// party serve — 常驻监听频道，每条 @你 的消息触发一次本地命令，把「跑完就停的 session agent」
// 用外部 supervisor 唤醒（wake GOAL 的 session 型那半；有入站 URL 的 runtime 走 webhook）。
// 复用 client.connect 的自动重连帧流，真正常驻；命令串行执行（一条处理完再下一条，不并发抢跑）。
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_STREAM_ENDED, type MsgFrame } from "@agentparty/shared";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { connect } from "../client";
import { loadCursor, loadRevCursor, resolveChannel, saveCursor, saveRevCursor } from "../config";
import { formatMsg } from "../format";
import { resolveAuthDetailed, type ResolvedAuthDetailed } from "../oidc-cli";
import { postMessage } from "../rest";
import { isSlug } from "../validation";
import { buildContext } from "./status";

const PROTOCOL_REMINDER =
  "被 @ 唤起：若这是一个全新会话（你不记得这个频道的前情），先 `party history <channel 字段的频道>` 补齐上下文再动手（下面的 recent 只是最近片段）；若是续上的会话就按你记得的继续。需要产出结论时，先用 `party send --reply-to <seq>` 把 final synthesis 发回频道，再 status done；别只回本地。";

// context file 里附带的最近频道消息条数上限（冷起的 runner 不用先跑 history 也有基本上下文）
const RECENT_MAX = 20;
const RECENT_BODY_MAX = 400;
const RUNNER_SESSION_FILE = "wake-session.json";
const RUNNER_LOG_FILE = "serve-runner.log";

export type RunnerHarness = "codex" | "claude";

export interface RunnerProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunnerProcessOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export type RunnerProcess = (
  args: string[],
  opts: RunnerProcessOptions,
) => Promise<RunnerProcessResult>;

interface WakeSessionState {
  harness: RunnerHarness;
  session_id: string;
  created_at: number;
  last_wake_ts: number;
  wakes: number;
}

interface SdkWakeSessionState {
  harness: "codex-sdk";
  thread_id: string;
  created_at: number;
  last_wake_ts: number;
  wakes: number;
}

export interface BuiltinRunnerOptions {
  server: string;
  token: string;
  channel: string;
  harness: RunnerHarness;
  workdir: string;
  repo?: string;
  runProcess?: RunnerProcess;
  runGit?: RunnerProcess;
  authSourceFile?: string;
  now?: () => number;
  post?: typeof postMessage;
}

export interface ThreadLike {
  id?: string;
  thread_id?: string;
  run(prompt: string, opts: { sandbox: string }): Promise<unknown>;
}

export interface CodexLike {
  startThread(): ThreadLike | Promise<ThreadLike>;
  resumeThread(threadId: string): ThreadLike | Promise<ThreadLike>;
}

export interface SdkRunnerOptions {
  server: string;
  token: string;
  channel: string;
  workdir: string;
  sandbox?: string;
  codexFactory?: () => CodexLike | Promise<CodexLike>;
  now?: () => number;
  post?: typeof postMessage;
}

// 把一条 @mention 的完整上下文落成 JSON 文件，命令拿路径读——避开 env/stdin 的 shell quoting/注入，
// 也让 runner 能一次拿全 channel/seq/sender/body/reply_to/recent/protocol_reminder（评审建议）。
// recent = 触发消息之前、serve 在线期间看到的最近频道消息（含自己/未 @ 的闲聊，正文截断），
// 让冷起的 runner 开箱有上下文；完整脉络仍以 party history 为准。
function buildWakeContext(frame: MsgFrame, channel: string, self: string, recent: MsgFrame[]) {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  return {
    channel,
    seq: frame.seq,
    sender: frame.sender.name,
    owner: frame.sender.owner ?? null,
    kind: frame.kind,
    body,
    mentions: frame.mentions,
    reply_to: frame.seq, // 回这条就 --reply-to 它
    self,
    recent: recent.map((m) => ({
      seq: m.seq,
      sender: m.sender.name,
      kind: m.kind,
      body: (m.kind === "message" ? m.body : (m.note ?? "")).slice(0, RECENT_BODY_MAX),
      ts: m.ts,
    })),
    protocol_reminder: PROTOCOL_REMINDER,
  };
}

export function writeContextFile(frame: MsgFrame, channel: string, self: string, recent: MsgFrame[]): string {
  const path = join(tmpdir(), `agentparty-serve-${channel}-${frame.seq}.json`);
  writeFileSync(
    path,
    JSON.stringify(buildWakeContext(frame, channel, self, recent), null, 2) + "\n",
    { mode: 0o600 },
  );
  return path;
}

const SERVE_FLAGS = ["channel", "on-mention", "all", "runner", "workdir", "repo"];
const HELP = `usage: party serve [channel|--channel C] (--on-mention "<cmd>" | --runner codex|claude|codex-sdk) [--all]

Stay attached to a channel and run one local command for each matching message.
The command can read the context JSON path from {file} or AP_CONTEXT_FILE.

Options:
  --channel C          serve channel C instead of the bound channel
  --on-mention "<cmd>" command to run for each wake
  --runner codex|claude|codex-sdk
                       use the built-in isolated wake runner instead of a custom command
  --workdir DIR        runner workdir (default: ~/.agentparty/runners/<channel>)
  --repo URL           clone into workdir/repo once, then git pull --ff-only before each wake
  --all                run for every non-self message, not only @mentions`;

export interface ServeOptions {
  server: string;
  token: string;
  channel: string;
  since: number;
  sinceRev?: number; // 修订游标（hello.since_rev）
  cmd: string;
  mentionsOnly: boolean;
  builtinRunner?: BuiltinRunnerOptions;
  onCursor?: (cursor: number) => void;
  onRevCursor?: (revCursor: number) => void;
  // 测试注入点：默认用 sh -c 起子进程
  runCommand?: (
    frame: MsgFrame,
    ctx: { cmd: string; channel: string; self: string; recent: MsgFrame[] },
  ) => Promise<void>;
  sdkRunner?: SdkRunnerOptions;
  // serve 挂上后声明自己「可被唤醒」的钩子；run() 注入真实实现，测试可省略/替换
  advertise?: () => Promise<void>;
  out?: (line: string) => void;
}

// serve 一挂上就把 presence 标成可唤醒：residency=supervised + wake.kind=serve。
// 没这一步，agent 跑了 serve 但 presence 仍是 null → 别人 party wake test @你 会判 not_auto_wakeable，
// agent 得自己再手动 party status --wake-kind serve --residency supervised 才行（外部 agent 就卡在这半天）。
export async function advertiseServeWake(auth: ResolvedAuthDetailed, channel: string): Promise<void> {
  if (!auth.server || !auth.token) return;
  await postMessage(auth.server, auth.token, channel, {
    kind: "status",
    state: "waiting",
    note: "serve supervisor 已挂上——被 @ 才唤起你一次，等待零 token",
    mentions: [],
    residency: "supervised",
    wake: { kind: "serve" },
    context: buildContext(auth),
  });
}

// 默认执行器：把上下文写成 context file → sh -c <cmd>（cmd 里的 {file} 替成路径，也放进 AP_CONTEXT_FILE）。
// 正文仍走 stdin + AP_* env 图省事；context file 是给需要稳健取全量的 runner 用。串行等它退出。
// 非零退出：打印 exit code + context file 路径（便于排查），并保留文件；成功则清理。
async function defaultRun(
  frame: MsgFrame,
  ctx: { cmd: string; channel: string; self: string; recent: MsgFrame[] },
): Promise<void> {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  const file = writeContextFile(frame, ctx.channel, ctx.self, ctx.recent);
  const cmd = ctx.cmd.includes("{file}") ? ctx.cmd.replaceAll("{file}", file) : ctx.cmd;
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdin: new TextEncoder().encode(body),
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      AP_CONTEXT_FILE: file,
      AP_CHANNEL: ctx.channel,
      AP_SEQ: String(frame.seq),
      AP_SENDER: frame.sender.name,
      AP_OWNER: frame.sender.owner ?? "",
      AP_BODY: body,
      AP_MENTIONS: frame.mentions.join(","),
      AP_SELF: ctx.self,
      AP_REPLY_TO: String(frame.seq),
    },
  });
  const code = await proc.exited;
  if (code !== 0) {
    // 保留 context file 供排查，抛错让 runServe 打印（不发频道）
    throw new Error(`command exited ${code} (context: ${file})`);
  }
  try {
    unlinkSync(file);
  } catch {
    /* 清理失败无所谓 */
  }
}

function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function attachmentPathFromRunnerText(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\[attach:([^\]\r\n]+)\]$/);
    if (!match) continue;
    const path = match[1]!;
    if (!isAbsolute(path)) throw new Error(`[attach] path must be absolute: ${path}`);
    return path;
  }
  return null;
}

function finalMessageBody(text: string, marker: string | null): string {
  const attach = attachmentPathFromRunnerText(text);
  if (attach) return readFileSync(attach, "utf8");
  return marker ? `${marker}\n${text}` : text;
}

async function defaultRunnerProcess(
  args: string[],
  opts: RunnerProcessOptions,
): Promise<RunnerProcessResult> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: compactEnv(opts.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function readSession(path: string, harness: RunnerHarness): WakeSessionState | null {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as WakeSessionState;
    return state.harness === harness && typeof state.session_id === "string" ? state : null;
  } catch {
    return null;
  }
}

function writeSession(path: string, state: WakeSessionState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function readSdkSession(path: string): SdkWakeSessionState | null {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as SdkWakeSessionState;
    return state.harness === "codex-sdk" && typeof state.thread_id === "string" ? state : null;
  } catch {
    return null;
  }
}

function writeSdkSession(path: string, state: SdkWakeSessionState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function shortSid(sid: string | null | undefined): string {
  return sid ? sid.slice(0, 8) : "unknown";
}

function appendRunnerLog(workdir: string, line: string): void {
  appendFileSync(join(workdir, RUNNER_LOG_FILE), line + "\n");
}

function parseCodexSessionId(stdout: string): string | null {
  return stdout.match(/session id:\s*([0-9a-fA-F][0-9a-fA-F-]{7,})/i)?.[1] ?? null;
}

function sdkPrompt(frame: MsgFrame, channel: string, self: string, recent: MsgFrame[]): string {
  return JSON.stringify(buildWakeContext(frame, channel, self, recent), null, 2) + "\n";
}

function sdkThreadId(thread: ThreadLike): string {
  if (typeof thread.id === "string") return thread.id;
  if (typeof thread.thread_id === "string") return thread.thread_id;
  throw new Error("@openai/codex-sdk thread did not expose an id/thread_id");
}

async function defaultCodexFactory(): Promise<CodexLike> {
  const specifier = "@openai/codex-sdk";
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch {
    throw new Error(
      "runner codex-sdk requires @openai/codex-sdk and Node >=18. Install it with: npm i @openai/codex-sdk",
    );
  }
  const record = mod && typeof mod === "object" ? (mod as Record<string, unknown>) : {};
  const nestedDefault = record.default && typeof record.default === "object"
    ? (record.default as Record<string, unknown>)
    : {};
  const Codex = record.Codex ?? nestedDefault.Codex ?? record.default;
  if (typeof Codex !== "function") {
    throw new Error("@openai/codex-sdk did not export Codex");
  }
  const CodexCtor = Codex as new () => CodexLike;
  return new CodexCtor();
}

export function finalText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return String(result ?? "");
  const body = result as Record<string, unknown>;
  for (const key of ["final_response", "finalResponse", "text", "message", "content", "result"]) {
    if (typeof body[key] === "string") return body[key];
  }
  return String(result);
}

function parseClaudeJson(stdout: string): { sessionId: string | null; text: string } {
  try {
    const body = JSON.parse(stdout) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : null;
    for (const key of ["result", "text", "message", "content"]) {
      if (typeof body[key] === "string") return { sessionId, text: body[key] };
    }
    return { sessionId, text: stdout };
  } catch {
    return { sessionId: null, text: stdout };
  }
}

function prepareCodexHome(workdir: string, authSourceFile?: string): Record<string, string | undefined> {
  const codexHome = join(workdir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const authDest = join(codexHome, "auth.json");
  const authSource = authSourceFile ?? join(homedir(), ".codex", "auth.json");
  // 隔离 CODEX_HOME 会把登录态也隔离掉；只在目标缺失时拷贝一次，后续由该 home 自己刷新。
  if (!existsSync(authDest) && existsSync(authSource)) {
    copyFileSync(authSource, authDest);
  }
  return { ...process.env, CODEX_HOME: codexHome };
}

async function ensureRepo(
  opts: BuiltinRunnerOptions,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (!opts.repo) return null;
  const repoDir = join(opts.workdir, "repo");
  const runGit = opts.runGit ?? defaultRunnerProcess;
  const args = existsSync(repoDir)
    ? ["git", "-C", repoDir, "pull", "--ff-only"]
    : ["git", "clone", opts.repo, repoDir];
  const res = await runGit(args, { cwd: opts.workdir, env });
  if (res.code !== 0) {
    appendRunnerLog(
      opts.workdir,
      `${new Date((opts.now ?? Date.now)()).toISOString()} repo_exit=${res.code} cmd=${args.join(" ")} stderr=${JSON.stringify(res.stderr.slice(0, 500))}`,
    );
  }
  return existsSync(repoDir) ? repoDir : null;
}

interface HarnessRun {
  result: RunnerProcessResult;
  text: string;
  sessionId: string | null;
  outFile?: string;
}

async function runHarness(
  opts: BuiltinRunnerOptions,
  prompt: string,
  sid: string | null,
  cwd: string,
  env: Record<string, string | undefined>,
  seq: number,
): Promise<HarnessRun> {
  const runProcess = opts.runProcess ?? defaultRunnerProcess;
  if (opts.harness === "codex") {
    const outFile = join(opts.workdir, `runner-${seq}-${Date.now()}.out`);
    const base = ["--skip-git-repo-check", "--sandbox", "workspace-write", "-o", outFile, prompt];
    const args = sid ? ["codex", "exec", "resume", sid, ...base] : ["codex", "exec", ...base];
    const result = await runProcess(args, { cwd, env });
    const text = result.code === 0 && existsSync(outFile) ? readFileSync(outFile, "utf8").trimEnd() : "";
    return { result, text, sessionId: sid ? sid : parseCodexSessionId(result.stdout), outFile };
  }

  const args = sid
    ? ["claude", "-p", "--resume", sid, prompt]
    : ["claude", "-p", "--output-format", "json", prompt];
  const result = await runProcess(args, { cwd, env });
  if (sid) return { result, text: result.stdout.trimEnd(), sessionId: sid };
  const parsed = parseClaudeJson(result.stdout);
  return { result, text: parsed.text.trimEnd(), sessionId: parsed.sessionId };
}

async function postBlocked(
  opts: BuiltinRunnerOptions,
  frame: MsgFrame,
  note: string,
): Promise<void> {
  await (opts.post ?? postMessage)(opts.server, opts.token, opts.channel, {
    kind: "status",
    state: "blocked",
    note,
    mentions: [],
    blocked_reason: note,
  });
}

export function createSdkRunner(opts: SdkRunnerOptions): NonNullable<ServeOptions["runCommand"]> {
  let codexPromise: Promise<CodexLike> | null = null;
  let thread: ThreadLike | null = null;
  let session: SdkWakeSessionState | null = null;
  let queue = Promise.resolve();

  const codex = (): Promise<CodexLike> => {
    codexPromise ??= Promise.resolve((opts.codexFactory ?? defaultCodexFactory)());
    return codexPromise;
  };

  const ensureThread = async (started: number): Promise<{ thread: ThreadLike; session: SdkWakeSessionState }> => {
    if (thread && session) return { thread, session };
    mkdirSync(opts.workdir, { recursive: true });
    const sessionPath = join(opts.workdir, RUNNER_SESSION_FILE);
    const prior = readSdkSession(sessionPath);
    const client = await codex();
    if (prior) {
      thread = await client.resumeThread(prior.thread_id);
      session = prior;
      return { thread, session };
    }
    thread = await client.startThread();
    const threadId = sdkThreadId(thread);
    session = {
      harness: "codex-sdk",
      thread_id: threadId,
      created_at: started,
      last_wake_ts: started,
      wakes: 0,
    };
    writeSdkSession(sessionPath, session);
    return { thread, session };
  };

  const handle = async (
    frame: MsgFrame,
    ctx: { cmd: string; channel: string; self: string; recent: MsgFrame[] },
  ): Promise<void> => {
    const started = opts.now?.() ?? Date.now();
    mkdirSync(opts.workdir, { recursive: true });
    const post = opts.post ?? postMessage;
    const sessionPath = join(opts.workdir, RUNNER_SESSION_FILE);

    await post(opts.server, opts.token, opts.channel, {
      kind: "status",
      state: "working",
      note: `wake ack: ${ctx.self} builtin codex-sdk runner handling seq=${frame.seq}`,
      mentions: [],
    });

    let threadId = session?.thread_id ?? null;
    try {
      const active = await ensureThread(started);
      threadId = active.session.thread_id;
      const result = await active.thread.run(sdkPrompt(frame, ctx.channel, ctx.self, ctx.recent), {
        sandbox: opts.sandbox ?? "full_access",
      });
      const body = finalText(result);
      const now = opts.now?.() ?? Date.now();
      session = {
        ...active.session,
        last_wake_ts: now,
        wakes: active.session.wakes + 1,
      };
      writeSdkSession(sessionPath, session);
      await post(opts.server, opts.token, opts.channel, {
        kind: "message",
        body,
        mentions: [],
        reply_to: frame.seq,
      });
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(threadId)} duration_ms=${now - started} status=ok`,
      );
    } catch (err) {
      const now = opts.now?.() ?? Date.now();
      const message = err instanceof Error ? err.message : String(err);
      if (session) {
        session = { ...session, last_wake_ts: now, wakes: session.wakes + 1 };
        writeSdkSession(sessionPath, session);
        threadId = session.thread_id;
      }
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(threadId)} duration_ms=${now - started} status=error error=${JSON.stringify(message.slice(0, 500))}`,
      );
      const note = `builtin codex-sdk runner blocked: ${message}; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`;
      await post(opts.server, opts.token, opts.channel, {
        kind: "status",
        state: "blocked",
        note,
        mentions: [],
        blocked_reason: note,
      });
    }
  };

  return (frame, ctx) => {
    const next = queue.then(() => handle(frame, ctx));
    queue = next.catch(() => {});
    return next;
  };
}

export function createBuiltinRunner(opts: BuiltinRunnerOptions): NonNullable<ServeOptions["runCommand"]> {
  return async (frame, ctx) => {
    const started = opts.now?.() ?? Date.now();
    mkdirSync(opts.workdir, { recursive: true });
    const env = opts.harness === "codex" ? prepareCodexHome(opts.workdir, opts.authSourceFile) : { ...process.env };
    const sessionPath = join(opts.workdir, RUNNER_SESSION_FILE);
    const prior = readSession(sessionPath, opts.harness);
    let oldSid = prior?.session_id ?? null;
    let forked = false;
    let exitCode: number | null = null;
    let finalSid = oldSid;
    const post = opts.post ?? postMessage;

    await post(opts.server, opts.token, opts.channel, {
      kind: "status",
      state: "working",
      note: `wake ack: ${ctx.self} builtin ${opts.harness} runner handling seq=${frame.seq}`,
      mentions: [],
    });

    const repoCwd = await ensureRepo(opts, env);
    const cwd = repoCwd ?? opts.workdir;
    const contextFile = writeContextFile(frame, ctx.channel, ctx.self, ctx.recent);
    const prompt = readFileSync(contextFile, "utf8");

    let run = await runHarness(opts, prompt, oldSid, cwd, env, frame.seq);
    exitCode = run.result.code;
    if (oldSid && run.result.code !== 0) {
      forked = true;
      run = await runHarness(opts, prompt, null, cwd, env, frame.seq);
      exitCode = run.result.code;
    }

    try {
      unlinkSync(contextFile);
    } catch {
      /* 保留失败的清理不影响唤醒结果 */
    }

    const now = opts.now?.() ?? Date.now();
    if (run.result.code !== 0) {
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(oldSid)} duration_ms=${now - started} exit=${run.result.code}`,
      );
      await postBlocked(
        opts,
        frame,
        `builtin ${opts.harness} runner blocked: exit code ${run.result.code}; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`,
      );
      return;
    }

    finalSid = run.sessionId;
    if (!finalSid) {
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=unknown duration_ms=${now - started} exit=${exitCode ?? 0} missing_session_id=true`,
      );
      await postBlocked(
        opts,
        frame,
        `builtin ${opts.harness} runner blocked: no session id parsed; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`,
      );
      return;
    }

    const wakes = prior && !forked ? prior.wakes + 1 : 1;
    writeSession(sessionPath, {
      harness: opts.harness,
      session_id: finalSid,
      created_at: prior && !forked ? prior.created_at : now,
      last_wake_ts: now,
      wakes,
    });

    const marker = oldSid
      ? forked
        ? `[session reset: ${shortSid(oldSid)} → ${shortSid(finalSid)}]`
        : null
      : `[session start: ${shortSid(finalSid)}]`;
    let body: string;
    try {
      body = finalMessageBody(run.text, marker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} attach_error=${JSON.stringify(message)}`,
      );
      await postBlocked(opts, frame, `builtin ${opts.harness} runner blocked: ${message}`);
      return;
    }
    await post(opts.server, opts.token, opts.channel, {
      kind: "message",
      body,
      mentions: [],
      reply_to: frame.seq,
    });

    appendRunnerLog(
      opts.workdir,
      `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} duration_ms=${now - started} exit=${exitCode ?? 0}` +
        (forked ? ` fork=${shortSid(oldSid)}->${shortSid(finalSid)}` : ""),
    );
  };
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export async function runServe(o: ServeOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.error(line));
  const run = o.runCommand ?? (o.sdkRunner ? createSdkRunner(o.sdkRunner) : o.builtinRunner ? createBuiltinRunner(o.builtinRunner) : defaultRun);
  const conn = connect(o.server, o.token, o.channel, o.since, {
    onCursor: o.onCursor,
    sinceRev: o.sinceRev,
    onRevCursor: o.onRevCursor,
  });

  let self = "";
  let code = 0;
  let advertised = false;
  // 触发消息之前的最近频道消息（滚动窗口），随 context file 递给 runner
  const recent: MsgFrame[] = [];
  out(
    `serving #${o.channel} — 每条${o.mentionsOnly ? " @你 的" : ""}消息触发一次命令（Ctrl-C 停）`,
  );
  try {
    for await (const frame of conn.frames) {
      if (frame.type === "welcome") {
        self = frame.self;
        // 挂上即声明可唤醒（best-effort，只做一次；重连再收 welcome 不重复刷）
        if (!advertised) {
          advertised = true;
          try {
            await o.advertise?.();
          } catch (e) {
            out(`  wake 能力声明失败（不影响服务，可稍后手动 party status 声明）: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        continue;
      }
      if (frame.type === "error") {
        console.error(`error: ${frame.code} ${frame.message}`);
        code =
          frame.code === "unauthorized"
            ? EXIT_AUTH
            : frame.code === "archived"
              ? EXIT_ARCHIVED
              : 1;
        break;
      }
      if (frame.type !== "msg") continue;
      const fromSelf = frame.sender.name === self;
      // fresh = 游标之上的新消息。历史修订快照会穿透去重被重放（seq 早已消费过），
      // 它们不是新唤醒——不 fresh 就绝不触发 runner（否则旧 @ 被编辑一次，每次重连都重跑一遍）
      const fresh = frame.seq > conn.cursor;
      const qualifies = fresh && !fromSelf && (!o.mentionsOnly || frame.mentions.includes(self));
      if (qualifies) {
        out(`▶ ${formatMsg(frame)}`);
        // 串行：本条命令跑完再消费下一帧（新帧此间缓冲在 FrameQueue），避免并发唤起互相抢
        try {
          await run(frame, { cmd: o.cmd, channel: o.channel, self, recent: recent.slice() });
        } catch (e) {
          out(`  命令失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // 触发消息本身不进 recent（它就是 context 主体）；自己的/未 @ 的都算上下文
      recent.push(frame);
      if (recent.length > RECENT_MAX) recent.shift();
      // 处理（或跳过）后才推进游标，退出时未消费的留给下次补拉
      conn.ack(frame.seq);
    }
  } finally {
    conn.close();
  }
  // 帧流意外结束（既非终局 error 也非用户 Ctrl-C）：常驻 supervisor 语义下这是异常终止。
  // 报机器可读原因 + 非零退出，否则 --on-mention supervisor 会像 watch --follow 一样静默消失（issue #29 同源）。
  if (code === 0) {
    out(`serve exited: stream ended unexpectedly`);
    return EXIT_STREAM_ENDED;
  }
  return code;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["all"] });
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, SERVE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "on-mention", "runner", "workdir", "repo"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cmd = str(flags["on-mention"]);
  const runner = str(flags.runner);
  if ((cmd ? 1 : 0) + (runner ? 1 : 0) !== 1) {
    console.error(
      'choose exactly one of --on-mention or --runner.\n' +
        '  自定义：--on-mention "<command>"（{file}=context JSON，正文在 stdin，元信息在 AP_*）。\n' +
        "  内建：--runner codex|claude|codex-sdk（自动隔离 workdir、续接 session、外层发回频道）。",
    );
    return 1;
  }
  if (runner && runner !== "codex" && runner !== "claude" && runner !== "codex-sdk") {
    console.error("--runner must be codex, claude, or codex-sdk");
    return 1;
  }
  const harness = runner === "codex" || runner === "claude" ? runner : undefined;
  const useSdkRunner = runner === "codex-sdk";
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  return runServe({
    server: auth.server,
    token: auth.token,
    channel,
    since: loadCursor(channel),
    sinceRev: loadRevCursor(channel),
    cmd: cmd ?? "",
    mentionsOnly: flags.all !== true,
    onCursor: (c) => saveCursor(channel, c),
    onRevCursor: (r) => saveRevCursor(channel, r),
    advertise: () => advertiseServeWake(auth, channel),
    builtinRunner: harness
      ? {
          server: auth.server,
          token: auth.token,
          channel,
          harness,
          workdir: expandHomePath(str(flags.workdir) ?? join(homedir(), ".agentparty", "runners", channel)),
          repo: str(flags.repo),
        }
      : undefined,
    sdkRunner: useSdkRunner
      ? {
          server: auth.server,
          token: auth.token,
          channel,
          workdir: expandHomePath(str(flags.workdir) ?? join(homedir(), ".agentparty", "runners", channel)),
        }
      : undefined,
  });
}
