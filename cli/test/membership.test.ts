// party membership（#277 骨架）：owner 手动开通。这里只覆盖联网前的参数校验路径
// （help / 缺子命令 / 缺 --account / 缺 ADMIN_SECRET）；开通成功/翻转走 worker 集成测试
// （account-membership.spec.ts）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run } from "../src/commands/membership";

function capture(fn: () => Promise<number>): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  return fn()
    .then((code) => ({ code, out, err }))
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
    });
}

let savedSecret: string | undefined;
let savedServer: string | undefined;
beforeEach(() => {
  savedSecret = process.env.ADMIN_SECRET;
  savedServer = process.env.AGENTPARTY_SERVER;
  delete process.env.ADMIN_SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = savedSecret;
  if (savedServer === undefined) delete process.env.AGENTPARTY_SERVER;
  else process.env.AGENTPARTY_SERVER = savedServer;
});

describe("party membership 参数校验（#277）", () => {
  test("--help 打印用法并 exit 0", async () => {
    const { code, out } = await capture(() => run(["--help"]));
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("party membership activate");
  });

  test("缺子命令 → exit 1", async () => {
    const { code, err } = await capture(() => run([]));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("activate|deactivate");
  });

  test("非法子命令 → exit 1", async () => {
    const { code, err } = await capture(() => run(["upgrade", "--account", "a@b.com"]));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("activate|deactivate");
  });

  test("缺 --account → exit 1", async () => {
    const { code, err } = await capture(() => run(["activate", "--server", "https://ap.test"]));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--account required");
  });

  test("有 account 但缺 ADMIN_SECRET → exit 1", async () => {
    const { code, err } = await capture(() =>
      run(["activate", "--account", "a@b.com", "--server", "https://ap.test"]),
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("ADMIN_SECRET");
  });
});
