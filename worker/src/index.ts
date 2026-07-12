// worker 入口 — rest 路由 + ws 升级转发
import {
  CHANNEL_CREATE_WINDOW_MS,
  CHARTER_LIMIT,
  DEFAULT_MEMBERSHIP,
  FREE_ATTACHMENT_SIZE_LIMIT,
  FREE_CHANNEL_CAP,
  isMember,
  LOOP_GUARD_N,
  LOOP_GUARD_PARTY_N,
  MAX_CHANNELS_PER_ACCOUNT,
  MAX_CHANNEL_CREATES_PER_WINDOW,
  MEMBER_ATTACHMENT_SIZE_LIMIT,
  normalizeTier,
  RESERVED_NAMES,
  ROLE_RESPONSIBILITY_LIMIT,
} from "@agentparty/shared";
import type {
  AgentLineage,
  MembershipStatus,
  MembershipTier,
  Attachment,
  CaptureKind,
  ChannelRoleAssignment,
  ChannelSquad,
  CaptureRecord,
  CompletionGate,
  CompletionReviewPolicy,
  DecisionMode,
  ChannelKind,
  ChannelMode,
  CollaborationRole,
  MsgFrame,
  RestErrorCode,
  TaskAssigneeKind,
  TaskRecord,
  TaskSummary,
  StatusState,
  TaskState,
  TokenRole,
  WebhookFilter,
} from "@agentparty/shared";
import { MAX_ATTACHMENTS, parseAttachments, parseStoredAttachments } from "./attachments";
import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { canAccessChannel, isChannelModerator } from "./acl";
import {
  CLIENT_TOO_OLD_HEADER,
  CLIENT_VERSION_HEADER,
  MIN_CLIENT_VERSION_HEADER,
  clientTooOldNotice,
  evaluateClientVersion,
  isEnforced,
  resolveMinClientVersion,
} from "./client-version";
import {
  extractBearer,
  lookupToken,
  oidcConfigFromEnv,
  randomToken,
  sha256Hex,
  type TokenIdentity,
} from "./auth";
import { ChannelDO } from "./do";
import {
  decideDesktopPairing,
  exchangeDesktopPairing,
  inspectDesktopPairing,
  listDesktopSessions,
  refreshDesktopSession,
  revokeCurrentDesktopSession,
  revokeDesktopSessionByOwner,
  startDesktopPairing,
} from "./desktop-pairing";
import { handleConflict, validateHandleFormat } from "./handle";
import { nicknameConflict, validateNicknameFormat } from "./nickname";
import {
  bestEffortRecordManagementAudit,
  listManagementAudit,
  managementAuditActor,
  managementAuditAdminActor,
  parseManagementAuditPagination,
} from "./management-audit";
import {
  buildMentionCard,
  getLarkDirectoryUser,
  inferReceiveIdType,
  LarkDirectoryError,
  resolveLarkProvider,
  searchLarkDirectory,
  sendLarkCard,
  verifyWebhookSignature,
  type LarkReceiveIdType,
  type LarkWebhookPayload,
} from "./integrations/lark";
import { openapiDocument } from "./openapi";

declare const __AGENTPARTY_BUILD_VERSION__: string | undefined;
declare const __AGENTPARTY_BUILD_COMMIT__: string | undefined;
declare const __AGENTPARTY_DEPLOYED_AT__: string | undefined;

export { ChannelDO };

const DEPLOYMENT_METADATA = Object.freeze({
  version: typeof __AGENTPARTY_BUILD_VERSION__ === "string" ? __AGENTPARTY_BUILD_VERSION__ : "dev",
  commit: typeof __AGENTPARTY_BUILD_COMMIT__ === "string" ? __AGENTPARTY_BUILD_COMMIT__ : "unknown",
  deployed_at: typeof __AGENTPARTY_DEPLOYED_AT__ === "string" ? __AGENTPARTY_DEPLOYED_AT__ : null,
});

// OIDC_ISSUER + OIDC_CLIENT_ID 为可选 vars/secrets：都配齐才启用人类网页 OIDC 登录（spec §10）。
// AUTH_PROVIDERS 是新版可扩展 OAuth 配置，Lark/Feishu 走 worker 服务端换码，secret 不下发给浏览器。
type AppEnv = Env & {
  ASSETS: Fetcher;
  ADMIN_SECRET?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  AUTH_PROVIDERS?: string;
  LARK_CLIENT_SECRET?: string;
  FEISHU_CLIENT_SECRET?: string;
  DESKTOP_PAIRING_SECRET?: string;
  // CLI↔worker 版本协商（#137）：声明的最低客户端版本 + 是否硬拒。缺省时用内置默认、默认只建言。
  MIN_CLIENT_VERSION?: string;
  MIN_CLIENT_ENFORCE?: string;
  // 会员分层真门槛（#277）：free 层配额/附件上限，自部署可抬高。缺省取 shared 常量。
  FREE_CHANNEL_CAP?: string;
  FREE_ATTACHMENT_SIZE_LIMIT?: string;
  HOSTED_MEMBERSHIP_GATING?: string;
};

type AppContext = {
  Bindings: AppEnv;
  Variables: { identity: TokenIdentity };
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLES: readonly string[] = ["agent", "human", "readonly"] satisfies TokenRole[];
const KINDS: readonly string[] = ["standing", "temp"] satisfies ChannelKind[];
const MODES: readonly string[] = ["normal", "party"] satisfies ChannelMode[];
// #381 public_watch：第三档访问模式——任意人可观看（读），参与（发送）需成员/被邀请。
// 读门 acl.ts 把 public_watch 当 public 放行；写门由 worker 算 canParticipateInChannel、DO handleSend 强制。
const VISIBILITIES: readonly string[] = ["public", "private", "public_watch"];
const COMPLETION_GATES: readonly string[] = ["off", "reviewer"] satisfies CompletionGate[];
const COMPLETION_REVIEW_POLICIES: readonly string[] = ["sender", "owner"] satisfies CompletionReviewPolicy[];
const DECISION_MODES: readonly string[] = ["approval", "unattended"] satisfies DecisionMode[];
const COLLAB_ROLES: readonly string[] = ["host", "worker", "reviewer", "observer"] satisfies CollaborationRole[];
const TASK_STATES: readonly string[] = ["triage", "backlog", "assigned", "in_progress", "needs_review", "done", "blocked"] satisfies TaskState[];
const TASK_ASSIGNEE_KINDS: readonly string[] = ["agent", "human", "squad"] satisfies TaskAssigneeKind[];

// TASK_STATES.includes() 不做类型收窄，用守卫保住 TaskState
function isTaskState(input: unknown): input is TaskState {
  return typeof input === "string" && TASK_STATES.includes(input);
}

const HUMAN_METADATA_POLICIES = ["owner", "moderators", "members"] as const;
const AGENT_METADATA_POLICIES = ["off", "moderators", "members", "allowlist"] as const;

type HumanMetadataPolicy = (typeof HUMAN_METADATA_POLICIES)[number];
type AgentMetadataPolicy = (typeof AGENT_METADATA_POLICIES)[number];

interface ChannelPerms {
  charter_write: HumanMetadataPolicy;
  charter_write_agents: AgentMetadataPolicy;
  charter_write_agent_allowlist: string[];
  members_list: HumanMetadataPolicy | "off";
  members_list_agents: AgentMetadataPolicy;
  members_list_agent_allowlist: string[];
}

function isDurableObjectReset(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { durableObjectReset?: unknown; message?: unknown; stack?: unknown };
  if (record.durableObjectReset === true) return true;
  const text = `${typeof record.message === "string" ? record.message : ""}\n${typeof record.stack === "string" ? record.stack : ""}`;
  return text.includes("invalidating this Durable Object") && text.includes("Please retry");
}

function channelStub(env: AppEnv, slug: string): DurableObjectStub<ChannelDO> {
  return env.CHANNELS.get(env.CHANNELS.idFromName(slug));
}

async function fetchChannelDO(env: AppEnv, slug: string, request: Request | (() => Request), retries = 1): Promise<Response> {
  const stub = channelStub(env, slug);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const req = typeof request === "function" ? request() : request.clone();
    try {
      return await stub.fetch(req);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isDurableObjectReset(error)) throw error;
      await Promise.resolve();
    }
  }
  throw lastError;
}

function parseRoleResponsibility(body: Record<string, unknown> | null): { present: boolean; value: string | null } | null {
  if (body === null || !Object.prototype.hasOwnProperty.call(body, "responsibility")) {
    return { present: false, value: null };
  }
  const raw = body.responsibility;
  if (raw === null) return { present: true, value: null };
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (textEncoder.encode(value).byteLength > ROLE_RESPONSIBILITY_LIMIT) return null;
  return { present: true, value: value === "" ? null : value };
}

interface ChannelRoleRow {
  name: string;
  role: CollaborationRole;
  responsibility: string | null;
  assigned_by: string;
  assigned_at: number;
  token_role: TokenRole | null;
  account: string | null;
  reports_to: string | null;
}

function channelRoleAssignmentFromRow(row: ChannelRoleRow): ChannelRoleAssignment {
  const kind = row.token_role === "human" ? "human" : row.token_role === "agent" ? "agent" : undefined;
  return {
    name: row.name,
    role: row.role,
    responsibility: row.responsibility ?? null,
    assigned_by: row.assigned_by,
    assigned_at: row.assigned_at,
    ...(kind === undefined ? {} : { kind }),
    ...(row.account === null ? {} : { account: row.account }),
    ...(kind === "human" && row.account !== null ? { display: row.account } : { display: row.name }),
    ...(row.reports_to == null ? {} : { reports_to: row.reports_to }),
  };
}

async function loadChannelRoleAssignment(db: D1Database, slug: string, name: string): Promise<ChannelRoleAssignment | null> {
  const row = await db.prepare(
    `SELECT cr.agent_name AS name, cr.role, cr.responsibility, cr.assigned_by, cr.assigned_at,
            t.role AS token_role, t.owner AS account, cr.reports_to
       FROM channel_roles cr
       LEFT JOIN tokens t ON t.name = cr.agent_name AND t.revoked_at IS NULL
      WHERE cr.channel_slug = ? AND cr.agent_name = ?`,
  )
    .bind(slug, name)
    .first<ChannelRoleRow>();
  return row === null ? null : channelRoleAssignmentFromRow(row);
}
const WEBHOOK_FILTERS: readonly string[] = ["mentions", "status", "needs-human", "all"] satisfies WebhookFilter[];
const CAPTURE_KINDS: readonly string[] = ["decision", "requirement", "bug", "action-item"] satisfies CaptureKind[];
const WEBHOOK_URL_MAX = 2048;
// 附件文件名：单段、禁路径分隔符与控制符，用作 R2 key 末段和下载文件名
const ATTACHMENT_FILENAME_RE = /^[^/\\\x00-\x1f\x7f]{1,255}$/;

// #277 会员真门槛：free 账号（含未开通会员、legacy 无账号 token）用低配额，member 解锁到平台原上限。
// env 覆盖手法同 do.ts 的 maxConnectionsPerChannel()——非法/缺省值一律回落到 shared 常量。
function resolveFreeChannelCap(env: AppEnv): number {
  const raw = env.FREE_CHANNEL_CAP;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : FREE_CHANNEL_CAP;
}

function resolveFreeAttachmentLimit(env: AppEnv): number {
  const raw = env.FREE_ATTACHMENT_SIZE_LIMIT;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : FREE_ATTACHMENT_SIZE_LIMIT;
}

export function hostedMembershipGating(env: Pick<AppEnv, "HOSTED_MEMBERSHIP_GATING">): boolean {
  return env.HOSTED_MEMBERSHIP_GATING === "true" || env.HOSTED_MEMBERSHIP_GATING === "1";
}

// 会员申请指引：拒绝时附在错误信息里，告诉调用方「为什么」+「怎么解锁」。
const MEMBERSHIP_UPGRADE_HINT =
  "upgrade to member for a higher quota (use the membership link in the Web or desktop header)";
const WEBHOOK_SECRET_MAX = 4096;
const HEADER_VALUE_RE = /^[\x21-\x7e]+$/;
// do 无条件信任的内部头清单：ws 升级转发前必须逐个剥离客户端注入值，只认 worker 权威版本
const AP_FORWARD_HEADERS = [
  "x-ap-name",
  "x-ap-kind",
  "x-ap-role",
  "x-ap-owner",
  "x-ap-display-name",
  "x-ap-avatar-url",
  "x-ap-avatar-thumb",
  "x-ap-token-hash",
  "x-ap-parent-agent",
  "x-ap-root-agent",
  "x-ap-team-id",
  "x-ap-spawn-depth",
  "x-ap-child-expires-at",
  "x-ap-mode",
  "x-ap-channel-kind",
  "x-ap-completion-gate",
  "x-ap-completion-review-policy",
  "x-ap-decision-mode",
  "x-ap-loop-guard-enabled",
  "x-ap-loop-guard-limit",
  "x-ap-workflow-guard-enabled",
  "x-ap-workflow-guard-limit",
  "x-ap-charter-rev",
  "x-ap-host",
  "x-ap-archived",
  "x-ap-archive-at",
  "x-ap-collab-role",
  "x-ap-role-source",
  "x-ap-handle",
  // #381：频道可见性 + 「本连接能否参与写」都是 worker 权威值，客户端注入必须先剥离
  "x-ap-visibility",
  "x-ap-can-write",
] as const;
// 所属人标签：铸造时可选写入，须 header-safe（可打印 ASCII，含空格）以便经 x-ap-owner 转发给 do
const OWNER_MAX = 128;
const OWNER_RE = /^[\x20-\x7e]{1,128}$/;
// CLI 用来跑回环 PKCE 的 public client（account.leeguoo.com 已登记）。CLI 拉 /api/config 得知用哪个
const CLI_CLIENT_ID = "agentparty-cli";
const CAPTURE_NOTE_MAX = 4000;
const TASK_TITLE_MAX = 200;
const TASK_DESC_MAX = 8000;
const TASK_LABEL_MAX = 40;
const TASK_LABELS_MAX = 20;
// #204 scope / blocked_reason 校验上限
const TASK_SCOPE_ITEM_MAX = 256; // 每个 scope 条目的字节上限
const TASK_SCOPE_MAX = 32; // scope 条目数量上限
const TASK_BLOCKED_REASON_MAX = 2000; // blocked_reason 字节上限
const TASK_EXTERNAL_REF_MAX = 512; // #141 external_ref 字节上限
const SQUAD_MEMBERS_MAX = 50;
const SQUAD_TITLE_MAX = 120;
const SQUAD_DESCRIPTION_MAX = 4000;
const SPAWN_DEFAULT_TTL_SEC = 2 * 60 * 60;
const SPAWN_MAX_TTL_SEC = 24 * 60 * 60;
const PROFILE_TEXT_MAX = 4096;
const PROFILE_BRANCH_MAX = 128;
const JOIN_REQUEST_NOTE_MAX = 2000;
const JOIN_REQUEST_REASON_MAX = 2000;
const LARK_DIRECTORY_QUERY_MAX = 64;
const LARK_DIRECTORY_MAX_LIMIT = 50;
const LARK_DIRECTORY_SEARCHES_PER_MINUTE = 10;
const PROJECT_AGENT_RUNNERS = ["codex", "claude", "codex-sdk", "shell"] as const;
const PROJECT_AGENT_WORKTREE = ["branch", "shared", "none"] as const;
const PROJECT_AGENT_INVITABLE = ["owner", "org", "anyone"] as const;
const textEncoder = new TextEncoder();

type OAuthProviderKind = "lark" | "feishu";

interface OAuthProviderConfig {
  id: string;
  kind: OAuthProviderKind;
  label: string;
  clientId: string;
  clientSecretEnv: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
  tenantKey: string | null;
}

interface AccountProfileMetadata {
  account: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  avatarThumb: string | null;
  provider: string;
  providerUserId: string;
  tenantKey: string | null;
}

interface ChannelJoinRequestRow {
  id: string;
  slug: string;
  account: string;
  requester_display: string;
  requester_profile_json: string;
  state: "pending" | "approved" | "rejected";
  note: string | null;
  source_token_name: string;
  requested_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  review_reason: string | null;
}

interface LarkNotifySubscriptionRow {
  channel_slug: string;
  account: string;
  target_name: string;
  provider_id: string;
  provider_kind: string;
  receive_id: string;
  receive_id_type: LarkReceiveIdType;
  secret: string;
  created_at: number;
  updated_at: number;
}

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const PROVIDER_DEFAULTS: Record<
  OAuthProviderKind,
  Pick<OAuthProviderConfig, "authorizeUrl" | "tokenUrl" | "userInfoUrl" | "label" | "clientSecretEnv" | "scope">
> = {
  lark: {
    label: "Sign in with Lark",
    clientSecretEnv: "LARK_CLIENT_SECRET",
    authorizeUrl: "https://accounts.larksuite.com/open-apis/authen/v1/authorize",
    tokenUrl: "https://open.larksuite.com/open-apis/authen/v2/oauth/token",
    userInfoUrl: "https://open.larksuite.com/open-apis/authen/v1/user_info",
    scope: "",
  },
  feishu: {
    label: "Sign in with Feishu",
    clientSecretEnv: "FEISHU_CLIENT_SECRET",
    authorizeUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
    userInfoUrl: "https://open.feishu.cn/open-apis/authen/v1/user_info",
    scope: "",
  },
};

function errorBody(code: RestErrorCode, message: string) {
  return { error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAuthProviders(env: AppEnv): OAuthProviderConfig[] {
  const raw = env.AUTH_PROVIDERS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const providers: OAuthProviderConfig[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const kind = item.kind === "feishu" ? "feishu" : item.kind === "lark" ? "lark" : null;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const clientId = typeof item.client_id === "string" ? item.client_id.trim() : "";
    if (kind === null || !PROVIDER_ID_RE.test(id) || clientId === "") continue;
    const defaults = PROVIDER_DEFAULTS[kind];
    providers.push({
      id,
      kind,
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : defaults.label,
      clientId,
      clientSecretEnv:
        typeof item.client_secret_env === "string" && item.client_secret_env.trim()
          ? item.client_secret_env.trim()
          : defaults.clientSecretEnv,
      authorizeUrl:
        typeof item.authorize_url === "string" && item.authorize_url.trim()
          ? item.authorize_url.trim()
          : defaults.authorizeUrl,
      tokenUrl:
        typeof item.token_url === "string" && item.token_url.trim()
          ? item.token_url.trim()
          : defaults.tokenUrl,
      userInfoUrl:
        typeof item.user_info_url === "string" && item.user_info_url.trim()
          ? item.user_info_url.trim()
          : defaults.userInfoUrl,
      scope: typeof item.scope === "string" ? item.scope.trim() : defaults.scope,
      tenantKey: typeof item.tenant_key === "string" && item.tenant_key.trim() ? item.tenant_key.trim() : null,
    });
  }
  return providers;
}

function positiveInt(input: unknown): number | null {
  return typeof input === "number" && Number.isInteger(input) && input > 0 ? input : null;
}

function randomJoinCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function validAccountParam(input: string): boolean {
  return input.length > 0 && input.length <= 320 && !/[\x00-\x1f\x7f]/.test(input);
}

function accountOrg(input: string | null | undefined): string | null {
  if (!input) return null;
  const at = input.lastIndexOf("@");
  if (at <= 0 || at === input.length - 1) return null;
  return input.slice(at + 1).toLowerCase();
}

function canInviteProjectAgent(invitableBy: string, inviterAccount: string | null | undefined, ownerAccount: string): boolean {
  if (invitableBy === "anyone") return true;
  if (inviterAccount === ownerAccount) return true;
  if (invitableBy !== "org") return false;
  const inviterOrg = accountOrg(inviterAccount);
  return inviterOrg !== null && inviterOrg === accountOrg(ownerAccount);
}

function optionalProfileText(input: unknown, max = PROFILE_TEXT_MAX): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== "string") return null;
  const value = input.trim();
  return textEncoder.encode(value).byteLength <= max ? value : null;
}

function projectAgentProfileFromRow(row: {
  owner_account: string;
  handle: string;
  name: string;
  runner: string;
  repo_url: string | null;
  workdir: string | null;
  base_branch: string;
  worktree_strategy: string;
  rules: string | null;
  invitable_by: string;
  created_at: number;
  updated_at: number;
}) {
  return {
    owner_account: row.owner_account,
    handle: row.handle,
    name: row.name,
    runner: row.runner,
    repo_url: row.repo_url,
    workdir: row.workdir,
    base_branch: row.base_branch,
    worktree_strategy: row.worktree_strategy,
    rules: row.rules,
    invitable_by: row.invitable_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function mintOrRotateProfileRuntimeToken(
  db: D1Database,
  opts: { ownerAccount: string; handle: string },
): Promise<{ token: string } | { conflict: true }> {
  const existing = await db
    .prepare("SELECT id, role, owner, revoked_at FROM tokens WHERE name = ?")
    .bind(opts.handle)
    .first<{ id: number; role: string; owner: string | null; revoked_at: number | null }>();
  if (existing && existing.revoked_at === null && (existing.role !== "agent" || existing.owner !== opts.ownerAccount)) {
    return { conflict: true };
  }
  const handleOwner = await db.prepare("SELECT account FROM account_profiles WHERE handle = ? COLLATE NOCASE")
    .bind(opts.handle).first<{ account: string }>();
  if (handleOwner && handleOwner.account !== opts.ownerAccount) return { conflict: true };

  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  if (existing) {
    await db.prepare(
      `UPDATE tokens
          SET hash = ?, role = 'agent', owner = ?, channel_scope = NULL,
              parent_agent = NULL, root_agent = NULL, team_id = NULL, spawn_depth = NULL, child_expires_at = NULL,
              created_at = ?, revoked_at = NULL
        WHERE id = ?`,
    )
      .bind(hash, opts.ownerAccount, now, existing.id)
      .run();
  } else {
    await db.prepare(
      `INSERT INTO tokens (
         hash, name, role, owner, channel_scope,
         parent_agent, root_agent, team_id, spawn_depth, child_expires_at,
         created_at
       ) VALUES (?, ?, 'agent', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    )
      .bind(hash, opts.handle, opts.ownerAccount, now)
      .run();
  }
  return { token };
}

async function mintOrRotateProfileChannelToken(
  db: D1Database,
  opts: { ownerAccount: string; handle: string; channelScope: string; childName: string },
): Promise<{ token: string; lineage: AgentLineage } | { conflict: true }> {
  const existing = await db
    .prepare("SELECT id, role, owner, channel_scope, parent_agent, revoked_at FROM tokens WHERE name = ?")
    .bind(opts.childName)
    .first<{ id: number; role: string; owner: string | null; channel_scope: string | null; parent_agent: string | null; revoked_at: number | null }>();
  if (
    existing &&
    existing.revoked_at === null &&
    (existing.role !== "agent" ||
      existing.owner !== opts.ownerAccount ||
      existing.channel_scope !== opts.channelScope ||
      existing.parent_agent !== opts.handle)
  ) {
    return { conflict: true };
  }
  const handleOwner = await db.prepare("SELECT 1 FROM account_profiles WHERE handle = ? COLLATE NOCASE")
    .bind(opts.childName).first();
  if (handleOwner) return { conflict: true };

  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  const lineage: AgentLineage = {
    parent_agent: opts.handle,
    root_agent: opts.handle,
    team_id: opts.handle,
    depth: 1,
    expires_at: null,
  };
  if (existing) {
    await db.prepare(
      `UPDATE tokens
          SET hash = ?, role = 'agent', owner = ?, channel_scope = ?,
              parent_agent = ?, root_agent = ?, team_id = ?, spawn_depth = ?, child_expires_at = ?,
              created_at = ?, revoked_at = NULL
        WHERE id = ?`,
    )
      .bind(
        hash,
        opts.ownerAccount,
        opts.channelScope,
        lineage.parent_agent,
        lineage.root_agent,
        lineage.team_id,
        lineage.depth,
        lineage.expires_at,
        now,
        existing.id,
      )
      .run();
  } else {
    await db.prepare(
      `INSERT INTO tokens (
         hash, name, role, owner, channel_scope,
         parent_agent, root_agent, team_id, spawn_depth, child_expires_at,
         created_at
       ) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        hash,
        opts.childName,
        opts.ownerAccount,
        opts.channelScope,
        lineage.parent_agent,
        lineage.root_agent,
        lineage.team_id,
        lineage.depth,
        lineage.expires_at,
        now,
      )
      .run();
  }
  return { token, lineage };
}

function isOpaqueHumanSessionName(name: string): boolean {
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|login-verify-.+)$/i.test(name);
}

function captureRowToRecord(row: {
  channel_slug: string;
  seq: number;
  kind: string;
  note: string | null;
  created_by: string;
  created_by_kind: string;
  created_at: number;
  message_sender: string;
  message_sender_kind: string;
  message_kind: string;
  message_body: string;
  message_ts: number;
}): CaptureRecord {
  return {
    type: "capture",
    channel: row.channel_slug,
    seq: row.seq,
    capture_kind: row.kind as CaptureKind,
    note: row.note,
    created_by: row.created_by,
    created_by_kind: row.created_by_kind === "human" ? "human" : "agent",
    created_at: row.created_at,
    message: {
      seq: row.seq,
      sender: {
        name: row.message_sender,
        kind: row.message_sender_kind === "human" ? "human" : "agent",
      },
      kind: row.message_kind === "status" ? "status" : "message",
      body: row.message_body,
      ts: row.message_ts,
    },
  };
}

function safeJsonArray<T>(raw: string | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function taskRowToRecord(row: {
  id: number;
  channel_slug: string;
  title: string;
  description: string | null;
  state: string;
  assignee_name: string | null;
  assignee_kind: string | null;
  created_by: string;
  created_by_kind: string;
  created_by_owner: string | null;
  priority: number;
  labels_json: string;
  parent_id: number | null;
  anchor_seqs_json: string;
  scope_json: string;
  blocked_reason: string | null;
  external_ref: string | null;
  attachments_json: string | null;
  completion_artifact_json: string | null;
  workflow_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}): TaskRecord {
  const assignee =
    row.assignee_name === null || row.assignee_kind === null
      ? null
      : { name: row.assignee_name, kind: row.assignee_kind as TaskAssigneeKind };
  let completionArtifact: unknown | null = null;
  if (row.completion_artifact_json !== null) {
    try {
      completionArtifact = JSON.parse(row.completion_artifact_json);
    } catch {
      completionArtifact = null;
    }
  }
  return {
    type: "task",
    id: row.id,
    channel: row.channel_slug,
    title: row.title,
    desc: row.description,
    state: row.state as TaskState,
    assignee,
    created_by: row.created_by,
    created_by_kind: row.created_by_kind === "human" ? "human" : "agent",
    ...(row.created_by_owner === null ? {} : { created_by_owner: row.created_by_owner }),
    priority: row.priority,
    labels: safeJsonArray<string>(row.labels_json).filter((label): label is string => typeof label === "string"),
    parent_id: row.parent_id,
    anchor_seqs: safeJsonArray<number>(row.anchor_seqs_json).filter((seq): seq is number => Number.isInteger(seq) && seq > 0),
    scope: safeJsonArray<string>(row.scope_json).filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    blocked_reason: row.blocked_reason,
    external_ref: row.external_ref,
    ...(() => {
      const att = parseStoredAttachments(row.attachments_json);
      return att === undefined ? {} : { attachments: att };
    })(),
    completion_artifact: completionArtifact,
    workflow_id: row.workflow_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

function parseTaskLabels(input: unknown): string[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  const labels: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") return null;
    const label = item.trim();
    if (label === "") continue;
    if (label.length > TASK_LABEL_MAX || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label)) return null;
    if (!labels.includes(label)) labels.push(label);
    if (labels.length > TASK_LABELS_MAX) return null;
  }
  return labels;
}

function parseTaskAnchors(input: unknown): number[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  const anchors: number[] = [];
  for (const item of input) {
    const seq = positiveInt(item);
    if (seq === null) return null;
    if (!anchors.includes(seq)) anchors.push(seq);
  }
  return anchors;
}

// #204 scope：每项非空字符串（去空白后非空）、字节上限、整体去重、数量上限。undefined/null → []。非法 → null。
function parseTaskScope(input: unknown): string[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  const scope: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") return null;
    const entry = item.trim();
    if (entry === "") return null;
    if (textEncoder.encode(entry).byteLength > TASK_SCOPE_ITEM_MAX) return null;
    if (!scope.includes(entry)) scope.push(entry);
    if (scope.length > TASK_SCOPE_MAX) return null;
  }
  return scope;
}

// #204 blocked_reason：null 直通；字符串校验字节上限；非法类型/超长 → false（由调用方转 400）。
// 注意：undefined 需由调用方先行处理（POST=默认 null，PATCH=保留原值），本函数不接收 undefined。
function parseTaskBlockedReason(input: unknown): string | null | false {
  if (input === null) return null;
  if (typeof input !== "string") return false;
  if (textEncoder.encode(input).byteLength > TASK_BLOCKED_REASON_MAX) return false;
  return input;
}

// #141 external_ref：null 直通；字符串校验非空、字节上限、不含控制字符；非法类型/超长/空串 → false。
// 注意：undefined 需由调用方先行处理（POST=不提供即 null），本函数不接收 undefined。
function parseTaskExternalRef(input: unknown): string | null | false {
  if (input === null) return null;
  if (typeof input !== "string") return false;
  if (input.trim() === "") return false;
  if (textEncoder.encode(input).byteLength > TASK_EXTERNAL_REF_MAX) return false;
  if (/[\x00-\x1f\x7f]/.test(input)) return false;
  return input;
}

function parseTaskAssignee(input: unknown): { name: string; kind: TaskAssigneeKind } | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (!isRecord(input)) return undefined;
  const name = typeof input.name === "string" ? input.name.trim().replace(/^@/, "") : "";
  const kind = typeof input.kind === "string" ? input.kind : "agent";
  if (!NAME_RE.test(name) || !TASK_ASSIGNEE_KINDS.includes(kind)) return undefined;
  return { name, kind: kind as TaskAssigneeKind };
}

type TaskRow = Parameters<typeof taskRowToRecord>[0];

async function loadTaskRow(db: D1Database, slug: string, id: number): Promise<TaskRow | null> {
  return db.prepare("SELECT * FROM channel_tasks WHERE channel_slug = ? AND id = ?")
    .bind(slug, id)
    .first<TaskRow>();
}

async function loadTaskSummary(db: D1Database, slug: string, identityName: string): Promise<TaskSummary> {
  const { results } = await db.prepare(
    `SELECT state, COUNT(*) AS count
       FROM channel_tasks
      WHERE channel_slug = ?
      GROUP BY state`,
  )
    .bind(slug)
    .all<{ state: string; count: number }>();
  const counts: Record<TaskState, number> = {
    triage: 0,
    backlog: 0,
    assigned: 0,
    in_progress: 0,
    needs_review: 0,
    done: 0,
    blocked: 0,
  };
  for (const row of results) {
    if (TASK_STATES.includes(row.state)) counts[row.state as TaskState] = row.count;
  }
  const mineRow = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM channel_tasks
      WHERE channel_slug = ?
        AND assignee_name = ?
        AND state IN ('assigned', 'in_progress', 'needs_review', 'blocked')`,
  )
    .bind(slug, identityName)
    .first<{ count: number }>();
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    type: "task_summary",
    channel: slug,
    total,
    open: total - counts.done,
    ...counts,
    mine: mineRow?.count ?? 0,
  };
}

function parseSquadMembers(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const members: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") return null;
    const name = item.trim().replace(/^@/, "");
    if (!NAME_RE.test(name)) return null;
    if (!members.includes(name)) members.push(name);
    if (members.length > SQUAD_MEMBERS_MAX) return null;
  }
  return members;
}

function parseSquadLeader(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  if (typeof input !== "string") return undefined;
  const name = input.trim().replace(/^@/, "");
  return NAME_RE.test(name) ? name : undefined;
}

function squadRowToRecord(row: {
  channel_slug: string;
  name: string;
  title: string | null;
  description: string | null;
  leader_name: string | null;
  members_json: string | null;
  created_by: string;
  created_by_kind: string;
  created_at: number;
  updated_at: number;
}): ChannelSquad {
  return {
    type: "squad",
    channel: row.channel_slug,
    name: row.name,
    title: row.title,
    description: row.description,
    leader: row.leader_name,
    members: safeJsonArray<string>(row.members_json).filter((name): name is string => NAME_RE.test(name)),
    created_by: row.created_by,
    created_by_kind: row.created_by_kind === "human" ? "human" : "agent",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

type SquadRow = Parameters<typeof squadRowToRecord>[0];

async function loadSquadRow(db: D1Database, slug: string, name: string): Promise<SquadRow | null> {
  return db.prepare("SELECT * FROM channel_squads WHERE channel_slug = ? AND name = ?")
    .bind(slug, name)
    .first<SquadRow>();
}

function completionTaskIdFromPayload(input: unknown): number | null | undefined {
  if (!isRecord(input) || input.kind !== "message") return undefined;
  const artifact = input.completion_artifact;
  if (!isRecord(artifact) || artifact.kind !== "final_synthesis" || artifact.task_id === undefined) return undefined;
  return positiveInt(artifact.task_id);
}

function taskAnchorsWithCompletion(row: TaskRow, artifact: unknown, seq: number): number[] {
  const anchors = taskRowToRecord(row).anchor_seqs;
  if (isRecord(artifact)) {
    const kickoff = positiveInt(artifact.kickoff_seq);
    if (kickoff !== null && !anchors.includes(kickoff)) anchors.push(kickoff);
  }
  if (!anchors.includes(seq)) anchors.push(seq);
  return anchors;
}

async function syncTaskCompletion(
  env: AppEnv,
  slug: string,
  taskId: number,
  artifact: unknown,
  seq: number,
  state: Extract<TaskState, "needs_review" | "done" | "in_progress">,
): Promise<void> {
  const row = await loadTaskRow(env.DB, slug, taskId);
  if (!row) return;
  const now = Date.now();
  const anchors = taskAnchorsWithCompletion(row, artifact, seq);
  await env.DB.prepare(
    `UPDATE channel_tasks
        SET state = ?,
            completion_artifact_json = ?,
            anchor_seqs_json = ?,
            updated_at = ?,
            completed_at = ?
      WHERE channel_slug = ? AND id = ?`,
  )
    .bind(
      state,
      JSON.stringify(artifact),
      JSON.stringify(anchors),
      now,
      state === "done" ? row.completed_at ?? now : null,
      slug,
      taskId,
    )
    .run();
  const note =
    state === "needs_review" ? `task #${taskId} needs_review via completion #${seq}` :
    state === "done" ? `task #${taskId} done via completion #${seq}` :
    `task #${taskId} back to in_progress after rejected completion #${seq}`;
  await insertSystemStatus(env, slug, note, statusStateForTask(state)).catch(() => false);
}

// 铸/重铸 token 的落库逻辑（/api/tokens 与 /api/agents 共用）：
// 同名活 token 冲突返回 conflict；同名已吊销 token 复用行覆盖（owner/channel_scope 一并刷新），
// 否则插新行。返回一次性明文 token。
async function persistToken(
  db: D1Database,
  opts: {
    name: string;
    role: TokenRole;
    owner: string;
    channelScope: string | null;
    lineage?: AgentLineage;
  },
): Promise<{ token: string } | { conflict: true }> {
  const existing = await db
    .prepare("SELECT id, revoked_at FROM tokens WHERE name = ?")
    .bind(opts.name)
    .first<{ id: number; revoked_at: number | null }>();
  if (existing && existing.revoked_at === null) return { conflict: true };
  // 反向唯一性：token 名不得撞已存在的人类 handle 或 agent 昵称（三者共用 @ 命名空间，#165）
  const handleOwner = await db.prepare("SELECT 1 FROM account_profiles WHERE handle = ? COLLATE NOCASE")
    .bind(opts.name).first();
  if (handleOwner) return { conflict: true };
  const nickOwner = await db.prepare("SELECT 1 FROM agent_nicknames WHERE nickname = ? COLLATE NOCASE")
    .bind(opts.name).first();
  if (nickOwner) return { conflict: true };
  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  if (existing) {
    await db
      .prepare(
        `UPDATE tokens
            SET hash = ?, role = ?, owner = ?, channel_scope = ?,
                parent_agent = ?, root_agent = ?, team_id = ?, spawn_depth = ?, child_expires_at = ?,
                created_at = ?, revoked_at = NULL
          WHERE id = ?`,
      )
      .bind(
        hash,
        opts.role,
        opts.owner,
        opts.channelScope,
        opts.lineage?.parent_agent ?? null,
        opts.lineage?.root_agent ?? null,
        opts.lineage?.team_id ?? null,
        opts.lineage?.depth ?? null,
        opts.lineage?.expires_at ?? null,
        now,
        existing.id,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO tokens (
           hash, name, role, owner, channel_scope,
           parent_agent, root_agent, team_id, spawn_depth, child_expires_at,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        hash,
        opts.name,
        opts.role,
        opts.owner,
        opts.channelScope,
        opts.lineage?.parent_agent ?? null,
        opts.lineage?.root_agent ?? null,
        opts.lineage?.team_id ?? null,
        opts.lineage?.depth ?? null,
        opts.lineage?.expires_at ?? null,
        now,
      )
      .run();
    // 预分配认领（#101）：该 name 从无 token（existing 为 null）→ 这是它的【首次】铸造。
    // 把此前预分配、尚未绑定的角色锚定到铸造账号。仅在首次铸造时绑定：重铸（existing 非 null，
    // 见上面的 UPDATE 分支）绝不重绑，于是残留角色不会被易主的新账号继承。
    await db
      .prepare("UPDATE channel_roles SET owner_account = ? WHERE agent_name = ? AND owner_account IS NULL")
      .bind(opts.owner ?? null, opts.name)
      .run();
  }
  return { token };
}

async function upsertHumanSessionToken(db: D1Database, name: string, owner: string): Promise<{ token: string }> {
  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  const existing = await db.prepare("SELECT id FROM tokens WHERE name = ?").bind(name).first<{ id: number }>();
  if (existing) {
    await db
      .prepare(
        `UPDATE tokens
            SET hash = ?, role = 'human', owner = ?, channel_scope = NULL,
                parent_agent = NULL, root_agent = NULL, team_id = NULL,
                spawn_depth = NULL, child_expires_at = NULL,
                created_at = ?, revoked_at = NULL
          WHERE id = ?`,
      )
      .bind(hash, owner, now, existing.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO tokens (
           hash, name, role, owner, channel_scope,
           parent_agent, root_agent, team_id, spawn_depth, child_expires_at,
           created_at
         ) VALUES (?, ?, 'human', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      )
      .bind(hash, name, owner, now)
      .run();
  }
  return { token };
}

function oauthTokenName(providerId: string, account: string): Promise<string> {
  return sha256Hex(`${providerId}:${account}`).then((hash) => `${providerId}-${hash.slice(0, 12)}`);
}

function slugifyHandle(input: string): string | null {
  const base = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9._-]+$/g, "")
    .slice(0, 31);
  const normalized = base.length >= 2 ? base : "";
  return validateHandleFormat(normalized) === null ? null : normalized;
}

async function ensureDefaultHandle(
  db: D1Database,
  profile: AccountProfileMetadata,
): Promise<void> {
  const existing = await db.prepare("SELECT handle FROM account_profiles WHERE account = ?").bind(profile.account).first<{ handle: string }>();
  if (existing) {
    await db.prepare(
      `UPDATE account_profiles
          SET display_name = ?, avatar_url = ?, avatar_thumb = ?, provider = ?,
              provider_user_id = ?, tenant_key = ?, updated_at = ?
        WHERE account = ?`,
    )
      .bind(
        profile.displayName,
        profile.avatarUrl,
        profile.avatarThumb,
        profile.provider,
        profile.providerUserId,
        profile.tenantKey,
        Date.now(),
        profile.account,
      )
      .run();
    return;
  }
  const hash = await sha256Hex(`${profile.provider}:${profile.account}`);
  const fromDisplay = slugifyHandle(profile.displayName);
  const candidates = [
    fromDisplay,
    fromDisplay === null ? null : `${fromDisplay.slice(0, 26)}-${hash.slice(0, 4)}`,
    `${profile.provider}-${hash.slice(0, 10)}`,
  ].filter((candidate): candidate is string => candidate !== null && validateHandleFormat(candidate) !== null);
  const now = Date.now();
  for (const handle of candidates) {
    if ((await handleConflict(db, handle, profile.account)) !== null) continue;
    try {
      await db
        .prepare(
          `INSERT INTO account_profiles (
             account, handle, display_name, avatar_url, avatar_thumb, provider, provider_user_id, tenant_key,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          profile.account,
          handle,
          profile.displayName,
          profile.avatarUrl,
          profile.avatarThumb,
          profile.provider,
          profile.providerUserId,
          profile.tenantKey,
          now,
          now,
        )
        .run();
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("UNIQUE")) throw e;
    }
  }
}

const requireAdmin = createMiddleware<AppContext>(async (c, next) => {
  const secret = c.env.ADMIN_SECRET;
  if (!secret || c.req.header("x-admin-secret") !== secret) {
    return c.json(errorBody("unauthorized", "invalid admin secret"), 401);
  }
  await next();
});

// 会员骨架（#277）：读账号的 free/member 状态。无 account_membership 行 => free（默认，含自部署/未申请）。
// 这是账号维度分层的读侧真相来源；isMember（shared）判会员时喂它的返回值即可。
async function loadMembership(db: D1Database, account: string | null | undefined): Promise<MembershipStatus> {
  if (account == null) return DEFAULT_MEMBERSHIP;
  const row = await db
    .prepare("SELECT tier, member_since FROM account_membership WHERE account = ?")
    .bind(account)
    .first<{ tier: string; member_since: number | null }>();
  if (!row) return DEFAULT_MEMBERSHIP;
  return { tier: normalizeTier(row.tier), member_since: row.member_since ?? null };
}

const requireBearer = createMiddleware<AppContext>(async (c, next) => {
  if (!c.get("identity")) {
    const bearer = extractBearer(c.req.raw, {
      allowQueryToken:
        c.req.method === "GET" &&
        c.req.path.endsWith("/ws") &&
        c.req.header("upgrade")?.toLowerCase() === "websocket",
    });
    const identity = bearer
      ? await lookupToken(c.env.DB, bearer.token, oidcConfigFromEnv(c.env, [CLI_CLIENT_ID]), c.env.DESKTOP_PAIRING_SECRET)
      : null;
    if (!identity) {
      return c.json(errorBody("unauthorized", "invalid or revoked token"), 401);
    }
    if (bearer?.source === "query" && identity.role !== "readonly") {
      return c.json(errorBody("unauthorized", "query-string websocket tokens must be readonly"), 403);
    }
    c.set("identity", identity);
  }
  await next();
});

async function loadChannel(db: D1Database, slug: string) {
  return db
    .prepare(
      `SELECT slug, kind, mode, archived_at, created_by, visibility, owner_account,
              completion_gate, completion_review_policy, decision_mode, loop_guard_enabled, loop_guard_limit,
              workflow_guard_enabled, workflow_guard_limit,
              charter, charter_rev, charter_updated_at, charter_updated_by,
              charter_write_policy, charter_write_agents, charter_write_agent_allowlist_json,
              members_list_policy, members_list_agents, members_list_agent_allowlist_json
         FROM channels WHERE slug = ?`,
    )
    .bind(slug)
    .first<{
      slug: string;
      kind: string;
      mode: string;
      archived_at: number | null;
      created_by: string | null;
      visibility: string;
      owner_account: string | null;
      completion_gate: string;
      completion_review_policy: string;
      decision_mode: string;
      loop_guard_enabled: number;
      loop_guard_limit: number | null;
      workflow_guard_enabled: number;
      workflow_guard_limit: number;
      charter: string | null;
      charter_rev: number;
      charter_updated_at: number | null;
      charter_updated_by: string | null;
      charter_write_policy: string;
      charter_write_agents: string;
      charter_write_agent_allowlist_json: string;
      members_list_policy: string;
      members_list_agents: string;
      members_list_agent_allowlist_json: string;
    }>();
}

type LoadedChannel = NonNullable<Awaited<ReturnType<typeof loadChannel>>>;

async function isChannelMember(db: D1Database, slug: string, account: string | null | undefined): Promise<boolean> {
  if (account == null) return false;
  const row = await db.prepare("SELECT account FROM channel_members WHERE channel_slug = ? AND account = ?")
    .bind(slug, account)
    .first<{ account: string }>();
  return row !== null;
}

function channelJoinRequestFromRow(row: ChannelJoinRequestRow) {
  let requesterProfile: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.requester_profile_json) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      requesterProfile = parsed as Record<string, unknown>;
    }
  } catch {
    // The migration enforces valid JSON; retain a safe response if a legacy/manual row is malformed.
  }
  return {
    id: row.id,
    slug: row.slug,
    account: row.account,
    requester_display: row.requester_display,
    requester_profile: requesterProfile,
    state: row.state,
    note: row.note,
    source_token_name: row.source_token_name,
    requested_at: row.requested_at,
    reviewed_at: row.reviewed_at,
    reviewed_by: row.reviewed_by,
    review_reason: row.review_reason,
  };
}

async function loadChannelJoinRequest(
  db: D1Database,
  slug: string,
  where: { id: string } | { account: string },
): Promise<ChannelJoinRequestRow | null> {
  const column = "id" in where ? "id" : "account";
  const value = "id" in where ? where.id : where.account;
  return db.prepare(
    `SELECT id, slug, account, requester_display, requester_profile_json, state, note,
            source_token_name, requested_at, reviewed_at, reviewed_by, review_reason
       FROM channel_join_requests
      WHERE slug = ? AND ${column} = ?`,
  )
    .bind(slug, value)
    .first<ChannelJoinRequestRow>();
}

async function joinRequestProfileSnapshot(db: D1Database, account: string): Promise<{
  display: string;
  json: string;
}> {
  const profile = await db.prepare(
    `SELECT handle, display_name, avatar_url, avatar_thumb
       FROM account_profiles
      WHERE account = ?`,
  )
    .bind(account)
    .first<{
      handle: string;
      display_name: string | null;
      avatar_url: string | null;
      avatar_thumb: string | null;
    }>();
  if (!profile) return { display: account, json: "{}" };
  const snapshot = {
    handle: profile.handle,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    avatar_thumb: profile.avatar_thumb,
  };
  return { display: profile.display_name ?? profile.handle ?? account, json: JSON.stringify(snapshot) };
}

function optionalBoundedText(value: unknown, maxBytes: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (textEncoder.encode(text).byteLength > maxBytes) return undefined;
  return text === "" ? null : text;
}

async function canAccessLoadedChannel(db: D1Database, identity: TokenIdentity, channel: LoadedChannel): Promise<boolean> {
  if (canAccessChannel(identity, channel, await isChannelMember(db, channel.slug, identity.account))) return true;
  if (identity.role !== "agent" || identity.account == null) return false;
  const row = await db.prepare(
    `SELECT id
       FROM channel_agent_invites
      WHERE channel_slug = ?
        AND owner_account = ?
        AND profile_handle = ?
        AND revoked_at IS NULL`,
  )
    .bind(channel.slug, identity.account, identity.name)
    .first<{ id: number }>();
  return row !== null;
}

// #381 public_watch 写门：能否「参与/发送」。public_watch 频道任意人可读，但发送需成员/被邀请。
// 参与集 = 把该频道当**私有**频道时的访问集（房主账号 / channel_members / 被邀 project-agent / scope 命中）。
// readonly 恒不可写（DO handleSend 也拦）。worker 持 D1 成员表，算好后经 x-ap-can-write 传给 DO 强制。
// 仅 public_watch 频道 DO 才据此拦截；public/private 忽略此位，故对现有频道零行为变化。
async function canParticipateInChannel(db: D1Database, identity: TokenIdentity, channel: LoadedChannel): Promise<boolean> {
  if (identity.role === "readonly") return false;
  return canAccessLoadedChannel(db, identity, { ...channel, visibility: "private" });
}

async function writeGateHeaders(db: D1Database, identity: TokenIdentity, channel: LoadedChannel): Promise<Record<string, string>> {
  return { "x-ap-can-write": (await canParticipateInChannel(db, identity, channel)) ? "1" : "0" };
}

async function channelMessageStats(env: AppEnv, slug: string): Promise<{ message_count: number; earliest_ts: number | null }> {
  const res = await fetchChannelDO(
    env,
    slug,
    new Request("https://do/internal/message-stats", { headers: { "x-partykit-room": slug } }),
  );
  if (!res.ok) return { message_count: 0, earliest_ts: null };
  return (await res.json()) as { message_count: number; earliest_ts: number | null };
}

// state 必传（#143）：worker 层发的都是信息类事件，落成 blocked 会让守 etiquette 的 agent
// 停手等人类。唯一真 blocked 的来源在 DO 内部（webhook 死信 / 队列满 / guard 熔断）。
async function insertSystemStatus(
  env: AppEnv,
  slug: string,
  note: string,
  state: StatusState = "waiting",
  ts = Date.now(),
): Promise<boolean> {
  const res = await fetchChannelDO(
    env,
    slug,
    new Request("https://do/internal/system-status", {
      method: "POST",
      body: JSON.stringify({ note, ts, state }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  return res.ok;
}

// task 状态 → 系统状态帧的 state。task 自己 blocked 时确实该报 blocked；done 报 done；
// 其余（triage/backlog/assigned/in_progress/needs_review）都是推进中的信息事件 → waiting。
// 入参放宽到 string（DB 行的 state 列是裸 string）：未知值兜底 waiting，与 insertSystemStatus
// 的默认值同向——误判成 blocked 会让 agent 停手，误判成 waiting 只是少一条告警。
function statusStateForTask(state: string): StatusState {
  if (state === "blocked") return "blocked";
  if (state === "done") return "done";
  return "waiting";
}

async function recentNonMemberSpeakers(db: D1Database, env: AppEnv, slug: string, ownerAccount: string | null): Promise<string[]> {
  const res = await fetchChannelDO(
    env,
    slug,
    new Request("https://do/internal/messages?since=0&limit=1000", { headers: { "x-partykit-room": slug } }),
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { messages?: MsgFrame[] };
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const memberAccounts = new Set(
    (await db.prepare("SELECT account FROM channel_members WHERE channel_slug = ?")
      .bind(slug)
      .all<{ account: string }>()).results.map((row) => row.account),
  );
  const accounts = new Set<string>();
  for (const msg of body.messages ?? []) {
    const account = msg.sender.owner;
    if (msg.ts < cutoff || account === undefined || account === ownerAccount || memberAccounts.has(account)) continue;
    accounts.add(account);
  }
  return [...accounts].sort();
}

// do 侧按 meta 缓存 mode/kind/host（loop guard 分档、temp 归档、webhook permalink 都要用）
function channelHeaders(
  channel: {
    kind: string;
    mode: string;
    visibility?: string;
    completion_gate?: string;
    completion_review_policy?: string;
    decision_mode?: string;
    loop_guard_enabled?: number;
    loop_guard_limit?: number | null;
    workflow_guard_enabled?: number;
    workflow_guard_limit?: number;
    charter_rev?: number;
  },
  requestUrl: string,
) {
  return {
    "x-ap-mode": channel.mode,
    "x-ap-channel-kind": channel.kind,
    // #381：把频道可见性权威缓存进 DO（cacheChannelMeta），供 handleSend 判 public_watch 写门
    ...(channel.visibility ? { "x-ap-visibility": channel.visibility } : {}),
    "x-ap-completion-gate": channel.completion_gate ?? "off",
    "x-ap-completion-review-policy": channel.completion_review_policy ?? "sender",
    "x-ap-decision-mode": channel.decision_mode ?? "approval",
    "x-ap-loop-guard-enabled": String(channel.loop_guard_enabled ?? 0),
    "x-ap-loop-guard-limit": channel.loop_guard_limit == null ? "" : String(channel.loop_guard_limit),
    "x-ap-workflow-guard-enabled": String(channel.workflow_guard_enabled ?? 0),
    "x-ap-workflow-guard-limit": String(channel.workflow_guard_limit ?? 30),
    "x-ap-charter-rev": String(channel.charter_rev ?? 0),
    "x-ap-host": new URL(requestUrl).host,
  };
}

async function canConfigureChannel(db: D1Database, identity: TokenIdentity, channel: LoadedChannel): Promise<boolean> {
  if (isChannelModerator(identity, channel)) return true;
  return (await loadAssignedRole(db, channel.slug, identity)) === "host";
}

function parseNameListJson(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && NAME_RE.test(item));
  } catch {
    return [];
  }
}

function channelPerms(channel: LoadedChannel): ChannelPerms {
  const charterWrite = HUMAN_METADATA_POLICIES.includes(channel.charter_write_policy as HumanMetadataPolicy)
    ? (channel.charter_write_policy as HumanMetadataPolicy)
    : "moderators";
  const charterWriteAgents = AGENT_METADATA_POLICIES.includes(channel.charter_write_agents as AgentMetadataPolicy)
    ? (channel.charter_write_agents as AgentMetadataPolicy)
    : "moderators";
  const membersList = (["off", ...HUMAN_METADATA_POLICIES] as const).includes(channel.members_list_policy as ChannelPerms["members_list"])
    ? (channel.members_list_policy as ChannelPerms["members_list"])
    : "members";
  const membersListAgents = AGENT_METADATA_POLICIES.includes(channel.members_list_agents as AgentMetadataPolicy)
    ? (channel.members_list_agents as AgentMetadataPolicy)
    : "members";
  return {
    charter_write: charterWrite,
    charter_write_agents: charterWriteAgents,
    charter_write_agent_allowlist: parseNameListJson(channel.charter_write_agent_allowlist_json),
    members_list: membersList,
    members_list_agents: membersListAgents,
    members_list_agent_allowlist: parseNameListJson(channel.members_list_agent_allowlist_json),
  };
}

function canByHumanPolicy(policy: HumanMetadataPolicy | "off", identity: TokenIdentity, channel: LoadedChannel, isMember: boolean): boolean {
  if (policy === "off") return false;
  if (policy === "owner") return identity.account != null && identity.account === channel.owner_account;
  if (isChannelModerator(identity, channel)) return true;
  return policy === "members" && isMember;
}

function canByAgentPolicy(
  policy: AgentMetadataPolicy,
  allowlist: string[],
  identity: TokenIdentity,
  channel: LoadedChannel,
  isMember: boolean,
  assignedRole: CollaborationRole | null,
): boolean {
  if (identity.role === "readonly" || policy === "off") return false;
  if (policy === "allowlist") return allowlist.includes(identity.name);
  if (isChannelModerator(identity, channel)) return true;
  if (policy === "moderators") return assignedRole === "host";
  return policy === "members" && isMember;
}

async function canListMembers(db: D1Database, identity: TokenIdentity, channel: LoadedChannel): Promise<boolean> {
  const perms = channelPerms(channel);
  const isMember = await isChannelMember(db, channel.slug, identity.account);
  if (identity.kind === "agent") {
    const role = await loadAssignedRole(db, channel.slug, identity);
    return canByAgentPolicy(perms.members_list_agents, perms.members_list_agent_allowlist, identity, channel, isMember, role);
  }
  return canByHumanPolicy(perms.members_list, identity, channel, isMember);
}

async function consumeLarkDirectorySearchLimit(db: D1Database, account: string): Promise<number> {
  const now = Date.now();
  const windowMs = 60_000;
  const keyHash = await sha256Hex(account);
  await db.prepare(
    `INSERT INTO desktop_rate_limits (scope, key_hash, window_started_at, count, blocked_until, updated_at)
     VALUES ('lark-directory-search', ?, ?, 1, 0, ?)
     ON CONFLICT(scope, key_hash) DO UPDATE SET
       window_started_at = CASE
         WHEN excluded.updated_at - desktop_rate_limits.window_started_at >= ? THEN excluded.updated_at
         ELSE desktop_rate_limits.window_started_at
       END,
       count = CASE
         WHEN excluded.updated_at - desktop_rate_limits.window_started_at >= ? THEN 1
         ELSE desktop_rate_limits.count + 1
       END,
       updated_at = excluded.updated_at`,
  ).bind(keyHash, now, now, windowMs, windowMs).run();
  const row = await db.prepare(
    "SELECT count, window_started_at FROM desktop_rate_limits WHERE scope = 'lark-directory-search' AND key_hash = ?",
  ).bind(keyHash).first<{ count: number; window_started_at: number }>();
  if (Number(row?.count ?? 1) <= LARK_DIRECTORY_SEARCHES_PER_MINUTE) return 0;
  return Math.max(1, Math.ceil((Number(row?.window_started_at ?? now) + windowMs - now) / 1000));
}

function directoryAccount(providerId: string, providerUserId: string): string | null {
  const account = `${providerId}:${providerUserId}`;
  return account.length <= OWNER_MAX && OWNER_RE.test(account) ? account : null;
}

async function canEditCharter(db: D1Database, identity: TokenIdentity, channel: LoadedChannel): Promise<boolean> {
  if (identity.role === "readonly") return false;
  const perms = channelPerms(channel);
  const isMember = await isChannelMember(db, channel.slug, identity.account);
  if (identity.kind === "agent") {
    const role = await loadAssignedRole(db, channel.slug, identity);
    return canByAgentPolicy(perms.charter_write_agents, perms.charter_write_agent_allowlist, identity, channel, isMember, role);
  }
  return canByHumanPolicy(perms.charter_write, identity, channel, isMember);
}

function stringArrayBody(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  if (items.some((item) => !NAME_RE.test(item))) return null;
  return [...new Set(items)].sort();
}

function channelPermsPatch(body: Record<string, unknown>): { sets: string[]; values: string[] } | null {
  const sets: string[] = [];
  const values: string[] = [];
  const setString = (column: string, value: string) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  const maybeHumanPolicy = (key: string, column: string, allowOff = false) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return true;
    const value = body[key];
    if (typeof value !== "string") return false;
    const allowed = allowOff ? (["off", ...HUMAN_METADATA_POLICIES] as readonly string[]) : HUMAN_METADATA_POLICIES;
    if (!allowed.includes(value)) return false;
    setString(column, value);
    return true;
  };
  const maybeAgentPolicy = (key: string, column: string) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return true;
    const value = body[key];
    if (typeof value !== "string" || !AGENT_METADATA_POLICIES.includes(value as AgentMetadataPolicy)) return false;
    setString(column, value);
    return true;
  };
  const maybeAllowlist = (key: string, column: string) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return true;
    const list = stringArrayBody(body[key]);
    if (list === null) return false;
    setString(column, JSON.stringify(list));
    return true;
  };
  if (!maybeHumanPolicy("charter_write", "charter_write_policy")) return null;
  if (!maybeAgentPolicy("charter_write_agents", "charter_write_agents")) return null;
  if (!maybeAllowlist("charter_write_agent_allowlist", "charter_write_agent_allowlist_json")) return null;
  if (!maybeHumanPolicy("members_list", "members_list_policy", true)) return null;
  if (!maybeAgentPolicy("members_list_agents", "members_list_agents")) return null;
  if (!maybeAllowlist("members_list_agent_allowlist", "members_list_agent_allowlist_json")) return null;
  return { sets, values };
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !isRecord(data)) {
    throw new Error(`provider request failed (${res.status})`);
  }
  return data;
}

function extractLarkAccessToken(data: Record<string, unknown>): {
  accessToken: string;
  expiresIn: number | null;
} {
  const code = data.code;
  if (code !== undefined && String(code) !== "0") {
    const desc = typeof data.error_description === "string" ? data.error_description : typeof data.msg === "string" ? data.msg : "token exchange failed";
    throw new Error(desc);
  }
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) throw new Error("provider token response did not include access_token");
  return {
    accessToken,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
  };
}

function extractLarkUserInfo(data: Record<string, unknown>, providerId = "lark"): {
  account: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  avatarThumb: string | null;
  providerUserId: string;
  tenantKey: string | null;
} {
  const code = data.code;
  if (code !== undefined && Number(code) !== 0) {
    const msg = typeof data.msg === "string" ? data.msg : "user_info failed";
    throw new Error(msg);
  }
  const user = isRecord(data.data) ? data.data : data;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = user[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const email = pick("email", "enterprise_email") || null;
  const providerUserId = pick("union_id", "open_id", "user_id");
  const externalId = email ?? providerUserId;
  if (!externalId) throw new Error("provider user_info did not include a usable identity");
  const displayName = pick("name", "en_name", "display_name") || email || externalId;
  const account = `${email === null ? providerId : `${providerId}-email`}:${externalId}`;
  if (account.length > OWNER_MAX || !OWNER_RE.test(account)) {
    throw new Error("provider user_info returned an unsupported account id");
  }
  return {
    account,
    email,
    displayName,
    avatarUrl: pick("avatar_url", "avatar_big", "avatar_middle") || null,
    avatarThumb: pick("avatar_thumb", "avatar_middle", "avatar_url") || null,
    providerUserId: providerUserId || externalId,
    tenantKey: pick("tenant_key") || null,
  };
}

async function exchangeOAuthCode(
  provider: OAuthProviderConfig,
  secret: string,
  body: { code: string; redirect_uri: string; code_verifier?: string },
): Promise<AccountProfileMetadata & { expiresIn: number | null }> {
  const tokenData = await fetchJson(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: provider.clientId,
      client_secret: secret,
      code: body.code,
      redirect_uri: body.redirect_uri,
      ...(body.code_verifier ? { code_verifier: body.code_verifier } : {}),
    }),
  });
  const token = extractLarkAccessToken(tokenData);
  const userData = await fetchJson(provider.userInfoUrl, {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  const user = extractLarkUserInfo(userData, provider.id);
  return { ...user, provider: provider.id, expiresIn: token.expiresIn };
}

// 协作角色按【账号】锚定，不认裸 name（#101）。一个 host 角色只对绑定账号的身份生效：
//   - owner_account 为 null（预分配未认领 / 迁移无法确定账号）→ 一律不生效（安全失败方向）。
//     预分配角色由 persistToken 在该 name 首次铸 token 时绑定到铸造账号；未绑定前无 token 能读到它。
//   - owner_account 非 null → 仅当 identity.account 严格相等才返回角色。
// 于是「撤销旧 token → 他人重铸同名」拿不到残留角色（account 不符）；同账号重铸同名则保留（account 相等）。
async function loadAssignedRole(db: D1Database, slug: string, identity: TokenIdentity): Promise<CollaborationRole | null> {
  const row = await db
    .prepare("SELECT role, owner_account FROM channel_roles WHERE channel_slug = ? AND agent_name = ?")
    .bind(slug, identity.name)
    .first<{ role: string; owner_account: string | null }>();
  if (!row || !COLLAB_ROLES.includes(row.role)) return null;
  if (row.owner_account === null) return null;
  return row.owner_account === (identity.account ?? null) ? (row.role as CollaborationRole) : null;
}

function assignedRoleHeaders(role: CollaborationRole | null): Record<string, string> {
  return role === null ? {} : { "x-ap-collab-role": role, "x-ap-role-source": "assigned" };
}

// 人类 handle 头：仅当身份是人类且已设 handle 才带（权威值，供 do 盖 presence + stamp 消息，Task A6/A7）。
// #165：agent 身份则带自己的 nickname（同样走 x-ap-handle，复用 do 的 presence/sender 展示管线）。
// x-ap-handle 一律 encodeURIComponent——人类 handle 是 ASCII 编码后原样不变，agent 中文昵称则需编码
// 才能塞进 latin1 的 HTTP 头（do 侧 decodedHeaderText 解回）。
export async function handleHeader(db: D1Database, identity: TokenIdentity): Promise<Record<string, string>> {
  // agent：昵称按 token name 存，与是否有 account 无关。
  if (identity.kind === "agent") {
    const row = await db
      .prepare("SELECT nickname FROM agent_nicknames WHERE name = ?")
      .bind(identity.name)
      .first<{ nickname: string | null }>();
    return row?.nickname ? { "x-ap-handle": encodeURIComponent(row.nickname) } : {};
  }
  if (identity.kind !== "human" || identity.account == null) return {};
  const row = await db.prepare(
    `SELECT handle, display_name, avatar_url, avatar_thumb
       FROM account_profiles
      WHERE account = ?`,
  )
    .bind(identity.account)
    .first<{ handle: string | null; display_name: string | null; avatar_url: string | null; avatar_thumb: string | null }>();
  if (!row) return {};
  return {
    ...(row.handle ? { "x-ap-handle": encodeURIComponent(row.handle) } : {}),
    ...(row.display_name ? { "x-ap-display-name": encodeURIComponent(row.display_name) } : {}),
    ...(row.avatar_url ? { "x-ap-avatar-url": row.avatar_url } : {}),
    ...(row.avatar_thumb ? { "x-ap-avatar-thumb": row.avatar_thumb } : {}),
  };
}

function lineageHeaders(identity: TokenIdentity): Record<string, string> {
  const lineage = identity.lineage;
  if (lineage === undefined) return {};
  return {
    "x-ap-parent-agent": lineage.parent_agent,
    "x-ap-root-agent": lineage.root_agent,
    "x-ap-team-id": lineage.team_id,
    "x-ap-spawn-depth": String(lineage.depth),
    ...(lineage.expires_at === null ? {} : { "x-ap-child-expires-at": String(lineage.expires_at) }),
  };
}

function isPrivateIpv4(host: string): boolean {
  const chunks = host.split(".");
  if (chunks.length !== 4) return false;
  const parts = chunks.map((p) => (p === "" ? NaN : Number(p)));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function mappedIpv4FromIpv6(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const tail = host.slice("::ffff:".length);
  if (tail.includes(".")) return tail;
  const parts = tail.split(":");
  if (parts.length !== 2) return null;
  const nums = parts.map((p) => Number.parseInt(p, 16));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  const [hi, lo] = nums as [number, number];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isIpv6LinkLocal(host: string): boolean {
  const first = host.split(":")[0] ?? "";
  const n = Number.parseInt(first, 16);
  return Number.isInteger(n) && n >= 0xfe80 && n <= 0xfebf;
}

function isBlockedWebhookHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const isIpv6 = host.includes(":");
  const mapped = isIpv6 ? mappedIpv4FromIpv6(host) : null;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::" ||
    host === "::1" ||
    (isIpv6 && isIpv6LinkLocal(host)) ||
    (isIpv6 && host.startsWith("fc")) ||
    (isIpv6 && host.startsWith("fd")) ||
    (mapped !== null && isPrivateIpv4(mapped)) ||
    isPrivateIpv4(host)
  );
}

const app = new Hono<AppContext>();
const DESKTOP_CORS_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "agentparty-ui://localhost",
  "http://agentparty-ui.localhost",
]);

function docsAsset(c: Context<AppContext>, path: string): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = path;
  url.search = "";
  return c.env.ASSETS.fetch(new Request(url.toString(), { method: "GET", headers: c.req.raw.headers }));
}

app.get("/docs", (c) => docsAsset(c, "/docs/index.html"));
app.get("/docs/", (c) => docsAsset(c, "/docs/index.html"));
app.get("/docs/statusline", (c) => docsAsset(c, "/docs/statusline/index.html"));
app.get("/docs/statusline/", (c) => docsAsset(c, "/docs/statusline/index.html"));
app.get("/docs/spec", (c) => docsAsset(c, "/docs/spec/index.html"));
app.get("/docs/spec/", (c) => docsAsset(c, "/docs/spec/index.html"));

app.use("/api/desktop/*", async (c, next) => {
  await next();
  c.res.headers.set("cache-control", "no-store, no-cache, max-age=0");
  c.res.headers.set("pragma", "no-cache");
  c.res.headers.set("referrer-policy", "no-referrer");
});

app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin") ?? "";
  if (!origin) return next();
  const sameOrigin = origin === new URL(c.req.url).origin;
  if (!sameOrigin && !DESKTOP_CORS_ORIGINS.has(origin)) {
    return c.json(errorBody("forbidden", "origin not allowed"), 403);
  }

  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-max-age": "86400",
        vary: "Origin",
      },
    });
  }

  await next();
  c.res.headers.set("access-control-allow-origin", origin);
  c.res.headers.append("vary", "Origin");
});

// CLI↔worker 版本协商护栏（#137）。默认建言：低版本客户端照常放行，仅回一个 x-ap-client-too-old 信号头；
// 仅当 MIN_CLIENT_ENFORCE 显式开启且客户端**确实带版本头且低于下限**时才 426 硬拒——缺头的 legacy 永不拒。
// /api/version 与 /api/health 是老客户端了解自己过时的唯一入口，任何模式下都不拦。
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api/version" || path === "/api/health") return next();
  const minVersion = resolveMinClientVersion(c.env.MIN_CLIENT_VERSION);
  const verdict = evaluateClientVersion(c.req.header(CLIENT_VERSION_HEADER), minVersion);
  if (verdict.status === "too_old" && isEnforced(c.env.MIN_CLIENT_ENFORCE)) {
    c.header("cache-control", "no-store");
    c.header(MIN_CLIENT_VERSION_HEADER, minVersion);
    c.header(CLIENT_TOO_OLD_HEADER, "1");
    return c.json(clientTooOldNotice(verdict), 426);
  }
  await next();
  // 建言信号：始终告知下限；已知过时才打 too-old 标（unknown/legacy 不打，避免误伤本就不带头的浏览器等）。
  // 建言头是尽力而为——某些响应（流式/已终结）的 headers 不可变，绝不能因加建言头而把请求崩成 500。
  try {
    c.res.headers.set(MIN_CLIENT_VERSION_HEADER, minVersion);
    if (verdict.status === "too_old") c.res.headers.set(CLIENT_TOO_OLD_HEADER, "1");
  } catch {
    // 不可变响应头：跳过建言头，不影响正文
  }
});

app.get("/api/health", (c) => {
  c.header("cache-control", "no-store");
  return c.json({ ok: true, ...DEPLOYMENT_METADATA });
});

// CLI↔worker 版本协商源点（#137）：服务端 version/commit/deployed_at + 声明的最低客户端版本 + 是否硬拒。
// 老客户端据此得知自己是否过时；本端点与 /api/health 永不受 min-version 护栏拦截（见下方中间件）。
app.get("/api/version", (c) => {
  c.header("cache-control", "no-store");
  return c.json({
    ...DEPLOYMENT_METADATA,
    min_client_version: resolveMinClientVersion(c.env.MIN_CLIENT_VERSION),
    min_client_enforced: isEnforced(c.env.MIN_CLIENT_ENFORCE),
  });
});

app.get("/api/management-audit", requireAdmin, async (c) => {
  const pagination = parseManagementAuditPagination(new URL(c.req.url));
  if (pagination === null) {
    return c.json(errorBody("bad_request", "limit must be 1..100 and cursor must be valid for this audit scope"), 400);
  }
  const page = await listManagementAudit(c.env.DB, pagination);
  if (page === null) return c.json(errorBody("bad_request", "cursor is unknown for this audit scope"), 400);
  return c.json(page);
});
app.get("/openapi.json", (c) => c.json(openapiDocument));

// Desktop Device Flow: only start/token/refresh are unauthenticated. The short user code is
// accepted exclusively by authenticated human inspect/decision routes and can never redeem.
app.post("/api/desktop/pairings", (c) => startDesktopPairing(c.req.raw, c.env));
app.post("/api/desktop/pairings/inspect", requireBearer, (c) =>
  inspectDesktopPairing(c.req.raw, c.env, c.get("identity")),
);
app.post("/api/desktop/pairings/decision", requireBearer, (c) =>
  decideDesktopPairing(c.req.raw, c.env, c.get("identity")),
);
app.post("/api/desktop/pairings/token", (c) => exchangeDesktopPairing(c.req.raw, c.env));
app.post("/api/desktop/sessions/refresh", (c) => refreshDesktopSession(c.req.raw, c.env));
app.get("/api/desktop/sessions", requireBearer, (c) => listDesktopSessions(c.env, c.get("identity")));
app.delete("/api/desktop/sessions/:id", requireBearer, (c) =>
  revokeDesktopSessionByOwner(c.env, c.get("identity"), c.req.param("id")),
);
app.post("/api/desktop/sessions/revoke", (c) => revokeCurrentDesktopSession(c.req.raw, c.env));

// 公开配置：web 据此决定是否显示 "Sign in with leeguoo"（未配 OIDC 时 oidc:null）；
// cli_client_id 供 CLI party login 知道用哪个 public client 跑回环 PKCE（spec §4）
app.get("/api/config", (c) => {
  const oidc = oidcConfigFromEnv(c.env, [CLI_CLIENT_ID]);
  const providers = parseAuthProviders(c.env);
  return c.json({
    oidc: oidc ? { issuer: oidc.issuer, client_id: oidc.clientId } : null,
    auth: {
      providers: providers.map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        label: provider.label,
        client_id: provider.clientId,
        authorize_url: provider.authorizeUrl,
        scope: provider.scope,
      })),
    },
    cli_client_id: CLI_CLIENT_ID,
  });
});

app.post("/api/auth/:provider/callback", async (c) => {
  const providers = parseAuthProviders(c.env);
  const provider = providers.find((item) => item.id === c.req.param("provider"));
  if (provider === undefined) {
    return c.json(errorBody("not_found", "auth provider not configured"), 404);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { code?: unknown; redirect_uri?: unknown; code_verifier?: unknown }
    | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const redirectUri = typeof body?.redirect_uri === "string" ? body.redirect_uri.trim() : "";
  const codeVerifier = typeof body?.code_verifier === "string" ? body.code_verifier.trim() : "";
  if (!code || !redirectUri) {
    return c.json(errorBody("bad_request", "code and redirect_uri required"), 400);
  }
  const secret = ((c.env as unknown) as Record<string, string | undefined>)[provider.clientSecretEnv]?.trim();
  if (!secret) {
    return c.json(errorBody("unavailable", "auth provider secret is not configured"), 500);
  }
  let exchanged: Awaited<ReturnType<typeof exchangeOAuthCode>>;
  try {
    exchanged = await exchangeOAuthCode(provider, secret, {
      code,
      redirect_uri: redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "provider sign-in failed";
    return c.json(errorBody("unauthorized", message), 401);
  }
  if (!OWNER_RE.test(exchanged.account) || exchanged.account.length > OWNER_MAX) {
    return c.json(errorBody("unavailable", "provider account id is not header-safe"), 500);
  }
  const existingAccount = await c.env.DB.prepare(
    `SELECT account FROM account_profiles
      WHERE provider = ? AND provider_user_id = ? AND tenant_key = ?
      LIMIT 1`,
  ).bind(provider.id, exchanged.providerUserId, exchanged.tenantKey).first<{ account: string }>();
  const stableAccount = existingAccount?.account ?? directoryAccount(provider.id, exchanged.providerUserId);
  if (stableAccount === null) {
    return c.json(errorBody("unavailable", "provider user id is not header-safe"), 500);
  }
  exchanged.account = stableAccount;
  const tokenName = await oauthTokenName(provider.id, exchanged.account);
  const sess = await upsertHumanSessionToken(c.env.DB, tokenName, exchanged.account);
  await ensureDefaultHandle(c.env.DB, exchanged);
  return c.json({
    access_token: sess.token,
    token_type: "Bearer",
    expires_in: exchanged.expiresIn ?? 365 * 24 * 60 * 60,
    provider: provider.id,
    email: exchanged.email,
  });
});

// DO webhook relay: channel mention -> personal Lark/Feishu card.
// Auth is the per-subscription webhook secret, then the DO HMAC signature over the raw body.
app.post("/api/integrations/lark/relay", async (c) => {
  const bearer = extractBearer(c.req.raw);
  if (!bearer) return c.json(errorBody("unauthorized", "missing webhook bearer secret"), 401);
  const sub = await c.env.DB.prepare(
    `SELECT channel_slug, account, target_name, provider_id, provider_kind,
            receive_id, receive_id_type, secret, created_at, updated_at
       FROM lark_notify_subscriptions
      WHERE secret = ?`,
  )
    .bind(bearer.token)
    .first<LarkNotifySubscriptionRow>();
  if (!sub) return c.json(errorBody("not_found", "lark notification subscription not found"), 404);

  const rawBody = await c.req.text();
  const signed = await verifyWebhookSignature(sub.secret, rawBody, c.req.header("x-agentparty-signature"));
  if (!signed) return c.json(errorBody("unauthorized", "invalid webhook signature"), 401);

  let payload: LarkWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LarkWebhookPayload;
  } catch {
    return c.json(errorBody("bad_request", "invalid webhook payload"), 400);
  }
  if (payload.channel !== sub.channel_slug || !Array.isArray(payload.mentions) || !payload.mentions.includes(sub.target_name)) {
    return c.json(errorBody("bad_request", "webhook payload does not match subscription"), 400);
  }
  const provider = resolveLarkProvider(c.env, sub.provider_id);
  if (!provider || provider.id !== sub.provider_id || provider.kind !== sub.provider_kind) {
    return c.json(errorBody("unavailable", "lark provider is not configured"), 503);
  }
  try {
    await sendLarkCard(c.env, provider, sub.receive_id, sub.receive_id_type, buildMentionCard(payload));
  } catch (e) {
    const message = e instanceof Error ? e.message : "lark delivery failed";
    return c.json(errorBody("unavailable", message), 502);
  }
  return c.json({ ok: true });
});

// 当前登录身份：web topbar 显示 "signed in as <email 或 name>"（spec §10）
app.get("/api/me", requireBearer, async (c) => {
  const id = c.get("identity");
  // 权限自省（whoami --caps / 网页）：从 role + channel_scope + account 派生，让工具提前知道能干什么
  const scoped = id.channel_scope != null;
  // handle（spec 2026-07-08）：全局唯一昵称，仅 human 账号会话（有 account）才可能设置过
  const profile = id.account == null
    ? null
    : await c.env.DB.prepare(
        `SELECT handle, display_name, avatar_url, avatar_thumb, provider, tenant_key
           FROM account_profiles
          WHERE account = ?`,
      )
        .bind(id.account)
        .first<{
          handle: string | null;
          display_name: string | null;
          avatar_url: string | null;
          avatar_thumb: string | null;
          provider: string | null;
          tenant_key: string | null;
        }>();
  // #165：agent 的昵称按 token name 存（非 per-account），单独取，作为 handle 回给网页 me chip。
  const agentNickname = id.kind !== "agent"
    ? null
    : (await c.env.DB.prepare("SELECT nickname FROM agent_nicknames WHERE name = ?")
        .bind(id.name)
        .first<{ nickname: string | null }>())?.nickname ?? null;
  // 会员骨架（#277）：账号维度 free/member。无账号会话（legacy/readonly）也回落 free，让工具统一读这两个字段。
  const membership = await loadMembership(c.env.DB, id.account);
  return c.json({
    name: id.name,
    email: id.email ?? null,
    kind: id.kind,
    role: id.role,
    owner: id.owner ?? null,
    channel_scope: id.channel_scope ?? null,
    lineage: id.lineage ?? null,
    handle: profile?.handle ?? agentNickname,
    display_name: profile?.display_name ?? null,
    avatar_url: profile?.avatar_url ?? null,
    avatar_thumb: profile?.avatar_thumb ?? null,
    provider: profile?.provider ?? null,
    tenant_key: profile?.tenant_key ?? null,
    membership_tier: membership.tier,
    member_since: membership.member_since,
    caps: {
      send: id.role !== "readonly",
      // scoped token 不得建频道（会逃出 scope）；readonly 也不行
      create_channel: id.role !== "readonly" && !scoped,
      // POST /api/agents 的门：human 账号会话（有 account）才能自助铸 agent
      mint_agents: id.role === "human" && id.account != null,
      // POST /api/spawn 的门：父 agent 必须已被限定在一个频道，子身份同 scope 且短 TTL。
      spawn_children:
        id.role === "agent" && id.account != null && id.channel_scope != null && id.lineage === undefined,
      scoped_to: id.channel_scope ?? null,
    },
  });
});

// 设置/更新本账号的全局唯一 handle（spec 2026-07-08，Task A4）：仅 human 账号会话（有 account）可用，
// readonly/legacy 无账号 token 一律 403。撞保留名 / 撞任意 token 名 / 已被别的账号占用 → 409。
app.put("/api/me/handle", requireBearer, async (c) => {
  const id = c.get("identity");
  if (id.role === "readonly" || id.account == null) {
    return c.json(errorBody("forbidden", "setting a handle requires a human account session"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { handle?: unknown } | null;
  const handle = validateHandleFormat(body?.handle);
  if (handle === null) {
    return c.json(errorBody("bad_request", "handle must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$"), 400);
  }
  const conflict = await handleConflict(c.env.DB, handle, id.account);
  if (conflict !== null) {
    return c.json(errorBody("conflict", `handle unavailable (${conflict})`), 409);
  }
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO account_profiles (account, handle, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at`,
    )
      .bind(id.account, handle, now, now)
      .run();
  } catch (e) {
    // 竞态：handleConflict 通过后、另一账号抢先占了同一 handle → UNIQUE(handle) 冲突。转 409（非 500）。
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      return c.json(errorBody("conflict", "handle unavailable (taken)"), 409);
    }
    throw e; // 其它未预期错误保持原样（让它 500，不掩盖真问题）
  }
  return c.json({ handle });
});

// #165：设置/更新本 agent 的全局唯一昵称（可被 @中文昵称 唤醒）。昵称按 token name 存（per-identity，
// 因 agent 与 human 共享 account，不能像 handle 那样 per-account）。仅 agent 身份可用；
// readonly/human 一律 403（human 用 /api/me/handle）。撞保留名/token 名/人类 handle/别的 agent 昵称 → 409。
app.put("/api/me/nickname", requireBearer, async (c) => {
  const id = c.get("identity");
  if (id.role !== "agent") {
    return c.json(errorBody("forbidden", "setting a nickname requires an agent session"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { nickname?: unknown } | null;
  const nickname = validateNicknameFormat(body?.nickname);
  if (nickname === null) {
    return c.json(errorBody("bad_request", "nickname must be 1-64 unicode letters/digits (start alnum, then . _ -)"), 400);
  }
  const conflict = await nicknameConflict(c.env.DB, nickname, id.name);
  if (conflict !== null) {
    return c.json(errorBody("conflict", `nickname unavailable (${conflict})`), 409);
  }
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO agent_nicknames (name, nickname, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at`,
    )
      .bind(id.name, nickname, now, now)
      .run();
  } catch (e) {
    // 竞态：nicknameConflict 通过后、另一 agent 抢先占了同名 → UNIQUE(nickname) 冲突。转 409（非 500）。
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      return c.json(errorBody("conflict", "nickname unavailable (taken)"), 409);
    }
    throw e;
  }
  return c.json({ nickname });
});

// 会员骨架 · owner 手动开通（#277）：owner/admin-only（requireAdmin，走 ADMIN_SECRET，跟铸 token 同一把钥匙）。
// 申请走邮件（网页 mailto → leeguooooo@gmail.com），owner 收到后用这个端点把账号翻成 member。
// tier=member 首次开通盖 member_since（重复开通保留最初时间，幂等）；tier=free 降级并清 member_since。
// 本次不接支付、不 gate 任何功能——只把「谁是会员」落库，供将来的 feature-tier 清单消费。
app.post("/api/admin/membership", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { account?: unknown; tier?: unknown } | null;
  const account = typeof body?.account === "string" ? body.account.trim() : "";
  if (account === "") {
    return c.json(errorBody("bad_request", "account required"), 400);
  }
  // 只认精确的 free/member；别的字符串（含大小写变体）一律 400，不静默当 free 吞掉。
  if (body?.tier !== "free" && body?.tier !== "member") {
    return c.json(errorBody("bad_request", "tier must be 'free' or 'member'"), 400);
  }
  const tier: MembershipTier = body.tier;
  const now = Date.now();
  const existing = await loadMembership(c.env.DB, account);
  // member：首次开通盖 now，已是会员则保留最初 member_since（幂等，不重置开通时间）。free：清空。
  const memberSince =
    tier === "member"
      ? existing.tier === "member" && existing.member_since != null
        ? existing.member_since
        : now
      : null;
  await c.env.DB.prepare(
    `INSERT INTO account_membership (account, tier, member_since, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account) DO UPDATE SET tier = excluded.tier, member_since = excluded.member_since, updated_at = excluded.updated_at`,
  )
    .bind(account, tier, memberSince, now)
    .run();
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditAdminActor,
    action: "membership.set",
    resource: `account/${account}`,
    channel: null,
    timestamp: now,
    metadata: { tier },
  });
  return c.json({ account, tier, member_since: memberSince });
});

app.post("/api/tokens", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; role?: unknown; owner?: unknown; channel_scope?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const role = typeof body?.role === "string" ? body.role : "";
  if (!NAME_RE.test(name) || !ROLES.includes(role)) {
    return c.json(errorBody("bad_request", "valid name and role (agent|human|readonly) required"), 400);
  }
  // owner 必填（spec §6 修复3）：P1 起新铸 token 一律带归属账号（连 ADMIN_SECRET 铸也要求），
  // 这样 owner=null 只存在于 P1 之前的存量 token，不再新增，legacy 过渡缺口随轮换单调收敛。
  if (body?.owner === undefined || body?.owner === null) {
    return c.json(errorBody("bad_request", "owner required"), 400);
  }
  const owner = body.owner;
  // owner 须 header-safe 且不超长（后续经 x-ap-owner 转发给 do）
  if (typeof owner !== "string" || owner.length > OWNER_MAX || !OWNER_RE.test(owner)) {
    return c.json(errorBody("bad_request", `owner must be printable ascii, <= ${OWNER_MAX} chars`), 400);
  }
  // channel_scope 可选（spec §5.3）：把 agent/readonly token 限死单频道 slug——invite 递给外部
  // 协作方 / 分享链接用，canAccessChannel 据此硬上限。须是合法频道 slug。
  const channelScope = body?.channel_scope === undefined || body?.channel_scope === null ? null : body.channel_scope;
  if (channelScope !== null && (typeof channelScope !== "string" || !SLUG_RE.test(channelScope))) {
    return c.json(errorBody("bad_request", "channel_scope must be a valid channel slug"), 400);
  }
  if (RESERVED_NAMES.includes(name)) {
    return c.json(errorBody("bad_request", "name is reserved"), 400);
  }
  const result = await persistToken(c.env.DB, { name, role: role as TokenRole, owner, channelScope });
  if ("conflict" in result) {
    return c.json(errorBody("conflict", "token name already exists, revoke it first"), 409);
  }
  const { token } = result;
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditAdminActor,
    action: "token.issue",
    resource: `token/${name}`,
    channel: channelScope,
    metadata: { token_role: role, channel_scope: channelScope },
  });
  return c.json(
    channelScope !== null ? { token, name, role, owner, channel_scope: channelScope } : { token, name, role, owner },
    201,
  );
});

// 账号维度自助铸 agent token（spec §5.3 / P3）：无需 ADMIN_SECRET，凭 human 账号会话即可铸。
//   - 须 human 身份且带账号锚点（OIDC 人类，或带 owner 的 human ap_ token）；readonly/agent token 一律 403。
//   - owner 恒 = 铸造者自己的 principal.account，绝不接受客户端传 owner（否则可冒充他人账号铸 token）。
//   - role 固定 agent；channel_scope 可选（须合法 slug），用于把外派 agent 限死单频道。
// ADMIN_SECRET 的 /api/tokens 保留给 CI/bootstrap。
app.post("/api/agents", requireBearer, async (c) => {
  const identity = c.get("identity");
  // readonly/agent token 不能铸；legacy human token（无 account）也不行——无从确定归属账号。
  // kind 单独判 human 不够：readonly token 的 kind 也是 human，故必须 role === "human"。
  if (identity.role !== "human" || identity.account == null) {
    return c.json(
      errorBody("forbidden", "minting agent tokens requires a human account session (party login)"),
      403,
    );
  }
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; channel_scope?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  if (!NAME_RE.test(name)) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  if (RESERVED_NAMES.includes(name)) {
    return c.json(errorBody("bad_request", "name is reserved"), 400);
  }
  const channelScope =
    body?.channel_scope === undefined || body?.channel_scope === null ? null : body.channel_scope;
  if (channelScope !== null && (typeof channelScope !== "string" || !SLUG_RE.test(channelScope))) {
    return c.json(errorBody("bad_request", "channel_scope must be a valid channel slug"), 400);
  }
  // scope 继承：channel-scoped 的调用者（如递给 B 公司的 scoped token）只能铸【同一频道 scope】的 agent，
  // 不得铸出无 scope 或别频道的 token 来放大自己的权限（否则外部方铸个无 scope agent 就进你所有频道）。
  const callerScope = identity.channel_scope ?? null;
  let effectiveScope = channelScope;
  if (callerScope !== null) {
    if (channelScope !== null && channelScope !== callerScope) {
      return c.json(
        errorBody("forbidden", "channel-scoped session can only mint tokens for its own channel"),
        403,
      );
    }
    effectiveScope = callerScope;
  }
  // owner = 铸造者账号（不取客户端值）。铸出的 agent token account 因此 = 铸造者账号，
  // 与铸造者共享同一账号 → 天然能进铸造者的私有频道（canAccessChannel 账号规则）。
  const owner = identity.account;
  const result = await persistToken(c.env.DB, { name, role: "agent", owner, channelScope: effectiveScope });
  if ("conflict" in result) {
    return c.json(errorBody("conflict", "token name already exists, revoke it first"), 409);
  }
  const { token } = result;
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "token.issue",
    resource: `token/${name}`,
    channel: effectiveScope,
    metadata: { token_role: "agent", channel_scope: effectiveScope },
  });
  return c.json(
    effectiveScope !== null
      ? { token, name, role: "agent", owner, channel_scope: effectiveScope }
      : { token, name, role: "agent", owner },
    201,
  );
});

app.get("/api/agent-profiles", requireBearer, async (c) => {
  const identity = c.get("identity");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "listing project agent profiles requires a human account session"), 403);
  }
  const rows = await c.env.DB.prepare(
    `SELECT owner_account, handle, name, runner, repo_url, workdir, base_branch,
            worktree_strategy, rules, invitable_by, created_at, updated_at
       FROM agent_profiles
      WHERE owner_account = ?
      ORDER BY updated_at DESC, handle`,
  )
    .bind(identity.account)
    .all<Parameters<typeof projectAgentProfileFromRow>[0]>();
  return c.json({ profiles: (rows.results ?? []).map(projectAgentProfileFromRow) });
});

app.post("/api/agent-profiles", requireBearer, async (c) => {
  const identity = c.get("identity");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "creating a project agent profile requires a human account session"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const handle = typeof body?.handle === "string" ? body.handle : "";
  const name = typeof body?.name === "string" && body.name.trim() !== "" ? body.name.trim() : handle;
  const runner = typeof body?.runner === "string" ? body.runner : "";
  const repoUrl = optionalProfileText(body?.repo_url);
  const workdir = optionalProfileText(body?.workdir);
  const baseBranch = body?.base_branch === undefined ? "main" : optionalProfileText(body.base_branch, PROFILE_BRANCH_MAX);
  const worktreeStrategy = body?.worktree_strategy === undefined ? "branch" : body.worktree_strategy;
  const rules = optionalProfileText(body?.rules);
  const invitableBy = body?.invitable_by === undefined ? "owner" : body.invitable_by;

  if (!NAME_RE.test(handle) || RESERVED_NAMES.includes(handle)) {
    return c.json(errorBody("bad_request", "handle must be a valid agent/name token"), 400);
  }
  if (!PROJECT_AGENT_RUNNERS.includes(runner as (typeof PROJECT_AGENT_RUNNERS)[number])) {
    return c.json(errorBody("bad_request", "runner must be codex, claude, codex-sdk, or shell"), 400);
  }
  if (repoUrl === null || workdir === null || rules === null) {
    return c.json(errorBody("bad_request", `repo_url, workdir, and rules must be strings <= ${PROFILE_TEXT_MAX} bytes`), 400);
  }
  if (baseBranch === null || baseBranch === "") {
    return c.json(errorBody("bad_request", `base_branch must be a string <= ${PROFILE_BRANCH_MAX} bytes`), 400);
  }
  if (!PROJECT_AGENT_WORKTREE.includes(worktreeStrategy as (typeof PROJECT_AGENT_WORKTREE)[number])) {
    return c.json(errorBody("bad_request", "worktree_strategy must be branch, shared, or none"), 400);
  }
  if (!PROJECT_AGENT_INVITABLE.includes(invitableBy as (typeof PROJECT_AGENT_INVITABLE)[number])) {
    return c.json(errorBody("bad_request", "invitable_by must be owner, org, or anyone"), 400);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO agent_profiles (
       owner_account, handle, name, runner, repo_url, workdir, base_branch,
       worktree_strategy, rules, invitable_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_account, handle) DO UPDATE SET
       name = excluded.name,
       runner = excluded.runner,
       repo_url = excluded.repo_url,
       workdir = excluded.workdir,
       base_branch = excluded.base_branch,
       worktree_strategy = excluded.worktree_strategy,
       rules = excluded.rules,
       invitable_by = excluded.invitable_by,
       updated_at = excluded.updated_at`,
  )
    .bind(
      identity.account,
      handle,
      name,
      runner,
      repoUrl ?? null,
      workdir ?? null,
      baseBranch,
      worktreeStrategy,
      rules ?? null,
      invitableBy,
      now,
      now,
    )
    .run();
  const row = await c.env.DB.prepare(
    `SELECT owner_account, handle, name, runner, repo_url, workdir, base_branch,
            worktree_strategy, rules, invitable_by, created_at, updated_at
       FROM agent_profiles
      WHERE owner_account = ? AND handle = ?`,
  )
    .bind(identity.account, handle)
    .first<Parameters<typeof projectAgentProfileFromRow>[0]>();
  return c.json(projectAgentProfileFromRow(row!), 201);
});

app.post("/api/agent-profiles/:handle/runtime-token", requireBearer, async (c) => {
  const identity = c.get("identity");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "starting a project agent daemon requires the owner human account session"), 403);
  }
  const handle = c.req.param("handle");
  if (!NAME_RE.test(handle) || RESERVED_NAMES.includes(handle)) {
    return c.json(errorBody("bad_request", "valid project agent handle required"), 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT owner_account, handle, name, runner, repo_url, workdir, base_branch,
            worktree_strategy, rules, invitable_by, created_at, updated_at
       FROM agent_profiles
      WHERE owner_account = ? AND handle = ?`,
  )
    .bind(identity.account, handle)
    .first<Parameters<typeof projectAgentProfileFromRow>[0]>();
  if (!row) return c.json(errorBody("not_found", "project agent profile not found"), 404);
  const minted = await mintOrRotateProfileRuntimeToken(c.env.DB, { ownerAccount: identity.account, handle });
  if ("conflict" in minted) {
    return c.json(errorBody("conflict", "profile handle conflicts with an existing token or human handle"), 409);
  }
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "token.issue",
    resource: `token/${handle}`,
    metadata: { token_role: "agent" },
  });
  return c.json({ token: minted.token, profile: projectAgentProfileFromRow(row) }, 201);
});

app.get("/api/agent-profiles/invites", requireBearer, async (c) => {
  const identity = c.get("identity");
  if (identity.account == null) {
    return c.json(errorBody("forbidden", "listing project agent invites requires an account session"), 403);
  }
  const handle = c.req.query("handle") ?? null;
  if (handle !== null && !NAME_RE.test(handle)) {
    return c.json(errorBody("bad_request", "handle must be a valid agent/name token"), 400);
  }
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.channel_slug, i.owner_account, i.profile_handle, i.invited_by, i.invited_at,
            p.name, p.runner, p.repo_url, p.workdir, p.base_branch, p.worktree_strategy, p.rules, p.invitable_by
       FROM channel_agent_invites i
       JOIN agent_profiles p ON p.owner_account = i.owner_account AND p.handle = i.profile_handle
      WHERE i.owner_account = ?
        AND (? IS NULL OR i.profile_handle = ?)
        AND i.revoked_at IS NULL
      ORDER BY i.invited_at DESC, i.channel_slug`,
  )
    .bind(identity.account, handle, handle)
    .all<{
      id: number;
      channel_slug: string;
      owner_account: string;
      profile_handle: string;
      invited_by: string;
      invited_at: number;
      name: string;
      runner: string;
      repo_url: string | null;
      workdir: string | null;
      base_branch: string;
      worktree_strategy: string;
      rules: string | null;
      invitable_by: string;
    }>();
  return c.json({
    invites: (rows.results ?? []).map((row) => ({
      id: row.id,
      channel_slug: row.channel_slug,
      owner_account: row.owner_account,
      profile_handle: row.profile_handle,
      invited_by: row.invited_by,
      invited_at: row.invited_at,
      profile: {
        owner_account: row.owner_account,
        handle: row.profile_handle,
        name: row.name,
        runner: row.runner,
        repo_url: row.repo_url,
        workdir: row.workdir,
        base_branch: row.base_branch,
        worktree_strategy: row.worktree_strategy,
        rules: row.rules,
        invitable_by: row.invitable_by,
      },
    })),
  });
});

app.post("/api/channels/:slug/project-agents/runtime-token", requireBearer, async (c) => {
  const identity = c.get("identity");
  const slug = c.req.param("slug");
  if (identity.role !== "agent" || identity.account == null || identity.channel_scope != null) {
    return c.json(errorBody("forbidden", "project agent channel runtime requires an unscoped profile daemon token"), 403);
  }
  if (!SLUG_RE.test(slug)) {
    return c.json(errorBody("bad_request", "valid channel slug required"), 400);
  }
  const body = (await c.req.json().catch(() => null)) as { owner_account?: unknown; handle?: unknown; name?: unknown } | null;
  const ownerAccount = typeof body?.owner_account === "string" ? body.owner_account : "";
  const handle = typeof body?.handle === "string" ? body.handle : "";
  const childName = typeof body?.name === "string" ? body.name : "";
  if (!validAccountParam(ownerAccount) || !NAME_RE.test(handle) || !NAME_RE.test(childName)) {
    return c.json(errorBody("bad_request", "owner_account, handle, and child name are required"), 400);
  }
  if (identity.account !== ownerAccount || identity.name !== handle) {
    return c.json(errorBody("forbidden", "profile daemon token can only mint children for itself"), 403);
  }
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (channel.archived_at !== null) return c.json(errorBody("archived", "channel is archived"), 410);
  const profile = await c.env.DB.prepare(
    `SELECT owner_account, handle, name, runner, repo_url, workdir, base_branch,
            worktree_strategy, rules, invitable_by, created_at, updated_at
       FROM agent_profiles
      WHERE owner_account = ? AND handle = ?`,
  )
    .bind(ownerAccount, handle)
    .first<Parameters<typeof projectAgentProfileFromRow>[0]>();
  if (!profile) return c.json(errorBody("not_found", "project agent profile not found"), 404);
  const invite = await c.env.DB.prepare(
    `SELECT id
       FROM channel_agent_invites
      WHERE channel_slug = ?
        AND owner_account = ?
        AND profile_handle = ?
        AND revoked_at IS NULL`,
  )
    .bind(slug, ownerAccount, handle)
    .first<{ id: number }>();
  if (!invite) return c.json(errorBody("forbidden", "project agent profile is not invited to this channel"), 403);
  const minted = await mintOrRotateProfileChannelToken(c.env.DB, { ownerAccount, handle, channelScope: slug, childName });
  if ("conflict" in minted) {
    return c.json(errorBody("conflict", "child agent name conflicts with an existing identity"), 409);
  }
  try {
    await fetchChannelDO(
      c.env,
      slug,
      new Request("https://do/internal/kick", {
        method: "POST",
        body: JSON.stringify({ name: childName }),
        headers: { "content-type": "application/json", "x-partykit-room": slug },
      }),
    );
  } catch {
    // Best-effort takeover after daemon restart.
  }
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "token.issue",
    resource: `token/${childName}`,
    channel: slug,
    metadata: { token_role: "agent", channel_scope: slug },
  });
  return c.json(
    {
      token: minted.token,
      name: childName,
      role: "agent",
      owner: ownerAccount,
      channel_scope: slug,
      lineage: minted.lineage,
      profile: projectAgentProfileFromRow(profile),
    },
    201,
  );
});

app.get("/api/channels/:slug/agents", requireBearer, async (c) => {
  const identity = c.get("identity");
  const slug = c.req.param("slug");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "listing agent tokens requires a human account session"), 403);
  }
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const rows = await c.env.DB.prepare(
    `SELECT name, owner, channel_scope, created_at
       FROM tokens
      WHERE owner = ?
        AND role = 'agent'
        AND channel_scope = ?
        AND revoked_at IS NULL
        AND parent_agent IS NULL
      ORDER BY created_at DESC, name`,
  )
    .bind(identity.account, slug)
    .all<{ name: string; owner: string; channel_scope: string; created_at: number }>();
  return c.json({ agents: rows.results ?? [] });
});

app.post("/api/channels/:slug/agents/:name/rotate", requireBearer, async (c) => {
  const identity = c.get("identity");
  const slug = c.req.param("slug");
  const name = c.req.param("name");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "rotating agent tokens requires a human account session"), 403);
  }
  if (!NAME_RE.test(name) || RESERVED_NAMES.includes(name)) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const row = await c.env.DB.prepare(
    `SELECT id
       FROM tokens
      WHERE name = ?
        AND owner = ?
        AND role = 'agent'
        AND channel_scope = ?
        AND revoked_at IS NULL
        AND parent_agent IS NULL`,
  )
    .bind(name, identity.account, slug)
    .first<{ id: number }>();
  if (!row) return c.json(errorBody("not_found", "agent token not found"), 404);
  const nextToken = randomToken();
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE tokens
        SET hash = ?, created_at = ?
      WHERE id = ?`,
  )
    .bind(await sha256Hex(nextToken), now, row.id)
    .run();
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "token.issue",
    resource: `token/${name}`,
    channel: slug,
    timestamp: now,
    metadata: { token_role: "agent", channel_scope: slug },
  });
  const kicked = await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/kick", {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  )
    .then((res) => res.ok)
    .catch(() => false);
  return c.json({ token: nextToken, name, role: "agent", owner: identity.account, channel_scope: slug, created_at: now, kicked });
});

// Agent 子身份（#18 MVP）：父 agent 可在自己的频道 scope 内创建短期 child token。
// 不建 workflow DAG；只保证可验证的 parent/root/team/depth/expires_at 身份血缘与权限边界。
app.post("/api/spawn", requireBearer, async (c) => {
  const identity = c.get("identity");
  if (identity.role !== "agent" || identity.account == null || identity.channel_scope == null) {
    return c.json(
      errorBody("forbidden", "spawning child agents requires an account-owned channel-scoped agent token"),
      403,
    );
  }
  if (identity.lineage !== undefined) {
    return c.json(errorBody("forbidden", "child agents cannot spawn more child agents"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; channel_scope?: unknown; ttl_sec?: unknown; team_id?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name : "";
  if (!NAME_RE.test(name)) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  if (RESERVED_NAMES.includes(name)) {
    return c.json(errorBody("bad_request", "name is reserved"), 400);
  }
  const requestedScope = body?.channel_scope === undefined || body?.channel_scope === null ? identity.channel_scope : body.channel_scope;
  if (typeof requestedScope !== "string" || !SLUG_RE.test(requestedScope)) {
    return c.json(errorBody("bad_request", "channel_scope must be a valid channel slug"), 400);
  }
  if (requestedScope !== identity.channel_scope) {
    return c.json(errorBody("forbidden", "child agent must inherit the parent channel scope"), 403);
  }
  const channel = await loadChannel(c.env.DB, requestedScope);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const ttlSec =
    body?.ttl_sec === undefined || body?.ttl_sec === null
      ? SPAWN_DEFAULT_TTL_SEC
      : typeof body.ttl_sec === "number" && Number.isInteger(body.ttl_sec)
        ? body.ttl_sec
        : null;
  if (ttlSec === null || ttlSec < 60 || ttlSec > SPAWN_MAX_TTL_SEC) {
    return c.json(errorBody("bad_request", `ttl_sec must be an integer between 60 and ${SPAWN_MAX_TTL_SEC}`), 400);
  }
  const teamId = body?.team_id === undefined || body?.team_id === null ? identity.name : body.team_id;
  if (typeof teamId !== "string" || !NAME_RE.test(teamId)) {
    return c.json(errorBody("bad_request", "team_id must be a valid agent/name token"), 400);
  }
  const expiresAt = Date.now() + ttlSec * 1000;
  const lineage: AgentLineage = {
    parent_agent: identity.name,
    root_agent: identity.name,
    team_id: teamId,
    depth: 1,
    expires_at: expiresAt,
  };
  const result = await persistToken(c.env.DB, {
    name,
    role: "agent",
    owner: identity.account,
    channelScope: identity.channel_scope,
    lineage,
  });
  if ("conflict" in result) {
    return c.json(errorBody("conflict", "token name already exists, revoke it first"), 409);
  }
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "token.issue",
    resource: `token/${name}`,
    channel: identity.channel_scope,
    metadata: { token_role: "agent", channel_scope: identity.channel_scope },
  });
  return c.json(
    {
      token: result.token,
      name,
      role: "agent",
      owner: identity.account,
      channel_scope: identity.channel_scope,
      lineage,
      expires_at: expiresAt,
    },
    201,
  );
});

app.delete("/api/tokens/:name", requireAdmin, async (c) => {
  const name = c.req.param("name");
  const revoked = await c.env.DB.prepare(
    `UPDATE tokens
        SET revoked_at = ?
      WHERE name = ? AND revoked_at IS NULL
      RETURNING channel_scope, owner`,
  )
    .bind(Date.now(), name)
    .first<{ channel_scope: string | null; owner: string | null }>();
  if (revoked === null) {
    return c.json(errorBody("not_found", "no active token with that name"), 404);
  }
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditAdminActor,
    action: "token.revoke",
    resource: `token/${name}`,
    channel: revoked.channel_scope,
  });
  // 吊销即时生效：踢掉该 name 的存活 ws（spec §12）。#200：只踢该 token **可能持连接**的频道，
  // 而不是唤醒整个部署的每一个 DO（O(全部频道)、冷启动、149 频道时光扇出 8.3s、还是 #185 CI flaky 主因）。
  // 收窄按 token 类型（严格是「该 token 能访问的频道」的超集，即实际连接的超集，绝不漏踢）：
  //   - channel_scope 有值：scoped/guest token 只在那一个频道有效（acl.ts canAccessChannel）→ 只踢它。
  //   - 账号级 token：覆盖 canAccessChannel/canAccessLoadedChannel 的全部访问路径：
  //       public（对任何 token 开放，不能只看 channel_members）∪ 自己创建的（created_by=name，
  //       兜住 owner 为空的 token）∪ 账号房主（owner_account=account）∪ 成员（channel_members）
  //       ∪ 被邀请的 project-agent（channel_agent_invites，按 name=profile_handle）。
  const scopedSlugs = revoked.channel_scope
    ? await c.env.DB.prepare("SELECT slug FROM channels WHERE slug = ?").bind(revoked.channel_scope).all<{ slug: string }>()
    : await c.env.DB.prepare(
        `SELECT slug FROM channels
          WHERE visibility = 'public'
             OR created_by = ?2
             OR (?1 IS NOT NULL AND owner_account = ?1)
             OR (?1 IS NOT NULL AND slug IN (SELECT channel_slug FROM channel_members WHERE account = ?1))
             OR slug IN (SELECT channel_slug FROM channel_agent_invites WHERE profile_handle = ?2 AND revoked_at IS NULL)`,
      ).bind(revoked.owner, name).all<{ slug: string }>();
  const { results } = scopedSlugs;
  await Promise.all(
    results.map(async ({ slug }) => {
      try {
        await fetchChannelDO(
          c.env,
          slug,
          new Request("https://do/internal/kick", {
            method: "POST",
            body: JSON.stringify({ name }),
            headers: { "content-type": "application/json", "x-partykit-room": slug },
          }),
        );
      } catch {
        // do 实例被重置时连接已随之消失，踢线是尽力而为
      }
    }),
  );
  return c.json({ ok: true });
});

app.use("/api/channels", requireBearer);
app.use("/api/channels/*", requireBearer);

app.get("/api/channels/:slug/management-audit", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only channel owners or moderators can read management audit"), 403);
  }
  const pagination = parseManagementAuditPagination(new URL(c.req.url));
  if (pagination === null) {
    return c.json(errorBody("bad_request", "limit must be 1..100 and cursor must be valid for this audit scope"), 400);
  }
  const page = await listManagementAudit(c.env.DB, { ...pagination, channel: slug });
  if (page === null) return c.json(errorBody("bad_request", "cursor is unknown for this channel"), 400);
  return c.json(page);
});
app.use("/api/join/*", requireBearer);

app.get("/api/channels/:slug/lark-notify", async (c) => {
  const identity = c.get("identity");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "lark notifications require a human account session"), 403);
  }
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const row = await c.env.DB.prepare(
    `SELECT target_name, provider_id, provider_kind, created_at, updated_at
       FROM lark_notify_subscriptions
      WHERE channel_slug = ? AND account = ?`,
  )
    .bind(slug, identity.account)
    .first<{ target_name: string; provider_id: string; provider_kind: string; created_at: number; updated_at: number }>();
  return c.json({
    enabled: row !== null,
    channel_slug: slug,
    ...(row === null
      ? {}
      : {
          target_name: row.target_name,
          provider_id: row.provider_id,
          provider_kind: row.provider_kind,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }),
  });
});

app.post("/api/channels/:slug/lark-notify", async (c) => {
  const identity = c.get("identity");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "lark notifications require a human account session"), 403);
  }
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const profile = await c.env.DB.prepare(
    `SELECT handle, provider, provider_user_id
       FROM account_profiles
      WHERE account = ?`,
  )
    .bind(identity.account)
    .first<{ handle: string | null; provider: string | null; provider_user_id: string | null }>();
  if (!profile?.handle || !NAME_RE.test(profile.handle)) {
    return c.json(errorBody("forbidden", "set a profile handle before enabling lark notifications"), 403);
  }
  if (!profile.provider || !profile.provider_user_id) {
    return c.json(errorBody("forbidden", "sign in with Lark or Feishu before enabling notifications"), 403);
  }
  const provider = resolveLarkProvider(c.env, profile.provider);
  if (!provider || provider.id !== profile.provider) {
    return c.json(errorBody("unavailable", "lark provider is not configured"), 503);
  }
  const existing = await c.env.DB.prepare(
    "SELECT target_name FROM lark_notify_subscriptions WHERE channel_slug = ? AND account = ?",
  )
    .bind(slug, identity.account)
    .first<{ target_name: string }>();
  if (existing) {
    await fetchChannelDO(
      c.env,
      slug,
      new Request(`https://do/internal/webhooks?name=${encodeURIComponent(existing.target_name)}`, {
        method: "DELETE",
        headers: { "x-partykit-room": slug },
      }),
    ).catch(() => null);
  }
  const secret = randomToken();
  const relayUrl = new URL(c.req.url);
  relayUrl.pathname = "/api/integrations/lark/relay";
  relayUrl.search = "";
  const doRes = await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/webhooks", {
      method: "POST",
      body: JSON.stringify({
        name: profile.handle,
        url: relayUrl.toString().replace(/^http:/, "https:"),
        secret,
        filter: "mentions",
      }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  if (!doRes.ok) return doRes;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO lark_notify_subscriptions (
       channel_slug, account, target_name, provider_id, provider_kind,
       receive_id, receive_id_type, secret, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_slug, account) DO UPDATE SET
       target_name = excluded.target_name,
       provider_id = excluded.provider_id,
       provider_kind = excluded.provider_kind,
       receive_id = excluded.receive_id,
       receive_id_type = excluded.receive_id_type,
       secret = excluded.secret,
       updated_at = excluded.updated_at`,
  )
    .bind(
      slug,
      identity.account,
      profile.handle,
      provider.id,
      provider.kind,
      profile.provider_user_id,
      inferReceiveIdType(profile.provider_user_id),
      secret,
      existing ? now : now,
      now,
    )
    .run();
  return c.json({ enabled: true, channel_slug: slug, target_name: profile.handle, provider_id: provider.id }, 201);
});

app.delete("/api/channels/:slug/lark-notify", async (c) => {
  const identity = c.get("identity");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "lark notifications require a human account session"), 403);
  }
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const sub = await c.env.DB.prepare(
    "SELECT target_name FROM lark_notify_subscriptions WHERE channel_slug = ? AND account = ?",
  )
    .bind(slug, identity.account)
    .first<{ target_name: string }>();
  if (sub) {
    await fetchChannelDO(
      c.env,
      slug,
      new Request(`https://do/internal/webhooks?name=${encodeURIComponent(sub.target_name)}`, {
        method: "DELETE",
        headers: { "x-partykit-room": slug },
      }),
    ).catch(() => null);
    await c.env.DB.prepare("DELETE FROM lark_notify_subscriptions WHERE channel_slug = ? AND account = ?")
      .bind(slug, identity.account)
      .run();
  }
  return c.json({ enabled: false, channel_slug: slug });
});

// 频道列表默认只读 D1，避免每次列表刷新都按频道数 fan-out 到所有 ChannelDO。
// 调试/兼容场景可显式带 ?summary=1 拉「最近一条消息 + 参与者状态点」。
interface ChannelSummary {
  last: { sender: string; kind: string; body: string; ts: number } | null;
  presence: { name: string; state: string; note: string | null; ts: number }[];
}

app.get("/api/channels", async (c) => {
  const identity = c.get("identity");
  const includeSummary = c.req.query("summary") === "1" || c.req.query("summary") === "true";
  // created_by / owner_account 仅用于 ACL 判定，不回给客户端（保持列表响应契约不变）
  const { results } = await c.env.DB.prepare(
    `SELECT slug, title, topic, kind, mode, visibility, created_by, owner_account, created_at, archived_at,
            loop_guard_enabled, loop_guard_limit, workflow_guard_enabled, workflow_guard_limit, charter_rev
       FROM channels ORDER BY created_at, id`,
  ).all<{
    slug: string;
    visibility: string;
    created_by: string | null;
    owner_account: string | null;
    charter_rev: number;
    loop_guard_enabled: number;
    loop_guard_limit: number | null;
    workflow_guard_enabled: number;
    workflow_guard_limit: number;
  }>();
  // 防私有频道泄漏给粉丝（spec §5.5）：无权访问的私有频道连名字都不出现，summary 也不拉。
  // 账号房主 / 自己的 agent / scope 命中的 token / legacy token 照常看到对应私有频道。
  const memberSlugs =
    identity.account == null
      ? new Set<string>()
      : new Set(
          (await c.env.DB.prepare("SELECT channel_slug FROM channel_members WHERE account = ?")
            .bind(identity.account)
            .all<{ channel_slug: string }>()).results.map((row) => row.channel_slug),
        );
  const projectAgentInviteSlugs =
    identity.role !== "agent" || identity.account == null
      ? new Set<string>()
      : new Set(
          (await c.env.DB.prepare(
            `SELECT channel_slug
               FROM channel_agent_invites
              WHERE owner_account = ?
                AND profile_handle = ?
                AND revoked_at IS NULL`,
          )
            .bind(identity.account, identity.name)
            .all<{ channel_slug: string }>()).results.map((row) => row.channel_slug),
        );
  const visible = results.filter((row) => canAccessChannel(identity, row, memberSlugs.has(row.slug)) || projectAgentInviteSlugs.has(row.slug));
  const channels = await Promise.all(
    visible.map(async (full) => {
      // can_moderate：当前身份能否管理（转可见性/踢人/归档）。不回 owner 身份本身，只回布尔，
      // 前端据此决定渲不渲染可见性切换等管理控件（非 owner 不该看见会 403 的按钮）。
      const canModerate = isChannelModerator(identity, full);
      // owned/member：分类筛选用的布尔标记，不泄露 owner_account 本身。
      const owned = full.owner_account != null && full.owner_account === identity.account;
      const member = memberSlugs.has(full.slug);
      const { created_by, owner_account, ...row } = full;
      let summary: ChannelSummary = { last: null, presence: [] };
      if (includeSummary) {
        try {
          const res = await fetchChannelDO(
            c.env,
            row.slug,
            new Request("https://do/internal/summary", { headers: { "x-partykit-room": row.slug } }),
          );
          if (res.ok) summary = (await res.json()) as ChannelSummary;
        } catch {
          // do 不可达时列表仍可用，摘要降级为空
        }
      }
      return { ...row, can_moderate: canModerate, owned, member, last_message: summary.last, presence: summary.presence };
    }),
  );
  return c.json({ channels });
});

app.post("/api/channels", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { slug?: unknown; title?: unknown; kind?: unknown; mode?: unknown; visibility?: unknown }
    | null;
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const kind = body?.kind === undefined ? "standing" : body.kind;
  const mode = body?.mode === undefined ? "normal" : body.mode;
  // 默认 private = 零破坏（spec §3.1）
  const visibility = body?.visibility === undefined ? "private" : body.visibility;
  const title = typeof body?.title === "string" ? body.title : null;
  if (!SLUG_RE.test(slug) || typeof kind !== "string" || !KINDS.includes(kind)) {
    return c.json(errorBody("bad_request", "valid slug and kind (standing|temp) required"), 400);
  }
  if (typeof mode !== "string" || !MODES.includes(mode)) {
    return c.json(errorBody("bad_request", "mode must be normal or party"), 400);
  }
  if (typeof visibility !== "string" || !VISIBILITIES.includes(visibility)) {
    return c.json(errorBody("bad_request", "visibility must be public, private, or public_watch"), 400);
  }
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot create channels"), 403);
  }
  // channel-scoped token 只能创建它自己 scope 的那个频道（invite 先 mint scoped token 再建同名频道的正常路径，
  // 见 issue #31）：创建自己的 scope 不算逃出 scope。仍禁止建任意其它频道——外部方拿到 scoped token 越不了权，
  // 至多创建它被邀请的那一个 slug，且该 slug 已存在时是 409 no-op，不能以房主账号名义抢占别的 slug / 建 public。
  const createScope = c.get("identity").channel_scope;
  if (createScope != null && createScope !== slug) {
    return c.json(errorBody("forbidden", "channel-scoped token can only create its own scope channel"), 403);
  }
  const now = Date.now();
  const creator = c.get("identity");
  // #137 成本滥用 + #277 会员真门槛：每频道 = 一个 DO + 一行 D1。带账号的 token 受两道闸约束——
  //   owned 总量硬上限（quota_exceeded/403，free/member 分层）+ 滚动窗口创建限速（rate_limited/429，不分层）。
  // owned 计数含归档频道（archived_at 不为 null 也占 DO/D1），堵 create→archive→create 绕过。
  // legacy 无账号 token（account == null）不计入、不受限（fail-open，与建表处 owner_account=null 的过渡口径一致）；
  // 有账号但未开通会员的一律按 free 分层（loadMembership 无记录 => DEFAULT_MEMBERSHIP=free）。
  if (creator.account != null) {
    const membership = await loadMembership(c.env.DB, creator.account);
    const member = !hostedMembershipGating(c.env) || isMember(membership);
    const cap = member ? MAX_CHANNELS_PER_ACCOUNT : resolveFreeChannelCap(c.env);
    const windowStart = now - CHANNEL_CREATE_WINDOW_MS;
    const counts = await c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END), 0) AS recent
         FROM channels
        WHERE owner_account = ?2`,
    )
      .bind(windowStart, creator.account)
      .first<{ total: number; recent: number }>();
    const total = Number(counts?.total ?? 0);
    const recent = Number(counts?.recent ?? 0);
    if (total >= cap) {
      const hint = member ? "" : ` (free tier limit — ${MEMBERSHIP_UPGRADE_HINT})`;
      return c.json(
        errorBody("quota_exceeded", `account channel quota reached (max ${cap} channels per account)${hint}`),
        403,
      );
    }
    if (recent >= MAX_CHANNEL_CREATES_PER_WINDOW) {
      return c.json(
        errorBody(
          "rate_limited",
          `too many channels created recently (max ${MAX_CHANNEL_CREATES_PER_WINDOW} per hour)`,
        ),
        429,
      );
    }
  }
  try {
    await c.env.DB.prepare(
      "INSERT INTO channels (slug, title, kind, mode, visibility, created_by, owner_account, created_at, loop_guard_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
    )
      // created_by 记具体铸造者（审计）；owner_account = 创建者账号（ACL 依据）。
      // legacy token 无 account → owner_account = null（老频道，仅 legacy 过渡放行）。
      // loop_guard_enabled=1（#96）：新频道开箱即有熔断，否则两个 agent 可在无人值守下
      // 互相唤醒到天亮（唯一约束仅 30 msg/min）。limit 留空 → 回退 mode 默认 30/200。
      // 存量频道保持关闭：强开会立刻熔断正在工作的频道。房主可随时 PUT loop-guard 关闭。
      .bind(slug, title, kind, mode, visibility, creator.name, creator.account ?? null, now)
      .run();
  } catch {
    return c.json(errorBody("conflict", "slug already exists"), 409);
  }
  if (kind === "temp") {
    try {
      await fetchChannelDO(
        c.env,
        slug,
        new Request("https://do/internal/init", {
          method: "POST",
          headers: {
            "x-partykit-room": slug,
            ...channelHeaders({ kind, mode }, c.req.url),
          },
        }),
      );
    } catch {
      await c.env.DB.prepare("DELETE FROM channels WHERE slug = ? AND created_at = ?")
        .bind(slug, now)
        .run()
        .catch(() => null);
      return c.json(errorBody("unavailable", "temp channel initialization failed"), 503);
    }
  }
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(creator),
    action: "channel.create",
    resource: `channel/${slug}`,
    channel: slug,
    timestamp: now,
    metadata: { kind, mode, visibility },
  });
  return c.json({ slug, title, kind, mode, visibility }, 201);
});

app.post("/api/channels/:slug/project-agents", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const identity = c.get("identity");
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly sessions cannot invite project agents"), 403);
  }
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { owner_account?: unknown; handle?: unknown } | null;
  const ownerAccount = typeof body?.owner_account === "string" ? body.owner_account : "";
  const handle = typeof body?.handle === "string" ? body.handle : "";
  if (!validAccountParam(ownerAccount) || !NAME_RE.test(handle)) {
    return c.json(errorBody("bad_request", "owner_account and valid handle required"), 400);
  }
  const profile = await c.env.DB.prepare(
    `SELECT owner_account, handle, name, runner, repo_url, workdir, base_branch,
            worktree_strategy, rules, invitable_by, created_at, updated_at
       FROM agent_profiles
      WHERE owner_account = ? AND handle = ?`,
  )
    .bind(ownerAccount, handle)
    .first<Parameters<typeof projectAgentProfileFromRow>[0]>();
  if (!profile) return c.json(errorBody("not_found", "project agent profile not found"), 404);
  if (!canInviteProjectAgent(profile.invitable_by, identity.account, ownerAccount)) {
    return c.json(errorBody("forbidden", `this project agent can only be invited by ${profile.invitable_by}`), 403);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id, channel_slug, owner_account, profile_handle, invited_by, invited_at
       FROM channel_agent_invites
      WHERE channel_slug = ?
        AND owner_account = ?
        AND profile_handle = ?
        AND revoked_at IS NULL`,
  )
    .bind(slug, ownerAccount, handle)
    .first<{
      id: number;
      channel_slug: string;
      owner_account: string;
      profile_handle: string;
      invited_by: string;
      invited_at: number;
    }>();
  if (existing) {
    return c.json({ ...existing, profile: projectAgentProfileFromRow(profile), already_invited: true });
  }

  const invitedBy = identity.account ?? identity.name;
  const invitedAt = Date.now();
  const result = await c.env.DB.prepare(
    `INSERT INTO channel_agent_invites (channel_slug, owner_account, profile_handle, invited_by, invited_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(slug, ownerAccount, handle, invitedBy, invitedAt)
    .run();
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.project_agent.invite",
    resource: `channel/${slug}/project-agents/${ownerAccount}/${handle}`,
    channel: slug,
    timestamp: invitedAt,
  });
  return c.json(
    {
      id: result.meta.last_row_id,
      channel_slug: slug,
      owner_account: ownerAccount,
      profile_handle: handle,
      invited_by: invitedBy,
      invited_at: invitedAt,
      profile: projectAgentProfileFromRow(profile),
      already_invited: false,
    },
    201,
  );
});

app.delete("/api/channels/:slug/project-agents", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly sessions cannot remove project agents"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { owner_account?: unknown; handle?: unknown } | null;
  const ownerAccount = typeof body?.owner_account === "string" ? body.owner_account : "";
  const handle = typeof body?.handle === "string" ? body.handle : "";
  if (!validAccountParam(ownerAccount) || !NAME_RE.test(handle)) {
    return c.json(errorBody("bad_request", "owner_account and valid handle required"), 400);
  }
  if (identity.account !== ownerAccount && !isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the profile owner or channel moderator can remove a project agent"), 403);
  }
  const revokedAt = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE channel_agent_invites
        SET revoked_at = ?
      WHERE channel_slug = ?
        AND owner_account = ?
        AND profile_handle = ?
        AND revoked_at IS NULL`,
  )
    .bind(revokedAt, slug, ownerAccount, handle)
    .run();
  if (result.meta.changes === 0) {
    return c.json(errorBody("not_found", "active project agent invite not found"), 404);
  }
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.project_agent.remove",
    resource: `channel/${slug}/project-agents/${ownerAccount}/${handle}`,
    channel: slug,
    timestamp: revokedAt,
  });
  const childRows = await c.env.DB.prepare(
    `SELECT name
       FROM tokens
      WHERE owner = ?
        AND role = 'agent'
        AND channel_scope = ?
        AND parent_agent = ?
        AND revoked_at IS NULL`,
  )
    .bind(ownerAccount, slug, handle)
    .all<{ name: string }>();
  await c.env.DB.prepare(
    `UPDATE tokens
        SET revoked_at = ?
      WHERE owner = ?
        AND role = 'agent'
        AND channel_scope = ?
        AND parent_agent = ?
        AND revoked_at IS NULL`,
  )
    .bind(revokedAt, ownerAccount, slug, handle)
    .run();
  await Promise.all(
    (childRows.results ?? []).map(({ name }) =>
      bestEffortRecordManagementAudit(c.env.DB, {
        actor: managementAuditActor(identity),
        action: "token.revoke",
        resource: `token/${name}`,
        channel: slug,
        timestamp: revokedAt,
      }),
    ),
  );
  try {
    await Promise.all(
      [handle, ...(childRows.results ?? []).map((row) => row.name)].map((name) =>
        fetchChannelDO(
          c.env,
          slug,
          new Request("https://do/internal/kick", {
            method: "POST",
            body: JSON.stringify({ name }),
            headers: { "content-type": "application/json", "x-partykit-room": slug },
          }),
        ),
      ),
    );
  } catch {
    // Best effort: access is already revoked at the Worker ACL layer.
  }
  return c.json({ ok: true, channel_slug: slug, owner_account: ownerAccount, profile_handle: handle, revoked_at: revokedAt });
});

app.get("/api/channels/:slug/members", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canListMembers(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed to list channel members"), 403);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT account, added_by, added_at FROM channel_members WHERE channel_slug = ? ORDER BY account",
  )
    .bind(slug)
    .all<{ account: string; added_by: string; added_at: number }>();
  return c.json({ members: results });
});

app.get("/api/channels/:slug/lark-directory", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (identity.kind !== "human" || identity.account == null || !isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only a Lark human moderator can search the organization directory"), 403);
  }
  const profile = await c.env.DB.prepare(
    "SELECT provider, tenant_key FROM account_profiles WHERE account = ?",
  ).bind(identity.account).first<{ provider: string | null; tenant_key: string | null }>();
  const provider = profile?.provider == null
    ? undefined
    : parseAuthProviders(c.env).find((candidate) => candidate.id === profile.provider);
  if (provider === undefined || (provider.kind !== "lark" && provider.kind !== "feishu")) {
    return c.json(errorBody("forbidden", "only a Lark human moderator can search the organization directory"), 403);
  }
  if (profile?.tenant_key == null || provider.tenantKey == null || profile.tenant_key !== provider.tenantKey) {
    return c.json(errorBody("forbidden", "Lark tenant does not match the configured organization"), 403);
  }
  const url = new URL(c.req.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 20 : Number(limitRaw);
  const cursor = url.searchParams.get("cursor");
  if (!query || query.length > LARK_DIRECTORY_QUERY_MAX || !Number.isInteger(limit) || limit < 1 || limit > LARK_DIRECTORY_MAX_LIMIT || (cursor !== null && cursor.length > 1024)) {
    return c.json(errorBody("bad_request", "q, limit, or cursor is invalid"), 400);
  }
  const retryAfter = await consumeLarkDirectorySearchLimit(c.env.DB, identity.account);
  if (retryAfter > 0) {
    return c.json(errorBody("rate_limited", "too many Lark directory searches"), 429, { "retry-after": String(retryAfter) });
  }
  try {
    const page = await searchLarkDirectory(c.env, provider, query, cursor, limit);
    const profiles = await c.env.DB.prepare(
      "SELECT account, provider_user_id FROM account_profiles WHERE provider = ? AND tenant_key = ?",
    ).bind(provider.id, profile.tenant_key).all<{ account: string; provider_user_id: string | null }>();
    const knownAccounts = new Map(
      profiles.results.filter((row) => row.provider_user_id !== null).map((row) => [row.provider_user_id!, row.account]),
    );
    const members = new Set((await c.env.DB.prepare(
      "SELECT account FROM channel_members WHERE channel_slug = ?",
    ).bind(slug).all<{ account: string }>()).results.map((row) => row.account));
    return c.json({
      users: page.users.map((user) => {
        const account = knownAccounts.get(user.id) ?? directoryAccount(provider.id, user.id);
        return { id: user.id, name: user.name, avatar_url: user.avatarUrl, already_member: account !== null && members.has(account) };
      }),
      next_cursor: page.nextCursor,
    });
  } catch (error) {
    if (error instanceof LarkDirectoryError) {
      if (error.kind === "permission") return c.json(errorBody("lark_contact_permission_required", "Lark contact permission is not enabled"), 503);
      if (error.kind === "invalid_cursor") return c.json(errorBody("bad_request", "Lark directory cursor is invalid"), 400);
      if (error.kind === "rate_limited") return c.json(errorBody("unavailable", "Lark directory is rate limited"), 503);
    }
    return c.json(errorBody("unavailable", "Lark directory is unavailable"), 503);
  }
});

app.post("/api/channels/:slug/lark-members", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (identity.kind !== "human" || identity.account == null || !isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only a Lark human moderator can invite organization members"), 403);
  }
  const profile = await c.env.DB.prepare(
    "SELECT provider, tenant_key FROM account_profiles WHERE account = ?",
  ).bind(identity.account).first<{ provider: string | null; tenant_key: string | null }>();
  const provider = profile?.provider == null
    ? undefined
    : parseAuthProviders(c.env).find((candidate) => candidate.id === profile.provider);
  if (provider === undefined || (provider.kind !== "lark" && provider.kind !== "feishu") || profile?.tenant_key == null || provider.tenantKey !== profile.tenant_key) {
    return c.json(errorBody("forbidden", "Lark tenant does not match the configured organization"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { user_id?: unknown } | null;
  const userId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    return c.json(errorBody("bad_request", "valid Lark user_id required"), 400);
  }
  try {
    const user = await getLarkDirectoryUser(c.env, provider, userId);
    const known = await c.env.DB.prepare(
      `SELECT account FROM account_profiles
        WHERE provider = ? AND provider_user_id = ? AND tenant_key = ?
        LIMIT 1`,
    ).bind(provider.id, user.id, profile.tenant_key).first<{ account: string }>();
    const account = known?.account ?? directoryAccount(provider.id, user.id);
    if (account === null) return c.json(errorBody("bad_request", "unsupported Lark user id"), 400);
    await ensureDefaultHandle(c.env.DB, {
      account,
      email: null,
      displayName: user.name,
      avatarUrl: user.avatarUrl,
      avatarThumb: user.avatarUrl,
      provider: provider.id,
      providerUserId: user.id,
      tenantKey: profile.tenant_key,
    });
    const addedAt = Date.now();
    const inserted = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO channel_members (channel_slug, account, added_by, added_at) VALUES (?, ?, ?, ?)",
    ).bind(slug, account, identity.account, addedAt).run();
    const alreadyMember = inserted.meta.changes === 0;
    if (!alreadyMember) {
      await bestEffortRecordManagementAudit(c.env.DB, {
        actor: managementAuditActor(identity),
        action: "channel.member.add",
        resource: `channel/${slug}/members/${account}`,
        channel: slug,
        timestamp: addedAt,
      });
    }
    return c.json({ id: user.id, name: user.name, avatar_url: user.avatarUrl, already_member: alreadyMember }, alreadyMember ? 200 : 201);
  } catch (error) {
    if (error instanceof LarkDirectoryError) {
      if (error.kind === "permission") return c.json(errorBody("lark_contact_permission_required", "Lark contact permission is not enabled"), 503);
      if (error.kind === "not_found") return c.json(errorBody("not_found", "Lark user not found in this organization"), 404);
      if (error.kind === "rate_limited") return c.json(errorBody("unavailable", "Lark directory is rate limited"), 503);
    }
    return c.json(errorBody("unavailable", "Lark directory is unavailable"), 503);
  }
});

app.get("/api/channels/:slug/perms", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  return c.json({ permissions: channelPerms(channel) });
});

app.put("/api/channels/:slug/perms", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only channel moderators can change channel permissions"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null || Array.isArray(body)) {
    return c.json(errorBody("bad_request", "permission policy object required"), 400);
  }
  const patch = channelPermsPatch(body);
  if (patch === null) {
    return c.json(errorBody("bad_request", "invalid permission policy"), 400);
  }
  if (patch.sets.length > 0) {
    await c.env.DB.prepare(`UPDATE channels SET ${patch.sets.join(", ")} WHERE slug = ?`)
      .bind(...patch.values, slug)
      .run();
    await bestEffortRecordManagementAudit(c.env.DB, {
      actor: managementAuditActor(identity),
      action: "channel.permissions.update",
      resource: `channel/${slug}/permissions`,
      channel: slug,
      metadata: { permission_fields: Object.keys(body) },
    });
  }
  const updated = await loadChannel(c.env.DB, slug);
  return c.json({ permissions: channelPerms(updated ?? channel) });
});

app.put("/api/channels/:slug/members/:account", async (c) => {
  const slug = c.req.param("slug");
  const account = decodeURIComponent(c.req.param("account"));
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can add members"), 403);
  }
  if (!validAccountParam(account)) {
    return c.json(errorBody("bad_request", "valid account required"), 400);
  }
  const addedBy = identity.account ?? identity.name;
  const addedAt = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO channel_members (channel_slug, account, added_by, added_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_slug, account) DO UPDATE SET
       added_by = excluded.added_by,
       added_at = excluded.added_at`,
  )
    .bind(slug, account, addedBy, addedAt)
    .run();
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.member.add",
    resource: `channel/${slug}/members/${account}`,
    channel: slug,
    timestamp: addedAt,
  });
  return c.json({ account, added_by: addedBy, added_at: addedAt });
});

app.delete("/api/channels/:slug/members/:account", async (c) => {
  const slug = c.req.param("slug");
  const identity = c.get("identity");
  const rawAccount = decodeURIComponent(c.req.param("account"));
  const account = rawAccount === "me" ? identity.account : rawAccount;
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (account == null || !validAccountParam(account)) {
    return c.json(errorBody("bad_request", "valid account required"), 400);
  }
  if (account === channel.owner_account) {
    return c.json(errorBody("bad_request", "channel owner cannot be removed"), 400);
  }
  if (!isChannelModerator(identity, channel) && identity.account !== account) {
    return c.json(errorBody("forbidden", "only moderators can remove other members"), 403);
  }
  const removedAt = Date.now();
  const removed = await c.env.DB.prepare("DELETE FROM channel_members WHERE channel_slug = ? AND account = ?")
    .bind(slug, account)
    .run();
  if (removed.meta.changes > 0) {
    await bestEffortRecordManagementAudit(c.env.DB, {
      actor: managementAuditActor(identity),
      action: "channel.member.remove",
      resource: `channel/${slug}/members/${account}`,
      channel: slug,
      timestamp: removedAt,
    });
  }
  return c.json({ ok: true });
});

app.post("/api/channels/:slug/join-links", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage join links"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { expires_in_sec?: unknown; max_uses?: unknown } | null;
  const expiresInSec = body?.expires_in_sec === undefined || body?.expires_in_sec === null ? null : positiveInt(body.expires_in_sec);
  const maxUses = body?.max_uses === undefined || body?.max_uses === null ? null : positiveInt(body.max_uses);
  if (expiresInSec === null && body?.expires_in_sec !== undefined && body.expires_in_sec !== null) {
    return c.json(errorBody("bad_request", "expires_in_sec must be a positive integer"), 400);
  }
  if (maxUses === null && body?.max_uses !== undefined && body.max_uses !== null) {
    return c.json(errorBody("bad_request", "max_uses must be a positive integer"), 400);
  }
  const now = Date.now();
  const expiresAt = expiresInSec === null ? null : now + expiresInSec * 1000;
  let code = randomJoinCode();
  for (let i = 0; i < 3; i++) {
    try {
      const createdBy = identity.account ?? identity.name;
      await c.env.DB.prepare(
        `INSERT INTO channel_join_links (code, channel_slug, created_by, created_at, expires_at, max_uses, uses, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
      )
        .bind(code, slug, createdBy, now, expiresAt, maxUses)
        .run();
      await bestEffortRecordManagementAudit(c.env.DB, {
        actor: managementAuditActor(identity),
        action: "channel.join_link.create",
        resource: `channel/${slug}/join-links/${code}`,
        channel: slug,
        timestamp: now,
      });
      const url = new URL(c.req.url);
      return c.json(
        { code, url: `${url.origin}/join/${code}`, channel_slug: slug, created_by: createdBy, created_at: now, expires_at: expiresAt, max_uses: maxUses, uses: 0, revoked_at: null },
        201,
      );
    } catch {
      code = randomJoinCode();
    }
  }
  return c.json(errorBody("conflict", "could not allocate join link code"), 409);
});

app.get("/api/channels/:slug/join-links", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage join links"), 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT code, channel_slug, created_by, created_at, expires_at, max_uses, uses, revoked_at
       FROM channel_join_links
      WHERE channel_slug = ?
      ORDER BY created_at DESC`,
  )
    .bind(slug)
    .all();
  return c.json({ links: results });
});

app.delete("/api/channels/:slug/join-links/:code", async (c) => {
  const slug = c.req.param("slug");
  const code = c.req.param("code");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage join links"), 403);
  }
  const revokedAt = Date.now();
  const result = await c.env.DB.prepare(
    "UPDATE channel_join_links SET revoked_at = COALESCE(revoked_at, ?) WHERE code = ? AND channel_slug = ?",
  )
    .bind(revokedAt, code, slug)
    .run();
  if (result.meta.changes === 0) return c.json(errorBody("not_found", "join link not found"), 404);
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.join_link.revoke",
    resource: `channel/${slug}/join-links/${code}`,
    channel: slug,
    timestamp: revokedAt,
  });
  return c.json({ ok: true });
});

// 观看模式邀请（#186）：房主自助铸「频道内只读分享 token」，返回 /c/<slug>?t=<token> 围观链接。
// 复用现成 readonly 角色——发送在所有 seam 已被硬挡（do.handleSend / acl），不新造权限。
// 与 join-links（参与模式，成员制、需登录）平行：观看链接无需登录，点开即读、发送禁用。
// token 明文只在创建时回一次（表里只存 hash），故 GET 列表只能回 name/created_at，不能重现 URL。
app.post("/api/channels/:slug/share-links", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage watch links"), 403);
  }
  // owner 恒 = 房主账号（legacy admin token 无账号则回落 token 名，header-safe）；不取客户端值。
  const owner = identity.account ?? identity.name;
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const name = `watch_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const result = await persistToken(c.env.DB, { name, role: "readonly", owner, channelScope: slug });
    if ("conflict" in result) continue; // 撞名（极罕见）→ 换名重试
    await bestEffortRecordManagementAudit(c.env.DB, {
      actor: managementAuditActor(identity),
      action: "token.issue",
      resource: `token/${name}`,
      channel: slug,
      metadata: { token_role: "readonly", channel_scope: slug },
    });
    const url = new URL(c.req.url);
    return c.json(
      { token: result.token, name, role: "readonly", channel_scope: slug, url: `${url.origin}/c/${slug}?t=${result.token}`, created_at: now },
      201,
    );
  }
  return c.json(errorBody("conflict", "could not allocate watch link"), 409);
});

app.get("/api/channels/:slug/share-links", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage watch links"), 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT name, created_at
       FROM tokens
      WHERE channel_scope = ? AND role = 'readonly' AND revoked_at IS NULL
      ORDER BY created_at DESC`,
  )
    .bind(slug)
    .all();
  return c.json({ links: results });
});

app.delete("/api/channels/:slug/share-links/:name", async (c) => {
  const slug = c.req.param("slug");
  const name = c.req.param("name");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage watch links"), 403);
  }
  const result = await c.env.DB.prepare(
    "UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE name = ? AND channel_scope = ? AND role = 'readonly'",
  )
    .bind(Date.now(), name, slug)
    .run();
  if (result.meta.changes === 0) return c.json(errorBody("not_found", "watch link not found"), 404);
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "token.revoke",
    resource: `token/${name}`,
    channel: slug,
    metadata: { token_role: "readonly", channel_scope: slug },
  });
  return c.json({ ok: true });
});

app.post("/api/channels/:slug/join-requests", async (c) => {
  const identity = c.get("identity");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "join requests require a human account session"), 403);
  }
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (await isChannelMember(c.env.DB, slug, identity.account)) {
    return c.json({ state: "already_member" });
  }
  const body = (await c.req.json().catch(() => null)) as { watch_token?: unknown; note?: unknown } | null;
  const note = optionalBoundedText(body?.note, JOIN_REQUEST_NOTE_MAX);
  if (typeof body?.watch_token !== "string" || body.watch_token === "" || note === undefined) {
    return c.json(errorBody("bad_request", "watch_token and a valid note are required"), 400);
  }
  const now = Date.now();
  const watchHash = await sha256Hex(body.watch_token);
  const watch = await c.env.DB.prepare(
    `SELECT name
       FROM tokens
      WHERE hash = ?
        AND revoked_at IS NULL
        AND role = 'readonly'
        AND channel_scope = ?
        AND (child_expires_at IS NULL OR child_expires_at > ?)`,
  )
    .bind(watchHash, slug, now)
    .first<{ name: string }>();
  if (!watch) {
    return c.json(errorBody("bad_request", "watch_token is invalid for this channel"), 400);
  }

  const existing = await loadChannelJoinRequest(c.env.DB, slug, { account: identity.account });
  if (existing?.state === "pending") return c.json(channelJoinRequestFromRow(existing));
  if (existing?.state === "approved") {
    return c.json(errorBody("conflict", "join request is already approved"), 409);
  }
  const profile = await joinRequestProfileSnapshot(c.env.DB, identity.account);
  if (existing?.state === "rejected") {
    const updated = await c.env.DB.prepare(
      `UPDATE channel_join_requests
          SET requester_display = ?, requester_profile_json = ?, state = 'pending', note = ?,
              source_token_name = ?, requested_at = ?, reviewed_at = NULL, reviewed_by = NULL,
              review_reason = NULL
        WHERE id = ? AND slug = ? AND state = 'rejected'`,
    )
      .bind(profile.display, profile.json, note, watch.name, now, existing.id, slug)
      .run();
    if (updated.meta.changes > 0) {
      const request = await loadChannelJoinRequest(c.env.DB, slug, { id: existing.id });
      return c.json(channelJoinRequestFromRow(request!), 201);
    }
    const current = await loadChannelJoinRequest(c.env.DB, slug, { account: identity.account });
    if (current?.state === "pending") return c.json(channelJoinRequestFromRow(current));
    return c.json(errorBody("conflict", "join request changed while reapplying"), 409);
  }

  const id = `jr_${crypto.randomUUID().replaceAll("-", "")}`;
  const inserted = await c.env.DB.prepare(
    `INSERT INTO channel_join_requests (
       id, slug, account, requester_display, requester_profile_json, state, note,
       source_token_name, requested_at, reviewed_at, reviewed_by, review_reason
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT(slug, account) DO NOTHING`,
  )
    .bind(id, slug, identity.account, profile.display, profile.json, note, watch.name, now)
    .run();
  if (inserted.meta.changes === 0) {
    const current = await loadChannelJoinRequest(c.env.DB, slug, { account: identity.account });
    if (current?.state === "pending") return c.json(channelJoinRequestFromRow(current));
    return c.json(errorBody("conflict", "join request already exists"), 409);
  }
  const request = await loadChannelJoinRequest(c.env.DB, slug, { id });
  return c.json(channelJoinRequestFromRow(request!), 201);
});

app.get("/api/channels/:slug/join-requests/me", async (c) => {
  const identity = c.get("identity");
  if (identity.role !== "human" || identity.account == null) {
    return c.json(errorBody("forbidden", "join requests require a human account session"), 403);
  }
  const slug = c.req.param("slug");
  if (!(await loadChannel(c.env.DB, slug))) return c.json(errorBody("not_found", "channel not found"), 404);
  const request = await loadChannelJoinRequest(c.env.DB, slug, { account: identity.account });
  return c.json({ request: request === null ? null : channelJoinRequestFromRow(request) });
});

app.get("/api/channels/:slug/join-requests", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only channel moderators can list join requests"), 403);
  }
  if (new URL(c.req.url).searchParams.get("state") !== "pending") {
    return c.json(errorBody("bad_request", "state=pending is required"), 400);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, account, requester_display, requester_profile_json, state, note,
            source_token_name, requested_at, reviewed_at, reviewed_by, review_reason
       FROM channel_join_requests
      WHERE slug = ? AND state = 'pending'
      ORDER BY requested_at ASC, id ASC`,
  )
    .bind(slug)
    .all<ChannelJoinRequestRow>();
  return c.json({ requests: results.map(channelJoinRequestFromRow) });
});

app.post("/api/channels/:slug/join-requests/:id/review", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only channel moderators can review join requests"), 403);
  }
  if (channel.archived_at !== null) return c.json(errorBody("archived", "channel is archived"), 410);
  const id = c.req.param("id");
  const request = await loadChannelJoinRequest(c.env.DB, slug, { id });
  if (!request) return c.json(errorBody("not_found", "join request not found"), 404);
  if (request.state !== "pending") {
    return c.json(errorBody("conflict", "join request is already final"), 409);
  }
  const body = (await c.req.json().catch(() => null)) as { action?: unknown; reason?: unknown } | null;
  if (body?.action !== "approve" && body?.action !== "reject") {
    return c.json(errorBody("bad_request", "action must be approve or reject"), 400);
  }
  const reason = optionalBoundedText(body.reason, JOIN_REQUEST_REASON_MAX);
  if (reason === undefined || (body.action === "reject" && reason === null)) {
    return c.json(errorBody("bad_request", "a valid reason is required when rejecting"), 400);
  }
  const reviewedAt = Date.now();
  const reviewedBy = identity.account ?? identity.name;
  let changed = 0;
  if (body.action === "approve") {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE channel_join_requests
            SET state = 'approved', reviewed_at = ?, reviewed_by = ?, review_reason = NULL
          WHERE id = ? AND slug = ? AND state = 'pending'`,
      ).bind(reviewedAt, reviewedBy, id, slug),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO channel_members (channel_slug, account, added_by, added_at)
         SELECT slug, account, ?, ?
           FROM channel_join_requests
          WHERE id = ? AND slug = ? AND state = 'approved' AND reviewed_at = ? AND reviewed_by = ?`,
      ).bind(reviewedBy, reviewedAt, id, slug, reviewedAt, reviewedBy),
    ]);
    changed = results[0]?.meta.changes ?? 0;
  } else {
    const result = await c.env.DB.prepare(
      `UPDATE channel_join_requests
          SET state = 'rejected', reviewed_at = ?, reviewed_by = ?, review_reason = ?
        WHERE id = ? AND slug = ? AND state = 'pending'`,
    )
      .bind(reviewedAt, reviewedBy, reason, id, slug)
      .run();
    changed = result.meta.changes;
  }
  if (changed === 0) return c.json(errorBody("conflict", "join request is already final"), 409);
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: body.action === "approve" ? "channel.join_request.approve" : "channel.join_request.reject",
    resource: `channel/${slug}/join-requests/${id}`,
    channel: slug,
    timestamp: reviewedAt,
  });
  const reviewed = await loadChannelJoinRequest(c.env.DB, slug, { id });
  return c.json(channelJoinRequestFromRow(reviewed!));
});

app.post("/api/join/:code", async (c) => {
  const identity = c.get("identity");
  // 判据是 role，不是 hash 前缀：`oidc:` 前缀只有 OIDC JWT 身份才有（auth.ts），
  // Lark/Feishu 换码铸的是 D1 human token（hash 是普通 sha256），曾被误判成非人类一律 403。
  // agent（role=agent）与只读分享 token（role=readonly）依然进不来，闸门不放宽。
  if (identity.role !== "human") {
    return c.json(
      errorBody("forbidden", "join links are for human identities; agents should use the party-invite onboarding package"),
      403,
    );
  }
  if (identity.account == null) {
    return c.json(errorBody("forbidden", "join links require an account identity"), 403);
  }
  const code = c.req.param("code");
  const now = Date.now();
  const link = await c.env.DB.prepare(
    "SELECT code, channel_slug, expires_at, max_uses, uses, revoked_at FROM channel_join_links WHERE code = ?",
  )
    .bind(code)
    .first<{ code: string; channel_slug: string; expires_at: number | null; max_uses: number | null; uses: number; revoked_at: number | null }>();
  if (!link) return c.json(errorBody("not_found", "join link not found"), 404);
  if (link.revoked_at !== null) return c.json(errorBody("not_found", "join link has been revoked"), 410);
  if (link.expires_at !== null && link.expires_at <= now) return c.json(errorBody("not_found", "join link has expired"), 410);
  if (link.max_uses !== null && link.uses >= link.max_uses) {
    return c.json(errorBody("not_found", "join link has reached its max uses"), 410);
  }
  const addedBy = `join-link:${code.slice(0, 8)}`;
  const inserted = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO channel_members (channel_slug, account, added_by, added_at) VALUES (?, ?, ?, ?)",
  )
    .bind(link.channel_slug, identity.account, addedBy, now)
    .run();
  if (inserted.meta.changes === 0) {
    return c.json({ channel_slug: link.channel_slug, joined: false });
  }
  const counted = await c.env.DB.prepare(
    `UPDATE channel_join_links
        SET uses = uses + 1
      WHERE code = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND (max_uses IS NULL OR uses < max_uses)`,
  )
    .bind(code, now)
    .run();
  if (counted.meta.changes === 0) {
    await c.env.DB.prepare("DELETE FROM channel_members WHERE channel_slug = ? AND account = ? AND added_by = ?")
      .bind(link.channel_slug, identity.account, addedBy)
      .run();
    return c.json(errorBody("not_found", "join link has reached its max uses"), 410);
  }
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.member.add",
    resource: `channel/${link.channel_slug}/members/${identity.account}`,
    channel: link.channel_slug,
    timestamp: now,
  });
  return c.json({ channel_slug: link.channel_slug, joined: true });
});

app.put("/api/channels/:slug/visibility", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can change visibility"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { visibility?: unknown; confirm?: unknown } | null;
  const visibility = typeof body?.visibility === "string" ? body.visibility : "";
  if (!VISIBILITIES.includes(visibility)) {
    return c.json(errorBody("bad_request", "visibility must be public, private, or public_watch"), 400);
  }
  if (visibility === channel.visibility) {
    return c.json({ visibility, changed: false });
  }
  // #381：private→(public | public_watch) 都会把私有历史暴露给任意观看者，故同样要二段确认。
  if (channel.visibility === "private" && (visibility === "public" || visibility === "public_watch") && body?.confirm !== true) {
    const stats = await channelMessageStats(c.env, slug);
    return c.json(
      { needs_confirm: true, message_count: stats.message_count, earliest_ts: stats.earliest_ts },
      409,
    );
  }
  const now = Date.now();
  await c.env.DB.prepare("UPDATE channels SET visibility = ? WHERE slug = ?")
    .bind(visibility, slug)
    .run();
  // #381：把新可见性权威推给 DO（同 guard PUT 的 /internal/init 手法），立即刷新缓存的 visibility meta，
  // 让已挂着的 WS 连接的后续发送也按新档判写门（否则要等下一次带 channelHeaders 的请求才生效）。
  await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/init", {
      method: "POST",
      headers: { "x-partykit-room": slug, ...channelHeaders({ ...channel, visibility }, c.req.url) },
    }),
  );
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.visibility.update",
    resource: `channel/${slug}/visibility`,
    channel: slug,
    timestamp: now,
    metadata: { visibility },
  });
  const ok = await insertSystemStatus(c.env, slug, `visibility changed to ${visibility} by ${identity.name}`, "waiting", now);
  if (!ok) return c.json(errorBody("unavailable", "visibility changed but audit status failed"), 503);
  const recentSpeakers =
    visibility === "private" ? await recentNonMemberSpeakers(c.env.DB, c.env, slug, channel.owner_account) : [];
  return c.json({
    visibility,
    changed: true,
    ...(visibility === "private" ? { recent_non_member_speakers: recentSpeakers } : {}),
  });
});

app.get("/api/channels/:slug/charter", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  return c.json({
    charter: channel.charter,
    charter_rev: channel.charter_rev,
    updated_at: channel.charter_updated_at,
    updated_by: channel.charter_updated_by,
    permissions: channelPerms(channel),
  });
});

app.put("/api/channels/:slug/charter", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canEditCharter(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "only channel moderators or hosts can edit the charter"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as { charter?: unknown; expected_rev?: unknown } | null;
  if (typeof body?.charter !== "string") {
    return c.json(errorBody("bad_request", "charter must be a string"), 400);
  }
  if (textEncoder.encode(body.charter).byteLength > CHARTER_LIMIT) {
    return c.json(
      errorBody("too_large", "charter is a pointer document; keep it <= 16KB and link longer repo/docs content"),
      413,
    );
  }
  const expectedRev =
    body.expected_rev === undefined
      ? undefined
      : typeof body.expected_rev === "number" && Number.isInteger(body.expected_rev) && body.expected_rev >= 0
        ? body.expected_rev
        : null;
  if (expectedRev === null) {
    return c.json(errorBody("bad_request", "expected_rev must be a non-negative integer"), 400);
  }
  const now = Date.now();
  const updatedBy = identity.name;
  const result =
    expectedRev === undefined
      ? await c.env.DB.prepare(
          `UPDATE channels
              SET charter = ?, charter_rev = charter_rev + 1, charter_updated_at = ?, charter_updated_by = ?
            WHERE slug = ?`,
        )
          .bind(body.charter, now, updatedBy, slug)
          .run()
      : await c.env.DB.prepare(
          `UPDATE channels
              SET charter = ?, charter_rev = charter_rev + 1, charter_updated_at = ?, charter_updated_by = ?
            WHERE slug = ? AND charter_rev = ?`,
        )
          .bind(body.charter, now, updatedBy, slug, expectedRev)
          .run();
  if (result.meta.changes === 0) {
    return c.json(errorBody("conflict", "charter_rev changed; refetch and retry"), 409);
  }
  const updated = await loadChannel(c.env.DB, slug);
  const rev = updated?.charter_rev ?? channel.charter_rev + 1;
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/charter-rev", {
      method: "POST",
      body: JSON.stringify({ rev, updated_by: updatedBy, ts: now }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  if (!res.ok) return c.json(errorBody("unavailable", "charter updated but audit status failed"), 503);
  return c.json({
    charter: updated?.charter ?? body.charter,
    charter_rev: rev,
    updated_at: now,
    updated_by: updatedBy,
    permissions: channelPerms(updated ?? channel),
  });
});

app.get("/api/channels/:slug/messages", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // 防粉丝用 REST 绕过 WS 读私有频道历史（spec §3.2）
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const search = new URL(c.req.url).search;
  return fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/messages${search}`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/presence", async (c) => {
  // party who：从终端看谁在线/可唤醒/最近（分档由 CLI 做）。与 messages 同样的 ACL 门，防粉丝窥私有频道。
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  return fetchChannelDO(c.env, slug, new Request("https://do/internal/presence", { headers: { "x-partykit-room": slug } }));
});

app.get("/api/channels/:slug/loop-guard", async (c) => {
  // #174 loop guard 读路径：熔断前就能读 limit/streak/remaining。与 presence 同样的 ACL 门。
  // 传 channelHeaders 让 DO 用 D1 权威刷新 enabled/limit，再叠上它自己的 streak。
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  return fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/guard", {
      headers: { "x-partykit-room": slug, ...channelHeaders(channel, c.req.url) },
    }),
  );
});

app.get("/api/channels/:slug/identities", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const identities = new Map<string, { name: string; kind?: "agent" | "human"; account?: string; display: string; handle?: string }>();
  const add = (identity: { name: string; kind?: "agent" | "human"; account?: string; display?: string; handle?: string | null }) => {
    const prev = identities.get(identity.name);
    const kind = identity.kind ?? prev?.kind;
    const account = identity.account ?? prev?.account;
    const handle = typeof identity.handle === "string" && identity.handle !== "" ? identity.handle : prev?.handle;
    const explicitDisplay = typeof identity.display === "string" && identity.display !== "" ? identity.display : undefined;
    identities.set(identity.name, {
      name: identity.name,
      ...(kind === undefined ? {} : { kind }),
      ...(account === undefined ? {} : { account }),
      ...(handle === undefined ? {} : { handle }),
      display: explicitDisplay ?? (kind === "human" && account ? account : (prev?.display ?? identity.name)),
    });
  };

  if (channel.created_by && channel.owner_account && isOpaqueHumanSessionName(channel.created_by)) {
    add({ name: channel.created_by, kind: "human", account: channel.owner_account });
  }

  const res = await fetchChannelDO(c.env, slug, new Request("https://do/internal/identities", { headers: { "x-partykit-room": slug } }));
  if (res.ok) {
    const data = (await res.json()) as { identities?: { name: string; kind?: "agent" | "human"; account?: string }[] };
    for (const identity of data.identities ?? []) {
      if (typeof identity.name === "string" && identity.name !== "") add(identity);
    }
  }

  const humanAccounts = new Set(
    [...identities.values()]
      .filter((identity) => identity.kind === "human" && identity.account !== undefined)
      .map((identity) => identity.account!),
  );
  for (const account of humanAccounts) {
    const profile = await c.env.DB.prepare(
      `SELECT handle, display_name
         FROM account_profiles
        WHERE account = ?`,
    )
      .bind(account)
      .first<{ handle: string | null; display_name: string | null }>();
    const handle = profile?.handle || null;
    const display = handle || profile?.display_name || null;
    if (display === null) continue;
    for (const identity of identities.values()) {
      if (identity.kind === "human" && identity.account === account) add({ ...identity, display, handle });
    }
  }

  return c.json({ identities: [...identities.values()].sort((a, b) => a.name.localeCompare(b.name)) });
});

app.get("/api/channels/:slug/search", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const q = new URL(c.req.url).searchParams.get("q");
  if (q === null || q.trim() === "") {
    return c.json(errorBody("bad_request", "q required"), 400);
  }
  const search = new URL(c.req.url).search;
  return fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/search${search}`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/wake-deliveries", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const search = new URL(c.req.url).search;
  return fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/wake-deliveries${search}`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

// #108 per-agent wake 预算 inspect：任何能访问频道的成员可读某 agent 的窗口内 used/remaining。
app.get("/api/channels/:slug/wake-budget/:name", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const name = c.req.param("name");
  if (!name || name.length > 256) return c.json(errorBody("bad_request", "valid name required"), 400);
  return fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/wake-budget/${encodeURIComponent(name)}`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

// #108 set：agent 给自己设（自我节流 wake），或 moderator 给任意 agent 设/清（硬上限，超额 @ 不再烧订阅）。
app.put("/api/channels/:slug/wake-budget/:name", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const name = c.req.param("name");
  if (!name || name.length > 256) return c.json(errorBody("bad_request", "valid name required"), 400);
  const identity = c.get("identity");
  const isSelf =
    identity.kind === "agent" && identity.name === name && (await canAccessLoadedChannel(c.env.DB, identity, channel));
  if (!isSelf && !isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the agent itself or a channel moderator can set a wake budget"), 403);
  }
  const body = await c.req.json().catch(() => null);
  return fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/wake-budget/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(body ?? {}),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/read-cursors", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  return fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/read-cursors", {
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/squads", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM channel_squads
      WHERE channel_slug = ?
      ORDER BY name COLLATE NOCASE ASC`,
  )
    .bind(slug)
    .all<SquadRow>();
  return c.json({ squads: results.map(squadRowToRecord) });
});

app.get("/api/channels/:slug/squads/:name", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const name = c.req.param("name").replace(/^@/, "");
  if (!NAME_RE.test(name)) return c.json(errorBody("bad_request", "squad name must be a valid name"), 400);
  const row = await loadSquadRow(c.env.DB, slug, name);
  if (!row) return c.json(errorBody("not_found", "squad not found"), 404);
  return c.json(squadRowToRecord(row));
});

app.post("/api/channels/:slug/squads", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly token cannot create squads"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim().replace(/^@/, "") : "";
  if (!NAME_RE.test(name) || name === "system") {
    return c.json(errorBody("bad_request", "name must be a valid squad name"), 400);
  }
  const title = body?.title === undefined || body?.title === null ? null : typeof body.title === "string" ? body.title.trim() : undefined;
  if (title === undefined || (title !== null && textEncoder.encode(title).byteLength > SQUAD_TITLE_MAX)) {
    return c.json(errorBody("bad_request", `title must be null or <= ${SQUAD_TITLE_MAX} bytes`), 400);
  }
  const description = body?.description === undefined || body?.description === null ? null : typeof body.description === "string" ? body.description : undefined;
  if (description === undefined || (description !== null && textEncoder.encode(description).byteLength > SQUAD_DESCRIPTION_MAX)) {
    return c.json(errorBody("bad_request", `description must be null or <= ${SQUAD_DESCRIPTION_MAX} bytes`), 400);
  }
  const members = parseSquadMembers(body?.members);
  if (members === null || members.length === 0) {
    return c.json(errorBody("bad_request", `members must be 1..${SQUAD_MEMBERS_MAX} valid names`), 400);
  }
  const leader = parseSquadLeader(body?.leader);
  if (leader === undefined) return c.json(errorBody("bad_request", "leader must be null or a valid name"), 400);
  if (leader !== null && !members.includes(leader)) members.unshift(leader);
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO channel_squads (
         channel_slug, name, title, description, leader_name, members_json,
         created_by, created_by_kind, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(slug, name, title, description, leader, JSON.stringify(members), identity.name, identity.kind, now, now)
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return c.json(errorBody("conflict", "squad already exists"), 409);
    throw error;
  }
  const row = await loadSquadRow(c.env.DB, slug, name);
  await insertSystemStatus(c.env, slug, `squad @${name} created`, "waiting").catch(() => false);
  return c.json(squadRowToRecord(row!), 201);
});

app.patch("/api/channels/:slug/squads/:name", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly token cannot update squads"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const name = c.req.param("name").replace(/^@/, "");
  if (!NAME_RE.test(name)) return c.json(errorBody("bad_request", "squad name must be a valid name"), 400);
  const existing = await loadSquadRow(c.env.DB, slug, name);
  if (!existing) return c.json(errorBody("not_found", "squad not found"), 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json(errorBody("bad_request", "json body required"), 400);
  const title = body.title === undefined ? existing.title : body.title === null ? null : typeof body.title === "string" ? body.title.trim() : undefined;
  if (title === undefined || (title !== null && textEncoder.encode(title).byteLength > SQUAD_TITLE_MAX)) {
    return c.json(errorBody("bad_request", `title must be null or <= ${SQUAD_TITLE_MAX} bytes`), 400);
  }
  const description =
    body.description === undefined ? existing.description : body.description === null ? null : typeof body.description === "string" ? body.description : undefined;
  if (description === undefined || (description !== null && textEncoder.encode(description).byteLength > SQUAD_DESCRIPTION_MAX)) {
    return c.json(errorBody("bad_request", `description must be null or <= ${SQUAD_DESCRIPTION_MAX} bytes`), 400);
  }
  const members = body.members === undefined ? squadRowToRecord(existing).members : parseSquadMembers(body.members);
  if (members === null || members.length === 0) {
    return c.json(errorBody("bad_request", `members must be 1..${SQUAD_MEMBERS_MAX} valid names`), 400);
  }
  const parsedLeader = parseSquadLeader(body.leader);
  if (parsedLeader === undefined && Object.prototype.hasOwnProperty.call(body, "leader")) {
    return c.json(errorBody("bad_request", "leader must be null or a valid name"), 400);
  }
  const leader = parsedLeader === undefined ? existing.leader_name : parsedLeader;
  if (leader !== null && !members.includes(leader)) members.unshift(leader);
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE channel_squads
        SET title = ?, description = ?, leader_name = ?, members_json = ?, updated_at = ?
      WHERE channel_slug = ? AND name = ?`,
  )
    .bind(title, description, leader, JSON.stringify(members), now, slug, name)
    .run();
  const row = await loadSquadRow(c.env.DB, slug, name);
  await insertSystemStatus(c.env, slug, `squad @${name} updated`, "waiting").catch(() => false);
  return c.json(squadRowToRecord(row!));
});

app.delete("/api/channels/:slug/squads/:name", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly token cannot delete squads"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const name = c.req.param("name").replace(/^@/, "");
  if (!NAME_RE.test(name)) return c.json(errorBody("bad_request", "squad name must be a valid name"), 400);
  const existing = await loadSquadRow(c.env.DB, slug, name);
  if (!existing) return c.json(errorBody("not_found", "squad not found"), 404);
  await c.env.DB.prepare("DELETE FROM channel_squads WHERE channel_slug = ? AND name = ?")
    .bind(slug, name)
    .run();
  await insertSystemStatus(c.env, slug, `squad @${name} deleted`, "waiting").catch(() => false);
  return c.json({ ok: true, squad: squadRowToRecord(existing) });
});

app.get("/api/channels/:slug/tasks", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const url = new URL(c.req.url);
  const state = url.searchParams.get("state");
  if (state !== null && !TASK_STATES.includes(state)) {
    return c.json(errorBody("bad_request", "state must be triage|backlog|assigned|in_progress|needs_review|done|blocked"), 400);
  }
  const assignee = url.searchParams.get("assignee");
  if (assignee !== null && !NAME_RE.test(assignee.replace(/^@/, ""))) {
    return c.json(errorBody("bad_request", "assignee must be a valid name"), 400);
  }
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return c.json(errorBody("bad_request", "limit must be 1..500"), 400);
  }
  const clauses = ["channel_slug = ?"];
  const bindings: unknown[] = [slug];
  if (state !== null) {
    clauses.push("state = ?");
    bindings.push(state);
  }
  if (assignee !== null) {
    clauses.push("assignee_name = ?");
    bindings.push(assignee.replace(/^@/, ""));
  }
  bindings.push(limit);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM channel_tasks WHERE ${clauses.join(" AND ")} ORDER BY
      CASE state
        WHEN 'blocked' THEN 0
        WHEN 'needs_review' THEN 1
        WHEN 'in_progress' THEN 2
        WHEN 'assigned' THEN 3
        WHEN 'triage' THEN 4
        WHEN 'backlog' THEN 5
        ELSE 6
      END,
      priority DESC,
      updated_at DESC,
      id DESC
     LIMIT ?`,
  )
    .bind(...bindings)
    .all<TaskRow>();
  return c.json({ tasks: results.map(taskRowToRecord) });
});

app.get("/api/channels/:slug/tasks/summary", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  return c.json(await loadTaskSummary(c.env.DB, slug, identity.name));
});

app.get("/api/channels/:slug/tasks/:id", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const id = positiveInt(Number(c.req.param("id")));
  if (id === null) return c.json(errorBody("bad_request", "id must be a positive integer"), 400);
  const row = await loadTaskRow(c.env.DB, slug, id);
  if (!row) return c.json(errorBody("not_found", "task not found"), 404);
  return c.json(taskRowToRecord(row));
});

app.post("/api/channels/:slug/tasks", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly token cannot create tasks"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const desc = typeof body?.desc === "string" ? body.desc : typeof body?.description === "string" ? body.description : null;
  if (title === "" || textEncoder.encode(title).byteLength > TASK_TITLE_MAX) {
    return c.json(errorBody("bad_request", `title must be a non-empty string <= ${TASK_TITLE_MAX} bytes`), 400);
  }
  if (desc !== null && textEncoder.encode(desc).byteLength > TASK_DESC_MAX) {
    return c.json(errorBody("bad_request", `description must be <= ${TASK_DESC_MAX} bytes`), 400);
  }
  const requestedState = typeof body?.state === "string" ? body.state : null;
  if (requestedState !== null && !TASK_STATES.includes(requestedState)) {
    return c.json(errorBody("bad_request", "state must be triage|backlog|assigned|in_progress|needs_review|done|blocked"), 400);
  }
  const assignee = parseTaskAssignee(body?.assignee);
  if (assignee === undefined && body !== null && Object.prototype.hasOwnProperty.call(body, "assignee")) {
    return c.json(errorBody("bad_request", "assignee must be null or {name, kind: agent|human|squad}"), 400);
  }
  if (assignee?.kind === "squad" && !(await loadSquadRow(c.env.DB, slug, assignee.name))) {
    return c.json(errorBody("not_found", "assignee squad not found in this channel"), 404);
  }
  const labels = parseTaskLabels(body?.labels);
  if (labels === null) {
    return c.json(errorBody("bad_request", `labels must be <= ${TASK_LABELS_MAX} valid name tokens`), 400);
  }
  const anchorSeqs = parseTaskAnchors(body?.anchor_seqs);
  if (anchorSeqs === null) return c.json(errorBody("bad_request", "anchor_seqs must be positive integer array"), 400);
  const scope = parseTaskScope(body?.scope);
  if (scope === null) {
    return c.json(errorBody("bad_request", `scope must be <= ${TASK_SCOPE_MAX} non-empty strings, each <= ${TASK_SCOPE_ITEM_MAX} bytes`), 400);
  }
  const blockedReason = body?.blocked_reason === undefined ? null : parseTaskBlockedReason(body.blocked_reason);
  if (blockedReason === false) {
    return c.json(errorBody("bad_request", `blocked_reason must be null or a string <= ${TASK_BLOCKED_REASON_MAX} bytes`), 400);
  }
  // #141 external_ref：可选外部引用键，供 issue→task 同步做幂等 create。undefined/null → 不去重（今天的默认行为）。
  const externalRef = body?.external_ref === undefined ? null : parseTaskExternalRef(body.external_ref);
  if (externalRef === false) {
    return c.json(errorBody("bad_request", `external_ref must be null or a non-empty printable string <= ${TASK_EXTERNAL_REF_MAX} bytes`), 400);
  }
  const priority = body?.priority === undefined ? 0 : typeof body?.priority === "number" && Number.isInteger(body.priority) ? body.priority : null;
  if (priority === null || priority < -100 || priority > 100) {
    return c.json(errorBody("bad_request", "priority must be an integer between -100 and 100"), 400);
  }
  const parentId = body?.parent_id === undefined || body?.parent_id === null ? null : positiveInt(body.parent_id);
  if (parentId === null && body?.parent_id !== undefined && body?.parent_id !== null) {
    return c.json(errorBody("bad_request", "parent_id must be a positive integer"), 400);
  }
  if (parentId !== null && !(await loadTaskRow(c.env.DB, slug, parentId))) {
    return c.json(errorBody("not_found", "parent task not found in this channel"), 404);
  }
  const workflowId = body?.workflow_id === undefined || body?.workflow_id === null ? null : body.workflow_id;
  if (workflowId !== null && (typeof workflowId !== "string" || workflowId.length > 128 || /[\x00-\x1f\x7f]/.test(workflowId))) {
    return c.json(errorBody("bad_request", "workflow_id must be printable text <= 128 chars"), 400);
  }
  // #369 附件引用：与消息同款校验（./attachments）。非法结构/超上限 → 400；缺省/空 → undefined（不落列）。
  const attachments = parseAttachments(body?.attachments);
  if (attachments === null) {
    return c.json(errorBody("bad_request", `attachments must be at most ${MAX_ATTACHMENTS} valid attachment refs`), 400);
  }
  const state = (requestedState ?? (assignee ? "assigned" : identity.kind === "agent" ? "triage" : "backlog")) as TaskState;
  // #204 不变量：blocked_reason 只在 state=blocked 时有意义。非 blocked 一律落 null，
  // 否则 blockers 派生会读到「未 blocked 却带 reason」的陈旧数据（门禁 P1）。服务端强制，
  // 不信任客户端一致性。
  const effectiveBlockedReason = state === "blocked" ? blockedReason : null;
  // #141 幂等 create：external_ref 命中已存在的 (channel, external_ref) 行 → 直接返回既有 task（200），
  // 不再 INSERT、不再重复触发 system status/唤醒。这是 issue→task 同步重跑不再重复建的核心。
  if (externalRef !== null) {
    const existing = await c.env.DB.prepare(
      `SELECT * FROM channel_tasks WHERE channel_slug = ? AND external_ref = ?`,
    )
      .bind(slug, externalRef)
      .first<TaskRow>();
    if (existing) return c.json(taskRowToRecord(existing), 200);
  }
  const now = Date.now();
  let result: D1Result;
  try {
    result = await c.env.DB.prepare(
      `INSERT INTO channel_tasks (
         channel_slug, title, description, state, assignee_name, assignee_kind,
         created_by, created_by_kind, created_by_owner, priority, labels_json,
         parent_id, anchor_seqs_json, workflow_id, scope_json, blocked_reason, external_ref, attachments_json, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        slug,
        title,
        desc,
        state,
        assignee?.name ?? null,
        assignee?.kind ?? null,
        identity.name,
        identity.kind,
        identity.owner ?? null,
        priority,
        JSON.stringify(labels),
        parentId,
        JSON.stringify(anchorSeqs),
        workflowId,
        JSON.stringify(scope),
        effectiveBlockedReason,
        externalRef,
        attachments === undefined ? null : JSON.stringify(attachments),
        now,
        now,
        state === "done" ? now : null,
      )
      .run();
  } catch (error) {
    // #141 并发兜底：两个请求同时带同一 external_ref 都读到「未命中」再各自 INSERT，
    // 唯一索引 (channel_slug, external_ref) 会让后到的一条撞 UNIQUE constraint failed——
    // 回落成幂等命中语义（200 + 既有行），而不是把 D1 错误甩给调用方。
    if (externalRef !== null && String(error).includes("UNIQUE constraint failed")) {
      const existing = await c.env.DB.prepare(
        `SELECT * FROM channel_tasks WHERE channel_slug = ? AND external_ref = ?`,
      )
        .bind(slug, externalRef)
        .first<TaskRow>();
      if (existing) return c.json(taskRowToRecord(existing), 200);
    }
    throw error;
  }
  const id = Number(result.meta.last_row_id);
  const row = await loadTaskRow(c.env.DB, slug, id);
  await insertSystemStatus(c.env, slug, `task #${id} created: ${title}`, "waiting").catch(() => false);
  return c.json(taskRowToRecord(row!), 201);
});

app.patch("/api/channels/:slug/tasks/:id", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly token cannot update tasks"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const id = positiveInt(Number(c.req.param("id")));
  if (id === null) return c.json(errorBody("bad_request", "id must be a positive integer"), 400);
  const existing = await loadTaskRow(c.env.DB, slug, id);
  if (!existing) return c.json(errorBody("not_found", "task not found"), 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json(errorBody("bad_request", "json body required"), 400);

  const state = body.state === undefined ? existing.state : isTaskState(body.state) ? body.state : null;
  if (state === null) {
    return c.json(errorBody("bad_request", "state must be triage|backlog|assigned|in_progress|needs_review|done|blocked"), 400);
  }
  const assignee = parseTaskAssignee(body.assignee);
  if (assignee === undefined && Object.prototype.hasOwnProperty.call(body, "assignee")) {
    return c.json(errorBody("bad_request", "assignee must be null or {name, kind: agent|human|squad}"), 400);
  }
  if (assignee?.kind === "squad" && !(await loadSquadRow(c.env.DB, slug, assignee.name))) {
    return c.json(errorBody("not_found", "assignee squad not found in this channel"), 404);
  }
  const title = body.title === undefined ? existing.title : typeof body.title === "string" ? body.title.trim() : null;
  if (title === null || title === "" || textEncoder.encode(title).byteLength > TASK_TITLE_MAX) {
    return c.json(errorBody("bad_request", `title must be a non-empty string <= ${TASK_TITLE_MAX} bytes`), 400);
  }
  const desc = body.desc === undefined && body.description === undefined
    ? existing.description
    : body.desc === null || body.description === null
      ? null
      : typeof body.desc === "string"
        ? body.desc
        : typeof body.description === "string"
          ? body.description
          : undefined;
  if (desc === undefined || (desc !== null && textEncoder.encode(desc).byteLength > TASK_DESC_MAX)) {
    return c.json(errorBody("bad_request", `description must be <= ${TASK_DESC_MAX} bytes`), 400);
  }
  const labels = body.labels === undefined ? safeJsonArray<string>(existing.labels_json) : parseTaskLabels(body.labels);
  if (labels === null) {
    return c.json(errorBody("bad_request", `labels must be <= ${TASK_LABELS_MAX} valid name tokens`), 400);
  }
  const priority = body.priority === undefined ? existing.priority : typeof body.priority === "number" && Number.isInteger(body.priority) ? body.priority : null;
  if (priority === null || priority < -100 || priority > 100) {
    return c.json(errorBody("bad_request", "priority must be an integer between -100 and 100"), 400);
  }
  const scope = body.scope === undefined
    ? safeJsonArray<string>(existing.scope_json).filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : parseTaskScope(body.scope);
  if (scope === null) {
    return c.json(errorBody("bad_request", `scope must be <= ${TASK_SCOPE_MAX} non-empty strings, each <= ${TASK_SCOPE_ITEM_MAX} bytes`), 400);
  }
  const blockedReason = body.blocked_reason === undefined ? existing.blocked_reason : parseTaskBlockedReason(body.blocked_reason);
  if (blockedReason === false) {
    return c.json(errorBody("bad_request", `blocked_reason must be null or a string <= ${TASK_BLOCKED_REASON_MAX} bytes`), 400);
  }
  // #204 不变量：blocked_reason 只在 state=blocked 时保留。转出 blocked（→done/in_progress/…）
  // 时清掉旧原因，否则 blockers 派生把已不再 blocked 的任务当阻塞（门禁 P1）。服务端强制。
  const effectiveBlockedReason = state === "blocked" ? blockedReason : null;

  const nextAssigneeName =
    assignee === undefined ? existing.assignee_name : assignee === null ? null : assignee.name;
  const nextAssigneeKind =
    assignee === undefined ? existing.assignee_kind : assignee === null ? null : assignee.kind;
  const now = Date.now();
  const completedAt = state === "done" ? existing.completed_at ?? now : null;
  await c.env.DB.prepare(
    `UPDATE channel_tasks
        SET title = ?, description = ?, state = ?, assignee_name = ?, assignee_kind = ?,
            priority = ?, labels_json = ?, scope_json = ?, blocked_reason = ?, updated_at = ?, completed_at = ?
      WHERE channel_slug = ? AND id = ?`,
  )
    .bind(title, desc, state, nextAssigneeName, nextAssigneeKind, priority, JSON.stringify(labels), JSON.stringify(scope), effectiveBlockedReason, now, completedAt, slug, id)
    .run();
  const row = await loadTaskRow(c.env.DB, slug, id);
  await insertSystemStatus(c.env, slug, `task #${id} ${state}`, statusStateForTask(state)).catch(() => false);
  return c.json(taskRowToRecord(row!));
});

app.get("/api/channels/:slug/captures", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const url = new URL(c.req.url);
  const kind = url.searchParams.get("kind");
  if (kind !== null && !CAPTURE_KINDS.includes(kind)) {
    return c.json(errorBody("bad_request", "kind must be decision|requirement|bug|action-item"), 400);
  }
  const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
  if (!Number.isInteger(since) || since < 0) {
    return c.json(errorBody("bad_request", "since must be a non-negative integer"), 400);
  }
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return c.json(errorBody("bad_request", "limit must be 1..1000"), 400);
  }
  const base =
    "SELECT * FROM captures WHERE channel_slug = ? AND seq > ?" +
    (kind === null ? "" : " AND kind = ?") +
    " ORDER BY seq DESC, created_at DESC LIMIT ?";
  const stmt = c.env.DB.prepare(base);
  const query = kind === null ? stmt.bind(slug, since, limit) : stmt.bind(slug, since, kind, limit);
  const { results } = await query.all<Parameters<typeof captureRowToRecord>[0]>();
  return c.json({ captures: results.map(captureRowToRecord) });
});

app.post("/api/channels/:slug/captures", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly token cannot create captures"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { seq?: unknown; kind?: unknown; as?: unknown; note?: unknown }
    | null;
  const seq = positiveInt(body?.seq);
  const kind = typeof body?.kind === "string" ? body.kind : typeof body?.as === "string" ? body.as : "";
  const note = body?.note === undefined || body?.note === null ? null : body.note;
  if (seq === null) return c.json(errorBody("bad_request", "seq must be a positive integer"), 400);
  if (!CAPTURE_KINDS.includes(kind)) {
    return c.json(errorBody("bad_request", "kind must be decision|requirement|bug|action-item"), 400);
  }
  if (note !== null && (typeof note !== "string" || note.length > CAPTURE_NOTE_MAX)) {
    return c.json(errorBody("bad_request", `note must be a string <= ${CAPTURE_NOTE_MAX} chars`), 400);
  }

  const msgRes = await fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/messages?since=${seq - 1}&limit=1`, {
      headers: { "x-partykit-room": slug },
    }),
  );
  if (!msgRes.ok) return c.json(errorBody("unavailable", "channel history unavailable"), 503);
  const msgBody = (await msgRes.json()) as { messages?: MsgFrame[] };
  const msg = msgBody.messages?.find((m) => m.seq === seq);
  if (!msg) return c.json(errorBody("not_found", `message seq ${seq} not found in retained history`), 404);

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO captures (
      channel_slug, seq, kind, note, created_by, created_by_kind, created_at,
      message_sender, message_sender_kind, message_kind, message_body, message_ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_slug, seq, kind) DO UPDATE SET
      note = excluded.note,
      created_by = excluded.created_by,
      created_by_kind = excluded.created_by_kind,
      created_at = excluded.created_at,
      message_sender = excluded.message_sender,
      message_sender_kind = excluded.message_sender_kind,
      message_kind = excluded.message_kind,
      message_body = excluded.message_body,
      message_ts = excluded.message_ts`,
  )
    .bind(
      slug,
      seq,
      kind,
      note,
      identity.name,
      identity.kind,
      now,
      msg.sender.name,
      msg.sender.kind,
      msg.kind,
      msg.kind === "status" ? (msg.note ?? msg.body) : msg.body,
      msg.ts,
    )
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM captures WHERE channel_slug = ? AND seq = ? AND kind = ?")
    .bind(slug, seq, kind)
    .first<Parameters<typeof captureRowToRecord>[0]>();
  return c.json(captureRowToRecord(row!), 201);
});

app.get("/api/channels/:slug/roles", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT cr.agent_name AS name, cr.role, cr.responsibility, cr.assigned_by, cr.assigned_at,
            t.role AS token_role, t.owner AS account, cr.reports_to
       FROM channel_roles cr
       LEFT JOIN tokens t ON t.name = cr.agent_name AND t.revoked_at IS NULL
      WHERE cr.channel_slug = ?
      ORDER BY cr.agent_name`,
  )
    .bind(slug)
    .all<ChannelRoleRow>();
  const roles: ChannelRoleAssignment[] = results.map(channelRoleAssignmentFromRow);
  return c.json({ roles });
});

app.put("/api/channels/:slug/roles/:name", async (c) => {
  const slug = c.req.param("slug");
  const name = c.req.param("name");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can assign roles"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const role = typeof body?.role === "string" ? body.role : "";
  const responsibility = parseRoleResponsibility(body);
  if (!NAME_RE.test(name) || !COLLAB_ROLES.includes(role)) {
    return c.json(errorBody("bad_request", "valid name and role (host|worker|reviewer|observer) required"), 400);
  }
  if (responsibility === null) {
    return c.json(errorBody("bad_request", `responsibility must be a string <= ${ROLE_RESPONSIBILITY_LIMIT} bytes`), 400);
  }
  // #370 reports_to：管理层级（可跨 owner）。undefined=不改；null/""=清空（顶层）；否则须是本频道在场
  // 角色、非自己、且不成环。归属账号不参与此校验——正是为了允许 owner X 的 agent 挂到 owner Y 的 agent 下。
  const reportsToRaw = body?.reports_to;
  const reportsToProvided = reportsToRaw !== undefined;
  let reportsTo: string | null = null;
  if (reportsToProvided) {
    if (reportsToRaw === null || reportsToRaw === "") {
      reportsTo = null;
    } else if (typeof reportsToRaw !== "string" || !NAME_RE.test(reportsToRaw)) {
      return c.json(errorBody("bad_request", "reports_to must be a valid agent name or null"), 400);
    } else if (reportsToRaw === name) {
      return c.json(errorBody("bad_request", "an agent cannot report to itself"), 400);
    } else {
      reportsTo = reportsToRaw;
    }
    if (reportsTo !== null) {
      const edgeRows = await c.env.DB.prepare(
        "SELECT agent_name, reports_to FROM channel_roles WHERE channel_slug = ?",
      )
        .bind(slug)
        .all<{ agent_name: string; reports_to: string | null }>();
      const managerOf = new Map(edgeRows.results.map((r) => [r.agent_name, r.reports_to]));
      if (!managerOf.has(reportsTo)) {
        return c.json(errorBody("bad_request", "reports_to must reference an agent that already has a role in this channel"), 400);
      }
      // 从 reportsTo 沿 reports_to 链上溯：碰到被指派者 name → 会成环，拒绝。
      let cursor: string | null = reportsTo;
      const seen = new Set<string>();
      while (cursor !== null) {
        if (cursor === name) {
          return c.json(errorBody("bad_request", "reports_to would create a reporting cycle"), 400);
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
        cursor = managerOf.get(cursor) ?? null;
      }
    }
  }
  const assignedAt = Date.now();
  // 角色按账号锚定（#101）：绑定到该 name 当前【存活】token 的 owner。
  // 若无存活 token（预分配「先分工再铸 token」）→ null，等 persistToken 在首次铸造时认领绑定。
  const liveOwner = await c.env.DB.prepare(
    "SELECT owner FROM tokens WHERE name = ? AND revoked_at IS NULL",
  )
    .bind(name)
    .first<{ owner: string | null }>();
  const ownerAccount = liveOwner?.owner ?? null;
  await c.env.DB.prepare(
    `INSERT INTO channel_roles (channel_slug, agent_name, role, assigned_by, assigned_at, responsibility, owner_account, reports_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_slug, agent_name) DO UPDATE SET
       role = excluded.role,
       assigned_by = excluded.assigned_by,
       assigned_at = excluded.assigned_at,
       responsibility = ${responsibility.present ? "excluded.responsibility" : "channel_roles.responsibility"},
       owner_account = COALESCE(excluded.owner_account, channel_roles.owner_account),
       reports_to = ${reportsToProvided ? "excluded.reports_to" : "channel_roles.reports_to"}`,
  )
    .bind(slug, name, role, identity.name, assignedAt, responsibility.value, ownerAccount, reportsTo)
    .run();
  await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/roles", {
      method: "POST",
      body: JSON.stringify({ name, role }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.role.assign",
    resource: `channel/${slug}/roles/${name}`,
    channel: slug,
    timestamp: assignedAt,
    metadata: { role },
  });
  const saved = await loadChannelRoleAssignment(c.env.DB, slug, name);
  return c.json(saved ?? { name, role, responsibility: responsibility.value, assigned_by: identity.name, assigned_at: assignedAt });
});

app.delete("/api/channels/:slug/roles/:name", async (c) => {
  const slug = c.req.param("slug");
  const name = c.req.param("name");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can assign roles"), 403);
  }
  if (!NAME_RE.test(name)) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  const removedAt = Date.now();
  const removed = await c.env.DB.prepare("DELETE FROM channel_roles WHERE channel_slug = ? AND agent_name = ?")
    .bind(slug, name)
    .run();
  await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/roles", {
      method: "POST",
      body: JSON.stringify({ name, role: null }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  if (removed.meta.changes > 0) {
    await bestEffortRecordManagementAudit(c.env.DB, {
      actor: managementAuditActor(identity),
      action: "channel.role.remove",
      resource: `channel/${slug}/roles/${name}`,
      channel: slug,
      timestamp: removedAt,
    });
  }
  return c.json({ ok: true });
});

app.put("/api/channels/:slug/completion-gate", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can configure completion gate"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as { gate?: unknown; policy?: unknown } | null;
  const gate = typeof body?.gate === "string" ? body.gate : "";
  if (!COMPLETION_GATES.includes(gate as CompletionGate)) {
    return c.json(errorBody("bad_request", "gate must be off or reviewer"), 400);
  }
  const policy =
    body?.policy === undefined
      ? channel.completion_review_policy
      : typeof body.policy === "string"
        ? body.policy
        : "";
  if (!COMPLETION_REVIEW_POLICIES.includes(policy as CompletionReviewPolicy)) {
    return c.json(errorBody("bad_request", "policy must be sender or owner"), 400);
  }
  await c.env.DB.prepare(
    "UPDATE channels SET completion_gate = ?, completion_review_policy = ? WHERE slug = ?",
  )
    .bind(gate, policy, slug)
    .run();
  const updated = { ...channel, completion_gate: gate, completion_review_policy: policy };
  await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/init", {
      method: "POST",
      headers: { "x-partykit-room": slug, ...channelHeaders(updated, c.req.url) },
    }),
  );
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.guard.update",
    resource: `channel/${slug}/guards/completion_gate`,
    channel: slug,
    metadata: { guard: "completion_gate" },
  });
  return c.json({ gate, policy });
});

// 频道决策模式（#284）：approval（默认，人类审批）↔ unattended（无人值守，自动放行）。
// 门禁同 completion-gate——只有 moderator（频道 owner / ap_ token）能切。
app.put("/api/channels/:slug/decision-mode", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can configure decision mode"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as { mode?: unknown } | null;
  const mode = typeof body?.mode === "string" ? body.mode : "";
  if (!DECISION_MODES.includes(mode as DecisionMode)) {
    return c.json(errorBody("bad_request", "mode must be approval or unattended"), 400);
  }
  await c.env.DB.prepare("UPDATE channels SET decision_mode = ? WHERE slug = ?").bind(mode, slug).run();
  const updated = { ...channel, decision_mode: mode };
  await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/init", {
      method: "POST",
      headers: { "x-partykit-room": slug, ...channelHeaders(updated, c.req.url) },
    }),
  );
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.guard.update",
    resource: `channel/${slug}/guards/decision_mode`,
    channel: slug,
    metadata: { guard: "decision_mode" },
  });
  return c.json({ mode });
});


// #119：削弱 guard 的门禁不得弱于 reset-guard 的 human-only。
// reset 只清计数，关闭/放宽 guard 是永久摘掉刹车——更强的动作，不能门禁更松。
// 加强（开启、调低阈值）对任何 configurer 放行：那是往安全方向走。
function loopGuardEffectiveLimit(channel: LoadedChannel): number {
  if (channel.loop_guard_limit != null && channel.loop_guard_limit > 0) return channel.loop_guard_limit;
  return channel.mode === "party" ? LOOP_GUARD_PARTY_N : LOOP_GUARD_N;
}

function weakensLoopGuard(channel: LoadedChannel, enabled: boolean, limit: number | null): boolean {
  if (!enabled) return channel.loop_guard_enabled === 1; // 开→关 = 削弱；本就关着不算
  if (channel.loop_guard_enabled !== 1) return false; // 关→开 = 加强
  return limit !== null && limit > loopGuardEffectiveLimit(channel); // 放宽阈值 = 削弱
}

function weakensWorkflowGuard(channel: LoadedChannel, enabled: boolean, limit: number | null): boolean {
  if (!enabled) return channel.workflow_guard_enabled === 1;
  if (channel.workflow_guard_enabled !== 1) return false;
  return limit !== null && limit > channel.workflow_guard_limit;
}

app.put("/api/channels/:slug/loop-guard", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canConfigureChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "only channel moderators or hosts can configure loop guard"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as { enabled?: unknown; limit?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return c.json(errorBody("bad_request", "enabled must be boolean"), 400);
  }
  const limit = body.enabled ? positiveInt(body.limit) : null;
  if (body.enabled && (limit === null || limit > 10_000)) {
    return c.json(errorBody("bad_request", "limit must be an integer between 1 and 10000"), 400);
  }
  if (weakensLoopGuard(channel, body.enabled, limit) && identity.kind !== "human") {
    return c.json(errorBody("forbidden", "only a human can disable or loosen the loop guard"), 403);
  }
  const enabled = body.enabled ? 1 : 0;
  await c.env.DB.prepare("UPDATE channels SET loop_guard_enabled = ?, loop_guard_limit = ? WHERE slug = ?")
    .bind(enabled, limit, slug)
    .run();
  const updated = { ...channel, loop_guard_enabled: enabled, loop_guard_limit: limit };
  await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/init", {
      method: "POST",
      headers: { "x-partykit-room": slug, ...channelHeaders(updated, c.req.url) },
    }),
  );
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.guard.update",
    resource: `channel/${slug}/guards/loop_guard`,
    channel: slug,
    metadata: { guard: "loop_guard" },
  });
  return c.json({ enabled: body.enabled, limit });
});

app.put("/api/channels/:slug/workflow-guard", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canConfigureChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "only channel moderators or hosts can configure workflow guard"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as { enabled?: unknown; limit?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return c.json(errorBody("bad_request", "enabled must be boolean"), 400);
  }
  const limit = body.enabled
    ? body.limit === undefined
      ? channel.workflow_guard_limit
      : positiveInt(body.limit)
    : null;
  if (body.enabled && (limit === null || limit > 1000)) {
    return c.json(errorBody("bad_request", "limit must be an integer between 1 and 1000"), 400);
  }
  if (weakensWorkflowGuard(channel, body.enabled, limit) && identity.kind !== "human") {
    return c.json(errorBody("forbidden", "only a human can disable or loosen the workflow guard"), 403);
  }
  const enabled = body.enabled ? 1 : 0;
  const storedLimit = limit ?? channel.workflow_guard_limit;
  await c.env.DB.prepare("UPDATE channels SET workflow_guard_enabled = ?, workflow_guard_limit = ? WHERE slug = ?")
    .bind(enabled, storedLimit, slug)
    .run();
  const updated = { ...channel, workflow_guard_enabled: enabled, workflow_guard_limit: storedLimit };
  await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/init", {
      method: "POST",
      headers: { "x-partykit-room": slug, ...channelHeaders(updated, c.req.url) },
    }),
  );
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.guard.update",
    resource: `channel/${slug}/guards/workflow_guard`,
    channel: slug,
    metadata: { guard: "workflow_guard" },
  });
  return c.json({ enabled: body.enabled, limit });
});

app.post("/api/channels/:slug/messages/:seq/review", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const seq = positiveInt(Number(c.req.param("seq")));
  if (seq === null) return c.json(errorBody("bad_request", "seq must be a positive integer"), 400);
  const assignedRole = await loadAssignedRole(c.env.DB, slug, identity);
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/messages/${seq}/review`, {
      method: "POST",
      body: await c.req.text(),
      headers: {
        "content-type": "application/json",
        "x-partykit-room": slug,
        "x-ap-name": identity.name,
        "x-ap-kind": identity.kind,
        "x-ap-role": identity.role,
        ...(identity.owner ? { "x-ap-owner": identity.owner } : {}),
        "x-ap-token-hash": identity.hash,
        ...lineageHeaders(identity),
        ...assignedRoleHeaders(assignedRole),
        ...channelHeaders(channel, c.req.url),
        ...(await handleHeader(c.env.DB, identity)),
      },
    }),
  );
  if (!res.ok) return res;
  const payload = (await res.clone().json().catch(() => null)) as { message?: MsgFrame } | null;
  const message = payload?.message;
  const taskId = message?.completion_artifact?.task_id;
  const reviewState = message?.completion_review?.state;
  if (message !== undefined && typeof taskId === "number" && Number.isInteger(taskId) && taskId > 0) {
    if (reviewState === "approved") {
      await syncTaskCompletion(c.env, slug, taskId, message.completion_artifact, message.seq, "done");
    } else if (reviewState === "rejected") {
      await syncTaskCompletion(c.env, slug, taskId, message.completion_artifact, message.seq, "in_progress");
    }
  }
  return res;
});

// 人类决策回应（#284）：人类/moderator 在频道内对某条 decision_request 点选项/审批。
// 必须注册在 :action 泛匹配之前，否则被吞。moderator 位在 worker 层算好后转发给 DO。
app.post("/api/channels/:slug/messages/:seq/decision", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const seq = positiveInt(Number(c.req.param("seq")));
  if (seq === null) return c.json(errorBody("bad_request", "seq must be a positive integer"), 400);
  const assignedRole = await loadAssignedRole(c.env.DB, slug, identity);
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/messages/${seq}/decision`, {
      method: "POST",
      body: await c.req.text(),
      headers: {
        "content-type": "application/json",
        "x-partykit-room": slug,
        "x-ap-name": identity.name,
        "x-ap-kind": identity.kind,
        "x-ap-role": identity.role,
        ...(identity.owner ? { "x-ap-owner": identity.owner } : {}),
        "x-ap-token-hash": identity.hash,
        ...(isChannelModerator(identity, channel) ? { "x-ap-moderator": "1" } : {}),
        ...lineageHeaders(identity),
        ...assignedRoleHeaders(assignedRole),
        ...channelHeaders(channel, c.req.url),
        ...(await handleHeader(c.env.DB, identity)),
      },
    }),
  );
  return res;
});

app.post("/api/channels/:slug/messages/:seq/:action", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const seq = positiveInt(Number(c.req.param("seq")));
  if (seq === null) return c.json(errorBody("bad_request", "seq must be a positive integer"), 400);
  const action = c.req.param("action");
  if (action !== "edit" && action !== "retract" && action !== "supersede") {
    return c.json(errorBody("bad_request", "action must be edit|retract|supersede"), 400);
  }
  const assignedRole = await loadAssignedRole(c.env.DB, slug, identity);
  return fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/messages/${seq}/${action}`, {
      method: "POST",
      body: action === "retract" ? null : await c.req.text(),
      headers: {
        "content-type": "application/json",
        "x-partykit-room": slug,
        "x-ap-name": identity.name,
        "x-ap-kind": identity.kind,
        "x-ap-role": identity.role,
        ...(identity.owner ? { "x-ap-owner": identity.owner } : {}),
        "x-ap-token-hash": identity.hash,
        "x-ap-moderator": isChannelModerator(identity, channel) ? "1" : "0",
        ...lineageHeaders(identity),
        ...assignedRoleHeaders(assignedRole),
        ...channelHeaders(channel, c.req.url),
        // #381：supersede 会经 handleSend 落新消息，public_watch 频道须带写门信号，否则房主自己的
        // 超越会被 fail-closed 拦下。edit/retract 不经 handleSend，多带此位无害。
        ...(await writeGateHeaders(c.env.DB, identity, channel)),
        ...(await handleHeader(c.env.DB, identity)),
      },
    }),
  );
});

app.get("/api/channels/:slug/messages/:seq/audit", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const seq = positiveInt(Number(c.req.param("seq")));
  if (seq === null) return c.json(errorBody("bad_request", "seq must be a positive integer"), 400);
  return fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/messages/${seq}/audit`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

// GDPR 按身份数据出口（#421）。只读，导出某身份在本频道的全部可归因数据（消息 + 审计 + wake 账本 +
// 读游标 + presence），满足「数据可携」/ 出境审查。授权同 kick/pause：仅频道 moderator（房主 / ap_）——
// 导出包含 PII，不能让普通成员随手拉别人的数据。
app.get("/api/channels/:slug/identity/:name/data", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can export identity data"), 403);
  }
  const name = c.req.param("name");
  if (!name || name.length > 256) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  return fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/identity/${encodeURIComponent(name)}/data${new URL(c.req.url).search}`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

// GDPR 按身份硬擦除（#421）。物理删除该身份在本频道 message_audit / wake_delivery_ledger / read_cursor /
// presence 的可识别行，并把其发过的消息正文 + 归属 PII 抹成 [erased]——补齐撤回（#196）只覆盖单条消息、
// 覆盖不到审计/账本身份维度的合规缺口。授权同 kick：仅频道 moderator（房主 / ap_）；操作落 management_audit。
app.delete("/api/channels/:slug/identity/:name/data", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can erase identity data"), 403);
  }
  const name = c.req.param("name");
  if (!name || name.length > 256) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/identity/${encodeURIComponent(name)}/data`, {
      method: "DELETE",
      headers: {
        "x-partykit-room": slug,
        "x-ap-name": identity.name,
        "x-ap-kind": identity.kind,
        "x-ap-role": identity.role,
        "x-ap-token-hash": identity.hash,
      },
    }),
  );
  if (res.ok) {
    const summary = (await res.clone().json().catch(() => null)) as (Record<string, unknown> & { attachment_keys?: unknown }) | null;
    const attachmentKeys = Array.isArray(summary?.attachment_keys)
      ? summary.attachment_keys.filter((key): key is string => typeof key === "string" && key.startsWith(`${slug}/`))
      : [];
    await Promise.all(attachmentKeys.map((key) => c.env.ATTACHMENTS.delete(key)));
    await bestEffortRecordManagementAudit(c.env.DB, {
      actor: managementAuditActor(identity),
      action: "channel.identity.erase",
      resource: `channel/${slug}/identity/${name}`,
      channel: slug,
      metadata: summary ?? {},
    });
  }
  return res;
});

// 附件上传（#176）：blob 进 R2，返回引用元数据；发消息时把引用带在 attachments 字段里。
// 鉴权同频道写：必须是可访问该频道的非 readonly token（私有频道即房主/成员/被邀 agent）。
app.post("/api/channels/:slug/attachments", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly token cannot upload attachments"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const filename = (c.req.query("filename") ?? "").trim();
  if (!ATTACHMENT_FILENAME_RE.test(filename)) {
    return c.json(errorBody("bad_request", "filename query param required (single path segment, <=255 chars)"), 400);
  }
  // #277 会员真门槛：上传者账号决定体积上限——free 低配额，member 解锁到平台原 25 MiB 上限。
  // 无账号的 legacy token（identity.account undefined）按 loadMembership 的 fail-open 语义落回 free。
  const uploaderMembership = await loadMembership(c.env.DB, identity.account);
  const uploaderIsMember = !hostedMembershipGating(c.env) || isMember(uploaderMembership);
  const sizeLimit = uploaderIsMember ? MEMBER_ATTACHMENT_SIZE_LIMIT : resolveFreeAttachmentLimit(c.env);
  const sizeHint = uploaderIsMember ? "" : ` (free tier limit — ${MEMBERSHIP_UPGRADE_HINT})`;
  // Content-Length 先挡一刀，避免把超大体读进内存
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > sizeLimit) {
    return c.json(errorBody("too_large", `attachment exceeds ${sizeLimit} bytes${sizeHint}`), 413);
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return c.json(errorBody("bad_request", "attachment body is empty"), 400);
  }
  if (bytes.byteLength > sizeLimit) {
    return c.json(errorBody("too_large", `attachment exceeds ${sizeLimit} bytes${sizeHint}`), 413);
  }
  const contentType = c.req.header("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  // #387 内容 hash 去重：object 按内容 sha256 命名（不再随机 uuid）——同频道内同内容+同名
  // 重复上传落到同一个 key，R2 里只存一份，省存储/带宽。key 前缀仍锚定 slug 做跨频道隔离
  // （下载时 worker 用权威 slug 重拼 key，伪造引用读不到别人的 blob）。hash 即完整性锚。
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const objectPath = `${hash}/${filename}`;
  const key = `${slug}/${objectPath}`;
  // 已存在同内容同名对象 → 跳过 put（去重命中），省一次写 + 上行带宽。
  const existing = await c.env.ATTACHMENTS.head(key);
  if (existing === null) {
    await c.env.ATTACHMENTS.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { filename, uploaded_by: identity.name, channel: slug },
    });
  }
  const meta: Attachment = {
    key,
    filename,
    content_type: contentType,
    size: bytes.byteLength,
    url: `/api/channels/${slug}/attachments/${objectPath}`,
  };
  return c.json(meta, 201);
});

// 附件下载（#176）：同频道读鉴权，从 R2 流式回传。绝不暴露裸 R2 公链——频道内容是受控的。
app.get("/api/channels/:slug/attachments/:path{.+}", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!(await canAccessLoadedChannel(c.env.DB, c.get("identity"), channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const objectPath = c.req.param("path");
  // 只认 worker 权威 slug 前缀拼出的 key，客户端传的完整 key 一律不信任，防目录穿越
  if (!objectPath || objectPath.includes("..") || objectPath.startsWith("/")) {
    return c.json(errorBody("bad_request", "invalid attachment path"), 400);
  }
  const object = await c.env.ATTACHMENTS.get(`${slug}/${objectPath}`);
  if (!object) return c.json(errorBody("not_found", "attachment not found"), 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  // nosniff：即便 content-type 被伪造也不让浏览器嗅探成可执行类型，缓解存储型 XSS
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
});

app.post("/api/channels/:slug/messages", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  // 私有频道仅 ap_ token 或房主可发（spec §3.2）；写权限的 readonly 限制在 do 侧
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const rawBody = await c.req.text();
  const parsedBody = ((): unknown => {
    try {
      return JSON.parse(rawBody || "null");
    } catch {
      return null;
    }
  })();
  const taskId = completionTaskIdFromPayload(parsedBody);
  if (taskId === null) return c.json(errorBody("bad_request", "completion task_id must be a positive integer"), 400);
  if (taskId !== undefined && !(await loadTaskRow(c.env.DB, slug, taskId))) {
    return c.json(errorBody("not_found", "task not found in this channel"), 404);
  }
  const assignedRole = await loadAssignedRole(c.env.DB, slug, identity);
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/messages", {
      method: "POST",
      body: rawBody,
      headers: {
        "content-type": "application/json",
        "x-partykit-room": slug,
        "x-ap-name": identity.name,
        "x-ap-kind": identity.kind,
        "x-ap-role": identity.role,
        ...(identity.owner ? { "x-ap-owner": identity.owner } : {}),
        "x-ap-token-hash": identity.hash,
        ...lineageHeaders(identity),
        ...assignedRoleHeaders(assignedRole),
        ...channelHeaders(channel, c.req.url),
        // #381：public_watch 写门信号——非成员/未被邀者在 public_watch 频道会被 DO handleSend 拒发
        ...(await writeGateHeaders(c.env.DB, identity, channel)),
        ...(await handleHeader(c.env.DB, identity)),
      },
    }),
  );
  if (!res.ok || taskId === undefined || !isRecord(parsedBody)) return res;
  const payload = (await res.clone().json().catch(() => null)) as { seq?: unknown; completion_review?: { state?: unknown } } | null;
  const seq = positiveInt(payload?.seq);
  if (seq !== null) {
    const state = payload?.completion_review?.state === "pending_review" ? "needs_review" : "done";
    await syncTaskCompletion(c.env, slug, taskId, parsedBody.completion_artifact, seq, state);
  }
  return res;
});

// outbound webhook 注册 / 列表 / 删除（spec §7/§15），存储在频道 do 里
app.post("/api/channels/:slug/webhooks", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // webhook 能窃取频道全部消息，属管理操作：仅 ap_ token（非只读）或房主可管理（spec §7/§15）。
  // 前置于 archived 判定，避免向粉丝泄漏私有频道是否存在/是否已归档。
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage webhooks"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; url?: unknown; secret?: unknown; filter?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const url = typeof body?.url === "string" ? body.url : "";
  const secret = typeof body?.secret === "string" ? body.secret : "";
  const filter = body?.filter === undefined ? "mentions" : body.filter;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (
    !NAME_RE.test(name) ||
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    url.length > WEBHOOK_URL_MAX ||
    secret.length === 0 ||
    secret.length > WEBHOOK_SECRET_MAX ||
    !HEADER_VALUE_RE.test(secret) ||
    isBlockedWebhookHost(parsed.hostname) ||
    typeof filter !== "string" ||
    !WEBHOOK_FILTERS.includes(filter)
  ) {
    return c.json(
      errorBody("bad_request", "name, https url, secret and filter (mentions|status|needs-human|all) required"),
      400,
    );
  }
  const response = await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/webhooks", {
      method: "POST",
      body: JSON.stringify({ name, url, secret, filter }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  if (response.ok) {
    await bestEffortRecordManagementAudit(c.env.DB, {
      actor: managementAuditActor(c.get("identity")),
      action: "channel.webhook.add",
      resource: `channel/${slug}/webhooks/${name}`,
      channel: slug,
      metadata: { webhook_filter: filter },
    });
  }
  return response;
});

app.get("/api/channels/:slug/webhooks", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // webhook 能窃取频道全部消息，属管理操作：仅 ap_ token（非只读）或房主可管理（spec §7/§15）。
  // 前置于 archived 判定，避免向粉丝泄漏私有频道是否存在/是否已归档。
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage webhooks"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  return fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/webhooks", { headers: { "x-partykit-room": slug } }),
  );
});

app.delete("/api/channels/:slug/webhooks/:name", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // webhook 能窃取频道全部消息，属管理操作：仅 ap_ token（非只读）或房主可管理（spec §7/§15）。
  // 前置于 archived 判定，避免向粉丝泄漏私有频道是否存在/是否已归档。
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage webhooks"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const name = c.req.param("name");
  const response = await fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/webhooks?name=${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { "x-partykit-room": slug },
    }),
  );
  if (response.ok) {
    await bestEffortRecordManagementAudit(c.env.DB, {
      actor: managementAuditActor(c.get("identity")),
      action: "channel.webhook.remove",
      resource: `channel/${slug}/webhooks/${name}`,
      channel: slug,
    });
  }
  return response;
});

// #105：列出死信（重试耗尽 / 队列满被永久放弃的投递）。与 webhook 管理同权限：仅房主 / ap_ token。
app.get("/api/channels/:slug/webhooks/dead-letters", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage webhooks"), 403);
  }
  return fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/dead-letters", { headers: { "x-partykit-room": slug } }),
  );
});

// #105：重投某 webhook 的死信。成功即出表，仍失败留表待再试——不再永久静默丢弃。管理权同上。
app.post("/api/channels/:slug/webhooks/:name/redeliver", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage webhooks"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const name = c.req.param("name");
  const response = await fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/dead-letters/redeliver?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "x-partykit-room": slug },
    }),
  );
  if (response.ok) {
    await bestEffortRecordManagementAudit(c.env.DB, {
      actor: managementAuditActor(c.get("identity")),
      action: "channel.webhook.redeliver",
      resource: `channel/${slug}/webhooks/${name}`,
      channel: slug,
    });
  }
  return response;
});

app.post("/api/channels/:slug/archive", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // 归档是破坏性操作：仅房主或 ap_ token（非只读）可为，否则粉丝能归档别人的私有频道捣乱
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can archive"), 403);
  }
  const archivedAt = Date.now();
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/archive", {
      method: "POST",
      headers: {
        "x-partykit-room": slug,
        "x-ap-archive-at": String(channel.archived_at ?? archivedAt),
        ...channelHeaders(channel, c.req.url),
      },
    }),
  );
  if (!res.ok) return c.json(errorBody("unavailable", "archive coordination failed"), 503);
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(c.get("identity")),
    action: "channel.archive",
    resource: `channel/${slug}`,
    channel: slug,
    timestamp: channel.archived_at ?? archivedAt,
  });
  return c.json({ ok: true });
});

type KickMode = "disconnect" | "remove";

// 踢人（spec §5 防滥用 MVP）：默认只把某 name 的存活 ws 踢下线；remove 额外撤销本频道 scoped token。
app.post("/api/channels/:slug/kick", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can kick"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; mode?: unknown } | null;
  // 被踢者 name 可能是 OIDC sub（含 NAME_RE 之外的字符），只做非空 + 长度校验，不套 NAME_RE
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name || name.length > 256) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  if (body?.mode !== undefined && body.mode !== "disconnect" && body.mode !== "remove") {
    return c.json(errorBody("bad_request", "mode must be disconnect or remove"), 400);
  }
  const mode: KickMode = body?.mode === "remove" ? "remove" : "disconnect";
  if (name === channel.created_by || name === channel.owner_account) {
    return c.json(errorBody("forbidden", "channel owner cannot kick themselves"), 403);
  }
  if (mode === "remove") {
    const now = Date.now();
    const revoked = await c.env.DB.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE channel_scope = ? AND name = ? AND revoked_at IS NULL",
    )
      .bind(now, slug, name)
      .run();
    if (revoked.meta.changes > 0) {
      await bestEffortRecordManagementAudit(c.env.DB, {
        actor: managementAuditActor(c.get("identity")),
        action: "token.revoke",
        resource: `token/${name}`,
        channel: slug,
        timestamp: now,
      });
    }
  }
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/kick", {
      method: "POST",
      body: JSON.stringify(mode === "remove" ? { name, mode } : { name }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  if (!res.ok) return c.json(errorBody("unavailable", "kick coordination failed"), 503);
  if (mode === "remove") {
    const kicked = (await res.json().catch(() => null)) as { owners?: unknown } | null;
    const owners = Array.isArray(kicked?.owners) ? kicked.owners.filter((owner): owner is string => typeof owner === "string") : [];
    const accounts = [...new Set([name, ...owners])].slice(0, 16);
    const placeholders = accounts.map(() => "?").join(", ");
    await c.env.DB.prepare(
      `DELETE FROM channel_members
        WHERE channel_slug = ?
          AND (? IS NULL OR account != ?)
          AND (
            account IN (${placeholders})
            OR account IN (SELECT owner FROM tokens WHERE name = ? AND owner IS NOT NULL)
          )`,
    )
      .bind(slug, channel.owner_account, channel.owner_account, ...accounts, name)
      .run();
  }
  return c.json({ ok: true });
});

// 人为暂停/恢复某 agent 的接待（issue #180）。授权口径同 kick：仅频道 moderator（房主 / legacy ap_）。
// 暂停后该 agent 被 @ 也不唤醒（webhook 不投、serve/watch 自我抑制），消息仍进历史；可带 resume_at 定时恢复。
app.post("/api/channels/:slug/presence/:name/pause", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can pause an agent"), 403);
  }
  const name = c.req.param("name");
  if (!name || name.length > 256) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  const body = (await c.req.json().catch(() => null)) as { resume_at?: unknown } | null;
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/presence/${encodeURIComponent(name)}/pause`, {
      method: "POST",
      body: JSON.stringify({ resume_at: body?.resume_at ?? null }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  return res;
});

app.post("/api/channels/:slug/presence/:name/resume", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can resume an agent"), 403);
  }
  const name = c.req.param("name");
  if (!name || name.length > 256) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/presence/${encodeURIComponent(name)}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  return res;
});

app.post("/api/channels/:slug/reset-guard", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // 重置 loop guard 要同时满足两条：① 是房主/ap_ token（挡粉丝越权重置别人频道）
  // ② 是 human（loop guard 防的就是 agent 失控刷屏，不能让 agent 重置自己的熔断）
  const identity = c.get("identity");
  if (!isChannelModerator(identity, channel) || identity.kind !== "human") {
    return c.json(errorBody("forbidden", "only a human owner or human ap_ token can reset guard"), 403);
  }
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request("https://do/internal/reset-guard", {
      method: "POST",
      headers: { "x-partykit-room": slug },
    }),
  );
  if (res.ok) {
    await bestEffortRecordManagementAudit(c.env.DB, {
      actor: managementAuditActor(identity),
      action: "channel.guard.reset",
      resource: `channel/${slug}/guards/loop`,
      channel: slug,
      metadata: { guard: "loop" },
    });
  }
  return res;
});

app.post("/api/channels/:slug/workflows/:workflow_id/reset-guard", async (c) => {
  const slug = c.req.param("slug");
  const workflowId = c.req.param("workflow_id");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (identity.kind !== "human" || !(await canConfigureChannel(c.env.DB, identity, channel))) {
    return c.json(errorBody("forbidden", "only a human moderator or host can reset workflow guard"), 403);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(workflowId)) {
    return c.json(errorBody("bad_request", "valid workflow_id required"), 400);
  }
  const res = await fetchChannelDO(
    c.env,
    slug,
    new Request(`https://do/internal/workflows/${encodeURIComponent(workflowId)}/reset-guard`, {
      method: "POST",
      headers: { "x-partykit-room": slug },
    }),
  );
  if (!res.ok) return c.json(errorBody("unavailable", "workflow guard reset failed"), 503);
  await bestEffortRecordManagementAudit(c.env.DB, {
    actor: managementAuditActor(identity),
    action: "channel.guard.reset",
    resource: `channel/${slug}/guards/workflow/${workflowId}`,
    channel: slug,
    metadata: { guard: "workflow" },
  });
  return c.json({ ok: true, workflow_id: workflowId });
});

app.get("/api/channels/:slug/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json(errorBody("bad_request", "websocket upgrade required"), 426);
  }
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  // 私有频道粉丝（OIDC 非房主）连 WS 前即挡下（spec §3.2），不进 do。
  // 用 accept-then-close(1008,"forbidden") 而非 HTTP 403：浏览器 WebSocket 只对 close code/reason
  // 敏感，握手阶段的 403 在客户端仅表现为 1006（无 reason），会被误判为普通断线而无限重连；
  // 1008+"forbidden" 与 archived 同套路，ws.ts 据此识别终局、停重连、提示（不进 do，零 DO 负载）。
  if (!(await canAccessLoadedChannel(c.env.DB, identity, channel))) {
    const requested = c.req
      .header("sec-websocket-protocol")
      ?.split(",")
      .map((part) => part.trim());
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(1008, "forbidden");
    const headers = new Headers();
    if (requested?.includes("agentparty")) headers.set("Sec-WebSocket-Protocol", "agentparty");
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }
  // new Request(c.req.raw) 会带上客户端所有头：升级请求里任何 x-ap-* 都是客户端注入的，
  // 先逐个剥离再写 worker 权威值，否则 readonly 能靠 x-ap-archived:1 提权归档活频道、
  // 靠 x-ap-host 污染 webhook permalink（do 无条件信任 x-ap-*）。
  const fwd = new Request(c.req.raw);
  for (const h of AP_FORWARD_HEADERS) fwd.headers.delete(h);
  fwd.headers.set("x-partykit-room", slug);
  fwd.headers.set("x-ap-name", identity.name);
  fwd.headers.set("x-ap-kind", identity.kind);
  fwd.headers.set("x-ap-role", identity.role);
  if (identity.owner) fwd.headers.set("x-ap-owner", identity.owner);
  fwd.headers.set("x-ap-token-hash", identity.hash);
  for (const [key, value] of Object.entries(lineageHeaders(identity))) fwd.headers.set(key, value);
  const assignedRole = await loadAssignedRole(c.env.DB, slug, identity);
  if (assignedRole !== null) {
    fwd.headers.set("x-ap-collab-role", assignedRole);
    fwd.headers.set("x-ap-role-source", "assigned");
  }
  fwd.headers.set("x-ap-mode", channel.mode);
  fwd.headers.set("x-ap-channel-kind", channel.kind);
  fwd.headers.set("x-ap-completion-gate", channel.completion_gate);
  fwd.headers.set("x-ap-completion-review-policy", channel.completion_review_policy);
  fwd.headers.set("x-ap-decision-mode", channel.decision_mode ?? "approval");
  fwd.headers.set("x-ap-loop-guard-enabled", String(channel.loop_guard_enabled));
  fwd.headers.set("x-ap-loop-guard-limit", channel.loop_guard_limit == null ? "" : String(channel.loop_guard_limit));
  fwd.headers.set("x-ap-workflow-guard-enabled", String(channel.workflow_guard_enabled));
  fwd.headers.set("x-ap-workflow-guard-limit", String(channel.workflow_guard_limit));
  fwd.headers.set("x-ap-charter-rev", String(channel.charter_rev ?? 0));
  fwd.headers.set("x-ap-host", new URL(c.req.url).host);
  // #381：把频道可见性 + 「本连接能否写」权威传给 DO。可见性缓存进 meta 供 handleSend 判 public_watch；
  // can-write 定死在连接建立时（与 role/archived 同快照语义），public_watch 频道 DO 据此拦发。
  // 无条件显式写 "0"，堵住客户端注入 + 未覆盖的透传（AP_FORWARD_HEADERS 已先剥离）。
  fwd.headers.set("x-ap-visibility", channel.visibility);
  fwd.headers.set("x-ap-can-write", (await canParticipateInChannel(c.env.DB, identity, channel)) ? "1" : "0");
  // 无条件写：未归档也显式置 "0"，堵住"客户端注入 1、未归档分支不覆盖"的透传
  fwd.headers.set("x-ap-archived", channel.archived_at !== null ? "1" : "0");
  for (const [key, value] of Object.entries(await handleHeader(c.env.DB, identity))) fwd.headers.set(key, value);
  const upgrade = await channelStub(c.env, slug).fetch(fwd);
  const requestedProtocols = c.req
    .header("sec-websocket-protocol")
    ?.split(",")
    .map((part) => part.trim());
  if (upgrade.status === 101 && upgrade.webSocket && requestedProtocols?.includes("agentparty")) {
    const headers = new Headers(upgrade.headers);
    headers.set("Sec-WebSocket-Protocol", "agentparty");
    return new Response(null, { status: 101, webSocket: upgrade.webSocket, headers });
  }
  return upgrade;
});

export default app;
