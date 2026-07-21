// #665：一个曾「可被唤醒」的 agent（如后台 `watch --once`）被 harness 在 turn 边界 reaped 后，
// presence 却仍像它在待命，其它 agent 连发三条 @ 全部石沉大海、靠人肉兜底才发现。修复：send 路由 agent
// mention 时，服务端据自己权威 presence（autoWakeReachable，issue #47 统一口径）当场算出哪些已解析的 agent
// 目标 wake 通道不可达，经回执 SentFrame.undeliverable_mentions（REST 同字段）透给**所有**客户端，不止升级过
// 的 CL(#664)/web(#666)。与 #663 的 unresolved_mentions 正交：那些是正文 token 压根没解析到身份；这些是解析
// 成功的 agent 目标、只是没有活的 wake 通道。
import { autoWakeReachable, wakeableState, PRESENCE_TIMEOUT_MS, type PresenceEntry } from "@agentparty/shared";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WsClient, api, completeCapabilityHello, createChannel, seedToken, uniq } from "./helpers";

interface SentJson {
  seq: number;
  unresolved_mentions?: string[];
  undeliverable_mentions?: string[];
}

function send(slug: string, token: string, body: string, mentions: string[]): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null }),
  });
}

async function seedProfile(handle: string): Promise<void> {
  const account = `lark:${uniq("acct")}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO account_profiles (account, handle, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(account, handle, handle, now, now).run();
}

async function presenceOf(slug: string, token: string, name: string): Promise<PresenceEntry | undefined> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence.find((p) => p.name === name);
}

// 断开一条连接并等到 markOffline 广播落定（消 onClose 竞态，复用 presence-liveness 的做法）。
async function closeAndAwaitOffline(target: WsClient, observer: WsClient, name: string): Promise<void> {
  target.close();
  for (;;) {
    const frame = await observer.nextOfType("presence");
    if (frame.name === name && frame.state === "offline") return;
  }
}

describe("#665 undeliverable agent mentions (server-authoritative wakeability truth)", () => {
  it("路由到 live / 可唤醒的 agent → 不标 undeliverable", async () => {
    const acct = "u665-live@leeguoo.com";
    const sender = await seedToken("human", uniq("sender"), { owner: acct });
    const slug = await createChannel(sender.token);
    const agent = await seedToken("agent", uniq("livebot"), { channelScope: slug });

    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    ws.send({
      type: "send",
      kind: "status",
      state: "working",
      note: "on it",
      mentions: [],
      residency: "supervised",
      wake: { kind: "serve", verified_at: 1 },
    });
    await ws.nextOfType("sent");
    // 前置断言：服务端权威 presence 判定它可达。
    expect(autoWakeReachable((await presenceOf(slug, sender.token, agent.name))!, Date.now())).toBe(true);

    const res = await send(slug, sender.token, `@${agent.name} 看一下`, [agent.name]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as SentJson;
    expect(json.undeliverable_mentions).toBeUndefined();
    ws.close();
  });

  it("watcher 被回收（连接断开 → markOffline 撤销 watch wake）后，@ 它 → 回执标 undeliverable", async () => {
    const acct = "u665-reaped@leeguoo.com";
    const sender = await seedToken("human", uniq("sender"), { owner: acct });
    const slug = await createChannel(sender.token);
    const agent = await seedToken("agent", uniq("reapedbot"), { channelScope: slug });

    // 常驻观察者，用它的 presence 帧同步 markOffline 时机。
    const observer = await WsClient.open(slug, sender.token);
    await completeCapabilityHello(observer);

    const watch = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(watch);
    watch.send({
      type: "send",
      kind: "status",
      state: "waiting",
      note: "watching",
      mentions: [],
      residency: "supervised",
      wake: { kind: "watch" },
    });
    await watch.nextOfType("sent");

    // 模拟 harness reap：连接断开 → onClose → markOffline，watch wake 声明被撤销（#454）。
    await closeAndAwaitOffline(watch, observer, agent.name);
    const offline = (await presenceOf(slug, sender.token, agent.name))!;
    expect(offline.state).toBe("offline");
    expect(autoWakeReachable(offline, Date.now())).toBe(false);

    const res = await send(slug, sender.token, `@${agent.name} 上线看下这个 bug`, [agent.name]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as SentJson;
    expect(json.undeliverable_mentions).toEqual([agent.name]);
    observer.close();
  });

  it("被人为 paused（#180）的 agent 即便不可唤醒也不标 undeliverable（有意暂停 ≠ wake 故障）", async () => {
    const acct = "u665-paused@leeguoo.com";
    const sender = await seedToken("human", uniq("sender"), { owner: acct });
    const slug = await createChannel(sender.token);
    const agent = await seedToken("agent", uniq("pausedbot"), { channelScope: slug });

    const observer = await WsClient.open(slug, sender.token);
    await completeCapabilityHello(observer);

    const watch = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(watch);
    watch.send({
      type: "send",
      kind: "status",
      state: "waiting",
      note: "watching",
      mentions: [],
      residency: "supervised",
      wake: { kind: "watch" },
    });
    await watch.nextOfType("sent");

    // 人为暂停（moderator = 频道创建者）。
    const paused = await api(`/api/channels/${slug}/presence/${encodeURIComponent(agent.name)}/pause`, sender.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(paused.status).toBe(200);

    // 断开使其不可唤醒（wake 被撤销），但 paused 状态持久。
    await closeAndAwaitOffline(watch, observer, agent.name);
    const entry = (await presenceOf(slug, sender.token, agent.name))!;
    expect(entry.paused).toBe(true);
    expect(autoWakeReachable(entry, Date.now())).toBe(false);

    const res = await send(slug, sender.token, `@${agent.name} 恢复后看下`, [agent.name]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as SentJson;
    // paused 是有意暂停，不是 wake 故障 → 不进 undeliverable。
    expect(json.undeliverable_mentions).toBeUndefined();
    observer.close();
  });

  it("human 目标不进 undeliverable（human_driven 靠人接续，非 wake 故障，也不入 deliveryTargets）", async () => {
    const acct = "u665-human@leeguoo.com";
    const sender = await seedToken("human", uniq("sender"), { owner: acct });
    const slug = await createChannel(sender.token);
    const handle = uniq("colleague");
    await seedProfile(handle);

    const res = await send(slug, sender.token, `@${handle} 有空吗`, [handle]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as SentJson;
    expect(json.undeliverable_mentions).toBeUndefined();
  });

  it("WS send 的 sent 回执同样带 undeliverable_mentions", async () => {
    const acct = "u665-ws@leeguoo.com";
    const sender = await seedToken("human", uniq("sender"), { owner: acct });
    const slug = await createChannel(sender.token);
    const agent = await seedToken("agent", uniq("wsbot"), { channelScope: slug });

    const senderWs = await WsClient.open(slug, sender.token);
    await completeCapabilityHello(senderWs);

    const watch = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(watch);
    watch.send({
      type: "send",
      kind: "status",
      state: "waiting",
      note: "watching",
      mentions: [],
      residency: "supervised",
      wake: { kind: "watch" },
    });
    await watch.nextOfType("sent");
    await closeAndAwaitOffline(watch, senderWs, agent.name);

    senderWs.send({ type: "send", kind: "message", body: `@${agent.name} ping`, mentions: [agent.name], reply_to: null });
    const ack = await senderWs.nextOfType("sent");
    expect((ack as SentJson).undeliverable_mentions).toEqual([agent.name]);
    senderWs.close();
  });

  it("REST 幂等重试命中也重算并带出 undeliverable_mentions（首发 ack 丢了不静默漏）", async () => {
    const acct = "u665-rest-idem@leeguoo.com";
    const sender = await seedToken("human", uniq("sender"), { owner: acct });
    const slug = await createChannel(sender.token);
    const agent = await seedToken("agent", uniq("idembot"), { channelScope: slug });

    const observer = await WsClient.open(slug, sender.token);
    await completeCapabilityHello(observer);
    const watch = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(watch);
    watch.send({
      type: "send",
      kind: "status",
      state: "waiting",
      note: "watching",
      mentions: [],
      residency: "supervised",
      wake: { kind: "watch" },
    });
    await watch.nextOfType("sent");
    await closeAndAwaitOffline(watch, observer, agent.name);

    const key = `idem-${crypto.randomUUID()}`;
    const body = JSON.stringify({ kind: "message", body: `@${agent.name} ping`, mentions: [agent.name], reply_to: null, idempotency_key: key });
    const first = await api(`/api/channels/${slug}/messages`, sender.token, { method: "POST", body });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as SentJson;
    expect(firstJson.undeliverable_mentions).toEqual([agent.name]);

    // 同 key 重试 → 幂等命中（同 seq），但仍须重算 undeliverable_mentions 带回，不静默丢失。
    const retry = await api(`/api/channels/${slug}/messages`, sender.token, { method: "POST", body });
    expect(retry.status).toBe(200);
    const retryJson = (await retry.json()) as SentJson;
    expect(retryJson.seq).toBe(firstJson.seq);
    expect(retryJson.undeliverable_mentions).toEqual([agent.name]);
    observer.close();
  });

  it("WS 幂等重试命中的 sent 回执也带 undeliverable_mentions", async () => {
    const acct = "u665-ws-idem@leeguoo.com";
    const sender = await seedToken("human", uniq("sender"), { owner: acct });
    const slug = await createChannel(sender.token);
    const agent = await seedToken("agent", uniq("wsidembot"), { channelScope: slug });

    const senderWs = await WsClient.open(slug, sender.token);
    await completeCapabilityHello(senderWs);
    const watch = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(watch);
    watch.send({
      type: "send",
      kind: "status",
      state: "waiting",
      note: "watching",
      mentions: [],
      residency: "supervised",
      wake: { kind: "watch" },
    });
    await watch.nextOfType("sent");
    await closeAndAwaitOffline(watch, senderWs, agent.name);

    const key = `idem-${crypto.randomUUID()}`;
    const frame = { type: "send" as const, kind: "message" as const, body: `@${agent.name} ping`, mentions: [agent.name], reply_to: null, idempotency_key: key };
    senderWs.send(frame);
    const firstAck = (await senderWs.nextOfType("sent")) as SentJson;
    expect(firstAck.undeliverable_mentions).toEqual([agent.name]);

    // 同 key 重发 → 服务端幂等去重命中，回同一 seq，且仍带 undeliverable_mentions。
    senderWs.send(frame);
    const retryAck = (await senderWs.nextOfType("sent")) as SentJson;
    expect(retryAck.seq).toBe(firstAck.seq);
    expect(retryAck.undeliverable_mentions).toEqual([agent.name]);
    senderWs.close();
  });

  // 纯函数：证明「租约随心跳过期而失活」的真相由 autoWakeReachable 承载——last_seen 超过 PRESENCE_TIMEOUT_MS
  // 且无活连接即判不可达。wakeableState 只分类 wake 层（watch=unverified），可达性另由 autoWakeReachable 判，
  // 二者共同构成 who/send 的「wakeable」真相（cli who: wstate!=offline && autoWakeReachable）。
  it("租约随 last_seen 老化过期：autoWakeReachable 由可达翻转为不可达（宽限期口径）", () => {
    const now = Date.now();
    const base = {
      name: "reaped",
      kind: "agent" as const,
      state: "waiting" as const,
      note: null,
      residency: "supervised" as const,
      wake: { kind: "watch" as const },
    };
    // 新鲜心跳 + 活连接 → 可达。
    const fresh: PresenceEntry = { ...base, ts: now, last_seen: now, live: true };
    expect(autoWakeReachable(fresh, now)).toBe(true);
    // 心跳早已过期（> PRESENCE_TIMEOUT_MS）且无活连接 → 不可达。
    const stale: PresenceEntry = {
      ...base,
      ts: now - (PRESENCE_TIMEOUT_MS + 60_000),
      last_seen: now - (PRESENCE_TIMEOUT_MS + 60_000),
    };
    expect(autoWakeReachable(stale, now)).toBe(false);
    // wake 层分类不看新鲜度：仍是 watch → unverified；真相靠 autoWakeReachable。
    expect(wakeableState(stale, now)).toBe("wakeable_unverified");
  });
});
