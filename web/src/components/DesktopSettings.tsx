import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  isAutostartEnabled,
  isDesktopRuntime,
  setAutostartEnabled,
} from "../lib/desktopRuntime";
import { useT, type TFunc } from "../i18n/useT";
import "../i18n/strings/DesktopSettings";

export interface DesktopSettingsRuntime {
  isDesktopRuntime(): boolean;
  isAutostartEnabled(): Promise<boolean>;
  setAutostartEnabled(enabled: boolean): Promise<boolean>;
}

const defaultRuntime: DesktopSettingsRuntime = {
  isDesktopRuntime,
  isAutostartEnabled,
  setAutostartEnabled,
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
  t: TFunc;
  onToggle(): void;
  switchRef?: RefObject<HTMLButtonElement | null>;
}

export function DesktopSettingsPanel({ enabled, pending, error, t, onToggle, switchRef }: PanelProps) {
  return (
    <section
      id="desktop-settings-panel"
      className="desktop-settings-panel t-mono"
      role="dialog"
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
    </section>
  );
}

interface Props {
  runtime?: DesktopSettingsRuntime;
}

export function DesktopSettings({ runtime = defaultRuntime }: Props) {
  const t = useT();
  const desktop = runtime.isDesktopRuntime();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(desktop);
  const [error, setError] = useState(false);
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
          t={t}
          onToggle={toggleAutostart}
          switchRef={switchRef}
        />
      )}
    </div>
  );
}
