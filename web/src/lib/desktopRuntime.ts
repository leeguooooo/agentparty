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

export interface DesktopUpdateNotification {
  title: string;
  body: string;
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
    id?: number;
    title: string;
    body: string;
    extra?: Record<string, unknown>;
  }): void;
  onAction(handler: (notification: { extra?: Record<string, unknown> }) => void): Promise<NotificationListener>;
  // 枚举已投递的通知 / 按 id 精确删除（issue #399）。旧壳可能没有这两条命令，标可选、调用侧兜底。
  active?(): Promise<Array<{ id: number; extra?: Record<string, unknown> }>>;
  removeActive?(notifications: Array<{ id: number }>): Promise<void>;
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

// 稳定通知 id：同一 (频道, seq) 的 @提醒在多窗口 / 重连 / 重开时都映射到同一 id，
// macOS 用相同 identifier 覆盖旧通知而非再堆一条——消除通知中心里的重复（issue #399：
// 两个 session 各弹一次、或重触发导致同一条 @ 出现多遍）。djb2 → 正 i32、非 0。
export function mentionNotificationId(slug: string, seq: number): number {
  const s = `${slug}:${seq}`;
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h & 0x7fffffff) || 1;
}

export async function sendMentionNotification(input: MentionNotification): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const notification = await dependencies.loadNotification();
    if (!(await notification.isPermissionGranted())) return false;
    await notification.sendNotification({
      id: mentionNotificationId(input.slug, input.seq),
      title: input.title,
      body: input.body,
      extra: { slug: input.slug, seq: input.seq },
    });
    return true;
  } catch {
    return false;
  }
}

// 清掉通知中心里「当前频道」已投递的 @提醒。用户聚焦窗口即视为读到，堆积的旧通知应随之消失
// （issue #399：「每次登录进来都显示 @我，但我都看过了」）。
//
// 只删当前频道，绝不用 removeAllActive——那会把其他频道仍未读的 @提醒一并误删（CodeRabbit #401）。
// 匹配用双保险：① 确定性 id（hash(频道:seq)，调用方按已加载的本频道 @消息算好传入，不依赖平台回传
// extra）；② 发送时写入的 extra.slug（覆盖已加载窗口外、但 extra 能回传的旧通知）。任一命中即删。
// 旧壳缺 active / removeActive → 兜底返回 false。
export async function clearDeliveredMentionNotifications(
  slug: string,
  mentionIds: readonly number[],
): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const notification = await dependencies.loadNotification();
    if (typeof notification.active !== "function" || typeof notification.removeActive !== "function") return false;
    const idSet = new Set(mentionIds);
    const delivered = await notification.active();
    const mine = delivered.filter((n) => idSet.has(n.id) || n.extra?.slug === slug);
    if (mine.length > 0) await notification.removeActive(mine.map((n) => ({ id: n.id })));
    return true;
  } catch {
    return false;
  }
}

export async function sendDesktopUpdateAvailableNotification(
  input: DesktopUpdateNotification,
): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    const notification = await dependencies.loadNotification();
    if (!(await notification.isPermissionGranted())) return false;
    await notification.sendNotification({ title: input.title, body: input.body });
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

export async function waitForDesktopWindowShown(): Promise<void> {
  if (!isDesktopRuntime()) return;
  try {
    const event = await dependencies.loadEvent();
    let finish!: () => void;
    const shown = new Promise<void>((resolve) => { finish = resolve; });
    const unlisten = await event.listen("agentparty://window-shown", finish);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (await invoke<boolean>("desktop_window_has_been_shown")) finish();
      await shown;
    } finally {
      unlisten();
    }
  } catch {
    // Older shells do not expose the visibility command. Fail open so a UI-only
    // update cannot strand users on the desktop loading screen.
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
