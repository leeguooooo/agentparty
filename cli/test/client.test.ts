import { afterEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agentparty/shared";
import pkg from "../package.json" with { type: "json" };
import { connect, type Connection } from "../src/client";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
let conn: Connection | null = null;
const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;
const originalConsoleDebug = console.debug;

afterEach(() => {
  conn?.close();
  conn = null;
  server?.stop();
  server = null;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalWebSocket;
  console.debug = originalConsoleDebug;
});

class ProbeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: ProbeWebSocket[] = [];

  readyState = ProbeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor() {
    ProbeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = ProbeWebSocket.CLOSED;
  }

  failHandshake(): void {
    this.readyState = ProbeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "" } as CloseEvent);
  }
}

function useProbeWebSocket(): void {
  ProbeWebSocket.instances = [];
  globalThis.WebSocket = ProbeWebSocket as unknown as typeof WebSocket;
}

async function collect(
  c: Connection,
  n: number,
  timeoutMs = 3000,
  ack = true,
): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  const timer = setTimeout(() => c.close(), timeoutMs);
  for await (const f of c.frames) {
    frames.push(f);
    if (ack && f.type === "msg") c.ack(f.seq);
    if (frames.length >= n) break;
  }
  clearTimeout(timer);
  return frames;
}

describe("ws client", () => {
  test("cursor only advances on ack, not on enqueue", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(2));
        sock.send(msgFrame(1, "a"));
        sock.send(msgFrame(2, "b"));
      }
    });
    const cursors: number[] = [];
    conn = connect(server.url, "ap_tok", "dev", 0, { onCursor: (c) => cursors.push(c) });
    const frames = await collect(conn, 3, 3000, false);
    expect(frames.map((f) => f.type)).toEqual(["welcome", "msg", "msg"]);
    expect(cursors).toEqual([]);
    expect(conn.cursor).toBe(0);
    conn.ack(1);
    expect(cursors).toEqual([1]);
    expect(conn.cursor).toBe(1);
  });

  test("replayUnacked puts consumed standby frames back before newer queued frames", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(3));
      sock.send(msgFrame(1, "standby wake"));
      sock.send(msgFrame(2, "queued context"));
      sock.send(msgFrame(3, "queued latest"));
    });
    conn = connect(server.url, "ap_tok", "dev", 0);
    const it = conn.frames[Symbol.asyncIterator]();
    await it.next(); // welcome
    const consumed = (await it.next()).value as { type: "msg"; seq: number; body: string };
    expect(consumed.body).toBe("standby wake");

    // seq=2/3 还在 FrameQueue，只有已取走但未 ack 的 seq=1 应被重排；不得复制仍在队里的帧。
    expect(conn.replayUnacked()).toBe(1);
    const replay = (await it.next()).value as { type: "msg"; seq: number; body: string };
    const second = (await it.next()).value as { type: "msg"; seq: number; body: string };
    const third = (await it.next()).value as { type: "msg"; seq: number; body: string };
    expect([replay.body, second.body, third.body]).toEqual(["standby wake", "queued context", "queued latest"]);

    conn.ack(3);
    expect(conn.replayUnacked()).toBe(0);
  });

  test("fails safely at the unacked replay cap without advancing the cursor", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(3));
      sock.send(msgFrame(1, "one"));
      sock.send(msgFrame(2, "two"));
      sock.send(msgFrame(3, "overflow"));
    });
    conn = connect(server.url, "ap_tok", "dev", 0, { maxUnackedFrames: 2 });

    let failure: unknown;
    try {
      for await (const _frame of conn.frames) {
        // 故意不 ack：模拟 standby 冻结 cursor。
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("terminating without advancing cursor");
    expect(conn.cursor).toBe(0);
  });

  test("dedups frames delivered by both broadcast and backfill", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        // broadcast 先到，hello 补拉又送一遍
        sock.send(welcomeFrame(6));
        sock.send(msgFrame(6, "broadcast copy"));
        sock.send(msgFrame(5, "backfill only"));
        sock.send(msgFrame(6, "backfill copy"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 4);
    const frames = await collect(conn, 3, 800, false);
    const msgs = frames.filter((f) => f.type === "msg") as { seq: number; body: string }[];
    expect(msgs.map((m) => m.seq)).toEqual([6, 5]);
    expect(msgs.map((m) => m.body)).toEqual(["broadcast copy", "backfill only"]);
  });

  test("allows revised snapshots for acked seqs after reconnect", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(6));
        sock.send(msgFrame(6, "edited copy", { edited: true, edited_at: Date.now(), edited_by: "bob" }));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 6);
    const frames = await collect(conn, 2, 800, false);
    const msgs = frames.filter((f) => f.type === "msg") as { seq: number; body: string; edited?: true }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ seq: 6, body: "edited copy", edited: true });
  });

  test("sends since_rev in hello and advances the rev cursor from revision frames", async () => {
    const hellos: Record<string, unknown>[] = [];
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      hellos.push(frame as unknown as Record<string, unknown>);
      sock.send(welcomeFrame(6));
      sock.send(msgFrame(6, "edited", { edited: true, edited_at: 111, edited_by: "bob", rev_seq: 5 }));
    });
    const revs: number[] = [];
    conn = connect(server.url, "ap_tok", "dev", 6, { sinceRev: 2, onRevCursor: (r) => revs.push(r) });
    await collect(conn, 2, 800, false);
    expect(hellos[0]).toMatchObject({ since: 6, since_rev: 2, client_version: pkg.version });
    expect(revs).toEqual([5]);
    expect(conn.revCursor).toBe(5);
  });

  test("full sync (since=0) adopts welcome.last_rev_seq as the rev cursor", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send({ ...welcomeFrame(3), last_rev_seq: 7 });
    });
    const revs: number[] = [];
    conn = connect(server.url, "ap_tok", "dev", 0, { onRevCursor: (r) => revs.push(r) });
    await collect(conn, 1, 500, false);
    expect(revs).toEqual([7]);
    expect(conn.revCursor).toBe(7);
  });

  test("the same revision snapshot replayed on reconnect is delivered once; a NEW revision still passes", async () => {
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(6));
      // 服务端每次 hello 都会重放历史修订快照（do.ts 补拉不受 since 约束）
      sock.send(msgFrame(6, "edited once", { edited: true, edited_at: 111, edited_by: "bob" }));
      if (connIndex === 0) {
        sock.close(); // 断线重连 → 同一修订又被重放
      } else {
        // 重连后又来一次同修订 + 一次「新的」修订（edited_at 变了）
        setTimeout(() => sock.send(msgFrame(6, "edited twice", { edited: true, edited_at: 222, edited_by: "bob" })), 20);
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 6, { backoffBaseMs: 20 });
    // 4 帧 = welcome + 首次修订 + 重连 welcome + 新修订（重放的同修订被指纹去重，不占帧）
    const frames = await collect(conn, 4, 800, false);
    const msgs = frames.filter((f) => f.type === "msg") as { seq: number; body: string }[];
    // 同一修订跨重连只递一次；新修订（不同指纹）仍然放行
    expect(msgs.map((m) => m.body)).toEqual(["edited once", "edited twice"]);
  });

  test("acked seqs are not redelivered, unacked queued frames dedup after reconnect", async () => {
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
      if (connIndex === 0) {
        sock.send(welcomeFrame(2));
        sock.send(msgFrame(1, "consumed"));
        sock.send(msgFrame(2, "queued"));
        sock.close();
      } else {
        // 重连 hello.since=1，服务端重发 2，客户端已入队过要去重
        sock.send(welcomeFrame(2));
        sock.send(msgFrame(2, "resent"));
        sock.send(msgFrame(3, "new"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, { backoffBaseMs: 20 });
    const it = conn.frames[Symbol.asyncIterator]();
    await it.next(); // welcome
    const first = (await it.next()).value as { seq: number };
    conn.ack(first.seq); // 只 ack 第一条，第二条留在队里
    const rest = await collect(conn, 3, 3000, false);
    expect(server.hellos).toEqual([0, 1]);
    const bodies = rest.filter((f) => f.type === "msg").map((f) => (f as { body: string }).body);
    expect(bodies).toEqual(["queued", "new"]);
  });

  test("sends bearer header and hello.since, receives backfill, advances cursor", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(7));
        sock.send(msgFrame(6, "missed one"));
        sock.send(msgFrame(7, "missed two"));
      }
    });
    const cursors: number[] = [];
    conn = connect(server.url, "ap_tok", "dev", 5, {
      onCursor: (c) => cursors.push(c),
    });
    const frames = await collect(conn, 3);
    expect(server.hellos).toEqual([5]);
    expect(server.auths[0]).toBe("Bearer ap_tok");
    expect(frames.map((f) => f.type)).toEqual(["welcome", "msg", "msg"]);
    expect(cursors).toEqual([6, 7]);
    expect(conn.cursor).toBe(7);
  });

  test("sent frame advances cursor (self-echo guard)", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(3));
      if (frame.type === "send") sock.send({ type: "sent", seq: 9 });
    });
    conn = connect(server.url, "ap_tok", "dev", 3);
    const it = conn.frames[Symbol.asyncIterator]();
    await it.next(); // welcome
    conn.send({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null });
    const sent = await it.next();
    expect(sent.value).toEqual({ type: "sent", seq: 9 });
    expect(conn.cursor).toBe(9);
  });

  test("terminal close(1008) ends the stream with an error frame and does not reconnect", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        sock.close(1008, "revoked");
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, { backoffBaseMs: 20 });
    const frames = await collect(conn, 2, 3000, false);
    expect(frames.map((f) => f.type)).toEqual(["welcome", "error"]);
    expect(frames[1]).toMatchObject({ type: "error", code: "unauthorized" });
    // queue.end() 后迭代器彻底结束，且不得重连
    const tail = await collect(conn, 99, 300, false);
    expect(tail).toEqual([]);
    expect(server.connections).toBe(1);
  });

  test("unrecognized 1008 close ends the stream without fabricating an error frame", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        sock.close(1008, "eof");
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, { backoffBaseMs: 20 });
    const frames = await collect(conn, 99, 500, false);
    expect(frames.map((f) => f.type)).toEqual(["welcome"]);
    expect(server.connections).toBe(1);
  });

  test("reconnects with backoff and latest cursor", async () => {
    const hellos: Record<string, unknown>[] = [];
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
      hellos.push(frame as unknown as Record<string, unknown>);
      if (connIndex === 0) {
        sock.send(welcomeFrame(4));
        sock.send(msgFrame(4, "before drop"));
        sock.close();
      } else {
        sock.send(welcomeFrame(4));
        sock.send(msgFrame(5, "after reconnect"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, { backoffBaseMs: 20 });
    const frames = await collect(conn, 4, 5000);
    expect(server.hellos).toEqual([0, 4]);
    expect(hellos).toEqual([
      expect.objectContaining({ since: 0, client_version: pkg.version }),
      expect.objectContaining({ since: 4, client_version: pkg.version }),
    ]);
    const bodies = frames.filter((f) => f.type === "msg").map((f) => (f as { body: string }).body);
    expect(bodies).toEqual(["before drop", "after reconnect"]);
    expect(conn.cursor).toBe(5);
  });

  test("onStatus reports open, then reconnecting across a transient drop, then open again (#254)", async () => {
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(4));
      if (connIndex === 0) sock.close();
    });
    const statuses: Array<{ status: string; error?: string }> = [];
    conn = connect(server.url, "ap_tok", "dev", 0, {
      backoffBaseMs: 20,
      onStatus: (status, detail) => statuses.push({ status, ...(detail?.error ? { error: detail.error } : {}) }),
    });
    // welcome × 2 = handshake completed twice (initial + after reconnect)
    await collect(conn, 2, 3000, false);
    expect(statuses.map((s) => s.status)).toEqual(["open", "reconnecting", "open"]);
  });

  test("onStatus reports closed with the fatal reason on a terminal 1008 close, and never reconnecting", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        sock.close(1008, "revoked");
      }
    });
    const statuses: Array<{ status: string; error?: string }> = [];
    conn = connect(server.url, "ap_tok", "dev", 0, {
      backoffBaseMs: 20,
      onStatus: (status, detail) => statuses.push({ status, ...(detail?.error ? { error: detail.error } : {}) }),
    });
    await collect(conn, 2, 3000, false); // welcome + error
    expect(statuses).toEqual([{ status: "open" }, { status: "closed", error: "token revoked, re-run: party init" }]);
  });

  test("a known network error from the fatal probe is debugged and retried", async () => {
    useProbeWebSocket();
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", { cause });
    }) as unknown as typeof fetch;
    const debug: unknown[][] = [];
    console.debug = (...args: unknown[]) => debug.push(args);
    const statuses: string[] = [];

    conn = connect("https://party.invalid", "ap_tok", "dev", 0, {
      backoffBaseMs: 5,
      onStatus: (status) => statuses.push(status),
    });
    ProbeWebSocket.instances[0]!.failHandshake();
    await Bun.sleep(20);

    expect(debug).toHaveLength(1);
    expect(debug[0]!.join(" ")).toContain("ECONNRESET");
    expect(statuses).toContain("reconnecting");
    expect(ProbeWebSocket.instances.length).toBeGreaterThan(1);
  });

  test("HTTP 403 from the fatal probe becomes a terminal auth frame", async () => {
    useProbeWebSocket();
    globalThis.fetch = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const statuses: Array<{ status: string; error?: string }> = [];

    conn = connect("https://party.invalid", "ap_tok", "dev", 0, {
      backoffBaseMs: 5,
      onStatus: (status, detail) => statuses.push({ status, ...(detail?.error ? { error: detail.error } : {}) }),
    });
    const next = conn.frames[Symbol.asyncIterator]().next();
    ProbeWebSocket.instances[0]!.failHandshake();

    expect((await next).value).toEqual({
      type: "error",
      code: "unauthorized",
      message: "channel access forbidden",
    });
    expect(statuses).toEqual([{ status: "closed", error: "channel access forbidden" }]);
    await Bun.sleep(15);
    expect(ProbeWebSocket.instances).toHaveLength(1);
  });

  test("an unknown fatal-probe exception rejects the frame stream instead of reconnecting", async () => {
    useProbeWebSocket();
    const failure = new Error("probe invariant failed");
    globalThis.fetch = (async () => {
      throw failure;
    }) as unknown as typeof fetch;
    const statuses: Array<{ status: string; error?: string }> = [];

    conn = connect("https://party.invalid", "ap_tok", "dev", 0, {
      backoffBaseMs: 5,
      onStatus: (status, detail) => statuses.push({ status, ...(detail?.error ? { error: detail.error } : {}) }),
    });
    const next = conn.frames[Symbol.asyncIterator]().next();
    ProbeWebSocket.instances[0]!.failHandshake();

    await expect(next).rejects.toBe(failure);
    expect(statuses).toEqual([{ status: "closed", error: "probe invariant failed" }]);
    await Bun.sleep(15);
    expect(ProbeWebSocket.instances).toHaveLength(1);
  });
});
