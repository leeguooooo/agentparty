import { afterEach, describe, expect, test } from "bun:test";
import type { DirectedDelivery, MsgFrame } from "@agentparty/shared";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter as pathDelimiter, join } from "node:path";
import type { Connection } from "../src/client";
import {
  buildCodexChildEnv,
  parseCodexVersion,
  resolveCodexBinary,
  resolveCodexLaunch,
  run as runBridge,
  supportsCodexSessionBridge,
  type CodexCapabilityProbe,
} from "../src/commands/bridge";
import {
  CodexFrontendLifecycleQueue,
  CodexFrontendRecoveryQueue,
  buildCodexTuiArgs,
  buildCodexTuiResumeArgs,
  buildCodexTuiResumeWithPromptArgs,
  resolveCodexRecoveryThreadId,
  runCodexSessionBridge,
  superviseCodexTui,
  terminateBridgeChild,
  type BridgeChildProcess,
  type CodexBridgeTerminalResult,
  type CodexBridgeRuntimeOptions,
} from "../src/commands/codex-bridge";
import {
  DeliveryRecoveryJournal,
  deliveryRecoveryJournalPath,
} from "../src/delivery-recovery-journal";

const supported: CodexCapabilityProbe = {
  version: "codex-cli 0.144.4",
  rootHelp: "--remote <ADDR> ws://host unix://PATH",
  appServerHelp: "--listen <URL> --stdio",
};

const mockCodexFixture = join(import.meta.dir, "fixtures", "mock-codex-app-server.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "agentparty-codex-command-"));
  tempDirs.push(path);
  return path;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function controlledBridgeChild(options: {
  exitOnSignal?: boolean;
  events?: string[];
  label?: string;
} = {}): BridgeChildProcess & {
  resolveExit(code: number): void;
  signals: Array<number | NodeJS.Signals | undefined>;
} {
  const exit = deferred<number>();
  const signals: Array<number | NodeJS.Signals | undefined> = [];
  return {
    exited: exit.promise,
    signals,
    resolveExit: exit.resolve,
    kill(signal) {
      signals.push(signal);
      options.events?.push(`kill:${options.label ?? "child"}:${String(signal)}`);
      if (options.exitOnSignal !== false) exit.resolve(signal === "SIGKILL" ? 137 : 143);
    },
  };
}

function terminalControl(): {
  run: Promise<CodexBridgeTerminalResult>;
  now: () => CodexBridgeTerminalResult | null;
  finish: (result: CodexBridgeTerminalResult) => void;
} {
  const terminal = deferred<CodexBridgeTerminalResult>();
  let settled: CodexBridgeTerminalResult | null = null;
  return {
    run: terminal.promise,
    now: () => settled,
    finish(result) {
      settled = result;
      terminal.resolve(result);
    },
  };
}

function recordCodexRecoveryDebt(
  journal: DeliveryRecoveryJournal,
  index: number,
  threadId: string,
): void {
  const now = Date.now();
  const delivery: DirectedDelivery = {
    id: `delivery-runtime-${index}`,
    message_seq: 700 + index,
    target_name: "front",
    cause: "mention",
    state: "claimed",
    attempt: 1,
    lease_epoch: 1,
    lease_token: `lease-${index}`,
    lease_until: now + 90_000,
    work_id: `work-${index}`,
    continuation_ref: `continuation-${index}`,
    reply_seq: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  const message: MsgFrame = {
    type: "msg",
    seq: delivery.message_seq,
    sender: { name: "owner", kind: "human" },
    kind: "message",
    body: `@front recover ${index}`,
    mentions: ["front"],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: now,
  };
  journal.recordClaim(delivery, message);
  journal.update(delivery.id, {
    phase: "harness_issued",
    threadId,
    delivery: { ...delivery, state: "running" },
  });
}

function dormantConnection(): Connection {
  let closeFrames!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeFrames = resolve;
  });
  return {
    frames: (async function* () {
      await closed;
    })(),
    send: () => true,
    ack: () => {},
    close: closeFrames,
    pendingFrames: () => [],
    replayUnacked: () => 0,
    cursor: 0,
    revCursor: 0,
  };
}

describe("party bridge codex capability and argv boundary", () => {
  test("requires the app-server stdio and Unix-remote capabilities", () => {
    expect(parseCodexVersion("codex-cli 0.144.4")).toEqual([0, 144, 4]);
    expect(parseCodexVersion("codex 0.146.0-alpha.3")).toEqual([0, 146, 0]);
    expect(parseCodexVersion("unknown")).toBeNull();
    expect(supportsCodexSessionBridge(supported)).toBe(true);
    expect(supportsCodexSessionBridge({ ...supported, version: "codex-cli 0.143.9" })).toBe(false);
    expect(supportsCodexSessionBridge({ ...supported, rootHelp: "--remote ws://host" })).toBe(false);
    expect(supportsCodexSessionBridge({ ...supported, appServerHelp: "--listen stdio://" })).toBe(false);
    expect(resolveCodexBinary(process.execPath)).toBe(realpathSync(process.execPath));
  });

  test("the bridge owns --remote and passes other Codex flags after --", async () => {
    const calls: CodexBridgeRuntimeOptions[] = [];
    let probed:
      | { codexBinary: string; options: { cwd: string; env: NodeJS.ProcessEnv } }
      | undefined;
    const code = await runBridge(
      ["codex", "dev", "--", "--model", "gpt-5.4", "--no-alt-screen"],
      {
        probeCodexCapabilities: async (codexBinary, options) => {
          probed = { codexBinary, options };
          return supported;
        },
        codexBinary: process.execPath,
        cwd: "/workspace",
        env: { PATH: "/bin" },
        runCodexBridge: async (options) => {
          calls.push(options);
          return 17;
        },
      },
    );
    expect(code).toBe(17);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      channel: "dev",
      codexBinary: realpathSync(process.execPath),
      codexArgs: ["--model", "gpt-5.4", "--no-alt-screen"],
      cwd: "/workspace",
    });
    expect(probed?.codexBinary).toBe(calls[0]?.codexBinary);
    expect(probed?.options.cwd).toBe(calls[0]?.cwd);
    expect(probed?.options.env).toBe(calls[0]?.env);
    const childPath = calls[0]?.env?.PATH?.split(pathDelimiter) ?? [];
    expect(childPath).toContain("/bin");
    expect(childPath).toContain(join(homedir(), ".local/bin"));
    expect(childPath).toContain(join(homedir(), ".npm-global/bin"));
    expect(childPath).toContain("/opt/homebrew/bin");
    expect(childPath).toContain("/usr/local/bin");
    expect(childPath).toContain("/Applications/Codex.app/Contents/Resources");
    expect(childPath).toContain("/Applications/ChatGPT.app/Contents/Resources");
    expect(buildCodexTuiArgs("/tmp/private.sock", ["--model", "gpt-5.4"])).toEqual([
      "--remote",
      "unix:///tmp/private.sock",
      "--model",
      "gpt-5.4",
    ]);
    expect(buildCodexTuiResumeArgs("/tmp/private.sock", "thread-recovered")).toEqual([
      "resume",
      "--remote",
      "unix:///tmp/private.sock",
      "thread-recovered",
    ]);
    expect(buildCodexTuiResumeArgs(
      "/tmp/private.sock",
      "thread-recovered",
      [
        "--model",
        "gpt-5.4",
        "-m=gpt-5.4-mini",
        "--profile=work",
        "-p=fast",
        "--sandbox",
        "read-only",
        "-s=workspace-write",
        "--ask-for-approval",
        "never",
        "-a=on-request",
        "--cd",
        "/workspace",
        "-C=/workspace/short",
        "--add-dir",
        "/shared",
        "--search",
        "--no-alt-screen",
        "--image",
        "/tmp/initial.png",
        "original positional prompt",
      ],
    )).toEqual([
      "resume",
      "--remote",
      "unix:///tmp/private.sock",
      "--model",
      "gpt-5.4",
      "-m=gpt-5.4-mini",
      "--profile=work",
      "-p=fast",
      "--sandbox",
      "read-only",
      "-s=workspace-write",
      "--ask-for-approval",
      "never",
      "-a=on-request",
      "--cd",
      "/workspace",
      "-C=/workspace/short",
      "--add-dir",
      "/shared",
      "--search",
      "--no-alt-screen",
      "thread-recovered",
    ]);
    expect(buildCodexTuiResumeWithPromptArgs(
      "/tmp/private.sock",
      "thread-recovered",
      ["-i", "/tmp/one.png", "/tmp/two.png", "--", "multi-image prompt"],
    )).toEqual([
      "resume",
      "--remote",
      "unix:///tmp/private.sock",
      "-i",
      "/tmp/one.png",
      "/tmp/two.png",
      "--",
      "thread-recovered",
      "multi-image prompt",
    ]);
    expect(buildCodexTuiResumeWithPromptArgs(
      "/tmp/private.sock",
      "thread-recovered",
      ["--model", "gpt-5.4", "--image", "/tmp/initial.png", "original prompt"],
      [{
        type: "text",
        text: "WIRE_PROMPT_746",
        text_elements: [],
      }],
    )).toEqual([
      "resume",
      "--remote",
      "unix:///tmp/private.sock",
      "--model",
      "gpt-5.4",
      "thread-recovered",
      "WIRE_PROMPT_746",
    ]);
    expect(buildCodexTuiResumeArgs(
      "/tmp/private.sock",
      "thread-recovered",
      ["-i", "/tmp/one.png", "/tmp/two.png", "--", "multi-image prompt"],
    )).toEqual([
      "resume",
      "--remote",
      "unix:///tmp/private.sock",
      "thread-recovered",
    ]);
    expect(buildCodexTuiResumeWithPromptArgs(
      "/tmp/private.sock",
      "thread-recovered",
      [
        "--model",
        "gpt-5.4",
        "-i",
        "/tmp/old-one.png",
        "/tmp/old-two.png",
        "--",
        "old prompt",
      ],
      [
        { type: "localImage", path: "/tmp/one.png" },
        { type: "localImage", path: "/tmp/two.png" },
        { type: "text", text: "multi-image prompt", text_elements: [] },
      ],
    )).toEqual([
      "resume",
      "--remote",
      "unix:///tmp/private.sock",
      "--model",
      "gpt-5.4",
      "--image",
      "/tmp/one.png",
      "--image",
      "/tmp/two.png",
      "--",
      "thread-recovered",
      "multi-image prompt",
    ]);
    expect(resolveCodexRecoveryThreadId([])).toBeNull();
    expect(resolveCodexRecoveryThreadId([
      { threadId: null },
      { threadId: "thread-recovered" },
      { threadId: "thread-recovered" },
    ])).toBe("thread-recovered");
    expect(() => resolveCodexRecoveryThreadId([
      { threadId: "thread-one" },
      { threadId: "thread-two" },
    ])).toThrow("spans multiple threads");
  });

  test("frontend recovery queue deduplicates generations and retains the newest restart", async () => {
    const queue = new CodexFrontendRecoveryQueue();
    const first = queue.next();
    queue.push({ disposition: "resume", threadId: "thread-one", generation: 2 });
    expect(await first).toEqual({
      disposition: "resume",
      threadId: "thread-one",
      generation: 2,
    });

    queue.push({ disposition: "resume", threadId: "stale-duplicate", generation: 2 });
    queue.push({ disposition: "resume", threadId: "thread-newest", generation: 3 });
    expect(await queue.next()).toEqual({
      disposition: "resume",
      threadId: "thread-newest",
      generation: 3,
    });
  });

  test("rejects an alternate remote endpoint instead of creating a second writer", async () => {
    let launched = false;
    const code = await runBridge(
      ["codex", "dev", "--", "--remote", "unix:///tmp/other.sock"],
      {
        probeCodexCapabilities: async () => supported,
        runCodexBridge: async () => {
          launched = true;
          return 0;
        },
      },
    );
    expect(code).toBe(1);
    expect(launched).toBe(false);
  });

  test("fails closed when the installed Codex lacks the bridge protocol", async () => {
    let launched = false;
    const code = await runBridge(["codex", "dev"], {
      probeCodexCapabilities: async () => ({
        version: "codex-cli 0.143.0",
        rootHelp: "",
        appServerHelp: "",
      }),
      codexBinary: process.execPath,
      runCodexBridge: async () => {
        launched = true;
        return 0;
      },
    });
    expect(code).toBe(1);
    expect(launched).toBe(false);
  });

  test("resolves Codex against the final child PATH and cwd", () => {
    const root = tempDir();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const codex = join(bin, "codex");
    writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    expect(resolveCodexBinary(undefined, { PATH: "bin" }, root)).toBe(realpathSync(codex));
    const env = buildCodexChildEnv({ PATH: "bin" });
    expect(env.PATH?.split(pathDelimiter)).toEqual(expect.arrayContaining([
      "bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]));
  });

  test("honors AGENTPARTY_CODEX_BIN under a minimized GUI/launchd PATH", () => {
    const root = tempDir();
    const bin = join(root, "private-bin");
    mkdirSync(bin);
    const codex = join(bin, "codex");
    writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const launch = resolveCodexLaunch(undefined, {
      PATH: "/usr/bin:/bin",
      AGENTPARTY_CODEX_BIN: codex,
    }, root);
    expect(launch.ok).toBe(true);
    if (launch.ok) {
      expect(launch.codexBinary).toBe(realpathSync(codex));
      expect(launch.env.PATH?.split(pathDelimiter)[0]).toBe(bin);
      expect(launch.env.PATH?.split(pathDelimiter)).toContain(
        "/Applications/ChatGPT.app/Contents/Resources",
      );
    }
  });

  test("makes an env-node shim runnable on the same child PATH or fails fast", () => {
    const root = tempDir();
    const bin = join(root, "custom-bin");
    mkdirSync(bin);
    const codex = join(bin, "codex");
    const node = join(bin, "node");
    writeFileSync(codex, "#!/usr/bin/env node\n", { mode: 0o755 });
    writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const runnable = resolveCodexLaunch(codex, { PATH: "/bin" }, root);
    expect(runnable.ok).toBe(true);
    if (runnable.ok) {
      expect(runnable.env.PATH?.split(pathDelimiter)[0]).toBe(bin);
    }

    const broken = join(bin, "broken-codex");
    writeFileSync(broken, "#!/usr/bin/env agentparty-missing-runtime\n", { mode: 0o755 });
    const missing = resolveCodexLaunch(broken, { PATH: "/bin" }, root);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("agentparty-missing-runtime is not executable");
  });
});

describe("party bridge codex process lifecycle", () => {
  test("SIGINT and SIGTERM abort authentication startup instead of being swallowed", async () => {
    for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      let handler: ((received: "SIGINT" | "SIGTERM") => void) | undefined;
      let removed = false;
      let markAuthStarted!: () => void;
      const authStarted = new Promise<void>((resolve) => {
        markAuthStarted = resolve;
      });
      const result = runCodexSessionBridge(
        {
          channel: "dev",
          codexBinary: realpathSync(process.execPath),
          cwd: "/workspace",
          env: { PATH: "/bin" },
        },
        {
          installSignalHandlers: (installed) => {
            handler = installed;
            return () => {
              removed = true;
            };
          },
          resolveAuth: async () => {
            markAuthStarted();
            return await new Promise<never>(() => {});
          },
          runtimeDir: () => {
            throw new Error("runtime directory must not be created after startup abort");
          },
          terminationGraceMs: 0,
          killWaitMs: 0,
          log: () => {},
        },
      );
      await authStarted;
      handler?.(signal);
      expect(await result).toBe(expectedCode);
      expect(removed).toBe(true);
    }
  });

  test("runtime cold start follows the journal's exact thread affinity and rejects conflicts", async () => {
    const previousAgentPartyHome = process.env.AGENTPARTY_HOME;
    const runWithThreads = async (threadIds: string[]) => {
      const root = tempDir();
      process.env.AGENTPARTY_HOME = root;
      const server = "https://runtime-recovery.example";
      const token = "ap_runtime_recovery";
      const journal = new DeliveryRecoveryJournal(
        deliveryRecoveryJournalPath("codex", server, token, "dev"),
        "dev",
        "codex",
      );
      threadIds.forEach((threadId, index) => {
        recordCodexRecoveryDebt(journal, index, threadId);
      });
      const runtimePath = join(root, "runtime");
      const statePath = join(root, "mock-state.json");
      if (threadIds.length === 1) {
        writeFileSync(statePath, JSON.stringify({
          threadId: threadIds[0],
          turns: [],
          nextTurn: 1,
          generations: 0,
        }));
      }
      const launches: string[][] = [];
      let requestsAtConnect: string[] = [];
      let appServerSpawns = 0;
      const result = await runCodexSessionBridge(
        {
          channel: "dev",
          codexBinary: process.execPath,
          codexArgs: [
            "--model",
            "gpt-5.4",
            "--image",
            "/tmp/input.png",
            "do not replay this prompt",
          ],
          cwd: root,
          env: { ...process.env },
        },
        {
          resolveAuth: async () => ({
            server,
            token,
            auth_source: "runtime_config",
            config: { kind: "none", path: null },
            account: { present: false, path: join(root, "account.json") },
          }),
          spawnAppServer: () => {
            appServerSpawns += 1;
            return spawn(process.execPath, ["run", mockCodexFixture], {
              stdio: ["pipe", "pipe", "pipe"],
              env: { ...process.env, MOCK_CODEX_STATE_PATH: statePath },
            });
          },
          connectAgentParty: () => {
            const state = JSON.parse(readFileSync(statePath, "utf8")) as {
              requests?: string[];
            };
            requestsAtConnect = state.requests ?? [];
            return dormantConnection();
          },
          runtimeDir: () => {
            mkdirSync(runtimePath);
            return runtimePath;
          },
          launchTui: (_binary, args) => {
            launches.push(args);
            return {
              exited: Promise.resolve(0),
              kill: () => {},
            };
          },
          installSignalHandlers: () => () => {},
          terminationGraceMs: 0,
          killWaitMs: 0,
          log: () => {},
        },
      );
      return {
        appServerSpawns,
        launches,
        requestsAtConnect,
        result,
        runtimePath,
        statePath,
      };
    };

    try {
      const empty = await runWithThreads([]);
      expect(empty.result).toBe(0);
      expect(empty.appServerSpawns).toBe(1);
      expect(empty.launches).toEqual([[
        "--remote",
        `unix://${join(empty.runtimePath, "codex.sock")}`,
        "--model",
        "gpt-5.4",
        "--image",
        "/tmp/input.png",
        "do not replay this prompt",
      ]]);

      const exact = await runWithThreads(["thread-journal"]);
      expect(exact.result).toBe(0);
      expect(exact.appServerSpawns).toBe(1);
      expect(exact.launches).toEqual([[
        "resume",
        "--remote",
        `unix://${join(exact.runtimePath, "codex.sock")}`,
        "--model",
        "gpt-5.4",
        "thread-journal",
      ]]);
      const exactState = JSON.parse(readFileSync(exact.statePath, "utf8")) as {
        requests?: string[];
      };
      expect(exactState.requests).toEqual(expect.arrayContaining([
        "thread/resume",
        "thread/read",
      ]));
      expect(exactState.requests!.indexOf("thread/resume")).toBeLessThan(
        exactState.requests!.indexOf("thread/read"),
      );
      expect(exact.requestsAtConnect).toEqual(expect.arrayContaining([
        "thread/resume",
        "thread/read",
      ]));

      const conflicting = await runWithThreads(["thread-one", "thread-two"]);
      expect(conflicting.result).toBe(1);
      expect(conflicting.appServerSpawns).toBe(0);
      expect(conflicting.launches).toEqual([]);
    } finally {
      if (previousAgentPartyHome === undefined) {
        delete process.env.AGENTPARTY_HOME;
      } else {
        process.env.AGENTPARTY_HOME = previousAgentPartyHome;
      }
    }
  }, 15_000);

  test("child shutdown escalates from SIGTERM to SIGKILL with bounded waits", async () => {
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    expect(await terminateBridgeChild(
      {
        exited,
        kill: (signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") finish(137);
        },
      },
      0,
      0,
      async () => {},
    )).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("child shutdown reports failure when SIGKILL cannot confirm process exit", async () => {
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    expect(await terminateBridgeChild(
      {
        exited: new Promise<number>(() => {}),
        kill: (signal) => signals.push(signal),
      },
      0,
      0,
      async () => {},
    )).toBe(false);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("supervisor treats the old TUI exit as expected and resumes only after detach", async () => {
    const lifecycle = new CodexFrontendLifecycleQueue();
    const terminal = terminalControl();
    const events: string[] = [];
    const launches: Array<{ args: string[]; child: ReturnType<typeof controlledBridgeChild> }> = [];
    const result = superviseCodexTui({
      channel: "dev",
      codexBinary: "codex",
      codexArgs: ["--model", "gpt-5.4", "do not replay me"],
      socketPath: "/tmp/codex.sock",
      cwd: "/workspace",
      env: {},
      lifecycle,
      proxy: {
        quiesceFrontend: () => {
          events.push("quiesce");
          return true;
        },
      },
      launchTui: (_binary, args) => {
        const label = `tui-${launches.length + 1}`;
        events.push(`launch:${label}`);
        const child = controlledBridgeChild({ events, label });
        launches.push({ args, child });
        return child;
      },
      terminalRun: terminal.run,
      terminalNow: terminal.now,
      terminationGraceMs: 0,
      killWaitMs: 0,
      log: () => {},
    });

    await waitFor(() => launches.length === 1, "initial TUI was not launched");
    lifecycle.reset({ disconnectedGeneration: 1, threadId: "thread-exact" });
    // The process may observe its closed backend and exit before the reset
    // promise wins. That exit is expected inside this recovery window.
    launches[0]!.child.resolveExit(1);
    lifecycle.recovered({
      disposition: "resume",
      threadId: "thread-exact",
      generation: 2,
    });
    await waitFor(() => launches.length === 2, "replacement TUI was not launched");

    expect(events.indexOf("quiesce")).toBeGreaterThan(events.indexOf("launch:tui-1"));
    expect(events.indexOf("launch:tui-2")).toBeGreaterThan(events.indexOf("quiesce"));
    expect(launches[1]!.args).toEqual([
      "resume",
      "--remote",
      "unix:///tmp/codex.sock",
      "--model",
      "gpt-5.4",
      "thread-exact",
    ]);

    terminal.finish({ source: "delivery", code: 0 });
    expect(await result).toBe(0);
  });

  test("supervisor cold-starts on the journal's exact thread without replaying argv input", async () => {
    const lifecycle = new CodexFrontendLifecycleQueue();
    const terminal = terminalControl();
    const launches: string[][] = [];
    const result = superviseCodexTui({
      channel: "dev",
      codexBinary: "codex",
      codexArgs: ["--model", "gpt-5.4", "--image", "/tmp/input.png", "do not replay"],
      initialThreadId: "thread-journal",
      socketPath: "/tmp/codex.sock",
      cwd: "/workspace",
      env: {},
      lifecycle,
      proxy: { quiesceFrontend: () => true },
      launchTui: (_binary, args) => {
        launches.push(args);
        return controlledBridgeChild();
      },
      terminalRun: terminal.run,
      terminalNow: terminal.now,
      terminationGraceMs: 0,
      killWaitMs: 0,
      log: () => {},
    });

    await waitFor(() => launches.length === 1, "journal-affine TUI was not launched");
    expect(launches[0]).toEqual([
      "resume",
      "--remote",
      "unix:///tmp/codex.sock",
      "--model",
      "gpt-5.4",
      "thread-journal",
    ]);
    terminal.finish({ source: "delivery", code: 0 });
    expect(await result).toBe(0);
  });

  test("supervisor rechecks the newest reset in the recovery-to-launch gap", async () => {
    const lifecycle = new CodexFrontendLifecycleQueue();
    const terminal = terminalControl();
    const launches: string[][] = [];
    const originalAccept = lifecycle.acceptRecovery.bind(lifecycle);
    let injectedNewestReset = false;
    lifecycle.acceptRecovery = (event) => {
      const accepted = originalAccept(event);
      if (accepted && !injectedNewestReset) {
        injectedNewestReset = true;
        lifecycle.reset({ disconnectedGeneration: 2, threadId: event.threadId });
        lifecycle.recovered({
          disposition: "resume",
          threadId: "thread-newest",
          generation: 3,
        });
      }
      return accepted;
    };
    const result = superviseCodexTui({
      channel: "dev",
      codexBinary: "codex",
      socketPath: "/tmp/codex.sock",
      cwd: "/workspace",
      env: {},
      lifecycle,
      proxy: { quiesceFrontend: () => true },
      launchTui: (_binary, args) => {
        launches.push(args);
        return controlledBridgeChild();
      },
      terminalRun: terminal.run,
      terminalNow: terminal.now,
      terminationGraceMs: 0,
      killWaitMs: 0,
      log: () => {},
    });

    await waitFor(() => launches.length === 1, "initial TUI was not launched");
    lifecycle.reset({ disconnectedGeneration: 1, threadId: "thread-stale" });
    lifecycle.recovered({
      disposition: "resume",
      threadId: "thread-stale",
      generation: 2,
    });
    await waitFor(() => launches.length === 2, "newest replacement was not launched");
    expect(launches).toHaveLength(2);
    expect(launches[1]!.at(-1)).toBe("thread-newest");
    expect(launches[1]).not.toContain("thread-stale");

    terminal.finish({ source: "delivery", code: 0 });
    expect(await result).toBe(0);
  });

  test("supervisor never launches after delivery or signal is already terminal", async () => {
    for (const terminalResult of [
      { source: "delivery" as const, code: 7 },
      { source: "signal" as const, code: 130 },
    ]) {
      const lifecycle = new CodexFrontendLifecycleQueue();
      const terminal = terminalControl();
      let launches = 0;
      terminal.finish(terminalResult);
      const result = await superviseCodexTui({
        channel: "dev",
        codexBinary: "codex",
        socketPath: "/tmp/codex.sock",
        cwd: "/workspace",
        env: {},
        lifecycle,
        proxy: { quiesceFrontend: () => true },
        launchTui: () => {
          launches += 1;
          return controlledBridgeChild();
        },
        terminalRun: terminal.run,
        terminalNow: terminal.now,
        terminationGraceMs: 0,
        killWaitMs: 0,
        log: () => {},
      });
      expect(result).toBe(terminalResult.code);
      expect(launches).toBe(0);
    }
  });

  test("supervisor replays initial argv only for a proven-not-written start", async () => {
    const lifecycle = new CodexFrontendLifecycleQueue();
    const terminal = terminalControl();
    const launches: string[][] = [];
    const codexArgs = ["--model", "gpt-5.4", "--image", "/tmp/input.png", "initial prompt"];
    const result = superviseCodexTui({
      channel: "dev",
      codexBinary: "codex",
      codexArgs,
      socketPath: "/tmp/codex.sock",
      cwd: "/workspace",
      env: {},
      lifecycle,
      proxy: { quiesceFrontend: () => true },
      launchTui: (_binary, args) => {
        launches.push(args);
        return controlledBridgeChild();
      },
      terminalRun: terminal.run,
      terminalNow: terminal.now,
      terminationGraceMs: 0,
      killWaitMs: 0,
      log: () => {},
    });

    await waitFor(() => launches.length === 1, "initial TUI was not launched");
    lifecycle.reset({ disconnectedGeneration: 1, threadId: null });
    lifecycle.recovered({
      disposition: "restart",
      threadId: null,
      generation: 2,
    });
    await waitFor(() => launches.length === 2, "safe initial restart was not launched");
    expect(launches[1]).toEqual(buildCodexTuiArgs("/tmp/codex.sock", codexArgs));

    terminal.finish({ source: "delivery", code: 0 });
    expect(await result).toBe(0);
  });

  test("supervisor resumes the created thread with the exact proven-not-written prompt", async () => {
    const lifecycle = new CodexFrontendLifecycleQueue();
    const terminal = terminalControl();
    const launches: string[][] = [];
    const result = superviseCodexTui({
      channel: "dev",
      codexBinary: "codex",
      codexArgs: ["--model", "gpt-5.4", "original positional prompt"],
      socketPath: "/tmp/codex.sock",
      cwd: "/workspace",
      env: {},
      lifecycle,
      proxy: { quiesceFrontend: () => true },
      launchTui: (_binary, args) => {
        launches.push(args);
        return controlledBridgeChild();
      },
      terminalRun: terminal.run,
      terminalNow: terminal.now,
      terminationGraceMs: 0,
      killWaitMs: 0,
      log: () => {},
    });

    await waitFor(() => launches.length === 1, "initial TUI was not launched");
    lifecycle.reset({ disconnectedGeneration: 1, threadId: "thread-bootstrap" });
    lifecycle.recovered({
      disposition: "restart_thread_with_prompt",
      threadId: "thread-bootstrap",
      generation: 2,
      initialInput: [{
        type: "text",
        text: "WIRE_PROMPT_746",
        text_elements: [],
      }],
    });
    await waitFor(() => launches.length === 2, "prompt resume was not launched");
    expect(launches[1]).toEqual([
      "resume",
      "--remote",
      "unix:///tmp/codex.sock",
      "--model",
      "gpt-5.4",
      "thread-bootstrap",
      "WIRE_PROMPT_746",
    ]);

    terminal.finish({ source: "delivery", code: 0 });
    expect(await result).toBe(0);
  });

  test("supervisor fails closed on an after-write initial start and on unsafe detach", async () => {
    {
      const lifecycle = new CodexFrontendLifecycleQueue();
      const terminal = terminalControl();
      let launches = 0;
      const result = superviseCodexTui({
        channel: "dev",
        codexBinary: "codex",
        codexArgs: ["initial prompt"],
        socketPath: "/tmp/codex.sock",
        cwd: "/workspace",
        env: {},
        lifecycle,
        proxy: { quiesceFrontend: () => true },
        launchTui: () => {
          launches += 1;
          return controlledBridgeChild();
        },
        terminalRun: terminal.run,
        terminalNow: terminal.now,
        terminationGraceMs: 0,
        killWaitMs: 0,
        log: () => {},
      });
      await waitFor(() => launches === 1, "initial TUI was not launched");
      lifecycle.reset({ disconnectedGeneration: 1, threadId: null });
      lifecycle.recovered({
        disposition: "unknown",
        threadId: null,
        generation: 2,
        reason: "thread/start crossed the transport write boundary",
      });
      expect(await result).toBe(1);
      expect(launches).toBe(1);
    }

    {
      const lifecycle = new CodexFrontendLifecycleQueue();
      const terminal = terminalControl();
      let launches = 0;
      const result = superviseCodexTui({
        channel: "dev",
        codexBinary: "codex",
        socketPath: "/tmp/codex.sock",
        cwd: "/workspace",
        env: {},
        lifecycle,
        proxy: { quiesceFrontend: () => true },
        launchTui: () => {
          launches += 1;
          return controlledBridgeChild({ exitOnSignal: false });
        },
        terminalRun: terminal.run,
        terminalNow: terminal.now,
        terminationGraceMs: 0,
        killWaitMs: 0,
        log: () => {},
      });
      await waitFor(() => launches === 1, "initial TUI was not launched");
      lifecycle.reset({ disconnectedGeneration: 1, threadId: "thread-one" });
      lifecycle.recovered({
        disposition: "resume",
        threadId: "thread-one",
        generation: 2,
      });
      expect(await result).toBe(1);
      expect(launches).toBe(1);
    }
  });
});
