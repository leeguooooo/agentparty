import { MAX_WEBHOOK_DEAD_LETTERS, WEBHOOK_MAX_RETRIES } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { fetchMock } from "./fetch-mock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function sendMessage(slug: string, token: string, body: string, mentions: string[] = []) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null }),
  });
}

function addWebhook(slug: string, token: string, name: string, url: string, filter = "all") {
  return api(`/api/channels/${slug}/webhooks`, token, {
    method: "POST",
    body: JSON.stringify({ name, url, secret: "s", filter }),
  });
}

async function deadLetterRows(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec(
        `SELECT webhook_name, mention_seq, payload, attempts, last_status, last_error, dead_lettered_at
           FROM webhook_dead_letters
          ORDER BY id`,
      )
      .toArray()
      .map((r) => ({
        webhook_name: String(r.webhook_name),
        mention_seq: Number(r.mention_seq),
        payload: String(r.payload),
        attempts: Number(r.attempts),
        last_status: r.last_status === null ? null : Number(r.last_status),
        last_error: r.last_error === null ? null : String(r.last_error),
        dead_lettered_at: Number(r.dead_lettered_at),
      })),
  );
}

// 把队列里的这条拨到「下一次失败即达上限」再触发 alarm，得到一条确定的死信
async function exhaustToDeadLetter(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (instance: ChannelDO, state) => {
    state.storage.sql.exec(
      "UPDATE webhook_queue SET attempts = ?, next_retry_at = ?",
      WEBHOOK_MAX_RETRIES,
      Date.now() - 1,
    );
    await instance.onAlarm();
  });
}

describe("webhook dead-letter persistence + redeliver", () => {
  it("persists a dead-letter instead of silently dropping when retries are exhausted", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const hook = uniq("dl");
    expect((await addWebhook(slug, token, hook, "https://dead.test/wake")).status).toBe(201);

    // 立即首投失败 → 入队 attempts=1（无 interceptor + disableNetConnect）
    expect((await sendMessage(slug, token, `@${hook} ping`, [hook])).status).toBe(200);
    await exhaustToDeadLetter(slug);

    const dead = await deadLetterRows(slug);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      webhook_name: hook,
      mention_seq: 1,
      attempts: WEBHOOK_MAX_RETRIES + 1,
    });
    expect(dead[0]?.last_error).toEqual(expect.any(String));
    // payload 里带着原始消息体，redeliver 时要原样重投
    expect(JSON.parse(dead[0]?.payload ?? "{}")).toMatchObject({ seq: 1, channel: slug });
  });

  it("lists dead-letters over a moderator-only endpoint", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const hook = uniq("dl");
    expect((await addWebhook(slug, token, hook, "https://dead.test/wake")).status).toBe(201);
    expect((await sendMessage(slug, token, `@${hook} ping`, [hook])).status).toBe(200);
    await exhaustToDeadLetter(slug);

    const res = await api(`/api/channels/${slug}/webhooks/dead-letters`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dead_letters: { webhook_name: string; mention_seq: number; attempts: number }[] };
    expect(body.dead_letters).toHaveLength(1);
    expect(body.dead_letters[0]).toMatchObject({ webhook_name: hook, mention_seq: 1 });

    // readonly（非 moderator）看不到死信
    const { token: ro } = await seedToken("readonly");
    expect((await api(`/api/channels/${slug}/webhooks/dead-letters`, ro)).status).toBe(403);
  });

  it("redeliver re-attempts a dead-letter and clears it on success", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const hook = uniq("dl");
    expect((await addWebhook(slug, token, hook, "https://revive.test/wake")).status).toBe(201);
    expect((await sendMessage(slug, token, `@${hook} ping`, [hook])).status).toBe(200);
    await exhaustToDeadLetter(slug);
    expect(await deadLetterRows(slug)).toHaveLength(1);

    fetchMock.get("https://revive.test").intercept({ path: "/wake", method: "POST" }).reply(200, "ok");
    const res = await api(`/api/channels/${slug}/webhooks/${hook}/redeliver`, token, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { redelivered: number; failed: number }).toMatchObject({
      redelivered: 1,
      failed: 0,
    });
    // 投递成功 → 死信清空
    expect(await deadLetterRows(slug)).toHaveLength(0);
  });

  it("redeliver that still fails leaves the delivery dead-lettered", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const hook = uniq("dl");
    expect((await addWebhook(slug, token, hook, "https://stilldown.test/wake")).status).toBe(201);
    expect((await sendMessage(slug, token, `@${hook} ping`, [hook])).status).toBe(200);
    await exhaustToDeadLetter(slug);
    expect(await deadLetterRows(slug)).toHaveLength(1);

    // 无 interceptor → redeliver 再次失败
    const res = await api(`/api/channels/${slug}/webhooks/${hook}/redeliver`, token, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { redelivered: number; failed: number }).toMatchObject({
      redelivered: 0,
      failed: 1,
    });
    // 仍然是死信，attempts 递增，不再静默消失
    const dead = await deadLetterRows(slug);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attempts).toBe(WEBHOOK_MAX_RETRIES + 2);
  });

  it("non-moderator cannot redeliver", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const hook = uniq("dl");
    expect((await addWebhook(slug, token, hook, "https://dead.test/wake")).status).toBe(201);
    expect((await sendMessage(slug, token, `@${hook} ping`, [hook])).status).toBe(200);
    await exhaustToDeadLetter(slug);

    const { token: ro } = await seedToken("readonly");
    const res = await api(`/api/channels/${slug}/webhooks/${hook}/redeliver`, ro, { method: "POST" });
    expect(res.status).toBe(403);
    // 死信没被非授权者动过
    expect(await deadLetterRows(slug)).toHaveLength(1);
  });

  it("persists a dead-letter when the retry queue is full (drop is no longer silent)", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const hook = uniq("dl");
    expect((await addWebhook(slug, token, hook, "https://dead.test/wake")).status).toBe(201);

    // 先把队列填满，再让下一条失败投递撞上「队列满」丢弃点
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      for (let i = 0; i < 200; i++) {
        state.storage.sql.exec(
          "INSERT INTO webhook_queue (webhook_name, payload, attempts, next_retry_at) VALUES (?, ?, 1, ?)",
          hook,
          JSON.stringify({ seq: 900 + i, channel: slug }),
          Date.now() + 3_600_000,
        );
      }
    });

    expect((await sendMessage(slug, token, `@${hook} overflow`, [hook])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const dead = await deadLetterRows(slug);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ webhook_name: hook });
    expect(JSON.parse(dead[0]?.payload ?? "{}")).toMatchObject({ body: expect.stringContaining("overflow") });
  });

  it("prunes dead-letters so the table stays bounded", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const hook = uniq("dl");
    // 走一次真实请求，确保 onStart 已建表（与生产路径一致），再直接造死信验证裁剪
    expect((await api(`/api/channels/${slug}/webhooks/dead-letters`, token)).status).toBe(200);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      for (let i = 0; i < MAX_WEBHOOK_DEAD_LETTERS + 25; i++) {
        instance.recordDeadLetterForTest(hook, JSON.stringify({ seq: i + 1, channel: slug }), 4, {
          ok: false,
          status: 500,
          error: "boom",
        });
      }
      const n = Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM webhook_dead_letters").one().n);
      expect(n).toBe(MAX_WEBHOOK_DEAD_LETTERS);
      // 保留的是最新的一批（旧的被裁掉）
      const min = Number(state.storage.sql.exec("SELECT MIN(mention_seq) AS m FROM webhook_dead_letters").one().m);
      expect(min).toBe(25 + 1);
    });
  });
});
