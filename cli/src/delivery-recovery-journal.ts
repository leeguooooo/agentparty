import type {
  DeliveryRecoverFrame,
  DeliveryRecoveryResultFrame,
  DirectedDelivery,
  MsgFrame,
} from "@agentparty/shared";
import { createHash, randomUUID } from "node:crypto";
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
import { agentpartyHome } from "./config";

export type DeliveryRecoveryPhase =
  | "claimed"
  | "running_authorized"
  | "harness_issued"
  | "harness_accepted"
  | "reply_posted"
  | "waiting_owner"
  | "failed_pending";

export interface DeliveryRecoveryEntry {
  delivery: DirectedDelivery;
  message: MsgFrame;
  phase: DeliveryRecoveryPhase;
  /** Persisted before recovery is sent, making an ACK-loss retry idempotent. */
  nextLeaseToken: string | null;
  replyBody: string | null;
  replySeq: number | null;
  /** Stable Claude claim receipt; null for adapters without a claim gate. */
  claimReceipt: string | null;
  terminalError: string | null;
  threadId: string | null;
  turnId: string | null;
  updatedAt: number;
}

export interface DeliveryRecoveryJournalOptions {
  /** Fault-injection seam. Production always executes the durable commit. */
  persist?: (commit: () => void) => void;
}

interface DeliveryRecoveryFile {
  version: 1;
  channel: string;
  bridge: "claude" | "codex";
  entries: DeliveryRecoveryEntry[];
}

const MAX_RECOVERY_ENTRIES = 64;

function unsupportedDirectoryFsync(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS";
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!unsupportedDirectoryFsync(error)) throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Commit the recovery WAL through the actual storage boundary: fsync the
 * complete same-directory temporary file, rename it, then fsync the parent
 * directory. Worker ownership is not acknowledged until this returns.
 */
function writeRecoveryJournalDurably(path: string, value: unknown): void {
  const directory = dirname(path);
  const missingDirectories: string[] = [];
  for (
    let candidate = directory;
    !existsSync(candidate) && dirname(candidate) !== candidate;
    candidate = dirname(candidate)
  ) {
    missingDirectories.push(candidate);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const created of missingDirectories) chmodSync(created, 0o700);
  chmodSync(directory, 0o700);
  // fsync every newly-created directory and its parent entry. Fsyncing only
  // the leaf directory does not make the leaf's name durable in its parent
  // after a machine crash on the first ever journal write.
  for (const created of missingDirectories) {
    fsyncDirectory(created);
    fsyncDirectory(dirname(created));
  }
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): DeliveryRecoveryEntry | null {
  if (!isRecord(value) || !isRecord(value.delivery) || !isRecord(value.message)) return null;
  const delivery = value.delivery as unknown as DirectedDelivery;
  const message = value.message as unknown as MsgFrame;
  const phases = new Set<DeliveryRecoveryPhase>([
    "claimed",
    "running_authorized",
    "harness_issued",
    "harness_accepted",
    "reply_posted",
    "waiting_owner",
    "failed_pending",
  ]);
  if (
    typeof delivery.id !== "string" ||
    !Number.isSafeInteger(delivery.attempt) ||
    delivery.attempt <= 0 ||
    !Number.isSafeInteger(delivery.lease_epoch) ||
    (delivery.lease_epoch ?? 0) <= 0 ||
    typeof delivery.lease_token !== "string" ||
    delivery.lease_token.length === 0 ||
    message.type !== "msg" ||
    !Number.isSafeInteger(message.seq) ||
    message.seq <= 0 ||
    delivery.message_seq !== message.seq ||
    !phases.has(value.phase as DeliveryRecoveryPhase) ||
    (value.nextLeaseToken !== null && typeof value.nextLeaseToken !== "string") ||
    (value.replyBody !== null && typeof value.replyBody !== "string") ||
    (value.replySeq !== null && (!Number.isSafeInteger(value.replySeq) || Number(value.replySeq) <= 0)) ||
    (
      value.claimReceipt !== undefined &&
      value.claimReceipt !== null &&
      (typeof value.claimReceipt !== "string" || value.claimReceipt.length === 0)
    ) ||
    (value.terminalError !== null && typeof value.terminalError !== "string") ||
    (value.threadId !== null && typeof value.threadId !== "string") ||
    (value.turnId !== null && typeof value.turnId !== "string") ||
    typeof value.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    ...(value as unknown as DeliveryRecoveryEntry),
    // Compatibility for journals written before the explicit Claude
    // claim/accept receipt was introduced.
    claimReceipt: typeof value.claimReceipt === "string" ? value.claimReceipt : null,
  };
}

export function deliveryRecoveryJournalPath(
  bridge: "claude" | "codex",
  server: string,
  token: string,
  channel: string,
): string {
  const principal = createHash("sha256")
    .update(server)
    .update("\0")
    .update(token)
    .update("\0")
    .update(channel)
    .digest("hex")
    .slice(0, 32);
  return join(agentpartyHome(), "delivery-recovery", `${bridge}-${channel}-${principal}.json`);
}

/**
 * A small, mode-0600 write-ahead journal for the gap between Worker ownership
 * and harness acceptance. The instance lock ensures a single normal writer;
 * atomic rename protects process and machine crashes.
 */
export class DeliveryRecoveryJournal {
  private readonly entriesById = new Map<string, DeliveryRecoveryEntry>();

  constructor(
    readonly path: string,
    readonly channel: string,
    readonly bridge: "claude" | "codex",
    private readonly options: DeliveryRecoveryJournalOptions = {},
  ) {
    if (!existsSync(path)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `could not read delivery recovery journal ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      !isRecord(raw) ||
      raw.version !== 1 ||
      raw.channel !== channel ||
      raw.bridge !== bridge ||
      !Array.isArray(raw.entries) ||
      raw.entries.length > MAX_RECOVERY_ENTRIES
    ) {
      throw new Error(`invalid delivery recovery journal ${path}`);
    }
    for (const value of raw.entries) {
      const entry = parseEntry(value);
      if (entry === null || this.entriesById.has(entry.delivery.id)) {
        throw new Error(`invalid delivery recovery journal entry in ${path}`);
      }
      this.entriesById.set(entry.delivery.id, entry);
    }
  }

  entries(): DeliveryRecoveryEntry[] {
    return [...this.entriesById.values()]
      .sort((left, right) => left.message.seq - right.message.seq)
      .map((entry) => structuredClone(entry));
  }

  get(deliveryId: string): DeliveryRecoveryEntry | null {
    const entry = this.entriesById.get(deliveryId);
    return entry === undefined ? null : structuredClone(entry);
  }

  recordClaim(delivery: DirectedDelivery, message: MsgFrame): DeliveryRecoveryEntry {
    if (
      delivery.state !== "claimed" ||
      delivery.message_seq !== message.seq ||
      delivery.lease_epoch === undefined ||
      delivery.lease_epoch <= 0 ||
      delivery.lease_token === undefined ||
      delivery.lease_token.length === 0
    ) {
      throw new Error(`delivery ${delivery.id} is not a valid claimed message assignment`);
    }
    const current = this.entriesById.get(delivery.id);
    if (current !== undefined) {
      const sameLogicalDelivery =
        current.delivery.message_seq === delivery.message_seq &&
        current.delivery.target_name === delivery.target_name &&
        current.delivery.cause === delivery.cause &&
        current.delivery.work_id === delivery.work_id &&
        current.delivery.continuation_ref === delivery.continuation_ref &&
        current.delivery.created_at === delivery.created_at &&
        JSON.stringify(current.message) === JSON.stringify(message);
      if (!sameLogicalDelivery) {
        throw new Error(`delivery ${delivery.id} changed logical identity while recovery debt exists`);
      }
      if (
        current.delivery.attempt !== delivery.attempt ||
        current.delivery.lease_epoch !== delivery.lease_epoch
      ) {
        if (
          current.phase === "claimed" &&
          delivery.attempt > current.delivery.attempt &&
          (delivery.lease_epoch ?? 0) > (current.delivery.lease_epoch ?? 0)
        ) {
          const replacement: DeliveryRecoveryEntry = {
            delivery: structuredClone(delivery),
            message: structuredClone(message),
            phase: "claimed",
            nextLeaseToken: null,
            replyBody: null,
            replySeq: null,
            claimReceipt: null,
            terminalError: null,
            threadId: null,
            turnId: null,
            updatedAt: Date.now(),
          };
          const nextEntries = new Map(this.entriesById);
          nextEntries.set(delivery.id, replacement);
          this.persistSnapshot(nextEntries);
          this.entriesById.set(delivery.id, replacement);
          return structuredClone(replacement);
        }
        throw new Error(`delivery ${delivery.id} changed assignment while recovery debt exists`);
      }
      if (current.delivery.lease_token !== delivery.lease_token) {
        throw new Error(`delivery ${delivery.id} changed lease token without recovery acknowledgement`);
      }
      return structuredClone(current);
    }
    if (this.entriesById.size >= MAX_RECOVERY_ENTRIES) {
      throw new Error(`delivery recovery journal exceeded ${MAX_RECOVERY_ENTRIES} active entries`);
    }
    const entry: DeliveryRecoveryEntry = {
      delivery: structuredClone(delivery),
      message: structuredClone(message),
      phase: "claimed",
      nextLeaseToken: null,
      replyBody: null,
      replySeq: null,
      claimReceipt: null,
      terminalError: null,
      threadId: null,
      turnId: null,
      updatedAt: Date.now(),
    };
    const nextEntries = new Map(this.entriesById);
    nextEntries.set(delivery.id, entry);
    this.persistSnapshot(nextEntries);
    this.entriesById.set(delivery.id, entry);
    return structuredClone(entry);
  }

  update(
    deliveryId: string,
    patch: Partial<Omit<DeliveryRecoveryEntry, "delivery" | "message">> & {
      delivery?: DirectedDelivery;
    },
  ): DeliveryRecoveryEntry {
    const current = this.entriesById.get(deliveryId);
    if (current === undefined) throw new Error(`no recovery journal entry for ${deliveryId}`);
    const next: DeliveryRecoveryEntry = {
      ...current,
      ...patch,
      delivery: patch.delivery === undefined ? current.delivery : structuredClone(patch.delivery),
      message: current.message,
      updatedAt: Date.now(),
    };
    const nextEntries = new Map(this.entriesById);
    nextEntries.set(deliveryId, next);
    this.persistSnapshot(nextEntries);
    this.entriesById.set(deliveryId, next);
    return structuredClone(next);
  }

  prepareRecovery(
    deliveryId: string,
    options: {
      replaySafe?: boolean;
      /**
       * Recovery decisions are made from an immutable journal snapshot. The
       * exact phase/revision fence prevents a stale lane from publishing
       * replay_safe after another callback has crossed the harness boundary.
       */
      expected?: {
        phase: DeliveryRecoveryPhase;
        updatedAt: number;
        attempt: number;
        leaseEpoch: number;
        leaseToken: string;
      };
    } = {},
  ): DeliveryRecoverFrame {
    const current = this.entriesById.get(deliveryId);
    if (current === undefined) throw new Error(`no recovery journal entry for ${deliveryId}`);
    const leaseEpoch = current.delivery.lease_epoch;
    const leaseToken = current.delivery.lease_token;
    if (leaseEpoch === undefined || leaseToken === undefined) {
      throw new Error(`delivery ${deliveryId} omitted reconnect ownership`);
    }
    const expected = options.expected;
    if (
      expected !== undefined &&
      (
        current.phase !== expected.phase ||
        current.updatedAt !== expected.updatedAt ||
        current.delivery.attempt !== expected.attempt ||
        leaseEpoch !== expected.leaseEpoch ||
        leaseToken !== expected.leaseToken
      )
    ) {
      throw new Error(`delivery ${deliveryId} changed while recovery was being prepared`);
    }
    if (options.replaySafe === true && expected === undefined) {
      throw new Error(`replay-safe recovery for ${deliveryId} requires an exact journal snapshot`);
    }
    const nextLeaseToken = current.nextLeaseToken ?? randomUUID();
    if (current.nextLeaseToken === null) {
      const next = {
        ...current,
        nextLeaseToken,
        updatedAt: Date.now(),
      };
      const nextEntries = new Map(this.entriesById);
      nextEntries.set(deliveryId, next);
      this.persistSnapshot(nextEntries);
      this.entriesById.set(deliveryId, next);
    }
    return {
      type: "delivery_recover",
      delivery_id: deliveryId,
      request_id: randomUUID(),
      attempt: current.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: leaseToken,
      next_lease_token: nextLeaseToken,
      ...(options.replaySafe === true ? { replay_safe: true as const } : {}),
    };
  }

  acceptRecovery(frame: DeliveryRecoveryResultFrame): DeliveryRecoveryEntry {
    const current = this.entriesById.get(frame.delivery_id);
    if (
      frame.result !== "recovered" ||
      frame.lease_token === undefined ||
      frame.lease_until === undefined ||
      current === undefined ||
      current.delivery.attempt !== frame.attempt ||
      current.delivery.lease_epoch !== frame.lease_epoch ||
      current.nextLeaseToken !== frame.lease_token
    ) {
      throw new Error(`delivery recovery acknowledgement does not match ${frame.delivery_id}`);
    }
    const next: DeliveryRecoveryEntry = {
      ...current,
      delivery: {
        ...current.delivery,
        state: frame.state,
        lease_token: frame.lease_token,
        lease_until: frame.lease_until,
      },
      nextLeaseToken: null,
      // Ownership recovery rotates the Worker bearer token, not the logical
      // harness invocation. Preserve an unaccepted receipt so a claim whose
      // MCP response was delayed/lost can be fetched or accepted idempotently
      // after websocket or process recovery. A genuinely new attempt gets a
      // fresh entry/receipt through recordClaim instead.
      claimReceipt: current.claimReceipt,
      updatedAt: Date.now(),
    };
    const nextEntries = new Map(this.entriesById);
    nextEntries.set(frame.delivery_id, next);
    this.persistSnapshot(nextEntries);
    this.entriesById.set(frame.delivery_id, next);
    return structuredClone(next);
  }

  remove(deliveryId: string): void {
    this.removeMany([deliveryId]);
  }

  /** Atomically clear related obligations (for example owner answer + source binding). */
  removeMany(deliveryIds: readonly string[]): void {
    const unique = new Set(deliveryIds);
    if (![...unique].some((deliveryId) => this.entriesById.has(deliveryId))) return;
    const nextEntries = new Map(this.entriesById);
    for (const deliveryId of unique) nextEntries.delete(deliveryId);
    this.persistSnapshot(nextEntries);
    for (const deliveryId of unique) this.entriesById.delete(deliveryId);
  }

  /**
   * Persist a complete prospective snapshot before publishing it in memory.
   * Every caller therefore has transaction-like failure semantics: an I/O
   * error leaves entriesById unchanged and a retry must cross the durability
   * boundary again before any recovery frame can be returned.
   */
  private persistSnapshot(entries: Map<string, DeliveryRecoveryEntry>): void {
    const commit = () => {
      if (entries.size === 0) {
        rmSync(this.path, { force: true });
        if (existsSync(dirname(this.path))) fsyncDirectory(dirname(this.path));
        return;
      }
      const file: DeliveryRecoveryFile = {
        version: 1,
        channel: this.channel,
        bridge: this.bridge,
        entries: [...entries.values()].sort(
          (left, right) => left.message.seq - right.message.seq,
        ),
      };
      writeRecoveryJournalDurably(this.path, file);
    };
    if (this.options.persist) this.options.persist(commit);
    else commit();
  }
}
