import { parseAuthConfigPayload, type AuthProviderConfig } from "./oidc";
import { snapshotDesktopStorage } from "./desktopStorage";

const CUSTOM_PROFILES_KEY = "ap_server_profiles_v1";
const ACTIVE_ORIGIN_KEY = "ap_active_server_origin_v1";

export interface ServerProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type ServerProfileMutationHandler = (storage: ServerProfileStorage) => void;

const snapshotServerProfileMutation: ServerProfileMutationHandler = (storage) => {
  void snapshotDesktopStorage(storage as Storage);
};

export interface ServerProfile {
  id: string;
  label: string;
  origin: string;
  kind: "official" | "custom";
}

export interface ServerProbeResult {
  origin: string;
  providers: AuthProviderConfig[];
}

export const OFFICIAL_SERVER_PROFILES: readonly ServerProfile[] = [
  {
    id: "official:prod",
    label: "AgentParty Production",
    origin: "https://agentparty.leeguoo.com",
    kind: "official",
  },
  {
    id: "official:test",
    label: "AgentParty Test",
    origin: "https://agentparty.pwtk-dev.work",
    kind: "official",
  },
];

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part)) && Number(parts[0]) === 127;
}

export function normalizeServerOrigin(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function defaultStorage(): ServerProfileStorage {
  return localStorage;
}

function normalizeLabel(label: string): string | null {
  const value = label.trim().replace(/\s+/g, " ");
  return value.length > 0 && value.length <= 80 ? value : null;
}

function readCustomProfiles(storage: ServerProfileStorage): ServerProfile[] {
  try {
    const raw = JSON.parse(storage.getItem(CUSTOM_PROFILES_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    const seen = new Set(OFFICIAL_SERVER_PROFILES.map((profile) => profile.origin));
    const profiles: ServerProfile[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const candidate = item as { label?: unknown; origin?: unknown };
      if (typeof candidate.label !== "string" || typeof candidate.origin !== "string") continue;
      const label = normalizeLabel(candidate.label);
      const origin = normalizeServerOrigin(candidate.origin);
      if (label === null || origin === null || seen.has(origin)) continue;
      seen.add(origin);
      profiles.push({ id: `custom:${origin}`, label, origin, kind: "custom" });
    }
    return profiles;
  } catch {
    return [];
  }
}

export function loadServerProfiles(storage: ServerProfileStorage = defaultStorage()): ServerProfile[] {
  return [...OFFICIAL_SERVER_PROFILES, ...readCustomProfiles(storage)];
}

export function addCustomServerProfile(
  storage: ServerProfileStorage = defaultStorage(),
  input: { label: string; origin: string },
  onMutation: ServerProfileMutationHandler = snapshotServerProfileMutation,
): ServerProfile[] {
  const label = normalizeLabel(input.label);
  const origin = normalizeServerOrigin(input.origin);
  if (label === null || origin === null) throw new Error("invalid server profile");
  const profiles = loadServerProfiles(storage);
  const official = OFFICIAL_SERVER_PROFILES.find((profile) => profile.origin === origin);
  if (official !== undefined) return profiles;
  const custom = profiles.filter((profile) => profile.kind === "custom" && profile.origin !== origin);
  custom.push({ id: `custom:${origin}`, label, origin, kind: "custom" });
  storage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(custom.map(({ label: nextLabel, origin: nextOrigin }) => ({
    label: nextLabel,
    origin: nextOrigin,
  }))));
  onMutation(storage);
  return [...OFFICIAL_SERVER_PROFILES, ...custom];
}

export function loadActiveServerOrigin(storage: ServerProfileStorage = defaultStorage()): string {
  const profiles = loadServerProfiles(storage);
  const stored = normalizeServerOrigin(storage.getItem(ACTIVE_ORIGIN_KEY) ?? "");
  return profiles.some((profile) => profile.origin === stored)
    ? stored ?? OFFICIAL_SERVER_PROFILES[0]!.origin
    : OFFICIAL_SERVER_PROFILES[0]!.origin;
}

export function saveActiveServerOrigin(
  storage: ServerProfileStorage = defaultStorage(),
  input: string,
  onMutation: ServerProfileMutationHandler = snapshotServerProfileMutation,
): string {
  const origin = normalizeServerOrigin(input);
  if (origin === null || !loadServerProfiles(storage).some((profile) => profile.origin === origin)) {
    throw new Error("server profile is not registered");
  }
  storage.setItem(ACTIVE_ORIGIN_KEY, origin);
  onMutation(storage);
  return origin;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function fetchWithoutCrossOriginRedirect(
  origin: string,
  path: string,
  fetcher: Fetcher,
): Promise<Response> {
  let target = `${origin}${path}`;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetcher(target, { redirect: "manual", headers: { accept: "application/json" } });
    if (response.type === "opaqueredirect") throw new Error("server redirect could not be verified");
    if (response.status < 300 || response.status >= 400) return response;
    const locationHeader = response.headers.get("location");
    if (locationHeader === null) throw new Error("server redirect is invalid");
    const next = new URL(locationHeader, target);
    if (next.origin !== origin) throw new Error("server redirect changed origin");
    target = next.toString();
  }
  throw new Error("server redirected too many times");
}

export async function probeServerProfile(input: string, fetcher: Fetcher = fetch): Promise<ServerProbeResult> {
  const origin = normalizeServerOrigin(input);
  if (origin === null) throw new Error("server origin is invalid");
  const health = await fetchWithoutCrossOriginRedirect(origin, "/api/health", fetcher);
  if (!health.ok) throw new Error(`server health check failed (${health.status})`);
  const config = await fetchWithoutCrossOriginRedirect(origin, "/api/config", fetcher);
  if (!config.ok) throw new Error(`server config check failed (${config.status})`);
  const auth = parseAuthConfigPayload(await config.json());
  return { origin, providers: auth.providers };
}
