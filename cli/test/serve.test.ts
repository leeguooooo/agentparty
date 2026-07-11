import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { EXIT_ARCHIVED, type Attachment, type MsgFrame } from "@agentparty/shared";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBuiltinRunner,
  createSdkRunner,
  projectAgentChildName,
  pendingWakeDepth,
  run as runServeCommand,
  runProfileServe,
  runServe,
  writeContextFile,
  type CodexLike,
  type RunnerProcess,
  type ServeOptions,
  type ThreadLike,
} from "../src/commands/serve";
import type { MessagePayload } from "../src/rest";
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
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: (line) => lines.push(line),
    lines,
    // 每个测试一把独立的单实例锁（#99）：测试不该依赖真实 ~/.agentparty，
    // 也不该互相抢锁（第二个 runServe 会被拒并返回 EXIT_ALREADY_SERVING）
    lockDir: mkdtempSync(join(tmpdir(), "ap-lock-")),
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

function tempDir(prefix = "ap-serve-runner-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function triggerFrame(seq = 7): MsgFrame {
  return msgFrame(seq, "wake up", { mentions: ["me"] }) as unknown as MsgFrame;
}

function runnerCtx() {
  return { cmd: "", channel: "dev", self: "me", contextDir: tempDir("ap-ctx-"), recent: [] as MsgFrame[] };
}

function uuid(n: number): string {
  return `019f35d9-0000-7000-8000-00000000000${n}`;
}

function postRecorder() {
  const posts: Array<{ server: string; token: string; channel: string; body: MessagePayload }> = [];
  return {
    posts,
    post: async (server: string, token: string, channel: string, body: MessagePayload) => {
      posts.push({ server, token, channel, body });
      return { seq: posts.length };
    },
  };
}

function uploadRecorder() {
  const uploads: Array<{ server: string; token: string; channel: string; filename: string; bytes: Uint8Array; contentType: string }> = [];
  return {
    uploads,
    upload: async (server: string, token: string, channel: string, filename: string, bytes: Uint8Array, contentType: string): Promise<Attachment> => {
      uploads.push({ server, token, channel, filename, bytes: Uint8Array.from(bytes), contentType });
      return {
        key: `${channel}/00000000-0000-4000-8000-000000000000/${filename}`,
        filename,
        content_type: contentType,
        size: bytes.byteLength,
        url: `/api/channels/${channel}/attachments/00000000-0000-4000-8000-000000000000/${filename}`,
      };
    },
  };
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

  // busy + 队列深度（#103）：serve 串行处理长任务时不再假装可即时响应。
  test("busy lifecycle: builtin runner marks busy on the working frame, then serve clears it when idle", async () => {
    const s = closeAfterOneMention();
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "answer\n");
      return { code: 0, stdout: `session id: ${uuid(1)}\n`, stderr: "" };
    };
    const o = opts({
      server: s.url,
      post,
      builtinRunner: { server: s.url, token: "ap_tok", channel: "dev", harness: "codex", workdir, runProcess, post },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);

    // 处理这条 wake 时自报「忙」（无积压 → queue_depth 0）
    const working = posts.find((p) => (p.body as { state?: string }).state === "working");
    expect(working, "runner must post a working frame").toBeDefined();
    expect(working!.body).toMatchObject({ kind: "status", state: "working", busy: true, queue_depth: 0 });

    // 收尾补一条「空闲」把 busy 清回 false——任务结束就不再假忙
    const idle = posts.find((p) => (p.body as { state?: string; busy?: boolean }).state === "waiting" && (p.body as { busy?: boolean }).busy === false);
    expect(idle, "serve must post a busy=false idle-clear once the queue drains").toBeDefined();
    expect(idle!.body).toMatchObject({ kind: "status", state: "waiting", busy: false, queue_depth: 0 });

    // 顺序：先忙后清
    expect(posts.indexOf(working!)).toBeLessThan(posts.indexOf(idle!));
  });

  // 每任务进度/心跳（#228，扩 #103 busy）：run() 阻塞串行循环数分钟时，靠 setInterval 侧信道
  // 周期性发 presence-only 的 heartbeat 帧（不落 history），频道/本机都能看到「正在处理 seq=X、活到 T」。
  test("task heartbeat: while a wake runs, serve emits advancing heartbeats with current_task, then clears on completion", async () => {
    const beats: Array<{ current_task: number | null; task_started_at: number | null; heartbeat_at: number | null }> = [];
    server = startMockServer((frame, sock) => {
      if (frame.type === "heartbeat") {
        beats.push(frame as unknown as (typeof beats)[number]);
        return;
      }
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "long task", { mentions: ["me"] })), 10);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 250);
    });
    let tick = 0;
    const o = opts({
      server: server.url,
      heartbeatIntervalMs: 8,
      now: () => (tick += 1000),
      // 自定义（注入）runner：阻塞 ~70ms 模拟长任务；#228 的重点就是让自定义 runner 也被看见。
      runCommand: async () => {
        await new Promise((r) => setTimeout(r, 70));
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);

    const active = beats.filter((b) => b.current_task === 1);
    // 立刻一拍 started + 至少一拍间隔心跳
    expect(active.length, "must emit a started beat plus periodic heartbeats while the task runs").toBeGreaterThanOrEqual(2);
    // heartbeat_at 严格递增 —— 证明心跳真的在推进（不是发同一个时间戳）
    for (let i = 1; i < active.length; i++) {
      expect(active[i]!.heartbeat_at!).toBeGreaterThan(active[i - 1]!.heartbeat_at!);
      expect(active[i]!.task_started_at).toBe(active[0]!.task_started_at);
    }
    // 收尾清除：一条 current_task=null，且在所有活跃心跳之后
    const clears = beats.filter((b) => b.current_task === null);
    expect(clears.length, "must clear the running task once it finishes").toBeGreaterThanOrEqual(1);
    expect(beats.lastIndexOf(active[active.length - 1]!)).toBeLessThan(beats.indexOf(clears[0]!));
  });

  // 本机操作者可见性（#228）：health.json 盖上正在处理的 seq，任务结束清回 null。
  test("task heartbeat: stamps current_task into the local health file and clears it on completion", async () => {
    const { readHealthCache } = await import("../src/health-cache");
    const prevHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = tempDir("ap-hb-home-");
    try {
      let seenDuringRun: number | null = null;
      server = startMockServer((frame, sock) => {
        if (frame.type === "hello") {
          sock.send(welcomeFrame(0, "me"));
          setTimeout(() => sock.send(msgFrame(1, "long task", { mentions: ["me"] })), 10);
          setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 200);
        }
      });
      const o = opts({
        server: server.url,
        heartbeatIntervalMs: 8,
        runCommand: async () => {
          await new Promise((r) => setTimeout(r, 60));
          // 任务执行到一半时，health.json 应该已经写上 current_task=1
          seenDuringRun = readHealthCache()?.current_task ?? null;
        },
      });

      expect(await runServe(o)).toBe(EXIT_ARCHIVED);
      expect(seenDuringRun as number | null, "health.json must show the running task while it executes").toBe(1);
      expect(readHealthCache()?.current_task, "health.json must clear the task once it finishes").toBeNull();
    } finally {
      if (prevHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = prevHome;
    }
  });

  test("reports a non-zero runner exit instead of silently swallowing it", async () => {
    const s = closeAfterOneMention();
    // 每次失败都打印，并带上「第几次/共几次」——有界重试的进度必须可见（#198）
    const o = opts({ server: s.url, cmd: "exit 7", maxWakeAttempts: 1, wakeRetryDelayMs: 0, post: async () => ({ seq: 1 }) });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(o.lines.some((line) => line.includes("命令失败 (1/1): command exited 7"))).toBe(true);
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
    const path = writeContextFile(tempDir("ap-ctx-"), trigger, "dev", "me", prior);
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

  test("replayed revision snapshot of an old mention does not re-trigger the runner", async () => {
    // 旧 @ 被编辑过 → 服务端每次连接都重放它；runner 只能被真正未消费的新消息触发
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(5, "me"));
      sock.send(msgFrame(1, "old mention, later edited", { mentions: ["me"], edited: true, edited_at: 111, edited_by: "bob" }));
      setTimeout(() => sock.send(msgFrame(6, "fresh mention", { mentions: ["me"] })), 30);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 80);
    });
    const seen: number[] = [];
    const o = opts({
      server: server.url,
      since: 5,
      runCommand: async (frame) => {
        seen.push(frame.seq);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([6]); // 只有 fresh 的 seq=6，重放的 seq=1 不触发
  });

  test("--auto-upgrade re-execs the newer on-disk binary at the post-ack safe point (issue #45)", async () => {
    const { EXIT_UPGRADED } = await import("@agentparty/shared");
    const s = closeAfterOneMention();
    const reexec: Array<{ path: string; argv: string[] }> = [];
    let ran = 0;
    const o = opts({
      server: s.url,
      autoUpgrade: true,
      upgradeDeps: {
        runningVersion: "0.2.60",
        execPath: "/usr/local/bin/party",
        readInstalledVersion: () => "0.2.61",
        reexec: (path, argv) => reexec.push({ path, argv }),
      },
      runCommand: async () => {
        ran++;
      },
    });

    // 处理完 seq=1、ack 后的安全点发现磁盘新版 → re-exec 并退出（EXIT_UPGRADED），不等 archived
    expect(await runServe(o)).toBe(EXIT_UPGRADED);
    expect(ran).toBe(1);
    expect(reexec).toHaveLength(1);
    expect(reexec[0]!.path).toBe("/usr/local/bin/party");
    expect(o.lines.some((l) => l.includes("新版接管"))).toBe(true);
  });

  test("without --auto-upgrade a newer on-disk binary is nudged once, not re-execed", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "a", { mentions: ["me"] })), 20);
      setTimeout(() => sock.send(msgFrame(2, "b", { mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 80);
    });
    const reexec: string[] = [];
    const o = opts({
      server: server.url,
      autoUpgrade: false,
      upgradeDeps: {
        runningVersion: "0.2.60",
        execPath: "/usr/local/bin/party",
        readInstalledVersion: () => "0.2.61",
        reexec: (p) => reexec.push(p),
      },
      runCommand: async () => {},
    });
    expect(await runServe(o)).toBe(EXIT_ARCHIVED); // 不因升级退出
    expect(reexec).toHaveLength(0); // 没 re-exec
    // 提示只播一次（两条消息两个安全点，但只 nudge 一次）
    expect(o.lines.filter((l) => l.includes("重启 serve 或加 --auto-upgrade")).length).toBe(1);
  });

  test("passes a pending CLI upgrade notice into the runner context before handling a mention", async () => {
    const s = closeAfterOneMention();
    const notices: unknown[] = [];
    const o = opts({
      server: s.url,
      autoUpgrade: false,
      upgradeDeps: {
        runningVersion: "0.2.72",
        execPath: "/usr/local/bin/party",
        readInstalledVersion: () => "0.2.73",
      },
      runCommand: async (_frame, ctx) => {
        notices.push(ctx.cliUpgrade);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(notices[0]).toMatchObject({
      running_version: "0.2.72",
      installed_version: "0.2.73",
      auto_upgrade: false,
      action_required: "ask_user",
    });
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

describe("builtin runner", () => {
  test("codex cold-starts, persists the session id, then resumes it on the next wake", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const calls: string[][] = [];
    const runProcess: RunnerProcess = async (args) => {
      calls.push(args);
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, calls.length === 1 ? "cold answer\n" : "resume answer\n");
      return {
        code: 0,
        stdout: calls.length === 1 ? `session id: ${uuid(1)}\n` : "",
        stderr: "",
      };
    };
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
    });

    await run(triggerFrame(1), runnerCtx());
    await run(triggerFrame(2), runnerCtx());

    const state = JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8"));
    expect(state).toMatchObject({ harness: "codex", session_id: uuid(1), wakes: 2 });
    expect(calls[0]!.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(calls[1]!.slice(0, 4)).toEqual(["codex", "exec", "resume", uuid(1)]);
    const log = readFileSync(join(workdir, "serve-runner.log"), "utf8");
    expect(log).toContain("seq=1 sid=019f35d9");
    expect(log).toContain("seq=2 sid=019f35d9");
    expect(log).toContain("exit=0");
  });

  test("[attach:path] uploads the file to R2 and references it as an attachment, not inlined (#41/#109)", async () => {
    const { posts, post } = postRecorder();
    const { uploads, upload } = uploadRecorder();
    const workdir = tempDir();
    const payload = tempDir();
    const attachFile = join(payload, "delivery.diff");
    // 逐字节内容,含会被模型转述损坏的东西:diff hunk 头、trailing space、无尾换行
    const bytes = "diff --git a/x b/x\n@@ -1,2 +1,2 @@ f() {\n-old   \n+new\n}";
    writeFileSync(attachFile, bytes);
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, `summary line the model wrote\n[attach:${attachFile}]\n`);
      return { code: 0, stdout: `session id: ${uuid(1)}\n`, stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
      uploadAttachment: upload,
    })(triggerFrame(41), runnerCtx());

    // 交付物逐字节上传到 R2（不做 utf8 往返、不经模型转述），保住 #41 的完整性
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.filename).toBe("delivery.diff");
    expect(Buffer.from(uploads[0]!.bytes).toString("utf8")).toBe(bytes);

    const finalPost = posts.at(-1)!;
    expect(finalPost.body).toMatchObject({ kind: "message", reply_to: 41 });
    const msg = finalPost.body as { body: string; attachments?: Array<{ filename: string }> };
    // 正文不再是文件内容（不再 inline → 不再撞 BODY_LIMIT / 413）；文件以附件引用随消息带上
    expect(msg.body).not.toBe(bytes);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]!.filename).toBe("delivery.diff");
  });

  test("oversize reply body is uploaded to R2 and referenced as an attachment, never a 413 (#109)", async () => {
    const { posts, post } = postRecorder();
    const { uploads, upload } = uploadRecorder();
    const workdir = tempDir();
    // 超过 BODY_LIMIT(100_000) 的正文：旧路径会 inline → worker 413 → 交付物静默丢失
    const huge = "x".repeat(100_001);
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, huge);
      return { code: 0, stdout: `session id: ${uuid(1)}\n`, stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
      uploadAttachment: upload,
    })(triggerFrame(50), runnerCtx());

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.bytes.byteLength).toBeGreaterThan(100_000);
    const finalPost = posts.at(-1)!;
    const msg = finalPost.body as { kind: string; body: string; attachments?: unknown[] };
    expect(msg.kind).toBe("message");
    expect(msg.attachments).toHaveLength(1);
    // 送出的正文本身不再超限（否则 worker 仍会 413）
    expect(Buffer.byteLength(msg.body, "utf8")).toBeLessThanOrEqual(100_000);
  });

  test("[attach] upload failure blocks the wake and posts no partial message (#109)", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    const payload = tempDir();
    const attachFile = join(payload, "delivery.diff");
    writeFileSync(attachFile, "some artifact bytes");
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, `[attach:${attachFile}]\n`);
      return { code: 0, stdout: `session id: ${uuid(1)}\n`, stderr: "" };
    };
    const upload = async (): Promise<Attachment> => {
      throw new Error("attachment endpoint rejected: 413 too_large");
    };

    // 唤醒未送达：抛给调用方（否则 runServe 会 ack 掉这条 @），最终 blocked 由 runServe 统一发
    await expect(
      createBuiltinRunner({
        server: "http://agentparty.test",
        token: "ap_tok",
        channel: "dev",
        harness: "codex",
        workdir,
        runProcess,
        post,
        uploadAttachment: upload,
      })(triggerFrame(51), runnerCtx()),
    ).rejects.toThrow(/413 too_large/);

    // 绝不发部分正文（附件上传失败就整条不发）
    expect(posts.some((p) => (p.body as { kind?: string }).kind === "message")).toBe(false);
  });

  test("upload failure surfaces as a blocked status carrying the reason (runServe end to end, #109)", async () => {
    const s = closeAfterOneMention();
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    const huge = "x".repeat(100_001);
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, huge);
      return { code: 0, stdout: `session id: ${uuid(1)}\n`, stderr: "" };
    };
    const upload = async (): Promise<Attachment> => {
      throw new Error("attachment endpoint rejected: 413 too_large");
    };
    const o = opts({
      server: s.url,
      post,
      maxWakeAttempts: 1,
      builtinRunner: { server: s.url, token: "ap_tok", channel: "dev", harness: "codex", workdir, runProcess, post, uploadAttachment: upload },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);

    const blocked = posts.find((p) => (p.body as { state?: string }).state === "blocked");
    expect(blocked).toBeDefined();
    // 不是静默 413：原因透传到 blocked_reason，人能看见交付为什么没送达
    expect((blocked!.body as { blocked_reason?: string }).blocked_reason).toContain("413 too_large");
    // 既然上传失败，绝不发出（半截）消息
    expect(posts.some((p) => (p.body as { kind?: string }).kind === "message")).toBe(false);
  });

  test("[attach] with a relative path is refused, throws, and posts no partial body (issue #41)", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "[attach:relative.diff]\n");
      return { code: 0, stdout: `session id: ${uuid(1)}\n`, stderr: "" };
    };

    // 唤醒未送达：既发 blocked，也抛给调用方（否则 runServe 会 ack 掉这条 @）
    await expect(
      createBuiltinRunner({
        server: "http://agentparty.test",
        token: "ap_tok",
        channel: "dev",
        harness: "codex",
        workdir,
        runProcess,
        post,
      })(triggerFrame(42), runnerCtx()),
    ).rejects.toThrow(/path must be absolute/);

    // runner 只回报失败信号，最终 blocked 由 runServe 在预算耗尽后统一发（#206 门禁 P1②）
    expect(posts.some((p) => (p.body as { state?: string }).state === "blocked")).toBe(false);
    // 绝不发部分正文
    expect(posts.some((p) => (p.body as { kind: string }).kind === "message")).toBe(false);
  });

  test("output without an [attach] marker falls back to the model text with session marker", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "plain narrative answer\n");
      return { code: 0, stdout: `session id: ${uuid(1)}\n`, stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
    })(triggerFrame(43), runnerCtx());

    const body = (posts.at(-1)!.body as { body: string }).body;
    expect(body).toContain("plain narrative answer");
    expect(body).toStartWith("[session start: 019f35d9]");
  });

  // 这条测试原本**固化了一个 bug**：resume 非零后内部 cold-start 重跑模型。
  // 那次 resume 可能已经 push 过、开过 PR，只是最后非零；重跑就是把副作用做第二遍。
  // 契约⑤：既有测试反过来断言缺陷时，要改的是测试（#206 门禁 P1②）。
  test("resume failure stops instead of cold-starting a new session (no duplicated side effects)", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    writeFileSync(
      join(workdir, "wake-session.json"),
      JSON.stringify({ harness: "codex", session_id: uuid(1), created_at: 1, last_wake_ts: 1, wakes: 3 }),
    );
    const calls: string[][] = [];
    const runProcess: RunnerProcess = async (args) => {
      calls.push(args);
      if (args.includes("resume")) return { code: 9, stdout: "", stderr: "missing session" };
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "fresh answer\n");
      return { code: 0, stdout: `session id: ${uuid(2)}\n`, stderr: "" };
    };

    await expect(
      createBuiltinRunner({
        server: "http://agentparty.test",
        token: "ap_tok",
        channel: "dev",
        harness: "codex",
        workdir,
        runProcess,
        post,
      })(triggerFrame(33), runnerCtx()),
    ).rejects.toThrow(/exit code 9/);

    // 只调用一次 runner（resume），绝不 fork 出新 session 重跑模型
    expect(calls.filter((a) => a.includes("resume"))).toHaveLength(1);
    expect(calls.filter((a) => !a.includes("resume"))).toHaveLength(0);
    // 也绝不发部分正文
    expect(posts.some((p) => (p.body as { kind?: string }).kind === "message")).toBe(false);
  });

  test("copies codex auth.json into the isolated CODEX_HOME before running", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const sourceDir = tempDir();
    const authSourceFile = join(sourceDir, "auth.json");
    writeFileSync(authSourceFile, '{"token":"secret"}\n');
    const runProcess: RunnerProcess = async (args, opts) => {
      expect(opts.env.CODEX_HOME).toBe(join(workdir, ".codex"));
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "ok\n");
      return { code: 0, stdout: `session id: ${uuid(3)}\n`, stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      authSourceFile,
      runProcess,
      post,
    })(triggerFrame(3), runnerCtx());

    expect(readFileSync(join(workdir, ".codex", "auth.json"), "utf8")).toBe('{"token":"secret"}\n');
  });

  // #121: ~/.codex/auth.json 是长期 ChatGPT 凭据；workdir 常是 git worktree，
  // 拷贝进去会被 git add -A 提交、被同步工具打包、被同机其它进程读到。
  // 断言 workdir 里那份必须是指回真实文件的符号链接，绝不能是独立字节的普通文件。
  test("does not duplicate ~/.codex/auth.json bytes into the runner workdir (#121)", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const sourceDir = tempDir();
    const authSourceFile = join(sourceDir, "auth.json");
    writeFileSync(authSourceFile, '{"token":"secret"}\n');
    const runProcess: RunnerProcess = async (args, o) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "ok\n");
      return { code: 0, stdout: `session id: ${uuid(3)}\n`, stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      authSourceFile,
      runProcess,
      post,
    })(triggerFrame(4), runnerCtx());

    const authDest = join(workdir, ".codex", "auth.json");
    // 必须存在（登录态得能用），但必须是符号链接，不是独立拷贝。
    expect(lstatSync(authDest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(authDest)).toBe(authSourceFile);

    // 证明字节没有被复制：删掉源文件后，workdir 里那份也应该跟着失效——
    // 如果之前是 copyFileSync，这里删源文件不会影响 workdir 里的独立副本。
    rmSync(authSourceFile);
    expect(existsSync(authDest)).toBe(false);
  });

  test("claude cold-starts from json output and resumes the persisted session id", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const calls: string[][] = [];
    const runProcess: RunnerProcess = async (args) => {
      calls.push(args);
      if (args.includes("--resume")) return { code: 0, stdout: "resumed text\n", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ session_id: uuid(4), result: "cold text" }), stderr: "" };
    };
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "claude",
      workdir,
      runProcess,
      post,
    });

    await run(triggerFrame(4), runnerCtx());
    await run(triggerFrame(5), runnerCtx());

    expect(JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8")).session_id).toBe(uuid(4));
    expect(calls[0]).toContain("--output-format");
    expect(calls[1]).toEqual(["claude", "-p", "--resume", uuid(4), expect.any(String)]);
  });

  test("outer serve process posts ack and final message with reply_to and session start marker", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "answer body\n");
      return { code: 0, stdout: `session id: ${uuid(5)}\n`, stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
    })(triggerFrame(44), runnerCtx());

    expect(posts[0]!.body).toMatchObject({
      kind: "status",
      state: "working",
      note: "wake ack: me builtin codex runner handling seq=44",
    });
    expect(posts[1]!.body).toMatchObject({
      kind: "message",
      reply_to: 44,
      body: "[session start: 019f35d9]\nanswer body",
    });
  });

  test("builtin runner prompt includes CLI upgrade notice and asks the user before continuing", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    // prompt 里只有 context 文件路径（#120：argv 对同机任意用户可见，不放正文/charter）。
    // 升级提示随 context 文件送达模型，趁 runner 还在跑时读出来断言。
    let ctxFromFile: Record<string, unknown> = {};
    let prompt = "";
    const runProcess: RunnerProcess = async (args) => {
      prompt = String(args.at(-1));
      const m = prompt.match(/(\/[^\s]*\.json)/);
      if (m) ctxFromFile = JSON.parse(readFileSync(m[0], "utf8"));
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "I will ask first.\n");
      return { code: 0, stdout: `session id: ${uuid(7)}\n`, stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
    })(triggerFrame(46), {
      ...runnerCtx(),
      cliUpgrade: {
        running_version: "0.2.72",
        installed_version: "0.2.73",
        auto_upgrade: false,
        action_required: "ask_user",
        message: "检测到 party CLI 已有新版本 v0.2.73（当前运行 v0.2.72）。继续任务前先询问用户是否升级。",
        command: "curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh",
      },
    });

    // argv 里只有路径，没有正文
    expect(prompt).not.toContain("wake up");
    const ctx = ctxFromFile as { cli_upgrade: { message: string } };
    expect(ctx.cli_upgrade).toMatchObject({
      installed_version: "0.2.73",
      action_required: "ask_user",
    });
    expect(ctx.cli_upgrade.message).toContain("先询问用户是否升级");
  });

  test("child non-zero exit throws with the runner log path and posts no blocked, no final body", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();

    await expect(
      createBuiltinRunner({
        server: "http://agentparty.test",
        token: "ap_tok",
        channel: "dev",
        harness: "codex",
        workdir,
        runProcess: async () => ({ code: 7, stdout: "", stderr: "boom" }),
        post,
      })(triggerFrame(45), runnerCtx()),
    ).rejects.toThrow(/exit code 7/);

    // 不再由 runner 自己发 blocked；错误信息里仍带 runner log 路径，供外层拼进最终通告
    expect(posts.some((p) => (p.body as { state?: string }).state === "blocked")).toBe(false);
    expect(readFileSync(join(workdir, "serve-runner.log"), "utf8")).toContain("seq=45 sid=unknown");
  });

  test("repo setup clones when workdir/repo is absent and pulls when it exists", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const gitCalls: string[][] = [];
    const runGit: RunnerProcess = async (args) => {
      gitCalls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "ok\n");
      return { code: 0, stdout: `session id: ${uuid(6)}\n`, stderr: "" };
    };
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      repo: "https://example.com/repo.git",
      runGit,
      runProcess,
      post,
    });

    await run(triggerFrame(6), runnerCtx());
    mkdirSync(join(workdir, "repo"), { recursive: true });
    await run(triggerFrame(7), runnerCtx());

    expect(gitCalls[0]).toEqual(["git", "clone", "https://example.com/repo.git", join(workdir, "repo")]);
    expect(gitCalls[1]).toEqual(["git", "-C", join(workdir, "repo"), "pull", "--ff-only"]);
  });

  test("runner and on-mention flags are mutually exclusive at the CLI boundary", async () => {
    const home = tempDir();
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: "http://127.0.0.1:1", token: "ap_tok" }));
    const oldHome = process.env.AGENTPARTY_HOME;
    const errors: string[] = [];
    const oldError = console.error;
    process.env.AGENTPARTY_HOME = home;
    console.error = (line?: unknown) => errors.push(String(line));
    try {
      expect(await runServeCommand(["dev", "--on-mention", "true", "--runner", "codex"])).toBe(1);
    } finally {
      if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = oldHome;
      console.error = oldError;
    }
    expect(errors.join("\n")).toContain("choose exactly one of --on-mention or --runner");
  });
});

describe("project profile daemon", () => {
  test("one resident daemon fans out to invited channels with scoped child tokens and distinct sessions", async () => {
    const home = tempDir();
    const oldHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    const { posts, post } = postRecorder();
    const profile = {
      owner_account: "fan@example.com",
      handle: "herness-dev",
      name: "Herness Dev",
      runner: "codex-sdk" as const,
      repo_url: null,
      workdir: null,
      base_branch: "main",
      worktree_strategy: "branch" as const,
      rules: "Report readiness.",
      invitable_by: "anyone" as const,
      created_at: 1,
      updated_at: 1,
    };
    const served: ServeOptions[] = [];
    const channelRuntimeCalls: Array<{ slug: string; childName: string }> = [];
    try {
      const code = await runProfileServe({
        server: "http://agentparty.test",
        humanToken: "acc-human",
        ownerAccount: "fan@example.com",
        handle: "herness-dev",
        mentionsOnly: true,
        once: true,
        post,
        mintRuntime: async () => ({ token: "ap_profile_runtime", profile }),
        listInvites: async () => ["alpha", "beta", "gamma"].map((channel_slug, index) => ({
          id: index + 1,
          channel_slug,
          owner_account: profile.owner_account,
          profile_handle: profile.handle,
          invited_by: "owner@example.com",
          invited_at: index + 1,
          profile,
        })),
        ensureChannelRuntime: async (_server, token, slug, owner, handle, childName) => {
          expect(token).toBe("ap_profile_runtime");
          expect(owner).toBe(profile.owner_account);
          expect(handle).toBe(profile.handle);
          channelRuntimeCalls.push({ slug, childName });
          return {
            token: `ap_child_${slug}`,
            name: childName,
            role: "agent",
            owner,
            channel_scope: slug,
            lineage: { parent_agent: handle, root_agent: handle, team_id: handle, depth: 1, expires_at: null },
            profile,
          };
        },
        runChannelServe: async (opts) => {
          served.push(opts);
          await opts.advertise?.();
          return 0;
        },
      });
      expect(code).toBe(0);
    } finally {
      if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = oldHome;
    }

    expect(served.map((o) => o.channel).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(served.map((o) => o.token).sort()).toEqual(["ap_child_alpha", "ap_child_beta", "ap_child_gamma"]);
    expect(new Set(served.map((o) => o.sdkRunner?.workdir)).size).toBe(3);
    expect(new Set(served.map((o) => o.projectAgent?.channel_workdir)).size).toBe(3);
    expect(channelRuntimeCalls).toEqual([
      { slug: "alpha", childName: projectAgentChildName("herness-dev", "alpha") },
      { slug: "beta", childName: projectAgentChildName("herness-dev", "beta") },
      { slug: "gamma", childName: projectAgentChildName("herness-dev", "gamma") },
    ]);
    expect(posts).toHaveLength(6);
    const statusPosts = posts.filter((p) => (p.body as { kind: string }).kind === "status");
    const joinPosts = posts.filter((p) => (p.body as { kind: string }).kind === "message");
    expect(statusPosts).toHaveLength(3);
    expect(statusPosts.every((p) => (p.body as { role?: string }).role === "host")).toBe(true);
    expect(posts.every((p) => p.token.startsWith("ap_child_"))).toBe(true);
    expect(String((posts[0]!.body as { note: string }).note)).toContain("front agent ready");
    expect(String((posts[0]!.body as { note: string }).note)).toContain("team=herness-dev");
    expect(String((posts[0]!.body as { note: string }).note)).toContain("worktree=branch");
    expect(joinPosts.every((p) => String((p.body as { body?: string }).body).includes("front agent"))).toBe(true);
    expect(joinPosts.every((p) => String((p.body as { body?: string }).body).includes("workers should spawn under team herness-dev"))).toBe(true);
  });

  test("project-agent child names are stable and stay within the token name limit", () => {
    const first = projectAgentChildName("long-profile-name-for-daemon", "long-channel-name-for-parallel-review");
    const second = projectAgentChildName("long-profile-name-for-daemon", "long-channel-name-for-parallel-review");
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  });
});

describe("codex-sdk runner", () => {
  function sdkRunner(
    over: Partial<Parameters<typeof createSdkRunner>[0]> & {
      workdir: string;
      codexFactory: () => CodexLike;
    },
  ) {
    return createSdkRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      ...over,
    });
  }

  test("first start calls startThread and persists the thread id", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    let startCalls = 0;
    let resumeCalls = 0;
    const thread: ThreadLike = {
      id: "thread_first_12345678",
      run: async () => ({ final_response: "first answer" }),
    };
    const run = sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => {
          startCalls++;
          return thread;
        },
        resumeThread: () => {
          resumeCalls++;
          return thread;
        },
      }),
    });

    await run(triggerFrame(101), runnerCtx());

    const state = JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8"));
    expect(startCalls).toBe(1);
    expect(resumeCalls).toBe(0);
    expect(state).toMatchObject({
      harness: "codex-sdk",
      thread_id: "thread_first_12345678",
      wakes: 1,
    });
  });

  test("persists the thread id after the first run when the SDK fills it lazily", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const thread: ThreadLike = {
      id: null,
      run: async () => {
        thread.id = "thread_lazy_12345678";
        return { finalResponse: "lazy answer" };
      },
    };

    await sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => thread,
        resumeThread: () => {
          throw new Error("should not resume before first thread id is stored");
        },
      }),
    })(triggerFrame(101), runnerCtx());

    const state = JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8"));
    expect(state).toMatchObject({
      harness: "codex-sdk",
      thread_id: "thread_lazy_12345678",
      wakes: 1,
    });
  });

  test("restart with an existing session resumes the stored thread id", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    writeFileSync(
      join(workdir, "wake-session.json"),
      JSON.stringify({
        harness: "codex-sdk",
        thread_id: "thread_stored_12345678",
        created_at: 1,
        last_wake_ts: 1,
        wakes: 3,
      }),
    );
    const resumed: string[] = [];
    const thread: ThreadLike = {
      id: "thread_stored_12345678",
      run: async () => ({ final_response: "resumed answer" }),
    };

    await sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => {
          throw new Error("should not cold-start");
        },
        resumeThread: (id) => {
          resumed.push(id);
          return thread;
        },
      }),
    })(triggerFrame(102), runnerCtx());

    expect(resumed).toEqual(["thread_stored_12345678"]);
    expect(JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8")).wakes).toBe(4);
  });

  test("passes the full wake context prompt and full_access sandbox to thread.run", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const prompts: string[] = [];
    const sandboxes: string[] = [];
    const thread: ThreadLike = {
      id: "thread_prompt_12345678",
      run: async (prompt, opts) => {
        prompts.push(prompt);
        sandboxes.push(opts.sandbox);
        return { final_response: "ok" };
      },
    };
    const prior = msgFrame(99, "recent context", { sender: { name: "bob", kind: "human" } }) as unknown as MsgFrame;

    await sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => thread,
        resumeThread: () => thread,
      }),
    })(
      msgFrame(103, "do it", { mentions: ["me"], sender: { name: "alice", kind: "human" } }) as unknown as MsgFrame,
      { cmd: "", channel: "dev", self: "me", contextDir: tempDir("ap-ctx-"), recent: [prior] },
    );

    const ctx = JSON.parse(prompts[0]!);
    expect(ctx).toMatchObject({
      channel: "dev",
      seq: 103,
      sender: "alice",
      body: "do it",
      mentions: ["me"],
      reply_to: 103,
      self: "me",
    });
    expect(ctx.recent).toEqual([
      expect.objectContaining({ seq: 99, sender: "bob", body: "recent context" }),
    ]);
    expect(ctx.protocol_reminder).toContain("party history");
    expect(sandboxes).toEqual(["full_access"]);
  });

  test("posts the final response verbatim as a reply without session markers or truncation", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    const final = "first line\n\n[session start: should stay payload]\ntrailing space \n";
    const thread: ThreadLike = {
      id: "thread_final_12345678",
      run: async () => ({ final_response: final }),
    };

    await sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => thread,
        resumeThread: () => thread,
      }),
    })(triggerFrame(104), runnerCtx());

    const finalPost = posts.at(-1)!;
    expect(finalPost.body).toMatchObject({ kind: "message", reply_to: 104 });
    expect((finalPost.body as { body: string }).body).toBe(final);
  });

  test("run errors signal the caller without posting blocked, and keep the resident thread", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    let startCalls = 0;
    let runCalls = 0;
    const thread: ThreadLike = {
      id: "thread_error_12345678",
      run: async () => {
        runCalls++;
        if (runCalls === 1) throw new Error("sdk exploded");
        return { final_response: "second answer" };
      },
    };
    const run = sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => {
          startCalls++;
          return thread;
        },
        resumeThread: () => {
          throw new Error("resident thread should not be discarded");
        },
      }),
    });

    await expect(run(triggerFrame(105), runnerCtx())).rejects.toThrow(/sdk exploded/);
    await run(triggerFrame(106), runnerCtx());

    expect(startCalls).toBe(1);
    expect(runCalls).toBe(2);
    // 失败只回报给调用方，不自己发 blocked（#206 门禁 P1②）；常驻 thread 仍保留给下一次唤醒
    expect(posts.some((p) => (p.body as { state?: string }).state === "blocked")).toBe(false);
    expect((posts.at(-1)!.body as { body: string }).body).toBe("second answer");
    expect(JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8")).thread_id).toBe("thread_error_12345678");
  });

  test("calls to thread.run are serialized even when wakes arrive concurrently", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const resolvers: Array<(value: unknown) => void> = [];
    const prompts: string[] = [];
    const thread: ThreadLike = {
      id: "thread_serial_12345678",
      run: (prompt) => new Promise((resolve) => {
        prompts.push(prompt);
        resolvers.push(resolve);
      }),
    };
    const run = sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => thread,
        resumeThread: () => thread,
      }),
    });

    const first = run(triggerFrame(107), runnerCtx());
    const second = run(triggerFrame(108), runnerCtx());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(1);

    resolvers[0]!({ final_response: "first" });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(2);

    resolvers[1]!({ final_response: "second" });
    await second;
    expect(JSON.parse(prompts[0]!).seq).toBe(107);
    expect(JSON.parse(prompts[1]!).seq).toBe(108);
  });
});

// 排队深度估算（#103）：只数「排在当前 wake 身后、够格触发唤醒」的已缓冲帧。
describe("pendingWakeDepth (#103)", () => {
  const msg = (seq: number, sender: string, mentions: string[]) =>
    msgFrame(seq, "x", { sender: { name: sender, kind: "agent" }, mentions }) as never;

  test("counts buffered mentions after the current seq, excluding self and older frames", () => {
    const pending = [
      msg(2, "alice", ["me"]),
      msg(3, "bob", ["me"]),
      msg(4, "me", ["me"]), // 自己发的不算
      { type: "status", seq: 5 } as never, // 非 msg 帧不算
      msg(1, "alice", ["me"]), // 早于/等于当前 seq 不算
    ];
    expect(pendingWakeDepth(pending, "me", true, 1)).toBe(2);
  });

  test("mentions-only=false counts every fresh message from others, mentioned or not", () => {
    const pending = [msg(2, "alice", []), msg(3, "bob", ["someone-else"])];
    expect(pendingWakeDepth(pending, "me", false, 1)).toBe(2);
    // mentions-only=true 时，没 @ 我的不算
    expect(pendingWakeDepth(pending, "me", true, 1)).toBe(0);
  });

  test("empty queue → depth 0", () => {
    expect(pendingWakeDepth([], "me", true, 0)).toBe(0);
  });
});
