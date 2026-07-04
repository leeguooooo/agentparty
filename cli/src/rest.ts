// rest api 封装
import {
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_LOOP_GUARD,
  type CaptureKind,
  type CaptureRecord,
  type ChannelKind,
  type ChannelMode,
  type MsgFrame,
  type PresenceEntry,
  type SearchHit,
  type SendMessageFrame,
  type SendStatusFrame,
  type TokenRole,
  type WakeDelivery,
  type WebhookFilter,
} from "@agentparty/shared";
import pkg from "../package.json" with { type: "json" };

export type { ChannelMode, WebhookFilter };
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
  archived_at: number | null;
  presence?: PresenceEntry[];
}

export interface WebhookInfo {
  name: string;
  url: string;
  filter: WebhookFilter;
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
  caps?: {
    send: boolean;
    create_channel: boolean;
    mint_agents: boolean;
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
): Promise<MsgFrame[]> {
  const body = await req(
    server,
    `/api/channels/${encodeURIComponent(slug)}/messages?since=${since}&limit=${limit}`,
    { headers: bearerJson(token) },
  );
  const messages = (body as Record<string, unknown> | null)?.messages;
  return Array.isArray(messages) ? (messages as MsgFrame[]) : [];
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
): Promise<{ seq: number }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(payload),
  })) as { seq: number };
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
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/kick`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify({ name }),
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
