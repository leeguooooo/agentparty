const SIGNATURE_VERSION = "v1";
export const ATTACHMENT_SIGNED_URL_TTL_SECONDS = 15 * 60;
const ATTACHMENT_SIGNED_URL_MAX_FUTURE_SECONDS = ATTACHMENT_SIGNED_URL_TTL_SECONDS + 60;

export type AttachmentSigningEnv = {
  ATTACHMENT_SIGNING_SECRET?: string;
  DESKTOP_PAIRING_SECRET?: string;
  ADMIN_SECRET?: string;
};

function signingSecret(env: AttachmentSigningEnv): string | null {
  return env.ATTACHMENT_SIGNING_SECRET?.trim() || env.DESKTOP_PAIRING_SECRET?.trim() || env.ADMIN_SECRET?.trim() || null;
}

function attachmentPath(pathname: string): boolean {
  return /^\/api\/channels\/[a-z0-9][a-z0-9-]{0,63}\/attachments\/.+$/u.test(pathname);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

async function signature(secret: string, pathname: string, expiresAt: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${SIGNATURE_VERSION}\n${expiresAt}\n${pathname}`)),
  );
}

export async function createSignedAttachmentUrl(
  requestUrl: string,
  env: AttachmentSigningEnv,
  nowMs = Date.now(),
): Promise<{ url: string; expiresAt: number } | null> {
  const secret = signingSecret(env);
  const url = new URL(requestUrl);
  if (secret === null || !attachmentPath(url.pathname)) return null;
  const expiresAt = Math.floor(nowMs / 1000) + ATTACHMENT_SIGNED_URL_TTL_SECONDS;
  const signed = await signature(secret, url.pathname, expiresAt);
  url.search = "";
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", base64url(signed));
  return { url: url.toString(), expiresAt };
}

export async function verifySignedAttachmentRequest(
  requestUrl: string,
  env: AttachmentSigningEnv,
  nowMs = Date.now(),
): Promise<boolean> {
  const secret = signingSecret(env);
  const url = new URL(requestUrl);
  if (secret === null || !attachmentPath(url.pathname)) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes("exp") || !keys.includes("sig")) return false;
  const expiresAt = Number(url.searchParams.get("exp"));
  const supplied = decodeBase64url(url.searchParams.get("sig") ?? "");
  const now = Math.floor(nowMs / 1000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < now ||
    expiresAt > now + ATTACHMENT_SIGNED_URL_MAX_FUTURE_SECONDS ||
    supplied === null
  ) {
    return false;
  }
  return sameBytes(supplied, await signature(secret, url.pathname, expiresAt));
}
