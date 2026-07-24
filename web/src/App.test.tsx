// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "./i18n/locale";
import { apiBase, clearApiBase } from "./lib/base";
import { applyShareToken, clearShareToken, currentShareToken, isShareMode } from "./lib/api";
import {
  __resetDesktopRuntimeForTests,
  __setDesktopRuntimeDependenciesForTests,
} from "./lib/desktopRuntime";
import {
  addCustomServerProfile,
  loadActiveServerOrigin,
  saveActiveServerOrigin,
} from "./lib/serverProfiles";

type InvokeHandler = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
let invokeHandler: InvokeHandler = async () => null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeHandler(command, args),
}));
mock.module("dompurify", () => ({
  default: {
    addHook: () => {},
    sanitize: (value: string) => value,
  },
}));

const { App } = await import("./App");

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const activeOrigin = "https://agentparty.leeguoo.com";
const unpairedOrigin = "https://agentparty.pwtk-dev.work";
let renderer: ReactTestRenderer | null = null;
let credentialDeletes = 0;
let storedCredential: string | null = null;
let notificationActionHandler: ((notification: { extra?: Record<string, unknown> }) => void) | null = null;
// 认证态桌面下，只有 App 级的 listenForDesktopChannelLinks 会注册 onOpenUrl（配对 listener 只在
// 配对闸里挂），所以这里抓到的就是频道 deep link 的投递回调，测试可拿它模拟外部 open 链接。
let channelLinkOpenHandler: ((urls: string[]) => void) | null = null;
let desktopFocusCalls: string[] = [];
let pushedPaths: string[] = [];
let desktopWindowShownHandler: (() => void) | null = null;

async function waitForCondition(condition: () => boolean, description: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { pathname: "/", search: "", origin: activeOrigin, href: `${activeOrigin}/` },
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: {
      pushState: (_state: unknown, _unused: string, url?: string | URL | null) => {
        pushedPaths.push(String(url ?? ""));
      },
      replaceState: () => {},
    },
  });

  const windowEvents = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {},
      location: globalThis.location,
      history: globalThis.history,
      innerWidth: 1200,
      innerHeight: 800,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
      focus: () => { desktopFocusCalls.push("browser-focus"); },
    },
  });
  const documentEvents = new EventTarget();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "visible",
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "test-desktop" },
  });

  addCustomServerProfile(localStorage, { label: "Private", origin: "https://private.example.com" });
  saveActiveServerOrigin(localStorage, activeOrigin);
  credentialDeletes = 0;
  notificationActionHandler = null;
  channelLinkOpenHandler = null;
  desktopFocusCalls = [];
  pushedPaths = [];
  desktopWindowShownHandler = null;
  storedCredential = JSON.stringify({
    refreshToken: "old-refresh",
    deviceSecret: "old-device-secret",
    serverOrigin: activeOrigin,
    sessionId: "old-session",
  });
  invokeHandler = async (command, args) => {
    if (command === "desktop_window_has_been_shown") return true;
    if (command === "desktop_credential_migrate") return null;
    if (command === "desktop_credential_read") {
      return args?.origin === activeOrigin ? storedCredential : null;
    }
    if (command === "desktop_credential_write") {
      storedCredential = String(args?.credential);
      return null;
    }
    if (command === "desktop_credential_delete") {
      credentialDeletes += 1;
      storedCredential = null;
      return null;
    }
    throw new Error(`unexpected native command: ${command}`);
  };

  __setDesktopRuntimeDependenciesForTests({
    isTauri: () => true,
    loadDeepLink: async () => ({
      getCurrent: async () => null,
      onOpenUrl: async (handler) => {
        channelLinkOpenHandler = handler;
        return () => {};
      },
    }),
    loadNotification: async () => ({
      isPermissionGranted: async () => true,
      requestPermission: async () => "granted",
      sendNotification: () => {},
      onAction: async (handler) => {
        notificationActionHandler = handler;
        return { unregister: async () => {} };
      },
    }),
    loadWindow: async () => ({
      getCurrentWindow: () => ({
        setBadgeCount: async () => {},
        show: async () => { desktopFocusCalls.push("show"); },
        unminimize: async () => { desktopFocusCalls.push("unminimize"); },
        setFocus: async () => { desktopFocusCalls.push("focus"); },
      }),
    }),
    loadEvent: async () => ({
      listen: async (event, handler) => {
        if (event === "agentparty://window-shown") desktopWindowShownHandler = handler;
        return () => {};
      },
    }),
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/desktop/sessions/refresh")) {
        return new Response(JSON.stringify({
          access_token: "old-access",
          refresh_token: "rotated-old-refresh",
          expires_in: 600,
          session_id: "old-session",
        }), { status: 200 });
      }
      if (url.endsWith("/api/config")) return new Response("{}", { status: 200 });
      if (url.endsWith("/api/channels")) return new Response('{"channels":[]}', { status: 200 });
      if (url.endsWith("/api/me")) {
        return new Response(JSON.stringify({
          name: "human-1",
          email: "human@example.com",
          kind: "human",
          handle: "human",
          display_name: "Human",
          avatar_url: null,
          avatar_thumb: null,
          provider: "oidc",
          tenant_key: null,
          role: "human",
          owner: null,
        }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });
});

test("desktop separates personal settings from the local-agent control center", async () => {
  const settingsFocus = mock(() => undefined);
  const onboardingFocus = mock(() => undefined);
  const bannerFocus = mock(() => undefined);
  const defaultFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/me")) {
        return new Response(JSON.stringify({
          name: "human-1",
          email: "human@example.com",
          kind: "human",
          handle: null,
          display_name: "Human",
          avatar_url: null,
          avatar_thumb: null,
          provider: "oidc",
          tenant_key: null,
          role: "human",
          owner: null,
        }), { status: 200 });
      }
      return defaultFetch(input, init);
    },
  });
  localStorage.setItem("ap_onboarded", "1");
  location.pathname = "/c/test-channel";
  location.href = `${activeOrigin}/c/test-channel`;
  await act(async () => {
    renderer = create(<LocaleProvider><App /></LocaleProvider>, {
      createNodeMock: (element) => {
        const props = element.props as { className?: string };
        if (element.type === "button" && props.className === "app-settings-btn") {
          return { focus: settingsFocus, isConnected: true };
        }
        if (element.type === "button" && props.className === "d-btn handle-banner-open") {
          return { focus: bannerFocus, isConnected: true };
        }
        if (element.type === "button" && props.className === "d-btn onboarding-close") {
          return { focus: onboardingFocus, isConnected: true, tabIndex: 0 };
        }
        return {};
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const root = renderer!.root;
  expect(root.findAllByProps({ className: "app-settings-btn" })).toHaveLength(1);
  expect(root.findAllByProps({ className: "app-agent-center-btn" })).toHaveLength(1);
  expect(root.findAllByProps({ className: "desktop-settings-trigger" })).toHaveLength(0);
  expect(root.findByProps({ className: "app-settings-btn" }).findByProps({
    className: "ap-sprite ap-sprite--settings",
  })).toBeTruthy();

  await act(async () => root.findByProps({ className: "app-settings-btn" }).props.onClick());

  expect(root.findByProps({ id: "desktop-settings-panel" })).toBeTruthy();
  expect(root.findAllByProps({ className: "desktop-agent" })).toHaveLength(0);
  expect(root.findAllByProps({ className: "local-agents" })).toHaveLength(0);
  expect(root.findByProps({ className: "d-btn notify-toggle-btn" }).props["aria-pressed"]).toBe(false);

  await act(async () => root.findByProps({ className: "settings-toggle" }).props.onClick());

  expect(root.findByProps({ className: "d-btn notify-toggle-btn is-active" }).props["aria-pressed"]).toBe(true);
  expect(root.findByProps({ className: "settings-toggle is-on" }).props["aria-pressed"]).toBe(true);

  await act(async () => root.findByProps({ className: "settings-close" }).props.onClick());
  expect(root.findAllByProps({ className: "settings-panel" })).toHaveLength(0);
  expect(settingsFocus).toHaveBeenCalledTimes(1);

  await act(async () => root.findByProps({ className: "app-agent-center-btn" }).props.onClick());

  expect(root.findByProps({ id: "local-agent-center-title" })).toBeTruthy();
  expect(root.findByProps({ className: "local-agents" })).toBeTruthy();
  expect(root.findAllByProps({ id: "desktop-settings-panel" })).toHaveLength(0);

  await act(async () => root.findByProps({ className: "settings-close" }).props.onClick());

  await act(async () => root.findByProps({ className: "app-settings-btn" }).props.onClick());

  const onboardingButton = root.findAll((node) =>
    typeof node.props.className === "string" && node.props.className.split(/\s+/).includes("settings-onboarding"),
  )[0];
  expect(onboardingButton).toBeTruthy();
  const focusBeforeHandoff = settingsFocus.mock.calls.length;
  await act(async () => onboardingButton!.props.onClick());

  expect(root.findAllByProps({ className: "settings-panel" })).toHaveLength(0);
  expect(root.findByProps({ className: "d-card onboarding-card" })).toBeTruthy();
  expect(root.findAllByProps({ role: "dialog" })).toHaveLength(1);
  expect(onboardingFocus).toHaveBeenCalledTimes(1);
  expect(settingsFocus).toHaveBeenCalledTimes(focusBeforeHandoff);

  await act(async () => root.findByProps({ className: "d-btn onboarding-close" }).props.onClick());

  expect(root.findAllByProps({ className: "d-card onboarding-card" })).toHaveLength(0);
  expect(settingsFocus).toHaveBeenCalledTimes(focusBeforeHandoff + 1);

  const bannerAction = root.findByProps({ className: "d-btn handle-banner-open" });
  await act(async () => bannerAction.props.onClick({}));
  const bannerOnboardingButton = root.findAll((node) =>
    typeof node.props.className === "string" && node.props.className.split(/\s+/).includes("settings-onboarding"),
  )[0]!;
  const settingsFocusBeforeBannerHandoff = settingsFocus.mock.calls.length;
  await act(async () => bannerOnboardingButton.props.onClick());
  await act(async () => root.findByProps({ className: "d-btn onboarding-close" }).props.onClick());

  expect(bannerFocus).toHaveBeenCalledTimes(1);
  expect(settingsFocus).toHaveBeenCalledTimes(settingsFocusBeforeBannerHandoff);
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  __resetDesktopRuntimeForTests();
  clearApiBase();
  clearShareToken();
  for (const key of [
    "IS_REACT_ACT_ENVIRONMENT",
    "__TAURI_INTERNALS__",
    "localStorage",
    "sessionStorage",
    "location",
    "history",
    "window",
    "document",
    "navigator",
    "fetch",
  ]) Reflect.deleteProperty(globalThis, key);
});

describe("App desktop server pairing behavior", () => {
  test("a restored human session clears a stale desktop watch credential", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchBeforeRestore = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        requests.push({ url: String(input), authorization: headers.get("authorization") });
        return fetchBeforeRestore(input, init);
      },
    });
    applyShareToken("stale-watch-token");
    expect(isShareMode()).toBe(true);

    act(() => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
    });
    await waitForCondition(
      () => !isShareMode() && (renderer?.root.findAllByProps({ className: "app-settings-btn" }).length ?? 0) === 1,
      "the restored human desktop session",
    );

    expect(isShareMode()).toBe(false);
    expect(currentShareToken()).toBeNull();
    expect(requests).toContainEqual({
      url: `${activeOrigin}/api/channels`,
      authorization: "Bearer old-access",
    });
    expect(requests.some((request) => request.url.includes("stale-watch-token"))).toBe(false);
    expect(renderer!.root.findByProps({ className: "app-settings-btn" })).toBeTruthy();
  });

  test("a missing restored human credential preserves an active watch session", async () => {
    storedCredential = null;
    let credentialReads = 0;
    const invokeBeforeMissingCredential = invokeHandler;
    invokeHandler = async (command, args) => {
      if (command === "desktop_credential_read") credentialReads += 1;
      return invokeBeforeMissingCredential(command, args);
    };
    applyShareToken("stale-watch-token");

    act(() => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
    });
    await waitForCondition(
      () => credentialReads === 1,
      "the desktop restore without a credential",
    );

    expect(isShareMode()).toBe(true);
    expect(currentShareToken()).toBe("stale-watch-token");
    expect(renderer!.root.findAllByProps({ className: "app-settings-btn" })).toHaveLength(0);
  });

  test("hidden desktop startup defers Keychain restore until the main window is shown", async () => {
    let credentialReads = 0;
    invokeHandler = async (command, args) => {
      if (command === "desktop_window_has_been_shown") return false;
      if (command === "desktop_credential_migrate") return null;
      if (command === "desktop_credential_read") {
        credentialReads += 1;
        return args?.origin === activeOrigin ? storedCredential : null;
      }
      if (command === "desktop_credential_write") {
        storedCredential = String(args?.credential);
        return null;
      }
      throw new Error(`unexpected native command: ${command}`);
    };

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(credentialReads).toBe(0);
    expect(desktopWindowShownHandler).not.toBeNull();

    await act(async () => {
      desktopWindowShownHandler?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(credentialReads).toBe(1);
  });

  test("a stale legacy Keychain slot does not block the current server session", async () => {
    let credentialReads = 0;
    invokeHandler = async (command, args) => {
      if (command === "desktop_window_has_been_shown") return true;
      if (command === "desktop_credential_migrate") {
        throw new Error("desktop_keychain_authorization_required");
      }
      if (command === "desktop_credential_read") {
        credentialReads += 1;
        return args?.origin === activeOrigin ? storedCredential : null;
      }
      if (command === "desktop_credential_write") {
        storedCredential = String(args?.credential);
        return null;
      }
      throw new Error(`unexpected native command: ${command}`);
    };

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(credentialReads).toBe(1);
    expect(renderer!.root.findByProps({ className: "app-settings-btn" })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  test("opens a clicked desktop mention notification at the target message", async () => {
    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(notificationActionHandler).not.toBeNull();
    await act(async () => {
      notificationActionHandler?.({ extra: { slug: "general", seq: 42 } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(desktopFocusCalls).toEqual(["show", "unminimize", "focus"]);
    expect(pushedPaths).toContain("/c/general");
    expect(location.hash).toBe("#msg-42");
  });

  test("channel deep link focuses the window and opens the channel on the current server", async () => {
    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(channelLinkOpenHandler).not.toBeNull();
    await act(async () => {
      // 无 server：直接在当前实例按 slug 跳。
      channelLinkOpenHandler?.(["agentparty://channel/general"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(desktopFocusCalls).toEqual(["show", "unminimize", "focus"]);
    expect(pushedPaths).toContain("/c/general");

    await act(async () => {
      // server 指向未配对实例（不在 profiles 里）：忽略 server，仍在当前实例跳，绝不切服。
      channelLinkOpenHandler?.([`agentparty://channel/off-server?server=${encodeURIComponent(unpairedOrigin)}`]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(pushedPaths).toContain("/c/off-server");
    expect(loadActiveServerOrigin(localStorage)).toBe(activeOrigin);
  });

  test("channel deep link with a paired other server switches instances then lands on the channel", async () => {
    const privateOrigin = "https://private.example.com";
    const replacements: string[] = [];
    history.replaceState = (_state: unknown, _unused: string, url?: string | URL | null) => {
      const next = String(url ?? "");
      replacements.push(next);
      location.pathname = next.split(/[?#]/)[0] || "/";
    };

    const credentials = new Map([
      [activeOrigin, storedCredential!],
      [privateOrigin, JSON.stringify({
        refreshToken: "private-refresh",
        deviceSecret: "private-device-secret",
        serverOrigin: privateOrigin,
        sessionId: "private-session",
      })],
    ]);
    invokeHandler = async (command, args) => {
      const origin = String(args?.origin ?? "");
      if (command === "desktop_window_has_been_shown") return true;
      if (command === "desktop_credential_migrate") return null;
      if (command === "desktop_credential_read") return credentials.get(origin) ?? null;
      if (command === "desktop_credential_write") {
        credentials.set(origin, String(args?.credential));
        return null;
      }
      if (command === "desktop_credential_delete") {
        credentials.delete(origin);
        return null;
      }
      throw new Error(`unexpected native command: ${command}`);
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/desktop/sessions/refresh")) {
          const isPrivate = url.startsWith(privateOrigin);
          return new Response(JSON.stringify({
            access_token: isPrivate ? "private-access" : "old-access",
            refresh_token: isPrivate ? "rotated-private-refresh" : "rotated-old-refresh",
            expires_in: 600,
            session_id: isPrivate ? "private-session" : "old-session",
          }), { status: 200 });
        }
        if (url.endsWith("/api/config")) return new Response("{}", { status: 200 });
        if (url.endsWith("/api/channels")) return new Response('{"channels":[]}', { status: 200 });
        if (url.endsWith("/api/me")) return new Response(JSON.stringify({
          name: "human", email: null, kind: "human", handle: null, display_name: "Human",
          avatar_url: null, avatar_thumb: null, provider: "oidc", tenant_key: null, role: "human", owner: null,
        }), { status: 200 });
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      channelLinkOpenHandler?.([`agentparty://channel/team?server=${encodeURIComponent(privateOrigin)}`]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(loadActiveServerOrigin(localStorage)).toBe(privateOrigin);
    // 切服与落频道同帧完成：replace 直接到 /c/team，不经中转的 Home（"/"）。
    expect(replacements).toContain("/c/team");
    expect(replacements).not.toContain("/");
  });

  test("successful server switch leaves a channel route from the previous server", async () => {
    const privateOrigin = "https://private.example.com";
    const replacements: string[] = [];
    location.pathname = "/c/old-server-only";
    location.href = `${activeOrigin}/c/old-server-only`;
    history.replaceState = (_state: unknown, _unused: string, url?: string | URL | null) => {
      const next = String(url ?? "");
      replacements.push(next);
      location.pathname = next.split(/[?#]/)[0] || "/";
    };

    const credentials = new Map([
      [activeOrigin, storedCredential!],
      [privateOrigin, JSON.stringify({
        refreshToken: "private-refresh",
        deviceSecret: "private-device-secret",
        serverOrigin: privateOrigin,
        sessionId: "private-session",
      })],
    ]);
    invokeHandler = async (command, args) => {
      const origin = String(args?.origin ?? "");
      if (command === "desktop_credential_migrate") return null;
      if (command === "desktop_credential_read") return credentials.get(origin) ?? null;
      if (command === "desktop_credential_write") {
        credentials.set(origin, String(args?.credential));
        return null;
      }
      if (command === "desktop_credential_delete") {
        credentials.delete(origin);
        return null;
      }
      throw new Error(`unexpected native command: ${command}`);
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/desktop/sessions/refresh")) {
          const isPrivate = url.startsWith(privateOrigin);
          return new Response(JSON.stringify({
            access_token: isPrivate ? "private-access" : "old-access",
            refresh_token: isPrivate ? "rotated-private-refresh" : "rotated-old-refresh",
            expires_in: 600,
            session_id: isPrivate ? "private-session" : "old-session",
          }), { status: 200 });
        }
        if (url.endsWith("/api/config")) return new Response("{}", { status: 200 });
        if (url.endsWith("/api/channels")) return new Response('{"channels":[]}', { status: 200 });
        if (url.endsWith("/api/me")) return new Response(JSON.stringify({
          name: "human-private",
          email: null,
          kind: "human",
          handle: null,
          display_name: "Private Human",
          avatar_url: null,
          avatar_thumb: null,
          provider: "oidc",
          tenant_key: null,
          role: "human",
          owner: null,
        }), { status: 200 });
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      renderer!.root.findByProps({ id: "active-server" }).props.onChange({ target: { value: privateOrigin } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(replacements).toContain("/");
    expect(renderer!.root.findByProps({ id: "active-server" }).props.value).toBe(privateOrigin);
    expect(loadActiveServerOrigin(localStorage)).toBe(privateOrigin);
  });

  test("startup restore failure still allows switching to another paired server", async () => {
    const privateOrigin = "https://private.example.com";
    const credentials = new Map([
      [activeOrigin, JSON.stringify({
        refreshToken: "offline-refresh",
        deviceSecret: "offline-device-secret",
        serverOrigin: activeOrigin,
        sessionId: "offline-session",
      })],
      [privateOrigin, JSON.stringify({
        refreshToken: "private-refresh",
        deviceSecret: "private-device-secret",
        serverOrigin: privateOrigin,
        sessionId: "private-session",
      })],
    ]);
    invokeHandler = async (command, args) => {
      const origin = String(args?.origin ?? "");
      if (command === "desktop_credential_migrate") return null;
      if (command === "desktop_credential_read") return credentials.get(origin) ?? null;
      if (command === "desktop_credential_write") {
        credentials.set(origin, String(args?.credential));
        return null;
      }
      if (command === "desktop_credential_delete") {
        credentials.delete(origin);
        credentialDeletes += 1;
        return null;
      }
      throw new Error(`unexpected native command: ${command}`);
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request) => {
        const url = String(input);
        if (url === `${activeOrigin}/api/desktop/sessions/refresh`) {
          return new Response("offline", { status: 503 });
        }
        if (url === `${privateOrigin}/api/desktop/sessions/refresh`) {
          return new Response(JSON.stringify({
            access_token: "private-access",
            refresh_token: "rotated-private-refresh",
            expires_in: 600,
            session_id: "private-session",
          }), { status: 200 });
        }
        if (url.endsWith("/api/config")) return new Response("{}", { status: 200 });
        if (url.endsWith("/api/channels")) return new Response('{"channels":[]}', { status: 200 });
        if (url.endsWith("/api/me")) return new Response(JSON.stringify({
          name: "human-private",
          email: null,
          kind: "human",
          handle: null,
          display_name: "Private Human",
          avatar_url: null,
          avatar_thumb: null,
          provider: "oidc",
          tenant_key: null,
          role: "human",
          owner: null,
        }), { status: 200 });
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const root = renderer!.root;
    expect(root.findByProps({ role: "alert" }).children).toContain("The secure desktop session could not be refreshed.");
    expect(root.findByProps({ className: "d-btn d-btn--primary" }).children).toContain("Retry");
    expect(root.findByProps({ className: "desktop-recovery-updater" })).toBeTruthy();
    expect(root.findAll((node) =>
      typeof node.props.className === "string" && node.props.className.split(/\s+/).includes("desktop-updater-trigger"),
    )).toHaveLength(1);
    await act(async () => {
      root.findByProps({ id: "active-server" }).props.onChange({ target: { value: privateOrigin } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(root.findByProps({ className: "app-settings-btn" })).toBeTruthy();
    expect(loadActiveServerOrigin(localStorage)).toBe(privateOrigin);
    expect(apiBase()).toBe(privateOrigin);
    expect(credentialDeletes).toBe(0);
    expect(credentials.has(activeOrigin)).toBe(true);
  });

  test("offers interactive Keychain authorization only for the native authorization sentinel", async () => {
    const commands: string[] = [];
    invokeHandler = async (command, args) => {
      commands.push(command);
      if (command === "desktop_credential_migrate") return null;
      if (command === "desktop_credential_read") throw new Error("desktop_keychain_authorization_required");
      if (command === "desktop_credential_authorize") return storedCredential;
      if (command === "desktop_credential_write_interactive") {
        storedCredential = String(args?.credential);
        return null;
      }
      throw new Error(`unexpected native command: ${command}`);
    };

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const root = renderer!.root;
    const recovery = root.findByProps({ className: "d-btn d-btn--primary" });
    expect(recovery.children).toContain("Authorize and retry");

    await act(async () => {
      recovery.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(commands).toContain("desktop_credential_authorize");
    expect(commands).toContain("desktop_credential_write_interactive");
    expect(root.findByProps({ className: "app-settings-btn" })).toBeTruthy();
  });

  test("logged-in add/pair cancellation preserves the old token, origin, runtime base, and credential", async () => {
    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const root = renderer!.root;
    const addPair = root.findByProps({ className: "server-switcher-add" });
    await act(async () => addPair.props.onClick());

    const targetSelect = root.findByProps({ id: "desktop-pairing-server" });
    await act(async () => targetSelect.props.onChange({ target: { value: unpairedOrigin } }));
    expect(root.findByProps({ id: "desktop-pairing-title" })).toBeTruthy();

    const back = root.findAllByType("button").find((button) => button.children.includes("Back to current server"));
    expect(back).toBeTruthy();
    await act(async () => back!.props.onClick());

    expect(root.findByProps({ className: "app-settings-btn" })).toBeTruthy();
    expect(root.findByProps({ id: "active-server" }).props.value).toBe(activeOrigin);
    expect(loadActiveServerOrigin(localStorage)).toBe(activeOrigin);
    expect(apiBase()).toBe(activeOrigin);
    expect(credentialDeletes).toBe(0);
    expect(JSON.parse(storedCredential ?? "null")).toEqual({
      refreshToken: "rotated-old-refresh",
      deviceSecret: "old-device-secret",
      serverOrigin: activeOrigin,
      sessionId: "old-session",
    });
  });

  test("an unpaired normal-header target offers pairing and keeps the old session after cancellation", async () => {
    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const root = renderer!.root;
    await act(async () => {
      root.findByProps({ id: "active-server" }).props.onChange({ target: { value: unpairedOrigin } });
    });

    const pairButton = root.findAllByType("button")
      .find((button) => button.children.includes("Pair this server"));
    expect(pairButton).toBeTruthy();
    await act(async () => pairButton!.props.onClick());
    expect(root.findByProps({ id: "desktop-pairing-title" })).toBeTruthy();

    const back = root.findAllByType("button").find((button) => button.children.includes("Back to current server"));
    await act(async () => back!.props.onClick());

    expect(root.findByProps({ className: "app-settings-btn" })).toBeTruthy();
    expect(root.findByProps({ id: "active-server" }).props.value).toBe(activeOrigin);
    expect(loadActiveServerOrigin(localStorage)).toBe(activeOrigin);
    expect(apiBase()).toBe(activeOrigin);
    expect(credentialDeletes).toBe(0);
  });
});
