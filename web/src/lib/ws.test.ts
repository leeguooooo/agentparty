// issue #117 回归测试：重连时 hello.since_rev 必须是本地维护的 revCursor（已消费的最大 rev_seq），
// 而不是新 welcome 的 last_rev_seq——否则断线窗口内的 edit/retract 会被服务端补拉永久跳过。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HelloFrame, ServerFrame } from "@agentparty/shared";
import { ChannelSocket } from "./ws";

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

// 最小 WebSocket 桩：记录 send 出去的帧，暴露 open/close/deliver 供测试驱动生命周期。
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
    this.readyState = 3; // CLOSED
  }
  // 测试驱动：进入 open 态并触发 onopen
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  // 测试驱动：投递一帧服务端消息
  deliver(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  // 测试驱动：触发一次传输层断线（非 1008，走重连）
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  // 本连接发出的 hello 帧
  hello(): HelloFrame {
    const raw = this.sent.map((s) => JSON.parse(s) as { type: string });
    const h = raw.find((f) => f.type === "hello");
    if (!h) throw new Error("no hello frame sent on this socket");
    return h as HelloFrame;
  }
}

// 待触发的重连定时器回调（window.setTimeout 捕获），flushTimers 手动放行。
let pendingTimers: Array<() => void>;
function flushTimers() {
  const due = pendingTimers.splice(0);
  for (const fn of due) fn();
}

beforeEach(() => {
  FakeSocket.reset();
  pendingTimers = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeSocket });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: { protocol: "http:", host: "localhost" },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn: () => void) => {
      pendingTimers.push(fn);
      return pendingTimers.length;
    },
    clearTimeout: () => {},
  } });
});

afterEach(() => {
  for (const [key, descriptor] of [
    ["WebSocket", originalWebSocket],
    ["window", originalWindow],
    ["location", originalLocation],
  ] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

function noopHandlers() {
  return {
    onFrame: () => {},
    onStatus: () => {},
    onFatal: () => {},
  };
}

function welcome(lastRevSeq: number, lastSeq = 0): ServerFrame {
  return {
    type: "welcome",
    channel: "demo",
    self: "me",
    participants: [],
    last_seq: lastSeq,
    last_rev_seq: lastRevSeq,
    presence: [],
  };
}

// rev_seq 携带者：一条修订快照（编辑后的消息）
function msgWithRev(seq: number, revSeq: number): ServerFrame {
  return {
    type: "msg",
    seq,
    sender: { name: "a", kind: "agent" },
    kind: "text",
    body: "edited",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 0,
    edited: true,
    edited_at: 1,
    rev_seq: revSeq,
  } as ServerFrame;
}

describe("ChannelSocket revCursor (issue #117)", () => {
  test("首连：since_rev 播种为 welcome.last_rev_seq（REST 已带来当前正文，历史修订不重放）", () => {
    const sock = new ChannelSocket("demo", "tok", noopHandlers(), { initialCursor: 42 });
    sock.connect();
    const s0 = FakeSocket.instances[0]!;
    s0.open();
    s0.deliver(welcome(100, 42));

    expect(s0.hello().since).toBe(42);
    expect(s0.hello().since_rev).toBe(100);
    sock.dispose();
  });

  test("旧服务端无 last_rev_seq → since_rev 退回 0（旧全量重放语义）", () => {
    const sock = new ChannelSocket("demo", "tok", noopHandlers(), { initialCursor: 5 });
    sock.connect();
    const s0 = FakeSocket.instances[0]!;
    s0.open();
    // last_rev_seq 缺省
    s0.deliver({
      type: "welcome",
      channel: "demo",
      self: "me",
      participants: [],
      last_seq: 5,
      presence: [],
    } as ServerFrame);

    expect(s0.hello().since_rev).toBe(0);
    sock.dispose();
  });

  test("收到带 rev_seq 的 update 帧后 revCursor 前进，重连时上报前进后的值", () => {
    const sock = new ChannelSocket("demo", "tok", noopHandlers(), { initialCursor: 10 });
    sock.connect();
    const s0 = FakeSocket.instances[0]!;
    s0.open();
    s0.deliver(welcome(100, 10)); // 基线 revCursor=100
    // live 修订：一条消息被编辑，rev_seq=105
    s0.deliver(msgWithRev(7, 105));

    // 断线 → 重连
    s0.drop();
    flushTimers();
    const s1 = FakeSocket.instances[1]!;
    expect(s1).toBeDefined();
    s1.open();
    s1.deliver(welcome(999, 10)); // 服务端水位已被别人推到 999

    // 重连上报的是已消费的 revCursor(105)，不是新 welcome 的 last_rev_seq(999)
    expect(s1.hello().since_rev).toBe(105);
    sock.dispose();
  });

  test("重连的 since_rev 是已消费的 revCursor，而不是新 welcome.last_rev_seq（核心缺陷）", () => {
    const sock = new ChannelSocket("demo", "tok", noopHandlers(), { initialCursor: 20 });
    sock.connect();
    const s0 = FakeSocket.instances[0]!;
    s0.open();
    s0.deliver(welcome(100, 20)); // 首连基线 revCursor=100
    expect(s0.hello().since_rev).toBe(100);

    // 断线窗口内没有任何帧到达本端（模拟：断线期间服务端发生了 edit/retract，water 涨到 200）
    s0.drop();
    flushTimers();
    const s1 = FakeSocket.instances[1]!;
    s1.open();
    s1.deliver(welcome(200, 20)); // 断线期间修订把 last_rev_seq 推到 200

    // 必须仍用 100 补拉，才能收到 (100,200] 区间的 edit/retract；用 200 会永久跳过（issue #117）
    expect(s1.hello().since_rev).toBe(100);
    expect(s1.hello().since_rev).not.toBe(200);
    sock.dispose();
  });

  test("message_update 也推进 revCursor（live 编辑广播）", () => {
    const sock = new ChannelSocket("demo", "tok", noopHandlers(), { initialCursor: 3 });
    sock.connect();
    const s0 = FakeSocket.instances[0]!;
    s0.open();
    s0.deliver(welcome(50, 3));
    s0.deliver({
      type: "message_update",
      target_seq: 2,
      action: "edit",
      actor: { name: "a", kind: "agent" },
      ts: 0,
      message: msgWithRev(2, 77),
    } as ServerFrame);

    s0.drop();
    flushTimers();
    const s1 = FakeSocket.instances[1]!;
    s1.open();
    s1.deliver(welcome(500, 3));

    expect(s1.hello().since_rev).toBe(77);
    sock.dispose();
  });
});
