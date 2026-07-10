// 人类网页 OIDC 登录（spec §10 双轨）：授权码 + PKCE，public client（无 secret，S256）。
// access_token 当 bearer 用；SSO 的 access_token 仅 ~10min，故一并存 refresh_token，到期前静默续期
// （之前只存 access_token 不续期，每 10 分钟必掉登录）。
import { apiUrl } from "./base";
import { jwtSub } from "./sessionIdentity";

export interface OidcConfig {
  issuer: string;
  clientId: string;
}

export interface OAuthProviderConfig {
  type: "oauth";
  id: string;
  kind: "lark" | "feishu" | string;
  label: string;
  clientId: string;
  authorizeUrl: string;
  scope: string;
}

export interface OidcProviderConfig extends OidcConfig {
  type: "oidc";
  id: "@oidc";
  label: string;
}

export type AuthProviderConfig = OidcProviderConfig | OAuthProviderConfig;

export interface AuthConfig {
  oidc: OidcConfig | null;
  providers: AuthProviderConfig[];
}

export type JoinAuthAction = "redeem" | "begin-provider-login" | "request-token-login" | "none";

export interface JoinAuthDecisionInput {
  joinCode: string | null;
  hasToken: boolean;
  providerAvailable: boolean;
  providersResolved: boolean;
  providerLoginPending: boolean;
}

export function decideJoinAuthAction(input: JoinAuthDecisionInput): JoinAuthAction {
  if (input.joinCode === null) return "none";
  if (input.hasToken) return "redeem";
  if (input.providerLoginPending) return "none";
  if (!input.providersResolved) return "none";
  return input.providerAvailable ? "begin-provider-login" : "request-token-login";
}

// OAuth providers only accept HTTPS/browser callbacks today. Keep them out of the
// embedded Tauri WebView until desktop pairing is available.
export function authConfigForRuntime(config: AuthConfig, runtime: unknown = globalThis): AuthConfig {
  const isTauri = typeof runtime === "object" && runtime !== null && "__TAURI_INTERNALS__" in runtime;
  return isTauri ? { oidc: null, providers: [] } : config;
}

// 网页会话：access_token + refresh_token + 绝对过期秒（epoch），供静默续期用
export interface WebSession {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null; // epoch 秒；null 表示未知（保守当已过期处理）
  /**
   * 稳定身份锚点（#126 follow-up）：**优先 access_token.sub**，id_token.sub 仅作回退；解不出为 null。
   * 之所以以 access_token 为准——App 的 identityRef 用的是 jwtSub(token)（access token），
   * 服务端授权也按 access token 的 claims.sub 取身份；若以 id_token 为准，遇到 pairwise
   * subject 的 IdP 会把自己刚登录的会话判成别人的。
   */
  identity: string | null;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function toSession(data: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}): WebSession {
  if (!data.access_token) throw new Error("no access_token in token response");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: typeof data.expires_in === "number" ? nowSec() + data.expires_in : null,
    // 身份锚点用 access_token 的 sub：与 App 的 identityRef（jwtSub(token)）以及服务端的
    // 授权口径（worker 按 access token 的 claims.sub 取身份）三方一致。id_token 仅作回退——
    // 某些 IdP 的 id_token.sub 与 access_token.sub 不同（pairwise subject），若以 id_token 为准，
    // 标签会把自己刚登录的会话判成「别人的」。
    identity: jwtSub(data.access_token) ?? jwtSub(data.id_token),
  };
}

const VERIFIER_KEY = "ap_oidc_verifier";
const STATE_KEY = "ap_oidc_state";
const PROVIDER_KEY = "ap_oidc_provider";
export const CALLBACK_PATH = "/auth/callback";

export function parseAuthConfigPayload(data: unknown): AuthConfig {
  try {
    const payload = data as {
      oidc: { issuer?: string; client_id?: string } | null;
      auth?: {
        providers?: Array<{
          id?: string;
          kind?: string;
          label?: string;
          client_id?: string;
          authorize_url?: string;
          scope?: string;
        }>;
      };
    };
    const oidc =
      payload.oidc?.issuer && payload.oidc?.client_id
        ? { issuer: payload.oidc.issuer.replace(/\/+$/, ""), clientId: payload.oidc.client_id }
        : null;
    const providers: AuthProviderConfig[] = [];
    for (const item of payload.auth?.providers ?? []) {
      if (!item.id || !item.client_id || !item.authorize_url) continue;
      providers.push({
        type: "oauth",
        id: item.id,
        kind: item.kind ?? item.id,
        label: item.label || `Sign in with ${item.id}`,
        clientId: item.client_id,
        authorizeUrl: item.authorize_url,
        scope: item.scope ?? "",
      });
    }
    if (oidc !== null) {
      providers.push({ type: "oidc", id: "@oidc", label: "Sign in with account center", ...oidc });
    }
    return { oidc, providers };
  } catch {
    return { oidc: null, providers: [] };
  }
}

// worker 暴露的公开配置：未配 SSO provider 时 providers:[] → 降级到纯粘贴 token。
export async function fetchAuthConfig(baseOrigin?: string): Promise<AuthConfig> {
  try {
    const url = baseOrigin === undefined ? apiUrl("/api/config") : `${baseOrigin}/api/config`;
    const res = await fetch(url);
    if (!res.ok) return { oidc: null, providers: [] };
    return parseAuthConfigPayload(await res.json());
  } catch {
    return { oidc: null, providers: [] };
  }
}

export function isCallbackPath(): boolean {
  return window.location.pathname === CALLBACK_PATH;
}

function base64Url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLen = 48): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

// 生成 verifier/challenge 存 sessionStorage，跳 provider 授权页。
export async function beginLogin(config: AuthProviderConfig): Promise<void> {
  const verifier = randomString();
  const state = randomString(24);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(PROVIDER_KEY, config.id);
  const url = new URL(config.type === "oidc" ? `${config.issuer}/authorize` : config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", window.location.origin + CALLBACK_PATH);
  const scope = config.type === "oidc" ? "openid profile email offline_access" : config.scope;
  if (scope) url.searchParams.set("scope", scope);
  url.searchParams.set("code_challenge", await challengeOf(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  window.location.assign(url.toString());
}

// 回调：校验 state → 换 token。OIDC 走 public client，Lark/Feishu 走 worker 服务端换码。
export async function completeLogin(providers: AuthProviderConfig[], baseOrigin?: string): Promise<WebSession> {
  const params = new URLSearchParams(window.location.search);
  const providerError = params.get("error");
  if (providerError) {
    throw new Error(params.get("error_description") ?? providerError);
  }
  const code = params.get("code");
  const state = params.get("state");
  const savedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const providerId = sessionStorage.getItem(PROVIDER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(PROVIDER_KEY);
  if (!code || !state || !verifier || state !== savedState) {
    throw new Error("invalid sign-in callback");
  }
  const config = providers.find((provider) => provider.id === providerId) ?? providers[0] ?? null;
  if (config === null) throw new Error("sign-in provider is not configured");
  if (config.type === "oauth") {
    const callbackUrl = baseOrigin === undefined
      ? apiUrl(`/api/auth/${encodeURIComponent(config.id)}/callback`)
      : `${baseOrigin}/api/auth/${encodeURIComponent(config.id)}/callback`;
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        redirect_uri: window.location.origin + CALLBACK_PATH,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(data?.error?.message ?? `token exchange failed (${res.status})`);
    }
    return toSession((await res.json()) as Record<string, never>);
  }
  const res = await fetch(`${config.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: window.location.origin + CALLBACK_PATH,
      client_id: config.clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  return toSession((await res.json()) as Record<string, never>);
}

// 静默续期：用 refresh_token 换一枚新 access_token（SSO 会轮换 refresh_token，回传新的则替换）。
// 失败（refresh 过期/被撤/client 不符）抛错，上层据此清会话回登录闸。
export async function refreshSession(config: OidcConfig, refreshToken: string): Promise<WebSession> {
  const res = await fetch(`${config.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
  const next = toSession((await res.json()) as Record<string, never>);
  // 轮换：token 端点未回新 refresh_token 时沿用旧的
  if (next.refreshToken === null) next.refreshToken = refreshToken;
  return next;
}
