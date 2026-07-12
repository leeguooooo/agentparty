import type { TokenIdentity } from "./auth";

export interface DesktopPairingEnv {
  DB: D1Database;
  DESKTOP_PAIRING_SECRET?: string;
}

const PAIRING_TTL_MS = 300_000;
const ACCESS_TTL_MS = 300_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const START_WINDOW_MS = 10 * 60 * 1000;
const START_LIMIT = 20;
const WRONG_CODE_WINDOW_MS = 15 * 60 * 1000;
const WRONG_CODE_LIMIT = 5;
const WRONG_CODE_BLOCK_MS = 60 * 60 * 1000;
const RECOVERY_TTL_MS = 60_000;
const REFRESH_RECOVERY_MIN_AGE_MS = 1_000;
const REFRESH_RECOVERY_WINDOW_MS = 5 * 60_000;
const REFRESH_RECOVERY_CLAIM_SCALE = 4096;
const BASE20 = "23456789BCDFGHJKLMNP";
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const RECOVERY_HKDF_SALT = textEncoder.encode("agentparty.desktop-token-recovery.salt.v1");
const RECOVERY_HKDF_INFO = textEncoder.encode("agentparty.desktop-token-recovery.aes-256-gcm.v1");

interface PairingRow {
  id: string;
  code_challenge: string;
  device_secret_challenge: string;
  device_name: string;
  device_platform: string | null;
  device_app_version: string | null;
  status: "pending" | "approved" | "denied" | "consumed";
  account: string | null;
  proof_failures: number;
  poll_interval_sec: number;
  next_poll_at: number;
  created_at: number;
  expires_at: number;
}

interface SessionRow {
  id: string;
  account: string;
  device_name: string;
  device_platform: string | null;
  device_app_version: string | null;
  device_secret_challenge: string;
  access_hash: string;
  access_expires_at: number;
  refresh_hash: string;
  refresh_expires_at: number;
  created_at: number;
  updated_at: number;
  last_used_at: number;
  revoked_at: number | null;
}

interface DesktopTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  session_id: string;
}

interface RecoveryRow {
  pairing_id: string;
  session_id: string;
  device_code_hash: string;
  nonce: string;
  ciphertext: string;
  created_at: number;
  expires_at: number;
  device_secret_challenge: string;
  access_hash: string;
  access_expires_at: number;
  refresh_hash: string;
  refresh_expires_at: number;
  session_created_at: number;
  session_updated_at: number;
  revoked_at: number | null;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function sensitiveJson(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store, no-cache, max-age=0",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function sensitiveSerializedJson(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store, no-cache, max-age=0",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    },
  });
}

export function sensitiveEmpty(status = 204): Response {
  return new Response(null, {
    status,
    headers: {
      "cache-control": "no-store, no-cache, max-age=0",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    },
  });
}

function requireSecret(env: DesktopPairingEnv): string | null {
  const secret = env.DESKTOP_PAIRING_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function recoveryKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", textEncoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: RECOVERY_HKDF_SALT, info: RECOVERY_HKDF_INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function recoveryAad(
  pairingId: string,
  sessionId: string,
  deviceCodeHash: string,
  deviceSecretChallenge: string,
): Uint8Array {
  return textEncoder.encode(
    JSON.stringify([
      "agentparty.desktop-token-recovery.v1",
      pairingId,
      sessionId,
      deviceCodeHash,
      deviceSecretChallenge,
    ]),
  );
}

async function encryptRecoveryResponse(
  secret: string,
  plaintext: string,
  identifiers: {
    pairingId: string;
    sessionId: string;
    deviceCodeHash: string;
    deviceSecretChallenge: string;
  },
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: recoveryAad(
        identifiers.pairingId,
        identifiers.sessionId,
        identifiers.deviceCodeHash,
        identifiers.deviceSecretChallenge,
      ),
      tagLength: 128,
    },
    await recoveryKey(secret),
    textEncoder.encode(plaintext),
  );
  return { nonce: base64url(nonce), ciphertext: base64url(new Uint8Array(ciphertext)) };
}

async function decryptRecoveryResponse(secret: string, row: RecoveryRow): Promise<string | null> {
  const nonce = base64urlToBytes(row.nonce);
  const ciphertext = base64urlToBytes(row.ciphertext);
  if (!nonce || nonce.length !== 12 || !ciphertext || ciphertext.length <= 16) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: recoveryAad(
          row.pairing_id,
          row.session_id,
          row.device_code_hash,
          row.device_secret_challenge,
        ),
        tagLength: 128,
      },
      await recoveryKey(secret),
      ciphertext,
    );
    return textDecoder.decode(plaintext);
  } catch {
    return null;
  }
}

function randomCredential(prefix: "apd" | "apr"): string {
  return `${prefix}_${base64url(randomBytes(32))}`;
}

function randomUserCode(): string {
  let code = "";
  while (code.length < 10) {
    for (const byte of randomBytes(16)) {
      if (byte >= 240) continue;
      code += BASE20[byte % BASE20.length];
      if (code.length === 10) break;
    }
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

async function hmacHex(secret: string, purpose: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, textEncoder.encode(`${purpose}\0${value}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function desktopCredentialHash(secret: string, purpose: "access" | "refresh", token: string): Promise<string> {
  return hmacHex(secret, purpose, token);
}

async function s256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value))));
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = textEncoder.encode(left);
  const b = textEncoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

function requestIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== 10 || [...compact].some((char) => !BASE20.includes(char))) return null;
  return compact;
}

function validMetadata(body: Record<string, unknown> | null): {
  name: string;
  platform: string | null;
  appVersion: string | null;
} | null {
  const device = body?.device;
  if (typeof device !== "object" || device === null || Array.isArray(device)) return null;
  const raw = device as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const platform = raw.platform === undefined ? null : typeof raw.platform === "string" ? raw.platform.trim() : undefined;
  const appVersion = raw.app_version === undefined ? null : typeof raw.app_version === "string" ? raw.app_version.trim() : undefined;
  if (!name || name.length > 128 || platform === undefined || appVersion === undefined) return null;
  if ((platform?.length ?? 0) > 64 || (appVersion?.length ?? 0) > 64) return null;
  return { name, platform: platform || null, appVersion: appVersion || null };
}

async function audit(
  db: D1Database,
  event: string,
  values: { pairingId?: string; sessionId?: string; accountHash?: string; ipHash?: string },
): Promise<void> {
  await db.prepare(
    `INSERT INTO desktop_audit (event, pairing_id, session_id, account_hash, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(event, values.pairingId ?? null, values.sessionId ?? null, values.accountHash ?? null, values.ipHash ?? null, Date.now())
    .run();
}

function invalidDeviceGrant(): Response {
  return sensitiveJson(errorBody("invalid_grant", "invalid device grant"), 400);
}

function parseRecoveredTokenResponse(raw: string, sessionId: string): DesktopTokenResponse | null {
  try {
    const value = JSON.parse(raw) as Partial<DesktopTokenResponse>;
    if (
      !/^apd_[A-Za-z0-9_-]{43}$/.test(value.access_token ?? "") ||
      !/^apr_[A-Za-z0-9_-]{43}$/.test(value.refresh_token ?? "") ||
      value.token_type !== "Bearer" ||
      value.session_id !== sessionId ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      typeof value.refresh_expires_in !== "number" ||
      !Number.isFinite(value.refresh_expires_in) ||
      value.refresh_expires_in <= 0
    ) {
      return null;
    }
    return value as DesktopTokenResponse;
  } catch {
    return null;
  }
}

async function recoverConsumedPairing(
  env: DesktopPairingEnv,
  secret: string,
  pairing: PairingRow,
  deviceCodeHash: string,
  now: number,
  proofValid: boolean,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT r.pairing_id, r.session_id, r.device_code_hash, r.nonce, r.ciphertext,
            r.created_at, r.expires_at,
            s.device_secret_challenge, s.access_hash, s.access_expires_at,
            s.refresh_hash, s.refresh_expires_at, s.created_at AS session_created_at,
            s.updated_at AS session_updated_at, s.revoked_at
       FROM desktop_token_recoveries r
       JOIN desktop_sessions s ON s.id = r.session_id AND s.pairing_id = r.pairing_id
      WHERE r.pairing_id = ?`,
  )
    .bind(pairing.id)
    .first<RecoveryRow>();
  if (!row) {
    await audit(env.DB, "pairing_recovery_missing", { pairingId: pairing.id });
    return invalidDeviceGrant();
  }

  const stale =
    row.expires_at <= now ||
    row.revoked_at !== null ||
    row.access_expires_at <= now ||
    row.refresh_expires_at <= now ||
    row.session_updated_at !== row.session_created_at;
  const deviceHashValid = constantTimeEqual(row.device_code_hash, deviceCodeHash);
  const plaintext = await decryptRecoveryResponse(secret, row);
  const recovered = plaintext === null ? null : parseRecoveredTokenResponse(plaintext, row.session_id);
  const tokenHashesValid =
    recovered !== null &&
    constantTimeEqual(await desktopCredentialHash(secret, "access", recovered.access_token), row.access_hash) &&
    constantTimeEqual(await desktopCredentialHash(secret, "refresh", recovered.refresh_token), row.refresh_hash);
  const recoveryValid = !stale && deviceHashValid && recovered !== null && tokenHashesValid;
  if (!recoveryValid) {
    await env.DB.prepare("DELETE FROM desktop_token_recoveries WHERE pairing_id = ?")
      .bind(pairing.id)
      .run();
    await audit(env.DB, "pairing_recovery_auth_failed", { pairingId: pairing.id, sessionId: row.session_id });
    return invalidDeviceGrant();
  }
  if (!proofValid) {
    await audit(env.DB, "pairing_recovery_proof_failed", { pairingId: pairing.id, sessionId: row.session_id });
    return invalidDeviceGrant();
  }

  await audit(env.DB, "pairing_response_recovered", { pairingId: pairing.id, sessionId: row.session_id });
  return sensitiveSerializedJson(plaintext!);
}

async function consumeRateLimit(
  db: D1Database,
  scope: string,
  keyHash: string,
  windowMs: number,
): Promise<{ count: number; blockedUntil: number; windowStartedAt: number }> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO desktop_rate_limits (scope, key_hash, window_started_at, count, blocked_until, updated_at)
     VALUES (?, ?, ?, 1, 0, ?)
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
  )
    .bind(scope, keyHash, now, now, windowMs, windowMs)
    .run();
  const row = await db.prepare(
    "SELECT count, blocked_until, window_started_at FROM desktop_rate_limits WHERE scope = ? AND key_hash = ?",
  )
    .bind(scope, keyHash)
    .first<{ count: number; blocked_until: number; window_started_at: number }>();
  return {
    count: Number(row?.count ?? 1),
    blockedUntil: Number(row?.blocked_until ?? 0),
    windowStartedAt: Number(row?.window_started_at ?? now),
  };
}

async function wrongCodeGate(
  env: DesktopPairingEnv,
  secret: string,
  request: Request,
  account: string,
  increment: boolean,
): Promise<Response | null> {
  const now = Date.now();
  const ipHash = await hmacHex(secret, "rate-ip", requestIp(request));
  const accountHash = await hmacHex(secret, "rate-account", account);
  const keys = [
    { scope: "wrong-code-ip", hash: ipHash },
    { scope: "wrong-code-account", hash: accountHash },
  ];
  for (const key of keys) {
    const existing = await env.DB.prepare(
      "SELECT blocked_until FROM desktop_rate_limits WHERE scope = ? AND key_hash = ?",
    )
      .bind(key.scope, key.hash)
      .first<{ blocked_until: number }>();
    if (Number(existing?.blocked_until ?? 0) > now) {
      const retry = Math.max(1, Math.ceil((Number(existing!.blocked_until) - now) / 1000));
      return sensitiveJson(errorBody("rate_limited", "too many invalid user codes"), 429, { "retry-after": String(retry) });
    }
  }
  if (!increment) return null;
  let blocked = false;
  for (const key of keys) {
    const result = await consumeRateLimit(env.DB, key.scope, key.hash, WRONG_CODE_WINDOW_MS);
    if (result.count >= WRONG_CODE_LIMIT) {
      blocked = true;
      await env.DB.prepare(
        "UPDATE desktop_rate_limits SET blocked_until = ?, updated_at = ? WHERE scope = ? AND key_hash = ?",
      )
        .bind(now + WRONG_CODE_BLOCK_MS, now, key.scope, key.hash)
        .run();
    }
  }
  if (!blocked) return null;
  return sensitiveJson(errorBody("rate_limited", "too many invalid user codes"), 429, { "retry-after": "3600" });
}

function pairingView(row: PairingRow) {
  return {
    pairing_id: row.id,
    status: row.expires_at <= Date.now() ? "expired" : row.status,
    device: {
      name: row.device_name,
      platform: row.device_platform,
      app_version: row.device_app_version,
    },
    expires_in: Math.max(0, Math.ceil((row.expires_at - Date.now()) / 1000)),
  };
}

export async function startDesktopPairing(request: Request, env: DesktopPairingEnv): Promise<Response> {
  const secret = requireSecret(env);
  if (!secret) return sensitiveJson(errorBody("unavailable", "desktop pairing is not configured"), 503);
  const ipHash = await hmacHex(secret, "rate-ip", requestIp(request));
  const rate = await consumeRateLimit(env.DB, "pairing-start", ipHash, START_WINDOW_MS);
  if (rate.count > START_LIMIT) {
    const retry = Math.max(1, Math.ceil((rate.windowStartedAt + START_WINDOW_MS - Date.now()) / 1000));
    return sensitiveJson(errorBody("rate_limited", "too many pairing requests"), 429, { "retry-after": String(retry) });
  }
  await env.DB.prepare(
    `DELETE FROM desktop_token_recoveries
      WHERE pairing_id IN (
        SELECT pairing_id FROM desktop_token_recoveries
         WHERE expires_at <= ?
         ORDER BY expires_at
         LIMIT 100
      )`,
  )
    .bind(Date.now())
    .run();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const codeChallenge = typeof body?.code_challenge === "string" ? body.code_challenge : "";
  const deviceSecretChallenge = typeof body?.device_secret_challenge === "string" ? body.device_secret_challenge : "";
  const metadata = validMetadata(body);
  if (body?.code_challenge_method !== "S256" || !CHALLENGE_RE.test(codeChallenge) || !CHALLENGE_RE.test(deviceSecretChallenge) || !metadata) {
    return sensitiveJson(errorBody("bad_request", "valid S256 challenges and device metadata required"), 400);
  }

  const pairingId = crypto.randomUUID();
  const deviceCode = base64url(randomBytes(32));
  const userCode = randomUserCode();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO desktop_pairings (
       id, device_code_hash, user_code_hash, code_challenge, device_secret_challenge,
       device_name, device_platform, device_app_version, status, proof_failures,
       poll_interval_sec, next_poll_at, created_ip_hash, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 3, 0, ?, ?, ?)`,
  )
    .bind(
      pairingId,
      await hmacHex(secret, "device-code", deviceCode),
      await hmacHex(secret, "user-code", userCode.replace("-", "")),
      codeChallenge,
      deviceSecretChallenge,
      metadata.name,
      metadata.platform,
      metadata.appVersion,
      ipHash,
      now,
      now + PAIRING_TTL_MS,
    )
    .run();
  await audit(env.DB, "pairing_started", { pairingId, ipHash });
  const url = new URL(request.url);
  const verificationUrl = new URL("/pair", url.origin);
  const verificationUrlComplete = new URL(verificationUrl);
  verificationUrlComplete.searchParams.set("code", userCode);
  return sensitiveJson(
    {
      pairing_id: pairingId,
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUrl.toString(),
      verification_uri_complete: verificationUrlComplete.toString(),
      expires_in: 300,
      interval: 3,
    },
    201,
  );
}

async function pairingByUserCode(
  request: Request,
  env: DesktopPairingEnv,
  identity: TokenIdentity,
): Promise<{ row: PairingRow; secret: string } | Response> {
  const secret = requireSecret(env);
  if (!secret) return sensitiveJson(errorBody("unavailable", "desktop pairing is not configured"), 503);
  if (identity.role !== "human" || !identity.account || identity.desktopSessionId !== undefined) {
    return sensitiveJson(errorBody("forbidden", "an independently authenticated human browser session is required"), 403);
  }
  const blocked = await wrongCodeGate(env, secret, request, identity.account, false);
  if (blocked) return blocked;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const userCode = normalizeUserCode(body?.user_code);
  if (!userCode) return sensitiveJson(errorBody("bad_request", "invalid user_code"), 400);
  const row = await env.DB.prepare(
    `SELECT id, code_challenge, device_secret_challenge, device_name, device_platform,
            device_app_version, status, account, proof_failures, poll_interval_sec,
            next_poll_at, created_at, expires_at
       FROM desktop_pairings WHERE user_code_hash = ?`,
  )
    .bind(await hmacHex(secret, "user-code", userCode))
    .first<PairingRow>();
  if (!row) {
    const limited = await wrongCodeGate(env, secret, request, identity.account, true);
    if (limited) return limited;
    return sensitiveJson(errorBody("not_found", "pairing not found"), 404);
  }
  if (row.expires_at <= Date.now()) return sensitiveJson(errorBody("expired", "pairing expired"), 410);
  return { row, secret };
}

export async function inspectDesktopPairing(
  request: Request,
  env: DesktopPairingEnv,
  identity: TokenIdentity,
): Promise<Response> {
  const result = await pairingByUserCode(request, env, identity);
  if (result instanceof Response) return result;
  await audit(env.DB, "pairing_inspected", {
    pairingId: result.row.id,
    accountHash: await hmacHex(result.secret, "account", identity.account!),
  });
  return sensitiveJson(pairingView(result.row));
}

export async function decideDesktopPairing(
  request: Request,
  env: DesktopPairingEnv,
  identity: TokenIdentity,
): Promise<Response> {
  const clone = request.clone();
  const body = (await clone.json().catch(() => null)) as Record<string, unknown> | null;
  const decision = body?.decision;
  if (decision !== "approve" && decision !== "deny") {
    return sensitiveJson(errorBody("bad_request", "decision must be approve or deny"), 400);
  }
  const result = await pairingByUserCode(request, env, identity);
  if (result instanceof Response) return result;
  if (result.row.status !== "pending") return sensitiveJson(errorBody("conflict", "pairing already decided"), 409);
  const now = Date.now();
  const status = decision === "approve" ? "approved" : "denied";
  const updated = await env.DB.prepare(
    `UPDATE desktop_pairings
        SET status = ?, account = ?, approved_by = ?,
            approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END,
            denied_at = CASE WHEN ? = 'denied' THEN ? ELSE denied_at END
      WHERE id = ? AND status = 'pending' AND expires_at > ?`,
  )
    .bind(status, decision === "approve" ? identity.account : null, identity.name, status, now, status, now, result.row.id, now)
    .run();
  if (updated.meta.changes !== 1) return sensitiveJson(errorBody("conflict", "pairing already decided"), 409);
  await audit(env.DB, `pairing_${status}`, {
    pairingId: result.row.id,
    accountHash: await hmacHex(result.secret, "account", identity.account!),
  });
  return sensitiveJson({ pairing_id: result.row.id, status });
}

export async function exchangeDesktopPairing(request: Request, env: DesktopPairingEnv): Promise<Response> {
  const secret = requireSecret(env);
  if (!secret) return sensitiveJson(errorBody("unavailable", "desktop pairing is not configured"), 503);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const deviceCode = typeof body?.device_code === "string" ? body.device_code : "";
  const verifier = typeof body?.code_verifier === "string" ? body.code_verifier : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(deviceCode) || verifier.length < 43 || verifier.length > 128) {
    return sensitiveJson(errorBody("bad_request", "valid device_code and code_verifier required"), 400);
  }
  const deviceHash = await hmacHex(secret, "device-code", deviceCode);
  const row = await env.DB.prepare(
    `SELECT id, code_challenge, device_secret_challenge, device_name, device_platform,
            device_app_version, status, account, proof_failures, poll_interval_sec,
            next_poll_at, created_at, expires_at
       FROM desktop_pairings WHERE device_code_hash = ?`,
  )
    .bind(deviceHash)
    .first<PairingRow>();
  if (!row) return sensitiveJson(errorBody("bad_request", "invalid device grant"), 400);
  const now = Date.now();
  const proof = await s256(verifier);
  if (row.status === "consumed") {
    return recoverConsumedPairing(
      env,
      secret,
      row,
      deviceHash,
      now,
      constantTimeEqual(proof, row.code_challenge),
    );
  }
  if (row.expires_at <= now) return sensitiveJson(errorBody("expired", "pairing expired"), 410);
  if (row.status === "denied") return sensitiveJson(errorBody("access_denied", "pairing denied"), 403);
  if (row.next_poll_at > now) {
    await env.DB.prepare("UPDATE desktop_pairings SET poll_interval_sec = 10, next_poll_at = ? WHERE id = ?")
      .bind(now + 10_000, row.id)
      .run();
    return sensitiveJson(
      { ...errorBody("slow_down", "polling too quickly"), interval: 10 },
      429,
      { "retry-after": "10" },
    );
  }
  if (!constantTimeEqual(proof, row.code_challenge)) {
    const failed = await env.DB.prepare(
      `UPDATE desktop_pairings
          SET proof_failures = proof_failures + 1,
              status = CASE WHEN proof_failures + 1 >= 5 THEN 'denied' ELSE status END,
              denied_at = CASE WHEN proof_failures + 1 >= 5 THEN ? ELSE denied_at END,
              next_poll_at = ?
        WHERE id = ? AND status IN ('pending', 'approved')`,
    )
      .bind(now, now + row.poll_interval_sec * 1000, row.id)
      .run();
    const terminal = row.proof_failures + (failed.meta.changes === 1 ? 1 : 0) >= 5;
    await audit(env.DB, terminal ? "pairing_proof_denied" : "pairing_proof_failed", { pairingId: row.id });
    return sensitiveJson(
      terminal ? errorBody("access_denied", "pairing denied") : errorBody("invalid_proof", "invalid code verifier"),
      terminal ? 403 : 401,
    );
  }
  if (row.status === "pending") {
    await env.DB.prepare("UPDATE desktop_pairings SET next_poll_at = ? WHERE id = ? AND status = 'pending'")
      .bind(now + row.poll_interval_sec * 1000, row.id)
      .run();
    return sensitiveJson({ status: "authorization_pending", interval: row.poll_interval_sec }, 202);
  }
  if (!row.account) return sensitiveJson(errorBody("conflict", "approved pairing has no account"), 409);

  const sessionId = crypto.randomUUID();
  const accessToken = randomCredential("apd");
  const refreshToken = randomCredential("apr");
  const accessHash = await desktopCredentialHash(secret, "access", accessToken);
  const refreshHash = await desktopCredentialHash(secret, "refresh", refreshToken);
  const tokenResponse: DesktopTokenResponse = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refreshToken,
    refresh_expires_in: REFRESH_TTL_MS / 1000,
    session_id: sessionId,
  };
  const serializedResponse = JSON.stringify(tokenResponse);
  const encryptedRecovery = await encryptRecoveryResponse(secret, serializedResponse, {
    pairingId: row.id,
    sessionId,
    deviceCodeHash: deviceHash,
    deviceSecretChallenge: row.device_secret_challenge,
  });
  const recoveryExpiresAt = now + RECOVERY_TTL_MS;
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO desktop_sessions (
           id, pairing_id, account, device_name, device_platform, device_app_version,
           device_secret_challenge, access_hash, access_expires_at, refresh_hash,
           refresh_expires_at, created_at, updated_at, last_used_at
         )
         SELECT ?, id, account, device_name, device_platform, device_app_version,
                device_secret_challenge, ?, ?, ?, ?, ?, ?, ?
           FROM desktop_pairings
          WHERE id = ? AND status = 'approved' AND account IS NOT NULL AND expires_at > ?`,
      ).bind(
        sessionId,
        accessHash,
        now + ACCESS_TTL_MS,
        refreshHash,
        now + REFRESH_TTL_MS,
        now,
        now,
        now,
        row.id,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO desktop_token_recoveries (
           pairing_id, session_id, device_code_hash, nonce, ciphertext, created_at, expires_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?
           FROM desktop_sessions
          WHERE id = ? AND pairing_id = ? AND revoked_at IS NULL`,
      ).bind(
        row.id,
        sessionId,
        deviceHash,
        encryptedRecovery.nonce,
        encryptedRecovery.ciphertext,
        now,
        recoveryExpiresAt,
        sessionId,
        row.id,
      ),
      env.DB.prepare(
        `UPDATE desktop_pairings SET status = 'consumed', consumed_at = ?
          WHERE id = ? AND status = 'approved'
            AND EXISTS (SELECT 1 FROM desktop_sessions WHERE id = ? AND pairing_id = ?)`,
      ).bind(now, row.id, sessionId, row.id),
    ]);
    if (
      results[0]?.meta.changes !== 1 ||
      results[1]?.meta.changes !== 1 ||
      results[2]?.meta.changes !== 1
    ) {
      return recoverConsumedPairing(env, secret, row, deviceHash, Date.now(), true);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return recoverConsumedPairing(env, secret, row, deviceHash, Date.now(), true);
    }
    throw error;
  }
  await audit(env.DB, "pairing_exchanged", { pairingId: row.id, sessionId });
  return sensitiveSerializedJson(serializedResponse);
}

export async function refreshDesktopSession(request: Request, env: DesktopPairingEnv): Promise<Response> {
  const secret = requireSecret(env);
  if (!secret) return sensitiveJson(errorBody("unavailable", "desktop pairing is not configured"), 503);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : "";
  const deviceSecret = typeof body?.device_secret === "string" ? body.device_secret : "";
  if (!/^apr_[A-Za-z0-9_-]{43}$/.test(refreshToken) || deviceSecret.length < 32 || deviceSecret.length > 256) {
    return sensitiveJson(errorBody("bad_request", "valid refresh_token and device_secret required"), 400);
  }
  const refreshHash = await desktopCredentialHash(secret, "refresh", refreshToken);
  const replay = await env.DB.prepare(
    "SELECT session_id, rotated_at FROM desktop_refresh_history WHERE refresh_hash = ?",
  )
    .bind(refreshHash)
    .first<{ session_id: string; rotated_at: number }>();
  if (replay) {
    const now = Date.now();
    const session = await env.DB.prepare(
      `SELECT id, account, device_name, device_platform, device_app_version,
              device_secret_challenge, access_hash, access_expires_at, refresh_hash,
              refresh_expires_at, created_at, updated_at, last_used_at, revoked_at
         FROM desktop_sessions WHERE id = ?`,
    )
      .bind(replay.session_id)
      .first<SessionRow>();
    if (!session || session.revoked_at !== null) {
      return sensitiveJson(errorBody("unauthorized", "invalid refresh token"), 401);
    }
    if (session.refresh_expires_at <= now) {
      await env.DB.prepare("UPDATE desktop_sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(now, now, session.id)
        .run();
      await audit(env.DB, "refresh_recovery_expired", { sessionId: session.id });
      return sensitiveJson(errorBody("expired", "refresh token expired"), 410);
    }
    if (!constantTimeEqual(await s256(deviceSecret), session.device_secret_challenge)) {
      await audit(env.DB, "refresh_recovery_device_proof_failed", { sessionId: session.id });
      return sensitiveJson(errorBody("unauthorized", "invalid device proof"), 401);
    }

    // A negative timestamp is an atomic one-shot recovery claim. Its magnitude
    // retains the original rotation time so stale replays still age out.
    const rotatedAt = replay.rotated_at < 0
      ? Math.floor(-replay.rotated_at / REFRESH_RECOVERY_CLAIM_SCALE)
      : replay.rotated_at;
    if (replay.rotated_at < 0) {
      await audit(env.DB, "refresh_recovery_conflict", { sessionId: session.id });
      return sensitiveJson(errorBody("refresh_conflict", "refresh recovery already used"), 409);
    }
    if (rotatedAt > now || now - rotatedAt > REFRESH_RECOVERY_WINDOW_MS) {
      await env.DB.prepare("UPDATE desktop_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?")
        .bind(now, now, replay.session_id)
        .run();
      await audit(env.DB, "refresh_replay_revoked", { sessionId: replay.session_id });
      return sensitiveJson(errorBody("replay_detected", "refresh token replay revoked the session"), 403);
    }
    if (now - rotatedAt < REFRESH_RECOVERY_MIN_AGE_MS) {
      await audit(env.DB, "refresh_recovery_too_early", { sessionId: session.id });
      return sensitiveJson(
        errorBody("refresh_conflict", "refresh recovery cannot start while the original rotation is in flight"),
        409,
        { "retry-after": "1" },
      );
    }

    const nextAccess = randomCredential("apd");
    const nextRefresh = randomCredential("apr");
    const nextAccessHash = await desktopCredentialHash(secret, "access", nextAccess);
    const nextRefreshHash = await desktopCredentialHash(secret, "refresh", nextRefresh);
    const claimRandom = crypto.getRandomValues(new Uint16Array(1))[0] & (REFRESH_RECOVERY_CLAIM_SCALE - 1);
    const claimMarker = -(rotatedAt * REFRESH_RECOVERY_CLAIM_SCALE + claimRandom);
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE desktop_refresh_history SET rotated_at = ?
          WHERE refresh_hash = ? AND rotated_at = ? AND rotated_at >= 0`,
      ).bind(claimMarker, refreshHash, replay.rotated_at),
      env.DB.prepare(
        `UPDATE desktop_sessions
            SET access_hash = ?, access_expires_at = ?, refresh_hash = ?,
                updated_at = ?, last_used_at = ?
          WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL
            AND refresh_expires_at > ?
            AND EXISTS (
              SELECT 1 FROM desktop_refresh_history
               WHERE refresh_hash = ? AND session_id = ? AND rotated_at = ?
            )`,
      ).bind(
        nextAccessHash,
        now + ACCESS_TTL_MS,
        nextRefreshHash,
        now,
        now,
        session.id,
        session.refresh_hash,
        now,
        refreshHash,
        session.id,
        claimMarker,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO desktop_refresh_history (refresh_hash, session_id, rotated_at)
         SELECT ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM desktop_sessions
             WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL
          )`,
      ).bind(session.refresh_hash, session.id, now, session.id, nextRefreshHash),
    ]);
    if (
      results[0]?.meta.changes !== 1 ||
      results[1]?.meta.changes !== 1 ||
      results[2]?.meta.changes !== 1
    ) {
      await audit(env.DB, "refresh_recovery_conflict", { sessionId: session.id });
      return sensitiveJson(errorBody("refresh_conflict", "concurrent refresh recovery"), 409);
    }
    await audit(env.DB, "session_refresh_recovered", { sessionId: session.id });
    return sensitiveJson({
      access_token: nextAccess,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: nextRefresh,
      refresh_expires_in: Math.max(0, Math.floor((session.refresh_expires_at - now) / 1000)),
      session_id: session.id,
    });
  }
  const session = await env.DB.prepare(
    `SELECT id, account, device_name, device_platform, device_app_version,
            device_secret_challenge, access_hash, access_expires_at, refresh_hash,
            refresh_expires_at, created_at, updated_at, last_used_at, revoked_at
       FROM desktop_sessions WHERE refresh_hash = ?`,
  )
    .bind(refreshHash)
    .first<SessionRow>();
  if (!session || session.revoked_at !== null) return sensitiveJson(errorBody("unauthorized", "invalid refresh token"), 401);
  const now = Date.now();
  if (session.refresh_expires_at <= now) {
    await env.DB.prepare("UPDATE desktop_sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, now, session.id)
      .run();
    return sensitiveJson(errorBody("expired", "refresh token expired"), 410);
  }
  if (!constantTimeEqual(await s256(deviceSecret), session.device_secret_challenge)) {
    await audit(env.DB, "refresh_device_proof_failed", { sessionId: session.id });
    return sensitiveJson(errorBody("unauthorized", "invalid device proof"), 401);
  }

  const nextAccess = randomCredential("apd");
  const nextRefresh = randomCredential("apr");
  const nextAccessHash = await desktopCredentialHash(secret, "access", nextAccess);
  const nextRefreshHash = await desktopCredentialHash(secret, "refresh", nextRefresh);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE desktop_sessions
          SET access_hash = ?, access_expires_at = ?, refresh_hash = ?,
              updated_at = ?, last_used_at = ?
        WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL`,
    ).bind(nextAccessHash, now + ACCESS_TTL_MS, nextRefreshHash, now, now, session.id, refreshHash),
    env.DB.prepare(
      `INSERT OR IGNORE INTO desktop_refresh_history (refresh_hash, session_id, rotated_at)
       SELECT ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM desktop_sessions
           WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL
        )`,
    ).bind(refreshHash, session.id, now, session.id, nextRefreshHash),
  ]);
  if (results[0]?.meta.changes !== 1) {
    await audit(env.DB, "refresh_race_rejected", { sessionId: session.id });
    return sensitiveJson(errorBody("refresh_conflict", "concurrent refresh rotation"), 409);
  }
  if (results[1]?.meta.changes !== 1) {
    await env.DB.prepare("UPDATE desktop_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?")
      .bind(now, now, session.id)
      .run();
    await audit(env.DB, "refresh_race_revoked", { sessionId: session.id });
    return sensitiveJson(errorBody("replay_detected", "refresh token replay revoked the session"), 403);
  }
  await audit(env.DB, "session_refreshed", { sessionId: session.id });
  return sensitiveJson({
    access_token: nextAccess,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: nextRefresh,
    refresh_expires_in: Math.max(0, Math.floor((session.refresh_expires_at - now) / 1000)),
    session_id: session.id,
  });
}

export async function listDesktopSessions(env: DesktopPairingEnv, identity: TokenIdentity): Promise<Response> {
  if (identity.role !== "human" || !identity.account) {
    return sensitiveJson(errorBody("forbidden", "a human account session is required"), 403);
  }
  const rows = await env.DB.prepare(
    `SELECT id, device_name, device_platform, device_app_version, created_at, updated_at,
            last_used_at, access_expires_at, refresh_expires_at, revoked_at
       FROM desktop_sessions WHERE account = ? ORDER BY created_at DESC`,
  )
    .bind(identity.account)
    .all<{
      id: string;
      device_name: string;
      device_platform: string | null;
      device_app_version: string | null;
      created_at: number;
      updated_at: number;
      last_used_at: number;
      access_expires_at: number;
      refresh_expires_at: number;
      revoked_at: number | null;
    }>();
  return sensitiveJson({
    sessions: rows.results.map((row) => ({
      id: row.id,
      device: { name: row.device_name, platform: row.device_platform, app_version: row.device_app_version },
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_used_at: row.last_used_at,
      access_expires_at: row.access_expires_at,
      refresh_expires_at: row.refresh_expires_at,
      revoked_at: row.revoked_at,
      current: identity.desktopSessionId === row.id,
    })),
  });
}

export async function revokeDesktopSessionByOwner(
  env: DesktopPairingEnv,
  identity: TokenIdentity,
  sessionId: string,
): Promise<Response> {
  if (identity.role !== "human" || !identity.account) {
    return sensitiveJson(errorBody("forbidden", "a human account session is required"), 403);
  }
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE desktop_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ? AND account = ?",
  )
    .bind(now, now, sessionId, identity.account)
    .run();
  if (result.meta.changes !== 1) return sensitiveJson(errorBody("not_found", "desktop session not found"), 404);
  await audit(env.DB, "session_revoked_by_owner", { sessionId });
  return sensitiveEmpty();
}

export async function revokeCurrentDesktopSession(request: Request, env: DesktopPairingEnv): Promise<Response> {
  const secret = requireSecret(env);
  if (!secret) return sensitiveJson(errorBody("unavailable", "desktop pairing is not configured"), 503);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : "";
  const deviceSecret = typeof body?.device_secret === "string" ? body.device_secret : "";
  if (!/^apr_[A-Za-z0-9_-]{43}$/.test(refreshToken) || deviceSecret.length < 32 || deviceSecret.length > 256) {
    return sensitiveEmpty();
  }
  const refreshHash = await desktopCredentialHash(secret, "refresh", refreshToken);
  const session = await env.DB.prepare(
    `SELECT id, device_secret_challenge FROM desktop_sessions
      WHERE refresh_hash = ? AND revoked_at IS NULL`,
  )
    .bind(refreshHash)
    .first<{ id: string; device_secret_challenge: string }>();
  if (!session || !constantTimeEqual(await s256(deviceSecret), session.device_secret_challenge)) {
    return sensitiveEmpty();
  }
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE desktop_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(now, now, session.id)
    .run();
  if (result.meta.changes === 1) await audit(env.DB, "session_revoked_by_device", { sessionId: session.id });
  return sensitiveEmpty();
}
