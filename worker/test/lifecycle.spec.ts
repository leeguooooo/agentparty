import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { ADMIN_HEADERS, api, createChannel, postMessage, seedToken, uniq, WsClient } from "./helpers";

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

describe("channel lifecycle endpoints", () => {
  it("archive endpoint archives, kicks live ws, is idempotent", async () => {
    const { token } = await seedToken("human");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "before")).status).toBe(200);

    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");

    const res = await api(`/api/channels/${slug}/archive`, token, { method: "POST" });
    expect(res.status).toBe(200);

    // 存活连接收到 error:archived 后被关闭
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("archived");

    const rejected = await postMessage(slug, token, "after");
    expect(rejected.status).toBe(410);
    expect(await errorCode(rejected)).toBe("archived");
    const row = await env.DB.prepare("SELECT archived_at FROM channels WHERE slug = ?")
      .bind(slug)
      .first<{ archived_at: number | null }>();
    expect(row?.archived_at).not.toBeNull();

    // 归档后仍可回看
    const history = await api(`/api/channels/${slug}/messages`, token);
    expect(history.status).toBe(200);

    // 幂等
    const again = await api(`/api/channels/${slug}/archive`, token, { method: "POST" });
    expect(again.status).toBe(200);
  });

  it("do refuses sends on its own authority after archive", async () => {
    const { token } = await seedToken("human");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "before")).status).toBe(200);
    expect((await api(`/api/channels/${slug}/archive`, token, { method: "POST" })).status).toBe(200);

    // 绕过 worker 的 d1 检查直捅 do，模拟归档窗口内在途的旧快照请求
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      const rejected = await instance.onRequest(
        new Request("https://do/internal/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-ap-name": "stale",
            "x-ap-kind": "agent",
            "x-ap-role": "agent",
          },
          body: JSON.stringify({ kind: "message", body: "late", mentions: [], reply_to: null }),
        }),
      );
      expect(rejected.status).toBe(410);
    });
  });

  it("archive pending meta reconciles D1 on the next alarm", async () => {
    const { token } = await seedToken("human");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "initialize do")).status).toBe(200);
    const ts = Date.now();
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      await instance.onRequest(
        new Request("https://do/internal/archive", {
          method: "POST",
          headers: {
            "x-partykit-room": slug,
            "x-ap-archive-at": String(ts),
            "x-ap-mode": "normal",
            "x-ap-channel-kind": "standing",
            "x-ap-host": "ap.test",
          },
        }),
      );
      state.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('archive_pending_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(ts),
      );
    });
    await env.DB.prepare("UPDATE channels SET archived_at = NULL WHERE slug = ?").bind(slug).run();

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      await instance.onAlarm();
      const pending = state.storage.sql
        .exec("SELECT value FROM meta WHERE key = 'archive_pending_at'")
        .toArray();
      expect(pending).toHaveLength(0);
    });
    const row = await env.DB.prepare("SELECT archived_at FROM channels WHERE slug = ?")
      .bind(slug)
      .first<{ archived_at: number | null }>();
    expect(row?.archived_at).toBe(ts);
  });

  it("archive rejects readonly and unknown slug", async () => {
    const agent = await seedToken("agent");
    const ro = await seedToken("readonly");
    const slug = await createChannel(agent.token);
    const forbidden = await api(`/api/channels/${slug}/archive`, ro.token, { method: "POST" });
    expect(forbidden.status).toBe(403);
    const missing = await api("/api/channels/no-such-channel/archive", agent.token, { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("revocation kicks live sockets even when D1 marks the channel archived", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    await env.DB.prepare("UPDATE channels SET archived_at = ? WHERE slug = ?")
      .bind(Date.now(), slug)
      .run();

    const revoked = await SELF.fetch(`http://ap.test/api/tokens/${name}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(revoked.status).toBe(200);
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("unauthorized");
    ws.close();
  });

  it("revocation still kicks a socket in a public channel the token neither owns nor is a member of (#200)", async () => {
    // #200 收窄的安全关键路径：public 频道对任何 token 开放（acl.ts），一个既非房主也非成员的
    // token 也能连进来。收窄若只看 owner_account/channel_members 会漏踢它 → 撤销的 token 还连着。
    const ownerTok = await seedToken("agent", uniq("pubowner"), { owner: "pubowner@x.com" });
    const slug = uniq("pubch");
    const created = await SELF.fetch("http://ap.test/api/channels", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerTok.token}`, "content-type": "application/json" },
      body: JSON.stringify({ slug, kind: "standing", visibility: "public" }),
    });
    expect(created.status).toBe(201);

    // 另一个账号的 token，不是房主、不是成员，靠 public 连进来
    const intruder = await seedToken("agent", uniq("intruder"), { owner: "intruder@x.com" });
    const ws = await WsClient.open(slug, intruder.token);
    await ws.nextOfType("welcome");

    const revoked = await SELF.fetch(`http://ap.test/api/tokens/${intruder.name}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(revoked.status).toBe(200);
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("unauthorized");
    ws.close();
  });

  it("reset-guard remains human-only and harmless while loop guard is disabled", async () => {
    const agentA = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agentA.token);

    const agentReset = await api(`/api/channels/${slug}/reset-guard`, agentA.token, { method: "POST" });
    expect(agentReset.status).toBe(403);

    const reset = await api(`/api/channels/${slug}/reset-guard`, human.token, { method: "POST" });
    expect(reset.status).toBe(200);

    const resumed = await postMessage(slug, agentA.token, "still allowed");
    expect(resumed.status).toBe(200);
  }, 30_000);
});
