// issue #634 回归测试：重连退避必须带 jitter。同频道多客户端常被同一次 DO 驱逐/部署/网络抖动同时
// 断开，纯确定性退避（1s/2s/4s…）会让它们精确同拍重连、惊群反复打垮刚恢复的 ChannelDO。断言调度延迟
// 被抖到 [0.5, 1)×backoff，且天花板仍按 backoff 确定性翻倍。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agentparty/shared";
import { ChannelSocket } from "./ws";

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
const realRandom = Math.random;

// 捕获 window.setTimeout 的 (回调, 延迟)；scheduledDelays 记录每次重连排定的延迟。
let scheduledDelays: number[];
let pendingTimers: Array<() => void>;
function flushTimers() {
  const due = pendingTimers.splice(0);
  for (const fn of due) fn();
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static reset() {
    FakeSocket.instances = [];
  }
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];
  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  deliver(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  // 传输层断线（非 1008），opened=true 走 scheduleReconnect
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function noopHandlers() {
  return { onFrame: () => {}, onStatus: () => {}, onFatal: () => {} };
}

beforeEach(() => {
  FakeSocket.reset();
  scheduledDelays = [];
  pendingTimers = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeSocket });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: { protocol: "http:", host: "localhost" },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (fn: () => void, delay?: number) => {
        scheduledDelays.push(delay ?? 0);
        pendingTimers.push(fn);
        return pendingTimers.length;
      },
      clearTimeout: () => {},
    },
  });
});

afterEach(() => {
  Math.random = realRandom;
  for (const [key, descriptor] of [
    ["WebSocket", originalWebSocket],
    ["window", originalWindow],
    ["location", originalLocation],
  ] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

const BACKOFF_MIN = 1_000;

// connect + open + drop 一次，返回本次重连排定的延迟。
function firstReconnectDelay(): number {
  const sock = new ChannelSocket("demo", "tok", noopHandlers());
  sock.connect();
  const s0 = FakeSocket.instances[FakeSocket.instances.length - 1]!;
  s0.open(); // everConnected=true, backoff 复位为 BACKOFF_MIN
  s0.drop();
  const delay = scheduledDelays[scheduledDelays.length - 1]!;
  sock.dispose();
  return delay;
}

describe("ChannelSocket 重连退避 jitter (issue #634)", () => {
  test("jitter 下界：Math.random=0 → 0.5×backoff", () => {
    Math.random = () => 0;
    expect(firstReconnectDelay()).toBe(BACKOFF_MIN * 0.5);
  });

  test("jitter 上界：Math.random→1 时延迟趋近但严格 < backoff（绝不同拍撞满）", () => {
    Math.random = () => 0.999_999;
    const delay = firstReconnectDelay();
    expect(delay).toBeGreaterThan(BACKOFF_MIN * 0.5);
    expect(delay).toBeLessThan(BACKOFF_MIN);
  });

  test("任意随机取值都落在 [0.5, 1)×backoff：同拍断开的一群客户端被摊开而非同步重连", () => {
    for (const r of [0, 0.1, 0.37, 0.5, 0.73, 0.9, 0.999_999]) {
      Math.random = () => r;
      const delay = firstReconnectDelay();
      expect(delay).toBeGreaterThanOrEqual(BACKOFF_MIN * 0.5);
      expect(delay).toBeLessThan(BACKOFF_MIN);
    }
  });

  test("加 jitter 不改天花板翻倍：持续握手失败时排定延迟按 backoff 逐轮翻番（各自 0.5× 下界）", () => {
    // 固定 random=0 让每轮落在各自 backoff 下界，凸显翻倍：backoff 1000 → 2000。onopen 会把 backoff 复位，
    // 故走「从未 open 的握手失败」分支才能观察到累积翻倍；只跑 2 轮，止步于 HANDSHAKE_PROBE_AFTER=3
    // 的 rest 探测分支（那条走 fetch，不在本用例范围）。
    Math.random = () => 0;
    const sock = new ChannelSocket("demo", "tok", noopHandlers());
    sock.connect();

    const delays: number[] = [];
    for (let round = 0; round < 2; round++) {
      const s = FakeSocket.instances[FakeSocket.instances.length - 1]!;
      s.drop(); // 从未 open：backoff 不被 onopen 复位，逐轮翻倍
      delays.push(scheduledDelays[scheduledDelays.length - 1]!);
      flushTimers(); // 排定的重连回调拉起下一条连接
    }

    expect(delays).toEqual([BACKOFF_MIN * 0.5, BACKOFF_MIN]); // 500, 1000 —— 即 0.5×1000, 0.5×2000
    sock.dispose();
  });
});
