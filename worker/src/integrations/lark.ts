import type { MsgFrame } from "@agentparty/shared";

export type LarkProviderKind = "lark" | "feishu";
export type LarkReceiveIdType = "union_id" | "open_id" | "user_id" | "email";

export interface LarkProviderConfig {
  id: string;
  kind: LarkProviderKind;
  clientId: string;
  clientSecretEnv: string;
  tenantKey: string | null;
}

export interface LarkDirectoryUser {
  id: string;
  identifiers: string[];
  name: string;
  avatarUrl: string | null;
}

export class LarkDirectoryError extends Error {
  constructor(
    readonly kind: "permission" | "invalid_cursor" | "not_found" | "rate_limited" | "upstream",
    message: string,
  ) {
    super(message);
  }
}

export interface LarkWebhookPayload extends MsgFrame {
  channel: string;
  permalink: string;
}

type EnvLike = {
  AUTH_PROVIDERS?: string;
  LARK_CLIENT_SECRET?: string;
  FEISHU_CLIENT_SECRET?: string;
};

const DEFAULT_SECRET_ENV: Record<LarkProviderKind, string> = {
  lark: "LARK_CLIENT_SECRET",
  feishu: "FEISHU_CLIENT_SECRET",
};
const TOKEN_SKEW_MS = 60_000;
const DIRECTORY_CURSOR_VERSION = 1;
const DIRECTORY_CURSOR_MAX = 1_024;
const DIRECTORY_PAGE_TOKEN_MAX = 512;
const DIRECTORY_DEPARTMENT_BATCH = 4;
const DEPARTMENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-@.]{0,63}$/;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface DirectoryCursorState {
  v: 1;
  q: string;
  p: string;
  d: string;
  a: string[];
  u: string | null;
  n: string | null;
  s: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function providerSecret(env: EnvLike, provider: LarkProviderConfig): string {
  const secret = (env as Record<string, string | undefined>)[provider.clientSecretEnv]?.trim();
  if (!secret) throw new Error("lark provider secret is not configured");
  return secret;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function directoryCursorSignature(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload))).slice(0, 16);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function validPageToken(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= DIRECTORY_PAGE_TOKEN_MAX);
}

async function encodeDirectoryCursor(secret: string, state: DirectoryCursorState): Promise<string> {
  const payload = base64url(textEncoder.encode(JSON.stringify(state)));
  const encoded = `${payload}.${base64url(await directoryCursorSignature(secret, payload))}`;
  if (encoded.length > DIRECTORY_CURSOR_MAX) throw new LarkDirectoryError("upstream", "Lark directory cursor is too large");
  return encoded;
}

async function decodeDirectoryCursor(
  secret: string,
  cursor: string,
  query: string,
  providerId: string,
): Promise<DirectoryCursorState> {
  const invalid = () => new LarkDirectoryError("invalid_cursor", "Lark directory cursor is invalid");
  if (cursor.length === 0 || cursor.length > DIRECTORY_CURSOR_MAX) throw invalid();
  const [payload, signature, extra] = cursor.split(".");
  const payloadBytes = payload === undefined ? null : base64urlBytes(payload);
  const signatureBytes = signature === undefined ? null : base64urlBytes(signature);
  if (payloadBytes === null || signatureBytes === null || extra !== undefined) throw invalid();
  const expected = await directoryCursorSignature(secret, payload);
  if (!sameBytes(signatureBytes, expected)) throw invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(payloadBytes));
  } catch {
    throw invalid();
  }
  if (
    !isRecord(decoded) || decoded.v !== DIRECTORY_CURSOR_VERSION || decoded.q !== query || decoded.p !== providerId ||
    typeof decoded.d !== "string" || !DEPARTMENT_ID_RE.test(decoded.d) || !validPageToken(decoded.u) ||
    !Array.isArray(decoded.a) || decoded.a.length >= DIRECTORY_DEPARTMENT_BATCH ||
    !decoded.a.every((departmentId) => typeof departmentId === "string" && DEPARTMENT_ID_RE.test(departmentId)) ||
    !validPageToken(decoded.n) || typeof decoded.s !== "boolean" ||
    (!decoded.s && (decoded.d !== "0" || decoded.a.length !== 0 || decoded.n !== null))
  ) {
    throw invalid();
  }
  return decoded as unknown as DirectoryCursorState;
}

function authProviderConfigs(env: EnvLike): LarkProviderConfig[] {
  const raw = env.AUTH_PROVIDERS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const providers: LarkProviderConfig[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const kind = item.kind === "feishu" ? "feishu" : item.kind === "lark" ? "lark" : null;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const clientId = typeof item.client_id === "string" ? item.client_id.trim() : "";
    if (kind === null || !id || !clientId) continue;
    providers.push({
      id,
      kind,
      clientId,
      clientSecretEnv:
        typeof item.client_secret_env === "string" && item.client_secret_env.trim()
          ? item.client_secret_env.trim()
          : DEFAULT_SECRET_ENV[kind],
      tenantKey: typeof item.tenant_key === "string" && item.tenant_key.trim() ? item.tenant_key.trim() : null,
    });
  }
  return providers;
}

function larkError(data: Record<string, unknown>, status: number): LarkDirectoryError | null {
  const code = Number(data.code ?? 0);
  if (status >= 200 && status < 300 && code === 0) return null;
  const message = typeof data.msg === "string" ? data.msg : `Lark request failed (${status})`;
  if (status === 429) return new LarkDirectoryError("rate_limited", message);
  if (code === 40012) return new LarkDirectoryError("invalid_cursor", message);
  if (code === 41012 || code === 99992352 || code === 99992363 || code === 99992364 || code === 99992381) {
    return new LarkDirectoryError("not_found", message);
  }
  if (code === 41050 || code === 40004 || code === 40014 || /(?:permission|authority|scope)/i.test(message)) {
    return new LarkDirectoryError("permission", message);
  }
  return new LarkDirectoryError("upstream", message);
}

async function larkDirectoryRequest(
  env: EnvLike,
  provider: LarkProviderConfig,
  path: string,
): Promise<Record<string, unknown>> {
  const token = await getTenantAccessToken(env, provider);
  const res = await fetch(`${larkApiBase(provider.kind)}${path}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!isRecord(data)) throw new LarkDirectoryError("upstream", `Lark request failed (${res.status})`);
  const error = larkError(data, res.status);
  if (error !== null) throw error;
  return data;
}

function directoryUsers(data: Record<string, unknown>): LarkDirectoryUser[] {
  const payload = isRecord(data.data) ? data.data : {};
  const rows = Array.isArray(payload.user_list) ? payload.user_list : Array.isArray(payload.items) ? payload.items : [];
  const users: LarkDirectoryUser[] = [];
  for (const value of rows) {
    if (!isRecord(value)) continue;
    const identifiers = [value.union_id, value.open_id, value.user_id]
      .filter((identifier): identifier is string => typeof identifier === "string" && identifier.trim().length > 0)
      .map((identifier) => identifier.trim())
      .filter((identifier, index, all) => all.indexOf(identifier) === index);
    const id = identifiers[0] ?? "";
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!id || !name) continue;
    const avatar = isRecord(value.avatar) ? value.avatar : {};
    const avatarUrl = typeof avatar.avatar_72 === "string"
      ? avatar.avatar_72
      : typeof value.avatar_url === "string"
        ? value.avatar_url
        : null;
    users.push({ id, identifiers, name, avatarUrl });
  }
  return users;
}

async function nextLarkDepartments(
  env: EnvLike,
  provider: LarkProviderConfig,
  pageToken: string | null,
): Promise<{ departmentIds: string[]; nextPageToken: string | null } | null> {
  const params = new URLSearchParams({
    department_id_type: "open_department_id",
    fetch_child: "true",
    page_size: String(DIRECTORY_DEPARTMENT_BATCH),
  });
  if (pageToken !== null) params.set("page_token", pageToken);
  const data = await larkDirectoryRequest(
    env,
    provider,
    `/open-apis/contact/v3/departments/0/children?${params.toString()}`,
  );
  const payload = isRecord(data.data) ? data.data : {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    if (payload.has_more === true) throw new LarkDirectoryError("upstream", "Lark returned an empty department page");
    return null;
  }
  const departmentIds = items.map((item) => isRecord(item) && typeof item.open_department_id === "string"
    ? item.open_department_id.trim()
    : "");
  if (departmentIds.some((departmentId) => !DEPARTMENT_ID_RE.test(departmentId))) {
    throw new LarkDirectoryError("upstream", "Lark returned an invalid department id");
  }
  const nextPageToken = payload.has_more === true && typeof payload.page_token === "string" && payload.page_token
    ? payload.page_token
    : null;
  if (payload.has_more === true && nextPageToken === null) {
    throw new LarkDirectoryError("upstream", "Lark omitted the next department cursor");
  }
  return { departmentIds, nextPageToken };
}

async function advanceLarkDepartment(
  env: EnvLike,
  provider: LarkProviderConfig,
  state: DirectoryCursorState,
): Promise<DirectoryCursorState | null> {
  if (state.a.length > 0) {
    return { ...state, d: state.a[0], a: state.a.slice(1), u: null, s: true };
  }
  const batch = state.s
    ? state.n === null ? null : await nextLarkDepartments(env, provider, state.n)
    : await nextLarkDepartments(env, provider, null);
  if (batch === null) return null;
  return {
    v: DIRECTORY_CURSOR_VERSION,
    q: state.q,
    p: state.p,
    d: batch.departmentIds[0],
    a: batch.departmentIds.slice(1),
    u: null,
    n: batch.nextPageToken,
    s: true,
  };
}

export async function searchLarkDirectory(
  env: EnvLike,
  provider: LarkProviderConfig,
  query: string,
  cursor: string | null,
  pageSize: number,
): Promise<{ users: LarkDirectoryUser[]; nextCursor: string | null }> {
  const normalizedQuery = query.toLocaleLowerCase();
  const secret = providerSecret(env, provider);
  const state = cursor === null
    ? { v: DIRECTORY_CURSOR_VERSION, q: normalizedQuery, p: provider.id, d: "0", a: [], u: null, n: null, s: false } as DirectoryCursorState
    : await decodeDirectoryCursor(secret, cursor, normalizedQuery, provider.id);
  const params = new URLSearchParams({
    user_id_type: "union_id",
    department_id_type: "open_department_id",
    department_id: state.d,
    page_size: String(pageSize),
  });
  if (state.u !== null) params.set("page_token", state.u);
  const data = await larkDirectoryRequest(
    env,
    provider,
    `/open-apis/contact/v3/users/find_by_department?${params.toString()}`,
  );
  const users = directoryUsers(data).filter((user) => user.name.toLocaleLowerCase().includes(normalizedQuery));
  const payload = isRecord(data.data) ? data.data : {};
  const hasMore = payload.has_more === true;
  const pageToken = typeof payload.page_token === "string" && payload.page_token ? payload.page_token : null;
  if (hasMore && pageToken === null) throw new LarkDirectoryError("upstream", "Lark omitted the next user cursor");
  let nextState: DirectoryCursorState | null = hasMore
    ? { ...state, u: pageToken }
    : null;
  if (!hasMore) {
    nextState = await advanceLarkDepartment(env, provider, state);
  }
  return { users, nextCursor: nextState === null ? null : await encodeDirectoryCursor(secret, nextState) };
}

export async function getLarkDirectoryUser(
  env: EnvLike,
  provider: LarkProviderConfig,
  userId: string,
): Promise<LarkDirectoryUser> {
  const data = await larkDirectoryRequest(
    env,
    provider,
    `/open-apis/contact/v3/users/${encodeURIComponent(userId)}?user_id_type=union_id`,
  );
  const payload = isRecord(data.data) && isRecord(data.data.user) ? { data: { items: [data.data.user] } } : data;
  const user = directoryUsers(payload)[0];
  if (user === undefined || user.id !== userId) throw new LarkDirectoryError("not_found", "Lark user not found");
  return user;
}

export function resolveLarkProvider(env: EnvLike, preferredId?: string | null): LarkProviderConfig | null {
  const providers = authProviderConfigs(env);
  if (preferredId) {
    const matched = providers.find((provider) => provider.id === preferredId);
    if (matched) return matched;
  }
  return providers[0] ?? null;
}

export function larkApiBase(kind: LarkProviderKind): string {
  return kind === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com";
}

export function clearLarkTokenCache(): void {
  tokenCache.clear();
}

export function inferReceiveIdType(providerUserId: string, email: string | null = null): LarkReceiveIdType {
  if (email !== null && providerUserId === email) return "email";
  if (providerUserId.startsWith("ou_")) return "open_id";
  if (providerUserId.startsWith("on_")) return "union_id";
  if (providerUserId.includes("@")) return "email";
  return "union_id";
}

export async function getTenantAccessToken(env: EnvLike, provider: LarkProviderConfig): Promise<string> {
  const secret = providerSecret(env, provider);
  const cacheKey = `${provider.id}:${provider.kind}:${provider.clientId}:${secret}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now + TOKEN_SKEW_MS) return cached.token;
  const res = await fetch(`${larkApiBase(provider.kind)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: provider.clientId, app_secret: secret }),
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !isRecord(data)) throw new Error(`tenant_access_token failed (${res.status})`);
  if (data.code !== undefined && Number(data.code) !== 0) {
    const msg = typeof data.msg === "string" ? data.msg : "tenant_access_token failed";
    throw new Error(msg);
  }
  const token = typeof data.tenant_access_token === "string" ? data.tenant_access_token : "";
  if (!token) throw new Error("tenant_access_token missing");
  const expire = typeof data.expire === "number" ? data.expire : 3600;
  tokenCache.set(cacheKey, { token, expiresAt: now + Math.max(60, expire) * 1000 });
  return token;
}

export async function sendLarkCard(
  env: EnvLike,
  provider: LarkProviderConfig,
  receiveId: string,
  idType: LarkReceiveIdType,
  card: Record<string, unknown>,
): Promise<void> {
  const token = await getTenantAccessToken(env, provider);
  const res = await fetch(`${larkApiBase(provider.kind)}/open-apis/im/v1/messages?receive_id_type=${idType}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !isRecord(data) || (data.code !== undefined && Number(data.code) !== 0)) {
    const msg = isRecord(data) && typeof data.msg === "string" ? data.msg : `send message failed (${res.status})`;
    throw new Error(msg);
  }
}

export function buildMentionCard(payload: LarkWebhookPayload): Record<string, unknown> {
  const title = `AgentParty @${payload.mentions.join(", @")}`;
  const sender = payload.sender.display_name || payload.sender.handle || payload.sender.owner || payload.sender.name;
  const body = payload.kind === "status" ? payload.note || payload.body : payload.body;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: payload.kind === "status" ? "yellow" : "blue",
      title: { tag: "plain_text", content: title },
    },
    elements: [
      {
        tag: "markdown",
        content: `**${sender}** mentioned you in **#${payload.channel}**\n\n${body}`,
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "Open channel" },
            type: "primary",
            url: payload.permalink,
          },
        ],
      },
    ],
  };
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhookSignature(secret: string, rawBody: string, header: string | null | undefined): Promise<boolean> {
  const prefix = "hmac-sha256=";
  if (!header?.startsWith(prefix)) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualHex(header.slice(prefix.length).toLowerCase(), expected);
}
