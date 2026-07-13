const PENDING_KEY = "ap_pending_join_request";
const TARGET_KEY = "ap_join_request_target";
const PENDING_TTL_MS = 15 * 60 * 1000;
const SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
// Mirror the worker's JOIN_REQUEST_NOTE_MAX so a note that survives login never
// exceeds what the API will accept.
export const JOIN_REQUEST_NOTE_MAX = 2000;

export interface PendingJoinRequest {
  slug: string;
  expiresAt: number;
  // The applicant's optional reason ("申请理由"). Persisted so it survives the
  // OIDC login round-trip; only the watch token is deliberately kept out of storage.
  note?: string;
}

function validSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

function normalizeNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, JOIN_REQUEST_NOTE_MAX);
  return text === "" ? undefined : text;
}

export function savePendingJoinRequest(value: { slug: string; note?: string }, now = Date.now()): void {
  if (!validSlug(value.slug)) throw new Error("invalid pending join request");
  const note = normalizeNote(value.note);
  const marker: PendingJoinRequest = { slug: value.slug, expiresAt: now + PENDING_TTL_MS };
  if (note !== undefined) marker.note = note;
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(marker));
}

export function readPendingJoinRequest(now = Date.now()): PendingJoinRequest | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as Partial<PendingJoinRequest> | null;
    if (parsed === null || !validSlug(parsed.slug) || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) {
      throw new Error("invalid pending join request");
    }
    const note = normalizeNote(parsed.note);
    return note === undefined
      ? { slug: parsed.slug, expiresAt: parsed.expiresAt }
      : { slug: parsed.slug, expiresAt: parsed.expiresAt, note };
  } catch {
    clearPendingJoinRequest();
    return null;
  }
}

export function clearPendingJoinRequest(): void {
  sessionStorage.removeItem(PENDING_KEY);
}

export function rememberJoinRequestTarget(slug: string): void {
  if (!validSlug(slug)) throw new Error("invalid join request target");
  sessionStorage.setItem(TARGET_KEY, slug);
}

export function readJoinRequestTarget(): string | null {
  const slug = sessionStorage.getItem(TARGET_KEY);
  if (slug === null) return null;
  if (validSlug(slug)) return slug;
  sessionStorage.removeItem(TARGET_KEY);
  return null;
}

export function clearJoinRequestTarget(): void {
  sessionStorage.removeItem(TARGET_KEY);
}
