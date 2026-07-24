import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { EXIT_ARCHIVED, type Attachment, type DirectedDelivery, type MsgFrame } from "@agentparty/shared";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  createBuiltinRunner,
  createManagedFrontResultRoute,
  createSdkRunner,
  EXIT_SIGNAL_TERM,
  MANAGED_FRONT_OUTPUT_SCHEMA,
  parseManagedFrontAction,
  projectAgentCleanupCommand,
  projectAgentChildName,
  projectAgentWorkerName,
  projectAgentReadyNote,
  pendingWakeDepth,
  prepareProfileChannelWorkspace,
  runWithRunnerTimeout,
  run as runServeCommand,
  runProfileServe,
  runServe,
  RunnerTimeoutError,
  WakeBlockedError,
  writeContextFile,
  type CodexLike,
  type RunnerProcess,
  type ServeOptions,
  type ThreadLike,
} from "../src/commands/serve";
import { runnerActivityFile, writeActivityFile } from "../src/activity";
import type { MessagePayload } from "../src/rest";
import { writeWorkspaceConfigOnly } from "../src/config";
import type { CliUpgradeNotice } from "../src/upgrade";
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

function managedAction(
  action: "channel_reply" | "worker_dispatch" | "worker_feedback" | "owner_decision" | "blocked",
  fields: Partial<Record<"body" | "instruction" | "prompt" | "options" | "reason", unknown>>,
): string {
  return JSON.stringify({
    action,
    body: null,
    instruction: null,
    prompt: null,
    options: null,
    reason: null,
    ...fields,
  });
}

function directedDelivery(messageSeq: number, cause: DirectedDelivery["cause"] = "mention"): DirectedDelivery {
  return {
    id: `delivery-${messageSeq}`,
    message_seq: messageSeq,
    target_name: "front",
    cause,
    state: "claimed",
    attempt: 1,
    lease_until: Date.now() + 60_000,
    work_id: "work-1",
    continuation_ref: "continuation-1",
    reply_seq: null,
    last_error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function uuid(n: number): string {
  return `019f35d9-0000-7000-8000-00000000000${n}`;
}

function allFileText(root: string): string {
  if (!existsSync(root)) return "";
  const chunks: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) chunks.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return chunks.join("\n");
}

function postRecorder(roleWarning?: string) {
  const posts: Array<{ server: string; token: string; channel: string; body: MessagePayload }> = [];
  return {
    posts,
    post: async (server: string, token: string, channel: string, body: MessagePayload) => {
      posts.push({ server, token, channel, body });
      const isHostStatus =
        (body as { kind?: string; role?: string }).kind === "status" &&
        (body as { role?: string }).role === "host";
      return {
        seq: posts.length,
        ...(roleWarning !== undefined && isHostStatus ? { role_warning: roleWarning } : {}),
      };
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

  test("downloads attachment-only wakes into the private context directory (#362)", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "", {
        mentions: ["me"],
        attachments: [{
          key: "dev/uuid/screenshot.png",
          filename: "screenshot.png",
          content_type: "image/png",
          size: 4,
          url: "/api/channels/dev/attachments/uuid/screenshot.png",
        }],
      })), 20);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 60);
    });
    const downloaded: Array<{ server: string; token: string; channel: string; url: string }> = [];
    const captured: { context?: Record<string, unknown>; localBytes?: Buffer; localMode?: number } = {};
    const o = opts({
      server: server.url,
      downloadAttachment: async (base, token, channel, attachment) => {
        downloaded.push({ server: base, token, channel, url: attachment.url });
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      },
      runCommand: async (frame, ctx) => {
        const file = writeContextFile(
          ctx.contextDir,
          frame,
          ctx.channel,
          ctx.self,
          ctx.recent,
          null,
          null,
          null,
          ctx.attachments,
        );
        captured.context = JSON.parse(readFileSync(file, "utf8"));
        const localPath = (captured.context as { attachments: Array<{ local_path: string }> }).attachments[0]!.local_path;
        captured.localBytes = readFileSync(localPath);
        captured.localMode = lstatSync(localPath).mode & 0o777;
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(downloaded).toEqual([{
      server: server.url,
      token: "ap_tok",
      channel: "dev",
      url: "/api/channels/dev/attachments/uuid/screenshot.png",
    }]);
    expect(captured.context).toMatchObject({
      body: "",
      attachments: [{
        filename: "screenshot.png",
        content_type: "image/png",
        size: 4,
        url: `${server.url}/api/channels/dev/attachments/uuid/screenshot.png`,
        auth: "Bearer token required",
        local_path: expect.stringContaining("screenshot.png"),
      }],
    });
    expect(captured.localBytes).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(captured.localMode).toBe(0o600);
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

    // 处理这条 wake 时自报「忙」（无积压 → queue_depth 0）。
    // 注意：#228 起 wrap 点会先落一条 busy 无关的 runner_started 审计 working 帧，故这里精确挑
    // busy=true 的那条 wake-ack，而不是第一条 working。
    const working = posts.find((p) => (p.body as { state?: string; busy?: boolean }).state === "working" && (p.body as { busy?: boolean }).busy === true);
    expect(working, "runner must post a busy working frame").toBeDefined();
    expect(working!.body).toMatchObject({ kind: "status", state: "working", busy: true, queue_depth: 0 });

    // 收尾补一条「空闲」把 busy 清回 false——任务结束就不再假忙
    const idle = posts.find((p) => (p.body as { state?: string; busy?: boolean }).state === "waiting" && (p.body as { busy?: boolean }).busy === false);
    expect(idle, "serve must post a busy=false idle-clear once the queue drains").toBeDefined();
    expect(idle!.body).toMatchObject({ kind: "status", state: "waiting", busy: false, queue_depth: 0 });

    // 顺序：先忙后清
    expect(posts.indexOf(working!)).toBeLessThan(posts.indexOf(idle!));
  });

  test("builtin failure clears busy on blocked without falling back to waiting (#756)", async () => {
    const s = closeAfterOneMention();
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    const o = opts({
      server: s.url,
      post,
      builtinRunner: {
        server: s.url,
        token: "ap_tok",
        channel: "dev",
        harness: "claude",
        workdir,
        runProcess: async () => ({
          code: 1,
          stdout: "",
          stderr: "tool use requires approval, but no interactive approver is available",
        }),
        post,
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);

    const blockedIdx = posts.findIndex((entry) =>
      (entry.body as { state?: string; note?: string }).state === "blocked" &&
      (entry.body as { note?: string }).note?.includes("wake undelivered")
    );
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    expect(posts[blockedIdx]!.body).toMatchObject({
      kind: "status",
      state: "blocked",
      busy: false,
      queue_depth: 0,
      blocked_reason: expect.stringContaining("builtin claude runner blocked"),
    });
    expect(posts.slice(blockedIdx + 1).some((entry) =>
      (entry.body as { state?: string }).state === "waiting"
    )).toBe(false);
  });

  test("preflight failure clears carried busy once the queued wake drains (#756)", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "first", { mentions: ["me"] })), 10);
      // 首条模型运行期间再入队第二条：首条收尾必须延续 busy，而不是先发 waiting。
      setTimeout(() => sock.send(msgFrame(2, "second", { mentions: ["me"] })), 25);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 150);
    });
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    let gitCalls = 0;
    let modelCalls = 0;
    const o = opts({
      server: server.url,
      post,
      builtinRunner: {
        server: server.url,
        token: "ap_tok",
        channel: "dev",
        harness: "codex",
        workdir,
        repo: "https://example.test/repo.git",
        runGit: async () => {
          gitCalls += 1;
          if (gitCalls === 2) throw new WakeBlockedError("repo preflight exploded", false);
          mkdirSync(join(workdir, "repo"), { recursive: true });
          return { code: 0, stdout: "", stderr: "" };
        },
        runProcess: async (args) => {
          modelCalls += 1;
          await Bun.sleep(40);
          const out = args[args.indexOf("-o") + 1]!;
          writeFileSync(out, "answer\n");
          return { code: 0, stdout: `session id: ${uuid(2)}\n`, stderr: "" };
        },
        post,
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(gitCalls).toBe(2);
    expect(modelCalls).toBe(1);

    const working = posts.find((entry) =>
      (entry.body as { state?: string; busy?: boolean }).state === "working" &&
      (entry.body as { busy?: boolean }).busy === true
    );
    expect(working?.body).toMatchObject({ busy: true });

    const blockedIdx = posts.findIndex((entry) =>
      (entry.body as { state?: string; note?: string }).state === "blocked" &&
      (entry.body as { note?: string }).note?.includes("before model start")
    );
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    expect(posts.slice(0, blockedIdx).some((entry) =>
      (entry.body as { state?: string }).state === "waiting"
    )).toBe(false);
    expect(posts[blockedIdx]!.body).toMatchObject({
      kind: "status",
      state: "blocked",
      busy: false,
      queue_depth: 0,
      blocked_reason: expect.stringContaining("repo preflight exploded"),
    });
    expect(posts.slice(blockedIdx + 1).some((entry) =>
      (entry.body as { state?: string }).state === "waiting"
    )).toBe(false);
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

  // 模型 session 活动（#602）：builtin claude runner 的 hooks 把「正在干什么」落到 workdir 的
  // activity.json，serve 每拍心跳读一次捎带上行；清除帧（current_task=null）不带 activity。
  test("task heartbeat: carries the hook-reported model activity for a claude builtin runner (#602)", async () => {
    const beats: Array<{ current_task: number | null; activity?: { phase: string; tool?: string } }> = [];
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
    const workdir = tempDir();
    const o = opts({
      server: server.url,
      heartbeatIntervalMs: 8,
      // builtinRunner 只为提供 activity 文件约定（harness=claude + workdir）；实际执行仍走注入的
      // runCommand（它扮演「hook 已落盘」的模型进程）。
      builtinRunner: { server: "http://unused", token: "t", channel: "dev", harness: "claude", workdir },
      runCommand: async () => {
        writeActivityFile(runnerActivityFile(workdir), { phase: "tool", tool: "Bash", ts: Date.now() });
        await new Promise((r) => setTimeout(r, 70));
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);

    const withActivity = beats.filter((b) => b.current_task === 1 && b.activity !== undefined);
    expect(withActivity.length, "periodic beats must pick up the hook-written activity").toBeGreaterThanOrEqual(1);
    expect(withActivity[withActivity.length - 1]!.activity).toMatchObject({ phase: "tool", tool: "Bash" });
    const clear = beats.find((b) => b.current_task === null);
    expect(clear, "task must still clear on completion").toBeDefined();
    expect(clear!.activity).toBeUndefined();
  });

  // runner 健康自报（#603）：连败计数随任务收尾拍上行——熔断前那段「presence 全绿但 @ 了没人应」
  // 的窗口从此可见。单次失败 ok 仍为 true（有重试兜底），≥2 连败才翻 false。
  test("task heartbeat: reports runner_health on consecutive failures with the last error (#603)", async () => {
    const beats: Array<{
      current_task: number | null;
      runner_health?: { ok: boolean; consecutive_failures: number; last_error?: string };
    }> = [];
    server = startMockServer((frame, sock) => {
      if (frame.type === "heartbeat") {
        beats.push(frame as unknown as (typeof beats)[number]);
        return;
      }
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      // 两条 @ 先后失败（第一条放弃宣告后欠账即了结、游标前移，第二条照常触发）→ 连败 2。
      setTimeout(() => sock.send(msgFrame(1, "doomed wake", { mentions: ["me"] })), 10);
      setTimeout(() => sock.send(msgFrame(2, "doomed again", { mentions: ["me"] })), 90);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 180);
    });
    const o = opts({
      server: server.url,
      maxWakeAttempts: 1,
      wakeRetryDelayMs: 0,
      post: async () => ({ seq: 99 }),
      runCommand: async () => {
        throw new Error("runner boom");
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);

    const clears = beats.filter((b) => b.current_task === null);
    expect(clears.length).toBeGreaterThanOrEqual(2);
    // 第一次放弃：failures=1、ok 仍 true、带脱敏后的错误摘要
    expect(clears[0]!.runner_health).toMatchObject({ ok: true, consecutive_failures: 1 });
    expect(clears[0]!.runner_health!.last_error).toContain("runner boom");
    // 第二次放弃：failures=2 → ok=false（「在线但干不动」）
    expect(clears[1]!.runner_health).toMatchObject({ ok: false, consecutive_failures: 2 });
    // 活跃拍也携带既有连败（第二条任务开跑时频道还能看见此前的失败史）
    const secondStart = beats.filter((b) => b.current_task === 2 && b.runner_health !== undefined);
    expect(secondStart.length).toBeGreaterThanOrEqual(1);
  });

  test("task heartbeat: in-task retry that ends delivered reports no runner_health (#603)", async () => {
    const beats: Array<{
      current_task: number | null;
      runner_health?: { ok: boolean; consecutive_failures: number };
    }> = [];
    server = startMockServer((frame, sock) => {
      if (frame.type === "heartbeat") {
        beats.push(frame as unknown as (typeof beats)[number]);
        return;
      }
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "flaky then fine", { mentions: ["me"] })), 10);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 120);
    });
    let calls = 0;
    const o = opts({
      server: server.url,
      maxWakeAttempts: 2,
      wakeRetryDelayMs: 0,
      post: async () => ({ seq: 99 }),
      runCommand: async () => {
        calls += 1;
        // 第一次尝试失败（可重试），第二次成功——最终送达的任务不算 runner 失败。
        if (calls === 1) throw new WakeBlockedError("spawn boom", true);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);

    expect(calls).toBe(2);
    const clears = beats.filter((b) => b.current_task === null);
    expect(clears.length).toBeGreaterThanOrEqual(1);
    // 任务内重试后仍然送达 → 收尾拍不带 runner_health（服务端据此保持/恢复健康档）
    expect(clears[clears.length - 1]!.runner_health).toBeUndefined();
  });

  test("restart resume: serve reports the persisted runner session on welcome (#522)", async () => {
    const workdir = tempDir();
    writeFileSync(join(workdir, "wake-session.json"), JSON.stringify({
      harness: "codex",
      session_id: uuid(22),
      created_at: 1000,
      last_wake_ts: 2000,
      wakes: 3,
      cwd: "/workspace/project",
      workdir,
    }));
    const clientFrames: Array<Record<string, unknown>> = [];
    // #590：归档必须事件驱动。welcome 后 serve 才异步读 wake-session.json 并自报 agent_session
    // 心跳；固定 60ms 掐线在慢 CI 上会赶在心跳前收摊（本用例曾一天咬掉两个无关 PR 的首跑）。
    // 收到目标心跳立即归档；5s 兜底让回归（心跳缺席）收敛为断言失败而非用例超时。
    let archived = false;
    server = startMockServer((frame, sock) => {
      clientFrames.push(frame as unknown as Record<string, unknown>);
      const archive = () => {
        if (archived) return;
        archived = true;
        try {
          sock.send({ type: "error", code: "archived", message: "done" });
        } catch {
          // 兜底定时器可能在用例收摊、socket 已关后触发——静默即可。
        }
      };
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0, "me"));
        setTimeout(() => sock.send({ type: "serve_lease", name: "me", held: true }), 20);
        setTimeout(archive, 5000);
        return;
      }
      if (frame.type === "heartbeat" && frame.agent_session !== undefined) archive();
    });
    const o = opts({
      server: server.url,
      builtinRunner: { server: server.url, token: "ap_tok", channel: "dev", harness: "codex", workdir },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(clientFrames).toContainEqual(expect.objectContaining({
      type: "heartbeat",
      current_task: null,
      agent_session: expect.objectContaining({
        harness: "codex",
        session_id: uuid(22),
        cwd: "/workspace/project",
      }),
    }));
  });

  // runner_started 审计（#228）：presence 心跳不落 history、任务结束即清 —— custom runner 跑完后频道
  // 历史里此前零证据它曾启动。现在 wrap 点补发一条落 history 的 working status「runner started for seq X」。
  test("runner_started audit: custom runner posts an auditable working status to history on start", async () => {
    const s = closeAfterOneMention();
    const { posts, post } = postRecorder();
    const o = opts({
      server: s.url,
      post,
      // 注入的自定义 runner（runnerKind=custom）：成功返回，不自报 busy、不发结束/失败 status。
      runCommand: async () => {},
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);

    // 启动即落一条可审计的 working status —— 这正是此前 custom runner 缺失的那条历史证据。
    const started = posts.find(
      (p) =>
        (p.body as { state?: string }).state === "working" &&
        typeof (p.body as { note?: string }).note === "string" &&
        (p.body as { note: string }).note.startsWith("runner started for seq 1"),
    );
    expect(started, "custom runner must post an auditable runner_started status").toBeDefined();
    expect(started!.body).toMatchObject({ kind: "status", state: "working" });
    // 带 trigger_seq 与 runner 信息，方便审计时定位是哪种 runner 为哪条 wake 启动。
    expect((started!.body as { note: string }).note).toContain("runner=custom");
    // 纯审计记录：不掺 busy（custom 不参与 busy 生命周期，置 busy 会让 presence 卡「假忙」）。
    expect((started!.body as { busy?: boolean }).busy).toBeUndefined();
    // 与「失败」区分：成功路径不产生 blocked 帧。
    expect(posts.some((p) => (p.body as { state?: string }).state === "blocked")).toBe(false);
  });

  // 与结束/失败区分（#228）：失败时 runner_started 仍先落，随后才是 blocked —— 两条各司其职、可分辨。
  test("runner_started audit: distinct from the failure status, and posted before it", async () => {
    const s = closeAfterOneMention();
    const { posts, post } = postRecorder();
    const o = opts({
      server: s.url,
      post,
      // 抛普通 Error（非 WakeBlockedError）→ 不可重试 → 走放弃路径发一条 blocked。
      runCommand: async () => {
        throw new Error("custom runner boom");
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);

    const startedIdx = posts.findIndex(
      (p) =>
        (p.body as { state?: string }).state === "working" &&
        (p.body as { note?: string }).note?.startsWith("runner started for seq 1"),
    );
    const blockedIdx = posts.findIndex((p) => (p.body as { state?: string }).state === "blocked");
    expect(startedIdx, "runner_started must be posted even when the runner fails").toBeGreaterThanOrEqual(0);
    expect(blockedIdx, "failure must post a blocked status").toBeGreaterThanOrEqual(0);
    // 启动证据先落、失败通告后落 —— 顺序即「先启动，后失败」的可审计时间线。
    expect(startedIdx).toBeLessThan(blockedIdx);
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

  test("reports custom runner SIGTERM immediately with the truthful attempt count", async () => {
    const s = closeAfterOneMention();
    const posts: MessagePayload[] = [];
    const o = opts({
      server: s.url,
      cmd: "exit 143",
      maxWakeAttempts: 3,
      wakeRetryDelayMs: 0,
      post: async (_server, _token, _channel, body) => {
        posts.push(body);
        return { seq: posts.length };
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(o.lines.filter((line) => line.includes("命令失败"))).toHaveLength(1);
    expect(o.lines.some((line) => line.includes("command exited 143 (SIGTERM)"))).toBe(true);
    const blocked = posts.find((post) => post.kind === "status" && post.state === "blocked");
    expect(blocked).toBeDefined();
    const blockedNote = blocked && "note" in blocked ? blocked.note : undefined;
    expect(blockedNote).toContain("attempts=1/3");
    expect(blockedNote).toContain("command exited 143 (SIGTERM)");
    expect(blockedNote).toContain("(context: ");
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

  test("refreshes the charter bundle on reconnect and only trusts system refresh statuses", async () => {
    const statusFrame = (seq: number, sender: string, note: string) =>
      msgFrame(seq, note, {
        type: "status",
        sender: { name: sender, kind: sender === "system" ? "agent" : "human" },
        kind: "status",
        state: "waiting",
        note,
        status: {
          owner: sender,
          state: "waiting",
          scope: [],
          summary_seq: null,
          blocked_reason: null,
          updated_at: Date.now(),
        },
      });
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(statusFrame(1, "alice", "charter updated to rev 99")), 10);
      setTimeout(() => sock.send(statusFrame(2, "alice", "decision ledger updated: fake")), 20);
      setTimeout(() => sock.send(statusFrame(3, "system", "decision ledger updated: decision_real")), 30);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 60);
    });
    let fetches = 0;
    const o = opts({
      server: server.url,
      fetchCharter: async () => {
        fetches += 1;
        return {
          charter: null,
          charter_rev: 0,
          updated_at: null,
          updated_by: null,
          active_decisions: [],
        };
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    // attach + welcome 无条件补漏 + 一条可信 system decision refresh；伪造 status 不放大请求。
    expect(fetches).toBe(3);
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
      expect(ctx.context_budget).toMatchObject({
        max_auxiliary_body_chars: 8000,
        trigger_body_chars: 12,
        trigger_body_truncated: false,
        recent_messages_included: 2,
        recent_messages_available: 2,
        recent_truncated: true,
      });
      expect(ctx.protocol_reminder).toContain("party history");
      expect(ctx.protocol_reminder).toContain("front agent");
      expect(ctx.protocol_reminder).toContain("AskUserQuestion");
      expect(ctx.protocol_reminder).toContain("兼容模式");
      expect(ctx.protocol_reminder).toContain("优先交给 harness 的 subagent/worker");
      expect(ctx.protocol_reminder).toContain("不要只报 blocked");
      expect(ctx.protocol_reminder).not.toContain("不要用 tmux/后台守护/子代理去接管这次唤醒");
      expect(ctx.operating_contract).toMatchObject({
        role: "front_agent",
        enforcement: "advisory",
        direct_actions: expect.arrayContaining(["short_channel_conversation", "single_read_only_check_needed_to_route_work"]),
        delegate_actions: expect.arrayContaining(["code_changes", "multi_step_investigation"]),
      });
    } finally {
      unlinkSync(path);
    }
  });

  test("wake context caps charter + recent bodies while preserving the full trigger", () => {
    const triggerBody = "T".repeat(12_000);
    const trigger = msgFrame(50, triggerBody, { mentions: ["me"] }) as unknown as MsgFrame;
    const prior = Array.from({ length: 20 }, (_, index) =>
      msgFrame(index + 1, String(index + 1).padStart(2, "0") + "x".repeat(498)) as unknown as MsgFrame,
    );
    const path = writeContextFile(
      tempDir("ap-budget-"),
      trigger,
      "dev",
      "me",
      prior,
      { charter: "C".repeat(8_000), charter_rev: 7, updated_at: null, updated_by: null },
    );
    try {
      const ctx = JSON.parse(readFileSync(path, "utf8"));
      expect(ctx.body).toBe(triggerBody); // 用户本次指令绝不为省 token 被裁掉
      expect(ctx.charter).toHaveLength(4_000);
      expect(ctx.charter).toEndWith("[charter truncated; run `party charter dev`]");
      expect(ctx.recent.map((m: { seq: number }) => m.seq)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      expect(ctx.recent.reduce((sum: number, m: { body: string }) => sum + m.body.length, 0)).toBe(4_000);
      expect(ctx.context_budget).toEqual({
        policy: "auxiliary-body-chars-v1",
        max_auxiliary_body_chars: 8_000,
        auxiliary_body_chars: 8_000,
        trigger_body_chars: 12_000,
        trigger_body_truncated: false,
        charter_chars: 4_000,
        charter_truncated: true,
        recent_body_chars: 4_000,
        recent_messages_included: 10,
        recent_messages_available: 20,
        recent_truncated: true,
      });
    } finally {
      unlinkSync(path);
    }
  });

  test("wake context uses the final partial recent-message budget", () => {
    const trigger = msgFrame(50, "full trigger", { mentions: ["me"] }) as unknown as MsgFrame;
    const prior = Array.from({ length: 12 }, (_, index) =>
      msgFrame(index + 1, `m${String(index + 1).padStart(2, "0")}` + "x".repeat(397)) as unknown as MsgFrame,
    );
    const path = writeContextFile(
      tempDir("ap-budget-partial-"),
      trigger,
      "dev",
      "me",
      prior,
      { charter: "C".repeat(3_999), charter_rev: 8, updated_at: null, updated_by: null },
    );
    try {
      const ctx = JSON.parse(readFileSync(path, "utf8"));
      expect(ctx.body).toBe("full trigger");
      expect(ctx.recent.map((m: { seq: number }) => m.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(ctx.recent[0].body).toBe("m");
      expect(ctx.context_budget).toMatchObject({
        auxiliary_body_chars: 8_000,
        charter_chars: 3_999,
        recent_body_chars: 4_001,
        recent_messages_included: 11,
        recent_messages_available: 12,
        recent_truncated: true,
      });
    } finally {
      unlinkSync(path);
    }
  });

  test("wake context includes a bounded authoritative decision snapshot", () => {
    const trigger = msgFrame(50, "continue", { mentions: ["me"] }) as unknown as MsgFrame;
    const path = writeContextFile(
      tempDir("ap-decision-snapshot-"),
      trigger,
      "dev",
      "me",
      [],
      {
        charter: null,
        charter_rev: 0,
        updated_at: null,
        updated_by: null,
        active_decisions: [
          {
            type: "channel_decision",
            id: "decision_0123456789abcdef0123456789abcdef",
            channel: "dev",
            topic: "runner",
            summary: "Use the assigned host and Codex runner.",
            source_seq: 42,
            supersedes_id: null,
            superseded_by_id: null,
            status: "active",
            created_by: "owner",
            created_by_kind: "human",
            created_at: 1,
          },
        ],
      },
    );
    try {
      const ctx = JSON.parse(readFileSync(path, "utf8"));
      expect(ctx.decision_snapshot).toContain("当前已定稿 / Active decisions");
      expect(ctx.decision_snapshot).toContain(
        "- runner: Use the assigned host and Codex runner. [decision_0123456789abcdef0123456789abcdef]",
      );
      expect(ctx.context_budget).toMatchObject({
        auxiliary_body_chars: Array.from(ctx.decision_snapshot).length,
        decision_snapshot_chars: Array.from(ctx.decision_snapshot).length,
        decision_snapshot_truncated: false,
        recent_body_chars: 0,
      });
    } finally {
      unlinkSync(path);
    }
  });

  test("wake context truncates the decision snapshot with its recovery notice", () => {
    const trigger = msgFrame(50, "continue", { mentions: ["me"] }) as unknown as MsgFrame;
    const path = writeContextFile(
      tempDir("ap-decision-snapshot-truncated-"),
      trigger,
      "dev",
      "me",
      [],
      {
        charter: null,
        charter_rev: 0,
        updated_at: null,
        updated_by: null,
        active_decisions: Array.from({ length: 20 }, (_, index) => ({
          type: "channel_decision" as const,
          id: `decision_${String(index).padStart(32, "0")}`,
          channel: "dev",
          topic: `topic-${index}`,
          summary: "😀".repeat(200),
          source_seq: null,
          supersedes_id: null,
          superseded_by_id: null,
          status: "active" as const,
          created_by: "owner",
          created_by_kind: "human" as const,
          created_at: index,
        })),
      },
    );
    try {
      const ctx = JSON.parse(readFileSync(path, "utf8"));
      expect(Array.from(ctx.decision_snapshot)).toHaveLength(3_000);
      expect(ctx.decision_snapshot).toEndWith(
        "[decision snapshot truncated; run `party decision list --channel dev`]",
      );
      expect(ctx.context_budget).toMatchObject({
        auxiliary_body_chars: 3_000,
        decision_snapshot_chars: 3_000,
        decision_snapshot_truncated: true,
        recent_body_chars: 0,
      });
    } finally {
      unlinkSync(path);
    }
  });

  test("wake context truncates on Unicode code-point boundaries", () => {
    const triggerBody = "🧭".repeat(10);
    const trigger = msgFrame(50, triggerBody, { mentions: ["me"] }) as unknown as MsgFrame;
    const path = writeContextFile(
      tempDir("ap-budget-unicode-"),
      trigger,
      "dev",
      "me",
      [msgFrame(49, "😀".repeat(500)) as unknown as MsgFrame],
      { charter: "🚀".repeat(5_000), charter_rev: 9, updated_at: null, updated_by: null },
    );
    try {
      const ctx = JSON.parse(readFileSync(path, "utf8"));
      expect(ctx.body).toBe(triggerBody);
      expect(Array.from(ctx.charter)).toHaveLength(4_000);
      expect(ctx.charter).toEndWith("[charter truncated; run `party charter dev`]");
      expect(Array.from(ctx.recent[0].body)).toHaveLength(400);
      expect(ctx.recent[0].body).toBe("😀".repeat(400));
      expect(ctx.context_budget).toMatchObject({
        trigger_body_chars: 10,
        charter_chars: 4_000,
        recent_body_chars: 400,
      });
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

  test("passes a newer deployed CLI notice into the runner context so the agent can notify its owner (#485)", async () => {
    const s = closeAfterOneMention();
    const notices: unknown[] = [];
    const o = opts({
      server: s.url,
      availableUpgrade: {
        running_version: "0.2.107",
        available_version: "0.2.108",
        auto_upgrade: false,
        action_required: "ask_user",
        message: "服务器已有新版；请主动提醒 owner 升级。",
        command: "curl -fsSL https://example.test/install.sh | sh",
      },
      runCommand: async (_frame, ctx) => {
        notices.push(ctx.cliUpgrade);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(notices[0]).toMatchObject({
      running_version: "0.2.107",
      available_version: "0.2.108",
      action_required: "ask_user",
    });
  });

  test("refreshes the deployed CLI notice before a later wake without blocking serve (#485)", async () => {
    const s = closeAfterOneMention();
    const notices: unknown[] = [];
    let probes = 0;
    const o = opts({
      server: s.url,
      availableUpgrade: null,
      upgradeProbeIntervalMs: 0,
      refreshAvailableUpgrade: async () => {
        probes += 1;
        return {
          running_version: "0.2.107",
          available_version: "0.2.109",
          auto_upgrade: false,
          action_required: "ask_user",
          message: "长驻 serve 检测到新发布。",
          command: "curl -fsSL https://example.test/install.sh | sh",
        };
      },
      runCommand: async (_frame, ctx) => {
        notices.push(ctx.cliUpgrade);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(probes).toBe(1);
    expect(notices[0]).toMatchObject({ available_version: "0.2.109", action_required: "ask_user" });
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

describe("managed front protocol", () => {
  test("accepts only the fixed six-field action envelope", () => {
    expect(parseManagedFrontAction(managedAction("channel_reply", { body: "收到" }))).toEqual({
      action: "channel_reply",
      body: "收到",
    });
    expect(parseManagedFrontAction(managedAction("worker_dispatch", { instruction: "实现并跑测试" }))).toEqual({
      action: "worker_dispatch",
      instruction: "实现并跑测试",
    });
    expect(parseManagedFrontAction(managedAction("owner_decision", { prompt: "是否发布？", options: [] }))).toEqual({
      action: "owner_decision",
      prompt: "是否发布？",
    });
    expect(parseManagedFrontAction(managedAction("owner_decision", { prompt: "选方案", options: ["A", "B"] }))).toEqual({
      action: "owner_decision",
      prompt: "选方案",
      options: ["A", "B"],
    });
    expect(() => parseManagedFrontAction(JSON.stringify({ action: "channel_reply", body: "missing envelope" })))
      .toThrow(/exactly action, body, instruction, prompt, options, reason/);
    expect(() => parseManagedFrontAction(managedAction("channel_reply", { body: "ok", instruction: "hidden work" })))
      .toThrow(/unused instruction/);
    expect(() => parseManagedFrontAction(managedAction("owner_decision", { prompt: "bad choice", options: ["only"] })))
      .toThrow(/at least 2 options/);
    expect(MANAGED_FRONT_OUTPUT_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["action", "body", "instruction", "prompt", "options", "reason"],
    });
    expect(MANAGED_FRONT_OUTPUT_SCHEMA).not.toHaveProperty("oneOf");
  });

  test("resolves worker and nested owner-decision replies back to the original channel message", async () => {
    const owner = "fan@example.com";
    const original = msgFrame(10, "please fix", {
      sender: { name: "leo", kind: "human", owner },
    }) as unknown as MsgFrame;
    const dispatch = msgFrame(11, "dispatch", {
      sender: { name: "front", kind: "agent", owner },
      mentions: ["worker"],
      reply_to: 10,
    }) as unknown as MsgFrame;
    const report = msgFrame(12, "report", {
      sender: { name: "worker", kind: "agent", owner },
      reply_to: 11,
    }) as unknown as MsgFrame;
    const question = msgFrame(13, "approve?", {
      sender: { name: "front", kind: "agent", owner },
      reply_to: 12,
      decision_request: { kind: "approval", prompt: "approve?", options: ["approve", "reject"] },
    }) as unknown as MsgFrame;
    const answer = msgFrame(14, "approved", {
      sender: { name: "leo", kind: "human", owner },
      reply_to: 13,
      decision_response: {
        request_seq: 13,
        chosen_index: 0,
        chosen_option: "approve",
        delivery_id: "delivery-12",
        origin_seq: 12,
        origin_channel: "dev",
        work_id: "work-1",
        continuation_ref: "continuation-1",
      },
    }) as unknown as MsgFrame;
    const nestedQuestion = msgFrame(15, "confirm again", {
      sender: { name: "front", kind: "agent", owner },
      reply_to: 14,
      decision_request: { kind: "approval", prompt: "confirm again", options: ["approve", "reject"] },
    }) as unknown as MsgFrame;
    const nestedAnswer = msgFrame(16, "confirmed", {
      sender: { name: "leo", kind: "human", owner },
      reply_to: 15,
      decision_response: {
        request_seq: 15,
        chosen_index: 0,
        chosen_option: "approve",
        delivery_id: "delivery-14",
        origin_seq: 14,
        origin_channel: "dev",
        work_id: "work-1",
        continuation_ref: "continuation-1",
      },
    }) as unknown as MsgFrame;
    const history = [original, dispatch, report, question, answer, nestedQuestion, nestedAnswer];
    const route = createManagedFrontResultRoute({
      server: "http://agentparty.test",
      token: "ap_front",
      channel: "dev",
      frontName: "front",
      workerName: "worker",
      ownerAccount: owner,
      ownerDecisionBindingEnforced: () => true,
      fetch: async (_server, _token, _channel, since, limit) =>
        history.filter((message) => message.seq > (since ?? 0)).slice(0, limit),
    });

    await expect(route(report, managedAction("channel_reply", { body: "完成" }), null, directedDelivery(12, "reply")))
      .resolves.toMatchObject({ replyTo: 10, text: "完成", completionSummarySeq: 12 });
    await expect(route(report, managedAction("worker_feedback", { instruction: "补测试证据" }), null, directedDelivery(12, "reply")))
      .resolves.toMatchObject({
        replyTo: 10,
        mentions: ["worker"],
        completionSummarySeq: 12,
        text: expect.stringContaining("report #12, dispatch #11, origin #10"),
      });
    await expect(route(original, managedAction("owner_decision", { prompt: "是否发布？", options: [] }), null, directedDelivery(10)))
      .resolves.toMatchObject({
        replyTo: 10,
        decisionRequest: { kind: "approval", prompt: "是否发布？" },
        expectedDecisionResponderOwner: owner,
      });
    await expect(route(answer, managedAction("channel_reply", { body: "已批准并完成" }), null, directedDelivery(14, "owner_answer")))
      .resolves.toMatchObject({ replyTo: 10, completionSummarySeq: 14 });
    await expect(route(nestedAnswer, managedAction("channel_reply", { body: "最终完成" }), null, directedDelivery(16, "owner_answer")))
      .resolves.toMatchObject({ replyTo: 10, completionSummarySeq: 16 });
    await expect(route(original, managedAction("blocked", { reason: "缺少生产权限" }), null, directedDelivery(10)))
      .resolves.toMatchObject({
        replyTo: 10,
        completionSummarySeq: 10,
        completionState: "blocked",
      blockedReason: "缺少生产权限",
    });
    const wrongOwnerAnswer = {
      ...answer,
      sender: { name: "not-owner", kind: "human" as const, owner: "other@example.com" },
    };
    await expect(route(wrongOwnerAnswer, managedAction("channel_reply", { body: "越权" }), null, directedDelivery(14, "owner_answer")))
      .rejects.toThrow(/owner decision question lineage/);
    for (const invalidAnswer of [
      { ...answer, sender: { name: "owner-agent", kind: "agent" as const, owner } },
      { ...answer, sender: { name: "owner-without-account", kind: "human" as const } },
      { ...answer, reply_to: 12 },
    ]) {
      await expect(route(invalidAnswer, managedAction("channel_reply", { body: "越权" }), null, directedDelivery(14, "owner_answer")))
        .rejects.toThrow(/owner decision question lineage/);
    }
  });
});

describe("builtin runner", () => {
  test("codex uses one resolved absolute binary instead of trusting the runner PATH", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const calls: string[][] = [];
    const runProcess: RunnerProcess = async (args) => {
      calls.push(args);
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "resolved answer\n");
      return { code: 0, stdout: `session id: ${uuid(0)}\n`, stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      codexBinary: process.execPath,
      workdir,
      runProcess,
      post,
    })(triggerFrame(700), runnerCtx());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual([realpathSync(process.execPath), "exec"]);
  });

  test("codex cold-starts, persists the session id, then resumes it on the next wake", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const calls: string[][] = [];
    const reported: Array<{ session_id: string; harness: string }> = [];
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
      onSession: (session) => reported.push(session),
    });

    await run(triggerFrame(1), runnerCtx());
    await run(triggerFrame(2), runnerCtx());

    const state = JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8"));
    expect(state).toMatchObject({ harness: "codex", session_id: uuid(1), wakes: 2 });
    expect(reported).toEqual([
      expect.objectContaining({ harness: "codex", session_id: uuid(1) }),
      expect.objectContaining({ harness: "codex", session_id: uuid(1) }),
    ]);
    expect(calls[0]!.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(calls[1]!.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(calls[1]!.slice(calls[1]!.indexOf("resume"), calls[1]!.indexOf("resume") + 2)).toEqual(["resume", uuid(1)]);
    // 先断言 --sandbox 真的存在：indexOf 缺失时返回 -1，只比顺序会放过 sandbox 护栏被删的回归。
    expect(calls[1]!).toContain("--sandbox");
    expect(calls[1]!.indexOf("--sandbox")).toBeLessThan(calls[1]!.indexOf("resume"));
    const log = readFileSync(join(workdir, "serve-runner.log"), "utf8");
    expect(log).toContain("seq=1 sid=019f35d9");
    expect(log).toContain("seq=2 sid=019f35d9");
    expect(log).toContain("exit=0");
  });

  test("codex 无 session id 也交付答案而非吞掉（#726：exit 0 有产出，只是没解析出 sid）", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    const reported: Array<{ session_id: string }> = [];
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "answer without a parsable session id\n");
      // codex exit 0、有答案，但 stdout/stderr 都不含 `session id:` 行（版本漂移症状）
      return { code: 0, stdout: "done\n", stderr: "" };
    };

    // 不抛 WakeBlockedError（不吞 @）
    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
      onSession: (session) => reported.push(session),
    })(triggerFrame(659), runnerCtx());

    // 答案照常投递到频道
    const finalPost = posts.at(-1)!;
    expect(finalPost.body).toMatchObject({ kind: "message", reply_to: 659 });
    const deliveredBody = (finalPost.body as { body: string }).body;
    expect(deliveredBody).toContain("answer without a parsable session id");
    // 无 sid 不打 "[session start: unknown]" marker 噪声
    expect(deliveredBody).not.toContain("[session start");
    // 没 sid → 不持久化会话、不上报 onSession（下次冷启动）
    expect(reported).toEqual([]);
    expect(existsSync(join(workdir, "wake-session.json"))).toBe(false);
    // 运维告警落日志:sid 未知、续跑不可用（但不抢先写 delivered=true，交付结果由后续日志行落账）
    const log = readFileSync(join(workdir, "serve-runner.log"), "utf8");
    expect(log).toContain("seq=659 sid=unknown");
    expect(log).toContain("missing_session_id=true");
    expect(log).toContain("note=session_continuity_unavailable");
    expect(log).not.toContain("delivered=true");
  });

  test("codex session id 落 stderr 或写作 session_id 仍能解析（#726 宽松匹配）", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const reported: Array<{ session_id: string }> = [];
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "answer\n");
      // 下划线写法 + 大小写变体 + 落 stderr，都得能捞到（宽松匹配）
      return { code: 0, stdout: "no id here\n", stderr: `Session_ID: ${uuid(1)}\n` };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
      onSession: (session) => reported.push(session),
    })(triggerFrame(1), runnerCtx());

    const state = JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8"));
    expect(state).toMatchObject({ harness: "codex", session_id: uuid(1) });
    expect(reported).toEqual([expect.objectContaining({ session_id: uuid(1) })]);
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

  test("managed front output treats a host-file [attach] marker as inert literal text (#6)", async () => {
    const { posts, post } = postRecorder();
    const { uploads, upload } = uploadRecorder();
    const workdir = tempDir();
    const secret = join(tempDir(), "host-secret.txt");
    writeFileSync(secret, "must never leave the host");
    const runProcess: RunnerProcess = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, managedAction("channel_reply", { body: `[attach:${secret}]` }));
      return { code: 0, stdout: `session id: ${uuid(1)}\n`, stderr: "" };
    };
    const route = createManagedFrontResultRoute({
      server: "http://agentparty.test",
      token: "ap_front",
      channel: "dev",
      frontName: "front",
      workerName: "worker",
      ownerAccount: "owner@example.com",
      ownerDecisionBindingEnforced: () => true,
    });

    // attachmentRoot===null（managed front 无附件能力）：marker 不再抛 blocked，而是原样透传成普通文字。
    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_front",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
      uploadAttachment: upload,
      resultRoute: route,
      attachmentRoot: null,
    })(triggerFrame(42), runnerCtx());

    // 附件语法既没触发上传，也没把主机文件内容读进来——只是当作字面量发进频道。
    expect(uploads).toHaveLength(0);
    const message = posts.find((entry) => (entry.body as { kind?: string }).kind === "message");
    expect(message).toBeDefined();
    const body = (message!.body as { body: string }).body;
    expect(body).toContain(`[attach:${secret}]`);
    expect(body).not.toContain("must never leave the host");
  });

  test("managed worker attachments stay inside the real workspace and reject symlink escape", async () => {
    const { posts, post } = postRecorder();
    const { uploads, upload } = uploadRecorder();
    const workspace = tempDir("ap-worker-workspace-");
    const allowed = join(workspace, "result.txt");
    writeFileSync(allowed, "allowed artifact");
    const route = (frame: MsgFrame, text: string) => ({ replyTo: frame.seq, text });
    const allowedWorkdir = tempDir();
    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_worker",
      channel: "dev",
      harness: "codex",
      workdir: allowedWorkdir,
      runProcess: async (args) => {
        writeFileSync(args[args.indexOf("-o") + 1]!, `[attach:${allowed}]`);
        return { code: 0, stdout: `session id: ${uuid(1)}\n`, stderr: "" };
      },
      post,
      uploadAttachment: upload,
      resultRoute: route,
      attachmentRoot: workspace,
    })(triggerFrame(43), runnerCtx());
    expect(uploads).toHaveLength(1);
    expect(Buffer.from(uploads[0]!.bytes).toString("utf8")).toBe("allowed artifact");

    const outside = join(tempDir("ap-worker-outside-"), "secret.txt");
    writeFileSync(outside, "outside secret");
    const escape = join(workspace, "escape.txt");
    symlinkSync(outside, escape);
    const escapeWorkdir = tempDir();
    await expect(createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_worker",
      channel: "dev",
      harness: "codex",
      workdir: escapeWorkdir,
      runProcess: async (args) => {
        writeFileSync(args[args.indexOf("-o") + 1]!, `[attach:${escape}]`);
        return { code: 0, stdout: `session id: ${uuid(2)}\n`, stderr: "" };
      },
      post,
      uploadAttachment: upload,
      resultRoute: route,
      attachmentRoot: workspace,
    })(triggerFrame(44), runnerCtx())).rejects.toThrow("runner attachment escapes allowed workspace");
    expect(uploads).toHaveLength(1);
    expect(posts.filter((entry) => (entry.body as { kind?: string }).kind === "message")).toHaveLength(1);
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

  test("an explicit session_not_found process error clears the poison session without replaying the wake (#550)", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    writeFileSync(
      join(workdir, "wake-session.json"),
      JSON.stringify({ harness: "codex", session_id: uuid(1), created_at: 1, last_wake_ts: 1, wakes: 3 }),
    );
    const calls: string[][] = [];
    const runProcess: RunnerProcess = async (args) => {
      calls.push(args);
      if (args.includes("resume")) {
        return { code: 9, stdout: "", stderr: JSON.stringify({ error: { code: "session_not_found" } }) };
      }
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "recovered answer\n");
      return { code: 0, stdout: `session id: ${uuid(2)}\n`, stderr: "" };
    };

    await expect(createBuiltinRunner({
        server: "http://agentparty.test",
        token: "ap_tok",
        channel: "dev",
        harness: "codex",
        workdir,
        runProcess,
        post,
      })(triggerFrame(34), runnerCtx()),
    ).rejects.toThrow(/exit code 9/);

    expect(calls.filter((args) => args.includes("resume"))).toHaveLength(1);
    expect(calls.filter((args) => !args.includes("resume"))).toHaveLength(0);
    expect(posts.some((entry) => (entry.body as { kind?: string }).kind === "message")).toBe(false);
    expect(existsSync(join(workdir, "wake-session.json"))).toBe(false);
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

  test("claude cold-starts with a preallocated session id and resumes it", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const calls: string[][] = [];
    let coldSessionId = "";
    const runProcess: RunnerProcess = async (args) => {
      calls.push(args);
      if (args.includes("--resume")) return { code: 0, stdout: "resumed text\n", stderr: "" };
      coldSessionId = args[args.indexOf("--session-id") + 1]!;
      return { code: 0, stdout: JSON.stringify({ session_id: coldSessionId, result: "cold text" }), stderr: "" };
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

    expect(JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8")).session_id).toBe(coldSessionId);
    expect(calls[0]).toContain("--output-format");
    expect(calls[0]).toContain("--session-id");
    expect(calls.every((args) =>
      args[args.indexOf("--permission-mode") + 1] === "bypassPermissions"
    )).toBe(true);
    expect(calls[1]).toEqual([
      "claude", "-p", "--disallowed-tools", "AskUserQuestion",
      "--permission-mode", "bypassPermissions", "--settings", expect.any(String),
      "--resume", coldSessionId, expect.any(String),
    ]);
  });

  test("managed Codex continues an unattended owner decision in the same session", async () => {
    const owner = "fan@example.com";
    const workdir = tempDir();
    const calls: string[][] = [];
    const posts: Array<MessagePayload> = [];
    const post = async (_server: string, _token: string, _channel: string, body: MessagePayload) => {
      posts.push(body);
      if (body.kind === "message" && body.decision_request !== undefined) {
        return {
          seq: 50,
          decision_resolution: { state: "auto_resolved" as const, chosen_index: 0, chosen_option: "approve" },
        };
      }
      return { seq: 51 };
    };
    const runProcess: RunnerProcess = async (args) => {
      calls.push(args);
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, calls.length === 1
        ? managedAction("owner_decision", { prompt: "允许发布？", options: [] })
        : managedAction("channel_reply", { body: "已自动批准并继续完成" }));
      return { code: 0, stdout: calls.length === 1 ? `session id: ${uuid(6)}\n` : "", stderr: "" };
    };
    const route = createManagedFrontResultRoute({
      server: "http://agentparty.test",
      token: "ap_front",
      channel: "dev",
      frontName: "front",
      workerName: "worker",
      ownerAccount: owner,
      ownerDecisionBindingEnforced: () => true,
    });
    const frame = msgFrame(20, "ship it", {
      sender: { name: "leo", kind: "human", owner },
      mentions: ["front"],
    }) as unknown as MsgFrame;

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_front",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
      outputSchema: MANAGED_FRONT_OUTPUT_SCHEMA,
      resultRoute: route,
    })(frame, { ...runnerCtx(), self: "front", delivery: directedDelivery(20) });

    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args.includes("--output-schema"))).toBe(true);
    expect(calls[1]!.indexOf("--output-schema")).toBeLessThan(calls[1]!.indexOf("resume"));
    expect(String(calls[1]!.at(-1))).toContain("已自动选择：approve");
    const messages = posts.filter((body) => body.kind === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      decision_request: { prompt: "允许发布？" },
      expected_decision_responder_owner: owner,
    });
    expect(messages[1]).toMatchObject({ body: "已自动批准并继续完成", reply_to: 20 });
  });

  test("managed Claude reads structured_output on cold start and resume", async () => {
    const owner = "fan@example.com";
    const workdir = tempDir();
    const calls: string[][] = [];
    const { posts, post } = postRecorder();
    let sessionId = "";
    const runProcess: RunnerProcess = async (args) => {
      calls.push(args);
      if (!args.includes("--resume")) sessionId = args[args.indexOf("--session-id") + 1]!;
      return {
        code: 0,
        stdout: JSON.stringify({
          session_id: sessionId,
          structured_output: JSON.parse(managedAction("channel_reply", {
            body: args.includes("--resume") ? "resume structured" : "cold structured",
          })),
          result: "must not win",
        }),
        stderr: "",
      };
    };
    const route = createManagedFrontResultRoute({
      server: "http://agentparty.test",
      token: "ap_front",
      channel: "dev",
      frontName: "front",
      workerName: "worker",
      ownerAccount: owner,
      ownerDecisionBindingEnforced: () => true,
    });
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_front",
      channel: "dev",
      harness: "claude",
      workdir,
      runProcess,
      post,
      outputSchema: MANAGED_FRONT_OUTPUT_SCHEMA,
      resultRoute: route,
      sandbox: "read-only",
    });

    await run(msgFrame(30, "first", { sender: { name: "leo", kind: "human", owner } }) as unknown as MsgFrame, runnerCtx());
    await run(msgFrame(31, "second", { sender: { name: "leo", kind: "human", owner } }) as unknown as MsgFrame, runnerCtx());

    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args.includes("--json-schema") && args.includes("--output-format"))).toBe(true);
    expect(calls.every((args) => args.includes("--permission-mode") && args.includes("plan"))).toBe(true);
    expect(posts.filter((entry) => (entry.body as MessagePayload).kind === "message").map((entry) =>
      (entry.body as Extract<MessagePayload, { kind: "message" }>).body)).toEqual(["cold structured", "resume structured"]);
  });

  test("builtin claude runner writes wake context inside the runner workdir (#479)", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const expectedContextPath = join(workdir, "wake-context", "6.json");
    let prompt = "";
    const runProcess: RunnerProcess = async (args) => {
      prompt = String(args.at(-1));
      expect(JSON.parse(readFileSync(expectedContextPath, "utf8"))).toMatchObject({ channel: "dev", seq: 6 });
      const sessionId = args[args.indexOf("--session-id") + 1]!;
      return { code: 0, stdout: JSON.stringify({ session_id: sessionId, result: "ok" }), stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "claude",
      workdir,
      runProcess,
      post,
    })(triggerFrame(6), runnerCtx());

    expect(prompt).toContain(expectedContextPath);
    expect(expectedContextPath).toStartWith(join(workdir, "wake-context") + sep);
    expect(existsSync(expectedContextPath)).toBe(false);
    expect(lstatSync(join(workdir, "wake-context")).isDirectory()).toBe(true);
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
        available_version: "0.2.73",
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

  test("--codex-bin is rejected unless the selected resident runner is codex", async () => {
    const home = tempDir();
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: "http://127.0.0.1:1", token: "ap_tok" }));
    const oldHome = process.env.AGENTPARTY_HOME;
    const errors: string[] = [];
    const oldError = console.error;
    process.env.AGENTPARTY_HOME = home;
    console.error = (line?: unknown) => errors.push(String(line));
    try {
      expect(
        await runServeCommand([
          "dev",
          "--runner",
          "claude",
          "--codex-bin",
          process.execPath,
        ]),
      ).toBe(1);
    } finally {
      if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = oldHome;
      console.error = oldError;
    }
    expect(errors.join("\n")).toContain("--codex-bin requires --runner codex");
  });
});

describe("project profile daemon", () => {
  test("profile sessions isolate server, stable profile identity, and authoritative child principal", async () => {
    const home = tempDir();
    const previous = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    const profile = {
      owner_account: "fan@example.com",
      handle: "same-handle",
      name: "Same",
      runner: "codex-sdk" as const,
      repo_url: null,
      workdir: null,
      base_branch: "main",
      worktree_strategy: "none" as const,
      rules: null,
      invitable_by: "anyone" as const,
      created_at: 100,
      updated_at: 200,
    };
    try {
      const prod = await prepareProfileChannelWorkspace({
        server: "https://prod.agentparty.test/api",
        profile,
        channel: "dev",
        child: { name: "child", owner: profile.owner_account, channel_scope: "dev" },
      });
      const rotated = await prepareProfileChannelWorkspace({
        server: "https://prod.agentparty.test",
        profile: { ...profile, updated_at: 999 },
        channel: "dev",
        child: { name: "child", owner: profile.owner_account, channel_scope: "dev" },
      });
      const testServer = await prepareProfileChannelWorkspace({
        server: "https://test.agentparty.test",
        profile,
        channel: "dev",
        child: { name: "child", owner: profile.owner_account, channel_scope: "dev" },
      });
      const otherChild = await prepareProfileChannelWorkspace({
        server: "https://prod.agentparty.test",
        profile,
        channel: "dev",
        child: { name: "other-child", owner: profile.owner_account, channel_scope: "dev" },
      });
      expect(prod.runnerWorkdir).toBe(rotated.runnerWorkdir);
      expect(prod.runnerWorkdir).not.toBe(testServer.runnerWorkdir);
      expect(prod.runnerWorkdir).not.toBe(otherChild.runnerWorkdir);
      expect(prod.runnerWorkdir).toContain("project-agents");
      expect(prod.runnerWorkdir).toContain("fan_example.com");
      expect(prod.runnerWorkdir).toContain("same-handle");
    } finally {
      if (previous === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = previous;
    }
  });

  test("shell-quotes cleanup branches and sanitizes user-visible ready fields", () => {
    expect(projectAgentCleanupCommand("main'; echo pwn")).toBe(
      "party worktree prune --base 'main'\\''; echo pwn' --remote --yes",
    );
    const note = projectAgentReadyNote(
      {
        owner_account: "fan@example.com",
        handle: "herness-dev",
        name: "Herness Dev",
        runner: "codex-sdk",
        repo_url: `https://example.test/repo\x1b[31m\nforged${"x".repeat(300)}`,
        workdir: null,
        base_branch: "main\nforged",
        worktree_strategy: "branch",
        rules: null,
        invitable_by: "anyone",
        created_at: 1,
        updated_at: 1,
      },
      "alpha\nforged",
      { runnerWorkdir: "/tmp/runner", channelWorkdir: "/tmp/repo\x1b]8;;https://evil\x07\nforged" },
    );
    expect(note).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(note).toContain("channel=#alpha forged");
    expect(note).toContain("base=main forged");
    expect(note).not.toContain("x".repeat(241));
  });

  test("front lane stays independently runnable while its execution worker is busy", async () => {
    const home = tempDir();
    const oldHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    const profile = {
      owner_account: "fan@example.com",
      handle: "parallel-front",
      name: "Parallel Front",
      runner: "codex-sdk" as const,
      repo_url: null,
      workdir: null,
      base_branch: "main",
      worktree_strategy: "shared" as const,
      rules: null,
      invitable_by: "anyone" as const,
      created_at: 1,
      updated_at: 1,
    };
    let workerStarted = false;
    let workerAborted = false;
    let frontStarted = false;
    try {
      expect(await runProfileServe({
        server: "http://agentparty.test",
        humanToken: "acc-human",
        ownerAccount: profile.owner_account,
        handle: profile.handle,
        mentionsOnly: true,
        once: true,
        mintRuntime: async () => ({ token: "ap_profile", profile }),
        listInvites: async () => [{
          id: 1,
          channel_slug: "dev",
          owner_account: profile.owner_account,
          profile_handle: profile.handle,
          invited_by: "owner@example.com",
          invited_at: 1,
          profile,
        }],
        ensureChannelRuntime: async (_server, _token, channel, _owner, _handle, childName) => ({
          token: `ap_${childName}`,
          name: childName,
          role: "agent",
          owner: profile.owner_account,
          channel_scope: channel,
          lineage: { parent_agent: profile.handle, root_agent: profile.handle, team_id: profile.handle, depth: 1, expires_at: null },
          profile,
        }),
        runChannelServe: async (options) => {
          if (options.projectAgent?.runtime_role === "worker") {
            workerStarted = true;
            return await new Promise<number>((resolve) => {
              const stop = () => {
                workerAborted = true;
                resolve(EXIT_SIGNAL_TERM);
              };
              options.signal?.addEventListener("abort", stop, { once: true });
              if (options.signal?.aborted) stop();
            });
          }
          expect(workerStarted).toBe(true);
          frontStarted = true;
          return 0;
        },
      })).toBe(0);
    } finally {
      if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = oldHome;
    }
    expect(frontStarted).toBe(true);
    expect(workerAborted).toBe(true);
  });

  test("one resident daemon fans out to invited channels with scoped child tokens and distinct sessions", async () => {
    const home = tempDir();
    const oldHome = process.env.AGENTPARTY_HOME;
    const oldConfig = process.env.AGENTPARTY_CONFIG;
    process.env.AGENTPARTY_HOME = home;
    const ownerConfig = join(home, "owner.json");
    writeFileSync(ownerConfig, JSON.stringify({ server: "http://agentparty.test", token: "ap_owner" }));
    process.env.AGENTPARTY_CONFIG = ownerConfig;
    const unsafeRoleWarning = "channel already has assigned host @owner-host\u001b[2Jforged";
    const { posts, post } = postRecorder(unsafeRoleWarning);
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
    const profileLines: string[] = [];
    let upgradeProbes = 0;
    const channelRuntimeCalls: Array<{ slug: string; childName: string }> = [];
    try {
      const code = await runProfileServe({
        server: "http://agentparty.test",
        humanToken: "acc-human",
        ownerAccount: "fan@example.com",
        handle: "herness-dev",
        mentionsOnly: true,
        upgradeProbeIntervalMs: 60_000,
        refreshAvailableUpgrade: async () => {
          upgradeProbes += 1;
          return null;
        },
        once: true,
        post,
        out: (line) => profileLines.push(line),
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
          const lane = childName === projectAgentWorkerName(profile.handle, slug) ? "worker" : "front";
          return {
            token: `ap_${lane}_${slug}`,
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
      if (oldConfig === undefined) delete process.env.AGENTPARTY_CONFIG;
      else process.env.AGENTPARTY_CONFIG = oldConfig;
    }

    expect(served.map((o) => o.channel).sort()).toEqual(["alpha", "alpha", "beta", "beta", "gamma", "gamma"]);
    expect(served.map((o) => o.token).sort()).toEqual([
      "ap_front_alpha", "ap_front_beta", "ap_front_gamma",
      "ap_worker_alpha", "ap_worker_beta", "ap_worker_gamma",
    ]);
    expect(new Set(served.map((o) => o.sdkRunner?.workdir)).size).toBe(6);
    expect(served.every((o) => o.sdkRunner?.agentpartyConfigPath === undefined)).toBe(true);
    expect(served.filter((o) => o.projectAgent?.runtime_role === "front")).toHaveLength(3);
    expect(served.filter((o) => o.projectAgent?.runtime_role === "worker")).toHaveLength(3);
    expect(served.filter((o) => o.projectAgent?.runtime_role === "front").every((o) =>
      o.sdkRunner?.outputSchema === MANAGED_FRONT_OUTPUT_SCHEMA &&
      o.sdkRunner?.sandbox === "read_only" &&
      o.sdkRunner?.attachmentRoot === null)).toBe(true);
    expect(served.filter((o) => o.projectAgent?.runtime_role === "worker").every((o) =>
      o.sdkRunner?.outputSchema === undefined &&
      o.sdkRunner?.sandbox === "workspace-write" &&
      o.sdkRunner?.attachmentRoot === o.projectAgent?.channel_workdir)).toBe(true);
    expect(served.every((o) => o.sdkRunner?.cwd === o.projectAgent?.channel_workdir)).toBe(true);
    expect(JSON.parse(readFileSync(ownerConfig, "utf8"))).toEqual({
      server: "http://agentparty.test",
      token: "ap_owner",
    });
    expect(allFileText(home)).not.toContain("ap_front_");
    expect(allFileText(home)).not.toContain("ap_worker_");
    await Promise.all(served.map((o) => o.refreshAvailableUpgrade?.(null)));
    expect(upgradeProbes).toBe(1);
    expect(new Set(served.map((o) => o.projectAgent?.channel_workdir)).size).toBe(3);
    expect(served.every((o) => o.projectAgent?.delivery_workflow.steps.join("->") ===
      "work_in_channel_worktree->create_pull_request->report_pull_request_url_in_channel->verify_deployment->prune_merged_worktree")).toBe(true);
    expect(served.every((o) => o.projectAgent?.delivery_workflow.cleanup_command ===
      "party worktree prune --base 'main' --remote --yes")).toBe(true);
    expect(served.every((o) => o.projectAgent?.delivery_workflow.cleanup_guard.includes("dirty or unmerged"))).toBe(true);
    expect(channelRuntimeCalls).toEqual([
      { slug: "alpha", childName: projectAgentChildName("herness-dev", "alpha") },
      { slug: "alpha", childName: projectAgentWorkerName("herness-dev", "alpha") },
      { slug: "beta", childName: projectAgentChildName("herness-dev", "beta") },
      { slug: "beta", childName: projectAgentWorkerName("herness-dev", "beta") },
      { slug: "gamma", childName: projectAgentChildName("herness-dev", "gamma") },
      { slug: "gamma", childName: projectAgentWorkerName("herness-dev", "gamma") },
    ]);
    expect(posts).toHaveLength(9);
    const statusPosts = posts.filter((p) => (p.body as { kind: string }).kind === "status");
    const joinPosts = posts.filter((p) => (p.body as { kind: string }).kind === "message");
    expect(statusPosts).toHaveLength(6);
    expect(statusPosts.filter((p) => (p.body as { role?: string }).role === "host")).toHaveLength(3);
    expect(statusPosts.filter((p) => (p.body as { role?: string }).role === "worker")).toHaveLength(3);
    expect(posts.every((p) => p.token.startsWith("ap_front_") || p.token.startsWith("ap_worker_"))).toBe(true);
    const frontReady = statusPosts.find((p) => (p.body as { role?: string }).role === "host")!;
    expect(String((frontReady.body as { note: string }).note)).toContain("front agent ready");
    expect(String((frontReady.body as { note: string }).note)).toContain("team=herness-dev");
    expect(String((frontReady.body as { note: string }).note)).toContain("worktree=branch");
    expect(String((frontReady.body as { note: string }).note)).toContain("delivery=worktree->PR->channel-link->deploy-verify->safe-prune");
    expect(joinPosts.every((p) => String((p.body as { body?: string }).body).includes("front="))).toBe(true);
    expect(joinPosts.every((p) => String((p.body as { body?: string }).body).includes("execution worker="))).toBe(true);
    expect(
      profileLines.filter(
        (line) => line === "profile front #alpha: warn: channel already has assigned host @owner-hostforged"
          || line === "profile front #beta: warn: channel already has assigned host @owner-hostforged"
          || line === "profile front #gamma: warn: channel already has assigned host @owner-hostforged",
      ),
    ).toHaveLength(3);
    expect(profileLines.join("\n")).not.toContain("\u001b");
  });

  test("shared profile channels keep distinct child identities without overwriting the shared workspace config", async () => {
    const home = tempDir();
    const sharedCwd = join(home, "shared-project");
    mkdirSync(sharedCwd, { recursive: true });
    const oldHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    const sharedConfigPath = writeWorkspaceConfigOnly(
      { server: "http://agentparty.test", token: "ap_workspace_owner" },
      sharedCwd,
    );
    const profile = {
      owner_account: "fan@example.com",
      handle: "shared-dev",
      name: "Shared Dev",
      runner: "codex-sdk" as const,
      repo_url: null,
      workdir: sharedCwd,
      base_branch: "main",
      worktree_strategy: "shared" as const,
      rules: null,
      invitable_by: "anyone" as const,
      created_at: 1,
      updated_at: 1,
    };
    const served: ServeOptions[] = [];
    try {
      expect(await runProfileServe({
        server: "http://agentparty.test",
        humanToken: "acc-human",
        ownerAccount: profile.owner_account,
        handle: profile.handle,
        mentionsOnly: true,
        once: true,
        post: async () => ({ seq: 1 }),
        mintRuntime: async () => ({ token: "ap_profile_runtime", profile }),
        listInvites: async () => ["alpha", "beta"].map((channel_slug, index) => ({
          id: index + 1,
          channel_slug,
          owner_account: profile.owner_account,
          profile_handle: profile.handle,
          invited_by: "owner@example.com",
          invited_at: index + 1,
          profile,
        })),
        ensureChannelRuntime: async (_server, _token, channel, _owner, _handle, childName) => ({
          token: `ap_child_${childName}`,
          name: childName,
          role: "agent",
          owner: profile.owner_account,
          channel_scope: channel,
          lineage: { parent_agent: profile.handle, root_agent: profile.handle, team_id: profile.handle, depth: 1, expires_at: null },
          profile,
        }),
        runChannelServe: async (options) => {
          served.push(options);
          return 0;
        },
      })).toBe(0);
    } finally {
      if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = oldHome;
    }

    expect(served).toHaveLength(4);
    expect(new Set(served.map((item) => item.sdkRunner?.cwd))).toEqual(new Set([sharedCwd]));
    expect(served.every((item) => item.sdkRunner?.agentpartyConfigPath === undefined)).toBe(true);
    expect(new Set(served.map((item) => item.token)).size).toBe(4);
    expect(JSON.parse(readFileSync(sharedConfigPath, "utf8"))).toEqual({
      server: "http://agentparty.test",
      token: "ap_workspace_owner",
    });
  });

  test("a cleared profile upgrade is not revived by a stale channel after a failed probe (#485)", async () => {
    const home = tempDir();
    const oldHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
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
    const notice: CliUpgradeNotice = {
      running_version: "0.2.107",
      available_version: "0.2.108",
      auto_upgrade: false,
      action_required: "ask_user",
      message: "notify owner",
      command: "install",
    };
    const served: ServeOptions[] = [];
    let polls = 0;
    let sleeps = 0;
    let probes = 0;
    let refreshDone: Promise<void> = Promise.resolve();
    try {
      await expect(runProfileServe({
        server: "http://agentparty.test",
        humanToken: "acc-human",
        ownerAccount: profile.owner_account,
        handle: profile.handle,
        mentionsOnly: true,
        availableUpgrade: notice,
        upgradeProbeIntervalMs: 0,
        refreshAvailableUpgrade: async () => {
          probes += 1;
          if (probes === 1) return null;
          throw new Error("version endpoint offline");
        },
        mintRuntime: async () => ({ token: "ap_profile_runtime", profile }),
        listInvites: async () => {
          polls += 1;
          return (polls === 1 ? ["alpha"] : ["alpha", "beta"]).map((channel_slug, index) => ({
            id: index + 1,
            channel_slug,
            owner_account: profile.owner_account,
            profile_handle: profile.handle,
            invited_by: "owner@example.com",
            invited_at: index + 1,
            profile,
          }));
        },
        ensureChannelRuntime: async (_server, _token, channel, _owner, _handle, childName) => ({
          token: `ap_child_${childName}`,
          name: childName,
          role: "agent",
          owner: profile.owner_account,
          channel_scope: channel,
          lineage: { parent_agent: profile.handle, root_agent: profile.handle, team_id: profile.handle, depth: 1, expires_at: null },
          profile,
        }),
        runChannelServe: (opts) => {
          served.push(opts);
          if (opts.channel === "alpha" && served.filter((item) => item.channel === "alpha").length === 1) {
            refreshDone = (async () => {
              await opts.refreshAvailableUpgrade?.(notice);
              await expect(opts.refreshAvailableUpgrade?.(notice)).rejects.toThrow("version endpoint offline");
            })();
          }
          return new Promise<number>((resolve) => {
            const stop = () => resolve(EXIT_SIGNAL_TERM);
            opts.signal?.addEventListener("abort", stop, { once: true });
            if (opts.signal?.aborted) stop();
          });
        },
        sleep: async () => {
          sleeps += 1;
          await refreshDone;
          if (sleeps >= 2) throw new Error("stop profile test");
        },
      })).rejects.toThrow("stop profile test");
    } finally {
      if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = oldHome;
    }

    expect(probes).toBe(2);
    expect(served.find((opts) => opts.channel === "beta")?.availableUpgrade).toBeNull();
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

  test("managed SDK continues an unattended owner decision before completing the delivery", async () => {
    const owner = "fan@example.com";
    const workdir = tempDir();
    const prompts: string[] = [];
    const posts: MessagePayload[] = [];
    const thread: ThreadLike = {
      id: "thread_auto_decision",
      run: async (prompt, options) => {
        prompts.push(prompt);
        expect(options.outputSchema).toBe(MANAGED_FRONT_OUTPUT_SCHEMA);
        return {
          final_response: prompts.length === 1
            ? managedAction("owner_decision", { prompt: "允许继续？", options: [] })
            : managedAction("channel_reply", { body: "自动批准后已完成" }),
        };
      },
    };
    const post = async (_server: string, _token: string, _channel: string, body: MessagePayload) => {
      posts.push(body);
      if (body.kind === "message" && body.decision_request !== undefined) {
        return {
          seq: 70,
          decision_resolution: { state: "auto_resolved" as const, chosen_index: 0, chosen_option: "approve" },
        };
      }
      return { seq: 71 };
    };
    const route = createManagedFrontResultRoute({
      server: "http://agentparty.test",
      token: "ap_front",
      channel: "dev",
      frontName: "front",
      workerName: "worker",
      ownerAccount: owner,
      ownerDecisionBindingEnforced: () => true,
    });
    const run = sdkRunner({
      workdir,
      outputSchema: MANAGED_FRONT_OUTPUT_SCHEMA,
      resultRoute: route,
      post,
      codexFactory: () => ({
        startThread: () => thread,
        resumeThread: () => thread,
      }),
    });
    const frame = msgFrame(40, "continue", {
      sender: { name: "leo", kind: "human", owner },
    }) as unknown as MsgFrame;

    await run(frame, { ...runnerCtx(), self: "front", delivery: directedDelivery(40) });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("已自动选择：approve");
    const messages = posts.filter((body) => body.kind === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ expected_decision_responder_owner: owner });
  });

  test("managed blocked action publishes blocked presence instead of only a normal reply", async () => {
    const owner = "fan@example.com";
    const { posts, post } = postRecorder();
    const thread: ThreadLike = {
      id: "thread_blocked",
      run: async () => ({ final_response: managedAction("blocked", { reason: "缺少部署权限" }) }),
    };
    const run = sdkRunner({
      workdir: tempDir(),
      post,
      outputSchema: MANAGED_FRONT_OUTPUT_SCHEMA,
      resultRoute: createManagedFrontResultRoute({
        server: "http://agentparty.test",
        token: "ap_front",
        channel: "dev",
        frontName: "front",
        workerName: "worker",
        ownerAccount: owner,
        ownerDecisionBindingEnforced: () => true,
      }),
      codexFactory: () => ({ startThread: () => thread, resumeThread: () => thread }),
    });
    const frame = msgFrame(41, "deploy", { sender: { name: "leo", kind: "human", owner } }) as unknown as MsgFrame;

    await run(frame, { ...runnerCtx(), self: "front", delivery: directedDelivery(41) });

    expect(posts.some((entry) => (entry.body as MessagePayload).kind === "message" &&
      (entry.body as Extract<MessagePayload, { kind: "message" }>).body.includes("暂时阻塞"))).toBe(true);
    expect(posts.some((entry) => (entry.body as MessagePayload).kind === "status" &&
      (entry.body as Extract<MessagePayload, { kind: "status" }>).state === "blocked" &&
      (entry.body as Extract<MessagePayload, { kind: "status" }>).blocked_reason === "缺少部署权限")).toBe(true);
  });

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

  test("session reports fall back to workdir when the SDK does not provide cwd", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    const reported: Array<{ cwd?: string; workdir?: string }> = [];
    const thread: ThreadLike = {
      id: "thread_cwd_12345678",
      run: async () => ({ final_response: "ok" }),
    };

    await sdkRunner({
      workdir,
      post,
      onSession: (session) => reported.push(session),
      codexFactory: () => ({
        startThread: () => thread,
        resumeThread: () => thread,
      }),
    })(triggerFrame(101), runnerCtx());

    expect(reported).toContainEqual(expect.objectContaining({ cwd: workdir, workdir }));
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

  test("an SDK thread_not_found error clears the persisted handle before cold start (#550)", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    writeFileSync(
      join(workdir, "wake-session.json"),
      JSON.stringify({
        harness: "codex-sdk",
        thread_id: "thread_poison_12345678",
        created_at: 1,
        last_wake_ts: 1,
        wakes: 3,
      }),
    );
    let starts = 0;
    let resumes = 0;
    const freshThread: ThreadLike = {
      id: "thread_fresh_12345678",
      run: async () => ({ final_response: "recovered" }),
    };

    await sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => {
          starts += 1;
          return freshThread;
        },
        resumeThread: () => {
          resumes += 1;
          throw Object.assign(new Error("thread is gone"), { code: "thread_not_found" });
        },
      }),
    })(triggerFrame(102), runnerCtx());

    expect(resumes).toBe(1);
    expect(starts).toBe(1);
    expect(JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8"))).toMatchObject({
      thread_id: "thread_fresh_12345678",
      wakes: 1,
    });
  });

  test("a lazy SDK resume that fails inside run clears the handle but never cold-starts the current wake (#550)", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    writeFileSync(
      join(workdir, "wake-session.json"),
      JSON.stringify({ harness: "codex-sdk", thread_id: "thread_lazy_bad_12345678", created_at: 1, last_wake_ts: 1, wakes: 2 }),
    );
    let starts = 0;
    const resumed: ThreadLike = {
      id: "thread_lazy_bad_12345678",
      run: async () => { throw Object.assign(new Error("gone"), { code: "thread_not_found" }); },
    };

    const error = await sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => { starts += 1; return resumed; },
        resumeThread: () => resumed,
      }),
    })(triggerFrame(102), runnerCtx()).catch((cause) => cause);

    expect(error).toBeInstanceOf(WakeBlockedError);
    expect((error as WakeBlockedError).retriable).toBe(false);
    expect(starts).toBe(0);
    expect(existsSync(join(workdir, "wake-session.json"))).toBe(false);
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

  test("an SDK that ignores AbortSignal forces an unconfirmed-termination timeout and no next wake (#550)", async () => {
    const { post } = postRecorder();
    const workdir = tempDir();
    let starts = 0;
    const hungThread: ThreadLike = {
      id: "thread_hung_12345678",
      run: async () => new Promise<never>(() => {}),
    };
    const run = sdkRunner({
      workdir,
      post,
      codexFactory: () => ({
        startThread: () => {
          starts += 1;
          return hungThread;
        },
        resumeThread: () => {
          throw new Error("timed-out session must not be resumed");
        },
      }),
    });

    const error = await runWithRunnerTimeout(run, triggerFrame(109), runnerCtx(), 10).catch((cause) => cause);
    expect(error).toBeInstanceOf(RunnerTimeoutError);
    expect((error as RunnerTimeoutError).terminationConfirmed).toBe(false);
    expect(starts).toBe(1);
  });
});

describe("runner hard timeout (#550)", () => {
  test("aborts the runner and rejects with a non-retriable timeout", async () => {
    let observedAbort = false;
    const run: NonNullable<ServeOptions["runCommand"]> = async (_frame, ctx) => {
      await new Promise<void>((_resolve, reject) => {
        ctx.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(ctx.signal?.reason);
        }, { once: true });
      });
    };

    const promise = runWithRunnerTimeout(run, triggerFrame(201), runnerCtx(), 10);
    await expect(promise).rejects.toBeInstanceOf(RunnerTimeoutError);
    expect(observedAbort).toBe(true);
    await promise.catch((error) => {
      expect(error).toMatchObject({ retriable: false, timeoutMs: 10 });
    });
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
