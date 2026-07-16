import { afterEach, describe, expect, test } from "bun:test";
import { EXIT_ARCHIVED, type DirectedDelivery, type MsgFrame } from "@agentparty/shared";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBuiltinRunner,
  createSdkRunner,
  RunnerTimeoutError,
  runServe,
  runWithRunnerTimeout,
  WakeBlockedError,
  writeContextFile,
  type CodexLike,
  type RunnerProcess,
  type ThreadLike,
} from "../src/commands/serve";
import { prepareDecisionContinuation } from "../src/commands/decision";
import {
  blockRunnerContinuation,
  continuationPath,
  deleteRunnerContinuation,
  mergeRunnerContinuation,
  readRunnerContinuation,
  withRunnerContinuationLock,
  writeRunnerContinuation,
} from "../src/continuation";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

const dirs: string[] = [];
const servers: MockServer[] = [];
type TrackedProcess = {
  kill(signal?: NodeJS.Signals | number): void;
  exited: Promise<number>;
};
const processes: TrackedProcess[] = [];

function trackProcess<T extends TrackedProcess>(process: T): T {
  processes.push(process);
  return process;
}

async function stopProcess(process: TrackedProcess): Promise<void> {
  try { process.kill("SIGTERM"); } catch { /* already exited */ }
  const stopped = await Promise.race([
    process.exited.then(() => true),
    Bun.sleep(100).then(() => false),
  ]);
  if (!stopped) {
    try { process.kill("SIGKILL"); } catch { /* already exited */ }
  }
  await process.exited.catch(() => undefined);
}

afterEach(async () => {
  for (const process of processes.splice(0)) await stopProcess(process);
  for (const server of servers.splice(0)) server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "ap-continuation-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function uuid(n: number): string {
  return `019f35d9-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function message(seq: number, over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    ...(msgFrame(seq, `work ${seq}`, { mentions: ["me"] }) as unknown as MsgFrame),
    ...over,
  };
}

function delivery(
  seq: number,
  workId: string,
  continuationRef: string,
  cause: DirectedDelivery["cause"] = "mention",
): DirectedDelivery {
  return {
    id: `delivery-${seq}-${cause}`,
    message_seq: seq,
    target_name: "me",
    cause,
    state: "claimed",
    attempt: 1,
    lease_until: Date.now() + 90_000,
    work_id: workId,
    continuation_ref: continuationRef,
    reply_seq: null,
    last_error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function context(item: DirectedDelivery) {
  return {
    cmd: "",
    channel: "dev",
    self: "me",
    contextDir: tempDir("ap-continuation-context-"),
    recent: [] as MsgFrame[],
    delivery: item,
  };
}

const post = async () => ({ seq: 99 });

describe("builtin per-work continuations (#548)", () => {
  test("a decision block written during a successful builtin run survives final session bookkeeping", async () => {
    const workdir = tempDir();
    const ref = "builtin-stale-merge";
    const workId = "work-builtin-stale";
    const sid = uuid(81);
    const path = continuationPath(workdir, ref);
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_test",
      channel: "dev",
      harness: "codex",
      workdir,
      post,
      runProcess: async (args) => {
        const out = args[args.indexOf("-o") + 1]!;
        writeFileSync(out, "parked\n");
        // Cold harness decision ask creates the first mapping from its live CODEX_THREAD_ID.
        writeRunnerContinuation(path, {
          harness: "codex",
          session_id: sid,
          created_at: 1,
          last_wake_ts: 1,
          wakes: 0,
          work_id: workId,
          continuation_ref: ref,
        });
        blockRunnerContinuation(path, "server lineage mismatch", 123);
        return { code: 0, stdout: `session id: ${sid}\n`, stderr: "" };
      },
    });
    await run(message(6), context(delivery(6, workId, ref)));
    expect(readRunnerContinuation(path)).toMatchObject({
      session_id: sid,
      work_id: workId,
      continuation_ref: ref,
      wakes: 1,
      resume_blocked_reason: "server lineage mismatch",
      resume_blocked_at: 123,
    });
    let processCalls = 0;
    const restarted = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_test",
      channel: "dev",
      harness: "codex",
      workdir,
      post,
      runProcess: async () => { processCalls += 1; return { code: 0, stdout: "", stderr: "" }; },
    });
    await expect(restarted(message(7), context(delivery(7, workId, ref, "owner_answer")))).rejects.toThrow("resume blocked");
    expect(processCalls).toBe(0);
  });

  test("A/B cold-start separately, owner answers resume B then A, and restart keeps both mappings", async () => {
    const workdir = tempDir();
    const legacySid = uuid(90);
    writeFileSync(join(workdir, "wake-session.json"), JSON.stringify({
      harness: "codex",
      session_id: legacySid,
      created_at: 1,
      last_wake_ts: 1,
      wakes: 7,
    }));

    const refA = "../../unsafe/ref A";
    const refB = "ref-B";
    const sidA = uuid(1);
    const sidB = uuid(2);
    const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const runProcess: RunnerProcess = async (args, options) => {
      calls.push({ args, env: options.env });
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, `answer for ${options.env.AP_WORK_ID}\n`);
      const sid = options.env.AP_WORK_ID === "work-A" ? sidA : sidB;
      return { code: 0, stdout: args.includes("resume") ? "" : `session id: ${sid}\n`, stderr: "" };
    };
    const makeRunner = () => createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_test",
      channel: "dev",
      harness: "codex",
      workdir,
      agentpartyConfigPath: "/safe/profile-child.json",
      runProcess,
      post,
    });

    const first = makeRunner();
    await first(message(1), context(delivery(1, "work-A", refA)));
    await first(message(2), context(delivery(2, "work-B", refB, "reply")));
    await first(message(3, { decision_response: { request_seq: 22, chosen_index: 0, chosen_option: "yes" } }), context(delivery(3, "work-B", refB, "owner_answer")));
    await first(message(4, { decision_response: { request_seq: 11, chosen_index: 1, chosen_option: "no" } }), context(delivery(4, "work-A", refA, "owner_answer")));

    // A new serve process must recover the same exact slot, not the legacy channel-wide session.
    await makeRunner()(message(5), context(delivery(5, "work-A", refA, "owner_answer")));

    expect(calls.map(({ args }) => args.slice(0, 4))).toEqual([
      ["codex", "exec", "--skip-git-repo-check", "--sandbox"],
      ["codex", "exec", "--skip-git-repo-check", "--sandbox"],
      ["codex", "exec", "resume", sidB],
      ["codex", "exec", "resume", sidA],
      ["codex", "exec", "resume", sidA],
    ]);
    expect(calls[0]!.env).toMatchObject({
      AGENTPARTY_CONFIG: "/safe/profile-child.json",
      AGENTPARTY_CHANNEL: "dev",
      AP_RUNNER_WORKDIR: workdir,
      AP_RUNNER_HARNESS: "codex",
      AP_RUNNER_SESSION_ID: "",
      AP_DELIVERY_ID: "delivery-1-mention",
      AP_WORK_ID: "work-A",
      AP_CONTINUATION_REF: refA,
    });
    expect(calls[2]!.env).toMatchObject({
      AP_RUNNER_WORKDIR: workdir,
      AP_RUNNER_HARNESS: "codex",
      AP_RUNNER_SESSION_ID: sidB,
      AP_DELIVERY_ID: "delivery-3-owner_answer",
      AP_WORK_ID: "work-B",
      AP_CONTINUATION_REF: refB,
    });

    const files = readdirSync(join(workdir, "continuations")).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(2);
    expect(files.every((name) => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true);
    expect(files.join(" ")).not.toContain("unsafe");
    const states = files.map((name) => JSON.parse(readFileSync(join(workdir, "continuations", name), "utf8")));
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: sidA, work_id: "work-A", continuation_ref: refA, wakes: 3 }),
      expect.objectContaining({ session_id: sidB, work_id: "work-B", continuation_ref: refB, wakes: 2 }),
    ]));
    expect(JSON.parse(readFileSync(join(workdir, "wake-session.json"), "utf8"))).toMatchObject({
      session_id: legacySid,
      wakes: 7,
    });
  });

  test("owner_answer never cold-starts when its slot is missing or belongs to another work id", async () => {
    const workdir = tempDir();
    let processCalls = 0;
    const runProcess: RunnerProcess = async (args) => {
      processCalls += 1;
      const out = args[args.indexOf("-o") + 1]!;
      writeFileSync(out, "ok\n");
      return { code: 0, stdout: `session id: ${uuid(7)}\n`, stderr: "" };
    };
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_test",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess,
      post,
    });

    const missing = await run(message(10), context(delivery(10, "missing", "missing-ref", "owner_answer"))).catch((error) => error);
    expect(missing).toBeInstanceOf(WakeBlockedError);
    expect((missing as WakeBlockedError).retriable).toBe(false);
    expect(processCalls).toBe(0);

    await run(message(11), context(delivery(11, "work-X", "shared-ref")));
    expect(processCalls).toBe(1);
    const mismatch = await run(message(12), context(delivery(12, "work-Y", "shared-ref", "owner_answer"))).catch((error) => error);
    expect(mismatch).toBeInstanceOf(WakeBlockedError);
    expect((mismatch as WakeBlockedError).retriable).toBe(false);
    expect(String((mismatch as Error).message)).toContain("mismatch");
    expect(processCalls).toBe(1);
  });

  test("Claude preallocates one cold session for argv, env, decision parking, and owner-answer resume", async () => {
    const workdir = tempDir();
    const ref = "ref-C";
    const workId = "work-C";
    const secret = "PRIVATE_OWNER_BODY_MUST_NOT_APPEAR_IN_ARGV";
    const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    let coldSessionId = "";
    const runProcess: RunnerProcess = async (args, options) => {
      calls.push({ args, env: options.env });
      expect(args.join(" ")).not.toContain(secret);
      if (args.includes("--resume")) {
        return { code: 0, stdout: "resumed", stderr: "" };
      }
      coldSessionId = args[args.indexOf("--session-id") + 1]!;
      expect(coldSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(options.env.AP_RUNNER_SESSION_ID).toBe(coldSessionId);
      expect(prepareDecisionContinuation(options.env, 123)).toMatchObject({
        workId,
        continuationRef: ref,
        harness: "claude",
        sessionId: coldSessionId,
      });
      // The official --session-id flag is authoritative even if stdout is absent, stale, or wrong.
      return { code: 0, stdout: JSON.stringify({ session_id: "ignored-output-id", result: "cold" }), stderr: "" };
    };
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_test",
      channel: "dev",
      harness: "claude",
      workdir,
      runProcess,
      post,
    });
    await run(message(20, { body: secret }), context(delivery(20, workId, ref)));
    expect(readRunnerContinuation(continuationPath(workdir, ref))).toMatchObject({
      harness: "claude",
      session_id: coldSessionId,
      work_id: workId,
      continuation_ref: ref,
    });
    await run(message(21, { body: secret }), context(delivery(21, workId, ref, "owner_answer")));

    expect(calls).toHaveLength(2);
    for (const { args } of calls) {
      expect(args).toContain("--disallowed-tools");
      expect(args[args.indexOf("--disallowed-tools") + 1]).toBe("AskUserQuestion");
    }
    expect(calls[0]!.args).toEqual([
      "claude", "-p", "--disallowed-tools", "AskUserQuestion", "--session-id", coldSessionId,
      "--output-format", "json", expect.any(String),
    ]);
    expect(calls[1]!.args).toEqual([
      "claude", "-p", "--disallowed-tools", "AskUserQuestion", "--resume", coldSessionId,
      expect.any(String),
    ]);
    expect(calls[1]!.env.AP_RUNNER_SESSION_ID).toBe(coldSessionId);
  });
});

describe("codex-sdk per-work continuations (#548)", () => {
  function sdk(workdir: string, factory: () => CodexLike) {
    return createSdkRunner({
      server: "http://agentparty.test",
      token: "ap_test",
      channel: "dev",
      workdir,
      codexFactory: factory,
      post,
    });
  }

  test("keeps ref-keyed A/B slots and resumes B then A after process restart", async () => {
    const workdir = tempDir();
    const runs: Array<{ thread: string; seq: number }> = [];
    const started = ["thread-A", "thread-B"];
    const makeThread = (id: string): ThreadLike => ({
      id,
      run: async (prompt) => {
        runs.push({ thread: id, seq: JSON.parse(prompt).seq as number });
        return { final_response: `answer ${id}` };
      },
    });
    let startIndex = 0;
    const first = sdk(workdir, () => ({
      startThread: () => makeThread(started[startIndex++]!),
      resumeThread: () => { throw new Error("first process must not resume"); },
    }));

    await first(message(31), context(delivery(31, "work-A", "sdk-ref-A")));
    await first(message(32), context(delivery(32, "work-B", "sdk-ref-B", "reply")));

    const resumed: string[] = [];
    const second = sdk(workdir, () => ({
      startThread: () => { throw new Error("owner answer must not cold-start"); },
      resumeThread: (id) => {
        resumed.push(id);
        return makeThread(id);
      },
    }));
    await second(message(33), context(delivery(33, "work-B", "sdk-ref-B", "owner_answer")));
    await second(message(34), context(delivery(34, "work-A", "sdk-ref-A", "owner_answer")));

    expect(resumed).toEqual(["thread-B", "thread-A"]);
    expect(runs).toEqual([
      { thread: "thread-A", seq: 31 },
      { thread: "thread-B", seq: 32 },
      { thread: "thread-B", seq: 33 },
      { thread: "thread-A", seq: 34 },
    ]);
    const states = readdirSync(join(workdir, "continuations"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(workdir, "continuations", name), "utf8")));
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ thread_id: "thread-A", work_id: "work-A", continuation_ref: "sdk-ref-A", wakes: 2 }),
      expect.objectContaining({ thread_id: "thread-B", work_id: "work-B", continuation_ref: "sdk-ref-B", wakes: 2 }),
    ]));
    expect(existsSync(join(workdir, "wake-session.json"))).toBe(false);
  });

  test("refreshes the exact delivery lineage inherited by nested decision asks on owner answers", async () => {
    const workdir = tempDir();
    const workId = "work-sdk-decision";
    const ref = "sdk-decision-ref";
    const source = delivery(35, workId, ref);
    const answer = delivery(36, workId, ref, "owner_answer");
    answer.attempt = 2;
    const clientEnvs: Record<string, string>[] = [];
    const starts: string[] = [];
    const resumes: string[] = [];

    const makeThread = (id: string, env: Record<string, string>): ThreadLike => ({
      id,
      run: async () => {
        const parked = prepareDecisionContinuation({ ...env, CODEX_THREAD_ID: id } as NodeJS.ProcessEnv);
        expect(parked).toMatchObject({
          deliveryId: env.AP_DELIVERY_ID,
          workId,
          continuationRef: ref,
          sessionId: id,
        });
        return { final_response: `handled ${env.AP_DELIVERY_ID}` };
      },
    });
    const exactRun = createSdkRunner({
      server: "http://agentparty.test",
      token: "ap_test",
      channel: "dev",
      workdir,
      codexFactory: (options) => {
        const env = options?.env ?? {};
        clientEnvs.push(env);
        return {
          startThread: () => {
            starts.push(env.AP_DELIVERY_ID ?? "missing");
            return makeThread("thread-sdk-decision", env);
          },
          resumeThread: (id) => {
            resumes.push(env.AP_DELIVERY_ID ?? "missing");
            return makeThread(id, env);
          },
        };
      },
      post,
    });

    await exactRun(message(35), context(source));
    await exactRun(message(36, {
      decision_response: { request_seq: 35, chosen_index: 1, chosen_option: "B" },
    }), context(answer));

    expect(clientEnvs).toHaveLength(2);
    expect(clientEnvs[0]).toMatchObject({
      AP_DELIVERY_ID: source.id,
      AP_WORK_ID: workId,
      AP_CONTINUATION_REF: ref,
      AP_DELIVERY_ATTEMPT: "1",
    });
    expect(clientEnvs[1]).toMatchObject({
      AP_DELIVERY_ID: answer.id,
      AP_WORK_ID: workId,
      AP_CONTINUATION_REF: ref,
      AP_DELIVERY_ATTEMPT: "2",
      AP_RUNNER_SESSION_ID: "thread-sdk-decision",
    });
    expect(starts).toEqual([source.id]);
    expect(resumes).toEqual([answer.id]);
  });

  test("pins child identity and channel worktree into the SDK client and resumed thread", async () => {
    const workdir = tempDir();
    const cwd = tempDir("ap-profile-channel-");
    writeFileSync(join(workdir, "wake-session.json"), JSON.stringify({
      harness: "codex-sdk",
      thread_id: "thread-profile-child",
      created_at: 1,
      last_wake_ts: 1,
      wakes: 1,
    }));
    let clientEnv: Record<string, string> | undefined;
    let resumeOptions: Parameters<CodexLike["resumeThread"]>[1];
    const thread: ThreadLike = {
      id: "thread-profile-child",
      run: async () => ({ final_response: "ok" }),
    };
    const run = createSdkRunner({
      server: "http://agentparty.test",
      token: "ap_child",
      channel: "alpha",
      workdir,
      cwd,
      agentpartyConfigPath: "/safe/alpha-child.json",
      codexFactory: (options) => {
        clientEnv = options?.env;
        return {
          startThread: () => { throw new Error("must resume the durable child session"); },
          resumeThread: (_id, options) => {
            resumeOptions = options;
            return thread;
          },
        };
      },
      post,
    });

    await run(message(40), {
      cmd: "",
      channel: "alpha",
      self: "profile-child",
      contextDir: tempDir("ap-profile-context-"),
      recent: [],
    });

    expect(clientEnv).toMatchObject({
      AGENTPARTY_CONFIG: "/safe/alpha-child.json",
      AGENTPARTY_CHANNEL: "alpha",
      AP_RUNNER_WORKDIR: workdir,
      AP_RUNNER_HARNESS: "codex-sdk",
      AP_RUNNER_SESSION_ID: "thread-profile-child",
    });
    expect(resumeOptions).toEqual({
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
    });
  });

  test("missing and mismatched owner continuations fail non-retriably without startThread", async () => {
    const workdir = tempDir();
    let starts = 0;
    const factory = () => ({
      startThread: () => {
        starts += 1;
        return { id: "thread-X", run: async () => ({ final_response: "ok" }) } satisfies ThreadLike;
      },
      resumeThread: (id: string) => ({ id, run: async () => ({ final_response: "ok" }) } satisfies ThreadLike),
    });
    const run = sdk(workdir, factory);

    const missing = await run(message(40), context(delivery(40, "missing", "sdk-missing", "owner_answer"))).catch((error) => error);
    expect(missing).toBeInstanceOf(WakeBlockedError);
    expect((missing as WakeBlockedError).retriable).toBe(false);
    expect(starts).toBe(0);

    await run(message(41), context(delivery(41, "work-X", "sdk-shared")));
    expect(starts).toBe(1);
    const restarted = sdk(workdir, factory);
    const mismatch = await restarted(message(42), context(delivery(42, "work-Y", "sdk-shared", "owner_answer"))).catch((error) => error);
    expect(mismatch).toBeInstanceOf(WakeBlockedError);
    expect((mismatch as WakeBlockedError).retriable).toBe(false);
    expect(String((mismatch as Error).message)).toContain("mismatch");
    expect(starts).toBe(1);
  });

  test("runServe failing mismatched work B never cleans same-ref work A", async () => {
    const workdir = tempDir();
    const ref = "sdk-runserve-shared-ref";
    const path = continuationPath(workdir, ref);
    writeRunnerContinuation(path, {
      harness: "codex-sdk",
      thread_id: "thread-work-a",
      created_at: 1,
      last_wake_ts: 2,
      wakes: 1,
      work_id: "work-a",
      continuation_ref: ref,
    });
    let starts = 0;
    let resumes = 0;
    const runner = sdk(workdir, () => ({
      startThread: () => {
        starts += 1;
        return { id: "wrong-new-thread", run: async () => ({ final_response: "wrong" }) };
      },
      resumeThread: (id) => {
        resumes += 1;
        return { id, run: async () => ({ final_response: "wrong" }) };
      },
    }));
    const answer = delivery(45, "work-b", ref, "owner_answer");
    const answerMessage = message(45, {
      decision_response: { request_seq: 44, chosen_index: 0, chosen_option: "approve" },
    });
    const updates: string[] = [];
    const server = startMockServer((frame, socket) => {
      if (frame.type === "hello") {
        socket.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
      } else if (frame.type === "serve_lease") {
        socket.send({ type: "serve_lease", name: "me", held: true });
        socket.send({ type: "delivery", delivery: answer, message: answerMessage });
      } else if (frame.type === "delivery_update") {
        updates.push(frame.state);
        socket.send({
          type: "delivery_state",
          request_id: frame.request_id,
          delivery: { ...answer, state: frame.state, last_error: frame.error ?? null, updated_at: Date.now() },
        });
        if (frame.state === "failed") socket.send({ type: "error", code: "archived", message: "done" });
      }
    });
    servers.push(server);

    expect(await runServe({
      server: server.url,
      token: "ap_test",
      channel: "dev",
      since: 0,
      cmd: "",
      mentionsOnly: true,
      allowMultiple: true,
      advertise: async () => {},
      post,
      runCommand: runner,
    })).toBe(EXIT_ARCHIVED);

    expect(updates).toEqual(["failed"]);
    expect(starts).toBe(0);
    expect(resumes).toBe(0);
    expect(readRunnerContinuation(path)).toMatchObject({
      harness: "codex-sdk",
      thread_id: "thread-work-a",
      work_id: "work-a",
      continuation_ref: ref,
    });
  });

  test("SDK timeout preserves and blocks the scoped handle so owner_answer fails without cold-starting", async () => {
    const workdir = tempDir();
    const ref = "sdk-timeout-ref";
    const work = "sdk-timeout-work";
    let aborted = 0;
    const timedOutRunner = sdk(workdir, () => ({
      startThread: () => ({
        id: "thread-timeout",
        run: (_prompt, options) => new Promise((_resolve, reject) => {
          const abort = () => {
            aborted += 1;
            reject(options.signal?.reason);
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        }),
      }),
      resumeThread: () => { throw new Error("initial turn must not resume"); },
    }));
    const item = delivery(50, work, ref);

    const timeout = await runWithRunnerTimeout(
      timedOutRunner,
      message(50),
      context(item),
      10,
    ).catch((error) => error);

    expect(timeout).toBeInstanceOf(RunnerTimeoutError);
    expect((timeout as RunnerTimeoutError).terminationConfirmed).toBe(true);
    expect(aborted).toBe(1);
    const path = continuationPath(workdir, ref);
    expect(readRunnerContinuation(path)).toMatchObject({
      harness: "codex-sdk",
      thread_id: "thread-timeout",
      work_id: work,
      continuation_ref: ref,
      resume_blocked_reason: expect.stringContaining("previous turn outcome unknown"),
    });

    let starts = 0;
    let resumes = 0;
    const restarted = sdk(workdir, () => ({
      startThread: () => {
        starts += 1;
        return { id: "wrong-new-thread", run: async () => ({ final_response: "wrong" }) };
      },
      resumeThread: (id) => {
        resumes += 1;
        return { id, run: async () => ({ final_response: "wrong" }) };
      },
    }));
    const answer = delivery(51, work, ref, "owner_answer");
    const answerMessage = message(51, {
      decision_response: { request_seq: 50, chosen_index: 0, chosen_option: "approve" },
    });
    const updates: Array<{ state?: string; error?: string }> = [];
    const server = startMockServer((frame, socket) => {
      if (frame.type === "hello") {
        socket.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "serve_lease") {
        socket.send({ type: "serve_lease", name: "me", held: true });
        socket.send({ type: "delivery", delivery: answer, message: answerMessage });
        return;
      }
      if (frame.type === "delivery_update") {
        updates.push(frame);
        socket.send({
          type: "delivery_state",
          request_id: frame.request_id,
          delivery: {
            ...answer,
            state: frame.state,
            last_error: frame.error ?? null,
            updated_at: Date.now(),
          },
        });
        if (frame.state === "failed") {
          socket.send({ type: "error", code: "archived", message: "done" });
        }
      }
    });
    servers.push(server);

    const code = await runServe({
      server: server.url,
      token: "ap_test",
      channel: "dev",
      since: 0,
      cmd: "",
      mentionsOnly: true,
      allowMultiple: true,
      advertise: async () => {},
      post,
      runCommand: restarted,
    });

    expect(code).toBe(EXIT_ARCHIVED);
    // Continuation validation is a model-free preflight. A blocked owner answer fails directly
    // from claimed without ever manufacturing a `running`/unknown-model state.
    expect(updates.map(({ state }) => state)).toEqual(["failed"]);
    expect(updates[0]?.error).toContain("resume blocked");
    expect(starts).toBe(0);
    expect(resumes).toBe(0);
  });

  test("SDK success and error finalizers preserve a concurrent decision block", async () => {
    for (const outcome of ["success", "error"] as const) {
      const workdir = tempDir();
      const ref = `sdk-stale-${outcome}`;
      const workId = `work-sdk-${outcome}`;
      const path = continuationPath(workdir, ref);
      const run = sdk(workdir, () => ({
        startThread: () => ({
          id: `thread-${outcome}`,
          run: async () => {
            blockRunnerContinuation(path, `blocked-${outcome}`, 456);
            if (outcome === "error") throw new Error("model failed after parking");
            return { final_response: "parked" };
          },
        }),
        resumeThread: () => { throw new Error("must cold start"); },
      }));
      const error = await run(message(60), context(delivery(60, workId, ref))).catch((cause) => cause);
      if (outcome === "error") expect(error).toBeInstanceOf(WakeBlockedError);
      else expect(error).toBeUndefined();
      expect(readRunnerContinuation(path)).toMatchObject({
        thread_id: `thread-${outcome}`,
        work_id: workId,
        continuation_ref: ref,
        resume_blocked_reason: `blocked-${outcome}`,
        resume_blocked_at: 456,
      });
    }
  });
});

describe("continuation transaction lock", () => {
  test("keeps the continuation directory private and the SQLite mutex owner-only", () => {
    const workdir = tempDir();
    const path = continuationPath(workdir, "private-lock");
    withRunnerContinuationLock(path, () => {});
    expect(statSync(join(workdir, "continuations")).mode & 0o777).toBe(0o700);
    expect(statSync(join(workdir, "continuations", ".continuation-lock.sqlite")).mode & 0o777).toBe(0o600);
  });

  test("deletes terminal per-work mappings under the shared lock and remains idempotent", () => {
    const workdir = tempDir();
    const path = continuationPath(workdir, "terminal-work");
    const identity = {
      harness: "codex",
      work_id: "terminal-work-id",
      continuation_ref: "terminal-work",
    } as const;
    writeRunnerContinuation(path, {
      ...identity,
      session_id: "terminal-session",
      created_at: 1,
      last_wake_ts: 2,
      wakes: 1,
    });

    expect(deleteRunnerContinuation(path, identity)).toBe("deleted");
    expect(existsSync(path)).toBe(false);
    expect(readRunnerContinuation(path)).toBeNull();
    expect(deleteRunnerContinuation(path, identity)).toBe("missing");
    expect(existsSync(join(workdir, "continuations", ".continuation-lock.sqlite"))).toBe(true);
  });

  test("terminal cleanup preserves a same-ref mapping owned by another work", () => {
    const workdir = tempDir();
    const path = continuationPath(workdir, "shared-ref");
    writeRunnerContinuation(path, {
      harness: "codex",
      session_id: "work-a-session",
      created_at: 1,
      last_wake_ts: 2,
      wakes: 1,
      work_id: "work-a",
      continuation_ref: "shared-ref",
    });

    expect(deleteRunnerContinuation(path, {
      harness: "codex",
      work_id: "work-b",
      continuation_ref: "shared-ref",
    })).toBe("mismatch");
    expect(readRunnerContinuation(path)).toMatchObject({
      session_id: "work-a-session",
      work_id: "work-a",
      continuation_ref: "shared-ref",
    });
  });

  test("builtin and SDK terminal hooks release their exact continuation files", async () => {
    const cases = [
      {
        harness: "codex" as const,
        runner: (workdir: string) => createBuiltinRunner({
          server: "https://party.test",
          token: "ap_test",
          channel: "dev",
          harness: "codex",
          workdir,
        }),
        state: (ref: string) => ({
          harness: "codex" as const,
          session_id: "builtin-session",
          created_at: 1,
          last_wake_ts: 2,
          wakes: 1,
          work_id: "terminal-work-id",
          continuation_ref: ref,
        }),
      },
      {
        harness: "codex-sdk" as const,
        runner: (workdir: string) => createSdkRunner({
          server: "https://party.test",
          token: "ap_test",
          channel: "dev",
          workdir,
        }),
        state: (ref: string) => ({
          harness: "codex-sdk" as const,
          thread_id: "sdk-thread",
          created_at: 1,
          last_wake_ts: 2,
          wakes: 1,
          work_id: "terminal-work-id",
          continuation_ref: ref,
        }),
      },
    ];

    for (const testCase of cases) {
      const workdir = tempDir(`ap-${testCase.harness}-terminal-`);
      const ref = `${testCase.harness}-terminal-ref`;
      const path = continuationPath(workdir, ref);
      writeRunnerContinuation(path, testCase.state(ref));
      const runner = testCase.runner(workdir);
      await runner.onDeliveryTerminal?.(delivery(89, "different-work", ref), "failed");
      expect(readRunnerContinuation(path)).toMatchObject({
        work_id: "terminal-work-id",
        continuation_ref: ref,
      });
      await runner.onDeliveryTerminal?.(delivery(90, "terminal-work-id", ref), "replied");
      expect(existsSync(path)).toBe(false);
    }
  });

  test("block-before-merge and merge-before-block both preserve the monotonic block", () => {
    for (const order of ["block-first", "merge-first"] as const) {
      const path = continuationPath(tempDir(), order);
      const base = {
        harness: "codex" as const,
        session_id: "same-session",
        created_at: 1,
        last_wake_ts: 1,
        wakes: 0,
        work_id: "same-work",
        continuation_ref: order,
      };
      writeRunnerContinuation(path, base);
      if (order === "block-first") blockRunnerContinuation(path, "blocked", 10);
      mergeRunnerContinuation(path, { ...base, last_wake_ts: 2, wakes: 1 });
      if (order === "merge-first") blockRunnerContinuation(path, "blocked", 10);
      expect(readRunnerContinuation(path)).toMatchObject({
        wakes: 1,
        resume_blocked_reason: "blocked",
        resume_blocked_at: 10,
      });
    }
  });

  test("block waits on the same cross-process transaction lock", async () => {
    const workdir = tempDir();
    const path = continuationPath(workdir, "contended");
    const ready = join(workdir, "lock-ready");
    writeRunnerContinuation(path, {
      harness: "codex",
      session_id: "same-session",
      created_at: 1,
      last_wake_ts: 1,
      wakes: 0,
      work_id: "same-work",
      continuation_ref: "contended",
    });
    const modulePath = new URL("../src/continuation.ts", import.meta.url).pathname;
    const holder = trackProcess(Bun.spawn(["bun", "-e", `
      import { withRunnerContinuationLock } from ${JSON.stringify(modulePath)};
      import { writeFileSync } from "node:fs";
      withRunnerContinuationLock(${JSON.stringify(path)}, () => {
        writeFileSync(${JSON.stringify(ready)}, "ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      });
    `], { stdout: "pipe", stderr: "pipe" }));
    // A cold Bun child must transpile/import continuation.ts before it can acquire the lock. Under
    // a parallel suite that startup exceeded the old 500ms readiness budget even though no SQLite
    // timeout occurred. Keep readiness aligned with the production 5s lock budget; this does not
    // change or relax CONTINUATION_LOCK_WAIT_MS itself.
    for (let i = 0; i < 1_000 && !existsSync(ready); i++) await Bun.sleep(5);
    expect(existsSync(ready)).toBe(true);
    const started = Date.now();
    expect(blockRunnerContinuation(path, "contended-block", 20)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(await holder.exited).toBe(0);
    mergeRunnerContinuation(path, {
      harness: "codex",
      session_id: "same-session",
      created_at: 1,
      last_wake_ts: 3,
      wakes: 1,
      work_id: "same-work",
      continuation_ref: "contended",
    });
    expect(readRunnerContinuation(path)?.resume_blocked_reason).toBe("contended-block");
  });

  test("two simultaneous processes serialize their continuation critical sections", async () => {
    const workdir = tempDir();
    const path = continuationPath(workdir, "two-reclaimers");
    const start = join(workdir, "start");
    const active = join(workdir, "active");
    const overlap = join(workdir, "overlap");
    const done = join(workdir, "done");
    const modulePath = new URL("../src/continuation.ts", import.meta.url).pathname;

    const children = ["a", "b"].map((id) => trackProcess(Bun.spawn(["bun", "-e", `
      import { withRunnerContinuationLock } from ${JSON.stringify(modulePath)};
      import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      writeFileSync(${JSON.stringify(join(workdir, "ready-"))} + ${JSON.stringify(id)}, "ready");
      while (!existsSync(${JSON.stringify(start)})) Atomics.wait(sleep, 0, 0, 2);
      withRunnerContinuationLock(${JSON.stringify(path)}, () => {
        let ownsGuard = false;
        try {
          writeFileSync(${JSON.stringify(active)}, ${JSON.stringify(id)}, { flag: "wx" });
          ownsGuard = true;
        } catch {
          appendFileSync(${JSON.stringify(overlap)}, ${JSON.stringify(id)} + "\\n");
        }
        Atomics.wait(sleep, 0, 0, 100);
        if (ownsGuard) rmSync(${JSON.stringify(active)}, { force: true });
        appendFileSync(${JSON.stringify(done)}, ${JSON.stringify(id)} + "\\n");
      });
    `], { stdout: "pipe", stderr: "pipe" })));
    for (let i = 0; i < 200; i++) {
      if (existsSync(join(workdir, "ready-a")) && existsSync(join(workdir, "ready-b"))) break;
      await Bun.sleep(5);
    }
    expect(existsSync(join(workdir, "ready-a"))).toBe(true);
    expect(existsSync(join(workdir, "ready-b"))).toBe(true);
    writeFileSync(start, "go");

    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    expect(existsSync(overlap)).toBe(false);
    expect(readFileSync(done, "utf8").trim().split("\n").sort()).toEqual(["a", "b"]);
  });

  test("SIGKILL releases the OS-managed transaction lock immediately", async () => {
    const workdir = tempDir();
    const path = continuationPath(workdir, "killed-holder");
    const ready = join(workdir, "killed-holder-ready");
    const modulePath = new URL("../src/continuation.ts", import.meta.url).pathname;
    const holder = trackProcess(Bun.spawn(["bun", "-e", `
      import { withRunnerContinuationLock } from ${JSON.stringify(modulePath)};
      import { writeFileSync } from "node:fs";
      withRunnerContinuationLock(${JSON.stringify(path)}, () => {
        writeFileSync(${JSON.stringify(ready)}, "ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
      });
    `], { stdout: "pipe", stderr: "pipe" }));
    for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(5);
    expect(existsSync(ready)).toBe(true);
    holder.kill("SIGKILL");
    await holder.exited;

    let entered = false;
    const started = Date.now();
    expect(() => withRunnerContinuationLock(path, () => { entered = true; }, 1_000)).not.toThrow();
    expect(entered).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("a live holder times out the waiter without entering its critical section", async () => {
    const workdir = tempDir();
    const path = continuationPath(workdir, "live-holder");
    const ready = join(workdir, "live-holder-ready");
    const modulePath = new URL("../src/continuation.ts", import.meta.url).pathname;
    const holder = trackProcess(Bun.spawn(["bun", "-e", `
      import { withRunnerContinuationLock } from ${JSON.stringify(modulePath)};
      import { writeFileSync } from "node:fs";
      withRunnerContinuationLock(${JSON.stringify(path)}, () => {
        writeFileSync(${JSON.stringify(ready)}, "ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      });
    `], { stdout: "pipe", stderr: "pipe" }));
    for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(5);
    expect(existsSync(ready)).toBe(true);

    let entered = false;
    expect(() => withRunnerContinuationLock(path, () => { entered = true; }, 50)).toThrow("timed out");
    expect(entered).toBe(false);
    expect(await holder.exited).toBe(0);
    expect(() => withRunnerContinuationLock(path, () => { entered = true; }, 500)).not.toThrow();
    expect(entered).toBe(true);
  });
});

test("wake context carries decision_request and decision_response frames", () => {
  const dir = tempDir("ap-decision-context-");
  const request = message(50, {
    decision_request: { kind: "choice", prompt: "which?", options: ["A", "B"] },
  });
  const response = message(51, {
    decision_response: { request_seq: 50, chosen_index: 1, chosen_option: "B" },
  });
  const requestBody = JSON.parse(readFileSync(writeContextFile(dir, request, "dev", "me", []), "utf8"));
  const responseBody = JSON.parse(readFileSync(writeContextFile(dir, response, "dev", "me", []), "utf8"));

  expect(requestBody.decision_request).toEqual(request.decision_request);
  expect(requestBody.decision_response).toBeNull();
  expect(responseBody.decision_request).toBeNull();
  expect(responseBody.decision_response).toEqual(response.decision_response);
});
