import { isDesktopRuntime } from "./desktopRuntime";

const MAX_ENTRIES = 512;
const MAX_KEY_BYTES = 160;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

const SAFE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validNonNegativeInteger(value: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part)) && Number(parts[0]) === 127;
}

function validOrigin(value: string, allowEmpty = false): boolean {
  if (allowEmpty && value === "") return true;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== "/" && url.pathname !== "") return false;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return false;
    return url.origin === value;
  } catch {
    return false;
  }
}

function validServerProfiles(value: string): boolean {
  try {
    const profiles: unknown = JSON.parse(value);
    return Array.isArray(profiles) && profiles.every((profile) => {
      if (!isRecord(profile)) return false;
      const keys = Object.keys(profile);
      if (keys.length !== 2 || !keys.includes("label") || !keys.includes("origin")) return false;
      if (typeof profile.label !== "string" || typeof profile.origin !== "string") return false;
      const normalizedLabel = profile.label.trim().replace(/\s+/g, " ");
      return profile.label.length > 0 &&
        normalizedLabel === profile.label &&
        profile.label.length <= 80 &&
        !/[\u0000-\u001f\u007f]/.test(profile.label) &&
        validOrigin(profile.origin);
    });
  } catch {
    return false;
  }
}

function validUpdaterDiagnostic(value: string): boolean {
  try {
    const diagnostic: unknown = JSON.parse(value);
    if (!isRecord(diagnostic)) return false;
    const allowed = new Set(["status", "source", "stage", "category", "timestamp", "appVersion", "targetVersion"]);
    const keys = Object.keys(diagnostic);
    if (keys.some((key) => !allowed.has(key))) return false;
    if (!["status", "source", "stage", "category", "timestamp", "appVersion"].every((key) => key in diagnostic)) {
      return false;
    }
    if (!(["attempt", "success", "failure", "pending"] as unknown[]).includes(diagnostic.status)) return false;
    if (!(diagnostic.source === null || diagnostic.source === "auto" || diagnostic.source === "manual")) return false;
    if (!(["check", "install", "relaunch"] as unknown[]).includes(diagnostic.stage)) return false;
    if (!(diagnostic.category === null || (["offline", "timeout", "verification", "install", "relaunch", "generic"] as unknown[]).includes(diagnostic.category))) {
      return false;
    }
    if (typeof diagnostic.timestamp !== "number" || !Number.isSafeInteger(diagnostic.timestamp) || diagnostic.timestamp < 0) {
      return false;
    }
    if (!(diagnostic.appVersion === null || (typeof diagnostic.appVersion === "string" && SAFE_VERSION_PATTERN.test(diagnostic.appVersion)))) {
      return false;
    }
    return diagnostic.targetVersion === undefined ||
      (typeof diagnostic.targetVersion === "string" && SAFE_VERSION_PATTERN.test(diagnostic.targetVersion));
  } catch {
    return false;
  }
}

function validValue(key: string, value: string): boolean {
  if (key.startsWith("ap_seen:v1:")) {
    const parts = key.slice("ap_seen:v1:".length).split(":");
    return parts.length === 2 && SAFE_SLUG_PATTERN.test(parts[0]!) &&
      SAFE_IDENTITY_PATTERN.test(parts[1]!) && validNonNegativeInteger(value);
  }
  if (key.startsWith("ap_charter_seen:")) {
    const slug = key.slice("ap_charter_seen:".length);
    return SAFE_SLUG_PATTERN.test(slug) && validNonNegativeInteger(value);
  }
  switch (key) {
    case "ap_active_server_origin_v1": return validOrigin(value);
    case "ap_api_base": return validOrigin(value, true);
    case "ap_channel_tools_expanded":
    case "ap_notify_optin":
    case "ap_presence_expanded": return value === "0" || value === "1";
    case "ap_onboarded": return value === "1";
    case "ap_desktop_updater_diagnostic": return validUpdaterDiagnostic(value);
    case "ap_desktop_updater_last_success": return validNonNegativeInteger(value);
    case "ap_locale": return value === "en" || value === "zh";
    case "ap_server_profiles_v1": return validServerProfiles(value);
    case "ap_theme": return value === "doodle" || value === "midnight";
    default: return false;
  }
}

function validEntry(key: string, value: string): boolean {
  return validValue(key, value) &&
    byteLength(key) <= MAX_KEY_BYTES &&
    byteLength(value) <= MAX_VALUE_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(key);
}

export type DesktopStorageSnapshot = Record<string, string>;

export interface DesktopStorageRuntime {
  isDesktop(): boolean;
  restore(): Promise<unknown>;
  snapshot(entries: DesktopStorageSnapshot): Promise<void>;
}

export function collectDesktopStorage(storage: Storage): DesktopStorageSnapshot {
  const entries: DesktopStorageSnapshot = {};
  let totalBytes = 0;
  for (let index = 0; index < storage.length && Object.keys(entries).length < MAX_ENTRIES; index += 1) {
    const key = storage.key(index);
    if (key === null) continue;
    const value = storage.getItem(key);
    if (value === null || !validEntry(key, value)) continue;
    const nextBytes = byteLength(key) + byteLength(value);
    if (totalBytes + nextBytes > MAX_TOTAL_BYTES) continue;
    entries[key] = value;
    totalBytes += nextBytes;
  }
  return entries;
}

export function restoreDesktopStorage(storage: Storage, snapshot: unknown): number {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return 0;
  let restored = 0;
  let totalBytes = 0;
  for (const [key, value] of Object.entries(snapshot as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
    if (typeof value !== "string" || !validEntry(key, value)) continue;
    const nextBytes = byteLength(key) + byteLength(value);
    if (totalBytes + nextBytes > MAX_TOTAL_BYTES) continue;
    totalBytes += nextBytes;
    if (storage.getItem(key) !== null) continue;
    storage.setItem(key, value);
    restored += 1;
  }
  return restored;
}

const defaultRuntime: DesktopStorageRuntime = {
  isDesktop: isDesktopRuntime,
  restore: async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("desktop_ui_storage_restore");
  },
  snapshot: async (entries) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("desktop_ui_storage_snapshot", { entries });
  },
};

let desktopSnapshotQueue: Promise<void> = Promise.resolve();

export async function snapshotDesktopStorage(
  storage: Storage = localStorage,
  runtime: DesktopStorageRuntime = defaultRuntime,
): Promise<boolean> {
  if (!runtime.isDesktop()) return false;
  try {
    const entries = collectDesktopStorage(storage);
    const pending = desktopSnapshotQueue.then(() => runtime.snapshot(entries));
    desktopSnapshotQueue = pending.catch(() => {});
    await pending;
    return true;
  } catch {
    return false;
  }
}

export async function synchronizeDesktopStorage(
  storage: Storage = localStorage,
  runtime: DesktopStorageRuntime = defaultRuntime,
): Promise<boolean> {
  if (!runtime.isDesktop()) return false;
  try {
    restoreDesktopStorage(storage, await runtime.restore());
    return await snapshotDesktopStorage(storage, runtime);
  } catch {
    return false;
  }
}
