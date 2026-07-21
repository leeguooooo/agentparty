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
  test("持久化 pending wake 发生在输出与 cursor ack 之前 (#508)", async () => {
    const events: string[] = [];
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(4, "me"));
      sock.send(msgFrame(4, "wake", { mentions: ["me"] }));
    });

    const o = opts({
      server: server.url,
      since: 3,
      out: (line) => events.push(`out:${line}`),
      onStuck: (stuck) => events.push(`stuck:${stuck.seq}`),
      onCursor: (cursor) => events.push(`cursor:${cursor}`),
    });
    expect(await runWatch(o)).toBe(0);

    expect(events[0]).toBe("stuck:4");
    expect(events.findIndex((event) => event.startsWith("out:"))).toBeGreaterThan(0);
    expect(events.indexOf("stuck:4")).toBeLessThan(events.indexOf("cursor:4"));
  });

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

describe("watch --once pending wake replay (#508)", () => {
  test("unconfirmed directed debt re-arms for a fresh claim and never uses blind REST replay", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-directed-rearm-"));
    let messageFetches = 0;
    let adapterRegistrations = 0;
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages" && req.method === "GET") {
          messageFetches += 1;
          return Response.json({ messages: [msgFrame(10, "must not replay", { mentions: ["me"] })] });
        }
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw)) as { type: string };
          if (frame.type === "hello") {
            ws.send(JSON.stringify({ ...welcomeFrame(10, "me"), directed_delivery: "v1" }));
          } else if (frame.type === "delivery_adapter") {
            adapterRegistrations += 1;
            ws.send(JSON.stringify({ type: "error", code: "archived", message: "stop after re-arm proof" }));
          }
        },
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    const debt = {
      seq: 10,
      delivery_id: "delivery-10",
      work_id: "work-10",
      continuation_ref: "continuation-10",
      delivery_acceptance: "unconfirmed",
      attempts: 0,
      source: "watch",
    };
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ channel: "dev", cursor: 10, cursors: { dev: { cursor: 10, stuck: debt } } }),
    );

    const result = await runCli(["watch", "dev", "--once", "--mentions-only", "--json"]);
    expect(result.code).not.toBe(0);
    expect(adapterRegistrations).toBe(1);
    expect(messageFetches).toBe(0);
    expect(result.stdout).not.toContain("watch_replay");
    expect(result.stdout).not.toContain("must not replay");
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cursors.dev.stuck).toEqual(debt);
  }, 15_000);

  test("重挂不带 --latest 先从 REST 重放欠账，且不再建立 WS", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-pending-replay-"));
    const pending = msgFrame(10, "@me must survive reaper", { mentions: ["me"] });
    let upgrades = 0;
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return Response.json({ messages: pending.seq > since ? [pending] : [] });
        }
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", kind: "agent", role: "agent", email: null, owner: null });
        }
        upgrades++;
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: { message() {} },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        channel: "dev",
        cursor: 10,
        cursors: {
          dev: {
            cursor: 10,
            stuck: { seq: 10, attempts: 0, last_error: "watch wake awaiting agent acknowledgement", source: "watch" },
          },
        },
      }),
    );

    const first = await runCli(["watch", "dev", "--once", "--mentions-only", "--json"]);
    expect(first.code).toBe(0);
    expect(upgrades).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      type: "msg",
      seq: 10,
      watch_replay: true,
      pending_ack: true,
      replay_attempt: 1,
      channel_last_seq: 10,
      lag: 0,
      skipped_mention_seqs: [],
    });
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cursors.dev.stuck.attempts).toBe(1);

    const second = await runCli(["watch", "dev", "--once", "--mentions-only", "--json"]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ seq: 10, watch_replay: true, replay_attempt: 2 });
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cursors.dev.stuck.attempts).toBe(2);
  }, 15_000);

  test("--latest 排空 pending 债、attach 到 head、绝不回放旧债 (#674)", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-latest-drain-"));
    // head 就是这条 pending（seq10）。--latest 应清债 + 把游标推到 10，然后 attach WS 到 head 等新消息，
    // 而不是像旧行为那样先把 seq10 回放一遍。
    const pending = msgFrame(10, "@me stale backlog", { mentions: ["me"] });
    let upgrades = 0;
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return Response.json({ messages: pending.seq > since ? [pending] : [] });
        }
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", kind: "agent", role: "agent", email: null, owner: null });
        }
        upgrades++;
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          // 收 hello 前不知 self；直接回 welcome(head=10) 让 --latest attach 到 head，随后无新消息超时退出。
          ws.send(JSON.stringify(welcomeFrame(10, "me")));
        },
        message() {},
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        channel: "dev",
        cursor: 10,
        cursors: {
          dev: {
            cursor: 10,
            stuck: { seq: 10, attempts: 0, last_error: "watch wake awaiting agent acknowledgement", source: "watch" },
          },
        },
      }),
    );

    const result = await runCli(["watch", "dev", "--once", "--mentions-only", "--latest", "--json", "--timeout", "1"]);
    // 旧行为会先 REST 回放 seq10（不建 WS）；新行为清债后 attach WS 到 head。
    expect(upgrades).toBeGreaterThanOrEqual(1);
    expect(result.stdout).not.toContain("watch_replay");
    expect(result.stderr).toContain("--latest 排空 pending 唤醒债");
    // pending 债被清、游标推进到 head=10。
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(state.cursors.dev.stuck).toBeUndefined();
    expect(state.cursors.dev.cursor).toBe(10);
  }, 15_000);

  test("重放帧重新探测频道 head，并保留首次快进的 mention 元数据 (#508)", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-pending-head-"));
    const pending = msgFrame(10, "oldest pending wake", { mentions: ["me"] });
    const head = msgFrame(14, "newer context");
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/api/channels/dev/messages") return new Response("not found", { status: 404 });
        return Response.json({ messages: url.searchParams.has("before") ? [head] : [pending] });
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        channel: "dev",
        cursor: 10,
        cursors: {
          dev: {
            cursor: 10,
            stuck: {
              seq: 10,
              attempts: 0,
              source: "watch",
              channel_last_seq: 12,
              skipped_mention_seqs: [3, 7],
            },
          },
        },
      }),
    );

    const result = await runCli(["watch", "dev", "--once", "--mentions-only", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      seq: 10,
      watch_replay: true,
      pending_ack: true,
      channel_last_seq: 14,
      lag: 4,
      skipped_mention_seqs: [3, 7],
    });

    const human = await runCli(["watch", "dev", "--once", "--mentions-only"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("channel_last_seq=14 lag=4 skipped_mention_seqs=[3,7]");
    expect(human.stdout).toContain("party history dev --since 10");
  }, 15_000);

  test("欠账消息已退出保留窗口时响亮失败并保留 debt", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-pending-missing-"));
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ messages: [] });
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ channel: "dev", cursor: 10, cursors: { dev: { cursor: 10, stuck: { seq: 10, attempts: 3, source: "watch" } } } }),
    );

    const result = await runCli(["watch", "dev", "--once", "--mentions-only", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no longer retained");
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cursors.dev.stuck).toEqual({ seq: 10, attempts: 3, source: "watch" });
  }, 15_000);
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
  test("zero cursor defaults mentions-only once to latest instead of replaying historical mentions (#361)", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-initial-latest-"));
    const messages = [
      msgFrame(1, "stale mention", { mentions: ["me"] }),
      msgFrame(2, "head"),
    ];
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
          ws.send(JSON.stringify(welcomeFrame(2, "me")));
          ws.send(JSON.stringify(frame.since === 0 ? messages[0] : msgFrame(3, "fresh mention", { mentions: ["me"] })));
        },
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ channel: "dev", cursor: 0 }));

    const result = await runCli(["watch", "dev", "--once", "--mentions-only", "--timeout", "2"]);

    expect(result.code).toBe(0);
    expect(hellos).toEqual([2]);
    expect(result.stdout).toContain("initial_cursor=latest");
    expect(result.stdout).toContain("skipped_mention_seqs=[1]");
    expect(result.stdout).not.toContain("stale mention");
    expect(result.stdout).toContain("fresh mention");
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cursors.dev.cursor).toBe(3);
  }, 15_000);

  test("explicit --since 0 preserves historical mention replay for zero-cursor users (#361)", async () => {
    home = mkdtempSync(join(tmpdir(), "ap-watch-explicit-zero-"));
    const hellos: number[] = [];
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw));
          if (frame.type !== "hello") return;
          hellos.push(frame.since);
          ws.send(JSON.stringify(welcomeFrame(2, "me")));
          ws.send(JSON.stringify(msgFrame(1, "requested historical mention", { mentions: ["me"] })));
        },
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${apiServer.port}`, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ channel: "dev", cursor: 0 }));

    const result = await runCli(["watch", "dev", "--since", "0", "--once", "--mentions-only", "--timeout", "2"]);

    expect(result.code).toBe(0);
    expect(hellos).toEqual([0]);
    expect(result.stdout).not.toContain("initial_cursor=latest");
    expect(result.stdout).toContain("requested historical mention");
  }, 15_000);

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
