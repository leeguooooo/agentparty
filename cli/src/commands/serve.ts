// party serve — 常驻监听频道，每条 @你 的消息触发一次本地命令，把「跑完就停的 session agent」
// 用外部 supervisor 唤醒（wake GOAL 的 session 型那半；有入站 URL 的 runtime 走 webhook）。
// 复用 client.connect 的自动重连帧流，真正常驻；命令串行执行（一条处理完再下一条，不并发抢跑）。
import { BODY_LIMIT, EXIT_ARCHIVED, EXIT_AUTH, EXIT_STREAM_ENDED, EXIT_UPGRADED, type Attachment, type MsgFrame, type ServerFrame } from "@agentparty/shared";
import { maybeReexecUpgrade, serverVersionUpgradeNotice, upgradeNotice, type CliUpgradeNotice, type UpgradeDeps } from "../upgrade";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readAccount } from "../account";
import { connect } from "../client";
import { readConfig, clearStuck, loadCursor, loadRevCursor, loadStuck, resolveChannel, saveCursor, saveRevCursor, saveStuck, type StuckWake } from "../config";
import { acquireInstanceLock, defaultInstanceLockDir, instanceLockTarget } from "../instance-lock";
import { formatMsg } from "../format";
import { clearHealthCache, writeHealthCache } from "../health-cache";
import { ensureFreshAccess, resolveAuthDetailed, type ResolvedAuthDetailed } from "../oidc-cli";
import {
  clearStatuslineListener,
  heartbeatPatch,
  lastMessageFromFrame,
  localStatuslineBase,
  unreadFromCursor,
  writeStatuslineCache,
} from "../statusline-cache";
import { downloadAttachment, ensureProjectAgentChannelRuntime, fetchChannelCharter, fetchServerVersion, listProjectAgentInvites, mintProjectAgentRuntimeToken, postMessage, RestError, uploadAttachment, type ChannelCharter, type ChannelProjectAgentInvite, type ProjectAgentChannelRuntime, type ProjectAgentProfile } from "../rest";
import { isName, isSlug } from "../validation";
import { buildContext } from "./status";

const PROTOCOL_REMINDER =
  "被 @ 唤起：先读本文件 charter 了解频道约定；若发现 charter 与频道现状矛盾，视为一个待办上报。需要更多上下文再 `party history <channel 字段的频道>`；需要产出结论时，先用 `party send --reply-to <seq>` 把 final synthesis 发回频道，再 status done；别只回本地。" +
  " 需要 owner 补充信息或批准时，把问题用 `party send --reply-to <seq> --mention <sender 字段的名字>` 发回本频道，然后结束本轮，让 serve 立即恢复监听；不要把 account/email 当 mention 名。禁止在 runner 子进程里调用 AskUserQuestion、request_user_input 或停住等待人工输入，否则整个频道监听会被串行阻塞。" +
  " 全程只用 party CLI 在【本频道】里协作：不要触发项目自带的其它频道/工作流机制（如 trellis 等 app-server 建频道流程）另建频道，也不要用 tmux/后台守护/子代理去接管这次唤醒——这一轮就在当前会话里用 party 回完即可。" +
  " 维护任务台账（#371）：认领活先 `party task claim <id>`（没有就 `party task create`），开工 `party status working --task <id>`，完成 `party status done --task <id>`（或 `party task done <id>`）——让台账反映真实进度，别和 GitHub issue/实际漂移。";

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

/** 连续放弃熔断：supervisor 已经无法履行唤醒职责，停止排空后续 @。 */
export const EXIT_WAKE_ABANDON_CIRCUIT = 11;

/** 已有 serve 挂在同一 (server identity, channel, machine) 上：拒绝启动，避免重复执行（#99/#465）。 */
export const EXIT_ALREADY_SERVING = 10;

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
// 每任务心跳节奏（#228）：任务运行期间每隔这么久刷一次「还活着、正在处理 seq=X」。
// 15s 足够让频道/本机在几分钟的长任务里持续看到新鲜度，又远比逐 tick 便宜（presence-only，不落 history）。
const DEFAULT_TASK_HEARTBEAT_MS = 15_000;
// 普通频道 loop guard 是 30；必须远低于它，避免放弃通告先把频道熔断、随后静默丢消息。
const MAX_CONSECUTIVE_WAKE_ABANDONS = 3;
const BLOCKED_ERROR_MAX = 300;

function sanitizeBlockedError(error: string): string {
  const compact = error
    .replace(/\b(?:ap|acc|ref)_[A-Za-z0-9._-]+\b/gi, "[redacted]")
    .replace(/((?:authorization|token|secret|password)\s*[:=]\s*)(?:Bearer\s+)?\S+/gi, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (compact || "unknown error").slice(0, BLOCKED_ERROR_MAX);
}

// context file 里附带的最近频道消息条数上限（冷起的 runner 不用先跑 history 也有基本上下文）
const RECENT_MAX = 20;
const RECENT_BODY_MAX = 400;
// 自动塞给模型的辅助正文预算（不含本次触发消息）。触发正文始终保留全文；charter/recent
// 超出预算时显式标记，runner 可按需 `party charter/history` 补取，避免每次 wake 固定烧掉大段上下文（#436）。
const WAKE_AUX_BODY_MAX = 8_000;
const WAKE_CHARTER_BODY_MAX = 4_000;
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

interface KillableRunnerProcess {
  pid: number;
  kill(signal?: NodeJS.Signals | number): void;
}

export function forwardRunnerSignal(
  proc: KillableRunnerProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  killGroup: typeof process.kill = process.kill,
): "group" | "child" {
  if (platform !== "win32") {
    try {
      killGroup(-proc.pid, signal);
      return "group";
    } catch {
      // The process may have exited between signal delivery and group lookup.
    }
  }
  proc.kill(signal);
  return "child";
}

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
  /** 交付物上传（#109）；默认真 REST。测试注入 mock。 */
  uploadAttachment?: typeof uploadAttachment;
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
  /** 交付物上传（#109）；默认真 REST。测试注入 mock。 */
  uploadAttachment?: typeof uploadAttachment;
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

export interface WakeContextAttachment extends Attachment {
  /** Absolute worker route. It still requires the current AgentParty bearer token. */
  url: string;
  auth: "Bearer token required";
  /** Private copy prepared by serve, or null when download failed/not attempted. */
  local_path: string | null;
  download_error?: string;
}

function attachmentContextMetadata(attachment: Attachment): WakeContextAttachment {
  return { ...attachment, auth: "Bearer token required", local_path: null };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function truncateCodePoints(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const points = Array.from(value);
  return points.length <= maxLength ? value : points.slice(0, maxLength).join("");
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
  attachments?: WakeContextAttachment[],
) {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  const rawCharter = charter?.charter ?? null;
  const charterNotice = `\n… [charter truncated; run \`party charter ${channel}\`]`;
  const charterNoticeLength = codePointLength(charterNotice);
  const boundedCharter = rawCharter === null
    ? null
    : codePointLength(rawCharter) <= WAKE_CHARTER_BODY_MAX
      ? rawCharter
      : charterNoticeLength >= WAKE_CHARTER_BODY_MAX
        ? truncateCodePoints(charterNotice, WAKE_CHARTER_BODY_MAX)
        : truncateCodePoints(rawCharter, WAKE_CHARTER_BODY_MAX - charterNoticeLength) + charterNotice;
  const boundedCharterLength = boundedCharter === null ? 0 : codePointLength(boundedCharter);
  let recentBudget = WAKE_AUX_BODY_MAX - boundedCharterLength;
  let recentBodyChars = 0;
  let recentBodyTruncated = false;
  const boundedRecent: Array<{
    seq: number;
    sender: string;
    kind: MsgFrame["kind"];
    body: string;
    attachments: ReturnType<typeof attachmentContextMetadata>[];
    ts: number;
  }> = [];
  // 最近的消息最有用：从尾部向前装预算，最后再恢复时间顺序。
  for (let i = recent.length - 1; i >= 0 && recentBudget > 0; i--) {
    const message = recent[i]!;
    const rawBody = message.kind === "message" ? message.body : (message.note ?? "");
    const rawBodyLength = codePointLength(rawBody);
    const boundedBody = truncateCodePoints(rawBody, Math.min(RECENT_BODY_MAX, recentBudget));
    const boundedBodyLength = codePointLength(boundedBody);
    recentBodyTruncated ||= boundedBodyLength < rawBodyLength;
    recentBodyChars += boundedBodyLength;
    recentBudget -= boundedBodyLength;
    boundedRecent.push({
      seq: message.seq,
      sender: message.sender.name,
      kind: message.kind,
      body: boundedBody,
      attachments: message.attachments?.map(attachmentContextMetadata) ?? [],
      ts: message.ts,
    });
  }
  boundedRecent.reverse();
  recentBodyTruncated ||= boundedRecent.length < recent.length;
  return {
    channel,
    seq: frame.seq,
    sender: frame.sender.name,
    owner: frame.sender.owner ?? null,
    kind: frame.kind,
    body,
    attachments: attachments ?? frame.attachments?.map(attachmentContextMetadata) ?? [],
    mentions: frame.mentions,
    reply_to: frame.seq, // 回这条就 --reply-to 它
    self,
    charter: boundedCharter,
    charter_rev: charter?.charter_rev ?? 0,
    project_agent: projectAgent,
    cli_upgrade: cliUpgrade,
    recent: boundedRecent,
    context_budget: {
      policy: "auxiliary-body-chars-v1",
      max_auxiliary_body_chars: WAKE_AUX_BODY_MAX,
      auxiliary_body_chars: boundedCharterLength + recentBodyChars,
      trigger_body_chars: codePointLength(body),
      trigger_body_truncated: false,
      charter_chars: boundedCharterLength,
      charter_truncated: rawCharter !== null && boundedCharter !== rawCharter,
      recent_body_chars: recentBodyChars,
      recent_messages_included: boundedRecent.length,
      recent_messages_available: recent.length,
      recent_truncated: recentBodyTruncated,
    },
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
  attachments?: WakeContextAttachment[],
): string {
  // dir 必须由调用方按运行实例隔离。文件名只需 seq：同一次唤醒重复写得到同一路径（幂等），
  // 而不同实例——不同身份 / 不同 server / 不同 profile——各在各的目录里。
  const path = join(dir, `${frame.seq}.json`);
  writeFileSync(
    path,
    JSON.stringify(buildWakeContext(frame, channel, self, recent, charter, projectAgent, cliUpgrade, attachments), null, 2) + "\n",
    { mode: 0o600 },
  );
  return path;
}

function builtinRunnerContextDir(workdir: string): string {
  const dir = join(workdir, "wake-context");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * runner workdir 按 (频道, 身份) 隔离（#99）。
 *
 * 旧实现只按频道键（`~/.agentparty/runners/<channel>`）。同机两个身份 serve 同一频道时，
 * 它们共享同一个 wake-session.json：互相把对方的 codex/claude session id 覆盖掉，
 * 而 builtin runner 在 resume 失败时会 fork 出一个新 session——于是重复执行。
 *
 * 身份未知（还没连上服务端拿到 welcome.self）时退回按频道键，保持旧行为。
 */
export function runnerWorkdir(root: string, channel: string, self: string | undefined): string {
  const safe = (part: string) => part.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, "_") || "_";
  if (self === undefined || self === "") return join(root, safe(channel));
  return join(root, `${safe(channel)}-${safe(self)}`);
}

/**
 * 默认 runner workdir。身份取自本地 config（启动时就有；welcome.self 要等连上才有）。
 * 没有缓存身份时退回按频道键，保持旧行为。
 */
export function defaultRunnerWorkdir(channel: string, cwd: string = process.cwd()): string {
  const self = readConfig(cwd)?.identity?.name;
  return runnerWorkdir(join(homedir(), ".agentparty", "runners"), channel, self);
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
  --all                run for every non-self message, not only @mentions

Supervisor safety: after ${MAX_CONSECUTIVE_WAKE_ABANDONS} consecutive wakes are abandoned, serve posts a final
blocked status and exits nonzero instead of consuming later messages.`;

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
  /** 单实例锁目录（#99/#465）。默认全机共享、再按 server/token 身份隔离；测试注入。 */
  lockDir?: string;
  /** 关掉单实例保护（逃生舱）。 */
  allowMultiple?: boolean;
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
  /** 入站附件下载注入点；默认走当前 server 的鉴权 REST 路径。 */
  downloadAttachment?: typeof downloadAttachment;
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
      attachments?: WakeContextAttachment[];
      /** 排在当前 wake 身后、尚未处理的 wake 数（#103）；runner 随 working 帧上报 busy+此值。 */
      queueDepth?: number;
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
  /** /api/version 发现服务器已有更新 CLI 时，随下一次 wake 交给 agent 主动提醒 owner（#485）。 */
  availableUpgrade?: CliUpgradeNotice | null;
  out?: (line: string) => void;
  statusline?: boolean;
  /** 每任务心跳间隔（#228）。默认 DEFAULT_TASK_HEARTBEAT_MS；测试注入更短值。 */
  heartbeatIntervalMs?: number;
  /** 时钟注入（#228）：任务开始时刻与每次心跳时刻走它，便于测试断言心跳在推进。默认 Date.now。 */
  now?: () => number;
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
    attachments?: WakeContextAttachment[];
    /** 排在当前 wake 身后、尚未处理的 wake 数（#103）。 */
    queueDepth?: number;
  },
): Promise<void> {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  const file = writeContextFile(ctx.contextDir, frame, ctx.channel, ctx.self, ctx.recent, ctx.charter, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null, ctx.attachments);
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

const ATTACH_LINE_RE = /^\[attach:[^\]\r\n]+\]$/;

// worker 存什么 content-type 就回什么（它 split(";")[0] 归一化）。给常见交付物一个像样的类型，
// 让 web 的 AttachmentList 能正确渲染（图片走 <img>、文本可预览）；认不出就 octet-stream。
const ATTACHMENT_CONTENT_TYPE_BY_EXT: Record<string, string> = {
  diff: "text/x-diff; charset=utf-8",
  patch: "text/x-diff; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  html: "text/html; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
};

function guessAttachmentContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return ATTACHMENT_CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

// worker 端 filename 校验：/^[^/\\\x00-\x1f\x7f]{1,255}$/（单段、无控制符）。消毒到合法单段。
function safeAttachmentFilename(name: string): string {
  const cleaned = name.replace(/[/\\\x00-\x1f\x7f]/g, "_").slice(0, 255);
  return cleaned.length > 0 ? cleaned : "attachment";
}

async function materializeWakeAttachments(
  server: string,
  token: string,
  channel: string,
  frame: MsgFrame,
  contextDir: string,
  download: typeof downloadAttachment,
): Promise<WakeContextAttachment[]> {
  const attachments = frame.attachments ?? [];
  if (attachments.length === 0) return [];
  const dir = join(contextDir, `${frame.seq}-attachments`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return Promise.all(attachments.map(async (attachment, index) => {
    const metadata = attachmentContextMetadata(attachment);
    try {
      const bytes = await download(server, token, channel, attachment);
      if (bytes.byteLength !== attachment.size) {
        throw new Error(`attachment size mismatch: expected ${attachment.size}, received ${bytes.byteLength}`);
      }
      const localPath = join(dir, `${index + 1}-${safeAttachmentFilename(attachment.filename)}`);
      writeFileSync(localPath, bytes, { mode: 0o600 });
      return {
        ...metadata,
        url: new URL(attachment.url, server.replace(/\/+$/, "") + "/").toString(),
        local_path: localPath,
      };
    } catch (error) {
      return {
        ...metadata,
        download_error: sanitizeBlockedError(error instanceof Error ? error.message : String(error)),
      };
    }
  }));
}

function stripAttachLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !ATTACH_LINE_RE.test(line.trim()))
    .join("\n")
    .trim();
}

// 正文兜底裁剪：极少见——[attach] 周围的叙述文本本身超过 BODY_LIMIT。裁到安全字节数，附件仍完整。
function clampInlineBody(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= BODY_LIMIT) return body;
  return Buffer.from(body, "utf8").subarray(0, BODY_LIMIT - 1024).toString("utf8");
}

/**
 * 交付一条 runner 结果（#109）。
 *
 * 旧实现把 [attach] 文件内容 / 长正文直接 inline 进消息 body：一撞 BODY_LIMIT(100KB) worker 就 413，
 * 而那次 post 在 try/catch 之外，连 blocked 都发不出——交付物静默丢失。
 *
 * 现在：有 [attach] 交付物、或 inline 正文会超限，就先把 blob 传到 R2（复用 #176 的附件端点），
 * 消息只带轻量正文 + 附件引用，走既有 AttachmentList 渲染。上传/交付失败由调用方兜进 WakeBlockedError，
 * 最终 runServe 发 blocked（带原因），绝不静默丢。
 */
async function deliverRunnerMessage(opts: {
  post: typeof postMessage;
  upload: typeof uploadAttachment;
  server: string;
  token: string;
  channel: string;
  replyTo: number;
  text: string;
  marker: string | null;
}): Promise<void> {
  const { post, upload, server, token, channel, replyTo, text, marker } = opts;
  // [attach:/abs/path]：交付物永远走 R2 附件（相对路径在此抛错，与旧行为一致）。
  const attachPath = attachmentPathFromRunnerText(text);
  if (attachPath !== null) {
    const bytes = readFileSync(attachPath); // Buffer：逐字节，不做 utf8 往返，保住 #41 的完整性
    const filename = safeAttachmentFilename(basename(attachPath));
    const ref = await upload(server, token, channel, filename, bytes, guessAttachmentContentType(filename));
    const rest = stripAttachLines(text);
    const parts: string[] = [];
    if (marker) parts.push(marker);
    if (rest) parts.push(rest);
    if (parts.length === 0) parts.push(`[attached ${filename}]`);
    await post(server, token, channel, {
      kind: "message",
      body: clampInlineBody(parts.join("\n")),
      mentions: [],
      reply_to: replyTo,
      attachments: [ref],
    });
    return;
  }

  const inline = marker ? `${marker}\n${text}` : text;
  const inlineBytes = Buffer.byteLength(inline, "utf8");
  if (inlineBytes > BODY_LIMIT) {
    // 正文超 inline 上限：整段传成 R2 附件，正文只留一行指引（#109），不再撞 413。
    const filename = `delivery-seq${replyTo}.md`;
    const ref = await upload(server, token, channel, filename, Buffer.from(inline, "utf8"), "text/markdown; charset=utf-8");
    await post(server, token, channel, {
      kind: "message",
      body: `[reply body ${inlineBytes} bytes exceeded the ${BODY_LIMIT}-byte inline limit; delivered as attachment ${filename}]`,
      mentions: [],
      reply_to: replyTo,
      attachments: [ref],
    });
    return;
  }

  await post(server, token, channel, {
    kind: "message",
    body: inline,
    mentions: [],
    reply_to: replyTo,
  });
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
    detached: process.platform !== "win32",
  });
  let terminatingSignal: NodeJS.Signals | null = null;
  const forward = (signal: NodeJS.Signals) => {
    if (terminatingSignal !== null) return;
    terminatingSignal = signal;
    forwardRunnerSignal(proc, signal);
    const force = setTimeout(() => forwardRunnerSignal(proc, "SIGKILL"), 1_000);
    force.unref();
  };
  const onTerm = () => forward("SIGTERM");
  const onInterrupt = () => forward("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInterrupt);
  let stdout: string;
  let stderr: string;
  let code: number;
  try {
    [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
  }
  if (terminatingSignal !== null) {
    process.exit(terminatingSignal === "SIGINT" ? 130 : 143);
  }
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
  attachments?: WakeContextAttachment[],
): string {
  return JSON.stringify(buildWakeContext(frame, channel, self, recent, charter, projectAgent, cliUpgrade, attachments), null, 2) + "\n";
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
  // 隔离 CODEX_HOME（会话/rollout 状态）仍然需要——多个 workdir 的 codex exec 可能并发跑，
  // 共享一个 CODEX_HOME 会互相踩会话索引。但 auth.json 是长期 ChatGPT 凭据，workdir 往往
  // 就是个 git worktree：拷贝进去等于把凭据字节复制到一个可能被 `git add -A`、同步工具、
  // 同机其它进程读到的地方（#121）。改成符号链接指回真实文件——workdir 里只留一条路径引用，
  // 凭据字节永远只有一份；codex 对真实文件做 token 刷新时，所有 workdir 立刻共享新值，
  // 不会像“拷贝一次后各自为政”那样，某个 workdir 长期攥着一份已撤销/已过期的旧 token。
  if (existsSync(authSource)) {
    let currentTarget: string | null = null;
    try {
      currentTarget = readlinkSync(authDest);
    } catch {
      // 不存在，或者存在但不是符号链接（例如修复前遗留的独立拷贝）。
    }
    if (currentTarget !== authSource) {
      // 清掉任何遗留状态再重建：可能是旧版本 copyFileSync 留下的真实凭据拷贝，
      // 也可能是指向别处的坏链接——两种都不该继续留在 workdir 里。
      rmSync(authDest, { force: true, recursive: true });
      symlinkSync(authSource, authDest);
    }
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
      attachments?: WakeContextAttachment[];
      /** 排在当前 wake 身后、尚未处理的 wake 数（#103）。 */
      queueDepth?: number;
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
      // busy（#103）：串行处理这条 wake 期间自报「忙 + 身后队列深度」，让 who/reach/web 别谎报可即时响应。
      busy: true,
      queue_depth: ctx.queueDepth ?? 0,
    });

    let threadId = session?.thread_id ?? null;
    try {
      const active = await ensureThread(started);
      const result = await active.thread.run(sdkPrompt(frame, ctx.channel, ctx.self, ctx.recent, ctx.charter ?? null, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null, ctx.attachments), {
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
      // 交付走统一路径：超限正文改走 R2 附件（#109），不再 inline 撞 413。上传失败落进下面的 catch。
      await deliverRunnerMessage({
        post,
        upload: opts.uploadAttachment ?? uploadAttachment,
        server: opts.server,
        token: opts.token,
        channel: opts.channel,
        replyTo: frame.seq,
        text: body,
        marker: null,
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
      // busy（#103）：串行处理这条 wake 期间自报「忙 + 身后队列深度」，让 who/reach/web 别谎报可即时响应。
      busy: true,
      queue_depth: ctx.queueDepth ?? 0,
    });

    const repoCwd = await ensureRepo(opts, env);
    const cwd = opts.cwd ?? repoCwd ?? opts.workdir;
    // #479：builtin Claude/Codex 子进程在 runner workdir 内运行；把 context JSON 写到 workdir
    // 内，避免 Claude Code 默认权限模式因读取系统 tmpdir 文件而卡无人批准的权限弹窗。
    const contextFile = writeContextFile(builtinRunnerContextDir(opts.workdir), frame, ctx.channel, ctx.self, ctx.recent, ctx.charter ?? null, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null, ctx.attachments);
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
    // 交付：[attach] 交付物 / 超限正文改走 R2 附件（#109）。上传+发送整体包进 try —— 旧代码里
    // 那次 post（含 413）在 try 外逃逸，交付物静默丢失；现在失败一律转 WakeBlockedError，
    // 由 runServe 统一发 blocked（带原因）。
    try {
      await deliverRunnerMessage({
        post,
        upload: opts.uploadAttachment ?? uploadAttachment,
        server: opts.server,
        token: opts.token,
        channel: opts.channel,
        replyTo: frame.seq,
        text: run.text,
        marker,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} attach_error=${JSON.stringify(message)}`,
      );
      throw new WakeBlockedError(`builtin ${opts.harness} runner blocked: ${message}`);
    }

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
  availableUpgrade?: CliUpgradeNotice | null;
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
      availableUpgrade: opts.availableUpgrade ?? null,
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

// 排队深度估算（#103）：serve 串行处理一条 wake 时，其后到达并已缓冲的帧里，有多少条是「够格触发
// 一次唤醒」的新消息——即排在身后、迟早要挨个处理的 wake 数。只数已缓冲快照，不含正在处理的这条。
// afterSeq = 当前正在处理/已了结到的 seq；只数它之后、非自己发的、（mentions-only 时）@ 到自己的消息。
export function pendingWakeDepth(
  pending: ServerFrame[],
  self: string,
  mentionsOnly: boolean,
  afterSeq: number,
): number {
  let depth = 0;
  for (const f of pending) {
    if (f.type !== "msg") continue;
    if (f.seq <= afterSeq) continue;
    if (f.sender.name === self) continue;
    if (mentionsOnly && !f.mentions.includes(self)) continue;
    depth += 1;
  }
  return depth;
}

export async function runServe(o: ServeOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.error(line));
  const run = o.runCommand ?? (o.sdkRunner ? createSdkRunner(o.sdkRunner) : o.builtinRunner ? createBuiltinRunner(o.builtinRunner) : defaultRun);
  // busy 生命周期（#103）：只有内建 serve runner（builtin/sdk）在 working 帧里自报 busy=true，
  // 因此也只有它们需要 runServe 在收尾时补一条「busy=false 空闲」把 busy 清干净。注入 runCommand
  // 的测试、以及 --cmd 裸执行器（自管 presence）不参与，避免覆盖它们自己的收尾状态。
  const reportsBusy = o.runCommand === undefined && (o.builtinRunner !== undefined || o.sdkRunner !== undefined);
  // runner_started 审计标签（#228）：标明是哪种 runner 启动，写进落 history 的审计 status。
  // sdk / builtin / custom(o.cmd 或注入的 runCommand) 三类统一在下方 wrap 点用它发一条启动证据。
  const runnerKind = o.sdkRunner
    ? "codex-sdk"
    : o.builtinRunner
      ? `builtin-${o.builtinRunner.harness}`
      : "custom";
  // 已自报 busy、尚未补发空闲清除。一次 busy→idle 转场只补一条，不逐 tick 刷。
  let busyReported = false;
  let upgraded = false;
  let nudgedUpgrade = false;
  // 本地连接健康探针（#254）：WS 生命周期转场（不是 presence 自报、不是 PID 推断）落 health.json，
  // 让 watchdog 能问「这个 serve 此刻真的还在收帧吗」而不是只能 pgrep。reconnect_count 数的是
  // 本进程生命周期内进入过几次 reconnecting，不是每次退避重试都加一——那样一次掉线会看起来像刷屏。
  let reconnectCount = 0;
  const onWsStatus = (status: "open" | "reconnecting" | "closed", detail?: { error?: string }) => {
    if (status === "open") {
      writeHealthCache({ channel: o.channel, ws_connected: true, reconnecting: false, connected_since: Date.now(), last_error: null });
    } else if (status === "reconnecting") {
      reconnectCount += 1;
      writeHealthCache({ channel: o.channel, ws_connected: false, reconnecting: true, reconnect_count: reconnectCount, connected_since: null });
    } else {
      writeHealthCache({ channel: o.channel, ws_connected: false, reconnecting: false, connected_since: null, last_error: detail?.error ?? null });
    }
  };
  const skipBacklog = o.skipBacklog !== false; // 默认跳过离线积压（#193）
  // 抢锁在连 WS 之前：第二个 serve 连接都不该建，否则它已经在消费 @、已经在跑 runner 了（#99）。
  // 这把锁只挡同机；跨机器重复执行需要服务端租约（do.ts 广播发给同名所有连接）。
  const lockDir = o.lockDir ?? defaultInstanceLockDir();
  const lockTarget = o.lockDir === undefined ? instanceLockTarget(o.server, o.token, o.channel) : o.channel;
  const lock = o.allowMultiple === true ? null : acquireInstanceLock("serve", lockTarget, lockDir);
  if (lock && !lock.ok) {
    out(
      `serve: 已有 serve 挂在 #${o.channel} 上（pid ${lock.heldByPid}）。` +
        ` 再挂一个会让同一条 @ 触发两次完整 runner——双份回帖，git push 类副作用执行两遍。` +
        ` 要么等它退出，要么 kill ${lock.heldByPid}；确实想并存请加 --allow-multiple。`,
    );
    return EXIT_ALREADY_SERVING;
  }
  let conn: ReturnType<typeof connect>;
  try {
    conn = connect(o.server, o.token, o.channel, o.since, {
      onCursor: o.onCursor,
      sinceRev: o.sinceRev,
      onRevCursor: o.onRevCursor,
      onStatus: onWsStatus,
    });
  } catch (error) {
    lock?.release?.();
    throw error;
  }
  // 挂载之初就落一份 health 基线：即便还没收到第一帧，watchdog 也能看到「这个 pid 认领了这个频道」，
  // 而不是文件缺失时无法区分「serve 没起来」和「serve 起来了但还没写过健康数据」。
  writeHealthCache({ channel: o.channel, ws_connected: false, reconnecting: false, reconnect_count: 0, last_frame_at: null, last_error: null, connected_since: null });
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
  let consecutiveWakeAbandons = 0;
  let wakeAbandonCircuitTripped = false;
  let advertised = false;
  // 人为暂停接待（#180）：服务端对 webhook 已抑制，但 serve 是本地 supervisor、消息照样广播给它。
  // 收到自己的 paused presence 帧就自我抑制唤醒——被 @ 也不触发 runner，直到收到恢复帧。消息仍进历史。
  let selfPaused = false;
  // 同名 serve 跨机租约（#99）：同机单实例锁（上文）只挡本机；跨机器两台 serve 各连一条 WS，服务端广播
  // 把每条 @ 发给同名所有连接 → 两台都跑完整 runner。修复：挂上后向服务端 claim 租约，只有持租的那台跑
  // runner。hasLease 默认 true（老服务端不认租约、从不下发 serve_lease → 保持旧行为不回归）；收到
  // held=false 转 standby（不跑 runner，且保留未确认 wake），held=true（持租/顶替）恢复并重放。
  let hasLease = true;
  let leaseKnown = false; // 是否至少收到过一次 serve_lease（用于只在真 standby 时打印提示）
  // standby 收到的最早可唤醒消息。它以及后续帧都不推进 cursor；接管租约时由 Connection
  // 把已消费但未 ack 的帧按 seq 重排到队首，避免持租者中途退出时静默吞掉在飞 wake（#465）。
  let deferredLeaseSeq: number | null = null;
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
      // 每收到一帧（含 ping 的 pong 回执）就刷新 last_frame_at——空闲频道也靠 ping 心跳（~25s）
      // 保持新鲜，watchdog 才能把"频道安静"和"连接僵死"分开（issue #254 证据边界）。
      writeHealthCache({ channel: o.channel, last_frame_at: Date.now() });
      if (frame.type === "welcome") {
        self = frame.self;
        // 挂上/重连即向服务端 claim serve 租约（#99）。best-effort：ws 此刻是 OPEN，claim 会送出；
        // 服务端在同名多条 serve 里选唯一持租者并回 serve_lease。老服务端不认识它、直接忽略（hasLease
        // 默认 true → 旧行为）。重连每次 welcome 都重新 claim（连接换了，租约候选身份也换了）。
        conn.send({ type: "serve_lease", op: "claim" });
        // 连上时若自己已被暂停接待（#180），从 welcome 的 presence 快照里认出来——重连也不误唤醒。
        const mine = frame.presence?.find((p) => p.name === self);
        selfPaused = mine?.paused === true;
        if (selfPaused) {
          out(
            `serve: 当前处于暂停接待状态——被 @ 也不唤醒 runner${typeof mine?.resume_at === "number" ? `，将于 ${new Date(mine.resume_at).toISOString()} 恢复` : "（等人工恢复）"}。`,
          );
        }
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
      // 人为暂停/恢复（#180）：跟踪自己的 paused 状态。moderator 一按暂停，DO 就广播这帧过来。
      if (frame.type === "presence" && frame.name === self) {
        const nextPaused = frame.paused === true;
        if (nextPaused !== selfPaused) {
          selfPaused = nextPaused;
          out(
            selfPaused
              ? `serve: 已被暂停接待——被 @ 也不再唤醒 runner${typeof frame.resume_at === "number" ? `，将于 ${new Date(frame.resume_at).toISOString()} 恢复` : "（等人工恢复）"}。消息仍进历史。`
              : "serve: 已恢复接待——重新响应 @。",
          );
        }
      }
      // 同名 serve 跨机租约（#99）：服务端在同名多条 serve 连接里选唯一持租者，用这帧告诉本连接是否持租。
      // 只有持租的那台跑 runner；held=false 转 standby（下方 qualifies 拦住 runner），持租者掉线后服务端
      // 补发 held=true 让 standby 顶上。跨进程互斥点在服务端——本地只是遵从它的裁决。
      if (frame.type === "serve_lease" && frame.name === self) {
        const next = frame.held === true;
        const takingOver = leaseKnown && !hasLease && next;
        if (!leaseKnown || next !== hasLease) {
          hasLease = next;
          const replayed = takingOver ? conn.replayUnacked() : 0;
          if (takingOver) deferredLeaseSeq = null;
          out(
            hasLease
              ? leaseKnown
                ? `serve: 取得 serve 租约——本台顶替，开始响应 @；重放 ${replayed} 条未确认帧（同名另一台已让出/掉线）。`
                : "serve: 持有 serve 租约——本台负责跑 runner。"
              : "serve: 未持有 serve 租约（同名另一台 serve 在跑）——本台转 standby：@ 会保留为未确认欠账；持租者掉线后自动顶替并重放。",
          );
        }
        leaseKnown = true;
        continue;
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
      const wouldWake = fresh && !blockedByDebt && (isDebt || passesFilter);
      // 暂停接待（#180）：本帧本该唤醒，但人按了暂停 → 不跑 runner。普通 @ 照进 recent/历史、游标照推进
      // （下方 ack），恢复后不重放（在历史里，agent 自行补看）；欠账帧因 stuck.seq===seq 天然不 ack，
      // 会一直欠着到恢复后再还——暂停不吞没一条从没进过模型的 @。
      if (wouldWake && selfPaused) {
        out(`⏸ 暂停中，跳过唤醒（消息仍在历史）: ${formatMsg(frame)}`);
      }
      // 未持租（#465）：standby 不跑 runner，也绝不能 ack 越过这条 @。记住最早 seq，并冻结后续
      // cursor；租约顶替时 replayUnacked() 把这些帧按序放回队首。这样持租者被 kill 时至少重投，
      // 不再出现 runner started 之后无人回复、standby 却已把同一条消息消费掉的静默丢失。
      const deferredForLease = wouldWake && !selfPaused && !hasLease;
      if (deferredForLease) {
        deferredLeaseSeq = Math.min(deferredLeaseSeq ?? frame.seq, frame.seq);
        out(`▷ standby（未持有 serve 租约），保留未确认 wake seq=${frame.seq}，接管后重放: ${formatMsg(frame)}`);
      }
      // deferredLeaseSeq 只会在 !hasLease 时设置，held=true 分支会先清空再 replay；因此持租处理
      // 与 standby 冻结区互斥。不要在这里额外跳过，否则一旦状态漂移反而会把欠账永久冻住。
      const qualifies = wouldWake && !selfPaused && hasLease;
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
        // 身后已缓冲的 wake 深度（#103）：内建 runner 随 working 帧上报，presence 显示「忙 + N 待处理」。
        // 本帧正在处理，故只数它 seq 之后、够格触发唤醒的缓冲帧。
        const queueDepth = pendingWakeDepth(conn.pendingFrames(), self, o.mentionsOnly === true, frame.seq);
        // 先把入站附件放进本 serve 实例的 0700 临时目录。runner 只拿 0600 本地文件与
        // 鉴权端点元数据，context 中绝不出现 bearer token；单个下载失败也不吞掉整次唤醒。
        const wakeAttachments = await materializeWakeAttachments(
          o.server,
          o.token,
          o.channel,
          frame,
          contextDir,
          o.downloadAttachment ?? downloadAttachment,
        );
        if (reportsBusy) busyReported = true;
        // 每任务进度/心跳（#228，扩 #103 busy）：run() 会把这条串行循环阻塞数分钟——期间频道与本机都看不到
        // 「具体这条任务在跑、活着」。用一个 setInterval 侧信道在 run() 执行期间周期性刷新（阻塞的循环靠定时器
        // 心跳），每拍做两件事：① 本机 health.json 盖上 current_task/heartbeat_at（供 party health/watchdog）；
        // ② 一条 presence-only 的 heartbeat 帧发给 DO（供 who/web），**不落 history、不刷屏**。任务结束（成功或
        // 放弃）在 finally 里清定时器 + 发一条 current_task=null 的清除帧——绝不留「假在跑」的僵状态。
        const nowFn = o.now ?? (() => Date.now());
        const taskStartedAt = nowFn();
        const heartbeatIntervalMs = o.heartbeatIntervalMs ?? DEFAULT_TASK_HEARTBEAT_MS;
        const emitTaskBeat = (active: boolean, at: number) => {
          const fields = active
            ? { current_task: frame.seq, task_started_at: taskStartedAt, heartbeat_at: at }
            : { current_task: null, task_started_at: null, heartbeat_at: null };
          try {
            writeHealthCache({ channel: o.channel, ...fields });
          } catch {
            /* 本机 health 落盘失败不影响唤醒 */
          }
          try {
            conn.send({ type: "heartbeat", ...fields });
          } catch {
            /* WS 未就绪就漏一拍：本机 health 仍新鲜，且下一拍/清除会补 */
          }
        };
        // t=0 立刻发一拍「started」：不必等第一个间隔，频道/本机马上就能看到「已开始处理 seq=X」。
        emitTaskBeat(true, taskStartedAt);
        // runner_started 审计（#228）：上面那拍是 presence-only 的 heartbeat——**不落 history、任务结束即清**，
        // 任务跑完后频道历史里没有任何「这个 runner 曾为 seq=X 启动过」的证据。这里在 run() 之前补发一条
        // **落 history** 的 working status，作为可审计的启动记录。三种 runner（builtin / sdk / custom o.cmd）
        // 统一在此 wrap 点覆盖——尤其 custom o.cmd 此前只有 presence 心跳、零 history 证据。
        // 与「结束」（runner 自己的回帖 / 排空后的 idle waiting 帧）和「失败」（blocked 帧）区分：note 以
        // 「runner started for seq X」起头，带 trigger_seq 与 runner 类型。不置 busy——busy 生命周期仍由
        // builtin/sdk 的 wake-ack 帧与下方 idle 清除各管各的，这条纯审计不掺和（custom 不参与 busy）。
        // best-effort：审计发不出去不阻塞唤醒（主职是把 @ 送进模型），留痕即可。
        try {
          await (o.post ?? postMessage)(o.server, o.token, o.channel, {
            kind: "status",
            state: "working",
            note: `runner started for seq ${frame.seq}: ${self} runner=${runnerKind}`,
            mentions: [],
          });
        } catch (e) {
          out(`  runner_started 审计发送失败（不影响送达）: ${errText(e)}`);
        }
        const taskBeat: ReturnType<typeof setInterval> = setInterval(() => emitTaskBeat(true, nowFn()), heartbeatIntervalMs);
        if (typeof taskBeat.unref === "function") taskBeat.unref();
        try {
          for (let attempt = priorAttempts + 1; attempt <= maxAttempts && retriable; attempt++) {
            try {
              // 磁盘已经装好的新版优先（可直接 re-exec）；否则把服务器发布版提示交给 runner，
              // 让 agent 在频道里主动请 owner 升级。旧客户端不知道新协议时最需要这条提醒（#485）。
              const cliUpgrade = upgradeNotice(o.autoUpgrade === true, o.upgradeDeps) ?? o.availableUpgrade ?? null;
              await run(frame, {
                cmd: o.cmd,
                channel: o.channel,
                self,
                contextDir,
                recent: recent.slice(),
                charter,
                projectAgent: o.projectAgent ?? null,
                cliUpgrade,
                attachments: wakeAttachments,
                queueDepth,
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
        } finally {
          // 任务收尾：无论送达、放弃还是抛异常穿透，都停心跳并清除本机+频道的「正在处理」状态。
          // 若身后还有排队的 wake，下一条自己的 started 拍会把 current_task 覆盖成新 seq。
          clearInterval(taskBeat);
          emitTaskBeat(false, nowFn());
        }
        if (delivered) {
          // 一条真正送达的 wake 证明 runner 恢复了；此前连续失败不再代表当前健康状态。
          consecutiveWakeAbandons = 0;
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
          // busy 清除（#103）：这条 wake 处理完了。若身后已无待处理 wake（队列排空），补一条「空闲」把
          // 之前 working 帧上的 busy 清回 false——否则任务结束后 presence 会永远卡在「忙」（假忙）。
          // 只在真排空时补：还有 @ 排队就保持 busy=true，等下一条 wake 的 working 帧继续覆盖 queue_depth。
          if (busyReported) {
            const remaining = pendingWakeDepth(conn.pendingFrames(), self, o.mentionsOnly === true, conn.cursor);
            if (remaining === 0) {
              busyReported = false;
              try {
                await (o.post ?? postMessage)(o.server, o.token, o.channel, {
                  kind: "status",
                  state: "waiting",
                  note: `idle: ${self} finished wake seq=${frame.seq}, waiting for next @`,
                  mentions: [],
                  busy: false,
                  queue_depth: 0,
                });
              } catch (e) {
                // 清 busy 只是锦上添花：发不出去就下条 wake 的 working 帧会重置 queue_depth，
                // 或下次排空再补。留痕但不影响主流程（wake 已成功送达）。
                out(`  busy 清除通告发送失败（不影响送达）: ${errText(e)}`);
              }
            }
          }
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
          consecutiveWakeAbandons += 1;
          if (consecutiveWakeAbandons >= MAX_CONSECUTIVE_WAKE_ABANDONS) {
            const finalNote =
              `serve wake circuit breaker tripped: consecutive_abandons=${consecutiveWakeAbandons}/${MAX_CONSECUTIVE_WAKE_ABANDONS}; ` +
              `last_seq=${frame.seq}; last_error=${sanitizeBlockedError(lastError)}`;
            out(`  ${finalNote}`);
            try {
              await (o.post ?? postMessage)(o.server, o.token, o.channel, {
                kind: "status",
                state: "blocked",
                note: finalNote,
                mentions: [],
                blocked_reason: finalNote,
              });
            } catch (e) {
              out(`  熔断通告发送失败，立即退出: ${sanitizeBlockedError(e instanceof Error ? e.message : String(e))}`);
            }
            // 当前 wake 已经逐条宣告放弃；让公共 ack 路径把它了结，再退出且不读取下一帧。
            wakeAbandonCircuitTripped = true;
            code = EXIT_WAKE_ABANDON_CIRCUIT;
          }
        }
      }
      const heldForLease = deferredLeaseSeq !== null && frame.seq >= deferredLeaseSeq;
      // standby 冻结区会在接管时完整重放；首次经过时不提前塞进 recent，避免重放后上下文重复。
      if (!heldForLease) {
        recent.push(frame);
        if (recent.length > RECENT_MAX) recent.shift();
      }
      // 游标只表达「已了结」（#198）：送达成功，或有界重试耗尽后**宣告过**的放弃。
      // 欠账未了结时游标绝不越过它——否则那条 @ 永远不会再被重放。
      //
      // 我曾断言这个守卫是死代码（有界重试后 stuck 恒为 null），并请门禁证伪。
      // 190-codex-dev 找到了反例：欠账那一帧若被 mentionsOnly / fromSelf 过滤掉，
      // stuck 就活着走到这里。守卫不是死的——是我的推理漏了过滤路径。
      if ((stuck === null || frame.seq < stuck.seq) && !heldForLease) conn.ack(frame.seq);
      if (o.statusline === true) {
        writeStatuslineCache({
          ...localStatuslineBase(o.channel),
          ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
          unread: unreadFromCursor(frame.seq, o.channel),
          last_message: lastMessageFromFrame(frame),
        });
      }

      if (wakeAbandonCircuitTripped) break;

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
    lock?.release?.();
    if (heartbeat) clearInterval(heartbeat);
    conn.close();
    if (o.statusline === true) clearStatuslineListener();
    // 进程真退出了：health.json 不该继续显示 ws_connected=true 骗 watchdog（只清自己写的记录）。
    clearHealthCache();
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
    let availableUpgrade: CliUpgradeNotice | null = null;
    try {
      availableUpgrade = serverVersionUpgradeNotice((await fetchServerVersion(account.session.server)).version);
      if (availableUpgrade !== null) console.error(`serve: ${availableUpgrade.message}\n  ${availableUpgrade.command}`);
    } catch {
      // 版本探测失败不影响 project-agent supervisor。
    }
    return runProfileServe({
      server: account.session.server,
      humanToken: account.token,
      ownerAccount: profileRef.owner,
      handle: profileRef.handle,
      mentionsOnly: flags.all !== true,
      availableUpgrade,
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
  let availableUpgrade: CliUpgradeNotice | null = null;
  try {
    const serverVersion = await fetchServerVersion(server);
    availableUpgrade = serverVersionUpgradeNotice(serverVersion.version);
    if (availableUpgrade !== null) console.error(`serve: ${availableUpgrade.message}\n  ${availableUpgrade.command}`);
  } catch {
    // 老部署没有 /api/version、临时断网都不能阻止 serve 挂上；下一次启动再探测。
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
    availableUpgrade,
    statusline: true,
    builtinRunner: harness
      ? {
          server,
          token,
          channel,
          harness,
          workdir: expandHomePath(str(flags.workdir) ?? defaultRunnerWorkdir(channel)),
          repo: str(flags.repo),
        }
      : undefined,
    sdkRunner: useSdkRunner
      ? {
          server,
          token,
          channel,
          workdir: expandHomePath(str(flags.workdir) ?? defaultRunnerWorkdir(channel)),
        }
      : undefined,
  });
}
