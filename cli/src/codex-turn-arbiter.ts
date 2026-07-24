/**
 * Single-writer input arbiter for a Codex app-server session.
 *
 * Codex 0.144.x permits multiple clients to `thread/resume` the same running
 * thread, but that does not make concurrent writers safe: `turn/start`
 * replaces/aborts the active task. Every TUI and AgentParty input must therefore
 * pass through one proxy-owned arbiter. This module is the protocol core for
 * that proxy and deliberately exposes no "optimistic start" operation.
 */

export interface CodexTextInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface CodexTurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: CodexTextInput[];
  responsesapiClientMetadata?: Record<string, string> | null;
}

export interface CodexTurnSteerParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: CodexTextInput[];
  responsesapiClientMetadata?: Record<string, string> | null;
  /** Required compare-and-swap precondition in Codex app-server 0.144.x. */
  expectedTurnId: string;
}

export interface CodexTurnTransport {
  turnStart(params: CodexTurnStartParams): Promise<{ turn: { id: string } }>;
  turnSteer(params: CodexTurnSteerParams): Promise<{ turnId: string }>;
}

export type CodexUnsteerableState = "review" | "compact" | "shell" | "unknown";
export type CodexArbiterPhase =
  | { type: "idle" }
  | { type: "normal"; turnId: string }
  | { type: CodexUnsteerableState; turnId: string | null };
type CodexShellBasePhase =
  | { type: "idle" }
  | { type: "normal"; turnId: string }
  | { type: "review" | "compact"; turnId: string | null };

interface CodexShellLifecycle {
  basePhase: CodexShellBasePhase;
  baseTurnId: string | null;
  baseCompleted: boolean;
  baselineItemIds: ReadonlySet<string>;
  requestOutcome: "pending" | "accepted" | "uncertain";
  standaloneTurnId: string | null;
  standaloneCompleted: boolean;
  itemId: string | null;
  itemTurnId: string | null;
  itemCompleted: boolean;
  itemAborted: boolean;
}

export interface CodexBridgeInput {
  text: string;
  /**
   * Durable proxy-owned command id, e.g. `agentparty:<delivery-id>`.
   * Codex stores this as ThreadItem.userMessage.clientId but does NOT dedupe it;
   * the arbiter journal below owns deduplication.
   */
  clientUserMessageId: string;
  metadata?: Record<string, string>;
  /**
   * Durable write-ahead boundary owned by the delivery ledger. It runs in the
   * single-writer lane immediately before turn/start or turn/steer can write.
   */
  beforeWrite?: () => void | Promise<void>;
  /**
   * Synchronous final ownership fence, called after awaited WAL preparation
   * and immediately before invoking the transport write.
   */
  checkWriteAuthorized?: () => void;
  /** Roll the WAL back to replay-safe when transport proves no input was accepted. */
  onWriteRejected?: () => void | Promise<void>;
}

export interface CodexDispatch {
  kind: "started" | "steered" | "queued" | "uncertain" | "duplicate";
  turnId?: string;
  queuePosition?: number;
  reason?: CodexUnsteerableState | "steer_rejected" | "start_rejected" | "unknown_outcome";
}

interface QueuedInput {
  id: number;
  input: CodexBridgeInput;
  reason: CodexDispatch["reason"];
}

export type CodexInteractiveMutation =
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt"
  | "review/start"
  | "thread/compact/start"
  | "thread/shellCommand";

export class CodexBridgeQueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`Codex session bridge queue is full (${limit})`);
    this.name = "CodexBridgeQueueFullError";
  }
}

/** A local pre-write durability/fence failure that is safe to retry. */
export class CodexRetryableBeforeWriteError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "CodexRetryableBeforeWriteError";
  }
}

export class CodexInteractiveMutationBlockedError extends Error {
  readonly code = -32_000;
  readonly data: {
    codexBridgeInfo: {
      type: "interactiveMutationBlocked";
      method: CodexInteractiveMutation;
      reason: "phase_not_idle" | "uncertain_outcome";
      phase: CodexArbiterPhase;
      uncertainCount: number;
    };
  };

  constructor(
    method: CodexInteractiveMutation,
    reason: "phase_not_idle" | "uncertain_outcome",
    phase: CodexArbiterPhase,
    uncertainCount: number,
  ) {
    super(
      reason === "uncertain_outcome"
        ? `Codex ${method} is blocked until an uncertain delivery is reconciled`
        : `Codex ${method} is blocked while the authoritative phase is ${phase.type}`,
    );
    this.name = "CodexInteractiveMutationBlockedError";
    this.data = {
      codexBridgeInfo: {
        type: "interactiveMutationBlocked",
        method,
        reason,
        phase: { ...phase },
        uncertainCount,
      },
    };
  }
}

export interface CodexTurnArbiterOptions {
  maxQueue?: number;
  onQueuedDispatch?: (entry: {
    id: number;
    input: CodexBridgeInput;
    dispatch: CodexDispatch;
  }) => void | Promise<void>;
  onQueuedError?: (entry: {
    input: CodexBridgeInput;
    error: unknown;
  }) => void | Promise<void>;
}

function asTextInput(text: string): CodexTextInput {
  return { type: "text", text, text_elements: [] };
}

function compactInput(input: CodexBridgeInput): CodexBridgeInput {
  const text = input.text.trim();
  if (text.length === 0) throw new Error("Codex bridge input must not be empty");
  return {
    text,
    clientUserMessageId: input.clientUserMessageId,
    ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
    ...(input.beforeWrite === undefined ? {} : { beforeWrite: input.beforeWrite }),
    ...(input.checkWriteAuthorized === undefined
      ? {}
      : { checkWriteAuthorized: input.checkWriteAuthorized }),
    ...(input.onWriteRejected === undefined ? {} : { onWriteRejected: input.onWriteRejected }),
  };
}

type JournalState = "queued" | "accepted" | "abandoned" | "uncertain";

function rpcErrorData(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { data?: unknown }).data;
  if (direct !== undefined) return direct;
  return (error as { error?: { data?: unknown } }).error?.data;
}

/** Parse the structured app-server error; never depend on localized text. */
export function nonSteerableTurnKind(error: unknown): "review" | "compact" | null {
  const data = rpcErrorData(error);
  if (typeof data !== "object" || data === null) return null;
  const info = (data as { codexErrorInfo?: unknown }).codexErrorInfo;
  if (typeof info !== "object" || info === null) return null;
  const active = (info as { activeTurnNotSteerable?: unknown }).activeTurnNotSteerable;
  if (typeof active !== "object" || active === null) return null;
  const kind = (active as { turnKind?: unknown }).turnKind;
  return kind === "review" || kind === "compact" ? kind : null;
}

/** A numeric JSON-RPC code proves app-server returned a rejection. */
function isDefinitiveRpcRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (typeof (error as { code?: unknown }).code === "number") return true;
  return typeof (error as { error?: { code?: unknown } }).error?.code === "number";
}

/** The controller/RPC layer can prove a disconnect happened before any write. */
function isProvenNotWritten(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    (error as { codexBridgeRequestWritten?: unknown }).codexBridgeRequestWritten === false;
}

/**
 * All mutating methods are serialized through `exclusive`. The transport call
 * happens while holding that lane, so two callers can never both observe idle
 * and issue `turn/start`.
 */
export class CodexTurnArbiter {
  private phase: CodexArbiterPhase = { type: "unknown", turnId: null };
  private readonly queue: QueuedInput[] = [];
  private nextQueueId = 1;
  private exclusive: Promise<void> = Promise.resolve();
  private readonly maxQueue: number;
  private readonly journal = new Map<string, JournalState>();
  private readonly uncertainInputs = new Map<string, CodexBridgeInput>();
  private readonly rollbackDebts = new Map<string, () => Promise<void>>();
  private readonly observedUserShellItemIds = new Set<string>();
  private shellLifecycle: CodexShellLifecycle | null = null;
  private flushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushRetryAttempt = 0;

  constructor(
    private readonly threadId: string,
    private readonly transport: CodexTurnTransport,
    private readonly options: CodexTurnArbiterOptions = {},
  ) {
    this.maxQueue = options.maxQueue ?? 128;
    if (!Number.isSafeInteger(this.maxQueue) || this.maxQueue <= 0) {
      throw new Error("maxQueue must be a positive integer");
    }
  }

  snapshot(): { phase: CodexArbiterPhase; queueDepth: number; uncertainCount: number } {
    return {
      phase: { ...this.phase },
      queueDepth: this.queue.length,
      uncertainCount: this.uncertainCount(),
    };
  }

  /**
   * Snapshot the writes whose transport outcome is still unknown. Callers must
   * only use this after an authoritative resume + full thread/read scan: an
   * absent client id is not proof that the original write had no side effects.
   */
  unresolvedUnknownInputs(): CodexBridgeInput[] {
    return [...this.uncertainInputs.values()].map((input) => ({
      ...input,
      ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
    }));
  }

  private uncertainCount(): number {
    return [...this.journal.values()].filter((state) => state === "uncertain").length;
  }

  private hasUncertainOutcome(): boolean {
    return this.uncertainCount() > 0;
  }

  private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.exclusive.then(operation, operation);
    this.exclusive = run.then(() => {}, () => {});
    return run;
  }

  private enqueue(input: CodexBridgeInput, reason: QueuedInput["reason"]): CodexDispatch {
    const existing = this.journal.get(input.clientUserMessageId);
    if (existing === "accepted" || existing === "abandoned") return { kind: "duplicate" };
    if (existing === "uncertain") return { kind: "uncertain", reason: "unknown_outcome" };
    if (existing === "queued") {
      const index = this.queue.findIndex((entry) =>
        entry.input.clientUserMessageId === input.clientUserMessageId
      );
      return { kind: "queued", queuePosition: index < 0 ? undefined : index + 1, reason };
    }
    if (this.queue.length >= this.maxQueue) throw new CodexBridgeQueueFullError(this.maxQueue);
    this.queue.push({ id: this.nextQueueId++, input, reason });
    this.journal.set(input.clientUserMessageId, "queued");
    return {
      kind: "queued",
      queuePosition: this.queue.length,
      reason,
    };
  }

  private startParams(input: CodexBridgeInput): CodexTurnStartParams {
    return {
      threadId: this.threadId,
      input: [asTextInput(input.text)],
      clientUserMessageId: input.clientUserMessageId,
      ...(input.metadata === undefined ? {} : { responsesapiClientMetadata: input.metadata }),
    };
  }

  private steerParams(input: CodexBridgeInput, expectedTurnId: string): CodexTurnSteerParams {
    return {
      threadId: this.threadId,
      input: [asTextInput(input.text)],
      expectedTurnId,
      clientUserMessageId: input.clientUserMessageId,
      ...(input.metadata === undefined ? {} : { responsesapiClientMetadata: input.metadata }),
    };
  }

  private async start(input: CodexBridgeInput): Promise<CodexDispatch> {
    // Move out of idle before awaiting I/O. The serialize lane already prevents
    // another writer, and unknown is fail-closed if an observer reads state.
    this.phase = { type: "unknown", turnId: null };
    let prepared = false;
    try {
      await this.settleRollbackDebt(input);
      await input.beforeWrite?.();
      prepared = true;
      input.checkWriteAuthorized?.();
    } catch (error) {
      this.phase = { type: "idle" };
      if (error instanceof CodexRetryableBeforeWriteError) {
        if (prepared) {
          try {
            await input.onWriteRejected?.();
          } catch {
            this.registerRollbackDebt(input);
          }
        }
        const dispatch = this.enqueue(input, "start_rejected");
        const entry = this.queue.find((queued) =>
          queued.input.clientUserMessageId === input.clientUserMessageId
        );
        if (entry) this.notifyQueuedError(entry, error);
        this.scheduleFlushRetry();
        return dispatch;
      }
      throw error;
    }
    try {
      const response = await this.transport.turnStart(this.startParams(input));
      this.phase = { type: "normal", turnId: response.turn.id };
      this.journal.set(input.clientUserMessageId, "accepted");
      this.uncertainInputs.delete(input.clientUserMessageId);
      return { kind: "started", turnId: response.turn.id };
    } catch (error) {
      this.phase = { type: "unknown", turnId: null };
      if (isDefinitiveRpcRejection(error) || isProvenNotWritten(error)) {
        // The transport proved no write occurred. Restore idle before the WAL
        // rollback callback: if that local commit fails, the queued-flush
        // retry lane can safely attempt the same input again.
        this.phase = { type: "idle" };
        try {
          await input.onWriteRejected?.();
        } catch {
          // The app-server proved the request was not written, but replay must
          // not happen until the delivery WAL also durably rolls back. Make
          // that rollback the first step of the queued write boundary.
          this.registerRollbackDebt(input);
        }
        const dispatch = this.enqueue(input, "start_rejected");
        // There may be no later backend notification after a definitive
        // pre-acceptance rejection. Keep the replay-safe input live on the
        // bounded retry lane instead of leaving an idle arbiter permanently
        // wedged with queued work.
        this.scheduleFlushRetry();
        return dispatch;
      }
      // Network close/timeout has an unknown outcome. Codex does not dedupe
      // clientUserMessageId, so never retry until a resume/read reconciliation
      // proves whether ThreadItem.userMessage.clientId exists.
      this.journal.set(input.clientUserMessageId, "uncertain");
      this.uncertainInputs.set(input.clientUserMessageId, input);
      return { kind: "uncertain", reason: "unknown_outcome" };
    }
  }

  private async steer(input: CodexBridgeInput, expectedTurnId: string): Promise<CodexDispatch> {
    let prepared = false;
    try {
      await this.settleRollbackDebt(input);
      await input.beforeWrite?.();
      prepared = true;
      input.checkWriteAuthorized?.();
    } catch (error) {
      if (error instanceof CodexRetryableBeforeWriteError) {
        if (prepared) {
          try {
            await input.onWriteRejected?.();
          } catch {
            this.registerRollbackDebt(input);
          }
        }
        const dispatch = this.enqueue(input, "steer_rejected");
        const entry = this.queue.find((queued) =>
          queued.input.clientUserMessageId === input.clientUserMessageId
        );
        if (entry) this.notifyQueuedError(entry, error);
        this.scheduleFlushRetry();
        return dispatch;
      }
      throw error;
    }
    try {
      const response = await this.transport.turnSteer(this.steerParams(input, expectedTurnId));
      // A valid response retains the same active turn. Do not accept a response
      // as authority to change the CAS id; turn/started is the authority.
      this.phase = { type: "normal", turnId: expectedTurnId };
      this.journal.set(input.clientUserMessageId, "accepted");
      this.uncertainInputs.delete(input.clientUserMessageId);
      return { kind: "steered", turnId: response.turnId };
    } catch (error) {
      const turnKind = nonSteerableTurnKind(error);
      if (turnKind !== null) {
        this.phase = { type: turnKind, turnId: expectedTurnId };
        try {
          await input.onWriteRejected?.();
        } catch {
          this.registerRollbackDebt(input);
        }
        const dispatch = this.enqueue(input, turnKind);
        if (this.rollbackDebts.has(input.clientUserMessageId)) this.scheduleFlushRetry();
        return dispatch;
      }
      if (!isDefinitiveRpcRejection(error) && !isProvenNotWritten(error)) {
        this.phase = { type: "unknown", turnId: null };
        this.journal.set(input.clientUserMessageId, "uncertain");
        this.uncertainInputs.set(input.clientUserMessageId, input);
        return { kind: "uncertain", reason: "unknown_outcome" };
      }
      try {
        await input.onWriteRejected?.();
      } catch {
        this.registerRollbackDebt(input);
      }
      // A stale expectedTurnId or a currently non-steerable server state must
      // never fall through to turn/start: that would abort/replace real work.
      this.phase = { type: "unknown", turnId: null };
      const dispatch = this.enqueue(input, "steer_rejected");
      if (this.rollbackDebts.has(input.clientUserMessageId)) this.scheduleFlushRetry();
      return dispatch;
    }
  }

  private registerRollbackDebt(input: CodexBridgeInput): void {
    this.rollbackDebts.set(input.clientUserMessageId, async () => {
      await input.onWriteRejected?.();
    });
  }

  private async settleRollbackDebt(input: CodexBridgeInput): Promise<void> {
    const rollback = this.rollbackDebts.get(input.clientUserMessageId);
    if (!rollback) return;
    try {
      await rollback();
      this.rollbackDebts.delete(input.clientUserMessageId);
    } catch (error) {
      throw new CodexRetryableBeforeWriteError(
        `Codex delivery WAL rollback is still pending: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  async submit(input: CodexBridgeInput): Promise<CodexDispatch> {
    const normalized = compactInput(input);
    return await this.serialize(async () => {
      const journal = this.journal.get(normalized.clientUserMessageId);
      if (journal === "accepted" || journal === "abandoned") return { kind: "duplicate" };
      if (journal === "uncertain") return { kind: "uncertain", reason: "unknown_outcome" };
      if (journal === "queued") return this.enqueue(normalized, "steer_rejected");
      if (this.queue.length > 0) {
        const reason = this.phase.type === "idle"
          ? "start_rejected"
          : this.phase.type === "normal"
            ? "steer_rejected"
            : this.phase.type;
        const dispatch = this.enqueue(normalized, reason);
        if (this.phase.type === "idle" || this.phase.type === "normal") {
          this.scheduleFlushRetry();
        }
        return dispatch;
      }
      // A transport-unknown write may already have changed the upstream turn.
      // Until every such journal entry has positive reconciliation, no later
      // input may start or steer. Retain it in the bounded queue instead.
      if (this.hasUncertainOutcome()) return this.enqueue(normalized, "unknown_outcome");
      if (this.phase.type === "idle") return await this.start(normalized);
      if (this.phase.type === "normal") return await this.steer(normalized, this.phase.turnId);
      return this.enqueue(normalized, this.phase.type);
    });
  }

  /**
   * Remove an input only while it is still locally queued and therefore has
   * not crossed the app-server write boundary. Accepted/uncertain writes are
   * deliberately immutable here because cancelling either would manufacture
   * a false negative about upstream execution.
   */
  async cancelQueued(clientUserMessageId: string): Promise<boolean> {
    return await this.serialize(() => {
      if (this.journal.get(clientUserMessageId) !== "queued") return false;
      const index = this.queue.findIndex((entry) =>
        entry.input.clientUserMessageId === clientUserMessageId
      );
      if (index < 0) return false;
      this.queue.splice(index, 1);
      this.journal.delete(clientUserMessageId);
      this.rollbackDebts.delete(clientUserMessageId);
      if (this.queue.length === 0 && this.flushRetryTimer !== null) {
        clearTimeout(this.flushRetryTimer);
        this.flushRetryTimer = null;
        this.flushRetryAttempt = 0;
      }
      return true;
    });
  }

  /**
   * Called by the proxy before forwarding review/start or
   * thread/compact/start. AgentParty inputs are bounded-queued until an
   * authoritative idle/completed event arrives.
   */
  async enterUnsteerable(state: "review" | "compact", turnId: string | null = null): Promise<void> {
    await this.serialize(() => {
      this.shellLifecycle = null;
      this.phase = { type: state, turnId };
    });
  }

  /**
   * Route interactive TUI mutations through the same exclusive lane as
   * AgentParty input. Merely serializing bytes is insufficient: a TUI
   * `turn/start` must move the phase away from idle before the RPC write, or a
   * concurrent AgentParty submission could also decide to start and replace it.
   */
  async runInteractiveMutation<T>(
    method: CodexInteractiveMutation,
    params: Record<string, unknown>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.serialize(async () => {
      if (this.rollbackDebts.size > 0) {
        const rollbackReady = await this.flushRollbackDebts();
        if (!rollbackReady) {
          this.scheduleFlushRetry();
          throw new CodexRetryableBeforeWriteError(
            "Codex delivery WAL rollback must finish before another interactive write",
          );
        }
      }
      const previous = this.phase;
      const previousShellLifecycle = this.shellLifecycle;
      if (this.hasUncertainOutcome()) {
        throw new CodexInteractiveMutationBlockedError(
          method,
          "uncertain_outcome",
          previous,
          this.uncertainCount(),
        );
      }
      // app-server's turn/start replaces an active task. Only an authoritative
      // idle phase permits forwarding it; all other phases fail locally
      // without invoking the upstream operation.
      if (method === "turn/start" && previous.type !== "idle") {
        throw new CodexInteractiveMutationBlockedError(
          method,
          "phase_not_idle",
          previous,
          0,
        );
      }
      if (
        (previous.type === "shell" && method !== "turn/interrupt") ||
        (method === "thread/shellCommand" &&
          (previous.type === "shell" || previous.type === "unknown"))
      ) {
        throw new CodexInteractiveMutationBlockedError(
          method,
          "phase_not_idle",
          previous,
          0,
        );
      }
      if (method === "turn/start" || method === "turn/interrupt") {
        this.shellLifecycle = null;
        this.phase = { type: "unknown", turnId: previous.type === "idle" ? null : previous.turnId };
      } else if (method === "review/start" && params.delivery !== "detached") {
        this.shellLifecycle = null;
        this.phase = {
          type: "review",
          turnId: previous.type === "idle" ? null : previous.turnId,
        };
      } else if (method === "thread/compact/start") {
        this.shellLifecycle = null;
        this.phase = {
          type: "compact",
          turnId: previous.type === "idle" ? null : previous.turnId,
        };
      } else if (method === "thread/shellCommand") {
        let basePhase: CodexShellBasePhase;
        if (previous.type === "idle") {
          basePhase = { type: "idle" };
        } else if (previous.type === "normal") {
          basePhase = { type: "normal", turnId: previous.turnId };
        } else if (previous.type === "review" || previous.type === "compact") {
          basePhase = { type: previous.type, turnId: previous.turnId };
        } else {
          throw new CodexInteractiveMutationBlockedError(
            method,
            "phase_not_idle",
            previous,
            0,
          );
        }
        this.shellLifecycle = {
          basePhase,
          baseTurnId: "turnId" in basePhase ? basePhase.turnId : null,
          baseCompleted: basePhase.type === "idle",
          baselineItemIds: new Set(this.observedUserShellItemIds),
          requestOutcome: "pending",
          standaloneTurnId: null,
          standaloneCompleted: false,
          itemId: null,
          itemTurnId: null,
          itemCompleted: false,
          itemAborted: false,
        };
        this.phase = {
          type: "shell",
          turnId: "turnId" in basePhase ? basePhase.turnId : null,
        };
      }

      try {
        const response = await operation();
        if (method === "turn/start") {
          const turnId = responseTurnId(response);
          this.phase = turnId === null
            ? { type: "unknown", turnId: null }
            : { type: "normal", turnId };
          if (turnId !== null) await this.flushIntoNormalTurn();
        } else if (method === "turn/steer") {
          const expected = typeof params.expectedTurnId === "string" ? params.expectedTurnId : null;
          const turnId = responseTurnId(response) ?? expected;
          this.phase = turnId === null
            ? { type: "unknown", turnId: null }
            : { type: "normal", turnId };
          if (turnId !== null) await this.flushIntoNormalTurn();
        } else if (method === "review/start" && params.delivery !== "detached") {
          const turnId = responseTurnId(response);
          this.phase = { type: "review", turnId };
        } else if (method === "thread/shellCommand" && this.shellLifecycle) {
          this.shellLifecycle.requestOutcome = "accepted";
        }
        return response;
      } catch (error) {
        const turnKind = nonSteerableTurnKind(error);
        if (error instanceof CodexRetryableBeforeWriteError) {
          this.phase = previous;
          this.shellLifecycle = previousShellLifecycle;
        } else if (isProvenNotWritten(error)) {
          this.phase = previous;
          this.shellLifecycle = previousShellLifecycle;
        } else if (
          method === "thread/shellCommand" &&
          isDefinitiveRpcRejection(error)
        ) {
          this.phase = previous;
          this.shellLifecycle = previousShellLifecycle;
        } else if (method === "thread/shellCommand" && this.shellLifecycle) {
          // The operation may already be queued in core even though its RPC
          // response was lost. Preserve the exact shell lifecycle across
          // recovery; projecting an in-progress shell turn as normal would let
          // AgentParty steer into a task that never runs the model.
          this.shellLifecycle.requestOutcome = "uncertain";
        } else if (turnKind !== null) {
          this.shellLifecycle = null;
          this.phase = {
            type: turnKind,
            turnId: previous.type === "idle" ? null : previous.turnId,
          };
        } else if (
          isDefinitiveRpcRejection(error) &&
          (
            method === "review/start" ||
            method === "thread/compact/start"
          )
        ) {
          // A rejected review/compact request never entered the special turn;
          // restore the phase observed while holding the same writer lane.
          this.phase = previous;
          this.shellLifecycle = previousShellLifecycle;
        } else {
          // A start/steer/interrupt rejection can prove our turn snapshot
          // stale, while a transport close has an unknown outcome. Both must
          // resync before any new start is allowed.
          this.shellLifecycle = null;
          this.phase = { type: "unknown", turnId: null };
        }
        throw error;
      }
    });
  }

  /**
   * Bootstrap from thread/resume. A running thread is steerable only when the
   * response includes exactly one identifiable in-progress turn. "active" by
   * itself is insufficient and remains fail-closed.
   */
  async observeResume(response: {
    thread: {
      status: { type: "idle" | "active" | "notLoaded" | "systemError" };
      turns: Array<{
        id: string;
        status: "completed" | "interrupted" | "failed" | "inProgress";
        items?: Array<{
          type: string;
          id?: string;
          clientId?: string | null;
          source?: string;
          status?: string;
        }>;
      }>;
    };
  }, options: { backendRestarted?: boolean } = {}): Promise<void> {
    await this.serialize(async () => {
      const acceptedClientIds = response.thread.turns.flatMap((turn) =>
          (turn.items ?? [])
            .filter((item) => item.type === "userMessage" && typeof item.clientId === "string")
            .map((item) => item.clientId as string)
        );
      const userShellItems = response.thread.turns.flatMap((turn) =>
        (turn.items ?? []).flatMap((item) =>
          item.type === "commandExecution" &&
            item.source === "userShell" &&
            typeof item.id === "string"
            ? [{
              itemId: item.id,
              itemStatus: item.status,
              turnId: turn.id,
              turnStatus: turn.status,
            }]
            : []
        )
      );
      this.reconcileAcceptedClientIds(acceptedClientIds);
      if (this.shellLifecycle) {
        const shell = this.shellLifecycle;
        const historyMatch = shell.itemId === null
          ? (() => {
            const candidates = userShellItems.filter((item) =>
              !shell.baselineItemIds.has(item.itemId)
            );
            return candidates.length === 1 ? candidates[0]! : null;
          })()
          : userShellItems.find((item) =>
            item.itemId === shell.itemId && item.turnId === shell.itemTurnId
          ) ?? null;
        if (historyMatch !== null) {
          if (shell.itemId === null) {
            shell.itemId = historyMatch.itemId;
            shell.itemTurnId = historyMatch.turnId;
            if (shell.basePhase.type === "idle") {
              shell.standaloneTurnId ??= historyMatch.turnId;
            } else if (shell.baseTurnId === null) {
              shell.baseTurnId = historyMatch.turnId;
            } else if (shell.baseTurnId !== historyMatch.turnId) {
              shell.standaloneTurnId ??= historyMatch.turnId;
            }
          }
          if (
            historyMatch.itemStatus === "completed" ||
            historyMatch.itemStatus === "failed" ||
            historyMatch.itemStatus === "declined"
          ) {
            shell.itemCompleted = true;
          }
          if (historyMatch.turnStatus !== "inProgress") {
            if (shell.standaloneTurnId === historyMatch.turnId) {
              shell.standaloneCompleted = true;
            } else if (shell.baseTurnId === historyMatch.turnId) {
              shell.baseCompleted = true;
            }
          }
        }
        if (
          historyMatch === null &&
          shell.itemId !== null &&
          shell.itemTurnId !== null &&
          options.backendRestarted === true &&
          response.thread.status.type === "idle"
        ) {
          const rememberedTurn = response.thread.turns.find((turn) =>
            turn.id === shell.itemTurnId
          );
          if (rememberedTurn && rememberedTurn.status !== "inProgress") {
            // Codex 0.144.x history is intentionally lossy for user-shell
            // commandExecution items. After an app-server crash, a started
            // shell can rehydrate as an interrupted/failed turn with
            // itemsView=full but no command item. The exact terminal turn plus
            // authoritative idle proves the shell can no longer own a writer;
            // record it as aborted (never successful) and release the fence.
            shell.itemCompleted = true;
            shell.itemAborted = true;
            if (shell.standaloneTurnId === rememberedTurn.id) {
              shell.standaloneCompleted = true;
            } else if (shell.baseTurnId === rememberedTurn.id) {
              shell.baseCompleted = true;
            }
          }
        }
        for (const item of userShellItems) this.observedUserShellItemIds.add(item.itemId);
        if (response.thread.status.type === "idle") {
          // A reconnect can race both the shell request and stale idle
          // notifications from the base turn. Without the exact
          // commandExecution lifecycle, idle alone cannot prove that the
          // user-shell operation completed.
          if (shell.basePhase.type !== "idle") shell.baseCompleted = true;
          if (shell.standaloneTurnId !== null) shell.standaloneCompleted = true;
          this.phase = {
            type: "shell",
            turnId: shell.standaloneTurnId ?? shell.baseTurnId,
          };
          if (shell.itemCompleted && (
            shell.standaloneTurnId !== null
              ? shell.standaloneCompleted
              : shell.basePhase.type !== "idle" && shell.baseCompleted
          )) {
            await this.finishShellIdle();
          } else if (
            shell.itemCompleted &&
            shell.standaloneTurnId === null &&
            !shell.baseCompleted
          ) {
            await this.restoreShellBase();
          }
          return;
        }
        if (response.thread.status.type === "active") {
          const running = response.thread.turns.filter((turn) => turn.status === "inProgress");
          if (running.length === 1) {
            const runningTurnId = running[0]!.id;
            if (
              shell.basePhase.type === "idle" ||
              (shell.baseTurnId !== null && shell.baseTurnId !== runningTurnId)
            ) {
              shell.standaloneTurnId ??= runningTurnId;
            } else if (shell.baseTurnId === null) {
              shell.baseTurnId = runningTurnId;
            }
            this.phase = {
              type: "shell",
              turnId: shell.standaloneTurnId ?? shell.baseTurnId,
            };
            if (shell.itemCompleted) {
              if (shell.standaloneTurnId !== null) {
                if (shell.standaloneCompleted) await this.finishShellIdle();
              } else if (shell.baseCompleted) {
                await this.finishShellIdle();
              } else {
                await this.restoreShellBase();
              }
            }
            return;
          }
        }
        // The request may have reached core even when recovery cannot identify
        // its exact turn. Preserve the shell fence instead of projecting an
        // ordinary steerable turn.
        this.phase = { type: "shell", turnId: shell.standaloneTurnId ?? shell.baseTurnId };
        return;
      }
      for (const item of userShellItems) this.observedUserShellItemIds.add(item.itemId);
      if (response.thread.status.type === "idle") {
        this.phase = { type: "idle" };
        await this.flushFromIdle();
        return;
      }
      if (response.thread.status.type === "active") {
        const running = response.thread.turns.filter((turn) => turn.status === "inProgress");
        if (running.length === 1) {
          const active = running[0]!;
          const items = active.items ?? [];
          let lastEnteredReview = -1;
          let lastExitedReview = -1;
          for (let index = 0; index < items.length; index += 1) {
            if (items[index]!.type === "enteredReviewMode") lastEnteredReview = index;
            if (items[index]!.type === "exitedReviewMode") lastExitedReview = index;
          }
          const specialBase = lastEnteredReview > lastExitedReview
            ? "review"
            : items.some((item) => item.type === "contextCompaction")
              ? "compact"
              : null;
          const activeShellItems = items.filter((item) =>
            item.type === "commandExecution" &&
            item.source === "userShell" &&
            typeof item.id === "string"
          );
          const inProgressShellItems = activeShellItems.filter((item) =>
            item.status === "inProgress"
          );
          const hasAmbiguousShellStatus = activeShellItems.some((item) =>
            item.status !== "inProgress" &&
            item.status !== "completed" &&
            item.status !== "failed" &&
            item.status !== "declined"
          );
          const coldShellItem = inProgressShellItems.length === 1
            ? inProgressShellItems[0]!
            : inProgressShellItems.length === 0 &&
                activeShellItems.length === 1 &&
                !hasAmbiguousShellStatus
              ? activeShellItems[0]!
              : null;
          if (coldShellItem !== null) {
            const shellItem = coldShellItem;
            const itemCompleted =
              shellItem.status === "completed" ||
              shellItem.status === "failed" ||
              shellItem.status === "declined";
            const hasModelTurnEvidence = items.some((item) =>
              item.type !== "commandExecution" &&
              item.type !== "enteredReviewMode" &&
              item.type !== "exitedReviewMode" &&
              item.type !== "contextCompaction"
            );
            const basePhase: CodexShellBasePhase = specialBase !== null
              ? { type: specialBase, turnId: active.id }
              : hasModelTurnEvidence
                ? { type: "normal", turnId: active.id }
                : { type: "idle" };
            // A completed auxiliary item can immediately project its still
            // active base phase. A standalone shell owns the turn until the
            // turn itself completes, even if its command item already did.
            if (!itemCompleted || basePhase.type === "idle") {
              this.shellLifecycle = {
                basePhase,
                baseTurnId: basePhase.type === "idle" ? null : active.id,
                baseCompleted: basePhase.type === "idle",
                baselineItemIds: new Set(
                  [...this.observedUserShellItemIds].filter((id) => id !== shellItem.id),
                ),
                requestOutcome: "accepted",
                standaloneTurnId: basePhase.type === "idle" ? active.id : null,
                standaloneCompleted: false,
                itemId: shellItem.id!,
                itemTurnId: active.id,
                itemCompleted,
                itemAborted: false,
              };
              this.phase = { type: "shell", turnId: active.id };
              return;
            }
          }
          if (
            inProgressShellItems.length > 1 ||
            hasAmbiguousShellStatus ||
            (
              inProgressShellItems.length === 0 &&
              activeShellItems.length > 1 &&
              !items.some((item) =>
                item.type !== "commandExecution" &&
                item.type !== "enteredReviewMode" &&
                item.type !== "exitedReviewMode" &&
                item.type !== "contextCompaction"
              )
            )
          ) {
            // Full ThreadItem history is authoritative, but multiple current
            // shell candidates (or a status outside the 0.144.x schema) is not
            // enough information to safely classify the turn as steerable.
            this.phase = { type: "unknown", turnId: null };
            return;
          }
          if (specialBase !== null) {
            this.phase = { type: specialBase, turnId: active.id };
            return;
          }
          this.phase = { type: "normal", turnId: active.id };
          await this.flushIntoNormalTurn();
          return;
        }
      }
      this.phase = { type: "unknown", turnId: null };
    });
  }

  async observeTurnStarted(turnId: string, clientIds: string[] = []): Promise<void> {
    await this.serialize(async () => {
      this.reconcileAcceptedClientIds(clientIds);
      // A review/compact request remains non-steerable even if it internally
      // emits turn/started. Only its completion/idle event opens the queue.
      if (
        this.phase.type === "review" ||
        this.phase.type === "compact" ||
        this.phase.type === "shell"
      ) {
        if (this.phase.type === "shell") {
          const shell = this.shellLifecycle;
          if (!shell) {
            this.phase = { type: "shell", turnId };
            return;
          }
          if (shell.basePhase.type === "idle") {
            shell.standaloneTurnId ??= turnId;
          } else if (shell.baseTurnId === null) {
            // review/compact can be entered before their turn/started event.
            shell.baseTurnId = turnId;
          } else if (shell.baseTurnId !== turnId) {
            shell.standaloneTurnId ??= turnId;
          }
          this.phase = {
            type: "shell",
            turnId: shell.standaloneTurnId ?? shell.baseTurnId,
          };
          return;
        }
        this.phase = { ...this.phase, turnId };
        return;
      }
      this.phase = { type: "normal", turnId };
      await this.flushIntoNormalTurn();
    });
  }

  async observeTurnCompleted(turnId: string): Promise<void> {
    await this.serialize(async () => {
      if (this.phase.type === "shell" && this.shellLifecycle) {
        const shell = this.shellLifecycle;
        if (shell.standaloneTurnId === turnId) {
          shell.standaloneCompleted = true;
          if (shell.itemCompleted) await this.finishShellIdle();
          return;
        }
        if (shell.baseTurnId === turnId) {
          shell.baseCompleted = true;
          if (shell.itemCompleted && shell.standaloneTurnId === null) {
            await this.finishShellIdle();
          }
        }
        return;
      }
      // In unknown state a completed event alone cannot prove the thread is
      // idle: another turn may already have replaced it. Wait for
      // thread/status/changed=idle or an authoritative resume.
      if (this.phase.type === "unknown" || this.phase.type === "idle") return;
      if (this.phase.turnId === null || this.phase.turnId !== turnId) return;
      this.shellLifecycle = null;
      this.phase = { type: "idle" };
      await this.flushFromIdle();
    });
  }

  async observeThreadIdle(): Promise<void> {
    await this.serialize(async () => {
      if (this.phase.type === "shell" && this.shellLifecycle) {
        const shell = this.shellLifecycle;
        if (shell.standaloneTurnId !== null) {
          shell.standaloneCompleted = true;
          if (shell.itemCompleted) await this.finishShellIdle();
        } else if (shell.basePhase.type !== "idle") {
          shell.baseCompleted = true;
          if (shell.itemCompleted) await this.finishShellIdle();
        }
        // For an idle-base shell, an idle notification can predate the exact
        // item/started event. It is intentionally not a completion signal.
        return;
      }
      this.shellLifecycle = null;
      this.phase = { type: "idle" };
      await this.flushFromIdle();
    });
  }

  /**
   * An active-turn user shell command has no dedicated turn/completed event.
   * Its commandExecution item completion is the authoritative point at which
   * queued AgentParty input may steer into the original turn again. A shell
   * started from idle owns a standalone turn and remains blocked until that
   * turn completes or the thread reports idle.
   */
  async observeUserShellStarted(turnId: string, itemId: string): Promise<void> {
    await this.serialize(async () => {
      if (this.phase.type !== "shell" || !this.shellLifecycle) return;
      const shell = this.shellLifecycle;
      this.observedUserShellItemIds.add(itemId);
      if (shell.itemId !== null) {
        // Only the commandExecution item that authoritatively started this
        // shell request may release the fence.
        return;
      }
      shell.itemId = itemId;
      shell.itemTurnId = turnId;
      if (shell.basePhase.type === "idle") {
        shell.standaloneTurnId ??= turnId;
      } else if (shell.baseTurnId === null) {
        shell.baseTurnId = turnId;
      } else if (shell.baseTurnId !== turnId) {
        shell.standaloneTurnId ??= turnId;
      }
      this.phase = {
        type: "shell",
        turnId: shell.standaloneTurnId ?? shell.baseTurnId,
      };
    });
  }

  async observeUserShellCompleted(turnId: string, itemId: string): Promise<void> {
    await this.serialize(async () => {
      if (this.phase.type !== "shell" || !this.shellLifecycle) return;
      const shell = this.shellLifecycle;
      this.observedUserShellItemIds.add(itemId);
      if (shell.itemId !== itemId || shell.itemTurnId !== turnId) return;
      shell.itemCompleted = true;
      if (shell.standaloneTurnId !== null) {
        if (shell.standaloneCompleted) await this.finishShellIdle();
        return;
      }
      if (shell.baseCompleted) {
        await this.finishShellIdle();
        return;
      }
      await this.restoreShellBase();
    });
  }

  private async restoreShellBase(): Promise<void> {
    const shell = this.shellLifecycle;
    if (!shell) return;
    this.shellLifecycle = null;
    if (shell.basePhase.type === "idle") {
      this.phase = { type: "idle" };
      await this.flushFromIdle();
      return;
    }
    if (shell.basePhase.type === "normal") {
      this.phase = { type: "normal", turnId: shell.basePhase.turnId };
      await this.flushIntoNormalTurn();
      return;
    }
    this.phase = {
      type: shell.basePhase.type,
      turnId: shell.baseTurnId,
    };
  }

  private async finishShellIdle(): Promise<void> {
    this.shellLifecycle = null;
    this.phase = { type: "idle" };
    await this.flushFromIdle();
  }

  /**
   * Resolve a transport unknown outcome only after an authoritative
   * thread/resume or thread/read scan. `accepted` suppresses all retries;
   * `notAccepted` moves the original command back to the bounded queue.
   */
  async resolveUnknownOutcome(
    input: CodexBridgeInput,
    outcome: "accepted" | "notAccepted" | "abandoned",
  ): Promise<CodexDispatch> {
    const normalized = compactInput(input);
    return await this.serialize(async () => {
      if (this.journal.get(normalized.clientUserMessageId) !== "uncertain") {
        const state = this.journal.get(normalized.clientUserMessageId);
        return state === "accepted" || state === "abandoned"
          ? { kind: "duplicate" }
          : this.enqueue(normalized, "steer_rejected");
      }
      if (outcome === "accepted") {
        this.journal.set(normalized.clientUserMessageId, "accepted");
        this.uncertainInputs.delete(normalized.clientUserMessageId);
        await this.flushAuthoritativePhase();
        return { kind: "duplicate" };
      }
      this.uncertainInputs.delete(normalized.clientUserMessageId);
      if (outcome === "abandoned") {
        // A cold-process resume/read that does not contain the client id is
        // still not a negative idempotency proof. The delivery layer first
        // records a visible terminal-unknown failure, then abandons this exact
        // write without replaying it so later independent work can proceed.
        this.journal.set(normalized.clientUserMessageId, "abandoned");
        await this.flushAuthoritativePhase();
        return { kind: "duplicate" };
      }
      this.journal.delete(normalized.clientUserMessageId);
      const dispatch = this.enqueue(normalized, "steer_rejected");
      await this.flushAuthoritativePhase();
      return dispatch;
    });
  }

  private reconcileAcceptedClientIds(clientIds: Iterable<string>): void {
    const accepted = new Set(clientIds);
    if (accepted.size === 0) return;
    for (const clientId of accepted) {
      this.journal.set(clientId, "accepted");
      this.uncertainInputs.delete(clientId);
    }
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (accepted.has(this.queue[index]!.input.clientUserMessageId)) this.queue.splice(index, 1);
    }
  }

  private async notifyQueuedDispatch(entry: QueuedInput, dispatch: CodexDispatch): Promise<void> {
    if (dispatch.kind !== "started" && dispatch.kind !== "steered") return;
    await this.options.onQueuedDispatch?.({ id: entry.id, input: entry.input, dispatch });
  }

  private notifyQueuedError(entry: QueuedInput, error: unknown): void {
    void Promise.resolve(this.options.onQueuedError?.({ input: entry.input, error })).catch(() => {});
  }

  private scheduleFlushRetry(): void {
    if (this.flushRetryTimer !== null || this.queue.length === 0) return;
    const delay = Math.min(30_000, 100 * 2 ** Math.min(this.flushRetryAttempt, 8));
    this.flushRetryAttempt += 1;
    this.flushRetryTimer = setTimeout(() => {
      this.flushRetryTimer = null;
      void this.serialize(async () => {
        const rollbackReady = await this.flushRollbackDebts();
        if (rollbackReady) await this.flushAuthoritativePhase();
        else this.scheduleFlushRetry();
      }).catch((error) => {
        const entry = this.queue[0];
        if (entry) this.notifyQueuedError(entry, error);
        this.scheduleFlushRetry();
      });
    }, delay);
    if (typeof this.flushRetryTimer.unref === "function") this.flushRetryTimer.unref();
  }

  private async flushRollbackDebts(): Promise<boolean> {
    let ready = true;
    for (const entry of this.queue) {
      if (!this.rollbackDebts.has(entry.input.clientUserMessageId)) continue;
      try {
        await this.settleRollbackDebt(entry.input);
      } catch (error) {
        ready = false;
        this.notifyQueuedError(entry, error);
      }
    }
    return ready;
  }

  private restoreQueuedAfterFlushError(entry: QueuedInput, error: unknown): void {
    this.queue.unshift(entry);
    this.journal.set(entry.input.clientUserMessageId, "queued");
    this.notifyQueuedError(entry, error);
    this.scheduleFlushRetry();
  }

  private async flushFromIdle(): Promise<void> {
    if (this.hasUncertainOutcome()) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.journal.delete(entry.input.clientUserMessageId);
    let dispatch: CodexDispatch;
    try {
      dispatch = await this.start(entry.input);
    } catch (error) {
      this.restoreQueuedAfterFlushError(entry, error);
      return;
    }
    if (dispatch.kind === "started") {
      this.flushRetryAttempt = 0;
      await this.notifyQueuedDispatch(entry, dispatch);
    }
  }

  private async flushIntoNormalTurn(): Promise<void> {
    if (this.hasUncertainOutcome()) return;
    while (
      !this.hasUncertainOutcome() &&
      this.phase.type === "normal" &&
      this.queue.length > 0
    ) {
      const entry = this.queue.shift()!;
      this.journal.delete(entry.input.clientUserMessageId);
      const expectedTurnId = this.phase.turnId;
      let dispatch: CodexDispatch;
      try {
        dispatch = await this.steer(entry.input, expectedTurnId);
      } catch (error) {
        this.restoreQueuedAfterFlushError(entry, error);
        return;
      }
      if (dispatch.kind === "queued" || dispatch.kind === "uncertain") {
        // steer() re-enqueued at the tail after a CAS/state rejection. Stop;
        // waiting for the next authoritative event avoids a retry loop.
        return;
      }
      this.flushRetryAttempt = 0;
      await this.notifyQueuedDispatch(entry, dispatch);
    }
  }

  private async flushAuthoritativePhase(): Promise<void> {
    if (this.hasUncertainOutcome()) return;
    if (this.phase.type === "idle") {
      await this.flushFromIdle();
    } else if (this.phase.type === "normal") {
      await this.flushIntoNormalTurn();
    }
  }
}

function responseTurnId(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const direct = (response as { turnId?: unknown }).turnId;
  if (typeof direct === "string") return direct;
  const turn = (response as { turn?: unknown }).turn;
  if (typeof turn !== "object" || turn === null) return null;
  return typeof (turn as { id?: unknown }).id === "string"
    ? (turn as { id: string }).id
    : null;
}
