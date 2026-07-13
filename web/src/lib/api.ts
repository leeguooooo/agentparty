// rest 封装 + token 存取。
// 规则（spec §10 / M2 契约）：URL 带 ?t= 时优先用它，并立即从地址栏移除；
// share token 只放 sessionStorage，本次标签页可刷新，避免长期落 localStorage。
import type { Attachment, ChannelRoleAssignment, ChannelSquad, CollaborationRole, MsgFrame, PresenceEntry, SearchHit, TaskAssigneeKind, TaskRecord, TaskState, TaskSummary, WakeDelivery } from "@agentparty/shared";
import { apiUrl } from "./base";
import { isTauriEnvironment } from "./desktopUpdater";
import type { WebSession } from "./oidc";

const TOKEN_KEY = "ap_token";
const SHARE_TOKEN_KEY = "ap_share_token";
const SESSION_KEY = "ap_oidc_session";
let activeShareToken: string | null = null;

export class AuthError extends Error {}
// 私有频道 ACL 拒入（spec §3 访问规则矩阵）：worker 回 403 forbidden / WS 1008 forbidden。
// 与 AuthError 区分——token 有效，只是这个频道不让进，不该回登录闸。
export class ForbiddenError extends Error {}
// 铸 agent token 时同名已存在（worker 409）——上层据此换名重试。
export class ConflictError extends Error {}
// 名字非法 / 保留名 / scope 非法（worker 400）——文案层面走内联红字。
export class ValidationError extends Error {}
export class LarkDirectoryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}

type ApiRequest = typeof fetchApi;

async function larkDirectoryError(res: Response): Promise<LarkDirectoryApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const retry = Number(res.headers.get("retry-after"));
  return new LarkDirectoryApiError(
    body?.error?.message ?? `Lark directory request failed (${res.status})`,
    res.status,
    body?.error?.code ?? "unavailable",
    Number.isFinite(retry) && retry > 0 ? retry : null,
  );
}

export interface LarkDirectoryUser {
  id: string;
  name: string;
  avatar_url: string | null;
  already_member: boolean;
}

export interface LarkDirectoryPage {
  users: LarkDirectoryUser[];
  next_cursor: string | null;
}

export async function searchLarkDirectory(
  token: string,
  slug: string,
  query: string,
  limit = 20,
  cursor: string | null = null,
): Promise<LarkDirectoryPage> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (cursor !== null) params.set("cursor", cursor);
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/lark-directory?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await larkDirectoryError(res);
  return (await res.json()) as LarkDirectoryPage;
}

export async function inviteLarkMember(
  token: string,
  slug: string,
  userId: string,
): Promise<LarkDirectoryUser> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/lark-members`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) throw await larkDirectoryError(res);
  return (await res.json()) as LarkDirectoryUser;
}

export function urlToken(): string | null {
  if (typeof window === "undefined") return null; // SSR/单测无 window 时不崩（无 URL token）
  return new URLSearchParams(window.location.search).get("t");
}

export function storedToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function isShareMode(): boolean {
  return activeShareToken !== null;
}

export function currentShareToken(): string | null {
  return activeShareToken ?? sessionStorage.getItem(SHARE_TOKEN_KEY);
}

// Temporarily leave share mode without losing this tab's credential across an auth redirect.
export function suspendShareMode(): void {
  activeShareToken = null;
}

export function getToken(): string | null {
  const queryToken = urlToken();
  if (queryToken !== null) {
    activeShareToken = queryToken;
    sessionStorage.setItem(SHARE_TOKEN_KEY, queryToken);
    dropUrlToken();
    return queryToken;
  }
  const sessionShareToken = sessionStorage.getItem(SHARE_TOKEN_KEY);
  if (sessionShareToken !== null) {
    activeShareToken = sessionShareToken;
    return sessionShareToken;
  }
  return storedToken();
}

export function saveToken(token: string) {
  // 桌面端绝不把「粘贴的 party token」落进持久化存储（#248）：桌面登录只经设备码配对
  // （refresh 存系统钥匙串）或 OIDC 浏览器登录换来的会话，粘贴的 token 至多驱动本次内存会话。
  // 这与 App 渲染层（桌面永不渲染粘贴登录闸）互为兜底——即便渲染层回归误挂粘贴闸，
  // 持久化边界仍拒绝写盘，保证桌面自身存储里不会留下粘贴的 party token。
  if (isTauriEnvironment()) return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
}

// OIDC 网页会话（access + refresh + 过期），用于静默续期。access_token 镜像到 ap_token，
// 故 getToken() 取到的仍是当前 access_token；续期后覆盖二者。
export function saveSession(sess: WebSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
  localStorage.setItem(TOKEN_KEY, sess.accessToken);
}

export function readSession(): WebSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as WebSession) : null;
  } catch {
    return null;
  }
}

export function clearShareToken() {
  activeShareToken = null;
  sessionStorage.removeItem(SHARE_TOKEN_KEY);
}

// 桌面版贴观看邀请链接（#297）：链接里的 ?t= 观看 token 不经地址栏，直接落进分享态。
// 与网页 getToken() 命中 ?t= 的分支等价（都设 activeShareToken + sessionStorage），
// 于是 isShareMode() 为真、ChannelPage 走只读——复用同一套 #186 观看机制。
export function applyShareToken(token: string) {
  activeShareToken = token;
  try {
    sessionStorage.setItem(SHARE_TOKEN_KEY, token);
  } catch {
    // 非浏览器测试环境无 sessionStorage；activeShareToken 已够驱动本次会话。
  }
}

// 分享 token 失效时退回粘贴登录：把 ?t= 从地址栏摘掉，避免 getToken 继续命中坏 token
export function dropUrlToken() {
  const url = new URL(window.location.href);
  url.searchParams.delete("t");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

// 频道列表页要「最近一条消息 + 参与者状态点」（spec §9 第 1 块），worker 聚合自各 do
export interface ChannelLastMessage {
  sender: string;
  kind: "message" | "status";
  body: string;
  ts: number;
}

// 频道访问档（#381）：public 任意人可读可参与；private 仅成员可读；
// public_watch 任意人可读（观看），但参与/发送需成员或被邀请。
export type Visibility = "public" | "private" | "public_watch";

export interface ChannelInfo {
  slug: string;
  title: string | null;
  topic: string | null;
  kind: "standing" | "temp";
  mode: "normal" | "party";
  // 公开/私有（spec §3.1）：默认 private，旧 worker 响应缺此字段时按私有处理（不显 PUBLIC 徽章）。
  // #381：public_watch = 任意人可观看、参与需邀请（读同 public，写需成员/被邀）。
  visibility: Visibility;
  // 当前身份能否管理本频道（转可见性/踢人/归档）。服务端按 isChannelModerator 算好的布尔，
  // 不含 owner 身份本身。旧 worker 缺此字段 → undefined，前端按「不可管理」处理（不渲染管理控件）。
  can_moderate?: boolean;
  // 我创建的（owner_account===我）；不回 owner_account 本身。旧 worker 缺此字段 → undefined 按 false 处理。
  owned?: boolean;
  // 我加入的（在 channel_members 里）。旧 worker 缺此字段 → undefined 按 false 处理。
  member?: boolean;
  // loop/workflow guard 配置：旧 worker 响应缺字段时按「未配置」处理（不渲染开关状态）。
  loop_guard_enabled?: number;
  loop_guard_limit?: number | null;
  workflow_guard_enabled?: number;
  workflow_guard_limit?: number;
  charter_rev?: number;
  created_at: number;
  archived_at: number | null;
  last_message: ChannelLastMessage | null;
  presence: PresenceEntry[];
}

export interface ChannelCharter {
  charter: string | null;
  charter_rev: number;
  updated_at: number | null;
  updated_by: string | null;
}

export interface ChannelIdentity {
  name: string;
  display: string;
  kind?: "agent" | "human";
  account?: string;
  handle?: string;
}

export type ChannelRoleInfo = ChannelRoleAssignment;

// 当前登录身份（spec §10）：topbar 显示真实 token name/kind/role，owner 仅作归属辅助信息。
export interface MeInfo {
  name: string;
  email: string | null;
  kind: "agent" | "human";
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  avatar_thumb: string | null;
  provider: string | null;
  tenant_key: string | null;
  role: "agent" | "human" | "readonly";
  owner: string | null;
  // 会员骨架（#277）：账号 free/member 层。旧 server 无这两个字段（可选）；缺失按 free 处理。
  membership_tier?: "free" | "member" | null;
  member_since?: number | null;
  channel_scope?: string | null;
  caps?: {
    send: boolean;
    create_channel: boolean;
    mint_agents: boolean;
    scoped_to: string | null;
  };
}

export async function fetchMe(token: string): Promise<MeInfo> {
  const res = await fetchApi("/api/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (!res.ok) throw new Error(`GET /api/me failed (${res.status})`);
  return (await res.json()) as MeInfo;
}

// 附件上传（#176）：把文件本体 POST 到频道，拿回 R2 引用元数据；随后发消息时带在 attachments 里。
// 体积上限 25MB 在服务端强制（超限 413）。TooLarge 单列以便前端给出明确文案。
export class TooLargeError extends Error {}

export async function uploadAttachment(token: string, slug: string, file: File): Promise<Attachment> {
  const res = await fetchApi(
    `/api/channels/${slug}/attachments?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    },
  );
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("not allowed to upload here");
  if (res.status === 413) throw new TooLargeError("file too large (max 25MB)");
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return (await res.json()) as Attachment;
}

// 附件下载（#176）：下载端点要 Bearer 鉴权，<img src>/<a href> 带不了头，所以取回 blob 再造 objectURL。
export async function fetchAttachmentBlob(token: string | null, url: string): Promise<Blob> {
  const res = await fetchApi(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("not allowed to read this attachment");
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return res.blob();
}

export async function listChannels(token: string): Promise<ChannelInfo[]> {
  const res = await fetchApi("/api/channels", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (!res.ok) throw new Error(`GET /api/channels failed (${res.status})`);
  const data = (await res.json()) as { channels: ChannelInfo[] };
  return data.channels;
}

// 频道页「让 agent 加入」：登录人类账号会话铸一枚 channel-scoped 的 agent token（spec §10）。
// owner 由服务端从会话推导，前端不传。明文 token 仅此一次返回，复制后即无法再取。
export interface ChannelAgent {
  token: string;
  name: string;
  channel_scope?: string;
  owner?: string;
  created_at?: number;
}

export interface ChannelAgentInfo {
  name: string;
  owner: string;
  channel_scope: string;
  created_at: number;
  nickname?: string | null;
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

export async function createChannelAgent(
  slug: string,
  name: string,
  token: string,
): Promise<ChannelAgent> {
  const res = await fetchApi("/api/agents", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, channel_scope: slug }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("no permission to mint agents here");
  if (res.status === 409) throw new ConflictError("agent name already exists");
  if (res.status === 400) throw new ValidationError("invalid agent name");
  if (!res.ok) throw new Error(`POST /api/agents failed (${res.status})`);
  return (await res.json()) as ChannelAgent;
}

export async function listChannelAgents(token: string, slug: string): Promise<ChannelAgentInfo[]> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/agents`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/agents failed (${res.status})`);
  const data = (await res.json()) as { agents: ChannelAgentInfo[] };
  return data.agents;
}

export async function setChannelAgentNickname(
  token: string,
  slug: string,
  name: string,
  nickname: string,
): Promise<{ name: string; nickname: string }> {
  const res = await fetchApi(
    `/api/channels/${encodeURIComponent(slug)}/agents/${encodeURIComponent(name)}/nickname`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ nickname }),
    },
  );
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid nickname");
  if (res.status === 409) throw new ConflictError("nickname unavailable");
  if (!res.ok) throw new Error(`PUT /api/channels/${slug}/agents/${name}/nickname failed (${res.status})`);
  return (await res.json()) as { name: string; nickname: string };
}

export async function listProjectAgentProfiles(token: string): Promise<ProjectAgentProfile[]> {
  const res = await fetchApi("/api/agent-profiles", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/agent-profiles failed (${res.status})`);
  const data = (await res.json()) as { profiles: ProjectAgentProfile[] };
  return data.profiles;
}

export async function createProjectAgentProfile(
  token: string,
  body: {
    handle: string;
    runner: ProjectAgentRunner;
    repo_url?: string;
    workdir?: string;
    base_branch?: string;
    worktree_strategy?: ProjectAgentWorktreeStrategy;
    rules?: string;
    invitable_by?: ProjectAgentInvitableBy;
  },
): Promise<ProjectAgentProfile> {
  const res = await fetchApi("/api/agent-profiles", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid project agent profile");
  if (!res.ok) throw new Error(`POST /api/agent-profiles failed (${res.status})`);
  return (await res.json()) as ProjectAgentProfile;
}

export async function inviteProjectAgent(
  token: string,
  slug: string,
  profile: ProjectAgentProfile,
): Promise<ChannelProjectAgentInvite> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/project-agents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ owner_account: profile.owner_account, handle: profile.handle }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid project agent invite");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/project-agents failed (${res.status})`);
  return (await res.json()) as ChannelProjectAgentInvite;
}

export async function fetchChannelIdentities(token: string, slug: string): Promise<ChannelIdentity[]> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/identities`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/identities failed (${res.status})`);
  const data = (await res.json()) as { identities: ChannelIdentity[] };
  return data.identities;
}

export async function fetchChannelRoles(token: string, slug: string): Promise<ChannelRoleInfo[]> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/roles`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/roles failed (${res.status})`);
  const data = (await res.json()) as { roles: ChannelRoleInfo[] };
  return data.roles;
}

export async function fetchTasks(token: string, slug: string): Promise<TaskRecord[]> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/tasks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/tasks failed (${res.status})`);
  const data = (await res.json()) as { tasks: TaskRecord[] };
  return data.tasks;
}

export async function fetchTaskSummary(token: string, slug: string): Promise<TaskSummary> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/tasks/summary`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/tasks/summary failed (${res.status})`);
  return (await res.json()) as TaskSummary;
}

export async function fetchSquads(token: string, slug: string): Promise<ChannelSquad[]> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/squads`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/squads failed (${res.status})`);
  const data = (await res.json()) as { squads: ChannelSquad[] };
  return data.squads;
}

export async function createTask(
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
    attachments?: Attachment[];
  },
): Promise<TaskRecord> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid task");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/tasks failed (${res.status})`);
  return (await res.json()) as TaskRecord;
}

export async function updateTask(
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
  },
): Promise<TaskRecord> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/tasks/${id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid task update");
  if (!res.ok) throw new Error(`PATCH /api/channels/${slug}/tasks/${id} failed (${res.status})`);
  return (await res.json()) as TaskRecord;
}

export async function reviewCompletion(
  token: string,
  slug: string,
  seq: number,
  body: { action: "approve" } | { action: "reject"; reason: string },
): Promise<{ message: MsgFrame; reply?: MsgFrame }> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/messages/${seq}/review`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid review");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/messages/${seq}/review failed (${res.status})`);
  return (await res.json()) as { message: MsgFrame; reply?: MsgFrame };
}

// 频道决策协议（#284）：人类/moderator 在频道内对某条 decision_request 拍板。
export async function respondDecision(
  token: string,
  slug: string,
  seq: number,
  body: { action: "approve" | "reject"; reason?: string } | { option: number | string; reason?: string },
): Promise<{ message: MsgFrame; reply?: MsgFrame }> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/messages/${seq}/decision`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400 || res.status === 409) throw new ValidationError("invalid decision response");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/messages/${seq}/decision failed (${res.status})`);
  return (await res.json()) as { message: MsgFrame; reply?: MsgFrame };
}

export async function setDecisionMode(
  token: string,
  slug: string,
  mode: "approval" | "unattended",
): Promise<{ mode: string }> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/decision-mode`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid decision mode");
  if (!res.ok) throw new Error(`PUT /api/channels/${slug}/decision-mode failed (${res.status})`);
  return (await res.json()) as { mode: string };
}

export async function setChannelRole(
  token: string,
  slug: string,
  name: string,
  role: CollaborationRole,
  responsibility: string,
  // #370：向谁汇报（可跨 owner）。undefined=不改；null=清空（顶层）；否则 agent 名。
  reportsTo?: string | null,
): Promise<ChannelRoleInfo> {
  const body: Record<string, unknown> = { role, responsibility };
  if (reportsTo !== undefined) body.reports_to = reportsTo;
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/roles/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid role assignment");
  if (!res.ok) throw new Error(`PUT /api/channels/${slug}/roles/${name} failed (${res.status})`);
  return (await res.json()) as ChannelRoleInfo;
}

export async function deleteChannelRole(token: string, slug: string, name: string): Promise<void> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/roles/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid role assignment");
  if (!res.ok) throw new Error(`DELETE /api/channels/${slug}/roles/${name} failed (${res.status})`);
}

export async function rotateChannelAgent(token: string, slug: string, name: string): Promise<ChannelAgent> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/agents/${encodeURIComponent(name)}/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 404) throw new Error("agent token not found");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/agents/${name}/rotate failed (${res.status})`);
  return (await res.json()) as ChannelAgent;
}

// 页面建频道（spec §3.1）：登录人类账号可建公开/私有频道；scoped/readonly token 会被服务端 403。
// owner_account 由服务端从会话推导。201 只回 {slug,title,kind,mode,visibility}，列表随后刷新补全。
export interface NewChannel {
  slug: string;
  title?: string;
  mode?: "normal" | "party";
  visibility?: Visibility;
}

export async function createChannel(
  token: string,
  input: NewChannel,
): Promise<{ slug: string }> {
  const res = await fetchApi("/api/channels", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "standing", ...input }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("no permission to create channels");
  if (res.status === 409) throw new ConflictError("slug already exists");
  if (res.status === 400) throw new ValidationError("invalid channel");
  if (!res.ok) throw new Error(`POST /api/channels failed (${res.status})`);
  return (await res.json()) as { slug: string };
}

// IM 式加载都走这条 rest：初始最新一页（before=MAX_SAFE_INTEGER）、触顶上翻（before=已加载
// 最老 seq）、归档频道回看（ws 被 1008 踢掉零补推，spec §6）。带 before 反向取最近 limit 条，仍升序返回。
export async function fetchMessages(
  token: string,
  slug: string,
  opts: { limit?: number; before?: number } = {},
): Promise<MsgFrame[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 1000) });
  if (opts.before !== undefined) params.set("before", String(opts.before));
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/messages?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/messages failed (${res.status})`);
  const data = (await res.json()) as { messages: MsgFrame[] };
  return data.messages;
}

export async function fetchMessagesWithRetry(
  token: string,
  slug: string,
  opts: { limit?: number; before?: number } = {},
  retry: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MsgFrame[]> {
  const attempts = Math.max(1, Math.floor(retry.attempts ?? 2));
  const delayMs = Math.max(0, retry.delayMs ?? 400);
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchMessages(token, slug, opts);
    } catch (error) {
      if (error instanceof AuthError || error instanceof ForbiddenError) throw error;
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

// @ 唤醒回执：webhook 唤醒台账(spec wake-deliveries)。since=最老可见 seq 限定窗口，返回该窗口内
// 每条 @ 的唤醒尝试(ok/failed/http/error) + 复活链接。serve/watch 型 agent 不产生台账行(它们是连着的
// 客户端，不靠服务端 POST)，那部分回执由 presence + 回复链接在前端补齐。
export async function fetchWakeDeliveries(
  token: string,
  slug: string,
  opts: { since?: number; limit?: number } = {},
): Promise<WakeDelivery[]> {
  const params = new URLSearchParams({
    since: String(opts.since ?? 0),
    limit: String(opts.limit ?? 100),
  });
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/wake-deliveries?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/wake-deliveries failed (${res.status})`);
  const data = (await res.json()) as { deliveries: WakeDelivery[] };
  return data.deliveries;
}

// 消息右键菜单（PR #49）：编辑/撤回走 REST POST /messages/:seq/:action，权限沿用后端 sender||moderator。
export async function reviseMessage(
  slug: string,
  seq: number,
  action: "edit" | "retract",
  body?: { body: string; mentions?: string[] },
): Promise<{ message: MsgFrame }> {
  const token = getToken();
  if (token === null) throw new AuthError("missing token");
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/messages/${encodeURIComponent(String(seq))}/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(action === "edit" ? { "content-type": "application/json" } : {}),
    },
    body: action === "edit" ? JSON.stringify(body ?? {}) : undefined,
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid message revision");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/messages/${seq}/${action} failed (${res.status})`);
  return (await res.json()) as { message: MsgFrame };
}

// 人类账号设置 @handle（PUT /api/me/handle）：400 格式非法 / 403 非人类账号 / 409 冲突。
export async function setHandle(handle: string): Promise<{ handle: string }> {
  const token = getToken();
  if (token === null) throw new AuthError("missing token");
  const res = await fetchApi("/api/me/handle", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid handle");
  if (res.status === 409) throw new ConflictError("handle unavailable");
  if (!res.ok) throw new Error(`PUT /api/me/handle failed (${res.status})`);
  return (await res.json()) as { handle: string };
}

// #165：agent 会话设置昵称（PUT /api/me/nickname）：400 格式非法 / 403 非 agent / 409 冲突。
// 与 setHandle 同形，只是别名可含 unicode（中文），后端 nicknameConflict 判全局唯一。
export async function setNickname(nickname: string): Promise<{ nickname: string }> {
  const token = getToken();
  if (token === null) throw new AuthError("missing token");
  const res = await fetchApi("/api/me/nickname", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid nickname");
  if (res.status === 409) throw new ConflictError("nickname unavailable");
  if (!res.ok) throw new Error(`PUT /api/me/nickname failed (${res.status})`);
  return (await res.json()) as { nickname: string };
}

export async function fetchChannelCharter(token: string, slug: string): Promise<ChannelCharter> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/charter`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/charter failed (${res.status})`);
  return (await res.json()) as ChannelCharter;
}

export async function setChannelCharter(token: string, slug: string, charter: string): Promise<ChannelCharter> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/charter`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ charter }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 413) throw new ValidationError("charter too large");
  if (!res.ok) throw new Error(`PUT /api/channels/${slug}/charter failed (${res.status})`);
  return (await res.json()) as ChannelCharter;
}

export async function searchMessages(
  token: string,
  slug: string,
  opts: { query: string; from?: string; since?: number; limit?: number },
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: opts.query });
  if (opts.from !== undefined && opts.from !== "") params.set("from", opts.from);
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/search?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/search failed (${res.status})`);
  const data = (await res.json()) as { hits: SearchHit[] };
  return data.hits;
}

export async function resetGuard(token: string, slug: string): Promise<void> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/reset-guard`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/reset-guard failed (${res.status})`);
}

// 私有频道邀请链接（issue #38 web）：点链接 → OIDC 登录 → 加入为成员。moderator（房主）专属，
// 服务端 isChannelModerator 强制；前端只对 canModerate 渲染入口，隐私性靠「只有创建者能生成」。
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

export async function createJoinLink(
  token: string,
  slug: string,
  opts: { expiresInSec?: number; maxUses?: number } = {},
): Promise<JoinLinkInfo> {
  const body: Record<string, number> = {};
  if (opts.expiresInSec !== undefined) body.expires_in_sec = opts.expiresInSec;
  if (opts.maxUses !== undefined) body.max_uses = opts.maxUses;
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/join-links`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only the channel owner can create invite links");
  if (res.status === 400) throw new ValidationError("invalid expiry or max-uses");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/join-links failed (${res.status})`);
  return (await res.json()) as JoinLinkInfo;
}

// 兑换邀请链接（访问 /join/<code> 的落地页调用）。需登录的人类账号；把当前账号加进频道成员。
// 返回 { channel_slug, joined }（joined=false 表示已经是成员，幂等）。
export async function redeemJoinLink(token: string, code: string): Promise<{ channel_slug: string; joined: boolean }> {
  const res = await fetchApi(`/api/join/${encodeURIComponent(code)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  // 别写死某个登录方式：部署方可能只配了 Lark/Feishu，也可能只配了 OIDC。
  if (res.status === 403) throw new ForbiddenError("join links require a signed-in human account (agents should use the party invite join pack)");
  if (res.status === 404) throw new ValidationError("this invite link doesn't exist");
  if (res.status === 410) {
    const b = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ValidationError(b.error?.message ?? "this invite link is no longer valid (expired / revoked / max uses reached)");
  }
  if (!res.ok) throw new Error(`POST /api/join/${code} failed (${res.status})`);
  return (await res.json()) as { channel_slug: string; joined: boolean };
}

export async function listJoinLinks(token: string, slug: string): Promise<JoinLinkInfo[]> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/join-links`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only the channel owner can view invite links");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/join-links failed (${res.status})`);
  const data = (await res.json()) as { links: JoinLinkInfo[] };
  return data.links;
}

export async function revokeJoinLink(token: string, slug: string, code: string): Promise<void> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/join-links/${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only the channel owner can revoke invite links");
  if (!res.ok && res.status !== 404) throw new Error(`DELETE join-link failed (${res.status})`);
}

export type ChannelJoinRequestState = "none" | "pending" | "rejected" | "approved" | "already_member";

export interface ChannelJoinRequest {
  id?: number | string;
  state: ChannelJoinRequestState;
  slug?: string;
  account?: string;
  requester_name?: string;
  requester_display?: string | null;
  requester_profile?: { display_name?: string | null; handle?: string | null; avatar_url?: string | null };
  note?: string | null;
  review_reason?: string | null;
  requested_at?: number;
}

function joinRequestFromPayload(payload: unknown): ChannelJoinRequest {
  const envelope = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const nested = envelope.request ?? envelope.join_request;
  const value = typeof nested === "object" && nested !== null ? nested as Record<string, unknown> : envelope;
  const rawState = value.state ?? value.status;
  const state: ChannelJoinRequestState =
    rawState === "pending" || rawState === "rejected" || rawState === "approved" || rawState === "already_member"
      ? rawState
      : "none";
  return { ...value, state } as ChannelJoinRequest;
}

export async function createChannelJoinRequest(
  token: string,
  slug: string,
  watchToken: string,
  note?: string,
  request: ApiRequest = fetchApi,
): Promise<ChannelJoinRequest> {
  const body = note === undefined || note.trim() === ""
    ? { watch_token: watchToken }
    : { watch_token: watchToken, note: note.trim() };
  const res = await request(`/api/channels/${encodeURIComponent(slug)}/join-requests`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("a signed-in human account is required");
  if (res.status === 400) throw new ValidationError("invalid join request");
  if (res.status === 409) throw new ConflictError("join request already approved or changed");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/join-requests failed (${res.status})`);
  return joinRequestFromPayload(await res.json().catch(() => ({})));
}

export async function getMyChannelJoinRequest(token: string, slug: string, request: ApiRequest = fetchApi): Promise<ChannelJoinRequest> {
  const res = await request(`/api/channels/${encodeURIComponent(slug)}/join-requests/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return { state: "none" };
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("a signed-in human account is required");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/join-requests/me failed (${res.status})`);
  return joinRequestFromPayload(await res.json());
}

export async function listChannelJoinRequests(
  token: string,
  slug: string,
  state: "pending" = "pending",
  request: ApiRequest = fetchApi,
): Promise<ChannelJoinRequest[]> {
  const params = new URLSearchParams({ state });
  const res = await request(`/api/channels/${encodeURIComponent(slug)}/join-requests?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only channel moderators can view join requests");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/join-requests failed (${res.status})`);
  const payload = await res.json() as { requests?: unknown[]; join_requests?: unknown[] } | unknown[];
  const requests = Array.isArray(payload) ? payload : payload.requests ?? payload.join_requests ?? [];
  return requests.map(joinRequestFromPayload);
}

export async function reviewChannelJoinRequest(
  token: string,
  slug: string,
  id: number | string,
  body: { action: "approve" } | { action: "reject"; reason: string },
  request: ApiRequest = fetchApi,
): Promise<ChannelJoinRequest> {
  const res = await request(
    `/api/channels/${encodeURIComponent(slug)}/join-requests/${encodeURIComponent(String(id))}/review`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only channel moderators can review join requests");
  if (res.status === 400 || res.status === 409) throw new ValidationError("invalid join request review");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/join-requests/${id}/review failed (${res.status})`);
  return joinRequestFromPayload(await res.json());
}

// 观看模式邀请（#186）：房主铸「频道内只读分享 token」，返回 /c/<slug>?t=<token> 围观链接。
// 与 join-links（参与模式）平行——观看链接无需登录，点开即读、发送禁用（复用 readonly 角色）。
// token 明文只在创建时回一次，故列表只能列 name/created_at，不能重现 URL。
export interface ShareLinkInfo {
  name: string;
  created_at: number;
  // 仅创建响应带；列表不回（明文取不回）
  url?: string;
  token?: string;
}

export async function createShareLink(token: string, slug: string): Promise<ShareLinkInfo> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/share-links`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only the channel owner can create watch links");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/share-links failed (${res.status})`);
  return (await res.json()) as ShareLinkInfo;
}

export async function listShareLinks(token: string, slug: string): Promise<ShareLinkInfo[]> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/share-links`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only the channel owner can view watch links");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/share-links failed (${res.status})`);
  return ((await res.json()) as { links: ShareLinkInfo[] }).links;
}

export async function revokeShareLink(token: string, slug: string, name: string): Promise<void> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/share-links/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only the channel owner can revoke watch links");
  if (!res.ok && res.status !== 404) throw new Error(`DELETE watch-link failed (${res.status})`);
}

export async function archiveChannel(token: string, slug: string): Promise<void> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/archive`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only the channel owner can archive");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/archive failed (${res.status})`);
}

export async function kickParticipant(token: string, slug: string, name: string, mode: "disconnect" | "remove" = "disconnect"): Promise<void> {
  const body = mode === "remove" ? { name, mode } : { name };
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/kick`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/kick failed (${res.status})`);
}

// 人为暂停某 agent 的接待（issue #180）。resumeAt = 定时恢复时刻（epoch ms），省略则手动恢复。moderator only。
export async function pauseAgent(token: string, slug: string, name: string, resumeAt?: number): Promise<void> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/presence/${encodeURIComponent(name)}/pause`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(resumeAt === undefined ? {} : { resume_at: resumeAt }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/presence/${name}/pause failed (${res.status})`);
}

// 恢复某 agent 的接待（issue #180）。moderator only。
export async function resumeAgent(token: string, slug: string, name: string): Promise<void> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/presence/${encodeURIComponent(name)}/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`POST /api/channels/${slug}/presence/${name}/resume failed (${res.status})`);
}

// 可见性切换（issue #38）。private→public 服务端要 confirm=true，未带时返回 409 + needs_confirm，
// 这里以 { needsConfirm, messageCount } resolve 让 UI 弹二段确认，而不是当错误抛。
export interface VisibilityResult {
  visibility?: Visibility;
  changed?: boolean;
  needsConfirm?: boolean;
  messageCount?: number;
}
export async function setChannelVisibility(
  token: string,
  slug: string,
  visibility: Visibility,
  confirm = false,
): Promise<VisibilityResult> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/visibility`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(confirm ? { visibility, confirm: true } : { visibility }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("only the channel owner can change visibility");
  if (res.status === 409) {
    const b = (await res.json().catch(() => ({}))) as { message_count?: number };
    return { needsConfirm: true, messageCount: b.message_count };
  }
  if (!res.ok) throw new Error(`PUT /api/channels/${slug}/visibility failed (${res.status})`);
  const b = (await res.json()) as { visibility?: Visibility; changed?: boolean };
  return { visibility: b.visibility, changed: b.changed };
}

// loop/workflow guard 配置开关：owner/human 专属，PUT 幂等返回最新配置。
export interface GuardResult {
  enabled: boolean;
  limit: number | null;
}

async function putGuard(token: string, slug: string, path: string, enabled: boolean, limit?: number): Promise<GuardResult> {
  const res = await fetchApi(`/api/channels/${encodeURIComponent(slug)}/${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(enabled ? { enabled, limit } : { enabled }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid guard limit");
  if (!res.ok) throw new Error(`PUT /api/channels/${slug}/${path} failed (${res.status})`);
  return (await res.json()) as GuardResult;
}

export async function setLoopGuard(token: string, slug: string, enabled: boolean, limit?: number): Promise<GuardResult> {
  return putGuard(token, slug, "loop-guard", enabled, limit);
}

export async function setWorkflowGuard(token: string, slug: string, enabled: boolean, limit?: number): Promise<GuardResult> {
  return putGuard(token, slug, "workflow-guard", enabled, limit);
}
