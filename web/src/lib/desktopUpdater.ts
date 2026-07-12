export const LAST_SUCCESSFUL_CHECK_KEY = "ap_desktop_updater_last_success";
export const LAST_UPDATER_DIAGNOSTIC_KEY = "ap_desktop_updater_diagnostic";

const AUTO_CHECK_DELAY_MS = 8_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_CHECK_RETRY_MS = 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const VERSION_LOOKUP_TIMEOUT_MS = 2_000;
const MAX_RELEASE_NOTES_LENGTH = 2_000;
const SAFE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export type UpdaterFailureStage = "check" | "install" | "relaunch";
export type UpdaterErrorKind = "offline" | "timeout" | "verification" | "install" | "relaunch" | "generic";

export interface DesktopUpdaterState {
  phase: UpdaterPhase;
  panelOpen: boolean;
  currentVersion: string | null;
  nextVersion: string | null;
  notes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  progressPercent: number | null;
  error: UpdaterErrorKind | null;
  failureStage: UpdaterFailureStage | null;
}

export interface UpdateCandidate {
  currentVersion: string;
  nextVersion: string;
  notes?: string | null;
}

export type DownloadEvent =
  | { type: "started"; totalBytes?: number }
  | { type: "progress"; chunkBytes: number }
  | { type: "finished" };

export interface DesktopUpdaterAdapter {
  version?(): Promise<string | null>;
  recordDiagnostic?(diagnostic: DesktopUpdaterDiagnostic): Promise<void>;
  check(): Promise<UpdateCandidate | null>;
  install(onEvent: (event: DownloadEvent) => void): Promise<void>;
  relaunch(): Promise<void>;
  close(): Promise<void>;
}

export interface DesktopUpdaterDiagnostic {
  status: "attempt" | "success" | "failure" | "pending";
  source: "auto" | "manual" | null;
  stage: UpdaterFailureStage;
  category: UpdaterErrorKind | null;
  timestamp: number;
  appVersion: string | null;
  targetVersion?: string;
}

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TimerAdapter {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
}

interface ControllerOptions {
  adapter: DesktopUpdaterAdapter;
  clock: { now(): number };
  storage: StorageAdapter;
  timer?: TimerAdapter;
}

interface PendingUpdateReceipt {
  appVersion: string;
  targetVersion: string;
}

export interface DesktopUpdaterController {
  getState(): DesktopUpdaterState;
  subscribe(listener: (state: DesktopUpdaterState) => void): () => void;
  start(): void;
  check(source: "auto" | "manual"): Promise<void>;
  install(): Promise<void>;
  retry(): Promise<void>;
  openPanel(): void;
  closePanel(): void;
  togglePanel(): void;
  dispose(): void;
}

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

const defaultTimer: TimerAdapter = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
};

export function isTauriEnvironment(value: unknown = globalThis): boolean {
  return typeof value === "object" && value !== null && "__TAURI_INTERNALS__" in value;
}

export function shouldAutoCheck(storage: StorageAdapter, now: number): boolean {
  try {
    const raw = storage.getItem(LAST_SUCCESSFUL_CHECK_KEY);
    if (raw === null) return true;
    const timestamp = Number(raw);
    const age = now - timestamp;
    return !Number.isFinite(timestamp) || age >= AUTO_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function autoCheckDelay(storage: StorageAdapter, now: number): number {
  try {
    const raw = storage.getItem(LAST_SUCCESSFUL_CHECK_KEY);
    if (raw === null) return AUTO_CHECK_DELAY_MS;
    const timestamp = Number(raw);
    if (!Number.isFinite(timestamp)) return AUTO_CHECK_DELAY_MS;
    const age = now - timestamp;
    if (age < 0) return AUTO_CHECK_INTERVAL_MS;
    if (age >= AUTO_CHECK_INTERVAL_MS) return AUTO_CHECK_DELAY_MS;
    return Math.max(AUTO_CHECK_DELAY_MS, AUTO_CHECK_INTERVAL_MS - age);
  } catch {
    return AUTO_CHECK_DELAY_MS;
  }
}

function readPendingUpdateReceipt(storage: StorageAdapter): PendingUpdateReceipt | null {
  try {
    const raw = storage.getItem(LAST_UPDATER_DIAGNOSTIC_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const receipt = value as Record<string, unknown>;
    if (
      receipt.status !== "pending" ||
      receipt.stage !== "relaunch" ||
      typeof receipt.appVersion !== "string" ||
      typeof receipt.targetVersion !== "string" ||
      !SAFE_VERSION_PATTERN.test(receipt.appVersion) ||
      !SAFE_VERSION_PATTERN.test(receipt.targetVersion)
    ) return null;
    return { appVersion: receipt.appVersion, targetVersion: receipt.targetVersion };
  } catch {
    return null;
  }
}

function updaterErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

export function classifyUpdaterError(error: unknown, stage: UpdaterFailureStage): UpdaterErrorKind {
  const message = updaterErrorMessage(error).toLowerCase();
  if (/\b(timeout|timed out|etimedout)\b/.test(message)) return "timeout";
  if (/\b(offline|network|connection|unreachable|dns|failed to fetch|econnrefused|enotfound|enetunreach|ehostunreach)\b/.test(message)) {
    return "offline";
  }
  if (/\b(signature|checksum|verification|verify|certificate|cert)\b/.test(message)) return "verification";
  if (stage === "install") return "install";
  if (stage === "relaunch") return "relaunch";
  return "generic";
}

function boundReleaseNotes(notes: string | null | undefined): string | null {
  if (typeof notes !== "string") return null;
  const plainText = notes.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (plainText.length === 0) return null;
  if (plainText.length <= MAX_RELEASE_NOTES_LENGTH) return plainText;
  return plainText.slice(0, MAX_RELEASE_NOTES_LENGTH - 3).trimEnd() + "...";
}

function withTimeout<T>(promise: Promise<T>, timer: TimerAdapter, timeoutMs: number) {
  let timeoutId: unknown;
  let active = true;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = timer.setTimeout(() => {
      if (active) reject(new Error("Update check timed out"));
    }, timeoutMs);
  });
  const cancel = () => {
    if (!active) return;
    active = false;
    if (timeoutId !== undefined) timer.clearTimeout(timeoutId);
    timeoutId = undefined;
  };
  return { promise: Promise.race([promise, timeout]).finally(cancel), cancel };
}

export function createDesktopUpdaterController(options: ControllerOptions): DesktopUpdaterController {
  const timer = options.timer ?? defaultTimer;
  const listeners = new Set<(state: DesktopUpdaterState) => void>();
  let state = { ...INITIAL_STATE };
  let startupTimer: unknown;
  let started = false;
  let disposed = false;
  let checkPromise: Promise<void> | null = null;
  let cancelCheckTimeout: (() => void) | null = null;
  let operationPromise: Promise<void> | null = null;
  let closeRequested = false;
  let diagnosticQueue: Promise<void> = Promise.resolve();

  const publish = (next: DesktopUpdaterState) => {
    if (disposed) return;
    state = next;
    listeners.forEach((listener) => listener(state));
  };

  const patch = (next: Partial<DesktopUpdaterState>) => publish({ ...state, ...next });

  const persistDiagnostic = (diagnostic: DesktopUpdaterDiagnostic): Promise<void> => {
    try {
      options.storage.setItem(LAST_UPDATER_DIAGNOSTIC_KEY, JSON.stringify(diagnostic));
    } catch {
      // Updater behavior must not depend on diagnostics storage availability.
    }
    if (options.adapter.recordDiagnostic === undefined) return Promise.resolve();
    diagnosticQueue = diagnosticQueue
      .then(() => options.adapter.recordDiagnostic?.(diagnostic))
      .then(() => undefined)
      .catch(() => {
        console.error("[desktop-updater] failed to persist native diagnostic");
      });
    return diagnosticQueue;
  };

  const reportFailure = (
    stage: UpdaterFailureStage,
    error: unknown,
    source: "auto" | "manual" | null = null,
    appVersion: string | null = null,
    targetVersion: string | null = null,
  ) => {
    if (disposed) return;
    const category = classifyUpdaterError(error, stage);
    console.error(`[desktop-updater] ${stage} failed`, error);
    void persistDiagnostic({
      status: "failure",
      source,
      stage,
      category,
      timestamp: options.clock.now(),
      appVersion,
      ...(targetVersion === null ? {} : { targetVersion }),
    });
    patch({ phase: "error", failureStage: stage, error: category });
  };

  const persistPendingRelaunch = (): Promise<void> => {
    if (state.currentVersion === null || state.nextVersion === null) return Promise.resolve();
    return persistDiagnostic({
      status: "pending",
      source: null,
      stage: "relaunch",
      category: null,
      timestamp: options.clock.now(),
      appVersion: state.currentVersion,
      targetVersion: state.nextVersion,
    });
  };

  const closeAdapter = async () => {
    try {
      await options.adapter.close();
    } catch (error) {
      console.error("[desktop-updater] failed to close update handle", error);
    }
  };

  const closeAdapterWhenIdle = () => {
    if (closeRequested) return;
    closeRequested = true;
    const pending = [checkPromise, operationPromise].filter((promise): promise is Promise<void> => promise !== null);
    if (pending.length === 0) {
      void closeAdapter();
      return;
    }
    void Promise.allSettled(pending).then(closeAdapter);
  };

  const beginRelaunch = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (operationPromise !== null) return operationPromise;
    patch({ phase: "ready", failureStage: null, error: null });
    const active = (async () => {
      await persistPendingRelaunch();
      try {
        await options.adapter.relaunch();
      } catch (error) {
        reportFailure("relaunch", error, null, state.currentVersion, state.nextVersion);
      }
    })();
    operationPromise = active;
    void active.finally(() => {
      if (operationPromise === active) operationPromise = null;
    });
    return active;
  };

  const beginInstall = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (operationPromise !== null) return operationPromise;
    const canInstall = state.phase === "available" || (state.phase === "error" && state.failureStage === "install");
    if (!canInstall) return Promise.resolve();

    patch({
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: null,
      failureStage: null,
      error: null,
    });

    const active = (async () => {
      try {
        await options.adapter.install((event) => {
          if (disposed) return;
          if (event.type === "started") {
            const totalBytes =
              event.totalBytes !== undefined && Number.isFinite(event.totalBytes) && event.totalBytes > 0
                ? event.totalBytes
                : null;
            patch({ downloadedBytes: 0, totalBytes, progressPercent: totalBytes === null ? null : 0 });
            return;
          }
          if (event.type === "progress") {
            const chunkBytes = Math.max(0, Number.isFinite(event.chunkBytes) ? event.chunkBytes : 0);
            const downloadedBytes =
              state.totalBytes === null
                ? state.downloadedBytes + chunkBytes
                : Math.min(state.totalBytes, state.downloadedBytes + chunkBytes);
            patch({
              downloadedBytes,
              progressPercent:
                state.totalBytes === null ? null : Math.min(100, Math.round((downloadedBytes / state.totalBytes) * 100)),
            });
            return;
          }
          patch({
            phase: "installing",
            downloadedBytes: state.totalBytes ?? state.downloadedBytes,
            progressPercent: state.totalBytes === null ? null : 100,
          });
        });
      } catch (error) {
        reportFailure("install", error, null, state.currentVersion);
        return;
      }
      if (disposed) return;
      patch({
        phase: "ready",
        downloadedBytes: state.totalBytes ?? state.downloadedBytes,
        progressPercent: state.totalBytes === null ? null : 100,
      });
      await persistPendingRelaunch();
      try {
        await options.adapter.relaunch();
      } catch (error) {
        reportFailure("relaunch", error, null, state.currentVersion, state.nextVersion);
      }
    })();
    operationPromise = active;
    void active.finally(() => {
      if (operationPromise === active) operationPromise = null;
    });
    return active;
  };

  const controller: DesktopUpdaterController = {
    getState: () => state,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      if (disposed || started) return;
      started = true;
      const scheduleAutoCheck = (delayOverride?: number) => {
        if (disposed) return;
        if (startupTimer !== undefined) timer.clearTimeout(startupTimer);
        const delay = delayOverride ?? autoCheckDelay(options.storage, options.clock.now());
        startupTimer = timer.setTimeout(() => {
          startupTimer = undefined;
          if (disposed) return;
          if (!shouldAutoCheck(options.storage, options.clock.now())) {
            scheduleAutoCheck();
            return;
          }
          void controller.check("auto").finally(() => {
            if (disposed) return;
            scheduleAutoCheck(
              state.phase === "error" && state.failureStage === "check"
                ? AUTO_CHECK_RETRY_MS
                : AUTO_CHECK_INTERVAL_MS,
            );
          });
        }, delay);
      };
      const pending = readPendingUpdateReceipt(options.storage);
      if (pending === null) {
        scheduleAutoCheck();
        return;
      }
      void (async () => {
        let currentVersion: string | null = null;
        try {
          currentVersion = options.adapter.version === undefined ? null : await options.adapter.version();
        } catch {
          currentVersion = null;
        }
        if (disposed) return;
        if (currentVersion === pending.targetVersion) {
          void persistDiagnostic({
            status: "success",
            source: null,
            stage: "relaunch",
            category: null,
            timestamp: options.clock.now(),
            appVersion: currentVersion,
            targetVersion: pending.targetVersion,
          });
          scheduleAutoCheck();
          return;
        }
        reportFailure(
          "relaunch",
          new Error("Update version verification failed"),
          null,
          currentVersion,
          pending.targetVersion,
        );
        patch({ panelOpen: true });
      })();
    },

    check(source) {
      if (disposed) return Promise.resolve();
      if (source === "manual" && !state.panelOpen) patch({ panelOpen: true });
      if (checkPromise !== null) return checkPromise;
      if (operationPromise !== null || state.failureStage === "install" || state.failureStage === "relaunch") {
        return operationPromise ?? Promise.resolve();
      }

      patch({
        phase: "checking",
        panelOpen: source === "manual" ? true : state.panelOpen,
        currentVersion: null,
        nextVersion: null,
        notes: null,
        downloadedBytes: 0,
        totalBytes: null,
        progressPercent: null,
        error: null,
        failureStage: null,
      });
      void persistDiagnostic({
        status: "attempt",
        source,
        stage: "check",
        category: null,
        timestamp: options.clock.now(),
        appVersion: null,
      });

      const active = (async () => {
        const timedCheck = withTimeout(options.adapter.check(), timer, CHECK_TIMEOUT_MS);
        cancelCheckTimeout = timedCheck.cancel;
        const appVersionPromise = options.adapter.version === undefined
          ? Promise.resolve(null)
          : withTimeout(options.adapter.version(), timer, VERSION_LOOKUP_TIMEOUT_MS).promise.catch(() => null);
        try {
          const update = await timedCheck.promise;
          const appVersion = update?.currentVersion ?? await appVersionPromise;
          if (disposed) return;
          try {
            options.storage.setItem(LAST_SUCCESSFUL_CHECK_KEY, String(options.clock.now()));
          } catch {
            // A successful native check remains successful when persistence is unavailable.
          }
          void persistDiagnostic({
            status: "success",
            source,
            stage: "check",
            category: null,
            timestamp: options.clock.now(),
            appVersion,
          });
          if (update === null) {
            patch({ phase: "up-to-date" });
            return;
          }
          patch({
            phase: "available",
            panelOpen: true,
            currentVersion: update.currentVersion,
            nextVersion: update.nextVersion,
            notes: boundReleaseNotes(update.notes),
          });
        } catch (error) {
          reportFailure("check", error, source, await appVersionPromise);
        } finally {
          cancelCheckTimeout = null;
        }
      })();
      checkPromise = active;
      void active.finally(() => {
        if (checkPromise === active) checkPromise = null;
      });
      return active;
    },

    install() {
      return beginInstall();
    },

    retry() {
      if (state.failureStage === "check") return controller.check("manual");
      if (state.failureStage === "install") return beginInstall();
      if (state.failureStage === "relaunch") return beginRelaunch();
      return Promise.resolve();
    },

    openPanel: () => patch({ panelOpen: true }),
    closePanel: () => patch({ panelOpen: false }),
    togglePanel: () => patch({ panelOpen: !state.panelOpen }),

    dispose() {
      if (disposed) return;
      disposed = true;
      if (startupTimer !== undefined) timer.clearTimeout(startupTimer);
      cancelCheckTimeout?.();
      startupTimer = undefined;
      cancelCheckTimeout = null;
      listeners.clear();
      closeAdapterWhenIdle();
    },
  };

  return controller;
}

type Importer = (specifier: string) => Promise<unknown>;

interface TauriUpdaterOptions {
  importer?: Importer;
}

interface TauriUpdaterModule {
  check(): Promise<TauriUpdate | null>;
}

interface TauriProcessModule {
  relaunch(): Promise<void>;
}

interface TauriCoreModule {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface TauriUpdate {
  currentVersion: string;
  version: string;
  body?: string | null;
  downloadAndInstall(onEvent: (event: TauriDownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}

type TauriDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength?: number } }
  | { event: "Finished"; data?: Record<string, never> };

const nativeImport: Importer = (specifier) => {
  if (specifier === "@tauri-apps/plugin-updater") return import("@tauri-apps/plugin-updater");
  if (specifier === "@tauri-apps/plugin-process") return import("@tauri-apps/plugin-process");
  if (specifier === "@tauri-apps/api/app") return import("@tauri-apps/api/app");
  if (specifier === "@tauri-apps/api/core") return import("@tauri-apps/api/core");
  return Promise.reject(new Error(`Unsupported Tauri plugin: ${specifier}`));
};

export async function createTauriUpdaterAdapter(options: TauriUpdaterOptions = {}): Promise<DesktopUpdaterAdapter> {
  const importer = options.importer ?? nativeImport;
  const [updaterModule, processModule] = (await Promise.all([
    importer("@tauri-apps/plugin-updater"),
    importer("@tauri-apps/plugin-process"),
  ])) as [TauriUpdaterModule, TauriProcessModule];
  let retainedUpdate: TauriUpdate | null = null;
  let checkGeneration = 0;

  let lifecycleQueue: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleQueue.then(operation, operation);
    lifecycleQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const closeUpdate = async (update: TauriUpdate | null) => {
    if (update === null) return;
    try {
      await update.close();
    } catch (error) {
      console.error("[desktop-updater] failed to close native update handle", error);
    }
  };

  return {
    async version() {
      const appModule = (await importer("@tauri-apps/api/app")) as { getVersion(): Promise<string> };
      return appModule.getVersion();
    },

    async recordDiagnostic(diagnostic) {
      const coreModule = (await importer("@tauri-apps/api/core")) as TauriCoreModule;
      await coreModule.invoke("desktop_updater_record_diagnostic", { diagnostic });
    },

    check() {
      const generation = ++checkGeneration;
      const operationBarrier = lifecycleQueue;
      return (async () => {
        // A check must not replace the retained handle during install/relaunch,
        // but a timed-out check must not block a newer retry forever.
        await operationBarrier;
        const nextUpdate = await updaterModule.check();
        if (generation !== checkGeneration) {
          await closeUpdate(nextUpdate);
          return null;
        }
        const previousUpdate = retainedUpdate;
        retainedUpdate = nextUpdate;
        await closeUpdate(previousUpdate);
        if (nextUpdate === null) return null;
        return {
          currentVersion: nextUpdate.currentVersion,
          nextVersion: nextUpdate.version,
          notes: nextUpdate.body ?? null,
        };
      })();
    },

    install(onEvent) {
      return enqueue(async () => {
        if (retainedUpdate === null) throw new Error("No update is ready to install");
        await retainedUpdate.downloadAndInstall((event) => {
          if (event.event === "Started") {
            onEvent({ type: "started", totalBytes: event.data.contentLength });
          } else if (event.event === "Progress") {
            onEvent({ type: "progress", chunkBytes: event.data.chunkLength ?? 0 });
          } else if (event.event === "Finished") {
            onEvent({ type: "finished" });
          }
        });
      });
    },

    relaunch: () => enqueue(processModule.relaunch),

    close() {
      checkGeneration += 1;
      return enqueue(async () => {
        const update = retainedUpdate;
        retainedUpdate = null;
        await closeUpdate(update);
      });
    },
  };
}

interface BrowserDesktopUpdaterClientOptions {
  windowRef?: unknown;
  clock?: { now(): number };
  storage?: StorageAdapter;
  timer?: TimerAdapter;
  importer?: Importer;
}

function storageFromWindow(windowRef: unknown): StorageAdapter {
  try {
    if (typeof windowRef === "object" && windowRef !== null && "localStorage" in windowRef) {
      const storage = (windowRef as { localStorage?: StorageAdapter | null }).localStorage;
      if (storage !== undefined && storage !== null) return storage;
    }
  } catch {
    // Storage may be blocked while the desktop updater remains otherwise usable.
  }
  return {
    getItem: () => null,
    setItem: () => {},
  };
}

export function createBrowserDesktopUpdaterClient(
  options: BrowserDesktopUpdaterClientOptions = {},
): DesktopUpdaterController | null {
  const windowRef = options.windowRef ?? globalThis;
  if (!isTauriEnvironment(windowRef)) return null;
  let nativeAdapterPromise: Promise<DesktopUpdaterAdapter> | null = null;
  const getNativeAdapter = () => {
    if (nativeAdapterPromise === null) {
      nativeAdapterPromise = createTauriUpdaterAdapter({ importer: options.importer }).catch((error) => {
        nativeAdapterPromise = null;
        throw error;
      });
    }
    return nativeAdapterPromise;
  };
  const controller = createDesktopUpdaterController({
    adapter: {
      async version() {
        return (await getNativeAdapter()).version?.() ?? null;
      },
      async recordDiagnostic(diagnostic) {
        await (await getNativeAdapter()).recordDiagnostic?.(diagnostic);
      },
      async check() {
        return (await getNativeAdapter()).check();
      },
      async install(onEvent) {
        return (await getNativeAdapter()).install(onEvent);
      },
      async relaunch() {
        return (await getNativeAdapter()).relaunch();
      },
      async close() {
        if (nativeAdapterPromise !== null) await (await nativeAdapterPromise).close();
      },
    },
    clock: options.clock ?? { now: () => Date.now() },
    storage: options.storage ?? storageFromWindow(windowRef),
    timer: options.timer,
  });
  return controller;
}
