import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { EXIT_ARCHIVED, type MsgFrame } from "@agentparty/shared";
import { runServe, writeContextFile, type ServeOptions } from "../src/commands/serve";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function opts(over: Partial<ServeOptions> & { server: string }): ServeOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: (line) => lines.push(line),
    lines,
    ...over,
  };
}

function closeAfterOneMention() {
  server = startMockServer((frame, sock) => {
    if (frame.type !== "hello") return;
    sock.send(welcomeFrame(0, "me"));
    setTimeout(() => sock.send(msgFrame(1, "wake up", { mentions: ["me"] })), 20);
    setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 60);
  });
  return server;
}

describe("runServe", () => {
  test("runs the command once for a mention and advances cursor after handling it", async () => {
    const s = closeAfterOneMention();
    const cursors: number[] = [];
    const seen: { frame: MsgFrame; self: string }[] = [];
    const o = opts({
      server: s.url,
      onCursor: (cursor) => cursors.push(cursor),
      runCommand: async (frame, ctx) => {
        seen.push({ frame, self: ctx.self });
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.frame.seq).toBe(1);
    expect(seen[0]!.self).toBe("me");
    expect(cursors).toEqual([1]);
  });

  test("reports a non-zero runner exit instead of silently swallowing it", async () => {
    const s = closeAfterOneMention();
    const o = opts({ server: s.url, cmd: "exit 7" });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(o.lines.some((line) => line.includes("命令失败: command exited 7"))).toBe(true);
  });

  test("advertises wake capability once on attach, before handling mentions", async () => {
    const s = closeAfterOneMention();
    let advertiseCalls = 0;
    const order: string[] = [];
    const o = opts({
      server: s.url,
      advertise: async () => {
        advertiseCalls++;
        order.push("advertise");
      },
      runCommand: async () => {
        order.push("mention");
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(advertiseCalls).toBe(1); // 只声明一次
    expect(order).toEqual(["advertise", "mention"]); // 声明先于处理 @
  });

  test("passes the recent channel messages (before the trigger) to the runner context", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      // 未 @ 的闲聊 + 自己的消息都属于上下文；触发消息本身不进 recent
      setTimeout(() => sock.send(msgFrame(1, "earlier chatter", { mentions: [] })), 10);
      setTimeout(() => sock.send(msgFrame(2, "my own note", { sender: { name: "me", kind: "agent" } })), 25);
      setTimeout(() => sock.send(msgFrame(3, "wake up", { mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 80);
    });
    const seen: { frame: MsgFrame; recent: MsgFrame[] }[] = [];
    const o = opts({
      server: server.url,
      runCommand: async (frame, ctx) => {
        seen.push({ frame, recent: ctx.recent });
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.frame.seq).toBe(3);
    expect(seen[0]!.recent.map((m) => m.seq)).toEqual([1, 2]);
  });

  test("writeContextFile embeds recent messages and the history reminder", () => {
    const trigger = msgFrame(9, "do the thing", { mentions: ["me"] }) as unknown as MsgFrame;
    const prior = [
      msgFrame(7, "context A") as unknown as MsgFrame,
      msgFrame(8, "x".repeat(500)) as unknown as MsgFrame, // 正文要截断
    ];
    const path = writeContextFile(trigger, "dev", "me", prior);
    try {
      const ctx = JSON.parse(readFileSync(path, "utf8"));
      expect(ctx).toMatchObject({ channel: "dev", seq: 9, self: "me", reply_to: 9 });
      expect(ctx.recent.map((m: { seq: number }) => m.seq)).toEqual([7, 8]);
      expect(ctx.recent[1].body).toHaveLength(400);
      expect(ctx.protocol_reminder).toContain("party history");
    } finally {
      unlinkSync(path);
    }
  });

  test("a failing advertise does not crash the server", async () => {
    const s = closeAfterOneMention();
    const seen: number[] = [];
    const o = opts({
      server: s.url,
      advertise: async () => {
        throw new Error("network down");
      },
      runCommand: async (frame) => {
        seen.push(frame.seq);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([1]); // 声明失败仍继续服务
    expect(o.lines.some((line) => line.includes("wake 能力声明失败"))).toBe(true);
  });
});
