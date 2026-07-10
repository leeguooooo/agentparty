import { isTauriEnvironment } from "./desktopUpdater";
import { parsePairDeepLink, resolveAllowedVerificationUrl, type PairDeepLink } from "./desktopPairing";

export type DesktopNotificationPermission =
  | "granted"
  | "denied"
  | "default"
  | "prompt"
  | "prompt-with-rationale"
  | "unsupported";

export interface MentionNotification {
  title: string;
  body: string;
  slug: string;
  seq: number;
}

export interface DesktopNotificationAction {
  slug: string;
  seq: number;
}

interface NotificationListener {
  unregister(): Promise<void>;
}

interface NotificationModule {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<Exclude<DesktopNotificationPermission, "unsupported">>;
  sendNotification(options: {
    title: string;
    body: string;
    extra: { slug: string; seq: number };
  }): void;
  onAction(handler: (notification: { extra?: Record<string, unknown> }) => void): Promise<NotificationListener>;
}

interface AutostartModule {
  enable(): Promise<void>;
  disable(): Promise<void>;
  isEnabled(): Promise<boolean>;
}

interface DesktopWindow {
  setBadgeCount(count?: number): Promise<void>;
  show(): Promise<void>;
  unminimize(): Promise<void>;
  setFocus(): Promise<void>;
}

interface WindowModule {
  getCurrentWindow(): DesktopWindow;
}

interface EventModule {
  listen(event: string, handler: () => void): Promise<() => void>;
}

interface OpenerModule {
  openUrl(url: string | URL): Promise<void>;
}

interface DeepLinkModule {
  getCurrent(): Promise<string[] | null>;
  onOpenUrl(handler: (urls: string[]) => void): Promise<() => void>;
}

export interface DesktopRuntimeDependencies {
  isTauri(): boolean;
  loadNotification(): Promise<NotificationModule>;
  loadAutostart(): Promise<AutostartModule>;
  loadWindow(): Promise<WindowModule>;
  loadEvent(): Promise<EventModule>;
  loadOpener(): Promise<OpenerModule>;
  loadDeepLink(): Promise<DeepLinkModule>;
}

const defaultDependencies: DesktopRuntimeDependencies = {
  isTauri: () => isTauriEnvironment(),
  loadNotification: () => import("@tauri-apps/plugin-notification"),
  loadAutostart: () => import("@tauri-apps/plugin-autostart"),
  loadWindow: () => import("@tauri-apps/api/window"),
  loadEvent: () => import("@tauri-apps/api/event"),
  loadOpener: () => import("@tauri-apps/plugin-opener"),
  loadDeepLink: () => import("@tauri-apps/plugin-deep-link"),
};

let dependencies = defaultDependencies;

export function isDesktopRuntime(): boolean {
  try {
    return dependencies.isTauri();
  } catch {
    return false;
  }
}

export async function isDesktopNotificationSupported(): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    await dependencies.loadNotification();
    return true;
  } catch {
    return false;
  }
}

export async function isDesktopNotificationPermissionGranted(): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const notification = await dependencies.loadNotification();
    return await notification.isPermissionGranted();
  } catch {
    return false;
  }
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (!isDesktopRuntime()) return "unsupported";
  try {
    const notification = await dependencies.loadNotification();
    const permission = await notification.requestPermission();
    return permission === "granted" ||
      permission === "denied" ||
      permission === "default" ||
      permission === "prompt" ||
      permission === "prompt-with-rationale"
      ? permission
      : "unsupported";
  } catch {
    return "unsupported";
  }
}

export async function sendMentionNotification(input: MentionNotification): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const notification = await dependencies.loadNotification();
    if (!(await notification.isPermissionGranted())) return false;
    await notification.sendNotification({
      title: input.title,
      body: input.body,
      extra: { slug: input.slug, seq: input.seq },
    });
    return true;
  } catch {
    return false;
  }
}

export async function listenForDesktopNotificationActions(
  onAction: (action: DesktopNotificationAction) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {};
  try {
    const notification = await dependencies.loadNotification();
    const listener = await notification.onAction(({ extra }) => {
      const slug = extra?.slug;
      const seq = extra?.seq;
      if (
        typeof slug !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ||
        typeof seq !== "number" ||
        !Number.isSafeInteger(seq) ||
        seq <= 0
      ) return;
      onAction({ slug, seq });
    });
    return () => { void listener.unregister(); };
  } catch {
    return () => {};
  }
}

export async function setDesktopBadge(count: number): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const badge = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const { getCurrentWindow } = await dependencies.loadWindow();
    await getCurrentWindow().setBadgeCount(badge > 0 ? badge : undefined);
    return true;
  } catch {
    return false;
  }
}

export async function showAndFocusDesktopWindow(): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const { getCurrentWindow } = await dependencies.loadWindow();
    const window = getCurrentWindow();
    await window.show();
    await window.unminimize();
    await window.setFocus();
    return true;
  } catch {
    return false;
  }
}

export async function openDesktopVerificationUrl(
  input: string,
  allowedOrigins: readonly string[],
): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  const url = resolveAllowedVerificationUrl(input, allowedOrigins);
  if (url === null) return false;
  try {
    const opener = await dependencies.loadOpener();
    await opener.openUrl(url);
    return true;
  } catch {
    return false;
  }
}

export async function listenForDesktopPairLinks(
  allowedOrigins: readonly string[],
  onPairLink: (link: PairDeepLink) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {};
  try {
    const deepLink = await dependencies.loadDeepLink();
    const deliver = (urls: string[]) => {
      for (const input of urls) {
        const parsed = parsePairDeepLink(input, allowedOrigins);
        if (parsed !== null) onPairLink(parsed);
      }
    };
    const unlisten = await deepLink.onOpenUrl(deliver);
    const current = await deepLink.getCurrent();
    if (current !== null) deliver(current);
    return unlisten;
  } catch {
    return () => {};
  }
}

export async function listenForDesktopUpdateChecks(onCheck: () => void): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {};
  try {
    const event = await dependencies.loadEvent();
    return await event.listen("agentparty://check-for-updates", onCheck);
  } catch {
    return () => {};
  }
}

export async function isAutostartEnabled(): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const autostart = await dependencies.loadAutostart();
    return await autostart.isEnabled();
  } catch {
    return false;
  }
}

export async function setAutostartEnabled(enabled: boolean): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const autostart = await dependencies.loadAutostart();
    await (enabled ? autostart.enable() : autostart.disable());
    return true;
  } catch {
    return false;
  }
}

export function __setDesktopRuntimeDependenciesForTests(
  overrides: Partial<DesktopRuntimeDependencies>,
): void {
  dependencies = { ...defaultDependencies, ...overrides };
}

export function __resetDesktopRuntimeForTests(): void {
  dependencies = defaultDependencies;
}
