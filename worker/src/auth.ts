// bearer/token 工具 — worker 侧鉴权唯一入口
import type { SenderKind, TokenRole } from "@agentparty/shared";

export interface TokenIdentity {
  name: string;
  role: TokenRole;
  kind: SenderKind;
  hash: string;
  // OIDC 人类 token 携带 email；ap_ token 无此字段
  email?: string;
  // 所属人：机器 ap_ token 取 tokens.owner 列；人类 OIDC token 取 email（退回 sub）。无则省略
  owner?: string;
  // principal.account（账号模型 spec §5.1）：ACL 的唯一身份锚点。
  //   OIDC 人类 = email ?? sub；带 owner 的 ap_ token = owner；legacy ap_ token（owner=null）= undefined。
  // 与 owner 目前取值一致，但语义分开：owner 是显示标签，account 是 canAccessChannel 判定依据。
  account?: string;
  // channel-scoped token（spec §5.3）：把该 token 限死单频道 slug。非空即触发 canAccessChannel 硬上限。
  //   OIDC 人类恒无 scope；普通 ap_ token 为 null/undefined；scoped token 取 tokens.channel_scope 列。
  channel_scope?: string;
}

export type BearerSource = "authorization" | "protocol" | "query";

export interface ExtractedBearer {
  token: string;
  source: BearerSource;
}

// OIDC 配置：env OIDC_ISSUER + OIDC_CLIENT_ID 都在时才启用，否则 JWT 一律拒（保持现状）
export interface OidcConfig {
  issuer: string;
  clientId: string;
}

export function oidcConfigFromEnv(env: {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
}): OidcConfig | null {
  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  return { issuer: issuer.replace(/\/+$/, ""), clientId };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ap_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// REST 写路径必须走 Authorization；浏览器 WebSocket 个人 token 走 Sec-WebSocket-Protocol，
// 分享链接为了可复制仍额外允许 ?t=。
export function extractBearer(request: Request, options: { allowQueryToken?: boolean } = {}): ExtractedBearer | null {
  const header = request.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return { token: header.slice(7).trim(), source: "authorization" };
  }
  if (options.allowQueryToken === true) {
    // 子协议形如 ["agentparty", <token>]；token 既可能是机器 ap_ token，也可能是
    // 人类 OIDC 的 JWT（eyJ… 开头）。取非 "agentparty" 标记的那段，别按 ap_ 前缀过滤，
    // 否则登录用户的 JWT 提取不到、WS 一直 401 重连。
    const protocolToken = request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((part) => part.trim())
      .find((part) => part.length > 0 && part !== "agentparty");
    if (protocolToken) return { token: protocolToken, source: "protocol" };
  }
  const queryToken = options.allowQueryToken === true ? new URL(request.url).searchParams.get("t") : null;
  return queryToken === null ? null : { token: queryToken, source: "query" };
}

export async function lookupToken(
  db: D1Database,
  token: string,
  oidc?: OidcConfig | null,
): Promise<TokenIdentity | null> {
  if (!token) return null;
  // 双轨（spec §10）：JWT（三段点分、非 ap_ 前缀）且配置了 OIDC 时走 OIDC 验证；
  // 其余（含未配 OIDC 时的任何 JWT）一律回落 D1 hash 查询，保持机器 ap_ token 现状。
  if (oidc && !token.startsWith("ap_") && looksLikeJwt(token)) {
    return verifyOidcToken(token, oidc);
  }
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT name, role, owner, channel_scope FROM tokens WHERE hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ name: string; role: string; owner: string | null; channel_scope: string | null }>();
  if (!row) return null;
  const role = row.role as TokenRole;
  return {
    name: row.name,
    role,
    kind: role === "agent" ? "agent" : "human",
    hash,
    owner: row.owner ?? undefined,
    // account = owner：带 owner 的 token → 走账号规则；legacy owner=null → account undefined → 过渡放行
    account: row.owner ?? undefined,
    // scoped token（含 readonly 分享 token）带 channel_scope；普通 token 为 undefined
    channel_scope: row.channel_scope ?? undefined,
  };
}

// ── OIDC access token（RS256 JWT）验证 ─────────────────────────────────────

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface JwksCacheEntry {
  keys: Jwk[];
  fetchedAt: number;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, JwksCacheEntry>();

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function base64UrlToBytes(seg: string): Uint8Array {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeSegment<T>(seg: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(seg))) as T;
  } catch {
    return null;
  }
}

async function fetchJwks(issuer: string): Promise<Jwk[]> {
  const res = await fetch(`${issuer}/jwks.json`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  return Array.isArray(data.keys) ? data.keys : [];
}

async function getJwks(issuer: string, forceRefresh = false): Promise<Jwk[]> {
  const cached = jwksCache.get(issuer);
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  try {
    const keys = await fetchJwks(issuer);
    jwksCache.set(issuer, { keys, fetchedAt: now });
    return keys;
  } catch (err) {
    // 拉取失败时回退旧缓存（若有），避免 issuer 抖动打断所有人的会话
    if (cached) return cached.keys;
    throw err;
  }
}

function selectKey(keys: Jwk[], kid?: string): Jwk | null {
  if (kid) return keys.find((k) => k.kid === kid) ?? null;
  return keys.find((k) => k.kty === "RSA") ?? null;
}

async function importVerifyKey(issuer: string, kid?: string): Promise<CryptoKey | null> {
  let key = selectKey(await getJwks(issuer), kid);
  // kid 轮换：缓存里找不到就强制刷新一次 JWKS
  if (!key) key = selectKey(await getJwks(issuer, true), kid);
  if (!key) return null;
  const { kid: _kid, ...rest } = key;
  try {
    return await crypto.subtle.importKey(
      "jwk",
      { ...rest, alg: "RS256", ext: true } as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

interface OidcClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  sub?: string;
  email?: string;
  name?: string;
}

async function verifyOidcToken(token: string, oidc: OidcConfig): Promise<TokenIdentity | null> {
  const [headerSeg, payloadSeg, sigSeg] = token.split(".");
  const header = decodeSegment<{ alg?: string; kid?: string }>(headerSeg);
  if (!header || header.alg !== "RS256") return null;
  const claims = decodeSegment<OidcClaims>(payloadSeg);
  if (!claims || !claims.sub) return null;
  // iss / aud / exp 校验（aud 允许字符串或数组）
  if (claims.iss !== oidc.issuer) return null;
  const audMatch =
    typeof claims.aud === "string"
      ? claims.aud === oidc.clientId
      : Array.isArray(claims.aud) && claims.aud.includes(oidc.clientId);
  if (!audMatch) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return null;
  // RS256 验签
  const key = await importVerifyKey(oidc.issuer, header.kid);
  if (!key) return null;
  const signed = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const signature = base64UrlToBytes(sigSeg);
  const ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signed);
  if (!ok) return null;
  // OIDC 人类：sub 作 name，role/kind=human；hash 用 oidc: 前哨（不落 D1，生命周期归 JWT exp）
  const email = typeof claims.email === "string" ? claims.email : undefined;
  return {
    name: claims.sub,
    email,
    role: "human",
    kind: "human",
    hash: `oidc:${claims.sub}`,
    // 所属人显示：有 email 用 email，否则退回 sub
    owner: email ?? claims.sub,
    // 账号锚点：OIDC 人类 = email ?? sub（spec §5.1）。OIDC 恒无 channel_scope（scoped 仅发给 ap_ token）
    account: email ?? claims.sub,
  };
}
