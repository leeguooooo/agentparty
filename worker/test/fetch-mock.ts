// vitest-pool-workers 0.18（vitest 4）移除了 `import { fetchMock } from "cloudflare:test"`，
// 官方迁移口径是改 mock `globalThis.fetch`（singleWorker 下 DO 与测试同 isolate，出站 fetch
// 走同一个 global）。这里按旧 undici MockAgent 的用法面做一层等价 shim，spec 只需换 import：
// activate / deactivate / disableNetConnect / get(origin).intercept({path,method})
//   .reply(status, body|fn) [.persist()] [.times(n)] / assertNoPendingInterceptors。
// 语义对齐 undici：拦截器默认消费 1 次、顺序消费（同 key 多个拦截器按注册序用完再用下一个）、
// persist 不计入 pending；path 匹配 pathname+search 全串。

type ReplyBody = string | Record<string, unknown> | unknown[];
type ReplyFn = (opts: {
  origin: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}) => ReplyBody;

interface Interceptor {
  origin: string;
  path: string;
  method: string;
  status: number;
  body: ReplyBody | ReplyFn;
  times: number;
  invoked: number;
  persisted: boolean;
  delayMs: number;
}

class MockInterceptor {
  constructor(private readonly entry: Interceptor) {}
  reply(status: number, body: ReplyBody | ReplyFn): this {
    this.entry.status = status;
    this.entry.body = body;
    return this;
  }
  persist(): this {
    this.entry.persisted = true;
    return this;
  }
  times(n: number): this {
    this.entry.times = n;
    return this;
  }
  delay(ms: number): this {
    this.entry.delayMs = ms;
    return this;
  }
}

class MockClient {
  constructor(
    private readonly origin: string,
    private readonly interceptors: Interceptor[],
  ) {}
  intercept(options: { path: string; method: string }): MockInterceptor {
    const entry: Interceptor = {
      origin: this.origin,
      path: options.path,
      method: options.method.toUpperCase(),
      status: 200,
      body: "",
      times: 1,
      invoked: 0,
      persisted: false,
      delayMs: 0,
    };
    this.interceptors.push(entry);
    return new MockInterceptor(entry);
  }
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "").toLowerCase();
}

class FetchMock {
  private interceptors: Interceptor[] = [];
  private realFetch: typeof globalThis.fetch | null = null;
  private netConnectDisabled = false;

  activate(): void {
    if (this.realFetch !== null) return;
    this.interceptors = [];
    this.realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const origin = normalizeOrigin(url.origin);
      const path = url.pathname + url.search;
      const method = request.method.toUpperCase();
      const match =
        this.interceptors.find(
          (it) =>
            it.origin === origin && it.path === path && it.method === method &&
            (it.persisted || it.invoked < it.times),
        ) ?? null;
      if (match === null) {
        if (this.netConnectDisabled) {
          throw new Error(`fetch-mock: no interceptor for ${method} ${origin}${path} (net connect disabled)`);
        }
        return this.realFetch!(input as RequestInfo, init);
      }
      match.invoked += 1;
      if (match.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, match.delayMs));
      }
      let body = match.body;
      if (typeof body === "function") {
        const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          headers[key] = value;
        });
        body = body({ origin, path, method, headers, body: await request.text() });
      }
      if (typeof body === "string") {
        return new Response(body, { status: match.status });
      }
      return new Response(JSON.stringify(body), {
        status: match.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  }

  deactivate(): void {
    if (this.realFetch !== null) {
      globalThis.fetch = this.realFetch;
      this.realFetch = null;
    }
    this.interceptors = [];
    this.netConnectDisabled = false;
  }

  disableNetConnect(): void {
    this.netConnectDisabled = true;
  }

  get(origin: string): MockClient {
    return new MockClient(normalizeOrigin(origin), this.interceptors);
  }

  assertNoPendingInterceptors(): void {
    const pending = this.interceptors.filter((it) => !it.persisted && it.invoked < it.times);
    if (pending.length > 0) {
      const list = pending
        .map((it) => `${it.method} ${it.origin}${it.path} (${it.invoked}/${it.times})`)
        .join(", ");
      throw new Error(`fetch-mock: pending interceptors: ${list}`);
    }
    // 与 undici 对齐：断言通过后清掉已消费的一次性拦截器，避免跨用例累积。
    this.interceptors = this.interceptors.filter((it) => it.persisted);
  }
}

export const fetchMock = new FetchMock();
