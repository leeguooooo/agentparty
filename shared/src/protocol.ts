// agentparty wire protocol — worker 与 cli 的单一事实来源

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
export const PRESENCE_TIMEOUT_MS = 60_000;
// temp 频道最后一条消息后闲置多久自动归档（spec §6）
export const TEMP_IDLE_ARCHIVE_MS = 14 * 24 * 60 * 60 * 1000;
// outbound webhook（spec §15）：短超时 + 1/4/16 分钟退避重试
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RETRIES = 3;
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 240_000, 960_000] as const;
export const MAX_WEBHOOKS_PER_CHANNEL = 20;
// 保留名：不得铸成真实 token。"system" 是 webhook 失败通告的发信名，dispatchWebhooks 靠它跳过投递；
// 若被铸成真实 token，其消息（含被 @）会静默永不触发 webhook。
export const RESERVED_NAMES: readonly string[] = ["system"];
export const MAX_WEBHOOK_QUEUE_ROWS = 200;
export const WEBHOOK_RETRY_BATCH_SIZE = 25;

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

// ---- 基础类型 ----

export type SenderKind = "agent" | "human";
export type TokenRole = "agent" | "human" | "readonly";
export type ChannelKind = "standing" | "temp";
export type ChannelMode = "normal" | "party";
export type MessageKind = "message" | "status";
export type WebhookFilter = "mentions" | "status" | "needs-human" | "all";
export type CaptureKind = "decision" | "requirement" | "bug" | "action-item";

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
  result: "ok" | "failed";
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
  | "unauthorized"
  | "rate_limited"
  | "too_large"
  | "loop_guard"
  | "workflow_guard"
  | "archived"
  | "not_found";

export type RestErrorCode = ErrorCode | "conflict" | "unavailable" | "forbidden";

export interface Sender {
  name: string;
  kind: SenderKind;
  /** 所属人：机器 ap_ token 铸造时写入的标签，人类 OIDC token 为其 email。无则省略（旧客户端忽略） */
  owner?: string;
  lineage?: AgentLineage;
  /** 同一身份当前活跃连接数。仅 >1 时下发，用于提示 token/session 被重复使用。 */
  connection_count?: number;
}

export interface PresenceEntry {
  name: string;
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
  /** 同一身份当前活跃连接数。仅 >1 时下发，用于提示 token/session 被重复使用。 */
  connection_count?: number;
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
   * 修订游标：客户端已见过的最大 rev_seq。带上它，服务端补拉只重放 rev_seq 更大的
   * 修订快照（编辑/撤回/超越），而不是把全部历史修订对每次连接无条件重放（issue #33）。
   * 旧客户端不带 → 服务端保持旧行为（全量重放）。
   */
  since_rev?: number;
}

export interface SendMessageFrame {
  type: "send";
  kind: "message";
  body: string;
  mentions: string[];
  reply_to: number | null;
  completion_artifact?: CompletionArtifact;
  replaces?: number;
}

export interface SendStatusFrame {
  type: "send";
  kind: "status";
  state: StatusState;
  note: string;
  mentions?: string[];
  scope?: string[];
  summary_seq?: number | null;
  blocked_reason?: string | null;
  role?: CollaborationRole;
  residency?: Residency;
  wake?: WakeInfo;
  context?: AgentContext;
  decision?: SendHostDecision;
  workflow?: SendStatusWorkflow;
}

export type SendFrame = SendMessageFrame | SendStatusFrame;

export interface PingFrame {
  type: "ping";
}

export type ClientFrame = HelloFrame | SendFrame | PingFrame;

// ---- 服务端 → 客户端帧 ----

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
  owner: string;
  state: StatusState;
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

function claimKey(status: StatusEvent): string {
  return `${status.owner}\0${status.scope.join("\0")}`;
}

function claimFrom(seq: number, status: StatusEvent): ClaimSummary {
  return {
    seq,
    owner: status.owner,
    state: status.state,
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
            owner: left.owner,
            state: left.state,
            scope: left.scope,
          });
          claims.set(`${right.owner}\0${right.seq}`, {
            seq: right.seq,
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

export function buildHostBoard(
  channel: string,
  presence: PresenceEntry[],
  messages: MsgFrame[],
  now = Date.now(),
  options: HostBoardOptions = {},
): HostBoard {
  const status = summarizeStatus(messages);
  const hosts = summarizeHosts(presence, now);
  const conflicts = summarizeConflicts(status.openClaims);
  return {
    schema: "agentparty.v1",
    type: "host_board",
    channel,
    generated_at: now,
    last_seq: messages.at(-1)?.seq ?? 0,
    hosts,
    open_claims: status.openClaims,
    blockers: status.blockers,
    conflicts,
    decisions: status.decisions,
    recommended_actions: recommendHostActions(channel, hosts, status.blockers, conflicts, messages, options),
  };
}

export interface MessageUpdateFrame {
  type: "message_update";
  target_seq: number;
  action: "edit" | "retract" | "supersede" | "review";
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
}

export interface ErrorFrame {
  type: "error";
  code: ErrorCode;
  message: string;
}

export interface PongFrame {
  type: "pong";
}

export type ServerFrame =
  | WelcomeFrame
  | ParticipantsFrame
  | MsgFrame
  | MessageUpdateFrame
  | SentFrame
  | PresenceFrame
  | ErrorFrame
  | PongFrame;
