// issue #99 跨机那半（客户端侧）：serve 挂上后向服务端 claim serve 租约；只有服务端回 held=true 的那台
// 才跑 runner。收到 held=false（另一台在跑）就转 standby：被 @ 也不触发 runner，消息仍进历史、游标照推进
// （与 #180 暂停接待同路径）。持租者掉线后服务端补发 held=true，standby 顶上开始跑。老服务端不认租约、
// 从不下发 serve_lease → 客户端默认持租（held 未知即照跑），不回归。
import { afterEach, describe, expect, test } from "bun:test";
import type { ClientFrame } from "@agentparty/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runServe, type ServeOptions } from "../src/commands/serve";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  server?.stop();
  server = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function opts(over: Partial<ServeOptions> & { server: string }): ServeOptions & { lines: string[] } {
  const lines: string[] = [];
  const lockDir = mkdtempSync(join(tmpdir(), "ap-lock-"));
  tempDirs.push(lockDir);
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: (line) => lines.push(line),
    lines,
    lockDir,
    ...over,
  };
}

function leaseFrame(held: boolean, name = "me") {
  return { type: "serve_lease", name, held };
}

describe("serve 跨机租约客户端互斥（#99）", () => {
  test("held=false（另一台持租）：@我 不跑 runner，但游标仍推进（standby）", async () => {
    let ran = 0;
    const cursors: number[] = [];
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(leaseFrame(false)), 20);
      setTimeout(() => sock.send(msgFrame(1, "@me wake up", { mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 80);
    });
    const o = opts({ server: server.url, onCursor: (c) => cursors.push(c), runCommand: async () => { ran++; } });
    await runServe(o);
    expect(ran).toBe(0); // 不持租：runner 一次都没跑
    expect(cursors).toContain(1); // 消息仍被消费、游标推进（不留欠账）
    expect(o.lines.some((l) => l.includes("standby") || l.includes("租约"))).toBe(true);
  });

  test("held=true（本台持租）：@我 正常唤醒 runner", async () => {
    let ran = 0;
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(leaseFrame(true)), 20);
      setTimeout(() => sock.send(msgFrame(1, "@me wake up", { mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 80);
    });
    const o = opts({ server: server.url, runCommand: async () => { ran++; } });
    await runServe(o);
    expect(ran).toBe(1);
  });

  test("takeover：先 held=false 跳过，收到 held=true 后的 @ 才跑", async () => {
    let ran = 0;
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(leaseFrame(false)), 15);
      setTimeout(() => sock.send(msgFrame(1, "@me while standby", { mentions: ["me"] })), 30);
      setTimeout(() => sock.send(leaseFrame(true)), 45);
      setTimeout(() => sock.send(msgFrame(2, "@me after takeover", { mentions: ["me"] })), 60);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 100);
    });
    const o = opts({ server: server.url, runCommand: async () => { ran++; } });
    await runServe(o);
    expect(ran).toBe(1); // 只跑了 takeover 之后的那条
  });

  test("老服务端从不下发 serve_lease：客户端默认持租，照常唤醒（不回归）", async () => {
    let ran = 0;
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "@me wake up", { mentions: ["me"] })), 30);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 70);
    });
    const o = opts({ server: server.url, runCommand: async () => { ran++; } });
    await runServe(o);
    expect(ran).toBe(1);
  });

  test("serve 挂上后向服务端 claim 租约（welcome 后发 serve_lease op=claim）", async () => {
    const clientFrames: ClientFrame[] = [];
    server = startMockServer((frame, sock) => {
      clientFrames.push(frame);
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 40);
    });
    const o = opts({ server: server.url, runCommand: async () => {} });
    await runServe(o);
    const claim = clientFrames.find((f) => (f as { type: string }).type === "serve_lease");
    expect(claim).toBeDefined();
    expect((claim as { op?: string }).op).toBe("claim");
  });
});
