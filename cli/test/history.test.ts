// party history / party_history（#151）：默认必须是"最近 N 条"，不是频道最开头 N 条。
// 断言查询串本身（过程），不只看返回结果——见频道公告 rev 6 契约①。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { run } from "../src/commands/history";
import { writeAccount } from "../src/account";
import { writeState } from "../src/config";
import { messagesQuery, TAIL_BEFORE } from "../src/rest";

let home: string;
let oldHome: string | undefined;
let restServer: ReturnType<typeof Bun.serve> | null = null;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-history-"));
  oldHome = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ server: "https://ap.test", token: "ap_tok" }));
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

describe("messagesQuery 纯函数（#151）", () => {
  test("默认 tail：before=TAIL_BEFORE，不发 since", () => {
    const q = messagesQuery({ limit: 100, before: TAIL_BEFORE });
    expect(q).toContain(`before=${TAIL_BEFORE}`);
    expect(q).not.toContain("since=");
  });

  test("显式 since=0：从头读，不发 before", () => {
    const q = messagesQuery({ since: 0, limit: 100 });
    expect(q).toContain("since=0");
    expect(q).not.toContain("before=");
  });

  test("since=5", () => {
    expect(messagesQuery({ since: 5, limit: 100 })).toContain("since=5");
  });

  test("before=50：不发 since", () => {
    const q = messagesQuery({ before: 50, limit: 100 });
    expect(q).toContain("before=50");
    expect(q).not.toContain("since=");
  });

  test("before 与 since 同时传：before 优先，且不发 since（防服务端歧义）", () => {
    const q = messagesQuery({ since: 5, before: 50, limit: 100 });
    expect(q).toContain("before=50");
    expect(q).not.toContain("since=");
  });

  test("completion=true → completion=1", () => {
    expect(messagesQuery({ limit: 100, completion: true })).toContain("completion=1");
  });

  test("before=0 视为未提供，走 since 语义", () => {
    const q = messagesQuery({ since: 3, before: 0, limit: 100 });
    expect(q).toContain("since=3");
    expect(q).not.toContain("before=");
  });
});

// 捕获 fetch 请求的查询串，断言过程而不只是 run() 的返回码
function captureSearch(): { get: () => string } {
  let search = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    search = url.search;
    return Response.json({ messages: [] });
  }) as typeof fetch;
  return { get: () => search };
}

describe("party history 参数解析（#151）", () => {
  test("missing bound agent config is loud and exits non-zero instead of using a human account (#518)", async () => {
    rmSync(join(home, "config.json"), { force: true });
    const missing = join(home, "agents", "missing-agent.json");
    writeState({ channel: "dev", cursor: 0, config_path: missing, bindings: { dev: missing } });
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      email: "human@example.com",
    });
    globalThis.fetch = (async () => {
      throw new Error("history must fail before making a request with the human token");
    }) as unknown as typeof fetch;

    expect(await run(["dev"])).toBe(1);
    expect(stderr.join("\n")).toContain("refusing human-account fallback");
    expect(stderr.join("\n")).toContain("no config");
  });

  test("attachment-only history output contains actionable metadata (#362)", async () => {
    globalThis.fetch = (async () => Response.json({
      messages: [{
        type: "msg",
        seq: 9,
        sender: { name: "alice", kind: "human" },
        kind: "message",
        body: "",
        mentions: [],
        reply_to: null,
        state: null,
        note: null,
        status: null,
        attachments: [{
          key: "dev/uuid/image.png",
          filename: "image.png",
          content_type: "image/png",
          size: 99,
          url: "/api/channels/dev/attachments/uuid/image.png",
        }],
        ts: 1,
      }],
    })) as unknown as typeof fetch;

    expect(await run(["dev"])).toBe(0);
    expect(stdout).toEqual([
      "[9] alice(human): [attachment: image.png · image/png · 99 bytes · auth GET /api/channels/dev/attachments/uuid/image.png]",
    ]);
  });

  test("--since 与 --before 同时给出 → exit 1，且不发请求", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      throw new Error("history 不应在 flag 冲突时打网络请求");
    }) as typeof fetch;
    const code = await run(["dev", "--since", "5", "--before", "10"]);
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("--since and --before are mutually exclusive");
  });

  test("默认（无 since/before）→ 走 tail：查询串带 before=TAIL_BEFORE，不带 since", async () => {
    const search = captureSearch();
    const code = await run(["dev"]);
    expect(code).toBe(0);
    expect(search.get()).toContain(`before=${TAIL_BEFORE}`);
    expect(search.get()).not.toContain("since=");
  });

  test("显式 --since 0 → 从头读，不走 tail", async () => {
    const search = captureSearch();
    const code = await run(["dev", "--since", "0"]);
    expect(code).toBe(0);
    expect(search.get()).toContain("since=0");
    expect(search.get()).not.toContain("before=");
  });

  test("--before <seq> → 反向分页，不带 since", async () => {
    const search = captureSearch();
    const code = await run(["dev", "--before", "50"]);
    expect(code).toBe(0);
    expect(search.get()).toContain("before=50");
    expect(search.get()).not.toContain("since=");
  });
});

describe("party_history（MCP，#151）", () => {
  test("默认（无 since/before）→ 走 tail，对得上工具描述里的 recent", async () => {
    const seen: string[] = [];
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages" && req.method === "GET") {
          seen.push(url.search);
          return Response.json({ messages: [] });
        }
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }));

    const indexPath = join(import.meta.dir, "..", "src", "index.ts");
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "mcp", "--channel", "dev"],
      env: { ...process.env, AGENTPARTY_HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "party_history", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toContain(`before=${TAIL_BEFORE}`);
      expect(seen[0]).not.toContain("since=");
    } finally {
      await client.close();
    }
  }, 15_000);
});
