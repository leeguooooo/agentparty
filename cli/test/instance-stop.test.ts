// #741:同机同频道多 agent 时,要能只停「本身份」的 serve/watch,不像 `pkill -f` 那样误杀别人的。
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireInstanceLock,
  type InstanceKind,
  instanceLockHolderPid,
  instanceLockTarget,
  processStartedAt,
  stopOwnInstance,
} from "../src/instance-lock";

const dirs: string[] = [];
const kids: ChildProcess[] = [];
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore(); // 无论断言成败都还原,避免 mock 泄漏到后续用例(#742)
  for (const k of kids.splice(0)) { try { k.kill("SIGKILL"); } catch { /* already gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "ap-stop-"));
  dirs.push(d);
  return d;
}
// 手写一把「属于 pid 的」实例锁(出生时间取真实进程的,以过保守校验)。
function writeLock(d: string, kind: InstanceKind, target: string, pid: number): void {
  const started_at = processStartedAt(pid);
  writeFileSync(join(d, `${kind}-${target}.lock`), JSON.stringify({ pid, id: "x", started_at, kind, channel: "dev", ts: Date.now() }));
}

const SERVER = "https://agentparty.test";

describe("instanceLockHolderPid / stopOwnInstance (#741)", () => {
  test("有活持有者(本进程)→ 返回其 pid;没锁 / 释放后 → null", () => {
    const d = dir();
    const target = instanceLockTarget(SERVER, "tok", "dev");
    expect(instanceLockHolderPid("serve", target, d)).toBeNull();
    const lock = acquireInstanceLock("serve", target, d);
    expect(lock.ok).toBe(true);
    expect(instanceLockHolderPid("serve", target, d)).toBe(process.pid);
    lock.release?.();
    expect(instanceLockHolderPid("serve", target, d)).toBeNull();
  });

  test("缺出生时间(legacy 锁)→ 保守返回 null,不冒险 SIGTERM 可能被复用的 PID", () => {
    const d = dir();
    const target = instanceLockTarget(SERVER, "tok", "dev");
    writeFileSync(join(d, `serve-${target}.lock`), JSON.stringify({ pid: process.pid, id: "x", kind: "serve", channel: "dev" }));
    expect(instanceLockHolderPid("serve", target, d)).toBeNull();
  });

  test("没有在跑的 listener → 返回 0、提示 nothing to stop、不发信号", () => {
    const d = dir();
    const kill = spyOn(process, "kill"); spies.push(kill);
    const lines: string[] = [];
    expect(stopOwnInstance("serve", SERVER, "tok", "dev", (l) => lines.push(l), d)).toBe(0);
    expect(lines.join("\n")).toContain("nothing to stop");
    expect(kill.mock.calls.some(([, sig]) => sig === "SIGTERM")).toBe(false);
  });

  test("持有者是本进程 → 自我保护:返回 0、不给自己发 SIGTERM", () => {
    const d = dir();
    acquireInstanceLock("serve", instanceLockTarget(SERVER, "tok", "dev"), d);
    const kill = spyOn(process, "kill"); spies.push(kill);
    expect(stopOwnInstance("serve", SERVER, "tok", "dev", () => {}, d)).toBe(0);
    expect(kill.mock.calls.some(([, sig]) => sig === "SIGTERM")).toBe(false);
  });

  test("真 SIGTERM:目标(A)确实退出,同频道另一身份(B)存活;kind 也隔离(#742)", async () => {
    const d = dir();
    const childA = spawn("sleep", ["300"], { stdio: "ignore" });
    const childB = spawn("sleep", ["300"], { stdio: "ignore" });
    kids.push(childA, childB);
    const aExited = new Promise<"exited">((resolve) => childA.once("exit", () => resolve("exited")));
    await new Promise((r) => setTimeout(r, 80)); // 等 ps 能看到子进程的 lstart
    // A=tokA 的 serve;B=tokB 的 serve;同一频道 dev。
    writeLock(d, "serve", instanceLockTarget(SERVER, "tokA", "dev"), childA.pid!);
    writeLock(d, "serve", instanceLockTarget(SERVER, "tokB", "dev"), childB.pid!);

    // 只停 tokA 的 serve——真发 SIGTERM,不 mock。
    expect(stopOwnInstance("serve", SERVER, "tokA", "dev", () => {}, d)).toBe(0);
    const result = await Promise.race([
      aExited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    expect(result).toBe("exited"); // A 真的被 SIGTERM 掉了
    expect(childB.exitCode).toBeNull(); // B(另一身份)毫发无伤,没被误杀

    // 换 kind:tokA 的 watch 没有锁 → 什么都不停,B 依然活。
    expect(stopOwnInstance("watch", SERVER, "tokA", "dev", () => {}, d)).toBe(0);
    expect(childB.exitCode).toBeNull();
  });
});
