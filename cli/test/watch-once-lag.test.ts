// #199：watch --once 醒在**最旧**的未读 mention。醒在最旧是对的（醒在最新会丢），
// 错的是它不说自己落后多少——被唤醒的 agent 以为手上这条就是最新的，
// 于是照着三小时前的上下文回话，而后面还压着 N 条没读。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceId } from "../src/config";
import { runWatch, type WatchOptions } from "../src/commands/watch";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
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

afterEach(() => {
  server?.stop();
  server = null;
  apiServer?.stop(true);
  apiServer = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function opts(over: Partial<WatchOptions> & { server: string }): WatchOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    timeoutSec: 3,
    follow: false,
    mentionsOnly: true,
    once: true,
    out: (l) => lines.push(l),
    backoffBaseMs: 20,
    lines,
    ...over,
  };
}

describe("watch --once 落后量告知 (#199)", () => {
  test("醒在最旧未读 @ 时，报出还落后多少条、频道 head 是多少", async () => {
    // 游标停在 3；频道已经到 20。seq 4 是最旧的未读 @，后面还压着 16 条。
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(20, "me"));
      sock.send(msgFrame(4, "三小时前 @ 你", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url, since: 3 });
    expect(await runWatch(o)).toBe(0);

    // 唤醒发生在 seq 4（最旧未读），这不改
    expect(o.lines.some((l) => l.includes("三小时前 @ 你"))).toBe(true);
    // 但必须说清楚：这条不是最新的，后面还有 16 条
    const notice = o.lines.find((l) => l.includes("落后"));
    expect(notice).toBeDefined();
    expect(notice!).toContain("seq=4");
    expect(notice!).toContain("head=20");
    expect(notice!).toContain("16");
    expect(notice!).toContain("channel_last_seq=20");
    expect(notice!).toContain("lag=16");
    expect(notice!).toContain("skipped_mention_seqs=[]");
  });

  test("游标已追平频道 head 时不打落后告知（没落后就别吓唬人）", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(4, "me"));
      sock.send(msgFrame(4, "刚刚 @ 你", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url, since: 3 });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines.some((l) => l.includes("落后"))).toBe(false);
    expect(o.lines).toContain("watch: channel_last_seq=4 lag=0 skipped_mention_seqs=[]");
  });

  test("JSON wake frame carries head, lag, and explicit skipped mention seqs", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(9, "me"));
      sock.send(msgFrame(8, "wake", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url, since: 7, json: true, skippedMentionSeqs: [3, 6] });
    expect(await runWatch(o)).toBe(0);

    expect(JSON.parse(o.lines[0]!)).toMatchObject({
      type: "msg",
      seq: 8,
      channel_last_seq: 9,
      lag: 1,
      skipped_mention_seqs: [3, 6],
    });
    expect(o.lines).toHaveLength(1);
  });

  test("非 --once（补拉排空）不打这条告知：它本来就会读到 head", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(5, "me"));
      sock.send(msgFrame(4, "@ 你 A", { mentions: ["me"] }));
      sock.send(msgFrame(5, "@ 你 B", { mentions: ["me"] }));
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 60);
    });

    const o = opts({ server: server.url, since: 3, once: false });
    expect(await runWatch(o)).toBe(0); // 补拉排空即退出 0，不会等到 archived
    expect(o.lines.some((l) => l.includes("落后"))).toBe(false);
  });
});

describe("watch --once 不得复用身份级已读游标 (#206 门禁 P1)", () => {
  test("welcome.read_cursors 领先本地游标时，绝不据此快进——它证明不了唤醒送达", async () => {
    // 服务端说这个身份已读到 10（可能是同身份的网页标签页读的）。
    // 但 watch --once 的送达由 wake 回执表达，不由 seen 表达（shared/src/protocol.ts:424-430）。
    // 拿 read_seq 快进会把 seq 4 这条从未送达的 @ 静默跳过。
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(12, "me", [{ name: "me", last_seen_seq: 10, updated_at: 1 }]));
      sock.send(msgFrame(4, "从未送达给 supervisor 的 @", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url, since: 3 });
    expect(await runWatch(o)).toBe(0);
    // 仍然醒在 seq 4：这条 @ 从没唤醒过任何 runner，不能因为网页读过就算了结
    expect(o.lines.some((l) => l.includes("从未送达给 supervisor 的 @"))).toBe(true);
  });
});

describe("watch explicit cursor choices (#172)", () => {
  test("--since starts and persists the explicit local watch cursor", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-since-"));
    const messages = [msgFrame(3, "old"), msgFrame(4, "mention", { mentions: ["me"] }), msgFrame(5, "head")];
    const hellos: number[] = [];
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
          const limit = Number(url.searchParams.get("limit") ?? 100);
          const before = Number(url.searchParams.get("before") ?? 0);
          return Response.json({
            messages: before > 0 ? messages.slice(-limit) : messages.filter((msg) => msg.seq > since).slice(0, limit),
          });
        }
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw));
          if (frame.type !== "hello") return;
          hellos.push(frame.since);
          ws.send(JSON.stringify(welcomeFrame(5, "me")));
        },
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ channel: "dev", cursor: 2 }));

    const result = await runCli(["watch", "dev", "--since", "5", "--once", "--timeout", "1"]);

    expect(result.code).toBe(2);
    expect(hellos).toEqual([5]);
    expect(result.stdout).toContain("skipped_messages=3");
    expect(result.stdout).toContain("skipped_mention_seqs=[4]");
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cursors.dev.cursor).toBe(5);
  }, 15_000);

  test("--latest fast-forwards locally, reports skipped mentions, then waits after head", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-latest-"));
    const messages = [
      msgFrame(3, "old"),
      msgFrame(4, "old mention", { mentions: ["me"] }),
      msgFrame(5, "head"),
    ];
    const hellos: number[] = [];
    let persistedAtAttach = -1;
    const dir = join(home, "state", workspaceId(process.cwd()));
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
          const limit = Number(url.searchParams.get("limit") ?? 100);
          const before = Number(url.searchParams.get("before") ?? 0);
          const selected = before > 0 ? messages.slice(-limit) : messages.filter((msg) => msg.seq > since).slice(0, limit);
          return Response.json({ messages: selected });
        }
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw));
          if (frame.type !== "hello") return;
          hellos.push(frame.since);
          persistedAtAttach = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cursors.dev.cursor;
          ws.send(JSON.stringify(welcomeFrame(5, "me")));
          setTimeout(() => ws.send(JSON.stringify(msgFrame(6, "new mention", { mentions: ["me"] }))), 20);
        },
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ channel: "dev", cursor: 2 }));

    const result = await runCli(["watch", "dev", "--latest", "--once", "--mentions-only", "--timeout", "2"]);

    expect(result.code).toBe(0);
    expect(hellos).toEqual([5]);
    expect(persistedAtAttach).toBe(5);
    expect(result.stdout).toContain("skipped_messages=3");
    expect(result.stdout).toContain("skipped_mentions=1");
    expect(result.stdout).toContain("skipped_mention_seqs=[4]");
    expect(result.stdout).toContain("[6] bob(agent): new mention");
    expect(result.stdout).toContain("channel_last_seq=6 lag=0 skipped_mention_seqs=[4]");
  }, 15_000);

  test("--since never persists a cursor beyond the current channel head", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-future-since-"));
    const messages = [msgFrame(3, "old"), msgFrame(4, "mention", { mentions: ["me"] }), msgFrame(5, "head")];
    const hellos: number[] = [];
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
          const limit = Number(url.searchParams.get("limit") ?? 100);
          const before = Number(url.searchParams.get("before") ?? 0);
          return Response.json({
            messages: before > 0 ? messages.slice(-limit) : messages.filter((msg) => msg.seq > since).slice(0, limit),
          });
        }
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw));
          if (frame.type !== "hello") return;
          hellos.push(frame.since);
          ws.send(JSON.stringify(welcomeFrame(5, "me")));
        },
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ channel: "dev", cursor: 2 }));

    const result = await runCli(["watch", "dev", "--since", "999", "--once", "--timeout", "1"]);

    expect(result.code).toBe(2);
    expect(hellos).toEqual([5]);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cursors.dev.cursor).toBe(5);
    expect(result.stdout).toContain("attached_at_seq=5");
  }, 15_000);
});
