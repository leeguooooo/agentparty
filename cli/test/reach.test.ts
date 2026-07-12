import { describe, expect, test } from "bun:test";
import { applyLiveConnection, type PresenceEntry } from "@agentparty/shared";
import { busyTimeoutHint, formatReach, formatReachLine, reachOf } from "../src/reach";

const NOW = 1_000_000_000;

function p(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, ...over };
}

describe("reachOf", () => {
  test("connected + fresh → online", () => {
    expect(reachOf("bob", [p({ name: "bob" })], NOW).reach).toBe("online");
  });

  test("not online but wakeable (serve/watch/webhook) + fresh → wakeable, carries wake kind", () => {
    const r = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "serve" } })], NOW);
    expect(r.reach).toBe("wakeable");
    expect(r.wake).toBe("serve");
  });

  test("stale serve/watch → offline：supervisor 死了叫不醒，不再谎报可唤醒（#47）", () => {
    // 13 分钟没心跳的 serve：supervisor 已死，@ 它无人应答 → offline
    const deadServe = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "serve" }, last_seen: NOW - 780_000 })], NOW);
    expect(deadServe.reach).toBe("offline");
    const deadWatch = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "watch" }, last_seen: NOW - 780_000 })], NOW);
    expect(deadWatch.reach).toBe("offline");
  });

  test("human_driven watch → offline for send reach（#55）", () => {
    const r = reachOf("bot", [p({ name: "bot", state: "offline", residency: "human_driven", wake: { kind: "watch" } })], NOW);
    expect(r.reach).toBe("offline");
  });

  test("stale webhook 仍 wakeable：服务端投递，agent 离线也真能唤醒（#47）", () => {
    // 2 分钟没露面但声明了 webhook → 仍可唤醒（webhook 由服务端 POST，不看连接）
    const recent = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - 120_000 })], NOW);
    expect(recent.reach).toBe("wakeable");
    expect(recent.wake).toBe("webhook");
    // 但超过 14 天 = 幽灵 → offline（webhook 也不豁免幽灵清理）
    const ghost = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - 15 * 24 * 60 * 60 * 1000 })], NOW);
    expect(ghost.reach).toBe("offline");
  });

  test("not in presence at all → offline", () => {
    expect(reachOf("ghost", [], NOW).reach).toBe("offline");
  });

  test("offline with no wake kind → offline", () => {
    expect(reachOf("x", [p({ name: "x", state: "offline", wake: { kind: "none" } })], NOW).reach).toBe("offline");
  });
});

// issue #97：修复在服务端（DO presence 序列化给有活连接的 name 打 live=true，不改写 last_seen）。
// reachOf 消费已带 live 的 presence：live 视同「在线」，与 web mentions（online.has＝participants＝活连接）
// 同源同判。这里守住 CLI/web 一致性回归。applyLiveConnection 是那道服务端修正的纯函数形态。
describe("consistency with server-side live-connection fix (#97)", () => {
  test("有活连接的 serve agent：陈旧甚至 offline 的行经 applyLiveConnection 打 live 后 → reachOf 判 online", () => {
    // 挂了 61s 没发帧的健康 serve：presence 陈旧、行内可能还是 offline（重连未自报）
    const raw = p({ name: "bot", state: "offline", wake: { kind: "serve" }, residency: "supervised", last_seen: NOW - 61_000 });
    // 未打 live（服务端不知道有活连接）时：CLI 会误判 offline —— 这正是 #97 里 CLI 与 web 打架的根源
    expect(reachOf("bot", [raw], NOW).reach).toBe("offline");
    // 打 live 后（服务端知道 bot 有活 WS 连接）：reachOf 判 online，与 web mentions（online.has）一致
    const corrected = applyLiveConnection(raw, true);
    expect(corrected.live).toBe(true);
    expect(corrected.last_seen).toBe(NOW - 61_000); // 不改写 last_seen（host 租约不受污染）
    expect(reachOf("bot", [corrected], NOW).reach).toBe("online");
  });

  test("无活连接：修正是恒等，陈旧 serve 仍判 offline（离线判定不被破坏）", () => {
    const raw = p({ name: "bot", state: "offline", wake: { kind: "serve" }, residency: "supervised", last_seen: NOW - 61_000 });
    expect(reachOf("bot", [applyLiveConnection(raw, false)], NOW).reach).toBe("offline");
  });
});

// busy + 队列深度（#103）：目标可达但正串行处理一条 wake——回复会慢，不是失联。
describe("busy surfacing (#103)", () => {
  test("online + busy with no queue → carries busy, no queueDepth", () => {
    const r = reachOf("bot", [p({ name: "bot", busy: true })], NOW);
    expect(r.reach).toBe("online");
    expect(r.busy).toBe(true);
    expect(r).not.toHaveProperty("queueDepth");
  });

  test("online + busy with a backlog → carries queue depth", () => {
    const r = reachOf("bot", [p({ name: "bot", busy: true, queue_depth: 4 })], NOW);
    expect(r).toMatchObject({ reach: "online", busy: true, queueDepth: 4 });
  });

  test("wakeable serve + busy → busy rides on wakeable too", () => {
    const r = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "serve" }, busy: true, queue_depth: 2 })], NOW);
    expect(r).toMatchObject({ reach: "wakeable", wake: "serve", busy: true, queueDepth: 2 });
  });

  test("not busy → no busy/queueDepth fields", () => {
    const r = reachOf("bot", [p({ name: "bot" })], NOW);
    expect(r).not.toHaveProperty("busy");
    expect(r).not.toHaveProperty("queueDepth");
  });

  test("queue_depth of 0 while busy → busy but no queued count", () => {
    const r = reachOf("bot", [p({ name: "bot", busy: true, queue_depth: 0 })], NOW);
    expect(r.busy).toBe(true);
    expect(r).not.toHaveProperty("queueDepth");
  });

  test("format shows busy and queued count legibly", () => {
    expect(formatReach({ name: "a", reach: "online", busy: true })).toBe("@a ● online · busy");
    expect(formatReach({ name: "a", reach: "online", busy: true, queueDepth: 3 })).toBe("@a ● online · busy, 3 queued");
    expect(formatReach({ name: "b", reach: "wakeable", wake: "serve", busy: true, queueDepth: 1 })).toBe(
      "@b ◐ wakeable(serve) · busy, 1 queued",
    );
  });
});

// ask 超时富提示（#103）：ask 委托 watch，超时只吐裸 TIMEOUT，看不出对方是「忙」还是「失联」。
// 若被 @ 的目标此刻仍标 busy，busyTimeoutHint 返回一行忙碌提示；否则 null（保持裸 TIMEOUT）。
describe("busyTimeoutHint (#103)", () => {
  test("目标 busy 带队列 → 富提示含忙碌 + 排队数", () => {
    const presence = [p({ name: "bot", busy: true, queue_depth: 3 })];
    expect(busyTimeoutHint(["bot"], presence, NOW)).toBe(
      "TIMEOUT — @bot 忙碌中, 3 排队; 稍后再试, 勿重复 @（对方在忙, 不是失联）",
    );
  });

  test("目标 busy 无队列 → 只报忙碌，不带排队数", () => {
    const presence = [p({ name: "bot", busy: true })];
    expect(busyTimeoutHint(["bot"], presence, NOW)).toBe(
      "TIMEOUT — @bot 忙碌中; 稍后再试, 勿重复 @（对方在忙, 不是失联）",
    );
  });

  test("wakeable serve + busy 同样出提示（可达即有意义）", () => {
    const presence = [p({ name: "bot", state: "offline", wake: { kind: "serve" }, busy: true, queue_depth: 1 })];
    expect(busyTimeoutHint(["bot"], presence, NOW)).toBe(
      "TIMEOUT — @bot 忙碌中, 1 排队; 稍后再试, 勿重复 @（对方在忙, 不是失联）",
    );
  });

  test("多个目标只列出 busy 的那些", () => {
    const presence = [
      p({ name: "a", busy: true, queue_depth: 2 }),
      p({ name: "b" }), // 在线不忙
    ];
    expect(busyTimeoutHint(["a", "b"], presence, NOW)).toBe(
      "TIMEOUT — @a 忙碌中, 2 排队; 稍后再试, 勿重复 @（对方在忙, 不是失联）",
    );
  });

  test("多个目标都 busy → 分号连接", () => {
    const presence = [p({ name: "a", busy: true, queue_depth: 2 }), p({ name: "b", busy: true })];
    expect(busyTimeoutHint(["a", "b"], presence, NOW)).toBe(
      "TIMEOUT — @a 忙碌中, 2 排队; @b 忙碌中; 稍后再试, 勿重复 @（对方在忙, 不是失联）",
    );
  });

  test("无 busy 目标 → null（保持裸 TIMEOUT）", () => {
    expect(busyTimeoutHint(["a"], [p({ name: "a" })], NOW)).toBeNull();
  });

  test("目标离线（查不到）→ null，不无中生有", () => {
    expect(busyTimeoutHint(["ghost"], [], NOW)).toBeNull();
  });
});

describe("formatting", () => {
  test("per-target labels are honest and compact", () => {
    expect(formatReach({ name: "a", reach: "online" })).toBe("@a ● online");
    expect(formatReach({ name: "b", reach: "wakeable", wake: "serve" })).toBe("@b ◐ wakeable(serve)");
    expect(formatReach({ name: "c", reach: "offline" })).toBe("@c ○ offline — reconnect to reach");
  });

  test("line joins with a separator and a leading arrow", () => {
    const line = formatReachLine([
      { name: "a", reach: "online" },
      { name: "c", reach: "offline" },
    ]);
    expect(line).toBe("→ @a ● online  ·  @c ○ offline — reconnect to reach");
  });
});
