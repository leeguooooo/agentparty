// channel durable object — seq 分配 / 广播 / presence / 补拉 / 各类熔断 / webhook 投递 / temp 归档
import {
  applyLiveConnection,
  BODY_LIMIT,
  IDEMPOTENCY_KEY_MAX,
  IDEMPOTENCY_WINDOW_MS,
  LOOP_GUARD_AGENT_N,
  LOOP_GUARD_AGENT_PARTY_N,
  LOOP_GUARD_N,
  LOOP_GUARD_PARTY_N,
  MAX_WEBHOOKS_PER_CHANNEL,
  MAX_MESSAGE_AUDIT_ROWS,
  MAX_WEBHOOK_DEAD_LETTERS,
  MAX_WEBHOOK_QUEUE_ROWS,
  READ_CURSOR_RETENTION_MS,
  WAKE_LEDGER_RETENTION_MS,
  DECISION_PROMPT_LIMIT,
  DECISION_OPTIONS_MAX,
  DECISION_OPTION_LIMIT,
  DECISION_REASON_LIMIT,
  DECISION_RESPONDER_OWNER_LIMIT,
  MAX_CONNECTIONS_PER_CHANNEL,
  PRESENCE_TIMEOUT_MS,
  RATE_LIMIT_PER_MIN,
  RETAIN_N,
  TEMP_IDLE_ARCHIVE_MS,
  WEBHOOK_MAX_RETRIES,
  WEBHOOK_REDELIVER_BATCH_SIZE,
  WEBHOOK_RETRY_BATCH_SIZE,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
  WAKE_BUDGET_DEFAULT_WINDOW_MS,
  WAKE_BUDGET_MAX_LIMIT,
  WAKE_BUDGET_MAX_WINDOW_MS,
  WAKE_BUDGET_MIN_WINDOW_MS,
  DIRECTED_DELIVERY_LEASE_MS,
  DELIVERY_CONTINUATION_REF_LIMIT,
  DELIVERY_ORIGIN_CHANNEL_LIMIT,
  DELIVERY_WORK_ID_LIMIT,
  AGENT_ACTIVITY_TTL_MS,
  parseAgentActivity,
  parseRunnerHealth,
  type AgentActivity,
  type ListeningVerdict,
  type RunnerHealth,
  type AgentLineage,
  type AgentSessionInfo,
  type Attachment,
  type ErrorCode,
  type AgentContext,
  type CollaborationRole,
  type CollaborationRoleSource,
  type CompletionArtifact,
  type CompletionReview,
  type CompletionReviewPolicy,
  type CompletionReviewState,
  type DecisionKind,
  type DecisionDeliveryLineage,
  type DecisionMode,
  type DecisionRequest,
  type DecisionResolution,
  type DecisionResponse,
  type DecisionState,
  type DirectedDelivery,
  type DirectedDeliveryCause,
  type DeliveryUpdateFrame,
  type PublicDirectedDelivery,
  type HostDecision,
  type HostDecisionKind,
  type IdentityEraseSummary,
  type IdentityExportData,
  type MsgFrame,
  type MessageUpdateFrame,
  type PresenceEntry,
  type PresenceFrame,
  type ReadCursor,
  type Residency,
  type SendHostDecision,
  type SendFrame,
  type SendStatusWorkflow,
  type SearchHit,
  type Sender,
  type SenderKind,
  type ServerFrame,
  type StatusEvent,
  type StatusState,
  type StatusWorkflow,
  type TokenRole,
  type WakeInfo,
  type WakeKind,
  type WebhookFilter,
  type WorkflowKind,
} from "@agentparty/shared";
import {
  extractMentionTokens,
  isValidMentionToken,
  mentionMatchKey,
  resolveMentionToken,
  type MentionAlias,
} from "@agentparty/shared/mentions";
import { anchorAttachmentUrls, parseAttachments, parseStoredAttachments } from "./attachments";
import { sha256Hex } from "./auth";
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";

interface ConnState {
  name: string;
  kind: SenderKind;
  role: TokenRole;
  owner?: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  avatarThumb?: string;
  lineage?: AgentLineage;
  tokenHash: string;
  collabRole?: CollaborationRole;
  collabRoleSource?: CollaborationRoleSource;
  archived: boolean;
  // #381：worker（持 D1 成员表）在连接建立时算好「本连接能否在本频道参与/发送」。
  // 仅 public_watch 频道的 handleSend 据此拦发；快照语义同 role/archived（连接期间定死）。
  canWrite: boolean;
  lastSeen: number;
  // 同名 serve 跨机租约（#99）：本连接是否 claim 过 serve 租约（是一条 serve runner）。
  serveCandidate?: boolean;
  // claim 时分配的单调序号（meta 计数器）。同名多条候选里最小序号者持租——序号在首次 claim 定死、
  // 重连/重复 claim 不变，故持租者掉线后由"次早"顶上，重连的原持租者拿到更大序号、不抢回（软租约）。
  serveClaimSeq?: number;
  // 上次已通告给本连接的持租状态，用于去重：只在 held 变化时才补发 serve_lease 帧。
  serveLeaseHeld?: boolean;
  // watch 可作为 directed delivery 的单次通知适配器；与 serve 共用同一 work lease，
  // raw message 不再另触发一次。watch --once 退出后 lease 留到回复或超时，不能立刻重派。
  watchCandidate?: boolean;
  watchClaimSeq?: number;
  // #434：本连接最近一次 hello 上报的 CLI package version，供 WS send 快照进消息 sender_client_version。
  clientVersion?: string;
  // 只有显式声明能消费 delivery + delivery_update v1 的连接，才可领取 durable work。
  // 旧 serve 仍可观察 raw mention，但不能仅凭 serve_lease claim 被误当成 v1 executor。
  directedDeliveryV1?: boolean;
  /** New sockets do not receive live message frames until hello establishes replay/capabilities. */
  helloPending?: boolean;
  /** Highest message cursor declared by hello on this socket; legacy once may only reserve newer raw work. */
  helloSince?: number;
  /** Fixed handshake deadline. Ping/auto-response activity must never extend it. */
  helloDeadlineAt?: number;
  /** Set before closing an expired handshake so it stops blocking durable dispatch immediately. */
  helloExpired?: boolean;
  /** Prevent duplicate upgrade errors while the runtime drains a closing socket. */
  upgradeRequired?: boolean;
}

const LEGACY_SESSION_ID = "__legacy__";

interface Identity {
  name: string;
  kind: SenderKind;
  role: TokenRole;
  owner?: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  avatarThumb?: string;
  lineage?: AgentLineage;
  tokenHash: string;
  collabRole?: CollaborationRole;
  collabRoleSource?: CollaborationRoleSource;
  // #381：public_watch 写门信号（worker 权威）。缺省/false 且频道为 public_watch → handleSend 拒发。
  canWrite?: boolean;
  // #434：发送方 CLI 版本（x-ap-client-version）。WS 取自 hello 快照进连接态，REST 取自请求头。
  // 落库快照到消息 sender_client_version 列并随帧下发；缺头/网页请求为 undefined。
  clientVersion?: string;
}

interface WebhookDeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

interface AtomicDeliveryEffects {
  deliveryStateIds: Set<string>;
  presenceTargets: Set<string>;
  dispatchTargets: Set<string>;
}

type DeliveryTerminalReason =
  | "delivery_failed"
  | "webhook_delivery_failed"
  | "unknown_outcome"
  | "owner_answer_failed"
  | "source_retracted"
  | "source_retention_expired"
  | "delivery_expired"
  | "orphaned_waiting_owner";

const REVIVABLE_DELIVERY_FAILURES = new Set<DeliveryTerminalReason>(["unknown_outcome"]);

type SendSuccessOutcome =
  // deduped：命中幂等去重（#98）——seq/frames 来自原来那条已落库消息，调用方须跳过广播/唤醒等副作用
  {
      ok: true;
      seq: number;
      frames: ServerFrame[];
      deduped?: boolean;
      deliveryTargets?: string[];
      deliveryTargetOwners?: Record<string, string>;
      /** Durable delivery rows whose state changed while handling the send. Broadcast by id only. */
      deliveryStateIds?: string[];
      atomicEffects?: AtomicDeliveryEffects;
    };

type SendOutcome =
  | SendSuccessOutcome
  | { ok: false; code: ErrorCode; message: string };
type SendErrorOutcome = Extract<SendOutcome, { ok: false }>;

interface ResolvedMentionFrame {
  frame: SendFrame;
  /** Canonical agent identities proven by the same directory read that validated the mentions. */
  agentTargets: string[];
}

interface RoutedMentionFrame {
  frame: SendFrame;
  /** Canonical, creation-time-bound agent targets that must receive durable work. */
  deliveryTargets: string[];
  deliveryTargetOwners: Record<string, string>;
}

interface ExpectedDecisionLineage {
  delivery_id: string;
  work_id: string;
  continuation_ref: string;
}

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unavailable: 503,
  mention_not_found: 400,
  mention_ambiguous: 409,
  unauthorized: 403,
  rate_limited: 429,
  too_large: 413,
  loop_guard: 409,
  workflow_guard: 409,
  archived: 410,
  quota_exceeded: 403,
  channel_full: 429,
  not_found: 404,
};

// presence 扫描 / 半开连接回收窗口（#487 降本）。
// 背景：Durable Objects Compute 是账单最大头（$37.50/68%），根因是每个有连接的频道 DO 被这个 alarm
// 24/7 每分钟唤醒一次。WS Hibernation 已开，健康连接的 ping 由 auto-response 处理、不唤醒 DO；alarm 唯一
// 的活是「醒来看看有没有连接超时静默（半开）需要回收」。把回收窗口与 alarm 重挂间隔从 60s 拉到 2× =
// 120s，并改成按连接实际到期时刻自适应重挂（见 scheduleNextAlarm），把每频道唤醒频率砍半。
//
// 与 PRESENCE_TIMEOUT_MS 的分工：
//   • PRESENCE_TIMEOUT_MS(60s) —— **面向客户端的时间戳新鲜度口径**（host 租约 / wakeReachable，只看
//     presence.last_seen / ts）。本次不动，host failover / 可唤醒判定语义完全不变。
//   • PRESENCE_SCAN_MS(120s)   —— **服务端回收半开 WS 连接的静默阈值 + alarm 重挂间隔**。客户端每 25s
//     ping（cli/web 一致），健康连接永远够不到 120s 静默，不会误回收；真半开的连接在其最后一次 ping 后
//     ≤PRESENCE_SCAN_MS + 一个 ping 间隔内被标 offline（#487 验收：≤2× 新间隔，自适应下实测≈1×）。
export const PRESENCE_SCAN_MS = 2 * PRESENCE_TIMEOUT_MS;
export const HELLO_TIMEOUT_MS = 8_000;

const STATUS_STATES: readonly string[] = ["working", "waiting", "blocked", "done"];
const COLLAB_ROLES: readonly string[] = ["host", "worker", "reviewer", "observer"];
const ROLE_SOURCES: readonly string[] = ["self", "assigned"];
const RESIDENCIES: readonly string[] = ["supervised", "webhook", "bare", "human_driven", "unknown"];
const WAKE_KINDS: readonly string[] = ["none", "watch", "serve", "webhook"];
// agent-webhook 接到 2xx 只证明通知越过 HTTP 边界，不能冒充 replied。给外部 harness
// 留出完成模型 turn 并回频道的时间；期间同一 principal 的 serve/watch 不得重复执行。
const DIRECTED_WEBHOOK_LEASE_MS = 10 * 60_000;
const HOST_DECISION_KINDS: readonly string[] = ["decision", "handoff", "takeover"];
const WORKFLOW_KINDS: readonly string[] = ["pipeline", "parallel", "orchestrator-workers", "evaluator-optimizer"];
const MENTION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
// #165：mentions 数组现在也能装 unicode @昵称（中文），故用放开首字的 unicode 版校验它；
// MENTION_NAME_RE 仍保 ASCII，用于 squad / lineage / handoff 这些结构性标识符。
const MENTION_TOKEN_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const WORKFLOW_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CLIENT_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const MAX_MENTIONS = 50;
const MENTIONS_JSON_LIMIT = 4096;
const MAX_STATUS_SCOPE = 50;
const STATUS_SCOPE_JSON_LIMIT = 4096;
const STATUS_DECISION_JSON_LIMIT = 4096;
const STATUS_WORKFLOW_JSON_LIMIT = 4096;
const MAX_COMPLETION_RELATED = 20;
// #129：hello 首连补拉的分页大小。REST /internal/messages 早有 limit=1000；hello 曾无 LIMIT，
// 单次把最多 1 万行一并 toArray 序列化。改为按 seq 分页多批下发（每批 ≤ 此值）——单条查询恒有界，
// 又不砍完整性：循环直到某页短于一页即判排空，跨批次仍下发全部消息（客户端逐帧消费，与不分页无差别）。
const HELLO_BACKFILL_PAGE_SIZE = 1000;
const COMPLETION_ARTIFACT_JSON_LIMIT = 4096;
const REVIEW_REASON_LIMIT = 4000;
// #106：workflow guard 近期 (step,state) 窗口大小。8 足以罩住多 agent 在若干状态间的环形 ping-pong
// （长度 ≤8 的循环里，重访的 tuple 仍在窗口内 → 被判非进展 → 计数累加直到 trip）；又足够小，
// 让真正线性推进的工作流（每帧都是新 step）永远命中「窗口内没见过」→ 判进展 → 永不误伤。
const WORKFLOW_GUARD_WINDOW = 8;
// Durable work cannot outlive its operator indefinitely. Even when message history retention is
// explicitly off, active delivery capability/lineage expires after 30 days and its terminal audit
// row is retained for another 7 days. This is far above the hours-long offline replay contract while
// keeping permanently offline agents and abandoned owner questions bounded.
const DIRECTED_DELIVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DIRECTED_DELIVERY_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function parseClientVersion(input: unknown): string | null {
  return typeof input === "string" && CLIENT_VERSION_RE.test(input) ? input : null;
}

function parseMentions(input: unknown): string[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  if (
    input.length > MAX_MENTIONS ||
    input.some((m) => typeof m !== "string" || !MENTION_TOKEN_RE.test(m)) ||
    byteLength(JSON.stringify(input)) > MENTIONS_JSON_LIMIT
  ) {
    return null;
  }
  return input as string[];
}

// 正文与显式 mentions 数组必须走同一条服务端决议路径。词法规则与 web 共用
// @agentparty/shared/mentions：中文正文可无空格（请@小明），email/URL/ASCII 单词内部的 @ 不算。
// 这里只做 union；真实目标、大小写和昵称/display 唯一性在 INSERT 前由 resolveMentions 校验。
function mergeBodyMentions(explicit: string[], text: string): string[] | null {
  const seen = new Set(explicit.map(mentionMatchKey));
  const out = [...explicit];
  for (const mention of extractMentionTokens(text)) {
    const name = mention.value;
    const key = mentionMatchKey(name);
    if (seen.has(key)) continue;
    if (out.length >= MAX_MENTIONS) return null;
    seen.add(key);
    out.push(name);
  }
  return byteLength(JSON.stringify(out)) <= MENTIONS_JSON_LIMIT ? out : null;
}

function withExpandedMentions(frame: SendFrame, mentions: string[]): SendFrame {
  return frame.kind === "message"
    ? { ...frame, mentions }
    : { ...frame, mentions };
}

function parseStoredTargetNames(input: unknown): string[] {
  if (typeof input !== "string") return [];
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string" || !MENTION_NAME_RE.test(value)) continue;
      const key = mentionMatchKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(value);
    }
    return targets;
  } catch {
    return [];
  }
}

function parseStatusScope(input: unknown): string[] | undefined | null {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return null;
  if (
    input.length > MAX_STATUS_SCOPE ||
    input.some((item) => typeof item !== "string" || item.trim() === "") ||
    byteLength(JSON.stringify(input)) > STATUS_SCOPE_JSON_LIMIT
  ) {
    return null;
  }
  return input as string[];
}

function parseOptionalPositiveSeq(input: unknown): number | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input === "number" && Number.isInteger(input) && input > 0) return input;
  return undefined;
}

function parsePositiveIntArray(input: unknown): number[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_COMPLETION_RELATED) return null;
  const out: number[] = [];
  for (const item of input) {
    if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) return null;
    out.push(item);
  }
  return out;
}

function parseCompletionArtifact(input: unknown, replyTo: number | null): CompletionArtifact | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (raw.kind !== "final_synthesis") return null;
  const kickoffSeq = parseOptionalPositiveSeq(raw.kickoff_seq);
  if (kickoffSeq === undefined || kickoffSeq === null) return null;
  if (replyTo !== kickoffSeq) return null;
  if (typeof raw.replies_count !== "number" || !Number.isInteger(raw.replies_count) || raw.replies_count < 0) {
    return null;
  }
  if (typeof raw.timeout !== "boolean") return null;
  const relatedIssues = parsePositiveIntArray(raw.related_issues);
  const relatedPrs = parsePositiveIntArray(raw.related_prs);
  if (relatedIssues === null || relatedPrs === null) return null;
  const taskId = parseOptionalPositiveSeq(raw.task_id);
  if (taskId === null) return null;
  const artifact: CompletionArtifact = {
    kind: "final_synthesis",
    kickoff_seq: kickoffSeq,
    replies_count: raw.replies_count,
    timeout: raw.timeout,
    related_issues: relatedIssues,
    related_prs: relatedPrs,
    ...(taskId === undefined ? {} : { task_id: taskId }),
  };
  if (byteLength(JSON.stringify(artifact)) > COMPLETION_ARTIFACT_JSON_LIMIT) return null;
  return artifact;
}

// 解析客户端发来的 decision_request（#284）。undefined = 无（不是决策消息）；null = 结构非法（拒收）。
// kind 缺省 approval；approval 恒用 approve/reject，忽略自带 options；choice 需 1..N 个非空选项。
function parseDecisionRequest(input: unknown): DecisionRequest | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.prompt !== "string") return null;
  const prompt = raw.prompt.trim();
  if (prompt === "" || byteLength(prompt) > DECISION_PROMPT_LIMIT) return null;
  if (raw.kind !== undefined && raw.kind !== "approval" && raw.kind !== "choice") return null;
  const kind: DecisionKind = raw.kind === "choice" ? "choice" : "approval";
  if (kind === "approval") {
    return { kind, prompt, options: ["approve", "reject"] };
  }
  if (!Array.isArray(raw.options)) return null;
  const options: string[] = [];
  for (const opt of raw.options) {
    if (typeof opt !== "string") return null;
    const trimmed = opt.trim();
    if (trimmed === "" || byteLength(trimmed) > DECISION_OPTION_LIMIT) return null;
    options.push(trimmed);
  }
  if (options.length < 2 || options.length > DECISION_OPTIONS_MAX) return null;
  return { kind, prompt, options };
}

// Managed REST asks keep the responder account beside the public decision payload. Like lineage,
// this is an authenticated compare-and-set capability and never enters a public message frame.
function parseExpectedDecisionResponderOwner(input: unknown): string | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "string") return null;
  const owner = input.trim();
  if (
    owner.length < 1 ||
    byteLength(owner) > DECISION_RESPONDER_OWNER_LIMIT ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(owner)
  ) return null;
  return owner;
}

// Authenticated REST decision asks may carry a compare-and-set precondition. It is intentionally
// separate from decision_request: the latter is public message content, while these identifiers are
// executor capabilities used only to reject a stale/wrong runner before any message is committed.
function parseExpectedDecisionLineage(input: unknown): ExpectedDecisionLineage | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.delivery_id !== "string" ||
    raw.delivery_id.length < 1 ||
    raw.delivery_id.length > 128 ||
    typeof raw.work_id !== "string" ||
    raw.work_id.length < 1 ||
    raw.work_id.length > DELIVERY_WORK_ID_LIMIT ||
    typeof raw.continuation_ref !== "string" ||
    raw.continuation_ref.length < 1 ||
    raw.continuation_ref.length > DELIVERY_CONTINUATION_REF_LIMIT
  ) return null;
  return {
    delivery_id: raw.delivery_id,
    work_id: raw.work_id,
    continuation_ref: raw.continuation_ref,
  };
}

// Decision lineage and the responder binding are server-owned. The public send parser above
// intentionally drops client-supplied nested fields; only persisted Worker output comes through
// these stricter parsers.
function parseStoredDecisionLineage(raw: Record<string, unknown>): DecisionDeliveryLineage | undefined {
  const fields = [raw.delivery_id, raw.origin_seq, raw.origin_channel, raw.work_id, raw.continuation_ref];
  if (fields.every((value) => value === undefined)) return undefined;
  if (
    typeof raw.delivery_id !== "string" ||
    raw.delivery_id.length < 1 ||
    raw.delivery_id.length > 128 ||
    typeof raw.origin_seq !== "number" ||
    !Number.isSafeInteger(raw.origin_seq) ||
    raw.origin_seq <= 0 ||
    typeof raw.origin_channel !== "string" ||
    raw.origin_channel.length < 1 ||
    byteLength(raw.origin_channel) > DELIVERY_ORIGIN_CHANNEL_LIMIT ||
    typeof raw.work_id !== "string" ||
    raw.work_id.length < 1 ||
    raw.work_id.length > DELIVERY_WORK_ID_LIMIT ||
    typeof raw.continuation_ref !== "string" ||
    raw.continuation_ref.length < 1 ||
    raw.continuation_ref.length > DELIVERY_CONTINUATION_REF_LIMIT
  ) {
    return undefined;
  }
  return {
    delivery_id: raw.delivery_id,
    origin_seq: raw.origin_seq,
    origin_channel: raw.origin_channel,
    work_id: raw.work_id,
    continuation_ref: raw.continuation_ref,
  };
}

function parseStoredDecisionRequest(input: unknown): DecisionRequest | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    const raw = JSON.parse(input) as unknown;
    const parsed = parseDecisionRequest(raw);
    if (parsed === null || parsed === undefined) return undefined;
    const rawRecord = typeof raw === "object" && raw !== null
      ? raw as Record<string, unknown>
      : undefined;
    const lineage = rawRecord === undefined ? undefined : parseStoredDecisionLineage(rawRecord);
    const expectedResponderOwner = rawRecord === undefined
      ? undefined
      : parseExpectedDecisionResponderOwner(rawRecord.expected_responder_owner);
    // Server-owned lineage is all-or-nothing. Treat a partially retained/corrupted capability as
    // an invalid decision request rather than silently downgrading it to an unbound question.
    if (
      lineage === undefined &&
      rawRecord !== undefined &&
      ["delivery_id", "origin_seq", "origin_channel", "work_id", "continuation_ref"]
        .some((key) => Object.prototype.hasOwnProperty.call(rawRecord, key))
    ) return undefined;
    if (expectedResponderOwner === null) return undefined;
    return {
      ...parsed,
      ...(lineage === undefined ? {} : lineage),
      ...(expectedResponderOwner === undefined ? {} : { expected_responder_owner: expectedResponderOwner }),
    };
  } catch {
    return undefined;
  }
}

function parseStoredDecisionResolution(r: Record<string, unknown>): DecisionResolution | undefined {
  if (r.decision_state === null || r.decision_state === undefined) return undefined;
  const state = String(r.decision_state) as DecisionState;
  if (r.decision_resolution_json === null || r.decision_resolution_json === undefined) {
    return { state };
  }
  try {
    const raw = JSON.parse(String(r.decision_resolution_json)) as Record<string, unknown>;
    const resolution: DecisionResolution = { state };
    if (typeof raw.chosen_index === "number") resolution.chosen_index = raw.chosen_index;
    if (typeof raw.chosen_option === "string") resolution.chosen_option = raw.chosen_option;
    if (raw.responder !== undefined && raw.responder !== null && typeof raw.responder === "object") {
      const rp = raw.responder as Record<string, unknown>;
      if (typeof rp.name === "string") {
        resolution.responder = {
          name: rp.name,
          kind: rp.kind === "human" || rp.kind === "agent" ? (rp.kind as SenderKind) : "human",
          ...(typeof rp.owner === "string" ? { owner: rp.owner } : {}),
        };
      }
    }
    if (typeof raw.responder_owner === "string") resolution.responder_owner = raw.responder_owner;
    if (typeof raw.responded_at === "number") resolution.responded_at = raw.responded_at;
    if (typeof raw.reason === "string") resolution.reason = raw.reason;
    return resolution;
  } catch {
    return { state };
  }
}

function parseStoredDecisionResponse(input: unknown): DecisionResponse | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    const raw = JSON.parse(input) as Record<string, unknown>;
    if (typeof raw.request_seq !== "number" || typeof raw.chosen_index !== "number" || typeof raw.chosen_option !== "string") {
      return undefined;
    }
    const lineage = parseStoredDecisionLineage(raw);
    const prompt =
      typeof raw.prompt === "string" && raw.prompt.length > 0 && byteLength(raw.prompt) <= DECISION_PROMPT_LIMIT
        ? raw.prompt
        : undefined;
    const reason =
      typeof raw.reason === "string" && byteLength(raw.reason) <= DECISION_REASON_LIMIT
        ? raw.reason
        : undefined;
    return {
      request_seq: raw.request_seq,
      chosen_index: raw.chosen_index,
      chosen_option: raw.chosen_option,
      ...(prompt === undefined ? {} : { prompt }),
      ...(reason === undefined || reason === "" ? {} : { reason }),
      ...(lineage === undefined ? {} : lineage),
    };
  } catch {
    return undefined;
  }
}

// Delivery/work/continuation identifiers are executor capabilities, not channel-history fields.
// Keep the full lineage in storage and exact-target delivery frames, while every public message
// surface receives an explicit allowlist projection. This also makes future lineage additions
// fail closed instead of silently becoming public.
function publicDecisionRequest(request: DecisionRequest): DecisionRequest {
  return {
    kind: request.kind,
    prompt: request.prompt,
    options: [...request.options],
  };
}

function publicDecisionResponse(response: DecisionResponse): DecisionResponse {
  return {
    request_seq: response.request_seq,
    chosen_index: response.chosen_index,
    chosen_option: response.chosen_option,
    ...(response.prompt === undefined ? {} : { prompt: response.prompt }),
    ...(response.reason === undefined ? {} : { reason: response.reason }),
  };
}

function publicMsgFrame(frame: MsgFrame): MsgFrame {
  if (frame.decision_request === undefined && frame.decision_response === undefined) return frame;
  return {
    ...frame,
    ...(frame.decision_request === undefined
      ? {}
      : { decision_request: publicDecisionRequest(frame.decision_request) }),
    ...(frame.decision_response === undefined
      ? {}
      : { decision_response: publicDecisionResponse(frame.decision_response) }),
  };
}

function publicServerFrame(frame: ServerFrame): ServerFrame {
  if (frame.type === "msg" || frame.type === "status") return publicMsgFrame(frame);
  if (frame.type === "message_update") {
    return { ...frame, message: publicMsgFrame(frame.message) };
  }
  return frame;
}

function parseStoredCompletionArtifact(input: unknown): CompletionArtifact | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    const parsed = JSON.parse(input) as unknown;
    const artifact = parseCompletionArtifact(parsed, (parsed as { kickoff_seq?: unknown } | null)?.kickoff_seq as number | null);
    return artifact ?? undefined;
  } catch {
    return undefined;
  }
}


function parseStoredCompletionReview(r: Record<string, unknown>): CompletionReview | undefined {
  if (r.completion_review_state === null || r.completion_review_state === undefined) return undefined;
  const state = String(r.completion_review_state) as CompletionReviewState;
  const policy =
    r.completion_review_policy === null || r.completion_review_policy === undefined
      ? "sender"
      : (String(r.completion_review_policy) as CompletionReviewPolicy);
  const reviewer =
    r.completion_reviewed_by === null || r.completion_reviewed_by === undefined
      ? undefined
      : {
          name: String(r.completion_reviewed_by),
          kind:
            r.completion_reviewed_by_kind === "human" || r.completion_reviewed_by_kind === "agent"
              ? (String(r.completion_reviewed_by_kind) as SenderKind)
              : "agent",
          ...(r.completion_reviewed_by_owner === null || r.completion_reviewed_by_owner === undefined
            ? {}
            : { owner: String(r.completion_reviewed_by_owner) }),
        };
  return {
    state,
    policy,
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(r.completion_reviewed_by_owner === null || r.completion_reviewed_by_owner === undefined
      ? {}
      : { reviewer_owner: String(r.completion_reviewed_by_owner) }),
    ...(r.completion_reviewed_at === null || r.completion_reviewed_at === undefined
      ? {}
      : { reviewed_at: Number(r.completion_reviewed_at) }),
    ...(r.completion_review_reason === null || r.completion_review_reason === undefined
      ? {}
      : { reason: String(r.completion_review_reason) }),
    ...(r.completion_review_replaces_seq === null || r.completion_review_replaces_seq === undefined
      ? {}
      : { replaces_seq: Number(r.completion_review_replaces_seq) }),
    ...(r.completion_review_replaced_by_seq === null || r.completion_review_replaced_by_seq === undefined
      ? {}
      : { replaced_by_seq: Number(r.completion_review_replaced_by_seq) }),
  };
}

function parseStoredScope(input: unknown): string[] {
  if (typeof input !== "string" || input === "") return [];
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function safeDecisionString(input: unknown, max: number): string | undefined | null {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > max) return null;
  return trimmed;
}

function parseSendHostDecision(input: unknown): SendHostDecision | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const kind =
    raw.kind === undefined
      ? undefined
      : typeof raw.kind === "string" && HOST_DECISION_KINDS.includes(raw.kind)
        ? (raw.kind as HostDecisionKind)
        : null;
  const decision = safeDecisionString(raw.decision, 500);
  const next = safeDecisionString(raw.next, 1000);
  if (kind === null || decision === null || decision === undefined || next === null) return null;
  const expiresAt =
    raw.expires_at === undefined || raw.expires_at === null
      ? undefined
      : typeof raw.expires_at === "number" && Number.isInteger(raw.expires_at) && raw.expires_at > 0
        ? raw.expires_at
        : null;
  if (expiresAt === null) return null;
  const handoffTo = safeDecisionString(raw.handoff_to, 64);
  const takeoverFrom = safeDecisionString(raw.takeover_from, 64);
  if (
    handoffTo === null ||
    takeoverFrom === null ||
    (handoffTo !== undefined && !MENTION_NAME_RE.test(handoffTo)) ||
    (takeoverFrom !== undefined && !MENTION_NAME_RE.test(takeoverFrom))
  ) {
    return null;
  }
  const decisionFrame: SendHostDecision = {
    ...(kind === undefined ? {} : { kind }),
    decision,
    ...(next === undefined ? {} : { next }),
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    ...(handoffTo === undefined ? {} : { handoff_to: handoffTo }),
    ...(takeoverFrom === undefined ? {} : { takeover_from: takeoverFrom }),
  };
  return byteLength(JSON.stringify(decisionFrame)) > STATUS_DECISION_JSON_LIMIT ? null : decisionFrame;
}

function hostDecisionFromSend(input: SendHostDecision | undefined, owner: string): HostDecision | undefined {
  if (input === undefined) return undefined;
  return {
    kind: input.kind ?? "decision",
    owner,
    decision: input.decision,
    next: input.next ?? null,
    expires_at: input.expires_at ?? null,
    ...(input.handoff_to === undefined || input.handoff_to === null ? {} : { handoff_to: input.handoff_to }),
    ...(input.takeover_from === undefined || input.takeover_from === null ? {} : { takeover_from: input.takeover_from }),
  };
}

function parseStoredHostDecision(input: unknown, owner: string): HostDecision | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    return hostDecisionFromSend(parseSendHostDecision(JSON.parse(input) as unknown) ?? undefined, owner);
  } catch {
    return undefined;
  }
}

function safeWorkflowId(input: unknown): string | undefined | null {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!WORKFLOW_ID_RE.test(trimmed)) return null;
  return trimmed;
}

function parseSendStatusWorkflow(input: unknown): SendStatusWorkflow | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const workflowId = safeWorkflowId(raw.workflow_id);
  const kind = typeof raw.kind === "string" && WORKFLOW_KINDS.includes(raw.kind) ? (raw.kind as WorkflowKind) : null;
  const runId = safeWorkflowId(raw.run_id);
  const stepId = safeWorkflowId(raw.step_id);
  if (workflowId === null || workflowId === undefined || kind === null || runId === null || stepId === null) {
    return null;
  }
  const parentSummarySeq = parseOptionalPositiveSeq(raw.parent_summary_seq);
  if (parentSummarySeq === undefined && raw.parent_summary_seq !== undefined) return null;
  const workflow: SendStatusWorkflow = {
    workflow_id: workflowId,
    kind,
    ...(runId === undefined ? {} : { run_id: runId }),
    ...(stepId === undefined ? {} : { step_id: stepId }),
    ...(parentSummarySeq === undefined ? {} : { parent_summary_seq: parentSummarySeq }),
  };
  return byteLength(JSON.stringify(workflow)) > STATUS_WORKFLOW_JSON_LIMIT ? null : workflow;
}

function statusWorkflowFromSend(input: SendStatusWorkflow | undefined): StatusWorkflow | undefined {
  if (input === undefined) return undefined;
  return {
    workflow_id: input.workflow_id,
    kind: input.kind,
    run_id: input.run_id ?? null,
    step_id: input.step_id ?? null,
    parent_summary_seq: input.parent_summary_seq ?? null,
  };
}

// #106：workflow guard 近期窗口的 tuple 键。step_id / state 均不含 \u0000，用它当分隔符杜绝歧义拼接。
function workflowTupleKey(stepId: string | null, state: StatusState | null): string {
  return `${stepId ?? ""}\u0000${state ?? ""}`;
}

// 存量行 recent_tuples 为 NULL / 脏数据时安全退回 []（等价于「窗口里什么都没见过」）。
function parseWorkflowGuardTuples(input: unknown): string[] {
  if (typeof input !== "string" || input === "") return [];
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(-WORKFLOW_GUARD_WINDOW) : [];
  } catch {
    return [];
  }
}

function parseStoredStatusWorkflow(input: unknown): StatusWorkflow | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    return statusWorkflowFromSend(parseSendStatusWorkflow(JSON.parse(input) as unknown) ?? undefined);
  } catch {
    return undefined;
  }
}

function statusEventFromRow(r: Record<string, unknown>, owner: string, state: StatusState, updatedAt: number): StatusEvent {
  const decision = parseStoredHostDecision(r.status_decision_json, owner);
  const workflow = parseStoredStatusWorkflow(r.status_workflow_json);
  return {
    owner,
    state,
    scope: parseStoredScope(r.status_scope_json),
    summary_seq: r.status_summary_seq === null || r.status_summary_seq === undefined ? null : Number(r.status_summary_seq),
    blocked_reason:
      r.status_blocked_reason === null || r.status_blocked_reason === undefined
        ? null
        : String(r.status_blocked_reason),
    updated_at: updatedAt,
    ...(() => {
      const context = parseStoredAgentContext(r.status_context_json);
      return context === undefined ? {} : { context };
    })(),
    ...(decision === undefined ? {} : { decision }),
    ...(workflow === undefined ? {} : { workflow }),
  };
}

function parseCollaborationRole(input: unknown): CollaborationRole | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !COLLAB_ROLES.includes(input)) return null;
  return input as CollaborationRole;
}

// undefined = 调用方没传（用默认值）；null = 传了但非法（400）。同 parseCollaborationRole 的三态约定。
function statusStateFrom(input: unknown): StatusState | undefined | null {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "string" || !STATUS_STATES.includes(input)) return null;
  return input as StatusState;
}

function parseRoleSource(input: unknown): CollaborationRoleSource | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !ROLE_SOURCES.includes(input)) return null;
  return input as CollaborationRoleSource;
}

function parseResidency(input: unknown): Residency | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !RESIDENCIES.includes(input)) return null;
  return input as Residency;
}

function parseWake(input: unknown): WakeInfo | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) return null;
  const w = input as Record<string, unknown>;
  if (typeof w.kind !== "string" || !WAKE_KINDS.includes(w.kind)) return null;
  if (w.verified_at !== undefined && (typeof w.verified_at !== "number" || !Number.isInteger(w.verified_at))) {
    return null;
  }
  return w.verified_at === undefined
    ? { kind: w.kind as WakeKind }
    : { kind: w.kind as WakeKind, verified_at: w.verified_at };
}

function parseStoredAgentContext(input: unknown): AgentContext | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    return parseAgentContext(JSON.parse(input) as unknown) ?? undefined;
  } catch {
    return undefined;
  }
}

function parseStoredLineage(input: unknown): AgentLineage | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    return parseLineage(JSON.parse(input) as unknown) ?? undefined;
  } catch {
    return undefined;
  }
}

// DO 未捕获异常的应用级日志：Cloudflare 对 DO 抛出的异常只回不透明的 "internal error; reference"，
// tail 里 exceptions 也是空的，等于对自己的异常完全失明。在 onRequest/onMessage 边界记一条带频道与
// 真实堆栈的日志，让下次同类瞬时故障能直接在 wrangler tail 里定位，而不是靠猜。
function logDoException(entry: string, channel: string, err: unknown, ctx = ""): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`ChannelDO ${entry} uncaught channel=${channel}${ctx ? ` ${ctx}` : ""}: ${detail}`);
}

// mentions_json 是唯一没兜底的读路径 JSON 解析（其余都 try/catch 或走 parseStored* 守卫）。
// 一旦某行存进空串或坏 JSON（NOT NULL DEFAULT '[]' 挡得住漏写，挡不住显式写入 ''），
// 裸 JSON.parse('') 会抛未捕获异常，整条频道的 messages/hello 回填全 500。按其余存储解析同样
// 的模式兜底：空/坏值当作无 mentions，绝不因一行坏数据拖垮整个频道读路径。
function parseStoredMentions(input: unknown): string[] {
  if (typeof input !== "string" || input === "") return [];
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function parseLineage(input: unknown): AgentLineage | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.parent_agent !== "string" ||
    !MENTION_NAME_RE.test(raw.parent_agent) ||
    typeof raw.root_agent !== "string" ||
    !MENTION_NAME_RE.test(raw.root_agent) ||
    typeof raw.team_id !== "string" ||
    !MENTION_NAME_RE.test(raw.team_id) ||
    typeof raw.depth !== "number" ||
    !Number.isInteger(raw.depth) ||
    raw.depth < 1 ||
    raw.depth > 16
  ) {
    return null;
  }
  if (raw.expires_at !== null && (typeof raw.expires_at !== "number" || !Number.isInteger(raw.expires_at))) {
    return null;
  }
  return {
    parent_agent: raw.parent_agent,
    root_agent: raw.root_agent,
    team_id: raw.team_id,
    depth: raw.depth,
    expires_at: raw.expires_at,
  };
}

function lineageFromHeaders(headers: Headers): AgentLineage | undefined {
  const parent = headers.get("x-ap-parent-agent");
  const root = headers.get("x-ap-root-agent");
  const team = headers.get("x-ap-team-id");
  const depth = Number(headers.get("x-ap-spawn-depth") ?? "");
  const expiresRaw = headers.get("x-ap-child-expires-at");
  if (parent === null && root === null && team === null && headers.get("x-ap-spawn-depth") === null && expiresRaw === null) {
    return undefined;
  }
  const lineage = parseLineage({
    parent_agent: parent,
    root_agent: root,
    team_id: team,
    depth,
    expires_at: expiresRaw === null ? null : Number(expiresRaw),
  });
  return lineage ?? undefined;
}

function senderFromIdentity(identity: Pick<Identity, "name" | "kind" | "owner" | "handle" | "displayName" | "avatarUrl" | "avatarThumb" | "lineage" | "clientVersion">): Sender {
  return {
    name: identity.name,
    kind: identity.kind,
    ...(identity.owner === undefined ? {} : { owner: identity.owner }),
    ...(identity.lineage === undefined ? {} : { lineage: identity.lineage }),
    ...(identity.handle === undefined ? {} : { handle: identity.handle }),
    ...(identity.displayName === undefined ? {} : { display_name: identity.displayName }),
    ...(identity.avatarUrl === undefined ? {} : { avatar_url: identity.avatarUrl }),
    ...(identity.avatarThumb === undefined ? {} : { avatar_thumb: identity.avatarThumb }),
    ...(identity.clientVersion === undefined ? {} : { client_version: identity.clientVersion }),
  };
}

function headerText(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  if (value === null || value === "") return undefined;
  return value;
}

function decodedHeaderText(headers: Headers, name: string): string | undefined {
  const value = headerText(headers, name);
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function profileFromHeaders(headers: Headers): Pick<Identity, "displayName" | "avatarUrl" | "avatarThumb"> {
  return {
    displayName: decodedHeaderText(headers, "x-ap-display-name"),
    avatarUrl: headerText(headers, "x-ap-avatar-url"),
    avatarThumb: headerText(headers, "x-ap-avatar-thumb"),
  };
}

function safeContextString(input: unknown, max = 160): string | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > max) return null;
  return trimmed;
}

function parseAgentContext(input: unknown): AgentContext | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const configKind = raw.config_kind;
  if (configKind !== undefined && !["explicit", "workspace", "global", "none"].includes(String(configKind))) {
    return null;
  }
  const configFingerprint = safeContextString(raw.config_fingerprint, 80);
  const workspaceId = safeContextString(raw.workspace_id, 128);
  const workspaceLabel = safeContextString(raw.workspace_label, 80);
  const worktreeLabel = safeContextString(raw.worktree_label, 120);
  if (configFingerprint === null || workspaceId === null || workspaceLabel === null || worktreeLabel === null) {
    return null;
  }
  return {
    ...(configKind === undefined ? {} : { config_kind: String(configKind) as AgentContext["config_kind"] }),
    ...(configFingerprint === undefined ? {} : { config_fingerprint: configFingerprint }),
    ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
    ...(workspaceLabel === undefined ? {} : { workspace_label: workspaceLabel }),
    ...(worktreeLabel === undefined ? {} : { worktree_label: worktreeLabel }),
  };
}

// parseSendFrame 返回 null 时用它给出更具体的拒收原因：role 拼错是 agent 自报协作角色最常见的坑，
// 单独识别并回明确文案（列出合法值），而不是笼统的 "invalid send payload"，让 agent 能自我纠正。
function sendRejectMessage(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "invalid send payload";
  const f = raw as { kind?: unknown; role?: unknown };
  if (f.kind === "status" && f.role !== undefined && parseCollaborationRole(f.role) === null) {
    return `role must be one of: ${COLLAB_ROLES.join(", ")}`;
  }
  return "invalid send payload";
}

// 幂等键（#98）：仅接受非空、长度受限的字符串；异常值静默丢弃（不因它拒收整条 send，向后兼容）。
function parseIdempotencyKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.length === 0 || raw.length > IDEMPOTENCY_KEY_MAX) return undefined;
  return raw;
}

// 附件引用校验（#176）已抽到 ./attachments，消息与任务（#369）共用同一实现。parseAttachments /
// parseStoredAttachments / MAX_ATTACHMENTS 见该模块（顶部 import）。

// rest body 与 ws send 帧共用的校验（rest 侧无 type 字段）
function parseSendFrame(input: unknown): SendFrame | null {
  if (typeof input !== "object" || input === null) return null;
  const f = input as Record<string, unknown>;
  const idempotencyKey = parseIdempotencyKey(f.idempotency_key);
  if (f.kind === "message") {
    if (typeof f.body !== "string") return null;
    const explicit = parseMentions(f.mentions);
    if (explicit === null) return null;
    // 正文里的 @name 也当 mention（否则裸 party send "@name" 不会唤醒目标）
    const mentions = mergeBodyMentions(explicit, f.body);
    if (mentions === null) return null;
    const reply_to =
      f.reply_to === undefined || f.reply_to === null
        ? null
        : typeof f.reply_to === "number" && Number.isInteger(f.reply_to) && f.reply_to > 0
          ? f.reply_to
          : undefined;
    if (reply_to === undefined) return null;
    const completionArtifact = parseCompletionArtifact(f.completion_artifact, reply_to);
    if (completionArtifact === null) return null;
    const decisionRequest = parseDecisionRequest(f.decision_request);
    if (decisionRequest === null) return null;
    // 一条消息不能既是 completion 又是 decision_request——两种结构化审批语义互斥，避免落库/渲染歧义。
    if (decisionRequest !== undefined && completionArtifact !== undefined) return null;
    const attachments = parseAttachments(f.attachments);
    if (attachments === null) return null;
    let replaces: number | undefined;
    if (f.replaces !== undefined) {
      if (typeof f.replaces !== "number" || !Number.isInteger(f.replaces) || f.replaces <= 0) return null;
      replaces = f.replaces;
    }
    return {
      type: "send",
      kind: "message",
      body: f.body,
      mentions,
      reply_to,
      ...(completionArtifact !== undefined ? { completion_artifact: completionArtifact } : {}),
      ...(decisionRequest !== undefined ? { decision_request: decisionRequest } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(completionArtifact !== undefined && replaces !== undefined ? { replaces } : {}),
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
    };
  }
  if (f.kind === "status") {
    if (f.completion_artifact !== undefined) return null;
    if (typeof f.state !== "string" || !STATUS_STATES.includes(f.state)) return null;
    const note = typeof f.note === "string" ? f.note : "";
    const explicit = parseMentions(f.mentions);
    if (explicit === null) return null;
    // status 的 note 里 @name 同样兜底提取（如「@leo blocked on X」应唤醒 leo）
    const mentions = mergeBodyMentions(explicit, note);
    if (mentions === null) return null;
    const role = parseCollaborationRole(f.role);
    if (role === null) return null;
    const residency = parseResidency(f.residency);
    if (residency === null) return null;
    const wake = parseWake(f.wake);
    if (wake === null) return null;
    const context = parseAgentContext(f.context);
    if (context === null) return null;
    const scope = parseStatusScope(f.scope);
    if (scope === null) return null;
    const summarySeq = parseOptionalPositiveSeq(f.summary_seq);
    if (summarySeq === undefined && f.summary_seq !== undefined) return null;
    const blockedReason =
      f.blocked_reason === undefined || f.blocked_reason === null
        ? undefined
        : typeof f.blocked_reason === "string"
          ? f.blocked_reason
          : null;
    if (blockedReason === null) return null;
    const decision = parseSendHostDecision(f.decision);
    if (decision === null) return null;
    const workflow = parseSendStatusWorkflow(f.workflow);
    if (workflow === null) return null;
    // busy（#103）：serve 串行处理时自报「忙」。只认 boolean；false 也保留（用于把 busy 显式清回空闲）。
    if (f.busy !== undefined && typeof f.busy !== "boolean") return null;
    const busy = f.busy as boolean | undefined;
    // queue_depth（#103）：非负整数，封顶防脏值撑爆展示。非法/负数 → 拒收（parseSendFrame 返 null）。
    const queueDepth =
      f.queue_depth === undefined
        ? undefined
        : typeof f.queue_depth === "number" && Number.isInteger(f.queue_depth) && f.queue_depth >= 0
          ? Math.min(f.queue_depth, 100_000)
          : null;
    if (queueDepth === null) return null;
    const agentSession = f.agent_session === undefined ? undefined : parseAgentSessionInfo(f.agent_session);
    if (f.agent_session !== undefined && agentSession === undefined) return null;
    return {
      type: "send",
      kind: "status",
      state: f.state as StatusState,
      note,
      mentions,
      ...(scope !== undefined ? { scope } : {}),
      ...(summarySeq !== undefined ? { summary_seq: summarySeq } : {}),
      ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(residency !== undefined ? { residency } : {}),
      ...(wake !== undefined ? { wake } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(decision !== undefined ? { decision } : {}),
      ...(workflow !== undefined ? { workflow } : {}),
      ...(busy !== undefined ? { busy } : {}),
      ...(queueDepth !== undefined ? { queue_depth: queueDepth } : {}),
      ...(agentSession === undefined ? {} : { agent_session: agentSession }),
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
    };
  }
  return null;
}

export interface ParsedTaskHeartbeat {
  current_task: number | null;
  task_started_at: number | null;
  heartbeat_at: number | null;
  activity?: AgentActivity;
  runner_health?: RunnerHealth;
  agent_session?: AgentSessionInfo;
}

function parseAgentSessionInfo(input: unknown): AgentSessionInfo | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = input as Record<string, unknown>;
  if (value.harness !== "codex" && value.harness !== "claude" && value.harness !== "codex-sdk") return undefined;
  if (typeof value.session_id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(value.session_id)) return undefined;
  if (typeof value.updated_at !== "number" || !Number.isSafeInteger(value.updated_at) || value.updated_at < 0) return undefined;
  const optionalPath = (field: unknown): string | undefined | false => {
    if (field === undefined) return undefined;
    return typeof field === "string" && field.length > 0 && field.length <= 2048 ? field : false;
  };
  const cwd = optionalPath(value.cwd);
  const workdir = optionalPath(value.workdir);
  if (cwd === false || workdir === false) return undefined;
  return {
    harness: value.harness,
    session_id: value.session_id,
    updated_at: value.updated_at,
    ...(cwd === undefined ? {} : { cwd }),
    ...(workdir === undefined ? {} : { workdir }),
  };
}

// 每任务心跳帧校验（#228）：三字段要么全是非负整数（活跃任务），要么各自 null（清除）。
// 混入负数/浮点/非数字 → 返回 null（整帧丢弃）。缺字段按 undefined→拒收，避免半截状态写脏 presence。
function parseHeartbeatFrame(input: unknown): ParsedTaskHeartbeat | null {
  if (typeof input !== "object" || input === null) return null;
  const f = input as Record<string, unknown>;
  const field = (v: unknown): number | null | undefined => {
    if (v === null) return null;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return Math.min(v, Number.MAX_SAFE_INTEGER);
    return undefined; // 非法
  };
  const current = field(f.current_task);
  const started = field(f.task_started_at);
  const heartbeat = field(f.heartbeat_at);
  if (current === undefined || started === undefined || heartbeat === undefined) return null;
  const agentSession = f.agent_session === undefined ? undefined : parseAgentSessionInfo(f.agent_session);
  if (f.agent_session !== undefined && agentSession === undefined) return null;
  // 模型 session 活动（#602）：可选捎带；脏 activity 与脏 agent_session 同口径——整帧丢弃。
  const activity = f.activity === undefined ? undefined : parseAgentActivity(f.activity);
  if (f.activity !== undefined && activity === undefined) return null;
  // runner 健康自报（#603）：同口径。
  const runnerHealth = f.runner_health === undefined ? undefined : parseRunnerHealth(f.runner_health);
  if (f.runner_health !== undefined && runnerHealth === undefined) return null;
  return {
    current_task: current,
    task_started_at: started,
    heartbeat_at: heartbeat,
    ...(activity === undefined ? {} : { activity }),
    ...(runnerHealth === undefined ? {} : { runner_health: runnerHealth }),
    ...(agentSession === undefined ? {} : { agent_session: agentSession }),
  };
}

function parseDeliveryUpdateFrame(input: unknown): DeliveryUpdateFrame | null {
  if (typeof input !== "object" || input === null) return null;
  const f = input as Record<string, unknown>;
  if (f.type !== "delivery_update") return null;
  if (typeof f.delivery_id !== "string" || f.delivery_id.length < 1 || f.delivery_id.length > 128) return null;
  if (f.state !== "running" && f.state !== "waiting_owner" && f.state !== "replied" && f.state !== "failed") return null;
  const optionalText = (value: unknown, limit: number): string | undefined | null => {
    if (value === undefined) return undefined;
    return typeof value === "string" && value.length > 0 && value.length <= limit ? value : null;
  };
  const workId = optionalText(f.work_id, DELIVERY_WORK_ID_LIMIT);
  const continuationRef = optionalText(f.continuation_ref, DELIVERY_CONTINUATION_REF_LIMIT);
  const requestId = optionalText(f.request_id, 128);
  const error = optionalText(f.error, DECISION_REASON_LIMIT);
  if (workId === null || continuationRef === null || requestId === null || error === null) return null;
  const replySeq =
    f.reply_seq === undefined
      ? undefined
      : typeof f.reply_seq === "number" && Number.isSafeInteger(f.reply_seq) && f.reply_seq > 0
        ? f.reply_seq
        : null;
  if (replySeq === null) return null;
  if (f.state === "failed" && error === undefined) return null;
  if (f.state !== "failed" && error !== undefined) return null;
  if (f.state !== "replied" && replySeq !== undefined) return null;
  return {
    type: "delivery_update",
    delivery_id: f.delivery_id,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    state: f.state,
    ...(workId === undefined ? {} : { work_id: workId }),
    ...(continuationRef === undefined ? {} : { continuation_ref: continuationRef }),
    ...(replySeq === undefined ? {} : { reply_seq: replySeq }),
    ...(error === undefined ? {} : { error }),
  };
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface WebhookRow {
  name: string;
  /** Immutable identity for one concrete registration. Re-registering the same name rotates it. */
  registrationId: string;
  url: string;
  secret: string;
  filter: WebhookFilter;
  mode: "notify" | "agent";
  targetOwner: string | null;
}

interface WebhookBinding {
  name: string;
  registrationId: string;
  mode: "notify" | "agent";
  targetOwner: string | null;
}

interface WorkflowGuardRow {
  workflow_id: string;
  kind: WorkflowKind;
  run_id: string | null;
  step_id: string | null;
  state: StatusState | null;
  count_since_progress: number;
  no_progress: number;
  // #106：本 run 内近期见过的 (step_id,state) tuple 环形窗口（最多 WORKFLOW_GUARD_WINDOW 个）。
  // 进展判定不再只比对紧邻上一帧——回到窗口里见过的 tuple = 非进展（振荡），只有从未见过的新 tuple 才算进展。
  recent_tuples: string[];
  blocked_seq: number | null;
  last_progress_seq: number | null;
  last_counted_seq: number | null;
  initiator_name: string | null;
  host_name: string | null;
  terminal: number;
  terminal_seq: number | null;
  updated_at: number;
}

interface WorkflowGuardDecision {
  workflow: StatusWorkflow;
  progressed: boolean;
  countable: boolean;
}

function toInt(value: string | null, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function firstMatchingField(frame: MsgFrame, query: string): SearchHit["match_field"] {
  const q = query.toLowerCase();
  if (frame.kind === "status" && (frame.note ?? "").toLowerCase().includes(q)) return "note";
  if (frame.body.toLowerCase().includes(q)) return "body";
  return "sender";
}

function snippetFor(frame: MsgFrame, field: SearchHit["match_field"]): string {
  const text = field === "sender" ? frame.sender.name : field === "note" ? (frame.note ?? "") : frame.body;
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

export class ChannelDO extends Server<Env> {
  static options = { hibernate: true };
  private atomicDeliveryEffects: AtomicDeliveryEffects | null = null;
  // 交互 lane 活动直报（#615）的服务端时钟节流标记：name → 上次接受时刻。内存态即可——
  // DO 休眠清空的代价只是偶尔多接受一次，而 client 自带 ts 不可信、不能当节流依据。
  private readonly activityPushAcceptedAt = new Map<string, number>();
  // partyserver can invoke async WebSocket handlers for the same connection while an earlier
  // frame is awaiting I/O. Preserve wire order explicitly: hello must finish token validation and
  // capability setup before an immediately-following serve lease / adapter / send frame runs.
  private readonly wsMessageTails = new Map<string, Promise<void>>();

  onStart() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY,
      sender_name TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      sender_owner TEXT,
      sender_lineage_json TEXT,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions_json TEXT NOT NULL DEFAULT '[]',
      delivery_targets_json TEXT NOT NULL DEFAULT '[]',
      reply_to INTEGER,
      state TEXT,
      note TEXT,
      status_scope_json TEXT,
      status_summary_seq INTEGER,
      status_blocked_reason TEXT,
      status_context_json TEXT,
      status_decision_json TEXT,
      status_workflow_json TEXT,
      message_workflow_json TEXT,
      sender_role TEXT,
      sender_role_source TEXT,
      completion_artifact_json TEXT,
      completion_review_state TEXT,
      completion_review_policy TEXT,
      completion_reviewed_by TEXT,
      completion_reviewed_by_kind TEXT,
      completion_reviewed_by_owner TEXT,
      completion_reviewed_at INTEGER,
      completion_review_reason TEXT,
      completion_review_replaces_seq INTEGER,
      completion_review_replaced_by_seq INTEGER,
      decision_request_json TEXT,
      decision_state TEXT,
      decision_resolution_json TEXT,
      decision_response_json TEXT,
      original_body TEXT,
      edited_at INTEGER,
      edited_by TEXT,
      retracted_at INTEGER,
      retracted_by TEXT,
      supersedes INTEGER,
      superseded_by INTEGER,
      ts INTEGER NOT NULL
    )`);
    // 历史消息也要带 sender 所属人：给早于本次的 do 表补列（新表已含，重复 ALTER 会抛，吞掉）
    try {
      sql.exec("ALTER TABLE messages ADD COLUMN sender_owner TEXT");
    } catch {
      // 列已存在
    }
    for (const ddl of [
      "ALTER TABLE messages ADD COLUMN sender_lineage_json TEXT",
      "ALTER TABLE messages ADD COLUMN status_scope_json TEXT",
      "ALTER TABLE messages ADD COLUMN status_summary_seq INTEGER",
      "ALTER TABLE messages ADD COLUMN status_blocked_reason TEXT",
      "ALTER TABLE messages ADD COLUMN status_context_json TEXT",
      "ALTER TABLE messages ADD COLUMN status_decision_json TEXT",
      "ALTER TABLE messages ADD COLUMN status_workflow_json TEXT",
      "ALTER TABLE messages ADD COLUMN message_workflow_json TEXT",
      "ALTER TABLE messages ADD COLUMN sender_role TEXT",
      "ALTER TABLE messages ADD COLUMN sender_role_source TEXT",
      "ALTER TABLE messages ADD COLUMN completion_artifact_json TEXT",
      "ALTER TABLE messages ADD COLUMN completion_review_state TEXT",
      "ALTER TABLE messages ADD COLUMN completion_review_policy TEXT",
      "ALTER TABLE messages ADD COLUMN completion_reviewed_by TEXT",
      "ALTER TABLE messages ADD COLUMN completion_reviewed_by_kind TEXT",
      "ALTER TABLE messages ADD COLUMN completion_reviewed_by_owner TEXT",
      "ALTER TABLE messages ADD COLUMN completion_reviewed_at INTEGER",
      "ALTER TABLE messages ADD COLUMN completion_review_reason TEXT",
      "ALTER TABLE messages ADD COLUMN completion_review_replaces_seq INTEGER",
      "ALTER TABLE messages ADD COLUMN completion_review_replaced_by_seq INTEGER",
      // 人类决策协议（#284）：DO 内建 SQLite 幂等补列，非 D1 迁移。decision_request_json 存请求 payload；
      // decision_state 单独成列以便裁剪时保护 pending 请求；resolution/response 存 JSON。
      "ALTER TABLE messages ADD COLUMN decision_request_json TEXT",
      "ALTER TABLE messages ADD COLUMN decision_state TEXT",
      "ALTER TABLE messages ADD COLUMN decision_resolution_json TEXT",
      "ALTER TABLE messages ADD COLUMN decision_response_json TEXT",
      "ALTER TABLE messages ADD COLUMN original_body TEXT",
      "ALTER TABLE messages ADD COLUMN edited_at INTEGER",
      "ALTER TABLE messages ADD COLUMN edited_by TEXT",
      "ALTER TABLE messages ADD COLUMN retracted_at INTEGER",
      "ALTER TABLE messages ADD COLUMN retracted_by TEXT",
      "ALTER TABLE messages ADD COLUMN supersedes INTEGER",
      "ALTER TABLE messages ADD COLUMN superseded_by INTEGER",
      // Compact exactly-once tombstone. Delivery rows may be pruned after their bounded audit
      // window, but editing the retained source must never recreate work for an old target.
      "ALTER TABLE messages ADD COLUMN delivery_targets_json TEXT NOT NULL DEFAULT '[]'",
      // 修订序号（issue #33）：每次编辑/撤回/超越递增，hello.since_rev 据此限定补拉重放范围
      "ALTER TABLE messages ADD COLUMN rev_seq INTEGER",
      // 迁移回填：历史修订行按 seq 赋 rev_seq（幂等，只补 NULL），让升级后的客户端能收到一次再推进游标
      `UPDATE messages SET rev_seq = seq
        WHERE rev_seq IS NULL
          AND (edited_at IS NOT NULL OR retracted_at IS NOT NULL OR supersedes IS NOT NULL OR superseded_by IS NOT NULL
               OR completion_review_state IS NOT NULL OR completion_review_replaced_by_seq IS NOT NULL)`,
      // 发送时快照人类 handle，同 sender_owner 手法
      "ALTER TABLE messages ADD COLUMN sender_handle TEXT",
      "ALTER TABLE messages ADD COLUMN sender_display_name TEXT",
      "ALTER TABLE messages ADD COLUMN sender_avatar_url TEXT",
      "ALTER TABLE messages ADD COLUMN sender_avatar_thumb TEXT",
      // 幂等键（#98）：客户端每次发送带一个 ULID，服务端按 (sender_name, idempotency_key) 去重。
      // 注：messages 表是 DO 内建 SQLite（ctx.storage.sql），不是 D1，故无需 worker/migrations 迁移文件。
      "ALTER TABLE messages ADD COLUMN idempotency_key TEXT",
      // 附件引用（#176）：存 Attachment[] 的 JSON，仅元数据（key/filename/type/size/url），blob 在 R2。
      "ALTER TABLE messages ADD COLUMN attachments_json TEXT",
      // 发送方 CLI 版本快照（#434）：发送即定格 sender 的 x-ap-client-version，随消息帧/历史下发，
      // 网页据此显示「该条来自哪个 CLI 版本」，落后于服务端最低版本时标警告。同 messages 其余列走 DO 内建
      // SQLite 幂等补列（非 D1 迁移）。缺头/网页/旧客户端为 NULL，消费方省略展示。
      "ALTER TABLE messages ADD COLUMN sender_client_version TEXT",
    ]) {
      try {
        sql.exec(ddl);
      } catch {
        // 列已存在
      }
    }
    // 幂等去重查询走 (sender_name, idempotency_key)；NULL 键（老客户端/非幂等发送）不进有效查询路径。
    sql.exec("CREATE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(sender_name, idempotency_key)");
    sql.exec(`CREATE TABLE IF NOT EXISTS presence (
      name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL,
      status_scope_json TEXT,
      status_summary_seq INTEGER,
      status_blocked_reason TEXT,
      status_context_json TEXT,
      status_decision_json TEXT,
      status_workflow_json TEXT,
      role TEXT,
      role_source TEXT,
      residency TEXT,
      wake_kind TEXT,
      wake_verified_at INTEGER,
      context_json TEXT,
      lineage_json TEXT,
      kind TEXT,
      account TEXT,
      client_version TEXT,
      agent_session_json TEXT,
      PRIMARY KEY (name, session_id)
    )`);
    for (const ddl of [
      "ALTER TABLE presence ADD COLUMN session_id TEXT",
      "ALTER TABLE presence ADD COLUMN kind TEXT",
      "ALTER TABLE presence ADD COLUMN account TEXT",
      "ALTER TABLE presence ADD COLUMN role TEXT",
      "ALTER TABLE presence ADD COLUMN role_source TEXT",
      "ALTER TABLE presence ADD COLUMN residency TEXT",
      "ALTER TABLE presence ADD COLUMN wake_kind TEXT",
      "ALTER TABLE presence ADD COLUMN wake_verified_at INTEGER",
      "ALTER TABLE presence ADD COLUMN context_json TEXT",
      "ALTER TABLE presence ADD COLUMN lineage_json TEXT",
      "ALTER TABLE presence ADD COLUMN status_scope_json TEXT",
      "ALTER TABLE presence ADD COLUMN status_summary_seq INTEGER",
      "ALTER TABLE presence ADD COLUMN status_blocked_reason TEXT",
      "ALTER TABLE presence ADD COLUMN status_context_json TEXT",
      "ALTER TABLE presence ADD COLUMN status_decision_json TEXT",
      "ALTER TABLE presence ADD COLUMN status_workflow_json TEXT",
      // 当前连接的人类 handle
      "ALTER TABLE presence ADD COLUMN handle TEXT",
      "ALTER TABLE presence ADD COLUMN display_name TEXT",
      "ALTER TABLE presence ADD COLUMN avatar_url TEXT",
      "ALTER TABLE presence ADD COLUMN avatar_thumb TEXT",
      "ALTER TABLE presence ADD COLUMN client_version TEXT",
      // issue #522：runner 自报的 Codex/Claude 模型会话句柄；与 websocket session_id 不同。
      "ALTER TABLE presence ADD COLUMN agent_session_json TEXT",
      // 人为「暂停接待」（issue #180）：paused_at 非 NULL 即暂停；paused_resume_at 为定时恢复时刻（epoch ms）。
      "ALTER TABLE presence ADD COLUMN paused_at INTEGER",
      "ALTER TABLE presence ADD COLUMN paused_resume_at INTEGER",
      // busy + 队列深度（#103）：serve 串行处理长任务时自报「忙 + N 待处理」，供 who/reach/web 展示。
      "ALTER TABLE presence ADD COLUMN busy INTEGER",
      "ALTER TABLE presence ADD COLUMN queue_depth INTEGER",
      // 每任务进度/心跳（#228，扩 #103）：正在处理哪条 wake（触发 seq）、何时开始、最近心跳。
      // 由 presence-only 的 heartbeat 帧刷（不落 history）；任务结束/离线时清空。供 who/web 判「活着 vs 卡死」。
      "ALTER TABLE presence ADD COLUMN current_task INTEGER",
      "ALTER TABLE presence ADD COLUMN task_started_at INTEGER",
      "ALTER TABLE presence ADD COLUMN heartbeat_at INTEGER",
      // 模型 session 活动（#602）：hook 落盘、serve 心跳捎带的「正在干什么」快照 JSON。
      // 与心跳字段同生共死（任务结束/离线即清）。
      "ALTER TABLE presence ADD COLUMN activity_json TEXT",
      // runner 健康自报（#603）：serve runner 连败计数 + 最后错误。独立于 current_task 生命周期
      //（空闲期也要能看见「干不动」）；恢复由心跳缺省即清，离线一并清。
      "ALTER TABLE presence ADD COLUMN runner_health_json TEXT",
    ]) {
      try {
        sql.exec(ddl);
      } catch {
        // 列已存在
      }
    }
    this.migratePresenceSessionSchema();
    // 监听力判定（#603）：directed delivery 租约对「仍活着的连接」过期的连续次数，按身份聚合。
    // live 只证明 TCP 活着；这张表回答「投喂了吃不吃」。任何一次被目标确认的 delivery 更新即清零。
    sql.exec(`CREATE TABLE IF NOT EXISTS listening_health (
      name TEXT PRIMARY KEY,
      streak INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS rate (
      name TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (name, bucket)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS webhooks (
      name TEXT PRIMARY KEY,
      registration_id TEXT,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      filter TEXT NOT NULL DEFAULT 'mentions',
      mode TEXT NOT NULL DEFAULT 'notify',
      target_owner TEXT,
      created_at INTEGER NOT NULL
    )`);
    try {
      sql.exec("ALTER TABLE webhooks ADD COLUMN registration_id TEXT");
    } catch {
      // column already exists
    }
    // Existing live registrations receive an identity once. Legacy queued/dead payloads are
    // deliberately not backfilled: their creation-time registration is unknowable, so retry must
    // fail closed instead of attaching them to whichever same-name URL happens to exist now.
    sql.exec(
      "UPDATE webhooks SET registration_id = lower(hex(randomblob(16))) WHERE registration_id IS NULL OR registration_id = ''",
    );
    try {
      sql.exec("ALTER TABLE webhooks ADD COLUMN mode TEXT NOT NULL DEFAULT 'notify'");
    } catch {
      // column already exists
    }
    try {
      sql.exec("ALTER TABLE webhooks ADD COLUMN target_owner TEXT");
    } catch {
      // column already exists
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS webhook_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_name TEXT NOT NULL,
      registration_id TEXT,
      webhook_mode TEXT,
      target_owner TEXT,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL
    )`);
    for (const ddl of [
      "ALTER TABLE webhook_queue ADD COLUMN registration_id TEXT",
      "ALTER TABLE webhook_queue ADD COLUMN webhook_mode TEXT",
      "ALTER TABLE webhook_queue ADD COLUMN target_owner TEXT",
    ]) {
      try {
        sql.exec(ddl);
      } catch {
        // column already exists
      }
    }
    // 死信表（#105）：重试耗尽 / 队列满而被永久放弃的投递落在这里，不再静默丢弃。
    // 保留原始 payload 以便 moderator 原样重投；有界裁剪（见 recordDeadLetter）防止写爆。
    sql.exec(`CREATE TABLE IF NOT EXISTS webhook_dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_name TEXT NOT NULL,
      registration_id TEXT,
      webhook_mode TEXT,
      target_owner TEXT,
      mention_seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      last_status INTEGER,
      last_error TEXT,
      dead_lettered_at INTEGER NOT NULL
    )`);
    for (const ddl of [
      "ALTER TABLE webhook_dead_letters ADD COLUMN registration_id TEXT",
      "ALTER TABLE webhook_dead_letters ADD COLUMN webhook_mode TEXT",
      "ALTER TABLE webhook_dead_letters ADD COLUMN target_owner TEXT",
    ]) {
      try {
        sql.exec(ddl);
      } catch {
        // column already exists
      }
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS wake_delivery_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mention_seq INTEGER NOT NULL,
      target_name TEXT NOT NULL,
      webhook_name TEXT NOT NULL,
      adapter_kind TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      result TEXT NOT NULL,
      http_status INTEGER,
      error TEXT,
      attempted_at INTEGER NOT NULL,
      ack_seq INTEGER,
      resume_seq INTEGER
    )`);
    // #551：聊天历史的 read cursor 只表示“读过”，不能承担 agent work 的可靠投递。
    // 定向投递单独持久化并引用原消息 seq；正文仍只有 messages 一份，避免复制与修订漂移。
    sql.exec(`CREATE TABLE IF NOT EXISTS directed_deliveries (
      id TEXT PRIMARY KEY,
      message_seq INTEGER NOT NULL,
      target_name TEXT NOT NULL,
      target_owner TEXT,
      cause TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_connection_id TEXT,
      last_lease_connection_id TEXT,
      lease_adapter TEXT,
      lease_until INTEGER,
      work_id TEXT,
      continuation_ref TEXT,
      parent_delivery_id TEXT,
      reply_seq INTEGER,
      last_error TEXT,
      terminal_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(message_seq, target_name)
    )`);
    try {
      sql.exec("ALTER TABLE directed_deliveries ADD COLUMN last_lease_connection_id TEXT");
    } catch {
      // column already exists
    }
    try {
      sql.exec("ALTER TABLE directed_deliveries ADD COLUMN target_owner TEXT");
    } catch {
      // column already exists
    }
    try {
      sql.exec("ALTER TABLE directed_deliveries ADD COLUMN lease_adapter TEXT");
    } catch {
      // column already exists
    }
    try {
      sql.exec("ALTER TABLE directed_deliveries ADD COLUMN parent_delivery_id TEXT");
    } catch {
      // column already exists
    }
    try {
      sql.exec("ALTER TABLE directed_deliveries ADD COLUMN terminal_reason TEXT");
    } catch {
      // column already exists
    }
    sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_directed_deliveries_target_state ON directed_deliveries(target_name, state, message_seq)",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_directed_deliveries_principal_state ON directed_deliveries(target_name, target_owner, state, message_seq)",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_directed_deliveries_lease ON directed_deliveries(state, lease_until)",
    );
    sql.exec(
      `UPDATE messages
          SET delivery_targets_json = COALESCE((
            SELECT json_group_array(target_name)
              FROM directed_deliveries delivery
             WHERE delivery.message_seq = messages.seq
          ), '[]')
        WHERE CASE
          WHEN json_valid(delivery_targets_json)
            THEN json_array_length(delivery_targets_json) = 0
          ELSE 1
        END
          AND messages.retracted_at IS NULL
          AND messages.body != '[erased]'
          AND EXISTS (
            SELECT 1 FROM directed_deliveries delivery
             WHERE delivery.message_seq = messages.seq
          )`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS message_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_seq INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      old_body TEXT,
      new_body TEXT,
      original_byte_length INTEGER,
      created_at INTEGER NOT NULL
    )`);
    try {
      sql.exec("ALTER TABLE message_audit ADD COLUMN original_byte_length INTEGER");
    } catch {
      // column already exists
    }
    if (this.getMeta("retract_scrub_v1") === null) {
      this.ctx.storage.transactionSync(() => {
        // Capture the only retained content-derived fact before erasing historical bodies.
        sql.exec(
          `UPDATE message_audit AS audit
              SET original_byte_length = length(CAST(COALESCE(
                (SELECT original_body FROM messages WHERE seq = audit.target_seq),
                audit.old_body,
                (SELECT NULLIF(body, '') FROM messages WHERE seq = audit.target_seq),
                (SELECT note FROM messages WHERE seq = audit.target_seq),
                ''
              ) AS BLOB))
            WHERE action = 'retract'
              AND original_byte_length IS NULL`,
        );
        sql.exec(
          `UPDATE messages
              SET body = '[retracted]', mentions_json = '[]', delivery_targets_json = '[]', original_body = NULL,
                  state = NULL, note = NULL, status_scope_json = NULL, status_blocked_reason = NULL,
                  status_context_json = NULL, status_decision_json = NULL, status_workflow_json = NULL,
                  message_workflow_json = NULL, completion_artifact_json = NULL,
                  completion_review_state = NULL, completion_review_policy = NULL,
                  completion_reviewed_by = NULL, completion_reviewed_by_kind = NULL,
                  completion_reviewed_by_owner = NULL, completion_reviewed_at = NULL,
                  completion_review_reason = NULL
            WHERE retracted_at IS NOT NULL`,
        );
        sql.exec(
          `UPDATE message_audit
              SET old_body = NULL, new_body = NULL
            WHERE target_seq IN (SELECT target_seq FROM message_audit WHERE action = 'retract')
               OR target_seq IN (SELECT seq FROM messages WHERE retracted_at IS NOT NULL)`,
        );
        this.setMeta("retract_scrub_v1", "1");
      });
    }
    if (this.getMeta("retract_scrub_v2") === null) {
      this.ctx.storage.transactionSync(() => {
        // Decision payloads retain prompt/reason and private delivery lineage. Historical retracts
        // created before v2 must erase them just as eagerly as status/completion payloads.
        sql.exec(
          `UPDATE messages
              SET decision_request_json = NULL, decision_state = NULL,
                  decision_resolution_json = NULL, decision_response_json = NULL
            WHERE retracted_at IS NOT NULL`,
        );
        this.setMeta("retract_scrub_v2", "1");
      });
    }
    if (this.getMeta("retract_scrub_v3") === null) {
      const now = Date.now();
      const originChannel = this.getMeta("channel_slug") ?? this.name;
      this.ctx.storage.transactionSync(() => {
        // Historical queue/dead-letter payloads are immutable copies of message content. Once the
        // source is retracted, no startup path may retain a copy that an alarm/operator can resend.
        sql.exec(
          `DELETE FROM webhook_queue
            WHERE json_valid(payload)
              AND CAST(json_extract(payload, '$.seq') AS INTEGER) IN (
                SELECT seq FROM messages WHERE retracted_at IS NOT NULL
              )`,
        );
        sql.exec(
          `DELETE FROM webhook_dead_letters
            WHERE mention_seq IN (SELECT seq FROM messages WHERE retracted_at IS NOT NULL)
               OR (
                 json_valid(payload)
                 AND CAST(json_extract(payload, '$.seq') AS INTEGER) IN (
                   SELECT seq FROM messages WHERE retracted_at IS NOT NULL
                 )
               )`,
        );
        // A pre-v3 retract could leave the question row pending even though its exact source was
        // gone/retracted/corrupted. Scrub those server-owned capabilities before repairing the
        // source rows so history replay cannot keep rendering an answerable decision.
        const invalidBoundQuestions = sql.exec(
          `SELECT q.seq
             FROM messages AS q
            WHERE q.retracted_at IS NULL
              AND q.decision_state = 'pending'
              AND (
                (
                  json_valid(q.decision_request_json)
                  AND CASE WHEN json_valid(q.decision_request_json)
                        THEN json_extract(q.decision_request_json, '$.delivery_id')
                        ELSE NULL END IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                      FROM directed_deliveries AS d
                      JOIN messages AS origin ON origin.seq = d.message_seq
                     WHERE d.id = json_extract(q.decision_request_json, '$.delivery_id')
                       AND d.state = 'waiting_owner'
                       AND d.target_name = q.sender_name
                       AND d.target_owner IS NOT NULL
                       AND (q.sender_owner IS NULL OR q.sender_owner = d.target_owner)
                       AND origin.retracted_at IS NULL
                       AND q.reply_to = d.message_seq
                       AND CAST(json_extract(q.decision_request_json, '$.origin_seq') AS INTEGER) = d.message_seq
                       AND json_extract(q.decision_request_json, '$.origin_channel') = ?
                       AND json_extract(q.decision_request_json, '$.work_id') = d.work_id
                       AND json_extract(q.decision_request_json, '$.continuation_ref') = d.continuation_ref
                  )
                )
                OR (
                  CASE WHEN json_valid(q.decision_request_json)
                    THEN json_extract(q.decision_request_json, '$.delivery_id')
                    ELSE NULL END IS NULL
                  AND EXISTS (
                    SELECT 1 FROM directed_deliveries AS possible
                     WHERE possible.message_seq = q.reply_to
                       AND possible.target_name = q.sender_name
                  )
                )
              )`,
          originChannel,
        ).toArray();
        for (const question of invalidBoundQuestions) {
          sql.exec(
            `UPDATE messages
                SET decision_request_json = NULL, decision_state = NULL,
                    decision_resolution_json = NULL, decision_response_json = NULL,
                    rev_seq = ?
              WHERE seq = ? AND decision_state = 'pending'`,
            this.nextRevSeq(),
            Number(question.seq),
          );
        }
        // Backfill the typed, non-revivable tombstone for all historical retracted roots and their
        // owner-answer descendants. In particular, legacy `failed + NULL reason` rows must not be
        // mistaken for an unknown outcome and revived after the origin has been erased.
        sql.exec(
          `WITH RECURSIVE retracted_tree(id) AS (
             SELECT d.id
               FROM directed_deliveries AS d
               JOIN messages AS m ON m.seq = d.message_seq
              WHERE m.retracted_at IS NOT NULL
             UNION
             SELECT child.id
               FROM directed_deliveries AS child
               JOIN retracted_tree AS parent ON child.parent_delivery_id = parent.id
           )
           UPDATE directed_deliveries
              SET state = CASE WHEN state = 'replied' THEN state ELSE 'failed' END,
                  last_error = CASE WHEN state = 'replied' THEN last_error ELSE 'source retracted, no retry' END,
                  terminal_reason = CASE WHEN state = 'replied' THEN terminal_reason ELSE 'source_retracted' END,
                  work_id = NULL, continuation_ref = NULL, parent_delivery_id = NULL,
                  lease_connection_id = NULL, last_lease_connection_id = NULL,
                  lease_adapter = NULL, lease_until = NULL, updated_at = ?
            WHERE id IN (SELECT id FROM retracted_tree)`,
          now,
        );
        // A short-lived pre-v3 build already wrote this authoritative retract terminal marker but
        // had no typed column. Some affected rows point at a live origin because the retracted item
        // was the pending question itself, whose lineage v2 correctly erased. Backfill that exact
        // legacy marker once during migration; runtime revival never relies on error text.
        sql.exec(
          `UPDATE directed_deliveries
              SET terminal_reason = 'source_retracted',
                  work_id = NULL, continuation_ref = NULL, parent_delivery_id = NULL,
                  lease_connection_id = NULL, last_lease_connection_id = NULL,
                  lease_adapter = NULL, lease_until = NULL, updated_at = ?
            WHERE state = 'failed'
              AND terminal_reason IS NULL
              AND last_error = 'source retracted, no retry'`,
          now,
        );
        // Normalize legacy operator-redeliverable webhook failures once, keeping the runtime reclaim
        // gate entirely typed instead of repeatedly interpreting presentation text.
        sql.exec(
          `UPDATE directed_deliveries
              SET terminal_reason = 'webhook_delivery_failed', updated_at = ?
            WHERE state = 'failed'
              AND terminal_reason IS NULL
              AND last_error LIKE 'agent webhook%'`,
          now,
        );
        // Repair historical waiting_owner rows only when no exact, live pending question still
        // owns that parked continuation. The full lineage/principal comparison prevents a retained
        // but corrupted question from keeping unrelated work suspended forever.
        sql.exec(
          `UPDATE directed_deliveries AS d
              SET state = 'failed',
                  work_id = NULL, continuation_ref = NULL, parent_delivery_id = NULL,
                  lease_connection_id = NULL, last_lease_connection_id = NULL,
                  lease_adapter = NULL, lease_until = NULL,
                  last_error = 'owner decision continuation is missing or invalid',
                  terminal_reason = 'orphaned_waiting_owner', updated_at = ?
            WHERE d.state = 'waiting_owner'
              AND NOT EXISTS (
                SELECT 1
                  FROM messages AS q
                  JOIN messages AS origin ON origin.seq = d.message_seq
                 WHERE origin.retracted_at IS NULL
                   AND q.retracted_at IS NULL
                   AND q.decision_state = 'pending'
                   AND q.decision_request_json IS NOT NULL
                   AND json_valid(q.decision_request_json)
                   AND q.sender_name = d.target_name
                   AND (q.sender_owner IS NULL OR q.sender_owner = d.target_owner)
                   AND q.reply_to = d.message_seq
                   AND json_extract(q.decision_request_json, '$.delivery_id') = d.id
                   AND CAST(json_extract(q.decision_request_json, '$.origin_seq') AS INTEGER) = d.message_seq
                   AND json_extract(q.decision_request_json, '$.origin_channel') = ?
                   AND json_extract(q.decision_request_json, '$.work_id') = d.work_id
                   AND json_extract(q.decision_request_json, '$.continuation_ref') = d.continuation_ref
              )`,
          now,
          originChannel,
        );
        this.setMeta("retract_scrub_v3", "1");
      });
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS workflow_guard_state (
      workflow_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      run_id TEXT,
      step_id TEXT,
      state TEXT,
      count_since_progress INTEGER NOT NULL DEFAULT 0,
      no_progress INTEGER NOT NULL DEFAULT 0,
      recent_tuples TEXT,
      blocked_seq INTEGER,
      last_progress_seq INTEGER,
      last_counted_seq INTEGER,
      initiator_name TEXT,
      host_name TEXT,
      latest_pending_completion_seq INTEGER,
      terminal INTEGER NOT NULL DEFAULT 0,
      terminal_seq INTEGER,
      updated_at INTEGER NOT NULL
    )`);
    // #106：给早于本次的 DO 表补 recent_tuples 列（DO 内建 SQLite，非 D1，无需 worker/migrations 迁移文件）。
    // 与 messages 表补列同手法：幂等 ALTER，列已存在则吞掉；缺列的存量行 recent_tuples 为 NULL → 解析成 []。
    try {
      sql.exec("ALTER TABLE workflow_guard_state ADD COLUMN recent_tuples TEXT");
    } catch {
      // 列已存在
    }
    sql.exec("CREATE INDEX IF NOT EXISTS workflow_guard_state_updated_idx ON workflow_guard_state(updated_at)");
    sql.exec(
      "CREATE INDEX IF NOT EXISTS workflow_guard_state_no_progress_idx ON workflow_guard_state(no_progress, updated_at)",
    );
    // 已读游标（Phase 2）：每身份读到的最大 seq。逐帧流式客户端（网页 / serve / watch --follow）回 seen
    // 时前移，断连后保留。人类与流式 agent 同表——读状态与身份类型无关，只看它逐帧收没收。
    sql.exec(`CREATE TABLE IF NOT EXISTS read_cursor (
      name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      last_seen_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (name, session_id)
    )`);
    try {
      sql.exec("ALTER TABLE read_cursor ADD COLUMN session_id TEXT");
    } catch {
      // column already exists
    }
    this.migrateReadCursorSessionSchema();
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
    // A permanent, otherwise idle channel may have no presence/webhook/temp/retention alarm at all.
    // Re-arm upgraded active and terminal delivery deadlines on hydration so bounded retention is a
    // real clock guarantee rather than something that only runs if unrelated traffic wakes the DO.
    this.scheduleDirectedDeliveryRetentionAlarm();
  }

  private hasCompositeSessionPrimaryKey(table: "presence" | "read_cursor"): boolean {
    const primaryKey = this.ctx.storage.sql
      .exec(`PRAGMA table_info(${table})`)
      .toArray()
      .filter((row) => Number(row.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => String(row.name));
    return primaryKey.length === 2 && primaryKey[0] === "name" && primaryKey[1] === "session_id";
  }

  private migratePresenceSessionSchema() {
    if (this.hasCompositeSessionPrimaryKey("presence")) return;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DROP TABLE IF EXISTS presence_session_v2");
      sql.exec(`CREATE TABLE presence_session_v2 (
        name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        note TEXT,
        updated_at INTEGER NOT NULL,
        status_scope_json TEXT,
        status_summary_seq INTEGER,
        status_blocked_reason TEXT,
        status_context_json TEXT,
        status_decision_json TEXT,
        status_workflow_json TEXT,
        role TEXT,
        role_source TEXT,
        residency TEXT,
        wake_kind TEXT,
        wake_verified_at INTEGER,
        context_json TEXT,
        lineage_json TEXT,
        kind TEXT,
        account TEXT,
        client_version TEXT,
        handle TEXT,
        display_name TEXT,
        avatar_url TEXT,
        avatar_thumb TEXT,
        paused_at INTEGER,
        paused_resume_at INTEGER,
        busy INTEGER,
        queue_depth INTEGER,
        current_task INTEGER,
        task_started_at INTEGER,
        heartbeat_at INTEGER,
        activity_json TEXT,
        runner_health_json TEXT,
        agent_session_json TEXT,
        PRIMARY KEY (name, session_id)
      )`);
      sql.exec(`INSERT INTO presence_session_v2 (
        name, session_id, state, note, updated_at,
        status_scope_json, status_summary_seq, status_blocked_reason, status_context_json,
        status_decision_json, status_workflow_json, role, role_source, residency, wake_kind,
        wake_verified_at, context_json, lineage_json, kind, account, client_version, handle,
        display_name, avatar_url, avatar_thumb, paused_at, paused_resume_at, busy, queue_depth,
        current_task, task_started_at, heartbeat_at, activity_json, runner_health_json, agent_session_json
      ) SELECT
        name, COALESCE(NULLIF(session_id, ''), '${LEGACY_SESSION_ID}'), state, note, updated_at,
        status_scope_json, status_summary_seq, status_blocked_reason, status_context_json,
        status_decision_json, status_workflow_json, role, role_source, residency, wake_kind,
        wake_verified_at, context_json, lineage_json, kind, account, client_version, handle,
        display_name, avatar_url, avatar_thumb, paused_at, paused_resume_at, busy, queue_depth,
        current_task, task_started_at, heartbeat_at, activity_json, runner_health_json, agent_session_json
      FROM presence`);
      sql.exec("DROP TABLE presence");
      sql.exec("ALTER TABLE presence_session_v2 RENAME TO presence");
    });
  }

  private migrateReadCursorSessionSchema() {
    if (this.hasCompositeSessionPrimaryKey("read_cursor")) return;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DROP TABLE IF EXISTS read_cursor_session_v2");
      sql.exec(`CREATE TABLE read_cursor_session_v2 (
        name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        last_seen_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (name, session_id)
      )`);
      sql.exec(`INSERT INTO read_cursor_session_v2 (name, session_id, kind, last_seen_seq, updated_at)
        SELECT name, COALESCE(NULLIF(session_id, ''), '${LEGACY_SESSION_ID}'), kind, last_seen_seq, updated_at
        FROM read_cursor`);
      sql.exec("DROP TABLE read_cursor");
      sql.exec("ALTER TABLE read_cursor_session_v2 RENAME TO read_cursor");
    });
  }

  // #137：每频道连接上限缺省取 MAX_CONNECTIONS_PER_CHANNEL；worker env 可覆盖以便运维调参
  // 或测试用小值（避免为验证上限真开 200 条 WS）。非法/缺省值回退到常量。
  private maxConnectionsPerChannel(): number {
    const raw = (this.env as { MAX_CONNECTIONS_PER_CHANNEL?: unknown }).MAX_CONNECTIONS_PER_CHANNEL;
    const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
    return Number.isInteger(n) && n > 0 ? n : MAX_CONNECTIONS_PER_CHANNEL;
  }

  async onConnect(connection: Connection<ConnState>, ctx: ConnectionContext) {
    const h = ctx.request.headers;
    const connectedAt = Date.now();
    const state: ConnState = {
      name: h.get("x-ap-name") ?? "",
      kind: h.get("x-ap-kind") === "agent" ? "agent" : "human",
      role: (h.get("x-ap-role") ?? "readonly") as TokenRole,
      owner: h.get("x-ap-owner") ?? undefined,
      handle: decodedHeaderText(h, "x-ap-handle"),
      ...profileFromHeaders(h),
      lineage: lineageFromHeaders(h),
      tokenHash: h.get("x-ap-token-hash") ?? "",
      collabRole: parseCollaborationRole(h.get("x-ap-collab-role") ?? undefined) ?? undefined,
      collabRoleSource: parseRoleSource(h.get("x-ap-role-source") ?? undefined) ?? undefined,
      archived: h.get("x-ap-archived") === "1",
      canWrite: h.get("x-ap-can-write") === "1",
      lastSeen: connectedAt,
      helloPending: true,
      helloDeadlineAt: connectedAt + HELLO_TIMEOUT_MS,
    };
    connection.setState(state);
    // mode/kind/host 随升级请求进来，写 meta 缓存（同 archived 的手法）
    this.cacheChannelMeta(h, new URL(ctx.request.url).host);
    // 归档以 do 自己的记录为权威，升级窗口内的快照竞态也拦得住
    if (state.archived) this.setMeta("archived", "1");
    if (state.archived || this.isArchived()) {
      this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
      connection.close(1008, "archived");
      return;
    }
    // #137 每频道 WS 连接上限：DO 无上限时单频道可被灌爆连接（每连接吃内存 + presence 扇出）。
    // getConnections 在 onConnect 时已含刚接入的这条，按 id 排除自己后计数「其它存活连接」，
    // 达上限即拒绝这条（第 N+1 条），前 N 条照常。镜像 archived 的 error 帧 + 1008 关闭。
    const connCap = this.maxConnectionsPerChannel();
    let otherConns = 0;
    for (const other of this.getConnections<ConnState>()) {
      if (other.id !== connection.id) otherConns++;
    }
    if (otherConns >= connCap) {
      this.sendFrame(connection, {
        type: "error",
        code: "channel_full",
        message: `channel connection limit reached (max ${connCap})`,
      });
      connection.close(1008, "channel_full");
      return;
    }
    // #527：浏览器人类通常不会主动发 status。连接建立时就把 worker 从账号资料解析出的
    // 权威 identity 落到本 session 的 presence，避免只在断线时由 markOffline 造出一个
    // 没有 kind/profile 的占位行，进而让 who 把 lark-* 人类猜成 agent。
    if (state.kind === "human") this.materializeConnectionPresence(state, connection.id, Date.now());
    const loopGuard = state.kind === "agent" ? this.loopGuardMessage(state.name) : this.globalLoopGuardMessage();
    this.sendFrame(connection, {
      type: "welcome",
      channel: this.name,
      self: state.name,
      mode: this.getMeta("mode") === "party" ? "party" : "normal",
      role: state.role,
      loop_guard: loopGuard,
      participants: this.participants(),
      last_seq: this.lastSeq(),
      last_rev_seq: this.lastRevSeq(),
      directed_delivery: "v1",
      owner_decision_binding: "v1",
      ...(this.charterRev() > 0 ? { charter_rev: this.charterRev() } : {}),
      presence: this.presenceList(),
      read_cursors: this.readCursors(),
    });
    this.broadcastFrame({ type: "participants", participants: this.participants() });
    // 只前移不后移：即便已有远期 alarm（temp 归档 +14 天 / webhook 重试）也保证 presence 扫描按期到来。
    // 新连接此刻刚握手（lastSeen=now），最早也要 PRESENCE_SCAN_MS 静默才可能被判半开，故排到 now+窗口即可。
    await this.ensureAlarmAt(connectedAt + HELLO_TIMEOUT_MS);
  }

  async onMessage(connection: Connection<ConnState>, message: WSMessage) {
    const previous = this.wsMessageTails.get(connection.id) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.onMessageSerial(connection, message));
    this.wsMessageTails.set(connection.id, current);
    try {
      await current;
    } catch (err) {
      // DO 抛未捕获异常时 Cloudflare 只回不透明的 "internal error; reference"，不留任何应用日志
      // （kyc/seamail 那次 30 分钟只能靠猜就是因为这里没日志）。落一条带频道/连接的真实堆栈，
      // 让下次同类故障在 wrangler tail 里直接可诊断；行为不变，照旧向上抛。
      logDoException("onMessage", this.name, err, `conn=${connection.id}`);
      throw err;
    } finally {
      if (this.wsMessageTails.get(connection.id) === current) {
        this.wsMessageTails.delete(connection.id);
      }
    }
  }

  private async onMessageSerial(connection: Connection<ConnState>, message: WSMessage) {
    const badRequest = () =>
      this.sendFrame(connection, { type: "error", code: "bad_request", message: "invalid frame" });
    if (typeof message !== "string") {
      badRequest();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      badRequest();
      return;
    }
    if (typeof raw !== "object" || raw === null) {
      badRequest();
      return;
    }
    const frame = raw as Record<string, unknown>;
    let st = connection.state;
    if (!st) return;
    const receivedAt = Date.now();
    st = connection.setState({ ...st, lastSeen: receivedAt });
    if (!st) return;

    if (
      st.helloPending === true &&
      typeof st.helloDeadlineAt === "number" &&
      st.helloDeadlineAt <= receivedAt
    ) {
      this.closeHelloExpired(connection);
      return;
    }

    if (frame.type === "ping") {
      // setWebSocketAutoResponse 只匹配字面 '{"type":"ping"}'，这里兜底其余序列化
      this.sendFrame(connection, { type: "pong" });
      return;
    }
    if (st.helloPending === true && frame.type !== "hello") {
      this.sendFrame(connection, {
        type: "error",
        code: "bad_request",
        message: "hello_required: send hello before any actionable frame",
      });
      return;
    }
    if (!(await this.isTokenActive(st.tokenHash))) {
      this.closeRevokedConnection(connection);
      return;
    }
    if (frame.type === "hello") {
      // Capability is sticky for the lifetime of this socket. A later cursor refresh from a caller
      // that omits optional fields must not silently downgrade an already-proven executor.
      const nextDirectedDeliveryV1 = st.directedDeliveryV1 === true || frame.directed_delivery === "v1";
      const clientVersion = parseClientVersion(frame.client_version);
      const since = typeof frame.since === "number" && frame.since > 0 ? Math.floor(frame.since) : 0;
      if (clientVersion !== null) {
        this.recordClientVersion(st.name, connection.id, clientVersion, Date.now());
      }
      // Finish capability identity before replay. Live broadcasts were withheld while helloPending;
      // DO message handling is serialized, so dispatch + backfill below form one gap-free handoff.
      st = connection.setState({
        ...st,
        directedDeliveryV1: nextDirectedDeliveryV1,
        ...(clientVersion === null ? {} : { clientVersion }),
        helloSince: Math.max(st.helloSince ?? 0, since),
        helloPending: false,
        helloExpired: false,
      }) ?? st;
      const sinceRev =
        typeof frame.since_rev === "number" && frame.since_rev >= 0 ? Math.floor(frame.since_rev) : null;
      // 带 since_rev 的新客户端：修订快照只重放 rev_seq 更大的那些（issue #33）；
      // 不带的旧客户端：保持旧行为（全部历史修订每次连接都重放，由客户端自行去重）。
      //
      // #129：分页而非无 LIMIT。曾用单条查询把全部匹配行（最多 1 万）一并 toArray——单次序列化上万行。
      // 现按 seq 游标分页（seq 是主键、唯一、单调），每页 ≤ HELLO_BACKFILL_PAGE_SIZE 有界下发，循环到
      // 某页短于一页即排空。分页游标从 0 起（不是 since）：since_rev 命中的行 seq 可能 ≤ since，
      // 必须纳入遍历，否则会漏掉「seq 小但被修订」的行。跨批次逐帧下发，客户端消费与不分页时完全一致，
      // 首连即完整的契约不破。
      //
      // 注：补拉期间不 await——DO 单线程处理这条 hello，其间新 send 无法穿插改表，快照一致；分页边界
      // 只会漏「本次 hello 开始后」的新消息，那些由 send 的 live 广播补上（seq 更大，客户端照收）。
      const backfillQuery =
        sinceRev !== null
          ? `SELECT * FROM messages
              WHERE (seq > ? OR (rev_seq IS NOT NULL AND rev_seq > ?))
                AND seq > ?
              ORDER BY seq LIMIT ?`
          : `SELECT * FROM messages
              WHERE (seq > ?
                 OR edited_at IS NOT NULL
                 OR retracted_at IS NOT NULL
                 OR supersedes IS NOT NULL
                 OR superseded_by IS NOT NULL
                 OR completion_review_state IS NOT NULL
                 OR completion_review_replaced_by_seq IS NOT NULL)
                AND seq > ?
              ORDER BY seq LIMIT ?`;
      let pageCursor = 0;
      for (;;) {
        const rows =
          sinceRev !== null
            ? this.ctx.storage.sql
                .exec(backfillQuery, since, sinceRev, pageCursor, HELLO_BACKFILL_PAGE_SIZE)
                .toArray()
            : this.ctx.storage.sql
                .exec(backfillQuery, since, pageCursor, HELLO_BACKFILL_PAGE_SIZE)
                .toArray();
        for (const row of rows) {
          if (!this.sendPublicFrame(connection, publicMsgFrame(this.rowToFrame(row)), true)) return;
        }
        if (rows.length < HELLO_BACKFILL_PAGE_SIZE) break;
        // 游标推进到本页最后一行的 seq；seq 唯一且升序，下一页严格取更大的 seq，保证前进、不重不漏。
        pageCursor = Number(rows[rows.length - 1]!.seq);
      }
      // Message history alone cannot reconstruct durable delivery state after a Web reload. Replay
      // every retained row (all states, not only active work) after messages so reducer upserts see
      // their source first. Compound keyset pagination keeps each SQLite materialization bounded even
      // when one source fans out to many agents.
      this.replayDirectedDeliveryStates(connection);
      // A connection may upgrade its declaration after an earlier legacy lease claim. Re-run the
      // election only after backfill so a newly capable executor cannot receive work before history.
      if (st.kind === "agent") {
        if (st.serveCandidate) this.reconcileServeLease(st.name);
        else this.dispatchNextDirectedDelivery(st.name);
      }
      return;
    }
    if (frame.type === "seen") {
      // 已读游标（Phase 2）：前移了才广播。人类与流式 agent 走同一条路径。
      const seq = typeof frame.seq === "number" ? frame.seq : NaN;
      if (Number.isFinite(seq)) {
        const cursor = this.recordSeen(st.name, connection.id, st.kind, seq);
        if (cursor !== null) this.broadcastFrame({ type: "read_cursor", ...cursor });
      }
      return;
    }
    if (frame.type === "heartbeat") {
      // 每任务进度/心跳（#228）：presence-only，不落 history、不占发送速率、不炸连接。
      // 脏值（负数/非整数/字段不齐）静默丢弃——心跳是自动流量，宁可漏一拍也别断流。
      const hb = parseHeartbeatFrame(frame);
      if (hb !== null) {
        // A heartbeat queued on the socket just before a decision POST can arrive after the DO has
        // already parked that work. Do not resurrect waiting/replied/failed work as busy presence;
        // legacy heartbeats with no delivery row remain accepted.
        if (hb.current_task === null || this.directedTaskAcceptsHeartbeat(st, hb.current_task)) {
          this.applyTaskHeartbeat(st.name, connection.id, hb);
        }
        this.applyDirectedDeliveryHeartbeat(st, connection.id, hb, Date.now());
      }
      return;
    }
    if (frame.type === "delivery_adapter" && frame.adapter === "watch" && frame.op === "register") {
      if (st.kind !== "agent") {
        badRequest();
        return;
      }
      if (!st.watchCandidate) {
        st = connection.setState({
          ...st,
          watchCandidate: true,
          watchClaimSeq: this.nextServeClaimSeq(),
        }) ?? st;
      }
      this.sendFrame(connection, { type: "delivery_adapter", adapter: "watch", registered: true });
      this.dispatchNextDirectedDelivery(st.name);
      return;
    }
    if (frame.type === "delivery_update") {
      const update = parseDeliveryUpdateFrame(frame);
      if (update === null || !this.applyDirectedDeliveryUpdate(st, connection.id, update, Date.now())) {
        badRequest();
      } else {
        // 监听力判定（#603）：任何一次被接受的 delivery 更新（running/waiting_owner/replied/failed
        // 都证明目标在消费投递，failed 也是「听见了」）即清零负面 streak，并把恢复广播出去。
        if (this.clearListeningStreak(st.name)) this.broadcastPresenceFor(st.name);
        // Explicit per-connection ACK. A broadcast alone is insufficient: idempotent retries do not
        // change state, and the CLI must not advance durable work until it sees server confirmation.
        const row = this.directedDeliveryRow(update.delivery_id);
        if (row !== undefined) {
          this.sendFrame(connection, {
            type: "delivery_state",
            delivery: this.deliveryStateForConnection(connection, row),
            ...(update.request_id === undefined ? {} : { request_id: update.request_id }),
          });
        }
      }
      return;
    }
    if (frame.type === "serve_lease" && frame.op === "claim") {
      // 同名 serve 跨机租约（#99）：本连接声明它是一条 serve runner，想当唯一在跑的那个。
      // 首次 claim 定死一个单调序号（重复 claim 不改，避免重连者用更小序号抢回租约）；随后在同名候选里
      // 选最小序号者持租，回 serve_lease 告知各连接是否持租。断连/心跳超时由 onClose/scanPresence 触发改选。
      if (
        st.directedDeliveryV1 !== true &&
        this.legacyServeConflictsWithV1(st, connection.id)
      ) {
        this.closeUpgradeRequired(
          connection,
          "a v1 executor already owns this principal; legacy serve cannot become standby",
        );
        return;
      }
      if (!st.serveCandidate) {
        st = connection.setState({ ...st, serveCandidate: true, serveClaimSeq: this.nextServeClaimSeq() }) ?? st;
      }
      this.reconcileServeLease(st.name);
      return;
    }
    if (frame.type === "send") {
      if (st.archived || this.isArchived()) {
        this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
        return;
      }
      const rate = this.consumeRate(st.name, Date.now());
      if (rate !== null) {
        this.sendFrame(connection, { type: "error", code: rate.code, message: rate.message });
        return;
      }
      const send = parseSendFrame(frame);
      if (!send) {
        this.sendFrame(connection, { type: "error", code: "bad_request", message: sendRejectMessage(frame) });
        return;
      }
      const out = await this.handleSend(
        {
          name: st.name,
          kind: st.kind,
          role: st.role,
          owner: st.owner,
          handle: st.handle,
          displayName: st.displayName,
          avatarUrl: st.avatarUrl,
          avatarThumb: st.avatarThumb,
          lineage: st.lineage,
          tokenHash: st.tokenHash,
          collabRole: st.collabRole,
          collabRoleSource: st.collabRoleSource,
          canWrite: st.canWrite,
          clientVersion: st.clientVersion,
        },
        send,
        { countRate: false, sessionId: connection.id },
      );
      if (!out.ok) {
        this.sendFrame(connection, { type: "error", code: out.code, message: out.message });
        return;
      }
      // 幂等去重命中（#98）：只回 sent（原 seq），不重复广播/唤醒。ws 发送目前不带 key，故常态为 false。
      if (out.deduped) {
        this.sendFrame(connection, { type: "sent", seq: out.seq });
        return;
      }
      const sent = out.frames[0] as MsgFrame;
      // Dispatch the committed durable work before acknowledging success. A reset after `sent` must
      // not leave a committed queued webhook waiting for unrelated future traffic to wake the DO.
      this.flushAtomicDeliveryEffects(out.atomicEffects);
      // sent 先于 raw self-echo 到达发送方，客户端先推进游标再看到自己的回声。
      this.sendFrame(connection, { type: "sent", seq: out.seq });
      // 广播必须紧跟 INSERT，中间不能有任何 await（#114）：
      // 并发发送时 A 落库 seq=N 后若在这里等 D1，B 落库 N+1 先广播，watcher ack 了 N+1，
      // 后到的 N 就被客户端当作「已消费」永久丢弃（client.ts: seq <= cursor 静默丢），
      // 而重连 hello since=cursor 也不会补拉——append-only + 游标契约被静默违背。
      for (const f of out.frames) this.broadcastFrame(f);
      await this.closeInactiveConnections();
      await this.afterSend(sent, undefined, true);
    }
  }

  async onClose(connection: Connection<ConnState>) {
    // A close event is ordered after all data frames already received on this socket. Do not
    // reclaim its delivery/serve leases while one of those frames is still queued behind hello or
    // awaiting D1; otherwise a final replied update can be undone by premature disconnect cleanup.
    await this.wsMessageTails.get(connection.id)?.catch(() => undefined);
    const st = connection.state;
    if (!st || !st.name || st.archived) return;
    // #551：work 租约属于具体连接，不属于模糊的在线身份。尚未启动的 v1 claim 可安全
    // 回到 queued；legacy raw handoff 已可能执行外部副作用，断线必须按 unknown outcome 失败。
    const affectedDeliveryTargets = this.requeueDirectedDeliveriesForConnection(
      connection.id,
      Date.now(),
    );
    // 同名 serve 跨机租约（#99）：持租者/候选断连 → 重选，让下一条 standby 顶上（补发 held=true）。
    // 排除正在关闭的这条（getConnections 可能仍返回它）。非 serve 连接不触发。
    if (st.serveCandidate) {
      // The standby must learn held=true before it receives the retried delivery. Otherwise a real
      // serve client can discard the delivery while it still believes it is standby.
      this.reconcileServeLease(st.name, connection.id);
      for (const targetName of affectedDeliveryTargets) {
        if (targetName !== st.name) this.dispatchNextDirectedDelivery(targetName, connection.id);
      }
    } else if (st.kind === "agent") {
      const targets = new Set(affectedDeliveryTargets);
      // Also release a helloPending / legacy-watch dispatch barrier even when this connection did
      // not yet own a durable row.
      targets.add(st.name);
      for (const targetName of targets) {
        this.dispatchNextDirectedDelivery(targetName, connection.id);
      }
    }
    // 被移除成员的残连关闭去抖：窗口口径按 presence 新鲜度基准（60s），与 #487 拉长的扫描间隔无关，
    // 保持既有语义不变——避免把回收 alarm 的间隔耦合进「移除后多久内的残连关闭要抹掉 presence」。
    const removedAt = Number(this.getMeta(this.removedPresenceKey(st.name)) ?? "");
    if (Number.isInteger(removedAt) && Date.now() - removedAt < PRESENCE_TIMEOUT_MS) {
      this.ctx.storage.sql.exec("DELETE FROM presence WHERE name = ?", st.name);
      this.broadcastFrame({ type: "participants", participants: this.participants() });
      return;
    }
    this.cleanupPresenceSession(st.name, connection.id, Date.now());
    this.broadcastFrame({ type: "participants", participants: this.participants() });
  }

  // alarm 三件套（spec §6/§13）：presence 扫描 → webhook 重试 → temp 归档检查，最后按最近到期时间续排
  async onAlarm() {
    const now = Date.now();
    this.requeueExpiredDirectedDeliveries(now);
    const scan = this.scanPresence(now);
    this.resumeDuePauses(now);
    await this.retryWebhooks(now);
    await this.checkTempArchive(now);
    await this.pruneStorage(now);
    await this.scheduleNextAlarm(now, scan);
  }

  // #128：DO 存储有界修剪。wake_delivery_ledger / message_audit / read_cursor 此前只增不减，
  // DO SQLite 无上限增长（10GB 上限前先拖慢 who/hello）。onAlarm 周期跑（60s presence 扫描顺带），
  // 全走已在 DO 单线程内的 sql.exec，热路径零成本；每张表各按「消费者仍需的窗口」定界，见各方法注释。
  private async pruneStorage(now: number) {
    await this.pruneRetainedContent(now);
    this.pruneDirectedDeliveryRetention(now);
    this.pruneWakeLedger(now);
    this.pruneMessageAudit();
    this.pruneReadCursors(now);
  }

  private retentionMs(key: "message_retention_ms" | "audit_retention_ms"): number | null {
    const value = Number(this.getMeta(key) ?? "");
    return Number.isSafeInteger(value) && value >= 60_000 ? value : null;
  }

  // #421: the policy is stored in D1 and authoritatively mirrored into DO meta.  Expired message
  // rows are physically deleted together with delivery copies and R2 blobs; audit history has its
  // own independent window so a tenant may retain an action trail longer than message content.
  private async pruneRetainedContent(now: number) {
    const messageRetention = this.retentionMs("message_retention_ms");
    const auditRetention = this.retentionMs("audit_retention_ms");
    const attachmentKeys = new Set<string>();
    if (messageRetention !== null) {
      const cutoff = now - messageRetention;
      const activeRoots = this.ctx.storage.sql
        .exec(
          `SELECT d.* FROM directed_deliveries d
            JOIN messages m ON m.seq = d.message_seq
           WHERE m.ts <= ?
             AND d.state IN ('queued', 'claimed', 'running', 'waiting_owner')
           ORDER BY d.created_at, d.id`,
          cutoff,
        )
        .toArray();
      if (activeRoots.length > 0) {
        let invalidatedDecisionSeqs: number[] = [];
        const effects = this.captureAtomicDeliveryEffects(() => {
          invalidatedDecisionSeqs = this.failDeliveryTree(activeRoots, now, {
            error: "source expired by channel message retention policy",
            terminalReason: "source_retention_expired",
          });
        });
        this.flushAtomicDeliveryEffects(effects);
        this.broadcastInvalidatedDecisions(invalidatedDecisionSeqs, now);
      }
      const expired = this.ctx.storage.sql
        .exec(
          `SELECT m.seq, m.attachments_json FROM messages m WHERE m.ts <= ?`,
          cutoff,
        )
        .toArray();
      for (const row of expired) {
        for (const attachment of parseStoredAttachments(row.attachments_json) ?? []) {
          if (attachment.key.startsWith(`${this.name}/`)) attachmentKeys.add(attachment.key);
        }
      }
      if (expired.length > 0) {
        // Delete blobs first.  If R2 is transiently unavailable the alarm retries while the message
        // rows still retain their keys; deleting SQLite first would make those blobs unreachable.
        const keys = [...attachmentKeys];
        for (let i = 0; i < keys.length; i += 1000) {
          await this.env.ATTACHMENTS.delete(keys.slice(i, i + 1000));
        }
        let invalidatedDecisionSeqs: number[] = [];
        const atomicEffects = this.captureAtomicDeliveryEffects(() => {
          const activeRoots = this.ctx.storage.sql.exec(
            `SELECT d.*
               FROM directed_deliveries d
               JOIN messages m ON m.seq = d.message_seq
              WHERE m.ts <= ?
                AND d.state IN ('queued', 'claimed', 'running', 'waiting_owner')
                AND (d.parent_delivery_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM directed_deliveries parent WHERE parent.id = d.parent_delivery_id
                ))`,
            cutoff,
          ).toArray();
          invalidatedDecisionSeqs = this.failDeliveryTree(activeRoots, now, {
            error: "source expired by channel message retention policy",
            terminalReason: "source_retention_expired",
          });
          this.ctx.storage.sql.exec(
            `DELETE FROM webhook_queue
              WHERE json_valid(payload)
                AND CAST(json_extract(payload, '$.seq') AS INTEGER) IN
                    (SELECT m.seq FROM messages m WHERE m.ts <= ?)`,
            cutoff,
          );
          this.ctx.storage.sql.exec(
            `DELETE FROM webhook_dead_letters
              WHERE mention_seq IN (
                SELECT m.seq FROM messages m WHERE m.ts <= ?)`,
            cutoff,
          );
          this.ctx.storage.sql.exec(
            `DELETE FROM wake_delivery_ledger
              WHERE mention_seq IN (
                SELECT m.seq FROM messages m WHERE m.ts <= ?)`,
            cutoff,
          );
          this.ctx.storage.sql.exec(
            `DELETE FROM directed_deliveries
              WHERE message_seq IN (
                SELECT m.seq FROM messages m WHERE m.ts <= ?)`,
            cutoff,
          );
          this.ctx.storage.sql.exec(
            `DELETE FROM messages AS m WHERE m.ts <= ?`,
            cutoff,
          );
        });
        this.flushAtomicDeliveryEffects(atomicEffects);
        this.broadcastInvalidatedDecisions(invalidatedDecisionSeqs, now);
      }
    }
    if (auditRetention !== null) {
      this.ctx.storage.sql.exec("DELETE FROM message_audit WHERE created_at <= ?", now - auditRetention);
    }
  }

  private broadcastInvalidatedDecisions(seqs: number[], now: number) {
    if (seqs.length === 0) return;
    const actor: Identity = { name: "system", kind: "agent", role: "agent", tokenHash: "" };
    for (const seq of new Set(seqs)) {
      const row = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).toArray()[0];
      if (row !== undefined) {
        this.broadcastFrame(this.messageUpdate("decision", actor, this.rowToFrame(row), now));
      }
    }
  }

  private pruneDirectedDeliveryRetention(now: number) {
    const activeCutoff = now - DIRECTED_DELIVERY_MAX_AGE_MS;
    const activeRoots = this.ctx.storage.sql
      .exec(
        `SELECT * FROM directed_deliveries
          WHERE state IN ('queued', 'claimed', 'running', 'waiting_owner')
            AND created_at <= ?
          ORDER BY created_at, id`,
        activeCutoff,
      )
      .toArray();
    if (activeRoots.length > 0) {
      let invalidatedDecisionSeqs: number[] = [];
      const effects = this.captureAtomicDeliveryEffects(() => {
        invalidatedDecisionSeqs = this.failDeliveryTree(activeRoots, now, {
          error: "durable delivery expired after 30 days without completion",
          terminalReason: "delivery_expired",
        });
      });
      this.flushAtomicDeliveryEffects(effects);
      this.broadcastInvalidatedDecisions(invalidatedDecisionSeqs, now);
    }

    // Delete only terminal leaves. Parent lineage remains until every descendant is terminal and
    // pruned; the next alarm removes the now-leaf parent. Pending questions are an additional guard
    // against deleting a source that has not been invalidated correctly.
    this.ctx.storage.sql.exec(
      `DELETE FROM directed_deliveries AS delivery
        WHERE delivery.state IN ('replied', 'failed')
          AND delivery.updated_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM directed_deliveries child
             WHERE child.parent_delivery_id = delivery.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM messages question
             WHERE question.decision_state = 'pending'
               AND question.decision_request_json IS NOT NULL
               AND json_valid(question.decision_request_json)
               AND json_extract(question.decision_request_json, '$.delivery_id') = delivery.id
          )`,
      now - DIRECTED_DELIVERY_TERMINAL_RETENTION_MS,
    );
  }

  // wake_delivery_ledger：按时间窗裁。保留窗口 WAKE_LEDGER_RETENTION_MS 严格大于预算窗口上限
  // WAKE_BUDGET_MAX_WINDOW_MS（#108 wakeCountInWindow 只数 attempted_at >= now-windowMs，windowMs ≤ 30d），
  // 故预算仍要数的行 attempted_at 一定 > cutoff，绝不被裁 → 预算不少计、不漏。#105 死信与 #107 resume
  // 回填（linkWakeResume 按 mention_seq 事后补 ack/resume）都只关心近期行，35 天足够；/internal/wake-deliveries
  // 观测丢失 35 天前的投递记录属可接受的保留策略。
  private pruneWakeLedger(now: number) {
    this.ctx.storage.sql.exec(
      "DELETE FROM wake_delivery_ledger WHERE attempted_at < ?",
      now - WAKE_LEDGER_RETENTION_MS,
    );
  }

  // message_audit：保留最新 MAX_MESSAGE_AUDIT_ROWS 行（按自增 id，镜像 recordDeadLetter 的裁剪手法）。
  // 审计 API（/internal/messages/:seq/audit）只按 target_seq 查单条消息 → 近期消息对应高 id 行，永不被裁。
  // 与 #196 撤回清洗正交：清洗按 target_seq 把撤回/编辑行正文置 NULL，这里按行数裁旧整行——被裁的旧行
  // 正文早已是 NULL（撤回后不可再编辑），裁掉不泄露任何内容；EXISTS('retract') 子查询按 target_seq 命中，
  // 裁旧行不影响同一 target 更晚（更高 id）的撤回行是否存在。
  private pruneMessageAudit() {
    this.ctx.storage.sql.exec(
      `DELETE FROM message_audit
        WHERE id NOT IN (SELECT id FROM message_audit ORDER BY id DESC LIMIT ?)`,
      MAX_MESSAGE_AUDIT_ROWS,
    );
  }

  // read_cursor：每个 session 一行；对外按身份取 MAX。只裁「updated_at 早于保留窗口且此刻该身份
  // 无活连接」的陈旧游标——在线身份（含刚 caught-up、频道久无新帧而未再推进游标的）永不被裁其活游标。
  // 断连超 READ_CURSOR_RETENTION_MS 仍未回来的身份，其读位对应的消息多半已过 RETAIN_N 被裁，游标失去意义；
  // 它再上线时 recordSeen 会重建游标，无副作用（只是丢了旧读位，长期离线后本就无从谈起）。
  private pruneReadCursors(now: number) {
    const aged = this.ctx.storage.sql
      .exec("SELECT name FROM read_cursor WHERE updated_at < ?", now - READ_CURSOR_RETENTION_MS)
      .toArray()
      .map((r) => String(r.name));
    if (aged.length === 0) return;
    const connected = new Set<string>();
    for (const connection of this.getConnections<ConnState>()) {
      const n = connection.state?.name;
      if (n) connected.add(n);
    }
    for (const name of aged) {
      if (connected.has(name)) continue;
      this.ctx.storage.sql.exec("DELETE FROM read_cursor WHERE name = ?", name);
    }
  }

  // #487：静默超过 PRESENCE_SCAN_MS（120s）的半开连接判 offline 并回收；ping 由 auto-response 盖时间戳、
  // 不唤醒 DO。返回存活连接数 + 最早一条存活连接的 last 活动时刻（earliestSeen），供 scheduleNextAlarm 按
  // 「最早到期」自适应重挂 alarm——只在真有连接可能超时的那一刻醒来，而非固定每分钟空转。
  private scanPresence(now: number): {
    live: number;
    earliestSeen: number | null;
    earliestHelloDeadline: number | null;
  } {
    const stale: Array<{ connection: Connection<ConnState>; helloTimeout: boolean }> = [];
    let live = 0;
    let earliestSeen: number | null = null;
    let earliestHelloDeadline: number | null = null;
    for (const connection of this.getConnections<ConnState>()) {
      const st = connection.state;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(connection)?.getTime() ?? 0;
      const last = Math.max(pinged, st?.lastSeen ?? 0);
      const helloDeadline = st?.helloPending === true && st.helloExpired !== true &&
          typeof st.helloDeadlineAt === "number"
        ? st.helloDeadlineAt
        : null;
      const helloTimeout = helloDeadline !== null && helloDeadline <= now;
      if (helloTimeout || now - last >= PRESENCE_SCAN_MS) {
        stale.push({ connection, helloTimeout });
      } else {
        live++;
        if (earliestSeen === null || last < earliestSeen) earliestSeen = last;
        if (
          helloDeadline !== null &&
          (earliestHelloDeadline === null || helloDeadline < earliestHelloDeadline)
        ) earliestHelloDeadline = helloDeadline;
      }
    }
    // 同名 serve 跨机租约（#99）：心跳超时的持租者，其连接在这里被关；关掉后要重选租约让 standby 顶上。
    const staleServeNames = new Set<string>();
    const expiredHelloNames = new Set<string>();
    const affectedDeliveryTargets = new Set<string>();
    for (const item of stale) {
      const { connection, helloTimeout } = item;
      const name = connection.state?.name;
      if (connection.state?.serveCandidate && name) staleServeNames.add(name);
      for (const targetName of this.requeueDirectedDeliveriesForConnection(connection.id, now)) {
        affectedDeliveryTargets.add(targetName);
      }
      if (helloTimeout) {
        if (name) expiredHelloNames.add(name);
        this.closeHelloExpired(connection);
      } else {
        connection.close(1001, "heartbeat timeout");
      }
      if (!name) continue;
      this.cleanupPresenceSession(name, connection.id, now);
    }
    // 已 close 的陈旧连接不在 getConnections 里，直接重选：存活的候选里最早的顶上、补发 held=true。
    for (const name of staleServeNames) this.reconcileServeLease(name);
    for (const targetName of affectedDeliveryTargets) {
      if (!staleServeNames.has(targetName)) this.dispatchNextDirectedDelivery(targetName);
    }
    for (const name of expiredHelloNames) {
      if (!staleServeNames.has(name) && !affectedDeliveryTargets.has(name)) {
        this.dispatchNextDirectedDelivery(name);
      }
    }
    if (stale.length > 0) {
      this.broadcastFrame({ type: "participants", participants: this.participants() });
    }
    return { live, earliestSeen, earliestHelloDeadline };
  }

  // 队列里到期的重投一轮：成功删行，失败退避 1/4/16 分钟，超过 3 次丢弃并向频道记一条 status
  private async retryWebhooks(now: number) {
    if (this.isArchived()) return;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT q.id, q.webhook_name, q.registration_id, q.webhook_mode, q.target_owner,
                q.payload, q.attempts
         FROM webhook_queue q
         WHERE q.next_retry_at <= ?
         ORDER BY q.next_retry_at, q.id
         LIMIT ?`,
        now,
        WEBHOOK_RETRY_BATCH_SIZE,
      )
      .toArray();
    for (const row of rows) {
      const id = Number(row.id);
      const webhookName = String(row.webhook_name);
      const payload = String(row.payload);
      const attempt = Number(row.attempts) + 1;
      if (this.scrubRetractedWebhookArtifacts(payload)) continue;
      const binding = this.storedWebhookBinding(row);
      if (binding === null) {
        const failure = { ok: false, status: null, error: "legacy retry has no immutable registration identity" };
        this.recordDeadLetter(webhookName, payload, attempt, failure, now);
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        continue;
      }
      const hook = this.currentWebhookForBinding(binding);
      if (hook === null) {
        const failure = {
          ok: false,
          status: null,
          error: "webhook registration changed; refusing cross-registration retry",
        };
        this.recordDeadLetter(webhookName, payload, attempt, failure, now, binding);
        this.failDirectedWebhookDelivery(payload, binding, failure.error, now);
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        continue;
      }
      if (binding.mode === "agent") {
        const deliveryId = this.directedDeliveryIdFromWebhookPayload(payload);
        const directed = deliveryId === null ? undefined : this.directedDeliveryRow(deliveryId);
        if (
          directed === undefined ||
          !this.directedWebhookPayloadMatchesBinding(payload, binding, directed)
        ) {
          const failure = {
            ok: false,
            status: null,
            error: "agent webhook payload no longer matches its creation-time principal/work",
          };
          this.recordDeadLetter(webhookName, payload, attempt, failure, now, binding);
          if (
            directed !== undefined &&
            String(directed.target_name) === binding.name &&
            String(directed.target_owner ?? "") === binding.targetOwner &&
            String(directed.lease_connection_id ?? "") === this.webhookHolderId(binding.registrationId)
          ) {
            this.transitionDirectedDeliveryTerminal(String(directed.id), "failed", now, {
              error: failure.error,
              terminalReason: "webhook_delivery_failed",
              expectedStates: ["claimed"],
              expectedLeaseAdapter: "webhook",
              expectedLeaseConnectionId: this.webhookHolderId(binding.registrationId),
            });
          }
          this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
          continue;
        }
      }
      if (!this.directedWebhookCanRetry(payload, binding)) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        continue;
      }
      const delivery = await this.deliverWebhook(hook.url, hook.secret, payload);
      if (this.scrubRetractedWebhookArtifacts(payload)) continue;
      this.recordWakeDelivery({
        mentionSeq: this.seqFromWebhookPayload(payload),
        targetName: webhookName,
        webhookName,
        attempt,
        delivery,
      });
      if (delivery.ok) {
        const directedId = this.directedDeliveryIdFromWebhookPayload(payload);
        if (binding.mode === "agent" && directedId !== null) {
          this.acceptDirectedWebhookDelivery(
            payload,
            binding,
            now + DIRECTED_WEBHOOK_LEASE_MS,
            now,
          );
        }
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        continue;
      }
      if (attempt > WEBHOOK_MAX_RETRIES) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        // #105：不再静默永久丢弃——落死信表待 moderator 重投，
        // 并向频道插一条 system status（in-channel，不经 webhook 自身，见 dispatchWebhooks 对 system 帧的默认跳过）。
        this.recordDeadLetter(webhookName, payload, attempt, delivery, now, binding);
        this.failDirectedWebhookDelivery(
          payload,
          binding,
          `agent webhook exhausted retries: ${delivery.error ?? `HTTP ${delivery.status ?? "unknown"}`}`,
          now,
        );
        this.insertSystemStatus(`webhook ${webhookName} 连续投递失败已转入死信，可 redeliver 重投`, now, false, { state: "blocked" });
        continue;
      }
      const nextRetryAt = now + this.retryDelay(attempt);
      this.ctx.storage.sql.exec(
        "UPDATE webhook_queue SET attempts = ?, next_retry_at = ? WHERE id = ?",
        attempt,
        nextRetryAt,
        id,
      );
      const directedId = this.directedDeliveryIdFromWebhookPayload(payload);
      if (binding.mode === "agent" && directedId !== null) {
        this.renewDirectedWebhookLease(
          directedId,
          binding,
          nextRetryAt + DIRECTED_WEBHOOK_LEASE_MS,
        );
      }
    }
  }

  private retryDelay(attempts: number): number {
    return WEBHOOK_RETRY_DELAYS_MS[
      Math.min(Math.max(attempts, 1), WEBHOOK_RETRY_DELAYS_MS.length) - 1
    ] as number;
  }

  private webhookHolderId(registrationId: string): string {
    return `webhook:${registrationId}`;
  }

  private storedWebhookBinding(row: Record<string, unknown>): WebhookBinding | null {
    const name = typeof row.webhook_name === "string" ? row.webhook_name : null;
    const registrationId = typeof row.registration_id === "string" && row.registration_id.length > 0
      ? row.registration_id
      : null;
    const mode = row.webhook_mode === "agent" ? "agent" : row.webhook_mode === "notify" ? "notify" : null;
    const targetOwner = typeof row.target_owner === "string" && row.target_owner.length > 0
      ? row.target_owner
      : null;
    if (name === null || registrationId === null || mode === null) return null;
    if (mode === "agent" && targetOwner === null) return null;
    if (mode === "notify" && targetOwner !== null) return null;
    return { name, registrationId, mode, targetOwner };
  }

  private currentWebhookForBinding(binding: WebhookBinding): WebhookRow | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT name, registration_id, url, secret, filter, mode, target_owner
           FROM webhooks WHERE name = ? AND registration_id = ?`,
        binding.name,
        binding.registrationId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const mode = String(row.mode) === "agent" ? "agent" : "notify";
    const targetOwner = row.target_owner === null || row.target_owner === undefined
      ? null
      : String(row.target_owner);
    if (mode !== binding.mode || targetOwner !== binding.targetOwner) return null;
    return {
      name: String(row.name),
      registrationId: String(row.registration_id),
      url: String(row.url),
      secret: String(row.secret),
      filter: String(row.filter) as WebhookFilter,
      mode,
      targetOwner,
    };
  }

  // #105：把一条被永久放弃的投递落死信表。保留 payload 供 redeliver 原样重投；
  // 有界裁剪——超过上限只留最新 MAX_WEBHOOK_DEAD_LETTERS 条，坏端点写不爆 DO 存储。
  private recordDeadLetter(
    webhookName: string,
    payload: string,
    attempts: number,
    delivery: WebhookDeliveryResult,
    now: number,
    binding: WebhookBinding | null = null,
  ) {
    if (this.scrubRetractedWebhookArtifacts(payload)) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO webhook_dead_letters (
         webhook_name, registration_id, webhook_mode, target_owner,
         mention_seq, payload, attempts, last_status, last_error, dead_lettered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      webhookName,
      binding?.registrationId ?? null,
      binding?.mode ?? null,
      binding?.targetOwner ?? null,
      this.seqFromWebhookPayload(payload),
      payload,
      attempts,
      delivery.status,
      delivery.error,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM webhook_dead_letters
        WHERE id NOT IN (SELECT id FROM webhook_dead_letters ORDER BY id DESC LIMIT ?)`,
      MAX_WEBHOOK_DEAD_LETTERS,
    );
  }

  // 测试专用薄封装：单测直接造死信验证裁剪，不必真跑一整轮重试耗尽。
  recordDeadLetterForTest(
    webhookName: string,
    payload: string,
    attempts: number,
    delivery: WebhookDeliveryResult,
  ) {
    this.recordDeadLetter(webhookName, payload, attempts, delivery, Date.now());
  }

  // #105：重投死信。成功即从死信表清除并记 wake ledger；失败则原地留存、attempts 递增，
  // 绝不静默消失——「重投还是不通」仍是死信，operator 可再试或删 webhook。
  // 不重新入 webhook_queue：redeliver 是一次显式尝试，不重启自动退避循环（least-surprising）。
  private async redeliverDeadLetters(name: string | null): Promise<{ redelivered: number; failed: number; remaining: number }> {
    const where = name === null ? "" : " WHERE dl.webhook_name = ?";
    const args: (string | number)[] = name === null ? [WEBHOOK_REDELIVER_BATCH_SIZE] : [name, WEBHOOK_REDELIVER_BATCH_SIZE];
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT dl.id, dl.webhook_name, dl.registration_id, dl.webhook_mode, dl.target_owner,
                dl.payload, dl.attempts
           FROM webhook_dead_letters dl${where}
          ORDER BY dl.id
          LIMIT ?`,
        ...args,
      )
      .toArray();
    let redelivered = 0;
    let failed = 0;
    const now = Date.now();
    for (const row of rows) {
      const id = Number(row.id);
      const webhookName = String(row.webhook_name);
      const payload = String(row.payload);
      const attempt = Number(row.attempts) + 1;
      if (this.scrubRetractedWebhookArtifacts(payload)) continue;
      const binding = this.storedWebhookBinding(row);
      const hook = binding === null ? null : this.currentWebhookForBinding(binding);
      // A dead letter belongs to one immutable registration. Re-creating the same name is a new
      // endpoint and must never inherit old payload/work/ref data.
      if (binding === null || hook === null) {
        failed++;
        this.ctx.storage.sql.exec(
          "UPDATE webhook_dead_letters SET attempts = ?, last_status = NULL, last_error = ?, dead_lettered_at = ? WHERE id = ?",
          attempt,
          binding === null
            ? "dead letter has no immutable registration identity; redelivery refused"
            : "webhook registration changed; cross-registration redelivery refused",
          now,
          id,
        );
        continue;
      }
      if (binding.mode === "agent" && !this.reclaimDirectedWebhookDeadLetter(payload, binding, now)) {
        failed++;
        this.ctx.storage.sql.exec(
          "UPDATE webhook_dead_letters SET attempts = ?, last_status = NULL, last_error = ?, dead_lettered_at = ? WHERE id = ?",
          attempt,
          "agent delivery is not safely reclaimable for this registration and principal",
          now,
          id,
        );
        continue;
      }
      const delivery = await this.deliverWebhook(hook.url, hook.secret, payload);
      if (this.scrubRetractedWebhookArtifacts(payload)) continue;
      this.recordWakeDelivery({
        mentionSeq: this.seqFromWebhookPayload(payload),
        targetName: webhookName,
        webhookName,
        attempt,
        delivery,
      });
      if (delivery.ok) {
        if (binding.mode === "agent") {
          const acceptedAt = Date.now();
          const accepted = this.acceptDirectedWebhookDelivery(
            payload,
            binding,
            acceptedAt + DIRECTED_WEBHOOK_LEASE_MS,
            acceptedAt,
          );
          const deliveryId = this.directedDeliveryIdFromWebhookPayload(payload);
          const current = deliveryId === null ? undefined : this.directedDeliveryRow(deliveryId);
          if (!accepted && String(current?.state ?? "") !== "replied") {
            failed++;
            this.ctx.storage.sql.exec(
              "UPDATE webhook_dead_letters SET attempts = ?, last_status = NULL, last_error = ?, dead_lettered_at = ? WHERE id = ?",
              attempt,
              "agent webhook handoff lost its exact registration lease",
              acceptedAt,
              id,
            );
            continue;
          }
        }
        redelivered++;
        this.ctx.storage.sql.exec("DELETE FROM webhook_dead_letters WHERE id = ?", id);
        continue;
      }
      failed++;
      if (binding.mode === "agent") {
        this.failDirectedWebhookDelivery(
          payload,
          binding,
          `agent webhook redelivery failed: ${delivery.error ?? `HTTP ${delivery.status ?? "unknown"}`}`,
          Date.now(),
        );
      }
      this.ctx.storage.sql.exec(
        "UPDATE webhook_dead_letters SET attempts = ?, last_status = ?, last_error = ?, dead_lettered_at = ? WHERE id = ?",
        attempt,
        delivery.status,
        delivery.error,
        now,
        id,
      );
    }
    const remaining = Number(
      name === null
        ? this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM webhook_dead_letters").one().n
        : this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM webhook_dead_letters WHERE webhook_name = ?", name).one().n,
    );
    return { redelivered, failed, remaining };
  }

  private listDeadLetters(): {
    id: number;
    webhook_name: string;
    mention_seq: number;
    attempts: number;
    last_status: number | null;
    last_error: string | null;
    dead_lettered_at: number;
  }[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT id, webhook_name, mention_seq, attempts, last_status, last_error, dead_lettered_at
           FROM webhook_dead_letters
          ORDER BY id`,
      )
      .toArray()
      .map((r) => ({
        id: Number(r.id),
        webhook_name: String(r.webhook_name),
        mention_seq: Number(r.mention_seq),
        attempts: Number(r.attempts),
        last_status: r.last_status === null ? null : Number(r.last_status),
        last_error: r.last_error === null ? null : String(r.last_error),
        dead_lettered_at: Number(r.dead_lettered_at),
      }));
  }

  // temp 频道最后一条消息后闲置超时 → 归档：写 do meta + 回写 d1 archived_at + 踢连接
  private async checkTempArchive(now: number) {
    const pending = this.getMeta("archive_pending_at");
    if (this.isArchived()) {
      if (pending !== null) await this.reconcileD1Archive(Number(pending) || now);
      return;
    }
    if (this.getMeta("ckind") !== "temp") return;
    const idleBasis = this.lastActivityTs();
    if (idleBasis === null || now - idleBasis < this.tempIdleMs()) return;
    this.archiveAndKick();
    this.setMeta("archive_pending_at", String(now));
    await this.reconcileD1Archive(now);
  }

  private async reconcileD1Archive(ts: number) {
    try {
      await this.env.DB.prepare(
        "UPDATE channels SET archived_at = ? WHERE slug = ? AND archived_at IS NULL",
      )
        .bind(ts, this.name)
        .run();
      this.deleteMeta("archive_pending_at");
    } catch {
      await this.ensureAlarmAt(Date.now() + 60_000);
    }
  }

  // 各来源里最近的下一个到期时间：presence 扫描 / webhook 重试 / paused 恢复 / temp 归档 / retention 修剪。
  // #487：presence 候选从固定 `now + PRESENCE_SCAN_MS` 改为 `earliestSeen + PRESENCE_SCAN_MS`——即最早一条
  // 存活连接真正可能跨过静默阈值的时刻。健康连接每 25s ping、last 紧贴当下，到期约在 now+95~120s，等于把
  // 空转的每分钟唤醒拉到近两分钟一次（无连接则彻底不排，让 DO 睡到别的 candidate）。webhook/paused/temp/
  // retention 候选一律照旧，各自的 alarm 用途不受影响（#180 / #128 / temp 归档仍按点触发）。
  private async scheduleNextAlarm(
    now: number,
    scan: { live: number; earliestSeen: number | null; earliestHelloDeadline: number | null },
  ) {
    const candidates: number[] = [];
    if (scan.live > 0 && scan.earliestSeen !== null) {
      candidates.push(scan.earliestSeen + PRESENCE_SCAN_MS);
    }
    if (scan.earliestHelloDeadline !== null) candidates.push(scan.earliestHelloDeadline);
    const next = this.ctx.storage.sql
      .exec("SELECT MIN(next_retry_at) AS t FROM webhook_queue")
      .one();
    if (next.t !== null) candidates.push(Number(next.t));
    const nextDeliveryLease = this.ctx.storage.sql
      .exec("SELECT MIN(lease_until) AS t FROM directed_deliveries WHERE state IN ('claimed', 'running') AND lease_until IS NOT NULL")
      .one();
    if (nextDeliveryLease.t !== null) candidates.push(Number(nextDeliveryLease.t));
    const oldestActiveDelivery = this.ctx.storage.sql
      .exec("SELECT MIN(created_at) AS t FROM directed_deliveries WHERE state IN ('queued', 'claimed', 'running', 'waiting_owner')")
      .one();
    if (oldestActiveDelivery.t !== null) {
      candidates.push(Number(oldestActiveDelivery.t) + DIRECTED_DELIVERY_MAX_AGE_MS);
    }
    const oldestTerminalLeaf = this.ctx.storage.sql
      .exec(
        `SELECT MIN(delivery.updated_at) AS t FROM directed_deliveries delivery
          WHERE delivery.state IN ('replied', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM directed_deliveries child
               WHERE child.parent_delivery_id = delivery.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM messages question
               WHERE question.decision_state = 'pending'
                 AND question.decision_request_json IS NOT NULL
                 AND json_valid(question.decision_request_json)
                 AND json_extract(question.decision_request_json, '$.delivery_id') = delivery.id
            )`,
      )
      .one();
    if (oldestTerminalLeaf.t !== null) {
      candidates.push(Number(oldestTerminalLeaf.t) + DIRECTED_DELIVERY_TERMINAL_RETENTION_MS);
    }
    // 暂停接待的定时恢复（issue #180）：取最近的一个未来恢复时刻作为候选，前移 alarm 到点自动恢复。
    const nextResume = this.ctx.storage.sql
      .exec("SELECT MIN(paused_resume_at) AS t FROM presence WHERE paused_resume_at IS NOT NULL")
      .one();
    if (nextResume.t !== null) candidates.push(Number(nextResume.t));
    if (this.getMeta("archive_pending_at") !== null) candidates.push(now + 60_000);
    if (this.getMeta("ckind") === "temp" && !this.isArchived()) {
      const basis = this.lastActivityTs();
      if (basis !== null) candidates.push(basis + this.tempIdleMs());
    }
    const messageRetention = this.retentionMs("message_retention_ms");
    if (messageRetention !== null) {
      const oldest = this.ctx.storage.sql.exec("SELECT MIN(ts) AS t FROM messages").one().t;
      if (oldest !== null) candidates.push(Number(oldest) + messageRetention);
    }
    const auditRetention = this.retentionMs("audit_retention_ms");
    if (auditRetention !== null) {
      const oldest = this.ctx.storage.sql.exec("SELECT MIN(created_at) AS t FROM message_audit").one().t;
      if (oldest !== null) candidates.push(Number(oldest) + auditRetention);
    }
    if (candidates.length > 0) {
      await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now + 1000));
    }
  }

  private markOffline(name: string, sessionId: string, ts: number) {
    this.ctx.storage.sql.exec(
      // 离线时清掉每任务心跳（#228）：否则一次硬崩后再上线（发个 status 但不带心跳），旧的 current_task
      // 会借尸还魂显示成「还在处理」。心跳字段与「活着」正交，离线即无任务，直接清空最干净。
      `INSERT INTO presence (name, session_id, state, note, updated_at) VALUES (?, ?, 'offline', NULL, ?)
       ON CONFLICT(name, session_id) DO UPDATE SET state = 'offline', updated_at = excluded.updated_at,
         current_task = NULL, task_started_at = NULL, heartbeat_at = NULL, activity_json = NULL,
         runner_health_json = NULL,
         -- #454：watch 只有活着的本地 listener 才能接住 @。最后一条连接断开后立即撤销 wake 声明，
         -- 不让被 harness kill 的 watch --once 继续以 wakeable 身份吸收 mention。serve/webhook 有独立
         -- supervisor/服务端投递语义，保持原样；watch 重挂后会由 advertiseWatchWake 重新声明。
         wake_verified_at = CASE WHEN wake_kind = 'watch' THEN NULL ELSE wake_verified_at END,
         wake_kind = CASE WHEN wake_kind = 'watch' THEN NULL ELSE wake_kind END`,
      name,
      sessionId,
      ts,
    );
    const frame: PresenceFrame = { type: "presence", name, state: "offline", note: null, ts };
    const entry = this.presenceFor(name);
    this.broadcastFrame(entry ? { type: "presence", ...entry } : frame);
  }

  private materializeConnectionPresence(identity: ConnState, sessionId: string, ts: number) {
    const previous = this.ctx.storage.sql
      .exec(
        `SELECT status_scope_json, status_summary_seq, status_blocked_reason, status_context_json,
                status_decision_json, status_workflow_json, role, role_source, residency,
                wake_kind, wake_verified_at, context_json, lineage_json, client_version,
                paused_at, paused_resume_at
           FROM presence WHERE name = ? AND session_id != ?
          ORDER BY updated_at DESC LIMIT 1`,
        identity.name,
        sessionId,
      )
      .toArray()[0];
    this.ctx.storage.sql.exec(
      `INSERT INTO presence (
         name, session_id, kind, account, handle, display_name, avatar_url, avatar_thumb,
         state, note, updated_at,
         status_scope_json, status_summary_seq, status_blocked_reason, status_context_json,
         status_decision_json, status_workflow_json, role, role_source, residency,
         wake_kind, wake_verified_at, context_json, lineage_json, client_version,
         paused_at, paused_resume_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, session_id) DO UPDATE SET
         kind = excluded.kind,
         account = COALESCE(excluded.account, presence.account),
         handle = COALESCE(excluded.handle, presence.handle),
         display_name = COALESCE(excluded.display_name, presence.display_name),
         avatar_url = COALESCE(excluded.avatar_url, presence.avatar_url),
         avatar_thumb = COALESCE(excluded.avatar_thumb, presence.avatar_thumb),
         lineage_json = COALESCE(excluded.lineage_json, presence.lineage_json)`,
      identity.name,
      sessionId,
      identity.kind,
      identity.owner ?? null,
      identity.handle ?? null,
      identity.displayName ?? null,
      identity.avatarUrl ?? null,
      identity.avatarThumb ?? null,
      ts,
      previous?.status_scope_json ?? null,
      previous?.status_summary_seq ?? null,
      previous?.status_blocked_reason ?? null,
      previous?.status_context_json ?? null,
      previous?.status_decision_json ?? null,
      previous?.status_workflow_json ?? null,
      previous?.role ?? null,
      previous?.role_source ?? null,
      previous?.residency ?? null,
      previous?.wake_kind ?? null,
      previous?.wake_verified_at ?? null,
      previous?.context_json ?? null,
      identity.lineage === undefined ? (previous?.lineage_json ?? null) : JSON.stringify(identity.lineage),
      previous?.client_version ?? null,
      previous?.paused_at ?? null,
      previous?.paused_resume_at ?? null,
    );
  }

  private cleanupPresenceSession(name: string, sessionId: string, ts: number) {
    const hasOtherLiveSession = [...this.getConnections<ConnState>()].some(
      (connection) => connection.id !== sessionId && connection.state?.name === name,
    );
    if (hasOtherLiveSession) {
      this.ctx.storage.sql.exec("DELETE FROM presence WHERE name = ? AND session_id = ?", name, sessionId);
      const entry = this.presenceFor(name);
      if (entry) this.broadcastFrame({ type: "presence", ...entry });
      return;
    }
    // Bound reconnect churn: once the identity is fully disconnected, retain only its final offline snapshot.
    this.ctx.storage.sql.exec("DELETE FROM presence WHERE name = ? AND session_id != ?", name, sessionId);
    this.markOffline(name, sessionId, ts);
  }

  private recordClientVersion(name: string, sessionId: string, clientVersion: string, ts: number) {
    this.ctx.storage.sql.exec(
      `INSERT INTO presence (name, session_id, state, note, updated_at, client_version) VALUES (?, ?, 'waiting', NULL, ?, ?)
       ON CONFLICT(name, session_id) DO UPDATE SET client_version = excluded.client_version`,
      name,
      sessionId,
      ts,
      clientVersion,
    );
    const entry = this.presenceFor(name);
    if (entry) this.broadcastFrame({ type: "presence", ...entry });
  }

  // 每任务进度/心跳（#228）+ runner session 自报（#522）：只更新 presence，不落 history。
  // 不碰 state/note/busy、不落 history（presence-only，不刷屏）。仅当已有这行 presence 时才更新+广播；
  // 从没发过 presence（连 status 都没发）就无从附着，直接忽略。current_task=null 即清除（任务结束）。
  private applyTaskHeartbeat(name: string, sessionId: string, hb: ParsedTaskHeartbeat) {
    const exists =
      this.ctx.storage.sql
        .exec("SELECT 1 FROM presence WHERE name = ? AND session_id = ? LIMIT 1", name, sessionId)
        .toArray().length > 0;
    if (!exists) return;
    this.ctx.storage.sql.exec(
      // activity（#602）/ runner_health（#603）不走 COALESCE：本拍没带就清空，绝不留僵值
      //（activity 新鲜度与心跳同生共死；runner_health 恢复即自动清零）。
      // 清除帧（current_task=null）即便捎带了 activity 也一并清——没有任务就没有活动可言。
      `UPDATE presence SET current_task = ?, task_started_at = ?, heartbeat_at = ?,
         activity_json = ?,
         runner_health_json = ?,
         agent_session_json = COALESCE(?, agent_session_json)
       WHERE name = ? AND session_id = ?`,
      hb.current_task,
      hb.task_started_at,
      hb.heartbeat_at,
      // 未来时间戳与 REST 直报同口径按脏值丢弃（容忍 60s 抖动）——ts 是序列化 TTL 的输入，
      // 远未来值会让僵活动永不过期。
      hb.current_task === null || hb.activity === undefined || hb.activity.ts - Date.now() > 60_000
        ? null
        : JSON.stringify(hb.activity),
      hb.runner_health === undefined ? null : JSON.stringify(hb.runner_health),
      hb.agent_session === undefined ? null : JSON.stringify(hb.agent_session),
      name,
      sessionId,
    );
    const entry = this.presenceFor(name);
    if (entry) this.broadcastFrame({ type: "presence", ...entry });
  }

  // 人为「暂停接待」（issue #180）：某个 name 当前是否被暂停。唤醒抑制的唯一权威判据。
  private isPresencePaused(name: string): boolean {
    const row = this.ctx.storage.sql
      .exec("SELECT paused_at FROM presence WHERE name = ?", name)
      .toArray()[0];
    return row !== undefined && row.paused_at !== null && row.paused_at !== undefined;
  }

  // 暂停某 agent 的接待：写 paused_at（可选 paused_resume_at 定时恢复）。不动 state/updated_at，
  // 故不干扰在线/新鲜度/host 租约判定——暂停与「活没活」正交。有定时点则前移 alarm 到点自动恢复。
  private pausePresence(name: string, resumeAt: number | null, now: number) {
    const exists = this.ctx.storage.sql.exec("SELECT 1 FROM presence WHERE name = ? LIMIT 1", name).toArray().length > 0;
    if (!exists) {
      this.ctx.storage.sql.exec(
        `INSERT INTO presence (name, session_id, state, note, updated_at)
         VALUES (?, ?, 'waiting', NULL, ?)`,
        name,
        LEGACY_SESSION_ID,
        now,
      );
    }
    this.ctx.storage.sql.exec(
      "UPDATE presence SET paused_at = ?, paused_resume_at = ? WHERE name = ?",
      now,
      resumeAt,
      name,
    );
    const entry = this.presenceFor(name);
    if (entry) this.broadcastFrame({ type: "presence", ...entry });
    const when = resumeAt !== null ? `，将于 ${new Date(resumeAt).toISOString()} 自动恢复` : "（需手动恢复）";
    this.insertSystemStatus(`${name} 已被暂停接待${when}`, now, false, { state: "waiting" });
    if (resumeAt !== null) void this.ensureAlarmAt(resumeAt);
  }

  // 恢复某 agent 的接待：清 paused_at/paused_resume_at。手动恢复与定时恢复共用。
  private resumePresence(name: string, now: number): boolean {
    const wasPaused = this.isPresencePaused(name);
    this.ctx.storage.sql.exec(
      "UPDATE presence SET paused_at = NULL, paused_resume_at = NULL WHERE name = ?",
      name,
    );
    if (!wasPaused) return false;
    const entry = this.presenceFor(name);
    if (entry) this.broadcastFrame({ type: "presence", ...entry });
    this.insertSystemStatus(`${name} 已恢复接待`, now, false, { state: "waiting" });
    this.dispatchNextDirectedDelivery(name);
    return true;
  }

  // alarm 到点：清掉所有 paused_resume_at 已过期的暂停（定时自动恢复，issue #180）。
  private resumeDuePauses(now: number) {
    const due = this.ctx.storage.sql
      .exec("SELECT DISTINCT name FROM presence WHERE paused_resume_at IS NOT NULL AND paused_resume_at <= ?", now)
      .toArray();
    for (const row of due) this.resumePresence(String(row.name), now);
  }

  // worker 每次转发都会带上频道快照头，do 写 meta 缓存（同 archived 的手法）
  // 每个请求都带着自己那一刻的 D1 快照头进来。无脑 last-writer-wins 会让在途旧快照回滚
  // 刚改的配置（#102）——正如 archived 早就防住的同一竞态：archived 只由权威路径写、且是单向
  // 闩，旧快照掀不回去。这里对 charter_rev / guard config 补上同款防线：
  //   - charter_rev 天生是单调计数器（D1 里只 +1），只接受 rev ≥ 已缓存值；旧快照的小 rev 丢弃。
  //   - guard config（loop/workflow 的 enabled/limit）没有自带版本号，无法比较新旧。于是照搬
  //     archived 的手法「DO 自己写下的值即权威」：只有权威配置推送（/internal/init，由 guard PUT
  //     触发）能改动已缓存的 guard 值；在途请求的顺带快照只能在 DO 从未缓存过时做首次播种，绝不
  //     覆盖已有值——这样管理员刚关掉的 guard 不会被旧快照又打开。
  private cacheChannelMeta(h: Headers, host: string | null, opts?: { authoritative?: boolean }) {
    const authoritative = opts?.authoritative === true;
    // Worker routes every request through the DO selected by this authoritative room slug. Keep a
    // local copy so decision lineage can name its origin channel without trusting client payload.
    const channelSlug = h.get("x-partykit-room");
    if (
      channelSlug !== null &&
      channelSlug.length > 0 &&
      byteLength(channelSlug) <= DELIVERY_ORIGIN_CHANNEL_LIMIT
    ) {
      this.setMeta("channel_slug", channelSlug);
    }
    const mode = h.get("x-ap-mode");
    if (mode === "normal" || mode === "party") this.setMeta("mode", mode);
    const ckind = h.get("x-ap-channel-kind");
    if (ckind === "standing" || ckind === "temp") this.setMeta("ckind", ckind);
    const completionGate = h.get("x-ap-completion-gate");
    if (completionGate === "off" || completionGate === "reviewer") this.setMeta("completion_gate", completionGate);
    const completionReviewPolicy = h.get("x-ap-completion-review-policy");
    if (completionReviewPolicy === "sender" || completionReviewPolicy === "owner") {
      this.setMeta("completion_review_policy", completionReviewPolicy);
    }
    const decisionMode = h.get("x-ap-decision-mode");
    if (decisionMode === "approval" || decisionMode === "unattended") this.setMeta("decision_mode", decisionMode);
    // #381：缓存频道可见性，供 handleSend 判 public_watch 写门。缺失/非法值不覆盖已缓存值
    // （旧路径不带此头时保留旧值；PUT visibility 会经 /internal/init 权威刷新）。
    const visibility = h.get("x-ap-visibility");
    if (visibility === "public" || visibility === "private" || visibility === "public_watch") {
      this.setMeta("visibility", visibility);
    }
    // loop guard：权威推送随意改；顺带快照只在从未缓存 enabled 时播种，不回滚
    if (authoritative || this.getMeta("loop_guard_enabled") === null) {
      const loopGuardEnabled = h.get("x-ap-loop-guard-enabled");
      if (loopGuardEnabled === "0" || loopGuardEnabled === "1") {
        this.setMeta("loop_guard_enabled", loopGuardEnabled);
        if (loopGuardEnabled === "0") this.deleteMeta("loop_guard_limit");
      }
      const rawLoopGuardLimit = h.get("x-ap-loop-guard-limit");
      if (rawLoopGuardLimit === "") this.deleteMeta("loop_guard_limit");
      const loopGuardLimit = Number(rawLoopGuardLimit ?? "");
      if (Number.isInteger(loopGuardLimit) && loopGuardLimit > 0) {
        this.setMeta("loop_guard_limit", String(Math.min(loopGuardLimit, 10_000)));
      }
    }
    // workflow guard：同上
    if (authoritative || this.getMeta("workflow_guard_enabled") === null) {
      const workflowGuardEnabled = h.get("x-ap-workflow-guard-enabled");
      if (workflowGuardEnabled === "0" || workflowGuardEnabled === "1") {
        this.setMeta("workflow_guard_enabled", workflowGuardEnabled);
      }
      const workflowGuardLimit = Number(h.get("x-ap-workflow-guard-limit") ?? "");
      if (Number.isInteger(workflowGuardLimit) && workflowGuardLimit > 0) {
        this.setMeta("workflow_guard_limit", String(Math.min(workflowGuardLimit, 1000)));
      }
    }
    if (authoritative || this.getMeta("message_retention_ms") === null) {
      const raw = h.get("x-ap-message-retention-ms");
      if (raw === "") this.setMeta("message_retention_ms", "off");
      const value = Number(raw ?? "");
      if (Number.isSafeInteger(value) && value >= 60_000) this.setMeta("message_retention_ms", String(value));
    }
    if (authoritative || this.getMeta("audit_retention_ms") === null) {
      const raw = h.get("x-ap-audit-retention-ms");
      if (raw === "") this.setMeta("audit_retention_ms", "off");
      const value = Number(raw ?? "");
      if (Number.isSafeInteger(value) && value >= 60_000) this.setMeta("audit_retention_ms", String(value));
    }
    // charter_rev：单调守卫，只前进不后退（旧快照的小 rev 丢弃）
    const charterRev = Number(h.get("x-ap-charter-rev") ?? "");
    if (Number.isInteger(charterRev) && charterRev >= 0) {
      const cachedRaw = Number(this.getMeta("charter_rev") ?? "");
      const cached = Number.isInteger(cachedRaw) ? cachedRaw : -1;
      if (charterRev >= cached) this.setMeta("charter_rev", String(charterRev));
    }
    if (host) this.setMeta("host", host);
  }

  // 消息落库广播之后的副作用：serve/watch 唤醒审计 + webhook 投递 + temp 归档计时续排
  private async afterSend(
    msg: MsgFrame,
    deliveryTargets?: string[],
    deliveriesAlreadyStaged = false,
    deliveryTargetOwners?: Record<string, string>,
  ) {
    // #551：先把 @agent work 落到独立队列，再做网络型副作用。消息正文仍只在 messages；
    // delivery 只引用 seq，因此断线、已读游标前移和 DO hibernate 都不会把 work 吞掉。
    if (!deliveriesAlreadyStaged) {
      this.ensureDirectedDeliveries(
        msg,
        deliveryTargets ?? await this.agentMentionTargets(msg),
        deliveryTargetOwners ?? {},
      );
    }
    // approval-mode decision requests have already atomically moved their source work to
    // waiting_owner inside handleSend. Only after the request + delivery_state were broadcast may
    // the same serve lease receive the next queued work; waiting rows deliberately do not serialize
    // unrelated work behind a human response.
    if (
      msg.decision_request?.delivery_id !== undefined &&
      msg.decision_resolution?.state === "pending"
    ) {
      this.dispatchNextDirectedDelivery(msg.sender.name);
    }
    // #107：serve/watch 目标的 @ 广播即落 ledger（同步 SQL，不烧订阅、不发网络）——补齐它们缺失的服务端唤醒审计。
    this.recordServeWatchWakes(msg);
    // 首投移出发送关键路径：坏/慢端点不再让每条消息阻塞 N×10s 才返回 seq（DoS 频道）
    this.ctx.waitUntil(this.dispatchWebhooks(msg));
    // #607：@ 到「谁都收不到」的人类时给发送者可见反馈，不再静默吞。
    this.ctx.waitUntil(this.warnUnreachableHumanMentions(msg));
    if (this.getMeta("ckind") === "temp" && !this.isArchived()) {
      await this.ensureAlarmAt(msg.ts + this.tempIdleMs());
    }
    const retention = this.retentionMs("message_retention_ms");
    if (retention !== null) await this.ensureAlarmAt(msg.ts + retention);
  }

  // spec §15：对每个 webhook 判 filter → 立即尝试投递，失败入队由 alarm 重试
  private async dispatchWebhooks(msg: MsgFrame) {
    // system 帧默认不触发 webhook，防止失败风暴自激；loop guard 例外，因为它需要唤醒人类。
    if (msg.sender.name === "system" && !this.isLoopGuardStatus(msg) && !this.isWorkflowGuardStatus(msg)) return;
    if (this.isMessageRetracted(msg.seq)) return;
    const hooks = this.ctx.storage.sql
      .exec("SELECT name, registration_id, url, secret, filter, mode, target_owner FROM webhooks")
      .toArray()
      .map((r) => ({
        name: String(r.name),
        registrationId: String(r.registration_id),
        url: String(r.url),
        secret: String(r.secret),
        filter: String(r.filter) as WebhookFilter,
        mode: String(r.mode) === "agent" ? "agent" : "notify",
        targetOwner: r.target_owner === null || r.target_owner === undefined ? null : String(r.target_owner),
      })) as WebhookRow[];
    if (hooks.length === 0) return;
    const host = this.getMeta("host") ?? "agentparty";
    const now = Date.now();
    // 暂停接待（issue #180）的抑制点：命中的 hook 里剔掉当前被人为暂停的目标——webhook 一律不投。
    // 这里在 afterSend 之后跑，消息早已落库+广播，历史/广播完全不受影响，只是不把「唤醒」推给暂停者。
    const targets = hooks.filter(
      (hook) => {
        if (
          hook.mode !== "notify" ||
          !this.shouldDeliverWebhook(hook.filter, hook.name, msg) ||
          this.isPresencePaused(hook.name)
        ) return false;
        const directed = this.ctx.storage.sql
          .exec(
            "SELECT state FROM directed_deliveries WHERE message_seq = ? AND target_name = ? LIMIT 1",
            msg.seq,
            hook.name,
          )
          .toArray()[0];
        // Legacy notify hooks may still be used as agent wake accelerators. If serve/watch already
        // claimed this exact work, suppress the parallel HTTP wake; when no executor is online the
        // row stays queued and notify remains useful without owning correctness.
        return directed === undefined || String(directed.state) === "queued";
      },
    );
    if (targets.length === 0) return;
    // #108 per-agent wake 预算：在真正投递（烧订阅）之前判每个目标是否已超窗口内 wake 硬上限。
    // 超额者不投 webhook（这是「webhook not fired」的强制点），落 wake_delivery_ledger 的 budget
    // 行做归属审计（哪条 mention_seq、谁被 @），并按窗口去重地在频道内 system status 通告一次可观测。
    const firing: WebhookRow[] = [];
    for (const hook of targets) {
      if (this.isOverWakeBudget(hook.name, now)) {
        this.recordWakeWithheld(msg.seq, hook.name, now);
        this.alertWakeBudget(hook.name, now);
      } else {
        firing.push(hook);
      }
    }
    if (firing.length === 0) return;
    // 并行投递：一个慢/坏端点不再拖累其余 hook（首投已由 afterSend 的 waitUntil 移出发送关键路径）
    const results = await Promise.all(
      firing.map(async (hook) => {
        const directed = this.ctx.storage.sql
          .exec(
            "SELECT * FROM directed_deliveries WHERE message_seq = ? AND target_name = ? LIMIT 1",
            msg.seq,
            hook.name,
          )
          .toArray()[0];
        const payload = JSON.stringify({
          ...publicMsgFrame(msg),
          channel: this.name,
          permalink: `https://${host}/c/${this.name}`,
          ...(directed === undefined
            ? {}
            : {
                directed_delivery: this.rowToPublicDirectedDelivery(directed),
                directed_delivery_adapter: "notify",
              }),
        });
        return { hook, payload, delivery: await this.deliverWebhook(hook.url, hook.secret, payload) };
      }),
    );
    let needAlarm = false;
    for (const { hook, payload, delivery } of results) {
      if (this.scrubRetractedWebhookArtifacts(payload)) continue;
      this.recordWakeDelivery({
        mentionSeq: msg.seq,
        targetName: hook.name,
        webhookName: hook.name,
        attempt: 1,
        delivery,
      });
      if (delivery.ok) continue;
      const queued = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM webhook_queue").one().n);
      if (queued >= MAX_WEBHOOK_QUEUE_ROWS) {
        // #105：队列满不再直接丢——落死信表，operator 事后可查可重投。
        this.recordDeadLetter(hook.name, payload, 1, delivery, now, hook);
        await this.insertSystemStatus("webhook retry queue is full; delivery moved to dead-letters", now, false, { state: "blocked" });
        continue;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO webhook_queue (
           webhook_name, registration_id, webhook_mode, target_owner, payload, attempts, next_retry_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
        hook.name,
        hook.registrationId,
        hook.mode,
        hook.targetOwner,
        payload,
        now + this.retryDelay(1),
      );
      needAlarm = true;
    }
    if (needAlarm) await this.ensureAlarmAt(now + this.retryDelay(1));
  }

  /** An agent-mode webhook competes for the same durable work as serve/watch. */
  private async dispatchDirectedWebhook(
    hook: WebhookRow,
    row: Record<string, unknown>,
    msg: MsgFrame,
  ) {
    const delivery = this.rowToDirectedDelivery(row);
    const payload = JSON.stringify({
      ...msg,
      channel: this.name,
      permalink: `https://${this.getMeta("host") ?? "agentparty"}/c/${this.name}`,
      directed_delivery: delivery,
      directed_delivery_adapter: "agent",
    });
    if (this.scrubRetractedWebhookArtifacts(payload)) return;
    const attemptedAt = Date.now();
    const result = await this.deliverWebhook(
      hook.url,
      hook.secret,
      payload,
      `agentparty-delivery-${delivery.id}`,
    );
    if (this.scrubRetractedWebhookArtifacts(payload)) return;
    this.recordWakeDelivery({
      mentionSeq: delivery.message_seq,
      targetName: delivery.target_name,
      webhookName: hook.name,
      attempt: delivery.attempt,
      delivery: result,
    });
    if (!this.directedWebhookStillClaimed(payload, hook)) return;
    if (result.ok) {
      const acceptedAt = Date.now();
      this.acceptDirectedWebhookDelivery(
        payload,
        hook,
        acceptedAt + DIRECTED_WEBHOOK_LEASE_MS,
        acceptedAt,
      );
      return;
    }
    if (this.currentWebhookForBinding(hook) === null) {
      this.failDirectedWebhookDelivery(
        payload,
        hook,
        "agent webhook registration changed before retry could be persisted",
        Date.now(),
      );
      return;
    }
    const queued = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM webhook_queue").one().n);
    if (queued >= MAX_WEBHOOK_QUEUE_ROWS) {
      this.recordDeadLetter(hook.name, payload, delivery.attempt, result, attemptedAt, hook);
      this.failDirectedWebhookDelivery(
        payload,
        hook,
        "agent webhook retry queue is full; delivery moved to dead-letters",
        attemptedAt,
      );
      return;
    }
    const nextRetryAt = attemptedAt + this.retryDelay(1);
    this.ctx.storage.sql.exec(
      `INSERT INTO webhook_queue (
         webhook_name, registration_id, webhook_mode, target_owner, payload, attempts, next_retry_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      hook.name,
      hook.registrationId,
      hook.mode,
      hook.targetOwner,
      payload,
      nextRetryAt,
    );
    this.renewDirectedWebhookLease(
      delivery.id,
      hook,
      nextRetryAt + DIRECTED_WEBHOOK_LEASE_MS,
    );
    await this.ensureAlarmAt(nextRetryAt);
  }

  private shouldDeliverWebhook(filter: WebhookFilter, hookName: string, msg: MsgFrame): boolean {
    switch (filter) {
      case "all":
        return true;
      case "mentions":
        return msg.mentions.includes(hookName);
      case "status":
        return msg.kind === "status";
      case "needs-human":
        return this.isHumanAttentionStatus(msg);
      default:
        return false;
    }
  }

  private isHumanAttentionStatus(msg: MsgFrame): boolean {
    if (msg.kind !== "status") return false;
    return msg.state === "blocked" || msg.state === "done" || this.isLoopGuardStatus(msg);
  }

  private isLoopGuardStatus(msg: MsgFrame): boolean {
    return msg.kind === "status" && msg.sender.name === "system" && msg.body.startsWith("loop guard tripped:");
  }

  private isWorkflowGuardStatus(msg: MsgFrame): boolean {
    return (
      msg.kind === "status" &&
      msg.sender.name === "system" &&
      msg.body.startsWith("workflow guard tripped:") &&
      msg.status?.workflow !== undefined
    );
  }

  // 短超时 POST；Bearer = 注册时的 secret，HMAC 签 payload 供接收方校验（spec §15）
  private directedDeliveryIdFromWebhookPayload(payload: string): string | null {
    try {
      const parsed = JSON.parse(payload) as { directed_delivery?: { id?: unknown } };
      return typeof parsed.directed_delivery?.id === "string" && parsed.directed_delivery.id.length > 0
        ? parsed.directed_delivery.id
        : null;
    } catch {
      return null;
    }
  }

  private directedWebhookPayloadMatchesBinding(
    payload: string,
    binding: WebhookBinding,
    row: Record<string, unknown>,
  ): boolean {
    try {
      const parsed = JSON.parse(payload) as {
        directed_delivery_adapter?: unknown;
        directed_delivery?: {
          id?: unknown;
          message_seq?: unknown;
          target_name?: unknown;
          work_id?: unknown;
          continuation_ref?: unknown;
        };
      };
      if (parsed.directed_delivery_adapter !== binding.mode) return false;
      if (binding.mode === "notify") return true;
      const delivery = parsed.directed_delivery;
      return (
        delivery !== undefined &&
        delivery.id === String(row.id) &&
        delivery.message_seq === Number(row.message_seq) &&
        delivery.target_name === String(row.target_name) &&
        delivery.work_id === String(row.work_id ?? "") &&
        delivery.continuation_ref === String(row.continuation_ref ?? "") &&
        binding.name === String(row.target_name) &&
        binding.targetOwner === String(row.target_owner ?? "")
      );
    } catch {
      return false;
    }
  }

  private directedWebhookStillClaimed(payload: string, binding: WebhookBinding): boolean {
    const deliveryId = this.directedDeliveryIdFromWebhookPayload(payload);
    if (deliveryId === null || binding.mode !== "agent") return false;
    const row = this.directedDeliveryRow(deliveryId);
    return (
      row !== undefined &&
      this.directedWebhookPayloadMatchesBinding(payload, binding, row) &&
      String(row.state) === "claimed" &&
      String(row.lease_adapter) === "webhook" &&
      String(row.lease_connection_id) === this.webhookHolderId(binding.registrationId)
    );
  }

  private directedWebhookCanRetry(payload: string, binding: WebhookBinding): boolean {
    const deliveryId = this.directedDeliveryIdFromWebhookPayload(payload);
    if (deliveryId === null) return true;
    try {
      const parsed = JSON.parse(payload) as { directed_delivery_adapter?: unknown };
      if (parsed.directed_delivery_adapter === "notify") {
        if (binding.mode !== "notify") return false;
        const row = this.directedDeliveryRow(deliveryId);
        return row !== undefined && String(row.state) === "queued";
      }
    } catch {
      return false;
    }
    return this.directedWebhookStillClaimed(payload, binding);
  }

  private acceptDirectedWebhookDelivery(
    payload: string,
    binding: WebhookBinding,
    leaseUntil: number,
    now: number,
  ): boolean {
    const deliveryId = this.directedDeliveryIdFromWebhookPayload(payload);
    if (deliveryId === null || binding.mode !== "agent") return false;
    const before = this.directedDeliveryRow(deliveryId);
    if (before === undefined || !this.directedWebhookPayloadMatchesBinding(payload, binding, before)) return false;
    const holder = this.webhookHolderId(binding.registrationId);
    this.ctx.storage.sql.exec(
      `UPDATE directed_deliveries
          SET state = 'running', lease_until = ?, last_error = NULL,
              terminal_reason = NULL, updated_at = ?
        WHERE id = ? AND state = 'claimed' AND lease_adapter = 'webhook'
          AND lease_connection_id = ? AND target_owner = ?`,
      leaseUntil,
      now,
      deliveryId,
      holder,
      binding.targetOwner,
    );
    const running = this.directedDeliveryRow(deliveryId);
    if (running === undefined || String(running.state) !== "running") return false;
    this.broadcastDirectedDelivery(running);
    this.ctx.waitUntil(this.ensureAlarmAt(leaseUntil));
    return true;
  }

  private reclaimDirectedWebhookDeadLetter(
    payload: string,
    binding: WebhookBinding,
    now: number,
  ): boolean {
    const deliveryId = this.directedDeliveryIdFromWebhookPayload(payload);
    if (deliveryId === null || binding.mode !== "agent") return false;
    const row = this.directedDeliveryRow(deliveryId);
    if (
      row === undefined ||
      !this.directedWebhookPayloadMatchesBinding(payload, binding, row) ||
      String(row.state) !== "failed" ||
      String(row.terminal_reason ?? "") !== "webhook_delivery_failed"
    ) return false;
    const holder = this.webhookHolderId(binding.registrationId);
    const leaseUntil = now + DIRECTED_WEBHOOK_LEASE_MS;
    this.ctx.storage.sql.exec(
      `UPDATE directed_deliveries
          SET state = 'claimed', attempt = attempt + 1,
              lease_connection_id = ?, last_lease_connection_id = ?, lease_adapter = 'webhook',
              lease_until = ?, last_error = NULL, terminal_reason = NULL, updated_at = ?
        WHERE id = ? AND state = 'failed' AND terminal_reason = 'webhook_delivery_failed'
          AND target_name = ? AND target_owner = ?`,
      holder,
      holder,
      leaseUntil,
      now,
      deliveryId,
      binding.name,
      binding.targetOwner,
    );
    const claimed = this.directedDeliveryRow(deliveryId);
    if (
      claimed === undefined ||
      String(claimed.state) !== "claimed" ||
      String(claimed.lease_connection_id) !== holder
    ) return false;
    this.broadcastDirectedDelivery(claimed);
    this.ctx.waitUntil(this.ensureAlarmAt(leaseUntil));
    return true;
  }

  private renewDirectedWebhookLease(
    deliveryId: string,
    binding: WebhookBinding,
    leaseUntil: number,
  ) {
    this.ctx.storage.sql.exec(
      `UPDATE directed_deliveries
          SET lease_until = MAX(COALESCE(lease_until, 0), ?), updated_at = MAX(updated_at, ?)
        WHERE id = ? AND state = 'claimed' AND lease_adapter = 'webhook'
          AND lease_connection_id = ? AND target_owner = ?`,
      leaseUntil,
      Date.now(),
      deliveryId,
      this.webhookHolderId(binding.registrationId),
      binding.targetOwner,
    );
    this.ctx.waitUntil(this.ensureAlarmAt(leaseUntil));
  }

  private failDirectedWebhookDelivery(
    payload: string,
    binding: WebhookBinding | null,
    error: string,
    now: number,
  ) {
    const deliveryId = this.directedDeliveryIdFromWebhookPayload(payload);
    if (deliveryId === null) return;
    const row = this.directedDeliveryRow(deliveryId);
    if (row === undefined) return;
    if (binding !== null) {
      if (binding.mode !== "agent" || !this.directedWebhookPayloadMatchesBinding(payload, binding, row)) return;
      if (String(row.lease_connection_id) !== this.webhookHolderId(binding.registrationId)) return;
    }
    this.transitionDirectedDeliveryTerminal(deliveryId, "failed", now, {
      error,
      terminalReason: "webhook_delivery_failed",
      expectedStates: ["claimed", "running"],
      expectedLeaseAdapter: "webhook",
      ...(binding === null
        ? {}
        : { expectedLeaseConnectionId: this.webhookHolderId(binding.registrationId) }),
    });
  }

  private async deliverWebhook(
    url: string,
    secret: string,
    payload: string,
    stableRequestId?: string,
  ): Promise<WebhookDeliveryResult> {
    try {
      const signature = await hmacSha256Hex(secret, payload);
      const directedId = this.directedDeliveryIdFromWebhookPayload(payload);
      const requestId = stableRequestId ?? (directedId === null
        ? `agentparty-${await sha256Hex(payload)}`
        : `agentparty-delivery-${directedId}`);
      const res = await fetch(url, {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
          "x-agentparty-signature": `hmac-sha256=${signature}`,
          // Hermes Agent's generic webhook adapter accepts the same HMAC as a
          // raw hex digest. Keep AgentParty's namespaced header as the primary
          // contract and send the compatibility header alongside it.
          "x-webhook-signature": signature,
          // Derived only from the immutable payload: stable across retries and
          // webhook secret rotation, so Hermes starts at most one agent turn.
          "x-request-id": requestId,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      return {
        ok: res.ok,
        status: res.status,
        error: res.ok ? null : res.statusText || `HTTP ${res.status}`,
      };
    } catch (err) {
      return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private recordWakeDelivery(args: {
    mentionSeq: number;
    targetName: string;
    webhookName: string;
    attempt: number;
    delivery: WebhookDeliveryResult;
  }) {
    const resume = this.findExistingWakeResume(args.targetName, args.mentionSeq);
    this.ctx.storage.sql.exec(
      `INSERT INTO wake_delivery_ledger (
         mention_seq, target_name, webhook_name, adapter_kind, attempt,
         result, http_status, error, attempted_at, ack_seq, resume_seq
       )
       VALUES (?, ?, ?, 'webhook', ?, ?, ?, ?, ?, ?, ?)`,
      args.mentionSeq,
      args.targetName,
      args.webhookName,
      args.attempt,
      args.delivery.ok ? "ok" : "failed",
      args.delivery.status,
      args.delivery.error,
      Date.now(),
      resume.ackSeq,
      resume.resumeSeq,
    );
  }

  // #107：某 name 当前登记的 wake 层（presence.wake_kind）。无 presence / 未登记 = null。
  private wakeKindFor(name: string): WakeKind | null {
    return this.presenceFor(name)?.wake?.kind ?? null;
  }

  // #107：serve/watch 的唤醒也进服务端 ledger。webhook 由服务端主动 POST、天然可审计；serve/watch 是
  // 拉模型——agent 自己的 loop 读广播、匹配 mentions.includes(self)，服务端从不"投递"给它们。故服务端能
  // 诚实记录的唯一事实是：这条 @ 被广播了，且被 @ 的目标是一个已登记 serve/watch 的可唤醒 agent。记为
  // result='broadcast'（已广播给拉客户端，**不是**"已确认消费"）。之后该 agent resume 且引用了这条 @
  // （复用 #191 的 @->resume 观测，见 linkWakeResume）才升级为 result='consumed'。绝不因为"广播了"就声称
  // 唤醒成功——broadcast 与 consumed 泾渭分明。adapter_kind 记 'serve'/'watch'，webhook 唤醒仍是 'webhook'。
  private recordServeWatchWakes(msg: MsgFrame) {
    if (msg.mentions.length === 0) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const name of msg.mentions) {
      if (seen.has(name)) continue;
      seen.add(name);
      const kind = this.wakeKindFor(name);
      if (kind !== "serve" && kind !== "watch") continue;
      // #180：被人为暂停接待的目标，webhook 一律不投；serve/watch 同理不落"已广播唤醒"行，
      // 让"存在一条 broadcast 行" == "服务端确实把这条 @ 推给了未被抑制的可唤醒拉客户端"。
      if (this.isPresencePaused(name)) continue;
      // 极端情形（resume 竟先于本行落库）下也别把已闭环的唤醒错记成未消费。
      const resume = this.findExistingWakeResume(name, msg.seq);
      const consumed = resume.ackSeq !== null || resume.resumeSeq !== null;
      this.ctx.storage.sql.exec(
        `INSERT INTO wake_delivery_ledger (
           mention_seq, target_name, webhook_name, adapter_kind, attempt,
           result, http_status, error, attempted_at, ack_seq, resume_seq
         )
         VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?)`,
        msg.seq,
        name,
        name, // webhook_name NOT NULL：serve/watch 无 webhook，回填 target 名，审计读列时 adapter_kind 已足够区分
        kind,
        consumed ? "consumed" : "broadcast",
        now,
        resume.ackSeq,
        resume.resumeSeq,
      );
    }
  }

  // #108 per-agent wake 预算配置：未设 = null = 不限（正常流）。limit 存 meta，window 缺省 1 小时。
  private wakeBudgetConfig(name: string): { limit: number; windowMs: number } | null {
    const raw = this.getMeta(`wake_budget_limit:${name}`);
    if (raw === null) return null;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit <= 0) return null;
    const rawWindow = Number(this.getMeta(`wake_budget_window:${name}`) ?? "");
    const windowMs =
      Number.isInteger(rawWindow) && rawWindow >= WAKE_BUDGET_MIN_WINDOW_MS ? rawWindow : WAKE_BUDGET_DEFAULT_WINDOW_MS;
    return { limit, windowMs };
  }

  // 滚动窗口内已消耗的 wake 数：ledger 里该 target 的首投行（attempt=1，排除 budget 抑制标记与重试行）。
  // 一条首投 = 一次「唤醒该 agent 的 runner」，正是要计的烧订阅事件；重试（attempt>1）是同一 wake 的
  // 再投，不重复计；budget 行是被抑制的、从未真投，不消耗预算。
  private wakeCountInWindow(name: string, windowStart: number): number {
    return Number(
      this.ctx.storage.sql
        .exec(
          // #107：wake 预算只计 webhook 唤醒（"烧订阅"的那一类）；serve/watch 的 broadcast/consumed 行是拉模型
          // 的审计记录、不消耗 webhook 预算，故用 adapter_kind='webhook' 把它们排除在预算之外。
          `SELECT COUNT(*) AS n FROM wake_delivery_ledger
            WHERE target_name = ? AND adapter_kind = 'webhook' AND attempt = 1 AND result != 'budget' AND attempted_at >= ?`,
          name,
          windowStart,
        )
        .one().n,
    );
  }

  // 该目标此刻是否已超 wake 预算（true = 应抑制，不投 webhook）。未设预算 = 永不超。
  private isOverWakeBudget(name: string, now: number): boolean {
    const cfg = this.wakeBudgetConfig(name);
    if (cfg === null) return false;
    return this.wakeCountInWindow(name, now - cfg.windowMs) >= cfg.limit;
  }

  // 超预算而被抑制的 wake：落一条 result='budget' 的 ledger 行做审计——归属到具体 mention_seq / 目标，
  // http_status=null（从未真投），error 记下预算参数。计数查询用 result!='budget' 把它排除在消耗之外。
  private recordWakeWithheld(mentionSeq: number, name: string, now: number) {
    const cfg = this.wakeBudgetConfig(name);
    const resume = this.findExistingWakeResume(name, mentionSeq);
    this.ctx.storage.sql.exec(
      `INSERT INTO wake_delivery_ledger (
         mention_seq, target_name, webhook_name, adapter_kind, attempt,
         result, http_status, error, attempted_at, ack_seq, resume_seq
       )
       VALUES (?, ?, ?, 'webhook', 1, 'budget', NULL, ?, ?, ?, ?)`,
      mentionSeq,
      name,
      name,
      cfg === null
        ? "wake budget exceeded"
        : `wake budget exceeded: ${cfg.limit} wakes / ${cfg.windowMs}ms`,
      now,
      resume.ackSeq,
      resume.resumeSeq,
    );
  }

  // 频道内可观测：预算用尽时通告一条 system status。按窗口去重（一个窗口内只播一次），避免
  // 高频 @ 把频道刷屏。用 waiting 而非 blocked——这是节流不是熔断，blocked 会让守 etiquette 的 agent 停手。
  // #607：mention 决议走全实例 handle 面（account_profiles 不分频道），所以 @ 一个从未连过
  // 本频道、也没订阅任何通知渠道的人类会正常落库，然后无声无息（生产实例：@karl 在么 → karl
  // 不在 presence、无 lark-notify webhook → 无人收到、无任何反馈）。消息落库后异步核对每个
  // 非 agent mention 的可达面：presence 非 offline（按 name 或 human handle 匹配）、或本频道
  // 任一同名 webhook（lark-notify 订阅在此注册）。全都没有 → 落一条 system status 让发送者
  // 看见。agent 目标不归这里管（离线 agent 有 directed delivery 持久重放），squad 会另行展开。
  private async warnUnreachableHumanMentions(msg: MsgFrame): Promise<void> {
    if (msg.sender.name === "system") return;
    const mentions = msg.mentions ?? [];
    if (mentions.length === 0) return;
    const reachable = new Set<string>();
    for (const row of this.ctx.storage.sql.exec("SELECT name, handle, state FROM presence").toArray()) {
      if (String(row.state) === "offline") continue;
      reachable.add(mentionMatchKey(String(row.name)));
      if (row.handle !== null && row.handle !== undefined) reachable.add(mentionMatchKey(String(row.handle)));
    }
    for (const row of this.ctx.storage.sql.exec("SELECT name FROM webhooks").toArray()) {
      reachable.add(mentionMatchKey(String(row.name)));
    }
    const candidates = mentions.filter((mention) => !reachable.has(mentionMatchKey(mention)));
    if (candidates.length === 0) return;
    const placeholders = candidates.map(() => "?").join(", ");
    let excluded: Set<string>;
    try {
      const [agents, squads] = await Promise.all([
        this.env.DB.prepare(
          `SELECT name FROM tokens
            WHERE revoked_at IS NULL AND role = 'agent'
              AND (channel_scope IS NULL OR channel_scope = ?)
              AND name IN (${placeholders})`,
        ).bind(this.name, ...candidates).all<{ name: string }>(),
        this.env.DB.prepare(
          `SELECT name FROM channel_squads WHERE channel_slug = ? AND name IN (${placeholders})`,
        ).bind(this.name, ...candidates).all<{ name: string }>(),
      ]);
      excluded = new Set([...agents.results, ...squads.results].map((row) => mentionMatchKey(row.name)));
    } catch {
      // 纯观测性告警：目录查询抖动时宁可少报一次，也不能让 waitUntil 抛错。
      return;
    }
    const now = Date.now();
    // 写入前顺手清掉已出窗的去重键（CodeRabbit #611）：每个新 handle 都会永久占一行 meta，
    // 长寿频道会无界增长；清理后存储只保留活跃窗口内的键。
    this.ctx.storage.sql.exec(
      "DELETE FROM meta WHERE key LIKE 'unreachable_mention_warned:%' AND CAST(value AS INTEGER) < ?",
      now - 30 * 60_000,
    );
    const unreachable = candidates.filter((mention) => {
      if (excluded.has(mentionMatchKey(mention))) return false;
      // per-target 30 分钟去重（仿 wake budget 通告）：反复 @ 同一个不可达的人只提醒一次。
      const key = `unreachable_mention_warned:${mentionMatchKey(mention)}`;
      const last = Number(this.getMeta(key) ?? "");
      if (Number.isInteger(last) && now - last < 30 * 60_000) return false;
      this.setMeta(key, String(now));
      return true;
    });
    if (unreachable.length === 0) return;
    this.insertSystemStatus(
      `${unreachable.map((name) => `@${name}`).join(" ")} won't see this mention: offline and not subscribed to any notification for this channel (they can enable Lark notify or open the channel page)`,
      now,
      false,
      { state: "waiting" },
    );
  }

  private alertWakeBudget(name: string, now: number) {
    const cfg = this.wakeBudgetConfig(name);
    if (cfg === null) return;
    const key = `wake_budget_alerted:${name}`;
    const last = Number(this.getMeta(key) ?? "");
    if (Number.isInteger(last) && now - last < cfg.windowMs) return;
    this.setMeta(key, String(now));
    const windowMin = Math.max(1, Math.round(cfg.windowMs / 60_000));
    this.insertSystemStatus(
      `wake budget for ${name} exhausted: ${cfg.limit} wakes per ${windowMin}m — further @-mentions are withheld until the window rolls`,
      now,
      false,
      { state: "waiting" },
    );
  }

  // 预算快照（inspect 用）：含窗口内已用 used / remaining / 最早那次 wake 老化出窗后的恢复时刻。
  private wakeBudgetState(name: string): {
    name: string;
    enabled: boolean;
    limit: number | null;
    window_ms: number | null;
    used: number;
    remaining: number | null;
    window_resets_at: number | null;
  } {
    const cfg = this.wakeBudgetConfig(name);
    if (cfg === null) {
      return { name, enabled: false, limit: null, window_ms: null, used: 0, remaining: null, window_resets_at: null };
    }
    const now = Date.now();
    const windowStart = now - cfg.windowMs;
    const used = this.wakeCountInWindow(name, windowStart);
    const oldest = this.ctx.storage.sql
      .exec(
        `SELECT MIN(attempted_at) AS t FROM wake_delivery_ledger
          WHERE target_name = ? AND adapter_kind = 'webhook' AND attempt = 1 AND result != 'budget' AND attempted_at >= ?`,
        name,
        windowStart,
      )
      .one().t;
    return {
      name,
      enabled: true,
      limit: cfg.limit,
      window_ms: cfg.windowMs,
      used,
      remaining: Math.max(0, cfg.limit - used),
      window_resets_at: oldest === null || oldest === undefined ? null : Number(oldest) + cfg.windowMs,
    };
  }

  private findExistingWakeResume(targetName: string, mentionSeq: number): { ackSeq: number | null; resumeSeq: number | null } {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT seq, reply_to, status_summary_seq
           FROM messages
          WHERE seq > ?
            AND sender_name = ?
            AND retracted_at IS NULL
            AND (reply_to = ? OR status_summary_seq = ?)
          ORDER BY seq`,
        mentionSeq,
        targetName,
        mentionSeq,
        mentionSeq,
      )
      .toArray();
    let ackSeq: number | null = null;
    let resumeSeq: number | null = null;
    for (const row of rows) {
      const seq = Number(row.seq);
      if (ackSeq === null && row.reply_to !== null && Number(row.reply_to) === mentionSeq) ackSeq = seq;
      if (resumeSeq === null && row.status_summary_seq !== null && Number(row.status_summary_seq) === mentionSeq) {
        resumeSeq = seq;
      }
      if (ackSeq !== null && resumeSeq !== null) break;
    }
    return { ackSeq, resumeSeq };
  }

  private seqFromWebhookPayload(payload: string): number {
    try {
      const parsed = JSON.parse(payload) as { seq?: unknown };
      return typeof parsed.seq === "number" && Number.isInteger(parsed.seq) && parsed.seq > 0 ? parsed.seq : 0;
    } catch {
      return 0;
    }
  }

  private isMessageRetracted(seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq <= 0) return false;
    const row = this.ctx.storage.sql
      .exec("SELECT retracted_at FROM messages WHERE seq = ?", seq)
      .toArray()[0];
    return row !== undefined && row.retracted_at !== null && row.retracted_at !== undefined;
  }

  /**
   * Retraction is a persistent webhook tombstone, including against stale async continuations that
   * started before the retract transaction committed. This check and cleanup run synchronously with
   * every post-network write, so no await can interleave between the barrier and persistence.
   */
  private scrubRetractedWebhookArtifacts(payload: string): boolean {
    const seq = this.seqFromWebhookPayload(payload);
    if (!this.isMessageRetracted(seq)) return false;
    const payloadSeq =
      "CASE WHEN json_valid(payload) THEN CAST(json_extract(payload, '$.seq') AS INTEGER) ELSE NULL END";
    this.ctx.storage.sql.exec(`DELETE FROM webhook_queue WHERE ${payloadSeq} = ?`, seq);
    this.ctx.storage.sql.exec(
      `DELETE FROM webhook_dead_letters WHERE mention_seq = ? OR ${payloadSeq} = ?`,
      seq,
      seq,
    );
    return true;
  }

  private messageUpdate(action: MessageUpdateFrame["action"], actor: Identity, message: MsgFrame, ts: number): MessageUpdateFrame {
    return {
      type: "message_update",
      target_seq: message.seq,
      action,
      actor: senderFromIdentity(actor),
      ts,
      message,
    };
  }

  // 3 次重试全败后向频道插一条 system status，让人看得见投递失败
  private insertSystemStatus(
    note: string,
    now: number,
    notifyWebhooks = false,
    options: { mentions?: string[]; workflow?: StatusWorkflow; broadcast?: boolean; state?: StatusState } = {},
  ): MsgFrame {
    const seq = this.nextSeq();
    // 默认 waiting 而非 blocked（#143）：信息类系统事件是常态、blocked 是例外，默认值失误的方向
    // 必须是安全的。blocked 会让守 etiquette 的 agent 停手等人类，误报的代价远大于漏报。
    const state = options.state ?? "waiting";
    const blockedReason = state === "blocked" ? note : null;
    const status: StatusEvent = {
      owner: "system",
      state,
      scope: [],
      summary_seq: null,
      blocked_reason: blockedReason,
      updated_at: now,
      ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (
         seq, sender_name, sender_kind, kind, body, mentions_json, reply_to,
         state, note, status_scope_json, status_summary_seq, status_blocked_reason, status_workflow_json, ts
       )
       VALUES (?, 'system', 'agent', 'status', ?, ?, NULL, ?, ?, '[]', NULL, ?, ?, ?)`,
      seq,
      note,
      JSON.stringify(options.mentions ?? []),
      state,
      note,
      blockedReason,
      options.workflow === undefined ? null : JSON.stringify(options.workflow),
      now,
    );
    const frame: MsgFrame = {
      type: "status",
      seq,
      sender: { name: "system", kind: "agent" },
      kind: "status",
      body: note,
      mentions: options.mentions ?? [],
      reply_to: null,
      state,
      note,
      status,
      ts: now,
    };
    if (options.broadcast !== false) this.broadcastFrame(frame);
    if (notifyWebhooks) this.ctx.waitUntil(this.dispatchWebhooks(frame));
    return frame;
  }

  private insertReviewerReply(identity: Identity, body: string, mentions: string[], replyTo: number, now: number): MsgFrame {
    const seq = this.nextSeq();
    const effectiveRole = identity.collabRole;
    const roleSource: CollaborationRoleSource | undefined = identity.collabRole === undefined ? undefined : "assigned";
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (
         seq, sender_name, sender_kind, sender_owner, sender_handle, sender_lineage_json, kind, body, mentions_json, reply_to,
         state, note, status_scope_json, status_summary_seq, status_blocked_reason, status_context_json,
         status_decision_json, status_workflow_json,
         sender_role, sender_role_source, completion_artifact_json, ts
       )
       VALUES (?, ?, ?, ?, ?, ?, 'message', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
      seq,
      identity.name,
      identity.kind,
      identity.owner ?? null,
      identity.handle ?? null,
      identity.lineage === undefined ? null : JSON.stringify(identity.lineage),
      body,
      JSON.stringify(mentions),
      replyTo,
      effectiveRole ?? null,
      roleSource ?? null,
      now,
    );
    const row = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
    const frame = this.rowToFrame(row);
    this.linkWakeResume(identity, frame, now);
    return frame;
  }

  // 决策回应回复（#284）：像 insertReviewerReply，但额外落 decision_response_json，
  // 让这条回复成为一条反指 request seq 的独立可消费帧。
  private insertDecisionResponse(
    identity: Identity,
    body: string,
    mentions: string[],
    replyTo: number,
    response: DecisionResponse,
    now: number,
  ): MsgFrame {
    const seq = this.nextSeq();
    const effectiveRole = identity.collabRole;
    const roleSource: CollaborationRoleSource | undefined = identity.collabRole === undefined ? undefined : "assigned";
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (
         seq, sender_name, sender_kind, sender_owner, sender_handle, sender_lineage_json, kind, body, mentions_json, reply_to,
         state, note, sender_role, sender_role_source, decision_response_json, ts
       )
       VALUES (?, ?, ?, ?, ?, ?, 'message', ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      seq,
      identity.name,
      identity.kind,
      identity.owner ?? null,
      identity.handle ?? null,
      identity.lineage === undefined ? null : JSON.stringify(identity.lineage),
      body,
      JSON.stringify(mentions),
      replyTo,
      effectiveRole ?? null,
      roleSource ?? null,
      JSON.stringify(response),
      now,
    );
    const row = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
    const frame = this.rowToFrame(row);
    this.linkWakeResume(identity, frame, now);
    return frame;
  }

  /**
   * Resolve server-owned decision lineage back to its exact parked work. A delivery id alone is not
   * sufficient: retained/corrupted questions must not graft an owner answer onto another origin,
   * work id, continuation, channel, or creation-time principal.
   */
  private exactDecisionSource(
    question: Record<string, unknown>,
    request: DecisionRequest,
  ): Record<string, unknown> | undefined {
    if (
      request.delivery_id === undefined ||
      request.origin_seq === undefined ||
      request.origin_channel === undefined ||
      request.work_id === undefined ||
      request.continuation_ref === undefined
    ) return undefined;
    const source = this.directedDeliveryRow(request.delivery_id);
    if (source === undefined) return undefined;
    const senderOwner =
      typeof question.sender_owner === "string" && question.sender_owner.length > 0
        ? question.sender_owner
        : null;
    const sourceOwner =
      typeof source.target_owner === "string" && source.target_owner.length > 0
        ? source.target_owner
        : null;
    const originChannel = this.getMeta("channel_slug") ?? this.name;
    const origin = this.ctx.storage.sql
      .exec("SELECT retracted_at FROM messages WHERE seq = ?", request.origin_seq)
      .toArray()[0];
    if (
      origin === undefined ||
      (origin.retracted_at !== null && origin.retracted_at !== undefined) ||
      String(source.target_name) !== String(question.sender_name) ||
      sourceOwner === null ||
      (senderOwner !== null && senderOwner !== sourceOwner) ||
      Number(source.message_seq) !== request.origin_seq ||
      Number(question.reply_to) !== request.origin_seq ||
      request.origin_channel !== originChannel ||
      String(source.work_id ?? "") !== request.work_id ||
      String(source.continuation_ref ?? "") !== request.continuation_ref
    ) return undefined;
    return source;
  }

  /**
   * Fail a source plus every still-active owner-answer continuation below it, invalidate parked
   * questions, and scrub reusable capability lineage. Retraction and retention share this exact
   * closure so neither path can leave a descendant able to resume deleted/expired work.
   */
  private failDeliveryTree(
    initial: Record<string, unknown>[],
    now: number,
    failure: { error: string; terminalReason: DeliveryTerminalReason },
  ): number[] {
    const pending = initial.map((row) => String(row.id));
    const visited = new Set<string>();
    const invalidatedDecisionSeqs = new Set<number>();
    // `visited` is the cycle guard; do not impose a depth/row cap that can leave an attacker-shaped
    // continuation tail revivable after the retract transaction commits.
    while (pending.length > 0) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const row = this.directedDeliveryRow(id);
      if (row === undefined) continue;
      for (const child of this.ctx.storage.sql
        .exec(
          `SELECT id FROM directed_deliveries
            WHERE parent_delivery_id = ?
            ORDER BY created_at, id`,
          id,
        )
        .toArray()) {
        pending.push(String(child.id));
      }
      // A parked question is a message, not a child delivery. Invalidate it while the source id is
      // still available so retracting an origin cannot leave an actionable pending decision UI.
      const questions = this.ctx.storage.sql
        .exec(
          `SELECT seq FROM messages
            WHERE decision_state = 'pending'
              AND decision_request_json IS NOT NULL
              AND json_valid(decision_request_json)
              AND json_extract(decision_request_json, '$.delivery_id') = ?`,
          id,
        )
        .toArray();
      for (const question of questions) {
        const questionSeq = Number(question.seq);
        this.ctx.storage.sql.exec(
          `UPDATE messages
              SET decision_request_json = NULL, decision_state = NULL,
                  decision_resolution_json = NULL, decision_response_json = NULL,
                  rev_seq = ?
            WHERE seq = ? AND decision_state = 'pending'`,
          this.nextRevSeq(),
          questionSeq,
        );
        if (Number(this.ctx.storage.sql.exec("SELECT changes() AS count").one().count) === 1) {
          invalidatedDecisionSeqs.add(questionSeq);
        }
      }
      const state = String(row.state);
      if (["queued", "claimed", "running", "waiting_owner"].includes(state)) {
        this.transitionDirectedDeliveryTerminal(id, "failed", now, {
          error: failure.error,
          terminalReason: failure.terminalReason,
          expectedStates: [state],
        });
      } else if (state === "failed") {
        // Failed rows can still be revivable (typed unknown_outcome or legacy NULL). Source
        // invalidation is stronger than that recovery policy, so reclassify every descendant.
        this.ctx.storage.sql.exec(
          `UPDATE directed_deliveries
              SET last_error = ?, terminal_reason = ?,
                  updated_at = ?
            WHERE id = ? AND state = 'failed'`,
          failure.error,
          failure.terminalReason,
          now,
          id,
        );
        const failed = this.directedDeliveryRow(id);
        if (failed !== undefined) this.broadcastDirectedDelivery(failed);
      } else if (state !== "replied") {
        continue;
      }
      this.ctx.storage.sql.exec(
        `UPDATE directed_deliveries
            SET work_id = NULL, continuation_ref = NULL, parent_delivery_id = NULL,
                lease_connection_id = NULL, last_lease_connection_id = NULL,
                lease_adapter = NULL, lease_until = NULL
          WHERE id = ?`,
        id,
      );
    }
    return [...invalidatedDecisionSeqs];
  }

  /** Fail the retracted source plus every still-active owner-answer continuation below it. */
  private failRetractedDeliveryTree(initial: Record<string, unknown>[], now: number): number[] {
    return this.failDeliveryTree(initial, now, {
      error: "source retracted, no retry",
      terminalReason: "source_retracted",
    });
  }

  private isFailedDeliveryRevivable(row: Record<string, unknown>): boolean {
    if (String(row.state) !== "failed") return false;
    if (row.terminal_reason === null || row.terminal_reason === undefined) return true;
    return REVIVABLE_DELIVERY_FAILURES.has(String(row.terminal_reason) as DeliveryTerminalReason);
  }

  // 归档收口：写 meta + 广播 error:archived + 踢连接（手动归档与 temp 自动归档共用）
  private archiveAndKick() {
    this.setMeta("archived", "1");
    for (const connection of this.getConnections<ConnState>()) {
      const st = connection.state;
      if (st) connection.setState({ ...st, archived: true });
      this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
      connection.close(1008, "archived");
    }
  }

  // temp 闲置计时基准：最后一条消息，没消息就用首次见到该频道的时间
  private lastActivityTs(): number | null {
    const row = this.ctx.storage.sql.exec("SELECT MAX(ts) AS t FROM messages").one();
    if (row.t !== null) return Number(row.t);
    const born = this.getMeta("born");
    if (born !== null) return Number(born);
    this.setMeta("born", String(Date.now()));
    return Date.now();
  }

  // 测试可经 meta 注入短 TTL
  private tempIdleMs(): number {
    const injected = Number(this.getMeta("temp_idle_ms"));
    return Number.isFinite(injected) && injected > 0 ? injected : TEMP_IDLE_ARCHIVE_MS;
  }

  private async ensureAlarmAt(ts: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > ts) await this.ctx.storage.setAlarm(ts);
  }

  private scheduleDirectedDeliveryRetentionAlarm() {
    const candidates: number[] = [];
    const active = this.ctx.storage.sql
      .exec("SELECT MIN(created_at) AS t FROM directed_deliveries WHERE state IN ('queued', 'claimed', 'running', 'waiting_owner')")
      .one().t;
    if (active !== null) candidates.push(Number(active) + DIRECTED_DELIVERY_MAX_AGE_MS);
    const terminal = this.ctx.storage.sql
      .exec(
        `SELECT MIN(delivery.updated_at) AS t FROM directed_deliveries delivery
          WHERE delivery.state IN ('replied', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM directed_deliveries child
               WHERE child.parent_delivery_id = delivery.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM messages question
               WHERE question.decision_state = 'pending'
                 AND question.decision_request_json IS NOT NULL
                 AND json_valid(question.decision_request_json)
                 AND json_extract(question.decision_request_json, '$.delivery_id') = delivery.id
            )`,
      )
      .one().t;
    if (terminal !== null) candidates.push(Number(terminal) + DIRECTED_DELIVERY_TERMINAL_RETENTION_MS);
    if (candidates.length > 0) {
      this.ctx.waitUntil(this.ensureAlarmAt(Math.max(Math.min(...candidates), Date.now() + 1000)));
    }
  }

  private async scheduleAuditRetention(createdAt: number) {
    const retention = this.retentionMs("audit_retention_ms");
    if (retention !== null) await this.ensureAlarmAt(createdAt + retention);
  }

  // worker 转发来的内部 rest
  async onRequest(request: Request): Promise<Response> {
    // 见 onMessage：未捕获异常否则只剩 Cloudflare 不透明 500。包一层落真实堆栈再原样抛。
    try {
      return await this.onRequestImpl(request);
    } catch (err) {
      // 只记路由族（第一段静态前缀，如 api/internal）+ method，不落完整 pathname——动态段可能含
      // agent 名等标识（/internal/identity/{name}/…），即便编码也可还原。真正定位靠 stack。
      const family = new URL(request.url).pathname.split("/").filter(Boolean)[0] ?? "";
      logDoException("onRequest", this.name, err, `${request.method} /${family}/…`);
      throw err;
    }
  }

  private async onRequestImpl(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/summary" && request.method === "GET") {
      // 频道列表页聚合用：最近一条消息（正文截断）+ presence 快照（spec §9 第 1 块）
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM messages ORDER BY seq DESC LIMIT 1")
        .toArray();
      const last = rows.length > 0 ? this.rowToFrame(rows[0]!) : null;
      return Response.json({
        last:
          last === null
            ? null
            : { sender: last.sender.name, kind: last.kind, body: last.body.slice(0, 200), ts: last.ts },
        presence: this.presenceList(),
      });
    }
    if (url.pathname === "/internal/presence" && request.method === "GET") {
      // party who：完整 presence 快照（含 kind/wake/last_seen），供 CLI 分档展示谁在线/可唤醒
      return Response.json({ presence: this.presenceList() });
    }
    if (url.pathname === "/internal/guard" && request.method === "GET") {
      // party channel guard status（#174）：熔断前就能读到 limit/streak/remaining。
      // 先按 header 刷新 config meta，保证 enabled/limit 与 D1 权威一致，streak 取 DO 自身状态。
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"));
      return Response.json(this.loopGuardState());
    }
    if (url.pathname === "/internal/identities" && request.method === "GET") {
      const identities = new Map<string, { name: string; kind?: SenderKind; account?: string }>();
      const add = (name: unknown, kind: unknown, account: unknown) => {
        if (typeof name !== "string" || name === "" || name === "system") return;
        const prev = identities.get(name) ?? { name };
        identities.set(name, {
          ...prev,
          ...(kind === "agent" || kind === "human" ? { kind } : {}),
          ...(typeof account === "string" && account !== "" ? { account } : {}),
        });
      };
      for (const row of this.ctx.storage.sql
        .exec("SELECT DISTINCT sender_name, sender_kind, sender_owner FROM messages")
        .toArray()) {
        add(row.sender_name, row.sender_kind, row.sender_owner);
      }
      for (const row of this.ctx.storage.sql.exec("SELECT name, kind, account FROM presence").toArray()) {
        add(row.name, row.kind, row.account);
      }
      return Response.json({ identities: [...identities.values()].sort((a, b) => a.name.localeCompare(b.name)) });
    }
    if (url.pathname === "/internal/init" && request.method === "POST") {
      // /internal/init 是权威配置推送（channel 创建 + 每次 guard PUT 都打这条），
      // 承载当下 D1 的真值，故允许改动已缓存的 guard config（#102）。
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"), { authoritative: true });
      if (this.getMeta("ckind") === "temp") {
        const born = Date.now();
        this.setMeta("born", String(born));
        await this.ensureAlarmAt(born + this.tempIdleMs());
      }
      if (this.retentionMs("message_retention_ms") !== null || this.retentionMs("audit_retention_ms") !== null) {
        await this.ensureAlarmAt(Date.now() + 1000);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/messages" && request.method === "GET") {
      const since = Math.max(toInt(url.searchParams.get("since"), 0), 0);
      const before = Math.max(toInt(url.searchParams.get("before"), 0), 0);
      const limit = Math.min(Math.max(toInt(url.searchParams.get("limit"), 100), 1), 1000);
      const completionOnly = url.searchParams.get("completion") === "1";
      // before 反向分页（IM 上翻加载历史）：返回 seq < before 的最近 limit 条，仍按 seq 升序输出。
      // 与 since 互斥，before 优先；不带 before 保持原有 since 正向语义。
      const rows =
        before > 0
          ? this.ctx.storage.sql
              .exec(
                `SELECT * FROM (
                   SELECT * FROM messages
                    WHERE seq < ?${completionOnly ? " AND completion_artifact_json IS NOT NULL" : ""}
                    ORDER BY seq DESC LIMIT ?
                 ) ORDER BY seq`,
                before,
                limit,
              )
              .toArray()
          : this.ctx.storage.sql
              .exec(
                `SELECT * FROM messages
                  WHERE seq > ?${completionOnly ? " AND completion_artifact_json IS NOT NULL" : ""}
                  ORDER BY seq LIMIT ?`,
                since,
                limit,
              )
              .toArray();
      return Response.json({ messages: rows.map((r) => publicMsgFrame(this.rowToFrame(r))) });
    }
    if (url.pathname === "/internal/message-stats" && request.method === "GET") {
      const row = this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS message_count, MIN(ts) AS earliest_ts FROM messages")
        .one();
      return Response.json({
        message_count: Number(row.message_count ?? 0),
        earliest_ts: row.earliest_ts === null || row.earliest_ts === undefined ? null : Number(row.earliest_ts),
      });
    }
    if (url.pathname === "/internal/export" && request.method === "GET") {
      // #422 频道级备份：把 DO 内建 SQLite 的持久表整表 dump 成 JSON，作为离线存档 = DO 的备份物
      //（D1 有 time-travel 兜底，DO 侧此前无等价备份）。跳过纯运行期表（速率窗口、webhook 重试队列/死信、
      // 唤醒投递账本）——它们是瞬时状态，不属于需要归档的频道数据，且会让备份无谓膨胀。
      const ephemeral = new Set(["rate", "webhook_queue", "webhook_dead_letters", "wake_delivery_ledger"]);
      const tableRows = this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
        .toArray();
      const tables: Record<string, unknown[]> = {};
      const rowCounts: Record<string, number> = {};
      for (const t of tableRows) {
        const name = String(t.name);
        if (ephemeral.has(name)) continue;
        // 表名来自 sqlite_master（无外部输入），拼接安全；无法参数化标识符故直接内插。
        const rows = this.ctx.storage.sql.exec(`SELECT * FROM "${name}"`).toArray();
        tables[name] = rows;
        rowCounts[name] = rows.length;
      }
      return Response.json({ exported_at: Date.now(), row_counts: rowCounts, tables });
    }
    if (url.pathname === "/internal/reconcile-state" && request.method === "GET") {
      // #422 对账：暴露 DO 侧对「与 D1 双写字段」的当前缓存值，供 worker 与 D1 channels 行逐字段比对。
      // meta 是懒缓存（standing 频道创建时不 push /internal/init，首条消息/guard/可见性变更才落）——
      // 故未落的字段返回 null，由 worker 侧解释为「DO 尚未物化」而非分裂。archived 恒有真值（缺省 false）。
      const msgCount = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one();
      return Response.json({
        archived: this.isArchived(),
        mode: this.getMeta("mode"),
        ckind: this.getMeta("ckind"),
        visibility: this.getMeta("visibility"),
        completion_gate: this.getMeta("completion_gate"),
        completion_review_policy: this.getMeta("completion_review_policy"),
        decision_mode: this.getMeta("decision_mode"),
        loop_guard_enabled: this.getMeta("loop_guard_enabled"),
        loop_guard_limit: this.getMeta("loop_guard_limit"),
        workflow_guard_enabled: this.getMeta("workflow_guard_enabled"),
        workflow_guard_limit: this.getMeta("workflow_guard_limit"),
        message_retention_ms: this.getMeta("message_retention_ms"),
        audit_retention_ms: this.getMeta("audit_retention_ms"),
        charter_rev: this.charterRev(),
        message_count: Number(msgCount.n ?? 0),
      });
    }
    if (url.pathname === "/internal/system-status" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { note?: unknown; ts?: unknown; state?: unknown } | null;
      const note = typeof body?.note === "string" ? body.note : "";
      if (!note || note.length > 1000) {
        return Response.json({ error: { code: "bad_request", message: "valid note required" } }, { status: 400 });
      }
      // state 由 worker 层显式指定（#143）：建 task / 改可见性 / squad 增删改这类信息事件是
      // waiting，不能落成 blocked——etiquette 教 agent「blocked 就停手等人类」，打反了会瘫痪协作。
      const state = statusStateFrom(body?.state);
      if (state === null) {
        return Response.json({ error: { code: "bad_request", message: "state must be working|waiting|blocked|done" } }, { status: 400 });
      }
      const ts = typeof body?.ts === "number" && Number.isInteger(body.ts) ? body.ts : Date.now();
      this.insertSystemStatus(note, ts, false, state === undefined ? {} : { state });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/charter-rev" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as
        | { rev?: unknown; updated_by?: unknown; ts?: unknown }
        | null;
      const rev = typeof body?.rev === "number" && Number.isInteger(body.rev) && body.rev >= 0 ? body.rev : null;
      if (rev === null) {
        return Response.json({ error: { code: "bad_request", message: "valid rev required" } }, { status: 400 });
      }
      const who = typeof body?.updated_by === "string" && body.updated_by !== "" ? body.updated_by : "unknown";
      const ts = typeof body?.ts === "number" && Number.isInteger(body.ts) ? body.ts : Date.now();
      this.setMeta("charter_rev", String(rev));
      this.insertSystemStatus(`charter updated to rev ${rev} by ${who}`, ts, false, { state: "waiting" });
      return Response.json({ ok: true });
    }
    const auditMatch = url.pathname.match(/^\/internal\/messages\/([1-9]\d*)\/audit$/);
    if (auditMatch && request.method === "GET") {
      const seq = Number(auditMatch[1]);
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT audit.target_seq, audit.action, audit.actor_name, audit.actor_kind,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM message_audit AS retraction
                     WHERE retraction.target_seq = audit.target_seq AND retraction.action = 'retract'
                  ) THEN NULL ELSE audit.old_body END AS old_body,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM message_audit AS retraction
                     WHERE retraction.target_seq = audit.target_seq AND retraction.action = 'retract'
                  ) THEN NULL ELSE audit.new_body END AS new_body,
                  audit.original_byte_length, audit.created_at
             FROM message_audit AS audit
            WHERE audit.target_seq = ?
            ORDER BY audit.id`,
          seq,
        )
        .toArray()
        .map((r) => ({
          target_seq: Number(r.target_seq),
          action: String(r.action),
          actor: { name: String(r.actor_name), kind: String(r.actor_kind) },
          old_body: r.old_body === null ? null : String(r.old_body),
          new_body: r.new_body === null ? null : String(r.new_body),
          original_byte_length:
            r.original_byte_length === null || r.original_byte_length === undefined
              ? null
              : Number(r.original_byte_length),
          created_at: Number(r.created_at),
        }));
      return Response.json({ audit: rows });
    }
    const revisionMatch = url.pathname.match(/^\/internal\/messages\/([1-9]\d*)\/(edit|retract|supersede)$/);
    if (revisionMatch && request.method === "POST") {
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"));
      const seq = Number(revisionMatch[1]);
      const action = revisionMatch[2] as "edit" | "retract" | "supersede";
      const identity: Identity = {
        name: request.headers.get("x-ap-name") ?? "",
        kind: request.headers.get("x-ap-kind") === "agent" ? "agent" : "human",
        role: (request.headers.get("x-ap-role") ?? "readonly") as TokenRole,
        owner: request.headers.get("x-ap-owner") ?? undefined,
        handle: decodedHeaderText(request.headers, "x-ap-handle"),
        ...profileFromHeaders(request.headers),
        lineage: lineageFromHeaders(request.headers),
        tokenHash: request.headers.get("x-ap-token-hash") ?? "",
        collabRole: parseCollaborationRole(request.headers.get("x-ap-collab-role") ?? undefined) ?? undefined,
        collabRoleSource: parseRoleSource(request.headers.get("x-ap-role-source") ?? undefined) ?? undefined,
        canWrite: request.headers.get("x-ap-can-write") === "1",
        // #434：REST 发送方 CLI 版本（index.ts 已把 x-ap-client-version 转发进来），快照进消息 sender_client_version。
        clientVersion: parseClientVersion(request.headers.get("x-ap-client-version")) ?? undefined,
      };
      if (this.isArchived()) {
        return Response.json({ error: { code: "archived", message: "channel is archived" } }, { status: 410 });
      }
      if (identity.role === "readonly") {
        return Response.json({ error: { code: "unauthorized", message: "readonly token cannot revise messages" } }, { status: 403 });
      }
      if (!(await this.isTokenActive(identity.tokenHash))) {
        return Response.json({ error: { code: "unauthorized", message: "invalid or revoked token" } }, { status: 401 });
      }
      const row = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
      if (!row) {
        return Response.json({ error: { code: "not_found", message: `message seq ${seq} not found` } }, { status: 404 });
      }
      const isModerator = request.headers.get("x-ap-moderator") === "1";
      if (String(row.sender_name) !== identity.name && !isModerator) {
        return Response.json({ error: { code: "forbidden", message: "only the sender or channel moderator can revise this message" } }, { status: 403 });
      }
      if (String(row.kind) !== "message") {
        return Response.json({ error: { code: "bad_request", message: "only message frames can be revised" } }, { status: 400 });
      }
      if (row.retracted_at !== null && row.retracted_at !== undefined) {
        return Response.json({ error: { code: "bad_request", message: "message is already retracted" } }, { status: 400 });
      }
      // `[erased]` is the authoritative GDPR tombstone, not an editable sender message. Allowing a
      // moderator to revise/supersede it would recreate content and durable work under an identity
      // whose owner/profile data was deliberately removed.
      if (String(row.body) === "[erased]") {
        return Response.json({ error: { code: "bad_request", message: "message was erased and cannot be revised" } }, { status: 400 });
      }
      let body: { body?: unknown; mentions?: unknown } | null = null;
      let editRouting: RoutedMentionFrame | undefined;
      if (action !== "retract") {
        body = (await request.json().catch(() => null)) as { body?: unknown; mentions?: unknown } | null;
        if (body === null || typeof body.body !== "string" || body.body.trim() === "") {
          return Response.json({ error: { code: "bad_request", message: "body is required" } }, { status: 400 });
        }
        if (byteLength(body.body) > BODY_LIMIT) {
          return Response.json({ error: { code: "too_large", message: `body exceeds ${BODY_LIMIT} bytes` } }, { status: 413 });
        }
        if (action === "edit") {
          const explicitMentions = parseMentions(body.mentions);
          if (explicitMentions === null) {
            return Response.json(
              { error: { code: "bad_request", message: "mentions are invalid or exceed limits" } },
              { status: 400 },
            );
          }
          const mentions = mergeBodyMentions(explicitMentions, body.body);
          if (mentions === null) {
            return Response.json(
              { error: { code: "too_large", message: "body contains too many mention targets" } },
              { status: 413 },
            );
          }
          const routed = await this.routeMentionsForDelivery(
            {
              type: "send",
              kind: "message",
              body: body.body,
              mentions,
              reply_to: row.reply_to === null || row.reply_to === undefined ? null : Number(row.reply_to),
            },
            identity.name,
          );
          if ("ok" in routed) {
            return Response.json(
              { error: { code: routed.code, message: routed.message } },
              { status: ERROR_STATUS[routed.code] },
            );
          }
          editRouting = routed;
        }
      }
      const now = Date.now();
      const originalBody = row.original_body === null || row.original_body === undefined ? String(row.body) : String(row.original_body);
      if (action === "edit") {
        if (editRouting === undefined || editRouting.frame.kind !== "message") {
          throw new Error("message edit produced no mention routing");
        }
        const editState: {
          failure?: SendErrorOutcome;
          frame?: MsgFrame;
        } = {};
        const effects = this.captureAtomicDeliveryEffects(() => {
          const current = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
          if (
            !current
            || current.retracted_at !== null && current.retracted_at !== undefined
            || String(current.body) === "[erased]"
          ) {
            editState.failure = { ok: false, code: "bad_request", message: "message is no longer editable" };
            return;
          }
          const currentFrame = this.rowToFrame(current);
          const oldMentionKeys = new Set(currentFrame.mentions.map(mentionMatchKey));
          const desiredTargetKeys = new Set(editRouting!.deliveryTargets.map(mentionMatchKey));
          const existingDeliveries = this.ctx.storage.sql
            .exec("SELECT target_name FROM directed_deliveries WHERE message_seq = ?", seq)
            .toArray();
          const historicalTargets: string[] = [];
          const historicalTargetKeys = new Set<string>();
          for (const targetName of [
            ...parseStoredTargetNames(current.delivery_targets_json),
            ...existingDeliveries.map((delivery) => String(delivery.target_name)),
          ]) {
            const key = mentionMatchKey(targetName);
            if (historicalTargetKeys.has(key)) continue;
            historicalTargetKeys.add(key);
            historicalTargets.push(targetName);
          }

          // A routed target is an immutable work/audit identity. The compact message tombstone
          // outlives bounded delivery rows, so pruning a terminal row cannot make a later edit
          // recreate the same (message_seq,target_name) work. Use supersede/retract to change it.
          for (const targetName of historicalTargets) {
            const key = mentionMatchKey(targetName);
            if (oldMentionKeys.has(key) && !desiredTargetKeys.has(key)) {
              editState.failure = {
                ok: false,
                code: "bad_request",
                message: `cannot remove routed target @${targetName}; retract or supersede the message instead`,
              };
              return;
            }
            if (!oldMentionKeys.has(key) && desiredTargetKeys.has(key)) {
              editState.failure = {
                ok: false,
                code: "bad_request",
                message: `cannot re-add routed target @${targetName} on the same message; send a new message instead`,
              };
              return;
            }
          }
          // Before durable deliveries existed, a retained message could already contain @agent but
          // have neither a delivery row nor a compact tombstone. Preserving that old mention while
          // merely editing wording is not new work. Tombstone it now, while still routing targets
          // that are genuinely added by this edit.
          const preservedLegacyTargets = editRouting!.deliveryTargets.filter((targetName) => {
            const key = mentionMatchKey(targetName);
            return oldMentionKeys.has(key) && !historicalTargetKeys.has(key);
          });
          const newDeliveryTargets = editRouting!.deliveryTargets.filter((targetName) => {
            const key = mentionMatchKey(targetName);
            return !oldMentionKeys.has(key) && !historicalTargetKeys.has(key);
          });
          const nextHistoricalTargets = [
            ...historicalTargets,
            ...preservedLegacyTargets,
            ...newDeliveryTargets,
          ];

          const currentOriginalBody =
            current.original_body === null || current.original_body === undefined
              ? String(current.body)
              : String(current.original_body);
          this.ctx.storage.sql.exec(
            `INSERT INTO message_audit (target_seq, action, actor_name, actor_kind, old_body, new_body, created_at)
             VALUES (?, 'edit', ?, ?, ?, ?, ?)`,
            seq,
            identity.name,
            identity.kind,
            String(current.body),
            body!.body,
            now,
          );
          this.ctx.storage.sql.exec(
            `UPDATE messages
                SET body = ?, mentions_json = ?, delivery_targets_json = ?,
                    original_body = COALESCE(original_body, ?),
                    edited_at = ?, edited_by = ?, rev_seq = ?
              WHERE seq = ?`,
            body!.body,
            JSON.stringify(editRouting!.frame.mentions),
            JSON.stringify(nextHistoricalTargets),
            currentOriginalBody,
            now,
            identity.name,
            this.nextRevSeq(),
            seq,
          );
          const updated = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
          editState.frame = this.rowToFrame(updated);
          this.ensureDirectedDeliveries(
            editState.frame,
            newDeliveryTargets,
            editRouting!.deliveryTargetOwners,
            "mention_edit",
          );
        });
        if (editState.failure !== undefined) {
          return Response.json(
            { error: { code: editState.failure.code, message: editState.failure.message } },
            { status: ERROR_STATUS[editState.failure.code] },
          );
        }
        const frame = editState.frame;
        if (frame === undefined) throw new Error("atomic message edit produced no frame");
        this.broadcastFrame(this.messageUpdate("edit", identity, frame, now));
        this.flushAtomicDeliveryEffects(effects);
        await this.scheduleAuditRetention(now);
        return Response.json({ message: publicMsgFrame(frame) });
      }
      if (action === "retract") {
        // Preserve the server-owned lineage before the row is scrubbed. A pending question parks
        // work on the origin message, so retracting only deliveries whose message_seq is the
        // question would strand that continuation forever.
        const retractedDecisionRequest = parseStoredDecisionRequest(row.decision_request_json);
        const invalidatedDecisionSeqs: number[] = [];
        const effects = this.captureAtomicDeliveryEffects(() => {
          this.ctx.storage.sql.exec(
            `INSERT INTO message_audit (
               target_seq, action, actor_name, actor_kind, old_body, new_body, original_byte_length, created_at
             ) VALUES (?, 'retract', ?, ?, NULL, NULL, ?, ?)`,
            seq,
            identity.name,
            identity.kind,
            byteLength(originalBody),
            now,
          );
          this.ctx.storage.sql.exec(
            "UPDATE message_audit SET old_body = NULL, new_body = NULL WHERE target_seq = ?",
            seq,
          );
          this.ctx.storage.sql.exec(
            `UPDATE messages
                SET body = '[retracted]', mentions_json = '[]', delivery_targets_json = '[]', original_body = NULL,
                    state = NULL, note = NULL, status_scope_json = NULL, status_blocked_reason = NULL,
                    status_context_json = NULL, status_decision_json = NULL, status_workflow_json = NULL,
                    message_workflow_json = NULL, completion_artifact_json = NULL,
                    completion_review_state = NULL, completion_review_policy = NULL,
                    completion_reviewed_by = NULL, completion_reviewed_by_kind = NULL,
                    completion_reviewed_by_owner = NULL, completion_reviewed_at = NULL,
                    completion_review_reason = NULL,
                    decision_request_json = NULL, decision_state = NULL,
                    decision_resolution_json = NULL, decision_response_json = NULL,
                    retracted_at = ?, retracted_by = ?, rev_seq = ?
              WHERE seq = ?`,
            now,
            identity.name,
            this.nextRevSeq(),
            seq,
          );

          // A queued/dead webhook payload is an immutable copy of the original frame. Scrubbing the
          // messages row alone would leave a retract bypass: alarm retry or moderator redeliver could
          // still POST the private original body. Match the source from the JSON payload itself so
          // notify and agent rows use the same deletion rule, including legacy-compatible JSON rows.
          const payloadSeq =
            "CASE WHEN json_valid(payload) THEN CAST(json_extract(payload, '$.seq') AS INTEGER) ELSE NULL END";
          const deliveryRoots: Record<string, unknown>[] = this.ctx.storage.sql
            .exec(
              `SELECT * FROM directed_deliveries
                WHERE message_seq = ?
                ORDER BY created_at, id`,
              seq,
            )
            .toArray();
          if (retractedDecisionRequest?.delivery_id !== undefined) {
            const source = this.exactDecisionSource(row, retractedDecisionRequest);
            if (source !== undefined && String(source.state) === "waiting_owner") {
              deliveryRoots.push(source);
            }
          }
          // Retract is terminal for every active execution adapter, not just rows that still have a
          // webhook retry payload. Descendant owner answers are part of the same continuation and
          // must close in the same SQLite commit; broadcasts/dispatch remain deferred by capture.
          invalidatedDecisionSeqs.push(...this.failRetractedDeliveryTree(deliveryRoots, now));
          this.ctx.storage.sql.exec(`DELETE FROM webhook_queue WHERE ${payloadSeq} = ?`, seq);
          this.ctx.storage.sql.exec(
            `DELETE FROM webhook_dead_letters WHERE mention_seq = ? OR ${payloadSeq} = ?`,
            seq,
            seq,
          );
        });
        this.flushAtomicDeliveryEffects(effects);
        for (const questionSeq of new Set(invalidatedDecisionSeqs)) {
          const question = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", questionSeq).toArray()[0];
          if (question !== undefined) {
            this.broadcastFrame(this.messageUpdate("decision", identity, this.rowToFrame(question), now));
          }
        }
        const updated = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
        const frame = this.rowToFrame(updated);
        this.broadcastFrame(this.messageUpdate("retract", identity, frame, now));
        await this.scheduleAuditRetention(now);
        return Response.json({ message: publicMsgFrame(frame) });
      }

      const mentions = Array.isArray(body!.mentions) ? body!.mentions.filter((m): m is string => typeof m === "string") : [];
      const out = await this.handleSend(
        identity,
        { type: "send", kind: "message", body: body!.body as string, mentions, reply_to: seq },
        { countRate: true },
      );
      if (!out.ok) {
        return Response.json({ error: { code: out.code, message: out.message } }, { status: ERROR_STATUS[out.code] });
      }
      // 同一次超越是一个修订事件：新旧两行共用一个 rev_seq
      const supersedeRev = this.nextRevSeq();
      this.ctx.storage.sql.exec("UPDATE messages SET superseded_by = ?, rev_seq = ? WHERE seq = ?", out.seq, supersedeRev, seq);
      this.ctx.storage.sql.exec("UPDATE messages SET supersedes = ?, rev_seq = ? WHERE seq = ?", seq, supersedeRev, out.seq);
      const oldRow = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
      const newRow = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", out.seq).one();
      const oldFrame = this.rowToFrame(oldRow);
      const newFrame = this.rowToFrame(newRow);
      this.ctx.storage.sql.exec(
        `INSERT INTO message_audit (target_seq, action, actor_name, actor_kind, old_body, new_body, created_at)
         VALUES (?, 'supersede', ?, ?, ?, ?, ?)`,
        seq,
        identity.name,
        identity.kind,
        String(row.body),
        body!.body,
        now,
      );
      this.broadcastFrame(this.messageUpdate("supersede", identity, oldFrame, now));
      this.flushAtomicDeliveryEffects(out.atomicEffects);
      this.broadcastFrame(newFrame);
      await this.afterSend(newFrame, undefined, true);
      await this.scheduleAuditRetention(now);
      return Response.json({ message: publicMsgFrame(newFrame), superseded: publicMsgFrame(oldFrame) });
    }
    const reviewMatch = url.pathname.match(/^\/internal\/messages\/([1-9]\d*)\/review$/);
    if (reviewMatch && request.method === "POST") {
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"));
      const seq = Number(reviewMatch[1]);
      const identity: Identity = {
        name: request.headers.get("x-ap-name") ?? "",
        kind: request.headers.get("x-ap-kind") === "agent" ? "agent" : "human",
        role: (request.headers.get("x-ap-role") ?? "readonly") as TokenRole,
        owner: request.headers.get("x-ap-owner") ?? undefined,
        handle: decodedHeaderText(request.headers, "x-ap-handle"),
        ...profileFromHeaders(request.headers),
        lineage: lineageFromHeaders(request.headers),
        tokenHash: request.headers.get("x-ap-token-hash") ?? "",
        collabRole: parseCollaborationRole(request.headers.get("x-ap-collab-role") ?? undefined) ?? undefined,
        collabRoleSource: parseRoleSource(request.headers.get("x-ap-role-source") ?? undefined) ?? undefined,
        canWrite: request.headers.get("x-ap-can-write") === "1",
        // #434：REST 发送方 CLI 版本（index.ts 已把 x-ap-client-version 转发进来），快照进消息 sender_client_version。
        clientVersion: parseClientVersion(request.headers.get("x-ap-client-version")) ?? undefined,
      };
      if (this.isArchived()) {
        return Response.json({ error: { code: "archived", message: "channel is archived" } }, { status: 410 });
      }
      if (identity.role === "readonly") {
        return Response.json({ error: { code: "unauthorized", message: "readonly token cannot review completions" } }, { status: 403 });
      }
      if (!(await this.isTokenActive(identity.tokenHash))) {
        return Response.json({ error: { code: "unauthorized", message: "invalid or revoked token" } }, { status: 401 });
      }
      const body = (await request.json().catch(() => null)) as { action?: unknown; reason?: unknown } | null;
      const action = body?.action;
      if (action !== "approve" && action !== "reject") {
        return Response.json({ error: { code: "bad_request", message: "action must be approve or reject" } }, { status: 400 });
      }
      const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      if (action === "reject" && reason === "") {
        return Response.json({ error: { code: "bad_request", message: "reject reason is required" } }, { status: 400 });
      }
      if (byteLength(reason) > REVIEW_REASON_LIMIT) {
        return Response.json({ error: { code: "too_large", message: `reason exceeds ${REVIEW_REASON_LIMIT} bytes` } }, { status: 413 });
      }
      const row = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
      if (!row) {
        return Response.json({ error: { code: "not_found", message: `message seq ${seq} not found` } }, { status: 404 });
      }
      if (String(row.kind) !== "message" || row.completion_artifact_json === null || row.completion_artifact_json === undefined) {
        return Response.json({ error: { code: "bad_request", message: "target is not a completion message" } }, { status: 400 });
      }
      if (row.retracted_at !== null && row.retracted_at !== undefined) {
        return Response.json({ error: { code: "bad_request", message: "retracted completion cannot be reviewed" } }, { status: 400 });
      }
      const currentState = row.completion_review_state === null || row.completion_review_state === undefined ? null : String(row.completion_review_state);
      if (currentState !== "pending_review") {
        return Response.json({ error: { code: "review_already_final", message: "completion is not pending review" } }, { status: 409 });
      }
      const policy =
        row.completion_review_policy === null || row.completion_review_policy === undefined
          ? "sender"
          : (String(row.completion_review_policy) as CompletionReviewPolicy);
      const senderName = String(row.sender_name);
      const senderOwner =
        row.sender_owner === null || row.sender_owner === undefined ? undefined : String(row.sender_owner);
      if (identity.name === senderName) {
        return Response.json({ error: { code: "forbidden", message: "completion sender cannot review their own completion" } }, { status: 403 });
      }
      if (policy === "owner" && identity.owner !== undefined && senderOwner !== undefined && identity.owner === senderOwner) {
        return Response.json({ error: { code: "forbidden", message: "same owner cannot review this completion" } }, { status: 403 });
      }
      const now = Date.now();
      const state: CompletionReviewState = action === "approve" ? "approved" : "rejected";
      // #627 / CodeRabbit #650：驳回回复要定向投递给完成作者（agent）。必须用落库时快照的
      // creation-time principal（row.sender_owner），不是当前同名 token 的 owner——原 agent 被撤、
      // 同名 token 被别的 owner 重建时，按当前 owner 投递会送错人。缺快照则在改动 review 状态**前**
      // fail closed，绝不静默投给错误 owner 或原地失败。
      if (action === "reject" && String(row.sender_kind) === "agent" && senderOwner === undefined) {
        return Response.json(
          { error: { code: "unavailable", message: "completion is missing its creation-time principal; cannot bind reject reply delivery" } },
          { status: 503 },
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE messages
            SET completion_review_state = ?,
                completion_reviewed_by = ?,
                completion_reviewed_by_kind = ?,
                completion_reviewed_by_owner = ?,
                completion_reviewed_at = ?,
                completion_review_reason = ?,
                rev_seq = ?
          WHERE seq = ?`,
        state,
        identity.name,
        identity.kind,
        identity.owner ?? null,
        now,
        action === "reject" ? reason : null,
        this.nextRevSeq(),
        seq,
      );
      const updated = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
      const message = this.rowToFrame(updated);
      this.broadcastFrame(this.messageUpdate("review", identity, message, now));
      const replyBody =
        action === "approve"
          ? reason === ""
            ? `review approved #${seq}`
            : `review approved #${seq}: ${reason}`
          : `@${senderName} review rejected #${seq}: ${reason}`;
      const mentions = action === "reject" ? [senderName] : [];
      const reply = this.insertReviewerReply(identity, replyBody, mentions, seq, now);
      this.broadcastFrame(reply);
      // #627：驳回回复 @ 原作者（agent）必须绑定 creation-time principal（上面 fail-closed 已保证
      // agent sender 时 senderOwner 存在），否则 ensureDirectedDeliveries 存 target_owner=null，
      // dispatchNextDirectedDelivery 的 null-principal 守卫立即把行置 failed（delivery_failed 不在
      // REVIVABLE_DELIVERY_FAILURES）→ agent 永远不被唤醒重交。
      const rejectTargets = String(row.sender_kind) === "agent" ? [senderName] : [];
      const rejectTargetOwners = senderOwner !== undefined ? { [senderName]: senderOwner } : {};
      await this.afterSend(reply, rejectTargets, false, rejectTargetOwners);
      return Response.json({ message: publicMsgFrame(message), reply: publicMsgFrame(reply) });
    }
    // 人类决策回应（#284）：镜像 completion review 的收口——resolve 请求 + 广播 message_update("decision")
    // + 落一条 decision_response 回复 @ 请求方。approval 用 action=approve/reject，choice 用 option=下标/文本。
    const decisionMatch = url.pathname.match(/^\/internal\/messages\/([1-9]\d*)\/decision$/);
    if (decisionMatch && request.method === "POST") {
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"));
      const seq = Number(decisionMatch[1]);
      const identity: Identity = {
        name: request.headers.get("x-ap-name") ?? "",
        kind: request.headers.get("x-ap-kind") === "agent" ? "agent" : "human",
        role: (request.headers.get("x-ap-role") ?? "readonly") as TokenRole,
        owner: request.headers.get("x-ap-owner") ?? undefined,
        handle: decodedHeaderText(request.headers, "x-ap-handle"),
        ...profileFromHeaders(request.headers),
        lineage: lineageFromHeaders(request.headers),
        tokenHash: request.headers.get("x-ap-token-hash") ?? "",
        collabRole: parseCollaborationRole(request.headers.get("x-ap-collab-role") ?? undefined) ?? undefined,
        collabRoleSource: parseRoleSource(request.headers.get("x-ap-role-source") ?? undefined) ?? undefined,
        canWrite: request.headers.get("x-ap-can-write") === "1",
        // #434：REST 发送方 CLI 版本（index.ts 已把 x-ap-client-version 转发进来），快照进消息 sender_client_version。
        clientVersion: parseClientVersion(request.headers.get("x-ap-client-version")) ?? undefined,
      };
      // moderator 由 worker 层（isChannelModerator）算好后转发；DO 只信这一位。
      const isModerator = request.headers.get("x-ap-moderator") === "1";
      if (this.isArchived()) {
        return Response.json({ error: { code: "archived", message: "channel is archived" } }, { status: 410 });
      }
      if (identity.role === "readonly") {
        return Response.json({ error: { code: "unauthorized", message: "readonly token cannot respond to decisions" } }, { status: 403 });
      }
      if (!(await this.isTokenActive(identity.tokenHash))) {
        return Response.json({ error: { code: "unauthorized", message: "invalid or revoked token" } }, { status: 401 });
      }
      const row = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
      if (!row) {
        return Response.json({ error: { code: "not_found", message: `message seq ${seq} not found` } }, { status: 404 });
      }
      const decisionReq = parseStoredDecisionRequest(row.decision_request_json);
      if (String(row.kind) !== "message" || decisionReq === undefined) {
        return Response.json({ error: { code: "bad_request", message: "target is not a decision request" } }, { status: 400 });
      }
      if (row.retracted_at !== null && row.retracted_at !== undefined) {
        return Response.json({ error: { code: "bad_request", message: "retracted decision cannot be answered" } }, { status: 400 });
      }
      const currentState = row.decision_state === null || row.decision_state === undefined ? null : String(row.decision_state);
      const senderName = String(row.sender_name);
      const expectedResponderOwner = decisionReq.expected_responder_owner;
      if (
        expectedResponderOwner !== undefined &&
        (identity.kind !== "human" || identity.owner !== expectedResponderOwner)
      ) {
        return Response.json(
          { error: { code: "forbidden", message: "only the requested human owner can respond to this decision" } },
          { status: 403 },
        );
      }
      if (identity.name === senderName) {
        return Response.json({ error: { code: "forbidden", message: "the requesting agent cannot answer its own decision" } }, { status: 403 });
      }
      // 人在回路：只有人类或 moderator 能替频道拍板；普通 worker agent 不行。
      if (identity.kind !== "human" && !isModerator) {
        return Response.json({ error: { code: "forbidden", message: "only a human or moderator can respond to a decision" } }, { status: 403 });
      }
      const resolvedRetryResponse = (): Response | null => {
        const resolvedRow = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
        if (resolvedRow === undefined || String(resolvedRow.decision_state ?? "") !== "resolved") return null;
        const originalResolution = parseStoredDecisionResolution(resolvedRow);
        const originalResponder = originalResolution?.responder;
        const originalOwner = originalResolution?.responder_owner ?? originalResponder?.owner;
        const sameResponder =
          originalResponder?.name === identity.name &&
          originalResponder.kind === identity.kind &&
          (originalOwner === undefined || originalOwner === identity.owner);
        if (!sameResponder) return null;
        const originalReplyRow = this.ctx.storage.sql
          .exec(
            `SELECT * FROM messages
              WHERE decision_response_json IS NOT NULL
                AND CAST(json_extract(decision_response_json, '$.request_seq') AS INTEGER) = ?
              ORDER BY seq LIMIT 1`,
            seq,
          )
          .toArray()[0];
        return originalReplyRow === undefined
          ? null
          : Response.json({
              message: publicMsgFrame(this.rowToFrame(resolvedRow)),
              reply: publicMsgFrame(this.rowToFrame(originalReplyRow)),
            });
      };
      if (currentState === "resolved") {
        const retry = resolvedRetryResponse();
        if (retry !== null) return retry;
      }
      if (currentState !== "pending") {
        return Response.json({ error: { code: "decision_already_final", message: "decision is not pending" } }, { status: 409 });
      }
      const body = (await request.json().catch(() => null)) as { option?: unknown; action?: unknown; reason?: unknown } | null;
      let chosenIndex: number | null = null;
      if (body?.action === "approve" || body?.action === "reject") {
        if (decisionReq.kind !== "approval") {
          return Response.json({ error: { code: "bad_request", message: "action is only valid for approval decisions" } }, { status: 400 });
        }
        chosenIndex = body.action === "approve" ? 0 : 1;
      } else if (body?.action !== undefined) {
        return Response.json({ error: { code: "bad_request", message: "action must be approve or reject" } }, { status: 400 });
      } else if (typeof body?.option === "number" && Number.isInteger(body.option)) {
        chosenIndex = body.option;
      } else if (typeof body?.option === "string") {
        chosenIndex = decisionReq.options.indexOf(body.option.trim());
      } else {
        return Response.json({ error: { code: "bad_request", message: "option (index or text) or action is required" } }, { status: 400 });
      }
      if (chosenIndex < 0 || chosenIndex >= decisionReq.options.length) {
        return Response.json({ error: { code: "bad_request", message: "chosen option is out of range" } }, { status: 400 });
      }
      const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      if (byteLength(reason) > DECISION_REASON_LIMIT) {
        return Response.json({ error: { code: "too_large", message: `reason exceeds ${DECISION_REASON_LIMIT} bytes` } }, { status: 413 });
      }
      // Bind the generated owner-answer work to the question sender's creation-time principal
      // before finalizing the decision. A current same-name token must never inherit an old answer.
      let replyTargetOwners: Record<string, string> = {};
      if (String(row.sender_kind) === "agent") {
        const senderPrincipal =
          typeof row.sender_owner === "string" && row.sender_owner.length > 0
            ? row.sender_owner
            : undefined;
        let principal = senderPrincipal;
        if (decisionReq.delivery_id !== undefined) {
          const sourceDelivery = this.exactDecisionSource(row, decisionReq);
          if (sourceDelivery === undefined) {
            return Response.json(
              { error: { code: "unavailable", message: "decision response target lineage is no longer available" } },
              { status: 503 },
            );
          }
          if (String(sourceDelivery.state) !== "waiting_owner") {
            return Response.json(
              { error: { code: "decision_already_final", message: "decision source work is no longer waiting for owner" } },
              { status: 409 },
            );
          }
          principal = String(sourceDelivery.target_owner);
        } else if (row.reply_to !== null && row.reply_to !== undefined) {
          // A server-bound decision can only become "unbound" through retention/corruption. Fail
          // closed if its replied-to origin has durable work for this agent, regardless of state.
          const possibleSource = this.ctx.storage.sql
            .exec(
              `SELECT id FROM directed_deliveries
                WHERE message_seq = ? AND target_name = ?
                LIMIT 1`,
              Number(row.reply_to),
              senderName,
            )
            .toArray()[0];
          if (possibleSource !== undefined) {
            return Response.json(
              { error: { code: "unavailable", message: "decision response is missing its source lineage" } },
              { status: 503 },
            );
          }
        }
        if (principal === undefined) {
          replyTargetOwners = (await this.agentOwnersForTargets([senderName])) ?? {};
        } else {
          replyTargetOwners = { [senderName]: principal };
        }
        if (!Object.prototype.hasOwnProperty.call(replyTargetOwners, senderName)) {
          return Response.json(
            { error: { code: "unavailable", message: "cannot bind decision response target identity" } },
            { status: 503 },
          );
        }
      }
      const now = Date.now();
      const chosenOption = decisionReq.options[chosenIndex];
      const resolution: DecisionResolution = {
        state: "resolved",
        chosen_index: chosenIndex,
        chosen_option: chosenOption,
        responder: senderFromIdentity(identity),
        ...(identity.owner === undefined ? {} : { responder_owner: identity.owner }),
        responded_at: now,
        ...(reason === "" ? {} : { reason }),
      };
      const replyBody = `@${senderName} decision #${seq} → ${chosenOption}${reason === "" ? "" : `: ${reason}`}`;
      const response: DecisionResponse = {
        request_seq: seq,
        chosen_index: chosenIndex,
        chosen_option: chosenOption,
        prompt: decisionReq.prompt,
        ...(reason === "" ? {} : { reason }),
        ...(decisionReq.delivery_id === undefined
          ? {}
          : {
              delivery_id: decisionReq.delivery_id,
              origin_seq: decisionReq.origin_seq!,
              origin_channel: decisionReq.origin_channel!,
              work_id: decisionReq.work_id!,
              continuation_ref: decisionReq.continuation_ref!,
            }),
      };
      let message: MsgFrame | undefined;
      let reply: MsgFrame | undefined;
      const replyTargets = String(row.sender_kind) === "agent" ? [senderName] : [];
      const casLost = new Error("decision request was finalized concurrently");
      let effects: AtomicDeliveryEffects;
      try {
        effects = this.captureAtomicDeliveryEffects(() => {
          const decisionRev = this.nextRevSeq();
          this.ctx.storage.sql.exec(
            `UPDATE messages
                SET decision_state = 'resolved', decision_resolution_json = ?, rev_seq = ?
              WHERE seq = ? AND decision_state = 'pending'
                AND (
                  ? IS NULL OR
                  (? = 'human' AND json_extract(decision_request_json, '$.expected_responder_owner') = ?)
                )`,
            JSON.stringify(resolution),
            decisionRev,
            seq,
            expectedResponderOwner ?? null,
            identity.kind,
            identity.owner ?? null,
          );
          const changed = Number(this.ctx.storage.sql.exec("SELECT changes() AS count").one().count);
          if (changed !== 1) throw casLost;
          const updated = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
          if (updated === undefined) throw new Error("resolved decision request disappeared");
          message = this.rowToFrame(updated);
          reply = this.insertDecisionResponse(
            identity,
            replyBody,
            [senderName],
            seq,
            response,
            now,
          );
          this.ensureDirectedDeliveries(reply, replyTargets, replyTargetOwners);
        });
      } catch (error) {
        if (error !== casLost) throw error;
        const retry = resolvedRetryResponse();
        if (retry !== null) return retry;
        return Response.json(
          { error: { code: "decision_already_final", message: "decision is not pending" } },
          { status: 409 },
        );
      }
      if (message === undefined || reply === undefined) {
        throw new Error("atomic decision response produced no message");
      }
      this.broadcastFrame(this.messageUpdate("decision", identity, message, now));
      this.flushAtomicDeliveryEffects(effects);
      this.broadcastFrame(reply);
      await this.afterSend(
        reply,
        replyTargets,
        true,
        replyTargetOwners,
      );
      return Response.json({ message: publicMsgFrame(message), reply: publicMsgFrame(reply) });
    }
    if (url.pathname === "/internal/search" && request.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length === 0) {
        return Response.json({ error: { code: "bad_request", message: "q required" } }, { status: 400 });
      }
      const since = Math.max(toInt(url.searchParams.get("since"), 0), 0);
      const limit = Math.min(Math.max(toInt(url.searchParams.get("limit"), 100), 1), 1000);
      const from = url.searchParams.get("from");
      const like = `%${escapeLike(query.toLowerCase())}%`;
      const fromSql = from === null ? "" : " AND sender_name = ?";
      const args: (number | string)[] =
        from === null
          ? [since, like, like, like, limit]
          : [since, from, like, like, like, limit];
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM messages
            WHERE seq > ?${fromSql}
              AND retracted_at IS NULL
              AND (
                lower(body) LIKE ? ESCAPE '\\'
                OR lower(note) LIKE ? ESCAPE '\\'
                OR lower(sender_name) LIKE ? ESCAPE '\\'
              )
            ORDER BY seq DESC
            LIMIT ?`,
          ...args,
        )
        .toArray();
      const hits = rows.map((row) => {
        const frame = this.rowToFrame(row);
        const matchField = firstMatchingField(frame, query);
        return {
          type: "search_hit",
          channel: this.name,
          query,
          seq: frame.seq,
          sender: frame.sender,
          kind: frame.kind,
          match_field: matchField,
          snippet: snippetFor(frame, matchField),
          ts: frame.ts,
        } satisfies SearchHit;
      });
      return Response.json({ hits });
    }
    if (url.pathname === "/internal/wake-deliveries" && request.method === "GET") {
      const since = Math.max(toInt(url.searchParams.get("since"), 0), 0);
      const limit = Math.min(Math.max(toInt(url.searchParams.get("limit"), 20), 1), 100);
      const target = url.searchParams.get("target");
      const targetSql = target === null ? "" : " AND target_name = ?";
      const args: (number | string)[] = target === null ? [since, limit] : [since, target, limit];
      const deliveries = this.ctx.storage.sql
        .exec(
          `SELECT mention_seq, target_name, webhook_name, adapter_kind, attempt,
                  result, http_status, error, attempted_at, ack_seq, resume_seq
             FROM wake_delivery_ledger
            WHERE mention_seq >= ?${targetSql}
            ORDER BY mention_seq, attempt, id
            LIMIT ?`,
          ...args,
        )
        .toArray()
        .map((r) => ({
          mention_seq: Number(r.mention_seq),
          target_name: String(r.target_name),
          webhook_name: String(r.webhook_name),
          adapter_kind: String(r.adapter_kind),
          attempt: Number(r.attempt),
          result: String(r.result),
          http_status: r.http_status === null ? null : Number(r.http_status),
          error: r.error === null ? null : String(r.error),
          attempted_at: Number(r.attempted_at),
          ack_seq: r.ack_seq === null ? null : Number(r.ack_seq),
          resume_seq: r.resume_seq === null ? null : Number(r.resume_seq),
        }));
      return Response.json({ deliveries });
    }
    if (url.pathname === "/internal/dead-letters" && request.method === "GET") {
      // #105：列出被永久放弃、待重投的死信（不回 payload 明文，正文在频道历史里已可读）
      return Response.json({ dead_letters: this.listDeadLetters() });
    }
    if (url.pathname === "/internal/dead-letters/redeliver" && request.method === "POST") {
      // #105：重投死信。?name= 限定单个 webhook；缺省重投全部（受批次上限约束）。
      const name = url.searchParams.get("name");
      const result = await this.redeliverDeadLetters(name);
      return Response.json(result);
    }
    if (url.pathname === "/internal/read-cursors" && request.method === "GET") {
      // 已读游标快照 + 频道最新 seq，供 `party who` 标注每个身份读到第几条 / 落后多少（Phase 2 · CLI）。
      return Response.json({ cursors: this.readCursors(), last_seq: this.lastSeq() });
    }
    // GDPR 按身份数据出口/擦除（#421）。授权在 worker 层做（moderator 门），DO 只按 name 读/删本频道数据。
    const identityDataMatch = url.pathname.match(/^\/internal\/identity\/([^/]+)\/data$/);
    if (identityDataMatch && request.method === "GET") {
      // 只读导出：该身份在本频道可归因的全部数据（消息 + 审计 + wake 账本 + 读游标 + presence）。
      const name = decodeURIComponent(identityDataMatch[1]!);
      const cursor = (key: string): number => {
        const value = Number(url.searchParams.get(key) ?? "0");
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
      };
      return Response.json(this.exportIdentityData(name, {
        messages: cursor("message_after"), audit: cursor("audit_after"), wake_deliveries: cursor("wake_after"),
      }));
    }
    if (identityDataMatch && request.method === "DELETE") {
      // 硬擦除：物理删除该身份在本频道的可识别数据，并把其发过的消息正文/归属 PII 抹成 [erased]。
      const name = decodeURIComponent(identityDataMatch[1]!);
      const actor: Identity = {
        name: request.headers.get("x-ap-name") ?? "system",
        kind: request.headers.get("x-ap-kind") === "agent" ? "agent" : "human",
        role: (request.headers.get("x-ap-role") ?? "host") as TokenRole,
        tokenHash: request.headers.get("x-ap-token-hash") ?? "",
      };
      return Response.json(this.eraseIdentityData(name, actor));
    }
    if (url.pathname === "/internal/messages" && request.method === "POST") {
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"));
      const identity: Identity = {
        name: request.headers.get("x-ap-name") ?? "",
        kind: request.headers.get("x-ap-kind") === "agent" ? "agent" : "human",
        role: (request.headers.get("x-ap-role") ?? "readonly") as TokenRole,
        owner: request.headers.get("x-ap-owner") ?? undefined,
        handle: decodedHeaderText(request.headers, "x-ap-handle"),
        ...profileFromHeaders(request.headers),
        lineage: lineageFromHeaders(request.headers),
        tokenHash: request.headers.get("x-ap-token-hash") ?? "",
        collabRole: parseCollaborationRole(request.headers.get("x-ap-collab-role") ?? undefined) ?? undefined,
        collabRoleSource: parseRoleSource(request.headers.get("x-ap-role-source") ?? undefined) ?? undefined,
        canWrite: request.headers.get("x-ap-can-write") === "1",
        // #434：REST 发送方 CLI 版本（index.ts 已把 x-ap-client-version 转发进来），快照进消息 sender_client_version。
        clientVersion: parseClientVersion(request.headers.get("x-ap-client-version")) ?? undefined,
      };
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: { code: "bad_request", message: "invalid json" } }, { status: 400 });
      }
      const send = parseSendFrame(raw);
      if (!send) {
        const rate = this.consumeRate(identity.name, Date.now());
        if (rate !== null) {
          return Response.json(
            { error: { code: rate.code, message: rate.message } },
            { status: ERROR_STATUS[rate.code] },
          );
        }
        return Response.json({ error: { code: "bad_request", message: sendRejectMessage(raw) } }, { status: 400 });
      }
      const expectedDecisionLineage = parseExpectedDecisionLineage(
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>).expected_decision_lineage
          : undefined,
      );
      if (expectedDecisionLineage === null) {
        return Response.json(
          { error: { code: "bad_request", message: "invalid expected_decision_lineage" } },
          { status: 400 },
        );
      }
      const expectedDecisionResponderOwner = parseExpectedDecisionResponderOwner(
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>).expected_decision_responder_owner
          : undefined,
      );
      if (expectedDecisionResponderOwner === null) {
        return Response.json(
          { error: { code: "bad_request", message: "invalid expected_decision_responder_owner" } },
          { status: 400 },
        );
      }
      const out = await this.handleSend(identity, send, {
        countRate: true,
        ...(expectedDecisionLineage === undefined ? {} : { expectedDecisionLineage }),
        ...(expectedDecisionResponderOwner === undefined ? {} : { expectedDecisionResponderOwner }),
      });
      if (!out.ok) {
        return Response.json(
          { error: { code: out.code, message: out.message } },
          { status: ERROR_STATUS[out.code] },
        );
      }
      // 幂等去重命中（#98）：首发时已广播/唤醒过，重发只回原 seq，绝不重复副作用
      if (!out.deduped) {
        const sent = out.frames[0] as MsgFrame;
        const parksSourceWork =
          sent.decision_request?.delivery_id !== undefined &&
          sent.decision_resolution?.state === "pending";
        // A legacy holder is selected by the committed delivery transition; publish that selection
        // before raw broadcast or the legacy filter correctly suppresses the still-queued message.
        // Decision asks are the inverse: expose the question before announcing that its source work
        // is parked, preserving the question -> waiting_owner event contract.
        if (!parksSourceWork) this.flushAtomicDeliveryEffects(out.atomicEffects);
        for (const f of out.frames) this.broadcastFrame(f);
        if (parksSourceWork) this.flushAtomicDeliveryEffects(out.atomicEffects);
        await this.closeInactiveConnections();
        await this.afterSend(sent, undefined, true);
      }
      const sent = out.frames[0] as MsgFrame;
      return Response.json({
        seq: out.seq,
        ...(sent.completion_review === undefined ? {} : { completion_review: sent.completion_review }),
        ...(sent.decision_request === undefined
          ? {}
          : { decision_request: publicDecisionRequest(sent.decision_request) }),
        ...(sent.decision_resolution === undefined ? {} : { decision_resolution: sent.decision_resolution }),
      });
    }
    if (url.pathname === "/internal/webhooks" && request.method === "GET") {
      // 列表不回 secret 明文（spec §7）
      const webhooks = this.ctx.storage.sql
        .exec("SELECT name, url, filter, mode, created_at FROM webhooks ORDER BY name")
        .toArray()
        .map((r) => ({
          name: String(r.name),
          url: String(r.url),
          filter: String(r.filter),
          mode: String(r.mode) === "agent" ? "agent" : "notify",
          created_at: Number(r.created_at),
        }));
      return Response.json({ webhooks });
    }
    if (url.pathname === "/internal/webhooks" && request.method === "POST") {
      // 参数校验在 worker 层完成，do 只做落库（同名覆盖 = 幂等注册）
      const body = (await request.json().catch(() => null)) as {
        name?: unknown;
        url?: unknown;
        secret?: unknown;
        filter?: unknown;
        mode?: unknown;
        target_owner?: unknown;
      } | null;
      const mode = body?.mode === undefined ? "notify" : body.mode;
      if (
        typeof body?.name !== "string" ||
        typeof body.url !== "string" ||
        typeof body.secret !== "string" ||
        typeof body.filter !== "string" ||
        (mode !== "notify" && mode !== "agent") ||
        (mode === "agent" && (typeof body.target_owner !== "string" || body.target_owner.length === 0))
      ) {
        return Response.json({ error: { code: "bad_request", message: "invalid webhook" } }, { status: 400 });
      }
      const count = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM webhooks").one().n);
      const exists = this.ctx.storage.sql
        .exec("SELECT name FROM webhooks WHERE name = ?", body.name)
        .toArray();
      if (exists.length === 0 && count >= MAX_WEBHOOKS_PER_CHANNEL) {
        return Response.json(
          { error: { code: "rate_limited", message: `max ${MAX_WEBHOOKS_PER_CHANNEL} webhooks per channel` } },
          { status: 429 },
        );
      }
      const registrationId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO webhooks (name, registration_id, url, secret, filter, mode, target_owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET url = excluded.url, secret = excluded.secret,
           registration_id = excluded.registration_id, filter = excluded.filter,
           mode = excluded.mode, target_owner = excluded.target_owner, created_at = excluded.created_at`,
        body.name,
        registrationId,
        body.url,
        body.secret,
        body.filter,
        mode,
        mode === "agent" ? body.target_owner : null,
        Date.now(),
      );
      if (mode === "agent") this.dispatchNextDirectedDelivery(body.name);
      return Response.json({ name: body.name, url: body.url, filter: body.filter, mode }, { status: 201 });
    }
    if (url.pathname === "/internal/roles" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { name?: unknown; role?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name : "";
      const role = body?.role === null ? null : parseCollaborationRole(body?.role);
      if (!name || role === undefined) {
        return Response.json({ error: { code: "bad_request", message: "invalid role assignment" } }, { status: 400 });
      }
      if (role === null) {
        this.ctx.storage.sql.exec(
          "UPDATE presence SET role = NULL, role_source = NULL WHERE name = ? AND role_source = 'assigned'",
          name,
        );
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE presence SET role = ?, role_source = 'assigned' WHERE name = ?",
          role,
          name,
        );
      }
      const entry = this.presenceFor(name);
      if (entry) this.broadcastFrame({ type: "presence", ...entry });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/webhooks" && request.method === "DELETE") {
      const name = url.searchParams.get("name") ?? "";
      const existed = this.ctx.storage.sql
        .exec(
          "SELECT name, registration_id, mode, target_owner FROM webhooks WHERE name = ?",
          name,
        )
        .toArray()[0];
      if (existed === undefined) {
        return Response.json({ error: { code: "not_found", message: "no such webhook" } }, { status: 404 });
      }
      const currentBinding: WebhookBinding = {
        name,
        registrationId: String(existed.registration_id),
        mode: String(existed.mode) === "agent" ? "agent" : "notify",
        targetOwner: existed.target_owner === null || existed.target_owner === undefined
          ? null
          : String(existed.target_owner),
      };
      const active = this.ctx.storage.sql
        .exec(
          `SELECT * FROM directed_deliveries
            WHERE lease_adapter = 'webhook' AND lease_connection_id = ?
              AND state IN ('claimed', 'running')`,
          this.webhookHolderId(currentBinding.registrationId),
        )
        .toArray();
      const queued = this.ctx.storage.sql
        .exec(
          `SELECT webhook_name, registration_id, webhook_mode, target_owner, payload, attempts
             FROM webhook_queue WHERE webhook_name = ?`,
          name,
        )
        .toArray();
      this.ctx.storage.sql.exec("DELETE FROM webhooks WHERE name = ?", name);
      const now = Date.now();
      for (const row of queued) {
        const binding = this.storedWebhookBinding(row);
        const payload = String(row.payload);
        const failure = {
          ok: false,
          status: null,
          error: "webhook registration removed; queued delivery was not reassigned",
        };
        this.recordDeadLetter(name, payload, Number(row.attempts), failure, now, binding);
        this.failDirectedWebhookDelivery(payload, binding, failure.error, now);
      }
      this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE webhook_name = ?", name);
      // Dead letters intentionally remain bound to the removed registration. A same-name webhook
      // created later cannot redeliver them; operators still retain the explicit failure evidence.
      for (const row of active) {
        this.transitionDirectedDeliveryTerminal(String(row.id), "failed", now, {
          error: String(row.state) === "running"
            ? "agent webhook removed after accepted handoff; outcome unknown, not auto-retried"
            : "agent webhook removed during handoff; outcome unknown, not auto-retried",
          terminalReason: "unknown_outcome",
          expectedStates: [String(row.state)],
          expectedLeaseAdapter: "webhook",
          expectedLeaseConnectionId: this.webhookHolderId(currentBinding.registrationId),
        });
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/reset-guard" && request.method === "POST") {
      this.clearLoopGuardState();
      return Response.json({ ok: true });
    }
    const resetWorkflowGuardMatch = url.pathname.match(/^\/internal\/workflows\/([^/]+)\/reset-guard$/);
    if (resetWorkflowGuardMatch && request.method === "POST") {
      const workflowId = decodeURIComponent(resetWorkflowGuardMatch[1] ?? "");
      if (!WORKFLOW_ID_RE.test(workflowId)) {
        return Response.json({ error: { code: "bad_request", message: "valid workflow_id required" } }, { status: 400 });
      }
      this.resetWorkflowGuard(workflowId);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/archive" && request.method === "POST") {
      // do 自己记下归档态（handleSend/onConnect 的权威依据），再踢存活连接
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"));
      const ts = toInt(request.headers.get("x-ap-archive-at"), Date.now());
      this.archiveAndKick();
      this.setMeta("archive_pending_at", String(ts));
      await this.reconcileD1Archive(ts);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/kick" && request.method === "POST") {
      // token 吊销即时生效：按 name 踢掉存活连接
      const body = (await request.json().catch(() => null)) as { name?: unknown; mode?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name : "";
      if (!name) {
        return Response.json({ error: { code: "bad_request", message: "name required" } }, { status: 400 });
      }
      const owners = new Set<string>();
      for (const connection of this.getConnections<ConnState>()) {
        if (connection.state?.name !== name) continue;
        if (connection.state.owner !== undefined) owners.add(connection.state.owner);
        this.closeRevokedConnection(connection);
      }
      if (body?.mode === "remove") {
        const now = Date.now();
        this.setMeta(this.removedPresenceKey(name), String(now));
        this.ctx.storage.sql.exec("DELETE FROM presence WHERE name = ?", name);
        this.ctx.storage.sql.exec("DELETE FROM listening_health WHERE name = ?", name);
        this.broadcastFrame({ type: "presence", name, state: "offline", note: null, ts: now });
        this.insertSystemStatus(`removed ${name} from channel`, now, false, { state: "done" });
      }
      return Response.json({ ok: true, owners: [...owners] });
    }
    // 交互 lane 活动直报（issue #615）：不跑 serve 的 Claude Code session 经 REST 自报活动。
    // 授权在 worker 侧已判（agent 只准自报），do 只落状态。presence 无行则无从附着，静默吞。
    const activityMatch = url.pathname.match(/^\/internal\/presence\/([^/]+)\/activity$/);
    if (activityMatch && request.method === "POST") {
      const name = decodeURIComponent(activityMatch[1] ?? "");
      if (!name) {
        return Response.json({ error: { code: "bad_request", message: "name required" } }, { status: 400 });
      }
      const body = (await request.json().catch(() => null)) as { activity?: unknown } | null;
      const activity = parseAgentActivity(body?.activity);
      const now = Date.now();
      if (activity === undefined) {
        return Response.json({ error: { code: "bad_request", message: "valid activity required" } }, { status: 400 });
      }
      // 未来时间戳拒收（容忍 60s 时钟抖动）：ts 是序列化侧 TTL 的输入，放进来一个远未来值
      // 会让僵活动永不过期地钉在 presence 上。
      if (activity.ts - now > 60_000) {
        return Response.json({ error: { code: "bad_request", message: "activity.ts is in the future" } }, { status: 400 });
      }
      // 兜底节流（客户端已 15s 节流，这里防绕过）：按**服务端时钟**记上次接受时刻——client 提供的
      // ts 不可信，不能当节流依据。DO 休眠会清掉内存标记，代价只是偶尔多接受一次，可承受。
      const lastAccepted = this.activityPushAcceptedAt.get(name);
      if (lastAccepted !== undefined && now - lastAccepted < 3_000) {
        return Response.json({ ok: true, throttled: true });
      }
      this.activityPushAcceptedAt.set(name, now);
      const updated = this.ctx.storage.sql.exec(
        "UPDATE presence SET activity_json = ? WHERE name = ?",
        JSON.stringify(activity),
        name,
      );
      if (updated.rowsWritten > 0) this.broadcastPresenceFor(name);
      return Response.json({ ok: true, attached: updated.rowsWritten > 0 });
    }
    // 人为暂停/恢复接待（issue #180）。授权在 worker 侧已判（moderator），do 只落状态。
    const pauseMatch = url.pathname.match(/^\/internal\/presence\/([^/]+)\/(pause|resume)$/);
    if (pauseMatch && request.method === "POST") {
      const name = decodeURIComponent(pauseMatch[1] ?? "");
      const action = pauseMatch[2];
      if (!name) {
        return Response.json({ error: { code: "bad_request", message: "name required" } }, { status: 400 });
      }
      const now = Date.now();
      if (action === "pause") {
        const body = (await request.json().catch(() => null)) as { resume_at?: unknown } | null;
        let resumeAt: number | null = null;
        if (body?.resume_at !== undefined && body.resume_at !== null) {
          const parsed = Number(body.resume_at);
          if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= now) {
            return Response.json(
              { error: { code: "bad_request", message: "resume_at must be a future epoch-ms integer" } },
              { status: 400 },
            );
          }
          resumeAt = parsed;
        }
        this.pausePresence(name, resumeAt, now);
        return Response.json({ ok: true, paused: true, ...(resumeAt !== null ? { resume_at: resumeAt } : {}) });
      }
      this.resumePresence(name, now);
      return Response.json({ ok: true, paused: false });
    }
    // #108 per-agent wake 预算 set/inspect。授权在 worker 侧已判（agent-for-self / moderator），do 只落状态。
    const wakeBudgetMatch = url.pathname.match(/^\/internal\/wake-budget\/([^/]+)$/);
    if (wakeBudgetMatch) {
      const name = decodeURIComponent(wakeBudgetMatch[1] ?? "");
      if (!name) {
        return Response.json({ error: { code: "bad_request", message: "name required" } }, { status: 400 });
      }
      if (request.method === "GET") {
        return Response.json(this.wakeBudgetState(name));
      }
      if (request.method === "PUT") {
        const body = (await request.json().catch(() => null)) as
          | { enabled?: unknown; limit?: unknown; window_ms?: unknown }
          | null;
        // enabled 显式 false = 清除预算（回到不限）；缺省视为设置。
        if (body?.enabled === false) {
          this.deleteMeta(`wake_budget_limit:${name}`);
          this.deleteMeta(`wake_budget_window:${name}`);
          this.deleteMeta(`wake_budget_alerted:${name}`);
          return Response.json(this.wakeBudgetState(name));
        }
        const limit = Number(body?.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          return Response.json(
            { error: { code: "bad_request", message: "limit must be a positive integer" } },
            { status: 400 },
          );
        }
        const rawWindow =
          body?.window_ms === undefined || body?.window_ms === null
            ? WAKE_BUDGET_DEFAULT_WINDOW_MS
            : Number(body.window_ms);
        if (!Number.isInteger(rawWindow) || rawWindow < WAKE_BUDGET_MIN_WINDOW_MS) {
          return Response.json(
            { error: { code: "bad_request", message: `window_ms must be an integer >= ${WAKE_BUDGET_MIN_WINDOW_MS}` } },
            { status: 400 },
          );
        }
        this.setMeta(`wake_budget_limit:${name}`, String(Math.min(limit, WAKE_BUDGET_MAX_LIMIT)));
        this.setMeta(`wake_budget_window:${name}`, String(Math.min(rawWindow, WAKE_BUDGET_MAX_WINDOW_MS)));
        this.deleteMeta(`wake_budget_alerted:${name}`); // 改配置即清抑制标记，新配置下可重新告警
        return Response.json(this.wakeBudgetState(name));
      }
    }
    return new Response("not found", { status: 404 });
  }

  private async expandSquadMentions(frame: SendFrame): Promise<ResolvedMentionFrame | SendErrorOutcome> {
    const mentions = frame.mentions ?? [];
    if (mentions.length === 0) return { frame, agentTargets: [] };
    const candidates = mentions.filter((name) => name !== "system" && MENTION_NAME_RE.test(name));
    if (candidates.length === 0) return { frame, agentTargets: [] };
    const placeholders = candidates.map(() => "?").join(", ");
    let rows: { results: { name: string; leader_name: string | null; members_json: string | null }[] };
    try {
      rows = await this.env.DB.prepare(
        `SELECT name, leader_name, members_json
           FROM channel_squads
          WHERE channel_slug = ? AND name IN (${placeholders})`,
      )
        .bind(this.name, ...candidates)
        .all<{ name: string; leader_name: string | null; members_json: string | null }>();
    } catch {
      return {
        ok: false,
        code: "unavailable",
        message: "squad directory is temporarily unavailable; message was not stored",
      };
    }
    if (rows.results.length === 0) return { frame, agentTargets: [] };
    const requestedTargets: string[] = [];
    const requestedSeen = new Set<string>();
    for (const row of rows.results) {
      const members = (() => {
        try {
          const parsed = JSON.parse(row.members_json ?? "[]");
          return Array.isArray(parsed)
            ? parsed.filter((name): name is string => typeof name === "string" && MENTION_NAME_RE.test(name))
            : [];
        } catch {
          return [];
        }
      })();
      const targets = row.leader_name && MENTION_NAME_RE.test(row.leader_name) ? [row.leader_name] : members;
      for (const target of targets) {
        if (target === "system") continue;
        const key = mentionMatchKey(target);
        if (requestedSeen.has(key)) continue;
        requestedSeen.add(key);
        requestedTargets.push(target);
      }
    }
    if (requestedTargets.length === 0) return { frame, agentTargets: [] };

    // Squad JSON is configuration, not an authority for token spelling or liveness. Resolve every
    // member through D1 and route only the canonical token name so case variants cannot create an
    // unclaimable durable row.
    let tokenRows: { results: { name: string }[] };
    try {
      const tokenPlaceholders = requestedTargets.map(() => "?").join(", ");
      tokenRows = await this.env.DB.prepare(
        `SELECT name FROM tokens
          WHERE role = 'agent' AND revoked_at IS NULL
            AND (channel_scope IS NULL OR channel_scope = ?)
            AND name COLLATE NOCASE IN (${tokenPlaceholders})`,
      )
        .bind(this.name, ...requestedTargets)
        .all<{ name: string }>();
    } catch {
      return {
        ok: false,
        code: "unavailable",
        message: "agent directory is temporarily unavailable; message was not stored",
      };
    }
    const canonical = new Map(tokenRows.results.map((row) => [mentionMatchKey(row.name), row.name] as const));
    const routed = [...mentions];
    const routedSeen = new Set(routed.map(mentionMatchKey));
    const agentTargets: string[] = [];
    const agentSeen = new Set<string>();
    for (const requested of requestedTargets) {
      const target = canonical.get(mentionMatchKey(requested));
      if (target === undefined) continue;
      const key = mentionMatchKey(target);
      if (!agentSeen.has(key)) {
        agentSeen.add(key);
        agentTargets.push(target);
      }
      if (routedSeen.has(key)) continue;
      if (routed.length >= MAX_MENTIONS) {
        return {
          ok: false,
          code: "too_large",
          message: `squad expansion exceeds ${MAX_MENTIONS} mention targets`,
        };
      }
      routedSeen.add(key);
      routed.push(target);
    }
    return { frame: withExpandedMentions(frame, routed), agentTargets };
  }

  private async agentOwnersForTargets(targets: string[]): Promise<Record<string, string> | null> {
    if (targets.length === 0) return {};
    try {
      const placeholders = targets.map(() => "?").join(", ");
      const rows = await this.env.DB.prepare(
        `SELECT name, owner, hash FROM tokens
          WHERE role = 'agent' AND revoked_at IS NULL
            AND (channel_scope IS NULL OR channel_scope = ?)
            AND name COLLATE NOCASE IN (${placeholders})`,
      )
        .bind(this.name, ...targets)
        .all<{ name: string; owner: string | null; hash: string }>();
      const byName = new Map(
        rows.results
          .filter((row) => typeof row.hash === "string" && row.hash.length > 0)
          .map((row) => [
            mentionMatchKey(row.name),
            typeof row.owner === "string" && row.owner.length > 0
              ? row.owner
              : `token-sha256:${row.hash}`,
          ] as const),
      );
      return Object.fromEntries(
        targets.flatMap((target) => {
          const owner = byName.get(mentionMatchKey(target));
          return owner === undefined ? [] : [[target, owner]];
        }),
      );
    } catch {
      // A durable row without a creation-time principal can later be captured by a different owner
      // reusing the same agent name. handleSend therefore fails before INSERT when this lookup fails.
      return null;
    }
  }

  private async mentionAliasDirectory(candidates: string[]): Promise<{ aliases: MentionAlias[]; agentTargets: Set<string> }> {
    const aliases: MentionAlias[] = [];
    const agentTargets = new Set<string>();
    const seen = new Set<string>();
    const add = (alias: unknown, target: unknown, kind: MentionAlias["kind"], agent = false) => {
      if (typeof alias !== "string" || typeof target !== "string") return;
      if (!isValidMentionToken(alias) || !isValidMentionToken(target) || target === "system") return;
      const key = `${mentionMatchKey(alias)}\0${mentionMatchKey(target)}\0${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      aliases.push({ alias, target, kind });
      if (agent) agentTargets.add(mentionMatchKey(target));
    };
    if (candidates.length === 0) return { aliases, agentTargets };

    // Candidate-bounded queries keep mention resolution off global full-table scans. The LIKE arm is
    // only a coarse prefilter for no-space CJK prose ("@小明看一下"); the shared pure resolver below
    // performs the literal prefix/uniqueness decision, so SQL wildcard semantics cannot route a target.
    const whereFor = (column: string) => candidates
      .map(() => `(? = ${column} COLLATE NOCASE OR ? LIKE (${column} || '%') COLLATE NOCASE)`)
      .join(" OR ");
    const binds = candidates.flatMap((candidate) => [candidate, candidate]);

    const [tokens, nicknames, profiles, squads] = await Promise.all([
      this.env.DB.prepare(
        `SELECT name, role FROM tokens
          WHERE revoked_at IS NULL
            AND (channel_scope IS NULL OR channel_scope = ?)
            AND (${whereFor("name")})`,
      ).bind(this.name, ...binds).all<{ name: string; role: string }>(),
      this.env.DB.prepare(
        `SELECT n.name, n.nickname
           FROM agent_nicknames n
           JOIN tokens t ON t.name = n.name
          WHERE t.revoked_at IS NULL
            AND (t.channel_scope IS NULL OR t.channel_scope = ?)
            AND (${whereFor("n.nickname")})`,
      ).bind(this.name, ...binds).all<{ name: string; nickname: string }>(),
      this.env.DB.prepare(
        `SELECT handle, display_name
           FROM account_profiles
          WHERE (${whereFor("handle")}) OR (${whereFor("display_name")})`,
      ).bind(...binds, ...binds).all<{ handle: string; display_name: string | null }>(),
      this.env.DB.prepare(
        `SELECT name
           FROM channel_squads
          WHERE channel_slug = ? AND (${whereFor("name")})`,
      ).bind(this.name, ...binds).all<{ name: string }>(),
    ]);

    for (const row of tokens.results) add(row.name, row.name, "canonical", row.role === "agent");
    for (const row of nicknames.results) add(row.nickname, row.name, "nickname", true);
    for (const row of profiles.results) {
      // Human notification webhooks are registered under the globally unique handle, so the handle
      // remains the delivery target. Readable OAuth display names are aliases only and may collide.
      add(row.handle, row.handle, "nickname");
      add(row.display_name, row.handle, "display");
    }
    for (const row of squads.results) add(row.name, row.name, "canonical");
    // Preserve #555's visible-channel routing semantics: recent message and presence identities
    // remain mentionable after a token rotation. They are aliases only, never proof that a durable
    // agent target is claimable; only the live token query above can populate agentTargets.
    const recentIdentities = this.ctx.storage.sql
      .exec(
        `SELECT sender_name, sender_kind, sender_handle, sender_display_name
           FROM messages
          WHERE sender_name IS NOT NULL
          ORDER BY seq DESC
          LIMIT 1000`,
      )
      .toArray();
    for (const row of recentIdentities) {
      const name = String(row.sender_name);
      add(name, name, "canonical");
      if (String(row.sender_kind) === "human" && row.sender_handle !== null) {
        add(String(row.sender_handle), String(row.sender_handle), "canonical");
      }
      if (row.sender_display_name !== null) {
        const target = String(row.sender_kind) === "human" && row.sender_handle !== null
          ? String(row.sender_handle)
          : name;
        add(String(row.sender_display_name), target, "display");
      }
    }
    for (const row of this.ctx.storage.sql
      .exec("SELECT name, kind, handle, display_name FROM presence")
      .toArray()) {
      const name = String(row.name);
      add(name, name, "canonical");
      if (String(row.kind) === "human" && row.handle !== null) {
        add(String(row.handle), String(row.handle), "canonical");
      }
      if (row.display_name !== null) {
        const target = String(row.kind) === "human" && row.handle !== null
          ? String(row.handle)
          : name;
        add(String(row.display_name), target, "display");
      }
    }
    for (const row of this.ctx.storage.sql.exec("SELECT name FROM webhooks").toArray()) {
      add(row.name, row.name, "canonical");
    }
    return { aliases, agentTargets };
  }

  // Resolve every body-derived and explicit mention before INSERT. Unknown/ambiguous explicit @ tokens
  // are rejected to the sender instead of being stored as an ordinary, unwakeable message. This also
  // canonicalizes case-insensitive agent names and agent nicknames for exact includes(self) consumers.
  private async resolveMentions(frame: SendFrame): Promise<ResolvedMentionFrame | SendErrorOutcome> {
    const mentions = frame.mentions ?? [];
    if (mentions.length === 0) return { frame, agentTargets: [] };
    let directory: Awaited<ReturnType<ChannelDO["mentionAliasDirectory"]>>;
    try {
      directory = await this.mentionAliasDirectory(mentions);
    } catch {
      return {
        ok: false,
        code: "unavailable",
        message: "mention directory is temporarily unavailable; message was not stored",
      };
    }
    const routed: string[] = [];
    const agentTargets = new Set<string>();
    const seen = new Set<string>();
    for (const mention of mentions) {
      if (["all", "everyone", "here", "system"].includes(mentionMatchKey(mention))) {
        return {
          ok: false,
          code: "mention_not_found",
          message: `mention target @${mention} is not a routable channel identity`,
        };
      }
      const resolution = resolveMentionToken(mention, directory.aliases);
      if (resolution.status === "unknown") {
        return {
          ok: false,
          code: "mention_not_found",
          message: `mention target @${mention} was not found; use an exact channel handle`,
        };
      }
      if (resolution.status === "ambiguous") {
        return {
          ok: false,
          code: "mention_ambiguous",
          message: `mention target @${mention} is ambiguous; use an exact channel handle`,
        };
      }
      const key = mentionMatchKey(resolution.target);
      if (seen.has(key)) continue;
      seen.add(key);
      routed.push(resolution.target);
      if (directory.agentTargets.has(key)) agentTargets.add(resolution.target);
    }
    return { frame: withExpandedMentions(frame, routed), agentTargets: [...agentTargets] };
  }

  // #544：reply_to 本身就是一条明确的定向消息。若原消息作者是 agent，即使回复正文没有再写
  // @name，也要把它加入 mentions，才能进入 watch/serve/webhook 的持久唤醒与断线重放路径。
  // 只补 agent、排除自回，避免把普通人类楼中楼回复改造成额外 @ 通知。
  private expandAgentReplyMention(
    frame: SendFrame,
    senderName: string,
  ): { frame: SendFrame; targets: Array<{ name: string; owner: string }> } {
    if (frame.kind !== "message" || frame.reply_to === null) return { frame, targets: [] };
    const row = this.ctx.storage.sql
      .exec("SELECT sender_name, sender_kind, sender_owner FROM messages WHERE seq = ?", frame.reply_to)
      .toArray()[0];
    if (row === undefined || String(row.sender_kind) !== "agent") return { frame, targets: [] };
    const target = String(row.sender_name);
    const targetOwner = typeof row.sender_owner === "string" && row.sender_owner.length > 0 ? row.sender_owner : null;
    const mentions = frame.mentions ?? [];
    if (
      targetOwner === null ||
      target === senderName ||
      target === "system" ||
      !MENTION_NAME_RE.test(target) ||
      mentions.includes(target) ||
      mentions.length >= MAX_MENTIONS
    ) return { frame, targets: [] };
    return { frame: withExpandedMentions(frame, [...mentions, target]), targets: [{ name: target, owner: targetOwner }] };
  }

  /**
   * Resolve/canonicalize every mention and bind agent targets to their creation-time principal.
   * Message creation and message edits must share this exact path: storing text that visibly says
   * `@agent` without creating the matching durable delivery is worse than rejecting the write.
   */
  private async routeMentionsForDelivery(
    frame: SendFrame,
    senderName: string,
  ): Promise<RoutedMentionFrame | SendErrorOutcome> {
    const mentionResolution = await this.resolveMentions(frame);
    if ("ok" in mentionResolution) return mentionResolution;
    const autoReplyExpansion = this.expandAgentReplyMention(mentionResolution.frame, senderName);
    frame = autoReplyExpansion.frame;
    const autoReplyTargets = autoReplyExpansion.targets;
    const squadExpansion = await this.expandSquadMentions(frame);
    if ("ok" in squadExpansion) return squadExpansion;
    frame = squadExpansion.frame;
    const requiredDeliveryTargets = [...new Set([
      ...mentionResolution.agentTargets,
      ...squadExpansion.agentTargets,
    ])];
    const candidateDeliveryTargets = [...new Set([
      ...requiredDeliveryTargets,
      ...autoReplyTargets.map((target) => target.name),
    ])];
    const ownerLookup = await this.agentOwnersForTargets(candidateDeliveryTargets);
    if (ownerLookup === null) {
      return {
        ok: false,
        code: "unavailable",
        message: "agent ownership directory is temporarily unavailable; message was not stored",
      };
    }
    const unboundDeliveryTargets = requiredDeliveryTargets.filter(
      (target) => !Object.prototype.hasOwnProperty.call(ownerLookup, target),
    );
    if (unboundDeliveryTargets.length > 0) {
      return {
        ok: false,
        code: "unavailable",
        message: `cannot bind delivery identity for @${unboundDeliveryTargets[0]}; retry shortly`,
      };
    }
    // A reply to a historical/revoked agent must remain a valid channel reply, but it must not
    // create a name-only wake that a future owner could capture. Drop only the server-added mention
    // when the current principal cannot be proven to match the source message snapshot; explicit
    // mentions keep their own validation.
    const expectedAutoOwners = new Map(autoReplyTargets.map((target) => [mentionMatchKey(target.name), target.owner]));
    const invalidAutoKeys = new Set(
      autoReplyTargets
        .filter((target) => ownerLookup[target.name] !== target.owner)
        .map((target) => mentionMatchKey(target.name)),
    );
    if (invalidAutoKeys.size > 0) {
      frame = withExpandedMentions(
        frame,
        (frame.mentions ?? []).filter((target) => !invalidAutoKeys.has(mentionMatchKey(target))),
      );
    }
    return {
      frame,
      deliveryTargets: candidateDeliveryTargets.filter((target) =>
        Object.prototype.hasOwnProperty.call(ownerLookup, target) &&
        (expectedAutoOwners.get(mentionMatchKey(target)) === undefined || !invalidAutoKeys.has(mentionMatchKey(target)))
      ),
      deliveryTargetOwners: ownerLookup,
    };
  }

  // 校验 → 分配 seq → 落库 → 修剪/presence，返回待广播帧
  private async handleSend(
    identity: Identity,
    frame: SendFrame,
    options: {
      countRate?: boolean;
      sessionId?: string;
      expectedDecisionLineage?: ExpectedDecisionLineage;
      expectedDecisionResponderOwner?: string;
    } = {},
  ): Promise<SendOutcome> {
    if (this.isArchived()) {
      return { ok: false, code: "archived", message: "channel is archived" };
    }
    if (identity.role === "readonly") {
      return { ok: false, code: "unauthorized", message: "readonly token cannot send" };
    }
    // #381 public_watch 参与门：任意人可观看（读），但发送需成员/被邀请。可见性由 worker 经 x-ap-visibility
    // 权威缓存到 meta；能否写由 worker（持 D1 成员表）经 x-ap-can-write 传入。仅 public_watch 频道据此拦发，
    // public/private 忽略此位（对现有频道零行为变化）。fail-closed：public_watch 下缺写门信号即拒。
    if (this.getMeta("visibility") === "public_watch" && identity.canWrite !== true) {
      return {
        ok: false,
        code: "unauthorized",
        message: "this channel is watch-only for non-members; sending requires membership or an invite",
      };
    }
    if (!(await this.isTokenActive(identity.tokenHash))) {
      return { ok: false, code: "unauthorized", message: "invalid or revoked token" };
    }
    const privateDecisionRequest =
      frame.kind === "message" ? (frame.decision_request as DecisionRequest | undefined) : undefined;
    if (options.expectedDecisionResponderOwner !== undefined) {
      if (privateDecisionRequest === undefined) {
        return {
          ok: false,
          code: "bad_request",
          message: "expected_decision_responder_owner requires a decision_request",
        };
      }
      if (identity.owner !== options.expectedDecisionResponderOwner) {
        return {
          ok: false,
          code: "unauthorized",
          message: "expected_decision_responder_owner must match the sender's authenticated owner",
        };
      }
    }
    // 幂等去重（#98）：必须在 rate/loop/workflow guard 与 INSERT 之前——重试是网络产物而非第二条消息，
    // 不能重复消耗配额、不能重复触发熔断，更不能重复落库/重复唤醒。命中就原样返回首发那条的 seq。
    // 窗口 IDEMPOTENCY_WINDOW_MS 内、同一 sender_name 的同一 key 才去重；DO 单线程 + 重试串行发生，
    // SELECT→INSERT 之间无并发同键写入之虞。
    if (frame.idempotency_key !== undefined) {
      const priorRow = this.ctx.storage.sql
        .exec(
          "SELECT * FROM messages WHERE sender_name = ? AND idempotency_key = ? AND ts >= ? ORDER BY seq DESC LIMIT 1",
          identity.name,
          frame.idempotency_key,
          Date.now() - IDEMPOTENCY_WINDOW_MS,
        )
        .toArray()[0];
      if (priorRow !== undefined) {
        if (options.expectedDecisionResponderOwner !== undefined) {
          const priorDecision = parseStoredDecisionRequest(priorRow.decision_request_json);
          if (priorDecision?.expected_responder_owner !== options.expectedDecisionResponderOwner) {
            return {
              ok: false,
              code: "bad_request",
              message: "idempotent decision responder binding does not match the stored request",
            };
          }
        }
        return { ok: true, seq: Number(priorRow.seq), frames: [this.rowToFrame(priorRow)], deduped: true };
      }
    }
    const payload = frame.kind === "message" ? frame.body : frame.note;
    if (byteLength(payload) > BODY_LIMIT) {
      return { ok: false, code: "too_large", message: `body exceeds ${BODY_LIMIT} bytes` };
    }
    const mentionRouting = await this.routeMentionsForDelivery(frame, identity.name);
    if ("ok" in mentionRouting) return mentionRouting;
    frame = mentionRouting.frame;
    const { deliveryTargets, deliveryTargetOwners } = mentionRouting;
    const workflowGuard = this.workflowGuardDecision(identity, frame);
    if (workflowGuard !== null) {
      const row = this.workflowGuardRow(workflowGuard.workflow.workflow_id);
      if ((row?.no_progress ?? 0) === 1 && !workflowGuard.progressed) {
        return {
          ok: false,
          code: "workflow_guard",
          message: this.workflowGuardBlockedMessage(workflowGuard.workflow.workflow_id, row?.blocked_seq ?? null),
        };
      }
    }
    // status 是 presence/协调状态，不是对话消息：agent 已触发 fair-share guard 后仍必须能声明
    // blocked/waiting，让频道知道它为什么停下。它也不消耗/重置消息 streak（#466）。
    const loopGuard = identity.kind === "agent" && frame.kind === "message" ? this.loopGuardMessage(identity.name) : null;
    if (loopGuard !== null) {
      this.alertLoopGuard(loopGuard);
      return {
        ok: false,
        code: "loop_guard",
        message: loopGuard,
      };
    }
    const now = Date.now();

    const sql = this.ctx.storage.sql;
    const seq = this.nextSeq();
    const sender: Sender = senderFromIdentity(identity);
    const hostDecision = frame.kind === "status" ? hostDecisionFromSend(frame.decision, identity.name) : undefined;
    const workflow = frame.kind === "status" ? statusWorkflowFromSend(frame.workflow) : undefined;
    const messageWorkflow = workflowGuard?.workflow;
    const status: StatusEvent | null =
      frame.kind === "status"
        ? {
            owner: identity.name,
            state: frame.state,
            scope: frame.scope ?? [],
            summary_seq: frame.summary_seq ?? null,
            blocked_reason: frame.blocked_reason ?? null,
            updated_at: now,
            ...(frame.context === undefined ? {} : { context: frame.context }),
            ...(hostDecision === undefined ? {} : { decision: hostDecision }),
            ...(workflow === undefined ? {} : { workflow }),
          }
        : null;
    const effectiveRole = identity.collabRole ?? (frame.kind === "status" ? frame.role : undefined);
    const roleSource: CollaborationRoleSource | undefined =
      identity.collabRole !== undefined
        ? "assigned"
        : frame.kind === "status" && frame.role !== undefined
          ? "self"
          : undefined;
    const completionGate = this.getMeta("completion_gate");
    const completionReviewPolicy = (this.getMeta("completion_review_policy") ?? "sender") as CompletionReviewPolicy;
    const completionArtifact = frame.kind === "message" ? frame.completion_artifact : undefined;
    // #624：落库前把附件 url 强制锚定到本频道（由 key 推导），不信任客户端传入的 url，杜绝 token 外泄。
    const attachments = frame.kind === "message" ? anchorAttachmentUrls(frame.attachments, this.name) : undefined;
    // decision_request（#284/#548）：public parser 只保留 prompt/kind/options，并主动丢掉客户端
    // 自称的 delivery/work/thread。仅 sender 恰好有一条 active durable work 时由服务端绑定血缘；
    // 多条 active 说明 invariant 已破坏，fail closed，不能猜错 owner answer 应恢复哪一条。
    const parsedDecisionRequest =
      frame.kind === "message" ? (frame.decision_request as DecisionRequest | undefined) : undefined;
    const activeDecision =
      parsedDecisionRequest !== undefined && identity.kind === "agent"
        ? this.activeDecisionDelivery(identity)
        : undefined;
    if (activeDecision !== undefined && "ambiguous" in activeDecision) {
      return {
        ok: false,
        code: "bad_request",
        message: "decision request cannot be bound: sender has multiple active directed deliveries",
      };
    }
    if (options.expectedDecisionLineage !== undefined) {
      if (parsedDecisionRequest === undefined || activeDecision === undefined) {
        return {
          ok: false,
          code: "bad_request",
          message: "decision continuation lineage has no active delivery; message was not stored",
        };
      }
      const expected = options.expectedDecisionLineage;
      if (
        activeDecision.lineage.delivery_id !== expected.delivery_id ||
        activeDecision.lineage.work_id !== expected.work_id ||
        activeDecision.lineage.continuation_ref !== expected.continuation_ref
      ) {
        return {
          ok: false,
          code: "bad_request",
          message: "decision continuation lineage does not match active delivery; message was not stored",
        };
      }
    }
    const decisionRequest =
      parsedDecisionRequest === undefined
        ? undefined
        : activeDecision === undefined
          ? {
              ...parsedDecisionRequest,
              ...(options.expectedDecisionResponderOwner === undefined
                ? {}
                : { expected_responder_owner: options.expectedDecisionResponderOwner }),
            }
          : {
              ...parsedDecisionRequest,
              ...activeDecision.lineage,
              ...(options.expectedDecisionResponderOwner === undefined
                ? {}
                : { expected_responder_owner: options.expectedDecisionResponderOwner }),
            };
    const decisionReplyTo =
      decisionRequest?.delivery_id !== undefined && activeDecision !== undefined
        ? activeDecision.lineage.origin_seq
        : frame.kind === "message"
          ? frame.reply_to
          : null;
    // 无人值守模式（unattended）：落库即自动放行第一项，agent 不必等人；approval 模式则挂起等人类。
    const decisionMode = (this.getMeta("decision_mode") ?? "approval") as DecisionMode;
    const decisionResolution: DecisionResolution | undefined =
      decisionRequest === undefined
        ? undefined
        : decisionMode === "unattended"
          ? { state: "auto_resolved", chosen_index: 0, chosen_option: decisionRequest.options[0] }
          : { state: "pending" };
    const replacesSeq =
      frame.kind === "message" && completionArtifact !== undefined && completionGate === "reviewer"
        ? frame.replaces
        : undefined;
    if (replacesSeq !== undefined) {
      const replacedRow = sql.exec("SELECT * FROM messages WHERE seq = ?", replacesSeq).one();
      if (!replacedRow) {
        return { ok: false, code: "bad_request", message: `replacement target seq ${replacesSeq} not found` };
      }
      if (
        String(replacedRow.kind) !== "message" ||
        replacedRow.completion_artifact_json === null ||
        replacedRow.completion_artifact_json === undefined
      ) {
        return { ok: false, code: "bad_request", message: "replacement target is not a completion message" };
      }
      const replacedState =
        replacedRow.completion_review_state === null || replacedRow.completion_review_state === undefined
          ? null
          : String(replacedRow.completion_review_state);
      if (replacedState !== "rejected") {
        return { ok: false, code: "bad_request", message: "replacement target is not a rejected completion" };
      }
      const replacedArtifact = parseStoredCompletionArtifact(replacedRow.completion_artifact_json);
      if (completionArtifact === undefined || replacedArtifact === undefined || replacedArtifact.kickoff_seq !== completionArtifact.kickoff_seq) {
        return { ok: false, code: "bad_request", message: "replacement target kickoff_seq does not match" };
      }
    }
    const msg: MsgFrame =
      frame.kind === "message"
        ? {
            type: "msg",
            seq,
            sender,
            kind: "message",
            body: frame.body,
            mentions: frame.mentions,
            reply_to: decisionReplyTo,
            state: null,
            note: null,
            status: null,
            ...(effectiveRole === undefined ? {} : { role: effectiveRole }),
            ...(roleSource === undefined ? {} : { role_source: roleSource }),
            ...(completionArtifact !== undefined ? { completion_artifact: completionArtifact } : {}),
            ...(attachments !== undefined ? { attachments } : {}),
            ...(completionArtifact !== undefined && completionGate === "reviewer"
              ? {
                  completion_review: {
                    state: "pending_review",
                    policy: completionReviewPolicy,
                    ...(replacesSeq === undefined ? {} : { replaces_seq: replacesSeq }),
                  },
                }
              : {}),
            ...(decisionRequest === undefined ? {} : { decision_request: decisionRequest }),
            ...(decisionResolution === undefined ? {} : { decision_resolution: decisionResolution }),
            ...(messageWorkflow === undefined ? {} : { workflow_ref: messageWorkflow }),
            ts: now,
          }
        : {
            type: "status",
            seq,
            sender,
            kind: "status",
            body: frame.note,
            mentions: frame.mentions ?? [],
            reply_to: null,
            state: frame.state,
            note: frame.note,
            status,
            ...(effectiveRole === undefined ? {} : { role: effectiveRole }),
            ...(roleSource === undefined ? {} : { role_source: roleSource }),
            ts: now,
          };
    let stagedOutcome: SendSuccessOutcome | undefined;
    let rateFailure: SendErrorOutcome | null = null;
    let decisionPreconditionFailure: SendErrorOutcome | null = null;
    const atomicEffects = this.captureAtomicDeliveryEffects(() => {
      // Re-read the compare-and-set lineage inside the same SQLite transaction that writes the
      // question and parks its source. A stale runner can therefore produce neither a message nor a
      // decision/waiting_owner state, even if storage changed after the earlier validation work.
      if (options.expectedDecisionLineage !== undefined) {
        const current = this.activeDecisionDelivery(identity);
        const expected = options.expectedDecisionLineage;
        if (
          current === undefined ||
          "ambiguous" in current ||
          current.lineage.delivery_id !== expected.delivery_id ||
          current.lineage.work_id !== expected.work_id ||
          current.lineage.continuation_ref !== expected.continuation_ref
        ) {
          decisionPreconditionFailure = {
            ok: false,
            code: "bad_request",
            message: "decision continuation lineage changed before commit; message was not stored",
          };
          return;
        }
      }
      if (options.countRate !== false) {
        const rate = this.consumeRate(identity.name, now);
        if (rate !== null) {
          rateFailure = rate;
          return;
        }
      }
    sql.exec(
      `INSERT INTO messages (
         seq, sender_name, sender_kind, sender_owner, sender_handle, sender_display_name, sender_avatar_url, sender_avatar_thumb,
         sender_lineage_json, kind, body, mentions_json, delivery_targets_json, reply_to,
         state, note, status_scope_json, status_summary_seq, status_blocked_reason, status_context_json,
         status_decision_json, status_workflow_json, message_workflow_json,
         sender_role, sender_role_source, completion_artifact_json, completion_review_state, completion_review_policy,
         completion_review_replaces_seq, decision_request_json, decision_state, decision_resolution_json,
         idempotency_key, attachments_json, sender_client_version, ts
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      seq,
      identity.name,
      identity.kind,
      identity.owner ?? null,
      identity.handle ?? null,
      identity.displayName ?? null,
      identity.avatarUrl ?? null,
      identity.avatarThumb ?? null,
      identity.lineage === undefined ? null : JSON.stringify(identity.lineage),
      msg.kind,
      msg.body,
      JSON.stringify(msg.mentions),
      JSON.stringify(deliveryTargets),
      msg.reply_to,
      msg.state,
      msg.note,
      status === null ? null : JSON.stringify(status.scope),
      status?.summary_seq ?? null,
      status?.blocked_reason ?? null,
      status?.context === undefined ? null : JSON.stringify(status.context),
      hostDecision === undefined ? null : JSON.stringify(hostDecision),
      workflow === undefined ? null : JSON.stringify(workflow),
      messageWorkflow === undefined ? null : JSON.stringify(messageWorkflow),
      effectiveRole ?? null,
      roleSource ?? null,
      frame.kind === "message" && frame.completion_artifact !== undefined
        ? JSON.stringify(frame.completion_artifact)
        : null,
      msg.completion_review?.state ?? null,
      msg.completion_review?.policy ?? null,
      replacesSeq ?? null,
      decisionRequest === undefined ? null : JSON.stringify(decisionRequest),
      decisionResolution?.state ?? null,
      decisionResolution === undefined || decisionResolution.state === "pending"
        ? null
        : JSON.stringify(decisionResolution),
      frame.idempotency_key ?? null,
      attachments === undefined ? null : JSON.stringify(attachments),
      identity.clientVersion ?? null,
      now,
    );
    this.ensureDirectedDeliveries(msg, deliveryTargets, deliveryTargetOwners);
    let waitingOwnerDelivery: Record<string, unknown> | undefined;
    let waitingOwnerPresence: PresenceEntry | null = null;
    if (
      decisionResolution?.state === "pending" &&
      activeDecision !== undefined &&
      !("ambiguous" in activeDecision)
    ) {
      // The question is durably stored before the runner lease is released. Preserve the holder in
      // a non-lease audit slot so its inevitable late "replied" receipt can be ACKed as a no-op.
      this.ctx.storage.sql.exec(
        `UPDATE directed_deliveries
            SET state = 'waiting_owner',
                last_lease_connection_id = lease_connection_id,
                lease_connection_id = NULL, lease_adapter = NULL, lease_until = NULL,
                terminal_reason = NULL,
                updated_at = ?
          WHERE id = ? AND target_name = ? AND target_owner = ? AND state IN ('claimed', 'running')`,
        now,
        activeDecision.lineage.delivery_id,
        identity.name,
        this.identityDeliveryPrincipal(identity),
      );
      const updatedDelivery = this.directedDeliveryRow(activeDecision.lineage.delivery_id);
      if (updatedDelivery === undefined || String(updatedDelivery.state) !== "waiting_owner") {
        throw new Error("failed to detach runner while waiting for owner");
      }
      waitingOwnerDelivery = updatedDelivery;
      this.broadcastDirectedDelivery(updatedDelivery);
      // waiting_owner is durable parked work, not a running/busy model task. Clear only the
      // heartbeat that points at this exact origin; unrelated sessions/tasks for the same identity
      // are left alone. The CLI's later clear heartbeat remains idempotent.
      this.ctx.storage.sql.exec(
        `UPDATE presence
            SET busy = 0, current_task = NULL, task_started_at = NULL, heartbeat_at = NULL, activity_json = NULL
          WHERE name = ? AND (current_task = ? OR current_task IS NULL)`,
        identity.name,
        activeDecision.lineage.origin_seq,
      );
      waitingOwnerPresence = this.presenceFor(identity.name);
    }
    let replacedUpdate: MessageUpdateFrame | undefined;
    if (replacesSeq !== undefined) {
      this.ctx.storage.sql.exec(
        `UPDATE messages
            SET completion_review_replaced_by_seq = ?,
                rev_seq = ?
          WHERE seq = ?`,
        seq,
        this.nextRevSeq(),
        replacesSeq,
      );
      const replacedRow = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", replacesSeq).one();
      if (replacedRow) replacedUpdate = this.messageUpdate("review", identity, this.rowToFrame(replacedRow), now);
    }
    this.linkWakeResume(identity, msg, now);
    const workflowGuardFrame = this.applyWorkflowGuardAfterSend(identity, msg, workflowGuard, now);
    if (frame.kind === "message") {
      if (identity.kind === "agent") {
        this.setMeta("agent_streak", String(this.agentStreak() + 1));
        this.setMeta(this.agentCountKey(identity.name), String(this.agentCount(identity.name) + 1));
      } else {
        this.clearLoopGuardState();
        this.clearWorkflowGuards();
      }
    }
    if (seq % 100 === 0) {
      // 按数量裁剪也必须尊重终态保留窗口：只删已过 DIRECTED_DELIVERY_TERMINAL_RETENTION_MS
      // 的非活跃 delivery，否则刚终止的审计行会在下一个第 100 条消息时被立即抹掉，绕过
      // pruneDirectedDeliveryRetention 的 7 天窗口。
      sql.exec(
        `DELETE FROM directed_deliveries
          WHERE updated_at <= ?
            AND message_seq IN (
            SELECT m.seq FROM messages m
             WHERE m.seq <= ?
               AND (m.completion_review_state IS NULL OR m.completion_review_state != 'pending_review')
               AND (m.decision_state IS NULL OR m.decision_state != 'pending')
               AND NOT EXISTS (
                 SELECT 1 FROM directed_deliveries active
                  WHERE active.message_seq = m.seq
                    AND active.state IN ('queued', 'claimed', 'running', 'waiting_owner')
               )
          )`,
        now - DIRECTED_DELIVERY_TERMINAL_RETENTION_MS,
        seq - RETAIN_N,
      );
      // 消息删除也要等 delivery 审计行清空后再动，否则保留期内的终态 delivery 会指向已删消息。
      // 上面的 delivery 裁剪先跑，剩下的 directed_deliveries 只会是活跃行或仍在保留期的终态行；
      // 任一残留都保住消息，等下一轮 delivery 过期后再一并回收。
      sql.exec(
        `DELETE FROM messages AS m
          WHERE m.seq <= ?
            AND (m.completion_review_state IS NULL OR m.completion_review_state != 'pending_review')
            AND (m.decision_state IS NULL OR m.decision_state != 'pending')
            AND NOT EXISTS (
              SELECT 1 FROM directed_deliveries d
               WHERE d.message_seq = m.seq
            )`,
        seq - RETAIN_N,
      );
    }

    const frames: ServerFrame[] = replacedUpdate === undefined ? [msg] : [msg, replacedUpdate];
    if (waitingOwnerPresence !== null) frames.push({ type: "presence", ...waitingOwnerPresence });
    if (workflowGuardFrame !== undefined) frames.push(workflowGuardFrame);
    if (frame.kind === "status") {
      const wakeProvided = frame.wake !== undefined ? 1 : 0;
      sql.exec(
        `INSERT INTO presence (
           name, session_id, kind, account, handle, display_name, avatar_url, avatar_thumb,
           state, note, updated_at, status_scope_json, status_summary_seq, status_blocked_reason,
           status_context_json, status_decision_json, status_workflow_json, role, role_source, residency, wake_kind, wake_verified_at, context_json,
           lineage_json, busy, queue_depth, agent_session_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, session_id) DO UPDATE SET
           kind = excluded.kind,
           account = COALESCE(excluded.account, presence.account),
           handle = COALESCE(excluded.handle, presence.handle),
           display_name = COALESCE(excluded.display_name, presence.display_name),
           avatar_url = COALESCE(excluded.avatar_url, presence.avatar_url),
           avatar_thumb = COALESCE(excluded.avatar_thumb, presence.avatar_thumb),
           state = excluded.state,
           note = excluded.note,
           updated_at = excluded.updated_at,
           status_scope_json = excluded.status_scope_json,
           status_summary_seq = excluded.status_summary_seq,
           status_blocked_reason = excluded.status_blocked_reason,
           status_context_json = excluded.status_context_json,
           status_decision_json = excluded.status_decision_json,
           status_workflow_json = excluded.status_workflow_json,
           role = COALESCE(excluded.role, presence.role),
           role_source = COALESCE(excluded.role_source, presence.role_source),
           residency = COALESCE(excluded.residency, presence.residency),
           wake_kind = CASE WHEN ? THEN excluded.wake_kind ELSE presence.wake_kind END,
           -- #191：wake.verified_at 只由服务端在观测到 resume 时盖（markWakeVerified），**绝不吃客户端自报**
           -- （否则回到 #55/#60 的「自称可唤醒实则叫不醒」）。status 帧只能改 wake_kind：kind 不变则保留服务端
           -- 已盖的验证时间；kind 变了（旧验证对新 kind 无效）则清空；没带 wake 则原样保留。
           wake_verified_at = CASE
             WHEN NOT ? THEN presence.wake_verified_at
             WHEN excluded.wake_kind IS presence.wake_kind THEN presence.wake_verified_at
             ELSE NULL END,
           context_json = COALESCE(excluded.context_json, presence.context_json),
           lineage_json = excluded.lineage_json,
           busy = excluded.busy,
           queue_depth = excluded.queue_depth,
           agent_session_json = COALESCE(excluded.agent_session_json, presence.agent_session_json)`,
        identity.name,
        options.sessionId ?? LEGACY_SESSION_ID,
        identity.kind,
        identity.owner ?? null, // 人类会话 = email，agent = 所属账号；presence.account 存它供前端显示「是谁」
        identity.handle ?? null, // 当前连接的人类 handle；同 account 手法，presence.handle 供前端展示/被 @
        identity.displayName ?? null,
        identity.avatarUrl ?? null,
        identity.avatarThumb ?? null,
        frame.state,
        frame.note,
        now,
        JSON.stringify(status?.scope ?? []),
        status?.summary_seq ?? null,
        status?.blocked_reason ?? null,
        status?.context === undefined ? null : JSON.stringify(status.context),
        hostDecision === undefined ? null : JSON.stringify(hostDecision),
        workflow === undefined ? null : JSON.stringify(workflow),
        effectiveRole ?? null,
        roleSource ?? null,
        frame.residency ?? null,
        frame.wake?.kind ?? null,
        null, // #191：wake_verified_at 从不采信客户端；服务端 markWakeVerified 才盖，见上方 CASE
        frame.context === undefined ? null : JSON.stringify(frame.context),
        identity.lineage === undefined ? null : JSON.stringify(identity.lineage),
        // busy/queue_depth（#103）：每条 status 覆盖写（非 COALESCE）——不显式自报 busy 的 status
        // （waiting/done/blocked 等）自然把 busy 清回 0，这就是「任务结束即清 busy」的落点。
        frame.busy === true ? 1 : 0,
        frame.queue_depth ?? 0,
        frame.agent_session === undefined ? null : JSON.stringify(frame.agent_session),
        wakeProvided,
        wakeProvided,
      );
      const entry = this.presenceFor(identity.name);
      frames.push(entry ? { type: "presence", ...entry } : { type: "presence", name: identity.name, state: frame.state, note: frame.note, ts: now });
    }
    stagedOutcome = {
      ok: true,
      seq,
      frames,
      deliveryTargets,
      deliveryTargetOwners,
    };
    });
    if (decisionPreconditionFailure !== null) return decisionPreconditionFailure;
    if (rateFailure !== null) return rateFailure;
    if (stagedOutcome === undefined) throw new Error("atomic send produced no outcome");
    return { ...stagedOutcome, atomicEffects };
  }

  private linkWakeResume(identity: Identity, msg: MsgFrame, now: number) {
    const targetName = identity.name;
    if (msg.reply_to !== null) {
      this.ctx.storage.sql.exec(
        // #107：serve/watch 的 broadcast 行在观测到 @->resume 时升级为 consumed（webhook 行 result 不动，
        // 仍是 ok/failed/budget）——"已广播"与"已确认消费"至此分明。
        `UPDATE wake_delivery_ledger
            SET ack_seq = COALESCE(ack_seq, ?),
                result = CASE WHEN adapter_kind IN ('serve', 'watch') THEN 'consumed' ELSE result END
          WHERE mention_seq = ? AND target_name = ?`,
        msg.seq,
        msg.reply_to,
        targetName,
      );
      // A bound decision_request is a question turn, not completion of the work that asked it. In
      // approval mode its source is already waiting_owner; in unattended mode it intentionally stays
      // claimed/running so the same runner can continue after auto-resolution. Neither may be closed
      // merely because the question used reply_to=origin_seq.
      if (msg.decision_request?.delivery_id === undefined) {
        this.completeDirectedDelivery(identity, msg.reply_to, msg.seq, now);
      }
      // #191：回复的正是一条 @ 了自己的消息 → 服务端亲眼看到「被 @ 后 resume」，据此盖 verified_at。
      if (this.messageMentions(msg.reply_to).includes(targetName)) this.markWakeVerified(targetName, now);
    }
    const summarySeq = msg.status?.summary_seq ?? null;
    if (summarySeq !== null) {
      this.ctx.storage.sql.exec(
        // #107：同上，status 帧的 summary_seq 指向的 @ 若命中 serve/watch broadcast 行，同样升级为 consumed。
        `UPDATE wake_delivery_ledger
            SET resume_seq = COALESCE(resume_seq, ?),
                result = CASE WHEN adapter_kind IN ('serve', 'watch') THEN 'consumed' ELSE result END
          WHERE mention_seq = ? AND target_name = ?`,
        msg.seq,
        summarySeq,
        targetName,
      );
      this.completeDirectedDelivery(identity, summarySeq, msg.seq, now);
      // 同理：status 帧 summary_seq 指向的那条消息若 @ 了自己，也是一次可验证的 resume。
      if (this.messageMentions(summarySeq).includes(targetName)) this.markWakeVerified(targetName, now);
    }
  }

  // #191：读一条历史消息的 @ 列表，用于判定「这次 resume 是不是回应对本人的 @」——
  // 别人的普通回帖不能伪造成「被唤醒」证据（校验必须来自真实的 @→resume 闭环）。
  private messageMentions(seq: number): string[] {
    const rows = this.ctx.storage.sql.exec("SELECT mentions_json FROM messages WHERE seq = ?", seq).toArray();
    // 与 rowToFrame 共用同一个存储 mentions 解析器，避免两处对空/坏值的语义漂移。
    return parseStoredMentions(rows[0]?.mentions_json);
  }

  // #191：服务端对某 agent 的 serve/watch wake layer 记下「已验证可唤醒」的时间戳。
  // 只在观测到真实 @→resume 闭环时调用；只盖 serve/watch（webhook 本就服务端投递、恒 verified，
  // wake=none/缺失不无中生有）。这是「可唤醒·已验证」区别于「自称可唤醒·未验证」的唯一可信来源。
  private markWakeVerified(name: string, now: number) {
    this.ctx.storage.sql.exec(
      "UPDATE presence SET wake_verified_at = ? WHERE name = ? AND wake_kind IN ('serve', 'watch')",
      now,
      name,
    );
  }

  private workflowGuardEnabled(): boolean {
    return this.getMeta("workflow_guard_enabled") === "1";
  }

  private workflowGuardLimit(): number {
    const configured = Number(this.getMeta("workflow_guard_limit") ?? "");
    return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 1000) : 30;
  }

  private workflowGuardRow(workflowId: string): WorkflowGuardRow | null {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM workflow_guard_state WHERE workflow_id = ?", workflowId)
      .toArray();
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      workflow_id: String(r.workflow_id),
      kind: String(r.kind) as WorkflowKind,
      run_id: r.run_id === null || r.run_id === undefined ? null : String(r.run_id),
      step_id: r.step_id === null || r.step_id === undefined ? null : String(r.step_id),
      state: r.state === null || r.state === undefined ? null : (String(r.state) as StatusState),
      count_since_progress: Number(r.count_since_progress),
      no_progress: Number(r.no_progress),
      recent_tuples: parseWorkflowGuardTuples(r.recent_tuples),
      blocked_seq: r.blocked_seq === null || r.blocked_seq === undefined ? null : Number(r.blocked_seq),
      last_progress_seq: r.last_progress_seq === null || r.last_progress_seq === undefined ? null : Number(r.last_progress_seq),
      last_counted_seq: r.last_counted_seq === null || r.last_counted_seq === undefined ? null : Number(r.last_counted_seq),
      initiator_name: r.initiator_name === null || r.initiator_name === undefined ? null : String(r.initiator_name),
      host_name: r.host_name === null || r.host_name === undefined ? null : String(r.host_name),
      terminal: Number(r.terminal),
      terminal_seq: r.terminal_seq === null || r.terminal_seq === undefined ? null : Number(r.terminal_seq),
      updated_at: Number(r.updated_at),
    };
  }

  // #106：进展 = 一个在本 run 近期窗口里从未见过的 (step_id,state) tuple。
  // 旧实现只比对紧邻上一行，任何翻转都算进展——双 agent 在 A/B 之间来回，每帧都「≠上一帧」→ 永远进展 →
  // 计数永不累加 → guard 永不 trip。现在用窗口判定：回到窗口里见过的 tuple = 非进展（振荡），计数继续爬；
  // run_id 变化 = 新 run = 全新进展且窗口重置。真正线性推进（每帧都是新 step）永远命中「窗口内没见过」→ 判进展。
  private workflowProgressed(workflow: StatusWorkflow, state: StatusState, row: WorkflowGuardRow | null): boolean {
    if (row === null) return true;
    if (row.run_id !== workflow.run_id) return true;
    return !row.recent_tuples.includes(workflowTupleKey(workflow.step_id, state));
  }

  // 计算本次落库要写回的近期窗口：run 内沿用旧窗口并追加当前 tuple（换 run 则清空重开），环形截断到窗口大小。
  // tuple 为 null（message 帧无 step/state 转移）时不追加，只保留 run 内旧窗口。
  private nextWorkflowGuardWindow(
    row: WorkflowGuardRow | null,
    workflow: StatusWorkflow,
    tuple: string | null,
  ): string[] {
    const base = row !== null && row.run_id === workflow.run_id ? row.recent_tuples : [];
    const next = tuple === null ? base : [...base, tuple];
    return next.slice(-WORKFLOW_GUARD_WINDOW);
  }

  private workflowFromReply(replyTo: number | null): StatusWorkflow | undefined {
    if (replyTo === null) return undefined;
    const rows = this.ctx.storage.sql
      .exec("SELECT message_workflow_json, status_workflow_json FROM messages WHERE seq = ?", replyTo)
      .toArray();
    if (rows.length === 0) return undefined;
    return (
      parseStoredStatusWorkflow(rows[0]!.message_workflow_json) ??
      parseStoredStatusWorkflow(rows[0]!.status_workflow_json)
    );
  }

  private currentWorkflowForSender(name: string): StatusWorkflow | undefined {
    return this.presenceFor(name)?.status?.workflow;
  }

  private workflowGuardDecision(identity: Identity, frame: SendFrame): WorkflowGuardDecision | null {
    if (!this.workflowGuardEnabled()) return null;
    if (identity.kind !== "agent") return null;
    if (frame.kind === "status") {
      const workflow = statusWorkflowFromSend(frame.workflow);
      if (workflow === undefined) return null;
      const row = this.workflowGuardRow(workflow.workflow_id);
      return {
        workflow,
        progressed: this.workflowProgressed(workflow, frame.state, row),
        countable: row !== null && !this.workflowProgressed(workflow, frame.state, row),
      };
    }
    const workflow = this.workflowFromReply(frame.reply_to) ?? this.currentWorkflowForSender(identity.name);
    if (workflow === undefined) return null;
    return { workflow, progressed: false, countable: true };
  }

  private activeHostName(): string | null {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT name FROM presence
          WHERE role = 'host' AND state != 'offline'
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .toArray();
    return rows.length > 0 ? String(rows[0]!.name) : null;
  }

  private workflowGuardBlockedMessage(workflowId: string, blockedSeq: number | null): string {
    return `workflow ${workflowId} is blocked by workflow guard${blockedSeq === null ? "" : ` at seq ${blockedSeq}`}; send a progress status or ask a human to reset it`;
  }

  private applyWorkflowGuardAfterSend(
    identity: Identity,
    msg: MsgFrame,
    decision: WorkflowGuardDecision | null,
    now: number,
  ): MsgFrame | undefined {
    if (identity.kind !== "agent" || decision === null) return undefined;
    const row = this.workflowGuardRow(decision.workflow.workflow_id);
    const hostName = this.activeHostName() ?? row?.host_name ?? null;
    if (msg.kind === "status" && msg.state === "done") {
      const window = this.nextWorkflowGuardWindow(row, decision.workflow, workflowTupleKey(decision.workflow.step_id, msg.state));
      this.upsertWorkflowGuardProgress(decision.workflow, msg.state, msg.seq, identity.name, hostName, now, true, window);
      this.pruneWorkflowGuardState();
      return undefined;
    }
    if (msg.kind === "status" && decision.progressed) {
      const state = msg.state ?? "working";
      const window = this.nextWorkflowGuardWindow(row, decision.workflow, workflowTupleKey(decision.workflow.step_id, state));
      this.upsertWorkflowGuardProgress(decision.workflow, state, msg.seq, identity.name, hostName, now, false, window);
      this.pruneWorkflowGuardState();
      return undefined;
    }
    if (!decision.countable) return undefined;
    const nextCount = (row?.count_since_progress ?? 0) + 1;
    const shouldTrip = (row?.no_progress ?? 0) === 0 && nextCount >= this.workflowGuardLimit();
    const blockedSeq = shouldTrip ? msg.seq : row?.blocked_seq ?? null;
    const trackedState = msg.kind === "status" ? msg.state : row?.state ?? null;
    // #106：只有 status 帧承载 (step,state) 转移；message 帧（reply/presence 关联的工作流）没有 tuple，
    // 传 null → 窗口原样保留，不污染振荡判定。非进展的重访 tuple 照样进窗口，让后续判定持续认得它。
    const countedTuple = msg.kind === "status" ? workflowTupleKey(decision.workflow.step_id, msg.state) : null;
    const nextWindow = this.nextWorkflowGuardWindow(row, decision.workflow, countedTuple);
    this.ctx.storage.sql.exec(
      `INSERT INTO workflow_guard_state (
         workflow_id, kind, run_id, step_id, state, count_since_progress, no_progress, recent_tuples,
         blocked_seq, last_progress_seq, last_counted_seq, initiator_name, host_name,
         terminal, terminal_seq, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET
         kind = excluded.kind,
         run_id = excluded.run_id,
         step_id = excluded.step_id,
         state = excluded.state,
         count_since_progress = excluded.count_since_progress,
         no_progress = excluded.no_progress,
         recent_tuples = excluded.recent_tuples,
         blocked_seq = COALESCE(workflow_guard_state.blocked_seq, excluded.blocked_seq),
         last_counted_seq = excluded.last_counted_seq,
         initiator_name = COALESCE(workflow_guard_state.initiator_name, excluded.initiator_name),
         host_name = COALESCE(excluded.host_name, workflow_guard_state.host_name),
         terminal = 0,
         terminal_seq = NULL,
         updated_at = excluded.updated_at`,
      decision.workflow.workflow_id,
      decision.workflow.kind,
      decision.workflow.run_id,
      decision.workflow.step_id,
      trackedState,
      nextCount,
      shouldTrip ? 1 : row?.no_progress ?? 0,
      JSON.stringify(nextWindow),
      blockedSeq,
      row?.last_progress_seq ?? null,
      msg.seq,
      row?.initiator_name ?? identity.name,
      hostName,
      now,
    );
    if (shouldTrip) {
      const mentions = [...new Set([row?.initiator_name ?? identity.name, hostName].filter((name): name is string => !!name))];
      const note = `workflow guard tripped: workflow ${decision.workflow.workflow_id} made no progress after ${nextCount} counted messages`;
      const guardFrame = this.insertSystemStatus(note, now, true, {
        mentions,
        workflow: decision.workflow,
        broadcast: false,
        state: "blocked",
      });
      this.pruneWorkflowGuardState();
      return guardFrame;
    }
    this.pruneWorkflowGuardState();
    return undefined;
  }

  private upsertWorkflowGuardProgress(
    workflow: StatusWorkflow,
    state: StatusState,
    seq: number,
    initiatorName: string,
    hostName: string | null,
    now: number,
    terminal: boolean,
    recentTuples: string[],
  ) {
    this.ctx.storage.sql.exec(
      `INSERT INTO workflow_guard_state (
         workflow_id, kind, run_id, step_id, state, count_since_progress, no_progress, recent_tuples,
         blocked_seq, last_progress_seq, last_counted_seq, initiator_name, host_name,
         terminal, terminal_seq, updated_at
       )
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET
         kind = excluded.kind,
         run_id = excluded.run_id,
         step_id = excluded.step_id,
         state = excluded.state,
         count_since_progress = 0,
         no_progress = 0,
         recent_tuples = excluded.recent_tuples,
         blocked_seq = NULL,
         last_progress_seq = excluded.last_progress_seq,
         initiator_name = COALESCE(workflow_guard_state.initiator_name, excluded.initiator_name),
         host_name = COALESCE(excluded.host_name, workflow_guard_state.host_name),
         terminal = excluded.terminal,
         terminal_seq = excluded.terminal_seq,
         updated_at = excluded.updated_at`,
      workflow.workflow_id,
      workflow.kind,
      workflow.run_id,
      workflow.step_id,
      state,
      JSON.stringify(recentTuples),
      seq,
      initiatorName,
      hostName,
      terminal ? 1 : 0,
      terminal ? seq : null,
      now,
    );
  }

  private pruneWorkflowGuardState() {
    const total = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM workflow_guard_state").one().n);
    const excess = total - 200;
    if (excess <= 0) return;
    const victims = this.ctx.storage.sql
      .exec(
        `SELECT workflow_id FROM workflow_guard_state
          WHERE no_progress = 0
          ORDER BY updated_at, workflow_id
          LIMIT ?`,
        excess,
      )
      .toArray()
      .map((r) => String(r.workflow_id));
    for (const workflowId of victims) {
      this.ctx.storage.sql.exec("DELETE FROM workflow_guard_state WHERE workflow_id = ? AND no_progress = 0", workflowId);
    }
  }

  private clearWorkflowGuards() {
    this.ctx.storage.sql.exec(
      "UPDATE workflow_guard_state SET count_since_progress = 0, no_progress = 0, blocked_seq = NULL, updated_at = ?",
      Date.now(),
    );
  }

  private resetWorkflowGuard(workflowId: string) {
    this.ctx.storage.sql.exec(
      `UPDATE workflow_guard_state
          SET count_since_progress = 0,
              no_progress = 0,
              blocked_seq = NULL,
              updated_at = ?
        WHERE workflow_id = ?`,
      Date.now(),
      workflowId,
    );
  }

  private consumeRate(name: string, now: number): SendErrorOutcome | null {
    const sql = this.ctx.storage.sql;
    const bucket = Math.floor(now / 60_000);
    sql.exec("DELETE FROM rate WHERE bucket < ?", bucket - 1);
    // 滑动窗口：当前 bucket + 上一 bucket 按剩余占比折算，跨分钟边界不翻倍
    let current = 0;
    let previous = 0;
    for (const row of sql
      .exec("SELECT bucket, count FROM rate WHERE name = ? AND bucket >= ?", name, bucket - 1)
      .toArray()) {
      if (Number(row.bucket) === bucket) current = Number(row.count);
      else previous = Number(row.count);
    }
    const windowUsed = current + previous * (1 - (now % 60_000) / 60_000);
    if (windowUsed >= RATE_LIMIT_PER_MIN) {
      return {
        ok: false,
        code: "rate_limited",
        message: `over ${RATE_LIMIT_PER_MIN} messages per minute`,
      };
    }
    sql.exec(
      `INSERT INTO rate (name, bucket, count) VALUES (?, ?, 1)
       ON CONFLICT(name, bucket) DO UPDATE SET count = count + 1`,
      name,
      bucket,
    );
    return null;
  }

  private broadcastFrame(frame: ServerFrame) {
    if (frame.type === "delivery_state") {
      const row = this.directedDeliveryRow(frame.delivery.id);
      if (row !== undefined) this.broadcastDirectedDelivery(row);
      return;
    }
    const publicFrame = publicServerFrame(frame);
    for (const connection of this.getConnections<ConnState>()) {
      if (
        connection.state?.helloPending === true &&
        (frame.type === "msg" || frame.type === "status" || frame.type === "message_update")
      ) continue;
      this.sendPublicFrame(connection, publicFrame, false);
    }
  }

  /**
   * Pre-v1 CLI sockets cannot declare whether they are watch --once, follow, or serve until a later
   * serve_lease frame. Never put a durable source @ into such a socket's raw queue unless it is the
   * already-elected legacy serve holder receiving that exact live handoff. Web agents omit
   * client_version and remain ordinary observers; humans are never considered here.
   */
  private sendPublicFrame(
    connection: Connection<ConnState>,
    frame: ServerFrame,
    replay: boolean,
  ): boolean {
    const st = connection.state;
    const message = frame.type === "msg" || frame.type === "status"
      ? frame
      : frame.type === "message_update"
        ? frame.message
        : null;
    if (
      st?.kind === "agent" &&
      // Hibernated pre-rollout states have no helloPending field. Their clientVersion proves an
      // earlier legacy hello, so undefined must not bypass raw suppression during deployment.
      st.helloPending !== true &&
      st.directedDeliveryV1 !== true &&
      typeof st.clientVersion === "string" &&
      st.clientVersion.length > 0 &&
      message?.kind === "message"
    ) {
      const row = this.ctx.storage.sql
        .exec(
          `SELECT * FROM directed_deliveries
            WHERE message_seq = ? AND target_name = ?
            LIMIT 1`,
          message.seq,
          st.name,
        )
        .toArray()[0];
      if (row !== undefined) {
        const isExactLiveLegacyServeHandoff =
          !replay &&
          frame.type === "msg" &&
          st.serveCandidate === true &&
          st.serveLeaseHeld === true &&
          String(row.state) === "running" &&
          String(row.lease_adapter) === "legacy_serve" &&
          String(row.lease_connection_id) === connection.id &&
          this.identityMatchesDeliveryTarget(st, row);
        if (!isExactLiveLegacyServeHandoff) {
          this.closeUpgradeRequired(
            connection,
            `durable @${st.name} delivery requires directed_delivery v1`,
          );
          return false;
        }
      }
    }
    this.sendFrame(connection, frame);
    return true;
  }

  private closeUpgradeRequired(connection: Connection<ConnState>, detail: string) {
    const st = connection.state;
    if (st?.upgradeRequired === true) return;
    if (st) connection.setState({ ...st, upgradeRequired: true });
    // ErrorCode does not yet contain upgrade_required; preserve the wire-compatible code while the
    // stable machine-readable marker leads the message and close reason.
    this.sendFrame(connection, {
      type: "error",
      code: "unavailable",
      message: `upgrade_required: ${detail}`,
    });
    connection.close(1008, "upgrade_required");
  }

  private closeHelloExpired(connection: Connection<ConnState>) {
    const st = connection.state;
    if (!st || st.helloExpired === true) return;
    connection.setState({ ...st, helloExpired: true });
    this.sendFrame(connection, {
      type: "error",
      code: "bad_request",
      message: "hello_required: handshake deadline expired",
    });
    connection.close(1008, "hello timeout");
  }

  private closeExpiredHelloConnections(now: number, name?: string, excludeId?: string) {
    for (const connection of this.getConnections<ConnState>()) {
      if (connection.id === excludeId) continue;
      const st = connection.state;
      if (
        st?.helloPending === true &&
        st.helloExpired !== true &&
        (name === undefined || st.name === name) &&
        typeof st.helloDeadlineAt === "number" &&
        st.helloDeadlineAt <= now
      ) this.closeHelloExpired(connection);
    }
  }

  // 每条消息都要扫一遍活连接找被撤销的 token。原实现逐连接串行 await D1：
  // 广播延迟随连接数线性放大，且 D1 抖动时 isTokenActive 的 catch 返回 false，
  // 把所有活连接当成「已撤销」集体踢掉（#114）。
  // 现在：按 tokenHash 去重（多个连接常共享同一 token）→ 并行查 → 只有明确查到
  // 「已撤销/已过期」才踢；D1 报错返回 null（未知），保留连接。
  private async closeInactiveConnections() {
    const connections = [...this.getConnections<ConnState>()].filter((c) => c.state);
    if (connections.length === 0) return;
    const hashes = [...new Set(connections.map((c) => c.state!.tokenHash))];
    const results = await Promise.all(hashes.map(async (h) => [h, await this.tokenActivity(h)] as const));
    const activity = new Map(results);
    for (const connection of connections) {
      if (activity.get(connection.state!.tokenHash) === false) this.closeRevokedConnection(connection);
    }
  }

  // 三态：true=有效，false=确认已撤销/过期，null=查不出来（D1 抖动）。
  // 踢人只认 false——把「不知道」当「已撤销」会在一次 D1 抖动里踢光整个频道。
  private async tokenActivity(hash: string): Promise<boolean | null> {
    if (!hash) return false;
    if (hash.startsWith("oidc:")) return true;
    try {
      const row = await this.env.DB.prepare(
        `SELECT id FROM tokens
          WHERE hash = ?
            AND revoked_at IS NULL
            AND (child_expires_at IS NULL OR child_expires_at > ?)`,
      )
        .bind(hash, Date.now())
        .first<{ id: number }>();
      return row !== null;
    } catch {
      return null;
    }
  }

  private closeRevokedConnection(connection: Connection<ConnState>) {
    this.sendFrame(connection, { type: "error", code: "unauthorized", message: "token revoked" });
    connection.close(1008, "revoked");
  }

  private async isTokenActive(hash: string): Promise<boolean> {
    if (!hash) return false;
    // OIDC 人类 token 不落 D1，无法被吊销扫描；生命周期由 JWT exp 在 worker 边界管辖（spec §10）
    if (hash.startsWith("oidc:")) return true;
    try {
      if (hash.startsWith("desktop:")) {
        const row = await this.env.DB.prepare(
          `SELECT id FROM desktop_sessions
            WHERE access_hash = ?
              AND revoked_at IS NULL
              AND access_expires_at > ?
              AND refresh_expires_at > ?`,
        )
          .bind(hash.slice("desktop:".length), Date.now(), Date.now())
          .first<{ id: string }>();
        return row !== null;
      }
      const row = await this.env.DB.prepare(
        `SELECT id FROM tokens
          WHERE hash = ?
            AND revoked_at IS NULL
            AND (child_expires_at IS NULL OR child_expires_at > ?)`,
      )
        .bind(hash, Date.now())
        .first<{ id: number }>();
      return row !== null;
    } catch {
      return false;
    }
  }

  private sendFrame(connection: Connection, frame: ServerFrame) {
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      try {
        connection.close(1011, "send failed");
      } catch {
        // The runtime may already have detached the socket.
      }
    }
  }

  // seq 计数器同样落 meta，绝不从 MAX(seq) 派生（#626）。与 rev_seq 同源的坑：保留期修剪
  // 按 ts 删行（DELETE FROM messages WHERE ts <= cutoff，无「保留最后 N 条」下限），一个配了
  // message_retention_ms 的频道久静默后会把整张表清空；此时 MAX(seq) 塌回 0，下条消息从 seq=1
  // 重启、复用已被在线端消费过的号。recordSeen 因老 read_cursor 已 >= 复用 seq 而不推进，
  // 流式消费端（serve/watch/web）按 seq > cursor 过滤 → 新 @ 帧被当积压丢掉，永久漏收唤醒。
  // 首次读取时从 MAX(seq) 播种，存量 DO 无需迁移即可平滑升级。
  private lastSeq(): number {
    const cached = this.getMeta("seq");
    if (cached !== null) return Number(cached);
    const row = this.ctx.storage.sql.exec("SELECT COALESCE(MAX(seq), 0) AS last FROM messages").one();
    const seeded = Number(row.last);
    this.setMeta("seq", String(seeded));
    return seeded;
  }

  // 单调递增，且立即落盘——即便本次写入随后失败，号也不会被复用（与 nextRevSeq 一致）。
  private nextSeq(): number {
    const next = this.lastSeq() + 1;
    this.setMeta("seq", String(next));
    return next;
  }

  // 已读游标快照（welcome 首帧下发）。
  private readCursors(): ReadCursor[] {
    return this.ctx.storage.sql
      .exec(`SELECT name, kind, MAX(last_seen_seq) AS last_seen_seq, MAX(updated_at) AS updated_at
               FROM read_cursor GROUP BY name ORDER BY name`)
      .toArray()
      .map((r) => ({
        name: String(r.name),
        kind: r.kind === "agent" ? "agent" : "human",
        last_seen_seq: Number(r.last_seen_seq),
        updated_at: Number(r.updated_at),
      }));
  }

  // GDPR 只读导出（#421）：该身份在本频道可归因的全部数据，供数据可携 / 出境审查。不改任何状态。
  // 复用 rowToFrame / presenceFor / readCursors，与现有观测端点同口径，不另造字段。
  private exportIdentityData(
    name: string,
    after: { messages: number; audit: number; wake_deliveries: number },
  ): IdentityExportData {
    const sql = this.ctx.storage.sql;
    const pageSize = 200;
    const messageRows = sql
      .exec("SELECT * FROM messages WHERE sender_name = ? AND seq > ? ORDER BY seq LIMIT ?", name, after.messages, pageSize + 1)
      .toArray();
    const messages = messageRows.slice(0, pageSize)
      .map((r) => publicMsgFrame(this.rowToFrame(r)));
    // 审计：该身份作为 actor 的行 + 其发的消息被审计过的行（target_seq 命中）。撤回后正文已 NULL。
    const auditRows = sql
      .exec(
        `SELECT id, target_seq, action, actor_name, actor_kind, old_body, new_body, original_byte_length, created_at
           FROM message_audit
          WHERE id > ? AND (actor_name = ? OR target_seq IN (SELECT seq FROM messages WHERE sender_name = ?))
          ORDER BY id LIMIT ?`,
        after.audit,
        name,
        name,
        pageSize + 1,
      )
      .toArray();
    const audit = auditRows.slice(0, pageSize)
      .map((r) => ({
        target_seq: Number(r.target_seq),
        action: String(r.action),
        actor: { name: String(r.actor_name), kind: String(r.actor_kind) },
        old_body: r.old_body === null || r.old_body === undefined ? null : String(r.old_body),
        new_body: r.new_body === null || r.new_body === undefined ? null : String(r.new_body),
        original_byte_length:
          r.original_byte_length === null || r.original_byte_length === undefined ? null : Number(r.original_byte_length),
        created_at: Number(r.created_at),
      }));
    const wakeRows = sql
      .exec(
        `SELECT id, mention_seq, target_name, webhook_name, adapter_kind, attempt,
                result, http_status, error, attempted_at, ack_seq, resume_seq
           FROM wake_delivery_ledger WHERE target_name = ? AND id > ? ORDER BY id LIMIT ?`,
        name,
        after.wake_deliveries,
        pageSize + 1,
      )
      .toArray();
    const wake_deliveries = wakeRows.slice(0, pageSize)
      .map((r) => ({
        mention_seq: Number(r.mention_seq),
        target_name: String(r.target_name),
        webhook_name: String(r.webhook_name),
        adapter_kind: String(r.adapter_kind),
        attempt: Number(r.attempt),
        result: String(r.result),
        http_status: r.http_status === null || r.http_status === undefined ? null : Number(r.http_status),
        error: r.error === null || r.error === undefined ? null : String(r.error),
        attempted_at: Number(r.attempted_at),
        ack_seq: r.ack_seq === null || r.ack_seq === undefined ? null : Number(r.ack_seq),
        resume_seq: r.resume_seq === null || r.resume_seq === undefined ? null : Number(r.resume_seq),
      }));
    const cursor = this.readCursors().find((c) => c.name === name) ?? null;
    const presenceEntry = this.presenceFor(name);
    return {
      name,
      exported_at: Date.now(),
      messages,
      audit,
      wake_deliveries,
      read_cursor: cursor,
      presence: presenceEntry === null ? [] : [presenceEntry],
      next: {
        messages: messageRows.length > pageSize ? Number(messageRows[pageSize - 1]!.seq) : null,
        audit: auditRows.length > pageSize ? Number(auditRows[pageSize - 1]!.id) : null,
        wake_deliveries: wakeRows.length > pageSize ? Number(wakeRows[pageSize - 1]!.id) : null,
      },
    };
  }

  // GDPR 按身份硬擦除（#421）：物理删除该身份在本频道 message_audit / wake_delivery_ledger /
  // read_cursor / presence 的可识别行，并把其发过的消息正文 + 归属 PII（owner/handle/头像/血缘/各类
  // JSON payload）抹成 [erased]——#196 撤回清洗只覆盖已撤回的消息，这里补齐「按身份彻底擦除」的口子。
  // 单事务原子提交；返回各表命中数供 worker 落审计 + CLI 回显。sender_name 作为墓碑保留（频道内昵称，
  // 非原始 PII；账号级 owner 已抹），线程/回复链不悬空；跨频道 / D1 token 维度擦除留 follow-up。
  private eraseIdentityData(name: string, actor: Identity): IdentityEraseSummary {
    const sql = this.ctx.storage.sql;
    const countOne = (query: string, ...args: (string | number)[]): number =>
      Number(sql.exec(query, ...args).one().n ?? 0);
    let messages_scrubbed = 0;
    let audit_deleted = 0;
    let wake_ledger_deleted = 0;
    let webhook_payloads_deleted = 0;
    let read_cursors_deleted = 0;
    let presence_deleted = 0;
    const attachmentKeys: string[] = [];
    const updatedSeqs: number[] = [];
    this.ctx.storage.transactionSync(() => {
      const affected = sql.exec(
        "SELECT seq, attachments_json FROM messages WHERE sender_name = ? AND body != '[erased]' ORDER BY seq",
        name,
      ).toArray();
      for (const row of affected) {
        updatedSeqs.push(Number(row.seq));
        for (const attachment of parseStoredAttachments(row.attachments_json) ?? []) attachmentKeys.push(attachment.key);
      }
      messages_scrubbed = countOne(
        "SELECT COUNT(*) AS n FROM messages WHERE sender_name = ? AND body != '[erased]'",
        name,
      );
      // 正文 + 归属 PII 一并抹除。列集对齐 #196 撤回清洗，另加 sender_owner/handle/头像/血缘/decision。
      for (const seq of updatedSeqs) {
        const revSeq = this.nextRevSeq();
        sql.exec(
        `UPDATE messages
            SET body = '[erased]', mentions_json = '[]', delivery_targets_json = '[]', original_body = NULL,
                state = NULL, note = NULL,
                status_scope_json = NULL, status_blocked_reason = NULL, status_context_json = NULL,
                status_decision_json = NULL, status_workflow_json = NULL, message_workflow_json = NULL,
                completion_artifact_json = NULL, completion_review_state = NULL, completion_review_policy = NULL,
                completion_reviewed_by = NULL, completion_reviewed_by_kind = NULL, completion_reviewed_by_owner = NULL,
                completion_reviewed_at = NULL, completion_review_reason = NULL,
                decision_request_json = NULL, decision_state = NULL,
                decision_resolution_json = NULL, decision_response_json = NULL,
                sender_owner = NULL, sender_lineage_json = NULL, sender_role = NULL, sender_role_source = NULL,
                sender_handle = NULL, sender_display_name = NULL, sender_avatar_url = NULL, sender_avatar_thumb = NULL,
                attachments_json = NULL, edited_by = NULL, retracted_by = NULL, idempotency_key = NULL,
                rev_seq = ?
          WHERE seq = ?`,
        revSeq,
        seq,
      );
      }
      audit_deleted = countOne(
        `SELECT COUNT(*) AS n FROM message_audit
          WHERE actor_name = ? OR target_seq IN (SELECT seq FROM messages WHERE sender_name = ?)`,
        name,
        name,
      );
      sql.exec(
        `DELETE FROM message_audit
          WHERE actor_name = ? OR target_seq IN (SELECT seq FROM messages WHERE sender_name = ?)`,
        name,
        name,
      );
      wake_ledger_deleted = countOne("SELECT COUNT(*) AS n FROM wake_delivery_ledger WHERE target_name = ?", name);
      sql.exec("DELETE FROM wake_delivery_ledger WHERE target_name = ?", name);
      webhook_payloads_deleted = countOne(
        `SELECT
           (SELECT COUNT(*) FROM webhook_queue
             WHERE json_extract(payload, '$.sender.name') = ?
                OR json_extract(payload, '$.directed_delivery.target_name') = ?) +
           (SELECT COUNT(*) FROM webhook_dead_letters
             WHERE json_extract(payload, '$.sender.name') = ?
                OR json_extract(payload, '$.directed_delivery.target_name') = ?) AS n`,
        name,
        name,
        name,
        name,
      );
      sql.exec(
        `DELETE FROM webhook_queue
          WHERE json_extract(payload, '$.sender.name') = ?
             OR json_extract(payload, '$.directed_delivery.target_name') = ?`,
        name,
        name,
      );
      sql.exec(
        `DELETE FROM webhook_dead_letters
          WHERE json_extract(payload, '$.sender.name') = ?
             OR json_extract(payload, '$.directed_delivery.target_name') = ?`,
        name,
        name,
      );
      // Durable work contains target identity plus private work/continuation capabilities. Erasing
      // an identity must remove those rows before a same-name principal can ever reconnect.
      sql.exec("DELETE FROM directed_deliveries WHERE target_name = ?", name);
      read_cursors_deleted = countOne("SELECT COUNT(*) AS n FROM read_cursor WHERE name = ?", name);
      sql.exec("DELETE FROM read_cursor WHERE name = ?", name);
      presence_deleted = countOne("SELECT COUNT(*) AS n FROM presence WHERE name = ?", name);
      sql.exec("DELETE FROM presence WHERE name = ?", name);
      // 监听力 streak（#603）按身份聚合，同属可识别数据，随擦除一并物理删除。
      sql.exec("DELETE FROM listening_health WHERE name = ?", name);
    });
    const erasedAt = Date.now();
    for (const seq of updatedSeqs) {
      const row = sql.exec("SELECT * FROM messages WHERE seq = ?", seq).toArray()[0];
      if (row) this.broadcastFrame(this.messageUpdate("edit", actor, this.rowToFrame(row), erasedAt));
    }
    return {
      name, erased_at: erasedAt, messages_scrubbed, audit_deleted, wake_ledger_deleted,
      webhook_payloads_deleted, read_cursors_deleted, presence_deleted,
      attachment_keys: [...new Set(attachmentKeys)],
    };
  }

  // seen 帧：把某身份的已读游标前移到 seq（只前移；旧 seq 幂等忽略）。前移了返回新游标（供广播），
  // 没前移返回 null（不广播，避免噪声）。seq 被夹到 [0, lastSeq]，防止未来 seq 污染。
  private recordSeen(name: string, sessionId: string, kind: SenderKind, seq: number): ReadCursor | null {
    const capped = Math.min(Math.max(Math.floor(seq), 0), this.lastSeq());
    if (capped <= 0) return null;
    const aggregateBefore = Number(
      this.ctx.storage.sql.exec("SELECT COALESCE(MAX(last_seen_seq), 0) AS seq FROM read_cursor WHERE name = ?", name).one()
        .seq,
    );
    const prev = this.ctx.storage.sql
      .exec("SELECT last_seen_seq FROM read_cursor WHERE name = ? AND session_id = ?", name, sessionId)
      .toArray();
    if (prev.length > 0 && Number(prev[0]!.last_seen_seq) >= capped) return null;
    const updatedAt = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO read_cursor (name, session_id, kind, last_seen_seq, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name, session_id) DO UPDATE SET kind = excluded.kind, last_seen_seq = excluded.last_seen_seq, updated_at = excluded.updated_at`,
      name,
      sessionId,
      kind,
      capped,
      updatedAt,
    );
    if (capped <= aggregateBefore) return null;
    return { name, kind, last_seen_seq: capped, updated_at: updatedAt };
  }

  // 修订游标（issue #33）：单调修订序号，编辑/撤回/超越各占一号；DO 单线程，MAX+1 足够
  // rev_seq 计数器落 meta，绝不从 MAX(rev_seq) 派生（#125）。
  //
  // 修剪按 seq 删行（DELETE FROM messages WHERE seq <= cutoff），而一条【旧】消息若被
  // 【近期】编辑/撤回过，它的 seq 很小、rev_seq 却很大。删掉这一行，MAX(rev_seq) 就回退，
  // 下一个修订复用已经发过的号。此时一个离线客户端带着 since_rev=R 回来补拉，
  // 服务端按 rev_seq > since_rev 过滤，新修订的号 <= R → 永久漏收。
  // retract 的设计场景正是撤回误发的密钥——漏收就是撤不掉。
  //
  // 首次读取时从 MAX(rev_seq) 播种，存量 DO 无需迁移即可平滑升级。
  private lastRevSeq(): number {
    const cached = this.getMeta("rev_seq");
    if (cached !== null) return Number(cached);
    const row = this.ctx.storage.sql.exec("SELECT COALESCE(MAX(rev_seq), 0) AS last FROM messages").one();
    const seeded = Number(row.last);
    this.setMeta("rev_seq", String(seeded));
    return seeded;
  }

  // 单调递增，且立即落盘——即便本次写入随后失败，号也不会被复用。
  private nextRevSeq(): number {
    const next = this.lastRevSeq() + 1;
    this.setMeta("rev_seq", String(next));
    return next;
  }

  private agentStreak(): number {
    return Number(this.getMeta("agent_streak") ?? "0");
  }

  private agentCount(name: string): number {
    return Number(this.getMeta(this.agentCountKey(name)) ?? "0");
  }

  private agentCountKey(name: string): string {
    return `agent_count:${name}`;
  }

  // 熔断实际生效的阈值：显式配置优先，否则回落 normal/party 默认（便于手工修复旧 DO meta）。
  private effectiveLoopGuardLimit(): number {
    const configured = Number(this.getMeta("loop_guard_limit") ?? "");
    return Number.isInteger(configured) && configured > 0
      ? Math.min(configured, 10_000)
      : this.getMeta("mode") === "party"
        ? LOOP_GUARD_PARTY_N
        : LOOP_GUARD_N;
  }

  // 熔断【之前】就可读的 guard 快照（#174）：limit/streak/remaining 与实际触发用同一套阈值口径，
  // 让 agent 能自我节流，而不必先撞 exit 4 把频道锁死才知道 guard 存在。
  private loopGuardState(): {
    enabled: boolean;
    limit: number;
    streak: number;
    remaining: number;
    resets_on: "human";
  } {
    const limit = this.effectiveLoopGuardLimit();
    const streak = this.agentStreak();
    return {
      enabled: this.getMeta("loop_guard_enabled") === "1",
      limit,
      streak,
      remaining: Math.max(0, limit - streak),
      resets_on: "human",
    };
  }

  private globalLoopGuardMessage(): string | null {
    if (this.getMeta("loop_guard_enabled") !== "1") return null;
    const guardLimit = this.effectiveLoopGuardLimit();
    return this.agentStreak() >= guardLimit
      ? `${guardLimit} consecutive agent messages, waiting for a human`
      : null;
  }

  private loopGuardMessage(agentName: string): string | null {
    if (this.getMeta("loop_guard_enabled") !== "1") return null;
    const global = this.globalLoopGuardMessage();
    if (global !== null) return global;
    const guardLimit = this.getMeta("mode") === "party" ? LOOP_GUARD_AGENT_PARTY_N : LOOP_GUARD_AGENT_N;
    return this.agentCount(agentName) >= guardLimit
      ? `${agentName} reached its ${guardLimit}-message fair-share budget since the last human message; another agent can continue, or a human/reset can clear it`
      : null;
  }

  private clearLoopGuardState() {
    this.setMeta("agent_streak", "0");
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE substr(key, 1, 12) = 'agent_count:'");
    this.deleteMeta("loop_guard_alerted");
  }

  private alertLoopGuard(message: string) {
    if (this.getMeta("loop_guard_alerted") !== null) return;
    this.setMeta("loop_guard_alerted", "1");
    this.insertSystemStatus(`loop guard tripped: ${message}`, Date.now(), true, { state: "blocked" });
  }

  private isArchived(): boolean {
    return this.getMeta("archived") === "1";
  }

  private participants(): Sender[] {
    const seen = new Map<string, Sender>();
    const counts = new Map<string, number>();
    for (const connection of this.getConnections<ConnState>()) {
      const st = connection.state;
      if (st?.name) {
        counts.set(st.name, (counts.get(st.name) ?? 0) + 1);
        if (!seen.has(st.name)) {
          seen.set(st.name, senderFromIdentity(st));
        }
      }
    }
    return [...seen.values()]
      .map((sender) => {
        const count = counts.get(sender.name) ?? 1;
        return count > 1 ? { ...sender, connection_count: count } : sender;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private liveConnectionCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const connection of this.getConnections<ConnState>()) {
      const name = connection.state?.name;
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }

  // ---- 持久定向投递（issue #551）----

  private rowToDirectedDelivery(row: Record<string, unknown>): DirectedDelivery {
    const storedCause = String(row.cause) as DirectedDelivery["cause"];
    const attempt = Number(row.attempt);
    return {
      id: String(row.id),
      message_seq: Number(row.message_seq),
      target_name: String(row.target_name),
      cause: attempt > 1 && storedCause !== "owner_answer" ? "retry" : storedCause,
      state: String(row.state) as DirectedDelivery["state"],
      attempt,
      lease_until: row.lease_until === null || row.lease_until === undefined ? null : Number(row.lease_until),
      work_id: row.work_id === null || row.work_id === undefined ? null : String(row.work_id),
      continuation_ref:
        row.continuation_ref === null || row.continuation_ref === undefined ? null : String(row.continuation_ref),
      reply_seq: row.reply_seq === null || row.reply_seq === undefined ? null : Number(row.reply_seq),
      last_error: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  /**
   * 目标消息正文的单行截断预览。投影时从 messages 现查（不复制存储），供 Agent 看板展示
   * 「在忙什么」——delivery 指向的消息常在客户端已加载窗口之外。已撤回消息回 null。
   */
  private deliveryMessagePreview(messageSeq: number): string | null {
    const row = this.ctx.storage.sql
      .exec("SELECT body, retracted_at FROM messages WHERE seq = ?", messageSeq)
      .toArray()[0];
    // [erased] 是身份擦除的墓碑（不设 retracted_at），和撤回一样不可展示。
    if (
      row === undefined ||
      String(row.body) === "[erased]" ||
      (row.retracted_at !== null && row.retracted_at !== undefined)
    ) return null;
    const compact = String(row.body).replace(/\s+/g, " ").trim();
    if (compact === "") return null;
    return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
  }

  private rowToPublicDirectedDelivery(
    row: Record<string, unknown>,
    detailedState = false,
    preview?: string | null,
  ): PublicDirectedDelivery {
    const delivery = this.rowToDirectedDelivery(row);
    const state =
      detailedState || delivery.state === "queued" || delivery.state === "replied" || delivery.state === "failed"
        ? delivery.state
        : "running";
    return {
      id: delivery.id,
      message_seq: delivery.message_seq,
      target_name: delivery.target_name,
      state,
      reply_seq: delivery.reply_seq,
      created_at: delivery.created_at,
      updated_at: delivery.updated_at,
      preview: preview !== undefined ? preview : this.deliveryMessagePreview(delivery.message_seq),
    };
  }

  /**
   * The creation-time principal stored in target_owner is either an account owner or, for legacy
   * owner-less tokens, the token hash prefixed with token-sha256:. Never infer it from current
   * presence/messages: a revoked name may be registered by a different account later.
   */
  private identityDeliveryPrincipal(identity: Pick<Identity, "owner" | "tokenHash">): string {
    return typeof identity.owner === "string" && identity.owner.length > 0
      ? identity.owner
      : `token-sha256:${identity.tokenHash}`;
  }

  private identityMatchesDeliveryTarget(
    identity: Pick<Identity, "name" | "owner" | "tokenHash">,
    row: Record<string, unknown>,
  ): boolean {
    const principal = typeof row.target_owner === "string" && row.target_owner.length > 0
      ? row.target_owner
      : null;
    return (
      principal !== null &&
      identity.name === String(row.target_name) &&
      this.identityDeliveryPrincipal(identity) === principal
    );
  }

  private canViewDetailedDeliveryState(connection: Connection<ConnState>, row: Record<string, unknown>): boolean {
    const viewer = connection.state;
    if (!viewer) return false;
    const owner = typeof row.target_owner === "string" && row.target_owner.length > 0
      ? row.target_owner
      : null;
    if (owner === null) return false;
    if (viewer.kind === "agent") {
      return this.identityMatchesDeliveryTarget(viewer, row);
    }
    return viewer.kind === "human" && !owner.startsWith("token-sha256:") && viewer.owner === owner;
  }

  private deliveryStateForConnection(
    connection: Connection<ConnState>,
    row: Record<string, unknown>,
    preview?: string | null,
  ): PublicDirectedDelivery {
    return this.rowToPublicDirectedDelivery(row, this.canViewDetailedDeliveryState(connection, row), preview);
  }

  private captureAtomicDeliveryEffects(run: () => void): AtomicDeliveryEffects {
    if (this.atomicDeliveryEffects !== null) {
      throw new Error("nested atomic delivery effect capture is not supported");
    }
    const effects: AtomicDeliveryEffects = {
      deliveryStateIds: new Set<string>(),
      presenceTargets: new Set<string>(),
      dispatchTargets: new Set<string>(),
    };
    this.atomicDeliveryEffects = effects;
    try {
      this.ctx.storage.transactionSync(run);
      return effects;
    } finally {
      this.atomicDeliveryEffects = null;
    }
  }

  private flushAtomicDeliveryEffects(effects?: AtomicDeliveryEffects) {
    if (effects === undefined) return;
    for (const deliveryId of effects.deliveryStateIds) {
      const row = this.directedDeliveryRow(deliveryId);
      if (row !== undefined) this.broadcastDirectedDelivery(row);
    }
    for (const targetName of effects.presenceTargets) this.broadcastPresenceFor(targetName);
    for (const targetName of effects.dispatchTargets) this.dispatchNextDirectedDelivery(targetName);
  }

  private broadcastDirectedDelivery(row: Record<string, unknown>) {
    if (this.atomicDeliveryEffects !== null) {
      this.atomicDeliveryEffects.deliveryStateIds.add(String(row.id));
      return;
    }
    // preview 每批广播只查一次，避免 fan-out 时按连接数放大 messages 查询。
    const preview = this.deliveryMessagePreview(Number(row.message_seq));
    for (const connection of this.getConnections<ConnState>()) {
      this.sendFrame(connection, {
        type: "delivery_state",
        delivery: this.deliveryStateForConnection(connection, row, preview),
      });
    }
  }

  private replayDirectedDeliveryStates(connection: Connection<ConnState>) {
    let messageSeq = -1;
    let id = "";
    for (;;) {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM directed_deliveries
            WHERE message_seq > ? OR (message_seq = ? AND id > ?)
            ORDER BY message_seq, id LIMIT ?`,
          messageSeq,
          messageSeq,
          id,
          HELLO_BACKFILL_PAGE_SIZE,
        )
        .toArray();
      for (const row of rows) {
        this.sendFrame(connection, {
          type: "delivery_state",
          delivery: this.deliveryStateForConnection(connection, row),
        });
      }
      if (rows.length < HELLO_BACKFILL_PAGE_SIZE) return;
      const last = rows[rows.length - 1]!;
      messageSeq = Number(last.message_seq);
      id = String(last.id);
    }
  }

  private directedDeliveryRow(id: string): Record<string, unknown> | undefined {
    return this.ctx.storage.sql.exec("SELECT * FROM directed_deliveries WHERE id = ?", id).toArray()[0];
  }

  private activeDecisionDelivery(
    identity: Pick<Identity, "name" | "owner" | "tokenHash">,
  ):
    | { row: Record<string, unknown>; lineage: Required<DecisionDeliveryLineage> }
    | { ambiguous: true }
    | undefined {
    const principal = this.identityDeliveryPrincipal(identity);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT * FROM directed_deliveries
          WHERE target_name = ? AND target_owner = ? AND state IN ('claimed', 'running')
          ORDER BY message_seq, created_at`,
        identity.name,
        principal,
      )
      .toArray();
    if (rows.length === 0) return undefined;
    // This should be prevented by dispatchNextDirectedDelivery, but fail closed if storage was
    // imported/corrupted rather than attaching an owner's answer to the wrong concurrent work.
    if (rows.length !== 1) return { ambiguous: true };

    let row: Record<string, unknown> = rows[0]!;
    const id = String(row.id);
    const existingWork = row.work_id === null || row.work_id === undefined ? "" : String(row.work_id);
    const existingContinuation =
      row.continuation_ref === null || row.continuation_ref === undefined ? "" : String(row.continuation_ref);
    const workId =
      existingWork.length > 0 && existingWork.length <= DELIVERY_WORK_ID_LIMIT ? existingWork : crypto.randomUUID();
    const continuationRef =
      existingContinuation.length > 0 && existingContinuation.length <= DELIVERY_CONTINUATION_REF_LIMIT
        ? existingContinuation
        : crypto.randomUUID();
    if (workId !== existingWork || continuationRef !== existingContinuation) {
      this.ctx.storage.sql.exec(
        "UPDATE directed_deliveries SET work_id = ?, continuation_ref = ? WHERE id = ?",
        workId,
        continuationRef,
        id,
      );
      row = this.directedDeliveryRow(id) ?? row;
    }
    const originChannel = this.getMeta("channel_slug") ?? this.name;
    return {
      row,
      lineage: {
        delivery_id: id,
        origin_seq: Number(row.message_seq),
        origin_channel: originChannel,
        work_id: workId,
        continuation_ref: continuationRef,
      },
    };
  }

  private async agentMentionTargets(msg: MsgFrame): Promise<string[]> {
    const candidates = [...new Set(msg.mentions.filter((name) => name !== "system"))];
    if (candidates.length === 0) return [];
    const authoritative = new Map<string, { name: string; role: string; active: boolean }>();
    let authoritativeLookupSucceeded = false;
    try {
      const placeholders = candidates.map(() => "?").join(", ");
      const rows = await this.env.DB.prepare(
        `SELECT name, role, revoked_at FROM tokens WHERE name COLLATE NOCASE IN (${placeholders})`,
      )
        .bind(...candidates)
        .all<{ name: string; role: string; revoked_at: number | null }>();
      authoritativeLookupSucceeded = true;
      for (const row of rows.results) {
        authoritative.set(mentionMatchKey(row.name), {
          name: row.name,
          role: row.role,
          active: row.revoked_at === null,
        });
      }
    } catch {
      // 老测试/自托管迁移瞬间可能没有可查的 D1 token 表；下面只用 DO 内已有的 agent 事实兜底。
    }

    const localAgents = new Set<string>();
    const localNonAgents = new Set<string>();
    const placeholders = candidates.map(() => "?").join(", ");
    for (const row of this.ctx.storage.sql
      .exec(`SELECT name, kind FROM presence WHERE name IN (${placeholders})`, ...candidates)
      .toArray()) {
      const key = mentionMatchKey(String(row.name));
      if (String(row.kind) === "agent") localAgents.add(key);
      else localNonAgents.add(key);
    }
    for (const row of this.ctx.storage.sql
      .exec(`SELECT DISTINCT sender_name AS name, sender_kind AS kind FROM messages WHERE sender_name IN (${placeholders})`, ...candidates)
      .toArray()) {
      const key = mentionMatchKey(String(row.name));
      if (String(row.kind) === "agent") localAgents.add(key);
      else localNonAgents.add(key);
    }
    for (const row of this.ctx.storage.sql
      .exec(`SELECT name FROM webhooks WHERE name IN (${placeholders})`, ...candidates)
      .toArray()) {
      localNonAgents.add(mentionMatchKey(String(row.name)));
    }

    const out: string[] = [];
    for (const candidate of candidates) {
      const key = mentionMatchKey(candidate);
      const token = authoritative.get(key);
      // D1 有记录时它是权威：human、readonly、已撤销 token 都不能被本地旧 presence 重新抬成 agent。
      if (token !== undefined) {
        if (token.role === "agent" && token.active) out.push(token.name);
      } else if (localAgents.has(key)) {
        out.push(candidate);
      } else if (!authoritativeLookupSucceeded && !localNonAgents.has(key)) {
        // resolveMentions already proved this canonical target existed before INSERT. If the second,
        // classification-only D1 read fails during that narrow window, dropping an offline agent here
        // would lose durable work forever. Fail open for identities with no local human/webhook fact;
        // a mistakenly queued human/squad can never claim a serve lease, while a missed agent cannot
        // be reconstructed after the request returns.
        out.push(candidate);
      }
    }
    return [...new Set(out)];
  }

  private directedDeliveryCause(msg: MsgFrame, targetName: string): DirectedDeliveryCause {
    if (msg.decision_response !== undefined) return "owner_answer";
    if (msg.reply_to !== null) {
      const original = this.ctx.storage.sql
        .exec("SELECT sender_name FROM messages WHERE seq = ?", msg.reply_to)
        .toArray()[0];
      if (original !== undefined && String(original.sender_name) === targetName) return "reply";
    }
    return "mention";
  }

  private ensureDirectedDeliveries(
    msg: MsgFrame,
    classifiedTargets: string[],
    targetOwners: Record<string, string> = {},
    causeOverride?: DirectedDeliveryCause,
  ) {
    // Status/presence frames are coordination metadata, not agent work. Self-mentions likewise must
    // never claim a queue slot the CLI intentionally refuses to run, or one poison row blocks every
    // later work item for that target until lease expiry.
    if (msg.kind !== "message") return;
    // Pause delays dispatch; it must not erase the durable wake debt. The queued row is created even
    // while the target is paused and resumePresence() restarts adapter selection later.
    const targets = [...new Set(classifiedTargets)].filter((targetName) => targetName !== msg.sender.name);
    if (targets.length === 0) return;
    const now = Date.now();
    for (const targetName of targets) {
      const existing = this.ctx.storage.sql
        .exec("SELECT * FROM directed_deliveries WHERE message_seq = ? AND target_name = ?", msg.seq, targetName)
        .toArray()[0];
      if (existing !== undefined) continue;
      const id = crypto.randomUUID();
      // An owner's decision is a new delivery attempt/message but the same logical work and model
      // continuation as the question that suspended it. Ordinary mentions start a fresh lineage.
      const workId = msg.decision_response?.work_id ?? crypto.randomUUID();
      const continuationRef = msg.decision_response?.continuation_ref ?? crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO directed_deliveries (
           id, message_seq, target_name, target_owner, cause, state, attempt,
           lease_connection_id, lease_until, work_id, continuation_ref,
           parent_delivery_id, reply_seq, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
        id,
        msg.seq,
        targetName,
        targetOwners[targetName] ?? null,
        causeOverride ?? this.directedDeliveryCause(msg, targetName),
        workId,
        continuationRef,
        msg.decision_response?.delivery_id ?? null,
        now,
        now,
      );
      const inserted = this.directedDeliveryRow(id);
      if (inserted !== undefined) {
        this.broadcastDirectedDelivery(inserted);
        this.ctx.waitUntil(this.ensureAlarmAt(now + DIRECTED_DELIVERY_MAX_AGE_MS));
      }
    }
    for (const targetName of targets) this.dispatchNextDirectedDelivery(targetName);
  }

  private dispatchNextDirectedDelivery(targetName: string, excludeConnectionId?: string) {
    if (this.atomicDeliveryEffects !== null) {
      this.atomicDeliveryEffects.dispatchTargets.add(targetName);
      return;
    }
    this.closeExpiredHelloConnections(Date.now(), targetName, excludeConnectionId);
    if (this.isPresencePaused(targetName)) return;
    const serveCandidates = this.serveLeaseCandidates(targetName, excludeConnectionId).filter(
      (candidate) => candidate.state?.serveLeaseHeld === true,
    );
    const legacyServeCandidates = this.claimedServeConnections(targetName, excludeConnectionId).filter(
      (candidate) => candidate.state?.directedDeliveryV1 !== true && candidate.state?.serveLeaseHeld === true,
    );
    const watchCandidates = this.watchLeaseCandidates(targetName, excludeConnectionId);
    const agentWebhooks = this.agentWebhookCandidates(targetName);

    for (;;) {
      const queued = this.ctx.storage.sql
        .exec(
          `SELECT * FROM directed_deliveries
            WHERE target_name = ? AND state = 'queued'
            ORDER BY message_seq, created_at LIMIT 1`,
          targetName,
        )
        .toArray()[0];
      if (queued === undefined) return;
      const principal = typeof queued.target_owner === "string" && queued.target_owner.length > 0
        ? queued.target_owner
        : null;
      if (principal === null) {
        const now = Date.now();
        this.transitionDirectedDeliveryTerminal(String(queued.id), "failed", now, {
          error: "delivery has no creation-time target principal; refusing unsafe name-based dispatch",
          expectedStates: ["queued"],
          dispatchNext: false,
        });
        continue;
      }
      // A just-welcomed exact-principal socket has not yet identified itself as v1, legacy CLI, or
      // Web. Hold the row queued until hello resolves that ambiguity; live actionable raw frames are
      // withheld from that socket in the same window.
      const helloPending = [...this.getConnections<ConnState>()].some((connection) => {
        if (connection.id === excludeConnectionId) return false;
        const state = connection.state;
        return state?.helloPending === true && state.helloExpired !== true &&
          state.kind === "agent" && state.name === targetName &&
          this.identityDeliveryPrincipal(state) === principal;
      });
      if (helloPending) return;
      const matchingServe = serveCandidates.filter((candidate) => {
        const st = candidate.state;
        return st != null && this.identityDeliveryPrincipal(st) === principal;
      });
      const matchingWatch = watchCandidates.filter((candidate) => {
            const st = candidate.state;
            return st != null && this.identityDeliveryPrincipal(st) === principal;
      });
      const samePrincipalLegacy = legacyServeCandidates.filter((candidate) => {
        const st = candidate.state;
        return st != null && this.identityDeliveryPrincipal(st) === principal;
      });
      // An edit-created delivery has no new raw `msg` broadcast for legacy consumers to execute.
      // Never hand it to a v0 adapter and then call the work running; keep it queued until a v1
      // serve/watch or a bound agent webhook can consume the explicit durable delivery frame.
      const matchingLegacy = String(queued.cause) === "mention_edit" ? [] : samePrincipalLegacy.filter((candidate) => {
        const st = candidate.state;
        return st != null &&
          typeof st.helloSince === "number" &&
          st.helloSince < Number(queued.message_seq);
      });
      const matchingWebhooks = agentWebhooks.filter((hook) => hook.targetOwner === principal);
      if (
        matchingServe.length === 0 &&
        matchingWatch.length === 0 &&
        matchingWebhooks.length === 0 &&
        matchingLegacy.length === 0
      ) {
        // Explicit legacy serve can only consume a raw frame newer than its hello cursor. Older
        // queued debt stays durable for v1; marking it running would create a silent lost handoff.
        if (samePrincipalLegacy.length > 0) return;
        // Legacy/imported rows without a bound principal must never be inferred from current
        // presence. If a same-name but different-principal runner is online, the old work can no
        // longer be delivered safely and must not head-of-line block that runner's new queue.
        if (
          serveCandidates.length === 0 &&
          legacyServeCandidates.length === 0 &&
          watchCandidates.length === 0 &&
          agentWebhooks.length === 0
        ) return;
        const now = Date.now();
        this.transitionDirectedDeliveryTerminal(String(queued.id), "failed", now, {
          error: "target principal changed before delivery; refusing same-name reassignment",
          expectedStates: ["queued"],
          dispatchNext: false,
        });
        continue;
      }
      const active = this.ctx.storage.sql
        .exec(
          `SELECT id FROM directed_deliveries
            WHERE target_name = ? AND target_owner = ? AND state IN ('claimed', 'running')
            ORDER BY message_seq LIMIT 1`,
          targetName,
          principal,
        )
        .toArray()[0];
      if (active !== undefined) return;
      const now = Date.now();
      if (
        matchingServe.length === 0 &&
        matchingWatch.length === 0 &&
        matchingWebhooks.length === 0 &&
        matchingLegacy.length > 0
      ) {
        // Rolling upgrade: an elected legacy serve receives the raw msg broadcast but cannot ACK a
        // v1 delivery frame. Treat that raw handoff as already running/unknown, never as a queued row
        // that a later v1 connection could replay. Reply/heartbeat still converge it normally.
        const holderId = matchingLegacy[0]!.id;
        const leaseUntil = now + DIRECTED_DELIVERY_LEASE_MS;
        this.ctx.storage.sql.exec(
          `UPDATE directed_deliveries
              SET state = 'running', attempt = attempt + 1,
                  lease_connection_id = ?, last_lease_connection_id = ?,
                  lease_adapter = 'legacy_serve', lease_until = ?, last_error = NULL,
                  terminal_reason = NULL, updated_at = ?
            WHERE id = ? AND target_owner = ? AND state = 'queued'`,
          holderId,
          holderId,
          leaseUntil,
          now,
          String(queued.id),
          principal,
        );
        const running = this.directedDeliveryRow(String(queued.id));
        if (running !== undefined && String(running.state) === "running") {
          this.broadcastDirectedDelivery(running);
          this.ctx.waitUntil(this.ensureAlarmAt(leaseUntil));
        }
        return;
      }
      const adapter = matchingServe.length > 0 ? "serve" : matchingWatch.length > 0 ? "watch" : "webhook";
      const connectionHolder = adapter === "serve" ? matchingServe[0] : adapter === "watch" ? matchingWatch[0] : undefined;
      const webhookHolder = adapter === "webhook" ? matchingWebhooks[0] : undefined;
      const holderId = connectionHolder?.id ?? this.webhookHolderId(webhookHolder!.registrationId);
      const leaseUntil = now + (adapter === "webhook" ? DIRECTED_WEBHOOK_LEASE_MS : DIRECTED_DELIVERY_LEASE_MS);
      this.ctx.storage.sql.exec(
        `UPDATE directed_deliveries
            SET state = 'claimed', attempt = attempt + 1,
                lease_connection_id = ?, last_lease_connection_id = ?,
                lease_adapter = ?, lease_until = ?, last_error = NULL,
                terminal_reason = NULL, updated_at = ?
          WHERE id = ? AND target_owner = ? AND state = 'queued'`,
        holderId,
        holderId,
        adapter,
        leaseUntil,
        now,
        String(queued.id),
        principal,
      );
      const claimed = this.directedDeliveryRow(String(queued.id));
      if (claimed === undefined || String(claimed.state) !== "claimed") return;
      const message = this.ctx.storage.sql
        .exec("SELECT * FROM messages WHERE seq = ?", Number(claimed.message_seq))
        .toArray()[0];
      if (message === undefined) {
        this.transitionDirectedDeliveryTerminal(String(claimed.id), "failed", now, {
          error: "source message is no longer retained",
          expectedStates: ["claimed"],
          expectedLeaseConnectionId: holderId,
          dispatchNext: false,
        });
        continue;
      }
      this.broadcastDirectedDelivery(claimed);
      const messageFrame = this.rowToFrame(message);
      if (connectionHolder !== undefined) {
        this.sendFrame(connectionHolder, {
          type: "delivery",
          delivery: this.rowToDirectedDelivery(claimed),
          message: messageFrame,
        });
      } else {
        this.ctx.waitUntil(this.dispatchDirectedWebhook(webhookHolder!, claimed, messageFrame));
      }
      this.ctx.waitUntil(this.ensureAlarmAt(leaseUntil));
      return;
    }
  }

  private requeueDirectedDeliveriesForConnection(connectionId: string, now: number): string[] {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT * FROM directed_deliveries
          WHERE lease_connection_id = ?
            AND ((state = 'claimed' AND (lease_adapter IS NULL OR lease_adapter IN ('serve', 'watch')))
              OR (state = 'running' AND lease_adapter = 'legacy_serve'))`,
        connectionId,
      )
      .toArray();
    const targets = new Set<string>();
    for (const row of rows) {
      const targetName = String(row.target_name);
      targets.add(targetName);
      if (
        String(row.state) === "running" &&
        String(row.lease_adapter) === "legacy_serve"
      ) {
        this.transitionDirectedDeliveryTerminal(String(row.id), "failed", now, {
          error: "legacy runner disconnected after raw handoff; outcome unknown, not auto-retried",
          terminalReason: "unknown_outcome",
          expectedStates: ["running"],
          expectedLeaseAdapter: "legacy_serve",
          expectedLeaseConnectionId: connectionId,
          dispatchNext: false,
        });
        continue;
      }
      this.ctx.storage.sql.exec(
        `UPDATE directed_deliveries
            SET state = 'queued', lease_connection_id = NULL,
                lease_adapter = NULL, lease_until = NULL,
                last_error = NULL, terminal_reason = NULL, updated_at = ?
          WHERE id = ? AND lease_connection_id = ? AND state = 'claimed'`,
        now,
        String(row.id),
        connectionId,
      );
      const queued = this.directedDeliveryRow(String(row.id));
      if (queued !== undefined && String(queued.state) === "queued") this.broadcastDirectedDelivery(queued);
    }
    return [...targets];
  }

  private requeueExpiredDirectedDeliveries(now: number) {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT * FROM directed_deliveries
          WHERE state IN ('claimed', 'running') AND lease_until IS NOT NULL AND lease_until <= ?`,
        now,
      )
      .toArray();
    const expiredConnections = new Map<string, string>();
    const targets = new Set<string>();
    for (const row of rows) {
      const targetName = String(row.target_name);
      const state = String(row.state);
      const connectionId = row.lease_connection_id === null ? null : String(row.lease_connection_id);
      targets.add(targetName);
      if (connectionId !== null) expiredConnections.set(targetName, connectionId);
      if (state === "claimed") {
        // No task heartbeat was ever observed, so the model is proven not to have started under this
        // lease and automatic retry is safe.
        this.ctx.storage.sql.exec(
          `UPDATE directed_deliveries
              SET state = 'queued', lease_connection_id = NULL,
                  lease_adapter = NULL, lease_until = NULL,
                  last_error = NULL, terminal_reason = NULL, updated_at = ?
            WHERE id = ? AND state = 'claimed' AND lease_until <= ?`,
          now,
          String(row.id),
          now,
        );
      } else {
        // A running runner may survive a network partition. Starting the standby would duplicate
        // model/external side effects, so fail visibly with an unknown outcome instead of auto-replay.
        this.transitionDirectedDeliveryTerminal(String(row.id), "failed", now, {
          error: "runner ownership lost after task start; outcome unknown, not auto-retried",
          terminalReason: "unknown_outcome",
          expectedStates: ["running"],
          dispatchNext: false,
        });
      }
      const updated = this.directedDeliveryRow(String(row.id));
      if (updated !== undefined && (String(updated.state) === "queued" || String(updated.state) === "failed")) {
        this.broadcastDirectedDelivery(updated);
      }
    }
    for (const targetName of targets) {
      const expiredConnectionId = expiredConnections.get(targetName);
      if (expiredConnectionId !== undefined) {
        for (const connection of this.getConnections<ConnState>()) {
          if (connection.id === expiredConnectionId) {
            // 监听力判定（#603）：租约过期时连接还活着 = 「投喂了不吃」的实锤（断连的租约由
            // requeueDirectedDeliveriesForConnection 即时回收，不会走到这里）。计一次负面 streak，
            // presence 据此下发 suspect/deaf——过去这里只默默换人，谁在反复超时频道看不见。
            this.bumpListeningStreak(targetName, now);
            connection.close(1012, "delivery lease expired");
          }
        }
      }
      // 明确排除超时 runner，让同名 standby 立即接棒；没有 standby 时 work 留在 queued 等重连。
      this.reconcileServeLease(targetName, expiredConnectionId);
      this.dispatchNextDirectedDelivery(targetName, expiredConnectionId);
      this.broadcastPresenceFor(targetName);
    }
  }

  private applyDirectedDeliveryHeartbeat(
    identity: ConnState,
    connectionId: string,
    hb: ParsedTaskHeartbeat,
    now: number,
  ) {
    if (hb.current_task === null) return;
    const row = this.ctx.storage.sql
      .exec(
        `SELECT * FROM directed_deliveries
          WHERE target_name = ? AND target_owner = ? AND message_seq = ? AND lease_connection_id = ?
            AND state = 'running'
          LIMIT 1`,
        identity.name,
        this.identityDeliveryPrincipal(identity),
        hb.current_task,
        connectionId,
      )
      .toArray()[0];
    if (row === undefined) return;
    const leaseUntil = now + DIRECTED_DELIVERY_LEASE_MS;
    this.ctx.storage.sql.exec(
      `UPDATE directed_deliveries
          SET lease_until = ?, updated_at = ?
        WHERE id = ? AND lease_connection_id = ? AND state = 'running'`,
      leaseUntil,
      now,
      String(row.id),
      connectionId,
    );
    this.ctx.waitUntil(this.ensureAlarmAt(leaseUntil));
  }

  private directedTaskAcceptsHeartbeat(identity: ConnState, messageSeq: number): boolean {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT * FROM directed_deliveries WHERE target_name = ? AND message_seq = ? LIMIT 1",
        identity.name,
        messageSeq,
      )
      .toArray()[0];
    if (row === undefined) return true;
    return this.identityMatchesDeliveryTarget(identity, row) && String(row.state) === "running";
  }

  private applyDirectedDeliveryUpdate(
    identity: ConnState,
    connectionId: string,
    update: DeliveryUpdateFrame,
    now: number,
  ): boolean {
    const row = this.directedDeliveryRow(update.delivery_id);
    if (row === undefined || !this.identityMatchesDeliveryTarget(identity, row)) return false;
    if (update.work_id !== undefined && update.work_id !== String(row.work_id ?? "")) return false;
    if (update.continuation_ref !== undefined && update.continuation_ref !== String(row.continuation_ref ?? "")) return false;
    const oldState = String(row.state);
    const ownsCurrentLease = String(row.lease_connection_id ?? "") === connectionId;
    const ownsFormerLease = String(row.last_lease_connection_id ?? "") === connectionId;
    // handleSend can persist the question and detach the lease before the runner's success receipt
    // arrives. ACK that exact former holder as a no-op and return the authoritative waiting_owner
    // row; never let the generic replied receipt erase the human handoff.
    if (oldState === "waiting_owner") {
      return ownsFormerLease && (update.state === "waiting_owner" || update.state === "replied");
    }

    // Terminal receipts detach the current lease but retain its last holder for idempotent ACKs.
    // Only an explicitly typed unknown outcome (or a legacy untyped row) may converge on a late
    // success. Policy/retract failures are final and must never be revived by a stale receipt.
    if (oldState === "replied") return update.state === "replied" && (ownsCurrentLease || ownsFormerLease);
    if (oldState === "failed") {
      if (!(ownsCurrentLease || ownsFormerLease)) return false;
      if (update.state === "failed") return true;
      if (update.state !== "replied") return false;
      if (!this.isFailedDeliveryRevivable(row)) return false;
    } else if (!ownsCurrentLease) {
      return false;
    }

    // A serve adapter must still be the elected holder. Watch connections are assigned the delivery
    // directly and prove ownership with the exact connection-bound lease above.
    if (
      identity.serveCandidate &&
      this.serveLeaseCandidates(
        identity.name,
        undefined,
        this.identityDeliveryPrincipal(identity),
      )[0]?.id !== connectionId
    ) return false;

    if (
      oldState !== "claimed" &&
      oldState !== "running" &&
      !(oldState === "failed" && update.state === "replied")
    ) return false;
    if (update.state === "replied" && update.reply_seq === undefined) {
      if (oldState !== "claimed" && oldState !== "running") return false;
      const failed = this.transitionDirectedDeliveryTerminal(update.delivery_id, "failed", now, {
        error: "runner reported success without a linked channel reply",
        expectedStates: [oldState],
        expectedLeaseConnectionId: connectionId,
      });
      return failed !== undefined && String(failed.state) === "failed";
    }
    if (update.reply_seq !== undefined) {
      const reply = this.ctx.storage.sql
        .exec("SELECT sender_name, reply_to, status_summary_seq FROM messages WHERE seq = ?", update.reply_seq)
        .toArray()[0];
      if (reply === undefined || String(reply.sender_name) !== identity.name) return false;
      if (
        update.state === "replied" &&
        Number(reply.reply_to ?? -1) !== Number(row.message_seq) &&
        Number(reply.status_summary_seq ?? -1) !== Number(row.message_seq)
      ) return false;
    }

    if (update.state === "running") {
      const leaseUntil = now + DIRECTED_DELIVERY_LEASE_MS;
      this.ctx.storage.sql.exec(
        `UPDATE directed_deliveries
          SET state = 'running', lease_until = ?, last_error = NULL, terminal_reason = NULL, updated_at = ?
          WHERE id = ? AND target_name = ? AND target_owner = ? AND lease_connection_id = ?
            AND state IN ('claimed', 'running')`,
        leaseUntil,
        now,
        update.delivery_id,
        identity.name,
        this.identityDeliveryPrincipal(identity),
        connectionId,
      );
      const running = this.directedDeliveryRow(update.delivery_id);
      if (running === undefined || String(running.state) !== "running") return false;
      this.broadcastDirectedDelivery(running);
      this.ctx.waitUntil(this.ensureAlarmAt(leaseUntil));
      return true;
    }

    if (update.state === "replied" || update.state === "failed") {
      const terminal = this.transitionDirectedDeliveryTerminal(update.delivery_id, update.state, now, {
        replySeq: update.reply_seq ?? null,
        error: update.error ?? null,
        expectedStates: [oldState],
        ...(oldState === "failed" ? {} : { expectedLeaseConnectionId: connectionId }),
      });
      return terminal !== undefined && String(terminal.state) === update.state;
    }

    // waiting_owner is not a client-declared terminal receipt. Only handleSend may create it while
    // atomically storing a valid pending question. Accepting a bare update here would release the
    // next work item with no owner decision capable of resuming this one.
    return false;
  }

  /**
   * One terminal transition gate for durable work. Besides detaching the lease and broadcasting,
   * this is the mandatory lineage hook: every terminal owner_answer closes its exact parked
   * waiting_owner ancestor (and only that work/ref/principal chain).
   */
  private transitionDirectedDeliveryTerminal(
    deliveryId: string,
    terminalState: "replied" | "failed",
    now: number,
    options: {
      replySeq?: number | null;
      error?: string | null;
      terminalReason?: DeliveryTerminalReason;
      expectedStates: string[];
      expectedLeaseAdapter?: string;
      expectedLeaseConnectionId?: string;
      dispatchNext?: boolean;
    },
  ): Record<string, unknown> | undefined {
    const before = this.directedDeliveryRow(deliveryId);
    if (before === undefined) return undefined;
    const beforeState = String(before.state);
    if (beforeState === "failed" && terminalState === "replied" && !this.isFailedDeliveryRevivable(before)) {
      return undefined;
    }
    if (beforeState === terminalState) {
      if (String(before.cause) === "owner_answer") {
        this.settleWaitingOwnerAncestors(
          before,
          terminalState,
          options.replySeq ?? (before.reply_seq === null ? null : Number(before.reply_seq)),
          options.error ?? (before.last_error === null ? null : String(before.last_error)),
          now,
        );
      }
      return before;
    }
    if (!options.expectedStates.includes(beforeState)) return undefined;
    if (
      options.expectedLeaseAdapter !== undefined &&
      String(before.lease_adapter ?? "") !== options.expectedLeaseAdapter
    ) return undefined;
    if (
      options.expectedLeaseConnectionId !== undefined &&
      String(before.lease_connection_id ?? "") !== options.expectedLeaseConnectionId
    ) return undefined;

    const clauses = ["id = ?", "state = ?"];
    const whereArgs: (string | number | null)[] = [deliveryId, beforeState];
    if (options.expectedLeaseAdapter !== undefined) {
      clauses.push("lease_adapter = ?");
      whereArgs.push(options.expectedLeaseAdapter);
    }
    if (options.expectedLeaseConnectionId !== undefined) {
      clauses.push("lease_connection_id = ?");
      whereArgs.push(options.expectedLeaseConnectionId);
    }
    const replySeq = options.replySeq ?? null;
    const error = terminalState === "failed"
      ? (options.error ?? "delivery failed").slice(0, DECISION_REASON_LIMIT)
      : null;
    const terminalReason: DeliveryTerminalReason | null = terminalState === "failed"
      ? options.terminalReason ?? "delivery_failed"
      : null;
    this.ctx.storage.sql.exec(
      `UPDATE directed_deliveries
          SET state = ?,
              last_lease_connection_id = COALESCE(lease_connection_id, last_lease_connection_id),
              lease_connection_id = NULL, lease_adapter = NULL, lease_until = NULL,
              reply_seq = COALESCE(?, reply_seq), last_error = ?, terminal_reason = ?, updated_at = ?
        WHERE ${clauses.join(" AND ")}`,
      terminalState,
      replySeq,
      error,
      terminalReason,
      now,
      ...whereArgs,
    );
    const terminal = this.directedDeliveryRow(deliveryId);
    if (terminal === undefined || String(terminal.state) !== terminalState) return undefined;
    this.broadcastDirectedDelivery(terminal);
    this.ctx.waitUntil(this.ensureAlarmAt(now + DIRECTED_DELIVERY_TERMINAL_RETENTION_MS));
    if (String(terminal.cause) === "owner_answer") {
      this.settleWaitingOwnerAncestors(terminal, terminalState, replySeq, error, now);
    }
    if (beforeState === "waiting_owner") {
      this.broadcastPresenceFor(String(terminal.target_name));
    }
    if (options.dispatchNext !== false) this.dispatchNextDirectedDelivery(String(terminal.target_name));
    return terminal;
  }

  private completeDirectedDelivery(identity: Identity, messageSeq: number, replySeq: number, now: number) {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT * FROM directed_deliveries WHERE message_seq = ? AND target_name = ? LIMIT 1",
        messageSeq,
        identity.name,
      )
      .toArray()[0];
    if (row === undefined || !this.identityMatchesDeliveryTarget(identity, row)) return;
    const oldState = String(row.state);
    // A notify webhook may wake the bound target while the durable row is still queued. A real
    // reply from the exact creation-time principal is stronger evidence than adapter bookkeeping,
    // so it may complete queued work and prevents a later serve from executing it again.
    if (oldState !== "queued" && oldState !== "claimed" && oldState !== "running" && oldState !== "failed") return;
    if (oldState === "failed" && !this.isFailedDeliveryRevivable(row)) return;
    this.transitionDirectedDeliveryTerminal(String(row.id), "replied", now, {
      replySeq,
      expectedStates: [oldState],
    });
  }

  private settleWaitingOwnerAncestors(
    completedAnswer: Record<string, unknown>,
    terminalState: "replied" | "failed",
    replySeq: number | null,
    error: string | null,
    now: number,
  ) {
    let answer = completedAnswer;
    const visited = new Set<string>();
    const presenceTargets = new Set<string>();
    while (String(answer.cause) === "owner_answer") {
      const answerId = String(answer.id);
      if (visited.has(answerId)) break;
      visited.add(answerId);
      const message = this.ctx.storage.sql
        .exec("SELECT decision_response_json FROM messages WHERE seq = ?", Number(answer.message_seq))
        .toArray()[0];
      const response = parseStoredDecisionResponse(message?.decision_response_json);
      // New rows snapshot the server-validated parent id so retention/corruption of the answer
      // message cannot strand waiting_owner forever. Legacy rows fall back to the stored response.
      const parentDeliveryId =
        typeof answer.parent_delivery_id === "string" && answer.parent_delivery_id.length > 0
          ? answer.parent_delivery_id
          : response?.delivery_id;
      if (parentDeliveryId === undefined || parentDeliveryId === answerId) break;
      if (
        response !== undefined &&
        (response.origin_seq === undefined ||
          response.work_id === undefined ||
          response.continuation_ref === undefined ||
          response.delivery_id !== parentDeliveryId ||
          response.work_id !== String(answer.work_id ?? "") ||
          response.continuation_ref !== String(answer.continuation_ref ?? ""))
      ) break;
      const source = this.directedDeliveryRow(parentDeliveryId);
      if (
        source === undefined ||
        String(source.target_name) !== String(answer.target_name) ||
        String(source.target_owner ?? "") !== String(answer.target_owner ?? "") ||
        (response?.origin_seq !== undefined && Number(source.message_seq) !== response.origin_seq) ||
        String(source.continuation_ref ?? "") !== String(answer.continuation_ref ?? "") ||
        String(source.work_id ?? "") !== String(answer.work_id ?? "")
      ) {
        break;
      }
      const sourceState = String(source.state);
      if (terminalState === "replied") {
        if (sourceState !== "replied") {
          if (sourceState !== "waiting_owner") break;
          this.ctx.storage.sql.exec(
            `UPDATE directed_deliveries
                SET state = 'replied', lease_connection_id = NULL, lease_adapter = NULL, lease_until = NULL,
                    reply_seq = COALESCE(?, reply_seq), last_error = NULL,
                    terminal_reason = NULL, updated_at = ?
              WHERE id = ? AND state = 'waiting_owner'`,
            replySeq,
            now,
            parentDeliveryId,
          );
        }
      } else {
        if (sourceState === "replied") break;
        if (sourceState !== "failed") {
          if (sourceState !== "waiting_owner") break;
          const ancestorError = `owner answer failed: ${error ?? "runner reported failure"}`.slice(
            0,
            DECISION_REASON_LIMIT,
          );
          this.ctx.storage.sql.exec(
            `UPDATE directed_deliveries
                SET state = 'failed', lease_connection_id = NULL, lease_adapter = NULL, lease_until = NULL,
                    last_error = ?, terminal_reason = 'owner_answer_failed', updated_at = ?
              WHERE id = ? AND state = 'waiting_owner'`,
            ancestorError,
            now,
            parentDeliveryId,
          );
        }
      }
      const closed = this.directedDeliveryRow(parentDeliveryId);
      if (closed === undefined || String(closed.state) !== terminalState) break;
      this.broadcastDirectedDelivery(closed);
      presenceTargets.add(String(closed.target_name));
      answer = closed;
    }
    for (const targetName of presenceTargets) this.broadcastPresenceFor(targetName);
  }

  // ---- 同名 serve 跨机租约（issue #99）----
  // 同机单实例锁（CLI src/instance-lock.ts，#237）只挡本机；跨机器两台 serve 各连一条 WS，广播把每条 @
  // 发给同名所有连接 → 都跑完整 runner、双份副作用。这里在服务端做互斥：同名 serve 连接各自 claim，只有
  // claim 最早（序号最小）的那条持租、跑 runner；其余转 standby。持租者断连/心跳超时后自动让下一条顶上。

  // claim 时从单调计数器取一个序号：越早 claim 越小。序号首次 claim 后定死，故持租者掉线由"次早"顶替、
  // 重连的原持租者拿到更大序号不抢回（软租约）。计数器落 meta，DO hibernate 也不丢。
  private nextServeClaimSeq(): number {
    const next = (Number(this.getMeta("serve_claim_seq") ?? "0") || 0) + 1;
    this.setMeta("serve_claim_seq", String(next));
    return next;
  }

  private watchLeaseCandidates(name: string, excludeId?: string): Connection<ConnState>[] {
    const list: Connection<ConnState>[] = [];
    for (const connection of this.getConnections<ConnState>()) {
      if (connection.id === excludeId) continue;
      const state = connection.state;
      if (state?.watchCandidate && state.kind === "agent" && state.name === name) list.push(connection);
    }
    list.sort((a, b) => {
      const left = a.state?.watchClaimSeq ?? Number.MAX_SAFE_INTEGER;
      const right = b.state?.watchClaimSeq ?? Number.MAX_SAFE_INTEGER;
      return left !== right ? left - right : a.id.localeCompare(b.id);
    });
    return list;
  }

  private agentWebhookCandidates(name: string): WebhookRow[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT name, registration_id, url, secret, filter, mode, target_owner
           FROM webhooks
          WHERE name = ? AND mode = 'agent' AND filter IN ('mentions', 'all')`,
        name,
      )
      .toArray()
      .map((row) => ({
        name: String(row.name),
        registrationId: String(row.registration_id),
        url: String(row.url),
        secret: String(row.secret),
        filter: String(row.filter) as WebhookFilter,
        mode: "agent" as const,
        targetOwner: row.target_owner === null || row.target_owner === undefined
          ? null
          : String(row.target_owner),
      }));
  }

  // 同名的活 serve 候选连接，按 claim 序号升序（并列用 connection.id 兜底稳定）。excludeId 供 onClose 用：
  // 正在关闭的连接 getConnections 可能仍返回，但它已不该参与选举。
  private claimedServeConnections(
    name: string,
    excludeId?: string,
    principal?: string,
  ): Connection<ConnState>[] {
    const list: Connection<ConnState>[] = [];
    for (const c of this.getConnections<ConnState>()) {
      if (c.id === excludeId) continue;
      const st = c.state;
      if (
        st?.serveCandidate &&
        st.kind === "agent" &&
        st.name === name &&
        (principal === undefined || this.identityDeliveryPrincipal(st) === principal)
      ) list.push(c);
    }
    list.sort((a, b) => {
      const sa = a.state?.serveClaimSeq ?? Number.MAX_SAFE_INTEGER;
      const sb = b.state?.serveClaimSeq ?? Number.MAX_SAFE_INTEGER;
      return sa !== sb ? sa - sb : a.id.localeCompare(b.id);
    });
    return list;
  }

  /** Only an explicit v1 consumer may own a durable directed-delivery lease. */
  private serveLeaseCandidates(
    name: string,
    excludeId?: string,
    principal?: string,
  ): Connection<ConnState>[] {
    return this.claimedServeConnections(name, excludeId, principal).filter(
      (connection) => connection.state?.directedDeliveryV1 === true,
    );
  }

  private legacyServeConflictsWithV1(identity: ConnState, connectionId: string): boolean {
    const principal = this.identityDeliveryPrincipal(identity);
    const v1AlreadyHeld = this.serveLeaseCandidates(identity.name, connectionId, principal).some(
      (connection) => connection.state?.serveLeaseHeld === true,
    );
    if (v1AlreadyHeld) return true;
    const activeV1 = this.ctx.storage.sql
      .exec(
        `SELECT id FROM directed_deliveries
          WHERE target_name = ? AND target_owner = ? AND state IN ('claimed', 'running')
            AND (lease_adapter IS NULL OR lease_adapter <> 'legacy_serve')
          LIMIT 1`,
        identity.name,
        principal,
      )
      .toArray()[0];
    return activeV1 !== undefined;
  }

  // 同名 token 可以在撤销后被另一 owner 复用。租约按 creation-time principal 分组，避免新 owner
  // 被旧 owner 的残连压成 standby，也避免旧 work 被同名新连接领取。
  private reconcileServeLease(name: string, excludeId?: string) {
    const candidates = this.claimedServeConnections(name, excludeId);
    const holderIds = new Set<string>();
    const byPrincipal = new Map<string, Connection<ConnState>[]>();
    for (const candidate of candidates) {
      const st = candidate.state;
      if (!st) continue;
      const principal = this.identityDeliveryPrincipal(st);
      const group = byPrincipal.get(principal) ?? [];
      group.push(candidate);
      byPrincipal.set(principal, group);
    }
    for (const group of byPrincipal.values()) {
      // Never steal an already-announced lease during a rolling upgrade: a legacy holder may have
      // accepted a raw @ that a newly connected v1 standby must not replay. With no incumbent, v1 is
      // the safe failover choice; otherwise fall back to the oldest explicit legacy claim.
      const incumbent = group.find((candidate) => candidate.state?.serveLeaseHeld === true);
      const holder = incumbent ??
        group.find((candidate) => candidate.state?.directedDeliveryV1 === true) ??
        group[0];
      if (holder) holderIds.add(holder.id);
    }
    for (const c of candidates) {
      const st = c.state;
      if (!st) continue;
      const held = holderIds.has(c.id);
      if (st.serveLeaseHeld === held) continue;
      c.setState({ ...st, serveLeaseHeld: held });
      this.sendFrame(c, { type: "serve_lease", name, held });
    }
    if (holderIds.size > 0) this.dispatchNextDirectedDelivery(name, excludeId);
  }

  // 每个 name 的 serve 候选连接数（含持租者）。用于 presence 暴露 standby 数（候选数 - 1）。
  private serveCandidateCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const c of this.getConnections<ConnState>()) {
      const st = c.state;
      if (st?.serveCandidate && st.name) counts.set(st.name, (counts.get(st.name) ?? 0) + 1);
    }
    return counts;
  }

  private getMeta(key: string): string | null {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length > 0 ? String(rows[0]!.value) : null;
  }

  private removedPresenceKey(name: string): string {
    return `removed-presence:${name}`;
  }

  private charterRev(): number {
    const raw = Number(this.getMeta("charter_rev") ?? "");
    return Number.isInteger(raw) && raw > 0 ? raw : 0;
  }

  private setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private deleteMeta(key: string) {
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", key);
  }

  // issue #173：presence.kind 只有 status 帧写路径会盖，markOffline 新建的行、kind 列迁移前的旧行都是 NULL。
  // 而 messages.sender_kind 每条消息落库时都从权威 token（identity.kind）盖，永远有真值。presence.kind 缺失时
  // 回填该 name 最近一条消息的 sender_kind，让 `who`（读 presence）与 `history`（读 messages）对同一身份返回同一个
  // kind——否则 CLI who.ts kindOf() 会按名字猜（非 UUID → "agent"），把只发过普通消息的人类谎报成 agent。
  // presence.kind 非 NULL 时（即刚发过 status 帧、最新一手 token 快照）优先用它，不被历史消息覆盖。
  private static readonly PRESENCE_COLUMNS = `name, session_id,
                COALESCE(kind, (SELECT sender_kind FROM messages WHERE sender_name = presence.name ORDER BY seq DESC LIMIT 1)) AS kind,
                account, handle, display_name, avatar_url, avatar_thumb, client_version,
                state, note, updated_at, status_scope_json, status_summary_seq, status_blocked_reason,
                status_context_json, status_decision_json, status_workflow_json, role, role_source, residency, wake_kind, wake_verified_at,
                context_json, lineage_json, paused_at, paused_resume_at, busy, queue_depth,
                current_task, task_started_at, heartbeat_at, activity_json, runner_health_json, agent_session_json`;

  private presenceList(): PresenceEntry[] {
    const liveCounts = this.liveConnectionCounts();
    const serveCounts = this.serveCandidateCounts();
    const waitingOwnerCounts = this.waitingOwnerCounts();
    const liveSessions = this.livePresenceSessions();
    const rows = this.ctx.storage.sql
      .exec(`SELECT ${ChannelDO.PRESENCE_COLUMNS} FROM presence ORDER BY name`)
      .toArray();
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const name = String(row.name);
      const group = grouped.get(name) ?? [];
      group.push(row);
      grouped.set(name, group);
    }
    const listeningStreaks = this.listeningStreaks();
    return [...grouped.entries()].map(([name, group]) =>
      this.withLivePresence(
        this.presenceRowToEntry(this.aggregatePresenceRow(name, group, liveSessions)),
        liveCounts,
        serveCounts,
        waitingOwnerCounts,
        listeningStreaks,
      ),
    );
  }

  private presenceFor(name: string): PresenceEntry | null {
    const liveCounts = this.liveConnectionCounts();
    const serveCounts = this.serveCandidateCounts();
    const waitingOwnerCounts = this.waitingOwnerCounts();
    const liveSessions = this.livePresenceSessions();
    const rows = this.ctx.storage.sql
      .exec(`SELECT ${ChannelDO.PRESENCE_COLUMNS} FROM presence WHERE name = ?`, name)
      .toArray();
    return rows.length > 0
      ? this.withLivePresence(
          this.presenceRowToEntry(this.aggregatePresenceRow(name, rows, liveSessions)),
          liveCounts,
          serveCounts,
          waitingOwnerCounts,
          this.listeningStreaks(),
        )
      : null;
  }

  private broadcastPresenceFor(name: string) {
    if (this.atomicDeliveryEffects !== null) {
      this.atomicDeliveryEffects.presenceTargets.add(name);
      return;
    }
    const entry = this.presenceFor(name);
    if (entry) this.broadcastFrame({ type: "presence", ...entry });
  }

  private livePresenceSessions(): Map<string, Set<string>> {
    const sessions = new Map<string, Set<string>>();
    for (const connection of this.getConnections<ConnState>()) {
      const name = connection.state?.name;
      if (!name) continue;
      const ids = sessions.get(name) ?? new Set<string>();
      ids.add(connection.id);
      sessions.set(name, ids);
    }
    return sessions;
  }

  private aggregatePresenceRow(
    name: string,
    rows: Record<string, unknown>[],
    liveSessions: Map<string, Set<string>>,
  ): Record<string, unknown> {
    const live = liveSessions.get(name);
    const liveRows = live === undefined ? [] : rows.filter((row) => live.has(String(row.session_id)));
    const candidates = liveRows.length > 0 ? liveRows : rows;
    const rank = (row: Record<string, unknown>): number => {
      if (Number(row.busy) === 1) return 500;
      if (row.current_task !== null && row.current_task !== undefined) return 450;
      if (row.state === "working") return 400;
      if (row.state === "blocked") return 300;
      if (row.state === "waiting") return 200;
      if (row.state === "done") return 100;
      return 0;
    };
    return candidates.reduce((best, row) => {
      const score = rank(row);
      const bestScore = rank(best);
      if (score !== bestScore) return score > bestScore ? row : best;
      return Number(row.updated_at) > Number(best.updated_at) ? row : best;
    });
  }

  // issue #97：presence 序列化时用「当前有无活 WS 连接」在读侧修正可达性/离线，再叠加重复连接计数。
  // 有活连接 → applyLiveConnection 打 live=true、offline 提升为 waiting（不改写 ts/last_seen，故 host 租约
  // 判定完全不受影响，详见 shared 注释）；无活连接 → 原样返回。connection_count 语义照旧（仅 >1 时下发）。
  private withLivePresence(
    entry: PresenceEntry,
    liveCounts: Map<string, number>,
    serveCounts?: Map<string, number>,
    waitingOwnerCounts?: Map<string, number>,
    listeningStreaks?: Map<string, number>,
  ): PresenceEntry {
    const count = liveCounts.get(entry.name) ?? 0;
    const live = applyLiveConnection(entry, count > 0);
    const withCount = count > 1 ? { ...live, connection_count: count } : live;
    // 同名 serve standby 数（#99）：serve 候选连接数 - 1 持租者。>0 才下发（有几台在待命顶替），让 who/web
    // 一眼看出"重复 serve 但已被租约互斥、只有 1 台在跑"，而不是只能靠 connection_count x2 猜。
    const standbys = (serveCounts?.get(entry.name) ?? 0) - 1;
    const withStandbys = standbys > 0 ? { ...withCount, serve_standbys: standbys } : withCount;
    const waitingOwner = waitingOwnerCounts?.get(entry.name) ?? 0;
    const withWaiting = waitingOwner > 0 ? { ...withStandbys, waiting_owner_count: waitingOwner } : withStandbys;
    // 监听力判定（#603）：只对「当前有活连接」的身份下发——没有连接的身份是 offline/wakeable，
    // 不是 deaf。streak 1 次 = suspect，连续 ≥2 次 = deaf。缺省 = 无恙。
    const streak = count > 0 ? (listeningStreaks?.get(entry.name) ?? 0) : 0;
    const listening: ListeningVerdict | null = streak >= 2 ? "deaf" : streak === 1 ? "suspect" : null;
    return listening === null ? withWaiting : { ...withWaiting, listening };
  }

  // 监听力 streak（#603）：directed delivery 租约对活连接过期的连续次数，按身份聚合。
  private listeningStreaks(): Map<string, number> {
    const map = new Map<string, number>();
    for (const row of this.ctx.storage.sql.exec("SELECT name, streak FROM listening_health").toArray()) {
      map.set(String(row.name), Number(row.streak));
    }
    return map;
  }

  private bumpListeningStreak(name: string, now: number) {
    this.ctx.storage.sql.exec(
      // 判定只区分 1（suspect）与 ≥2（deaf），封顶 1000 防长期僵尸把计数器涨成天文数字。
      `INSERT INTO listening_health (name, streak, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(name) DO UPDATE SET streak = MIN(streak + 1, 1000), updated_at = excluded.updated_at`,
      name,
      now,
    );
  }

  /** 返回是否真的清掉了一条负面记录（调用方据此决定要不要广播 presence 变化）。 */
  private clearListeningStreak(name: string): boolean {
    const existed =
      this.ctx.storage.sql.exec("SELECT 1 FROM listening_health WHERE name = ? LIMIT 1", name).toArray().length > 0;
    if (existed) this.ctx.storage.sql.exec("DELETE FROM listening_health WHERE name = ?", name);
    return existed;
  }

  private waitingOwnerCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of this.ctx.storage.sql
      .exec(
        `SELECT target_name, COUNT(*) AS n FROM directed_deliveries
          WHERE state = 'waiting_owner' GROUP BY target_name`,
      )
      .toArray()) {
      counts.set(String(row.target_name), Number(row.n));
    }
    return counts;
  }

  private presenceRowToEntry(r: Record<string, unknown>): PresenceEntry {
    const ts = Number(r.updated_at);
    const wake =
      r.wake_kind === null || r.wake_kind === undefined
        ? undefined
        : r.wake_verified_at === null || r.wake_verified_at === undefined
          ? { kind: String(r.wake_kind) as WakeKind }
          : { kind: String(r.wake_kind) as WakeKind, verified_at: Number(r.wake_verified_at) };
    const state = String(r.state) as PresenceEntry["state"];
    const status =
      state === "offline"
        ? undefined
        : statusEventFromRow(r, String(r.name), state as StatusState, ts);
    return {
      name: String(r.name),
      ...(typeof r.client_version === "string" && r.client_version !== ""
        ? { client_version: r.client_version }
        : {}),
      ...(r.kind === "agent" || r.kind === "human" ? { kind: r.kind as SenderKind } : {}),
      ...(typeof r.account === "string" && r.account !== "" ? { account: r.account } : {}),
      ...(typeof r.handle === "string" && r.handle !== "" ? { handle: r.handle } : {}),
      ...(typeof r.display_name === "string" && r.display_name !== "" ? { display_name: r.display_name } : {}),
      ...(typeof r.avatar_url === "string" && r.avatar_url !== "" ? { avatar_url: r.avatar_url } : {}),
      ...(typeof r.avatar_thumb === "string" && r.avatar_thumb !== "" ? { avatar_thumb: r.avatar_thumb } : {}),
      state,
      note: r.note === null ? null : String(r.note),
      ts,
      last_seen: ts,
      ...(status === undefined ? {} : { status }),
      ...(r.role === null || r.role === undefined ? {} : { role: String(r.role) as CollaborationRole }),
      ...(r.role_source === null || r.role_source === undefined
        ? {}
        : { role_source: String(r.role_source) as CollaborationRoleSource }),
      ...(r.residency === null || r.residency === undefined ? {} : { residency: String(r.residency) as Residency }),
      ...(wake === undefined ? {} : { wake }),
      // 人为暂停接待（issue #180）：paused_at 非空即暂停；有定时恢复时刻则一并带出。
      ...(r.paused_at === null || r.paused_at === undefined
        ? {}
        : {
            paused: true as const,
            ...(r.paused_resume_at === null || r.paused_resume_at === undefined
              ? {}
              : { resume_at: Number(r.paused_resume_at) }),
          }),
      ...(() => {
        const context = parseStoredAgentContext(r.context_json);
        return context === undefined ? {} : { context };
      })(),
      ...(() => {
        const lineage = parseStoredLineage(r.lineage_json);
        return lineage === undefined ? {} : { lineage };
      })(),
      // busy/queue_depth（#103）：仅在真的 busy / 有积压时下发，且 offline 一律不带（离线谈不上「忙」）。
      // 缺省即「不忙、无积压」，旧客户端与旧行没这两列时 Number(undefined/null)=0/NaN，天然回退。
      ...(state !== "offline" && Number(r.busy) === 1 ? { busy: true } : {}),
      ...(state !== "offline" && Number(r.queue_depth) > 0 ? { queue_depth: Number(r.queue_depth) } : {}),
      // 每任务进度/心跳（#228）：仅在有活跃任务（current_task 非空）且 state != offline 时下发这一组。
      // 三者同生共死：只要 current_task 在，就一并带出 started/heartbeat，供消费方算新鲜度。
      ...(state !== "offline" && r.current_task !== null && r.current_task !== undefined
        ? {
            current_task: Number(r.current_task),
            ...(r.task_started_at === null || r.task_started_at === undefined ? {} : { task_started_at: Number(r.task_started_at) }),
            ...(r.heartbeat_at === null || r.heartbeat_at === undefined ? {} : { heartbeat_at: Number(r.heartbeat_at) }),
          }
        : {}),
      // 模型 session 活动（#602/#615）：不再绑死 current_task——交互 lane（不跑 serve）经 REST 直报
      // 的活动没有任务上下文。改按 TTL 判新鲜：serve lane 任务结束仍主动清（activity_json=NULL），
      // 交互 lane 靠 TTL 自然过期，不留僵活动。offline 一律不带。
      ...(() => {
        if (state === "offline" || typeof r.activity_json !== "string" || r.activity_json === "") return {};
        try {
          const activity = parseAgentActivity(JSON.parse(r.activity_json) as unknown);
          if (activity === undefined || Date.now() - activity.ts > AGENT_ACTIVITY_TTL_MS) return {};
          return { activity };
        } catch {
          return {};
        }
      })(),
      // runner 健康（#603）：独立于 current_task——空闲期也要能看见「干不动」；offline 不带。
      ...(() => {
        if (state === "offline" || typeof r.runner_health_json !== "string" || r.runner_health_json === "") return {};
        try {
          const health = parseRunnerHealth(JSON.parse(r.runner_health_json) as unknown);
          return health === undefined ? {} : { runner_health: health };
        } catch {
          return {};
        }
      })(),
      ...(() => {
        if (typeof r.agent_session_json !== "string" || r.agent_session_json === "") return {};
        try {
          const session = parseAgentSessionInfo(JSON.parse(r.agent_session_json) as unknown);
          return session === undefined ? {} : { agent_session: session };
        } catch {
          return {};
        }
      })(),
    };
  }

  private rowToFrame(r: Record<string, unknown>): MsgFrame {
    const kind = String(r.kind) as MsgFrame["kind"];
    const retracted = r.retracted_at !== null && r.retracted_at !== undefined;
    const state = retracted || r.state === null ? null : (String(r.state) as StatusState);
    const note = retracted || r.note === null ? null : String(r.note);
    const ts = Number(r.ts);
    const status: StatusEvent | null =
      !retracted && kind === "status" && state !== null
        ? statusEventFromRow(r, String(r.sender_name), state, ts)
        : null;
    const frame: MsgFrame = {
      type: kind === "status" ? "status" : "msg",
      seq: Number(r.seq),
      sender: {
        name: String(r.sender_name),
        kind: String(r.sender_kind) as SenderKind,
        ...(r.sender_owner === null || r.sender_owner === undefined ? {} : { owner: String(r.sender_owner) }),
        ...(() => {
          const lineage = parseStoredLineage(r.sender_lineage_json);
          return lineage === undefined ? {} : { lineage };
        })(),
        ...(r.sender_handle === null || r.sender_handle === undefined ? {} : { handle: String(r.sender_handle) }),
        ...(r.sender_display_name === null || r.sender_display_name === undefined ? {} : { display_name: String(r.sender_display_name) }),
        ...(r.sender_avatar_url === null || r.sender_avatar_url === undefined ? {} : { avatar_url: String(r.sender_avatar_url) }),
        ...(r.sender_avatar_thumb === null || r.sender_avatar_thumb === undefined ? {} : { avatar_thumb: String(r.sender_avatar_thumb) }),
        // #434：历史回放/修订帧也带上发送时快照的 CLI 版本，网页展示与 live 帧一致。
        ...(r.sender_client_version === null || r.sender_client_version === undefined ? {} : { client_version: String(r.sender_client_version) }),
      },
      kind,
      body: retracted ? "[retracted]" : String(r.body),
      mentions: parseStoredMentions(r.mentions_json),
      reply_to: r.reply_to === null ? null : Number(r.reply_to),
      state,
      note,
      status,
      ...(r.sender_role === null || r.sender_role === undefined
        ? {}
        : { role: String(r.sender_role) as CollaborationRole }),
      ...(r.sender_role_source === null || r.sender_role_source === undefined
        ? {}
        : { role_source: String(r.sender_role_source) as CollaborationRoleSource }),
      ts,
    };
    if (!retracted) {
      const completionArtifact = parseStoredCompletionArtifact(r.completion_artifact_json);
      if (completionArtifact !== undefined) frame.completion_artifact = completionArtifact;
      const completionReview = parseStoredCompletionReview(r);
      if (completionReview !== undefined) frame.completion_review = completionReview;
      const decisionRequest = parseStoredDecisionRequest(r.decision_request_json);
      if (decisionRequest !== undefined) frame.decision_request = decisionRequest;
      const decisionResolution = parseStoredDecisionResolution(r);
      if (decisionResolution !== undefined) frame.decision_resolution = decisionResolution;
      const decisionResponse = parseStoredDecisionResponse(r.decision_response_json);
      if (decisionResponse !== undefined) frame.decision_response = decisionResponse;
      const workflowRef = parseStoredStatusWorkflow(r.message_workflow_json);
      if (workflowRef !== undefined) frame.workflow_ref = workflowRef;
      // #624 出站防御：即便库里存了历史/恶意的绝对 url，回传前也一律锚定成同源相对路径。
      const attachments = anchorAttachmentUrls(parseStoredAttachments(r.attachments_json), this.name);
      if (attachments !== undefined) frame.attachments = attachments;
    }
    if (r.edited_at !== null && r.edited_at !== undefined) {
      frame.edited = true;
      frame.edited_at = Number(r.edited_at);
      if (r.edited_by !== null && r.edited_by !== undefined) frame.edited_by = String(r.edited_by);
    }
    if (retracted) {
      frame.retracted = true;
      frame.retracted_at = Number(r.retracted_at);
      if (r.retracted_by !== null && r.retracted_by !== undefined) frame.retracted_by = String(r.retracted_by);
    }
    if (r.supersedes !== null && r.supersedes !== undefined) frame.supersedes = Number(r.supersedes);
    if (r.superseded_by !== null && r.superseded_by !== undefined) frame.superseded_by = Number(r.superseded_by);
    if (r.rev_seq !== null && r.rev_seq !== undefined) frame.rev_seq = Number(r.rev_seq);
    if (!retracted && r.original_body !== null && r.original_body !== undefined) {
      frame.revision = { original_body: String(r.original_body) };
    }
    return frame;
  }
}
