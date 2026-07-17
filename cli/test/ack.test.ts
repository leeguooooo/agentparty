// #594：party ack——纯读场景的显式清账。只清 watch 源债；serve 债误清=静默丢 @（#198 红线）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runAck } from "../src/commands/ack";
import { loadStuck, saveStuck, saveWatchStuck } from "../src/config";

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
