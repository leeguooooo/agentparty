// issue #97：活 WS 连接 = supervisor 存活的最强证据。presence.updated_at 只由 status 帧 / markOffline
// 写，安静的健康连接不回写 → 被误判「叫不醒」；断线重连又钉死在 offline。修复用独立字段 `live`（DO 从
// liveConnectionCounts 权威判定）短路可达性/新鲜度判定，**不改写 ts/last_seen**——所以 host 租约（只看
// last_seen）语义完全不变，failover 不受影响。这里既覆盖纯函数，也走真实 WS 端到端。
import {
  applyLiveConnection,
  autoWakeReachable,
  evaluateHostLease,
  PRESENCE_TIMEOUT_MS,
  type PresenceEntry,
} from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, seedToken } from "./helpers";

const NOW = 1_000_000_000;
const STALE_SEEN = NOW - (PRESENCE_TIMEOUT_MS + 60_000); // 早已陈旧的 last_seen（>60s）

function entry(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, ...over };
}

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { presence: PresenceEntry[] };
  return body.presence;
}

describe("applyLiveConnection (issue #97 read-side reachability fix)", () => {
  it("有活连接：打 live=true、offline 提升为 waiting，但**不改写 ts/last_seen**", () => {
    const stale = entry({ name: "bot", state: "offline", wake: { kind: "serve" }, residency: "supervised", last_seen: STALE_SEEN, ts: STALE_SEEN });
    const live = applyLiveConnection(stale, true);
    expect(live.live).toBe(true);
    expect(live.state).toBe("waiting"); // 解重连死锁
    // 关键不变量：时间戳原封不动，host 租约据此判活不受污染
    expect(live.last_seen).toBe(STALE_SEEN);
    expect(live.ts).toBe(STALE_SEEN);
  });

  it("(b) 有活连接：autoWakeReachable 为 true —— live 短路了陈旧判定", () => {
    const stale = entry({ name: "bot", state: "offline", wake: { kind: "serve" }, residency: "supervised", last_seen: STALE_SEEN, ts: STALE_SEEN });
    // 没活连接时：陈旧 serve = supervisor 大概率已死 → 叫不醒
    expect(autoWakeReachable(stale, NOW)).toBe(false);
    // 有活连接：live 短路 staleMs → 可唤醒
    expect(autoWakeReachable(applyLiveConnection(stale, true), NOW)).toBe(true);
  });

  it("(a) host 租约不吃 live：有活连接但 last_seen 陈旧的 host，evaluateHostLease 仍 stale/lease-expired", () => {
    const host = entry({
      name: "hostbot",
      role: "host",
      state: "working",
      residency: "supervised",
      wake: { kind: "serve", verified_at: 1 },
      last_seen: STALE_SEEN,
      ts: STALE_SEEN,
    });
    const withoutLive = evaluateHostLease(host, NOW);
    const withLive = evaluateHostLease(applyLiveConnection(host, true), NOW);
    // 与修复前完全一致：租约靠 last_seen 判活，live 不参与 → 仍然过期
    expect(withLive.lease).toBe("stale");
    expect(withLive.reason).toBe("lease-expired");
    expect(withLive).toEqual(withoutLive);
  });

  it("没有活连接：陈旧的行原样返回（引用不变），仍判离线 / 不可达", () => {
    const stale = entry({ name: "bot", state: "offline", wake: { kind: "serve" }, residency: "supervised", last_seen: STALE_SEEN, ts: STALE_SEEN });
    const same = applyLiveConnection(stale, false);
    expect(same).toBe(stale);
    expect(same.live).toBeUndefined();
    expect(autoWakeReachable(same, NOW)).toBe(false);
  });

  it("有活连接不谎称在忙：working/blocked/done 等已自报的工作态不被改写，只打 live", () => {
    for (const state of ["working", "blocked", "done", "waiting"] as const) {
      const e = entry({ name: "bot", state, note: "refactor", wake: { kind: "serve" }, residency: "supervised", last_seen: STALE_SEEN, ts: STALE_SEEN });
      const live = applyLiveConnection(e, true);
      expect(live.state).toBe(state); // 工作态原样
      expect(live.note).toBe("refactor");
      expect(live.live).toBe(true);
      expect(live.last_seen).toBe(STALE_SEEN);
    }
  });

  it("webhook 语义不受影响：无活连接、陈旧也恒可唤醒", () => {
    const stale = entry({ name: "hookbot", state: "offline", wake: { kind: "webhook" }, last_seen: STALE_SEEN, ts: STALE_SEEN });
    expect(autoWakeReachable(applyLiveConnection(stale, false), NOW)).toBe(true);
    expect(autoWakeReachable(applyLiveConnection(stale, true), NOW)).toBe(true);
  });
});

describe("DO presence wiring (issue #97 end-to-end)", () => {
  it("最后一个 watch listener 断开后立即撤销 wake 层，避免 harness kill 后 false-online（#454）", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    const observer = await WsClient.open(slug, human.token);
    await observer.nextOfType("welcome");
    const watch = await WsClient.open(slug, agent.token);
    await watch.nextOfType("welcome");
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
    expect((await fetchPresence(slug, agent.token)).find((p) => p.name === agent.name)?.wake?.kind).toBe("watch");

    watch.close();
    for (;;) {
      const frame = await observer.nextOfType("presence");
      if (frame.name === agent.name && frame.state === "offline") break;
    }

    const offline = (await fetchPresence(slug, agent.token)).find((p) => p.name === agent.name)!;
    expect(offline.state).toBe("offline");
    expect(offline.wake).toBeUndefined();
    expect(autoWakeReachable(offline, Date.now())).toBe(false);
    observer.close();
  });

  it("活 WS 连接的 agent：/presence 标 live=true、报为非 offline、可自动唤醒", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
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

    const list = await fetchPresence(slug, agent.token);
    const me = list.find((p) => p.name === agent.name)!;
    expect(me).toBeDefined();
    expect(me.live).toBe(true);
    expect(me.state).not.toBe("offline");
    expect(autoWakeReachable(me, Date.now())).toBe(true);
    ws.close();
  });

  it("断线重连后不再钉死在 offline：presence 行是 offline，活连接把它提升为可达", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);

    // 人类观察者常驻，用它的 presence 帧同步 markOffline 时机，避免 onClose 竞态
    const watcher = await WsClient.open(slug, human.token);
    await watcher.nextOfType("welcome");

    const first = await WsClient.open(slug, agent.token);
    await first.nextOfType("welcome");
    first.send({
      type: "send",
      kind: "status",
      state: "working",
      note: "first pass",
      mentions: [],
      residency: "supervised",
      wake: { kind: "serve", verified_at: 1 },
    });
    await first.nextOfType("sent");

    // 断线 → onClose → markOffline，等 watcher 收到 offline presence 帧才继续（消竞态）
    first.close();
    for (;;) {
      const f = await watcher.nextOfType("presence");
      if (f.name === agent.name && f.state === "offline") break;
    }

    // 此刻无活连接：/presence 权威地报 offline、无 live（离线判定不被破坏）
    const offlineList = await fetchPresence(slug, agent.token);
    const offlineMe = offlineList.find((p) => p.name === agent.name)!;
    expect(offlineMe.state).toBe("offline");
    expect(offlineMe.live).toBeUndefined();

    // 重连：presence 行仍是 offline（下次自报前不变），但活连接立即让它重新可达
    const second = await WsClient.open(slug, agent.token);
    await second.nextOfType("welcome");

    const reconnList = await fetchPresence(slug, agent.token);
    const reconnMe = reconnList.find((p) => p.name === agent.name)!;
    expect(reconnMe.live).toBe(true);
    expect(reconnMe.state).not.toBe("offline"); // 不再钉死在 offline
    expect(autoWakeReachable(reconnMe, Date.now())).toBe(true); // 可唤醒 / 可达，CLI 与 web 一致
    second.close();
  });
});
