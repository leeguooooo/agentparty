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
  type AgentLineage,
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
  type DecisionMode,
  type DecisionRequest,
  type DecisionResolution,
  type DecisionResponse,
  type DecisionState,
  type HostDecision,
  type HostDecisionKind,
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
  lastSeen: number;
  // 同名 serve 跨机租约（#99）：本连接是否 claim 过 serve 租约（是一条 serve runner）。
  serveCandidate?: boolean;
  // claim 时分配的单调序号（meta 计数器）。同名多条候选里最小序号者持租——序号在首次 claim 定死、
  // 重连/重复 claim 不变，故持租者掉线后由"次早"顶上，重连的原持租者拿到更大序号、不抢回（软租约）。
  serveClaimSeq?: number;
  // 上次已通告给本连接的持租状态，用于去重：只在 held 变化时才补发 serve_lease 帧。
  serveLeaseHeld?: boolean;
}

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
}

interface WebhookDeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

type SendOutcome =
  // deduped：命中幂等去重（#98）——seq/frames 来自原来那条已落库消息，调用方须跳过广播/唤醒等副作用
  | { ok: true; seq: number; frames: ServerFrame[]; deduped?: boolean }
  | { ok: false; code: ErrorCode; message: string };
type SendErrorOutcome = Extract<SendOutcome, { ok: false }>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
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

// presence 扫描周期（spec §5：60s 无帧判 offline）
export const PRESENCE_SCAN_MS = PRESENCE_TIMEOUT_MS;

const STATUS_STATES: readonly string[] = ["working", "waiting", "blocked", "done"];
const COLLAB_ROLES: readonly string[] = ["host", "worker", "reviewer", "observer"];
const ROLE_SOURCES: readonly string[] = ["self", "assigned"];
const RESIDENCIES: readonly string[] = ["supervised", "webhook", "bare", "human_driven", "unknown"];
const WAKE_KINDS: readonly string[] = ["none", "watch", "serve", "webhook"];
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

// 正文里的 @name（@ 须在行首或空白后，避开 email 的 @）。serve/webhook 唤醒只看 mentions
// 数组——若发送方只在正文打 @ 没进数组（裸 party send "@name"），目标永不被唤醒。故服务端
// 从 body/note 兜底提取并 union 进 mentions，去重、剔除 system、总量截到 MAX_MENTIONS。
// 误报无害：wake ledger 只投给真实可唤醒目标，无对应者的 @ 不会触发任何投递。
// #165：放开首字为 unicode 字母/数字，能捕获 @中文昵称。@ 前仍须行首/空白（不吃 email 的 @），
// 长度仍上界 64（[\p{L}\p{N}._-]{0,63}）。捕获到的 @昵称 由 resolveNicknameMentions 解析成真实 name。
const BODY_MENTION_RE = /(?:^|\s)@([\p{L}\p{N}][\p{L}\p{N}._-]{0,63})/gu;
function mergeBodyMentions(explicit: string[], text: string): string[] {
  const seen = new Set(explicit);
  const out = [...explicit];
  for (const match of text.matchAll(BODY_MENTION_RE)) {
    const name = match[1]!;
    if (name === "system" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

function withExpandedMentions(frame: SendFrame, mentions: string[]): SendFrame {
  return frame.kind === "message"
    ? { ...frame, mentions }
    : { ...frame, mentions };
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

function parseStoredDecisionRequest(input: unknown): DecisionRequest | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    const parsed = parseDecisionRequest(JSON.parse(input) as unknown);
    return parsed === null ? undefined : parsed;
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
    return { request_seq: raw.request_seq, chosen_index: raw.chosen_index, chosen_option: raw.chosen_option };
  } catch {
    return undefined;
  }
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

// 反序列化落库的附件引用（#176）；复用 parseAttachments 做结构校验，脏数据静默丢弃。
function parseStoredAttachments(input: unknown): Attachment[] | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    const parsed = parseAttachments(JSON.parse(input) as unknown);
    return parsed === null ? undefined : parsed;
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

function senderFromIdentity(identity: Pick<Identity, "name" | "kind" | "owner" | "handle" | "displayName" | "avatarUrl" | "avatarThumb" | "lineage">): Sender {
  return {
    name: identity.name,
    kind: identity.kind,
    ...(identity.owner === undefined ? {} : { owner: identity.owner }),
    ...(identity.lineage === undefined ? {} : { lineage: identity.lineage }),
    ...(identity.handle === undefined ? {} : { handle: identity.handle }),
    ...(identity.displayName === undefined ? {} : { display_name: identity.displayName }),
    ...(identity.avatarUrl === undefined ? {} : { avatar_url: identity.avatarUrl }),
    ...(identity.avatarThumb === undefined ? {} : { avatar_thumb: identity.avatarThumb }),
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

// 附件引用（#176）：一条消息可带 N 个引用，只是元数据不是 blob。缺省/空数组 → undefined（不落列）。
// 校验失败（类型不对、超上限）返回 null，由 parseSendFrame 上抛整条拒收——附件是主动带上的，宁可明确报错。
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const ATTACHMENT_KEY_MAX = 1024;
const ATTACHMENT_FILENAME_MAX = 512;
const ATTACHMENT_CONTENT_TYPE_MAX = 256;
const ATTACHMENT_URL_MAX = 2048;
function parseAttachments(raw: unknown): Attachment[] | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_ATTACHMENTS_PER_MESSAGE) return null;
  const out: Attachment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const a = item as Record<string, unknown>;
    if (typeof a.key !== "string" || a.key.length === 0 || a.key.length > ATTACHMENT_KEY_MAX) return null;
    if (typeof a.filename !== "string" || a.filename.length === 0 || a.filename.length > ATTACHMENT_FILENAME_MAX) return null;
    if (typeof a.content_type !== "string" || a.content_type.length === 0 || a.content_type.length > ATTACHMENT_CONTENT_TYPE_MAX) return null;
    if (typeof a.size !== "number" || !Number.isInteger(a.size) || a.size < 0) return null;
    if (typeof a.url !== "string" || a.url.length === 0 || a.url.length > ATTACHMENT_URL_MAX) return null;
    out.push({ key: a.key, filename: a.filename, content_type: a.content_type, size: a.size, url: a.url });
  }
  return out;
}

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
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
    };
  }
  return null;
}

export interface ParsedTaskHeartbeat {
  current_task: number | null;
  task_started_at: number | null;
  heartbeat_at: number | null;
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
  return { current_task: current, task_started_at: started, heartbeat_at: heartbeat };
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
  url: string;
  secret: string;
  filter: WebhookFilter;
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
      name TEXT PRIMARY KEY,
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
      client_version TEXT
    )`);
    for (const ddl of [
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
    ]) {
      try {
        sql.exec(ddl);
      } catch {
        // 列已存在
      }
    }
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
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      filter TEXT NOT NULL DEFAULT 'mentions',
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS webhook_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_name TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL
    )`);
    // 死信表（#105）：重试耗尽 / 队列满而被永久放弃的投递落在这里，不再静默丢弃。
    // 保留原始 payload 以便 moderator 原样重投；有界裁剪（见 recordDeadLetter）防止写爆。
    sql.exec(`CREATE TABLE IF NOT EXISTS webhook_dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_name TEXT NOT NULL,
      mention_seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      last_status INTEGER,
      last_error TEXT,
      dead_lettered_at INTEGER NOT NULL
    )`);
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
              SET body = '[retracted]', mentions_json = '[]', original_body = NULL,
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
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      last_seen_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
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
      lastSeen: Date.now(),
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
      ...(this.charterRev() > 0 ? { charter_rev: this.charterRev() } : {}),
      presence: this.presenceList(),
      read_cursors: this.readCursors(),
    });
    this.broadcastFrame({ type: "participants", participants: this.participants() });
    // 只前移不后移：即便已有远期 alarm（temp 归档 +14 天 / webhook 重试）也保证 60s presence 扫描
    await this.ensureAlarmAt(Date.now() + PRESENCE_SCAN_MS);
  }

  async onMessage(connection: Connection<ConnState>, message: WSMessage) {
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
    st = connection.setState({ ...st, lastSeen: Date.now() });
    if (!st) return;

    if (frame.type === "ping") {
      // setWebSocketAutoResponse 只匹配字面 '{"type":"ping"}'，这里兜底其余序列化
      this.sendFrame(connection, { type: "pong" });
      return;
    }
    if (!(await this.isTokenActive(st.tokenHash))) {
      this.closeRevokedConnection(connection);
      return;
    }
    if (frame.type === "hello") {
      const clientVersion = parseClientVersion(frame.client_version);
      if (clientVersion !== null) this.recordClientVersion(st.name, clientVersion, Date.now());
      const since = typeof frame.since === "number" && frame.since > 0 ? Math.floor(frame.since) : 0;
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
        for (const row of rows) this.sendFrame(connection, this.rowToFrame(row));
        if (rows.length < HELLO_BACKFILL_PAGE_SIZE) break;
        // 游标推进到本页最后一行的 seq；seq 唯一且升序，下一页严格取更大的 seq，保证前进、不重不漏。
        pageCursor = Number(rows[rows.length - 1]!.seq);
      }
      return;
    }
    if (frame.type === "seen") {
      // 已读游标（Phase 2）：前移了才广播。人类与流式 agent 走同一条路径。
      const seq = typeof frame.seq === "number" ? frame.seq : NaN;
      if (Number.isFinite(seq)) {
        const cursor = this.recordSeen(st.name, st.kind, seq);
        if (cursor !== null) this.broadcastFrame({ type: "read_cursor", ...cursor });
      }
      return;
    }
    if (frame.type === "heartbeat") {
      // 每任务进度/心跳（#228）：presence-only，不落 history、不占发送速率、不炸连接。
      // 脏值（负数/非整数/字段不齐）静默丢弃——心跳是自动流量，宁可漏一拍也别断流。
      const hb = parseHeartbeatFrame(frame);
      if (hb !== null) this.applyTaskHeartbeat(st.name, hb);
      return;
    }
    if (frame.type === "serve_lease" && frame.op === "claim") {
      // 同名 serve 跨机租约（#99）：本连接声明它是一条 serve runner，想当唯一在跑的那个。
      // 首次 claim 定死一个单调序号（重复 claim 不改，避免重连者用更小序号抢回租约）；随后在同名候选里
      // 选最小序号者持租，回 serve_lease 告知各连接是否持租。断连/心跳超时由 onClose/scanPresence 触发改选。
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
          lineage: st.lineage,
          tokenHash: st.tokenHash,
          collabRole: st.collabRole,
          collabRoleSource: st.collabRoleSource,
        },
        send,
        { countRate: false },
      );
      if (!out.ok) {
        this.sendFrame(connection, { type: "error", code: out.code, message: out.message });
        return;
      }
      // sent 先于广播到达发送方，客户端先推进游标再看到自己的回声
      this.sendFrame(connection, { type: "sent", seq: out.seq });
      // 幂等去重命中（#98）：只回 sent（原 seq），不重复广播/唤醒。ws 发送目前不带 key，故常态为 false。
      if (out.deduped) return;
      // 广播必须紧跟 INSERT，中间不能有任何 await（#114）：
      // 并发发送时 A 落库 seq=N 后若在这里等 D1，B 落库 N+1 先广播，watcher ack 了 N+1，
      // 后到的 N 就被客户端当作「已消费」永久丢弃（client.ts: seq <= cursor 静默丢），
      // 而重连 hello since=cursor 也不会补拉——append-only + 游标契约被静默违背。
      for (const f of out.frames) this.broadcastFrame(f);
      await this.closeInactiveConnections();
      await this.afterSend(out.frames[0] as MsgFrame);
    }
  }

  onClose(connection: Connection<ConnState>) {
    const st = connection.state;
    if (!st || !st.name || st.archived) return;
    // 同名 serve 跨机租约（#99）：持租者/候选断连 → 重选，让下一条 standby 顶上（补发 held=true）。
    // 排除正在关闭的这条（getConnections 可能仍返回它）。非 serve 连接不触发。
    if (st.serveCandidate) this.reconcileServeLease(st.name, connection.id);
    for (const other of this.getConnections<ConnState>()) {
      if (other.id !== connection.id && other.state?.name === st.name) {
        this.broadcastFrame({ type: "participants", participants: this.participants() });
        return;
      }
    }
    const removedAt = Number(this.getMeta(this.removedPresenceKey(st.name)) ?? "");
    if (Number.isInteger(removedAt) && Date.now() - removedAt < PRESENCE_SCAN_MS) {
      this.ctx.storage.sql.exec("DELETE FROM presence WHERE name = ?", st.name);
      this.broadcastFrame({ type: "participants", participants: this.participants() });
      return;
    }
    this.markOffline(st.name, Date.now());
    this.broadcastFrame({ type: "participants", participants: this.participants() });
  }

  // alarm 三件套（spec §6/§13）：presence 扫描 → webhook 重试 → temp 归档检查，最后按最近到期时间续排
  async onAlarm() {
    const now = Date.now();
    const live = this.scanPresence(now);
    this.resumeDuePauses(now);
    await this.retryWebhooks(now);
    await this.checkTempArchive(now);
    this.pruneStorage(now);
    await this.scheduleNextAlarm(now, live);
  }

  // #128：DO 存储有界修剪。wake_delivery_ledger / message_audit / read_cursor 此前只增不减，
  // DO SQLite 无上限增长（10GB 上限前先拖慢 who/hello）。onAlarm 周期跑（60s presence 扫描顺带），
  // 全走已在 DO 单线程内的 sql.exec，热路径零成本；每张表各按「消费者仍需的窗口」定界，见各方法注释。
  private pruneStorage(now: number) {
    this.pruneWakeLedger(now);
    this.pruneMessageAudit();
    this.pruneReadCursors(now);
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

  // read_cursor：PK=name，每身份仅一行 = 其当前游标，无重复行可裁。只裁「updated_at 早于保留窗口
  // 且此刻无活连接」的陈旧游标——在线身份（含刚 caught-up、频道久无新帧而未再推进游标的）永不被裁其活游标。
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

  // spec §5：60s 无帧（ping 由 auto-response 记时间戳）判 offline，返回存活连接数
  private scanPresence(now: number): number {
    const stale: Connection<ConnState>[] = [];
    let live = 0;
    for (const connection of this.getConnections<ConnState>()) {
      const st = connection.state;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(connection)?.getTime() ?? 0;
      const last = Math.max(pinged, st?.lastSeen ?? 0);
      if (now - last >= PRESENCE_TIMEOUT_MS) stale.push(connection);
      else live++;
    }
    // 同名 serve 跨机租约（#99）：心跳超时的持租者，其连接在这里被关；关掉后要重选租约让 standby 顶上。
    const staleServeNames = new Set<string>();
    for (const connection of stale) {
      const name = connection.state?.name;
      if (connection.state?.serveCandidate && name) staleServeNames.add(name);
      connection.close(1001, "heartbeat timeout");
      if (!name) continue;
      // getConnections 只回 open 的连接，刚 close 的不算
      let gone = true;
      for (const other of this.getConnections<ConnState>()) {
        if (other.state?.name === name) {
          gone = false;
          break;
        }
      }
      if (gone) this.markOffline(name, now);
    }
    // 已 close 的陈旧连接不在 getConnections 里，直接重选：存活的候选里最早的顶上、补发 held=true。
    for (const name of staleServeNames) this.reconcileServeLease(name);
    if (stale.length > 0) {
      this.broadcastFrame({ type: "participants", participants: this.participants() });
    }
    return live;
  }

  // 队列里到期的重投一轮：成功删行，失败退避 1/4/16 分钟，超过 3 次丢弃并向频道记一条 status
  private async retryWebhooks(now: number) {
    if (this.isArchived()) return;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT q.id, q.webhook_name, q.payload, q.attempts, w.url, w.secret
         FROM webhook_queue q LEFT JOIN webhooks w ON w.name = q.webhook_name
         WHERE q.next_retry_at <= ?
         ORDER BY q.next_retry_at, q.id
         LIMIT ?`,
        now,
        WEBHOOK_RETRY_BATCH_SIZE,
      )
      .toArray();
    for (const row of rows) {
      const id = Number(row.id);
      // webhook 已被删除，队列残留直接清掉
      if (row.url === null) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        continue;
      }
      const webhookName = String(row.webhook_name);
      const payload = String(row.payload);
      const attempt = Number(row.attempts) + 1;
      const delivery = await this.deliverWebhook(String(row.url), String(row.secret), payload);
      this.recordWakeDelivery({
        mentionSeq: this.seqFromWebhookPayload(payload),
        targetName: webhookName,
        webhookName,
        attempt,
        delivery,
      });
      if (delivery.ok) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        continue;
      }
      if (attempt > WEBHOOK_MAX_RETRIES) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        // #105：不再静默永久丢弃——落死信表待 moderator 重投，
        // 并向频道插一条 system status（in-channel，不经 webhook 自身，见 dispatchWebhooks 对 system 帧的默认跳过）。
        this.recordDeadLetter(webhookName, payload, attempt, delivery, now);
        this.insertSystemStatus(`webhook ${webhookName} 连续投递失败已转入死信，可 redeliver 重投`, now, false, { state: "blocked" });
        continue;
      }
      this.ctx.storage.sql.exec(
        "UPDATE webhook_queue SET attempts = ?, next_retry_at = ? WHERE id = ?",
        attempt,
        now + this.retryDelay(attempt),
        id,
      );
    }
  }

  private retryDelay(attempts: number): number {
    return WEBHOOK_RETRY_DELAYS_MS[
      Math.min(Math.max(attempts, 1), WEBHOOK_RETRY_DELAYS_MS.length) - 1
    ] as number;
  }

  // #105：把一条被永久放弃的投递落死信表。保留 payload 供 redeliver 原样重投；
  // 有界裁剪——超过上限只留最新 MAX_WEBHOOK_DEAD_LETTERS 条，坏端点写不爆 DO 存储。
  private recordDeadLetter(
    webhookName: string,
    payload: string,
    attempts: number,
    delivery: WebhookDeliveryResult,
    now: number,
  ) {
    this.ctx.storage.sql.exec(
      `INSERT INTO webhook_dead_letters (
         webhook_name, mention_seq, payload, attempts, last_status, last_error, dead_lettered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      webhookName,
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
        `SELECT dl.id, dl.webhook_name, dl.payload, dl.attempts, w.url, w.secret
           FROM webhook_dead_letters dl LEFT JOIN webhooks w ON w.name = dl.webhook_name${where}
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
      // webhook 已被删除 → 无从投递，视为失败但留存，operator 需先重建同名 webhook 或清死信。
      if (row.url === null) {
        failed++;
        this.ctx.storage.sql.exec(
          "UPDATE webhook_dead_letters SET attempts = ?, last_status = NULL, last_error = ?, dead_lettered_at = ? WHERE id = ?",
          attempt,
          "webhook no longer registered",
          now,
          id,
        );
        continue;
      }
      const delivery = await this.deliverWebhook(String(row.url), String(row.secret), payload);
      this.recordWakeDelivery({
        mentionSeq: this.seqFromWebhookPayload(payload),
        targetName: webhookName,
        webhookName,
        attempt,
        delivery,
      });
      if (delivery.ok) {
        redelivered++;
        this.ctx.storage.sql.exec("DELETE FROM webhook_dead_letters WHERE id = ?", id);
        continue;
      }
      failed++;
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

  // 三个来源里最近的下一个到期时间：presence 扫描 / webhook 重试 / temp 归档
  private async scheduleNextAlarm(now: number, live: number) {
    const candidates: number[] = [];
    if (live > 0) candidates.push(now + PRESENCE_SCAN_MS);
    const next = this.ctx.storage.sql
      .exec("SELECT MIN(next_retry_at) AS t FROM webhook_queue")
      .one();
    if (next.t !== null) candidates.push(Number(next.t));
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
    if (candidates.length > 0) {
      await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now + 1000));
    }
  }

  private markOffline(name: string, ts: number) {
    this.ctx.storage.sql.exec(
      // 离线时清掉每任务心跳（#228）：否则一次硬崩后再上线（发个 status 但不带心跳），旧的 current_task
      // 会借尸还魂显示成「还在处理」。心跳字段与「活着」正交，离线即无任务，直接清空最干净。
      `INSERT INTO presence (name, state, note, updated_at) VALUES (?, 'offline', NULL, ?)
       ON CONFLICT(name) DO UPDATE SET state = 'offline', updated_at = excluded.updated_at,
         current_task = NULL, task_started_at = NULL, heartbeat_at = NULL`,
      name,
      ts,
    );
    const frame: PresenceFrame = { type: "presence", name, state: "offline", note: null, ts };
    const entry = this.presenceFor(name);
    this.broadcastFrame(entry ? { type: "presence", ...entry } : frame);
  }

  private recordClientVersion(name: string, clientVersion: string, ts: number) {
    this.ctx.storage.sql.exec(
      `INSERT INTO presence (name, state, note, updated_at, client_version) VALUES (?, 'waiting', NULL, ?, ?)
       ON CONFLICT(name) DO UPDATE SET client_version = excluded.client_version`,
      name,
      ts,
      clientVersion,
    );
    const entry = this.presenceFor(name);
    if (entry) this.broadcastFrame({ type: "presence", ...entry });
  }

  // 每任务进度/心跳（#228）：只更新 presence 上的 current_task/task_started_at/heartbeat_at 三列，
  // 不碰 state/note/busy、不落 history（presence-only，不刷屏）。仅当已有这行 presence 时才更新+广播；
  // 从没发过 presence（连 status 都没发）就无从附着，直接忽略。current_task=null 即清除（任务结束）。
  private applyTaskHeartbeat(name: string, hb: ParsedTaskHeartbeat) {
    const exists = this.ctx.storage.sql.exec("SELECT 1 FROM presence WHERE name = ? LIMIT 1", name).toArray().length > 0;
    if (!exists) return;
    this.ctx.storage.sql.exec(
      `UPDATE presence SET current_task = ?, task_started_at = ?, heartbeat_at = ? WHERE name = ?`,
      hb.current_task,
      hb.task_started_at,
      hb.heartbeat_at,
      name,
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
    this.ctx.storage.sql.exec(
      `INSERT INTO presence (name, state, note, updated_at, paused_at, paused_resume_at)
       VALUES (?, 'waiting', NULL, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET paused_at = excluded.paused_at, paused_resume_at = excluded.paused_resume_at`,
      name,
      now,
      now,
      resumeAt,
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
    return true;
  }

  // alarm 到点：清掉所有 paused_resume_at 已过期的暂停（定时自动恢复，issue #180）。
  private resumeDuePauses(now: number) {
    const due = this.ctx.storage.sql
      .exec("SELECT name FROM presence WHERE paused_resume_at IS NOT NULL AND paused_resume_at <= ?", now)
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
  private async afterSend(msg: MsgFrame) {
    // #107：serve/watch 目标的 @ 广播即落 ledger（同步 SQL，不烧订阅、不发网络）——补齐它们缺失的服务端唤醒审计。
    this.recordServeWatchWakes(msg);
    // 首投移出发送关键路径：坏/慢端点不再让每条消息阻塞 N×10s 才返回 seq（DoS 频道）
    this.ctx.waitUntil(this.dispatchWebhooks(msg));
    if (this.getMeta("ckind") === "temp" && !this.isArchived()) {
      await this.ensureAlarmAt(msg.ts + this.tempIdleMs());
    }
  }

  // spec §15：对每个 webhook 判 filter → 立即尝试投递，失败入队由 alarm 重试
  private async dispatchWebhooks(msg: MsgFrame) {
    // system 帧默认不触发 webhook，防止失败风暴自激；loop guard 例外，因为它需要唤醒人类。
    if (msg.sender.name === "system" && !this.isLoopGuardStatus(msg) && !this.isWorkflowGuardStatus(msg)) return;
    const hooks = this.ctx.storage.sql
      .exec("SELECT name, url, secret, filter FROM webhooks")
      .toArray()
      .map((r) => ({
        name: String(r.name),
        url: String(r.url),
        secret: String(r.secret),
        filter: String(r.filter) as WebhookFilter,
      })) as WebhookRow[];
    if (hooks.length === 0) return;
    const host = this.getMeta("host") ?? "agentparty";
    const now = Date.now();
    // payload 对本条消息的所有 hook 都相同，循环外算一次（hook 不变量）
    const payload = JSON.stringify({
      ...msg,
      channel: this.name,
      permalink: `https://${host}/c/${this.name}`,
    });
    // 暂停接待（issue #180）的抑制点：命中的 hook 里剔掉当前被人为暂停的目标——webhook 一律不投。
    // 这里在 afterSend 之后跑，消息早已落库+广播，历史/广播完全不受影响，只是不把「唤醒」推给暂停者。
    const targets = hooks.filter(
      (h) => this.shouldDeliverWebhook(h.filter, h.name, msg) && !this.isPresencePaused(h.name),
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
      firing.map(async (hook) => ({
        hook,
        delivery: await this.deliverWebhook(hook.url, hook.secret, payload),
      })),
    );
    let needAlarm = false;
    for (const { hook, delivery } of results) {
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
        this.recordDeadLetter(hook.name, payload, 1, delivery, now);
        await this.insertSystemStatus("webhook retry queue is full; delivery moved to dead-letters", now, false, { state: "blocked" });
        continue;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO webhook_queue (webhook_name, payload, attempts, next_retry_at) VALUES (?, ?, 1, ?)",
        hook.name,
        payload,
        now + this.retryDelay(1),
      );
      needAlarm = true;
    }
    if (needAlarm) await this.ensureAlarmAt(now + this.retryDelay(1));
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
  private async deliverWebhook(url: string, secret: string, payload: string): Promise<WebhookDeliveryResult> {
    try {
      const signature = await hmacSha256Hex(secret, payload);
      const res = await fetch(url, {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
          "x-agentparty-signature": `hmac-sha256=${signature}`,
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
    const row = this.ctx.storage.sql.exec("SELECT wake_kind FROM presence WHERE name = ?", name).toArray()[0];
    const raw = row?.wake_kind;
    return typeof raw === "string" ? (raw as WakeKind) : null;
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
    const seq = this.lastSeq() + 1;
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
    const seq = this.lastSeq() + 1;
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
    this.linkWakeResume(identity.name, frame, now);
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
    const seq = this.lastSeq() + 1;
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
    this.linkWakeResume(identity.name, frame, now);
    return frame;
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

  // worker 转发来的内部 rest
  async onRequest(request: Request): Promise<Response> {
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
      return Response.json({ messages: rows.map((r) => this.rowToFrame(r)) });
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
      let body: { body?: unknown; mentions?: unknown } | null = null;
      if (action !== "retract") {
        body = (await request.json().catch(() => null)) as { body?: unknown; mentions?: unknown } | null;
        if (body === null || typeof body.body !== "string" || body.body.trim() === "") {
          return Response.json({ error: { code: "bad_request", message: "body is required" } }, { status: 400 });
        }
        if (byteLength(body.body) > BODY_LIMIT) {
          return Response.json({ error: { code: "too_large", message: `body exceeds ${BODY_LIMIT} bytes` } }, { status: 413 });
        }
      }
      const now = Date.now();
      const originalBody = row.original_body === null || row.original_body === undefined ? String(row.body) : String(row.original_body);
      if (action === "edit") {
        this.ctx.storage.sql.exec(
          `INSERT INTO message_audit (target_seq, action, actor_name, actor_kind, old_body, new_body, created_at)
           VALUES (?, 'edit', ?, ?, ?, ?, ?)`,
          seq,
          identity.name,
          identity.kind,
          String(row.body),
          body!.body,
          now,
        );
        this.ctx.storage.sql.exec(
          `UPDATE messages
              SET body = ?, original_body = COALESCE(original_body, ?), edited_at = ?, edited_by = ?, rev_seq = ?
            WHERE seq = ?`,
          body!.body,
          originalBody,
          now,
          identity.name,
          this.nextRevSeq(),
          seq,
        );
        const updated = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
        const frame = this.rowToFrame(updated);
        this.broadcastFrame(this.messageUpdate("edit", identity, frame, now));
        return Response.json({ message: frame });
      }
      if (action === "retract") {
        this.ctx.storage.transactionSync(() => {
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
                SET body = '[retracted]', mentions_json = '[]', original_body = NULL,
                    state = NULL, note = NULL, status_scope_json = NULL, status_blocked_reason = NULL,
                    status_context_json = NULL, status_decision_json = NULL, status_workflow_json = NULL,
                    message_workflow_json = NULL, completion_artifact_json = NULL,
                    completion_review_state = NULL, completion_review_policy = NULL,
                    completion_reviewed_by = NULL, completion_reviewed_by_kind = NULL,
                    completion_reviewed_by_owner = NULL, completion_reviewed_at = NULL,
                    completion_review_reason = NULL,
                    retracted_at = ?, retracted_by = ?, rev_seq = ?
              WHERE seq = ?`,
            now,
            identity.name,
            this.nextRevSeq(),
            seq,
          );
        });
        const updated = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
        const frame = this.rowToFrame(updated);
        this.broadcastFrame(this.messageUpdate("retract", identity, frame, now));
        return Response.json({ message: frame });
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
      this.broadcastFrame(newFrame);
      await this.afterSend(newFrame);
      return Response.json({ message: newFrame, superseded: oldFrame });
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
      await this.afterSend(reply);
      return Response.json({ message, reply });
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
      if (currentState !== "pending") {
        return Response.json({ error: { code: "decision_already_final", message: "decision is not pending" } }, { status: 409 });
      }
      const senderName = String(row.sender_name);
      if (identity.name === senderName) {
        return Response.json({ error: { code: "forbidden", message: "the requesting agent cannot answer its own decision" } }, { status: 403 });
      }
      // 人在回路：只有人类或 moderator 能替频道拍板；普通 worker agent 不行。
      if (identity.kind !== "human" && !isModerator) {
        return Response.json({ error: { code: "forbidden", message: "only a human or moderator can respond to a decision" } }, { status: 403 });
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
      this.ctx.storage.sql.exec(
        `UPDATE messages SET decision_state = 'resolved', decision_resolution_json = ?, rev_seq = ? WHERE seq = ?`,
        JSON.stringify(resolution),
        this.nextRevSeq(),
        seq,
      );
      const updated = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
      const message = this.rowToFrame(updated);
      this.broadcastFrame(this.messageUpdate("decision", identity, message, now));
      const replyBody = `@${senderName} decision #${seq} → ${chosenOption}${reason === "" ? "" : `: ${reason}`}`;
      const reply = this.insertDecisionResponse(
        identity,
        replyBody,
        [senderName],
        seq,
        { request_seq: seq, chosen_index: chosenIndex, chosen_option: chosenOption },
        now,
      );
      this.broadcastFrame(reply);
      await this.afterSend(reply);
      return Response.json({ message, reply });
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
      const out = await this.handleSend(identity, send, { countRate: true });
      if (!out.ok) {
        return Response.json(
          { error: { code: out.code, message: out.message } },
          { status: ERROR_STATUS[out.code] },
        );
      }
      // 幂等去重命中（#98）：首发时已广播/唤醒过，重发只回原 seq，绝不重复副作用
      if (!out.deduped) {
        // 同 ws 路径（#114）：先广播，再做与本条消息无关的连接清理
        for (const f of out.frames) this.broadcastFrame(f);
        await this.closeInactiveConnections();
        await this.afterSend(out.frames[0] as MsgFrame);
      }
      const sent = out.frames[0] as MsgFrame;
      return Response.json({
        seq: out.seq,
        ...(sent.completion_review === undefined ? {} : { completion_review: sent.completion_review }),
        ...(sent.decision_request === undefined ? {} : { decision_request: sent.decision_request }),
        ...(sent.decision_resolution === undefined ? {} : { decision_resolution: sent.decision_resolution }),
      });
    }
    if (url.pathname === "/internal/webhooks" && request.method === "GET") {
      // 列表不回 secret 明文（spec §7）
      const webhooks = this.ctx.storage.sql
        .exec("SELECT name, url, filter, created_at FROM webhooks ORDER BY name")
        .toArray()
        .map((r) => ({
          name: String(r.name),
          url: String(r.url),
          filter: String(r.filter),
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
      } | null;
      if (
        typeof body?.name !== "string" ||
        typeof body.url !== "string" ||
        typeof body.secret !== "string" ||
        typeof body.filter !== "string"
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
      this.ctx.storage.sql.exec(
        `INSERT INTO webhooks (name, url, secret, filter, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET url = excluded.url, secret = excluded.secret, filter = excluded.filter`,
        body.name,
        body.url,
        body.secret,
        body.filter,
        Date.now(),
      );
      return Response.json({ name: body.name, url: body.url, filter: body.filter }, { status: 201 });
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
        .exec("SELECT name FROM webhooks WHERE name = ?", name)
        .toArray();
      if (existed.length === 0) {
        return Response.json({ error: { code: "not_found", message: "no such webhook" } }, { status: 404 });
      }
      this.ctx.storage.sql.exec("DELETE FROM webhooks WHERE name = ?", name);
      this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE webhook_name = ?", name);
      // #105：webhook 删除后其死信已无从重投，一并清掉避免留下不可投递的孤儿。
      this.ctx.storage.sql.exec("DELETE FROM webhook_dead_letters WHERE webhook_name = ?", name);
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
        this.broadcastFrame({ type: "presence", name, state: "offline", note: null, ts: now });
        this.insertSystemStatus(`removed ${name} from channel`, now, false, { state: "done" });
      }
      return Response.json({ ok: true, owners: [...owners] });
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

  private async expandSquadMentions(frame: SendFrame): Promise<SendFrame> {
    const mentions = frame.mentions ?? [];
    if (mentions.length === 0) return frame;
    const candidates = mentions.filter((name) => name !== "system" && MENTION_NAME_RE.test(name));
    if (candidates.length === 0) return frame;
    const placeholders = candidates.map(() => "?").join(", ");
    const rows = await this.env.DB.prepare(
      `SELECT name, leader_name, members_json
         FROM channel_squads
        WHERE channel_slug = ? AND name IN (${placeholders})`,
    )
      .bind(this.name, ...candidates)
      .all<{ name: string; leader_name: string | null; members_json: string | null }>()
      .catch(() => ({ results: [] }));
    if (rows.results.length === 0) return frame;
    const routed = new Set(mentions);
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
        routed.add(target);
        if (routed.size >= MAX_MENTIONS) break;
      }
      if (routed.size >= MAX_MENTIONS) break;
    }
    return withExpandedMentions(frame, [...routed]);
  }

  // #165：把正文/显式 mentions 里的 @昵称（含中文）解析成目标 agent 的真实 ASCII name，union 进 mentions。
  // 手法镜像 expandSquadMentions（读 D1、大小写不敏感匹配、再重写 mentions），且同样跑在 INSERT 之前——
  // 这样 serve/watch（msg.mentions.includes(name)）与 webhook（shouldDeliverWebhook 按 hookName=name）
  // 都能凭真实 name 命中被 @ 的 agent。昵称是全局唯一的，故一个 token 匹配即定位到唯一 agent。
  private async resolveNicknameMentions(frame: SendFrame): Promise<SendFrame> {
    const mentions = frame.mentions ?? [];
    if (mentions.length === 0) return frame;
    const candidates = mentions.filter((t) => t !== "system" && t.length <= 64);
    if (candidates.length === 0) return frame;
    const placeholders = candidates.map(() => "?").join(", ");
    const rows = await this.env.DB.prepare(
      `SELECT name, nickname FROM agent_nicknames WHERE nickname COLLATE NOCASE IN (${placeholders})`,
    )
      .bind(...candidates)
      .all<{ name: string; nickname: string }>()
      .catch(() => ({ results: [] as { name: string; nickname: string }[] }));
    if (rows.results.length === 0) return frame;
    const routed = new Set(mentions);
    for (const row of rows.results) {
      if (typeof row.name !== "string" || !MENTION_NAME_RE.test(row.name)) continue;
      routed.add(row.name);
      if (routed.size >= MAX_MENTIONS) break;
    }
    return withExpandedMentions(frame, [...routed]);
  }

  // 校验 → 分配 seq → 落库 → 修剪/presence，返回待广播帧
  private async handleSend(
    identity: Identity,
    frame: SendFrame,
    options: { countRate?: boolean } = {},
  ): Promise<SendOutcome> {
    if (this.isArchived()) {
      return { ok: false, code: "archived", message: "channel is archived" };
    }
    if (identity.role === "readonly") {
      return { ok: false, code: "unauthorized", message: "readonly token cannot send" };
    }
    if (!(await this.isTokenActive(identity.tokenHash))) {
      return { ok: false, code: "unauthorized", message: "invalid or revoked token" };
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
        return { ok: true, seq: Number(priorRow.seq), frames: [this.rowToFrame(priorRow)], deduped: true };
      }
    }
    const payload = frame.kind === "message" ? frame.body : frame.note;
    if (byteLength(payload) > BODY_LIMIT) {
      return { ok: false, code: "too_large", message: `body exceeds ${BODY_LIMIT} bytes` };
    }
    frame = await this.expandSquadMentions(frame);
    frame = await this.resolveNicknameMentions(frame);
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
    const loopGuard = identity.kind === "agent" ? this.loopGuardMessage(identity.name) : null;
    if (loopGuard !== null) {
      this.alertLoopGuard(loopGuard);
      return {
        ok: false,
        code: "loop_guard",
        message: loopGuard,
      };
    }
    const now = Date.now();
    if (options.countRate !== false) {
      const rate = this.consumeRate(identity.name, now);
      if (rate !== null) return rate;
    }

    const sql = this.ctx.storage.sql;
    const seq = this.lastSeq() + 1;
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
    const attachments = frame.kind === "message" ? frame.attachments : undefined;
    // decision_request（#284）：parseSendFrame 已把它规整成完整 DecisionRequest（kind/options 齐全）。
    const decisionRequest = frame.kind === "message" ? (frame.decision_request as DecisionRequest | undefined) : undefined;
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
            reply_to: frame.reply_to,
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
    sql.exec(
      `INSERT INTO messages (
         seq, sender_name, sender_kind, sender_owner, sender_handle, sender_display_name, sender_avatar_url, sender_avatar_thumb,
         sender_lineage_json, kind, body, mentions_json, reply_to,
         state, note, status_scope_json, status_summary_seq, status_blocked_reason, status_context_json,
         status_decision_json, status_workflow_json, message_workflow_json,
         sender_role, sender_role_source, completion_artifact_json, completion_review_state, completion_review_policy,
         completion_review_replaces_seq, decision_request_json, decision_state, decision_resolution_json,
         idempotency_key, attachments_json, ts
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      now,
    );
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
    this.linkWakeResume(identity.name, msg, now);
    const workflowGuardFrame = this.applyWorkflowGuardAfterSend(identity, msg, workflowGuard, now);
    if (identity.kind === "agent") {
      this.setMeta("agent_streak", String(this.agentStreak() + 1));
      this.setMeta(this.agentCountKey(identity.name), String(this.agentCount(identity.name) + 1));
    } else {
      this.clearLoopGuardState();
      this.clearWorkflowGuards();
    }
    if (seq % 100 === 0) {
      sql.exec(
        "DELETE FROM messages WHERE seq <= ? AND (completion_review_state IS NULL OR completion_review_state != 'pending_review') AND (decision_state IS NULL OR decision_state != 'pending')",
        seq - RETAIN_N,
      );
    }

    const frames: ServerFrame[] = replacedUpdate === undefined ? [msg] : [msg, replacedUpdate];
    if (workflowGuardFrame !== undefined) frames.push(workflowGuardFrame);
    if (frame.kind === "status") {
      const wakeProvided = frame.wake !== undefined ? 1 : 0;
      sql.exec(
        `INSERT INTO presence (
           name, kind, account, handle, display_name, avatar_url, avatar_thumb,
           state, note, updated_at, status_scope_json, status_summary_seq, status_blocked_reason,
           status_context_json, status_decision_json, status_workflow_json, role, role_source, residency, wake_kind, wake_verified_at, context_json,
           lineage_json, busy, queue_depth
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
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
           queue_depth = excluded.queue_depth`,
        identity.name,
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
        wakeProvided,
        wakeProvided,
      );
      const entry = this.presenceFor(identity.name);
      frames.push(entry ? { type: "presence", ...entry } : { type: "presence", name: identity.name, state: frame.state, note: frame.note, ts: now });
    }
    return { ok: true, seq, frames };
  }

  private linkWakeResume(targetName: string, msg: MsgFrame, now: number) {
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
      // 同理：status 帧 summary_seq 指向的那条消息若 @ 了自己，也是一次可验证的 resume。
      if (this.messageMentions(summarySeq).includes(targetName)) this.markWakeVerified(targetName, now);
    }
  }

  // #191：读一条历史消息的 @ 列表，用于判定「这次 resume 是不是回应对本人的 @」——
  // 别人的普通回帖不能伪造成「被唤醒」证据（校验必须来自真实的 @→resume 闭环）。
  private messageMentions(seq: number): string[] {
    const rows = this.ctx.storage.sql.exec("SELECT mentions_json FROM messages WHERE seq = ?", seq).toArray();
    const raw = rows[0]?.mentions_json;
    if (typeof raw !== "string") return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
    } catch {
      return [];
    }
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
    const rows = this.ctx.storage.sql
      .exec("SELECT status_workflow_json FROM presence WHERE name = ? AND state != 'offline'", name)
      .toArray();
    return rows.length > 0 ? parseStoredStatusWorkflow(rows[0]!.status_workflow_json) : undefined;
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
    for (const connection of this.getConnections<ConnState>()) {
      this.sendFrame(connection, frame);
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

  private lastSeq(): number {
    const row = this.ctx.storage.sql.exec("SELECT COALESCE(MAX(seq), 0) AS last FROM messages").one();
    return Number(row.last);
  }

  // 已读游标快照（welcome 首帧下发）。
  private readCursors(): ReadCursor[] {
    return this.ctx.storage.sql
      .exec("SELECT name, kind, last_seen_seq, updated_at FROM read_cursor ORDER BY name")
      .toArray()
      .map((r) => ({
        name: String(r.name),
        kind: r.kind === "agent" ? "agent" : "human",
        last_seen_seq: Number(r.last_seen_seq),
        updated_at: Number(r.updated_at),
      }));
  }

  // seen 帧：把某身份的已读游标前移到 seq（只前移；旧 seq 幂等忽略）。前移了返回新游标（供广播），
  // 没前移返回 null（不广播，避免噪声）。seq 被夹到 [0, lastSeq]，防止未来 seq 污染。
  private recordSeen(name: string, kind: SenderKind, seq: number): ReadCursor | null {
    const capped = Math.min(Math.max(Math.floor(seq), 0), this.lastSeq());
    if (capped <= 0) return null;
    const prev = this.ctx.storage.sql
      .exec("SELECT last_seen_seq FROM read_cursor WHERE name = ?", name)
      .toArray();
    if (prev.length > 0 && Number(prev[0]!.last_seen_seq) >= capped) return null;
    const updatedAt = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO read_cursor (name, kind, last_seen_seq, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, last_seen_seq = excluded.last_seen_seq, updated_at = excluded.updated_at`,
      name,
      kind,
      capped,
      updatedAt,
    );
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

  // 同名的活 serve 候选连接，按 claim 序号升序（并列用 connection.id 兜底稳定）。excludeId 供 onClose 用：
  // 正在关闭的连接 getConnections 可能仍返回，但它已不该参与选举。
  private serveLeaseCandidates(name: string, excludeId?: string): Connection<ConnState>[] {
    const list: Connection<ConnState>[] = [];
    for (const c of this.getConnections<ConnState>()) {
      if (c.id === excludeId) continue;
      const st = c.state;
      if (st?.serveCandidate && st.name === name) list.push(c);
    }
    list.sort((a, b) => {
      const sa = a.state?.serveClaimSeq ?? Number.MAX_SAFE_INTEGER;
      const sb = b.state?.serveClaimSeq ?? Number.MAX_SAFE_INTEGER;
      return sa !== sb ? sa - sb : a.id.localeCompare(b.id);
    });
    return list;
  }

  // 选出唯一持租者（序号最小），给每条候选连接补发它此刻是否持租——只在 held 相对上次变化时才发（去重）。
  private reconcileServeLease(name: string, excludeId?: string) {
    const candidates = this.serveLeaseCandidates(name, excludeId);
    const holderId = candidates[0]?.id;
    for (const c of candidates) {
      const st = c.state;
      if (!st) continue;
      const held = c.id === holderId;
      if (st.serveLeaseHeld === held) continue;
      c.setState({ ...st, serveLeaseHeld: held });
      this.sendFrame(c, { type: "serve_lease", name, held });
    }
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
  private static readonly PRESENCE_COLUMNS = `name,
                COALESCE(kind, (SELECT sender_kind FROM messages WHERE sender_name = presence.name ORDER BY seq DESC LIMIT 1)) AS kind,
                account, handle, display_name, avatar_url, avatar_thumb, client_version,
                state, note, updated_at, status_scope_json, status_summary_seq, status_blocked_reason,
                status_context_json, status_decision_json, status_workflow_json, role, role_source, residency, wake_kind, wake_verified_at,
                context_json, lineage_json, paused_at, paused_resume_at, busy, queue_depth,
                current_task, task_started_at, heartbeat_at`;

  private presenceList(): PresenceEntry[] {
    const liveCounts = this.liveConnectionCounts();
    const serveCounts = this.serveCandidateCounts();
    return this.ctx.storage.sql
      .exec(`SELECT ${ChannelDO.PRESENCE_COLUMNS} FROM presence ORDER BY name`)
      .toArray()
      .map((r) => this.withLivePresence(this.presenceRowToEntry(r), liveCounts, serveCounts));
  }

  private presenceFor(name: string): PresenceEntry | null {
    const liveCounts = this.liveConnectionCounts();
    const serveCounts = this.serveCandidateCounts();
    const rows = this.ctx.storage.sql
      .exec(`SELECT ${ChannelDO.PRESENCE_COLUMNS} FROM presence WHERE name = ?`, name)
      .toArray();
    return rows.length > 0 ? this.withLivePresence(this.presenceRowToEntry(rows[0]!), liveCounts, serveCounts) : null;
  }

  // issue #97：presence 序列化时用「当前有无活 WS 连接」在读侧修正可达性/离线，再叠加重复连接计数。
  // 有活连接 → applyLiveConnection 打 live=true、offline 提升为 waiting（不改写 ts/last_seen，故 host 租约
  // 判定完全不受影响，详见 shared 注释）；无活连接 → 原样返回。connection_count 语义照旧（仅 >1 时下发）。
  private withLivePresence(
    entry: PresenceEntry,
    liveCounts: Map<string, number>,
    serveCounts?: Map<string, number>,
  ): PresenceEntry {
    const count = liveCounts.get(entry.name) ?? 0;
    const live = applyLiveConnection(entry, count > 0);
    const withCount = count > 1 ? { ...live, connection_count: count } : live;
    // 同名 serve standby 数（#99）：serve 候选连接数 - 1 持租者。>0 才下发（有几台在待命顶替），让 who/web
    // 一眼看出"重复 serve 但已被租约互斥、只有 1 台在跑"，而不是只能靠 connection_count x2 猜。
    const standbys = (serveCounts?.get(entry.name) ?? 0) - 1;
    return standbys > 0 ? { ...withCount, serve_standbys: standbys } : withCount;
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
      },
      kind,
      body: retracted ? "[retracted]" : String(r.body),
      mentions: JSON.parse(String(r.mentions_json ?? "[]")) as string[],
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
      const attachments = parseStoredAttachments(r.attachments_json);
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
