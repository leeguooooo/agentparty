// party serve — 常驻监听频道，每条 @你 的消息触发一次本地命令，把「跑完就停的 session agent」
// 用外部 supervisor 唤醒（wake GOAL 的 session 型那半；有入站 URL 的 runtime 走 webhook）。
// 复用 client.connect 的自动重连帧流，真正常驻；命令串行执行（一条处理完再下一条，不并发抢跑）。
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_STREAM_ENDED, EXIT_UPGRADED, type MsgFrame } from "@agentparty/shared";
import { maybeReexecUpgrade, upgradeNotice, type CliUpgradeNotice, type UpgradeDeps } from "../upgrade";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readAccount } from "../account";
import { connect } from "../client";
import { clearStuck, loadCursor, loadRevCursor, loadStuck, resolveChannel, saveCursor, saveRevCursor, saveStuck, type StuckWake } from "../config";
import { formatMsg } from "../format";
import { ensureFreshAccess, resolveAuthDetailed, type ResolvedAuthDetailed } from "../oidc-cli";
import {
  clearStatuslineListener,
  heartbeatPatch,
  lastMessageFromFrame,
  localStatuslineBase,
  unreadFromCursor,
  writeStatuslineCache,
} from "../statusline-cache";
import { ensureProjectAgentChannelRuntime, fetchChannelCharter, listProjectAgentInvites, mintProjectAgentRuntimeToken, postMessage, RestError, type ChannelCharter, type ChannelProjectAgentInvite, type ProjectAgentChannelRuntime, type ProjectAgentProfile } from "../rest";
import { isName, isSlug } from "../validation";
import { buildContext } from "./status";

const PROTOCOL_REMINDER =
  "被 @ 唤起：先读本文件 charter 了解频道约定；若发现 charter 与频道现状矛盾，视为一个待办上报。需要更多上下文再 `party history <channel 字段的频道>`；需要产出结论时，先用 `party send --reply-to <seq>` 把 final synthesis 发回频道，再 status done；别只回本地。";

// 唤醒未送达（runner 非零退出 / 无 session id / SDK 抛错 / [attach] 被拒）。
// 四种 runner 统一抛它：调用方据此判断「这条 @ 没进过模型」，从而不推进游标。
export class WakeBlockedError extends Error {
  /**
   * 重试是否安全 —— 即**模型确定没有跑过**。
   * 抛出这个错并不能证明模型没运行：runner 非零退出、SDK 在 thread.run 之后写 session /
   * 发回复 / 写日志失败、custom runner 产生副作用后才退出，都会走到这里。
   * 那些情况下重跑 = 重复模型副作用（重复 git push、重复开 PR）。默认 false。
   * 只有「runner 根本没起来」（spawn 失败）才置 true。
   */
  readonly retriable: boolean;
  constructor(message: string, retriable = false) {
    super(message);
    this.name = "WakeBlockedError";
    this.retriable = retriable;
  }
}

// 放弃通告都发不出去（网络/loop guard 熔断）。此时既没送达也没宣告，继续跑就是静默丢 @。
export const EXIT_WAKE_UNANNOUNCED = 1;

/** 传给 builtin runner 的提示：只给路径，不给正文（#120）。 */
function wakePrompt(contextFile: string): string {
  return (
    `你在 AgentParty 频道里被 @ 了。唤醒上下文是一个 JSON 文件：${contextFile}\n` +
    `先读它（含 channel / seq / sender / body / mentions / charter / recent），再动手。\n` +
    `${PROTOCOL_REMINDER}`
  );
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 有界重放（#198）：同一条 seq 连续送达失败到顶就响亮放弃，既不无限重放也不静默丢弃
// env 里保留的正文上限。完整正文走 stdin 与 context file。
const AP_BODY_MAX = 4_000;

const DEFAULT_MAX_WAKE_ATTEMPTS = 3;
const DEFAULT_WAKE_RETRY_DELAY_MS = 500;

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
  cwd?: string;
  repo?: string;
  runProcess?: RunnerProcess;
  runGit?: RunnerProcess;
  authSourceFile?: string;
  now?: () => number;
  post?: typeof postMessage;
}

export interface ThreadLike {
  id?: string | null;
  thread_id?: string | null;
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

export interface ProjectAgentRunContext {
  owner_account: string;
  handle: string;
  name: string;
  runner: string;
  repo_url: string | null;
  workdir: string | null;
  base_branch: string;
  worktree_strategy: string;
  rules: string | null;
  channel_workdir: string;
  runner_workdir: string;
}

// 把一条 @mention 的完整上下文落成 JSON 文件，命令拿路径读——避开 env/stdin 的 shell quoting/注入，
// 也让 runner 能一次拿全 channel/seq/sender/body/reply_to/recent/protocol_reminder（评审建议）。
// recent = 触发消息之前、serve 在线期间看到的最近频道消息（含自己/未 @ 的闲聊，正文截断），
// 让冷起的 runner 开箱有上下文；完整脉络仍以 party history 为准。
function buildWakeContext(
  frame: MsgFrame,
  channel: string,
  self: string,
  recent: MsgFrame[],
  charter: ChannelCharter | null = null,
  projectAgent: ProjectAgentRunContext | null = null,
  cliUpgrade: CliUpgradeNotice | null = null,
) {
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
    charter: charter?.charter ?? null,
    charter_rev: charter?.charter_rev ?? 0,
    project_agent: projectAgent,
    cli_upgrade: cliUpgrade,
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

/**
 * 每个 serve 实例一个私有上下文目录（0700）。
 *
 * 不要把身份塞进文件名（PR #208 门禁）：那是**有损映射**——`tenant|alice` 与
 * `tenant/alice` 消毒后同名，仍会互相覆盖；文件名也没有 server / profile 维度，
 * 同时连 prod 与 test 私有部署时同频道同 seq 仍会串；长 IdP subject 还会 ENAMETOOLONG。
 * 私有目录一次性解决碰撞、跨部署、长度三件事：路径里压根不出现身份。
 */
export function createWakeContextDir(): string {
  return mkdtempSync(join(tmpdir(), "agentparty-serve-"), { encoding: "utf8" });
}

export function writeContextFile(
  dir: string,
  frame: MsgFrame,
  channel: string,
  self: string,
  recent: MsgFrame[],
  charter: ChannelCharter | null = null,
  projectAgent: ProjectAgentRunContext | null = null,
  cliUpgrade: CliUpgradeNotice | null = null,
): string {
  // dir 是本 serve 实例私有的（createWakeContextDir）。文件名只需 seq：同一次唤醒重复写得到
  // 同一路径（幂等），而不同实例——不同身份 / 不同 server / 不同 profile——各在各的目录里。
  const path = join(dir, `${frame.seq}.json`);
  writeFileSync(
    path,
    JSON.stringify(buildWakeContext(frame, channel, self, recent, charter, projectAgent, cliUpgrade), null, 2) + "\n",
    { mode: 0o600 },
  );
  return path;
}

const SERVE_FLAGS = ["channel", "on-mention", "all", "runner", "workdir", "repo", "auto-upgrade", "replay-backlog", "profile", "profile-once", "profile-poll-interval"];
const HELP = `usage: party serve [channel|--channel C] (--on-mention "<cmd>" | --runner codex|claude|codex-sdk) [--all]
       party serve --profile <owner>/<handle>

Stay attached to a channel and run one local command for each matching message.
The command can read the context JSON path from {file} or AP_CONTEXT_FILE.

Options:
  --channel C          serve channel C instead of the bound channel
  --on-mention "<cmd>" command to run for each wake
  --runner codex|claude|codex-sdk
                       use the built-in isolated wake runner instead of a custom command
  --workdir DIR        runner workdir (default: ~/.agentparty/runners/<channel>)
  --repo URL           clone into workdir/repo once, then git pull --ff-only before each wake
  --profile ref        run the reusable project-agent profile as one resident daemon across all invites
  --auto-upgrade       between wakes, if a newer party binary is on disk, re-exec it (issue #45)
  --replay-backlog     on attach, replay the offline backlog one wake per message
                       (default: skip the backlog, advance the cursor, and print
                       how many were skipped — serve wakes only for messages that
                       arrive AFTER it attaches, issue #193. An undelivered wake
                       (stuck, issue #198) is a debt, not backlog: it always replays.)
  --all                run for every non-self message, not only @mentions`;

export interface ServeOptions {
  server: string;
  token: string;
  channel: string;
  since: number;
  sinceRev?: number; // 修订游标（hello.since_rev）
  cmd: string;
  mentionsOnly: boolean;
  // 挂载时是否跳过离线积压（#193）。默认 true：serve 是唤醒 supervisor，不是补偿队列。
  // 但「积压」与「欠账」是两回事（#198）：跳过的只能是**已离线堆积、从未送达**的历史；
  // 送达失败被钉住的 stuck 无论多旧都必须重放，否则 #118 救下的那条 @ 会被这里吃掉。
  skipBacklog?: boolean;
  builtinRunner?: BuiltinRunnerOptions;
  onCursor?: (cursor: number) => void;
  onRevCursor?: (revCursor: number) => void;
  /** 上次进程留下的欠账（#198）：崩溃前失败了几次，重启后接着数。 */
  stuck?: StuckWake | null;
  onStuck?: (stuck: StuckWake | null) => void;
  /** 有界重放：同一条 seq 连续送达失败上限，到顶就响亮放弃。 */
  maxWakeAttempts?: number;
  wakeRetryDelayMs?: number;
  post?: typeof postMessage;
  // 测试注入点：默认用 sh -c 起子进程
  runCommand?: (
    frame: MsgFrame,
    ctx: {
      cmd: string;
      channel: string;
      self: string;
      /** 本 serve 实例私有的上下文目录（createWakeContextDir）。 */
      contextDir: string;
      recent: MsgFrame[];
      charter?: ChannelCharter | null;
      projectAgent?: ProjectAgentRunContext | null;
      cliUpgrade?: CliUpgradeNotice | null;
    },
  ) => Promise<void>;
  sdkRunner?: SdkRunnerOptions;
  // serve 挂上后声明自己「可被唤醒」的钩子；run() 注入真实实现，测试可省略/替换
  advertise?: () => Promise<void>;
  charter?: ChannelCharter | null;
  projectAgent?: ProjectAgentRunContext | null;
  fetchCharter?: () => Promise<ChannelCharter>;
  // 唤醒间隙发现磁盘装了更新的 party 就自动 re-exec 新版（issue #45）；默认只提示不动。
  autoUpgrade?: boolean;
  upgradeDeps?: UpgradeDeps; // 测试注入版本读取/re-exec
  out?: (line: string) => void;
  statusline?: boolean;
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
  ctx: {
    cmd: string;
    channel: string;
    self: string;
    contextDir: string;
    recent: MsgFrame[];
    charter?: ChannelCharter | null;
    projectAgent?: ProjectAgentRunContext | null;
    cliUpgrade?: CliUpgradeNotice | null;
  },
): Promise<void> {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  const file = writeContextFile(ctx.contextDir, frame, ctx.channel, ctx.self, ctx.recent, ctx.charter, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null);
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
      // env 也会被同一 unix 用户下的兄弟 agent 读到（`ps -E`），而「一机多 agent」是推荐拓扑。
      // 完整正文走 stdin（不进 ps）与 AP_CONTEXT_FILE（0700）；env 里只留一个可读的摘要。
      AP_BODY: body.length > AP_BODY_MAX ? body.slice(0, AP_BODY_MAX) : body,
      AP_BODY_TRUNCATED: body.length > AP_BODY_MAX ? "1" : "0",
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

function sdkPrompt(
  frame: MsgFrame,
  channel: string,
  self: string,
  recent: MsgFrame[],
  charter: ChannelCharter | null,
  projectAgent: ProjectAgentRunContext | null = null,
  cliUpgrade: CliUpgradeNotice | null = null,
): string {
  return JSON.stringify(buildWakeContext(frame, channel, self, recent, charter, projectAgent, cliUpgrade), null, 2) + "\n";
}

function sdkThreadId(thread: ThreadLike): string | null {
  // codex-sdk 在 run() 之前 thread id 可能还是 null（懒初始化），不能直接抛
  if (typeof thread.id === "string") return thread.id;
  if (typeof thread.thread_id === "string") return thread.thread_id;
  return null;
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
  const rawRunProcess = opts.runProcess ?? defaultRunnerProcess;
  // runProcess 自己抛 = 进程根本没起来（spawn ENOENT / 权限），模型确定没跑过 → 重试安全。
  // 一旦进程起来了（哪怕退出码非零），模型就可能已经产生副作用，重跑不安全。
  const runProcess: RunnerProcess = async (args, o2) => {
    try {
      return await rawRunProcess(args, o2);
    } catch (e) {
      throw new WakeBlockedError(
        `builtin ${opts.harness} runner did not start: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  };
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

export function createSdkRunner(opts: SdkRunnerOptions): NonNullable<ServeOptions["runCommand"]> {
  let codexPromise: Promise<CodexLike> | null = null;
  let thread: ThreadLike | null = null;
  let session: SdkWakeSessionState | null = null;
  let queue = Promise.resolve();

  const codex = (): Promise<CodexLike> => {
    codexPromise ??= Promise.resolve((opts.codexFactory ?? defaultCodexFactory)());
    return codexPromise;
  };

  const ensureThread = async (started: number): Promise<{ thread: ThreadLike; session: SdkWakeSessionState | null }> => {
    if (thread && session) return { thread, session };
    mkdirSync(opts.workdir, { recursive: true });
    const sessionPath = join(opts.workdir, RUNNER_SESSION_FILE);
    const prior = readSdkSession(sessionPath);
    // 这一段全在 thread.run() **之前**：连不上 SDK、拿不到 thread —— 模型确定还没跑。
    // 这类失败标为可重试（EAI_AGAIN 这种瞬态抖动，第二次就成了）。
    // thread.run() 之后的任何失败都不可重试（模型可能已经跑过、已经产生副作用）。
    const beforeModel = async <T>(fn: () => Promise<T> | T): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        throw new WakeBlockedError(
          `builtin codex-sdk runner blocked before the model started: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
    };
    const client = await beforeModel(() => codex());
    if (prior) {
      thread = await beforeModel(() => client.resumeThread(prior.thread_id));
      session = prior;
      return { thread, session };
    }
    thread = await beforeModel(() => client.startThread());
    const threadId = sdkThreadId(thread);
    // thread id 懒初始化：拿不到就先不落 session 文件，等首个 run() 之后补写
    session = threadId
      ? {
          harness: "codex-sdk",
          thread_id: threadId,
          created_at: started,
          last_wake_ts: started,
          wakes: 0,
        }
      : null;
    if (session) writeSdkSession(sessionPath, session);
    return { thread, session };
  };

  const handle = async (
    frame: MsgFrame,
    ctx: {
      cmd: string;
      channel: string;
      self: string;
      recent: MsgFrame[];
      charter?: ChannelCharter | null;
      projectAgent?: ProjectAgentRunContext | null;
      cliUpgrade?: CliUpgradeNotice | null;
    },
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
      const result = await active.thread.run(sdkPrompt(frame, ctx.channel, ctx.self, ctx.recent, ctx.charter ?? null, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null), {
        sandbox: opts.sandbox ?? "full_access",
      });
      // run() 之后 thread id 一定就位；懒初始化的 session 在这里补建
      threadId = active.session?.thread_id ?? sdkThreadId(active.thread);
      if (!threadId) throw new Error("@openai/codex-sdk thread did not expose an id/thread_id after run");
      const body = finalText(result);
      const now = opts.now?.() ?? Date.now();
      const baseSession = active.session ?? {
        harness: "codex-sdk" as const,
        thread_id: threadId,
        created_at: started,
        last_wake_ts: started,
        wakes: 0,
      };
      session = {
        ...baseSession,
        last_wake_ts: now,
        wakes: baseSession.wakes + 1,
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
      // 同上：只回报失败，最终 blocked 由 runServe 统一发一次。
      // 模型前的失败（ensureThread 抛的 WakeBlockedError.retriable=true）必须把可重试性
      // 透传出去，否则一次 EAI_AGAIN 就被当成「模型可能跑过」而立刻放弃（#206 门禁 P1③）。
      const retriable = err instanceof WakeBlockedError && err.retriable;
      throw new WakeBlockedError(
        `builtin codex-sdk runner blocked: ${message}; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`,
        retriable,
      );
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
    const cwd = opts.cwd ?? repoCwd ?? opts.workdir;
    const contextFile = writeContextFile(ctx.contextDir, frame, ctx.channel, ctx.self, ctx.recent, ctx.charter ?? null, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null);
    // 绝不把 context JSON 当 argv 传（#120）：argv 对同机任意用户可见（`ps -axww`），
    // 一条私有频道消息的正文、charter、最近 20 条上下文就全泄漏了。
    // 只传 0700 私有目录里的文件路径——protocol_reminder 本来就叫模型「先读本文件」。
    //
    // 顺带证伪 issue 里「大消息 E2BIG」那半：macOS 上 argv 单条到 ~2MB 才 E2BIG，
    // 而最坏 context ≈ 230KB（BODY_LIMIT 100KB + CHARTER_LIMIT 16KB + recent 20×400B）。
    // 当前限额下炸不了；真正当下就成立的是上面这条泄漏。
    const prompt = wakePrompt(contextFile);

    // resume 非零退出**不能**再 cold-start 重跑（#206 门禁 P1②）：
    // 那次 resume 可能已经执行了模型、push 过、开过 PR，只是最后一步非零。
    // 内部 fallback 会绕过外层的 retriable=false，把副作用做第二遍。
    // 只有能**结构化证明模型没启动**的错误才允许换新 session——目前没有这样的信号，
    // 所以一律停在这里，由外层宣告放弃。
    const run = await runHarness(opts, prompt, oldSid, cwd, env, frame.seq);
    exitCode = run.result.code;

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
      // 只回报失败信号，不发频道：外层还要重试，瞬态失败不该把频道标成 blocked，
      // 每次尝试发一条更会给 loop guard 上膛（worker/src/do.ts:2582 对 status 也计数）。
      // 最终那一条 blocked 由 runServe 在预算耗尽时统一发（#206 门禁 P1②）。
      throw new WakeBlockedError(`builtin ${opts.harness} runner blocked: exit code ${run.result.code}; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`);
    }

    finalSid = run.sessionId;
    if (!finalSid) {
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=unknown duration_ms=${now - started} exit=${exitCode ?? 0} missing_session_id=true`,
      );
      throw new WakeBlockedError(`builtin ${opts.harness} runner blocked: no session id parsed; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`);
    }

    const wakes = prior ? prior.wakes + 1 : 1;
    writeSession(sessionPath, {
      harness: opts.harness,
      session_id: finalSid,
      created_at: prior ? prior.created_at : now,
      last_wake_ts: now,
      wakes,
    });

    // resume 非零不再 cold-start（#206 门禁 P1②），所以不存在 session reset 这条路径了。
    const marker = oldSid ? null : `[session start: ${shortSid(finalSid)}]`;
    let body: string;
    try {
      body = finalMessageBody(run.text, marker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} attach_error=${JSON.stringify(message)}`,
      );
      throw new WakeBlockedError(`builtin ${opts.harness} runner blocked: ${message}`);
    }
    await post(opts.server, opts.token, opts.channel, {
      kind: "message",
      body,
      mentions: [],
      reply_to: frame.seq,
    });

    appendRunnerLog(
      opts.workdir,
      `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} duration_ms=${now - started} exit=${exitCode ?? 0}`,
    );
  };
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function safeSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "agent";
}

function parseProfileRef(input: string | undefined): { owner: string; handle: string } | null {
  if (!input) return null;
  const slash = input.lastIndexOf("/");
  if (slash <= 0 || slash === input.length - 1) return null;
  const owner = input.slice(0, slash);
  const handle = input.slice(slash + 1);
  if (owner.length > 320 || /[\x00-\x1f\x7f]/.test(owner) || !isName(handle)) return null;
  return { owner, handle };
}

export interface PreparedProfileWorkspace {
  runnerWorkdir: string;
  channelWorkdir: string;
}

export interface PrepareProfileWorkspaceOptions {
  profile: ProjectAgentProfile;
  channel: string;
  runGit?: RunnerProcess;
  env?: Record<string, string | undefined>;
}

export async function prepareProfileChannelWorkspace(opts: PrepareProfileWorkspaceOptions): Promise<PreparedProfileWorkspace> {
  const root = join(
    homedir(),
    ".agentparty",
    "project-agents",
    safeSegment(opts.profile.owner_account),
    safeSegment(opts.profile.handle),
  );
  const runnerWorkdir = join(root, "sessions", safeSegment(opts.channel));
  mkdirSync(runnerWorkdir, { recursive: true });
  const runGit = opts.runGit ?? defaultRunnerProcess;
  const env = opts.env ?? process.env;

  if (opts.profile.worktree_strategy !== "branch") {
    const channelWorkdir =
      opts.profile.worktree_strategy === "shared" && opts.profile.workdir
        ? expandHomePath(opts.profile.workdir)
        : runnerWorkdir;
    mkdirSync(channelWorkdir, { recursive: true });
    return { runnerWorkdir, channelWorkdir };
  }

  const baseDir = opts.profile.workdir ? expandHomePath(opts.profile.workdir) : join(root, "source");
  if (!existsSync(baseDir)) {
    if (!opts.profile.repo_url) {
      mkdirSync(baseDir, { recursive: true });
    } else {
      mkdirSync(join(root, "source-parent"), { recursive: true });
      const clone = await runGit(["git", "clone", opts.profile.repo_url, baseDir], { cwd: root, env });
      if (clone.code !== 0) {
        throw new Error(`git clone failed for project agent profile: ${clone.stderr || clone.stdout}`);
      }
    }
  }

  const worktreeDir = join(root, "worktrees", safeSegment(opts.channel));
  if (!existsSync(worktreeDir) && existsSync(join(baseDir, ".git"))) {
    mkdirSync(join(root, "worktrees"), { recursive: true });
    const branch = `agentparty/${safeSegment(opts.profile.handle)}/${safeSegment(opts.channel)}`;
    const added = await runGit(["git", "-C", baseDir, "worktree", "add", "-B", branch, worktreeDir, opts.profile.base_branch], {
      cwd: root,
      env,
    });
    if (added.code !== 0) {
      throw new Error(`git worktree add failed for #${opts.channel}: ${added.stderr || added.stdout}`);
    }
  } else if (!existsSync(worktreeDir)) {
    mkdirSync(worktreeDir, { recursive: true });
  }
  return { runnerWorkdir, channelWorkdir: worktreeDir };
}

/**
 * profile 子 serve 继承的语义（#206 门禁 P2）。
 * `--profile --replay-backlog` 原本被 parseArgs 接受，却没传给子 serve：
 * 用户明确要求重放，profile 模式下却静默跳过——flag 接受了但不起作用。
 */
export function profileChildServeOptions(base: {
  server: string;
  token: string;
  channel: string;
  mentionsOnly: boolean;
  skipBacklog?: boolean;
}): Pick<ServeOptions, "server" | "token" | "channel" | "mentionsOnly" | "skipBacklog"> {
  return {
    server: base.server,
    token: base.token,
    channel: base.channel,
    mentionsOnly: base.mentionsOnly,
    ...(base.skipBacklog === undefined ? {} : { skipBacklog: base.skipBacklog }),
  };
}

export interface ProfileServeOptions {
  /** 由 --replay-backlog 决定；透传给每个频道的子 serve。 */
  skipBacklog?: boolean;
  server: string;
  humanToken: string;
  ownerAccount: string;
  handle: string;
  mentionsOnly: boolean;
  once?: boolean;
  pollIntervalMs?: number;
  out?: (line: string) => void;
  runGit?: RunnerProcess;
  mintRuntime?: typeof mintProjectAgentRuntimeToken;
  listInvites?: typeof listProjectAgentInvites;
  ensureChannelRuntime?: typeof ensureProjectAgentChannelRuntime;
  runChannelServe?: (opts: ServeOptions) => Promise<number>;
  post?: typeof postMessage;
  sleep?: (ms: number) => Promise<void>;
}

function profileContext(profile: ProjectAgentProfile, prepared: PreparedProfileWorkspace): ProjectAgentRunContext {
  return {
    owner_account: profile.owner_account,
    handle: profile.handle,
    name: profile.name,
    runner: profile.runner,
    repo_url: profile.repo_url,
    workdir: profile.workdir,
    base_branch: profile.base_branch,
    worktree_strategy: profile.worktree_strategy,
    rules: profile.rules,
    channel_workdir: prepared.channelWorkdir,
    runner_workdir: prepared.runnerWorkdir,
  };
}

function checksum(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function projectAgentChildName(handle: string, channel: string): string {
  const cleanHandle = safeSegment(handle).replace(/^[^A-Za-z0-9]+/, "") || "agent";
  const cleanChannel = safeSegment(channel).replace(/^[^A-Za-z0-9]+/, "") || "channel";
  const suffix = checksum(`${handle}/${channel}`);
  return `${cleanHandle.slice(0, 24)}-${cleanChannel.slice(0, 24)}-${suffix}`.slice(0, 64);
}

function profileReadyNote(profile: ProjectAgentProfile, channel: string, prepared: PreparedProfileWorkspace): string {
  const project = profile.repo_url ?? profile.workdir ?? "local";
  return `front agent ready: ${profile.owner_account}/${profile.handle} channel=#${channel} team=${profile.handle} project=${project} base=${profile.base_branch} worktree=${profile.worktree_strategy} cwd=${prepared.channelWorkdir}`;
}

export async function runProfileServe(opts: ProfileServeOptions): Promise<number> {
  const out = opts.out ?? ((line: string) => console.error(line));
  const mintRuntime = opts.mintRuntime ?? mintProjectAgentRuntimeToken;
  const listInvites = opts.listInvites ?? listProjectAgentInvites;
  const ensureChannelRuntime = opts.ensureChannelRuntime ?? ensureProjectAgentChannelRuntime;
  const runChannelServe = opts.runChannelServe ?? runServe;
  const post = opts.post ?? postMessage;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runtime = await mintRuntime(opts.server, opts.humanToken, opts.handle);
  const profile = runtime.profile;
  if (profile.owner_account !== opts.ownerAccount || profile.handle !== opts.handle) {
    throw new Error(`profile token mismatch: requested ${opts.ownerAccount}/${opts.handle}, got ${profile.owner_account}/${profile.handle}`);
  }
  const running = new Map<string, Promise<number>>();
  out(`serving project agent ${profile.owner_account}/${profile.handle} — runner=${profile.runner}`);

  const startInvite = async (invite: ChannelProjectAgentInvite) => {
    const channel = invite.channel_slug;
    if (running.has(channel)) return;
    const prepared = await prepareProfileChannelWorkspace({ profile, channel, runGit: opts.runGit });
    const ctx = profileContext(profile, prepared);
    const child: ProjectAgentChannelRuntime = await ensureChannelRuntime(
      opts.server,
      runtime.token,
      channel,
      profile.owner_account,
      profile.handle,
      projectAgentChildName(profile.handle, channel),
    );
    const serveOpts: ServeOptions = {
      ...profileChildServeOptions({
        server: opts.server,
        token: child.token,
        channel,
        mentionsOnly: opts.mentionsOnly,
        skipBacklog: opts.skipBacklog,
      }),
      server: opts.server,
      token: child.token,
      channel,
      since: loadCursor(channel),
      stuck: loadStuck(channel),
      onStuck: (st) => (st === null ? clearStuck(channel) : saveStuck(channel, st)),
      sinceRev: loadRevCursor(channel),
      cmd: "",
      mentionsOnly: opts.mentionsOnly,
      onCursor: (c) => saveCursor(channel, c),
      onRevCursor: (r) => saveRevCursor(channel, r),
      projectAgent: ctx,
      advertise: async () => {
        const note = profileReadyNote(profile, channel, prepared);
        await post(opts.server, child.token, channel, {
          kind: "status",
          state: "waiting",
          role: "host",
          note,
          mentions: [],
          residency: "supervised",
          wake: { kind: "serve" },
          context: {
            workspace_label: `${profile.owner_account}/${profile.handle}`,
            worktree_label: `${child.name}:${profile.worktree_strategy}:${profile.base_branch}`,
          },
        });
        await post(opts.server, child.token, channel, {
          kind: "message",
          body: `${profile.name || profile.handle} joined #${channel} as front agent ${child.name}; workers should spawn under team ${profile.handle}. ${note}`,
          mentions: [],
          reply_to: null,
        });
      },
      fetchCharter: () => fetchChannelCharter(opts.server, child.token, channel),
      builtinRunner: profile.runner === "codex" || profile.runner === "claude"
        ? {
            server: opts.server,
            token: child.token,
            channel,
            harness: profile.runner,
            workdir: prepared.runnerWorkdir,
            cwd: prepared.channelWorkdir,
          }
        : undefined,
      sdkRunner: profile.runner === "codex-sdk"
        ? {
            server: opts.server,
            token: child.token,
            channel,
            workdir: prepared.runnerWorkdir,
          }
        : undefined,
    };
    if (profile.runner === "shell") {
      throw new Error("project agent runner shell is not supported by party serve --profile");
    }
    const promise = runChannelServe(serveOpts).finally(() => running.delete(channel));
    running.set(channel, promise);
    out(`attached project agent ${profile.owner_account}/${profile.handle} to #${channel}`);
  };

  // 控制面必须比数据面更耐操（#115）：一次 DNS 抖动 / 5xx / 单频道 clone 失败，都不该
  // 拖死整个 daemon 和它已经挂上的其它频道。数据面的 ws 早就有指数退避，这里补齐。
  const basePollMs = opts.pollIntervalMs ?? 5000;
  const maxBackoffMs = 5 * 60_000;
  let consecutiveFailures = 0;

  for (;;) {
    try {
      const invites = await listInvites(opts.server, runtime.token, opts.handle);
      // 单个 invite 起不来（clone 失败、token 铸不出）不连坐其它频道
      for (const invite of invites) {
        try {
          await startInvite(invite);
        } catch (err) {
          out(`failed to attach #${invite.channel_slug}: ${errText(err)} (will retry next poll)`);
        }
      }
      consecutiveFailures = 0;
    } catch (err) {
      // 401/403 是终局：token 被撤或无权，重试只会刷日志（同 watch 的 EXIT_AUTH 语义）
      if (err instanceof RestError && (err.status === 401 || err.status === 403)) throw err;
      consecutiveFailures += 1;
      const backoff = Math.min(basePollMs * 2 ** (consecutiveFailures - 1), maxBackoffMs);
      out(`invite poll failed (${consecutiveFailures}x): ${errText(err)}; retrying in ${Math.round(backoff / 1000)}s`);
      if (opts.once) throw err;
      await sleep(backoff);
      continue;
    }
    if (opts.once) {
      await Promise.all([...running.values()]);
      return 0;
    }
    await sleep(basePollMs);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runServe(o: ServeOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.error(line));
  const run = o.runCommand ?? (o.sdkRunner ? createSdkRunner(o.sdkRunner) : o.builtinRunner ? createBuiltinRunner(o.builtinRunner) : defaultRun);
  let upgraded = false;
  let nudgedUpgrade = false;
  const conn = connect(o.server, o.token, o.channel, o.since, {
    onCursor: o.onCursor,
    sinceRev: o.sinceRev,
    onRevCursor: o.onRevCursor,
  });

  const skipBacklog = o.skipBacklog !== false; // 默认跳过离线积压（#193）
  // 本实例私有的上下文命名空间（#197 / #208 门禁）。退出时整目录删除：
  // 失败的唤醒会把上下文留在盘上供本次排查，但它带着 charter / recent 正文，
  // 不能在进程结束后继续躺在共享 tmpdir 里。
  const contextDir = createWakeContextDir();
  // 挂载那一刻的频道水位（welcome.last_seq），只在首个 welcome 记一次。
  let attachHead: number | null = null;
  let self = "";
  // 欠账（#198）：这条 @ 送达失败、从没进过模型。跨进程持久，重启后接着数重试次数。
  let stuck: StuckWake | null = o.stuck ?? null;
  const maxAttempts = Math.max(1, o.maxWakeAttempts ?? DEFAULT_MAX_WAKE_ATTEMPTS);
  const retryDelayMs = o.wakeRetryDelayMs ?? DEFAULT_WAKE_RETRY_DELAY_MS;
  const setStuck = (next: StuckWake | null) => {
    stuck = next;
    o.onStuck?.(next);
  };
  let code = 0;
  let advertised = false;
  let charter: ChannelCharter | null = o.charter ?? null;
  const refreshCharter = async (reason: string, expectedRev?: number) => {
    if (!o.fetchCharter) return;
    if (expectedRev !== undefined && charter !== null && charter.charter_rev >= expectedRev) return;
    try {
      charter = await o.fetchCharter();
    } catch (e) {
      out(`  charter 刷新失败（${reason}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await refreshCharter("attach");
  // 触发消息之前的最近频道消息（滚动窗口），随 context file 递给 runner
  const recent: MsgFrame[] = [];
  out(
    `serving #${o.channel} — 每条${o.mentionsOnly ? " @你 的" : ""}消息触发一次命令（Ctrl-C 停）`,
  );
  // Heartbeat on a clock, not only on traffic — see watch.ts; a quiet channel
  // must not read as "listener down" on status bars.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (o.statusline === true) {
    heartbeat = setInterval(() => {
      writeStatuslineCache({
        ...localStatuslineBase(o.channel),
        ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
      });
    }, 60_000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }
  try {
    for await (const frame of conn.frames) {
      if (frame.type === "welcome") {
        self = frame.self;
        // 首个 welcome：定格挂载水位，并就积压去留告知（stderr）。知情权给 agent，决定权给人。
        if (attachHead === null) {
          attachHead = frame.last_seq;
          const pending = Math.max(0, attachHead - o.since);
          if (pending > 0) {
            const range = `seq ${o.since + 1}..${attachHead}`;
            const debt = stuck !== null && stuck.seq <= attachHead ? ` 欠账 seq=${stuck.seq} 不在跳过之列，将重放（#198）。` : "";
            out(
              skipBacklog
                ? `serve: 跳过 ${pending} 条离线积压（${range}）——不逐条唤醒 runner。${debt}` +
                    ` 查看：party history ${o.channel}；要逐条重放请重启并加 --replay-backlog`
                : `serve: --replay-backlog：将逐条重放 ${pending} 条离线积压（${range}），每条唤醒一次 runner（可能重放副作用）`,
            );
          }
        }
        if (o.statusline === true) {
          writeStatuslineCache({
            ...localStatuslineBase(o.channel),
            ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
            unread: unreadFromCursor(frame.last_seq, o.channel),
          });
        }
        if (typeof frame.charter_rev === "number") await refreshCharter("welcome", frame.charter_rev);
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
      if (
        (frame.type === "msg" || frame.type === "status") &&
        frame.kind === "status" &&
        (frame.note ?? frame.body).startsWith("charter updated to rev ")
      ) {
        const rev = Number((frame.note ?? frame.body).match(/^charter updated to rev (\d+)/)?.[1] ?? "");
        await refreshCharter("status", Number.isInteger(rev) ? rev : undefined);
      }
      if (frame.type !== "msg") continue;
      const fromSelf = frame.sender.name === self;
      // fresh = 游标之上的新消息。历史修订快照会穿透去重被重放（seq 早已消费过），
      // 它们不是新唤醒——不 fresh 就绝不触发 runner（否则旧 @ 被编辑一次，每次重连都重跑一遍）
      const fresh = frame.seq > conn.cursor;
      // 欠账（#198）先于**一切**过滤条件。它送达失败过、从没进过模型——欠着就是欠着，
      // 与当前是不是 mentions-only、是不是积压无关。
      // 反例（190-codex-dev on PR #206）：--all 下一条非 mention 失败留下欠账，重启回默认
      // mentions-only 后 qualifies=false → 不重试、不清欠账、却无条件 ack 越过它。
      const isDebt = stuck !== null && frame.seq === stuck.seq;
      const isBacklog = skipBacklog && attachHead !== null && frame.seq <= attachHead;
      const passesFilter = !fromSelf && !isBacklog && (!o.mentionsOnly || frame.mentions.includes(self));
      // 欠账未了结时，**后续的任何消息都不许先跑**（#206 门禁 P1①）。
      // 反例：cursor=3、欠账 seq=4、head=6 未重放它、新 seq=7 进来 → 旧实现跑了 7、
      // 把游标推到 7，并在成功路径上无条件 setStuck(null)，把 seq=4 的欠账顺手清掉。
      // 欠着的那条必须先还：要么被重放并了结，要么有界重试耗尽后宣告放弃。
      const blockedByDebt = stuck !== null && !isDebt;
      const qualifies = fresh && !blockedByDebt && (isDebt || passesFilter);
      if (qualifies) {
        out(`▶ ${formatMsg(frame)}`);
        // 串行：本条命令跑完再消费下一帧（新帧此间缓冲在 FrameQueue），避免并发唤起互相抢
        // 有界重试（#198）：同一条 seq 最多 maxAttempts 次。前一个进程崩在第 k 次，这里从 k 接着数。
        const priorAttempts = stuck?.seq === frame.seq ? stuck.attempts : 0;
        // 崩溃在「最后一次失败落盘」与「最终通告」之间时，这里循环一次都不跑，
        // lastError 必须从盘上接手，否则最终通告里的错误原因是空字符串（门禁 P2）。
        let lastError = (stuck?.seq === frame.seq ? stuck.last_error : "") ?? "";
        let delivered = false;
        let retriable = true;
        for (let attempt = priorAttempts + 1; attempt <= maxAttempts && retriable; attempt++) {
          try {
            const cliUpgrade = upgradeNotice(o.autoUpgrade === true, o.upgradeDeps);
            await run(frame, {
              cmd: o.cmd,
              channel: o.channel,
              self,
              contextDir,
              recent: recent.slice(),
              charter,
              projectAgent: o.projectAgent ?? null,
              cliUpgrade,
            });
            delivered = true;
            break;
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            // 抛错不等于「模型没跑过」。只有 runner 明确声明可重试（spawn 都没成功）才重试；
            // 否则重跑会重复模型与外部副作用（git push / 开 PR）。见门禁 P1③。
            retriable = e instanceof WakeBlockedError ? e.retriable : false;
            if (!retriable) lastError += " (not retriable: model may have run)";
            out(`  命令失败 (${attempt}/${maxAttempts}): ${lastError}`);
            // 先落盘再重试：此刻进程崩掉，重启后不会把已经烧掉的次数忘干净
            setStuck({ seq: frame.seq, attempts: attempt, last_error: lastError });
            if (retriable && attempt < maxAttempts && retryDelayMs > 0) await delay(retryDelayMs);
          }
        }
        if (delivered) {
          // 只清**本帧**的欠账。别的 seq 的欠账不是它能了结的（#206 门禁 P1①）。
          //
          // 注意不能写成 `if (isDebt)`：isDebt 是进入本帧时算的，而重试过程中
          // setStuck 会把 stuck 设成本帧 —— 那时 isDebt 仍是 false，欠账就清不掉了。
          // （我试过，被「transient failure is retried」和「each failed attempt
          // persists stuck」两条既有测试当场逮住。）
          //
          // 这里的 seq 校验在当前 blockedByDebt 守卫之下**不可达**（变异掉它零条测试变红）。
          // 它是第二道闸：一旦有人放宽 blockedByDebt，这行会挡住「A 的成功清掉 B 的欠账」。
          // 不删，理由写在这里。
          if (stuck !== null && stuck.seq === frame.seq) setStuck(null);
        } else {
          // 有界重放到顶：显式放弃，但必须响亮留痕——静默丢弃正是 #118 要修的东西。
          // 没有 CLI flag，所以重试预算与退避必须**在频道里可见**：把常数藏进源码是不诚实的。
          const note =
            `wake undelivered, giving up: seq=${frame.seq}; ` +
            `attempts=${maxAttempts}/${maxAttempts}; retry_delay_ms=${retryDelayMs}; ` +
            `last error: ${lastError}`;
          out(`  ${note}`);
          try {
            await (o.post ?? postMessage)(o.server, o.token, o.channel, {
              kind: "status",
              state: "blocked",
              note,
              mentions: [],
              blocked_reason: note,
            });
          } catch (e) {
            // 通告发不出去 = 没宣告过 = 没了结。此时清欠账 + ack 就是恢复 #118 的静默丢失。
            // 一个连自己喊不出救命的 supervisor，没有任何理由继续消费消息队列：响亮地死，让人发现。
            out(`  放弃通告发送失败，欠账保留、游标不动、退出: ${e instanceof Error ? e.message : String(e)}`);
            code = EXIT_WAKE_UNANNOUNCED;
            break;
          }
          setStuck(null); // 放弃也是一种「了结」：宣告过了，才允许推进游标
        }
      }
      // 触发消息本身不进 recent（它就是 context 主体）；自己的/未 @ 的都算上下文
      recent.push(frame);
      if (recent.length > RECENT_MAX) recent.shift();
      // 游标只表达「已了结」（#198）：送达成功，或有界重试耗尽后**宣告过**的放弃。
      // 欠账未了结时游标绝不越过它——否则那条 @ 永远不会再被重放。
      //
      // 我曾断言这个守卫是死代码（有界重试后 stuck 恒为 null），并请门禁证伪。
      // 190-codex-dev 找到了反例：欠账那一帧若被 mentionsOnly / fromSelf 过滤掉，
      // stuck 就活着走到这里。守卫不是死的——是我的推理漏了过滤路径。
      if (stuck === null || frame.seq < stuck.seq) conn.ack(frame.seq);
      if (o.statusline === true) {
        writeStatuslineCache({
          ...localStatuslineBase(o.channel),
          ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
          unread: unreadFromCursor(frame.seq, o.channel),
          last_message: lastMessageFromFrame(frame),
        });
      }

      // 唤醒间隙的安全点：磁盘上的 party 二进制被 install.sh 换新了吗（issue #45）？
      // 此刻上一轮已 ack、游标已落盘、无进行中的 runner——re-exec 干净。--auto-upgrade 直接换，
      // 否则只播一次提示（不刷屏）。dev / 版本未变 → maybeReexecUpgrade 返回 pending=null，无副作用。
      const up = maybeReexecUpgrade(o.autoUpgrade === true, o.upgradeDeps);
      if (up.reexeced) {
        out(`serve: 磁盘已装 party v${up.pending}，已启动新版接管，本进程退出（issue #45）`);
        upgraded = true;
        break;
      }
      if (up.pending && !nudgedUpgrade) {
        nudgedUpgrade = true;
        out(`serve: 磁盘已装 party v${up.pending}（当前跑的是旧版）——重启 serve 或加 --auto-upgrade 以采用`);
      }
    }
  } finally {
    // 私有目录里躺着 charter / recent 正文。失败的唤醒把它留到本次排查结束，
    // 但绝不在进程退出后继续留在共享 tmpdir 里（#208 门禁 P2）。
    rmSync(contextDir, { recursive: true, force: true });
    if (heartbeat) clearInterval(heartbeat);
    conn.close();
    if (o.statusline === true) clearStatuslineListener();
  }
  if (upgraded) return EXIT_UPGRADED;
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
  const { positionals, flags } = parseArgs(argv, { booleans: ["all", "auto-upgrade", "replay-backlog", "profile-once"] });
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const server = auth.server;
  const token = auth.token;
  const unknown = unknownFlagError(flags, SERVE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "on-mention", "runner", "workdir", "repo", "profile", "profile-poll-interval"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cmd = str(flags["on-mention"]);
  const runner = str(flags.runner);
  const profileRef = parseProfileRef(str(flags.profile));
  if (flags.profile !== undefined && !profileRef) {
    console.error("profile must be <owner>/<handle>");
    return 1;
  }
  if (profileRef) {
    if (cmd || runner || str(flags.channel) || positionals[0]) {
      console.error("party serve --profile cannot be combined with channel, --on-mention, or --runner");
      return 1;
    }
    const sess = readAccount();
    if (!sess) {
      console.error("party serve --profile requires a human login; run party login");
      return 1;
    }
    let account;
    try {
      account = await ensureFreshAccess(sess);
    } catch {
      console.error("party serve --profile requires a fresh human login; run party login");
      return 1;
    }
    const pollFlag = str(flags["profile-poll-interval"]);
    const pollIntervalMs = pollFlag === undefined ? undefined : Number(pollFlag);
    if (pollIntervalMs !== undefined && (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 500)) {
      console.error("--profile-poll-interval must be an integer >= 500 milliseconds");
      return 1;
    }
    return runProfileServe({
      server: account.session.server,
      humanToken: account.token,
      ownerAccount: profileRef.owner,
      handle: profileRef.handle,
      mentionsOnly: flags.all !== true,
      skipBacklog: flags["replay-backlog"] !== true,
      once: flags["profile-once"] === true,
      pollIntervalMs,
    });
  }
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
    server,
    token,
    channel,
    since: loadCursor(channel),
    stuck: loadStuck(channel),
    onStuck: (st) => (st === null ? clearStuck(channel) : saveStuck(channel, st)),
    sinceRev: loadRevCursor(channel),
    cmd: cmd ?? "",
    mentionsOnly: flags.all !== true,
    skipBacklog: flags["replay-backlog"] !== true, // 默认跳过积压；--replay-backlog 才重放（#193）
    onCursor: (c) => saveCursor(channel, c),
    onRevCursor: (r) => saveRevCursor(channel, r),
    advertise: () => advertiseServeWake(auth, channel),
    fetchCharter: () => fetchChannelCharter(server, token, channel),
    autoUpgrade: flags["auto-upgrade"] === true,
    statusline: true,
    builtinRunner: harness
      ? {
          server,
          token,
          channel,
          harness,
          workdir: expandHomePath(str(flags.workdir) ?? join(homedir(), ".agentparty", "runners", channel)),
          repo: str(flags.repo),
        }
      : undefined,
    sdkRunner: useSdkRunner
      ? {
          server,
          token,
          channel,
          workdir: expandHomePath(str(flags.workdir) ?? join(homedir(), ".agentparty", "runners", channel)),
        }
      : undefined,
  });
}
