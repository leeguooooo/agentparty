// #672 Phase-1 spike：party daemon 单测。用真 connect + WS mock server 驱动帧流，注入 SDK runner
// 与 postReply 捕获回帖——CI 永不触碰真 @anthropic-ai/claude-agent-sdk（SDK 无法在 CI 跑）。
import { afterEach, describe, expect, test } from "bun:test";
import { runDaemon, type DaemonOptions, type PostReply, type SdkRunner } from "../src/commands/daemon";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

interface Captured {
  reply: Parameters<PostReply>[0][];
  runCalls: { prompt: string; sender: string; seq: number }[];
  lines: string[];
}

function harness(over: {
  runner: SdkRunner;
  server: string;
}): { opts: DaemonOptions; captured: Captured } {
  const captured: Captured = { reply: [], runCalls: [], lines: [] };
  const postReply: PostReply = async (r) => {
    captured.reply.push(r);
  };
  const opts: DaemonOptions = {
    server: over.server,
    token: "ap_tok",
    channel: "dev",
    since: 0,
    runner: over.runner,
    postReply,
    backoffBaseMs: 20,
    // 收完 welcome + 一条 @ 后由 mock 关闭连接触发帧流结束；短 timeout 兜底防挂。
    timeoutSec: 3,
    out: (l) => captured.lines.push(l),
  };
  return { opts, captured };
}

function recordingRunner(reply: string): { runner: SdkRunner; calls: Captured["runCalls"] } {
  const calls: Captured["runCalls"] = [];
  return {
    calls,
    runner: {
      async run(prompt, ctx) {
        calls.push({ prompt, sender: ctx.sender, seq: ctx.seq });
        return reply;
      },
    },
  };
}

describe("party daemon (#672 Phase-1 spike)", () => {
  test("@-mention → SDK invoked with mention text → SDK output posted back", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      sock.send(msgFrame(1, "please summarize the thread", { mentions: ["me"] }));
      // 让 daemon 处理完后自然收束：关闭连接结束帧流。
      setTimeout(() => sock.close(), 60);
    });

    const { runner, calls } = recordingRunner("here is your summary");
    const { opts, captured } = harness({ runner, server: server.url });
    await runDaemon(opts);

    // SDK 被调用一次，拿到的是 @-mention 正文（不是整帧）。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("please summarize the thread");
    expect(calls[0]!.sender).toBe("bob");
    expect(calls[0]!.seq).toBe(1);

    // SDK 返回文本被原样回帖，@ 回发起人、reply_to 指向原消息。
    expect(captured.reply).toHaveLength(1);
    expect(captured.reply[0]).toEqual({
      body: "here is your summary",
      mentions: ["bob"],
      replyTo: 1,
    });
  });

  test("hello advertises a wake kind so presence sees a live wake channel (Phase-1: watch)", async () => {
    let helloWakeKind: unknown = "unset";
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      helloWakeKind = (frame as unknown as { wake_kind?: unknown }).wake_kind;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.close(), 30);
    });

    const { runner } = recordingRunner("noop");
    const { opts } = harness({ runner, server: server.url });
    await runDaemon(opts);

    // Phase-1 捷径：daemon 复用 watch 唤醒声明，协议不动。
    expect(helloWakeKind).toBe("watch");
  });

  test("SDK error → posts a short failure note, does not crash, keeps serving", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      sock.send(msgFrame(1, "do the thing", { mentions: ["me"] }));
      sock.send(msgFrame(2, "second try", { mentions: ["me"] }));
      setTimeout(() => sock.close(), 80);
    });

    let calls = 0;
    const runner: SdkRunner = {
      async run() {
        calls++;
        throw new Error("model unavailable");
      },
    };
    const { opts, captured } = harness({ runner, server: server.url });
    // 不应抛：graceful 处理。
    await runDaemon(opts);

    // 两条 @ 都被尝试（进程未因第一条报错而崩溃）。
    expect(calls).toBe(2);
    // 每条都回了一条失败提示（含错误摘要），@ 回发起人、reply_to 指向原消息。
    expect(captured.reply).toHaveLength(2);
    expect(captured.reply[0]!.body).toContain("model unavailable");
    expect(captured.reply[0]!.mentions).toEqual(["bob"]);
    expect(captured.reply[0]!.replyTo).toBe(1);
    expect(captured.reply[1]!.replyTo).toBe(2);
  });

  test("ignores own messages and non-mentions (no SDK call, no reply)", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      // 自己发的（即便 @self）不唤醒
      sock.send(msgFrame(1, "self note", { sender: { name: "me", kind: "agent" }, mentions: ["me"] }));
      // 别人发但没 @ 我
      sock.send(msgFrame(2, "chatter", { mentions: [] }));
      setTimeout(() => sock.close(), 60);
    });

    const { runner, calls } = recordingRunner("should not run");
    const { opts, captured } = harness({ runner, server: server.url });
    await runDaemon(opts);

    expect(calls).toHaveLength(0);
    expect(captured.reply).toHaveLength(0);
  });

  test("empty SDK result falls back to a placeholder reply (never posts empty)", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      sock.send(msgFrame(1, "hi", { mentions: ["me"] }));
      setTimeout(() => sock.close(), 60);
    });

    const { runner } = recordingRunner("   ");
    const { opts, captured } = harness({ runner, server: server.url });
    await runDaemon(opts);

    expect(captured.reply).toHaveLength(1);
    expect(captured.reply[0]!.body.length).toBeGreaterThan(0);
  });

  test("abortSignal (SIGTERM) closes the connection and returns cleanly", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      // 不发消息、不关闭：靠 abort 收束。
    });

    const controller = new AbortController();
    const { runner } = recordingRunner("noop");
    const { opts } = harness({ runner, server: server.url });
    opts.abortSignal = controller.signal;
    opts.timeoutSec = 0; // 常驻，仅靠 abort 退出

    const done = runDaemon(opts);
    // 等 attach 后再 abort
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const code = await done;
    // 干净关停返回 0（run() 再据信号翻成 128+signo）。
    expect(code).toBe(0);
  });
});
