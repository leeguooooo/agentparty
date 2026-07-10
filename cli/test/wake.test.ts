// party wake test — falsifiability (#181) 与 self-target 快速失败 (#194)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRestMock, type RestMock, type RestRequest } from "./rest-mock";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let mock: RestMock | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-wake-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home, ADMIN_SECRET: undefined },
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

function writeCfg(server: string, identityName?: string) {
  mkdirSync(home, { recursive: true });
  const cfg: Record<string, unknown> = { server, token: "ap_tok" };
  if (identityName !== undefined) {
    cfg.identity = {
      name: identityName,
      email: null,
      kind: "agent",
      role: "agent",
      owner: null,
      channel_scope: null,
      verified_at: 0,
    };
  }
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
}

function reqsOf(m: RestMock, method: string, pathPrefix: string): RestRequest[] {
  return m.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
}

// ── #181：advertises-no-adapter 的 agent 也要真发探针，让 not_auto_wakeable 可证伪 ──
describe("wake test falsifiability (#181)", () => {
  test("no advertised adapter but reachable: probe IS sent and reads healthy when it replies", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        const now = Date.now();
        // 声明了 residency 但没有 wake 适配器（tk-zego-im 场景：轮询/人驱动，模型没表达）
        return Response.json({
          presence: [{ name: "bot", state: "offline", note: null, ts: now, last_seen: now, residency: "supervised" }],
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/messages") {
        return Response.json({ seq: 5 });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            { type: "message", seq: 6, sender: { name: "bot", kind: "agent" }, kind: "message", body: "on it", mentions: [], reply_to: 5, ts: 1 },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url, "me");

    const r = await runCli(["wake", "test", "@bot", "dev", "--timeout", "1", "--json"]);
    expect(r.code).toBe(0);
    // 探针必须真发出去（旧行为是 mention: not sent）
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages")).toHaveLength(1);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      type: "wake_test",
      result: "healthy",
      phases: {
        mention_delivered: { ok: true, seq: 5 },
        agent_resumed: { ok: true, seq: 6, evidence: "reply_to" },
      },
    });
  });

  test("no advertised adapter and no reply: probe delivered, verdict is not_auto_wakeable (unconfirmed)", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        const now = Date.now();
        return Response.json({
          presence: [{ name: "bot", state: "offline", note: null, ts: now, last_seen: now, residency: "supervised" }],
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/messages") {
        return Response.json({ seq: 7 });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({ messages: [] });
      }
      return undefined;
    });
    writeCfg(mock.url, "me");

    const r = await runCli(["wake", "test", "@bot", "dev", "--timeout", "1", "--json"]);
    expect(r.code).toBe(2);
    // 关键：探针发出了，mention 不再是 "not sent"
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages")).toHaveLength(1);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      type: "wake_test",
      result: "not_auto_wakeable",
      phases: {
        mention_delivered: { ok: true, seq: 7 },
        wake_invoked: { ok: false },
        agent_resumed: { ok: false, seq: null },
      },
    });
    // wake_invoked 摊出 heartbeat 视角（没声明适配器），而不是笼统的「未审计」
    expect(frame.phases.wake_invoked.evidence).toContain("no wake adapter");
    // 结论标注为「探针未答复，未确认」——把 heartbeat 判定与投递判定分开
    expect(frame.reason).toContain("no wake adapter");
    expect(frame.reason).toContain("unconfirmed");
  });

  test("human_driven stays inbox-only: no probe is sent (falsifiability scoped to no-adapter, not human)", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [{ name: "bot", state: "waiting", note: null, ts: 111, last_seen: 111, residency: "human_driven", wake: { kind: "none" } }],
        });
      }
      return undefined;
    });
    writeCfg(mock.url, "me");

    const r = await runCli(["wake", "test", "@bot", "dev", "--json"]);
    expect(r.code).toBe(2);
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages")).toHaveLength(0);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      type: "wake_test",
      result: "not_auto_wakeable",
      phases: { mention_delivered: { ok: false, seq: null } },
    });
    expect(frame.reason).toContain("human-driven");
  });
});

// ── #194：目标解析为自己身份时，别发真探针、别等满 timeout，立刻失败 ──
describe("wake test self-target fast-fail (#194)", () => {
  test("self-target (cached identity) fails immediately with no probe and no network call", async () => {
    mock = startRestMock();
    writeCfg(mock.url, "me");

    const r = await runCli(["wake", "test", "@me", "dev"]);
    // 与通用 timeout(exit 2) 区分开，供调度端识别「误用」而非「agent 真死了」
    expect(r.code).toBe(1);
    // 一条网络请求都不该发（presence 都没查，更别说探针）
    expect(mock.requests).toHaveLength(0);
    expect(r.stderr).toContain("your own identity");
  });

  test("self-target --json emits a structured self_target frame, still no probe", async () => {
    mock = startRestMock();
    writeCfg(mock.url, "me");

    const r = await runCli(["wake", "test", "@me", "dev", "--json"]);
    expect(r.code).toBe(1);
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages")).toHaveLength(0);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({ type: "wake_test", target: "me", result: "self_target" });
  });
});
