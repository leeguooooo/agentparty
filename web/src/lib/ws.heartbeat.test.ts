// issue #130 回归测试：ws 心跳发了 ping 必须在有界时间内收到 pong（或任何回帧），否则判定
// TCP 半开死连接——主动 close + 触发重连。绝不能把"沉默"当成健康、继续显示 open。
//
// 观测的是"过程"而非终值：
//   - 死连接下断言 socket 真的被 close 了、状态真的翻成 reconnecting、退避定时器真的排到并拉起新连接；
//   - 健康连接（每个 interval 都回 pong）下断言 socket 从不被 close、状态一直是 open。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agentparty/shared";
import { ChannelSocket } from "./ws";

// 受控时钟：ws.ts 的看门狗用 Date.now() 算 lastFrameAt 新鲜度，测试用它推进"时间"。
let clock = 0;
const realDateNow = Date.now;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

// 捕获 window.setInterval 的心跳回调，fireHeartbeat() 手动放行一次 tick。
let intervalCbs: Map<number, () => void>;
let intervalSeq: number;
function fireHeartbeat() {
  for (const cb of [...intervalCbs.values()]) cb();
}

// 捕获 window.setTimeout 的重连回调，flushTimers() 手动放行。
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
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  // 真实浏览器 close() 不会同步触发 onclose；看门狗那条路径会先摘掉 onclose 再 close，
  // 所以这里只记录 close 被调用（不回调 onclose）。
  close(code?: number, reason?: string) {
    this.readyState = 3; // CLOSED
    this.closeCalls.push({ code, reason });
  }
  get closed() {
    return this.closeCalls.length > 0;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  deliver(frame: ServerFrame | { type: string }) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  pings() {
    return this.sent.filter((s) => s === '{"type":"ping"}');
  }
}

function welcome(): ServerFrame {
  return {
    type: "welcome",
    channel: "demo",
    self: "me",
    participants: [],
    last_seq: 0,
    last_rev_seq: 0,
    presence: [],
  } as ServerFrame;
}

// 记录 onStatus 全过程，断言"翻成 reconnecting"，而不是只看最后一帧
function statusRecorder() {
  const statuses: string[] = [];
  return {
    statuses,
    handlers: {
      onFrame: () => {},
      onStatus: (s: string) => statuses.push(s),
      onFatal: () => {},
    },
  };
}

beforeEach(() => {
  clock = 1_000_000;
  Date.now = () => clock;
  FakeSocket.reset();
  intervalCbs = new Map();
  intervalSeq = 0;
  pendingTimers = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeSocket });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: { protocol: "http:", host: "localhost" },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {
    setInterval: (fn: () => void) => {
      const id = ++intervalSeq;
      intervalCbs.set(id, fn);
      return id;
    },
    clearInterval: (id: number) => {
      intervalCbs.delete(id);
    },
    setTimeout: (fn: () => void) => {
      pendingTimers.push(fn);
      return pendingTimers.length;
    },
    clearTimeout: () => {},
  } });
});

afterEach(() => {
  Date.now = realDateNow;
  for (const [key, descriptor] of [
    ["WebSocket", originalWebSocket],
    ["window", originalWindow],
    ["location", originalLocation],
  ] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

const PING_INTERVAL = 25_000;

describe("ChannelSocket 心跳 pong 看门狗 (issue #130)", () => {
  test("静默死连接：ping 发出去但收不到 pong → 主动 close + 翻 reconnecting + 拉起新连接", () => {
    const { statuses, handlers } = statusRecorder();
    const sock = new ChannelSocket("demo", "tok", handlers);
    sock.connect();
    const s0 = FakeSocket.instances[0]!;
    s0.open();
    s0.deliver(welcome()); // 最后一次收到帧就停在这里（模拟随后 TCP 半开、彻底沉默）

    // 一路推进时间、逐个 tick 放行心跳，但从不投递 pong。
    // 看门狗阈值 = 2×interval：直到 now - lastFrameAt 超过它才判死。
    for (let i = 1; i <= 4 && !s0.closed; i++) {
      clock += PING_INTERVAL;
      fireHeartbeat();
    }

    // 过程断言 1：死连接真的被 close 了（不是只改了个状态字段）
    expect(s0.closed).toBe(true);
    // 过程断言 2：至少发过 ping（证明确实在心跳，只是没人应答）
    expect(s0.pings().length).toBeGreaterThan(0);
    // 过程断言 3：状态真的从 open 翻成了 reconnecting（不再对用户谎报 open）
    expect(statuses).toContain("open");
    expect(statuses[statuses.length - 1]).toBe("reconnecting");

    // 过程断言 4：重连真的发起——退避定时器排到后拉起了一条新连接
    expect(FakeSocket.instances.length).toBe(1);
    flushTimers();
    expect(FakeSocket.instances.length).toBe(2);
    expect(FakeSocket.instances[1]).toBeDefined();

    sock.dispose();
  });

  test("健康连接：每个 interval 都回 pong → socket 从不被 close，状态始终 open", () => {
    const { statuses, handlers } = statusRecorder();
    const sock = new ChannelSocket("demo", "tok", handlers);
    sock.connect();
    const s0 = FakeSocket.instances[0]!;
    s0.open();
    s0.deliver(welcome());

    // 6 个心跳周期，每次 tick 后服务端如常回 pong
    for (let i = 0; i < 6; i++) {
      clock += PING_INTERVAL;
      fireHeartbeat();
      s0.deliver({ type: "pong" }); // do 的 auto-response
    }

    expect(s0.closed).toBe(false);
    // 全程只有一个 socket，没有误触发重连
    expect(FakeSocket.instances.length).toBe(1);
    // 状态从没翻成 reconnecting
    expect(statuses).not.toContain("reconnecting");
    expect(statuses[statuses.length - 1]).toBe("open");
    // 确实一直在发 ping（心跳没被误停）
    expect(s0.pings().length).toBe(6);

    sock.dispose();
  });

  test("后台标签页 timer 被节流到 ~60s/次、但每 tick 服务端仍即时回 pong → 绝不误判掉线重连 (issue #634)", () => {
    const { statuses, handlers } = statusRecorder();
    const sock = new ChannelSocket("demo", "tok", handlers);
    sock.connect();
    const s0 = FakeSocket.instances[0]!;
    s0.open();
    s0.deliver(welcome());

    // 节流：tick 间隔被浏览器拉到 60s（> PONG_TIMEOUT_MS=50s）。旧看门狗按「lastFrameAt 超 2×interval」
    // 会在每个 tick 前就把健康连接误判成死连接、每分钟无谓重连；新看门狗只认「发了 ping 又一帧未回」的
    // 真实沉默窗口——上一个 ping 每次都被紧随的 pong 归零，节流拉长的 tick 间隔完全不触发判死。
    const THROTTLED_INTERVAL = 60_000;
    for (let i = 0; i < 6; i++) {
      clock += THROTTLED_INTERVAL;
      fireHeartbeat();
      s0.deliver({ type: "pong" }); // do 的 auto-response，紧随 ping 立即到达
    }

    // 过程断言：健康连接从不被 close、从不翻 reconnecting、只有一个 socket（没有惊群重连）
    expect(s0.closed).toBe(false);
    expect(FakeSocket.instances.length).toBe(1);
    expect(statuses).not.toContain("reconnecting");
    expect(statuses[statuses.length - 1]).toBe("open");
    // 心跳没被误停：每个 tick 都照常发了 ping
    expect(s0.pings().length).toBe(6);

    sock.dispose();
  });

  test("连上后迟迟没有 welcome/任何帧：看门狗以 open 时刻为基线，首个周期内不误杀、超阈值后照样判死", () => {
    const { handlers } = statusRecorder();
    const sock = new ChannelSocket("demo", "tok", handlers);
    sock.connect();
    const s0 = FakeSocket.instances[0]!;
    s0.open(); // 握手成功，但服务端此后再没发过任何帧（含 welcome）

    // 第 1 个周期（25s < 2×interval）：open 时刻是新鲜基线，给足宽限，不能误杀。
    // 若 onopen 没把 lastFrameAt 初始化成 open 时刻（退回字段默认 0），这里会在首个 tick 立刻判死。
    clock += PING_INTERVAL;
    fireHeartbeat();
    expect(s0.closed).toBe(false);

    // 继续沉默越过阈值：看门狗完全不依赖"收到过帧"，照样判死 + 重连（沉默 ≠ 健康）。
    for (let i = 0; i < 3 && !s0.closed; i++) {
      clock += PING_INTERVAL;
      fireHeartbeat();
    }
    expect(s0.closed).toBe(true);
    flushTimers();
    expect(FakeSocket.instances.length).toBe(2);

    sock.dispose();
  });
});
