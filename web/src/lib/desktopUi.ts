import { isDesktopRuntime } from "./desktopRuntime";

export interface DesktopUiIdentity {
  buildId: string;
  uiAbi: number;
}

export interface DesktopUiRuntime {
  isDesktop(): boolean;
  readIdentity(): unknown;
  invokeReady(identity: DesktopUiIdentity): Promise<void>;
}

type DesktopUiGlobal = typeof globalThis & {
  __AGENTPARTY_DESKTOP_UI__?: unknown;
};

const BUILD_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const reported = new Set<string>();
const inFlight = new Map<string, Promise<boolean>>();

export function parseDesktopUiIdentity(value: unknown): DesktopUiIdentity | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "buildId" && key !== "uiAbi")) return null;
  if (typeof record.buildId !== "string" || !BUILD_ID_PATTERN.test(record.buildId)) return null;
  if (!Number.isSafeInteger(record.uiAbi) || Number(record.uiAbi) < 1 || Number(record.uiAbi) > 65_535) return null;
  return { buildId: record.buildId, uiAbi: Number(record.uiAbi) };
}

const defaultRuntime: DesktopUiRuntime = {
  isDesktop: isDesktopRuntime,
  readIdentity: () => (globalThis as DesktopUiGlobal).__AGENTPARTY_DESKTOP_UI__,
  invokeReady: async ({ buildId, uiAbi }) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("desktop_ui_ready", { buildId, uiAbi });
  },
};

export async function reportDesktopUiReady(runtime: DesktopUiRuntime = defaultRuntime): Promise<boolean> {
  if (!runtime.isDesktop()) return false;
  const identity = parseDesktopUiIdentity(runtime.readIdentity());
  if (identity === null) return false;
  const key = `${identity.buildId}:${identity.uiAbi}`;
  if (reported.has(key)) return true;
  const current = inFlight.get(key);
  if (current !== undefined) return current;
  const pending = runtime.invokeReady(identity)
    .then(() => {
      reported.add(key);
      return true;
    })
    .catch(() => false)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

export function __resetDesktopUiForTests(): void {
  reported.clear();
  inFlight.clear();
}
