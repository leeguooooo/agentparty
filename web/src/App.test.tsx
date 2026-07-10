// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "./i18n/locale";
import { apiBase, clearApiBase } from "./lib/base";
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
let desktopFocusCalls: string[] = [];
let pushedPaths: string[] = [];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
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
  desktopFocusCalls = [];
  pushedPaths = [];
  storedCredential = JSON.stringify({
    refreshToken: "old-refresh",
    deviceSecret: "old-device-secret",
    serverOrigin: activeOrigin,
    sessionId: "old-session",
  });
  invokeHandler = async (command, args) => {
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
      onOpenUrl: async () => () => {},
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

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  __resetDesktopRuntimeForTests();
  clearApiBase();
  for (const key of [
    "IS_REACT_ACT_ENVIRONMENT",
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
    await act(async () => {
      root.findByProps({ id: "active-server" }).props.onChange({ target: { value: privateOrigin } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(root.findByProps({ className: "app-signout t-mono" })).toBeTruthy();
    expect(loadActiveServerOrigin(localStorage)).toBe(privateOrigin);
    expect(apiBase()).toBe(privateOrigin);
    expect(credentialDeletes).toBe(0);
    expect(credentials.has(activeOrigin)).toBe(true);
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

    expect(root.findByProps({ className: "app-signout t-mono" })).toBeTruthy();
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

    expect(root.findByProps({ className: "app-signout t-mono" })).toBeTruthy();
    expect(root.findByProps({ id: "active-server" }).props.value).toBe(activeOrigin);
    expect(loadActiveServerOrigin(localStorage)).toBe(activeOrigin);
    expect(apiBase()).toBe(activeOrigin);
    expect(credentialDeletes).toBe(0);
  });
});
