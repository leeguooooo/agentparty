// rest api 封装
import {
  type AgentLineage,
  type Attachment,
  type CaptureKind,
  type CaptureRecord,
  type ChannelKind,
  type ChannelMode,
  type ChannelRoleAssignment,
  type ChannelSquad,
  type CollaborationRole,
  type CompletionGate,
  type CompletionReview,
  type CompletionReviewPolicy,
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_LOOP_GUARD,
  EXIT_RATE_LIMITED,
  EXIT_WORKFLOW_GUARD,
  type MsgFrame,
  type PresenceEntry,
  type ReadCursor,
  type SearchHit,
  type SendMessageFrame,
  type SendStatusFrame,
  type TaskAssigneeKind,
  type TaskRecord,
  type TaskState,
  type TokenRole,
  type WakeDelivery,
  type WebhookFilter,
} from "@agentparty/shared";
import pkg from "../package.json" with { type: "json" };

export type { ChannelMode, WebhookFilter };
export type { CompletionGate, CompletionReview, CompletionReviewPolicy };
export type { CaptureKind, CaptureRecord };
export type { TaskAssigneeKind, TaskRecord, TaskState };
export type { ChannelSquad };

// 频道可见性：public = 任何鉴权身份可进；private（默认）= 仅 leo 的 ap_ token + 房主（spec §3.2）
export type ChannelVisibility = "public" | "private";

export class RestError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export interface ChannelInfo {
  slug: string;
  title: string | null;
  kind: ChannelKind;
  mode?: ChannelMode;
  visibility?: ChannelVisibility;
  charter_rev?: number;
  archived_at: number | null;
  presence?: PresenceEntry[];
}

export interface ChannelCharter {
  charter: string | null;
  charter_rev: number;
  updated_at: number | null;
  updated_by: string | null;
  permissions?: ChannelPerms;
}

export type HumanChannelPermPolicy = "owner" | "moderators" | "members";
export type HumanChannelListPolicy = HumanChannelPermPolicy | "off";
export type AgentChannelPermPolicy = "off" | "moderators" | "members" | "allowlist";

export interface ChannelPerms {
  charter_write: HumanChannelPermPolicy;
  charter_write_agents: AgentChannelPermPolicy;
  charter_write_agent_allowlist: string[];
  members_list: HumanChannelListPolicy;
  members_list_agents: AgentChannelPermPolicy;
  members_list_agent_allowlist: string[];
}

export type ChannelPermsUpdate = Partial<{
  charter_write: HumanChannelPermPolicy;
  charter_write_agents: AgentChannelPermPolicy;
  charter_write_agent_allowlist: string[];
  members_list: HumanChannelListPolicy;
  members_list_agents: AgentChannelPermPolicy;
  members_list_agent_allowlist: string[];
}>;

export interface WebhookInfo {
  name: string;
  url: string;
  filter: WebhookFilter;
}

export interface LarkNotifyStatus {
  enabled: boolean;
  channel_slug: string;
  target_name?: string;
  provider_id?: string;
  provider_kind?: string;
  created_at?: number;
  updated_at?: number;
}

export type ChannelRoleInfo = ChannelRoleAssignment;

export interface ChannelMemberInfo {
  account: string;
  added_by: string;
  added_at: number;
}

export interface JoinLinkInfo {
  code: string;
  url?: string;
  channel_slug: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  revoked_at: number | null;
}

export type ProjectAgentRunner = "codex" | "claude" | "codex-sdk" | "shell";
export type ProjectAgentWorktreeStrategy = "branch" | "shared" | "none";
export type ProjectAgentInvitableBy = "owner" | "org" | "anyone";

export interface ProjectAgentProfile {
  owner_account: string;
  handle: string;
  name: string;
  runner: ProjectAgentRunner;
  repo_url: string | null;
  workdir: string | null;
  base_branch: string;
  worktree_strategy: ProjectAgentWorktreeStrategy;
  rules: string | null;
  invitable_by: ProjectAgentInvitableBy;
  created_at: number;
  updated_at: number;
}

export interface ChannelProjectAgentInvite {
  id: number;
  channel_slug: string;
  owner_account: string;
  profile_handle: string;
  invited_by: string;
  invited_at: number;
  already_invited?: boolean;
  profile: ProjectAgentProfile;
}

export interface ProjectAgentRuntime {
  token: string;
  profile: ProjectAgentProfile;
}

export interface ProjectAgentChannelRuntime {
  token: string;
  name: string;
  role: "agent";
  owner: string;
  channel_scope: string;
  lineage: AgentLineage;
  profile: ProjectAgentProfile;
}

function extractError(status: number, body: unknown, raw: string): RestError {
  let code: string | null = null;
  let message = raw || `http ${status}`;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const err = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : b;
    if (typeof err.code === "string") code = err.code;
    if (typeof err.message === "string") message = err.message;
    else if (typeof b.error === "string") message = b.error;
  }
  if (!code && status === 401) code = "unauthorized";
  return new RestError(status, code, message);
}

// 所有 REST 调用的默认超时（#116）。没有它，一次 TCP 半开就让 serve 永久挂在 await 上：
// ping 还在跑、presence 显示在线，实际不再处理任何 @——最坏的一种失败（假在线）。
// 调用方可用 init.signal 覆盖（例如 watch 的长轮询）。
const REQ_TIMEOUT_MS = 30_000;

async function req(server: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const signal = init.signal ?? AbortSignal.timeout(REQ_TIMEOUT_MS);
  const res = await fetch(server.replace(/\/+$/, "") + path, { ...init, signal });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // 非 json 响应
  }
  if (!res.ok) throw extractError(res.status, body, raw);
  return body;
}

function bearerJson(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

// 公开配置：oidc issuer + web client_id + cli client_id（供 party login 知道去哪授权、用哪个 client）
export interface PublicConfig {
  issuer: string;
  clientId: string;
}

export async function fetchPublicConfig(server: string): Promise<PublicConfig> {
  const body = (await req(server, "/api/config")) as {
    oidc?: { issuer?: string; client_id?: string } | null;
    cli_client_id?: string;
  } | null;
  const issuer = body?.oidc?.issuer;
  if (!issuer) throw new Error("server has no OIDC configured (cannot party login)");
  // cli_client_id 缺省回落到 web 的 client_id（老 worker 尚未返 cli_client_id 时仍可用）
  const clientId = body.cli_client_id ?? body.oidc?.client_id;
  if (!clientId) throw new Error("server did not advertise a cli client_id");
  return { issuer, clientId };
}

export interface Identity {
  name: string;
  email: string | null;
  kind: string;
  role: string;
  owner: string | null;
  // 权限自省（whoami --caps）：旧 server 无这些字段（可选）
  channel_scope?: string | null;
  lineage?: AgentLineage | null;
  // 会员骨架（#277）：旧 server 无这两个字段（可选）；缺失时按 free 处理（isMember 会兜底）。
  membership_tier?: "free" | "member" | null;
  member_since?: number | null;
  caps?: {
    send: boolean;
    create_channel: boolean;
    mint_agents: boolean;
    spawn_children?: boolean;
    scoped_to: string | null;
  };
}

export async function fetchMe(server: string, token: string): Promise<Identity> {
  return (await req(server, "/api/me", { headers: bearerJson(token) })) as Identity;
}

// #165：agent 设自己的全局唯一昵称（可被 @中文昵称 唤醒）。须 agent token 作 bearer。
export async function setNickname(server: string, token: string, nickname: string): Promise<{ nickname: string }> {
  return (await req(server, "/api/me/nickname", {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify({ nickname }),
  })) as { nickname: string };
}

// 账号自助铸 agent token（spec P3）：须账号会话作 bearer，owner 由 worker 从会话推导
export async function createAgent(
  server: string,
  token: string,
  name: string,
  channelScope?: string,
): Promise<{ token: string; name: string; owner?: string; channel_scope?: string }> {
  const body: Record<string, unknown> = { name };
  if (channelScope !== undefined) body.channel_scope = channelScope;
  return (await req(server, "/api/agents", {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { token: string; name: string; owner?: string; channel_scope?: string };
}

export async function listProjectAgentProfiles(server: string, token: string): Promise<ProjectAgentProfile[]> {
  const body = await req(server, "/api/agent-profiles", { headers: bearerJson(token) });
  const profiles = (body as Record<string, unknown> | null)?.profiles;
  return Array.isArray(profiles) ? (profiles as ProjectAgentProfile[]) : [];
}

export async function createProjectAgentProfile(
  server: string,
  token: string,
  body: {
    handle: string;
    name?: string;
    runner: ProjectAgentRunner;
    repo_url?: string;
    workdir?: string;
    base_branch?: string;
    worktree_strategy?: ProjectAgentWorktreeStrategy;
    rules?: string;
    invitable_by?: ProjectAgentInvitableBy;
  },
): Promise<ProjectAgentProfile> {
  return (await req(server, "/api/agent-profiles", {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as ProjectAgentProfile;
}

export async function inviteProjectAgent(
  server: string,
  token: string,
  slug: string,
  ownerAccount: string,
  handle: string,
): Promise<ChannelProjectAgentInvite> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/project-agents`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify({ owner_account: ownerAccount, handle }),
  })) as ChannelProjectAgentInvite;
}

export async function removeProjectAgentInvite(
  server: string,
  token: string,
  slug: string,
  ownerAccount: string,
  handle: string,
): Promise<{ ok: true; channel_slug: string; owner_account: string; profile_handle: string; revoked_at: number }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/project-agents`, {
    method: "DELETE",
    headers: bearerJson(token),
    body: JSON.stringify({ owner_account: ownerAccount, handle }),
  })) as { ok: true; channel_slug: string; owner_account: string; profile_handle: string; revoked_at: number };
}

export async function mintProjectAgentRuntimeToken(
  server: string,
  token: string,
  handle: string,
): Promise<ProjectAgentRuntime> {
  return (await req(server, `/api/agent-profiles/${encodeURIComponent(handle)}/runtime-token`, {
    method: "POST",
    headers: bearerJson(token),
  })) as ProjectAgentRuntime;
}

export async function listProjectAgentInvites(
  server: string,
  token: string,
  handle?: string,
): Promise<ChannelProjectAgentInvite[]> {
  const suffix = handle === undefined ? "" : `?handle=${encodeURIComponent(handle)}`;
  const body = await req(server, `/api/agent-profiles/invites${suffix}`, { headers: bearerJson(token) });
  const invites = (body as Record<string, unknown> | null)?.invites;
  return Array.isArray(invites) ? (invites as ChannelProjectAgentInvite[]) : [];
}

export async function ensureProjectAgentChannelRuntime(
  server: string,
  token: string,
  slug: string,
  ownerAccount: string,
  handle: string,
  childName: string,
): Promise<ProjectAgentChannelRuntime> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/project-agents/runtime-token`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify({ owner_account: ownerAccount, handle, name: childName }),
  })) as ProjectAgentChannelRuntime;
}

export async function spawnAgent(
  server: string,
  token: string,
  name: string,
  channelScope: string,
  opts: { ttlSec?: number; teamId?: string } = {},
): Promise<{
  token: string;
  name: string;
  role: "agent";
  owner: string;
  channel_scope: string;
  lineage: AgentLineage;
  expires_at: number;
}> {
  const body: Record<string, unknown> = { name, channel_scope: channelScope };
  if (opts.ttlSec !== undefined) body.ttl_sec = opts.ttlSec;
  if (opts.teamId !== undefined) body.team_id = opts.teamId;
  return (await req(server, "/api/spawn", {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as {
    token: string;
    name: string;
    role: "agent";
    owner: string;
    channel_scope: string;
    lineage: AgentLineage;
    expires_at: number;
  };
}

export async function createToken(
  server: string,
  adminSecret: string,
  name: string,
  role: TokenRole,
  owner?: string,
  channelScope?: string,
): Promise<{
  token: string;
  name: string;
  role: TokenRole;
  owner?: string;
  channel_scope?: string;
}> {
  // owner / channel_scope 仅在给出时进请求体，缺省不发，保持旧调用方的请求形状不变
  const body: Record<string, unknown> = { name, role };
  if (owner !== undefined) body.owner = owner;
  if (channelScope !== undefined) body.channel_scope = channelScope;
  return (await req(server, "/api/tokens", {
    method: "POST",
    headers: { "x-admin-secret": adminSecret, "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as {
    token: string;
    name: string;
    role: TokenRole;
    owner?: string;
    channel_scope?: string;
  };
}

export async function revokeToken(server: string, adminSecret: string, name: string): Promise<void> {
  await req(server, `/api/tokens/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { "x-admin-secret": adminSecret },
  });
}

// 会员骨架（#277）：owner 手动把账号翻成 member/free。走 ADMIN_SECRET（与铸 token 同一把钥匙）。
export async function setMembership(
  server: string,
  adminSecret: string,
  account: string,
  tier: "free" | "member",
): Promise<{ account: string; tier: "free" | "member"; member_since: number | null }> {
  return (await req(server, "/api/admin/membership", {
    method: "POST",
    headers: { "x-admin-secret": adminSecret, "content-type": "application/json" },
    body: JSON.stringify({ account, tier }),
  })) as { account: string; tier: "free" | "member"; member_since: number | null };
}

export async function listChannels(server: string, token: string): Promise<ChannelInfo[]> {
  const body = await req(server, "/api/channels", { headers: bearerJson(token) });
  if (Array.isArray(body)) return body as ChannelInfo[];
  const channels = (body as Record<string, unknown> | null)?.channels;
  return Array.isArray(channels) ? (channels as ChannelInfo[]) : [];
}

export async function fetchChannelCharter(server: string, token: string, slug: string): Promise<ChannelCharter> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/charter`, {
    headers: bearerJson(token),
  })) as ChannelCharter;
}

export async function setChannelCharter(
  server: string,
  token: string,
  slug: string,
  charter: string,
  expectedRev?: number,
): Promise<ChannelCharter> {
  const body: Record<string, unknown> = { charter };
  if (expectedRev !== undefined) body.expected_rev = expectedRev;
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/charter`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as ChannelCharter;
}

export async function fetchChannelPerms(server: string, token: string, slug: string): Promise<ChannelPerms> {
  const body = (await req(server, `/api/channels/${encodeURIComponent(slug)}/perms`, {
    headers: bearerJson(token),
  })) as { permissions?: ChannelPerms };
  if (!body.permissions) throw new Error("server did not return channel permissions");
  return body.permissions;
}

export async function setChannelPerms(
  server: string,
  token: string,
  slug: string,
  update: ChannelPermsUpdate,
): Promise<ChannelPerms> {
  const body = (await req(server, `/api/channels/${encodeURIComponent(slug)}/perms`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(update),
  })) as { permissions?: ChannelPerms };
  if (!body.permissions) throw new Error("server did not return channel permissions");
  return body.permissions;
}

export async function createChannel(
  server: string,
  token: string,
  body: {
    slug: string;
    title?: string;
    kind: ChannelKind;
    mode?: ChannelMode;
    visibility?: ChannelVisibility;
  },
): Promise<void> {
  await req(server, "/api/channels", {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  });
}

export async function addWebhook(
  server: string,
  token: string,
  slug: string,
  body: { name: string; url: string; secret: string; filter: WebhookFilter },
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/webhooks`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  });
}

export async function removeWebhook(
  server: string,
  token: string,
  slug: string,
  name: string,
): Promise<void> {
  await req(
    server,
    `/api/channels/${encodeURIComponent(slug)}/webhooks/${encodeURIComponent(name)}`,
    { method: "DELETE", headers: bearerJson(token) },
  );
}

export async function listWebhooks(
  server: string,
  token: string,
  slug: string,
): Promise<WebhookInfo[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/webhooks`, {
    headers: bearerJson(token),
  });
  if (Array.isArray(body)) return body as WebhookInfo[];
  const webhooks = (body as Record<string, unknown> | null)?.webhooks;
  return Array.isArray(webhooks) ? (webhooks as WebhookInfo[]) : [];
}

export async function getLarkNotifyStatus(
  server: string,
  token: string,
  slug: string,
): Promise<LarkNotifyStatus> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/lark-notify`, {
    headers: bearerJson(token),
  })) as LarkNotifyStatus;
}

export async function enableLarkNotify(
  server: string,
  token: string,
  slug: string,
): Promise<LarkNotifyStatus> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/lark-notify`, {
    method: "POST",
    headers: bearerJson(token),
  })) as LarkNotifyStatus;
}

export async function disableLarkNotify(
  server: string,
  token: string,
  slug: string,
): Promise<LarkNotifyStatus> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/lark-notify`, {
    method: "DELETE",
    headers: bearerJson(token),
  })) as LarkNotifyStatus;
}

export async function listTasks(
  server: string,
  token: string,
  slug: string,
  opts: { state?: TaskState; assignee?: string; limit?: number } = {},
): Promise<TaskRecord[]> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set("state", opts.state);
  if (opts.assignee !== undefined) params.set("assignee", opts.assignee);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/tasks${suffix}`, {
    headers: bearerJson(token),
  });
  const tasks = (body as Record<string, unknown> | null)?.tasks;
  return Array.isArray(tasks) ? (tasks as TaskRecord[]) : [];
}

export async function createTask(
  server: string,
  token: string,
  slug: string,
  body: {
    title: string;
    desc?: string;
    state?: TaskState;
    assignee?: { name: string; kind: TaskAssigneeKind } | null;
    priority?: number;
    labels?: string[];
    parent_id?: number;
    anchor_seqs?: number[];
    workflow_id?: string;
    scope?: string[];
    blocked_reason?: string | null;
    external_ref?: string;
  },
): Promise<TaskRecord> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/tasks`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as TaskRecord;
}

export async function updateTask(
  server: string,
  token: string,
  slug: string,
  id: number,
  body: {
    title?: string;
    desc?: string | null;
    state?: TaskState;
    assignee?: { name: string; kind: TaskAssigneeKind } | null;
    priority?: number;
    labels?: string[];
    scope?: string[];
    blocked_reason?: string | null;
  },
): Promise<TaskRecord> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/tasks/${id}`, {
    method: "PATCH",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as TaskRecord;
}

export async function listSquads(server: string, token: string, slug: string): Promise<ChannelSquad[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/squads`, {
    headers: bearerJson(token),
  });
  const squads = (body as Record<string, unknown> | null)?.squads;
  return Array.isArray(squads) ? (squads as ChannelSquad[]) : [];
}

export async function createSquad(
  server: string,
  token: string,
  slug: string,
  body: {
    name: string;
    title?: string;
    description?: string;
    leader?: string | null;
    members: string[];
  },
): Promise<ChannelSquad> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/squads`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as ChannelSquad;
}

export async function updateSquad(
  server: string,
  token: string,
  slug: string,
  name: string,
  body: {
    title?: string | null;
    description?: string | null;
    leader?: string | null;
    members?: string[];
  },
): Promise<ChannelSquad> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/squads/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as ChannelSquad;
}

export async function deleteSquad(
  server: string,
  token: string,
  slug: string,
  name: string,
): Promise<{ ok: true; squad: ChannelSquad }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/squads/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: bearerJson(token),
  })) as { ok: true; squad: ChannelSquad };
}

/** 取「最近 N 条」用的哨兵 before：服务端 before>0 时返回 seq<before 的最近 limit 条。 */
export const TAIL_BEFORE = Number.MAX_SAFE_INTEGER;

/**
 * 消息查询串。before 与 since 互斥——服务端 before 优先，这里直接不发 since，避免歧义。
 * 不传 before 时保持原有 since 正向语义。
 */
export function messagesQuery(o: {
  since?: number;
  before?: number;
  limit: number;
  completion?: boolean;
}): string {
  const params = new URLSearchParams();
  if (o.before !== undefined && o.before > 0) params.set("before", String(o.before));
  else params.set("since", String(o.since ?? 0));
  params.set("limit", String(o.limit));
  if (o.completion === true) params.set("completion", "1");
  return params.toString();
}

export async function fetchMessages(
  server: string,
  token: string,
  slug: string,
  since = 0,
  limit = 100,
  opts: { completion?: boolean; before?: number } = {},
): Promise<MsgFrame[]> {
  const query = messagesQuery({ since, limit, ...(opts.before === undefined ? {} : { before: opts.before }), ...(opts.completion === true ? { completion: true } : {}) });
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/messages?${query}`, { headers: bearerJson(token) });
  const messages = (body as Record<string, unknown> | null)?.messages;
  return Array.isArray(messages) ? (messages as MsgFrame[]) : [];
}

/** 最近 limit 条（「补上下文」的正确默认语义）。 */
export async function fetchRecentMessages(
  server: string, token: string, slug: string, limit = 100,
  opts: { completion?: boolean } = {},
): Promise<MsgFrame[]> {
  return fetchMessages(server, token, slug, 0, limit, { ...opts, before: TAIL_BEFORE });
}

export async function fetchPresence(server: string, token: string, slug: string): Promise<PresenceEntry[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/presence`, {
    headers: bearerJson(token),
  });
  const presence = (body as Record<string, unknown> | null)?.presence;
  return Array.isArray(presence) ? (presence as PresenceEntry[]) : [];
}

// 已读游标快照 + 频道最新 seq（Phase 2 · CLI）：给 `party who` 标注每个身份读到第几条 / 落后多少。
export async function fetchReadCursors(
  server: string,
  token: string,
  slug: string,
): Promise<{ cursors: ReadCursor[]; last_seq: number }> {
  const body = (await req(server, `/api/channels/${encodeURIComponent(slug)}/read-cursors`, {
    headers: bearerJson(token),
  })) as Record<string, unknown> | null;
  const cursors = Array.isArray(body?.cursors) ? (body.cursors as ReadCursor[]) : [];
  const last_seq = typeof body?.last_seq === "number" ? body.last_seq : 0;
  return { cursors, last_seq };
}

export async function reviseMessage(
  server: string,
  token: string,
  slug: string,
  seq: number,
  action: "edit" | "retract" | "supersede",
  body?: { body: string; mentions?: string[] },
): Promise<{ message: MsgFrame; superseded?: MsgFrame }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages/${seq}/${action}`, {
    method: "POST",
    headers: bearerJson(token),
    body: action === "retract" ? undefined : JSON.stringify(body),
  })) as { message: MsgFrame; superseded?: MsgFrame };
}

export async function reviewCompletion(
  server: string,
  token: string,
  slug: string,
  seq: number,
  body: { action: "approve" | "reject"; reason?: string },
): Promise<{ message: MsgFrame; reply: MsgFrame }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages/${seq}/review`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { message: MsgFrame; reply: MsgFrame };
}

export async function fetchWakeDeliveries(
  server: string,
  token: string,
  slug: string,
  opts: { since?: number; target?: string; limit?: number } = {},
): Promise<WakeDelivery[]> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.target !== undefined) params.set("target", opts.target);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/wake-deliveries${suffix}`, {
    headers: bearerJson(token),
  });
  const deliveries = (body as Record<string, unknown> | null)?.deliveries;
  return Array.isArray(deliveries) ? (deliveries as WakeDelivery[]) : [];
}

export async function createCapture(
  server: string,
  token: string,
  slug: string,
  body: { seq: number; kind: CaptureKind; note?: string },
): Promise<CaptureRecord> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/captures`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as CaptureRecord;
}

export async function listCaptures(
  server: string,
  token: string,
  slug: string,
  opts: { kind?: CaptureKind; since?: number; limit?: number } = {},
): Promise<CaptureRecord[]> {
  const params = new URLSearchParams();
  if (opts.kind !== undefined) params.set("kind", opts.kind);
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/captures${suffix}`, {
    headers: bearerJson(token),
  });
  const captures = (body as Record<string, unknown> | null)?.captures;
  return Array.isArray(captures) ? (captures as CaptureRecord[]) : [];
}

export async function listChannelRoles(
  server: string,
  token: string,
  slug: string,
): Promise<ChannelRoleInfo[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/roles`, {
    headers: bearerJson(token),
  });
  const roles = (body as Record<string, unknown> | null)?.roles;
  return Array.isArray(roles) ? (roles as ChannelRoleInfo[]) : [];
}

export async function setChannelRole(
  server: string,
  token: string,
  slug: string,
  name: string,
  role: CollaborationRole,
  responsibility?: string,
): Promise<ChannelRoleInfo> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/roles/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(responsibility === undefined ? { role } : { role, responsibility }),
  })) as ChannelRoleInfo;
}

export async function clearChannelRole(
  server: string,
  token: string,
  slug: string,
  name: string,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/roles/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: bearerJson(token),
  });
}

export async function setCompletionGate(
  server: string,
  token: string,
  slug: string,
  body: { gate: CompletionGate; policy?: CompletionReviewPolicy },
): Promise<{ gate: CompletionGate; policy: CompletionReviewPolicy }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/completion-gate`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { gate: CompletionGate; policy: CompletionReviewPolicy };
}

export async function setLoopGuard(
  server: string,
  token: string,
  slug: string,
  body: { enabled: boolean; limit?: number },
): Promise<{ enabled: boolean; limit: number | null }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/loop-guard`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { enabled: boolean; limit: number | null };
}

export interface LoopGuardState {
  enabled: boolean;
  limit: number;
  streak: number;
  remaining: number;
  resets_on: string;
}

// #174 loop guard 读路径：熔断前就能读到 limit/streak/remaining，agent 据此自我节流。
export async function getLoopGuard(server: string, token: string, slug: string): Promise<LoopGuardState> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/loop-guard`, {
    headers: bearerJson(token),
  })) as LoopGuardState;
}

export async function setWorkflowGuard(
  server: string,
  token: string,
  slug: string,
  body: { enabled: boolean; limit?: number },
): Promise<{ enabled: boolean; limit: number | null }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/workflow-guard`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { enabled: boolean; limit: number | null };
}

export async function setChannelVisibility(
  server: string,
  token: string,
  slug: string,
  body: { visibility: ChannelVisibility; confirm?: true },
): Promise<{ visibility: ChannelVisibility }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/visibility`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { visibility: ChannelVisibility };
}

export async function listChannelMembers(
  server: string,
  token: string,
  slug: string,
): Promise<ChannelMemberInfo[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/members`, {
    headers: bearerJson(token),
  });
  const members = (body as Record<string, unknown> | null)?.members;
  return Array.isArray(members) ? (members as ChannelMemberInfo[]) : [];
}

export async function addChannelMember(
  server: string,
  token: string,
  slug: string,
  account: string,
): Promise<ChannelMemberInfo> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/members/${encodeURIComponent(account)}`, {
    method: "PUT",
    headers: bearerJson(token),
  })) as ChannelMemberInfo;
}

export async function removeChannelMember(
  server: string,
  token: string,
  slug: string,
  account: string,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/members/${encodeURIComponent(account)}`, {
    method: "DELETE",
    headers: bearerJson(token),
  });
}

export async function createJoinLink(
  server: string,
  token: string,
  slug: string,
  body: { expires_in_sec?: number; max_uses?: number },
): Promise<JoinLinkInfo> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/join-links`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as JoinLinkInfo;
}

export async function revokeJoinLink(
  server: string,
  token: string,
  slug: string,
  code: string,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/join-links/${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers: bearerJson(token),
  });
}

export async function searchMessages(
  server: string,
  token: string,
  slug: string,
  opts: { query: string; since?: number; limit?: number; from?: string },
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: opts.query });
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.from !== undefined) params.set("from", opts.from);
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/search?${params.toString()}`, {
    headers: bearerJson(token),
  });
  const hits = (body as Record<string, unknown> | null)?.hits;
  return Array.isArray(hits) ? (hits as SearchHit[]) : [];
}

export type MessagePayload = Omit<SendMessageFrame, "type"> | Omit<SendStatusFrame, "type">;

const ULID_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ULID（#98）：48-bit 毫秒时间戳 + 80-bit 随机，时间有序、无依赖。仅需唯一性即可满足幂等，
// 时间有序还让服务端 (sender, key) 索引对最近消息更友好。crypto.getRandomValues 在 node/bun/浏览器均有。
function newIdempotencyKey(): string {
  let ts = Date.now();
  const time: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    time.unshift(ULID_CROCKFORD[ts % 32]!);
    ts = Math.floor(ts / 32);
  }
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  const rand: string[] = [];
  for (let i = 0; i < 16; i += 1) rand.push(ULID_CROCKFORD[rnd[i]! % 32]!);
  return time.join("") + rand.join("");
}

export type { Attachment };

export async function postMessage(
  server: string,
  token: string,
  slug: string,
  payload: MessagePayload,
): Promise<{ seq: number; completion_review?: CompletionReview }> {
  // 每次发送生成一个新的幂等键：调用方不必操心；重试（客户端超时重发 / 服务端 DO-reset clone 重发）
  // 携带同一 body 即同一 key，服务端据此去重。调用方若已带 key（少见）则尊重之。
  const body: MessagePayload = "idempotency_key" in payload && payload.idempotency_key !== undefined
    ? payload
    : { ...payload, idempotency_key: newIdempotencyKey() };
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { seq: number; completion_review?: CompletionReview };
}

// 附件上传（#176/#109）：blob 进 R2，返回引用元数据；随消息带在 attachments 字段里。
// serve 交付物（[attach] 文件 / 超过 BODY_LIMIT 的正文）走这里，绝不再 inline 进消息正文撞 413。
// content-type 直接透传给 worker（它会 split(";")[0] 归一化）；content-length 由 fetch 依 body 自动补。
export async function uploadAttachment(
  server: string,
  token: string,
  slug: string,
  filename: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<Attachment> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/attachments?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": contentType,
    },
    // typed array 是合法 BodyInit；不能走 bearerJson（它会把 content-type 钉成 application/json）
    body: bytes,
  })) as Attachment;
}

export async function archiveChannel(server: string, token: string, slug: string): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/archive`, {
    method: "POST",
    headers: bearerJson(token),
  });
}

export async function resetGuard(server: string, token: string, slug: string): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/reset-guard`, {
    method: "POST",
    headers: bearerJson(token),
  });
}

// 重置某个 workflow 的 no-progress 熔断（与 loop guard 的 reset-guard 分属两套熔断器）。
// human-only + moderator/host，服务端 /api/channels/:slug/workflows/:workflow_id/reset-guard 强制。
export async function resetWorkflowGuard(
  server: string,
  token: string,
  slug: string,
  workflowId: string,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(workflowId)}/reset-guard`, {
    method: "POST",
    headers: bearerJson(token),
  });
}

// 房主踢人：按参与者/token 名字踢出频道（防滥用 MVP，spec §5）
export async function kickParticipant(
  server: string,
  token: string,
  slug: string,
  name: string,
  mode: "disconnect" | "remove" = "disconnect",
): Promise<void> {
  const body = mode === "remove" ? { name, mode } : { name };
  await req(server, `/api/channels/${encodeURIComponent(slug)}/kick`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  });
}

// 人为暂停某 agent 的接待（issue #180）。resumeAt = 定时恢复时刻（epoch ms），省略则只能手动恢复。
export async function pauseAgent(
  server: string,
  token: string,
  slug: string,
  name: string,
  resumeAt?: number,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/presence/${encodeURIComponent(name)}/pause`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(resumeAt === undefined ? {} : { resume_at: resumeAt }),
  });
}

// 恢复某 agent 的接待（issue #180）。
export async function resumeAgent(server: string, token: string, slug: string, name: string): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/presence/${encodeURIComponent(name)}/resume`, {
    method: "POST",
    headers: bearerJson(token),
  });
}

// rest 错误 → 契约退出码
export function handleRestError(e: unknown): number {
  if (e instanceof RestError) {
    console.error(`error: ${e.code ?? e.status} ${e.message}`);
    if (e.status === 401) {
      // #2：旧版 CLI 会把「需升级」误报成 unauthorized，看着像 token 失效。附版本 + 升级指引降低误诊。
      console.error(
        `hint: 若确认 token 未撤销，多半是 CLI 过旧（当前 party v${pkg.version}）——旧版曾把「需升级」误报成本条。\n` +
          `      升级后重试：curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh`,
      );
      return EXIT_AUTH;
    }
    if (e.code === "loop_guard") return EXIT_LOOP_GUARD;
    // workflow guard 与 loop guard 同类：停手等人类，别换个措辞重试（#122）
    if (e.code === "workflow_guard") {
      console.error(
        "hint: workflow guard tripped — stop, report status blocked, wait for a human. Do not rephrase and retry.\n" +
          "      a human clears it with: party channel reset-workflow-guard <workflow_id> [slug]\n" +
          "      (the blocked workflow_id is named in the error above; plain `reset-guard` only clears the loop guard, not this)",
      );
      return EXIT_WORKFLOW_GUARD;
    }
    if (e.code === "archived") return EXIT_ARCHIVED;
    // 429：退避后再试，别立刻连打（#122）
    if (e.status === 429 || e.code === "rate_limited") {
      console.error("hint: rate limited — back off (exponential, start ~30s) before retrying. Do not hammer.");
      return EXIT_RATE_LIMITED;
    }
    return 1;
  }
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  return 1;
}
