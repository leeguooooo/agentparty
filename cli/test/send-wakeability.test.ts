// #664：party send --mention 目标不可唤醒时，发送方要拿到非阻断 warning（消息仍发成功），
// --require-wakeable 则在发送后非零退出。端到端跑真 CLI（spawn = 非 TTY，正是出问题的 agent 循环场景），
// 用 rest-mock 供 presence + messages。EXIT_UNREACHABLE=10 是「已发出但没落地」的独立退出码。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_UNREACHABLE, type PresenceEntry } from "@agentparty/shared";
import { startRestMock, type RestMock } from "./rest-mock";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");
const HOUR = 60 * 60 * 1000;

let home: string;
let configPath: string;
let restMock: RestMock | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-send-wake-"));
  configPath = join(home, "config.json");
});

afterEach(() => {
  restMock?.stop();
  restMock = null;
  rmSync(home, { recursive: true, force: true });
});

function writeCfg(server: string, token = "ap_tok") {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ server, token }, null, 2) + "\n");
}

// presence 用真实 now 相对时刻（CLI 子进程按 Date.now() 判新鲜度）。
function presenceMock(entries: (Partial<PresenceEntry> & { name: string })[]): RestMock {
  return startRestMock((req) => {
    if (req.method === "GET" && /^\/api\/channels\/[^/]+\/presence$/.test(req.path)) {
      const now = Date.now();
      const presence = entries.map((e) => ({
        state: "offline",
        note: null,
        ts: now - 88 * HOUR,
        last_seen: now - 88 * HOUR,
        kind: "agent" as const,
        ...e,
      }));
      return Response.json({ presence });
    }
    return undefined; // messages POST 走默认 { seq: 1 }
  });
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_CONFIG: configPath, AGENTPARTY_HOME: home },
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

describe("party send --mention wakeability warning (#664)", () => {
  test("no-wake + stale target → non-blocking warn on stderr, message still sent, exit 0", async () => {
    restMock = presenceMock([{ name: "kyc-claude", wake: { kind: "none" } }]);
    writeCfg(restMock.url);
    const r = await runCli(["send", "dispatch P0 fix", "--channel", "kyc", "--mention", "kyc-claude"]);
    expect(r.code).toBe(0); // 非阻断：消息发成功
    expect(r.stdout).toContain("sent seq="); // 消息确实发出去了
    expect(r.stderr).toContain("warn:");
    expect(r.stderr).toContain("kyc-claude has no live wake channel");
    expect(r.stderr).toContain("party wake test @kyc-claude");
  });

  test("wakeable target (webhook) → no warn line, exit 0", async () => {
    restMock = presenceMock([{ name: "hook-bot", wake: { kind: "webhook" }, last_seen: Date.now() - 2 * HOUR, ts: Date.now() - 2 * HOUR }]);
    writeCfg(restMock.url);
    const r = await runCli(["send", "ping", "--channel", "dev", "--mention", "hook-bot"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("sent seq=");
    expect(r.stderr).not.toContain("warn:");
    expect(r.stderr).not.toContain("has no live wake channel");
  });

  test("--require-wakeable + unreachable target → exit EXIT_UNREACHABLE, message still sent", async () => {
    restMock = presenceMock([{ name: "kyc-claude", wake: { kind: "none" } }]);
    writeCfg(restMock.url);
    const r = await runCli(["send", "dispatch P0 fix", "--channel", "kyc", "--mention", "kyc-claude", "--require-wakeable"]);
    expect(r.code).toBe(EXIT_UNREACHABLE);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("sent seq="); // 消息仍发成功（严格模式只影响退出码）
    expect(r.stderr).toContain("has no live wake channel");
    // 消息确实 POST 到服务端了
    expect(restMock.requests.some((q) => q.method === "POST" && /\/messages$/.test(q.path))).toBe(true);
  });

  test("--require-wakeable + wakeable target → exit 0", async () => {
    restMock = presenceMock([{ name: "hook-bot", wake: { kind: "webhook" }, last_seen: Date.now() - 2 * HOUR, ts: Date.now() - 2 * HOUR }]);
    writeCfg(restMock.url);
    const r = await runCli(["send", "ping", "--channel", "dev", "--mention", "hook-bot", "--require-wakeable"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("sent seq=");
  });

  test("--no-reach silences the warn line (message still sent, exit 0)", async () => {
    restMock = presenceMock([{ name: "kyc-claude", wake: { kind: "none" } }]);
    writeCfg(restMock.url);
    const r = await runCli(["send", "dispatch", "--channel", "kyc", "--mention", "kyc-claude", "--no-reach"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("sent seq=");
    expect(r.stderr).not.toContain("warn:");
  });
});
