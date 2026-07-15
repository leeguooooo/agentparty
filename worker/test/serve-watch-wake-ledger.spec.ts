// #107：serve/watch 的唤醒也要进服务端 ledger。webhook 由服务端主动投递、天然可审计；serve/watch 是
// 拉模型（agent 自己的 loop 读广播、匹配 mentions.includes(self)），服务端不"投递"给它们。故服务端能诚实
// 记录的事实是：一条 @ 被广播到某频道，且被 @ 的目标是已登记 serve/watch 的可唤醒 agent —— 记为
// result='broadcast'（已广播给拉模型客户端，非"已确认消费"）。之后若该 agent resume 且引用了这条 @
// （复用 #191 的 @→resume 观测），才升级为 result='consumed'。"已广播"与"已确认消费"泾渭分明，绝不越权声称。
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

function sendMessage(slug: string, token: string, body: string, mentions: string[] = []) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null }),
  });
}

function reply(slug: string, token: string, body: string, replyTo: number, mentions: string[] = []) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: replyTo }),
  });
}

async function ledgerRows(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec(
        `SELECT mention_seq, target_name, webhook_name, adapter_kind, attempt,
                result, http_status, error, ack_seq, resume_seq
         FROM wake_delivery_ledger
         ORDER BY id`,
      )
      .toArray()
      .map((r) => ({
        mention_seq: Number(r.mention_seq),
        target_name: String(r.target_name),
        webhook_name: String(r.webhook_name),
        adapter_kind: String(r.adapter_kind),
        attempt: Number(r.attempt),
        result: String(r.result),
        http_status: r.http_status === null ? null : Number(r.http_status),
        error: r.error === null ? null : String(r.error),
        ack_seq: r.ack_seq === null ? null : Number(r.ack_seq),
        resume_seq: r.resume_seq === null ? null : Number(r.resume_seq),
      })),
  );
}

async function wakeVerifiedAt(slug: string, name: string): Promise<number | null> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const row = state.storage.sql.exec("SELECT wake_verified_at FROM presence WHERE name = ?", name).toArray()[0];
    return row === undefined || row.wake_verified_at === null || row.wake_verified_at === undefined
      ? null
      : Number(row.wake_verified_at);
  });
}

async function messageMentions(slug: string, seq: number): Promise<string[]> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const row = state.storage.sql.exec("SELECT mentions_json FROM messages WHERE seq = ?", seq).toArray()[0];
    return JSON.parse(String(row?.mentions_json ?? "[]")) as string[];
  });
}

// 用真实 WS status 帧把某 agent 登记成 serve/watch（服务端据此盖 presence.wake_kind）。
async function registerWakeAgent(slug: string, token: string, kind: "serve" | "watch"): Promise<WsClient> {
  const ws = await WsClient.open(slug, token);
  await ws.nextOfType("welcome");
  ws.send({ type: "send", kind: "status", state: "waiting", note: "standby", mentions: [], residency: "supervised", wake: { kind } });
  await ws.nextOfType("sent");
  return ws;
}

describe("#107 serve/watch wakes land in the server-side wake ledger", () => {
  it("records a broadcast ledger row when an @ targets a registered serve agent", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("serve-bot"));
    const slug = await createChannel(sender.token);
    const botWs = await registerWakeAgent(slug, bot.token, "serve");

    expect((await sendMessage(slug, sender.token, `@${bot.name} ping`, [bot.name])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    expect(await ledgerRows(slug)).toEqual([
      {
        mention_seq: 2, // seq 1 = the serve agent's registering status frame
        target_name: bot.name,
        webhook_name: bot.name,
        adapter_kind: "serve",
        attempt: 1,
        result: "broadcast",
        http_status: null,
        error: null,
        ack_seq: null,
        resume_seq: null,
      },
    ]);

    // 审计 API 与 webhook 唤醒同口径可查
    const apiRes = await api(`/api/channels/${slug}/wake-deliveries?since=1&target=${bot.name}`, sender.token);
    expect(apiRes.status).toBe(200);
    expect((await apiRes.json()) as { deliveries: unknown[] }).toMatchObject({
      deliveries: [{ mention_seq: 2, target_name: bot.name, adapter_kind: "serve", result: "broadcast", ack_seq: null, resume_seq: null }],
    });
    botWs.close();
  });

  it("records adapter_kind='watch' for a registered watch agent", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("watch-bot"));
    const slug = await createChannel(sender.token);
    const botWs = await registerWakeAgent(slug, bot.token, "watch");

    expect((await sendMessage(slug, sender.token, `@${bot.name} hey`, [bot.name])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const rows = await ledgerRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_name: bot.name, adapter_kind: "watch", result: "broadcast" });
    botWs.close();
  });

  it("treats a reply_to an agent as a durable wake target even without an explicit @ (#544)", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("reply-bot"));
    const slug = await createChannel(sender.token);
    const botWs = await registerWakeAgent(slug, bot.token, "watch");
    try {
      // seq 1 = watch registration; seq 2 = bot asks; seq 3 = peer replies without @.
      expect((await sendMessage(slug, bot.token, "can you check this?")).status).toBe(200);
      expect((await reply(slug, sender.token, "yes, checking", 2)).status).toBe(200);

      // REST response waits for afterSend, so the durable wake ledger is already committed here.
      expect(await messageMentions(slug, 3)).toEqual([bot.name]);
      expect(await ledgerRows(slug)).toContainEqual(expect.objectContaining({
        mention_seq: 3,
        target_name: bot.name,
        adapter_kind: "watch",
        result: "broadcast",
      }));
    } finally {
      botWs.close();
    }
  });

  it("does NOT record a serve/watch row for a mention with no wakeable presence", async () => {
    const sender = await seedToken("agent");
    const ghost = uniq("ghost"); // never registered any presence
    const slug = await createChannel(sender.token);

    expect((await sendMessage(slug, sender.token, `@${ghost} anybody?`, [ghost])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    expect(await ledgerRows(slug)).toEqual([]);
  });

  it("does NOT record a serve/watch row for a wake=none agent (mutation guard: only serve/watch)", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("none-bot"));
    const slug = await createChannel(sender.token);
    const botWs = await WsClient.open(slug, bot.token);
    await botWs.nextOfType("welcome");
    botWs.send({ type: "send", kind: "status", state: "waiting", note: "no wake", mentions: [], wake: { kind: "none" } });
    await botWs.nextOfType("sent");

    expect((await sendMessage(slug, sender.token, `@${bot.name} ping`, [bot.name])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    expect(await ledgerRows(slug)).toEqual([]);
    botWs.close();
  });

  it("keeps result='broadcast' when the agent never resumes (broadcast != confirmed consumed)", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("silent-bot"));
    const slug = await createChannel(sender.token);
    const botWs = await registerWakeAgent(slug, bot.token, "serve");

    expect((await sendMessage(slug, sender.token, `@${bot.name} ping`, [bot.name])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const rows = await ledgerRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("broadcast"); // 广播了，但没有确认消费——绝不擅自升级
    expect(rows[0]?.ack_seq).toBeNull();
    expect(rows[0]?.resume_seq).toBeNull();
    botWs.close();
  });

  it("marks the row consumed when the serve agent replies to the @ (reuses #191 @->resume signal)", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("resume-bot"));
    const slug = await createChannel(sender.token);
    const botWs = await registerWakeAgent(slug, bot.token, "serve");

    // seq 1 = register status; seq 2 = @-mention
    expect((await sendMessage(slug, sender.token, `@${bot.name} ping`, [bot.name])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    // 服务端此刻只观测到广播，尚未消费
    expect(await wakeVerifiedAt(slug, bot.name)).toBeNull();

    // seq 3 = the serve agent replies to the @ -> server-observed @->resume closes the loop
    expect((await reply(slug, bot.token, "on it", 2)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    expect(await ledgerRows(slug)).toEqual([
      {
        mention_seq: 2,
        target_name: bot.name,
        webhook_name: bot.name,
        adapter_kind: "serve",
        attempt: 1,
        result: "consumed",
        http_status: null,
        error: null,
        ack_seq: 3,
        resume_seq: null,
      },
    ]);
    // #191：同一 @->resume 闭环也盖了 wake_verified_at —— ledger 的 consumed 与 presence 的 verified 是同源信号
    expect(await wakeVerifiedAt(slug, bot.name)).not.toBeNull();
    botWs.close();
  });

  it("marks the row consumed on a status resume whose summary_seq points at the @", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("status-bot"));
    const slug = await createChannel(sender.token);
    const botWs = await registerWakeAgent(slug, bot.token, "serve");

    // seq 1 = register; seq 2 = @-mention
    expect((await sendMessage(slug, sender.token, `@${bot.name} status?`, [bot.name])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    // seq 3 = status frame summarizing seq 2
    botWs.send({ type: "send", kind: "status", state: "done", note: "resumed", mentions: [], summary_seq: 2 });
    await botWs.nextOfType("sent");
    await new Promise((r) => setTimeout(r, 50));

    const rows = await ledgerRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mention_seq: 2, target_name: bot.name, adapter_kind: "serve", result: "consumed", resume_seq: 3 });
    botWs.close();
  });
});
