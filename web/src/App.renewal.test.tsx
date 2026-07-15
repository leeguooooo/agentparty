// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "./i18n/locale";

// #123：静默续期（同身份换 token）不应清空 channels——清空会连带卸载 ChannelPage，
// 丢草稿和滚动位置。本文件钉住「同身份不清空」这条新行为，以及一直存在、但此前
// 零测试保护的 late-response `alive` 守卫（防止旧身份的陈旧响应覆盖新身份的 UI）。
// 范式照抄已在 main 上的 App.identity.test.tsx（react-test-renderer + mock.module + memoryStorage）。

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

function jwt(sub: string, generation = 1): string {
  const encode = (value: string) => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode('{"alg":"none"}')}.${encode(JSON.stringify({ sub, generation }))}.sig`;
}

function session(accessToken: string, refreshToken: string, expiresAt: number) {
  return {
    accessToken,
    refreshToken,
    expiresAt,
    identity: JSON.parse(atob(accessToken.split(".")[1]!)) as { sub: string },
  };
}

function storedSession(
  accessToken: string,
  refreshToken: string,
  expiresAt = Math.floor(Date.now() / 1000) - 60,
) {
  const value = session(accessToken, refreshToken, expiresAt);
  return JSON.stringify({ ...value, identity: value.identity.sub });
}

function authHeader(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
}

function meResponse() {
  return new Response(JSON.stringify({
    name: "human-a",
    email: "a@example.com",
    kind: "human",
    handle: "human-a",
    display_name: "Human A",
    avatar_url: null,
    avatar_thumb: null,
    provider: "oidc",
    tenant_key: null,
    role: "human",
    owner: null,
  }), { status: 200 });
}

function channelsPayload(slug: string, title: string): string {
  return JSON.stringify({
    channels: [{
      slug,
      title,
      topic: null,
      kind: "standing",
      mode: "normal",
      visibility: "private",
      created_at: 0,
      archived_at: null,
      last_message: null,
      presence: [],
    }],
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 让一个真实宏任务 tick 过去，供 fetch / 定时器链路往前推进一步。 */
async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 轮询等到条件成立——比固定 tick 数更稳：React 的被动 effect（useEffect）经调度器异步落地，
 * 不保证在固定几个 setTimeout(0) 内完成，用条件轮询避免这条链路的时序假设写死在测试里。
 */
async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  // 每个 tick 单独包一层 act()：如果整个轮询都窝在外层同一个 act() 回调里，
  // react-test-renderer 的被动 effect（useEffect）要等这个 act() 整体 resolve
  // 才会真正 flush——会跟"轮询直到某个由 effect 触发的条件成立"互相死等。
  // 单独开合 act() 才能让每一轮 tick 之间的 effect 有机会落地。
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await act(async () => { await tick(1); });
  }
  if (!predicate()) throw new Error(`waitFor: condition still false after ${maxTicks} ticks`);
}

/** 给「什么都不该发生」这类反向断言留出机会窗口——每个 tick 各自开合 act()，理由同 waitFor。 */
async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => { await tick(1); });
  }
}

function classTokens(className: unknown): string[] {
  return typeof className === "string" ? className.split(/\s+/).filter(Boolean) : [];
}

/** 语义断言用：只看渲染树里是否存在某个 className 标记的节点，不看内部实现变量。 */
function hasClassName(renderer: ReactTestRenderer, className: string): boolean {
  return renderer.root.findAll((node) => classTokens(node.props.className).includes(className)).length > 0;
}

/**
 * 侧栏当前渲染的「真实频道」标题列表——特意排除建频道的"+"入口贴片（CreateChannel 组件也复用了
 * chan-pill / chan-name 这两个 class，但它是常驻的、跟 channels 是否加载无关，用 newchan-open
 * 这个只有它才有的 class 排掉，避免语义断言被这枚无关元素污染）。
 */
function channelPillTitles(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => {
      const tokens = classTokens(node.props.className);
      return tokens.includes("chan-pill") && !tokens.includes("newchan-open");
    })
    .map((node) => {
      const nameNode = node.findAll((n) => classTokens(n.props.className).includes("chan-name"))[0];
      return (nameNode?.children.filter((c): c is string => typeof c === "string").join("")) ?? "";
    });
}

let renderer: ReactTestRenderer | null = null;
const globalKeys = [
  "IS_REACT_ACT_ENVIRONMENT",
  "localStorage",
  "sessionStorage",
  "location",
  "history",
  "window",
  "document",
  "navigator",
  "fetch",
] as const;
const originalGlobals = new Map(
  globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { pathname: "/", search: "", origin: "https://party.example", href: "https://party.example/" },
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { pushState: () => {}, replaceState: () => {} },
  });
  const windowEvents = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: globalThis.location,
      history: globalThis.history,
      innerWidth: 1200,
      innerHeight: 800,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      requestAnimationFrame: (callback: FrameRequestCallback) => (
        setTimeout(() => callback(performance.now()), 0)
      ),
      cancelAnimationFrame: clearTimeout,
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
      dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
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
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "test" } });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  for (const key of globalKeys) {
    const descriptor = originalGlobals.get(key);
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

describe("App silent renewal keeps channels (#123)", () => {
  test("same-identity silent renewal does not clear channels while the new list is in flight", async () => {
    const tokenA = jwt("user-a");
    const refreshedA = jwt("user-a", 2);
    localStorage.setItem("ap_token", tokenA);
    // 已过期（expiresAt 默认 now-60）：触发「到期前 60s 主动续期」定时器，delayMs=0 立即续期——
    // 这正是 spec 说的「直接等 token 变化」，不需要人为造 401。
    localStorage.setItem("ap_oidc_session", storedSession(tokenA, "refresh-a"));

    const channelTokens: Array<string | null> = [];
    let refreshCalls = 0;
    const secondChannels = deferredResponse();

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/config")) {
          return new Response(JSON.stringify({ oidc: { issuer: "https://idp.example", client_id: "web" } }));
        }
        if (url.endsWith("/api/channels")) {
          channelTokens.push(authHeader(init));
          if (channelTokens.length === 1) return new Response(channelsPayload("general", "general room"));
          return secondChannels.promise;
        }
        if (url.endsWith("/api/me")) return meResponse();
        if (url === "https://idp.example/token") {
          refreshCalls += 1;
          return new Response(JSON.stringify({
            access_token: refreshedA,
            refresh_token: "refresh-a-rotated",
            expires_in: 600,
          }));
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
    });
    // 等到第二次 listChannels（新 token）真正发起——它会一直挂在 secondChannels 上，
    // 是观测「续期期间 channels 有没有被清空」的窗口。
    await waitFor(() => channelTokens.length >= 2);

    // 续期确实发生了、且 listChannels 至少被调用两次（旧 token 一次、新 token 一次）
    expect(refreshCalls).toBe(1);
    expect(channelTokens[0]).toBe(tokenA);
    expect(channelTokens[channelTokens.length - 1]).toBe(refreshedA);

    // 关键观测窗口：第二次 listChannels 请求还没 resolve（deferred），但 UI 不能回到「清空后」的
    // 状态——语义断言，只看渲染树的结构标记（chan-cat-switch / chan-pill 只在 channels!==null 时渲染），
    // 不看 alive 这个实现变量。
    expect(hasClassName(renderer!, "chan-cat-switch")).toBe(true);
    expect(channelPillTitles(renderer!)).toEqual(["general room"]);

    await act(async () => {
      secondChannels.resolve(new Response(channelsPayload("general", "general room v2")));
    });
    await waitFor(() => channelPillTitles(renderer!)[0] === "general room v2");

    expect(hasClassName(renderer!, "chan-cat-switch")).toBe(true);
    expect(channelPillTitles(renderer!)).toEqual(["general room v2"]);
  });

  test("a stale response from before an identity switch never overwrites the new identity's channels", async () => {
    const tokenA = jwt("user-a");
    const tokenB = jwt("user-b");
    localStorage.setItem("ap_token", tokenA);
    // 不落 ap_oidc_session：纯「粘贴 token」会话，没有静默续期路径搅局，专测 alive 竞态本身。

    const channelTokens: Array<string | null> = [];
    const firstChannels = deferredResponse();

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/config")) {
          return new Response(JSON.stringify({ oidc: null }));
        }
        if (url.endsWith("/api/channels")) {
          const tok = authHeader(init);
          channelTokens.push(tok);
          if (tok === tokenA) return firstChannels.promise;
          return new Response(channelsPayload("b-room", "B's room"));
        }
        if (url.endsWith("/api/me")) return meResponse();
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
    });
    await waitFor(() => channelTokens.length >= 1);

    // 身份 A 的 listChannels 请求已发出、还没 resolve（deferred）
    expect(channelTokens).toEqual([tokenA]);

    // 结束身份 A 的组件生命周期，再以身份 B 挂载。A 的 effect cleanup 必须让旧请求失效；
    // 这里直接测试生命周期边界，避免把设置弹层的异步渲染混进 stale-response 回归。
    await act(async () => {
      renderer!.unmount();
      renderer = null;
    });
    localStorage.setItem("ap_token", tokenB);
    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
    });
    await waitFor(() => channelTokens.length >= 2);

    expect(channelTokens).toEqual([tokenA, tokenB]);
    await waitFor(() => channelPillTitles(renderer!)[0] === "B's room");
    expect(channelPillTitles(renderer!)).toEqual(["B's room"]);

    // 身份 A 那个迟迟没 resolve 的旧请求，这时才姗姗来迟——绝不能覆盖身份 B 的频道列表。
    await act(async () => {
      firstChannels.resolve(new Response(channelsPayload("a-room", "A's room")));
    });
    await settle();

    expect(channelPillTitles(renderer!)).toEqual(["B's room"]);
  });

  test("direct channel load errors expose retry in the main area and sidebar", async () => {
    const token = jwt("user-a");
    localStorage.setItem("ap_token", token);
    location.pathname = "/c/general";
    location.href = "https://party.example/c/general";
    let channelCalls = 0;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/config")) return new Response(JSON.stringify({ oidc: null }));
        if (url.endsWith("/api/channels")) {
          channelCalls += 1;
          if (channelCalls === 1) return new Response("offline", { status: 503 });
          return new Response(channelsPayload("general", "general room"));
        }
        if (url.endsWith("/api/me")) return meResponse();
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => { renderer = create(<LocaleProvider><App /></LocaleProvider>); });
    await waitFor(() => renderer!.root.findAll((node) => classTokens(node.props.className).includes("channels-retry")).length === 2);

    const retries = renderer!.root.findAll((node) => classTokens(node.props.className).includes("channels-retry"));
    expect(retries.map((button) => button.children.join(""))).toEqual(["Retry", "Retry"]);
    await act(async () => { retries[0]!.props.onClick(); });
    await waitFor(() => channelPillTitles(renderer!)[0] === "general room");

    expect(channelCalls).toBe(2);
    expect(renderer!.root.findAll((node) => classTokens(node.props.className).includes("channels-retry"))).toHaveLength(0);
  });

  test("focus refreshes reuse the in-flight channel request", async () => {
    const token = jwt("user-a");
    localStorage.setItem("ap_token", token);
    const pendingChannels = deferredResponse();
    let channelCalls = 0;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/config")) return new Response(JSON.stringify({ oidc: null }));
        if (url.endsWith("/api/channels")) {
          channelCalls += 1;
          return pendingChannels.promise;
        }
        if (url.endsWith("/api/me")) return meResponse();
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => { renderer = create(<LocaleProvider><App /></LocaleProvider>); });
    await waitFor(() => channelCalls === 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(channelCalls).toBe(1);
    await act(async () => {
      pendingChannels.resolve(new Response(channelsPayload("general", "general room")));
    });
    await waitFor(() => channelPillTitles(renderer!)[0] === "general room");
  });
});
