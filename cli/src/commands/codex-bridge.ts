// Runtime wiring for `party bridge codex`.
//
// The interactive Codex TUI connects to a private Unix WebSocket endpoint.
// This process owns the only stdio app-server connection and also consumes
// AgentParty delivery, so every writer crosses one CodexSessionController.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAgentPartyBridge,
  CodexRpcClient,
  CodexSessionController,
  CodexUnixJsonRpcProxy,
  type CodexFrontendReset,
  type CodexFrontendRecovery,
} from "../codex-app-server-bridge";
import { connect, type Connection } from "../client";
import { loadCursor, saveCursor } from "../config";
import {
  DeliveryRecoveryJournal,
  deliveryRecoveryJournalPath,
} from "../delivery-recovery-journal";
import {
  acquireInstanceLock,
  defaultInstanceLockDir,
  instanceLockTarget,
  type InstanceLock,
} from "../instance-lock";
import { resolveAuthDetailed } from "../oidc-cli";
import { postMessage } from "../rest";

export interface CodexBridgeRuntimeOptions {
  channel: string;
  codexBinary: string;
  codexArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BridgeChildProcess {
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface CodexBridgeRuntimeDeps {
  resolveAuth?: typeof resolveAuthDetailed;
  connectAgentParty?: typeof connect;
  spawnAppServer?: (options: {
    codexBinary: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => ChildProcessWithoutNullStreams;
  launchTui?: (
    codexBinary: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => BridgeChildProcess;
  runtimeDir?: () => string;
  removeRuntimeDir?: (path: string) => void;
  installSignalHandlers?: (
    handler: (signal: "SIGINT" | "SIGTERM") => void,
  ) => () => void;
  terminationGraceMs?: number;
  killWaitMs?: number;
  log?: (line: string) => void;
}

export function buildCodexTuiArgs(socketPath: string, codexArgs: string[] = []): string[] {
  return ["--remote", `unix://${socketPath}`, ...codexArgs];
}

const CODEX_REPLAY_VALUE_FLAGS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote-auth-token-env",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
]);
const CODEX_REPLAY_BOOLEAN_FLAGS = new Set([
  "--strict-config",
  "--oss",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--search",
  "--no-alt-screen",
]);

function replayableCodexArgs(codexArgs: string[]): string[] {
  const replayable: string[] = [];
  for (let index = 0; index < codexArgs.length; index += 1) {
    const token = codexArgs[index]!;
    if (token === "--") break;
    if (token === "-i" || token === "--image") {
      // Initial attachments belong to the original prompt and must not be
      // re-submitted during an ordinary exact-thread resume.
      while (
        index + 1 < codexArgs.length &&
        codexArgs[index + 1] !== "--" &&
        !codexArgs[index + 1]!.startsWith("-")
      ) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--image=") || token.startsWith("-i=")) continue;
    if (CODEX_REPLAY_VALUE_FLAGS.has(token)) {
      const value = codexArgs[index + 1];
      if (value !== undefined) {
        replayable.push(token, value);
        index += 1;
      }
      continue;
    }
    const equals = token.indexOf("=");
    if (
      equals > 0 &&
      CODEX_REPLAY_VALUE_FLAGS.has(token.slice(0, equals))
    ) {
      replayable.push(token);
      continue;
    }
    if (CODEX_REPLAY_BOOLEAN_FLAGS.has(token)) replayable.push(token);
    // Every non-option is the original positional prompt. Unknown flags are
    // not replayed because their arity/side effects cannot be established.
  }
  return replayable;
}

export function buildCodexTuiResumeArgs(
  socketPath: string,
  threadId: string,
  codexArgs: string[] = [],
): string[] {
  return [
    "resume",
    "--remote",
    `unix://${socketPath}`,
    ...replayableCodexArgs(codexArgs),
    threadId,
  ];
}

interface InitialCodexInvocation {
  options: string[];
  imageOptions: string[];
  prompt: string | null;
}

function parseInitialCodexInvocation(codexArgs: string[]): InitialCodexInvocation | null {
  const options: string[] = [];
  const imageOptions: string[] = [];
  let prompt: string | null = null;
  for (let index = 0; index < codexArgs.length; index += 1) {
    const token = codexArgs[index]!;
    if (token === "--") {
      const positional = codexArgs.slice(index + 1);
      if (positional.length > 1 || (prompt !== null && positional.length > 0)) return null;
      if (positional.length === 1) prompt = positional[0]!;
      break;
    }
    if (token === "-i" || token === "--image") {
      imageOptions.push(token);
      let values = 0;
      while (
        index + 1 < codexArgs.length &&
        codexArgs[index + 1] !== "--" &&
        !codexArgs[index + 1]!.startsWith("-")
      ) {
        imageOptions.push(codexArgs[++index]!);
        values += 1;
      }
      if (values === 0) return null;
      continue;
    }
    if (token.startsWith("--image=") || token.startsWith("-i=")) {
      imageOptions.push(token);
      continue;
    }
    if (CODEX_REPLAY_VALUE_FLAGS.has(token)) {
      const value = codexArgs[index + 1];
      if (value === undefined) return null;
      options.push(token, value);
      index += 1;
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 0 && CODEX_REPLAY_VALUE_FLAGS.has(token.slice(0, equals))) {
      options.push(token);
      continue;
    }
    if (CODEX_REPLAY_BOOLEAN_FLAGS.has(token)) {
      options.push(token);
      continue;
    }
    if (token.startsWith("-")) return null;
    if (prompt !== null) return null;
    prompt = token;
  }
  return { options, imageOptions, prompt };
}

function invocationFromInitialInput(
  input: unknown,
): { imageOptions: string[]; prompt: string | null } | null {
  if (!Array.isArray(input)) return null;
  const imageOptions: string[] = [];
  let prompt: string | null = null;
  for (const item of input) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      if (prompt !== null) return null;
      prompt = record.text;
      continue;
    }
    if (
      (record.type === "localImage" || record.type === "image") &&
      typeof record.path === "string"
    ) {
      imageOptions.push("--image", record.path);
      continue;
    }
    return null;
  }
  return { imageOptions, prompt };
}

/**
 * Re-enter an already-created bootstrap thread while replaying only the
 * initial prompt that was proven not written. The thread itself is never
 * created twice.
 */
export function buildCodexTuiResumeWithPromptArgs(
  socketPath: string,
  threadId: string,
  codexArgs: string[] = [],
  initialInput?: unknown,
): string[] | null {
  const invocation = parseInitialCodexInvocation(codexArgs);
  if (!invocation) return null;
  const initial = initialInput === undefined
    ? { imageOptions: invocation.imageOptions, prompt: invocation.prompt }
    : invocationFromInitialInput(initialInput);
  if (!initial) return null;
  return [
    "resume",
    "--remote",
    `unix://${socketPath}`,
    ...invocation.options,
    ...initial.imageOptions,
    ...(initial.imageOptions.length === 0 ? [] : ["--"]),
    threadId,
    ...(initial.prompt === null ? [] : [initial.prompt]),
  ];
}

export function resolveCodexRecoveryThreadId(
  entries: ReadonlyArray<{ threadId: string | null }>,
): string | null {
  const threadIds = new Set(
    entries.flatMap((entry) => entry.threadId === null ? [] : [entry.threadId]),
  );
  if (threadIds.size > 1) {
    throw new Error(
      "Codex delivery recovery journal spans multiple threads; refusing to choose one",
    );
  }
  return threadIds.values().next().value ?? null;
}

export class CodexFrontendRecoveryQueue {
  private pending: CodexFrontendRecovery | null = null;
  private waiter: ((event: CodexFrontendRecovery) => void) | null = null;
  private newestGeneration = 0;

  push(event: CodexFrontendRecovery): void {
    if (event.generation <= this.newestGeneration) return;
    this.newestGeneration = event.generation;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(event);
      return;
    }
    this.pending = event;
  }

  next(): Promise<CodexFrontendRecovery> {
    if (this.pending) {
      const event = this.pending;
      this.pending = null;
      return Promise.resolve(event);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

type CodexFrontendLifecycleEvent =
  | { type: "reset"; event: CodexFrontendReset }
  | { type: "recovered"; event: CodexFrontendRecovery };

export class CodexFrontendLifecycleQueue {
  private readonly pending: CodexFrontendLifecycleEvent[] = [];
  private waiter: ((event: CodexFrontendLifecycleEvent) => void) | null = null;
  private resetGeneration = 0;
  private recoveryPending = false;

  reset(event: CodexFrontendReset): void {
    this.recoveryPending = true;
    this.resetGeneration = Math.max(
      this.resetGeneration,
      event.disconnectedGeneration,
    );
    this.push({ type: "reset", event });
  }

  recovered(event: CodexFrontendRecovery): void {
    this.push({ type: "recovered", event });
  }

  get inRecoveryWindow(): boolean {
    return this.recoveryPending;
  }

  get latestResetGeneration(): number {
    return this.resetGeneration;
  }

  acceptRecovery(event: CodexFrontendRecovery): boolean {
    if (event.generation <= this.resetGeneration) return false;
    this.recoveryPending = false;
    return true;
  }

  private push(event: CodexFrontendLifecycleEvent): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(event);
      return;
    }
    this.pending.push(event);
    if (this.pending.length > 32) this.pending.splice(0, this.pending.length - 32);
  }

  next(): Promise<CodexFrontendLifecycleEvent> {
    const event = this.pending.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

function defaultSpawnAppServer(options: {
  codexBinary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ChildProcessWithoutNullStreams {
  return spawn(options.codexBinary, ["app-server", "--stdio"], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function defaultLaunchTui(
  codexBinary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): BridgeChildProcess {
  const child = Bun.spawn([codexBinary, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  };
}

function defaultRuntimeDir(): string {
  const path = mkdtempSync(join(tmpdir(), "agentparty-codex-"));
  chmodSync(path, 0o700);
  return path;
}

function defaultRemoveRuntimeDir(path: string): void {
  // `path` is a freshly-created, bridge-owned mkdtemp directory; never accept
  // a caller/environment path as this recursive cleanup target.
  rmSync(path, { recursive: true, force: true });
}

function defaultInstallSignalHandlers(
  handler: (signal: "SIGINT" | "SIGTERM") => void,
): () => void {
  const onSigint = () => handler("SIGINT");
  const onSigterm = () => handler("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reap a bridge-owned child without waiting forever. SIGKILL is intentionally
 * attempted even when SIGTERM is ignored; all failures are best-effort because
 * the child may have exited between the checks.
 */
export async function terminateBridgeChild(
  child: BridgeChildProcess | null,
  graceMs: number = 1_000,
  killWaitMs: number = 500,
  wait: (ms: number) => Promise<void> = delay,
): Promise<boolean> {
  if (!child) return true;
  const exited = child.exited.then(
    () => true,
    () => true,
  );
  try {
    child.kill("SIGTERM");
  } catch {
    return await Promise.race([
      exited,
      wait(graceMs).then(() => false),
    ]);
  }
  const stopped = await Promise.race([
    exited,
    wait(graceMs).then(() => false),
  ]);
  if (stopped) return true;
  try {
    child.kill("SIGKILL");
  } catch {
    return await Promise.race([
      exited,
      wait(killWaitMs).then(() => false),
    ]);
  }
  return await Promise.race([exited, wait(killWaitMs).then(() => false)]);
}

function childProcessExited(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(1);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once("exit", (code) => finish(code ?? 1));
    child.once("error", () => finish(1));
  });
}

class CodexBridgeTerminated extends Error {}

function terminationExitCode(signal: "SIGINT" | "SIGTERM"): number {
  return signal === "SIGINT" ? 130 : 143;
}

export interface CodexBridgeTerminalResult {
  source: "delivery" | "signal";
  code: number;
}

export async function superviseCodexTui(options: {
  channel: string;
  codexBinary: string;
  codexArgs?: string[];
  initialThreadId?: string | null;
  socketPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  lifecycle: CodexFrontendLifecycleQueue;
  proxy: Pick<CodexUnixJsonRpcProxy, "quiesceFrontend">;
  launchTui: NonNullable<CodexBridgeRuntimeDeps["launchTui"]>;
  terminalRun: Promise<CodexBridgeTerminalResult>;
  terminalNow: () => CodexBridgeTerminalResult | null;
  terminationGraceMs: number;
  killWaitMs: number;
  log: (line: string) => void;
  onTuiChange?: (child: BridgeChildProcess | null) => void;
}): Promise<number> {
  let tui: BridgeChildProcess | null = null;
  let tuiArgs = options.initialThreadId
    ? buildCodexTuiResumeArgs(
      options.socketPath,
      options.initialThreadId,
      options.codexArgs,
    )
    : buildCodexTuiArgs(options.socketPath, options.codexArgs);
  let lifecycleRun: Promise<{
    source: "frontend-lifecycle";
    event: CodexFrontendLifecycleEvent;
    code: number;
  }> | null = null;
  const nextLifecycle = () => {
    lifecycleRun ??= options.lifecycle.next().then((event) => ({
      source: "frontend-lifecycle" as const,
      event,
      code: 0,
    }));
    return lifecycleRun;
  };
  try {
    for (;;) {
      const terminalBeforeRecovery = options.terminalNow();
      if (terminalBeforeRecovery) return terminalBeforeRecovery.code;

      if (options.lifecycle.inRecoveryWindow) {
        let recovered: CodexFrontendRecovery | null = null;
        while (recovered === null) {
          const terminal = options.terminalNow();
          if (terminal) return terminal.code;
          const next = await Promise.race([
            options.terminalRun,
            nextLifecycle(),
          ]);
          if (next.source !== "frontend-lifecycle") return next.code;
          lifecycleRun = null;
          if (
            next.event.type === "recovered" &&
            options.lifecycle.acceptRecovery(next.event.event)
          ) {
            recovered = next.event.event;
          }
        }

        const terminalAfterRecovery = options.terminalNow();
        if (terminalAfterRecovery) return terminalAfterRecovery.code;
        if (recovered.disposition === "unknown") {
          options.log(`codex-bridge: ${recovered.reason}; refusing to replay the initial prompt`);
          return 1;
        }
        if (recovered.disposition === "restart") {
          options.log(
            `codex-bridge: app-server generation ${recovered.generation} recovered before ` +
              "thread/start was written; restarting the original TUI invocation",
          );
          tuiArgs = buildCodexTuiArgs(options.socketPath, options.codexArgs);
        } else if (recovered.disposition === "restart_thread_with_prompt") {
          const replayArgs = buildCodexTuiResumeWithPromptArgs(
            options.socketPath,
            recovered.threadId,
            options.codexArgs,
            recovered.initialInput,
          );
          if (!replayArgs) {
            options.log(
              "codex-bridge: initial turn/start was not written, but its input cannot be " +
                "represented by the Codex resume CLI; refusing a lossy replay",
            );
            return 1;
          }
          options.log(
            `codex-bridge: app-server generation ${recovered.generation} recovered after ` +
              "thread creation; resuming the exact thread with its proven-not-written prompt",
          );
          tuiArgs = replayArgs;
        } else {
          options.log(
            `codex-bridge: app-server generation ${recovered.generation} recovered; ` +
              `restarting the TUI on exact thread ${recovered.threadId}`,
          );
          tuiArgs = buildCodexTuiResumeArgs(
            options.socketPath,
            recovered.threadId,
            options.codexArgs,
          );
        }
        // Re-enter both pre-launch gates. A newer reset or an already-settled
        // terminal source must win the resume-to-launch gap.
        continue;
      }

      const terminalBeforeLaunch = options.terminalNow();
      if (terminalBeforeLaunch) return terminalBeforeLaunch.code;
      options.log(
        `codex-bridge: launching Codex TUI for #${options.channel}; ` +
          "TUI and AgentParty now share one app-server writer",
      );
      tui = options.launchTui(
        options.codexBinary,
        tuiArgs,
        { cwd: options.cwd, env: options.env },
      );
      options.onTuiChange?.(tui);
      const currentTui = tui;
      const tuiRun = currentTui.exited.then(
        (code) => ({ source: "tui" as const, code }),
        (error) => {
          options.log(
            `codex-bridge: TUI failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return { source: "tui" as const, code: 1 };
        },
      );
      for (;;) {
        const finished = await Promise.race([
          options.terminalRun,
          nextLifecycle(),
          tuiRun,
        ]);
        if (finished.source === "delivery" || finished.source === "signal") {
          return finished.code;
        }
        if (finished.source === "frontend-lifecycle") {
          lifecycleRun = null;
          if (!options.lifecycle.inRecoveryWindow) {
            // A duplicate/stale recovery frame cannot evict a healthy TUI.
            continue;
          }
        } else if (!options.lifecycle.inRecoveryWindow) {
          return finished.code;
        }
        break;
      }

      if (!options.proxy.quiesceFrontend("Codex backend generation changed")) {
        options.log(
          "codex-bridge: could not detach the stale TUI frontend; refusing replacement",
        );
        return 1;
      }
      const stopped = await terminateBridgeChild(
        currentTui,
        options.terminationGraceMs,
        options.killWaitMs,
      );
      if (!stopped) {
        options.log(
          "codex-bridge: stale Codex TUI did not exit after SIGKILL; refusing replacement",
        );
        return 1;
      }
      if (tui === currentTui) {
        tui = null;
        options.onTuiChange?.(null);
      }
    }
  } finally {
    await terminateBridgeChild(
      tui,
      options.terminationGraceMs,
      options.killWaitMs,
    );
    options.onTuiChange?.(null);
  }
}

/**
 * Run the same-session Codex bridge until either the TUI exits or AgentParty
 * delivery reaches a terminal stream error.
 */
export async function runCodexSessionBridge(
  options: CodexBridgeRuntimeOptions,
  deps: CodexBridgeRuntimeDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line) => console.error(line));
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  let lock: InstanceLock | null = null;
  let runtimeDir: string | null = null;
  let connection: Connection | null = null;
  let delivery: CodexAgentPartyBridge | null = null;
  let rpc: CodexRpcClient | null = null;
  let proxy: CodexUnixJsonRpcProxy | null = null;
  let tui: BridgeChildProcess | null = null;
  let unsubscribeFrontendReset: (() => void) | null = null;
  let unsubscribeFrontendRecovery: (() => void) | null = null;
  const appServers = new Map<ChildProcessWithoutNullStreams, Promise<number>>();
  let terminationSignal: "SIGINT" | "SIGTERM" | null = null;
  let resolveTermination!: (signal: "SIGINT" | "SIGTERM") => void;
  const termination = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
    resolveTermination = resolve;
  });
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (terminationSignal !== null) return;
    terminationSignal = signal;
    resolveTermination(signal);
  };
  const removeSignalHandlers = (deps.installSignalHandlers ?? defaultInstallSignalHandlers)(onSignal);
  const throwIfTerminated = () => {
    if (terminationSignal !== null) throw new CodexBridgeTerminated();
  };
  const awaitStartup = async <T>(operation: Promise<T>): Promise<T> => {
    throwIfTerminated();
    return await Promise.race([
      operation,
      termination.then(() => {
        throw new CodexBridgeTerminated();
      }),
    ]);
  };
  const graceMs = deps.terminationGraceMs ?? 1_000;
  const killWaitMs = deps.killWaitMs ?? 500;

  try {
    const auth = await awaitStartup(
      Promise.resolve().then(() => (deps.resolveAuth ?? resolveAuthDetailed)()),
    );
    if (!auth.server || !auth.token) {
      log("codex-bridge: no config, run: party login or party init --server URL --token T");
      return 1;
    }
    const serverUrl = auth.server;
    const token = auth.token;
    const recoveryJournal = new DeliveryRecoveryJournal(
      deliveryRecoveryJournalPath("codex", serverUrl, token, options.channel),
      options.channel,
      "codex",
    );
    let initialThreadId: string | null;
    try {
      initialThreadId = resolveCodexRecoveryThreadId(recoveryJournal.entries());
    } catch (error) {
      log(`codex-bridge: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    throwIfTerminated();
    lock = acquireInstanceLock(
      "serve",
      instanceLockTarget(serverUrl, token, options.channel),
      defaultInstanceLockDir(),
    );
    if (!lock.ok) {
      log(
        `codex-bridge: another serve/session bridge already owns #${options.channel}` +
          (lock.heldByPid === undefined ? "" : ` (pid=${lock.heldByPid})`),
      );
      return 1;
    }

    throwIfTerminated();
    runtimeDir = (deps.runtimeDir ?? defaultRuntimeDir)();
    const socketPath = join(runtimeDir, "codex.sock");
    rpc = new CodexRpcClient({
      spawnProxy: () => {
        const child = (deps.spawnAppServer ?? defaultSpawnAppServer)({
          codexBinary: options.codexBinary,
          cwd,
          env,
        });
        const exited = childProcessExited(child);
        appServers.set(child, exited);
        void exited.then(() => appServers.delete(child));
        return child;
      },
      log,
    });
    const initialInvocation = parseInitialCodexInvocation(options.codexArgs ?? []);
    const expectBootstrapPrompt =
      initialThreadId === null &&
      initialInvocation !== null &&
      (
        initialInvocation.prompt !== null ||
        initialInvocation.imageOptions.length > 0
      );
    const session = new CodexSessionController(rpc, {
      log,
      expectBootstrapPrompt,
    });
    const frontendLifecycle = new CodexFrontendLifecycleQueue();
    unsubscribeFrontendReset = session.onFrontendReset((event) => {
      frontendLifecycle.reset(event);
    });
    unsubscribeFrontendRecovery = session.onFrontendRecovery((event) => {
      frontendLifecycle.recovered(event);
    });
    await awaitStartup(session.start());
    if (initialThreadId !== null) {
      await awaitStartup(session.request("thread/resume", {
        threadId: initialThreadId,
      }));
      if (session.activeThreadId !== initialThreadId) {
        throw new Error(
          `Codex app-server resumed ${session.activeThreadId ?? "no thread"} instead of ` +
            `recovery thread ${initialThreadId}`,
        );
      }
      await awaitStartup(session.request("thread/read", {
        threadId: initialThreadId,
        includeTurns: true,
      }));
      if (session.activeThreadId !== initialThreadId) {
        throw new Error(
          `Codex app-server read ${session.activeThreadId ?? "no thread"} instead of ` +
            `recovery thread ${initialThreadId}`,
        );
      }
    }
    proxy = new CodexUnixJsonRpcProxy(session, { log });
    await awaitStartup(proxy.listen(socketPath));

    throwIfTerminated();
    connection = (deps.connectAgentParty ?? connect)(
      serverUrl,
      token,
      options.channel,
      loadCursor(options.channel),
      {
        directedDelivery: "v1",
        deliveryRecovery: "v1",
        advertiseWakeKind: "daemon",
        onCursor: (cursor) => saveCursor(options.channel, cursor),
        onStatus: (status) => {
          if (status !== "open") delivery?.handleConnectionStatus(status);
        },
      },
    );
    delivery = new CodexAgentPartyBridge({
      channel: options.channel,
      connection,
      session,
      recoveryJournal,
      requireDeliveryRecovery: true,
      postReply: async ({ body, mentions, replyTo, idempotencyKey }) => {
        const posted = await postMessage(serverUrl, token, options.channel, {
          kind: "message",
          body,
          mentions,
          reply_to: replyTo,
          idempotency_key: idempotencyKey,
        });
        return { seq: posted.seq };
      },
      log,
    });

    let deliveryTerminal: { source: "delivery"; code: number } | null = null;
    const deliveryRun = delivery.run().then(
      (code) => ({ source: "delivery" as const, code }),
      (error) => {
        log(`codex-bridge: delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        return { source: "delivery" as const, code: 1 };
      },
    ).then((result) => {
      deliveryTerminal = result;
      return result;
    });
    const signalRun = termination.then((signal) => ({
      source: "signal" as const,
      code: terminationExitCode(signal),
    }));
    const terminalNow = (): { source: "delivery" | "signal"; code: number } | null => {
      if (terminationSignal !== null) {
        return { source: "signal", code: terminationExitCode(terminationSignal) };
      }
      return deliveryTerminal;
    };
    const terminalRun = Promise.race([signalRun, deliveryRun]).then((terminal) => {
      if (terminal.source === "signal") {
        log(`codex-bridge: received ${terminationSignal}; shutting down`);
      }
      return terminal;
    });
    return await superviseCodexTui({
      channel: options.channel,
      codexBinary: options.codexBinary,
      codexArgs: options.codexArgs,
      initialThreadId,
      socketPath,
      cwd,
      env,
      lifecycle: frontendLifecycle,
      proxy,
      launchTui: deps.launchTui ?? defaultLaunchTui,
      terminalRun,
      terminalNow,
      terminationGraceMs: graceMs,
      killWaitMs,
      log,
      onTuiChange: (child) => {
        tui = child;
      },
    });
  } catch (error) {
    if (error instanceof CodexBridgeTerminated && terminationSignal !== null) {
      log(`codex-bridge: received ${terminationSignal}; shutting down`);
      return terminationExitCode(terminationSignal);
    }
    throw error;
  } finally {
    // Restore the platform's default second-signal behavior before asynchronous
    // cleanup, so a stuck cleanup cannot make Ctrl-C/TERM disappear.
    removeSignalHandlers();
    try { unsubscribeFrontendReset?.(); } catch { /* best-effort shutdown */ }
    try { unsubscribeFrontendRecovery?.(); } catch { /* best-effort shutdown */ }
    try { delivery?.close(); } catch { /* best-effort shutdown */ }
    try { connection?.close(); } catch { /* best-effort shutdown */ }
    try { await proxy?.close(); } catch { /* best-effort shutdown */ }
    try { rpc?.close(); } catch { /* best-effort shutdown */ }
    await terminateBridgeChild(tui, graceMs, killWaitMs);
    await Promise.all(
      [...appServers.entries()].map(([child, exited]) =>
        terminateBridgeChild(
          { exited, kill: (signal) => child.kill(signal) },
          graceMs,
          killWaitMs,
        )),
    );
    try { lock?.release?.(); } catch { /* best-effort lock release */ }
    if (runtimeDir !== null) {
      try {
        (deps.removeRuntimeDir ?? defaultRemoveRuntimeDir)(runtimeDir);
      } catch {
        /* best-effort removal of the bridge-owned mkdtemp */
      }
    }
  }
}
