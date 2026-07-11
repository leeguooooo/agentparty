import { afterEach, describe, expect, test } from "bun:test";
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_LOOP_GUARD, EXIT_STREAM_ENDED, EXIT_TIMEOUT } from "@agentparty/shared";
import { resolveWatchTimeoutSec, runWatch, type WatchOptions } from "../src/commands/watch";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function opts(over: Partial<WatchOptions> & { server: string }): WatchOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    timeoutSec: 3,
    follow: false,
    mentionsOnly: false,
    out: (l) => lines.push(l),
    backoffBaseMs: 20,
    lines,
    ...over,
  };
}

describe("runWatch", () => {
  test("follow mode has no idle timeout unless --timeout is explicit", () => {
    expect(resolveWatchTimeoutSec(undefined, false)).toBe(240);
    expect(resolveWatchTimeoutSec(undefined, true)).toBe(0);
    expect(resolveWatchTimeoutSec(30, true)).toBe(30);
  });

  test("prints backfilled messages and exits 0 once drained", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(2));
        sock.send(msgFrame(1, "line one\nline two"));
        sock.send(msgFrame(2, "second"));
      }
    });
    const o = opts({ server: server.url });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines).toEqual(["[1] bob(agent): line one\n    line two", "[2] bob(agent): second"]);
  });

  test("blocks until a live message arrives, then exits 0", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        setTimeout(() => sock.send(msgFrame(1, "fresh")), 50);
      }
    });
    const o = opts({ server: server.url });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines).toEqual(["[1] bob(agent): fresh"]);
  });

  test("timeout prints TIMEOUT and exits 2", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    const o = opts({ server: server.url, timeoutSec: 0.2 });
    expect(await runWatch(o)).toBe(EXIT_TIMEOUT);
    expect(o.lines).toEqual(["TIMEOUT"]);
  });

  test("json mode prints timeout as an NDJSON frame", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    const o = opts({ server: server.url, timeoutSec: 0.2, json: true });
    expect(await runWatch(o)).toBe(EXIT_TIMEOUT);
    const frame = JSON.parse(o.lines[0]!);
    expect(frame).toMatchObject({
      schema: "agentparty.v1",
      type: "timeout",
      channel: "dev",
      timeout_sec: 0.2,
    });
    expect(typeof frame.ts).toBe("number");
  });

  test("mentions-only ignores messages not mentioning self", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0, "me"));
        setTimeout(() => sock.send(msgFrame(1, "not for me")), 20);
        setTimeout(() => sock.send(msgFrame(2, "for me", { mentions: ["me"] })), 60);
      }
    });
    const o = opts({ server: server.url, mentionsOnly: true });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines).toEqual(["[2] bob(agent): for me"]);
  });

  test("own messages are skipped", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0, "me"));
        setTimeout(() => sock.send(msgFrame(1, "echo", { sender: { name: "me", kind: "agent" } })), 20);
        setTimeout(() => sock.send(msgFrame(2, "reply")), 60);
      }
    });
    const o = opts({ server: server.url });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines).toEqual(["[2] bob(agent): reply"]);
  });

  test("status messages print state and note", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(1));
        sock.send(msgFrame(1, "", { kind: "status", state: "working", note: "fixing api" }));
      }
    });
    const o = opts({ server: server.url });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines).toEqual(["[1] bob(agent): [working] fixing api"]);
  });

  test("json mode prints matching messages as raw NDJSON frames", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(1));
        sock.send(msgFrame(1, "for me", { mentions: ["alice"] }));
      }
    });
    const o = opts({ server: server.url, json: true });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines).toHaveLength(1);
    expect(JSON.parse(o.lines[0]!)).toMatchObject({
      schema: "agentparty.v1",
      type: "msg",
      seq: 1,
      body: "for me",
      mentions: ["alice"],
    });
  });

  test("error frames map to contract exit codes", async () => {
    for (const [code, exit] of [
      ["unauthorized", EXIT_AUTH],
      ["loop_guard", EXIT_LOOP_GUARD],
      ["archived", EXIT_ARCHIVED],
    ] as const) {
      const s = startMockServer((frame, sock) => {
        if (frame.type === "hello") sock.send({ type: "error", code, message: code });
      });
      const o = opts({ server: s.url });
      expect(await runWatch(o)).toBe(exit);
      s.stop();
    }
  });

  test("json mode prints error frames as NDJSON before exiting", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ type: "error", code: "loop_guard", message: "too many agent messages" });
      }
    });
    const o = opts({ server: server.url, json: true });
    expect(await runWatch(o)).toBe(EXIT_LOOP_GUARD);
    const frame = JSON.parse(o.lines[0]!);
    expect(frame).toMatchObject({
      schema: "agentparty.v1",
      type: "error",
      code: "loop_guard",
      message: "too many agent messages",
      retryable: false,
    });
    expect(typeof frame.ts).toBe("number");
  });

  test("self message at the tail still completes the drain promptly", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(4, "me"));
        sock.send(msgFrame(3, "reply"));
        sock.send(msgFrame(4, "own note", { sender: { name: "me", kind: "human" } }));
      }
    });
    const o = opts({ server: server.url, timeoutSec: 5 });
    const started = Date.now();
    expect(await runWatch(o)).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(o.lines).toEqual(["[3] bob(agent): reply"]);
  });

  test("messages queued but not printed before exit are not marked read", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(1));
        sock.send(msgFrame(1, "prints and exits"));
        sock.send(msgFrame(2, "same batch, never printed"));
      }
    });
    const cursors: number[] = [];
    const o = opts({ server: server.url, onCursor: (c) => cursors.push(c) });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines).toEqual(["[1] bob(agent): prints and exits"]);
    // seq 2 未打印，游标不能越过它，留给下次 watch 补拉
    expect(cursors).toEqual([1]);
  });

  test("rejected ws upgrade maps 401 to exit 3 and 404 to exit 1", async () => {
    for (const [status, code, exit] of [
      [401, "unauthorized", EXIT_AUTH],
      [404, "not_found", 1],
    ] as const) {
      const s = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(JSON.stringify({ error: { code, message: "nope" } }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      });
      const o = opts({ server: `http://127.0.0.1:${s.port}`, timeoutSec: 5 });
      const started = Date.now();
      expect(await runWatch(o)).toBe(exit);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(o.lines).toEqual([]);
      s.stop(true);
    }
  });

  test("terminal close(1008,\"archived\") exits EXIT_ARCHIVED without reconnecting", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        sock.close(1008, "archived");
      }
    });
    const o = opts({ server: server.url, follow: true, timeoutSec: 0, json: true });
    expect(await runWatch(o)).toBe(EXIT_ARCHIVED);
    // 终局 close：客户端不得重连一个死频道
    expect(server.connections).toBe(1);
    expect(JSON.parse(o.lines[0]!)).toMatchObject({
      type: "error",
      code: "archived",
      retryable: false,
    });
  });

  test("follow stream ending unexpectedly exits EXIT_STREAM_ENDED, not silent 0", async () => {
    // 服务端用未识别的 1008 直接结束帧流（非终局 error、非 timeout）：连接层放弃，
    // 迭代器结束。watch --follow 必须机器可读地报告并以非零码退出（issue #29）。
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        sock.close(1008, "eof");
      }
    });
    const o = opts({ server: server.url, follow: true, timeoutSec: 0, json: true });
    expect(await runWatch(o)).toBe(EXIT_STREAM_ENDED);
    expect(server.connections).toBe(1);
    expect(JSON.parse(o.lines[0]!)).toMatchObject({
      schema: "agentparty.v1",
      type: "watch_exited",
      reason: "stream_ended",
      channel: "dev",
    });
  });

  test("transient drop still reconnects and is not treated as terminal", async () => {
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
      if (connIndex === 0) {
        sock.send(welcomeFrame(2));
        sock.send(msgFrame(1, "first"));
        sock.close(); // 普通断线（无 1008）→ 应重连
      } else {
        sock.send(welcomeFrame(2));
        sock.send(msgFrame(2, "second"));
      }
    });
    const o = opts({ server: server.url, timeoutSec: 5 });
    expect(await runWatch(o)).toBe(0);
    expect(server.hellos).toEqual([0, 1]);
    expect(o.lines).toEqual(["[1] bob(agent): first", "[2] bob(agent): second"]);
  });

  test("--once blocks past non-matching messages, exits 0 right after the first match", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0, "me"));
        setTimeout(() => sock.send(msgFrame(1, "not for me")), 20);
        setTimeout(() => sock.send(msgFrame(2, "own echo", { sender: { name: "me", kind: "agent" } })), 40);
        setTimeout(() => sock.send(msgFrame(3, "wake", { mentions: ["me"] })), 60);
        // 匹配后立刻退出，这条不应被消费
        setTimeout(() => sock.send(msgFrame(4, "after", { mentions: ["me"] })), 200);
      }
    });
    const cursors: number[] = [];
    const o = opts({ server: server.url, once: true, mentionsOnly: true, timeoutSec: 0, onCursor: (c) => cursors.push(c) });
    const started = Date.now();
    expect(await runWatch(o)).toBe(0);
    // 在 seq=4 到达前就退出（退出即 harness 的唤醒信号）
    expect(Date.now() - started).toBeLessThan(180);
    expect(o.lines).toEqual(["[3] bob(agent): wake", "watch: channel_last_seq=3 lag=0 skipped_mention_seqs=[]"]);
    // 游标推进过匹配消息，下次待命从 seq=3 之后继续
    expect(cursors).toEqual([1, 2, 3]);
  });

  test("--once with a transient drop reconnects and still completes on the first match", async () => {
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
      if (connIndex === 0) {
        sock.send(welcomeFrame(0, "me"));
        sock.close(); // 普通断线 → once 仍应重连接着等
      } else {
        sock.send(welcomeFrame(1, "me"));
        sock.send(msgFrame(1, "wake", { mentions: ["me"] }));
      }
    });
    const o = opts({ server: server.url, once: true, mentionsOnly: true, timeoutSec: 5 });
    expect(await runWatch(o)).toBe(0);
    // 断线前没消费任何消息 → 重连仍从 since=0 开始
    expect(server.hellos).toEqual([0, 0]);
    expect(o.lines).toEqual(["[1] bob(agent): wake", "watch: channel_last_seq=1 lag=0 skipped_mention_seqs=[]"]);
  });

  test("--once stream ending without a match exits EXIT_STREAM_ENDED, not silent 0", async () => {
    // 把退出当唤醒信号的 harness 必须能区分「有消息」和「流挂了」——后者静默 0 会被误当唤醒
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0, "me"));
        sock.close(1008, "eof");
      }
    });
    const o = opts({ server: server.url, once: true, mentionsOnly: true, timeoutSec: 0, json: true });
    expect(await runWatch(o)).toBe(EXIT_STREAM_ENDED);
    expect(JSON.parse(o.lines[0]!)).toMatchObject({ type: "watch_exited", reason: "stream_ended" });
  });

  test("--once ignores replayed revision snapshots and completes only on a fresh message", async () => {
    // 服务端 hello 补拉会无条件重放被编辑过的历史消息（不受 since 约束）——
    // 它可以照常打印，但不能算唤醒（曾把新挂上的 --once 立即假唤醒，seq=123 事故）
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(5, "me"));
        sock.send(msgFrame(1, "ancient but edited", { edited: true, edited_at: 111, edited_by: "bob" }));
        setTimeout(() => sock.send(msgFrame(6, "fresh wake")), 60);
      }
    });
    const o = opts({ server: server.url, once: true, timeoutSec: 5, since: 5 });
    expect(await runWatch(o)).toBe(0);
    // 旧修订照常展示，但完成 --once 的是 fresh 消息
    expect(o.lines).toEqual([
      "[1] bob(agent) {edited}: ancient but edited",
      "[6] bob(agent): fresh wake",
      "watch: channel_last_seq=6 lag=0 skipped_mention_seqs=[]",
    ]);
  });

  test("--once with only replayed revisions never completes (times out)", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(5, "me"));
        sock.send(msgFrame(1, "ancient but edited", { edited: true, edited_at: 111, edited_by: "bob" }));
      }
    });
    const o = opts({ server: server.url, once: true, timeoutSec: 0.3, since: 5 });
    expect(await runWatch(o)).toBe(EXIT_TIMEOUT);
  });

  test("--once with explicit timeout and no match exits TIMEOUT", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0, "me"));
    });
    const o = opts({ server: server.url, once: true, mentionsOnly: true, timeoutSec: 0.2 });
    expect(await runWatch(o)).toBe(EXIT_TIMEOUT);
    expect(o.lines).toEqual(["TIMEOUT"]);
  });

  test("cursor callback fires for received messages", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(2));
        sock.send(msgFrame(1, "a"));
        sock.send(msgFrame(2, "b"));
      }
    });
    const cursors: number[] = [];
    const o = opts({ server: server.url, onCursor: (c) => cursors.push(c) });
    expect(await runWatch(o)).toBe(0);
    expect(cursors).toEqual([1, 2]);
  });
});
