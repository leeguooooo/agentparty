import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetDesktopRuntimeForTests,
  __setDesktopRuntimeDependenciesForTests,
  clearDeliveredMentionNotifications,
  mentionNotificationId,
  isAutostartEnabled,
  isDesktopNotificationPermissionGranted,
  isDesktopNotificationSupported,
  listenForDesktopNotificationActions,
  listenForDesktopPairLinks,
  openDesktopVerificationUrl,
  requestDesktopNotificationPermission,
  listenForDesktopUpdateChecks,
  sendDesktopUpdateAvailableNotification,
  sendMentionNotification,
  setAutostartEnabled,
  setDesktopBadge,
  showAndFocusDesktopWindow,
  type DesktopRuntimeDependencies,
} from "./desktopRuntime";

type NotificationModule = Awaited<ReturnType<DesktopRuntimeDependencies["loadNotification"]>>;
type AutostartModule = Awaited<ReturnType<DesktopRuntimeDependencies["loadAutostart"]>>;
type WindowModule = Awaited<ReturnType<DesktopRuntimeDependencies["loadWindow"]>>;

function notificationModule(overrides: Partial<NotificationModule> = {}): NotificationModule {
  return {
    isPermissionGranted: async () => true,
    requestPermission: async () => "granted",
    sendNotification: () => {},
    onAction: async () => ({ unregister: async () => {} }),
    ...overrides,
  };
}

function autostartModule(overrides: Partial<AutostartModule> = {}): AutostartModule {
  return {
    enable: async () => {},
    disable: async () => {},
    isEnabled: async () => false,
    ...overrides,
  };
}

function windowModule(overrides: Partial<WindowModule> = {}): WindowModule {
  return {
    getCurrentWindow: () => ({
      setBadgeCount: async () => {},
      show: async () => {},
      unminimize: async () => {},
      setFocus: async () => {},
    }),
    ...overrides,
  };
}

afterEach(() => {
  __resetDesktopRuntimeForTests();
});

describe("browser fallback", () => {
  test("does not load native modules and returns explicit no-op values", async () => {
    const loaded: string[] = [];
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => false,
      loadNotification: async () => {
        loaded.push("notification");
        return notificationModule();
      },
      loadAutostart: async () => {
        loaded.push("autostart");
        return autostartModule();
      },
      loadWindow: async () => {
        loaded.push("window");
        return windowModule();
      },
    });

    expect(await isDesktopNotificationSupported()).toBe(false);
    expect(await isDesktopNotificationPermissionGranted()).toBe(false);
    expect(await requestDesktopNotificationPermission()).toBe("unsupported");
    expect(await sendMentionNotification({ title: "Mention", body: "hello", slug: "general", seq: 7 })).toBe(false);
    const stopNotificationActions = await listenForDesktopNotificationActions(() => {});
    stopNotificationActions();
    expect(await setDesktopBadge(4)).toBe(false);
    expect(await showAndFocusDesktopWindow()).toBe(false);
    const unlisten = await listenForDesktopUpdateChecks(() => {});
    unlisten();
    expect(await isAutostartEnabled()).toBe(false);
    expect(await setAutostartEnabled(true)).toBe(false);
    expect(loaded).toEqual([]);
  });
});

describe("desktop notifications", () => {
  test("queries support and permission without requesting permission", async () => {
    let permissionChecks = 0;
    let permissionRequests = 0;
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({
        isPermissionGranted: async () => {
          permissionChecks += 1;
          return true;
        },
        requestPermission: async () => {
          permissionRequests += 1;
          return "granted";
        },
      }),
    });

    expect(await isDesktopNotificationSupported()).toBe(true);
    expect(await isDesktopNotificationPermissionGranted()).toBe(true);
    expect(permissionChecks).toBe(1);
    expect(permissionRequests).toBe(0);
  });

  test("requests and returns the native permission state", async () => {
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({ requestPermission: async () => "denied" }),
    });

    expect(await requestDesktopNotificationPermission()).toBe("denied");
  });

  test("preserves the native default permission state", async () => {
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({ requestPermission: async () => "default" }),
    });

    expect(await requestDesktopNotificationPermission()).toBe("default");
  });

  test("sends mention metadata in the notification extra payload", async () => {
    const payloads: unknown[] = [];
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({
        sendNotification: (payload) => {
          payloads.push(payload);
        },
      }),
    });

    expect(await sendMentionNotification({
      title: "Mention in #general",
      body: "Ada: hello @leo",
      slug: "general",
      seq: 42,
    })).toBe(true);
    expect(payloads).toEqual([{
      id: mentionNotificationId("general", 42),
      title: "Mention in #general",
      body: "Ada: hello @leo",
      extra: { slug: "general", seq: 42 },
    }]);
  });

  test("derives a stable, positive notification id per (channel, seq)", () => {
    // 同一 (频道, seq) → 同一 id：多窗口 / 重连 / 重开都覆盖同一条通知，去掉通知中心重复。
    const a = mentionNotificationId("general", 42);
    expect(mentionNotificationId("general", 42)).toBe(a);
    expect(a).toBeGreaterThan(0);
    expect(Number.isSafeInteger(a)).toBe(true);
    // 不同 seq / 频道给出不同 id，避免误覆盖别的通知。
    expect(mentionNotificationId("general", 43)).not.toBe(a);
    expect(mentionNotificationId("other", 42)).not.toBe(a);
  });

  test("clearDeliveredMentionNotifications removes only the focused channel's notifications", async () => {
    // 通知中心里混着两个频道 + 一条无关通知；只应删掉当前频道（general）的两条：
    // 一条按确定性 id 命中（已加载窗口内的 @），一条按 extra.slug 命中（窗口外但 extra 回传）。
    const delivered = [
      { id: mentionNotificationId("general", 42), extra: { slug: "general", seq: 42 } },
      { id: 999999, extra: { slug: "general", seq: 7 } },
      { id: mentionNotificationId("other", 5), extra: { slug: "other", seq: 5 } },
      { id: 111, extra: {} },
    ];
    let removed: Array<{ id: number }> = [];
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({
        active: async () => delivered,
        removeActive: async (notifications) => {
          removed = notifications;
        },
      }),
    });

    expect(await clearDeliveredMentionNotifications("general", [mentionNotificationId("general", 42)])).toBe(true);
    expect(removed.map((n) => n.id).sort((a, b) => a - b)).toEqual(
      [mentionNotificationId("general", 42), 999999].sort((a, b) => a - b),
    );
  });

  test("clearDeliveredMentionNotifications skips removeActive when nothing matches", async () => {
    let removeCalls = 0;
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({
        active: async () => [{ id: mentionNotificationId("other", 5), extra: { slug: "other", seq: 5 } }],
        removeActive: async () => {
          removeCalls += 1;
        },
      }),
    });

    expect(await clearDeliveredMentionNotifications("general", [])).toBe(true);
    expect(removeCalls).toBe(0);
  });

  test("clearDeliveredMentionNotifications is a safe no-op on shells without active/removeActive", async () => {
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => {
        const base = notificationModule();
        // 旧壳：JS 里没有 active / removeActive。
        delete (base as { active?: unknown }).active;
        delete (base as { removeActive?: unknown }).removeActive;
        return base;
      },
    });

    expect(await clearDeliveredMentionNotifications("general", [1, 2, 3])).toBe(false);
  });

  test("clearDeliveredMentionNotifications returns false when the native command rejects", async () => {
    // 旧壳保留了 JS 方法但底层命令不支持：应进入 catch 返回 false（CodeRabbit #401）。
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({
        active: async () => [{ id: mentionNotificationId("general", 42), extra: { slug: "general", seq: 42 } }],
        removeActive: async () => {
          throw new Error("plugin:notification|remove_active not implemented");
        },
      }),
    });

    expect(await clearDeliveredMentionNotifications("general", [mentionNotificationId("general", 42)])).toBe(false);
  });

  test("does not send when notification permission is not granted", async () => {
    let sends = 0;
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({
        isPermissionGranted: async () => false,
        sendNotification: () => {
          sends += 1;
        },
      }),
    });

    expect(await sendMentionNotification({ title: "Mention", body: "hello", slug: "general", seq: 8 })).toBe(false);
    expect(sends).toBe(0);
  });

  test("sends update copy without requesting permission or mention metadata", async () => {
    const payloads: unknown[] = [];
    let permissionRequests = 0;
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({
        requestPermission: async () => {
          permissionRequests += 1;
          return "granted";
        },
        sendNotification: (payload) => {
          payloads.push(payload);
        },
      }),
    });

    expect(await sendDesktopUpdateAvailableNotification({
      title: "Desktop update available",
      body: "AgentParty 0.2.98 is ready to install.",
    })).toBe(true);
    expect(permissionRequests).toBe(0);
    expect(payloads).toEqual([{
      title: "Desktop update available",
      body: "AgentParty 0.2.98 is ready to install.",
    }]);
  });

  test("does not send an update notification without existing permission", async () => {
    let sends = 0;
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({
        isPermissionGranted: async () => false,
        sendNotification: () => {
          sends += 1;
        },
      }),
    });

    expect(await sendDesktopUpdateAvailableNotification({ title: "Update", body: "Ready" })).toBe(false);
    expect(sends).toBe(0);
  });

  test("delivers validated notification actions and unregisters the native listener", async () => {
    let actionHandler: ((notification: { extra?: Record<string, unknown> }) => void) | null = null;
    let unregistered = false;
    const actions: Array<{ slug: string; seq: number }> = [];
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => notificationModule({
        onAction: async (handler) => {
          actionHandler = handler;
          return { unregister: async () => { unregistered = true; } };
        },
      }),
    });

    const stop = await listenForDesktopNotificationActions((action) => actions.push(action));
    actionHandler?.({ extra: { slug: "general", seq: 42 } });
    actionHandler?.({ extra: { slug: "../admin", seq: 43 } });
    actionHandler?.({ extra: { slug: "general", seq: 0 } });
    actionHandler?.({ extra: { slug: "general", seq: 1.5 } });
    actionHandler?.({ extra: { slug: "general", seq: "44" } });
    actionHandler?.({});
    stop();
    await Promise.resolve();

    expect(actions).toEqual([{ slug: "general", seq: 42 }]);
    expect(unregistered).toBe(true);
  });
});

describe("desktop window", () => {
  test("opens verification pages only through the allowlisted system browser", async () => {
    const opened: string[] = [];
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadOpener: async () => ({ openUrl: async (url) => { opened.push(String(url)); } }),
    });

    expect(await openDesktopVerificationUrl(
      "https://agentparty.leeguoo.com/pair?code=AB12C-DE34F",
      ["https://agentparty.leeguoo.com"],
    )).toBe(true);
    expect(await openDesktopVerificationUrl(
      "https://evil.example/pair?code=AB12C-DE34F",
      ["https://agentparty.leeguoo.com"],
    )).toBe(false);
    expect(opened).toEqual(["https://agentparty.leeguoo.com/pair?code=AB12C-DE34F"]);
  });

  test("filters cold-start and live deep links before delivering navigation hints", async () => {
    let liveHandler: ((urls: string[]) => void) | null = null;
    const links: string[] = [];
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadDeepLink: async () => ({
        getCurrent: async () => [
          "agentparty://pair/AB12C-DE34F?server=https%3A%2F%2Fagentparty.leeguoo.com",
          "agentparty://pair/AB12C-DE34F?token=must-not-pass",
        ],
        onOpenUrl: async (handler) => {
          liveHandler = handler;
          return () => {};
        },
      }),
    });

    const unlisten = await listenForDesktopPairLinks(
      ["https://agentparty.leeguoo.com"],
      (link) => links.push(`${link.userCode}:${link.serverOrigin}`),
    );
    liveHandler?.([
      "agentparty://pair/ZX90Y-WV87U",
      "agentparty://pair/ZX90Y-WV87U?server=https%3A%2F%2Fevil.example",
    ]);
    unlisten();

    expect(links).toEqual([
      "AB12C-DE34F:https://agentparty.leeguoo.com",
      "ZX90Y-WV87U:null",
    ]);
  });

  test("forwards native tray update checks and exposes cleanup", async () => {
    let handler: (() => void) | null = null;
    let cleaned = false;
    let checks = 0;
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadEvent: async () => ({
        listen: async (_event, nextHandler) => {
          handler = nextHandler;
          return () => { cleaned = true; };
        },
      }),
    });

    const unlisten = await listenForDesktopUpdateChecks(() => { checks += 1; });
    handler?.();
    expect(checks).toBe(1);
    unlisten();
    expect(cleaned).toBe(true);
  });

  test("clamps badge counts to non-negative integers and clears zero-like values", async () => {
    const counts: Array<number | undefined> = [];
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadWindow: async () => windowModule({
        getCurrentWindow: () => ({
          setBadgeCount: async (count) => {
            counts.push(count);
          },
          show: async () => {},
          unminimize: async () => {},
          setFocus: async () => {},
        }),
      }),
    });

    expect(await setDesktopBadge(5.9)).toBe(true);
    expect(await setDesktopBadge(0)).toBe(true);
    expect(await setDesktopBadge(-3)).toBe(true);
    expect(await setDesktopBadge(Number.NaN)).toBe(true);
    expect(counts).toEqual([5, undefined, undefined, undefined]);
  });

  test("shows, unminimizes, and focuses the current window in order", async () => {
    const calls: string[] = [];
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadWindow: async () => windowModule({
        getCurrentWindow: () => ({
          setBadgeCount: async () => {},
          show: async () => { calls.push("show"); },
          unminimize: async () => { calls.push("unminimize"); },
          setFocus: async () => { calls.push("focus"); },
        }),
      }),
    });

    expect(await showAndFocusDesktopWindow()).toBe(true);
    expect(calls).toEqual(["show", "unminimize", "focus"]);
  });
});

describe("desktop autostart", () => {
  test("queries the native autostart state", async () => {
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadAutostart: async () => autostartModule({ isEnabled: async () => true }),
    });

    expect(await isAutostartEnabled()).toBe(true);
  });

  test("enables and disables autostart", async () => {
    const calls: string[] = [];
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadAutostart: async () => autostartModule({
        enable: async () => { calls.push("enable"); },
        disable: async () => { calls.push("disable"); },
      }),
    });

    expect(await setAutostartEnabled(true)).toBe(true);
    expect(await setAutostartEnabled(false)).toBe(true);
    expect(calls).toEqual(["enable", "disable"]);
  });
});

describe("native plugin failures", () => {
  test("downgrades module loading and native call errors without throwing", async () => {
    __setDesktopRuntimeDependenciesForTests({
      isTauri: () => true,
      loadNotification: async () => { throw new Error("notification unavailable"); },
      loadAutostart: async () => autostartModule({
        isEnabled: async () => { throw new Error("autostart failed"); },
        enable: async () => { throw new Error("autostart failed"); },
      }),
      loadWindow: async () => windowModule({
        getCurrentWindow: () => ({
          setBadgeCount: async () => { throw new Error("badge failed"); },
          show: async () => { throw new Error("window failed"); },
          unminimize: async () => {},
          setFocus: async () => {},
        }),
      }),
    });

    expect(await isDesktopNotificationSupported()).toBe(false);
    expect(await isDesktopNotificationPermissionGranted()).toBe(false);
    expect(await requestDesktopNotificationPermission()).toBe("unsupported");
    expect(await sendMentionNotification({ title: "Mention", body: "hello", slug: "general", seq: 9 })).toBe(false);
    const stopNotificationActions = await listenForDesktopNotificationActions(() => {});
    stopNotificationActions();
    expect(await setDesktopBadge(2)).toBe(false);
    expect(await showAndFocusDesktopWindow()).toBe(false);
    expect(await isAutostartEnabled()).toBe(false);
    expect(await setAutostartEnabled(true)).toBe(false);
  });
});
