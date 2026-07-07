import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { EXIT_ARCHIVED, type MsgFrame } from "@agentparty/shared";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBuiltinRunner,
  run as runServeCommand,
  runServe,
  writeContextFile,
  type RunnerProcess,
  type ServeOptions,
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
  return { cmd: "", channel: "dev", self: "me", recent: [] as MsgFrame[] };
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

  test("resume failure cold-starts a new codex session and prefixes the reply with a reset marker", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();
    writeFileSync(
      join(workdir, "wake-session.json"),
      JSON.stringify({ harness: "codex", session_id: uuid(1), created_at: 1, last_wake_ts: 1, wakes: 3 }),
    );
    const runProcess: RunnerProcess = async (args) => {
      if (args.includes("resume")) return { code: 9, stdout: "", stderr: "missing session" };
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "fresh answer\n");
      return { code: 0, stdout: `session id: ${uuid(2)}\n`, stderr: "" };
    };

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
    })(triggerFrame(33), runnerCtx());

    const finalPost = posts.at(-1)!;
    expect(finalPost.body).toMatchObject({ kind: "message", reply_to: 33 });
    expect((finalPost.body as { body: string }).body).toStartWith(
      "[session reset: 019f35d9 → 019f35d9]\nfresh answer",
    );
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

  test("child non-zero exit posts blocked status with the runner log path and no final body", async () => {
    const { posts, post } = postRecorder();
    const workdir = tempDir();

    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess: async () => ({ code: 7, stdout: "", stderr: "boom" }),
      post,
    })(triggerFrame(45), runnerCtx());

    expect(posts).toHaveLength(2);
    const blocked = posts[1]!.body as { note?: unknown };
    const note = String(blocked.note);
    expect(posts[1]!.body).toMatchObject({
      kind: "status",
      state: "blocked",
    });
    expect(note).toContain("exit code 7");
    expect(note).toContain(join(workdir, "serve-runner.log"));
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
