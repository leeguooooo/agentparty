const API_BASE_KEY = "ap_api_base";
let runtimeApiBase: string | null = null;

function defaultApiBase(): string {
  return normalizeApiBase(import.meta.env.VITE_API_BASE);
}

function normalizeApiBase(base: string | undefined | null): string {
  return (base ?? "").trim().replace(/\/+$/, "");
}

export function apiBase(): string {
  if (runtimeApiBase !== null) return runtimeApiBase;
  try {
    return normalizeApiBase(localStorage.getItem(API_BASE_KEY) ?? defaultApiBase());
  } catch {
    return defaultApiBase();
  }
}

export function setApiBase(base: string): void {
  runtimeApiBase = normalizeApiBase(base);
  try {
    localStorage.setItem(API_BASE_KEY, runtimeApiBase);
  } catch {
    // Non-browser test/runtime environments have no localStorage.
  }
}

export function clearApiBase(): void {
  runtimeApiBase = null;
  try {
    localStorage.removeItem(API_BASE_KEY);
  } catch {
    // Non-browser test/runtime environments have no localStorage.
  }
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

export function apiOrigin(fallbackOrigin = location.origin): string {
  return apiBase() || fallbackOrigin;
}

export function wsUrl(path: string): string {
  const base = apiBase();
  if (base !== "") return `${base.replace(/^http/i, "ws")}${path}`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}
