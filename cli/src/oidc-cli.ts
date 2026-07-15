// 回环重定向 PKCE 登录流 + 令牌刷新 + bearer 解析（spec §4）
import { createHash, randomBytes } from "node:crypto";
import { accountPath, readAccount, writeAccount, type AccountSession } from "./account";
import { cwdStatePath, readConfigWithSource, type ConfigSourceInfo, type WorkspaceState } from "./config";
import { fetchPublicConfig } from "./rest";
import { healServerUrl } from "./validation";
import { readFileSync } from "node:fs";

// cwd-state 有 config_path 指针、但指向的文件已不在 → 一个「本该是 agent 却丢了 config」的孤儿标记。
function orphanedAgentPointer(): string | null {
  try {
    const st = JSON.parse(readFileSync(cwdStatePath(), "utf8")) as WorkspaceState;
    const pointer = st.bindings?.[st.channel] ?? st.config_path;
    if (!pointer) return null;
    try {
      readFileSync(pointer, "utf8");
      return null; // 文件还在，readConfigWithSource 的面包屑回落已经用它了，不是孤儿
    } catch {
      return pointer;
    }
  } catch {
    return null;
  }
}

const SCOPE = "openid profile email offline_access";
// 固定回环端口，事先登记到 SSO 白名单；占用则依次退，三个都占用报错（不随机挑端口）
export const LOOPBACK_PORTS = [8976, 8977, 8978];
// 访问令牌视为过期的提前量（秒），避免边界处刚好过期
const EXPIRY_SKEW_SEC = 60;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// PKCE：verifier 为 43~128 字符高熵串，challenge = base64url(sha256(verifier))
export function makeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function makeState(): string {
  return randomBytes(16).toString("base64url");
}

// id_token 只解 payload 取 email/sub；签名由 worker 侧校验，CLI 不做验签
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function issuerBase(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

async function tokenRequest(issuer: string, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${issuerBase(issuer)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // 非 json 错误体
  }
  if (!res.ok) {
    const b = body as { error?: string; error_description?: string } | null;
    const detail = b?.error_description || b?.error || raw || `http ${res.status}`;
    throw new Error(`token endpoint ${res.status}: ${detail}`);
  }
  const t = body as TokenResponse | null;
  if (!t?.access_token) throw new Error("token endpoint returned no access_token");
  return t;
}

export function exchangeCode(
  issuer: string,
  clientId: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenResponse> {
  return tokenRequest(issuer, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
}

export function refreshTokens(
  issuer: string,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  return tokenRequest(issuer, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

function buildAuthorizeUrl(
  issuer: string,
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${issuerBase(issuer)}/authorize?${q.toString()}`;
}

function browserHtml(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px -apple-system,sans-serif;padding:3rem;text-align:center">${body}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function defaultOpen(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    // 打不开就靠打印的 URL 手动开
  }
}

interface Loopback {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  done: Promise<string>;
}

// 在固定端口起一次性回环 server，收到 /callback 校验 state 后 resolve(code)
function startLoopback(ports: number[], expectedState: string, timeoutMs: number): Loopback {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const done = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const timer = setTimeout(
    () => rejectCode(new Error("login timed out waiting for browser redirect")),
    timeoutMs,
  );

  let server: ReturnType<typeof Bun.serve> | null = null;
  let boundPort = 0;
  let lastErr: unknown = null;
  for (const p of ports) {
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: p,
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
          const err = u.searchParams.get("error");
          const code = u.searchParams.get("code");
          const state = u.searchParams.get("state");
          if (err) {
            clearTimeout(timer);
            rejectCode(new Error(`authorization error: ${err}`));
            return browserHtml("login failed", "Authorization failed. You can close this tab.");
          }
          // state 校验：防 CSRF / 授权码注入，不匹配即拒
          if (!state || state !== expectedState) {
            clearTimeout(timer);
            rejectCode(new Error("state mismatch (possible CSRF), aborting login"));
            return browserHtml("login failed", "State mismatch. You can close this tab.");
          }
          if (!code) {
            clearTimeout(timer);
            rejectCode(new Error("callback missing authorization code"));
            return browserHtml("login failed", "No code. You can close this tab.");
          }
          clearTimeout(timer);
          resolveCode(code);
          return browserHtml("logged in", "Logged in. You can close this tab and return to the terminal.");
        },
      });
      boundPort = p;
      break;
    } catch (e) {
      lastErr = e;
      server = null;
    }
  }
  if (!server) {
    clearTimeout(timer);
    throw new Error(
      `all loopback ports busy (${ports.join(", ")}); free one and retry` +
        (lastErr instanceof Error ? `: ${lastErr.message}` : ""),
    );
  }
  return { server, port: boundPort, done };
}

export interface LoginOptions {
  ports?: number[];
  // 注入点：默认开系统浏览器；测试里模拟 IdP 直接回调
  openUrl?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
}

// 完整回环 PKCE 登录：拉 config → 起回环 server → 授权 → 换 token → 组装会话（不落盘，交给调用方）
export async function loginFlow(server: string, opts: LoginOptions = {}): Promise<AccountSession> {
  const { issuer, clientId } = await fetchPublicConfig(server);
  const verifier = makeVerifier();
  const challenge = challengeFor(verifier);
  const state = makeState();
  const ports = opts.ports ?? LOOPBACK_PORTS;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const lb = startLoopback(ports, state, timeoutMs);
  try {
    const redirectUri = `http://127.0.0.1:${lb.port}/callback`;
    const authorizeUrl = buildAuthorizeUrl(issuer, clientId, redirectUri, challenge, state);
    console.error(`if the browser did not open, visit:\n${authorizeUrl}`);
    // 开浏览器与等回调并发：先注册对 done 的等待（下一行 await），open 失败不致命（靠打印的 URL 手动开）
    void Promise.resolve((opts.openUrl ?? defaultOpen)(authorizeUrl)).catch(() => {});

    const code = await lb.done;
    const tokens = await exchangeCode(issuer, clientId, code, redirectUri, verifier);
    if (!tokens.refresh_token) {
      throw new Error("token endpoint returned no refresh_token (need offline_access)");
    }
    const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
    return {
      server,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: nowSec() + (tokens.expires_in ?? 3600),
      email: typeof claims.email === "string" ? claims.email : undefined,
      sub: typeof claims.sub === "string" ? claims.sub : undefined,
    };
  } finally {
    lb.server.stop(true);
  }
}

// 保证会话持有未过期的 access_token：过期则用 refresh_token 换新并落盘（含 refresh 轮换）
export async function ensureFreshAccess(
  sess: AccountSession,
): Promise<{ session: AccountSession; token: string }> {
  const fresh =
    !!sess.access_token && !!sess.expires_at && nowSec() < sess.expires_at - EXPIRY_SKEW_SEC;
  if (fresh) return { session: sess, token: sess.access_token! };

  const { issuer, clientId } = await fetchPublicConfig(sess.server);
  const tokens = await refreshTokens(issuer, clientId, sess.refresh_token);
  const updated: AccountSession = {
    ...sess,
    access_token: tokens.access_token,
    // refresh_token 轮换：IdP 返新则替换，否则沿用旧的
    refresh_token: tokens.refresh_token ?? sess.refresh_token,
    expires_at: nowSec() + (tokens.expires_in ?? 3600),
  };
  writeAccount(updated);
  return { session: updated, token: tokens.access_token };
}

export interface Auth {
  server: string;
  token: string;
}

export interface AccountInfo {
  present: boolean;
  path: string;
  server?: string;
  email?: string;
  sub?: string;
  expires_at?: number;
}

export interface ResolvedAuthDetailed {
  server: string | null;
  token: string | null;
  auth_source: "runtime_config" | "account_session" | "none";
  config: ConfigSourceInfo;
  account: AccountInfo;
}

export interface RuntimeIdentityInfo {
  name?: string | null;
  kind?: string | null;
  role?: string | null;
  owner?: string | null;
  channel_scope?: string | null;
}

function accountInfo(sess: AccountSession | null): AccountInfo {
  if (!sess) return { present: false, path: accountPath() };
  return {
    present: true,
    path: accountPath(),
    server: sess.server,
    ...(sess.email !== undefined ? { email: sess.email } : {}),
    ...(sess.sub !== undefined ? { sub: sess.sub } : {}),
    ...(sess.expires_at !== undefined ? { expires_at: sess.expires_at } : {}),
  };
}

// bearer 解析：显式绑定的 workspace 凭据（party init --token 写的 config.token）优先，
// 无则回落账号会话（纯 party login 的人类交互场景），自动刷新其 access_token。
// 关键：agent 用 `party init --token <agent-token>` 接入后必须以「该 agent」的身份发言——
// 若让残留的人类账号会话顶替，agent 就会以「人」的名义说话，且过期会话还会直接 401
// （「让 agent 加入」踩过：init 写了 ap_ token，却被旧 account.json 顶掉导致 send 失败）。
// server 必须与 credential source 成对选择，不能把 config server 和 account token 混用。
export async function resolveAuthDetailed(): Promise<ResolvedAuthDetailed> {
  const { config: cfg, source } = readConfigWithSource();
  const sess = readAccount();
  const useRuntimeConfig = !!cfg?.token;
  const useAccountSession = !useRuntimeConfig && !!sess?.refresh_token;
  const rawServer = useRuntimeConfig
    ? cfg!.server
    : useAccountSession
      ? sess!.server
      : cfg?.server ?? sess?.server;
  // 自愈缺协议头的 server（手改 config 的常见事故，生产实锤 #agentparty seq=725）：
  // 治不了就明确报出来，别让它流进 fetch 变成不可诊断的 "fetch() URL is invalid"
  const server = rawServer ? healServerUrl(rawServer) : undefined;
  if (rawServer && !server) {
    console.error(`config server url invalid: "${rawServer}" — expected like https://agentparty.example.com`);
  }
  if (!server) {
    return { server: null, token: null, auth_source: "none", config: source, account: accountInfo(sess) };
  }
  if (useRuntimeConfig) {
    return {
      server,
      token: cfg!.token,
      auth_source: "runtime_config",
      config: source,
      account: accountInfo(sess),
    };
  }
  if (useAccountSession) {
    // 身份误用护栏（issue #42）：config 无 token、正回落到人类账号会话，但 cwd-state 有个指向
    // 已失效路径的 config_path 面包屑——说明这本该是个 agent，只是丢了它的 config。宁可显著告警，
    // 避免 agent 静默以人类身份发言（冒充是安全问题）。
    const orphan = orphanedAgentPointer();
    if (orphan) {
      console.error(
        `⚠ identity would resolve to human account (${sess.email ?? "logged-in user"}), but this workspace was bound to an agent config at ${orphan} which is now missing. ` +
          `refusing human-account fallback; restore that file or run every command with AGENTPARTY_CONFIG=<path> (issues #42/#518).`,
      );
      return {
        server,
        token: null,
        auth_source: "none",
        config: source,
        account: accountInfo(sess),
      };
    }
    const { token } = await ensureFreshAccess(sess);
    return {
      server,
      token,
      auth_source: "account_session",
      config: source,
      account: accountInfo(readAccount() ?? sess),
    };
  }
  return { server, token: null, auth_source: "none", config: source, account: accountInfo(sess) };
}

export async function resolveAuth(): Promise<Auth | null> {
  const detailed = await resolveAuthDetailed();
  if (!detailed.server || !detailed.token) return null;
  return { server: detailed.server, token: detailed.token };
}

export function formatAuthDebugLine(auth: ResolvedAuthDetailed, runtime?: RuntimeIdentityInfo | null): string {
  const runtimeLabel = runtime?.name
    ? `${runtime.name} (${runtime.kind ?? "?"}/${runtime.role ?? "?"})`
    : auth.auth_source === "none"
      ? "not-logged-in"
      : "unverified";
  const owner = runtime?.owner ? ` owner=${runtime.owner}` : "";
  const scope = runtime?.channel_scope ? ` scope=${runtime.channel_scope}` : "";
  const cfg = auth.config.path ? `${auth.config.kind}:${auth.config.path}` : auth.config.kind;
  const fp = auth.config.token_fingerprint ? ` token=${auth.config.token_fingerprint}` : "";
  return `using runtime=${runtimeLabel}${owner}${scope} auth-source=${auth.auth_source} config=${cfg}${fp}`;
}
