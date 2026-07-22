import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  isAutostartEnabled,
  isDesktopRuntime,
  setAutostartEnabled,
} from "../lib/desktopRuntime";
import { useT, type TFunc } from "../i18n/useT";
import "../i18n/strings/DesktopSettings";
import { DesktopAgentPanel } from "./DesktopAgentPanel";
import { ResidentDutyLogs } from "./ResidentDutyLogs";
import { LocalAgentsOverview } from "./LocalAgentsOverview";
import { desktopAgentAdapter, type DesktopAgentAdapter } from "../lib/desktopAgent";
import {
  loadDesktopReleaseInfo,
  type DesktopReleaseInfo,
} from "../lib/desktopRelease";

export interface DesktopSettingsRuntime {
  isDesktopRuntime(): boolean;
  isAutostartEnabled(): Promise<boolean>;
  setAutostartEnabled(enabled: boolean): Promise<boolean>;
  getAppVersion(): Promise<string>;
  getReleaseInfo(): Promise<DesktopReleaseInfo>;
}

export interface DesktopVersionInfo {
  desktop: string | null;
  server: string | null;
  commit: string | null;
  release: DesktopReleaseInfo;
}

type DesktopVersionFetcher = (input: string) => Promise<Response>;

function displayVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(normalized)
    ? normalized
    : null;
}

function displayCommit(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

export async function loadDesktopVersionInfo(
  runtime: DesktopSettingsRuntime,
  serverOrigin: string,
  fetcher: DesktopVersionFetcher = fetch,
): Promise<DesktopVersionInfo> {
  const desktop = runtime.getAppVersion().then(displayVersion).catch(() => null);
  const release = runtime.getReleaseInfo().catch(() => ({
    distribution: "development" as const,
    notarized: false,
  }));
  const server = (async (): Promise<Pick<DesktopVersionInfo, "server" | "commit">> => {
    const origin = serverOrigin.trim().replace(/\/+$/, "");
    if (origin === "") return { server: null, commit: null };
    try {
      const response = await fetcher(`${origin}/api/health`);
      if (!response.ok) return { server: null, commit: null };
      const payload = await response.json() as { version?: unknown; commit?: unknown };
      return { server: displayVersion(payload.version), commit: displayCommit(payload.commit) };
    } catch {
      return { server: null, commit: null };
    }
  })();
  const [desktopVersion, releaseInfo, serverVersion] = await Promise.all([desktop, release, server]);
  return { desktop: desktopVersion, release: releaseInfo, ...serverVersion };
}

const defaultRuntime: DesktopSettingsRuntime = {
  isDesktopRuntime,
  isAutostartEnabled,
  setAutostartEnabled,
  getAppVersion: async () => (await import("@tauri-apps/api/app")).getVersion(),
  getReleaseInfo: loadDesktopReleaseInfo,
};

export async function loadAutostartSetting(runtime: DesktopSettingsRuntime): Promise<boolean> {
  return runtime.isAutostartEnabled();
}

export async function applyAutostartSetting(
  runtime: DesktopSettingsRuntime,
  next: boolean,
  previous: boolean,
): Promise<{ enabled: boolean; failed: boolean }> {
  if (await runtime.setAutostartEnabled(next)) return { enabled: next, failed: false };
  try {
    return { enabled: await runtime.isAutostartEnabled(), failed: true };
  } catch {
    return { enabled: previous, failed: true };
  }
}

export function shouldDismissDesktopSettings(event: Pick<KeyboardEvent, "key">): boolean {
  return event.key === "Escape";
}

export function isDesktopSettingsOutsideClick(
  root: Pick<Node, "contains"> | null,
  target: Node,
): boolean {
  return root !== null && !root.contains(target);
}

interface FocusTarget {
  focus(): void;
}

export function updateDesktopSettingsFocus(
  open: boolean,
  wasOpen: boolean,
  restoreFocus: boolean,
  control: FocusTarget | null,
  trigger: FocusTarget | null,
): void {
  if (open && !wasOpen) control?.focus();
  else if (!open && wasOpen && restoreFocus) trigger?.focus();
}

interface PanelProps {
  enabled: boolean;
  pending: boolean;
  error: boolean;
  versions: DesktopVersionInfo;
  t: TFunc;
  onToggle(): void;
  switchRef?: RefObject<HTMLButtonElement | null>;
  agentAdapter?: DesktopAgentAdapter;
  embedded?: boolean;
}

export function DesktopSettingsPanel({
  enabled,
  pending,
  error,
  versions,
  t,
  onToggle,
  switchRef,
  agentAdapter = desktopAgentAdapter,
  embedded = false,
}: PanelProps) {
  const unavailable = t("DesktopSettings.version.unavailable");
  return (
    <section
      id="desktop-settings-panel"
      className={`desktop-settings-panel t-mono${embedded ? " desktop-settings-panel--embedded" : ""}`}
      role={embedded ? "group" : "dialog"}
      aria-label={t("DesktopSettings.panel.title")}
    >
      <header>{t("DesktopSettings.panel.title")}</header>
      <div className="desktop-settings-row">
        <span>
          <strong>{t("DesktopSettings.autostart.label")}</strong>
          <small>{t("DesktopSettings.autostart.description")}</small>
        </span>
        <button
          ref={switchRef}
          type="button"
          className={`desktop-settings-switch${enabled ? " is-on" : ""}`}
          role="switch"
          aria-checked={enabled}
          aria-label={t("DesktopSettings.autostart.label")}
          disabled={pending}
          onClick={onToggle}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {pending && <p className="desktop-settings-status">{t("DesktopSettings.autostart.loading")}</p>}
      {error && <p className="desktop-settings-error" role="alert">{t("DesktopSettings.autostart.error")}</p>}
      <dl className="desktop-settings-versions">
        <div><dt>{t("DesktopSettings.version.desktop")}</dt><dd>{versions.desktop ?? unavailable}</dd></div>
        <div>
          <dt>{t("DesktopSettings.version.channel")}</dt>
          <dd>{t(`DesktopSettings.release.${versions.release.distribution}`)}</dd>
        </div>
        <div><dt>{t("DesktopSettings.version.server")}</dt><dd>{versions.server ?? unavailable}</dd></div>
        <div>
          <dt>{t("DesktopSettings.version.build")}</dt>
          <dd title={versions.commit ?? undefined}>{versions.commit?.slice(0, 8) ?? unavailable}</dd>
        </div>
      </dl>
      {versions.release.distribution === "preview" && (
        <p className="desktop-settings-release-warning" role="status">
          {t("DesktopSettings.release.previewWarning")}
        </p>
      )}
      {/* #700：全局「本机 agent」概览——按频道分组 + 可检索（不限频道）。下方 DesktopAgentPanel 仍是启动器。 */}
      <LocalAgentsOverview t={t} adapter={agentAdapter} />
      <DesktopAgentPanel adapter={agentAdapter} t={t} />
      {/* #725：常驻(launchd) agent 的日志查看——排查「设了常驻、@ 没反应」。 */}
      <ResidentDutyLogs t={t} adapter={agentAdapter} />
    </section>
  );
}

interface Props {
  runtime?: DesktopSettingsRuntime;
  serverOrigin?: string;
  agentAdapter?: DesktopAgentAdapter;
  embedded?: boolean;
}

export function DesktopSettings({
  runtime = defaultRuntime,
  serverOrigin = "",
  agentAdapter = desktopAgentAdapter,
  embedded = false,
}: Props) {
  const t = useT();
  const desktop = runtime.isDesktopRuntime();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(desktop);
  const [error, setError] = useState(false);
  const [versions, setVersions] = useState<DesktopVersionInfo>({
    desktop: null,
    server: null,
    commit: null,
    release: { distribution: "development", notarized: false },
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const switchRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    setPending(true);
    void loadAutostartSetting(runtime).then((next) => {
      if (!alive) return;
      setEnabled(next);
      setPending(false);
    });
    return () => { alive = false; };
  }, [desktop, runtime]);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void loadDesktopVersionInfo(runtime, serverOrigin).then((next) => {
      if (alive) setVersions(next);
    });
    return () => { alive = false; };
  }, [desktop, runtime, serverOrigin]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldDismissDesktopSettings(event)) {
        restoreFocusRef.current = true;
        setOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && isDesktopSettingsOutsideClick(rootRef.current, event.target)) {
        restoreFocusRef.current = false;
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    updateDesktopSettingsFocus(
      open,
      wasOpenRef.current,
      restoreFocusRef.current,
      switchRef.current,
      triggerRef.current,
    );
    wasOpenRef.current = open;
    if (!open) restoreFocusRef.current = false;
  }, [open]);

  if (!desktop) return null;

  const toggleAutostart = () => {
    if (pending) return;
    const previous = enabled;
    setPending(true);
    setError(false);
    void applyAutostartSetting(runtime, !enabled, previous).then((result) => {
      setEnabled(result.enabled);
      setError(result.failed);
      setPending(false);
    });
  };

  if (embedded) {
    return (
      <section className="settings-section settings-section--desktop">
        <DesktopSettingsPanel
          enabled={enabled}
          pending={pending}
          error={error}
          versions={versions}
          t={t}
          onToggle={toggleAutostart}
          switchRef={switchRef}
          agentAdapter={agentAdapter}
          embedded
        />
      </section>
    );
  }

  return (
    <div className="desktop-settings" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="desktop-settings-trigger"
        aria-label={t("DesktopSettings.control.label")}
        title={t("DesktopSettings.control.label")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="desktop-settings-panel"
        onClick={() => setOpen((current) => {
          restoreFocusRef.current = current;
          return !current;
        })}
      >
        <span className="ap-sprite ap-sprite--settings" aria-hidden="true" />
      </button>
      {open && (
        <DesktopSettingsPanel
          enabled={enabled}
          pending={pending}
          error={error}
          versions={versions}
          t={t}
          onToggle={toggleAutostart}
          switchRef={switchRef}
          agentAdapter={agentAdapter}
        />
      )}
    </div>
  );
}
