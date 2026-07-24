// party serve — 常驻监听频道，每条 @你 的消息触发一次本地命令，把「跑完就停的 session agent」
// 用外部 supervisor 唤醒（wake GOAL 的 session 型那半；有入站 URL 的 runtime 走 webhook）。
// 复用 client.connect 的自动重连帧流，真正常驻；命令串行执行（一条处理完再下一条，不并发抢跑）。
import { BODY_LIMIT, DECISION_OPTION_LIMIT, DECISION_OPTIONS_MAX, DECISION_PROMPT_LIMIT, EXIT_ARCHIVED, EXIT_AUTH, EXIT_STREAM_ENDED, EXIT_UPGRADED, type AgentSessionInfo, type Attachment, type DeliveryUpdateFrame, type DirectedDelivery, type MsgFrame, type PublicDirectedDelivery, type SendDecisionRequest, type ServerFrame } from "@agentparty/shared";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { downloadPartyUpgrade, isPartyBinaryPath, maybeReexecUpgrade, serverVersionUpgradeNotice, upgradeNotice, type CliUpgradeNotice, type UpgradeDeps } from "../upgrade";
import {
  clearManagedActions,
  clearManagedExclusiveLocks,
  MANAGED_CONFIG_FILE,
  readManagedActions,
  writeManagedManifest,
  writeManagedWake,
} from "../managed";
import { clearActivityFile, readActivityFile, runnerActivityFile } from "../activity";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readAccount } from "../account";
import { connect } from "../client";
import { clearStuck, clearStuckForConfig, loadCursor, loadCursorForConfig, loadRevCursor, loadRevCursorForConfig, loadStuck, loadStuckForConfig, resolveChannel, saveCursor, saveCursorForConfig, saveRevCursor, saveRevCursorForConfig, saveStuck, saveStuckForConfig, type StuckWake } from "../config";
import { acquireInstanceLock, defaultInstanceLockDir, instanceLockTarget, stopOwnInstance } from "../instance-lock";
import { formatMsg, stripTerminalControls } from "../format";
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
import { downloadAttachment, ensureProjectAgentChannelRuntime, fetchChannelCharter, fetchMe, fetchMessages, fetchServerVersion, listProjectAgentInvites, mintProjectAgentRuntimeToken, postMessage, RestError, uploadAttachment, type ChannelCharter, type ChannelProjectAgentInvite, type ProjectAgentChannelRuntime, type ProjectAgentProfile } from "../rest";
import { isName, isSlug } from "../validation";
import { buildContext } from "./status";
import {
  blockRunnerContinuation,
  continuationPath,
  deleteRunnerContinuation,
  mergeRunnerContinuation,
  readRunnerContinuation,
  RUNNER_CONTINUATIONS_DIR,
  type RunnerContinuationState,
} from "../continuation";

export type ServeExecutionRole = "front" | "worker";

const COMMON_PROTOCOL_REMINDER =
  "被 @ 唤起：先读本文件 charter 了解频道约定；若发现 charter 与频道现状矛盾，视为一个待办上报。" +
  " 不要在 runner 里调用 AskUserQuestion、request_user_input 或停住等人；不要另建频道、启动 tmux/后台守护进程，或切到项目自带的其它工作流。";

const ADVISORY_FRONT_REMINDER =
  " 你是留在主频道沟通和调度的 front agent。简短对话和一次只读路由检查可直接处理；代码修改、多步排查、浏览器/运维及其它耗时工作，优先交给 harness 的 subagent/worker，让它回报证据由你汇总。" +
  " 这是兼容模式（CLI 不能证明 worker 已启动）：harness 支持子 agent 就委派；确实无法创建 worker 时，就在本会话内把活干完，不要只报 blocked 停住。" +
  " 你的最终输出会由 serve 自动发回本频道（上下文里的 reply_to 已指好这条）——直接把回复写成你的输出即可，" +
  "【不要自己调用 `party send`】：会重复投递，且常驻的 codex runner 跑在无网络沙箱里根本发不出去、还会把『连接失败』误写进回复。" +
  " 同理 `party history` / `party decision ask` 等直连服务的 CLI 在该沙箱也会失败——上下文已含 charter 与 recent，据此作答；" +
  " 确需 owner 决策或更多上下文却当前拿不到时，在你的输出里说清（由 serve 发回频道请人跟进），不要反复重试直连命令。";

const MANAGED_FRONT_REMINDER =
  " 你是 managed front agent，是三个方向的通信与调度控制面：对频道交流、对 owner 请求决定、对子 worker 派工/追问/验收；执行 worker 已由 supervisor 独立常驻。你没有执行面权限，也不要调用 party CLI。" +
  " 每次严格只输出一个 JSON 对象，固定包含 action、body、instruction、prompt、options、reason 六个字段；当前动作不用的字段必须为 null。" +
  " 对频道简短交流或 worker 回报汇总：action=channel_reply，body=给频道的回复。" +
  " 对代码修改、多步排查、浏览器/运维或其它耗时工作：action=worker_dispatch，instruction=给 worker 的完整任务、范围和验收标准；需要返工/补证据时用 worker_feedback，instruction 也必须自包含。" +
  " 需要 owner 做权限、取舍或批准时：action=owner_decision，prompt=具体问题；approve/reject 时 options=[]，自定义选择必须给 2-10 个选项。" +
  " 如果缺少无法自行取得的关键权限或输入：action=blocked，reason=需要人处理的具体阻塞。" +
  " 不得输出 JSON 之外的文字，不得把执行工作包装成 channel_reply 自己完成。";

const WORKER_REMINDER =
  " 你是 execution worker，不是频道 front。只执行这条有界派工，不再派生其它 agent；完成必要的代码、调查、浏览器或运维工作，并返回证据、风险和验收结果。" +
  " 不要调用 party CLI，也不要直接面向人做最终承诺；supervisor 会把你的回报作为执行记录送回 front，由 front 汇总。";

// #581 Phase 2：MCP 协议 lane 的提醒——动作面即工具面，模型文本输出只进日志。
const MANAGED_FRONT_MCP_REMINDER =
  " 你是 managed front agent，是三个方向的通信与调度控制面：对频道交流、对 owner 请求决定、对子 worker 派工/追问/验收；执行 worker 已由 supervisor 独立常驻。你没有执行面权限，也不要调用 party CLI。" +
  " 一切频道动作都必须通过 party MCP 工具完成：对频道简短交流或 worker 回报汇总用 party_reply；" +
  " 代码修改、多步排查、浏览器/运维或其它耗时工作用 party_worker_dispatch（instruction 必须自包含：完整任务、范围和验收标准）；需要返工/补证据用 party_worker_feedback；" +
  " 需要 owner 做权限、取舍或批准用 party_decision_ask（返回 waiting_owner 就结束本轮，owner 的答复会带上下文再次唤醒你）。" +
  " 你的自由文本输出不会进频道（只进日志）；没有任何工具调用的回合会被判定为未送达。";

const WORKER_MCP_REMINDER =
  " 你是 execution worker，不是频道 front。只执行这条有界派工，不再派生其它 agent；完成必要的代码、调查、浏览器或运维工作。" +
  " 完成后必须调用 party MCP 工具 party_worker_report 回报证据、风险和验收结果（交付物用 attach 从频道工作区上传）；" +
  " 你的自由文本输出不会进频道（只进日志），不调用 party_worker_report 的回合会被判定为未送达。不要调用 party CLI。";

function protocolReminder(projectAgent: ProjectAgentRunContext | null): string {
  const mcp = projectAgent?.protocol === "mcp";
  if (projectAgent?.runtime_role === "worker") {
    return COMMON_PROTOCOL_REMINDER + (mcp ? WORKER_MCP_REMINDER : WORKER_REMINDER);
  }
  if (projectAgent?.runtime_role === "front" && projectAgent.workers.length > 0) {
    return COMMON_PROTOCOL_REMINDER + (mcp ? MANAGED_FRONT_MCP_REMINDER : MANAGED_FRONT_REMINDER);
  }
  return COMMON_PROTOCOL_REMINDER + ADVISORY_FRONT_REMINDER;
}

function operatingContract(projectAgent: ProjectAgentRunContext | null) {
  if (projectAgent?.runtime_role === "worker") {
    return {
      role: "execution_worker",
      enforcement: "managed_profile",
      front_agent: projectAgent.front_agent,
      direct_actions: ["bounded_delegated_execution"],
      delegate_actions: [],
      result_boundary: "return evidence and results to the front agent through the supervisor-managed worker report",
    } as const;
  }
  const managed = projectAgent?.runtime_role === "front" && projectAgent.workers.length > 0;
  return {
    role: "front_agent",
    enforcement: managed ? "managed_profile" : "advisory",
    workers: projectAgent?.workers ?? [],
    direct_actions: [
      "short_channel_conversation",
      "single_read_only_check_needed_to_route_work",
      "worker_result_synthesis",
    ],
    delegate_actions: [
      "code_changes",
      "multi_step_investigation",
      "browser_or_operations_work",
      "other_long_running_execution",
    ],
    front_agent_responsibilities: [
      "channel_communication_and_visible_status",
      "owner_permission_tradeoff_and_decision_communication",
      "worker_dispatch_followup_acceptance_and_synthesis",
    ],
    unsupported_behavior: managed
      ? "managed front output is restricted to channel_reply, owner_decision, worker_dispatch, worker_feedback, or blocked actions"
      : "prefer delegating heavy work to a worker; when the harness cannot create one, complete it in this session rather than reporting blocked; use `party decision ask` for owner approval",
  } as const;
}

/**
 * 读取服务器发布版并生成 #485 提醒。探测失败时保留上一个已知结果，
 * 让启动和长驻 wake 都不被断网或旧部署阻断。
 */
export async function resolveAvailableUpgrade(
  server: string,
  current: CliUpgradeNotice | null = null,
  options: { autoDownload?: boolean; upgradeDeps?: UpgradeDeps; out?: (line: string) => void } = {},
): Promise<CliUpgradeNotice | null> {
  try {
    const notice = serverVersionUpgradeNotice((await fetchServerVersion(server)).version, options.upgradeDeps);
    if (notice === null) return null;
    if (options.autoDownload !== true) return notice;
    const installed = upgradeNotice(true, options.upgradeDeps);
    if (installed !== null && compareUpgradeVersion(installed.available_version, notice.available_version) >= 0) return installed;
    try {
      const result = await downloadPartyUpgrade({ version: notice.available_version }, options.upgradeDeps);
      return {
        ...notice,
        installed_version: result.target_version,
        auto_upgrade: true,
        action_required: "auto_reexec",
        message: `AgentParty 服务器已发布 party CLI v${notice.available_version}，已下载并校验新版二进制。本轮唤醒结束后 serve 会自动 re-exec 新版。`,
      };
    } catch (error) {
      options.out?.(`serve: 自动下载 party v${notice.available_version} 失败，保留人工升级提示: ${error instanceof Error ? error.message : String(error)}`);
      return notice;
    }
  } catch {
    return current;
  }
}

function compareUpgradeVersion(left: string, right: string): number {
  const parse = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

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
  /**
   * #690：runner **环境性**失败——认证过期 / 二进制缺失 / 沙箱拒权等在**模型启动之前**就崩的错。
   * 与 retriable 正交：environment=true 时模型确定没跑（放弃留痕不该再说「model may have run」），
   * 但认证/二进制没修好前立刻重试也是白烧（默认仍 retriable=false，快速放弃、把清晰的环境错拍进 runner_health
   * 让 owner 从 `party who` / `party wake test` 看得见），修好后由下一条 @ 或重连自愈。
   */
  readonly environment: boolean;
  constructor(message: string, retriable = false, opts?: { environment?: boolean }) {
    super(message);
    this.name = "WakeBlockedError";
    this.retriable = retriable;
    this.environment = opts?.environment ?? false;
  }
}

/** runner 占用超过硬上限；模型可能已经执行过，所以绝不能自动重跑。 */
export class RunnerTimeoutError extends WakeBlockedError {
  readonly timeoutMs: number;
  /** true only when the runner promise settled after abort; false means the process must exit before another wake. */
  terminationConfirmed = false;
  constructor(timeoutMs: number) {
    super(`runner timed out after ${timeoutMs}ms`, false);
    this.name = "RunnerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * managed worker 收到的这条 wake 根本不是 front 派给它的活（例如有人回复了 worker 的报告，服务端
 * 据 #544 自动补了一条 cause=reply 的定向投递）。worker 不是频道参与者，对这类 wake「无话可说」：
 * 定向投递照常 settle（不再重投），但不在频道刷一条 blocked 状态——否则每条闲聊回复都刷一次噪声。
 */
export class ManagedWorkerUndispatchedError extends WakeBlockedError {
  constructor(message: string) {
    super(message, false);
    this.name = "ManagedWorkerUndispatchedError";
  }
}

/** Process-level serve shutdown. This is terminal control flow, not a failed/retriable wake. */
export class ServeShutdownError extends Error {
  readonly exitCode: typeof EXIT_SIGNAL_INT | typeof EXIT_SIGNAL_TERM;
  constructor(signal: "SIGINT" | "SIGTERM") {
    super(`serve shutting down on ${signal}`);
    this.name = "ServeShutdownError";
    this.exitCode = signal === "SIGINT" ? EXIT_SIGNAL_INT : EXIT_SIGNAL_TERM;
  }
}

// 放弃通告都发不出去（网络/loop guard 熔断）。此时既没送达也没宣告，继续跑就是静默丢 @。
export const EXIT_WAKE_UNANNOUNCED = 1;

/** 连续放弃熔断：supervisor 已经无法履行唤醒职责，停止排空后续 @。 */
export const EXIT_WAKE_ABANDON_CIRCUIT = 11;

/** 已有 serve 挂在同一 (server identity, channel, machine) 上：拒绝启动，避免重复执行（#99/#465）。 */
export const EXIT_ALREADY_SERVING = 10;

/** Conventional shell exit codes for an explicitly interrupted resident serve. */
export const EXIT_SIGNAL_INT = 128 + 2;
export const EXIT_SIGNAL_TERM = 128 + 15;

/** 桌面「转为常驻」生成的 launchd job label 前缀(须与 desktop/src-tauri/src/duty.rs 的 DUTY_LABEL_PREFIX 一致)。 */
const DUTY_LABEL_PREFIX = "com.agentparty.duty.";

/**
 * #744:launchd 常驻下,「终局不该重启」的退出(熔断 EXIT_WAKE_ABANDON_CIRCUIT / 撤销 EXIT_AUTH)必须
 * 让 launchd 别 KeepAlive 重启——否则熔断的安全停机被绕过、或对着被撤 token 空转,且 launchd 还以为在线。
 * serve 自己 `launchctl bootout` 掉自己那个 job:launchd 移除它 → 不再重启,launchctl print/health/presence
 * 一致显示停机,人工重新「转为常驻」才复活。普通崩溃 / stream-ended **不** bootout,照常由 KeepAlive 自愈。
 * 只在 plist 传了 AP_DUTY_LABEL(桌面「转为常驻」会传)且 macOS 时生效;不改退出码契约,tmux/手动 supervisor 无感。
 * best-effort:bootout 失败也照常退出(退出码仍对,只是少了自卸载)。可注入 spawn 供测试。
 */
export function selfBootoutTerminalDuty(
  code: number,
  out: (line: string) => void,
  deps?: { platform?: string; uid?: number | null; label?: string; spawn?: typeof spawnSync },
): boolean {
  const label = deps?.label ?? process.env.AP_DUTY_LABEL;
  if (label === undefined || label === "") return false;
  const platform = deps?.platform ?? process.platform;
  if (platform !== "darwin") return false;
  if (code !== EXIT_WAKE_ABANDON_CIRCUIT && code !== EXIT_AUTH) return false;
  // 严格校验注入的 label(@macmini #744 评审):只接受我们自己生成的 duty label(前缀 + launchd 合法字符),
  // 否则拒绝——绝不拿一个猜的/被篡改的 label 去 bootout,免得卸载错的甚至宽泛目标。
  if (!label.startsWith(DUTY_LABEL_PREFIX) || !/^[A-Za-z0-9.-]+$/.test(label)) {
    // 不回显未验证的 label 原值(#745 CodeRabbit):非法即无信息价值,还可能是被塞的脏数据。
    out("serve: 拒绝自卸载——AP_DUTY_LABEL 不是合法的 duty label");
    return false;
  }
  const uid = deps?.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (uid === null) return false;
  const target = `gui/${uid}/${label}`;
  const reason = code === EXIT_WAKE_ABANDON_CIRCUIT ? "circuit-breaker" : "auth-revoked";
  out(`serve: 终局退出(${reason}, code=${code})——从 launchd 卸载自身(${label}),不再自动重启;修好后重新「转为常驻」。`);
  // bootout 必须是最后动作(@macmini #744 评审):它可能给 serve 发 SIGTERM,其后不能再有必需的清理/日志。
  // 必须检查返回值(#745 CodeRabbit):spawnSync 把非零退出/超时/命令找不到写进 result(不总是抛),
  // 只 try/catch 会静默吞掉——那样日志说「已卸载」但 job 还在、KeepAlive 照样重启,假的安全停机。
  try {
    const result = (deps?.spawn ?? spawnSync)("launchctl", ["bootout", target], { timeout: 5000 });
    // 成功仅当 status===0 且无 error;非零退出、超时/信号杀(status=null+signal)、命令找不到一律算失败。
    if (result.error !== undefined || result.status !== 0) {
      const why = result.error?.message ?? (result.signal != null ? `killed by ${result.signal}` : `exit ${result.status}`);
      out(`serve: ⚠ launchctl bootout 失败(${why})——自卸载未生效,launchd 可能仍 KeepAlive 重启;请人工:launchctl bootout ${target}`);
    }
  } catch (error) {
    out(`serve: ⚠ launchctl bootout 抛错(${error instanceof Error ? error.message : String(error)})——自卸载未生效;请人工:launchctl bootout ${target}`);
  }
  return true;
}

/** 传给 builtin runner 的提示：只给路径，不给正文（#120）。 */
export function wakePrompt(contextFile: string, projectAgent: ProjectAgentRunContext | null): string {
  return (
    `你在 AgentParty 频道里被 @ 了。唤醒上下文是一个 JSON 文件：${contextFile}\n` +
    `先读它（含 channel / seq / sender / body / mentions / charter / recent），再动手。\n` +
    protocolReminder(projectAgent)
  );
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// 有界重放（#198）：同一条 seq 连续送达失败到顶就响亮放弃，既不无限重放也不静默丢弃
// env 里保留的正文上限。完整正文走 stdin 与 context file。
const AP_BODY_MAX = 4_000;

const DEFAULT_MAX_WAKE_ATTEMPTS = 3;
const DEFAULT_WAKE_RETRY_DELAY_MS = 500;
// 无人值守 runner 的硬上限。owner 问答必须走 decision/waiting_owner，不能靠一个
// headless 子进程永久占住 serve。CLI 可按任务体量覆盖，测试直接注入毫秒值。
export const DEFAULT_RUNNER_TIMEOUT_MS = 30 * 60_000;
// managed front 单次 wake 的默认预算：这一个计时窗口要罩住初轮 + 最多 4 次 unattended 决策续轮、
// 血缘 REST 拉取与投递（见 MAX_AUTO_DECISION_CONTINUATIONS）。60s 罩不住多轮，单个 SDK/claude 轮
// 读 JSON wake context 就常常超 60s，会把决策已 POST 的 wake 判成不可重试超时并锁死会话。给足
// 余量，同时保留 --runner-timeout-seconds 向上/向下覆盖（不再用 Math.min 硬顶死 60s）。
export const DEFAULT_FRONT_RUNNER_TIMEOUT_MS = 10 * 60_000;
// 每任务心跳节奏（#228）：任务运行期间每隔这么久刷一次「还活着、正在处理 seq=X」。
// 15s 足够让频道/本机在几分钟的长任务里持续看到新鲜度，又远比逐 tick 便宜（presence-only，不落 history）。
const DEFAULT_TASK_HEARTBEAT_MS = 15_000;
// 普通频道 loop guard 是 30；必须远低于它，避免放弃通告先把频道熔断、随后静默丢消息。
const MAX_CONSECUTIVE_WAKE_ABANDONS = 3;
const BLOCKED_ERROR_MAX = 300;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function projectAgentCleanupCommand(baseBranch: string): string {
  return `party worktree prune --base ${shellQuote(baseBranch)} --remote --yes`;
}

function readyNoteField(value: string, maxLength: number): string {
  return value
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function terminalOutput(value: string): string {
  return stripTerminalControls(value);
}

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
const SERVE_LIFECYCLE_LOG_FILE = "serve-lifecycle.log";
const DEFAULT_SUPERVISOR_RESTART_DELAY_MS = 1_000;
const MAX_SUPERVISOR_RESTART_DELAY_MS = 30_000;
const RUNNER_TERMINATION_GRACE_MS = 1_000;
const RUNNER_TERMINATION_BARRIER_MS = RUNNER_TERMINATION_GRACE_MS + 500;
const DELIVERY_UPDATE_ACK_TIMEOUT_MS = 5_000;

export type RunnerHarness = "codex" | "claude";

export interface RunnerProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunnerProcessOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** serve runner 超时或退出时取消子进程；默认执行器会终止整个进程组。 */
  signal?: AbortSignal;
}

export type RunnerProcess = (
  args: string[],
  opts: RunnerProcessOptions,
) => Promise<RunnerProcessResult>;

export interface RoutedRunnerMessage {
  replyTo: number;
  text: string;
  mentions?: string[];
  /** Complete the current directed wake when the human-facing reply targets an earlier origin. */
  completionSummarySeq?: number;
  completionState?: "done" | "blocked";
  blockedReason?: string;
  decisionRequest?: SendDecisionRequest;
  expectedDecisionLineage?: {
    delivery_id: string;
    work_id: string;
    continuation_ref: string;
  };
  /** Server-private account constraint for a managed owner decision. */
  expectedDecisionResponderOwner?: string;
}

export type RunnerResultRoute = (
  frame: MsgFrame,
  text: string,
  marker: string | null,
  delivery: DirectedDelivery | null,
) => RoutedRunnerMessage | Promise<RoutedRunnerMessage>;

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

/**
 * Abort a detached runner and always execute the SIGKILL escalation after the grace period.
 * The group leader may exit on SIGTERM while a grandchild ignores it; clearing the timer when
 * the leader exits would orphan that grandchild and let it overlap the next wake.
 */
async function terminateRunnerProcess(proc: KillableRunnerProcess): Promise<void> {
  if (process.platform === "win32") {
    // Node/Bun's direct child kill is not a tree guarantee on Windows. taskkill /T keeps the same
    // child+grandchild invariant as POSIX process groups; /F is the escalation barrier.
    try {
      await Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    } catch {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    }
    await delay(RUNNER_TERMINATION_GRACE_MS);
    try {
      await Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    } catch {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
    return;
  }
  try {
    forwardRunnerSignal(proc, "SIGTERM");
  } catch {
    // The leader can disappear before the first signal; the process-group SIGKILL below is authoritative.
  }
  await delay(RUNNER_TERMINATION_GRACE_MS);
  try {
    process.kill(-proc.pid, "SIGKILL");
    return;
  } catch {
    // Group is already gone; fall through to the direct-child best effort.
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // Already reaped.
  }
}

interface WakeSessionState extends RunnerContinuationState {
  harness: RunnerHarness;
  session_id: string;
  created_at: number;
  last_wake_ts: number;
  wakes: number;
  cwd?: string;
  workdir?: string;
  continuation_ref?: string;
  work_id?: string;
}

interface SdkWakeSessionState extends RunnerContinuationState {
  harness: "codex-sdk";
  thread_id: string;
  created_at: number;
  last_wake_ts: number;
  wakes: number;
  cwd?: string;
  workdir?: string;
  continuation_ref?: string;
  work_id?: string;
}

interface ContinuationScope {
  ref: string | null;
  workId: string | null;
  deliveryId: string | null;
  deliveryAttempt: number | null;
  path: string;
  ownerAnswer: boolean;
  directed: boolean;
}

export interface BuiltinRunnerOptions {
  server: string;
  token: string;
  channel: string;
  harness: RunnerHarness;
  workdir: string;
  cwd?: string;
  /** Child-only CLI identity pinned into the model process (#548). */
  agentpartyConfigPath?: string;
  /** Prevent the model process from inheriting any usable AgentParty identity. */
  isolateModelPartyAccess?: boolean;
  /** Front control plane is read-only; execution workers keep workspace-write. */
  sandbox?: "read-only" | "workspace-write";
  /** Supervisor-owned routing for managed front/worker results. */
  resultRoute?: RunnerResultRoute;
  /** Harness-enforced final response schema for the managed control plane. */
  outputSchema?: Record<string, unknown>;
  /** null disables host-file markers; a path confines them to that real workspace tree. */
  attachmentRoot?: string | null;
  /**
   * #581：managed MCP 协议 lane。runner 给 harness 注入 `party mcp --managed <stateDir>`
   * 的角色裁剪工具面；每个 wake 前 supervisor 写 wake.json，回合结束读动作回执结算。
   */
  managedMcp?: { stateDir: string; ownerDecisionBinding: () => boolean };
  repo?: string;
  runProcess?: RunnerProcess;
  runGit?: RunnerProcess;
  authSourceFile?: string;
  now?: () => number;
  post?: typeof postMessage;
  /** 交付物上传（#109）；默认真 REST。测试注入 mock。 */
  uploadAttachment?: typeof uploadAttachment;
  /** 模型 session 落盘后自报给频道 presence（issue #522）。 */
  onSession?: (session: AgentSessionInfo) => void;
}

export interface ThreadLike {
  id?: string | null;
  thread_id?: string | null;
  run(prompt: string, opts: { sandbox: string; signal?: AbortSignal; outputSchema?: Record<string, unknown> }): Promise<unknown>;
}

export interface CodexThreadOptions {
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface CodexClientOptions {
  env?: Record<string, string>;
}

export interface CodexLike {
  startThread(options?: CodexThreadOptions): ThreadLike | Promise<ThreadLike>;
  resumeThread(threadId: string, options?: CodexThreadOptions): ThreadLike | Promise<ThreadLike>;
}

export interface SdkRunnerOptions {
  server: string;
  token: string;
  channel: string;
  workdir: string;
  cwd?: string;
  /** Child-only CLI identity pinned into the SDK-spawned Codex process (#548). */
  agentpartyConfigPath?: string;
  isolateModelPartyAccess?: boolean;
  resultRoute?: RunnerResultRoute;
  outputSchema?: Record<string, unknown>;
  /** null disables host-file markers; a path confines them to that real workspace tree. */
  attachmentRoot?: string | null;
  sandbox?: string;
  codexFactory?: (options?: CodexClientOptions) => CodexLike | Promise<CodexLike>;
  now?: () => number;
  post?: typeof postMessage;
  /** 交付物上传（#109）；默认真 REST。测试注入 mock。 */
  uploadAttachment?: typeof uploadAttachment;
  /** 模型 session 落盘后自报给频道 presence（issue #522）。 */
  onSession?: (session: AgentSessionInfo) => void;
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
  /** managed profile 的控制面/执行面角色；普通 serve 不设置。 */
  runtime_role: ServeExecutionRole;
  /** #581：managed lane 协议。mcp=动作走角色裁剪的 MCP 工具；缺省按 text（旧文本信封）处理。 */
  protocol?: "mcp" | "text";
  /** 本频道的可对话 front identity。 */
  front_agent: string;
  /** supervisor 已启动、可接 durable delivery 的 execution workers。 */
  workers: readonly string[];
  channel_workdir: string;
  runner_workdir: string;
  delivery_workflow: {
    steps: readonly [
      "work_in_channel_worktree",
      "create_pull_request",
      "report_pull_request_url_in_channel",
      "verify_deployment",
      "prune_merged_worktree",
    ];
    cleanup_command: string;
    cleanup_guard: string;
  };
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
  delivery: DirectedDelivery | null = null,
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
    delivery: delivery === null
      ? null
      : {
          id: delivery.id,
          work_id: delivery.work_id,
          continuation_ref: delivery.continuation_ref,
          cause: delivery.cause,
          attempt: delivery.attempt,
        },
    decision_request: frame.decision_request ?? null,
    decision_response: frame.decision_response ?? null,
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
    operating_contract: operatingContract(projectAgent),
    protocol_reminder: protocolReminder(projectAgent),
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
  delivery: DirectedDelivery | null = null,
): string {
  // dir 必须由调用方按运行实例隔离。文件名只需 seq：同一次唤醒重复写得到同一路径（幂等），
  // 而不同实例——不同身份 / 不同 server / 不同 profile——各在各的目录里。
  const path = join(dir, `${frame.seq}.json`);
  writeFileSync(
    path,
    JSON.stringify(buildWakeContext(frame, channel, self, recent, charter, projectAgent, cliUpgrade, attachments, delivery), null, 2) + "\n",
    { mode: 0o600 },
  );
  return path;
}

function builtinRunnerContextDir(workdir: string): string {
  const dir = join(workdir, "wake-context");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function isolatedModelPartyEnv(workdir: string, server: string): Record<string, string> {
  const home = join(workdir, "model-agentparty-denied");
  const config = join(home, "config.json");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // A previous model turn controls files in its workspace. Never trust an existing path here: it
  // could be a symlink or a config rewritten with a discovered credential. Recreate the denied
  // file before every model boundary so the supervisor does not follow attacker-controlled links.
  writeFileSync(config, JSON.stringify({ server, token: "" }) + "\n", { mode: 0o600, flag: "wx" });
  return {
    AGENTPARTY_HOME: home,
    AGENTPARTY_CONFIG: config,
    AGENTPARTY_TOKEN: "",
  };
}

// #581：给 harness 注入的 party 可执行体。编译版直接用自身路径（不受 PATH 漂移影响）；
// dev（bun test）下回落 PATH 上的 party。
export function managedPartyBinary(): string {
  return isPartyBinaryPath(process.execPath) ? process.execPath : "party";
}

// #581：claude --mcp-config 只认文件/JSON 串；写进 stateDir（0700）与其余 managed 握手文件同处。
function writeManagedClaudeMcpConfig(stateDir: string): string {
  const path = join(stateDir, "mcp-config.json");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: { party: { command: managedPartyBinary(), args: ["mcp", "--managed", stateDir] } },
    }) + "\n",
    { mode: 0o600 },
  );
  return path;
}

function writeRunnerOutputSchema(workdir: string, schema: Record<string, unknown>): string {
  const path = join(workdir, "runner-output-schema.json");
  mkdirSync(workdir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(schema) + "\n", { mode: 0o600 });
  return path;
}

/**
 * runner workdir 按 (频道, 身份) 隔离（#99）。
 *
 * 旧实现只按频道键（`~/.agentparty/runners/<channel>`）。同机两个身份 serve 同一频道时，
 * 它们共享同一个 wake-session.json：互相把对方的 codex/claude session id 覆盖掉，
 * 而 builtin runner 在 resume 失败时会 fork 出一个新 session——于是重复执行。
 *
 * namespace 必须先由 authoritative `/api/me` 身份计算，身份未知时不创建默认 workdir。
 */
export function runnerWorkdir(root: string, channel: string, namespace: string): string {
  const safe = (part: string) => part.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, "_") || "_";
  if (!/^[a-f0-9]{64}$/.test(namespace)) throw new Error("runner namespace must be a sha256 digest");
  return join(root, namespace, safe(channel));
}

/**
 * 默认 runner workdir。namespace 必须来自当前 server 的 authoritative `/api/me`，绝不读取
 * 可能已切服/换身份的本地 config 快照。有 owner 的 token 按 owner 稳定续会；legacy
 * owner-less token 按 token sha256 隔离，避免同名 token 撤销重铸后接管旧 session。
 */
export function defaultRunnerWorkdir(channel: string, namespace: string): string {
  const stateRoot = process.env.AGENTPARTY_HOME ?? join(homedir(), ".agentparty");
  return runnerWorkdir(join(stateRoot, "runners"), channel, namespace);
}

const SERVE_FLAGS = ["channel", "on-mention", "all", "runner", "workdir", "repo", "auto-upgrade", "replay-backlog", "profile", "profile-once", "profile-poll-interval", "runner-timeout-seconds", "protocol", "stop"];
const HELP = `usage: party serve [channel|--channel C] (--on-mention "<cmd>" | --runner codex|claude|codex-sdk) [--all]
       party serve --profile <owner>/<handle>

Stay attached to a channel and run one local command for each matching message.
The command can read the context JSON path from {file} or AP_CONTEXT_FILE.

Options:
  --channel C          serve channel C instead of the bound channel
  --on-mention "<cmd>" run a fresh custom process for each wake
                       owner answers rerun it with the same AP_WORK_ID/AP_CONTINUATION_REF
                       and decision_response in AP_CONTEXT_FILE; no model session is resumed
  --runner codex|claude|codex-sdk
                       use the built-in isolated wake runner instead of a custom command
  --workdir DIR        runner workdir (default: ~/.agentparty/runners/<principal-sha256>/<channel>)
  --repo URL           clone into workdir/repo once, then git pull --ff-only before each wake
  --runner-timeout-seconds N
                       terminate one stuck runner after N seconds (default: ${DEFAULT_RUNNER_TIMEOUT_MS / 1000})
  --profile ref        run the reusable project-agent profile as one resident daemon across all invites
  --protocol mcp|text  managed lane protocol (default mcp: role-trimmed party MCP tools; text is a
                       deprecated escape hatch kept for one minor cycle)
  --auto-upgrade       between wakes, if a newer party binary is on disk, re-exec it (issue #45)
  --stop               stop only THIS identity's serve on the channel (safe on multi-agent hosts;
                       resolves your own listener via the instance lock — unlike pkill -f, issue #741)
  --replay-backlog     on attach, replay the offline backlog one wake per message
                       (default: skip the backlog, advance the cursor, and print
                       how many were skipped — serve wakes only for messages that
                       arrive AFTER it attaches, issue #193. An undelivered wake
                       (stuck, issue #198) is a debt, not backlog: it always replays.)
  --all                run for every non-self message, not only @mentions

Supervisor safety: after ${MAX_CONSECUTIVE_WAKE_ABANDONS} consecutive wakes are abandoned, serve posts a final
blocked status and exits nonzero instead of consuming later messages.`;

export interface ServeRunnerContext {
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
  /** 排在当前 wake 身后、尚未处理的 wake 数（#103）。 */
  queueDepth?: number;
  /** Worker 持久 work；存在时 read cursor 与 backlog 策略不得决定是否执行。 */
  delivery?: DirectedDelivery | null;
  /** runner hard-timeout / serve shutdown 的取消信号。 */
  signal?: AbortSignal;
}

export type ServeRunner = ((frame: MsgFrame, ctx: ServeRunnerContext) => Promise<void>) & {
  /** Everything that can fail before the model starts. Called before durable `running`. */
  prepare?: (frame: MsgFrame, ctx: ServeRunnerContext) => Promise<void>;
  /** Release per-work model state only after the Worker confirms a terminal delivery. */
  onDeliveryTerminal?: (delivery: DirectedDelivery, state: "replied" | "failed") => void | Promise<void>;
};

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
  runCommand?: ServeRunner;
  sdkRunner?: SdkRunnerOptions;
  // serve 挂上后声明自己「可被唤醒」的钩子；run() 注入真实实现，测试可省略/替换
  advertise?: (signal?: AbortSignal) => Promise<void>;
  /**
   * 首个 welcome 已被本次 runServe 实际消费。外层 supervisor 只能在这个边界后
   * 把后续连接视为「内部重启」；连 welcome 都没收到的失败仍必须保留用户的
   * 首次 backlog 策略。
   */
  onWelcome?: () => void;
  /** 每个 welcome 上报服务端能力位（用于 managed front 判断 owner 决策绑定是否被强制）。 */
  onServerCapabilities?: (caps: { ownerDecisionBinding: boolean }) => void;
  charter?: ChannelCharter | null;
  projectAgent?: ProjectAgentRunContext | null;
  fetchCharter?: (signal?: AbortSignal) => Promise<ChannelCharter>;
  // 唤醒间隙发现磁盘装了更新的 party 就自动 re-exec 新版（issue #45）；默认只提示不动。
  autoUpgrade?: boolean;
  upgradeDeps?: UpgradeDeps; // 测试注入版本读取/re-exec
  /** /api/version 发现服务器已有更新 CLI 时，随下一次 wake 交给 agent 主动提醒 owner（#485）。 */
  availableUpgrade?: CliUpgradeNotice | null;
  /** 长驻 serve 在后续 wake 前低频刷新服务器发布版；探测失败时必须保留旧值。 */
  refreshAvailableUpgrade?: (current: CliUpgradeNotice | null) => Promise<CliUpgradeNotice | null>;
  /** 服务器版本刷新间隔；测试可注入 0。 */
  upgradeProbeIntervalMs?: number;
  out?: (line: string) => void;
  statusline?: boolean;
  /** 每任务心跳间隔（#228）。默认 DEFAULT_TASK_HEARTBEAT_MS；测试注入更短值。 */
  heartbeatIntervalMs?: number;
  /** 时钟注入（#228）：任务开始时刻与每次心跳时刻走它，便于测试断言心跳在推进。默认 Date.now。 */
  now?: () => number;
  /** 单次 runner 的硬超时；默认 30 分钟。到点后恢复监听，不再让 task heartbeat 无限伪装健康。 */
  runnerTimeoutMs?: number;
  /** WS 入站 watchdog 阈值；仅供诊断/测试注入，默认沿用 client 的 3 个 ping 周期。 */
  inboundIdleTimeoutMs?: number;
  /** 外层 profile/supervisor 持有的生命周期；存在时 runServe 不再注册进程级 signal listener。 */
  signal?: AbortSignal;
}

// serve 一挂上就把 presence 标成可唤醒：residency=supervised + wake.kind=serve。
// 没这一步，agent 跑了 serve 但 presence 仍是 null → 别人 party wake test @你 会判 not_auto_wakeable，
// agent 得自己再手动 party status --wake-kind serve --residency supervised 才行（外部 agent 就卡在这半天）。
export async function advertiseServeWake(
  auth: ResolvedAuthDetailed,
  channel: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!auth.server || !auth.token) return;
  await postMessage(auth.server, auth.token, channel, {
    kind: "status",
    state: "waiting",
    note: "serve supervisor 已挂上——被 @ 才唤起你一次，等待零 token",
    mentions: [],
    residency: "supervised",
    wake: { kind: "serve" },
    context: buildContext(auth),
  }, signal);
}

// 默认执行器：把上下文写成 context file → sh -c <cmd>（cmd 里的 {file} 替成路径，也放进 AP_CONTEXT_FILE）。
// 正文仍走 stdin + AP_* env 图省事；context file 是给需要稳健取全量的 runner 用。串行等它退出。
// 非零退出：打印 exit code + context file 路径（便于排查），并保留文件；成功则清理。
async function defaultRun(
  frame: MsgFrame,
  ctx: ServeRunnerContext,
): Promise<void> {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  const file = writeContextFile(ctx.contextDir, frame, ctx.channel, ctx.self, ctx.recent, ctx.charter, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null, ctx.attachments, ctx.delivery ?? null);
  const cmd = ctx.cmd.includes("{file}") ? ctx.cmd.replaceAll("{file}", file) : ctx.cmd;
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdin: new TextEncoder().encode(body),
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      // Nested party commands must stay on the served channel even when the workspace is bound to
      // another one. AP_CHANNEL is informational; resolveChannel intentionally reads this binding.
      AGENTPARTY_CHANNEL: ctx.channel,
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
      // Explicit custom continuation contract: an owner_answer starts this same command as a fresh
      // process. The script recovers idempotently from AP_WORK_ID + AP_CONTEXT_FILE; party does not
      // pretend an arbitrary shell command has a resumable model session.
      AP_RUNNER_HARNESS: "custom",
      AP_DELIVERY_ID: ctx.delivery?.id ?? "",
      AP_WORK_ID: ctx.delivery?.work_id ?? "",
      AP_CONTINUATION_REF: ctx.delivery?.continuation_ref ?? "",
      AP_DELIVERY_ATTEMPT: ctx.delivery ? String(ctx.delivery.attempt) : "",
    },
    detached: process.platform !== "win32",
  });
  let termination: Promise<void> | null = null;
  const abort = () => {
    termination ??= terminateRunnerProcess(proc);
  };
  ctx.signal?.addEventListener("abort", abort, { once: true });
  if (ctx.signal?.aborted) abort();
  let code: number;
  try {
    code = await proc.exited;
  } finally {
    ctx.signal?.removeEventListener("abort", abort);
    // Do not let leader exit cancel the group escalation.  The next wake may start only after this barrier.
    if (termination !== null) await termination;
  }
  if (ctx.signal?.aborted) {
    throw ctx.signal.reason instanceof Error
      ? ctx.signal.reason
      : new WakeBlockedError("custom runner aborted", false);
  }
  if (code !== 0) {
    // 保留 context file 供排查，抛错让 runServe 打印（不发频道）
    // POSIX shell 用 128 + signal 表示被信号终止；143 = 128 + SIGTERM(15)。
    // 明说 SIGTERM，避免 owner 只能看到一个难以辨认的数字、误以为 serve 静默吞掉了 wake。
    const signal = code === 143 ? " (SIGTERM)" : "";
    throw new Error(`command exited ${code}${signal} (context: ${file})`);
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

function resolveRunnerAttachmentPath(path: string, attachmentRoot: string | null | undefined): string {
  if (attachmentRoot === null) {
    throw new WakeBlockedError("managed front host-file attachments are disabled", false);
  }
  if (attachmentRoot === undefined) return path;
  const realRoot = realpathSync(attachmentRoot);
  if (!statSync(realRoot).isDirectory()) {
    throw new WakeBlockedError(`runner attachment root is not a directory: ${attachmentRoot}`, false);
  }
  const realPath = realpathSync(path);
  const fromRoot = relative(realRoot, realPath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new WakeBlockedError(`runner attachment escapes allowed workspace: ${path}`, false);
  }
  // Read the resolved target, not the model-controlled symlink path checked above.
  return realPath;
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
  mentions?: string[];
  decisionRequest?: SendDecisionRequest;
  expectedDecisionLineage?: RoutedRunnerMessage["expectedDecisionLineage"];
  expectedDecisionResponderOwner?: RoutedRunnerMessage["expectedDecisionResponderOwner"];
  attachmentRoot?: string | null;
}): Promise<Awaited<ReturnType<typeof postMessage>>> {
  const {
    post,
    upload,
    server,
    token,
    channel,
    replyTo,
    text,
    marker,
    mentions = [],
    decisionRequest,
    expectedDecisionLineage,
    expectedDecisionResponderOwner,
    attachmentRoot,
  } = opts;
  // [attach:/abs/path]：交付物永远走 R2 附件（相对路径在此抛错，与旧行为一致）。
  // attachmentRoot===null 表示这个 lane（managed front）根本没有附件能力：此时 marker 只是普通
  // 文字（例如 front 在给 worker 的派工指令里引用这行语法），原样带过去即可，绝不能因为「提到」
  // 附件语法就把整次 wake 判成 blocked。
  const attachPath = attachmentRoot === null ? null : attachmentPathFromRunnerText(text);
  if (decisionRequest !== undefined && attachPath !== null) {
    throw new Error("managed owner decision cannot be delivered as an attachment");
  }
  if (attachPath !== null) {
    const allowedPath = resolveRunnerAttachmentPath(attachPath, attachmentRoot);
    const bytes = readFileSync(allowedPath); // Buffer：逐字节，不做 utf8 往返，保住 #41 的完整性
    const filename = safeAttachmentFilename(basename(allowedPath));
    const ref = await upload(server, token, channel, filename, bytes, guessAttachmentContentType(filename));
    const rest = stripAttachLines(text);
    const parts: string[] = [];
    if (marker) parts.push(marker);
    if (rest) parts.push(rest);
    if (parts.length === 0) parts.push(`[attached ${filename}]`);
    return await post(server, token, channel, {
      kind: "message",
      body: clampInlineBody(parts.join("\n")),
      mentions,
      reply_to: replyTo,
      attachments: [ref],
    });
  }

  const inline = marker ? `${marker}\n${text}` : text;
  const inlineBytes = Buffer.byteLength(inline, "utf8");
  if (inlineBytes > BODY_LIMIT) {
    // 正文超 inline 上限：整段传成 R2 附件，正文只留一行指引（#109），不再撞 413。
    const filename = `delivery-seq${replyTo}.md`;
    const ref = await upload(server, token, channel, filename, Buffer.from(inline, "utf8"), "text/markdown; charset=utf-8");
    return await post(server, token, channel, {
      kind: "message",
      body: `[reply body ${inlineBytes} bytes exceeded the ${BODY_LIMIT}-byte inline limit; delivered as attachment ${filename}]`,
      mentions,
      reply_to: replyTo,
      attachments: [ref],
    });
  }

  const payload: Parameters<typeof post>[3] & {
    expected_decision_lineage?: RoutedRunnerMessage["expectedDecisionLineage"];
    expected_decision_responder_owner?: RoutedRunnerMessage["expectedDecisionResponderOwner"];
  } = {
    kind: "message",
    body: inline,
    mentions,
    reply_to: replyTo,
    ...(decisionRequest === undefined ? {} : { decision_request: decisionRequest }),
    ...(expectedDecisionLineage === undefined ? {} : { expected_decision_lineage: expectedDecisionLineage }),
    ...(expectedDecisionResponderOwner === undefined
      ? {}
      : { expected_decision_responder_owner: expectedDecisionResponderOwner }),
  };
  return await post(server, token, channel, payload);
}

interface AutoDecisionContinuation {
  requestSeq: number;
  prompt: string;
  chosenOption: string;
}

interface RunnerDeliveryOutcome {
  autoDecision?: AutoDecisionContinuation;
}

const MAX_AUTO_DECISION_CONTINUATIONS = 4;

function autoDecisionContinuationPrompt(decision: AutoDecisionContinuation): string {
  return (
    `频道处于 unattended 决策模式；你刚才的 owner_decision #${decision.requestSeq} 已自动选择：${decision.chosenOption}。\n` +
    `原问题：${decision.prompt}\n` +
    "继续履行 managed front 的三向沟通职责，并按同一个六字段 JSON schema 只输出下一步动作。"
  );
}

async function deliverRunnerResult(opts: {
  frame: MsgFrame;
  text: string;
  marker: string | null;
  delivery?: DirectedDelivery | null;
  route?: RunnerResultRoute;
  post: typeof postMessage;
  upload: typeof uploadAttachment;
  server: string;
  token: string;
  channel: string;
  attachmentRoot?: string | null;
}): Promise<RunnerDeliveryOutcome> {
  const routed = opts.route === undefined
    ? { replyTo: opts.frame.seq, text: opts.text }
    : await opts.route(opts.frame, opts.text, opts.marker, opts.delivery ?? null);
  const delivered = await deliverRunnerMessage({
    post: opts.post,
    upload: opts.upload,
    server: opts.server,
    token: opts.token,
    channel: opts.channel,
    replyTo: routed.replyTo,
    text: routed.text,
    marker: opts.route === undefined ? opts.marker : null,
    mentions: routed.mentions,
    decisionRequest: routed.decisionRequest,
    expectedDecisionLineage: routed.expectedDecisionLineage,
    expectedDecisionResponderOwner: routed.expectedDecisionResponderOwner,
    // A supervisor-owned route is managed. It is fail-closed unless that lane explicitly grants a
    // real workspace root; legacy non-routed runners preserve their historical attachment behavior.
    attachmentRoot: opts.route === undefined ? opts.attachmentRoot : opts.attachmentRoot ?? null,
  });
  if (routed.completionSummarySeq !== undefined) {
    const completionState = routed.completionState ?? "done";
    await opts.post(opts.server, opts.token, opts.channel, {
      kind: "status",
      state: completionState,
      note: completionState === "blocked"
        ? routed.blockedReason ?? `managed front blocked for seq=${routed.completionSummarySeq}`
        : `front synthesis delivered for seq=${routed.completionSummarySeq}`,
      mentions: [],
      summary_seq: routed.completionSummarySeq,
      ...(completionState === "blocked"
        ? { blocked_reason: routed.blockedReason ?? "managed front reported blocked" }
        : {}),
    });
  }
  const resolution = delivered?.decision_resolution;
  if (resolution?.state === "auto_resolved") {
    if (routed.decisionRequest === undefined || typeof resolution.chosen_option !== "string") {
      throw new Error("auto-resolved managed decision is missing its continuation payload");
    }
    return {
      autoDecision: {
        requestSeq: delivered.seq,
        prompt: routed.decisionRequest.prompt,
        chosenOption: resolution.chosen_option,
      },
    };
  }
  return {};
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
  let termination: Promise<void> | null = null;
  const onAbort = () => {
    termination ??= terminateRunnerProcess(proc);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
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
    opts.signal?.removeEventListener("abort", onAbort);
    if (termination !== null) await termination;
  }
  if (opts.signal?.aborted) {
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new WakeBlockedError(`builtin runner aborted`, false);
  }
  return { code, stdout, stderr };
}

function readSession(path: string, harness: RunnerHarness): WakeSessionState | null {
  const state = readRunnerContinuation(path);
  return state?.harness === harness && typeof state.session_id === "string"
    ? state as WakeSessionState
    : null;
}

function continuationScope(workdir: string, delivery: DirectedDelivery | null | undefined): ContinuationScope {
  if (delivery === null || delivery === undefined) {
    return {
      ref: null,
      workId: null,
      deliveryId: null,
      deliveryAttempt: null,
      path: join(workdir, RUNNER_SESSION_FILE),
      ownerAnswer: false,
      directed: false,
    };
  }
  const workId = delivery.work_id;
  const ref = delivery.continuation_ref;
  if (typeof workId !== "string" || workId.trim().length === 0 || typeof ref !== "string" || ref.trim().length === 0) {
    throw new WakeBlockedError(
      `directed delivery ${delivery.id} is missing its durable work_id/continuation_ref`,
      false,
    );
  }
  return {
    ref,
    workId,
    deliveryId: delivery.id,
    deliveryAttempt: delivery.attempt,
    // continuation_ref is server data, not a path segment. The shared helper hashes the full opaque
    // value, so both the runner and `party decision ask` commit to exactly the same collision-safe path.
    path: continuationPath(workdir, ref),
    ownerAnswer: delivery.cause === "owner_answer",
    directed: true,
  };
}

function scopedSession<T extends { work_id?: string; continuation_ref?: string }>(
  scope: ContinuationScope,
  read: (path: string) => T | null,
  label: string,
): T | null {
  const state = read(scope.path);
  if (!scope.directed) return state;
  if (state === null) {
    if (scope.ownerAnswer || existsSync(scope.path)) {
      const reason = existsSync(scope.path) ? "invalid or mismatched" : "missing";
      throw new WakeBlockedError(
        `${label} owner continuation ${reason}: work_id=${scope.workId} continuation_ref=${scope.ref}`,
        false,
      );
    }
    return null;
  }
  if (state.work_id !== scope.workId || state.continuation_ref !== scope.ref) {
    throw new WakeBlockedError(
      `${label} continuation mapping mismatch: expected work_id=${scope.workId} continuation_ref=${scope.ref}`,
      false,
    );
  }
  const blockedReason = (state as T & { resume_blocked_reason?: unknown }).resume_blocked_reason;
  if (typeof blockedReason === "string" && blockedReason.length > 0) {
    throw new WakeBlockedError(
      `${label} continuation resume blocked: ${blockedReason}; work_id=${scope.workId} continuation_ref=${scope.ref}`,
      false,
    );
  }
  return state;
}

function writeSession(path: string, state: WakeSessionState): WakeSessionState {
  return mergeRunnerContinuation(path, state) as WakeSessionState;
}

function readSdkSession(path: string): SdkWakeSessionState | null {
  const state = readRunnerContinuation(path);
  return state?.harness === "codex-sdk" && typeof state.thread_id === "string"
    ? state as SdkWakeSessionState
    : null;
}

const INVALID_SESSION_CODES = new Set([
  "conversation_not_found",
  "invalid_session",
  "invalid_session_id",
  "resume_not_found",
  "session_not_found",
  "thread_not_found",
]);

function structuredErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["code", "type", "error_code"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && INVALID_SESSION_CODES.has(candidate.toLowerCase())) return candidate;
  }
  return record.error === value ? null : structuredErrorCode(record.error);
}

/**
 * 只识别能证明 resume 在模型启动前就失败的 session/thread 不存在错误。
 * 其它非零退出一律沿用 #206 的副作用安全边界：不可 cold-start 重跑。
 */
export function isInvalidPersistedSessionFailure(result: Pick<RunnerProcessResult, "stdout" | "stderr">): boolean {
  for (const line of `${result.stderr}\n${result.stdout}`.split(/\r?\n/).reverse()) {
    const text = line.trim();
    if (!text) continue;
    try {
      if (structuredErrorCode(JSON.parse(text)) !== null) return true;
    } catch {
      // 自由文本可能来自模型输出或交付阶段，不能证明模型尚未启动；绝不据此重跑当前 wake。
    }
  }
  return false;
}

function isInvalidPersistedSessionError(error: unknown): boolean {
  return structuredErrorCode(error) !== null;
}

// #690：识别 runner **环境性**失败——凭据过期 / 未登录 / 二进制缺失 / 沙箱拒权。这类错在模型启动**之前**
// 就把 runner 崩掉（`claude -p` 秒退 exit 1），既非「model may have run」也非可 cold-start 重跑的 session 失效。
// 只匹配明确的环境指纹（保守：宁可漏判也不把真实的模型失败误标成环境错），命中即：
//   ① 放弃留痕说「runner environment failure — model did not run」而非「model may have run」；
//   ② 拍进 runner_health.last_error，owner 从 `party who` / `party wake test` 看得见（#603 观测面）。
const RUNNER_ENV_FAILURE_PATTERNS: readonly RegExp[] = [
  /oauth[^\n]*(expired|refresh)/i,
  /(session|token|credential)[^\n]*expired/i,
  /failed to authenticate/i,
  /authentication[_\s-]*(error|failed|required)/i,
  /not (logged in|authenticated)/i,
  /please run\b[^\n]*login/i,
  /\bclaude (login|setup-token)\b/i,
  /invalid api key/i,
  /\b(401|403)\b[^\n]*(unauthorized|forbidden)/i,
  /\bunauthorized\b/i,
  // 二进制缺失 / 无法执行（spawn 前后都可能落到 stderr）。
  /command not found/i,
  /no such file or directory/i,
  /\benoent\b/i,
  /permission denied/i,
];

// 只扫 stderr，绝不扫 stdout：环境错（认证/spawn/权限）都落 stderr；而 stdout 是**模型输出**——若模型正好
// 写了「unauthorized」「permission denied」之类的字样，扫进来就会把一次真实的模型运行误判成「model did not run」，
// 正好颠倒 environment 标志的语义（CodeRabbit #693）。stderr-only 既覆盖真实指纹又杜绝这条误报路径。
export function isRunnerEnvFailure(result: Pick<RunnerProcessResult, "stderr">): boolean {
  return RUNNER_ENV_FAILURE_PATTERNS.some((re) => re.test(result.stderr));
}

// #748：claude `-p --output-format json` 命中环境性 auth/api 失败时，结构化错误落在 **stdout 的 JSON**
// （`is_error:true, terminal_reason:"api_error", result:"...OAuth session expired..."`）而非 stderr，exit 1。
// isRunnerEnvFailure 只扫 stderr（#693 为躲模型输出误报），会把这类漏判成通用「exit-1 / model may have run」：
// 不标 env failure、不触发 #744 自卸载、频道只显示没头没脑的 exit-1，owner 看不出是凭据过期。
// 这里只吃**结构化字段**：仅当 `is_error===true && terminal_reason==="api_error"` 且 `result` 命中环境错指纹
// 才判 env failure——正常模型输出 `is_error:false`（即便正文含「unauthorized」），绝不误报，不重犯 #693。
export function claudeJsonEnvFailure(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  // JSON.parse 对 "null"/数字/字符串等合法 JSON 返回非对象值——直接取属性会抛(合法 null 更会),
  // 别让失败处理自身崩(CodeRabbit #752)。只认对象体。
  if (typeof parsed !== "object" || parsed === null) return false;
  const body = parsed as Record<string, unknown>;
  if (body.is_error !== true || body.terminal_reason !== "api_error") return false;
  const result = typeof body.result === "string" ? body.result : "";
  return RUNNER_ENV_FAILURE_PATTERNS.some((re) => re.test(result));
}

function writeSdkSession(path: string, state: SdkWakeSessionState): SdkWakeSessionState {
  return mergeRunnerContinuation(path, state) as SdkWakeSessionState;
}

function persistedAgentSession(o: Pick<ServeOptions, "builtinRunner" | "sdkRunner">): AgentSessionInfo | null {
  if (o.builtinRunner !== undefined) {
    const state = readSession(join(o.builtinRunner.workdir, RUNNER_SESSION_FILE), o.builtinRunner.harness);
    if (state === null) return null;
    return {
      harness: state.harness,
      session_id: state.session_id,
      updated_at: state.last_wake_ts,
      cwd: state.cwd ?? o.builtinRunner.cwd ?? o.builtinRunner.workdir,
      workdir: state.workdir ?? o.builtinRunner.workdir,
    };
  }
  if (o.sdkRunner !== undefined) {
    const state = readSdkSession(join(o.sdkRunner.workdir, RUNNER_SESSION_FILE));
    if (state === null) return null;
    return {
      harness: "codex-sdk",
      session_id: state.thread_id,
      updated_at: state.last_wake_ts,
      cwd: state.cwd ?? o.sdkRunner.workdir,
      workdir: state.workdir ?? o.sdkRunner.workdir,
    };
  }
  return null;
}

function shortSid(sid: string | null | undefined): string {
  return sid ? sid.slice(0, 8) : "unknown";
}

function appendRunnerLog(workdir: string, line: string): void {
  appendFileSync(join(workdir, RUNNER_LOG_FILE), line + "\n");
}

function appendServeLifecycleLog(workdir: string, line: string): void {
  mkdirSync(workdir, { recursive: true, mode: 0o700 });
  appendFileSync(join(workdir, SERVE_LIFECYCLE_LOG_FILE), line + "\n");
}

// Codex 打印 session id 的格式在版本间漂移过（`session id:` / `session_id:`，有时落 stderr）。
// 宽松匹配 id/_id、大小写无关、两个流都扫，避免因一行文案变化就丢掉会话续跑（#726）。
function parseCodexSessionId(...streams: (string | null | undefined)[]): string | null {
  for (const s of streams) {
    const m = s?.match(/session[ _]id:\s*([0-9a-fA-F][0-9a-fA-F-]{7,})/i)?.[1];
    if (m) return m;
  }
  return null;
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
  delivery: DirectedDelivery | null = null,
): string {
  return JSON.stringify(buildWakeContext(frame, channel, self, recent, charter, projectAgent, cliUpgrade, attachments, delivery), null, 2) + "\n";
}

function sdkThreadId(thread: ThreadLike): string | null {
  // codex-sdk 在 run() 之前 thread id 可能还是 null（懒初始化），不能直接抛
  if (typeof thread.id === "string") return thread.id;
  if (typeof thread.thread_id === "string") return thread.thread_id;
  return null;
}

async function defaultCodexFactory(options: CodexClientOptions = {}): Promise<CodexLike> {
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
  const CodexCtor = Codex as new (options?: CodexClientOptions) => CodexLike;
  return new CodexCtor(options);
}

function sdkSandboxMode(value: string | undefined): CodexThreadOptions["sandboxMode"] {
  switch (value) {
    case "read_only":
    case "read-only":
      return "read-only";
    case "workspace_write":
    case "workspace-write":
      return "workspace-write";
    case "danger-full-access":
    case "full_access":
    case undefined:
      return "danger-full-access";
    default:
      return "danger-full-access";
  }
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
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
    if (body.structured_output !== undefined) {
      return { sessionId, text: JSON.stringify(body.structured_output) };
    }
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
  signal?: AbortSignal,
): Promise<string | null> {
  if (!opts.repo) return null;
  const repoDir = join(opts.workdir, "repo");
  const runGit = opts.runGit ?? defaultRunnerProcess;
  const args = existsSync(repoDir)
    ? ["git", "-C", repoDir, "pull", "--ff-only"]
    : ["git", "clone", opts.repo, repoDir];
  const res = await runGit(args, { cwd: opts.workdir, env, signal });
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

// 活动上报（#602）：给 builtin claude runner 注入 session 级 hooks——每个关键 hook 事件都管道进
// `party hook report`，把「正在跑哪个工具 / 卡权限 / compact / turn 结束」落成 AP_ACTIVITY_FILE
// 指向的本地文件，serve 的 15s 任务心跳捎带上行。编译版二进制用绝对路径（runner 的 PATH 里未必有
// party）；dev（bun run）下 execPath 是 bun，回退裸 `party`。timeout 收紧到 10s：hook 挂死不许拖模型。
export function claudeHookSettingsJson(execPath: string = process.execPath): string {
  const partyBin = isPartyBinaryPath(execPath) ? execPath : "party";
  // hook command 是交给 shell 的一整串：绝对路径一律 JSON.stringify 包双引号并转义（空白、引号、
  // 反斜杠都盖住；双引号在 POSIX sh 与 cmd 下都成立——单引号会破 Windows）。裸 `party` 不引，
  // 保持 PATH 查找语义。路径里的 `$` 反引号属 POSIX 双引号残余风险，party 安装路径不含此类字符。
  const command = `${partyBin === "party" ? partyBin : JSON.stringify(partyBin)} hook report`;
  const hook = [{ hooks: [{ type: "command", command, timeout: 10 }] }];
  return JSON.stringify({
    hooks: {
      PreToolUse: hook,
      PostToolUse: hook,
      Notification: hook,
      Stop: hook,
      SessionStart: hook,
      SessionEnd: hook,
      PreCompact: hook,
      UserPromptSubmit: hook,
    },
  });
}

/**
 * launchd residents bind the selected builtin CLI to an absolute path at install/repair time.
 * Keep PATH lookup as a compatibility fallback for terminal-started `party serve`, but never
 * ignore a malformed explicit binding: that would turn a configuration problem back into a
 * delayed wake-time `Executable not found` failure.
 */
export function builtinRunnerCommand(
  harness: Exclude<RunnerHarness, "codex-sdk">,
  env: Record<string, string | undefined>,
): string {
  const configured = env.AGENTPARTY_RUNNER_BIN?.trim();
  if (configured === undefined || configured === "") return harness;
  if (!isAbsolute(configured)) {
    throw new WakeBlockedError(
      `builtin ${harness} runner binding is invalid: AGENTPARTY_RUNNER_BIN must be absolute`,
      true,
    );
  }
  return configured;
}

async function runHarness(
  opts: BuiltinRunnerOptions,
  prompt: string,
  sid: string | null,
  coldSessionId: string | null,
  cwd: string,
  env: Record<string, string | undefined>,
  seq: number,
  signal?: AbortSignal,
): Promise<HarnessRun> {
  const rawRunProcess = opts.runProcess ?? defaultRunnerProcess;
  // runProcess 自己抛 = 进程根本没起来（spawn ENOENT / 权限），模型确定没跑过 → 重试安全。
  // 一旦进程起来了（哪怕退出码非零），模型就可能已经产生副作用，重跑不安全。
  const runProcess: RunnerProcess = async (args, o2) => {
    try {
      return await rawRunProcess(args, o2);
    } catch (e) {
      if (e instanceof WakeBlockedError) throw e;
      throw new WakeBlockedError(
        `builtin ${opts.harness} runner did not start: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  };
  if (opts.harness === "codex") {
    const runnerCommand = builtinRunnerCommand("codex", env);
    const outFile = join(opts.workdir, `runner-${seq}-${Date.now()}.out`);
    const schemaArgs = opts.outputSchema === undefined
      ? []
      : ["--output-schema", writeRunnerOutputSchema(opts.workdir, opts.outputSchema)];
    // #581：注入角色裁剪的 party MCP server。command/args 都是 TOML 字面量，路径经 JSON.stringify
    // 得到合法 TOML basic string；server 自身从 stateDir 读清单/凭据，不需要 env。
    const mcpArgs = opts.managedMcp === undefined
      ? []
      : [
          "-c", `mcp_servers.party.command=${JSON.stringify(managedPartyBinary())}`,
          "-c", `mcp_servers.party.args=["mcp","--managed",${JSON.stringify(opts.managedMcp.stateDir)}]`,
        ];
    const flags = [
      "--skip-git-repo-check",
      "--sandbox",
      opts.sandbox ?? "workspace-write",
      ...schemaArgs,
      ...mcpArgs,
      "-o",
      outFile,
    ];
    // exec-level flags must precede the `resume` subcommand.  Putting --sandbox after the session
    // id is parsed as a resume-only flag and current Codex rejects the second managed turn.
    const args = sid
      ? [runnerCommand, "exec", ...flags, "resume", sid, prompt]
      : [runnerCommand, "exec", ...flags, prompt];
    const result = await runProcess(args, { cwd, env, signal });
    const text = result.code === 0 && existsSync(outFile) ? readFileSync(outFile, "utf8").trimEnd() : "";
    return { result, text, sessionId: sid ? sid : parseCodexSessionId(result.stdout, result.stderr), outFile };
  }

  // A resident unattended serve must never let Claude block its one serial consumer on an
  // interactive tool prompt. Owner input goes through `party decision ask` and a later delivery.
  if (sid === null && coldSessionId === null) {
    throw new WakeBlockedError("builtin claude runner has no preallocated cold session id", true);
  }
  // Claude accepts an official UUID session handle on cold start. Allocate it during preflight so
  // nested `party decision ask` can durably park the exact handle before this turn returns. Parsing
  // a session id from stdout is too late: the Worker may already have released an owner_answer.
  // `claude -p` has no human sitting at a TTY to approve tool calls. Leaving its default
  // permission mode in a resident workspace-write lane turns every Read/Bash/Edit request into an
  // unanswerable prompt: the process exits nonzero and the agent becomes an online-looking black
  // hole. Read-only managed fronts stay in plan mode; an explicitly unattended execution lane must
  // skip interactive permission prompts so it can actually do the work it was started to perform.
  const permissionArgs = [
    "--permission-mode",
    opts.sandbox === "read-only" ? "plan" : "bypassPermissions",
  ];
  const schemaArgs = opts.outputSchema === undefined ? [] : ["--json-schema", JSON.stringify(opts.outputSchema)];
  const jsonOutputArgs = opts.outputSchema === undefined ? [] : ["--output-format", "json"];
  // #581：--strict-mcp-config 只用注入的 server（隔离用户全局 MCP 配置）；
  // --allowedTools mcp__party 放行整个 party server 的工具，headless 下不弹权限。
  const mcpArgs = opts.managedMcp === undefined
    ? []
    : [
        "--mcp-config", writeManagedClaudeMcpConfig(opts.managedMcp.stateDir),
        "--strict-mcp-config",
        "--allowedTools", "mcp__party",
      ];
  // 活动上报（#602）：session 级注入 hooks，把模型「正在干什么」经 `party hook report` 落盘，
  // 由外层 serve 心跳捎带进频道 presence。--settings 只作用于本次 session，不碰用户/项目 settings。
  const hookArgs = ["--settings", claudeHookSettingsJson()];
  const runnerCommand = builtinRunnerCommand("claude", env);
  const args = sid
    ? [runnerCommand, "-p", "--disallowed-tools", "AskUserQuestion", ...permissionArgs, ...schemaArgs, ...jsonOutputArgs, ...mcpArgs, ...hookArgs, "--resume", sid, prompt]
    : [
        runnerCommand,
        "-p",
        "--disallowed-tools",
        "AskUserQuestion",
        ...permissionArgs,
        ...schemaArgs,
        ...mcpArgs,
        ...hookArgs,
        "--session-id",
        coldSessionId!,
        "--output-format",
        "json",
        prompt,
      ];
  const result = await runProcess(args, { cwd, env, signal });
  if (sid && opts.outputSchema === undefined) return { result, text: result.stdout.trimEnd(), sessionId: sid };
  const parsed = parseClaudeJson(result.stdout);
  return { result, text: parsed.text.trimEnd(), sessionId: sid ?? coldSessionId };
}

export function createSdkRunner(opts: SdkRunnerOptions): NonNullable<ServeOptions["runCommand"]> {
  interface SdkSlot {
    thread: ThreadLike | null;
    session: SdkWakeSessionState | null;
    activeThreadFromPersistedSession: boolean;
    activeRunKey: string | null;
  }
  // CodexClientOptions.env is fixed when the SDK client is created. A continuation may receive more
  // than one delivery (initial mention, then one or more owner answers), so a client/thread created
  // for the first delivery must not be reused with its stale AP_DELIVERY_ID. The durable thread id is
  // resumed through a fresh client for each delivery attempt; that keeps nested `party decision ask`
  // bound to the exact delivery currently running while preserving the model conversation.
  const slots = new Map<string, SdkSlot>();
  let queue = Promise.resolve();
  const runKey = (scope: ContinuationScope): string => JSON.stringify([
    scope.path,
    scope.deliveryId,
    scope.deliveryAttempt,
  ]);
  const clientOptions = (scope: ContinuationScope, sessionId: string | null): CodexClientOptions => ({
    env: definedEnv({
      ...process.env,
      AGENTPARTY_CHANNEL: opts.channel,
      ...(opts.isolateModelPartyAccess
        ? isolatedModelPartyEnv(opts.workdir, opts.server)
        : opts.agentpartyConfigPath
          ? { AGENTPARTY_CONFIG: opts.agentpartyConfigPath }
          : {}),
      AP_RUNNER_WORKDIR: opts.workdir,
      AP_RUNNER_HARNESS: "codex-sdk",
      ...(sessionId === null ? {} : { AP_RUNNER_SESSION_ID: sessionId }),
      ...(scope.directed
        ? {
            AP_DELIVERY_ID: scope.deliveryId!,
            AP_WORK_ID: scope.workId!,
            AP_CONTINUATION_REF: scope.ref!,
            AP_DELIVERY_ATTEMPT: String(scope.deliveryAttempt!),
          }
        : {}),
    }),
  });
  const threadOptions: CodexThreadOptions = {
    workingDirectory: opts.cwd ?? opts.workdir,
    skipGitRepoCheck: true,
    sandboxMode: sdkSandboxMode(opts.sandbox),
  };

  const codex = (scope: ContinuationScope, sessionId: string | null): Promise<CodexLike> => {
    // Do not cache a rejected factory promise: pre-model failures are explicitly retriable and need
    // a fresh SDK client. Successful clients live only for the delivery attempt whose env they carry.
    return Promise.resolve((opts.codexFactory ?? defaultCodexFactory)(clientOptions(scope, sessionId)));
  };

  const slotFor = (scope: ContinuationScope): SdkSlot => {
    let slot = slots.get(scope.path);
    if (slot === undefined) {
      slot = { thread: null, session: null, activeThreadFromPersistedSession: false, activeRunKey: null };
      slots.set(scope.path, slot);
    }
    return slot;
  };

  const resetSlot = (slot: SdkSlot) => {
    slot.thread = null;
    slot.session = null;
    slot.activeThreadFromPersistedSession = false;
    slot.activeRunKey = null;
  };

  const ensureThread = async (
    started: number,
    scope: ContinuationScope,
    slot: SdkSlot,
  ): Promise<{ thread: ThreadLike; session: SdkWakeSessionState | null }> => {
    const currentRunKey = runKey(scope);
    if (slot.activeRunKey !== currentRunKey) {
      // Keep the durable session mapping, but replace the SDK client/thread so tool subprocesses get
      // this delivery's AP_DELIVERY_ID instead of the previous turn's lineage.
      slot.thread = null;
      slot.activeThreadFromPersistedSession = false;
    }
    // owner_answer is allowed to resume only a durable, exact mapping. Even a resident in-memory
    // thread is rejected if its file disappeared or was replaced: silently cold-starting here would
    // detach the answer from the work that asked the question.
    if (scope.ownerAnswer) {
      const durable = scopedSession(scope, readSdkSession, "builtin codex-sdk");
      if (slot.session !== null && durable?.thread_id !== slot.session.thread_id) {
        throw new WakeBlockedError(
          `builtin codex-sdk continuation mapping mismatch for work_id=${scope.workId} continuation_ref=${scope.ref}`,
          false,
        );
      }
    }
    if (slot.thread && slot.session) return { thread: slot.thread, session: slot.session };
    mkdirSync(opts.workdir, { recursive: true });
    const sessionPath = scope.path;
    const prior = scopedSession(scope, readSdkSession, "builtin codex-sdk");
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
    const client = await beforeModel(() => codex(scope, prior?.thread_id ?? null));
    if (prior) {
      try {
        slot.thread = await client.resumeThread(prior.thread_id, threadOptions);
        slot.session = prior;
        slot.activeThreadFromPersistedSession = true;
        slot.activeRunKey = currentRunKey;
        return { thread: slot.thread, session: slot.session };
      } catch (error) {
        if (!isInvalidPersistedSessionError(error)) {
          throw new WakeBlockedError(
            `builtin codex-sdk runner blocked before the model started: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
        appendRunnerLog(
          opts.workdir,
          `${new Date(started).toISOString()} sid=${shortSid(prior.thread_id)} session_reset=invalid_before_model runner=codex-sdk`,
        );
        // A direct structured resume failure proves the model did not start. Legacy/initial work may
        // safely replace the poison handle, but an owner answer must never fork away from its work.
        if (scope.ownerAnswer) {
          throw new WakeBlockedError(
            `builtin codex-sdk owner continuation is unavailable: ${error instanceof Error ? error.message : String(error)}`,
            false,
          );
        }
        rmSync(sessionPath, { force: true });
      }
    }
    slot.thread = await beforeModel(() => client.startThread(threadOptions));
    slot.activeThreadFromPersistedSession = false;
    slot.activeRunKey = currentRunKey;
    const threadId = sdkThreadId(slot.thread);
    // thread id 懒初始化：拿不到就先不落 session 文件，等首个 run() 之后补写
    slot.session = threadId
      ? {
          harness: "codex-sdk",
          thread_id: threadId,
          created_at: started,
          last_wake_ts: started,
          wakes: 0,
          ...(scope.directed ? { work_id: scope.workId!, continuation_ref: scope.ref! } : {}),
        }
      : null;
    if (slot.session) slot.session = writeSdkSession(sessionPath, slot.session);
    return { thread: slot.thread, session: slot.session };
  };

  interface PreparedSdkRun {
    started: number;
    scope: ContinuationScope;
    slot: SdkSlot;
    active: { thread: ThreadLike; session: SdkWakeSessionState | null };
  }
  const prepared = new WeakMap<MsgFrame, PreparedSdkRun>();
  const prepare = async (frame: MsgFrame, ctx: ServeRunnerContext): Promise<void> => {
    if (prepared.has(frame)) return;
    const started = opts.now?.() ?? Date.now();
    mkdirSync(opts.workdir, { recursive: true });
    const scope = continuationScope(opts.workdir, ctx.delivery);
    const slot = slotFor(scope);
    // Factory creation plus start/resume validation is model-free. Finish it before the Worker sees
    // `running`, otherwise a crash here would manufacture an unknown model outcome.
    const active = await ensureThread(started, scope, slot);
    prepared.set(frame, { started, scope, slot, active });
  };

  const handle = async (
    frame: MsgFrame,
    ctx: ServeRunnerContext,
  ): Promise<void> => {
    if (!prepared.has(frame)) await prepare(frame, ctx);
    const ready = prepared.get(frame)!;
    prepared.delete(frame);
    const { started, scope, slot, active } = ready;
    const post = opts.post ?? postMessage;
    const sessionPath = scope.path;

    try {
      void post(opts.server, opts.token, opts.channel, {
        kind: "status",
        state: "working",
        note: `wake ack: ${ctx.self} builtin codex-sdk runner handling seq=${frame.seq}`,
        mentions: [],
        busy: true,
        queue_depth: ctx.queueDepth ?? 0,
      }).catch(() => {});
    } catch {
      // Presence is telemetry-only; do not delay the model boundary after durable `running`.
    }

    let threadId = slot.session?.thread_id ?? null;
    const markTimedOutContinuation = (timeout: RunnerTimeoutError): void => {
      const now = opts.now?.() ?? Date.now();
      const blockedReason =
        `codex-sdk runner timed out after ${timeout.timeoutMs}ms; previous turn outcome unknown, refusing resume`;
      // Prefer the on-disk state: `party decision ask` may have crash-safely enriched it while the
      // SDK run was active. Fall back to the in-memory handle for a turn that has not asked yet.
      const durable = readSdkSession(sessionPath) ?? slot.session;
      if (durable !== null) {
        slot.session = writeSdkSession(sessionPath, {
          ...durable,
          last_wake_ts: now,
          workdir: opts.workdir,
          resume_blocked_reason: blockedReason,
          resume_blocked_at: now,
        });
      } else {
        // A lazy SDK may expose its id only inside the spawned runtime. `party decision ask` writes
        // the same scoped file from CODEX_THREAD_ID before POST; pick that crash-safe mapping up.
        blockRunnerContinuation(sessionPath, blockedReason, now);
      }
    };
    const onAbort = (): void => {
      const reason = ctx.signal?.reason;
      if (reason instanceof RunnerTimeoutError) markTimedOutContinuation(reason);
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();
    try {
      threadId = active.session?.thread_id ?? sdkThreadId(active.thread);
      if (ctx.signal?.aborted) {
        onAbort();
        throw ctx.signal.reason instanceof Error
          ? ctx.signal.reason
          : new WakeBlockedError("builtin codex-sdk runner aborted", false);
      }
      let nextPrompt = sdkPrompt(frame, ctx.channel, ctx.self, ctx.recent, ctx.charter ?? null, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null, ctx.attachments, ctx.delivery ?? null);
      let autoContinuations = 0;
      for (;;) {
        // Await the SDK promise itself. Racing it with AbortSignal would let an SDK implementation
        // that ignores cancellation keep running while serve starts the next wake.
        const result = await active.thread.run(nextPrompt, {
          sandbox: opts.sandbox ?? "full_access",
          signal: ctx.signal,
          ...(opts.outputSchema === undefined ? {} : { outputSchema: opts.outputSchema }),
        });
        if (ctx.signal?.aborted) {
          throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new WakeBlockedError("builtin codex-sdk runner aborted", false);
        }
        // run() 之后 thread id 一定就位；懒初始化的 session 在这里补建
        threadId = slot.session?.thread_id ?? active.session?.thread_id ?? sdkThreadId(active.thread);
        if (!threadId) throw new Error("@openai/codex-sdk thread did not expose an id/thread_id after run");
        const body = finalText(result);
        const now = opts.now?.() ?? Date.now();
        const baseSession = slot.session ?? active.session ?? {
          harness: "codex-sdk" as const,
          thread_id: threadId,
          created_at: started,
          last_wake_ts: started,
          wakes: 0,
          ...(scope.directed ? { work_id: scope.workId!, continuation_ref: scope.ref! } : {}),
        };
        slot.session = writeSdkSession(sessionPath, {
          ...baseSession,
          last_wake_ts: now,
          wakes: baseSession.wakes + 1,
          workdir: opts.workdir,
        });
        opts.onSession?.({
          harness: "codex-sdk",
          session_id: slot.session.thread_id,
          updated_at: now,
          cwd: slot.session.cwd ?? opts.workdir,
          workdir: opts.workdir,
        });
        // 交付走统一路径：超限正文改走 R2 附件（#109），不再 inline 撞 413。上传失败落进下面的 catch。
        const outcome = await deliverRunnerResult({
          frame,
          text: body,
          marker: null,
          delivery: ctx.delivery ?? null,
          route: opts.resultRoute,
          post,
          upload: opts.uploadAttachment ?? uploadAttachment,
          server: opts.server,
          token: opts.token,
          channel: opts.channel,
          attachmentRoot: opts.attachmentRoot,
        });
        if (outcome.autoDecision === undefined) {
          appendRunnerLog(
            opts.workdir,
            `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(threadId)} duration_ms=${now - started} status=ok auto_continuations=${autoContinuations}`,
          );
          break;
        }
        autoContinuations += 1;
        if (autoContinuations > MAX_AUTO_DECISION_CONTINUATIONS) {
          throw new WakeBlockedError("managed front exceeded unattended decision continuation limit", false);
        }
        nextPrompt = autoDecisionContinuationPrompt(outcome.autoDecision);
      }
    } catch (err) {
      const now = opts.now?.() ?? Date.now();
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RunnerTimeoutError || err instanceof ServeShutdownError) {
        appendRunnerLog(
          opts.workdir,
          `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(threadId)} duration_ms=${now - started} status=${err instanceof RunnerTimeoutError ? "timeout" : "shutdown"}`,
        );
        // Do not erase the only work -> thread mapping. A decision may already have parked this work;
        // deleting the file would make its owner_answer look like an unrelated cold start. Preserve the
        // exact handle and mark it unsafe so the later answer terminates as an explicit failed delivery.
        if (err instanceof RunnerTimeoutError) markTimedOutContinuation(err);
        else {
          const durable = readSdkSession(sessionPath) ?? slot.session;
          if (durable !== null) {
            slot.session = writeSdkSession(sessionPath, {
              ...durable,
              last_wake_ts: now,
              workdir: opts.workdir,
              resume_blocked_reason: "codex-sdk runner stopped during shutdown; previous turn outcome unknown, refusing resume",
              resume_blocked_at: now,
            });
          }
        }
        resetSlot(slot);
        throw err;
      }
      if (slot.activeThreadFromPersistedSession && isInvalidPersistedSessionError(err)) {
        appendRunnerLog(
          opts.workdir,
          `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(threadId)} duration_ms=${now - started} session_reset=invalid_after_run runner=codex-sdk`,
        );
        const durable = readSdkSession(sessionPath);
        if (durable?.resume_blocked_reason === undefined) rmSync(sessionPath, { force: true });
        resetSlot(slot);
        // resumeThread() in the production SDK is lazy: thread existence is first checked by run().
        // At that point the model/side effects cannot be proven absent, so clear the handle only for
        // the next independent delivery and never cold-start the current wake.
        throw new WakeBlockedError(`builtin codex-sdk persisted session is invalid: ${message}`, false);
      }
      const errorSession = slot.session ?? readSdkSession(sessionPath);
      if (errorSession) {
        slot.session = { ...errorSession, last_wake_ts: now, wakes: errorSession.wakes + 1, workdir: opts.workdir };
        slot.session = writeSdkSession(sessionPath, slot.session);
        threadId = slot.session.thread_id;
        opts.onSession?.({
          harness: "codex-sdk",
          session_id: slot.session.thread_id,
          updated_at: now,
          cwd: slot.session.cwd ?? opts.workdir,
          workdir: opts.workdir,
        });
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
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  };

  const runner: NonNullable<ServeOptions["runCommand"]> = (frame, ctx) => {
    const next = queue.then(() => handle(frame, ctx));
    queue = next.catch(() => {});
    return next;
  };
  runner.prepare = prepare;
  runner.onDeliveryTerminal = (delivery) => {
    if (delivery.work_id === null || delivery.continuation_ref === null) return;
    const path = continuationPath(opts.workdir, delivery.continuation_ref);
    const slot = slots.get(path);
    const cleanup = deleteRunnerContinuation(path, {
      harness: "codex-sdk",
      work_id: delivery.work_id,
      continuation_ref: delivery.continuation_ref,
    });
    const slotMatches = slot !== undefined && (
      slot.session === null ||
      slot.session.work_id === delivery.work_id &&
      slot.session.continuation_ref === delivery.continuation_ref
    );
    // A disk mismatch belongs to another still-actionable work. Preserve an in-memory slot with
    // that same identity too; a null session is only the failed delivery's empty preflight slot.
    if (slotMatches && cleanup !== "mismatch") {
      resetSlot(slot!);
      slots.delete(path);
    }
  };
  return runner;
}

export function createBuiltinRunner(opts: BuiltinRunnerOptions): NonNullable<ServeOptions["runCommand"]> {
  interface PreparedBuiltinRun {
    started: number;
    scope: ContinuationScope;
    sessionPath: string;
    prior: WakeSessionState | null;
    coldSessionId: string | null;
    env: Record<string, string | undefined>;
    cwd: string;
  }
  const prepared = new WeakMap<MsgFrame, PreparedBuiltinRun>();
  const prepare = async (frame: MsgFrame, ctx: ServeRunnerContext): Promise<void> => {
    if (prepared.has(frame)) return;
    const started = opts.now?.() ?? Date.now();
    mkdirSync(opts.workdir, { recursive: true });
    // 活动上报（#602）：新 wake 冷起前清掉上一轮残留，首个 hook 到来前不展示旧活动。
    if (opts.harness === "claude") clearActivityFile(runnerActivityFile(opts.workdir));
    const baseEnv = opts.harness === "codex" ? prepareCodexHome(opts.workdir, opts.authSourceFile) : { ...process.env };
    const scope = continuationScope(opts.workdir, ctx.delivery);
    const sessionPath = scope.path;
    const prior = scopedSession(scope, (path) => readSession(path, opts.harness), `builtin ${opts.harness}`);
    const coldSessionId = prior === null && opts.harness === "claude" ? randomUUID() : null;
    const env = {
      ...baseEnv,
      AGENTPARTY_CHANNEL: opts.channel,
      ...(opts.isolateModelPartyAccess
        ? isolatedModelPartyEnv(opts.workdir, opts.server)
        : opts.agentpartyConfigPath
          ? { AGENTPARTY_CONFIG: opts.agentpartyConfigPath }
          : {}),
      // Nested `party decision ask` must be able to commit the current model handle before its POST
      // parks the server-side work. Cold harnesses expose CODEX_THREAD_ID / CLAUDE_SESSION_ID to tool
      // subprocesses; resumed turns additionally receive this explicit, runner-owned handle.
      AP_RUNNER_WORKDIR: opts.workdir,
      AP_RUNNER_HARNESS: opts.harness,
      // 活动上报（#602）：hook 子进程继承这个路径落盘，serve 心跳读同一路径——双方对文件位置
      // 显式约定，不靠 session_id 映射（resume 会换 id）。codex 无 hooks 机制，不设。
      ...(opts.harness === "claude" ? { AP_ACTIVITY_FILE: runnerActivityFile(opts.workdir) } : {}),
      AP_RUNNER_SESSION_ID: prior?.session_id ?? coldSessionId ?? "",
      AP_DELIVERY_ID: ctx.delivery?.id ?? "",
      AP_WORK_ID: ctx.delivery?.work_id ?? "",
      AP_CONTINUATION_REF: ctx.delivery?.continuation_ref ?? "",
      AP_DELIVERY_ATTEMPT: ctx.delivery ? String(ctx.delivery.attempt) : "",
    };
    // #581 managed MCP：每个 wake 前覆写 wake.json——工具 handler 即读即用，天然跟上当前 wake；
    // owner 决策绑定取 welcome 声明的当前值（prepare 必在 welcome 之后）。
    if (opts.managedMcp !== undefined) {
      // 消息编辑会复用原 seq 但产生新 delivery：新回合开工前清同 seq 的历史回执，
      // 旧动作绝不能替新回合的零动作充数（#592 评审）。
      clearManagedActions(opts.managedMcp.stateDir, frame.seq);
      clearManagedExclusiveLocks(opts.managedMcp.stateDir, frame.seq);
      writeManagedWake(opts.managedMcp.stateDir, {
        version: 1,
        seq: frame.seq,
        frame,
        delivery: ctx.delivery
          ? {
              id: ctx.delivery.id,
              cause: ctx.delivery.cause,
              work_id: ctx.delivery.work_id,
              continuation_ref: ctx.delivery.continuation_ref,
            }
          : null,
        owner_decision_binding: opts.managedMcp.ownerDecisionBinding(),
      });
    }
    // Clone/pull and continuation validation are model-free and can be slow. They must finish while
    // the durable delivery is still only `claimed`; a crash here is safe for the Worker to requeue.
    const repoCwd = await ensureRepo(opts, env, ctx.signal);
    prepared.set(frame, {
      started,
      scope,
      sessionPath,
      prior,
      coldSessionId,
      env,
      cwd: opts.cwd ?? repoCwd ?? opts.workdir,
    });
  };

  const runner: NonNullable<ServeOptions["runCommand"]> = async (frame, ctx) => {
    if (!prepared.has(frame)) await prepare(frame, ctx);
    const ready = prepared.get(frame)!;
    prepared.delete(frame);
    const { started, scope, sessionPath, coldSessionId, env, cwd } = ready;
    let prior = ready.prior;
    let oldSid = prior?.session_id ?? null;
    let exitCode: number | null = null;
    let finalSid = oldSid;
    const post = opts.post ?? postMessage;

    // Presence/audit must never sit between the authoritative running ACK and the model boundary.
    // It is observable telemetry, not a prerequisite for executing the claimed work.
    try {
      void post(opts.server, opts.token, opts.channel, {
        kind: "status",
        state: "working",
        note: `wake ack: ${ctx.self} builtin ${opts.harness} runner handling seq=${frame.seq}`,
        mentions: [],
        busy: true,
        queue_depth: ctx.queueDepth ?? 0,
      }).catch(() => {});
    } catch {
      // A synchronous test double / transport failure is still telemetry-only.
    }
    // #479：builtin Claude/Codex 子进程在 runner workdir 内运行；把 context JSON 写到 workdir
    // 内，避免 Claude Code 默认权限模式因读取系统 tmpdir 文件而卡无人批准的权限弹窗。
    const contextFile = writeContextFile(builtinRunnerContextDir(opts.workdir), frame, ctx.channel, ctx.self, ctx.recent, ctx.charter ?? null, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null, ctx.attachments, ctx.delivery ?? null);
    // 绝不把 context JSON 当 argv 传（#120）：argv 对同机任意用户可见（`ps -axww`），
    // 一条私有频道消息的正文、charter、最近 20 条上下文就全泄漏了。
    // 只传 0700 私有目录里的文件路径——protocol_reminder 本来就叫模型「先读本文件」。
    //
    // 顺带证伪 issue 里「大消息 E2BIG」那半：macOS 上 argv 单条到 ~2MB 才 E2BIG，
    // 而最坏 context ≈ 230KB（BODY_LIMIT 100KB + CHARTER_LIMIT 16KB + recent 20×400B）。
    // 当前限额下炸不了；真正当下就成立的是上面这条泄漏。
    let nextPrompt = wakePrompt(contextFile, ctx.projectAgent ?? null);
    let autoContinuations = 0;
    try {
      for (;;) {
        // resume 子进程一旦启动，任何非零都可能发生在模型或交付副作用之后；即使输出里带结构化
        // session_not_found，也只能清理句柄供下一条独立 wake 使用，绝不能 cold-start 重跑当前 wake。
        let run: HarnessRun;
        try {
          run = await runHarness(opts, nextPrompt, oldSid, coldSessionId, cwd, env, frame.seq, ctx.signal);
        } catch (error) {
          if (error instanceof ServeShutdownError && prior !== null) {
            blockRunnerContinuation(
              sessionPath,
              `${opts.harness} runner stopped during shutdown; previous turn outcome unknown, refusing resume`,
              opts.now?.() ?? Date.now(),
            );
          }
          throw error;
        }
        if (oldSid !== null && run.result.code !== 0 && isInvalidPersistedSessionFailure(run.result)) {
          const resetAt = opts.now?.() ?? Date.now();
          appendRunnerLog(
            opts.workdir,
            `${new Date(resetAt).toISOString()} seq=${frame.seq} sid=${shortSid(oldSid)} session_reset=invalid_after_process exit=${run.result.code}`,
          );
          const durable = readSession(sessionPath, opts.harness);
          if (durable?.resume_blocked_reason === undefined) rmSync(sessionPath, { force: true });
          prior = null;
          oldSid = null;
          finalSid = null;
        }
        exitCode = run.result.code;
        const now = opts.now?.() ?? Date.now();
        if (run.result.code !== 0) {
          // #690：认证过期 / 二进制缺失 / 沙箱拒权等环境性失败在模型启动前就崩，别归为「model may have run」。
          // #748：claude 的 auth/api 失败落在 stdout 的结构化 JSON（非 stderr），补一条只吃结构化字段的判定。
          const envFailure =
            isRunnerEnvFailure(run.result) ||
            (opts.harness === "claude" && claudeJsonEnvFailure(run.result.stdout));
          appendRunnerLog(
            opts.workdir,
            `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(oldSid)} duration_ms=${now - started} exit=${run.result.code}${envFailure ? " env_failure=true" : ""}`,
          );
          throw new WakeBlockedError(
            `builtin ${opts.harness} runner blocked: exit code ${run.result.code}${envFailure ? " (runner environment failure: credentials/binary/sandbox — model did not run)" : ""}; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`,
            false,
            { environment: envFailure },
          );
        }

        finalSid = run.sessionId;
        // 解析不到 session id 不再吞掉本回合答案（#726）：codex 已 exit 0 且产出在 run.text 里，
        // 唯一代价是无法持久化可续跑句柄——下一次 @ 冷启动而非 resume，远好于静默丢答案。
        // 落一条运维告警到 serve-runner.log，正常走投递；只跳过 writeSession/onSession。
        let committed: WakeSessionState | null = null;
        if (!finalSid) {
          // 只记录「解析不到 sid、将走无续跑投递」——真正的送达结果由下面投递/验收后的日志行落账,
          // 这里别抢先写 delivered=true(附件/发送失败或 managed 零动作时会留下假的已交付审计,#728 CodeRabbit)。
          appendRunnerLog(
            opts.workdir,
            `${new Date(now).toISOString()} seq=${frame.seq} sid=unknown duration_ms=${now - started} exit=${exitCode ?? 0} missing_session_id=true text_bytes=${Buffer.byteLength(run.text, "utf8")} note=session_continuity_unavailable`,
          );
        } else {
          committed = writeSession(sessionPath, {
            harness: opts.harness,
            session_id: finalSid,
            created_at: prior ? prior.created_at : now,
            last_wake_ts: now,
            wakes: prior ? prior.wakes + 1 : 1,
            cwd,
            workdir: opts.workdir,
            ...(scope.directed ? { work_id: scope.workId!, continuation_ref: scope.ref! } : {}),
          });
          opts.onSession?.({
            harness: opts.harness,
            session_id: committed.session_id,
            updated_at: now,
            cwd,
            workdir: opts.workdir,
          });
        }

        // #581 managed MCP：动作已由工具即时落频道，文本输出只进日志。这里只验收「本回合
        // 至少发生一个频道动作」——零动作=未送达（WakeBlockedError，不推游标不吞 @）。
        // auto-decision 续跑循环也随之退役：unattended 决策在工具返回里就地续行，同一回合完成。
        if (opts.managedMcp !== undefined) {
          const actions = readManagedActions(opts.managedMcp.stateDir, frame.seq);
          appendRunnerLog(
            opts.workdir,
            `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} duration_ms=${now - started} exit=${exitCode ?? 0} mcp_actions=${actions.length} text_bytes=${Buffer.byteLength(run.text, "utf8")}`,
          );
          if (actions.length === 0) {
            throw new WakeBlockedError(
              "managed mcp runner made no channel action: every channel effect must be a party MCP tool call (party_reply / party_worker_dispatch / party_worker_feedback / party_decision_ask / party_worker_report); free-text output is logged only",
              false,
            );
          }
          break;
        }
        // 无 sid（#726 续跑不可用）不打 "[session start: unknown]" 噪声——告警已进 runner 日志。
        const marker = finalSid && !oldSid ? `[session start: ${shortSid(finalSid)}]` : null;
        let outcome: RunnerDeliveryOutcome;
        try {
          outcome = await deliverRunnerResult({
            frame,
            text: run.text,
            marker,
            delivery: ctx.delivery ?? null,
            route: opts.resultRoute,
            post,
            upload: opts.uploadAttachment ?? uploadAttachment,
            server: opts.server,
            token: opts.token,
            channel: opts.channel,
            attachmentRoot: opts.attachmentRoot,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendRunnerLog(
            opts.workdir,
            `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} attach_error=${JSON.stringify(message)}`,
          );
          throw new WakeBlockedError(`builtin ${opts.harness} runner blocked: ${message}`);
        }
        if (outcome.autoDecision === undefined) {
          appendRunnerLog(
            opts.workdir,
            `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} duration_ms=${now - started} exit=${exitCode ?? 0} auto_continuations=${autoContinuations}`,
          );
          break;
        }
        autoContinuations += 1;
        if (autoContinuations > MAX_AUTO_DECISION_CONTINUATIONS) {
          throw new WakeBlockedError("managed front exceeded unattended decision continuation limit", false);
        }
        prior = committed;
        oldSid = finalSid;
        nextPrompt = autoDecisionContinuationPrompt(outcome.autoDecision);
      }
    } finally {
      try {
        unlinkSync(contextFile);
      } catch {
        /* 保留失败的清理不影响唤醒结果 */
      }
    }
  };
  runner.prepare = prepare;
  runner.onDeliveryTerminal = (delivery) => {
    if (delivery.work_id === null || delivery.continuation_ref === null) return;
    deleteRunnerContinuation(continuationPath(opts.workdir, delivery.continuation_ref), {
      harness: opts.harness,
      work_id: delivery.work_id,
      continuation_ref: delivery.continuation_ref,
    });
  };
  return runner;
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function safeSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "agent";
}

export function canonicalServerOrigin(server: string): string {
  return new URL(server).origin;
}

function stableNamespace(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
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
  server: string;
  profile: ProjectAgentProfile;
  channel: string;
  child: Pick<ProjectAgentChannelRuntime, "name" | "owner" | "channel_scope">;
  runGit?: RunnerProcess;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export async function prepareProfileChannelWorkspace(opts: PrepareProfileWorkspaceOptions): Promise<PreparedProfileWorkspace> {
  if (opts.signal?.aborted) throw opts.signal.reason;
  const origin = canonicalServerOrigin(opts.server);
  const serverNamespace = stableNamespace([origin]);
  const profileNamespace = stableNamespace([
    origin,
    opts.profile.owner_account,
    opts.profile.handle,
    opts.profile.created_at,
  ]);
  const root = join(
    process.env.AGENTPARTY_HOME ?? join(homedir(), ".agentparty"),
    "project-agents",
    serverNamespace,
    safeSegment(opts.profile.owner_account),
    safeSegment(opts.profile.handle),
    profileNamespace,
  );
  const childNamespace = stableNamespace([
    origin,
    opts.child.name,
    "agent",
    opts.child.owner ?? null,
    opts.child.channel_scope,
  ]);
  const runnerWorkdir = join(
    root,
    "sessions",
    childNamespace,
    safeSegment(opts.child.channel_scope),
  );
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
      const clone = await runGit(["git", "clone", opts.profile.repo_url, baseDir], {
        cwd: root,
        env,
        signal: opts.signal,
      });
      if (opts.signal?.aborted) throw opts.signal.reason;
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
      signal: opts.signal,
    });
    if (opts.signal?.aborted) throw opts.signal.reason;
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
  /**
   * #581：managed lane 协议。mcp（默认）=角色裁剪的 MCP 工具面；text=旧文本信封（deprecated，
   * 保留一个 minor 周期作为逃生舱）。codex-sdk runner 本期尚无 MCP 注入面，强制走 text。
   */
  protocol?: "mcp" | "text";
  /** 由 --replay-backlog 决定；透传给每个频道的子 serve。 */
  skipBacklog?: boolean;
  server: string;
  humanToken: string;
  ownerAccount: string;
  handle: string;
  mentionsOnly: boolean;
  availableUpgrade?: CliUpgradeNotice | null;
  refreshAvailableUpgrade?: (current: CliUpgradeNotice | null) => Promise<CliUpgradeNotice | null>;
  upgradeProbeIntervalMs?: number;
  // #630：多 lane profile daemon 协调 re-exec 用（测试注入版本读取/execv；生产走默认 execv）。
  upgradeDeps?: UpgradeDeps;
  once?: boolean;
  pollIntervalMs?: number;
  runnerTimeoutMs?: number;
  out?: (line: string) => void;
  runGit?: RunnerProcess;
  mintRuntime?: typeof mintProjectAgentRuntimeToken;
  listInvites?: typeof listProjectAgentInvites;
  ensureChannelRuntime?: typeof ensureProjectAgentChannelRuntime;
  runChannelServe?: (opts: ServeOptions) => Promise<number>;
  post?: typeof postMessage;
  fetchMessages?: typeof fetchMessages;
  sleep?: (ms: number) => Promise<void>;
  /** 嵌入/测试方持有的生命周期；CLI 默认由 profile 层独占 SIGINT/SIGTERM。 */
  signal?: AbortSignal;
}

function profileContext(
  profile: ProjectAgentProfile,
  prepared: PreparedProfileWorkspace,
  runtime: { role: ServeExecutionRole; frontAgent: string; workers: readonly string[]; protocol?: "mcp" | "text" },
): ProjectAgentRunContext {
  return {
    ...(runtime.protocol === undefined ? {} : { protocol: runtime.protocol }),
    owner_account: profile.owner_account,
    handle: profile.handle,
    name: profile.name,
    runner: profile.runner,
    repo_url: profile.repo_url,
    workdir: profile.workdir,
    base_branch: profile.base_branch,
    worktree_strategy: profile.worktree_strategy,
    rules: profile.rules,
    runtime_role: runtime.role,
    front_agent: runtime.frontAgent,
    workers: runtime.workers,
    channel_workdir: prepared.channelWorkdir,
    runner_workdir: prepared.runnerWorkdir,
    delivery_workflow: {
      steps: [
        "work_in_channel_worktree",
        "create_pull_request",
        "report_pull_request_url_in_channel",
        "verify_deployment",
        "prune_merged_worktree",
      ],
      cleanup_command: projectAgentCleanupCommand(profile.base_branch),
      cleanup_guard: "run only after deployment is verified; dirty or unmerged worktrees must be preserved",
    },
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

export type ManagedFrontAction =
  | { action: "channel_reply"; body: string }
  | { action: "worker_dispatch"; instruction: string }
  | { action: "worker_feedback"; instruction: string }
  | { action: "owner_decision"; prompt: string; options?: string[] }
  | { action: "blocked"; reason: string };

const MANAGED_FRONT_ACTION_KEYS = ["action", "body", "instruction", "prompt", "options", "reason"] as const;

// OpenAI Structured Outputs requires one root object, every property required, and nullable
// placeholders for action-specific fields.  The parser below still enforces the discriminated
// semantics so Claude/Codex output can never smuggle a second action through an unused field.
export const MANAGED_FRONT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["channel_reply", "worker_dispatch", "worker_feedback", "owner_decision", "blocked"],
    },
    body: { type: ["string", "null"] },
    instruction: { type: ["string", "null"] },
    prompt: { type: ["string", "null"] },
    options: {
      type: ["array", "null"],
      items: { type: "string" },
      maxItems: DECISION_OPTIONS_MAX,
    },
    reason: { type: ["string", "null"] },
  },
  required: [...MANAGED_FRONT_ACTION_KEYS],
  additionalProperties: false,
};

function boundedActionText(value: unknown, field: string, maxBytes = BODY_LIMIT - 1024): string {
  if (typeof value !== "string") throw new WakeBlockedError(`managed front action requires string ${field}`, false);
  const text = value.trim();
  if (text.length === 0) throw new WakeBlockedError(`managed front action requires non-empty ${field}`, false);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new WakeBlockedError(`managed front action ${field} exceeds message limit`, false);
  }
  return text;
}

// DEPRECATED（#581）：text 信封协议的解析器，仅 --protocol text 逃生舱使用，
// 保留一个 minor 周期后与 MANAGED_FRONT_OUTPUT_SCHEMA / formatWorkerEnvelope / 前缀比对一并删除。
export function parseManagedFrontAction(text: string): ManagedFrontAction {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    throw new WakeBlockedError("managed front must return exactly one JSON action", false);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WakeBlockedError("managed front action must be a JSON object", false);
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...MANAGED_FRONT_ACTION_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new WakeBlockedError(`managed front action must contain exactly ${MANAGED_FRONT_ACTION_KEYS.join(", ")}`, false);
  }
  const requireNull = (...fields: Array<Exclude<(typeof MANAGED_FRONT_ACTION_KEYS)[number], "action">>) => {
    for (const field of fields) {
      if (record[field] !== null) {
        throw new WakeBlockedError(`managed front action requires unused ${field} to be null`, false);
      }
    }
  };
  if (record.action === "channel_reply") {
    requireNull("instruction", "prompt", "options", "reason");
    return { action: "channel_reply", body: boundedActionText(record.body, "body") };
  }
  if (record.action === "worker_dispatch" || record.action === "worker_feedback") {
    requireNull("body", "prompt", "options", "reason");
    return { action: record.action, instruction: boundedActionText(record.instruction, "instruction") };
  }
  if (record.action === "owner_decision") {
    requireNull("body", "instruction", "reason");
    const prompt = boundedActionText(record.prompt, "prompt", DECISION_PROMPT_LIMIT);
    // approve/reject 决策没有选项。schema 把 options 声明为 ["array","null"]，reminder 也要求
    // 「当前动作不用的字段必须为 null」，所以合法的批准型输出会带 options:null——按 [] 处理，
    // 不能把一个 schema 合法的输出判成非法而 brick 整个 wake。
    const rawOptions = record.options === null ? [] : record.options;
    if (!Array.isArray(rawOptions) || rawOptions.length > DECISION_OPTIONS_MAX) {
      throw new WakeBlockedError(`managed front owner_decision options must contain 0-${DECISION_OPTIONS_MAX} values`, false);
    }
    if (rawOptions.length === 0) return { action: "owner_decision", prompt };
    if (rawOptions.length < 2) {
      throw new WakeBlockedError("managed front choice decision requires at least 2 options", false);
    }
    const options = rawOptions.map((option, index) =>
      boundedActionText(option, `options[${index}]`, DECISION_OPTION_LIMIT));
    return { action: "owner_decision", prompt, options };
  }
  if (record.action === "blocked") {
    requireNull("body", "instruction", "prompt", "options");
    return { action: "blocked", reason: boundedActionText(record.reason, "reason", 2_000) };
  }
  throw new WakeBlockedError(
    "managed front action must be channel_reply, owner_decision, worker_dispatch, worker_feedback, or blocked",
    false,
  );
}

export function projectAgentChildName(handle: string, channel: string): string {
  const cleanHandle = safeSegment(handle).replace(/^[^A-Za-z0-9]+/, "") || "agent";
  const cleanChannel = safeSegment(channel).replace(/^[^A-Za-z0-9]+/, "") || "channel";
  const suffix = checksum(`${handle}/${channel}`);
  return `${cleanHandle.slice(0, 24)}-${cleanChannel.slice(0, 24)}-${suffix}`.slice(0, 64);
}

export function projectAgentWorkerName(handle: string, channel: string): string {
  const cleanHandle = safeSegment(handle).replace(/^[^A-Za-z0-9]+/, "") || "agent";
  const cleanChannel = safeSegment(channel).replace(/^[^A-Za-z0-9]+/, "") || "channel";
  const suffix = checksum(`${handle}/${channel}/worker`);
  return `${cleanHandle.slice(0, 20)}-${cleanChannel.slice(0, 20)}-worker-${suffix}`.slice(0, 64);
}

// #578 升级迁移（每个 front lane 只跑一次，以 runnerWorkdir 里的哨兵文件为闸）：
// main 的单 lane profile serve 用全局 state（loadCursor(channel)）与同一个 child 的自由文本会话。
// 分成 front/worker 双 lane 后 front 改用独立 state namespace + 严格 JSON 输出模式。首次挂载时：
//  - (#7) 把升级前的游标/欠账/修订游标迁进 front namespace，否则升级前没送达的那条 @（欠账 #198）
//    会因新 namespace 游标=0 被当积压跳过而静默丢失；
//  - (#10) 清掉 front runnerWorkdir 里升级前的会话指针（wake-session.json 与 continuations/，都是
//    agentparty 自己的会话文件、不是工作树内容），否则严格 JSON 的 front 会续用那份自由文本会话、
//    反复吐非 JSON 让 wake 一次次作废。哨兵文件保证只做一次，绝不误清升级后新建的会话。
export function migrateLegacyProfileFrontLane(channel: string, frontStateKey: string, frontRunnerWorkdir: string): void {
  const marker = join(frontRunnerWorkdir, ".front-lane-init");
  if (existsSync(marker)) return;
  const legacyCursor = loadCursor(channel);
  const legacyStuck = loadStuck(channel);
  const legacyRev = loadRevCursor(channel);
  const hasLegacy = legacyCursor > 0 || legacyStuck !== null || legacyRev > 0;
  if (hasLegacy && loadCursorForConfig(channel, frontStateKey) <= 0) {
    // 修订游标/欠账先迁，会话痕迹再清，游标（本函数的迁移完成信号）最后落。任一步抛错就让它冒到
    // attachInvite 的按频道重试里，下次挂载重跑整段——绝不能半套就落哨兵永久跳过（正是 #118/#198
    // 反复强调的静默丢失）。故哨兵只在全部成功后写，不放进 finally。
    if (legacyRev > 0) saveRevCursorForConfig(channel, legacyRev, frontStateKey);
    if (legacyStuck !== null) saveStuckForConfig(channel, legacyStuck, frontStateKey);
    // rmSync 失败不吞：force:true 已把「文件不存在」当成功，剩下的权限/IO 错误必须冒出去，让哨兵
    // 不落、下次挂载重试整段。吞掉的话会话没清成却照样落哨兵，#10 的会话清理被静默架空。
    rmSync(join(frontRunnerWorkdir, RUNNER_SESSION_FILE), { force: true });
    rmSync(join(frontRunnerWorkdir, RUNNER_CONTINUATIONS_DIR), { recursive: true, force: true });
    if (legacyCursor > 0) saveCursorForConfig(channel, legacyCursor, frontStateKey);
  }
  // 走到这里说明迁移已整段成功（或本就无遗产）：落哨兵，后续挂载不再重试。
  writeFileSync(marker, "v1\n", { flag: "w" });
}

function managedWorkerResultRoute(): RunnerResultRoute {
  return (frame, text) => ({
    replyTo: frame.seq,
    text: `[worker report for origin #${frame.reply_to ?? frame.seq}]\n${text.trim() || "worker returned no result"}`,
  });
}

// managed front 派工/返工信封的文案是 worker lane 验证「这条 wake 确实来自 front 派工」的唯一依据
// （consumer=assertManagedWorkerWake，producer=createManagedFrontResultRoute，相隔上百行）。两侧
// 必须共用同一份动词前缀，否则任何一侧改词/改标点都会让所有派工被判成 unverified wake 而全线挂。
// Phase 2（#581）会把它换成结构化 delivery 字段，届时可删。
const WORKER_DISPATCH_VERB = "已派工";
const WORKER_FEEDBACK_VERB = "已要求补充/返工";

function formatWorkerEnvelope(
  kind: "worker_dispatch" | "worker_feedback",
  worker: string,
  lineage: string,
  instruction: string,
): string {
  const verb = kind === "worker_feedback" ? WORKER_FEEDBACK_VERB : WORKER_DISPATCH_VERB;
  return `${verb} ${worker}${lineage}：${instruction}`;
}

export function assertManagedWorkerWake(
  frame: MsgFrame,
  delivery: DirectedDelivery | null,
  projectAgent: ProjectAgentRunContext | null,
  self: string,
): void {
  if (projectAgent?.runtime_role !== "worker") return;
  // #581 mcp 协议：验收纯结构化。front 的 party_reply 没有 mentions 能力，任何 front @worker 的
  // 消息在结构上只能出自 dispatch/feedback 工具——文本前缀比对（#578 finding 3 的根源）不再参与。
  const structuralOnly = projectAgent.protocol === "mcp";
  const dispatchPrefix = `${WORKER_DISPATCH_VERB} ${self}：`;
  const feedbackPrefix = `${WORKER_FEEDBACK_VERB} ${self}`;
  const feedbackSeparator = frame.body.indexOf("：", feedbackPrefix.length);
  const routedDispatch = frame.body.startsWith(dispatchPrefix) && frame.body.slice(dispatchPrefix.length).trim().length > 0;
  const routedFeedback = frame.body.startsWith(feedbackPrefix) &&
    feedbackSeparator >= feedbackPrefix.length &&
    frame.body.slice(feedbackSeparator + 1).trim().length > 0;
  const allowedCause = delivery?.cause === "mention" || delivery?.cause === "mention_edit" || delivery?.cause === "retry";
  if (
    delivery === null ||
    delivery.message_seq !== frame.seq ||
    delivery.target_name !== self ||
    delivery.state !== "claimed" ||
    !allowedCause ||
    frame.kind !== "message" ||
    frame.sender.kind !== "agent" ||
    frame.sender.name !== projectAgent.front_agent ||
    frame.sender.owner !== projectAgent.owner_account ||
    frame.reply_to === null ||
    !frame.mentions.includes(self) ||
    (!structuralOnly && !routedDispatch && !routedFeedback)
  ) {
    throw new ManagedWorkerUndispatchedError(
      `managed worker rejected unverified wake: expected dispatch/feedback from ${projectAgent.front_agent} owned by ${projectAgent.owner_account}`,
    );
  }
}

export function createManagedFrontResultRoute(opts: {
  server: string;
  token: string;
  channel: string;
  frontName: string;
  workerName: string;
  ownerAccount: string;
  fetch?: typeof fetchMessages;
  /**
   * 服务端是否强制 owner 决策应答人绑定（welcome 的 owner_decision_binding=v1）。默认（未提供或返回
   * false）视为不支持：managed front 拒绝发起 owner 决策而不是静默发一条任何人都能应答的绑定，
   * 以免旧服务端下授权被无声降级（部署顺序必须先升级 Worker）。
   */
  ownerDecisionBindingEnforced?: () => boolean;
}): RunnerResultRoute {
  const fetch = opts.fetch ?? fetchMessages;
  const readExact = async (seq: number): Promise<MsgFrame> => {
    const message = (await fetch(opts.server, opts.token, opts.channel, Math.max(0, seq - 1), 1))
      .find((candidate) => candidate.seq === seq);
    if (message === undefined) throw new WakeBlockedError(`managed front lineage message #${seq} is unavailable`, false);
    return message;
  };
  interface ResolvedOrigin {
    seq: number;
    workerReportSeq?: number;
    workerDispatchSeq?: number;
  }
  const resolveFrame = async (frame: MsgFrame, seen: Set<number>, depth: number): Promise<ResolvedOrigin> => {
    if (depth > 12 || seen.has(frame.seq)) {
      throw new WakeBlockedError("managed front lineage is cyclic or too deep", false);
    }
    seen.add(frame.seq);
    if (frame.sender.name === opts.workerName) {
      if (frame.sender.owner !== opts.ownerAccount || frame.reply_to === null) {
        throw new WakeBlockedError("worker report principal or dispatch link could not be verified", false);
      }
      const dispatch = await readExact(frame.reply_to);
      if (
        dispatch.sender.name !== opts.frontName ||
        dispatch.sender.owner !== opts.ownerAccount ||
        !dispatch.mentions.includes(opts.workerName) ||
        dispatch.reply_to === null ||
        dispatch.seq >= frame.seq
      ) {
        throw new WakeBlockedError("worker report dispatch lineage could not be verified", false);
      }
      const root = await resolveFrame(await readExact(dispatch.reply_to), seen, depth + 1);
      return {
        ...root,
        workerReportSeq: frame.seq,
        workerDispatchSeq: dispatch.seq,
      };
    }
    if (frame.decision_response !== undefined) {
      const question = await readExact(frame.decision_response.request_seq);
      if (
        frame.sender.kind !== "human" ||
        frame.sender.owner !== opts.ownerAccount ||
        frame.reply_to !== frame.decision_response.request_seq ||
        question.sender.name !== opts.frontName ||
        question.sender.owner !== opts.ownerAccount ||
        question.decision_request === undefined ||
        question.reply_to === null ||
        question.seq >= frame.seq
      ) {
        throw new WakeBlockedError("owner decision question lineage could not be verified", false);
      }
      return resolveFrame(await readExact(question.reply_to), seen, depth + 1);
    }
    return { seq: frame.seq };
  };
  const continuationOrigin = async (
    frame: MsgFrame,
    delivery: DirectedDelivery | null,
  ): Promise<ResolvedOrigin | null> => {
    if (frame.sender.name === opts.workerName) return resolveFrame(frame, new Set(), 0);
    if (frame.decision_response === undefined) return null;
    if (
      delivery?.cause !== "owner_answer" ||
      delivery.work_id === null ||
      delivery.continuation_ref === null ||
      frame.decision_response.work_id !== delivery.work_id ||
      frame.decision_response.continuation_ref !== delivery.continuation_ref
    ) {
      throw new WakeBlockedError("owner answer delivery lineage could not be verified", false);
    }
    return resolveFrame(frame, new Set(), 0);
  };
  return async (frame, text, _marker, delivery) => {
    const action = parseManagedFrontAction(text);
    const origin = await continuationOrigin(frame, delivery);
    const replyTo = origin?.seq ?? frame.seq;
    const completionSummarySeq = origin === null ? undefined : frame.seq;
    if (action.action === "worker_dispatch" || action.action === "worker_feedback") {
      const lineage = action.action === "worker_feedback" && origin?.workerReportSeq !== undefined
        ? ` (report #${origin.workerReportSeq}, dispatch #${origin.workerDispatchSeq}, origin #${origin.seq})`
        : "";
      return {
        replyTo,
        text: formatWorkerEnvelope(action.action, opts.workerName, lineage, action.instruction),
        mentions: [opts.workerName],
        ...(completionSummarySeq === undefined ? {} : { completionSummarySeq }),
      };
    }
    if (action.action === "owner_decision") {
      if (delivery === null || delivery.work_id === null || delivery.continuation_ref === null) {
        throw new WakeBlockedError("managed owner decision requires an active durable delivery", false);
      }
      // 旧服务端会静默丢弃 expected_decision_responder_owner，任何人都能替 owner 拍板。宁可在这里
      // fail closed（front 会据此报 blocked，提示先升级 Worker），也不发一条授权无声降级的决策。
      if (opts.ownerDecisionBindingEnforced?.() !== true) {
        throw new WakeBlockedError(
          "server does not enforce owner_decision responder binding (owner_decision_binding v1); upgrade the Worker before managed owner decisions",
          false,
        );
      }
      const decisionRequest: SendDecisionRequest = action.options === undefined
        ? { kind: "approval", prompt: action.prompt }
        : { kind: "choice", prompt: action.prompt, options: action.options };
      return {
        replyTo,
        text: action.prompt,
        decisionRequest,
        expectedDecisionLineage: {
          delivery_id: delivery.id,
          work_id: delivery.work_id,
          continuation_ref: delivery.continuation_ref,
        },
        expectedDecisionResponderOwner: opts.ownerAccount,
      };
    }
    if (action.action === "channel_reply") {
      return {
        replyTo,
        text: action.body,
        ...(completionSummarySeq === undefined ? {} : { completionSummarySeq }),
      };
    }
    return {
      replyTo,
      text: `暂时阻塞：${action.reason}`,
      completionSummarySeq: frame.seq,
      completionState: "blocked",
      blockedReason: action.reason,
    };
  };
}

export function projectAgentReadyNote(profile: ProjectAgentProfile, channel: string, prepared: PreparedProfileWorkspace): string {
  const channelLabel = readyNoteField(channel, 64);
  const project = readyNoteField(profile.repo_url ?? profile.workdir ?? "local", 240);
  const baseBranch = readyNoteField(profile.base_branch, 128);
  const channelWorkdir = readyNoteField(prepared.channelWorkdir, 512);
  return `front agent ready: ${profile.owner_account}/${profile.handle} channel=#${channelLabel} team=${profile.handle} project=${project} base=${baseBranch} worktree=${profile.worktree_strategy} cwd=${channelWorkdir} delivery=worktree->PR->channel-link->deploy-verify->safe-prune`;
}

export async function runProfileServe(opts: ProfileServeOptions): Promise<number> {
  const rawOut = opts.out ?? ((line: string) => console.error(line));
  const out = (line: string) => rawOut(terminalOutput(line));
  const mintRuntime = opts.mintRuntime ?? mintProjectAgentRuntimeToken;
  const listInvites = opts.listInvites ?? listProjectAgentInvites;
  const ensureChannelRuntime = opts.ensureChannelRuntime ?? ensureProjectAgentChannelRuntime;
  const runChannelServe = opts.runChannelServe ?? runServe;
  const post = opts.post ?? postMessage;
  const injectedSleep = opts.sleep;
  const lifecycleController = new AbortController();
  const lifecycleSignal = lifecycleController.signal;
  let shutdownError: ServeShutdownError | null = null;
  const requestShutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (shutdownError !== null) return;
    shutdownError = new ServeShutdownError(signal);
    lifecycleController.abort(shutdownError);
  };
  const onInterrupt = () => requestShutdown("SIGINT");
  const onTerminate = () => requestShutdown("SIGTERM");
  const onInheritedAbort = () => {
    if (shutdownError !== null) return;
    shutdownError = opts.signal?.reason instanceof ServeShutdownError
      ? opts.signal.reason
      : new ServeShutdownError("SIGTERM");
    lifecycleController.abort(shutdownError);
  };
  if (opts.signal === undefined) {
    // Keep one idempotent handler installed through the full child cleanup barrier. A second signal
    // must not restore Node's default exit while runner process groups are still terminating.
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  } else {
    opts.signal.addEventListener("abort", onInheritedAbort, { once: true });
    if (opts.signal.aborted) onInheritedAbort();
  }
  // The production timer itself must be cancelled on shutdown. Racing a regular setTimeout
  // rejects promptly but leaves the timer alive, which can keep the profile daemon process open.
  const abortableSleep = injectedSleep === undefined
    ? (ms: number) => delayWithAbort(ms, lifecycleSignal)
    : (ms: number) => awaitWithAbort(injectedSleep(ms), lifecycleSignal);
  const running = new Map<string, Promise<number>>();
  const attaching = new Map<string, Promise<void>>();
  const terminalChannels = new Set<string>();
  const upgradeProbeIntervalMs = opts.upgradeProbeIntervalMs ?? 5 * 60_000;
  const refreshAvailableUpgrade = opts.refreshAvailableUpgrade;
  let currentAvailableUpgrade = opts.availableUpgrade ?? null;
  let nextSharedUpgradeProbeAt = 0;
  let sharedUpgradeProbe: Promise<CliUpgradeNotice | null> | null = null;
  const sharedRefreshAvailableUpgrade = refreshAvailableUpgrade === undefined
    ? undefined
    : (_current: CliUpgradeNotice | null) => {
        const now = Date.now();
        if (sharedUpgradeProbe === null || now >= nextSharedUpgradeProbeAt) {
          nextSharedUpgradeProbeAt = now + upgradeProbeIntervalMs;
          sharedUpgradeProbe = refreshAvailableUpgrade(currentAvailableUpgrade).then((next) => {
            currentAvailableUpgrade = next;
            return next;
          });
        }
        return sharedUpgradeProbe;
      };
  try {
  const runtime = await awaitWithAbort(
    mintRuntime(opts.server, opts.humanToken, opts.handle, lifecycleSignal),
    lifecycleSignal,
  );
  const profile = runtime.profile;
  if (profile.owner_account !== opts.ownerAccount || profile.handle !== opts.handle) {
    throw new Error(`profile token mismatch: requested ${opts.ownerAccount}/${opts.handle}, got ${profile.owner_account}/${profile.handle}`);
  }
  out(`serving project agent ${profile.owner_account}/${profile.handle} — runner=${profile.runner}`);

  const attachInvite = async (invite: ChannelProjectAgentInvite) => {
    if (lifecycleSignal.aborted) throw lifecycleSignal.reason;
    const channel = invite.channel_slug;
    if (running.has(channel) || terminalChannels.has(channel)) return;
    if (profile.runner === "shell") {
      throw new Error("project agent runner shell is not supported by party serve --profile");
    }
    const front: ProjectAgentChannelRuntime = await ensureChannelRuntime(
      opts.server,
      runtime.token,
      channel,
      profile.owner_account,
      profile.handle,
      projectAgentChildName(profile.handle, channel),
      lifecycleSignal,
    );
    const worker: ProjectAgentChannelRuntime = await ensureChannelRuntime(
      opts.server,
      runtime.token,
      channel,
      profile.owner_account,
      profile.handle,
      projectAgentWorkerName(profile.handle, channel),
      lifecycleSignal,
    );
    if (lifecycleSignal.aborted) throw lifecycleSignal.reason;
    for (const principal of [front, worker]) {
      if (principal.owner === profile.owner_account && principal.channel_scope === channel) continue;
      throw new Error(
        `profile child identity mismatch for #${channel}: owner=${principal.owner} scope=${principal.channel_scope}`,
      );
    }
    if (front.name === worker.name) throw new Error(`profile front and worker identities collide in #${channel}`);
    // The authoritative child principal/channel scope must exist before choosing any session path.
    // Same-named profiles or children on another server therefore cannot share continuation files.
    const frontPrepared = await prepareProfileChannelWorkspace({
      server: opts.server,
      profile,
      channel,
      child: front,
      runGit: opts.runGit,
      signal: lifecycleSignal,
    });
    const workerPrepared = await prepareProfileChannelWorkspace({
      server: opts.server,
      profile,
      channel,
      child: worker,
      runGit: opts.runGit,
      signal: lifecycleSignal,
    });
    if (lifecycleSignal.aborted) throw lifecycleSignal.reason;
    const frontContext = profileContext(profile, frontPrepared, {
      role: "front",
      frontAgent: front.name,
      workers: [worker.name],
      protocol: profile.runner === "codex-sdk" ? "text" : opts.protocol ?? "mcp",
    });
    const workerContext = profileContext(profile, workerPrepared, {
      role: "worker",
      frontAgent: front.name,
      workers: [],
      protocol: profile.runner === "codex-sdk" ? "text" : opts.protocol ?? "mcp",
    });
    // Managed child tokens are supervisor capabilities and stay memory-only.  Cursor/debt helpers
    // need only a stable namespace key; writing a real AgentParty config would let the model find
    // and reuse the front/worker bearer token even though its inherited env points at a denied home.
    const frontStateKey = join(frontPrepared.runnerWorkdir, "supervisor-front.state-key");
    const workerStateKey = join(workerPrepared.runnerWorkdir, "supervisor-worker.state-key");
    const channelController = new AbortController();
    const channelSignal = channelController.signal;
    const abortChannel = () => {
      if (!channelSignal.aborted) channelController.abort(lifecycleSignal.reason ?? new ServeShutdownError("SIGTERM"));
    };
    lifecycleSignal.addEventListener("abort", abortChannel, { once: true });
    if (lifecycleSignal.aborted) abortChannel();
    const channelSleep = injectedSleep === undefined
      ? (ms: number) => delayWithAbort(ms, channelSignal)
      : (ms: number) => awaitWithAbort(injectedSleep(ms), channelSignal);

    // #581：协议分流。codex-sdk 本期没有 MCP 注入面，强制 text；builtin 默认 mcp。
    const requestedProtocol = opts.protocol ?? "mcp";
    const laneProtocol: "mcp" | "text" = profile.runner === "codex-sdk" ? "text" : requestedProtocol;
    if (laneProtocol === "text") {
      out(
        profile.runner === "codex-sdk" && requestedProtocol === "mcp"
          ? `profile #${channel}: codex-sdk runner has no MCP injection surface yet; falling back to the deprecated text envelope protocol`
          : `profile #${channel}: text envelope protocol is DEPRECATED and will be removed after one minor cycle; drop --protocol text to use MCP tools`,
      );
    }
    const buildLane = (
      role: ServeExecutionRole,
      principal: ProjectAgentChannelRuntime,
      prepared: PreparedProfileWorkspace,
      stateKey: string,
      context: ProjectAgentRunContext,
    ): ServeOptions => {
      // 升级迁移只对 front lane（频道对话的继承者）做一次：迁旧游标/欠账 + 清旧自由文本会话（#7/#10）。
      if (role === "front") migrateLegacyProfileFrontLane(channel, stateKey, prepared.runnerWorkdir);
      // #581 managed MCP：lane 清单 + child token config（0600）。这是 #578「child token 纯内存」
      // 边界的有意放宽（issue #581 拍板）：MCP server 进程要持有身份就必须能读到它；模型 env 仍是
      // denied-home，token 不进模型环境。
      // #647：但它绝不能落在 worker 模型的 workspace-write 沙箱根（channelWorkdir）之内——否则模型能
      // 读回自己的 token（绕过 denied-home 直接打 REST）并篡改 managed.json（放宽 attachment_root
      // 越权上传宿主文件）。非 branch 策略下 channelWorkdir === runnerWorkdir，故不能再用 runnerWorkdir/mcp；
      // 改用 runnerWorkdir 的**同级**目录（.mcp 后缀），在所有策略下都保证落在沙箱之外。MCP server
      // 子进程（serve 起、非沙箱）照常读得到，被沙箱的只是模型本身。
      const mcpStateDir = `${prepared.runnerWorkdir}.mcp`;
      if (laneProtocol === "mcp") {
        // 兜底 fail-closed：万一某种策略下路径推导仍落进沙箱，拒绝启动而不是把 token 暴露给模型。
        // rel === "" 表示 mcpStateDir 与沙箱根**相等**，同样越界（CodeRabbit #651）；rel 不以 .. 开头
        // 且非绝对路径表示嵌套在沙箱内。两种都拒。
        const relToWorkspace = relative(prepared.channelWorkdir, mcpStateDir);
        if (!relToWorkspace.startsWith("..") && !isAbsolute(relToWorkspace)) {
          throw new Error(
            `refusing managed MCP: state dir ${mcpStateDir} is inside the worker sandbox ${prepared.channelWorkdir} ` +
              "(would leak the child token / manifest to the sandboxed model)",
          );
        }
        writeManagedManifest(mcpStateDir, {
          version: 1,
          server: opts.server,
          channel,
          role,
          self: principal.name,
          front: front.name,
          worker: worker.name,
          owner_account: profile.owner_account,
          config: join(mcpStateDir, MANAGED_CONFIG_FILE),
          attachment_root: role === "worker" ? prepared.channelWorkdir : null,
        });
        writeFileSync(
          join(mcpStateDir, MANAGED_CONFIG_FILE),
          JSON.stringify({ server: opts.server, token: principal.token }) + "\n",
          { mode: 0o600 },
        );
      }
      // 每个 welcome 刷新一次；owner 决策路由在 wake（必在 welcome 之后）里读它决定能否发决策。
      let serverOwnerDecisionBinding = false;
      const resultRoute = laneProtocol === "mcp"
        ? undefined
        : role === "front"
        ? createManagedFrontResultRoute({
            server: opts.server,
            token: principal.token,
            channel,
            frontName: front.name,
            workerName: worker.name,
            ownerAccount: profile.owner_account,
            fetch: opts.fetchMessages,
            ownerDecisionBindingEnforced: () => serverOwnerDecisionBinding,
          })
        : managedWorkerResultRoute();
      return {
        onServerCapabilities: (caps) => { serverOwnerDecisionBinding = caps.ownerDecisionBinding; },
        ...profileChildServeOptions({
          server: opts.server,
          token: principal.token,
          channel,
          mentionsOnly: role === "worker" ? true : opts.mentionsOnly,
          skipBacklog: opts.skipBacklog,
        }),
        server: opts.server,
        token: principal.token,
        channel,
        since: loadCursorForConfig(channel, stateKey),
        stuck: loadStuckForConfig(channel, stateKey),
        onStuck: (stuck) => stuck === null
          ? clearStuckForConfig(channel, stateKey)
          : saveStuckForConfig(channel, stuck, stateKey),
        sinceRev: loadRevCursorForConfig(channel, stateKey),
        cmd: "",
        mentionsOnly: role === "worker" ? true : opts.mentionsOnly,
        onCursor: (cursor) => saveCursorForConfig(channel, cursor, stateKey),
        onRevCursor: (revCursor) => saveRevCursorForConfig(channel, revCursor, stateKey),
        projectAgent: context,
        availableUpgrade: currentAvailableUpgrade,
        refreshAvailableUpgrade: sharedRefreshAvailableUpgrade,
        upgradeProbeIntervalMs,
        runnerTimeoutMs: role === "front"
          ? opts.runnerTimeoutMs ?? DEFAULT_FRONT_RUNNER_TIMEOUT_MS
          : opts.runnerTimeoutMs,
        signal: channelSignal,
        advertise: async (signal) => {
          if (role === "front") {
            const note = projectAgentReadyNote(profile, channel, prepared);
            await post(opts.server, principal.token, channel, {
              kind: "status",
              state: "waiting",
              role: "host",
              note: `${note} worker=${worker.name}`,
              mentions: [],
              residency: "supervised",
              wake: { kind: "serve" },
              context: {
                workspace_label: `${profile.owner_account}/${profile.handle}`,
                worktree_label: `${principal.name}:${profile.worktree_strategy}:${profile.base_branch}`,
              },
            }, signal);
            await post(opts.server, principal.token, channel, {
              kind: "message",
              body: `${profile.name || profile.handle} joined #${channel}: front=${front.name}, execution worker=${worker.name}.`,
              mentions: [],
              reply_to: null,
            }, signal);
            return;
          }
          await post(opts.server, principal.token, channel, {
            kind: "status",
            state: "waiting",
            role: "worker",
            note: `execution worker ready; reports to ${front.name}`,
            mentions: [],
            residency: "supervised",
            wake: { kind: "serve" },
            context: {
              workspace_label: `${profile.owner_account}/${profile.handle}`,
              worktree_label: `${principal.name}:${profile.worktree_strategy}:${profile.base_branch}`,
            },
          }, signal);
        },
        fetchCharter: (signal) => fetchChannelCharter(opts.server, principal.token, channel, signal),
        builtinRunner: profile.runner === "codex" || profile.runner === "claude"
          ? {
              server: opts.server,
              token: principal.token,
              channel,
              harness: profile.runner,
              workdir: prepared.runnerWorkdir,
              cwd: prepared.channelWorkdir,
              isolateModelPartyAccess: true,
              sandbox: role === "front" ? "read-only" : "workspace-write",
              resultRoute,
              outputSchema: laneProtocol === "mcp" ? undefined : role === "front" ? MANAGED_FRONT_OUTPUT_SCHEMA : undefined,
              attachmentRoot: role === "front" ? null : prepared.channelWorkdir,
              ...(laneProtocol === "mcp"
                ? {
                    managedMcp: {
                      stateDir: mcpStateDir,
                      ownerDecisionBinding: () => serverOwnerDecisionBinding,
                    },
                  }
                : {}),
            }
          : undefined,
        sdkRunner: profile.runner === "codex-sdk"
          ? {
              server: opts.server,
              token: principal.token,
              channel,
              workdir: prepared.runnerWorkdir,
              cwd: prepared.channelWorkdir,
              isolateModelPartyAccess: true,
              // worker 与 builtin lane 一致给 workspace-write，绝不能是 full_access（sdkSandboxMode
              // 会映射成 danger-full-access = 完全无沙箱）；否则 SDK worker 能读任意主机文件、拷进
              // channelWorkdir 再 [attach:] 上传，绕过本 PR 对 worker 的主机文件边界。
              sandbox: role === "front" ? "read_only" : "workspace-write",
              resultRoute,
              outputSchema: role === "front" ? MANAGED_FRONT_OUTPUT_SCHEMA : undefined,
              attachmentRoot: role === "front" ? null : prepared.channelWorkdir,
            }
          : undefined,
      };
    };

    const frontServeOpts = buildLane("front", front, frontPrepared, frontStateKey, frontContext);
    const workerServeOpts = buildLane("worker", worker, workerPrepared, workerStateKey, workerContext);
    const startLane = (label: ServeExecutionRole, lane: ServeOptions, stateKey: string): Promise<number> => {
      let firstAttach = true;
      return superviseServe({
        runOnce: () => {
          const skipBacklog = firstAttach ? lane.skipBacklog : false;
          return runChannelServe({
            ...lane,
            since: loadCursorForConfig(channel, stateKey),
            stuck: loadStuckForConfig(channel, stateKey),
            sinceRev: loadRevCursorForConfig(channel, stateKey),
            skipBacklog,
            onWelcome: () => { firstAttach = false; },
          });
        },
        maxRestarts: opts.once ? 0 : undefined,
        // A per-lane wake circuit is an execution fault, not channel/profile revocation. Restart
        // that lane after backoff while its sibling (especially the front control plane) stays up.
        isTerminal: (code) => isTerminalServeExit(code) && code !== EXIT_WAKE_ABANDON_CIRCUIT,
        sleep: channelSleep,
        onLifecycle: (line) => out(`profile ${label} #${channel}: ${line}`),
      }).catch((error) => {
        if (error instanceof ServeShutdownError) return error.exitCode;
        out(`profile ${label} #${channel} crashed: ${errText(error)}`);
        return EXIT_STREAM_ENDED;
      });
    };
    // Start the execution lane first.  A front dispatch that races its first websocket is still
    // safe because the directed delivery remains queued until this worker claims it.
    const workerPromise = startLane("worker", workerServeOpts, workerStateKey);
    const frontPromise = startLane("front", frontServeOpts, frontStateKey);
    const promise = Promise.race([
      frontPromise.then((code) => ({ lane: "front" as const, code })),
      workerPromise.then((code) => ({ lane: "worker" as const, code })),
    ])
      .then(async (first) => {
        if (!channelSignal.aborted) channelController.abort(new ServeShutdownError("SIGTERM"));
        await Promise.allSettled([frontPromise, workerPromise]);
        if (isTerminalServeExit(first.code)) {
          terminalChannels.add(channel);
          out(`profile ${first.lane} #${channel} stopped terminally with code=${first.code}`);
        }
        return first.code;
      })
      .finally(() => {
        lifecycleSignal.removeEventListener("abort", abortChannel);
        running.delete(channel);
      });
    running.set(channel, promise);
    out(`attached project agent ${profile.owner_account}/${profile.handle} to #${channel} (front=${front.name}, worker=${worker.name})`);
  };

  const startInvite = (invite: ChannelProjectAgentInvite): Promise<void> => {
    const channel = invite.channel_slug;
    const current = attaching.get(channel);
    if (current !== undefined) return current;
    if (running.has(channel) || terminalChannels.has(channel)) return Promise.resolve();
    const attach = attachInvite(invite);
    attaching.set(channel, attach);
    const clear = () => {
      if (attaching.get(channel) === attach) attaching.delete(channel);
    };
    void attach.then(clear, clear);
    return attach;
  };

  // 控制面必须比数据面更耐操（#115）：一次 DNS 抖动 / 5xx / 单频道 clone 失败，都不该
  // 拖死整个 daemon 和它已经挂上的其它频道。数据面的 ws 早就有指数退避，这里补齐。
  const basePollMs = opts.pollIntervalMs ?? 5000;
  const maxBackoffMs = 5 * 60_000;
  let consecutiveFailures = 0;

  for (;;) {
    try {
      const invites = await awaitWithAbort(
        listInvites(opts.server, runtime.token, opts.handle, lifecycleSignal),
        lifecycleSignal,
      );
      // 单个 invite 起不来（clone 失败、token 铸不出）不连坐其它频道
      for (const invite of invites) {
        try {
          await awaitWithAbort(startInvite(invite), lifecycleSignal);
        } catch (err) {
          if (lifecycleSignal.aborted) throw lifecycleSignal.reason;
          out(`failed to attach #${invite.channel_slug}: ${errText(err)} (will retry next poll)`);
        }
      }
      consecutiveFailures = 0;
    } catch (err) {
      if (lifecycleSignal.aborted) throw lifecycleSignal.reason;
      // 401/403 是终局：token 被撤或无权，重试只会刷日志（同 watch 的 EXIT_AUTH 语义）
      if (err instanceof RestError && (err.status === 401 || err.status === 403)) throw err;
      consecutiveFailures += 1;
      const backoff = Math.min(basePollMs * 2 ** (consecutiveFailures - 1), maxBackoffMs);
      out(`invite poll failed (${consecutiveFailures}x): ${errText(err)}; retrying in ${Math.round(backoff / 1000)}s`);
      if (opts.once) throw err;
      await abortableSleep(backoff);
      continue;
    }
    // #630：--auto-upgrade 已把新二进制下载+校验落盘（notice.action_required === "auto_reexec"，仅
    // autoDownload 成功才置）。多 lane profile daemon 同进程，绝不能在单个 lane 里 execv——会把另一条
    // lane 的在飞 runner 连根拔起、留孤儿 + 重启后双 runner 抢跑。改在 supervisor 空档协调：先排空所有
    // lane，再整进程 re-exec 新版（此刻无在飞 runner，干净）。execv 不可用/测试注入时退出 EXIT_UPGRADED
    // 让外层 supervisor（launchd KeepAlive / tmux）用新二进制拉起。此前只下载不 re-exec，daemon 永远跑旧版。
    if (currentAvailableUpgrade?.action_required === "auto_reexec") {
      out(`serve: 新版 party v${currentAvailableUpgrade.available_version} 已下载校验，排空 lane 后 re-exec`);
      if (!lifecycleSignal.aborted) lifecycleController.abort(new ServeShutdownError("SIGTERM"));
      await Promise.allSettled([...attaching.values()]);
      await Promise.allSettled([...running.values()]);
      // re-exec 失败（execv 抛错）也必须返回 EXIT_UPGRADED，让外层 supervisor（launchd/tmux）用新
      // 二进制拉起，而不是把异常抛出 daemon（CodeRabbit #651）。lane 已排空，此刻退出干净。
      try {
        maybeReexecUpgrade(true, opts.upgradeDeps);
      } catch (error) {
        out(`serve: re-exec 失败，退出让 supervisor 用新版拉起: ${errText(error)}`);
      }
      return EXIT_UPGRADED;
    }
    if (opts.once) {
      await Promise.all([...running.values()]);
      return 0;
    }
    await abortableSleep(basePollMs);
  }
  } catch (error) {
    if (!lifecycleSignal.aborted) lifecycleController.abort(error);
    // An attach can cross the abort edge while it is minting a child or terminating a detached git
    // process. Wait for those barriers first; only then snapshot child serves, because a finishing
    // attach may have inserted a new child into `running` immediately before it observed the abort.
    await Promise.allSettled([...attaching.values()]);
    await Promise.allSettled([...running.values()]);
    if (lifecycleSignal.reason instanceof ServeShutdownError) {
      return lifecycleSignal.reason.exitCode;
    }
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    opts.signal?.removeEventListener("abort", onInheritedAbort);
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
  directedDeliveryMode = false,
): number {
  let depth = 0;
  for (const f of pending) {
    if (directedDeliveryMode && f.type !== "delivery") continue;
    const message = f.type === "delivery" ? f.message : f.type === "msg" ? f : null;
    if (message === null) continue;
    if (f.type === "delivery") {
      if (f.delivery.target_name !== self || f.delivery.state !== "claimed") continue;
    } else {
      if (message.seq <= afterSeq) continue;
      if (message.sender.name === self) continue;
      if (mentionsOnly && !message.mentions.includes(self)) continue;
    }
    depth += 1;
  }
  return depth;
}

/**
 * A delivery transition is durable only after the Worker echoes the authoritative row.
 * `WebSocket.send()` alone can silently lose the frame in a disconnect window; advancing the local
 * cursor then would let the same work be replayed and execute model/external side effects twice.
 */
export async function confirmDeliveryUpdate(
  conn: Pick<ReturnType<typeof connect>, "send" | "pendingFrames">,
  update: DeliveryUpdateFrame,
  timeoutMs = DELIVERY_UPDATE_ACK_TIMEOUT_MS,
  signal?: AbortSignal,
  acceptedAuthoritativeStates: readonly PublicDirectedDelivery["state"][] = [],
): Promise<PublicDirectedDelivery> {
  const requestId = randomUUID();
  const existingErrors = new Set(conn.pendingFrames().filter((frame) => frame.type === "error"));
  if (signal?.aborted) throw signal.reason;
  if (!conn.send({ ...update, request_id: requestId })) throw new Error("websocket is not open");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    const pending = conn.pendingFrames();
    const ack = [...pending].reverse().find(
      (frame): frame is Extract<ServerFrame, { type: "delivery_state" }> =>
        frame.type === "delivery_state" &&
        frame.request_id === requestId &&
        frame.delivery.id === update.delivery_id,
    );
    if (ack !== undefined) {
      if (ack.delivery.state === update.state) return ack.delivery;
      // A decision request can move the source to waiting_owner while its runner is winding down.
      // The late generic `replied` receipt is intentionally a no-op; the authoritative suspended
      // state is still a successful durable acknowledgement of this turn.
      if (update.state === "replied" && ack.delivery.state === "waiting_owner") return ack.delivery;
      // Some transitions are probes rather than commands. In particular, a bare `replied` probe
      // asks the Worker whether a linked REST reply actually committed. The caller may explicitly
      // accept the authoritative `failed` answer and handle it as a visible silent-runner failure;
      // keep the default strict for every ordinary state transition.
      if (acceptedAuthoritativeStates.includes(ack.delivery.state)) return ack.delivery;
      if (ack.delivery.state === "waiting_owner" || ack.delivery.state === "replied" || ack.delivery.state === "failed") {
        throw new Error(`delivery state is ${ack.delivery.state}, expected ${update.state}`);
      }
    }
    const error = [...pending].reverse().find(
      (frame): frame is Extract<ServerFrame, { type: "error" }> =>
        frame.type === "error" && !existingErrors.has(frame),
    );
    if (error !== undefined) throw new Error(`${error.code}: ${error.message}`);
    if (Date.now() >= deadline) throw new Error(`delivery update acknowledgement timed out after ${timeoutMs}ms`);
    if (signal === undefined) await delay(10);
    else await delayWithAbort(10, signal);
  }
}

export async function runWithRunnerTimeout(
  run: NonNullable<ServeOptions["runCommand"]>,
  frame: MsgFrame,
  ctx: Parameters<NonNullable<ServeOptions["runCommand"]>>[1],
  requestedTimeoutMs: number = DEFAULT_RUNNER_TIMEOUT_MS,
  lifecycleSignal?: AbortSignal,
): Promise<void> {
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(1, Math.floor(requestedTimeoutMs))
    : DEFAULT_RUNNER_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutError = new RunnerTimeoutError(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  const onLifecycleAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(lifecycleSignal?.reason instanceof Error
        ? lifecycleSignal.reason
        : new ServeShutdownError("SIGTERM"));
    }
  };
  lifecycleSignal?.addEventListener("abort", onLifecycleAbort, { once: true });
  if (lifecycleSignal?.aborted) onLifecycleAbort();
  const running = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return run(frame, { ...ctx, signal: controller.signal });
    })
    .finally(() => { settled = true; });
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new WakeBlockedError("runner aborted", false));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    await Promise.race([running, aborted]);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    // Cancellation is a request, not proof of termination. No next wake or process exit may pass
    // this barrier while a child/process group can still be alive.
    if (!settled) await Promise.race([
      running.then(() => undefined, () => undefined),
      delay(RUNNER_TERMINATION_BARRIER_MS),
    ]);
    if (controller.signal.reason === timeoutError) timeoutError.terminationConfirmed = settled;
    throw controller.signal.reason instanceof Error ? controller.signal.reason : error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    lifecycleSignal?.removeEventListener("abort", onLifecycleAbort);
  }
}

export async function runServe(o: ServeOptions): Promise<number> {
  const rawOut = o.out ?? ((line: string) => console.error(line));
  const out = (line: string) => rawOut(terminalOutput(line));
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
  let availableUpgrade = o.availableUpgrade ?? null;
  let nextUpgradeProbeAt = 0;
  // 本地连接健康探针（#254）：WS 生命周期转场（不是 presence 自报、不是 PID 推断）落 health.json，
  // 让 watchdog 能问「这个 serve 此刻真的还在收帧吗」而不是只能 pgrep。reconnect_count 数的是
  // 本进程生命周期内进入过几次 reconnecting，不是每次退避重试都加一——那样一次掉线会看起来像刷屏。
  let reconnectCount = 0;
  // health/statusline 是本地可观测性，不是消息交付的一部分。磁盘满、只读目录或
  // 原子 rename 竞态都不能从 WS 回调 / 帧循环里把常驻 supervisor 打死。
  const bestEffortLocalState = (write: () => void) => {
    try {
      write();
    } catch {
      // A later heartbeat/frame will retry naturally; delivery stays authoritative on the server.
    }
  };
  const onWsStatus = (status: "open" | "reconnecting" | "closed", detail?: { error?: string }) => {
    if (status === "open") {
      // A successful TCP/WS handshake is not proof that the application path is alive. Clear the
      // previous frame timestamp on every replacement socket and keep the reconnect reason until
      // the frame loop receives a valid server frame; otherwise a half-broken endpoint that only
      // accepts WebSockets briefly inherits the old socket's fresh timestamp and looks healthy.
      bestEffortLocalState(() => writeHealthCache({
        channel: o.channel,
        ws_connected: true,
        reconnecting: false,
        connected_since: Date.now(),
        last_frame_at: null,
      }));
    } else if (status === "reconnecting") {
      reconnectCount += 1;
      bestEffortLocalState(() => writeHealthCache({
        channel: o.channel,
        ws_connected: false,
        reconnecting: true,
        reconnect_count: reconnectCount,
        connected_since: null,
        // 无新错误详情时保留上一条重连原因，避免 inbound timeout 后的替换连接在收到
        // 有效帧前再次断开时把 last_error 覆盖成 null（丢失原因）。
        ...(detail?.error === undefined ? {} : { last_error: detail.error }),
      }));
    } else {
      bestEffortLocalState(() => writeHealthCache({ channel: o.channel, ws_connected: false, reconnecting: false, connected_since: null, last_error: detail?.error ?? null }));
    }
  };
  const skipBacklog = o.skipBacklog !== false; // 默认跳过离线积压（#193）
  // 抢锁在连 WS 之前：第二个 serve 连接都不该建，否则它已经在消费 @、已经在跑 runner 了（#99）。
  // 这把锁只挡同机；跨机器重复执行需要服务端租约（do.ts 广播发给同名所有连接）。
  const lockDir = o.lockDir ?? defaultInstanceLockDir();
  const lockTarget = o.lockDir === undefined ? instanceLockTarget(o.server, o.token, o.channel) : o.channel;
  // #741:给进程起个可区分的标题——同机同频道多 agent 时,身份藏在 AGENTPARTY_CONFIG 环境变量里、
  // ps 命令列看不到,两个 serve 长得一模一样。把 lockTarget(<hash>-<channel>)写进 title,
  // 让 ps/pkill -f 能定位到具体某个(配合 `party serve <ch> --stop` 更稳)。best-effort,平台不支持就算了。
  try { process.title = `party serve ${lockTarget}`; } catch { /* 某些运行时 title 只读 */ }
  const lock = o.allowMultiple === true ? null : acquireInstanceLock("serve", lockTarget, lockDir);
  if (lock && !lock.ok) {
    out(
      `serve: 已有 serve 挂在 #${o.channel} 上（pid ${lock.heldByPid}）。` +
        ` 再挂一个会让同一条 @ 触发两次完整 runner——双份回帖，git push 类副作用执行两遍。` +
        ` 要么等它退出，要么用 \`party serve ${o.channel} --stop\`（只停本身份这台，别用 pkill -f 会误杀同机别人的）；确实想并存请加 --allow-multiple。`,
    );
    return EXIT_ALREADY_SERVING;
  }
  let conn: ReturnType<typeof connect>;
  try {
    conn = connect(o.server, o.token, o.channel, o.since, {
      onCursor: o.onCursor,
      directedDelivery: "v1",
      sinceRev: o.sinceRev,
      onRevCursor: o.onRevCursor,
      onStatus: onWsStatus,
      inboundIdleTimeoutMs: o.inboundIdleTimeoutMs,
    });
  } catch (error) {
    lock?.release?.();
    throw error;
  }
  const lifecycleController = new AbortController();
  let shutdownError: ServeShutdownError | null = null;
  const requestShutdown = (error: ServeShutdownError) => {
    if (shutdownError !== null) return;
    shutdownError = error;
    lifecycleController.abort(shutdownError);
    // Wake an idle frame iterator. Active runners observe the same signal and finish their
    // process-group TERM -> KILL barrier before runServe reaches its finally block.
    conn.close();
  };
  const onInterrupt = () => requestShutdown(new ServeShutdownError("SIGINT"));
  const onTerminate = () => requestShutdown(new ServeShutdownError("SIGTERM"));
  const onInheritedAbort = () => {
    const reason = o.signal?.reason;
    requestShutdown(
      reason instanceof ServeShutdownError ? reason : new ServeShutdownError("SIGTERM"),
    );
  };
  if (o.signal === undefined) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  } else {
    o.signal.addEventListener("abort", onInheritedAbort, { once: true });
    if (o.signal.aborted) onInheritedAbort();
  }
  // issue #522：runner 的模型 session 是可恢复句柄，不是 websocket session。连接建立后把它作为
  // presence-only 元数据自报；每次 runner 冷起/续会并刷新本地 wake-session.json 后再覆盖一次。
  const reportAgentSession = (session: AgentSessionInfo) => {
    try {
      conn.send({
        type: "heartbeat",
        current_task: null,
        task_started_at: null,
        heartbeat_at: null,
        agent_session: session,
      });
    } catch {
      // 重连 welcome 会从本地 wake-session.json 再报；一次 WS 窗口失败不阻断 runner。
    }
  };
  const run: ServeRunner = o.runCommand ?? (o.sdkRunner
    ? createSdkRunner({
        ...o.sdkRunner,
        onSession: (session) => {
          o.sdkRunner?.onSession?.(session);
          reportAgentSession(session);
        },
      })
    : o.builtinRunner
      ? createBuiltinRunner({
          ...o.builtinRunner,
          onSession: (session) => {
            o.builtinRunner?.onSession?.(session);
            reportAgentSession(session);
          },
        })
      : defaultRun);
  const settleRunnerDelivery = async (delivery: DirectedDelivery, state: "replied" | "failed") => {
    try {
      await run.onDeliveryTerminal?.(delivery, state);
    } catch (error) {
      // The channel reply/failure is already authoritative. Local cleanup must be visible but can
      // never roll the durable delivery back or make the runner execute the work again.
      out(`  delivery ${delivery.id} 本地 continuation 清理失败: ${errText(error)}`);
    }
  };
  // 挂载之初就落一份 health 基线：即便还没收到第一帧，watchdog 也能看到「这个 pid 认领了这个频道」，
  // 而不是文件缺失时无法区分「serve 没起来」和「serve 起来了但还没写过健康数据」。
  bestEffortLocalState(() => writeHealthCache({ channel: o.channel, ws_connected: false, reconnecting: false, reconnect_count: 0, last_frame_at: null, last_error: null, connected_since: null }));
  // 本实例私有的上下文命名空间（#197 / #208 门禁）。退出时整目录删除：
  // 失败的唤醒会把上下文留在盘上供本次排查，但它带着 charter / recent 正文，
  // 不能在进程结束后继续躺在共享 tmpdir 里。
  const contextDir = createWakeContextDir();
  // 挂载那一刻的频道水位（welcome.last_seq），只在首个 welcome 记一次。
  let attachHead: number | null = null;
  let welcomeReported = false;
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
  // runner 健康自报（#603）：连败计数 + 最后错误，随任务心跳（含清除帧）上行。熔断
  // （MAX_CONSECUTIVE_WAKE_ABANDONS）退出前那段「presence 全绿但 @ 了没人应」的窗口，
  // 频道从此看得见「在线但干不动」。送达一次即清零（与 consecutiveWakeAbandons 同口径）。
  let runnerHealth: { consecutive_failures: number; last_error?: string } = { consecutive_failures: 0 };
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
  // 新服务端把 agent work 作为独立 delivery 帧持久重放；普通 msg/read cursor 只负责阅读。
  // 缺 capability 的旧服务端继续沿用 mentions + cursor 唤醒，保证滚动升级兼容。
  let directedDeliveryMode = false;
  let pendingPersistedSession: AgentSessionInfo | null = null;
  const reportPendingPersistedSession = () => {
    if (pendingPersistedSession === null) return;
    reportAgentSession(pendingPersistedSession);
    pendingPersistedSession = null;
  };
  // standby 收到的最早可唤醒消息。它以及后续帧都不推进 cursor；接管租约时由 Connection
  // 把已消费但未 ack 的帧按 seq 重排到队首，避免持租者中途退出时静默吞掉在飞 wake（#465）。
  let deferredLeaseSeq: number | null = null;
  let charter: ChannelCharter | null = o.charter ?? null;
  const refreshCharter = async (reason: string, expectedRev?: number) => {
    if (!o.fetchCharter) return;
    if (expectedRev !== undefined && charter !== null && charter.charter_rev >= expectedRev) return;
    try {
      charter = await awaitWithAbort(
        o.fetchCharter(lifecycleController.signal),
        lifecycleController.signal,
      );
    } catch (e) {
      if (lifecycleController.signal.aborted) throw lifecycleController.signal.reason;
      out(`  charter 刷新失败（${reason}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // 触发消息之前的最近频道消息（滚动窗口），随 context file 递给 runner
  const recent: MsgFrame[] = [];
  // Heartbeat on a clock, not only on traffic — see watch.ts; a quiet channel
  // must not read as "listener down" on status bars.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  try {
    // Initial control-plane work belongs to the same lifecycle as the frame loop. If SIGTERM lands
    // here, the shared finally below must still release the socket, lock, listeners and context dir.
    await refreshCharter("attach");
    out(
      `serving #${o.channel} — 每条${o.mentionsOnly ? " @你 的" : ""}消息触发一次命令（Ctrl-C 停）`,
    );
    // #720：没开 --auto-upgrade 的常驻会卡在旧版——权限墙拦 `curl … | sh`、重启又自毁本轮会话。
    // 提醒一次:加 --auto-upgrade(唤醒间隙自行下载+校验+re-exec,无需人工),或用桌面版 launchd 常驻(默认带)。
    if (o.autoUpgrade !== true) {
      out("serve: 未开 --auto-upgrade——本进程不会自升级，落后版本需人工重启。加 --auto-upgrade 让它在唤醒间隙自行换新，或用桌面版「转为常驻」(launchd，默认带)。");
    }
    if (o.statusline === true) {
      heartbeat = setInterval(() => {
        bestEffortLocalState(() => writeStatuslineCache({
            ...localStatuslineBase(o.channel),
            ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
          }));
      }, 60_000);
      if (typeof heartbeat.unref === "function") heartbeat.unref();
    }
    frameLoop: for await (const incoming of conn.frames) {
      const directedDelivery = incoming.type === "delivery" ? incoming.delivery : null;
      const frame = incoming.type === "delivery" ? incoming.message : incoming;
      // 每收到一帧（含 ping 的 pong 回执）就刷新 last_frame_at——空闲频道也靠 ping 心跳（~25s）
      // 保持新鲜，watchdog 才能把"频道安静"和"连接僵死"分开（issue #254 证据边界）。
      bestEffortLocalState(() => writeHealthCache({
        channel: o.channel,
        last_frame_at: Date.now(),
        last_error: null,
      }));
      if (frame.type === "welcome") {
        self = frame.self;
        if (!welcomeReported) {
          o.onWelcome?.();
          welcomeReported = true;
        }
        directedDeliveryMode = frame.directed_delivery === "v1";
        o.onServerCapabilities?.({ ownerDecisionBinding: frame.owner_decision_binding === "v1" });
        // 挂上/重连即向服务端 claim serve 租约（#99）。best-effort：ws 此刻是 OPEN，claim 会送出；
        // 服务端在同名多条 serve 里选唯一持租者并回 serve_lease。老服务端不认识它、直接忽略（hasLease
        // 默认 true → 旧行为）。重连每次 welcome 都重新 claim（连接换了，租约候选身份也换了）。
        conn.send({ type: "serve_lease", op: "claim" });
        // 必须等服务端明确裁决 held=true：standby 机器上的旧 wake-session.json 不能因为网络抖动
        // 或裁决稍晚就覆盖持租者更新的 session。老服务端不认识 serve_lease 时仍能照常跑 runner，
        // 但不会冒险上报无法证明归属的恢复 session。
        leaseKnown = false;
        pendingPersistedSession = persistedAgentSession(o);
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
          bestEffortLocalState(() => writeStatuslineCache({
              ...localStatuslineBase(o.channel),
              ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
              unread: unreadFromCursor(frame.last_seq, o.channel),
            }));
        }
        if (typeof frame.charter_rev === "number") await refreshCharter("welcome", frame.charter_rev);
        // 挂上即声明可唤醒（best-effort，只做一次；重连再收 welcome 不重复刷）
        if (!advertised) {
          advertised = true;
          try {
            if (o.advertise !== undefined) {
              await awaitWithAbort(
                o.advertise(lifecycleController.signal),
                lifecycleController.signal,
              );
            }
          } catch (e) {
            if (lifecycleController.signal.aborted) throw lifecycleController.signal.reason;
            out(`  wake 能力声明失败（不影响服务，可稍后手动 party status 声明）: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        continue;
      }
      if (frame.type === "error") {
        console.error(terminalOutput(`error: ${frame.code} ${frame.message}`));
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
        if (hasLease) reportPendingPersistedSession();
        continue;
      }
      if (frame.type !== "msg") continue;
      if (
        directedDelivery !== null &&
        (directedDelivery.target_name !== self || directedDelivery.state !== "claimed")
      ) {
        out(`serve: ignored invalid delivery ${directedDelivery.id} for target=${directedDelivery.target_name} state=${directedDelivery.state}`);
        continue;
      }
      const fromSelf = frame.sender.name === self;
      // fresh = 游标之上的新消息。历史修订快照会穿透去重被重放（seq 早已消费过），
      // 它们不是新唤醒——不 fresh 就绝不触发 runner（否则旧 @ 被编辑一次，每次重连都重跑一遍）
      // delivery 是独立 work cursor：即使普通 read cursor 已越过 message_seq，也必须执行。
      const fresh = directedDelivery !== null || frame.seq > conn.cursor;
      // 欠账（#198）先于**一切**过滤条件。它送达失败过、从没进过模型——欠着就是欠着，
      // 与当前是不是 mentions-only、是不是积压无关。
      // 反例（190-codex-dev on PR #206）：--all 下一条非 mention 失败留下欠账，重启回默认
      // mentions-only 后 qualifies=false → 不重试、不清欠账、却无条件 ack 越过它。
      const isDebt = stuck !== null && frame.seq === stuck.seq;
      const isBacklog = directedDelivery === null && skipBacklog && attachHead !== null && frame.seq <= attachHead;
      const mentionOwnedByDelivery =
        directedDeliveryMode && directedDelivery === null && frame.mentions.includes(self);
      const passesFilter =
        directedDelivery !== null
          ? !fromSelf
          : !fromSelf && !isBacklog && !mentionOwnedByDelivery && (!o.mentionsOnly || frame.mentions.includes(self));
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
      let stopAfterFrame = false;
      if (qualifies) {
        out(`▶ ${formatMsg(frame)}`);
        // 串行：本条命令跑完再消费下一帧（新帧此间缓冲在 FrameQueue），避免并发唤起互相抢
        // 有界重试（#198）：同一条 seq 最多 maxAttempts 次。前一个进程崩在第 k 次，这里从 k 接着数。
        let attemptFloor = stuck?.seq === frame.seq ? stuck.attempts : 0;
        // 崩溃在「最后一次失败落盘」与「最终通告」之间时，这里循环一次都不跑，
        // lastError 必须从盘上接手，否则最终通告里的错误原因是空字符串（门禁 P2）。
        let lastError = (stuck?.seq === frame.seq ? stuck.last_error : "") ?? "";
        let delivered = false;
        let deliveryCleanupDone = false;
        const settleCurrentDelivery = async (state: "replied" | "failed") => {
          if (directedDelivery === null || deliveryCleanupDone) return;
          await settleRunnerDelivery(directedDelivery, state);
          deliveryCleanupDone = true;
        };
        // A crash can happen after a non-retriable model failure was persisted but before the final
        // blocked announcement. Preserve that safety bit across supervisor restarts; old state files
        // omit it and retain the historical retryable behavior for compatibility.
        let retriable = stuck?.seq === frame.seq ? stuck.retriable !== false : true;
        let runnerTerminationUnconfirmed = stuck?.seq === frame.seq && stuck.termination_unconfirmed === true;
        // custom/builtin runner 一旦可能已经执行过模型就不会重试；最终通告必须报告真实执行次数，
        // 不能把配置预算 maxAttempts 伪装成实际已跑次数（例如一次 SIGTERM 不能写成 3/3）。
        let attemptsUsed = attemptFloor;
        // 身后已缓冲的 wake 深度（#103）：内建 runner 随 working 帧上报，presence 显示「忙 + N 待处理」。
        // 本帧正在处理，故只数它 seq 之后、够格触发唤醒的缓冲帧。
        const queueDepth = pendingWakeDepth(
          conn.pendingFrames(),
          self,
          o.mentionsOnly === true,
          frame.seq,
          directedDeliveryMode,
        );
        // #646：busy 清除（#103）由所有终局路径共用——包括在模型启动前失败的 preflight。
        // 只在队列真排空时清：还有 @ 排队就保持 busy=true，等下一条 wake 的 working 帧继续覆盖
        // queue_depth（避免闪烁）。
        const takeBusyClearIfDrained = (force = false): { busy?: false; queue_depth?: 0 } => {
          if (!busyReported) return {};
          const remaining = pendingWakeDepth(
            conn.pendingFrames(),
            self,
            o.mentionsOnly === true,
            conn.cursor,
            directedDeliveryMode,
          );
          if (!force && remaining !== 0) return {};
          busyReported = false;
          return { busy: false, queue_depth: 0 };
        };
        // 先把入站附件放进本 serve 实例的 0700 临时目录。runner 只拿 0600 本地文件与
        // 鉴权端点元数据，context 中绝不出现 bearer token；单个下载失败也不吞掉整次唤醒。
        let wakeAttachments: WakeContextAttachment[] = [];
        let cliUpgrade: CliUpgradeNotice | null = availableUpgrade;
        let preflightFailed = false;
        // managed worker 的非派工 wake：settle 投递但不刷频道 blocked（见 ManagedWorkerUndispatchedError）。
        let preflightSilentSkip = false;
        for (;;) {
          try {
            // A managed execution identity is not a generally addressable agent. Reject direct
            // member mentions and stale/same-name principals before downloads, `running`, or model.
            assertManagedWorkerWake(frame, directedDelivery, o.projectAgent ?? null, self);
            wakeAttachments = await awaitWithAbort(materializeWakeAttachments(
              o.server,
              o.token,
              o.channel,
              frame,
              contextDir,
              o.downloadAttachment ?? downloadAttachment,
            ), lifecycleController.signal);
            if (o.refreshAvailableUpgrade !== undefined && Date.now() >= nextUpgradeProbeAt) {
              nextUpgradeProbeAt = Date.now() + (o.upgradeProbeIntervalMs ?? 5 * 60_000);
              try {
                availableUpgrade = await awaitWithAbort(
                  o.refreshAvailableUpgrade(availableUpgrade),
                  lifecycleController.signal,
                );
              } catch (error) {
                if (lifecycleController.signal.aborted) throw error;
                // A failed optional probe is a completed preflight with the previous known value.
              }
            }
            cliUpgrade = upgradeNotice(o.autoUpgrade === true, o.upgradeDeps) ?? availableUpgrade;
            // #646：prepare（git clone/pull、SDK startThread、附件下载）此前只受 shutdown 信号约束，
            // 停滞远端会无界挂住串行 wake 消费者——正是 runner 硬超时的初衷。给 prepare 也套一个超时预算
            // （与 runner 同额，并上 shutdown）：超时即中止本轮 prepare，走常规重试/放弃而非永久挂起。
            const prepareTimeoutMs = o.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
            const preparationSignal = AbortSignal.any([
              lifecycleController.signal,
              AbortSignal.timeout(prepareTimeoutMs),
            ]);
            const preflightContext: ServeRunnerContext = {
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
              delivery: directedDelivery,
              signal: preparationSignal,
            };
            const preparation = run.prepare?.(frame, preflightContext);
            if (preparation !== undefined) {
              await awaitWithAbort(preparation, preparationSignal);
            }
            if (lifecycleController.signal.aborted) throw lifecycleController.signal.reason;
            break;
          } catch (error) {
            if (error instanceof ServeShutdownError) {
              shutdownError = error;
              break frameLoop;
            }
            attemptsUsed = attemptFloor + 1;
            attemptFloor = attemptsUsed;
            lastError = errText(error);
            retriable = error instanceof WakeBlockedError && error.retriable;
            if (error instanceof ManagedWorkerUndispatchedError) preflightSilentSkip = true;
            out(`  runner 预处理失败 (${attemptsUsed}/${maxAttempts})，未发送 running、未启动模型: ${lastError}`);
            if (directedDelivery === null) {
              setStuck({ seq: frame.seq, attempts: attemptsUsed, last_error: lastError, retriable });
            }
            if (retriable && attemptsUsed < maxAttempts) {
              if (retryDelayMs > 0) await delayWithAbort(retryDelayMs, lifecycleController.signal);
              continue;
            }
            preflightFailed = true;
            break;
          }
        }
        if (preflightFailed) {
          const note =
            `wake undelivered before model start, giving up: seq=${frame.seq}; ` +
            `attempts=${attemptsUsed}/${maxAttempts}; retry_delay_ms=${retryDelayMs}; last error: ${lastError}`;
          // 非派工的 managed worker wake 不刷频道 blocked（worker 不是频道参与者，闲聊回复不该刷噪声）；
          // 投递仍在下方 settle，绝不重投。其它预处理失败照常公开宣告放弃。
          if (preflightSilentSkip) {
            out(`  managed worker 忽略非派工 wake，静默 settle（不刷频道 blocked）: seq=${frame.seq}`);
          } else {
            try {
              await (o.post ?? postMessage)(o.server, o.token, o.channel, {
                kind: "status",
                state: "blocked",
                note,
                mentions: [],
                blocked_reason: note,
                // 上一条 wake 因身后仍有积压而延续 busy 时，本条 preflight 终局负责在排空后
                // 原子清掉它；若仍有其它 wake，则继续保持 busy，避免中途闪成空闲。
                ...takeBusyClearIfDrained(),
              }, lifecycleController.signal);
            } catch {
              code = EXIT_WAKE_UNANNOUNCED;
              break frameLoop;
            }
          }
          if (directedDelivery !== null) {
            try {
              await confirmDeliveryUpdate(conn, {
                type: "delivery_update",
                delivery_id: directedDelivery.id,
                state: "failed",
                error: sanitizeBlockedError(lastError),
              }, undefined, lifecycleController.signal);
              await settleCurrentDelivery("failed");
            } catch (error) {
              out(`  delivery ${directedDelivery.id} 预处理失败回执发送失败: ${errText(error)}`);
              code = EXIT_STREAM_ENDED;
              break frameLoop;
            }
          } else {
            setStuck(null);
            conn.ack(frame.seq);
          }
          continue frameLoop;
        }

        // `running` now means every slow, model-free prerequisite succeeded. Once acknowledged,
        // only synchronous started telemetry remains before the runner crosses its model boundary.
        if (directedDelivery !== null) {
          try {
            await confirmDeliveryUpdate(conn, {
              type: "delivery_update",
              delivery_id: directedDelivery.id,
              state: "running",
              ...(directedDelivery.work_id === null ? {} : { work_id: directedDelivery.work_id }),
              ...(directedDelivery.continuation_ref === null ? {} : { continuation_ref: directedDelivery.continuation_ref }),
            }, undefined, lifecycleController.signal);
          } catch (error) {
            out(`  delivery ${directedDelivery.id} 启动确认失败，未启动 runner: ${errText(error)}`);
            code = EXIT_STREAM_ENDED;
            stopAfterFrame = true;
            break frameLoop;
          }
        }
        if (reportsBusy) busyReported = true;
        // 每任务进度/心跳（#228，扩 #103 busy）：run() 会把这条串行循环阻塞数分钟——期间频道与本机都看不到
        // 「具体这条任务在跑、活着」。用一个 setInterval 侧信道在 run() 执行期间周期性刷新（阻塞的循环靠定时器
        // 心跳），每拍做两件事：① 本机 health.json 盖上 current_task/heartbeat_at（供 party health/watchdog）；
        // ② 一条 presence-only 的 heartbeat 帧发给 DO（供 who/web），**不落 history、不刷屏**。任务结束（成功或
        // 放弃）在 finally 里清定时器 + 发一条 current_task=null 的清除帧——绝不留「假在跑」的僵状态。
        const nowFn = o.now ?? (() => Date.now());
        const taskStartedAt = nowFn();
        const heartbeatIntervalMs = o.heartbeatIntervalMs ?? DEFAULT_TASK_HEARTBEAT_MS;
        // runner 健康（#603）：finally 里的结账以「当时的 delivered」为准；随后的 completion probe
        // 可能把 delivered 翻成 false（silent runner）。记住任务前的连败基数，供 probe 纠账。
        const runnerFailuresBeforeTask = runnerHealth.consecutive_failures;
        // 活动上报（#602）：builtin claude runner 的 hooks 会把「正在干什么」落到约定文件；
        // 每拍读一次捎带进心跳帧。其它 runner（codex/sdk/custom）没有 hook 落盘，恒不带。
        const activityFile = o.builtinRunner?.harness === "claude" ? runnerActivityFile(o.builtinRunner.workdir) : null;
        const emitTaskBeat = (active: boolean, at: number) => {
          const fields = active
            ? { current_task: frame.seq, task_started_at: taskStartedAt, heartbeat_at: at }
            : { current_task: null, task_started_at: null, heartbeat_at: null };
          const activity = active && activityFile !== null ? readActivityFile(activityFile, at) : null;
          // runner 健康（#603）：有连败才带；恢复后缺省即清（服务端不 COALESCE）。
          const runnerHealthField = runnerHealth.consecutive_failures > 0
            ? {
                runner_health: {
                  ok: runnerHealth.consecutive_failures < 2,
                  consecutive_failures: runnerHealth.consecutive_failures,
                  ...(runnerHealth.last_error === undefined ? {} : { last_error: runnerHealth.last_error }),
                },
              }
            : {};
          try {
            bestEffortLocalState(() => writeHealthCache({ channel: o.channel, ...fields }));
          } catch {
            /* 本机 health 落盘失败不影响唤醒 */
          }
          try {
            conn.send({ type: "heartbeat", ...fields, ...(activity === null ? {} : { activity }), ...runnerHealthField });
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
          void (o.post ?? postMessage)(o.server, o.token, o.channel, {
            kind: "status",
            state: "working",
            note: `runner started for seq ${frame.seq}: ${self} runner=${runnerKind}`,
            mentions: [],
          }, lifecycleController.signal).catch((e) => out(`  runner_started 审计发送失败（不影响送达）: ${errText(e)}`));
        } catch (e) {
          out(`  runner_started 审计发送失败（不影响送达）: ${errText(e)}`);
        }
        const taskBeat: ReturnType<typeof setInterval> = setInterval(() => emitTaskBeat(true, nowFn()), heartbeatIntervalMs);
        if (typeof taskBeat.unref === "function") taskBeat.unref();
        try {
          for (let attempt = attemptFloor + 1; attempt <= maxAttempts && retriable; attempt++) {
            attemptsUsed = attempt;
            try {
              await runWithRunnerTimeout(run, frame, {
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
                delivery: directedDelivery,
              }, o.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS, lifecycleController.signal);
              delivered = true;
              break;
            } catch (e) {
              if (e instanceof ServeShutdownError) {
                shutdownError = e;
                break;
              }
              lastError = e instanceof Error ? e.message : String(e);
              runnerTerminationUnconfirmed = e instanceof RunnerTimeoutError && !e.terminationConfirmed;
              // 抛错不等于「模型没跑过」。只有 runner 明确声明可重试（spawn 都没成功）才重试；
              // 否则重跑会重复模型与外部副作用（git push / 开 PR）。见门禁 P1③。
              retriable = e instanceof WakeBlockedError ? e.retriable : false;
              // #690：环境性失败（认证/二进制/沙箱）模型确定没跑——别再挂「model may have run」的免责标签，
              // 那会误导 owner 以为副作用可能已发生。说清是环境坏了、修好再 @ 即可（保守：仅明确指纹命中）。
              const envFailure = e instanceof WakeBlockedError && e.environment;
              if (!retriable) {
                lastError += envFailure
                  ? " (runner environment failure: model did not run — fix credentials/binary/sandbox, e.g. `claude login`, then re-mention)"
                  : " (not retriable: model may have run)";
              }
              out(`  命令失败 (${attempt}/${maxAttempts}): ${lastError}`);
              // 先落盘再重试：此刻进程崩掉，重启后不会把已经烧掉的次数忘干净
              // Directed work has its own server-side lease/state machine. Mirroring it into the
              // legacy seq debt would make a later ordinary backfill bypass delivery ownership and
              // execute the same model turn again.
              if (directedDelivery === null) {
                setStuck({
                  seq: frame.seq,
                  attempts: attempt,
                  last_error: lastError,
                  retriable,
                  ...(runnerTerminationUnconfirmed ? { termination_unconfirmed: true } : {}),
                });
              }
              if (retriable && attempt < maxAttempts && retryDelayMs > 0) {
                await delayWithAbort(retryDelayMs, lifecycleController.signal);
              }
            }
          }
        } finally {
          // 任务收尾：无论送达、放弃还是抛异常穿透，都停心跳并清除本机+频道的「正在处理」状态。
          // 若身后还有排队的 wake，下一条自己的 started 拍会把 current_task 覆盖成新 seq。
          clearInterval(taskBeat);
          // runner 健康（#603）先于清除帧结账：让这一拍就把「本条送达/放弃」的结论带给频道。
          // 关停（shutdown）不算 runner 失败——那是 supervisor 生命周期，不是执行力问题。
          if (shutdownError === null) {
            runnerHealth = delivered
              ? { consecutive_failures: 0 }
              : {
                  consecutive_failures: runnerHealth.consecutive_failures + 1,
                  ...(lastError === "" ? {} : { last_error: sanitizeBlockedError(lastError).slice(0, 160) }),
                };
          }
          emitTaskBeat(false, nowFn());
          // WebSocket.send 只把帧交给本地发送队列；若服务端的终局帧已在入站队列里，下一轮会
          // 立刻 break 并 close socket。让出一拍，确保仍处于 OPEN 的连接有机会把 idle-clear
          // 刷到服务端，避免频道永久显示一条已经结束的 current_task。
          await delay(0);
        }
        if (shutdownError !== null) break frameLoop;
        let deliveryConfirmed = directedDelivery === null;
        if (delivered && directedDelivery !== null) {
          try {
            const completion = await confirmDeliveryUpdate(conn, {
              type: "delivery_update",
              delivery_id: directedDelivery.id,
              state: "replied",
            }, undefined, lifecycleController.signal, ["failed"]);
            if (completion.state === "failed") {
              // Worker is the race-free authority: if a linked REST reply committed, the row was
              // already replied before that HTTP request returned. A still-active row receiving a
              // bare success receipt is atomically failed as a silent runner, never guessed from
              // whether the asynchronous delivery_state broadcast reached this process yet.
              delivered = false;
              retriable = false;
              deliveryConfirmed = true;
              lastError = "runner exited successfully without a linked channel reply";
              attemptsUsed = Math.max(attemptsUsed, attemptFloor + 1);
              // runner 健康纠账（#603）：finally 已按「当时 delivered=true」清零；silent runner 是
              // 真失败，按任务前基数 +1 恢复连败计数（下一拍心跳把纠正带给频道）。
              runnerHealth = {
                consecutive_failures: runnerFailuresBeforeTask + 1,
                last_error: sanitizeBlockedError(lastError).slice(0, 160),
              };
              out(`  ${lastError}: seq=${frame.seq}`);
              // The first completion probe already made `failed` authoritative in the Worker.
              // Clean exact local continuation state now; a disconnect before the redundant
              // blocked-state receipt below must not leave a terminal work capability on disk.
              await settleCurrentDelivery("failed");
            } else {
              deliveryConfirmed = true;
              if (completion.state === "replied") {
                await settleCurrentDelivery("replied");
              }
            }
          } catch (error) {
            const message = errText(error);
            // 不伪称已确认：退出本轮。服务端仍保留 claimed/running，随后按明确的
            // unknown-outcome 规则收口；绝不在本地把 fire-and-forget 当 durable ack。
            out(`  delivery ${directedDelivery.id} 完成回执发送失败，重连核对: ${message}`);
            code = EXIT_STREAM_ENDED;
            stopAfterFrame = true;
          }
        }
        const clearBusyIfDrained = async (idleNote: string) => {
          const busyClear = takeBusyClearIfDrained();
          if (busyClear.busy !== false) return;
          try {
            await (o.post ?? postMessage)(o.server, o.token, o.channel, {
              kind: "status",
              state: "waiting",
              note: idleNote,
              mentions: [],
              ...busyClear,
            }, lifecycleController.signal);
          } catch (e) {
            // 清 busy 只是锦上添花：发不出去就下条 wake 的 working 帧会重置 queue_depth，或下次排空再补。
            out(`  busy 清除通告发送失败（不影响送达）: ${errText(e)}`);
          }
        };
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
          if (deliveryConfirmed && stuck !== null && stuck.seq === frame.seq) setStuck(null);
          await clearBusyIfDrained(`idle: ${self} finished wake seq=${frame.seq}, waiting for next @`);
        } else {
          // 有界重放到顶：显式放弃，但必须响亮留痕——静默丢弃正是 #118 要修的东西。
          // 没有 CLI flag，所以重试预算与退避必须**在频道里可见**：把常数藏进源码是不诚实的。
          const note =
            `wake undelivered, giving up: seq=${frame.seq}; ` +
            `attempts=${attemptsUsed}/${maxAttempts}; retry_delay_ms=${retryDelayMs}; ` +
            `last error: ${lastError}`;
          out(`  ${note}`);
          try {
            await (o.post ?? postMessage)(o.server, o.token, o.channel, {
              kind: "status",
              state: "blocked",
              note,
              mentions: [],
              blocked_reason: note,
              // Failure is already the authoritative terminal status for this wake. Clear the
              // busy bit on this same frame when the queue drained; a follow-up `waiting` frame
              // would erase the blocker and make the broken resident look healthy again (#756).
              ...takeBusyClearIfDrained(),
            }, lifecycleController.signal);
          } catch (e) {
            // 通告发不出去 = 没宣告过 = 没了结。此时清欠账 + ack 就是恢复 #118 的静默丢失。
            // 一个连自己喊不出救命的 supervisor，没有任何理由继续消费消息队列：响亮地死，让人发现。
            out(`  放弃通告发送失败，欠账保留、游标不动、退出: ${e instanceof Error ? e.message : String(e)}`);
            code = EXIT_WAKE_UNANNOUNCED;
            break;
          }
          // A silent-success completion probe may already have atomically returned the Worker's
          // terminal `failed` state. Do not require a second, redundant ACK after that authority;
          // a network drop between the two must not turn a known terminal result into "unknown".
          let failureConfirmed = deliveryConfirmed || directedDelivery === null;
          if (directedDelivery !== null && !failureConfirmed) {
            try {
              await confirmDeliveryUpdate(conn, {
                type: "delivery_update",
                delivery_id: directedDelivery.id,
                state: "failed",
                error: sanitizeBlockedError(lastError),
              }, undefined, lifecycleController.signal);
              failureConfirmed = true;
              await settleCurrentDelivery("failed");
            } catch (error) {
              out(`  delivery ${directedDelivery.id} 失败回执发送失败，重连重试: ${errText(error)}`);
              code = EXIT_STREAM_ENDED;
              stopAfterFrame = true;
            }
          }
          if (failureConfirmed && directedDelivery === null) {
            setStuck(null); // legacy 放弃只有在已宣告后才算了结
          }
          consecutiveWakeAbandons += 1;
          if (runnerTerminationUnconfirmed || consecutiveWakeAbandons >= MAX_CONSECUTIVE_WAKE_ABANDONS) {
            const finalNote =
              `serve wake circuit breaker tripped: reason=${runnerTerminationUnconfirmed ? "runner_termination_unconfirmed" : "consecutive_abandons"}; ` +
              `consecutive_abandons=${consecutiveWakeAbandons}/${MAX_CONSECUTIVE_WAKE_ABANDONS}; ` +
              `last_seq=${frame.seq}; last_error=${sanitizeBlockedError(lastError)}`;
            out(`  ${finalNote}`);
            try {
              await (o.post ?? postMessage)(o.server, o.token, o.channel, {
                kind: "status",
                state: "blocked",
                note: finalNote,
                mentions: [],
                blocked_reason: finalNote,
                // A circuit exits without consuming buffered mentions, so force-clear busy while
                // preserving `blocked` as the final externally visible state.
                ...takeBusyClearIfDrained(true),
              }, lifecycleController.signal);
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
      const awaitingDirectedDelivery =
        directedDeliveryMode && directedDelivery === null && !fromSelf && frame.mentions.includes(self);
      // standby 冻结区会在接管时完整重放；首次经过时不提前塞进 recent，避免重放后上下文重复。
      // 新协议的普通 mention 广播也先不塞：紧随其后的 delivery 才是触发点，recent 必须仍只含触发前上下文。
      if (!heldForLease && !awaitingDirectedDelivery) {
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
        bestEffortLocalState(() => writeStatuslineCache({
            ...localStatuslineBase(o.channel),
            ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
            unread: unreadFromCursor(frame.seq, o.channel),
            last_message: lastMessageFromFrame(frame),
          }));
      }

      if (wakeAbandonCircuitTripped) break;
      if (stopAfterFrame) break;

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
  } catch (error) {
    if (error instanceof ServeShutdownError) {
      shutdownError = error;
    } else if (lifecycleController.signal.aborted) {
      shutdownError = lifecycleController.signal.reason instanceof ServeShutdownError
        ? lifecycleController.signal.reason
        : new ServeShutdownError("SIGTERM");
    } else {
      throw error;
    }
  } finally {
    // 私有目录里躺着 charter / recent 正文。失败的唤醒把它留到本次排查结束，
    // 但绝不在进程退出后继续留在共享 tmpdir 里（#208 门禁 P2）。
    rmSync(contextDir, { recursive: true, force: true });
    lock?.release?.();
    if (heartbeat) clearInterval(heartbeat);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    o.signal?.removeEventListener("abort", onInheritedAbort);
    if (!lifecycleController.signal.aborted) {
      lifecycleController.abort(new ServeShutdownError("SIGTERM"));
    }
    conn.close();
    if (o.statusline === true) bestEffortLocalState(() => clearStatuslineListener());
    // 进程真退出了：health.json 不该继续显示 ws_connected=true 骗 watchdog（只清自己写的记录）。
    bestEffortLocalState(() => clearHealthCache());
  }
  if (shutdownError !== null) return shutdownError.exitCode;
  if (upgraded) return EXIT_UPGRADED;
  // 帧流意外结束（既非终局 error 也非用户 Ctrl-C）：常驻 supervisor 语义下这是异常终止。
  // 报机器可读原因 + 非零退出，否则 --on-mention supervisor 会像 watch --follow 一样静默消失（issue #29 同源）。
  if (code === 0) {
    out(`serve exited: stream ended unexpectedly`);
    return EXIT_STREAM_ENDED;
  }
  return code;
}

export interface ServeSupervisorOptions {
  runOnce: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 测试/嵌入方的上限；CLI 默认无限自愈，直到终局退出。 */
  maxRestarts?: number;
  /** Override terminal policy for composed lanes (managed front/worker keep healing after a circuit). */
  isTerminal?: (code: number) => boolean;
  onLifecycle?: (line: string) => void;
}

export function isTerminalServeExit(code: number): boolean {
  return code === 0 || code === EXIT_AUTH || code === EXIT_ARCHIVED || code === EXIT_UPGRADED ||
    code === EXIT_ALREADY_SERVING || code === EXIT_WAKE_ABANDON_CIRCUIT ||
    code === EXIT_SIGNAL_INT || code === EXIT_SIGNAL_TERM;
}

function reportServeLifecycle(opts: ServeSupervisorOptions, line: string): void {
  try {
    opts.onLifecycle?.(line);
  } catch {
    // Telemetry must never be the single point of failure for the self-healing supervisor
    // (disk full / read-only workdir / log rotation races are all non-fatal here).
  }
}

/**
 * CLI 外层常驻 supervisor。runServe 自己负责一条 WS 生命周期；若它仍以瞬态错误结束，
 * 这里从持久 cursor/stuck 重新构造下一轮，而不是把无人值守 agent 永久留在离线状态。
 */
export async function superviseServe(opts: ServeSupervisorOptions): Promise<number> {
  const sleep = opts.sleep ?? delay;
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? DEFAULT_SUPERVISOR_RESTART_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? MAX_SUPERVISOR_RESTART_DELAY_MS);
  let restarts = 0;
  for (;;) {
    reportServeLifecycle(opts, `event=start attempt=${restarts + 1}`);
    let code: number;
    let error = "";
    try {
      code = await opts.runOnce();
    } catch (cause) {
      code = 1;
      error = sanitizeBlockedError(cause instanceof Error ? cause.message : String(cause));
    }
    reportServeLifecycle(opts, `event=exit attempt=${restarts + 1} code=${code}${error ? ` error=${JSON.stringify(error)}` : ""}`);
    if ((opts.isTerminal ?? isTerminalServeExit)(code)) return code;
    if (opts.maxRestarts !== undefined && restarts >= opts.maxRestarts) return code;
    const waitMs = Math.min(baseDelayMs * 2 ** restarts, maxDelayMs);
    restarts += 1;
    reportServeLifecycle(opts, `event=restart next_attempt=${restarts + 1} delay_ms=${waitMs} previous_code=${code}`);
    if (waitMs > 0) await sleep(waitMs);
  }
}

export interface ServeIdentityBoundaryState {
  expectedPrincipal: string | null;
  rejectedAccountToken: string | null;
}

export interface ServePrincipal {
  server_origin: string;
  name: string;
  kind: string;
  owner: string | null;
}

export type ServeIdentityBoundaryResult =
  | { ok: true; principal: ServePrincipal; namespace: string }
  | { ok: false; code: typeof EXIT_AUTH; reason: string };

/**
 * Validate one supervisor attachment before it opens a WebSocket.
 *
 * The rejected-token check deliberately precedes `/api/me`: after a WS auth rejection an account
 * session gets one chance to rotate its token, but returning the exact same token is terminal and
 * must not issue the same doomed request forever.  `/api/me` 401/403 is terminal for both static and
 * account credentials; only transport/5xx failures remain restartable.
 */
export async function verifyServeIdentityBoundary(
  baseServer: string,
  auth: ResolvedAuthDetailed,
  state: ServeIdentityBoundaryState,
  fetchIdentity: typeof fetchMe = fetchMe,
): Promise<ServeIdentityBoundaryResult> {
  if (!auth.server || !auth.token) {
    return { ok: false, code: EXIT_AUTH, reason: "serve credentials are missing" };
  }
  const baseOrigin = canonicalServerOrigin(baseServer);
  const authOrigin = canonicalServerOrigin(auth.server);
  if (authOrigin !== baseOrigin) {
    return {
      ok: false,
      code: EXIT_AUTH,
      reason: `serve identity boundary changed: server ${baseOrigin} -> ${authOrigin}`,
    };
  }
  if (auth.auth_source === "account_session" && state.rejectedAccountToken === auth.token) {
    return {
      ok: false,
      code: EXIT_AUTH,
      reason: "serve account session returned the same rejected token",
    };
  }

  let me: Awaited<ReturnType<typeof fetchMe>>;
  try {
    me = await fetchIdentity(auth.server, auth.token);
  } catch (error) {
    if (error instanceof RestError && (error.status === 401 || error.status === 403)) {
      return {
        ok: false,
        code: EXIT_AUTH,
        reason: `serve authentication rejected by /api/me (${error.status})`,
      };
    }
    throw error;
  }

  const principal: ServePrincipal = {
    server_origin: authOrigin,
    name: me.name,
    kind: me.kind,
    owner: me.owner ?? null,
  };
  // Match the Worker's durable delivery principal exactly. Account-owned credentials remain
  // stable across rotation; owner-less legacy credentials are distinct capabilities even when a
  // revoked token name is later reused. Only the token digest enters memory/disk namespace keys.
  const deliveryPrincipal = typeof principal.owner === "string" && principal.owner.length > 0
    ? principal.owner
    : `token-sha256:${createHash("sha256").update(auth.token, "utf8").digest("hex")}`;
  const currentPrincipal = JSON.stringify([
    principal.server_origin,
    principal.name,
    principal.kind,
    deliveryPrincipal,
  ]);
  if (state.expectedPrincipal === null) state.expectedPrincipal = currentPrincipal;
  if (currentPrincipal !== state.expectedPrincipal) {
    return {
      ok: false,
      code: EXIT_AUTH,
      reason: `serve identity boundary changed: ${state.expectedPrincipal} -> ${currentPrincipal}`,
    };
  }
  if (state.rejectedAccountToken !== null && state.rejectedAccountToken !== auth.token) {
    state.rejectedAccountToken = null;
  }
  return {
    ok: true,
    principal,
    namespace: stableNamespace([
      principal.server_origin,
      principal.name,
      principal.kind,
      deliveryPrincipal,
    ]),
  };
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["all", "auto-upgrade", "replay-backlog", "profile-once", "stop"] });
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const server = auth.server;
  const unknown = unknownFlagError(flags, SERVE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "on-mention", "runner", "workdir", "repo", "profile", "profile-poll-interval", "runner-timeout-seconds", "protocol"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cmd = str(flags["on-mention"]);
  const runner = str(flags.runner);
  const runnerTimeoutSecondsRaw = str(flags["runner-timeout-seconds"]);
  // #646：flag 未显式提供时保持 undefined，让各 lane 用自己的默认（front 10min / worker+单 runner
  // 30min，见下游 `?? DEFAULT_FRONT_RUNNER_TIMEOUT_MS` / `?? DEFAULT_RUNNER_TIMEOUT_MS`）。此前这里
  // 恒填 30min，front 的 DEFAULT_FRONT_RUNNER_TIMEOUT_MS 永不生效（死代码）。显式提供则两 lane 统一用它。
  const runnerTimeoutSeconds = runnerTimeoutSecondsRaw === undefined ? undefined : Number(runnerTimeoutSecondsRaw);
  if (
    runnerTimeoutSeconds !== undefined &&
    (!Number.isInteger(runnerTimeoutSeconds) || runnerTimeoutSeconds < 1 || runnerTimeoutSeconds > 7 * 24 * 60 * 60)
  ) {
    console.error("--runner-timeout-seconds must be an integer between 1 and 604800");
    return 1;
  }
  const runnerTimeoutMs = runnerTimeoutSeconds === undefined ? undefined : runnerTimeoutSeconds * 1000;
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
    // #581：managed lane 协议开关。默认 mcp；text 是一个 minor 周期的逃生舱（deprecated）。
    const protocolFlag = str(flags.protocol);
    if (protocolFlag !== undefined && protocolFlag !== "mcp" && protocolFlag !== "text") {
      console.error("--protocol must be mcp or text");
      return 1;
    }
    const autoDownloadUpgrade = flags["auto-upgrade"] === true;
    const availableUpgrade = await resolveAvailableUpgrade(account.session.server, null, {
      autoDownload: autoDownloadUpgrade,
      out: (line) => console.error(terminalOutput(line)),
    });
    if (availableUpgrade !== null) console.error(terminalOutput(`serve: ${availableUpgrade.message}\n  ${availableUpgrade.command}`));
    return runProfileServe({
      server: account.session.server,
      humanToken: account.token,
      ownerAccount: profileRef.owner,
      handle: profileRef.handle,
      mentionsOnly: flags.all !== true,
      availableUpgrade,
      refreshAvailableUpgrade: (current) => resolveAvailableUpgrade(account.session.server, current, {
        autoDownload: autoDownloadUpgrade,
        out: (line) => console.error(terminalOutput(line)),
      }),
      skipBacklog: flags["replay-backlog"] !== true,
      once: flags["profile-once"] === true,
      pollIntervalMs,
      runnerTimeoutMs,
      ...(protocolFlag === undefined ? {} : { protocol: protocolFlag }),
    });
  }
  // 频道先解析:--stop 需要它,且必须在 runner/on-mention 校验之前处理——否则
  // `party serve <ch> --stop`（不带 --runner）会先撞上「必须二选一」而永远到不了 --stop(#742 CodeRabbit)。
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  // #741：只停「本身份」在这个频道跑的 serve,不像 `pkill -f` 那样误杀同机其它 agent 的 serve。
  if (flags.stop === true) {
    return stopOwnInstance("serve", server, auth.token, channel, (line) => console.error(line));
  }
  if ((cmd ? 1 : 0) + (runner ? 1 : 0) !== 1) {
    console.error(
      'choose exactly one of --on-mention or --runner.\n' +
        '  自定义：--on-mention "<command>"（每次 fresh process；owner 回答以同 work/ref + context JSON 再次调用；脚本须幂等）。\n' +
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
  const autoDownloadUpgrade = flags["auto-upgrade"] === true;
  const availableUpgrade = await resolveAvailableUpgrade(server, null, {
    autoDownload: autoDownloadUpgrade,
    out: (line) => console.error(terminalOutput(line)),
  });
  if (availableUpgrade !== null) console.error(terminalOutput(`serve: ${availableUpgrade.message}\n  ${availableUpgrade.command}`));
  const explicitRunnerWorkdir = str(flags.workdir);
  let runnerWorkdirPath = explicitRunnerWorkdir === undefined
    ? null
    : expandHomePath(explicitRunnerWorkdir);
  const identityState: ServeIdentityBoundaryState = {
    expectedPrincipal: null,
    rejectedAccountToken: null,
  };
  try {
    const initialBoundary = await verifyServeIdentityBoundary(server, auth, identityState);
    if (!initialBoundary.ok) {
      console.error(terminalOutput(initialBoundary.reason));
      return initialBoundary.code;
    }
    if (runnerWorkdirPath === null) {
      runnerWorkdirPath = defaultRunnerWorkdir(channel, initialBoundary.namespace);
    }
  } catch {
    // A transient startup outage should not prevent the WS supervisor from doing its own retry.
    // The first successful /api/me below establishes the immutable identity boundary.
  }
  let firstAttach = true;
  const lifecycle = (line: string) => {
    const record = `${new Date().toISOString()} ${line}`;
    if (runnerWorkdirPath !== null) appendServeLifecycleLog(runnerWorkdirPath, record);
    console.error(terminalOutput(`serve supervisor: ${line}`));
  };
  const superviseExit = await superviseServe({
    onLifecycle: lifecycle,
    runOnce: async () => {
      // 每次自愈都重读本地凭据与 OIDC 状态，避免用启动时快照把一次可恢复的 token
      // 刷新变成永久离线。终局 auth/archived 仍由 isTerminalServeExit 停止。
      const currentAuth = await resolveAuthDetailed();
      if (!currentAuth.server || !currentAuth.token) return EXIT_AUTH;
      const currentServer = currentAuth.server;
      const currentToken = currentAuth.token;
      // Cursor, stuck debt and model session are scoped to the original server+principal.  Token
      // rotation is safe only inside that boundary; config switching must start a new serve process.
      const boundary = await verifyServeIdentityBoundary(server, currentAuth, identityState);
      if (!boundary.ok) {
        console.error(terminalOutput(`${boundary.reason}; exiting`));
        return boundary.code;
      }
      const currentRunnerWorkdir = runnerWorkdirPath ?? defaultRunnerWorkdir(channel, boundary.namespace);
      runnerWorkdirPath = currentRunnerWorkdir;
      const skipBacklogThisAttach = firstAttach ? flags["replay-backlog"] !== true : false;
      const result = await runServe({
        server: currentServer,
        token: currentToken,
        channel,
        since: loadCursor(channel),
        stuck: loadStuck(channel),
        onStuck: (st) => (st === null ? clearStuck(channel) : saveStuck(channel, st)),
        sinceRev: loadRevCursor(channel),
        cmd: cmd ?? "",
        mentionsOnly: flags.all !== true,
        // Only the process's first attachment applies the user's backlog policy.  Internal recovery
        // always resumes from the durable cursor, so mentions received during the restart gap survive.
        skipBacklog: skipBacklogThisAttach,
        onWelcome: () => { firstAttach = false; },
        onCursor: (c) => saveCursor(channel, c),
        onRevCursor: (r) => saveRevCursor(channel, r),
        advertise: (signal) => advertiseServeWake(currentAuth, channel, signal),
        fetchCharter: (signal) => fetchChannelCharter(currentServer, currentToken, channel, signal),
        autoUpgrade: flags["auto-upgrade"] === true,
        availableUpgrade,
        refreshAvailableUpgrade: (current) => resolveAvailableUpgrade(currentServer, current, {
          autoDownload: flags["auto-upgrade"] === true,
          out: (line) => console.error(terminalOutput(line)),
        }),
        statusline: true,
        runnerTimeoutMs,
        builtinRunner: harness
          ? {
              server: currentServer,
              token: currentToken,
              channel,
              harness,
              workdir: currentRunnerWorkdir,
              repo: str(flags.repo),
            }
          : undefined,
        sdkRunner: useSdkRunner
          ? {
              server: currentServer,
              token: currentToken,
              channel,
              workdir: currentRunnerWorkdir,
            }
          : undefined,
      });
      if (result === EXIT_AUTH && currentAuth.auth_source === "account_session") {
        identityState.rejectedAccountToken = currentToken;
        return EXIT_STREAM_ENDED;
      }
      return result;
    },
  });
  // #744:终局不该重启的退出(熔断/撤销)在 launchd 常驻下自卸载,别让 KeepAlive 绕过安全停机/空转。
  selfBootoutTerminalDuty(superviseExit, (line) => console.error(terminalOutput(`serve supervisor: ${line}`)));
  return superviseExit;
}
