// rest api 封装
import {
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_LOOP_GUARD,
  type CaptureKind,
  type CaptureRecord,
  type AgentLineage,
  type ChannelKind,
  type ChannelMode,
  type ChannelRoleAssignment,
  type CollaborationRole,
  type CompletionGate,
  type CompletionReview,
  type CompletionReviewPolicy,
  type MsgFrame,
  type PresenceEntry,
  type ReadCursor,
  type SearchHit,
  type SendMessageFrame,
  type SendStatusFrame,
  type TokenRole,
  type WakeDelivery,
  type WebhookFilter,
} from "@agentparty/shared";
import pkg from "../package.json" with { type: "json" };

export type { ChannelMode, WebhookFilter };
export type { CompletionGate, CompletionReview, CompletionReviewPolicy };
export type { CaptureKind, CaptureRecord };

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
}

export interface WebhookInfo {
  name: string;
  url: string;
  filter: WebhookFilter;
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

async function req(server: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(server.replace(/\/+$/, "") + path, init);
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

export async function fetchMessages(
  server: string,
  token: string,
  slug: string,
  since = 0,
  limit = 100,
  opts: { completion?: boolean } = {},
): Promise<MsgFrame[]> {
  const params = new URLSearchParams({ since: String(since), limit: String(limit) });
  if (opts.completion === true) params.set("completion", "1");
  const body = await req(
    server,
    `/api/channels/${encodeURIComponent(slug)}/messages?${params.toString()}`,
    { headers: bearerJson(token) },
  );
  const messages = (body as Record<string, unknown> | null)?.messages;
  return Array.isArray(messages) ? (messages as MsgFrame[]) : [];
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

export async function postMessage(
  server: string,
  token: string,
  slug: string,
  payload: MessagePayload,
): Promise<{ seq: number; completion_review?: CompletionReview }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(payload),
  })) as { seq: number; completion_review?: CompletionReview };
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
    if (e.code === "archived") return EXIT_ARCHIVED;
    return 1;
  }
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  return 1;
}
