// issue #99 跨机那半（客户端侧）：serve 挂上后向服务端 claim serve 租约；只有服务端回 held=true 的那台
// 才跑 runner。收到 held=false（另一台在跑）就转 standby：被 @ 不触发 runner，但保留为未确认帧；
// 持租者掉线后服务端补发 held=true，standby 顶上并按序重放。老服务端不认租约、
// 从不下发 serve_lease → 客户端默认持租（held 未知即照跑），不回归。
import { afterEach, describe, expect, test } from "bun:test";
import type { ClientFrame } from "@agentparty/shared";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  test("held=false（另一台持租）：@我 不跑 runner，也不推进游标吞掉 wake", async () => {
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
    expect(cursors).not.toContain(1); // standby 保留未确认，租约接管后才能重放
    expect(o.lines.some((l) => l.includes("standby") || l.includes("租约"))).toBe(true);
  });

  test("held=false 不会上报 standby 机器持久化的旧 agent session", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "ap-standby-session-"));
    tempDirs.push(workdir);
    writeFileSync(join(workdir, "wake-session.json"), JSON.stringify({
      harness: "codex",
      session_id: "codex-standby-session",
      created_at: 1000,
      last_wake_ts: 2000,
      wakes: 3,
      cwd: "/workspace/stale",
      workdir,
    }));
    const clientFrames: ClientFrame[] = [];
    server = startMockServer((frame, sock) => {
      clientFrames.push(frame);
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      // 故意晚于旧实现的 250ms 猜测窗口，证明网络慢时也不会先泄漏 standby session。
      setTimeout(() => sock.send(leaseFrame(false)), 300);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 360);
    });

    await runServe(opts({
      server: server.url,
      builtinRunner: { server: server.url, token: "ap_tok", channel: "dev", harness: "codex", workdir },
    }));

    expect(clientFrames.some((frame) =>
      frame.type === "heartbeat" && frame.agent_session?.session_id === "codex-standby-session"
    )).toBe(false);
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

  test("takeover：held=false 期间的 @ 与接管后的 @ 都按序送达", async () => {
    const ran: number[] = [];
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(leaseFrame(false)), 15);
      setTimeout(() => sock.send(msgFrame(1, "@me while standby", { mentions: ["me"] })), 30);
      setTimeout(() => sock.send(leaseFrame(true)), 45);
      setTimeout(() => sock.send(msgFrame(2, "@me after takeover", { mentions: ["me"] })), 60);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 100);
    });
    const o = opts({ server: server.url, runCommand: async (frame) => { ran.push(frame.seq); } });
    await runServe(o);
    expect(ran).toEqual([1, 2]);
    expect(o.lines.some((line) => line.includes("重放 1 条未确认帧"))).toBe(true);
  });

  test("runner 在租约变更到 standby 前已经启动时允许 drain 完成", async () => {
    const events: string[] = [];
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(leaseFrame(true)), 10);
      setTimeout(() => sock.send(msgFrame(1, "@me long wake", { mentions: ["me"] })), 20);
      setTimeout(() => sock.send(leaseFrame(false)), 30);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 100);
    });
    const o = opts({
      server: server.url,
      runCommand: async () => {
        events.push("started");
        await new Promise((resolve) => setTimeout(resolve, 50));
        events.push("finished");
      },
    });
    await runServe(o);
    expect(events).toEqual(["started", "finished"]);
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

  test("serve 在 hello 声明 directed-delivery v1，并在 welcome 后 claim 租约", async () => {
    const clientFrames: ClientFrame[] = [];
    server = startMockServer((frame, sock) => {
      clientFrames.push(frame);
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 40);
    });
    const o = opts({ server: server.url, runCommand: async () => {} });
    await runServe(o);
    const hello = clientFrames.find((f) => f.type === "hello");
    expect(hello).toMatchObject({ directed_delivery: "v1" });
    const claim = clientFrames.find((f) => (f as { type: string }).type === "serve_lease");
    expect(claim).toBeDefined();
    expect((claim as { op?: string }).op).toBe("claim");
  });
});
