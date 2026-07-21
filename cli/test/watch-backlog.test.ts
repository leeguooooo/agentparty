// #668/#674/#675：深积压未读 @ 的一次性排空 + 债过期降级 + 挂载默认静默。
// 覆盖 party watch --drain / 债过期 history-only 降级 / 默认不往时间线发 waiting 状态。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceId } from "../src/config";
import { WATCH_WAKE_DEBT_MAX_AGE_MS } from "../src/commands/watch";

let apiServer: ReturnType<typeof Bun.serve> | null = null;
let home: string | null = null;
const indexPath = join(import.meta.dir, "..", "src", "index.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home! },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function msg(seq: number, body: string, mentions: string[] = []) {
  return { seq, type: "msg", sender: { name: "other" }, mentions, body };
}

function writeState(cursor: number, stuck?: Record<string, unknown>) {
  const dir = join(home!, "state", workspaceId(process.cwd()));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ channel: "dev", cursor, cursors: { dev: { cursor, ...(stuck ? { stuck } : {}) } } }),
  );
  return join(dir, "state.json");
}

afterEach(() => {
  apiServer?.stop(true);
  apiServer = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("party watch --drain（#674）", () => {
  test("把游标推进到 head、清 pending 债、报跳过的 @ 数、退出 0，不建 WS", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-drain-"));
    let upgrades = 0;
    // 积压：cursor 5，head 200，其间有两条 @me 未读（seq 40/120）。
    const backlog = [msg(40, "@me old", ["me"]), msg(120, "@me older", ["me"]), msg(200, "head")];
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", kind: "agent", role: "agent", email: null, owner: null });
        }
        if (url.pathname === "/api/channels/dev/messages") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return Response.json({ messages: backlog.filter((m) => m.seq > since) });
        }
        upgrades++;
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: { message() {} },
    });
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }));
    const statePath = writeState(5, { seq: 40, attempts: 1, source: "watch" });

    const result = await runCli(["watch", "dev", "--mentions-only", "--drain"]);
    expect(result.code).toBe(0);
    expect(upgrades).toBe(0); // 一次性排空，绝不建 WS
    expect(result.stdout).toContain("head seq=200");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.cursors.dev.cursor).toBe(200);
    expect(state.cursors.dev.stuck).toBeUndefined();
  }, 15_000);

  test("--drain --json 输出结构化排空结果 + pending 列表", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-drain-json-"));
    const backlog = [msg(7, "@me", ["me"]), msg(9, "head")];
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") return Response.json({ name: "me", kind: "agent", role: "agent", email: null, owner: null });
        if (url.pathname === "/api/channels/dev/messages") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return Response.json({ messages: backlog.filter((m) => m.seq > since) });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: { message() {} },
    });
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }));
    writeState(0);
    const result = await runCli(["watch", "dev", "--mentions-only", "--drain", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "watch_drained", channel: "dev", cursor: 9, head: 9, pending_mentions: 1, pending_mention_seqs: [7] });
  }, 15_000);
});

describe("pending 唤醒债过期降级（#668/#674）", () => {
  test("first_wake_ts 超过阈值：不回放、清债、游标推过它，落回正常 attach", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-expire-"));
    let upgrades = 0;
    const pending = msg(10, "@me days-old", ["me"]);
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") return Response.json({ name: "me", kind: "agent", role: "agent", email: null, owner: null });
        if (url.pathname === "/api/channels/dev/messages") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return Response.json({ messages: pending.seq > since ? [pending] : [] });
        }
        upgrades++;
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "welcome", channel: "dev", self: "me", last_seq: 10, participants: [], presence: [], read_cursors: [] }));
        },
        message() {},
      },
    });
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }));
    const staleTs = Date.now() - (WATCH_WAKE_DEBT_MAX_AGE_MS + 60_000);
    const statePath = writeState(10, { seq: 10, attempts: 3, source: "watch", first_wake_ts: staleTs });

    const result = await runCli(["watch", "dev", "--once", "--mentions-only", "--timeout", "1"]);
    // 过期债不回放
    expect(result.stdout).not.toContain("replaying pending unacknowledged wake");
    expect(result.stderr).toContain("已过期");
    expect(result.stderr).toContain("history-only");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.cursors.dev.stuck).toBeUndefined();
    expect(upgrades).toBeGreaterThanOrEqual(1); // 降级后落回正常 attach
  }, 15_000);

  test("未过期债（含旧格式缺 first_wake_ts）仍照常回放", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-noexpire-"));
    const pending = msg(10, "@me fresh", ["me"]);
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") return Response.json({ name: "me", kind: "agent", role: "agent", email: null, owner: null });
        if (url.pathname === "/api/channels/dev/messages") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return Response.json({ messages: pending.seq > since ? [pending] : [] });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: { message() {} },
    });
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }));
    // 旧格式债：无 first_wake_ts → 永不过期（保守，不误丢）。
    writeState(10, { seq: 10, attempts: 0, source: "watch" });
    const result = await runCli(["watch", "dev", "--once", "--mentions-only", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ seq: 10, watch_replay: true });
  }, 15_000);
});

describe("挂载默认静默（#675）", () => {
  function mkServer(onPost: () => void) {
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages" && req.method === "POST") {
          onPost();
          return Response.json({ seq: 1 });
        }
        if (url.pathname === "/api/me") return Response.json({ name: "me", kind: "agent", role: "agent", email: null, owner: null });
        if (url.pathname === "/api/channels/dev/messages") return Response.json({ messages: [] });
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "welcome", channel: "dev", self: "me", last_seq: 0, participants: [], presence: [], read_cursors: [] }));
        },
        message() {},
      },
    });
  }

  test("默认不往时间线发 waiting 状态（无 POST /messages）", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-silent-"));
    let posts = 0;
    apiServer = mkServer(() => posts++);
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }));
    writeState(0);
    const result = await runCli(["watch", "dev", "--once", "--mentions-only", "--timeout", "1"]);
    // 正常挂载后无新 @：超时(2)或流结束(6)都行，只要不是用法/鉴权错误(1/3)。
    expect([2, 6]).toContain(result.code);
    expect(posts).toBe(0); // 关键：静默挂载，零时间线噪音
  }, 15_000);

  test("--status 显式 opt-in 时才发一条 waiting 状态", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-status-optin-"));
    let posts = 0;
    apiServer = mkServer(() => posts++);
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }));
    writeState(0);
    await runCli(["watch", "dev", "--once", "--mentions-only", "--status", "--timeout", "1"]);
    expect(posts).toBeGreaterThanOrEqual(1);
  }, 15_000);
});
