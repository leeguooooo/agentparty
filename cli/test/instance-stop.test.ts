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
function sleeper(): number {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  kids.push(child);
  return child.pid!;
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

  test("只 SIGTERM 目标实例:身份(token)与 kind 都隔离,不误伤同频道别人", async () => {
    const d = dir();
    const pidA = sleeper();
    const pidB = sleeper();
    await new Promise((r) => setTimeout(r, 80)); // 等 ps 能看到子进程的 lstart
    // A=token 的 serve;B=另一个 token 的 serve;都在同一频道 dev。
    writeLock(d, "serve", instanceLockTarget(SERVER, "tokA", "dev"), pidA);
    writeLock(d, "serve", instanceLockTarget(SERVER, "tokB", "dev"), pidB);

    const realKill = process.kill.bind(process);
    const sigtermed: number[] = [];
    const kill = spyOn(process, "kill").mockImplementation((pid: number, sig?: string | number) => {
      if (sig === "SIGTERM") { sigtermed.push(pid); return true; } // 捕获,不真杀(子进程留给 afterEach 清)
      return realKill(pid, sig as never); // 存活探测(signal 0)走真实实现
    });
    spies.push(kill);

    // 只停 token A 的 serve
    expect(stopOwnInstance("serve", SERVER, "tokA", "dev", () => {}, d)).toBe(0);
    expect(sigtermed).toEqual([pidA]); // 只有 A,绝不碰 B
    // 换 kind:同 token 的 watch 没有锁 → 什么都不停
    sigtermed.length = 0;
    expect(stopOwnInstance("watch", SERVER, "tokA", "dev", () => {}, d)).toBe(0);
    expect(sigtermed).toEqual([]);
  });
});
