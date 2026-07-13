// 本机单实例锁（#195 watch / #99 serve 的同机那半）。
//
// `watch --once` 的「退出 → 处理 → 重挂」和 serve 的重启,两者的重挂步骤都无人守卫。
// 实测（#195 作者）：10 个唤醒周期后同一 (channel, identity) 上并存两个 watcher,
// 一条 @ 触发两次 runner,agent 把同一条消息回了两遍——而 `party who` 只显示一个 ● online。
// serve 更贵：每次重复都是一次完整的 codex/claude run,可能重复 git push、重复开 PR。
//
// 用 pid 锁而不是 flock：Bun 没有跨平台 flock,而且我们要能告诉用户**是哪个 pid 占着**。
// 陈旧锁（写锁的进程已死）必须能接管,否则一次 SIGKILL 就把频道永久锁死。
//
// ⚠️ 这把锁只挡**同一台机器**。跨机器的重复执行（工位机 + 家里机各跑一个 serve）
// 需要服务端租约（#99 的另一半,`do.ts` 广播发给同名所有连接）。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { agentpartyHome } from "./config";

export type InstanceKind = "watch" | "serve";

export interface InstanceLock {
  ok: boolean;
  /** ok=false 时,当前持锁的进程 pid。 */
  heldByPid?: number;
  release?: () => void;
}

function lockPath(kind: InstanceKind, channel: string, dir: string): string {
  return join(dir, `${kind}-${channel.replace(/[^a-zA-Z0-9._-]/g, "_")}.lock`);
}

/** 默认锁目录不再跟 cwd/workspace 走：同一身份从另一个 repo 启动也必须互斥。 */
export function defaultInstanceLockDir(): string {
  return join(agentpartyHome(), "instances");
}

/** token 只参与不可逆摘要，不落盘；不同 server/身份在同一频道互不阻塞。 */
export function instanceLockTarget(server: string, token: string, channel: string): string {
  const identity = createHash("sha256").update(server).update("\0").update(token).digest("hex").slice(0, 24);
  return `${identity}-${channel}`;
}

interface ProcessIdentity {
  alive: boolean;
  startedAt?: number;
}

function inspectProcess(pid: number): ProcessIdentity {
  try {
    process.kill(pid, 0); // 信号 0：只探测存活,不真的发信号
  } catch {
    return { alive: false };
  }
  if (process.platform === "win32") return { alive: true };

  // kill(pid, 0) 对 zombie 仍返回成功，而且 PID 可能已被系统复用。用 ps 同时核验状态与出生时间；
  // ps 不可用时保守回落到 kill(0)，绝不误杀一个无法确认的活进程。
  const probe = spawnSync("ps", ["-o", "lstart=", "-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
    env: { ...process.env, LC_ALL: "C", LC_TIME: "C" },
  });
  if (probe.error || probe.status !== 0) return { alive: true };
  const line = probe.stdout.trim();
  const match = line.match(/^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)/);
  if (!match) return line === "" ? { alive: false } : { alive: true };
  if (match[2]!.startsWith("Z")) return { alive: false };
  const startedAt = Date.parse(match[1]!);
  return Number.isFinite(startedAt) ? { alive: true, startedAt } : { alive: true };
}

const PROCESS_STARTED_AT =
  inspectProcess(process.pid).startedAt ?? Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000;

function holderAlive(holder: LockHolder | null): holder is LockHolder & { pid: number } {
  if (typeof holder?.pid !== "number") return false;
  const processIdentity = inspectProcess(holder.pid);
  if (!processIdentity.alive) return false;
  if (holder.started_at === undefined || processIdentity.startedAt === undefined) return true;
  return Math.abs(holder.started_at - processIdentity.startedAt) <= 2000;
}

export function currentProcessStartedAt(): number {
  return PROCESS_STARTED_AT;
}

interface LockHolder {
  pid?: number;
  id?: string;
  started_at?: number;
}

function readHolder(path: string): LockHolder | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockHolder;
  } catch {
    return null;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export function acquireInstanceLock(kind: InstanceKind, channel: string, dir: string): InstanceLock {
  const path = lockPath(kind, channel, dir);
  const reclaimPath = `${path}.reclaim`;
  const lockId = randomUUID();
  const body = JSON.stringify({ pid: process.pid, id: lockId, started_at: PROCESS_STARTED_AT, kind, channel, ts: Date.now() });
  let staleGeneration: string | null = null;
  mkdirSync(dir, { recursive: true });

  for (;;) {
    try {
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const held = readHolder(path);
    if (holderAlive(held)) {
      return { ok: false, heldByPid: held.pid };
    }
    const generation = held?.id ?? `legacy:${held?.pid ?? "invalid"}`;
    // If the file changed since this contender observed the stale owner, another
    // contender won the takeover. Never delete that newer generation.
    if (staleGeneration !== null && generation !== staleGeneration) {
      return { ok: false, heldByPid: held?.pid };
    }
    staleGeneration = generation;

    const reclaimId = randomUUID();
    try {
      // O_EXCL serializes stale-file removal; the winner recreates the main lock
      // with O_EXCL while still holding this short-lived reclaim lock.
      writeFileSync(reclaimPath, JSON.stringify({ pid: process.pid, id: reclaimId }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const reclaimer = readHolder(reclaimPath);
      if (typeof reclaimer?.pid === "number" && !holderAlive(reclaimer)) {
        try {
          unlinkSync(reclaimPath);
        } catch {
          /* Another contender already removed the stale reclaim lock. */
        }
      } else {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
      continue;
    }

    try {
      const current = readHolder(path);
      if (holderAlive(current)) {
        return { ok: false, heldByPid: current.pid };
      }
      const currentGeneration = current?.id ?? `legacy:${current?.pid ?? "invalid"}`;
      if (currentGeneration !== staleGeneration) {
        return { ok: false, heldByPid: current?.pid };
      }
      try {
        unlinkSync(path);
      } catch {
        /* Another stale cleanup may already have removed the old file. */
      }
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    } finally {
      try {
        unlinkSync(reclaimPath);
      } catch {
        /* Reclaim lock already disappeared. */
      }
    }
  }

  return {
    ok: true,
    release: () => {
      try {
        // 只删自己的锁：别人接管过就不动它
        const cur = JSON.parse(readFileSync(path, "utf8")) as { id?: string };
        if (cur.id === lockId) unlinkSync(path);
      } catch {
        /* 已经没了 */
      }
    },
  };
}
