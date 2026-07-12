import { describe, expect, test } from "bun:test";
import {
  LAST_UPDATER_DIAGNOSTIC_KEY,
  LAST_SUCCESSFUL_CHECK_KEY,
  classifyUpdaterError,
  createBrowserDesktopUpdaterClient,
  createDesktopUpdaterController,
  createTauriUpdaterAdapter,
  isTauriEnvironment,
  shouldAutoCheck,
  type DesktopUpdaterAdapter,
  type DownloadEvent,
  type StorageAdapter,
  type TimerAdapter,
  type UpdateCandidate,
} from "./desktopUpdater";

const HOUR = 60 * 60 * 1000;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function captureConsoleErrors(run: () => Promise<void>): Promise<unknown[][]> {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    await run();
  } finally {
    console.error = original;
  }
  return calls;
}

function memoryStorage(initial: Record<string, string> = {}): StorageAdapter & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function candidate(): UpdateCandidate {
  return { currentVersion: "0.2.82", nextVersion: "0.2.83" };
}

function adapter(overrides: Partial<DesktopUpdaterAdapter> = {}): DesktopUpdaterAdapter {
  return {
    check: async () => null,
    install: async () => {},
    relaunch: async () => {},
    close: async () => {},
    ...overrides,
  };
}

function timerHarness() {
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  const cleared: unknown[] = [];
  const timer: TimerAdapter = {
    setTimeout(callback, delayMs) {
      const id = scheduled.length + 1;
      scheduled.push({ callback, delayMs });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
    },
  };
  return { timer, scheduled, cleared };
}

describe("desktop runtime detection", () => {
  test("detects Tauri from its injected global without invoking a native API", () => {
    expect(isTauriEnvironment()).toBe(false);
    expect(isTauriEnvironment({})).toBe(false);
    expect(isTauriEnvironment({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  test("creates no controller in browser or server runtimes", () => {
    expect(createBrowserDesktopUpdaterClient({ windowRef: undefined })).toBe(null);
    expect(createBrowserDesktopUpdaterClient({ windowRef: {} })).toBe(null);
  });

  test("keeps the desktop client usable when localStorage access throws", () => {
    const windowRef = { __TAURI_INTERNALS__: {} };
    Object.defineProperty(windowRef, "localStorage", {
      get() {
        throw new Error("storage denied");
      },
    });

    expect(() => createBrowserDesktopUpdaterClient({ windowRef })).not.toThrow();
    expect(createBrowserDesktopUpdaterClient({ windowRef })).not.toBe(null);
  });

  test("passes the native app version through the browser-to-Tauri bridge", async () => {
    const storage = memoryStorage({
      [LAST_UPDATER_DIAGNOSTIC_KEY]: JSON.stringify({
        status: "pending",
        source: null,
        stage: "relaunch",
        category: null,
        timestamp: 100,
        appVersion: "0.2.82",
        targetVersion: "0.2.83",
      }),
    });
    const client = createBrowserDesktopUpdaterClient({
      windowRef: { __TAURI_INTERNALS__: {} },
      clock: { now: () => 200 },
      storage,
      importer: async (specifier) => {
        if (specifier === "@tauri-apps/plugin-updater") return { check: async () => null };
        if (specifier === "@tauri-apps/plugin-process") return { relaunch: async () => {} };
        if (specifier === "@tauri-apps/api/app") return { getVersion: async () => "0.2.83" };
        if (specifier === "@tauri-apps/api/core") return { invoke: async () => {} };
        throw new Error(`unexpected import ${specifier}`);
      },
    });

    client?.start();
    for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();

    expect(JSON.parse(storage.values.get(LAST_UPDATER_DIAGNOSTIC_KEY) ?? "null")).toMatchObject({
      status: "success",
      stage: "relaunch",
      appVersion: "0.2.83",
      targetVersion: "0.2.83",
    });
  });
});

describe("desktop updater auto-check", () => {
  test("confirms a pending update receipt after the new process reports the target version", async () => {
    const storage = memoryStorage({
      [LAST_UPDATER_DIAGNOSTIC_KEY]: JSON.stringify({
        status: "pending",
        source: null,
        stage: "relaunch",
        category: null,
        timestamp: 100,
        appVersion: "0.2.82",
        targetVersion: "0.2.83",
      }),
    });
    const controller = createDesktopUpdaterController({
      adapter: adapter({ version: async () => "0.2.83" }),
      clock: { now: () => 200 },
      storage,
    });

    controller.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(storage.values.get(LAST_UPDATER_DIAGNOSTIC_KEY) ?? "null")).toEqual({
      status: "success",
      source: null,
      stage: "relaunch",
      category: null,
      timestamp: 200,
      appVersion: "0.2.83",
      targetVersion: "0.2.83",
    });
    expect(controller.getState().phase).toBe("idle");
  });

  test("surfaces a verification failure when relaunch keeps the previous version", async () => {
    const storage = memoryStorage({
      [LAST_UPDATER_DIAGNOSTIC_KEY]: JSON.stringify({
        status: "pending",
        source: null,
        stage: "relaunch",
        category: null,
        timestamp: 100,
        appVersion: "0.2.82",
        targetVersion: "0.2.83",
      }),
    });
    const controller = createDesktopUpdaterController({
      adapter: adapter({ version: async () => "0.2.82" }),
      clock: { now: () => 200 },
      storage,
    });

    await captureConsoleErrors(async () => {
      controller.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(controller.getState()).toMatchObject({
      phase: "error",
      panelOpen: true,
      failureStage: "relaunch",
      error: "verification",
    });
    expect(JSON.parse(storage.values.get(LAST_UPDATER_DIAGNOSTIC_KEY) ?? "null")).toEqual({
      status: "failure",
      source: null,
      stage: "relaunch",
      category: "verification",
      timestamp: 200,
      appVersion: "0.2.82",
      targetVersion: "0.2.83",
    });
  });

  test("skips checks recorded within the previous 6 hours", () => {
    const now = 30 * HOUR;
    const recent = memoryStorage({ [LAST_SUCCESSFUL_CHECK_KEY]: String(now - 5 * HOUR) });
    const stale = memoryStorage({ [LAST_SUCCESSFUL_CHECK_KEY]: String(now - 6 * HOUR) });

    expect(shouldAutoCheck(recent, now)).toBe(false);
    expect(shouldAutoCheck(stale, now)).toBe(true);
    expect(shouldAutoCheck(memoryStorage(), now)).toBe(true);
  });

  test("treats a future successful-check timestamp as inside the gate", () => {
    const now = 30 * HOUR;
    const storage = memoryStorage({ [LAST_SUCCESSFUL_CHECK_KEY]: String(now + HOUR) });

    expect(shouldAutoCheck(storage, now)).toBe(false);
  });

  test("runs once after an 8 second startup delay when the gate is open", async () => {
    let checkCalls = 0;
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const timer: TimerAdapter = {
      setTimeout(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return scheduled.length;
      },
      clearTimeout() {},
    };
    const controller = createDesktopUpdaterController({
      adapter: adapter({ check: async () => { checkCalls += 1; return null; } }),
      clock: { now: () => 50 * HOUR },
      storage: memoryStorage(),
      timer,
    });

    controller.start();
    expect(checkCalls).toBe(0);
    scheduled.find(({ delayMs }) => delayMs === 8_000)?.callback();
    for (let attempt = 0; attempt < 8; attempt += 1) await Promise.resolve();

    expect(checkCalls).toBe(1);
    expect(controller.getState().panelOpen).toBe(false);
    expect(scheduled.some(({ delayMs }) => delayMs === 6 * HOUR)).toBe(true);
  });

  test("does not open the panel for automatic no-update checks", async () => {
    const controller = createDesktopUpdaterController({
      adapter: adapter(),
      clock: { now: () => 123_456 },
      storage: memoryStorage(),
    });

    await controller.check("auto");

    expect(controller.getState()).toMatchObject({ phase: "up-to-date", panelOpen: false, error: null });
  });

  test("rechecks the 6 hour gate when the delayed callback runs", async () => {
    let now = 50 * HOUR;
    let checkCalls = 0;
    const storage = memoryStorage();
    const { timer, scheduled } = timerHarness();
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => {
          checkCalls += 1;
          return null;
        },
      }),
      clock: { now: () => now },
      storage,
      timer,
    });

    controller.start();
    await controller.check("manual");
    now += HOUR;
    scheduled.find(({ delayMs }) => delayMs === 8_000)?.callback();
    await Promise.resolve();

    expect(checkCalls).toBe(1);
  });
});

describe("desktop updater checks", () => {
  test("serializes native diagnostics so an older attempt cannot overwrite success", async () => {
    const attemptWrite = deferred<void>();
    const successWrite = deferred<void>();
    const statuses: string[] = [];
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        version: async () => "0.2.90",
        recordDiagnostic: async (diagnostic) => {
          statuses.push(diagnostic.status);
          if (diagnostic.status === "attempt") await attemptWrite.promise;
          if (diagnostic.status === "success") successWrite.resolve();
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });

    await controller.check("manual");
    expect(statuses).toEqual(["attempt"]);
    attemptWrite.resolve();
    await successWrite.promise;

    expect(statuses).toEqual(["attempt", "success"]);
  });

  test("persists an attempt before a native check settles", () => {
    const storage = memoryStorage();
    const pending = deferred<UpdateCandidate | null>();
    const controller = createDesktopUpdaterController({
      adapter: adapter({ check: () => pending.promise }),
      clock: { now: () => 123_456 },
      storage,
    });

    void controller.check("manual");

    expect(JSON.parse(storage.values.get(LAST_UPDATER_DIAGNOSTIC_KEY) ?? "null")).toEqual({
      status: "attempt",
      source: "manual",
      stage: "check",
      category: null,
      timestamp: 123_456,
      appVersion: null,
    });
    pending.resolve(null);
  });

  test("persists a privacy-safe diagnostic when a check fails", async () => {
    const storage = memoryStorage();
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        version: async () => "0.2.88",
        check: async () => { throw new Error("signature rejected with secret-token"); },
      }),
      clock: { now: () => 123_456 },
      storage,
    });

    await captureConsoleErrors(() => controller.check("auto"));

    expect(JSON.parse(storage.values.get(LAST_UPDATER_DIAGNOSTIC_KEY) ?? "null")).toEqual({
      status: "failure",
      source: "auto",
      stage: "check",
      category: "verification",
      timestamp: 123_456,
      appVersion: "0.2.88",
    });
    expect(storage.values.get(LAST_UPDATER_DIAGNOSTIC_KEY)).not.toContain("secret-token");
  });

  test("does not let a stuck app-version lookup keep a failed check pending", async () => {
    let settled = false;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        version: () => new Promise(() => {}),
        check: async () => { throw new Error("network unavailable"); },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
      timer: {
        setTimeout(callback, delayMs) {
          if (delayMs < 30_000) callback();
          return delayMs;
        },
        clearTimeout() {},
      },
    });

    void captureConsoleErrors(() => controller.check("auto")).then(() => { settled = true; });
    for (let i = 0; i < 10 && !settled; i += 1) await Promise.resolve();

    expect(settled).toBe(true);
  });

  test("records a successful no-update check", async () => {
    const storage = memoryStorage();
    const controller = createDesktopUpdaterController({
      adapter: adapter({ version: async () => "0.2.88" }),
      clock: { now: () => 123_456 },
      storage,
    });

    await controller.check("manual");

    expect(controller.getState()).toMatchObject({ phase: "up-to-date", panelOpen: true, error: null });
    expect(storage.values.get(LAST_SUCCESSFUL_CHECK_KEY)).toBe("123456");
    expect(JSON.parse(storage.values.get(LAST_UPDATER_DIAGNOSTIC_KEY) ?? "null")).toEqual({
      status: "success",
      source: "manual",
      stage: "check",
      category: null,
      timestamp: 123_456,
      appVersion: "0.2.88",
    });
  });

  test("exposes the current version, next version, and notes when an update is available", async () => {
    const controller = createDesktopUpdaterController({
      adapter: adapter({ check: async () => ({ ...candidate(), notes: "Fixes update panel" }) }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });

    await controller.check("manual");

    expect(controller.getState()).toMatchObject({
      phase: "available",
      currentVersion: "0.2.82",
      nextVersion: "0.2.83",
      notes: "Fixes update panel",
      panelOpen: true,
    });
  });

  test("automatically opens the update panel when a background check finds a new version", async () => {
    const controller = createDesktopUpdaterController({
      adapter: adapter({ check: async () => candidate() }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });

    await controller.check("auto");

    expect(controller.getState()).toMatchObject({
      phase: "available",
      panelOpen: true,
      currentVersion: "0.2.82",
      nextVersion: "0.2.83",
    });
  });

  test("bounds release notes before publishing an available update", async () => {
    const controller = createDesktopUpdaterController({
      adapter: adapter({ check: async () => ({ ...candidate(), notes: "x".repeat(5_000) }) }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });

    await controller.check("manual");

    expect(controller.getState().notes?.length).toBeLessThanOrEqual(2_000);
  });

  test("keeps auto-check errors non-interrupting and retryable", async () => {
    const controller = createDesktopUpdaterController({
      adapter: adapter({ check: async () => { throw new Error("signature rejected"); } }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });

    const errors = await captureConsoleErrors(() => controller.check("auto"));

    expect(controller.getState()).toMatchObject({
      phase: "error",
      panelOpen: false,
      failureStage: "check",
      error: "verification",
    });
    expect(errors[0]?.[1]).toBeInstanceOf(Error);
    controller.openPanel();
    expect(controller.getState().panelOpen).toBe(true);
  });

  test("shares one adapter request between concurrent checks", async () => {
    const pending = deferred<UpdateCandidate | null>();
    let checkCalls = 0;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: () => {
          checkCalls += 1;
          return pending.promise;
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });

    const first = controller.check("auto");
    const second = controller.check("manual");
    expect(checkCalls).toBe(1);
    expect(controller.getState().panelOpen).toBe(true);

    pending.resolve(null);
    await Promise.all([first, second]);
    expect(checkCalls).toBe(1);
  });
});

describe("desktop updater installation", () => {
  test("normalizes known byte progress and enters installing after the download finishes", async () => {
    const events: DownloadEvent[] = [
      { type: "started", totalBytes: 100 },
      { type: "progress", chunkBytes: 40 },
      { type: "progress", chunkBytes: 80 },
    ];
    const installed = deferred<void>();
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: async (onEvent) => {
          events.forEach(onEvent);
          onEvent({ type: "finished" });
          return installed.promise;
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    await controller.check("manual");

    const installing = controller.install();
    await Promise.resolve();

    expect(controller.getState()).toMatchObject({
      phase: "installing",
      downloadedBytes: 100,
      totalBytes: 100,
      progressPercent: 100,
    });
    installed.resolve();
    await installing;
  });

  test("keeps progress indeterminate when the total size is unknown", async () => {
    let downloadingState: ReturnType<ReturnType<typeof createDesktopUpdaterController>["getState"]> | undefined;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: async (onEvent) => {
          onEvent({ type: "started" });
          onEvent({ type: "progress", chunkBytes: 64 });
          downloadingState = controller.getState();
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    await controller.check("manual");

    await controller.install();

    expect(downloadingState).toMatchObject({
      phase: "downloading",
      downloadedBytes: 64,
      totalBytes: null,
      progressPercent: null,
    });
  });

  test("enters ready state and relaunches after installation finishes", async () => {
    const phases: string[] = [];
    let relaunchCalls = 0;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: async (onEvent) => onEvent({ type: "finished" }),
        relaunch: async () => { relaunchCalls += 1; },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    controller.subscribe((state) => phases.push(state.phase));
    await controller.check("manual");

    await controller.install();

    expect(phases).toContain("ready");
    expect(relaunchCalls).toBe(1);
    expect(controller.getState().phase).toBe("ready");
  });

  test("persists the target-version receipt before requesting relaunch", async () => {
    const storage = memoryStorage();
    let receiptAtRelaunch: unknown = null;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: async (onEvent) => onEvent({ type: "finished" }),
        relaunch: async () => {
          receiptAtRelaunch = JSON.parse(storage.values.get(LAST_UPDATER_DIAGNOSTIC_KEY) ?? "null");
        },
      }),
      clock: { now: () => 123_456 },
      storage,
    });
    await controller.check("manual");

    await controller.install();

    expect(receiptAtRelaunch).toEqual({
      status: "pending",
      source: null,
      stage: "relaunch",
      category: null,
      timestamp: 123_456,
      appVersion: "0.2.82",
      targetVersion: "0.2.83",
    });
  });

  test("waits for the native receipt before requesting relaunch", async () => {
    const nativeWrite = deferred<void>();
    let relaunchCalls = 0;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: async () => {},
        recordDiagnostic: async (diagnostic) => {
          if (diagnostic.status === "pending") await nativeWrite.promise;
        },
        relaunch: async () => { relaunchCalls += 1; },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    await controller.check("manual");

    const installing = controller.install();
    await Promise.resolve();
    await Promise.resolve();
    expect(relaunchCalls).toBe(0);

    nativeWrite.resolve();
    await installing;
    expect(relaunchCalls).toBe(1);
  });

  test("reports the ready phase after download finishes and before relaunch", async () => {
    const phases: string[] = [];
    const relaunchGate = deferred<void>();
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: async (onEvent) => onEvent({ type: "finished" }),
        relaunch: () => relaunchGate.promise,
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    controller.subscribe((state) => phases.push(state.phase));
    await controller.check("manual");

    const installing = controller.install();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getState().phase).toBe("ready");
    expect(phases).toContain("ready");
    relaunchGate.resolve();
    await installing;
  });

  test("shows plugin or network failures without disabling retry", async () => {
    let installCalls = 0;
    const storage = memoryStorage();
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: async () => {
          installCalls += 1;
          if (installCalls === 1) throw new Error("network unavailable");
        },
      }),
      clock: { now: () => 1 },
      storage,
    });
    await controller.check("manual");

    const errors = await captureConsoleErrors(() => controller.install());

    expect(controller.getState()).toMatchObject({
      phase: "error",
      failureStage: "install",
      error: "offline",
      panelOpen: true,
    });
    expect((errors[0]?.[1] as Error).message).toBe("network unavailable");
    expect(JSON.parse(storage.values.get(LAST_UPDATER_DIAGNOSTIC_KEY) ?? "null")).toEqual({
      status: "failure",
      source: null,
      stage: "install",
      category: "offline",
      timestamp: 1,
      appVersion: "0.2.82",
    });

    await controller.retry();

    expect(installCalls).toBe(2);
    expect(controller.getState().phase).toBe("ready");
  });

  test("retries a failed relaunch without checking or installing again", async () => {
    let checkCalls = 0;
    let installCalls = 0;
    let relaunchCalls = 0;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => {
          checkCalls += 1;
          return candidate();
        },
        install: async () => {
          installCalls += 1;
        },
        relaunch: async () => {
          relaunchCalls += 1;
          if (relaunchCalls === 1) throw new Error("restart refused");
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    await controller.check("manual");

    const errors = await captureConsoleErrors(() => controller.install());
    expect(controller.getState()).toMatchObject({ phase: "error", failureStage: "relaunch", error: "relaunch" });
    expect((errors[0]?.[1] as Error).message).toBe("restart refused");

    await controller.retry();

    expect({ checkCalls, installCalls, relaunchCalls }).toEqual({ checkCalls: 1, installCalls: 1, relaunchCalls: 2 });
    expect(controller.getState().phase).toBe("ready");
  });

  test("shares one retained-handle install retry between duplicate retry clicks", async () => {
    const retryInstall = deferred<void>();
    let installCalls = 0;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: () => {
          installCalls += 1;
          if (installCalls === 1) return Promise.reject(new Error("install rejected"));
          return retryInstall.promise;
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    await controller.check("manual");
    await captureConsoleErrors(() => controller.install());

    const first = controller.retry();
    const second = controller.retry();
    expect(installCalls).toBe(2);

    retryInstall.resolve();
    await Promise.all([first, second]);
    expect(installCalls).toBe(2);
  });

  test("shares one relaunch retry between duplicate retry clicks", async () => {
    const retryRelaunch = deferred<void>();
    let relaunchCalls = 0;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        relaunch: () => {
          relaunchCalls += 1;
          if (relaunchCalls === 1) return Promise.reject(new Error("relaunch rejected"));
          return retryRelaunch.promise;
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    await controller.check("manual");
    await captureConsoleErrors(() => controller.install());

    const first = controller.retry();
    const second = controller.retry();
    await Promise.resolve();
    expect(relaunchCalls).toBe(2);

    retryRelaunch.resolve();
    await Promise.all([first, second]);
    expect(relaunchCalls).toBe(2);
  });

  test("ignores duplicate install clicks while installation is active", async () => {
    const pending = deferred<void>();
    let installCalls = 0;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: () => {
          installCalls += 1;
          return pending.promise;
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    await controller.check("manual");

    const first = controller.install();
    const second = controller.install();
    expect(installCalls).toBe(1);

    pending.resolve();
    await Promise.all([first, second]);
    expect(installCalls).toBe(1);
  });
});

describe("desktop updater timeout and plugin adapter", () => {
  test("times out native checks after 30 seconds", async () => {
    const pending = deferred<UpdateCandidate | null>();
    const { timer, scheduled } = timerHarness();
    const controller = createDesktopUpdaterController({
      adapter: adapter({ check: () => pending.promise }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
      timer,
    });

    const checked = controller.check("manual");
    expect(scheduled.at(-1)?.delayMs).toBe(30_000);
    scheduled.at(-1)?.callback();
    const errors = await captureConsoleErrors(() => checked);

    expect(controller.getState()).toMatchObject({
      phase: "error",
      failureStage: "check",
      error: "timeout",
      panelOpen: true,
    });
    expect((errors[0]?.[1] as Error).message).toBe("Update check timed out");
  });

  test("starts a fresh native check when retrying after a timed-out Tauri check", async () => {
    const firstNativeCheck = deferred<{
      currentVersion: string;
      version: string;
      downloadAndInstall(): Promise<void>;
      close(): Promise<void>;
    } | null>();
    let nativeCheckCalls = 0;
    let staleCloseCalls = 0;
    const tauriAdapter = await createTauriUpdaterAdapter({
      importer: async (specifier) => {
        if (specifier === "@tauri-apps/plugin-updater") {
          return {
            check: () => {
              nativeCheckCalls += 1;
              return nativeCheckCalls === 1 ? firstNativeCheck.promise : Promise.resolve(null);
            },
          };
        }
        if (specifier === "@tauri-apps/api/core") return { invoke: async () => {} };
        return { relaunch: async () => {} };
      },
    });
    const { timer, scheduled } = timerHarness();
    const controller = createDesktopUpdaterController({
      adapter: tauriAdapter,
      clock: { now: () => 1 },
      storage: memoryStorage(),
      timer,
    });

    const firstCheck = controller.check("manual");
    scheduled[0]?.callback();
    await captureConsoleErrors(() => firstCheck);
    const retry = controller.retry();
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeCheckCalls).toBe(2);
    await retry;
    expect(controller.getState().phase).toBe("up-to-date");

    firstNativeCheck.resolve({
      currentVersion: "0.2.83",
      version: "0.2.84",
      downloadAndInstall: async () => {},
      close: async () => {
        staleCloseCalls += 1;
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(staleCloseCalls).toBe(1);
  });

  test("classifies native errors without exposing their raw messages", () => {
    expect(classifyUpdaterError("network unavailable", "check")).toBe("offline");
    expect(classifyUpdaterError({ message: "ECONNREFUSED 127.0.0.1" }, "check")).toBe("offline");
    expect(classifyUpdaterError({ message: "request timed out" }, "check")).toBe("timeout");
    expect(classifyUpdaterError(new Error("ETIMEDOUT"), "check")).toBe("timeout");
    expect(classifyUpdaterError(new Error("signature rejected"), "check")).toBe("verification");
    expect(classifyUpdaterError(new Error("disk denied"), "install")).toBe("install");
    expect(classifyUpdaterError(new Error("restart refused"), "relaunch")).toBe("relaunch");
    expect(classifyUpdaterError(null, "check")).toBe("generic");
  });

  test("loads Tauri updater plugins only through dynamic import", async () => {
    const imports: string[] = [];
    const nativeDiagnostics: unknown[] = [];
    let closeCalls = 0;
    const update = {
      currentVersion: "0.2.82",
      version: "0.2.83",
      body: "Release notes",
      downloadAndInstall: async (onEvent: (event: { event: string; data?: Record<string, number> }) => void) => {
        onEvent({ event: "Started", data: { contentLength: 10 } });
        onEvent({ event: "Progress", data: { chunkLength: 10 } });
        onEvent({ event: "Finished" });
      },
      close: async () => {
        closeCalls += 1;
      },
    };
    let relaunchCalls = 0;
    const tauriAdapter = await createTauriUpdaterAdapter({
      importer: async (specifier) => {
        imports.push(specifier);
        if (specifier === "@tauri-apps/plugin-updater") return { check: async () => update };
        if (specifier === "@tauri-apps/plugin-process") return { relaunch: async () => { relaunchCalls += 1; } };
        if (specifier === "@tauri-apps/api/app") return { getVersion: async () => "0.2.82" };
        if (specifier === "@tauri-apps/api/core") {
          return { invoke: async (command: string, args: unknown) => nativeDiagnostics.push({ command, args }) };
        }
        throw new Error(`unexpected import ${specifier}`);
      },
    });

    expect(imports).toEqual(["@tauri-apps/plugin-updater", "@tauri-apps/plugin-process"]);
    await expect(tauriAdapter.version?.()).resolves.toBe("0.2.82");
    expect(imports).toEqual(["@tauri-apps/plugin-updater", "@tauri-apps/plugin-process", "@tauri-apps/api/app"]);
    await tauriAdapter.recordDiagnostic?.({
      status: "success",
      source: "manual",
      stage: "check",
      category: null,
      timestamp: 1,
      appVersion: "0.2.82",
    });
    expect(nativeDiagnostics).toEqual([{
      command: "desktop_updater_record_diagnostic",
      args: { diagnostic: {
        status: "success",
        source: "manual",
        stage: "check",
        category: null,
        timestamp: 1,
        appVersion: "0.2.82",
      } },
    }]);
    await expect(tauriAdapter.check()).resolves.toMatchObject({
      currentVersion: "0.2.82",
      nextVersion: "0.2.83",
      notes: "Release notes",
    });
    const events: DownloadEvent[] = [];
    await tauriAdapter.install((event) => events.push(event));
    await tauriAdapter.relaunch();
    await tauriAdapter.close();
    expect(events).toEqual([
      { type: "started", totalBytes: 10 },
      { type: "progress", chunkBytes: 10 },
      { type: "finished" },
    ]);
    expect(relaunchCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  test("closes the previous native update when a check replaces its handle", async () => {
    const closeCalls = [0, 0];
    const updates = closeCalls.map((_, index) => ({
      currentVersion: "0.2.82",
      version: `0.2.${83 + index}`,
      downloadAndInstall: async () => {},
      close: async () => {
        closeCalls[index] += 1;
      },
    }));
    let checkCalls = 0;
    const tauriAdapter = await createTauriUpdaterAdapter({
      importer: async (specifier) => {
        if (specifier === "@tauri-apps/plugin-updater") {
          return { check: async () => updates[checkCalls++] ?? null };
        }
        return { relaunch: async () => {} };
      },
    });

    await tauriAdapter.check();
    await tauriAdapter.check();

    expect(closeCalls).toEqual([1, 0]);
    await tauriAdapter.close();
    expect(closeCalls).toEqual([1, 1]);
  });

  test("does not replace or close a native handle while installation is active", async () => {
    const installing = deferred<void>();
    let checkCalls = 0;
    let closeCalls = 0;
    const firstUpdate = {
      currentVersion: "0.2.82",
      version: "0.2.83",
      downloadAndInstall: () => installing.promise,
      close: async () => {
        closeCalls += 1;
      },
    };
    const secondUpdate = {
      ...firstUpdate,
      version: "0.2.84",
      downloadAndInstall: async () => {},
    };
    const tauriAdapter = await createTauriUpdaterAdapter({
      importer: async (specifier) => {
        if (specifier === "@tauri-apps/plugin-updater") {
          return { check: async () => (checkCalls++ === 0 ? firstUpdate : secondUpdate) };
        }
        return { relaunch: async () => {} };
      },
    });
    await tauriAdapter.check();

    const installOperation = tauriAdapter.install(() => {});
    const replacementCheck = tauriAdapter.check();
    const closeOperation = tauriAdapter.close();
    await Promise.resolve();

    expect(checkCalls).toBe(1);
    expect(closeCalls).toBe(0);

    installing.resolve();
    await Promise.all([installOperation, replacementCheck, closeOperation]);
    expect(checkCalls).toBe(2);
    expect(closeCalls).toBe(2);
  });
});

describe("desktop updater disposal", () => {
  test("clears an in-flight native check timeout on disposal", async () => {
    const pending = deferred<UpdateCandidate | null>();
    const { timer, scheduled, cleared } = timerHarness();
    const controller = createDesktopUpdaterController({
      adapter: adapter({ check: () => pending.promise }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
      timer,
    });

    const checked = controller.check("manual");
    expect(scheduled[0]?.delayMs).toBe(30_000);
    controller.dispose();

    expect(cleared).toEqual([1]);
    pending.resolve(null);
    await checked;
    expect(cleared).toEqual([1]);
  });

  test("clears startup timers and ignores async state updates after disposal", async () => {
    const pending = deferred<UpdateCandidate | null>();
    let clearCalls = 0;
    let scheduled: (() => void) | undefined;
    const timer: TimerAdapter = {
      setTimeout(callback) {
        scheduled = callback;
        return 7;
      },
      clearTimeout(id) {
        expect(id).toBe(7);
        clearCalls += 1;
      },
    };
    const controller = createDesktopUpdaterController({
      adapter: adapter({ check: () => pending.promise }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
      timer,
    });
    const phases: string[] = [];
    controller.subscribe((state) => phases.push(state.phase));

    controller.start();
    controller.dispose();
    scheduled?.();
    pending.resolve(candidate());
    await Promise.resolve();
    await Promise.resolve();

    expect(clearCalls).toBe(1);
    expect(phases).toEqual([]);
  });

  test("defers closing the update handle until an in-flight install settles", async () => {
    const installing = deferred<void>();
    let closeCalls = 0;
    let relaunchCalls = 0;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        install: () => installing.promise,
        relaunch: async () => {
          relaunchCalls += 1;
        },
        close: async () => {
          closeCalls += 1;
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    await controller.check("manual");

    const operation = controller.install();
    controller.dispose();
    expect(closeCalls).toBe(0);

    installing.resolve();
    await operation;
    await Promise.resolve();
    expect(closeCalls).toBe(1);
    expect(relaunchCalls).toBe(0);
  });

  test("defers closing the update handle until an in-flight relaunch settles", async () => {
    const relaunching = deferred<void>();
    let closeCalls = 0;
    const controller = createDesktopUpdaterController({
      adapter: adapter({
        check: async () => candidate(),
        relaunch: () => relaunching.promise,
        close: async () => {
          closeCalls += 1;
        },
      }),
      clock: { now: () => 1 },
      storage: memoryStorage(),
    });
    await controller.check("manual");

    const operation = controller.install();
    await Promise.resolve();
    controller.dispose();
    expect(closeCalls).toBe(0);

    relaunching.resolve();
    await operation;
    await Promise.resolve();
    expect(closeCalls).toBe(1);
  });
});
