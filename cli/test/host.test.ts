// party host board（#151 扩展）：默认必须走 tail（最近窗口），并显式打印窗口范围与截断告警。
// 断言查询串本身与纯函数输出（过程），不只看命令返回码——见频道公告 rev347 契约①。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoardWindow, describeWindow, formatWindowLines, run } from "../src/commands/host";
import { TAIL_BEFORE } from "../src/rest";

let home: string;
let oldHome: string | undefined;
let restServer: ReturnType<typeof Bun.serve> | null = null;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-host-"));
  oldHome = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = home;
  mkdirSync(home, { recursive: true });
  stdout = [];
  stderr = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = oldHome;
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  restServer?.stop(true);
  restServer = null;
});

// host board 一次并发发三个请求（presence + 主查询 + limit=1 的头探针）。
// 全局变量拦截 fetch 在并发下会被互相覆盖，必须起一个真实的本地 server 按路径/查询串分别记录。
function startMockServer(messages: { seq: number }[]): { seen: string[] } {
  const seen: string[] = [];
  restServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/presence")) {
        return Response.json({ presence: [] });
      }
      if (url.pathname.endsWith("/messages")) {
        seen.push(url.search);
        // 头探针恒 limit=1，只回最新一条；其余按传入的 messages 原样返回
        const isHeadProbe = url.searchParams.get("limit") === "1";
        return Response.json({ messages: isHeadProbe ? messages.slice(-1) : messages });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
  );
  return { seen };
}

function isHeadProbeSearch(search: string): boolean {
  return new URLSearchParams(search).get("limit") === "1";
}

describe("party host board 默认取尾（#151 扩展）", () => {
  test("默认（无 --since）→ 主查询与头探针都带 before=TAIL_BEFORE，不带 since=", async () => {
    const { seen } = startMockServer([]);
    const code = await run(["board", "dev"]);
    expect(code).toBe(0);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const search of seen) {
      expect(search).toContain(`before=${TAIL_BEFORE}`);
      expect(search).not.toContain("since=");
    }
  });

  test("显式 --since 0 → 主查询带 since=0、不带 before=（头探针仍单独走 tail）", async () => {
    const { seen } = startMockServer([]);
    const code = await run(["board", "dev", "--since", "0"]);
    expect(code).toBe(0);
    const mainCalls = seen.filter((s) => !isHeadProbeSearch(s));
    expect(mainCalls.length).toBeGreaterThan(0);
    for (const search of mainCalls) {
      expect(search).toContain("since=0");
      expect(search).not.toContain("before=");
    }
    // 头探针必须仍然存在且走 tail，否则算不出真实 head
    const headCalls = seen.filter(isHeadProbeSearch);
    expect(headCalls.length).toBeGreaterThan(0);
    expect(headCalls[0]).toContain(`before=${TAIL_BEFORE}`);
  });
});

describe("party host board 打印窗口（#151 扩展）", () => {
  test("文本输出：last_seq 行之后紧接着打印 window 行", async () => {
    startMockServer([{ seq: 10 }, { seq: 20 }] as unknown as { seq: number }[]);
    const code = await run(["board", "dev"]);
    expect(code).toBe(0);
    const idx = stdout.findIndex((l) => l.startsWith("host board dev last_seq="));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(stdout[idx + 1]).toContain("window: seq");
    expect(stdout[idx + 1]).toContain("channel head =");
  });

  test("--json 输出：window 字段存在，含 head/truncated", async () => {
    startMockServer([{ seq: 10 }, { seq: 20 }] as unknown as { seq: number }[]);
    const code = await run(["board", "dev", "--json"]);
    expect(code).toBe(0);
    const frame = JSON.parse(stdout[0]!);
    expect(frame.window).toBeDefined();
    expect(typeof frame.window.head).toBe("number");
    expect(typeof frame.window.truncated).toBe("boolean");
    expect(typeof frame.window.missingBefore).toBe("boolean");
  });
});

describe("describeWindow 纯函数（#151 扩展）", () => {
  test("空 messages → from=0,to=0；truncated 取决于 head>0", () => {
    expect(describeWindow([], 0)).toMatchObject({ from: 0, to: 0, truncated: false, missingBefore: false });
    expect(describeWindow([], 5)).toMatchObject({ from: 0, to: 0, truncated: true, missingBefore: false });
  });

  test("to === head → truncated=false", () => {
    const w = describeWindow([{ seq: 10 }, { seq: 20 }], 20);
    expect(w.to).toBe(20);
    expect(w.truncated).toBe(false);
  });

  test("to < head → truncated=true", () => {
    const w = describeWindow([{ seq: 10 }, { seq: 20 }], 30);
    expect(w.truncated).toBe(true);
  });

  test("from > 1 → missingBefore=true；from === 1 → missingBefore=false", () => {
    expect(describeWindow([{ seq: 5 }, { seq: 20 }], 20).missingBefore).toBe(true);
    expect(describeWindow([{ seq: 1 }, { seq: 20 }], 20).missingBefore).toBe(false);
  });
});

describe("formatWindowLines 纯函数（#151 扩展）", () => {
  test("正常窗口（无告警）：只有 window 行，含 channel head =", () => {
    const w: BoardWindow = { from: 1, to: 20, head: 20, truncated: false, missingBefore: false };
    const lines = formatWindowLines(w);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("channel head =");
    expect(lines.join("\n")).not.toContain("NOT current");
  });

  test("truncated：含 warn 且真的出现 NOT current", () => {
    const w: BoardWindow = { from: 1, to: 20, head: 30, truncated: true, missingBefore: false };
    const lines = formatWindowLines(w);
    const text = lines.join("\n");
    expect(text).toContain("channel head =");
    expect(text).toContain("NOT current");
  });

  test("missingBefore：含 note，不含 NOT current", () => {
    const w: BoardWindow = { from: 50, to: 100, head: 100, truncated: false, missingBefore: true };
    const lines = formatWindowLines(w);
    const text = lines.join("\n");
    expect(text).toContain("channel head =");
    expect(text).toContain("claims opened before seq");
    expect(text).not.toContain("NOT current");
  });
});
