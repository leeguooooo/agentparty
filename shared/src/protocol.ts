// agentparty wire protocol — worker 与 cli 的单一事实来源

import {
  extractMentionTokens as extractMentionSpans,
  mentionMatchKey as mentionKey,
} from "./mentions";

export { mentionMatchKey } from "./mentions";

// ---- 常量 ----

export const BODY_LIMIT = 100_000;
export const CHARTER_LIMIT = 16_000;
export const RATE_LIMIT_PER_MIN = 30;
export const LOOP_GUARD_N = 30;
export const LOOP_GUARD_AGENT_N = 15;
// party 模式（spec §3）：多 agent 头脑风暴/分工频道，loop guard 放宽
export const LOOP_GUARD_PARTY_N = 200;
export const LOOP_GUARD_AGENT_PARTY_N = 50;
export const RETAIN_N = 10_000;
// 幂等键最大长度（#98）：ULID 是 26 字符，留足余量到 128 防滥用把 key 当附加 payload。
export const IDEMPOTENCY_KEY_MAX = 128;
// 幂等去重窗口（#98）：只在最近这段时间内的同键消息上去重。10 分钟足以覆盖
// 客户端 30s 超时 + 重试 + 服务端 fetchChannelDO 的 DO-reset 重发，并留足时钟偏移余量；
// 越界后同一 key 可被安全重用（实践中客户端每次发送都生成新 ULID，不会重用）。
// 另有 RETAIN_N 条消息保留上限做二次兜底：更老的消息连同其 key 一起被裁剪。
export const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;
export const PRESENCE_TIMEOUT_MS = 60_000;
// temp 频道最后一条消息后闲置多久自动归档（spec §6）
export const TEMP_IDLE_ARCHIVE_MS = 14 * 24 * 60 * 60 * 1000;
// outbound webhook（spec §15）：短超时 + 1/4/16 分钟退避重试
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RETRIES = 3;
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 240_000, 960_000] as const;
export const MAX_WEBHOOKS_PER_CHANNEL = 20;
export const ROLE_RESPONSIBILITY_LIMIT = 500;
// 保留名：不得铸成真实 token。"system" 是 webhook 失败通告的发信名，dispatchWebhooks 靠它跳过投递；
// 若被铸成真实 token，其消息（含被 @）会静默永不触发 webhook。
export const RESERVED_NAMES: readonly string[] = ["system"];
export const MAX_MENTIONS = 50;

// Keep the root export used by older CLI callers, but delegate lexical rules to
// the rich shared lexer so worker/web/CLI agree on URL, email, npm and code spans.
export function extractMentionTokens(text: string, limit: number = MAX_MENTIONS): string[] {
  if (limit <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of extractMentionSpans(text)) {
    // This compatibility API has no known-alias directory. Preserve the established
    // ASCII-first contract so `@agent-a看一下` yields `agent-a`; Unicode-first aliases
    // still keep their full token and are resolved authoritatively by the server.
    const asciiPrefix = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/.exec(token.value)?.[0];
    const value = asciiPrefix ?? [...token.value].slice(0, 64).join("");
    const key = mentionKey(value);
    if (key === "system" || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}
export const MAX_WEBHOOK_QUEUE_ROWS = 200;
export const WEBHOOK_RETRY_BATCH_SIZE = 25;
// 死信保留上限（#105）：重试耗尽 / 队列满而被永久放弃的投递不再静默丢弃，落死信表待人重投。
// 有界裁剪（只留最新 N 条）避免坏端点把 DO 存储写爆。
export const MAX_WEBHOOK_DEAD_LETTERS = 200;
// 单次 redeliver 最多重投多少条死信，避免一个端点的巨量积压一次性打满 subrequest 配额。
export const WEBHOOK_REDELIVER_BATCH_SIZE = 50;

// ---- 每账号频道配额 + 创建限速 + 每频道连接上限（#137 成本模型与滥用防护）----
// 每个频道背后是一个 Durable Object + 一行 D1；此前 POST /api/channels 无任何配额，
// 任一带账号的 ap_ token 持有者可无限造 DO/D1 行（面向跨公司外部 agent 发 token 的产品，
// 这是真实账单攻击面）。下面给「拥有该频道的账号」两道闸：owned 总量硬上限 + 滚动窗口创建限速。
// 缺省对单团队足够宽松（正常协作不可能撞上），只挡量级异常的滥用。legacy 无账号 token 不受限（fail-open）。
export const MAX_CHANNELS_PER_ACCOUNT = 100; // 单账号可拥有（owner_account）的频道总数上限（含归档，堵 create→archive→create 绕过）
export const CHANNEL_CREATE_WINDOW_MS = 60 * 60_000; // 创建限速滚动窗口：1 小时
export const MAX_CHANNEL_CREATES_PER_WINDOW = 20; // 单账号每窗口最多新建频道数
// 每频道并发 WS 连接上限：DO 无上限时单频道可被灌爆连接（每连接吃内存 + presence 扇出）。
// 缺省 200 远超任何真实多公司 party 的在场规模；worker env 可覆盖以便运维调参 / 测试用小值。
export const MAX_CONNECTIONS_PER_CHANNEL = 200;

// ---- per-agent wake 预算/配额（#108）----
// 每个 @ 触发一次完整 runner run，会烧目标 agent 的 LLM 订阅/tokens；协议此前无任何总量上限
// （README 宣称的「capacity routing」无落地）。这里给每个 agent 一个滚动窗口内的 wake 硬上限：
// 窗口内已投 wake 数达到 limit 后，再来的 @ 不再投 webhook（不烧订阅），落 wake_delivery_ledger
// 的 budget 行 + 频道内 system status 可观测。缺省不设 = 不限（正常流，零影响）。
export const WAKE_BUDGET_DEFAULT_WINDOW_MS = 60 * 60_000; // 未显式指定窗口时默认 1 小时
export const WAKE_BUDGET_MIN_WINDOW_MS = 1_000; // 窗口下限 1s，防除零/病态极短窗口
export const WAKE_BUDGET_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 窗口上限 30 天
export const WAKE_BUDGET_MAX_LIMIT = 100_000; // limit 硬上限，防把预算当计数器滥用

// ---- DO 存储有界修剪（#128）----
// wake_delivery_ledger / message_audit / read_cursor 此前只增不减，DO SQLite 无上限增长，
// 10GB DO 上限前先拖慢 who/hello。三张表各按「消费者仍需的窗口」定界，onAlarm 周期修剪，热路径零成本。
//
// wake_delivery_ledger：预算计数（wakeCountInWindow）按滚动时间窗，窗口上限 WAKE_BUDGET_MAX_WINDOW_MS(30d)。
// 保留窗口必须【严格大于】预算窗口上限，否则修剪会砍掉预算仍要数的行 → 少计 → 预算漏（#108）。留 5 天
// 时钟偏移/观测余量；#105 死信与 #107 resume 回填（按 mention_seq 事后补 ack/resume）都只关心近期行，35 天足够。
export const WAKE_LEDGER_RETENTION_MS = WAKE_BUDGET_MAX_WINDOW_MS + 5 * 24 * 60 * 60 * 1000; // 35 天
// message_audit：按行数封顶保留最新 N 行（镜像 MAX_WEBHOOK_DEAD_LETTERS 的裁剪手法）。审计 API 只按
// target_seq 查近期消息 → 近期消息对应高 id 行永不被裁；#196 撤回清洗已把撤回/编辑行正文置 NULL，
// 裁掉旧整行不泄露内容，与「按 target_seq 置空」的清洗语义正交。取 2× 消息保留量（RETAIN_N=10000），
// 给活跃消息留足多次修订的审计余量。
export const MAX_MESSAGE_AUDIT_ROWS = 20_000;
// read_cursor：PK=name，每身份仅一行（其当前游标），无重复行可裁。只裁「长期未推进且此刻未连接」的
// 陈旧游标，绝不动在线身份（含刚 caught-up 未再推进）的活游标。断连超此窗仍未回来的身份，其读位对应的
// 消息多半已过 RETAIN_N 被裁，游标失去意义；它再上线时 recordSeen 会重新建游标，无副作用。
export const READ_CURSOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

// ---- 定向消息可恢复投递（#551）----
// serve 每 25s ping/每 15s task heartbeat；90s 足够跨两三个心跳抖动，又能在进程/机器死亡后尽快交给 standby。
export const DIRECTED_DELIVERY_LEASE_MS = 90_000;
export const DELIVERY_WORK_ID_LIMIT = 128;
export const DELIVERY_CONTINUATION_REF_LIMIT = 512;
export const DELIVERY_ORIGIN_CHANNEL_LIMIT = 256;

// ---- 会员分层（#277 骨架）----
// 账号维度的 free/member 层：托管部署每月要成本，会员用于回收；自部署始终免费。
// 本次只搭骨架——建库、开通路径、isMember 钩子；不定价、不接支付、不 gate 任何功能。
export type MembershipTier = "free" | "member";

export interface MembershipStatus {
  tier: MembershipTier;
  /** 开通为 member 的时刻（epoch ms）；free 或从未开通为 null。 */
  member_since: number | null;
}

/** 无会员记录的账号（含自部署、未申请者）一律回落到此。 */
export const DEFAULT_MEMBERSHIP: MembershipStatus = { tier: "free", member_since: null };

/**
 * 把任意来源的 tier 值收敛成合法枚举。只有精确的 "member" 才算会员，其余（含 null/垃圾值）都 free——
 * 少一个未知字符串意外解锁付费能力的路子。
 */
export function normalizeTier(tier: unknown): MembershipTier {
  return tier === "member" ? "member" : "free";
}

/**
 * feature-gating 的唯一钩子：将来「免费 vs 会员」功能清单都只通过它判定，别处别再各自比字符串。
 * 传入 /api/me 或 account_membership 行（或 null=无记录）。
 */
export function isMember(status: { tier?: string | null } | null | undefined): boolean {
  return normalizeTier(status?.tier) === "member";
}

// ---- 会员分层真门槛（#277）----
// 官方托管部署每月有成本，免费层设低配额、会员解锁到平台原有高上限。
// 自部署默认不启用门槛；只有显式 HOSTED_MEMBERSHIP_GATING=true 才应用以下 free 配额。
// 频道配额：free 账号硬上限；member 沿用 MAX_CHANNELS_PER_ACCOUNT（原高上限，不变）。
export const FREE_CHANNEL_CAP = 20;
// 附件体积：free 账号上限；member 沿用原 25 MiB（#176 引入时的默认值，不变）。
export const FREE_ATTACHMENT_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MiB
export const MEMBER_ATTACHMENT_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MiB

// cli 退出码
export const EXIT_TIMEOUT = 2;
export const EXIT_AUTH = 3;
export const EXIT_LOOP_GUARD = 4;
export const EXIT_ARCHIVED = 5;
// watch --follow 的帧流意外中断（连接层彻底放弃/queue 结束但非超时、非终局 error）。
// 静默 return 0 会让 supervisor 误判为正常收尾（issue #29：pid 消失、日志 0 字节、无错误），
// 故单列一个非零码，让外层 supervisor 能看到失败并重启。
export const EXIT_STREAM_ENDED = 6;
// serve --auto-upgrade 在唤醒间隙发现磁盘上有更新的 party 二进制、已 re-exec 新版并让本进程退出
// （issue #45）。launchctl KeepAlive 场景无所谓；供包装脚本区分「正常升级退出」与异常。
export const EXIT_UPGRADED = 7;
// workflow guard 熔断（issue #122）：同一 workflow 连发 N 条消息无进展，服务端拒收。
// 与 loop guard 同类语义——**停手，别换个措辞重试**。之前它塌缩成通用 exit 1，
// agent 拿到 1 会当成普通失败、换个说法再发，绕着熔断打转、把额度耗光。
export const EXIT_WORKFLOW_GUARD = 8;
// 速率限制（429，issue #122）：退避后再试，别立刻连打。
// 之前同样塌缩成 exit 1，agent 无从判断该等还是该停。
export const EXIT_RATE_LIMITED = 9;

// ---- 基础类型 ----

export type SenderKind = "agent" | "human";
export type TokenRole = "agent" | "human" | "readonly";
export type ChannelKind = "standing" | "temp";
export type ChannelMode = "normal" | "party";
export type MessageKind = "message" | "status";
export type WebhookFilter = "mentions" | "status" | "needs-human" | "all";
export type CaptureKind = "decision" | "requirement" | "bug" | "action-item";
export type TaskState = "triage" | "backlog" | "assigned" | "in_progress" | "needs_review" | "done" | "blocked";
export type TaskAssigneeKind = "agent" | "human" | "squad";

export type StatusState = "working" | "waiting" | "blocked" | "done";
export type PresenceState = StatusState | "offline";
export type CollaborationRole = "host" | "worker" | "reviewer" | "observer";
export type CollaborationRoleSource = "self" | "assigned";
export type Residency = "supervised" | "webhook" | "bare" | "human_driven" | "unknown";
export type WakeKind = "none" | "watch" | "serve" | "webhook";
export type HostDecisionKind = "decision" | "handoff" | "takeover";
export type WorkflowKind = "pipeline" | "parallel" | "orchestrator-workers" | "evaluator-optimizer";
export type HostLeaseState = "active" | "stale";
export type CompletionGate = "off" | "reviewer";
export type CompletionReviewState = "pending_review" | "approved" | "rejected";
export type CompletionReviewPolicy = "sender" | "owner";
// 频道人类决策协议（#284）。approval：decision_request 挂起等人类回应；
// unattended（无人值守）：服务端在落库时立即自动放行（auto_resolved），agent 不必等人。
export type DecisionMode = "approval" | "unattended";
// approval：选项固定为 approve/reject；choice：agent 自带 1..N 个自定义选项。
export type DecisionKind = "approval" | "choice";
// pending：等人类；resolved：人类已选；auto_resolved：无人值守模式自动放行。
export type DecisionState = "pending" | "resolved" | "auto_resolved";
export type DirectedDeliveryState = "queued" | "claimed" | "running" | "waiting_owner" | "replied" | "failed";
export type DirectedDeliveryCause = "mention" | "mention_edit" | "reply" | "owner_answer" | "retry";
// decision_request 上限（#284）：与 completion review 同量级，防把 prompt/选项当附加 payload 滥用。
export const DECISION_PROMPT_LIMIT = 4_000;
export const DECISION_OPTIONS_MAX = 10;
export const DECISION_OPTION_LIMIT = 200;
export const DECISION_REASON_LIMIT = 2_000;
/** Maximum UTF-8 bytes in an account principal bound to an owner-only decision request. */
export const DECISION_RESPONDER_OWNER_LIMIT = 128;

export interface WakeInfo {
  kind: WakeKind;
  verified_at?: number;
}

export interface HostDecision {
  kind: HostDecisionKind;
  owner: string;
  decision: string;
  next: string | null;
  expires_at: number | null;
  handoff_to?: string;
  takeover_from?: string;
}

export interface SendHostDecision {
  kind?: HostDecisionKind;
  decision: string;
  next?: string | null;
  expires_at?: number | null;
  handoff_to?: string | null;
  takeover_from?: string | null;
}

export interface StatusWorkflow {
  workflow_id: string;
  kind: WorkflowKind;
  run_id: string | null;
  step_id: string | null;
  parent_summary_seq: number | null;
}

export interface SendStatusWorkflow {
  workflow_id: string;
  kind: WorkflowKind;
  run_id?: string | null;
  step_id?: string | null;
  parent_summary_seq?: number | null;
}

export type ConfigSourceKind = "explicit" | "workspace" | "global" | "none";

export interface AgentContext {
  config_kind?: ConfigSourceKind;
  config_fingerprint?: string;
  workspace_id?: string;
  workspace_label?: string;
  worktree_label?: string;
}

export interface WakeDelivery {
  mention_seq: number;
  target_name: string;
  webhook_name: string;
  adapter_kind: WakeKind;
  attempt: number;
  // #107：webhook 唤醒 ok/failed；serve/watch 拉模型广播即 broadcast、agent resume 引用后升 consumed。
  result: "ok" | "failed" | "broadcast" | "consumed";
  http_status: number | null;
  error: string | null;
  attempted_at: number;
  ack_seq: number | null;
  resume_seq: number | null;
}

export interface CaptureRecord {
  type: "capture";
  channel: string;
  seq: number;
  capture_kind: CaptureKind;
  note: string | null;
  created_by: string;
  created_by_kind: SenderKind;
  created_at: number;
  message: {
    seq: number;
    sender: Sender;
    kind: MessageKind;
    body: string;
    ts: number;
  };
}

export interface TaskRecord {
  type: "task";
  id: number;
  channel: string;
  title: string;
  desc: string | null;
  state: TaskState;
  assignee: { name: string; kind: TaskAssigneeKind } | null;
  created_by: string;
  created_by_kind: SenderKind;
  created_by_owner?: string;
  priority: number;
  labels: string[];
  parent_id: number | null;
  anchor_seqs: number[];
  /** 该任务声明占用的代码/文档作用域（#204）；conflicts 判定与派生 claim 的 scope 都来自这里 */
  scope: string[];
  /** state=blocked 时的结构化阻塞原因（#204）；其他状态为 null */
  blocked_reason: string | null;
  /** 外部系统引用键（如 gh:owner/repo#96），供 issue→task 同步做幂等 create（#141）；未提供为 null */
  external_ref: string | null;
  /** 附件引用（#369，#271 遗留）；空/缺省视为无附件。R2 上传流程与消息一致，见 Attachment。上限 MAX_ATTACHMENTS。 */
  attachments?: Attachment[];
  /** 任务的唯一交付方案（#464）；走频道鉴权附件端点，频道成员可见，缺省表示尚未提交。 */
  solution?: Attachment;
  completion_artifact: unknown | null;
  workflow_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface TaskSummary {
  type: "task_summary";
  channel: string;
  total: number;
  open: number;
  triage: number;
  backlog: number;
  assigned: number;
  in_progress: number;
  needs_review: number;
  blocked: number;
  done: number;
  mine: number;
}

export interface ChannelSquad {
  type: "squad";
  channel: string;
  name: string;
  title: string | null;
  description: string | null;
  leader: string | null;
  members: string[];
  created_by: string;
  created_by_kind: SenderKind;
  created_at: number;
  updated_at: number;
}

export interface AgentLineage {
  parent_agent: string;
  root_agent: string;
  team_id: string;
  depth: number;
  expires_at: number | null;
}

export interface SearchHit {
  type: "search_hit";
  channel: string;
  query: string;
  seq: number;
  sender: Sender;
  kind: MessageKind;
  match_field: "body" | "note" | "sender";
  snippet: string;
  ts: number;
}

export type ErrorCode =
  | "bad_request"
  | "unavailable"
  | "mention_not_found"
  | "mention_ambiguous"
  | "unauthorized"
  | "rate_limited"
  | "too_large"
  | "loop_guard"
  | "workflow_guard"
  | "archived"
  | "quota_exceeded"
  | "channel_full"
  | "not_found";

export type RestErrorCode =
  | ErrorCode
  | "conflict"
  | "unavailable"
  | "forbidden"
  | "lark_contact_permission_required"
  | "invite_required";

export interface Sender {
  name: string;
  kind: SenderKind;
  /** 所属人：机器 ap_ token 铸造时写入的标签，人类 OIDC token 为其 email。无则省略（旧客户端忽略） */
  owner?: string;
  lineage?: AgentLineage;
  /** 全局唯一昵称（可@别名）。人类=account handle，agent=自设 nickname（#165）；已设置才下发，未设置省略。旧客户端忽略。 */
  handle?: string;
  /** OAuth/SSO profile display name. Optional; clients fall back to handle/owner/name. */
  display_name?: string;
  /** OAuth/SSO profile avatar URL. Optional; clients may render initials when absent. */
  avatar_url?: string;
  avatar_thumb?: string;
  /** 发送这条消息时 sender 的 CLI package version（发送即快照，随消息帧下发；#434）。
   *  仅带 x-ap-client-version 的 CLI 发送才有；网页/旧客户端/无头请求缺失时省略。旧消费方忽略。 */
  client_version?: string;
  /** 同一身份当前活跃连接数。仅 >1 时下发，用于提示 token/session 被重复使用。 */
  connection_count?: number;
}

/**
 * Agent 自报的可恢复模型会话（issue #522）。它是 runner 的 Codex/Claude 会话句柄，
 * 不是 AgentParty websocket/登录 session。频道 ACL 保护 presence；旧客户端忽略该字段。
 */
export interface AgentSessionInfo {
  harness: "codex" | "claude" | "codex-sdk";
  session_id: string;
  updated_at: number;
  /** 模型进程实际运行目录；恢复时应回到同一目录，避免 resume 到错误项目。 */
  cwd?: string;
  /** 持久化 wake-session.json / 隔离 CODEX_HOME 的 runner 目录。 */
  workdir?: string;
}

export interface PresenceEntry {
  name: string;
  /** 最近一次有效 CLI hello 上报的 package version；旧客户端或非 CLI 客户端缺失时省略。 */
  client_version?: string;
  // agent / human。@ 补全等需要区分「可 @ 的 agent」和「只是围观的人类会话」。
  // 旧 worker 响应缺此字段 → undefined，消费方按未知处理（不当人类排除）。
  kind?: SenderKind;
  // 会话背后的账号（人类 = OIDC email）。人类网页会话的 name 是 UUID token 名，靠这个显示「是谁」。
  // 旧 worker 缺此字段 → undefined，前端回退到 name。
  account?: string;
  state: PresenceState;
  note: string | null;
  ts: number;
  last_seen?: number;
  status?: StatusEvent;
  role?: CollaborationRole;
  role_source?: CollaborationRoleSource;
  residency?: Residency;
  wake?: WakeInfo;
  context?: AgentContext;
  lineage?: AgentLineage;
  /** 全局唯一昵称（可@别名）。人类=account handle，agent=自设 nickname（#165）；已设置才下发，未设置省略。旧客户端忽略。 */
  handle?: string;
  /** OAuth/SSO profile display name. Optional; clients fall back to handle/account/name. */
  display_name?: string;
  /** OAuth/SSO profile avatar URL. Optional; clients may render initials when absent. */
  avatar_url?: string;
  avatar_thumb?: string;
  /** 同一身份当前活跃连接数。仅 >1 时下发，用于提示 token/session 被重复使用。 */
  connection_count?: number;
  /**
   * 人为「暂停接待」（issue #180）。true 时该 agent 被 @ 也不唤醒（webhook 不投、serve/watch 不触发），
   * 但消息照进频道历史。仅暂停时下发；旧客户端忽略。恢复靠手动或 resume_at 到点由 DO alarm 自动清除。
   */
  paused?: boolean;
  /** 定时恢复接待的时刻（epoch ms）。仅在暂停且指定了恢复时间时下发；缺省即只能手动恢复。 */
  resume_at?: number;
  /**
   * 序列化时该 name 是否持有活 WS 连接（issue #97）。DO 从 getConnections 权威判定，仅 true 时下发；
   * 旧客户端忽略。用途仅限「可达性/新鲜度」——live 视同新鲜（短路 wakeReachable 的 staleMs 判定）、
   * 视同在线。**不参与 host 租约判定**：evaluateHostLease/summarizeHosts 仍只看 last_seen，failover 触发
   * 条件保持「多久没干活」而非「TCP 有没有断」（一个卡在无超时 await 上的 serve socket 照样是活的）。
   */
  live?: boolean;
  /**
   * serve 正串行处理一条 wake、无法即时响应新 @（issue #103）。DO 从最近一条 status 帧的 busy 写入，
   * 仅 state != offline 且 busy 时下发；旧客户端忽略。用途：who/reach/web 显示「忙」，让同事把 ask 超时
   * 当作「忙、稍后回」而非「失联」，别反复 @ 堆重复唤醒。**不参与可达性/租约判定**——忙 ≠ 不可达。
   */
  busy?: boolean;
  /** 排在当前 wake 身后、尚未处理的 wake 数（issue #103）。仅 state != offline 且 >0 时下发。 */
  queue_depth?: number;
  /**
   * 已经把 agent runner 释放、正在等 owner 回答的 work 数（issue #548）。它来自服务端持久
   * directed delivery 状态，不是客户端自报；仅 >0 时下发。与 queue_depth 分开，避免把“等人”
   * 误显示成“agent 忙不过来”。旧客户端忽略。
   */
  waiting_owner_count?: number;
  /**
   * 同名多机 serve 里，除持租者外仍挂着、处于 standby 的 serve 连接数（issue #99）。DO 从活连接里的
   * serve 租约候选权威判定：候选数 N ≥ 2 时下发 N-1（有几台在待命顶替），否则省略。用途：who / web
   * 一眼看出「这个 name 有重复 serve，但只有 1 台在真正跑 runner」——把过去只能靠 connection_count x2
   * 猜测的重复执行风险，明确成「已被租约互斥、其余在 standby」。旧客户端忽略。
   */
  serve_standbys?: number;
  /**
   * 当前正在处理的那条 wake 的触发 seq（reply_to / @ 的 seq）（issue #228，扩 #103 busy）。
   * serve 处理一条长任务期间用轻量、presence-only 的 heartbeat 帧刷这三个字段：正在处理哪条、何时开始、
   * 最近一次心跳。用途：who/web 区分「还在干、活到 T」与「卡死」——busy 只说「在忙」，这里说「在忙哪一条、活没活」。
   * 仅 state != offline 且有活跃任务时下发；任务结束由 heartbeat(current_task=null) 清除。旧客户端忽略。
   */
  current_task?: number;
  /** 当前任务的 run() 开始时刻（epoch ms）（issue #228）。与 current_task 同生共死。 */
  task_started_at?: number;
  /**
   * 最近一次心跳时刻（epoch ms）（issue #228）。serve 周期性推进它；消费方据 now-heartbeat_at 判新鲜度：
   * 心跳还在推进 = 活着，长时间不动 = 卡死。不参与可达性/租约判定。
   */
  heartbeat_at?: number;
  /**
   * 模型 session 内的细粒度活动（issue #602）：正在跑哪个工具、是否卡在权限确认、是否在 compact。
   * 由 Claude Code hooks 落盘、serve 的任务心跳帧捎带上行；与 current_task 同生共死（任务结束即清），
   * 仅 state != offline 且有活跃任务时下发。旧客户端忽略。
   */
  activity?: AgentActivity;
  /**
   * runner 健康自报（issue #603）：serve runner 连败中（“在线但干不动”）。仅 state != offline 且
   * 有连败（consecutive_failures ≥ 1）时下发；恢复由后续心跳缺省即清。旧客户端忽略。
   */
  runner_health?: RunnerHealth;
  /**
   * 服务端派生的监听力判定（issue #603）：directed delivery 租约对活连接过期 → suspect，
   * 连续 ≥2 次 → deaf（“在线但没在听”）。仅有活 WS 连接且存在负面信号时下发；缺省 = 无恙。
   * 目标任何一次确认 delivery 更新即清零。旧客户端忽略。
   */
  listening?: ListeningVerdict;
  /** Agent 自报并由频道持久化的模型会话句柄；供重启后精确 resume（issue #522）。 */
  agent_session?: AgentSessionInfo;
}

// 模型 session 活动阶段（issue #602）。busy/current_task 只说「在忙哪条」，activity 说「具体在干什么」：
// waiting_permission 是无人值守最致命的静默挂法（headless 权限确认没人点），必须让频道看得见。
export const AGENT_ACTIVITY_PHASES = [
  "starting", // SessionStart：session 刚起
  "working", // 模型在推理/工具间隙（UserPromptSubmit/PostToolUse）
  "tool", // PreToolUse：正在跑某个工具（tool 字段带工具名）
  "waiting_permission", // Notification 权限请求：卡在权限确认
  "waiting_input", // Notification 等输入：交互式 session 空闲等人
  "compacting", // PreCompact：正在压缩上下文
  "idle", // Stop/SessionEnd：turn 结束
] as const;
export type AgentActivityPhase = (typeof AGENT_ACTIVITY_PHASES)[number];

export interface AgentActivity {
  phase: AgentActivityPhase;
  /** 仅 phase=tool / waiting_permission 时可带：工具名（绝不带入参正文，防 secret 泄漏）。 */
  tool?: string;
  /** 该活动的发生时刻（epoch ms）；消费方据 now-ts 判新鲜度。 */
  ts: number;
}

// runner 健康自报（issue #603）：serve 的 runner 连败（spawn 失败/硬超时/放弃）时，频道视角是
// 「@ 了没人应」而 presence 全绿——熔断（MAX_CONSECUTIVE_WAKE_ABANDONS）退出前那段窗口完全不可见。
// serve 把连败计数与最后错误随心跳帧自报；单次失败有重试兜底不算不健康（ok 在 ≥2 连败才翻 false）。
export interface RunnerHealth {
  ok: boolean;
  consecutive_failures: number;
  /** 最后一次失败的截断摘要（≤160 字符，已过 serve 侧脱敏）。 */
  last_error?: string;
}

export function parseRunnerHealth(input: unknown): RunnerHealth | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.ok !== "boolean") return undefined;
  if (
    typeof value.consecutive_failures !== "number" ||
    !Number.isInteger(value.consecutive_failures) ||
    value.consecutive_failures < 0 ||
    value.consecutive_failures > 1_000_000
  ) return undefined;
  // last_error 会被 who/wake 直接拼进终端输出：与 activity.tool 同口径剥 ESC/C0/C1，防转义序列注入。
  const cleanedError =
    typeof value.last_error === "string"
      ? // eslint-disable-next-line no-control-regex
        value.last_error.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 160)
      : "";
  const lastError = cleanedError.length > 0 ? cleanedError : undefined;
  return {
    ok: value.ok,
    consecutive_failures: value.consecutive_failures,
    ...(lastError === undefined ? {} : { last_error: lastError }),
  };
}

// 监听力判定（issue #603）：live 只证明 TCP+握手活着；这里由服务端从 directed delivery 租约
// 状态机派生「投喂了吃不吃」——租约对活连接过期一次 = suspect，连续 ≥2 次 = deaf。
// 任何一次被目标确认的 delivery 更新（running/waiting_owner/replied/failed 都证明它在听）即清零。
export type ListeningVerdict = "suspect" | "deaf";

// activity 校验的统一口径：CLI 读 hook 落盘文件、DO 收 heartbeat 帧共用。
// 脏值返回 undefined（调用方各自决定丢字段还是丢整帧）。tool 名截断到 64 字符——只是展示用途；
// 剥掉 ESC/C0/C1 控制字符（tool 名来自远端，会被直接渲染进终端，不给转义序列注入留门）。
export function parseAgentActivity(input: unknown): AgentActivity | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = input as Record<string, unknown>;
  if (!AGENT_ACTIVITY_PHASES.includes(value.phase as AgentActivityPhase)) return undefined;
  if (typeof value.ts !== "number" || !Number.isSafeInteger(value.ts) || value.ts < 0) return undefined;
  // tool 只在 tool / waiting_permission 阶段有意义（见 AgentActivity 注释）；其余阶段丢字段留活动，兼容旧客户端。
  const allowsTool = value.phase === "tool" || value.phase === "waiting_permission";
  const tool =
    allowsTool && typeof value.tool === "string" && value.tool.length > 0
      ? // eslint-disable-next-line no-control-regex
        value.tool.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 64)
      : undefined;
  return {
    phase: value.phase as AgentActivityPhase,
    ...(tool === undefined || tool === "" ? {} : { tool }),
    ts: value.ts,
  };
}

export interface ChannelRoleAssignment {
  name: string;
  role: CollaborationRole;
  responsibility: string | null;
  assigned_by: string;
  assigned_at: number;
  kind?: SenderKind;
  account?: string;
  display?: string;
  /** 管理层级（#370）：本 agent 向哪个 agent 汇报，构成组织树。可跨 owner；null/缺省=顶层。 */
  reports_to?: string | null;
}

export interface HostLeaseEvaluation {
  lease: HostLeaseState;
  reason: string | null;
  last_seen: number | null;
  residency: Residency | "unknown";
  wake_kind: WakeKind | "unknown";
}

export function presenceLastSeen(entry: Pick<PresenceEntry, "last_seen" | "ts">): number | null {
  return entry.last_seen ?? entry.ts ?? null;
}

// 可唤醒判定的统一口径（issue #47），cli `party who` / `send --reach` 与 web mention 候选共用：
// serve/watch 靠本地常驻 supervisor 持 WS，presence 不新鲜（supervisor 大概率已死）就叫不醒；
// webhook 由服务端投递，agent 离线也真能被唤醒，不受新鲜度限制（幽灵清理由调用方另行处理）。
// live（issue #97）：DO 权威判定「当前有活 WS 连接」时视同新鲜——WS 还连着本身就是 supervisor 存活的
// 最强证据，短路 staleMs 判定，让健康但安静的 serve/watch 不被误判叫不醒。webhook 恒 true、不受影响。
export function wakeReachable(
  kind: WakeKind | undefined,
  ageMs: number,
  staleMs = PRESENCE_TIMEOUT_MS,
  live = false,
): boolean {
  if (kind === "webhook") return true;
  return (kind === "serve" || kind === "watch") && (live || ageMs < staleMs);
}

// issue #97：presence 的新鲜度不变量没人维护。presence.updated_at 只由 status 帧和 markOffline 写，
// 活着但安静的 WS 连接不回写；于是一个健康的 serve/watch 挂着、频道静默 61s，就被 wakeReachable 误判
// 「supervisor 已死、叫不醒」，断线重连后又钉死在 offline。但 DO 权威地知道谁有活连接（getConnections）。
// 读侧修正：序列化 presence 时，若某 name 当前有活 WS 连接，就打上 live=true——可达性/新鲜度判定视同新鲜。
// 关键：**不改写 ts/last_seen**（那会连带把 host 租约变成「socket 在就永不过期」，废掉 failover——见 live
// 字段注释），只加一个独立信号让 wakeReachable/在线判定短路。同时把陈旧的 offline 提升为 waiting（连着但还
// 没自报 = 待命可唤醒，不是在忙，所以不碰 working/waiting/blocked/done 这些已自报的工作态，只解 offline 死锁）。
// 无活连接的行原样返回（引用不变），离线/租约判定完全不变。
export function applyLiveConnection(entry: PresenceEntry, hasLiveConnection: boolean): PresenceEntry {
  if (!hasLiveConnection) return entry;
  const next: PresenceEntry = { ...entry, live: true };
  if (next.state === "offline") next.state = "waiting";
  return next;
}

export function autoWakeReachable(
  entry: Pick<PresenceEntry, "wake" | "last_seen" | "ts" | "residency" | "live">,
  now: number,
  staleMs = PRESENCE_TIMEOUT_MS,
): boolean {
  if (entry.residency === "human_driven") return false;
  const live = entry.live === true;
  const seen = presenceLastSeen(entry);
  if (seen === null && !live) return false;
  const ageMs = seen === null ? 0 : now - seen;
  return wakeReachable(entry.wake?.kind, ageMs, staleMs, live);
}

// #191：一个 `watch --once` 的 agent 在两次唤醒之间必然断连（live=None），但它**依然可被唤醒**——
// presence 却只有「在线 / 离线」两档，把这种「断连但可唤醒的待命态」谎报成「离线·待重连」，用户以为它死了。
// wakeableState 把「非在线」细分成三档（在线与否由调用方按 live/新鲜度另判，本函数只看 wake layer + 校验事实）：
//   • offline            —— 没有任何 wake layer（wake=none/缺失）或 human_driven：进程没了 / 靠人接续，@ 它落不了地。
//   • wakeable_unverified —— 声明了 serve/watch wake layer，但服务端从未验证过它真能被唤醒。**自报不可信**
//                            （issue #55/#60 的「假在线」另一半：false-online），如实标注「未验证」，不谎称可达。
//   • wakeable_verified   —— 服务端亲自确认：webhook（服务端控制投递，天然可验证）或 serve/watch 且服务端
//                            近期观测到它被 @ 后确实 resume（presence.wake.verified_at 由 DO 盖，**不吃客户端自报**）。
// 关键：verified 只认服务端记录的事实，绝不信客户端塞进来的 wake.verified_at——不然就回到「自称可唤醒实则叫不醒」。
export type WakeableState = "wakeable_verified" | "wakeable_unverified" | "offline";

// 服务端唤醒验证的有效期：DO 每观测到一次「被 @ 后 resume」就把 verified_at 刷新到当下；
// 超过这个窗口没有新证据，就不再谎称 verified，回落到 unverified（仍显示「可唤醒·待命」，只是不再打包票）。
export const WAKE_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export function wakeableState(
  entry: Pick<PresenceEntry, "wake" | "residency">,
  now: number,
  verifyTtlMs = WAKE_VERIFY_TTL_MS,
): WakeableState {
  const kind = entry.wake?.kind;
  // 没有 wake layer（或显式 none）：真离线，无处可唤醒。
  if (kind === undefined || kind === "none") return "offline";
  // human_driven：靠人/外层 harness 接续，不承诺自动响应——不算可唤醒。
  if (entry.residency === "human_driven") return "offline";
  // webhook：服务端持有端点、自己 POST 投递 → 天然可服务端验证，离线也真能唤醒。
  if (kind === "webhook") return "wakeable_verified";
  // serve/watch：只有服务端记录过「近期成功唤醒」（verified_at，由 DO 盖，非客户端自报）才算已验证。
  const verifiedAt = entry.wake?.verified_at;
  if (typeof verifiedAt === "number" && verifiedAt > 0 && now - verifiedAt <= verifyTtlMs) {
    return "wakeable_verified";
  }
  // 声明了 serve/watch 但服务端从未（或不再新鲜地）验证过 → 可唤醒但未验证，如实标注。
  return "wakeable_unverified";
}

export function evaluateHostLease(
  entry: Pick<PresenceEntry, "state" | "ts" | "last_seen" | "role" | "residency" | "wake">,
  now: number,
  leaseMs = PRESENCE_TIMEOUT_MS,
): HostLeaseEvaluation {
  const seen = presenceLastSeen(entry);
  const residency = entry.residency ?? "unknown";
  const wakeKind = entry.wake?.kind ?? "unknown";
  if (entry.role !== "host") {
    return { lease: "stale", reason: `role=${entry.role ?? "missing"}`, last_seen: seen, residency, wake_kind: wakeKind };
  }
  if (entry.state === "offline") return { lease: "stale", reason: "offline", last_seen: seen, residency, wake_kind: wakeKind };
  if (residency !== "supervised" && residency !== "webhook") {
    return { lease: "stale", reason: `residency=${residency}`, last_seen: seen, residency, wake_kind: wakeKind };
  }
  if (wakeKind === "none" || wakeKind === "unknown") {
    return { lease: "stale", reason: `wake=${wakeKind}`, last_seen: seen, residency, wake_kind: wakeKind };
  }
  if (seen === null) return { lease: "stale", reason: "missing-last-seen", last_seen: seen, residency, wake_kind: wakeKind };
  if (now - seen > leaseMs) return { lease: "stale", reason: "lease-expired", last_seen: seen, residency, wake_kind: wakeKind };
  return { lease: "active", reason: null, last_seen: seen, residency, wake_kind: wakeKind };
}

// ---- 客户端 → 服务端帧 ----

export interface HelloFrame {
  type: "hello";
  since: number;
  /**
   * This connection can consume and acknowledge durable directed-delivery v1 frames.
   * Omitted by legacy clients: they may keep using raw message mentions, but must never
   * be selected as the executor for a durable delivery lease.
   */
  directed_delivery?: "v1";
  /** CLI package version。可选以兼容旧客户端；服务端会忽略非法值。 */
  client_version?: string;
  /**
   * 修订游标：客户端已见过的最大 rev_seq。带上它，服务端补拉只重放 rev_seq 更大的
   * 修订快照（编辑/撤回/超越），而不是把全部历史修订对每次连接无条件重放（issue #33）。
   * 旧客户端不带 → 服务端保持旧行为（全量重放）。
   */
  since_rev?: number;
}

/**
 * 频道消息附件引用（#176）：仅是指向 R2 对象的元数据，blob 本体不进消息帧/DO sqlite。
 * 客户端先 POST /api/channels/:slug/attachments 上传拿到本结构，再随消息带上 N 个引用。
 */
export interface Attachment {
  /** R2 对象键：<slug>/<sha256>/<filename>，前缀锚定到频道 slug 以隔离跨频道读取 */
  key: string;
  filename: string;
  content_type: string;
  size: number;
  /** 回 worker 的私有下载路径；授权客户端可为它换取短时签名 URL，不暴露裸 R2 公链。 */
  url: string;
}

export interface SendMessageFrame {
  type: "send";
  kind: "message";
  body: string;
  mentions: string[];
  reply_to: number | null;
  completion_artifact?: CompletionArtifact;
  /** 人类决策请求（#284）；带上它 = 这条 message 是一个 decision_request。与 completion_artifact 互斥。 */
  decision_request?: SendDecisionRequest;
  /** 附件引用（#176）；空/缺省视为无附件。上限见 do 侧 MAX_ATTACHMENTS_PER_MESSAGE。 */
  attachments?: Attachment[];
  replaces?: number;
  /**
   * 幂等键（#98）：客户端每次发送生成一个唯一键（ULID）。同一条逻辑消息的重试（客户端超时重发、
   * 或服务端 fetchChannelDO 在 DO reset 后 clone 重发）携带同一键，服务端按 (sender, key) 去重，
   * 返回原来那条的 seq，不再重复落库/重复唤醒。旧客户端不带 → 保持旧行为（不去重）。
   */
  idempotency_key?: string;
}

export interface SendStatusFrame {
  type: "send";
  kind: "status";
  state: StatusState;
  note: string;
  mentions?: string[];
  /** 幂等键（#98）：同 SendMessageFrame，status 帧同样会重复落库 + 重复唤醒，故也支持去重。 */
  idempotency_key?: string;
  scope?: string[];
  summary_seq?: number | null;
  blocked_reason?: string | null;
  role?: CollaborationRole;
  residency?: Residency;
  wake?: WakeInfo;
  context?: AgentContext;
  decision?: SendHostDecision;
  workflow?: SendStatusWorkflow;
  /**
   * serve 串行处理一条 wake 时置 true：正忙、无法即时响应新 @（issue #103）。空/false = 空闲。
   * 服务端据此在 presence 上表达「忙」，让同事把 ask 超时当作「忙」而非「失联」，别反复 @ 堆重复唤醒。
   */
  busy?: boolean;
  /** 当前排在身后、尚未处理的 wake 数（issue #103）。0/缺省 = 无积压。非负整数。 */
  queue_depth?: number;
  /** Agent 主动上报的可恢复模型会话；适用于非 builtin runner 的交互式 agent（issue #522）。 */
  agent_session?: AgentSessionInfo;
}

export type SendFrame = SendMessageFrame | SendStatusFrame;

export interface PingFrame {
  type: "ping";
}

// 已读游标（Phase 2）：逐帧流式连接的客户端（网页 tab / CLI serve / watch --follow）在读到某条
// 消息后回一个 seen，声明「我已读到 seq」。读状态覆盖人类 AND 流式 agent——只要它逐帧在收，就能声明已读。
// webhook / watch --once 型事件驱动 agent 不逐条流式读，不发 seen，其送达状态改由 wake 回执表达。
export interface SeenFrame {
  type: "seen";
  seq: number;
}

/**
 * 每任务进度/心跳（issue #228，扩 #103 busy）。serve 处理一条长 wake 期间，周期性发这条**轻量、
 * presence-only** 的帧：只更新发送者 presence 上的 current_task/task_started_at/heartbeat_at，
 * **不落 history**（不刷屏，是 ledger 而非聊天）。任务结束发一条 current_task=null 的清除帧。
 * 三个字段要么全是非负整数（正在处理），要么全是 null（清除）。脏值被服务端静默丢弃、不断流。
 */
export interface HeartbeatFrame {
  type: "heartbeat";
  /** 正在处理的 wake 的触发 seq；null = 任务结束、清除。 */
  current_task: number | null;
  /** 当前任务 run() 的开始时刻（epoch ms）；随 current_task 一起清空。 */
  task_started_at: number | null;
  /** 本次心跳时刻（epoch ms），周期性推进；随 current_task 一起清空。 */
  heartbeat_at: number | null;
  /**
   * 模型 session 内的细粒度活动（issue #602）：serve 每拍从 hook 落盘文件读到什么就捎带什么。
   * 缺省即「本拍无活动信息」，服务端把 activity 清空（活动新鲜度与心跳同生共死，绝不留僵值）。
   */
  activity?: AgentActivity;
  /**
   * runner 健康自报（issue #603）：serve 在任务收尾拍（含清除帧）带上连败计数。
   * 缺省即「无连败」，服务端把已存的 runner_health 清空（恢复自动清零，绝不留僵值）。
   */
  runner_health?: RunnerHealth;
  /**
   * 可选的模型会话自报。可与任务心跳同帧，也可在三个任务字段均为 null 时单独上报；
   * 服务端持久化但不落聊天 history。缺省表示不更新已有会话。
   */
  agent_session?: AgentSessionInfo;
}

// 同名 serve 跨机租约（#99）：一个 serve 连接声明「我是这个 name 的 serve runner，想当唯一在跑的那个」。
// 服务端据此在同名的多条 serve 连接里选出唯一持租者，并回 ServeLeaseFrame 告知各连接是否持租。
// 只有 serve 型 supervisor 发它；watch / webhook / 人类连接都不发。op 目前恒为 "claim"（断连即隐式释放）。
export interface ServeLeaseClaimFrame {
  type: "serve_lease";
  op: "claim";
}

/**
 * watch 连接声明自己愿意承接 durable directed delivery。
 *
 * 这和普通消息游标完全分离：注册只选择 delivery adapter，`seen`/普通 seq ack
 * 都不能完成或确认一条 delivery。
 */
export interface DeliveryAdapterRegisterFrame {
  type: "delivery_adapter";
  adapter: "watch";
  op: "register";
}

/** 持租 serve 对当前定向 work 的权威启动/终态/挂起态回执；连接身份必须等于 delivery.target_name。 */
export interface DeliveryUpdateFrame {
  type: "delivery_update";
  delivery_id: string;
  /** Ephemeral per-update correlation token. It is echoed only on the direct ACK, never persisted. */
  request_id?: string;
  state: "running" | "waiting_owner" | "replied" | "failed";
  work_id?: string;
  continuation_ref?: string;
  reply_seq?: number;
  error?: string;
}

export type ClientFrame =
  | HelloFrame
  | SendFrame
  | PingFrame
  | SeenFrame
  | HeartbeatFrame
  | ServeLeaseClaimFrame
  | DeliveryAdapterRegisterFrame
  | DeliveryUpdateFrame;

// ---- 服务端 → 客户端帧 ----

// 某身份的已读游标：读到的最大 seq + 时间。游标只前移不后移，断连后仍保留（像 IM 的已读位置）。
export interface ReadCursor {
  name: string;
  kind?: SenderKind;
  last_seen_seq: number;
  updated_at: number;
}

// 游标推进时广播，客户端据此实时更新每条消息的已读/未读名单。
export interface ReadCursorFrame extends ReadCursor {
  type: "read_cursor";
}

export interface WelcomeFrame {
  type: "welcome";
  channel: string;
  self: string;
  mode?: ChannelMode;
  /** 连接方 token 的角色；web 据此在首帧就隐藏 readonly 的输入框（spec §9），旧客户端忽略即可 */
  role?: TokenRole;
  /** 频道当前已被 loop guard 熔断时首帧提示；旧客户端忽略即可。 */
  loop_guard?: string | null;
  participants: Sender[];
  last_seq: number;
  /** 频道当前最大修订序号；since=0 全量同步的客户端可直接以此初始化修订游标 */
  last_rev_seq?: number;
  /** 频道公告/用前必读的版本；客户端发现变化后按需 REST 拉全文。 */
  charter_rev?: number;
  presence: PresenceEntry[];
  /** 已读游标快照（Phase 2）；晚到的客户端据此初始化每身份读到第几条。旧客户端忽略即可。 */
  read_cursors?: ReadCursor[];
  /** 服务端会把定向 @ 作为独立 delivery 帧重放；新 serve 应以它为唤醒真值，普通 read cursor 仅管阅读。 */
  directed_delivery?: "v1";
  /**
   * 服务端会强制 owner 决策的应答人绑定：owner_decision 携带 expected_decision_responder_owner 时，
   * 只有该 owner 账号本人能应答（在 CAS 里校验）。旧服务端不发这个能力位，会静默丢弃绑定字段——
   * managed front 据此判断能否安全发起 owner 决策，不支持就 fail closed，不静默降级授权。
   */
  owner_decision_binding?: "v1";
}

export interface DirectedDelivery {
  id: string;
  message_seq: number;
  target_name: string;
  cause: DirectedDeliveryCause;
  state: DirectedDeliveryState;
  attempt: number;
  lease_until: number | null;
  work_id: string | null;
  continuation_ref: string | null;
  reply_seq: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 频道状态投影。租约、attempt、cause、continuation/work 引用和内部错误永远不进
 * `delivery_state`；完整对象只走目标 holder 专用的 `delivery` 帧。状态本身按连接投影：
 * 目标身份及其 owner 可见 claimed/waiting_owner，其他连接会把 claimed/running/waiting_owner
 * 统一投影为 running。因此这里保留完整状态联合，授权边界由 worker 逐连接执行。
 */
export interface PublicDirectedDelivery {
  id: string;
  message_seq: number;
  target_name: string;
  state: DirectedDeliveryState;
  reply_seq: number | null;
  created_at: number;
  updated_at: number;
  /**
   * 目标消息正文的单行截断预览（投影时从 messages 现查，仍不复制存储）。Agent 看板靠它展示
   * 「在忙什么」，否则 delivery 指向的老消息不在客户端已加载窗口时只能显示占位符。
   * 已撤回消息为 null；旧 worker 不下发该字段。
   */
  preview?: string | null;
}

/** 只发给目标身份当前持有 serve lease 的连接；message 正文仍引用原 messages 行，不复制存储。 */
export interface DirectedDeliveryFrame {
  type: "delivery";
  delivery: DirectedDelivery;
  message: MsgFrame;
}

/** delivery 状态变化；无论观看者身份都不携带 runner/session 私有字段。 */
export interface DeliveryStateFrame {
  type: "delivery_state";
  delivery: PublicDirectedDelivery;
  /** Present only on the direct ACK for a delivery_update carrying the same token. */
  request_id?: string;
}

export interface ParticipantsFrame {
  type: "participants";
  participants: Sender[];
}

export interface StatusEvent {
  owner: string;
  state: StatusState;
  scope: string[];
  summary_seq: number | null;
  blocked_reason: string | null;
  updated_at: number;
  context?: AgentContext;
  decision?: HostDecision;
  workflow?: StatusWorkflow;
}

export interface CompletionArtifact {
  kind: "final_synthesis";
  kickoff_seq: number;
  replies_count: number;
  timeout: boolean;
  related_issues: number[];
  related_prs: number[];
  task_id?: number;
}

export interface CompletionReview {
  state: CompletionReviewState;
  policy: CompletionReviewPolicy;
  reviewer?: Sender;
  reviewer_owner?: string;
  reviewed_at?: number;
  reason?: string;
  replaces_seq?: number;
  replaced_by_seq?: number;
}

// ---- 人类决策协议（#284）----
// 一条 decision_request 消息携带一个待决问题：方案审批（approve/reject）或选项回答（1..N）。
// 决策的落地状态挂在同一条消息上（DecisionResolution），像 completion_review 挂在 completion 上。
/**
 * 决策与触发它的 durable work 的服务端血缘（#548）。客户端发来的同名字段一律不可信；只有
 * Worker 观察到该 sender 恰好持有一条 claimed/running delivery 时才绑定。字段全为 optional，
 * 保持普通 #284 决策和旧历史兼容。
 */
export interface DecisionDeliveryLineage {
  delivery_id?: string;
  origin_seq?: number;
  origin_channel?: string;
  work_id?: string;
  continuation_ref?: string;
}

export interface DecisionRequest extends DecisionDeliveryLineage {
  kind: DecisionKind;
  /** 一句话问题 / 方案标题；方案正文走消息 body。 */
  prompt: string;
  /** 可选项文本；approval 恒为 ["approve","reject"]，choice 为 agent 自带的 1..N 个。 */
  options: string[];
  /**
   * Optional account principal allowed to resolve this request. The Worker persists this field but
   * removes it from public message projections; it is an authorization constraint, not UI content.
   */
  expected_responder_owner?: string;
}

export interface DecisionResolution {
  state: DecisionState;
  /** 选中项在 options 中的 0 基下标；pending 时省略。 */
  chosen_index?: number;
  chosen_option?: string;
  /** 做出选择的人类/moderator；无人值守自动放行时省略。 */
  responder?: Sender;
  responder_owner?: string;
  responded_at?: number;
  /** 可选备注（如 reject 理由）。 */
  reason?: string;
}

// decision_response 消息：回应挂到频道里成为一条独立可渲染/可消费的帧，反指 request 的 seq。
export interface DecisionResponse extends DecisionDeliveryLineage {
  request_seq: number;
  chosen_index: number;
  chosen_option: string;
  /** 原问题快照，owner answer delivery 无需再反查已被裁剪的 request 才能恢复上下文。 */
  prompt?: string;
  /** owner 的可选说明；与 DecisionResolution.reason 同一份服务端校验后的文本。 */
  reason?: string;
}

// 客户端发 decision_request 时的入参：kind/options 可省，服务端兜底 approval + approve/reject。
export interface SendDecisionRequest {
  kind?: DecisionKind;
  prompt: string;
  options?: string[];
}

export interface MsgFrame {
  /** status messages are emitted as type:"status" so tools can consume them without text scraping. */
  type: "msg" | "status";
  seq: number;
  sender: Sender;
  kind: MessageKind;
  body: string;
  mentions: string[];
  reply_to: number | null;
  state: StatusState | null;
  note: string | null;
  status: StatusEvent | null;
  /** 普通消息在投递时归属到的 workflow；status 消息仍以 status.workflow 为准。 */
  workflow_ref?: StatusWorkflow;
  role?: CollaborationRole;
  role_source?: CollaborationRoleSource;
  completion_artifact?: CompletionArtifact;
  completion_review?: CompletionReview;
  /** 决策请求（#284）；仅 decision_request 消息携带。 */
  decision_request?: DecisionRequest;
  /** 决策落地状态（#284）；随人类回应/自动放行更新并以 message_update("decision") 重播。 */
  decision_resolution?: DecisionResolution;
  /** 决策回应（#284）；仅 decision_response 回复消息携带，反指 request 的 seq。 */
  decision_response?: DecisionResponse;
  /** 附件引用（#176）；仅 kind:"message" 携带，无附件时省略。 */
  attachments?: Attachment[];
  ts: number;
  edited?: true;
  edited_at?: number;
  edited_by?: string;
  retracted?: true;
  retracted_at?: number;
  retracted_by?: string;
  supersedes?: number;
  superseded_by?: number;
  /** 该消息最近一次修订的单调序号；客户端据此推进修订游标（hello.since_rev） */
  rev_seq?: number;
  revision?: {
    original_body: string | null;
  };
}

/** One bounded page of data attributable to an identity in a channel. */
export interface IdentityExportData {
  name: string;
  exported_at: number;
  messages: MsgFrame[];
  audit: {
    target_seq: number;
    action: string;
    actor: { name: string; kind: string };
    old_body: string | null;
    new_body: string | null;
    original_byte_length: number | null;
    created_at: number;
  }[];
  wake_deliveries: {
    mention_seq: number;
    target_name: string;
    webhook_name: string;
    adapter_kind: string;
    attempt: number;
    result: string;
    http_status: number | null;
    error: string | null;
    attempted_at: number;
    ack_seq: number | null;
    resume_seq: number | null;
  }[];
  read_cursor: ReadCursor | null;
  presence: PresenceEntry[];
  next: { messages: number | null; audit: number | null; wake_deliveries: number | null };
}

export interface IdentityEraseSummary {
  name: string;
  erased_at: number;
  messages_scrubbed: number;
  audit_deleted: number;
  wake_ledger_deleted: number;
  webhook_payloads_deleted: number;
  read_cursors_deleted: number;
  presence_deleted: number;
  attachment_keys: string[];
}

export interface HostSummary {
  name: string;
  lease: HostLeaseState;
  stale_reason: string | null;
  state: string;
  note: string | null;
  role_source: string | null;
  residency: Residency | "unknown";
  wake_kind: WakeKind | "unknown";
  wake_verified_at: number | null;
  last_seen: number | null;
}

export interface ClaimSummary {
  seq: number;
  /**
   * claim 的新身份（#204）：任务台账派生的 claim = 对应 task 的 id；消息折叠派生的历史 claim（unlinked）无 task，为 null。
   * owner+scope 拼出的 claimKey 不再是身份——同一 task 中途改 scope 仍是同一条 claim，不再裂成孤儿。
   */
  task_id: number | null;
  owner: string;
  /** StatusState 口径的状态；task 派生时由 taskStateToStatusState(task.state) 映射得到 */
  state: StatusState;
  /** 精确的任务台账状态（#204）；消息折叠派生的 claim 无对应 task 为 null，不丢失 assigned/in_progress/needs_review 的区分 */
  task_state: TaskState | null;
  scope: string[];
  note: string | null;
  blocked_reason: string | null;
  summary_seq: number | null;
  updated_at: number;
  workflow: StatusWorkflow | null;
}

export interface DecisionSummary {
  seq: number;
  owner: string;
  kind: HostDecision["kind"];
  decision: string;
  next: string | null;
  expires_at: number | null;
  handoff_to: string | null;
  takeover_from: string | null;
}

export interface ConflictClaimSummary {
  seq: number;
  /** 同 ClaimSummary.task_id：task 派生为对应 task 的 id，消息折叠派生为 null。渲染时据此区分 `task #N` 与 `#N`。 */
  task_id: number | null;
  owner: string;
  state: StatusState;
  scope: string[];
}

export interface ConflictSummary {
  scope: string;
  owners: string[];
  claims: ConflictClaimSummary[];
}

export interface RecommendedAction {
  kind: "clear-loop-guard" | "takeover" | "assign-host" | "resolve-conflict" | "review-blockers";
  reason: string;
  target: string | null;
  command: string | null;
  requires_human: boolean;
}

export interface HostBoard {
  schema: "agentparty.v1";
  type: "host_board";
  channel: string;
  generated_at: number;
  last_seq: number;
  hosts: HostSummary[];
  open_claims: ClaimSummary[];
  blockers: ClaimSummary[];
  conflicts: ConflictSummary[];
  decisions: DecisionSummary[];
  /** 历史消息里没有对应 task 的 status claim（#204 legacy 段）：按 seq 去重排序、附转换命令，不静默丢弃 */
  unlinked_claims: ClaimSummary[];
  recommended_actions: RecommendedAction[];
}

export interface HostBoardOptions {
  loopGuardActive?: boolean | null;
}

export function summarizeHosts(presence: PresenceEntry[], now: number): HostSummary[] {
  return presence
    .filter((entry) => entry.role === "host")
    .map((entry) => {
      const lease = evaluateHostLease(entry, now);
      return {
        name: entry.name,
        lease: lease.lease,
        stale_reason: lease.reason,
        state: entry.state,
        note: entry.note,
        role_source: entry.role_source ?? null,
        residency: lease.residency,
        wake_kind: lease.wake_kind,
        wake_verified_at: entry.wake?.verified_at ?? null,
        last_seen: lease.last_seen,
      };
    })
    .sort((a, b) => {
      if (a.lease !== b.lease) return a.lease === "active" ? -1 : 1;
      return (b.last_seen ?? 0) - (a.last_seen ?? 0) || a.name.localeCompare(b.name);
    });
}

// TaskState → StatusState 映射（#204）：host board 的 claim 用 StatusState 口径显示，而任务台账用 TaskState。
// 活跃三态（assigned/in_progress/needs_review）视作 working，blocked/done 直通，triage/backlog 视作 waiting（待命/未开工）。
// 精确 TaskState 另存于 claim.task_state，映射不丢信息。
export function taskStateToStatusState(state: TaskState): StatusState {
  switch (state) {
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "assigned":
    case "in_progress":
    case "needs_review":
      return "working";
    case "triage":
    case "backlog":
      return "waiting";
  }
}

function claimKey(status: StatusEvent): string {
  return `${status.owner}\0${status.scope.join("\0")}`;
}

function claimFrom(seq: number, status: StatusEvent): ClaimSummary {
  return {
    seq,
    task_id: null,
    owner: status.owner,
    state: status.state,
    task_state: null,
    scope: status.scope,
    note: null,
    blocked_reason: status.blocked_reason,
    summary_seq: status.summary_seq,
    updated_at: status.updated_at,
    workflow: status.workflow ?? null,
  };
}

export function summarizeStatus(messages: MsgFrame[]): {
  openClaims: ClaimSummary[];
  blockers: ClaimSummary[];
  decisions: DecisionSummary[];
} {
  const latestClaims = new Map<string, ClaimSummary>();
  const decisions: DecisionSummary[] = [];

  for (const msg of messages) {
    if (msg.kind !== "status" || msg.status === null) continue;
    const status = msg.status;
    const key = claimKey(status);
    const claim = { ...claimFrom(msg.seq, status), note: msg.note };
    if (status.state === "done") latestClaims.delete(key);
    else latestClaims.set(key, claim);

    if (status.decision !== undefined) {
      decisions.push({
        seq: msg.seq,
        owner: status.decision.owner,
        kind: status.decision.kind,
        decision: status.decision.decision,
        next: status.decision.next,
        expires_at: status.decision.expires_at,
        handoff_to: status.decision.handoff_to ?? null,
        takeover_from: status.decision.takeover_from ?? null,
      });
    }
  }

  const openClaims = [...latestClaims.values()].sort((a, b) => b.seq - a.seq);
  return {
    openClaims,
    blockers: openClaims.filter((claim) => claim.state === "blocked"),
    decisions: decisions.slice(-8).reverse(),
  };
}

function shellWord(s: string): string {
  return /^[a-zA-Z0-9._:@%+=,/-]+$/.test(s) ? s : JSON.stringify(s);
}

function isLoopGuardBlocker(claim: ClaimSummary): boolean {
  const text = `${claim.blocked_reason ?? ""} ${claim.note ?? ""}`.toLowerCase();
  return claim.owner === "system" && text.includes("loop guard");
}

function hasHumanMessageAfter(messages: MsgFrame[], seq: number): boolean {
  return messages.some((message) => message.seq > seq && message.kind === "message" && message.sender.kind === "human" && !message.retracted);
}

function isActiveLoopGuardBlocker(claim: ClaimSummary, messages: MsgFrame[]): boolean {
  return isLoopGuardBlocker(claim) && !hasHumanMessageAfter(messages, claim.seq);
}

function normalizeScope(scope: string): string {
  return scope.replace(/\/+$/g, "");
}

function overlapScope(a: string, b: string): string | null {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  if (left === "" || right === "") return null;
  if (left === right) return left;
  if (left.startsWith(`${right}/`)) return right;
  if (right.startsWith(`${left}/`)) return left;
  return null;
}

export function summarizeConflicts(openClaims: ClaimSummary[]): ConflictSummary[] {
  const groups = new Map<string, Map<string, ConflictClaimSummary>>();
  for (let i = 0; i < openClaims.length; i += 1) {
    const left = openClaims[i]!;
    for (let j = i + 1; j < openClaims.length; j += 1) {
      const right = openClaims[j]!;
      if (left.owner === right.owner) continue;
      for (const leftScope of left.scope) {
        for (const rightScope of right.scope) {
          const scope = overlapScope(leftScope, rightScope);
          if (scope === null) continue;
          const claims = groups.get(scope) ?? new Map<string, ConflictClaimSummary>();
          claims.set(`${left.owner}\0${left.seq}`, {
            seq: left.seq,
            task_id: left.task_id,
            owner: left.owner,
            state: left.state,
            scope: left.scope,
          });
          claims.set(`${right.owner}\0${right.seq}`, {
            seq: right.seq,
            task_id: right.task_id,
            owner: right.owner,
            state: right.state,
            scope: right.scope,
          });
          groups.set(scope, claims);
        }
      }
    }
  }

  return [...groups.entries()]
    .map(([scope, claims]) => {
      const sortedClaims = [...claims.values()].sort((a, b) => b.seq - a.seq || a.owner.localeCompare(b.owner));
      return {
        scope,
        owners: [...new Set(sortedClaims.map((claim) => claim.owner))].sort(),
        claims: sortedClaims,
      };
    })
    .sort((a, b) => a.scope.localeCompare(b.scope));
}

export function recommendHostActions(
  channel: string,
  hosts: HostSummary[],
  blockers: ClaimSummary[],
  conflicts: ConflictSummary[],
  messages: MsgFrame[] = [],
  options: HostBoardOptions = {},
): RecommendedAction[] {
  const actions: RecommendedAction[] = [];
  const activeLoopGuard =
    options.loopGuardActive === false ? false : blockers.some((claim) => isActiveLoopGuardBlocker(claim, messages));
  if (activeLoopGuard) {
    actions.push({
      kind: "clear-loop-guard",
      reason: "loop guard is tripped; agent messages are rejected until a human message or owner reset",
      target: null,
      command: `party channel reset-guard ${shellWord(channel)}`,
      requires_human: true,
    });
  }

  const activeHosts = hosts.filter((host) => host.lease === "active");
  const staleHosts = hosts.filter((host) => host.lease === "stale");
  if (activeHosts.length === 0 && staleHosts.length > 0) {
    const target = staleHosts[0]!;
    actions.push({
      kind: "takeover",
      reason: `no active resident host; latest host is stale (${target.stale_reason ?? "stale"})`,
      target: target.name,
      command: [
        "party status",
        shellWord(channel),
        "working",
        "-m",
        shellWord(`takeover host from ${target.name}`),
        "--role host",
        "--decision-kind takeover",
        "--decision",
        shellWord(`takeover stale host ${target.name}`),
        "--takeover-from",
        shellWord(target.name),
      ].join(" "),
      requires_human: false,
    });
  } else if (hosts.length === 0) {
    actions.push({
      kind: "assign-host",
      reason: "no visible host role in channel presence",
      target: null,
      command: `party channel role set <agent-name> host ${shellWord(channel)}`,
      requires_human: true,
    });
  }

  if (conflicts.length > 0) {
    const conflict = conflicts[0]!;
    actions.push({
      kind: "resolve-conflict",
      reason: `${conflicts.length} overlapping claim scope(s); first ${conflict.scope} claimed by ${conflict.owners.join(", ")}`,
      target: conflict.owners[0] ?? null,
      command: null,
      requires_human: false,
    });
  }

  const nonLoopBlockers = blockers.filter((claim) => !isLoopGuardBlocker(claim));
  if (nonLoopBlockers.length > 0) {
    actions.push({
      kind: "review-blockers",
      reason: `${nonLoopBlockers.length} blocked claim(s) need host triage`,
      target: nonLoopBlockers[0]!.owner,
      command: null,
      requires_human: false,
    });
  }

  return actions;
}

// #204：任务台账（channel_tasks）→ claim。claim 的身份 = task.id；owner = assignee（conflicts 按 assignee 判定），
// 无 assignee 的任务（如无人认领的 blocked）回退 created_by 以保证 owner 非空。scope/blocked_reason 直接取自 task。
function taskToClaim(task: TaskRecord): ClaimSummary {
  return {
    seq: task.id,
    task_id: task.id,
    owner: task.assignee?.name ?? task.created_by,
    state: taskStateToStatusState(task.state),
    task_state: task.state,
    scope: task.scope,
    note: task.blocked_reason,
    blocked_reason: task.blocked_reason,
    summary_seq: null,
    updated_at: task.updated_at,
    workflow: null,
  };
}

// open_claims：活跃且有 assignee 的任务。claim 身份 = task id，故同一 task 改 scope 仍是同一条，不再裂成孤儿。
const OPEN_CLAIM_STATES: readonly TaskState[] = ["assigned", "in_progress", "needs_review"];

function openClaimsFromTasks(tasks: TaskRecord[]): ClaimSummary[] {
  return tasks
    .filter((task) => task.assignee !== null && OPEN_CLAIM_STATES.includes(task.state))
    .map(taskToClaim)
    .sort((a, b) => b.seq - a.seq);
}

function blockersFromTasks(tasks: TaskRecord[]): ClaimSummary[] {
  return tasks
    .filter((task) => task.state === "blocked")
    .map(taskToClaim)
    .sort((a, b) => b.seq - a.seq);
}

// unlinked（legacy）段（#204）：消息折叠出的 openClaims 里，没有任何 task 的 anchor_seqs 指向其 seq 的那些。
// 「有对应 task」判定按 seq（anchor 命中），不用 owner+scope 拼 claimKey——这正是要修的影子台账根因：
// 一个改过 scope 的 claim 用 claimKey 匹配会误判成「另一条」。去重与排序也按 seq（claim 的稳定标识），
// 不用 claimKey：claimKey 会把同 owner+scope、不同 seq 的两条误并成一条、并按字符串序打乱顺序。
function unlinkedClaimsFromMessages(messageOpenClaims: ClaimSummary[], tasks: TaskRecord[]): ClaimSummary[] {
  const anchoredSeqs = new Set<number>();
  for (const task of tasks) {
    for (const seq of task.anchor_seqs) anchoredSeqs.add(seq);
  }
  const bySeq = new Map<number, ClaimSummary>();
  for (const claim of messageOpenClaims) {
    if (anchoredSeqs.has(claim.seq)) continue;
    bySeq.set(claim.seq, claim);
  }
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
}

export function buildHostBoard(
  channel: string,
  presence: PresenceEntry[],
  messages: MsgFrame[],
  tasks: TaskRecord[] = [],
  now = Date.now(),
  options: HostBoardOptions = {},
): HostBoard {
  // decisions 仍从消息折叠来；open_claims / blockers / conflicts 改由任务台账派生（#204）。
  const messageStatus = summarizeStatus(messages);
  const hosts = summarizeHosts(presence, now);
  const openClaims = openClaimsFromTasks(tasks);
  const blockers = blockersFromTasks(tasks);
  const conflicts = summarizeConflicts(openClaims);
  const unlinkedClaims = unlinkedClaimsFromMessages(messageStatus.openClaims, tasks);
  // recommendHostActions 的 loop-guard 检测靠 system status 消息里的 blocker（不是 task）；只喂 task blockers
  // 会让 loop guard 永远看不到。故把消息里的 loop-guard system blocker 一并喂它；review-blockers 只对
  // task blockers 生效（loop-guard blocker 的 owner=system 会被其 nonLoopBlockers 过滤掉）。
  const loopGuardBlockers = messageStatus.blockers.filter(isLoopGuardBlocker);
  const recommendBlockers = [...blockers, ...loopGuardBlockers];
  return {
    schema: "agentparty.v1",
    type: "host_board",
    channel,
    generated_at: now,
    last_seq: messages.at(-1)?.seq ?? 0,
    hosts,
    open_claims: openClaims,
    blockers,
    conflicts,
    decisions: messageStatus.decisions,
    unlinked_claims: unlinkedClaims,
    recommended_actions: recommendHostActions(channel, hosts, recommendBlockers, conflicts, messages, options),
  };
}

export interface MessageUpdateFrame {
  type: "message_update";
  target_seq: number;
  action: "edit" | "retract" | "supersede" | "review" | "decision";
  actor: Sender;
  ts: number;
  message: MsgFrame;
}

export interface SentFrame {
  type: "sent";
  seq: number;
}

export interface PresenceFrame {
  type: "presence";
  name: string;
  client_version?: string;
  kind?: SenderKind;
  account?: string;
  state: PresenceState;
  note: string | null;
  ts: number;
  last_seen?: number;
  status?: StatusEvent;
  role?: CollaborationRole;
  role_source?: CollaborationRoleSource;
  residency?: Residency;
  wake?: WakeInfo;
  context?: AgentContext;
  lineage?: AgentLineage;
  /** 全局唯一昵称（可@别名）。人类=account handle，agent=自设 nickname（#165）；已设置才下发，未设置省略。旧客户端忽略。 */
  handle?: string;
  display_name?: string;
  avatar_url?: string;
  avatar_thumb?: string;
  /** 人为「暂停接待」（issue #180）。true 时被 @ 也不唤醒；serve/watch 收到本帧即自我抑制唤醒。 */
  paused?: boolean;
  /** 定时恢复接待的时刻（epoch ms）。 */
  resume_at?: number;
  /** 当前身份是否仍持有活连接；与 PresenceEntry 同口径。 */
  live?: boolean;
  /** serve 正在处理 wake；与 PresenceEntry 同口径。 */
  busy?: boolean;
  /** 当前 wake 身后的排队深度。 */
  queue_depth?: number;
  /** 已释放 runner、正在等待 owner 回答的持久 work 数；与 busy/queue_depth 分开。 */
  waiting_owner_count?: number;
  /** 同名 serve 的待命实例数。 */
  serve_standbys?: number;
  /** 当前处理的触发消息 seq；仅活跃任务时下发。 */
  current_task?: number;
  /** 当前任务开始时间；与 current_task 同生共死。 */
  task_started_at?: number;
  /** 当前任务最近心跳；与 current_task 同生共死。 */
  heartbeat_at?: number;
  /** Agent 自报并由频道持久化的模型会话句柄；供重启后精确 resume（issue #522）。 */
  agent_session?: AgentSessionInfo;
  /** 同一身份当前活跃连接数。 */
  connection_count?: number;
}

export interface ErrorFrame {
  type: "error";
  code: ErrorCode;
  message: string;
}

export interface PongFrame {
  type: "pong";
}

// 同名 serve 跨机租约（#99）：服务端告诉某条 serve 连接它此刻是否持租。
// held=true 的那条才跑 runner；held=false 的转入 standby（被 @ 也不跑，消息仍进历史、游标照推进）。
// 持租者断连 / 心跳超时（presence 60s 扫描）后，服务端把租约转给下一条 standby 并补发 held=true。
export interface ServeLeaseFrame {
  type: "serve_lease";
  /** 本连接所属身份 name。 */
  name: string;
  /** 本连接此刻是否持有该 name 的 serve 租约（唯一在跑的那个）。 */
  held: boolean;
}

/** 服务端确认当前连接已注册为 watch delivery adapter。 */
export interface DeliveryAdapterRegisteredFrame {
  type: "delivery_adapter";
  adapter: "watch";
  registered: true;
}

export type ServerFrame =
  | WelcomeFrame
  | ParticipantsFrame
  | MsgFrame
  | MessageUpdateFrame
  | SentFrame
  | PresenceFrame
  | ReadCursorFrame
  | ErrorFrame
  | PongFrame
  | ServeLeaseFrame
  | DeliveryAdapterRegisteredFrame
  | DirectedDeliveryFrame
  | DeliveryStateFrame;
