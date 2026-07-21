// #594：party ack——纯读场景的显式清账。只清 watch 源债；serve 债误清=静默丢 @（#198 红线）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runAck } from "../src/commands/ack";
import { loadCursor, loadStuck, saveCursor, saveStuck, saveWatchStuck } from "../src/config";

let home: string;
let cwd: string;
let originalCwd: string;
const oldEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-ack-home-"));
  cwd = mkdtempSync(join(tmpdir(), "ap-ack-cwd-"));
  for (const key of ["AGENTPARTY_HOME", "AGENTPARTY_CONFIG", "AGENTPARTY_CHANNEL"]) {
    oldEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTPARTY_HOME = home;
  originalCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(() => {
  // check:cli 不带 --isolate：cwd 是进程级状态，不还原会污染后续测试文件的游标路径解析。
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const watchDebt = (seq: number) => ({
  seq,
  wake_ts: 1,
  attempts: 1,
  source: "watch" as const,
});

describe("party ack（#594）", () => {
  test("watch 债被清账；再跑一次报无债", async () => {
    expect(saveWatchStuck("dev", watchDebt(19))).toBe(true);
    expect(await runAck(["--channel", "dev"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
    expect(await runAck(["--channel", "dev"])).toBe(0);
  });

  test("--seq 不匹配拒绝清账", async () => {
    expect(saveWatchStuck("dev", watchDebt(19))).toBe(true);
    expect(await runAck(["--channel", "dev", "--seq", "20"])).toBe(1);
    expect(loadStuck("dev")).not.toBeNull();
    expect(await runAck(["--channel", "dev", "--seq", "19"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
  });

  test("serve 源债绝不触碰", async () => {
    saveStuck("dev", { seq: 7, wake_ts: 1, attempts: 1, source: "serve" } as never);
    expect(await runAck(["--channel", "dev"])).toBe(1);
    expect(loadStuck("dev")).not.toBeNull();
  });
});

describe("party ack 批量排空（#668/#674）", () => {
  test("--through N：清 <=N 的 watch 债并把游标推进到 N", async () => {
    saveCursor("dev", 5);
    expect(saveWatchStuck("dev", watchDebt(10))).toBe(true);
    expect(await runAck(["--channel", "dev", "--through", "10"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
    expect(loadCursor("dev")).toBe(10);
  });

  test("--before N：游标推进到 N-1，清严格早于 N 的债", async () => {
    saveCursor("dev", 3);
    expect(saveWatchStuck("dev", watchDebt(8))).toBe(true);
    expect(await runAck(["--channel", "dev", "--before", "20"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
    expect(loadCursor("dev")).toBe(19);
  });

  test("--through 低于债 seq 时保留债、只推游标", async () => {
    saveCursor("dev", 5);
    expect(saveWatchStuck("dev", watchDebt(30))).toBe(true);
    expect(await runAck(["--channel", "dev", "--through", "20"])).toBe(0);
    // 债 seq=30 高于排空点 20，保留；游标推进到 20。
    expect(loadStuck("dev")).not.toBeNull();
    expect(loadCursor("dev")).toBe(20);
  });

  test("--all 拉频道 head 排空多条积压债（一条命令清完，不逐条 ack）", async () => {
    saveCursor("dev", 5);
    expect(saveWatchStuck("dev", watchDebt(12))).toBe(true);
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages") {
          return Response.json({ messages: [{ seq: 182, type: "msg", sender: { name: "x" }, mentions: [], body: "head" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const configDir = join(home, "state");
      // ack --all 走 resolveAuthDetailed → 读 AGENTPARTY_HOME/config.json
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${api.port}`, token: "ap_tok" }));
      expect(await runAck(["--channel", "dev", "--all"])).toBe(0);
      expect(loadStuck("dev")).toBeNull();
      expect(loadCursor("dev")).toBe(182);
    } finally {
      api.stop(true);
    }
  });

  test("--all / --seq 互斥", async () => {
    expect(await runAck(["--channel", "dev", "--all", "--seq", "5"])).toBe(1);
  });

  test("--through 遇 serve 源债：保留债、推游标、退出 0 并提示", async () => {
    saveCursor("dev", 2);
    saveStuck("dev", { seq: 9, wake_ts: 1, attempts: 1, source: "serve" } as never);
    expect(await runAck(["--channel", "dev", "--through", "50"])).toBe(0);
    expect(loadStuck("dev")).not.toBeNull();
    expect(loadCursor("dev")).toBe(50);
  });
});
