import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const RUNNER_CONTINUATIONS_DIR = "continuations";

export type RunnerContinuationHarness = "codex" | "claude" | "codex-sdk";

export interface RunnerContinuationState {
  harness: RunnerContinuationHarness;
  session_id?: string;
  thread_id?: string;
  created_at: number;
  last_wake_ts: number;
  wakes: number;
  cwd?: string;
  workdir?: string;
  continuation_ref?: string;
  work_id?: string;
  /**
   * The handle still identifies the original turn, but resuming it is unsafe because the previous
   * outcome is unknown (for example an SDK timeout). Keeping the mapping with this marker lets a
   * later owner_answer fail explicitly instead of cold-starting or looking like missing state.
   */
  resume_blocked_reason?: string;
  resume_blocked_at?: number;
}

export function continuationPath(workdir: string, continuationRef: string): string {
  const filename = `${createHash("sha256").update(continuationRef, "utf8").digest("hex")}.json`;
  return join(workdir, RUNNER_CONTINUATIONS_DIR, filename);
}

export function continuationSessionId(state: RunnerContinuationState): string | null {
  const value = state.harness === "codex-sdk" ? state.thread_id : state.session_id;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readRunnerContinuation(path: string): RunnerContinuationState | null {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as RunnerContinuationState;
    if (
      state.harness !== "codex" &&
      state.harness !== "claude" &&
      state.harness !== "codex-sdk"
    ) return null;
    return continuationSessionId(state) === null ? null : state;
  } catch {
    return null;
  }
}

const CONTINUATION_LOCK_WAIT_MS = 5_000;
const CONTINUATION_LOCK_DB = ".continuation-lock.sqlite";

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const body = error as { code?: unknown; message?: unknown };
  return body.code === "SQLITE_BUSY" ||
    (typeof body.message === "string" && /database is (?:locked|busy)/i.test(body.message));
}

function isUnsupportedDirectoryFsync(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS";
}

/** Cross-process serialization for continuation read-modify-rename transactions. */
export function withRunnerContinuationLock<T>(
  path: string,
  fn: () => T,
  waitMs = CONTINUATION_LOCK_WAIT_MS,
): T {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const lockPath = join(directory, CONTINUATION_LOCK_DB);
  // Pre-create and re-chmod the database so the bearer-adjacent continuation directory never gains
  // a world-readable coordination artifact through a permissive process umask.
  const fd = openSync(lockPath, "a", 0o600);
  closeSync(fd);
  chmodSync(lockPath, 0o600);

  const db = new Database(lockPath, { create: true, strict: true });
  let transactionOpen = false;
  let committed = false;
  try {
    const boundedWaitMs = Number.isFinite(waitMs) ? Math.max(0, Math.floor(waitMs)) : CONTINUATION_LOCK_WAIT_MS;
    db.exec(`PRAGMA busy_timeout = ${boundedWaitMs}`);
    try {
      // SQLite owns the cross-process mutex. BEGIN EXCLUSIVE serializes every continuation JSON
      // transaction in this private directory; SIGKILL/abort closes the process fd and the kernel
      // releases the lock, so there is no stale PID file, reclaim mutex, or ABA unlink window.
      db.exec("BEGIN EXCLUSIVE");
      transactionOpen = true;
    } catch (error) {
      if (isSqliteBusy(error)) throw new Error(`runner continuation lock timed out: ${lockPath}`);
      throw error;
    }
    const result = fn();
    db.exec("COMMIT");
    transactionOpen = false;
    committed = true;
    return result;
  } finally {
    if (transactionOpen && !committed) {
      try { db.exec("ROLLBACK"); } catch { /* close() releases the OS lock even after I/O failure */ }
    }
    db.close(false);
  }
}

function writeRunnerContinuationUnlocked(path: string, state: RunnerContinuationState): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(state, null, 2) + "\n", "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    let directoryFd: number | null = null;
    try {
      directoryFd = openSync(directory, "r");
      fsyncSync(directoryFd);
    } catch (error) {
      // Some platforms/filesystems do not support fsync on a directory descriptor. Only that
      // explicit capability gap is safe to ignore; ENOSPC/EIO/EACCES must fail the commit.
      if (!isUnsupportedDirectoryFsync(error)) throw error;
    } finally {
      if (directoryFd !== null) closeSync(directoryFd);
    }
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

/**
 * Write a continuation with a same-directory fsync + rename commit. A crash can leave at most an
 * unreferenced .tmp file; readers either see the complete old mapping or the complete new mapping,
 * never a truncated JSON file after the work has already been parked server-side.
 */
export function writeRunnerContinuation(path: string, state: RunnerContinuationState): void {
  withRunnerContinuationLock(path, () => writeRunnerContinuationUnlocked(path, state));
}

function sameContinuationIdentity(
  current: RunnerContinuationState,
  next: RunnerContinuationState,
): boolean {
  return current.harness === next.harness &&
    continuationSessionId(current) === continuationSessionId(next) &&
    (current.work_id ?? null) === (next.work_id ?? null) &&
    (current.continuation_ref ?? null) === (next.continuation_ref ?? null);
}

/**
 * Commit runner bookkeeping without overwriting a decision/timeout marker written while the model
 * was active. The on-disk mapping is authoritative at turn completion: a different harness,
 * session, work or continuation means another writer replaced this slot, so fail closed.
 */
export function mergeRunnerContinuation(
  path: string,
  next: RunnerContinuationState,
): RunnerContinuationState {
  return withRunnerContinuationLock(path, () => {
    const current = readRunnerContinuation(path);
    if (current === null && existsSync(path)) {
      throw new Error(`runner continuation mapping is invalid: ${path}`);
    }
    if (current !== null && !sameContinuationIdentity(current, next)) {
      throw new Error(
        "runner continuation changed while the model was active; refusing stale session overwrite",
      );
    }

    const merged: RunnerContinuationState = current === null
      ? next
      : {
          ...current,
          ...next,
          ...(current.resume_blocked_reason === undefined
            ? {}
            : { resume_blocked_reason: current.resume_blocked_reason }),
          ...(current.resume_blocked_at === undefined
            ? {}
            : { resume_blocked_at: current.resume_blocked_at }),
        };
    writeRunnerContinuationUnlocked(path, merged);
    return merged;
  });
}

export function blockRunnerContinuation(path: string, reason: string, now = Date.now()): boolean {
  return withRunnerContinuationLock(path, () => {
    const state = readRunnerContinuation(path);
    if (state === null) return false;
    writeRunnerContinuationUnlocked(path, {
      ...state,
      resume_blocked_reason: reason,
      resume_blocked_at: now,
    });
    return true;
  });
}

export interface RunnerContinuationIdentity {
  harness: RunnerContinuationHarness;
  work_id: string;
  continuation_ref: string;
}

export type DeleteRunnerContinuationResult = "deleted" | "missing" | "mismatch";

/**
 * Remove one terminal work mapping under the same cross-process lock used by decision parking.
 * Identity is checked inside that lock: a bad/reused continuation_ref must never let work B delete
 * work A's still-actionable owner continuation merely because they hash to the same path.
 *
 * The shared SQLite mutex remains as one bounded directory-level coordination file; only the
 * matching per-work JSON is deleted, so completed deliveries cannot grow runner state forever.
 */
export function deleteRunnerContinuation(
  path: string,
  expected: RunnerContinuationIdentity,
): DeleteRunnerContinuationResult {
  return withRunnerContinuationLock(path, () => {
    const current = readRunnerContinuation(path);
    if (current === null) return existsSync(path) ? "mismatch" : "missing";
    if (
      current.harness !== expected.harness ||
      current.work_id !== expected.work_id ||
      current.continuation_ref !== expected.continuation_ref
    ) return "mismatch";
    rmSync(path, { force: true });
    return "deleted";
  });
}
