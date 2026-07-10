import { useEffect, useRef, useState, type RefObject } from "react";
import {
  createBrowserDesktopUpdaterClient,
  isTauriEnvironment,
  type DesktopUpdaterController,
  type DesktopUpdaterState,
} from "../lib/desktopUpdater";
import { listenForDesktopUpdateChecks } from "../lib/desktopRuntime";
import { useT } from "../i18n/useT";
import type { TFunc } from "../i18n/useT";
import "../i18n/strings/DesktopUpdater";

const INITIAL_STATE: DesktopUpdaterState = {
  phase: "idle",
  panelOpen: false,
  currentVersion: null,
  nextVersion: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  progressPercent: null,
  error: null,
  failureStage: null,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FocusTarget {
  focus(): void;
}

export function updateUpdaterDialogFocus(
  panelOpen: boolean,
  wasPanelOpen: boolean,
  dialog: FocusTarget | null,
  trigger: FocusTarget | null,
) {
  if (panelOpen) dialog?.focus();
  else if (wasPanelOpen) trigger?.focus();
}

export function handleDesktopUpdaterTrayCheck(controller: DesktopUpdaterController): void {
  controller.openPanel();
  void controller.check("manual");
}

interface DesktopUpdaterPanelProps {
  state: DesktopUpdaterState;
  t: TFunc;
  panelRef: RefObject<HTMLElement | null>;
  onClose(): void;
  onCheck(): void;
  onInstall(): void;
  onRetry(): void;
}

export function DesktopUpdaterPanel({
  state,
  t,
  panelRef,
  onClose,
  onCheck,
  onInstall,
  onRetry,
}: DesktopUpdaterPanelProps) {
  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
  return (
    <section
      ref={panelRef}
      className="desktop-updater-panel t-mono"
      role="dialog"
      aria-label={t("DesktopUpdater.panel.title")}
      tabIndex={-1}
    >
      <header className="desktop-updater-panel-head">
        <strong>{t("DesktopUpdater.panel.title")}</strong>
        <button
          type="button"
          className="desktop-updater-close"
          onClick={onClose}
          aria-label={t("DesktopUpdater.close")}
          title={t("DesktopUpdater.close")}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="desktop-updater-status" role="status" aria-live="polite">
        {state.phase === "idle" && <p>{t("DesktopUpdater.idle")}</p>}
        {state.phase === "checking" && <p>{t("DesktopUpdater.checking")}</p>}
        {state.phase === "up-to-date" && <p>{t("DesktopUpdater.noUpdate")}</p>}
        {state.phase === "available" && (
          <>
            <p>{t("DesktopUpdater.available")}</p>
            <dl className="desktop-updater-versions">
              <div>
                <dt>{t("DesktopUpdater.currentVersion")}</dt>
                <dd>{state.currentVersion}</dd>
              </div>
              <div>
                <dt>{t("DesktopUpdater.nextVersion")}</dt>
                <dd>{state.nextVersion}</dd>
              </div>
            </dl>
            {state.notes !== null && (
              <section className="desktop-updater-notes" aria-label={t("DesktopUpdater.releaseNotes")}>
                <strong>{t("DesktopUpdater.releaseNotes")}</strong>
                <p>{state.notes}</p>
              </section>
            )}
          </>
        )}
        {state.phase === "downloading" && (
          <>
            <p>{t("DesktopUpdater.downloading")}</p>
            <progress
              className="desktop-updater-progress"
              value={state.totalBytes === null ? undefined : state.downloadedBytes}
              max={state.totalBytes ?? undefined}
              aria-label={t("DesktopUpdater.downloadProgressLabel")}
            />
            <p className="desktop-updater-detail">
              {state.totalBytes === null
                ? t("DesktopUpdater.downloadUnknown", { downloaded: formatBytes(state.downloadedBytes) })
                : t("DesktopUpdater.downloadKnown", {
                    downloaded: formatBytes(state.downloadedBytes),
                    total: formatBytes(state.totalBytes),
                    percent: state.progressPercent ?? 0,
                  })}
            </p>
          </>
        )}
        {state.phase === "installing" && <p>{t("DesktopUpdater.installing")}</p>}
        {state.phase === "ready" && <p>{t("DesktopUpdater.ready")}</p>}
        {state.phase === "error" && (
          <>
            <p className="desktop-updater-error">{t("DesktopUpdater.error")}</p>
            {state.error !== null && (
              <p className="desktop-updater-detail">{t(`DesktopUpdater.error.${state.error}`)}</p>
            )}
          </>
        )}
      </div>

      <footer className="desktop-updater-actions">
        <button type="button" className="d-btn" onClick={state.phase === "error" ? onRetry : onCheck} disabled={busy}>
          {state.phase === "error" ? t("DesktopUpdater.retry") : t("DesktopUpdater.check")}
        </button>
        {state.phase === "available" && (
          <button type="button" className="d-btn desktop-updater-install" onClick={onInstall}>
            {t("DesktopUpdater.install")}
          </button>
        )}
      </footer>
    </section>
  );
}

export function DesktopUpdater() {
  const t = useT();
  const desktop = isTauriEnvironment();
  const controllerRef = useRef<DesktopUpdaterController | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const wasPanelOpenRef = useRef(false);
  const [state, setState] = useState<DesktopUpdaterState>(INITIAL_STATE);

  useEffect(() => {
    if (!desktop) return;
    const controller = createBrowserDesktopUpdaterClient({ windowRef: window });
    if (controller === null) return;
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setState);
    setState(controller.getState());
    controller.start();

    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten = () => {};
    void listenForDesktopUpdateChecks(() => {
      const controller = controllerRef.current;
      if (controller !== null) handleDesktopUpdaterTrayCheck(controller);
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [desktop]);

  useEffect(() => {
    updateUpdaterDialogFocus(state.panelOpen, wasPanelOpenRef.current, panelRef.current, triggerRef.current);
    wasPanelOpenRef.current = state.panelOpen;
  }, [state.panelOpen]);

  useEffect(() => {
    if (!state.panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (controllerRef.current) controllerRef.current.closePanel();
      else setState((current) => ({ ...current, panelOpen: false }));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.panelOpen]);

  if (!desktop) return null;

  const controlLabel =
    state.phase === "available"
      ? t("DesktopUpdater.control.available")
      : state.phase === "downloading"
        ? t("DesktopUpdater.control.downloading")
        : state.phase === "installing"
          ? t("DesktopUpdater.control.installing")
          : state.phase === "ready"
            ? t("DesktopUpdater.control.ready")
            : t("DesktopUpdater.control.label");

  const togglePanel = () => {
    if (controllerRef.current) controllerRef.current.togglePanel();
    else setState((current) => ({ ...current, panelOpen: !current.panelOpen }));
  };

  const closePanel = () => {
    if (controllerRef.current) controllerRef.current.closePanel();
    else setState((current) => ({ ...current, panelOpen: false }));
  };

  const manualCheck = () => {
    if (controllerRef.current) {
      void controllerRef.current.check("manual");
      return;
    }
  };

  const retry = () => {
    void controllerRef.current?.retry();
  };

  return (
    <div className="desktop-updater">
      <button
        ref={triggerRef}
        type="button"
        className={`desktop-updater-trigger desktop-updater-trigger--${state.phase}`}
        onClick={togglePanel}
        aria-label={controlLabel}
        aria-expanded={state.panelOpen}
        title={controlLabel}
      >
        <span aria-hidden="true">↻</span>
      </button>
      {state.panelOpen && (
        <DesktopUpdaterPanel
          state={state}
          t={t}
          panelRef={panelRef}
          onClose={closePanel}
          onCheck={manualCheck}
          onInstall={() => void controllerRef.current?.install()}
          onRetry={retry}
        />
      )}
    </div>
  );
}
