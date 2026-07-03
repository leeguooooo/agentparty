import { afterEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agentparty/shared";
import { connect, type Connection } from "../src/client";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
let conn: Connection | null = null;

afterEach(() => {
  conn?.close();
  conn = null;
  server?.stop();
  server = null;
});

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

  test("reconnects with backoff and latest cursor", async () => {
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
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
    const bodies = frames.filter((f) => f.type === "msg").map((f) => (f as { body: string }).body);
    expect(bodies).toEqual(["before drop", "after reconnect"]);
    expect(conn.cursor).toBe(5);
  });
});
