// Hidden stdio subprocess used by `party bridge claude`.
//
// Claude Code Channels are a dedicated MCP extension. Declaring the
// `claude/channel` capability and emitting `notifications/claude/channel`
// injects a queued input into the *current* Claude session. Do not replace this
// with ordinary MCP logging/resource notifications: those were proven not to
// wake an idle harness in #553.
import {
  BODY_LIMIT,
  DIRECTED_DELIVERY_LEASE_MS,
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_STREAM_ENDED,
  type ClientFrame,
  type DeliveryRecoverFrame,
  type DeliveryRecoveryResultFrame,
  type DirectedDelivery,
  type MsgFrame,
  type ServerFrame,
} from "@agentparty/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Notification,
  type Request,
  type Result,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import pkg from "../../package.json" with { type: "json" };
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { connect, type Connection } from "../client";
import { loadCursor, resolveChannel, saveCursor } from "../config";
import {
  DeliveryRecoveryJournal,
  deliveryRecoveryJournalPath,
  type DeliveryRecoveryEntry,
} from "../delivery-recovery-journal";
import { acquireInstanceLock, defaultInstanceLockDir, instanceLockTarget } from "../instance-lock";
import { resolveAuthDetailed } from "../oidc-cli";
import { fetchMessages, postMessage } from "../rest";
import { isSlug } from "../validation";

const REPLY_TOOL = "party_channel_reply";
const CLAIM_TOOL = "party_channel_claim";
const ACCEPT_TOOL = "party_channel_accept";

const HELP = `usage: party claude-channel [channel|--channel C]

Internal stdio MCP adapter for \`party bridge claude\`.

It declares Claude Code's dedicated experimental claude/channel capability,
holds AgentParty directed delivery, injects messages into the current Claude
session, and links replies back through ${REPLY_TOOL}. Run \`party bridge
claude\` instead of starting this command manually.`;

export interface ClaudeChannelNotification extends Notification {
  method: "notifications/claude/channel";
  params: {
    content: string;
    meta: Record<string, string>;
  };
}

export interface ChannelNotification {
  content: string;
  meta: Record<string, string>;
}

export type ChannelNotify = (notification: ChannelNotification) => Promise<void>;
export type ChannelPostReply = (reply: {
  body: string;
  mentions: string[];
  replyTo: number;
  idempotencyKey: string;
}) => Promise<{ seq: number }>;
export type ChannelLoadMessage = (seq: number) => Promise<MsgFrame | null>;

type BridgeConnection = Pick<Connection, "frames" | "send" | "ack" | "close" | "cursor">;
type DeliveryUpdateFrame = Extract<ClientFrame, { type: "delivery_update" }>;
type AuthoritativeDeliveryState =
  Extract<ServerFrame, { type: "delivery_state" }>["delivery"]["state"];

interface PendingDeliveryAck {
  deliveryId: string;
  state: DeliveryUpdateFrame["state"];
  resolve: (state: AuthoritativeDeliveryState) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingDeliveryRecovery {
  deliveryId: string;
  resolve: (frame: DeliveryRecoveryResultFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingChannelMessage {
  message: MsgFrame;
  delivery: DirectedDelivery | null;
  renewTimer: ReturnType<typeof setInterval> | null;
  renewEpoch: number;
  renewing: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryRound: number;
  replying: boolean;
  settling: boolean;
  terminalError: string | null;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  harnessClaimed: boolean;
  claimReceipt: string | null;
  claimNotificationAttempts: number;
  replyIdempotencyKey: string;
  replyBody: string | null;
  replySeq: number | null;
  continuationKey: string | null;
}

interface ParkedClaudeContinuation {
  key: string;
  workId: string;
  continuationRef: string;
  sourceDeliveryId: string;
  sourceMessage: MsgFrame;
  questionSeq: number;
}

export interface ClaudeChannelDeliveryBridgeOptions {
  channel: string;
  connection: BridgeConnection;
  notify: ChannelNotify;
  postReply: ChannelPostReply;
  out?: (line: string) => void;
  leaseRenewIntervalMs?: number;
  deliveryAckTimeoutMs?: number;
  deliveryAckMaxAttempts?: number;
  deliveryAckRetryDelayMs?: number;
  deliveryRecoveryRetryDelayMs?: number;
  deliverySettleRetryMaxRounds?: number;
  deliverySettleRetryDelayMs?: number;
  deliverySettleRetryCooldownMs?: number;
  recoveryUncertaintyTimeoutMs?: number;
  harnessClaimRetryDelayMs?: number;
  harnessClaimMaxNotifications?: number;
  harnessClaimNotifyTimeoutMs?: number;
  /** Production enables an idempotent claim gate before Claude sees task content. */
  requireHarnessClaim?: boolean;
  recoveryJournal?: DeliveryRecoveryJournal;
  /** Reads the Worker's durable channel history for restart/reconciliation. */
  loadMessage?: ChannelLoadMessage;
  /** Test/embedding seam; production uses request_id + delivery_state. */
  confirmDeliveryUpdate?: (
    update: DeliveryUpdateFrame,
  ) => Promise<AuthoritativeDeliveryState | void>;
}

class DeliveryUpdateRejectedError extends Error {}
class DeliveryUpdateCancelledError extends Error {}
class DeliveryConnectionReplacedError extends Error {}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deliveryUpdate(
  delivery: DirectedDelivery,
  state: "running" | "replied" | "failed",
  extra: { replySeq?: number; error?: string } = {},
): DeliveryUpdateFrame {
  return {
    type: "delivery_update",
    delivery_id: delivery.id,
    state,
    attempt: delivery.attempt,
    ...(delivery.lease_epoch === undefined ? {} : { lease_epoch: delivery.lease_epoch }),
    ...(delivery.lease_token === undefined ? {} : { lease_token: delivery.lease_token }),
    ...(delivery.work_id === null ? {} : { work_id: delivery.work_id }),
    ...(delivery.continuation_ref === null ? {} : { continuation_ref: delivery.continuation_ref }),
    ...(extra.replySeq === undefined ? {} : { reply_seq: extra.replySeq }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
  };
}

function notificationFor(
  channel: string,
  message: MsgFrame,
  delivery: DirectedDelivery | null,
  continuation: ParkedClaudeContinuation | null = null,
): ChannelNotification {
  const sender = message.sender.name;
  const decision = message.decision_response;
  const continuationContext = continuation === null
    ? ""
    : (
      `This is the owner answer for an AgentParty continuation that may no longer be present ` +
      "in Claude's conversation context (for example after /clear).\n\n" +
      `Original source message in #${channel} from @${continuation.sourceMessage.sender.name} ` +
      `(seq=${continuation.sourceMessage.seq}, delivery=${continuation.sourceDeliveryId}):\n\n` +
      `${continuation.sourceMessage.body}\n\n` +
      `Owner decision${decision?.prompt ? ` for "${decision.prompt}"` : ""}: ` +
      `${decision?.chosen_option ?? message.body}` +
      `${decision?.reason ? ` (${decision.reason})` : ""}\n\n`
    );
  return {
    content:
      continuationContext +
      `AgentParty message in #${channel} from @${sender} (seq=${message.seq}):\n\n` +
      `${message.body}\n\n` +
      `Respond to this exact message by calling ${REPLY_TOOL} with seq=${message.seq} and your reply text. ` +
      "Do not use party_send for this reply.",
    meta: {
      source: "agentparty",
      channel,
      seq: String(message.seq),
      sender,
      sender_kind: message.sender.kind,
      ...(message.sender.owner === undefined ? {} : { sender_owner: message.sender.owner }),
      ...(delivery === null
        ? {}
        : {
            delivery_id: delivery.id,
            delivery_cause: delivery.cause,
            ...(delivery.work_id === null ? {} : { work_id: delivery.work_id }),
            ...(delivery.continuation_ref === null
              ? {}
              : { continuation_ref: delivery.continuation_ref }),
          }),
      ...(continuation === null
        ? {}
        : {
            continuation_source_delivery_id: continuation.sourceDeliveryId,
            continuation_source_seq: String(continuation.sourceMessage.seq),
            continuation_source_sender: continuation.sourceMessage.sender.name,
          }),
    },
  };
}

function claimNotificationFor(
  channel: string,
  message: MsgFrame,
  delivery: DirectedDelivery,
): ChannelNotification {
  return {
    content:
      `AgentParty durable input is ready for #${channel} (execution_id=${delivery.id}, seq=${message.seq}). ` +
      `Call ${CLAIM_TOOL} with execution_id=${delivery.id} to receive a stable claim receipt and task body. ` +
      `After reading the full result, call ${ACCEPT_TOOL} with that exact receipt before doing any work ` +
      "or causing any side effect. An unaccepted claim may be fetched again; never execute the same receipt twice.",
    meta: {
      source: "agentparty",
      channel,
      seq: String(message.seq),
      sender: message.sender.name,
      sender_kind: message.sender.kind,
      delivery_id: delivery.id,
      execution_id: delivery.id,
      delivery_cause: delivery.cause,
    },
  };
}

function replyIdempotencyKey(
  channel: string,
  message: MsgFrame,
  delivery: DirectedDelivery | null,
): string {
  // Deterministic from the durable inbound identity, so retries and a process
  // restart reuse the same server-side dedupe key for one logical reply.
  return delivery === null
    ? `claude-channel-reply:${channel}:${message.seq}`
    : `claude-channel-reply:${delivery.id}`;
}

function continuationKey(delivery: DirectedDelivery): string | null {
  if (delivery.work_id === null || delivery.continuation_ref === null) return null;
  return `${delivery.work_id}\u0000${delivery.continuation_ref}`;
}

/**
 * Delivery ledger on the AgentParty side of a Claude Channel.
 *
 * A successful notification write only means Claude accepted a queued channel
 * input. It is not completion. The delivery remains `running` (with lease
 * renewal) until Claude explicitly calls the linked reply tool, the REST reply
 * carrying `reply_to` succeeds, and Worker confirms `replied` or parks it as
 * `waiting_owner`.
 */
export class ClaudeChannelDeliveryBridge {
  private self = "";
  private directedDeliveryMode = false;
  private exitCode = 0;
  private intentionalClose = false;
  private readonly pending = new Map<number, PendingChannelMessage>();
  private readonly parkedContinuations = new Map<string, ParkedClaudeContinuation>();
  private readonly completedContinuationKeys = new Set<string>();
  private readonly settledDeliveryIds = new Set<string>();
  private readonly seenPlainSeqs = new Set<number>();
  private readonly recoveringDeliveryIds = new Map<
    string,
    { generation: number; token: symbol }
  >();
  private readonly deliveryAcks = new Map<string, PendingDeliveryAck>();
  private readonly deliveryRecoveries = new Map<string, PendingDeliveryRecovery>();
  private readonly out: (line: string) => void;
  private frameWork: Promise<void> = Promise.resolve();
  private welcomeGeneration = 0;
  private stopped = false;
  private journalRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private journalRecoveryRetryGeneration = 0;
  private journalRecoveryRetryRound = 0;
  private journalRecoveryRun: {
    generation: number;
    promise: Promise<void>;
  } | null = null;

  constructor(private readonly options: ClaudeChannelDeliveryBridgeOptions) {
    if (options.requireHarnessClaim === true && options.recoveryJournal === undefined) {
      throw new Error("Claude harness claim gate requires a durable recovery journal");
    }
    this.out = options.out ?? ((line) => console.error(line));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get parkedContinuationCount(): number {
    return this.parkedContinuations.size;
  }

  private cancelJournalRecoveryRetry(): void {
    if (this.journalRecoveryRetryTimer !== null) {
      clearTimeout(this.journalRecoveryRetryTimer);
      this.journalRecoveryRetryTimer = null;
    }
  }

  private resetJournalRecoveryBackoff(generation: number): void {
    this.cancelJournalRecoveryRetry();
    this.journalRecoveryRetryGeneration = generation;
    this.journalRecoveryRetryRound = 0;
  }

  private scheduleJournalRecoveryRetry(generation: number): void {
    if (
      this.stopped ||
      generation !== this.welcomeGeneration ||
      this.journalRecoveryRetryTimer !== null
    ) {
      return;
    }
    if (this.journalRecoveryRetryGeneration !== generation) {
      this.journalRecoveryRetryGeneration = generation;
      this.journalRecoveryRetryRound = 0;
    }
    const baseDelayMs = Math.max(
      1,
      this.options.deliveryRecoveryRetryDelayMs ?? 1_000,
    );
    const delayMs = Math.min(
      30_000,
      baseDelayMs * 2 ** Math.min(this.journalRecoveryRetryRound, 5),
    );
    this.journalRecoveryRetryRound += 1;
    const timer = setTimeout(() => {
      if (this.journalRecoveryRetryTimer !== timer) return;
      this.journalRecoveryRetryTimer = null;
      if (this.stopped || generation !== this.welcomeGeneration) return;
      this.joinJournalRecovery(generation);
    }, delayMs);
    this.journalRecoveryRetryTimer = timer;
    if (typeof timer.unref === "function") timer.unref();
  }

  private startJournalRecovery(generation: number): Promise<void> {
    const active = this.journalRecoveryRun;
    if (active !== null && active.generation === generation) return active.promise;
    const run = {
      generation,
      promise: Promise.resolve(),
    };
    run.promise = this.recoverJournalEntries(generation)
      .catch((error) => {
        if (!this.stopped && generation === this.welcomeGeneration) {
          this.scheduleJournalRecoveryRetry(generation);
        }
        throw error;
      })
      .finally(() => {
        if (this.journalRecoveryRun === run) this.journalRecoveryRun = null;
      });
    this.journalRecoveryRun = run;
    return run.promise;
  }

  private joinJournalRecovery(generation: number): void {
    const oldLane = this.frameWork.catch(() => undefined);
    const recovery = this.startJournalRecovery(generation);
    this.frameWork = Promise.all([oldLane, recovery])
      .then(() => undefined)
      .catch((error) => {
        if (this.stopped || generation !== this.welcomeGeneration) return;
        this.out(
          `claude-channel: delivery recovery failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private stopLeaseRenewal(pending: PendingChannelMessage): void {
    pending.renewEpoch += 1;
    if (pending.renewTimer) clearInterval(pending.renewTimer);
    pending.renewTimer = null;
  }

  private stopPendingRetry(pending: PendingChannelMessage): void {
    if (pending.retryTimer) clearTimeout(pending.retryTimer);
    pending.retryTimer = null;
  }

  private schedulePendingRetry(
    pending: PendingChannelMessage,
    label: string,
    action: () => Promise<void>,
  ): void {
    if (
      this.pending.get(pending.message.seq) !== pending ||
      pending.retryTimer !== null
    ) {
      return;
    }
    const configuredRounds = this.options.deliverySettleRetryMaxRounds ?? 4;
    const maxRounds = Number.isSafeInteger(configuredRounds)
      ? Math.max(0, Math.min(10, configuredRounds))
      : 4;
    if (maxRounds === 0) return;
    const baseDelayMs = Math.max(1, this.options.deliverySettleRetryDelayMs ?? 500);
    const exhaustedFastRetries = pending.retryRound >= maxRounds;
    const delayMs = exhaustedFastRetries
      ? Math.max(baseDelayMs, this.options.deliverySettleRetryCooldownMs ?? 30_000)
      : Math.min(30_000, baseDelayMs * (2 ** pending.retryRound));
    if (!exhaustedFastRetries) pending.retryRound += 1;
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = null;
      if (this.pending.get(pending.message.seq) !== pending) return;
      void action().catch((error) => {
        this.out(
          `claude-channel: background ${label} ` +
            `${exhaustedFastRetries ? "cooldown reconciliation" : `retry ${pending.retryRound}/${maxRounds}`} failed ` +
            `for delivery ${pending.delivery?.id ?? pending.message.seq}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        this.schedulePendingRetry(pending, label, action);
      });
    }, delayMs);
    if (typeof pending.retryTimer.unref === "function") pending.retryTimer.unref();
  }

  private startLeaseRenewal(pending: PendingChannelMessage): void {
    const delivery = pending.delivery;
    if (
      delivery === null ||
      (delivery.state !== "claimed" && delivery.state !== "running") ||
      pending.renewTimer !== null ||
      pending.replying ||
      pending.settling ||
      pending.terminalError !== null
    ) {
      return;
    }
    const intervalMs = this.options.leaseRenewIntervalMs ?? Math.floor(DIRECTED_DELIVERY_LEASE_MS / 2);
    const epoch = pending.renewEpoch + 1;
    pending.renewEpoch = epoch;
    const isCurrent = () =>
      this.pending.get(pending.message.seq) === pending &&
      pending.renewEpoch === epoch &&
      !pending.replying &&
      !pending.settling &&
      pending.terminalError === null;
    pending.renewTimer = setInterval(() => {
      if (!isCurrent() || pending.renewing) return;
      pending.renewing = true;
      void this.confirmDeliveryUpdate(deliveryUpdate(delivery, "running"), isCurrent)
        .catch((error) => {
          if (error instanceof DeliveryUpdateCancelledError) return;
          this.out(
            `claude-channel: delivery ${delivery.id} lease renewal was not confirmed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          pending.renewing = false;
        });
    }, intervalMs);
    if (typeof pending.renewTimer.unref === "function") pending.renewTimer.unref();
  }

  private clearPending(seq: number): PendingChannelMessage | null {
    const pending = this.pending.get(seq) ?? null;
    if (!pending) return null;
    this.stopLeaseRenewal(pending);
    this.stopPendingRetry(pending);
    if (pending.recoveryTimer) clearTimeout(pending.recoveryTimer);
    pending.recoveryTimer = null;
    this.pending.delete(seq);
    return pending;
  }

  private scheduleHarnessClaimRetry(pending: PendingChannelMessage): void {
    if (
      this.options.requireHarnessClaim !== true ||
      pending.delivery === null ||
      pending.harnessClaimed ||
      pending.recoveryTimer !== null ||
      this.pending.get(pending.message.seq) !== pending
    ) {
      return;
    }
    const configuredMax = this.options.harnessClaimMaxNotifications ?? 12;
    const maxNotifications = Number.isSafeInteger(configuredMax)
      ? Math.max(1, Math.min(100, configuredMax))
      : 12;
    const baseDelayMs = Math.max(1, this.options.harnessClaimRetryDelayMs ?? 5_000);
    const delayMs = Math.min(
      5 * 60_000,
      baseDelayMs * 2 ** Math.min(Math.max(0, pending.claimNotificationAttempts - 1), 12),
    );
    pending.recoveryTimer = setTimeout(() => {
      pending.recoveryTimer = null;
      if (
        pending.harnessClaimed ||
        pending.delivery === null ||
        this.pending.get(pending.message.seq) !== pending
      ) {
        return;
      }
      if (pending.claimNotificationAttempts >= maxNotifications) {
        // Channel notifications are transport writes, not consumption ACKs.
        // Claude may simply be busy and process them on its next turn. Stop
        // renewing after the bounded, exponentially-spaced reminders so the
        // Worker can surface terminal_unknown, but retain the exact journal
        // and claim path for a delayed claim and revivable late reply.
        this.stopLeaseRenewal(pending);
        this.out(
          `claude-channel: delivery ${pending.delivery.id} remains unclaimed after ` +
            `${maxNotifications} claim-only notifications; preserving delayed-claim debt`,
        );
        return;
      }
      pending.claimNotificationAttempts += 1;
      void this.sendHarnessClaimNotification(pending).then(() => {
        this.scheduleHarnessClaimRetry(pending);
      }).catch((error) => {
        this.out(
          `claude-channel: claim-only notification retry failed for ${pending.delivery?.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        this.scheduleHarnessClaimRetry(pending);
      });
    }, delayMs);
    if (typeof pending.recoveryTimer.unref === "function") pending.recoveryTimer.unref();
  }

  /**
   * A full-body Channel notification has no consumption acknowledgement. Once
   * the transport call was issued, a thrown error cannot prove that Claude did
   * not queue the input. Keep the exact journal/bearer debt for a late tool
   * reply and never replay the body or turn that uncertainty into an ordinary
   * permanent failure. Renewal is bounded so the Worker can eventually expose
   * terminal_unknown without losing the late-reply capability.
   */
  private preservePostHarnessDebt(
    pending: PendingChannelMessage,
    detail: string,
  ): void {
    if (pending.delivery === null || this.pending.get(pending.message.seq) !== pending) return;
    if (pending.recoveryTimer) clearTimeout(pending.recoveryTimer);
    const timeoutMs = Math.max(
      1,
      this.options.recoveryUncertaintyTimeoutMs ?? 5 * 60_000,
    );
    pending.recoveryTimer = setTimeout(() => {
      pending.recoveryTimer = null;
      if (
        this.pending.get(pending.message.seq) !== pending ||
        pending.replyBody !== null ||
        pending.replying
      ) {
        return;
      }
      this.stopLeaseRenewal(pending);
      this.out(
        `claude-channel: stopped renewing uncertain post-harness delivery ` +
          `${pending.delivery?.id ?? pending.message.seq}; preserving late-reply debt`,
      );
    }, timeoutMs);
    if (typeof pending.recoveryTimer.unref === "function") pending.recoveryTimer.unref();
    this.out(
      `claude-channel: ${detail}; task content will not be replayed and its ` +
        "late-reply debt remains durable",
    );
  }

  private async sendHarnessClaimNotification(
    pending: PendingChannelMessage,
  ): Promise<void> {
    if (pending.delivery === null) throw new Error("claim notification requires a directed delivery");
    const timeoutMs = Math.max(1, this.options.harnessClaimNotifyTimeoutMs ?? 5_000);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.options.notify(
          claimNotificationFor(this.options.channel, pending.message, pending.delivery),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`claim-only notification timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async notifyHarnessClaim(pending: PendingChannelMessage): Promise<void> {
    if (pending.delivery === null) throw new Error("claim notification requires a directed delivery");
    pending.claimNotificationAttempts += 1;
    try {
      await this.sendHarnessClaimNotification(pending);
    } catch (error) {
      // This write contains only execution_id. Its outcome is not a harness
      // consumption ACK, so both a rejection and an unknown transport result
      // are safe to retry without releasing task content twice.
      this.out(
        `claude-channel: claim-only notification was not confirmed for ${pending.delivery.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.scheduleHarnessClaimRetry(pending);
  }

  private rememberBounded<T extends string | number>(set: Set<T>, value: T): void {
    set.add(value);
    if (set.size <= 4_096) return;
    const oldest = set.values().next().value as T | undefined;
    if (oldest !== undefined) set.delete(oldest);
  }

  private async confirmDeliveryUpdateOnce(
    update: DeliveryUpdateFrame,
  ): Promise<AuthoritativeDeliveryState> {
    if (this.options.confirmDeliveryUpdate) {
      return await this.options.confirmDeliveryUpdate(update) ?? update.state;
    }
    const requestId = randomUUID();
    const timeoutMs = this.options.deliveryAckTimeoutMs ?? 5_000;
    return await new Promise<AuthoritativeDeliveryState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.deliveryAcks.delete(requestId);
        reject(new Error(`delivery update acknowledgement timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.deliveryAcks.set(requestId, {
        deliveryId: update.delivery_id,
        state: update.state,
        resolve: (state) => {
          clearTimeout(timer);
          resolve(state);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      if (!this.options.connection.send({ ...update, request_id: requestId })) {
        this.deliveryAcks.delete(requestId);
        clearTimeout(timer);
        reject(new Error("AgentParty websocket is not open"));
      }
    });
  }

  private async confirmDeliveryUpdate(
    update: DeliveryUpdateFrame,
    shouldContinue: (() => boolean) | null = null,
  ): Promise<AuthoritativeDeliveryState> {
    const configuredAttempts = this.options.deliveryAckMaxAttempts ?? 3;
    const maxAttempts = Number.isSafeInteger(configuredAttempts)
      ? Math.max(1, Math.min(10, configuredAttempts))
      : 3;
    const retryDelayMs = Math.max(0, this.options.deliveryAckRetryDelayMs ?? 25);
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (shouldContinue !== null && !shouldContinue()) {
        throw new DeliveryUpdateCancelledError(
          `delivery ${update.delivery_id} ${update.state} acknowledgement was superseded`,
        );
      }
      try {
        return await this.confirmDeliveryUpdateOnce(update);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (
          normalized instanceof DeliveryUpdateRejectedError ||
          normalized instanceof DeliveryUpdateCancelledError ||
          normalized instanceof DeliveryConnectionReplacedError
        ) {
          throw normalized;
        }
        lastError = normalized;
        if (attempt === maxAttempts) break;
        this.out(
          `claude-channel: retrying ${update.state} acknowledgement for ${update.delivery_id} ` +
            `after attempt ${attempt}/${maxAttempts}: ${normalized.message}`,
        );
        await delay(retryDelayMs);
      }
    }
    throw lastError ?? new Error(`delivery ${update.delivery_id} acknowledgement failed`);
  }

  private observeDeliveryAck(incoming: Extract<ServerFrame, { type: "delivery_state" }>): void {
    if (!incoming.request_id) return;
    const pending = this.deliveryAcks.get(incoming.request_id);
    if (!pending || pending.deliveryId !== incoming.delivery.id) return;
    this.deliveryAcks.delete(incoming.request_id);
    if (
      incoming.delivery.state === pending.state ||
      (pending.state === "replied" &&
        (incoming.delivery.state === "replied" || incoming.delivery.state === "waiting_owner"))
    ) {
      pending.resolve(incoming.delivery.state);
      return;
    }
    pending.reject(new DeliveryUpdateRejectedError(
      `delivery state is ${incoming.delivery.state}, expected ${pending.state}`,
    ));
  }

  private async confirmDeliveryRecovery(
    recovery: DeliveryRecoverFrame,
  ): Promise<DeliveryRecoveryResultFrame> {
    const timeoutMs = this.options.deliveryAckTimeoutMs ?? 5_000;
    return await new Promise<DeliveryRecoveryResultFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.deliveryRecoveries.delete(recovery.request_id);
        reject(new Error(`delivery recovery acknowledgement timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.deliveryRecoveries.set(recovery.request_id, {
        deliveryId: recovery.delivery_id,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      if (!this.options.connection.send(recovery)) {
        this.deliveryRecoveries.delete(recovery.request_id);
        clearTimeout(timer);
        reject(new Error("AgentParty websocket is not open"));
      }
    });
  }

  private observeDeliveryRecovery(incoming: DeliveryRecoveryResultFrame): void {
    const pending = this.deliveryRecoveries.get(incoming.request_id);
    if (!pending || pending.deliveryId !== incoming.delivery_id) return;
    this.deliveryRecoveries.delete(incoming.request_id);
    pending.resolve(incoming);
  }

  private restorePending(entry: DeliveryRecoveryEntry): PendingChannelMessage {
    const existing = this.pending.get(entry.message.seq);
    if (existing !== undefined) {
      this.stopLeaseRenewal(existing);
      existing.delivery = entry.delivery;
      existing.replyBody = entry.replyBody;
      existing.replySeq = entry.replySeq;
      existing.terminalError = entry.terminalError;
      existing.claimReceipt = entry.claimReceipt;
      existing.harnessClaimed =
        entry.phase === "harness_accepted" || entry.phase === "reply_posted";
      return existing;
    }
    const pending: PendingChannelMessage = {
      message: entry.message,
      delivery: entry.delivery,
      renewTimer: null,
      renewEpoch: 0,
      renewing: false,
      retryTimer: null,
      retryRound: 0,
      replying: false,
      settling: false,
      terminalError: entry.terminalError,
      recoveryTimer: null,
      harnessClaimed: entry.phase === "harness_accepted" || entry.phase === "reply_posted",
      claimReceipt: entry.claimReceipt,
      claimNotificationAttempts: 0,
      replyIdempotencyKey: replyIdempotencyKey(
        this.options.channel,
        entry.message,
        entry.delivery,
      ),
      replyBody: entry.replyBody,
      replySeq: entry.replySeq,
      continuationKey: entry.delivery.cause === "owner_answer"
        ? continuationKey(entry.delivery)
        : null,
    };
    this.pending.set(entry.message.seq, pending);
    return pending;
  }

  private prepareJournalRecovery(
    journal: DeliveryRecoveryJournal,
    deliveryId: string,
  ): { entry: DeliveryRecoveryEntry; frame: DeliveryRecoverFrame } {
    const current = journal.get(deliveryId);
    if (current === null) throw new Error(`no recovery journal entry for ${deliveryId}`);
    const replaySafe =
      current.phase === "claimed" ||
      current.phase === "running_authorized" ||
      (current.phase === "harness_issued" && this.options.requireHarnessClaim === true);
    const frame = journal.prepareRecovery(deliveryId, {
      replaySafe,
      expected: {
        phase: current.phase,
        updatedAt: current.updatedAt,
        attempt: current.delivery.attempt,
        leaseEpoch: current.delivery.lease_epoch!,
        leaseToken: current.delivery.lease_token!,
      },
    });
    // prepareRecovery may durably add nextLeaseToken and advance updatedAt.
    // Bind all result interpretation to that exact post-prepare snapshot.
    const prepared = journal.get(deliveryId);
    if (prepared === null || prepared.nextLeaseToken !== frame.next_lease_token) {
      throw new Error(`delivery ${deliveryId} changed while recovery was being prepared`);
    }
    return { entry: prepared, frame };
  }

  private async recoverJournalEntries(generation = this.welcomeGeneration): Promise<void> {
    const journal = this.options.recoveryJournal;
    if (journal === undefined) return;
    if (this.stopped || generation !== this.welcomeGeneration) return;
    let retryNeeded = false;
    const recoveryEntries = journal.entries().map((initial) => {
      const deliveryId = initial.delivery.id;
      const recoveryGate = { generation, token: Symbol(deliveryId) };
      // Install every gate from one journal snapshot before the first CAS can
      // yield. Otherwise a slow earlier recovery leaves later entries
      // claimable under the old ownership generation.
      this.recoveringDeliveryIds.set(deliveryId, recoveryGate);
      return { initial, recoveryGate };
    });
    for (const { initial, recoveryGate } of recoveryEntries) {
      if (generation !== this.welcomeGeneration) return;
      const deliveryId = initial.delivery.id;
      const gateCurrent = () =>
        !this.stopped &&
        generation === this.welcomeGeneration &&
        this.recoveringDeliveryIds.get(deliveryId) === recoveryGate;
      let releaseRecoveryGate = false;
      let stored = initial;
      let recovered: DeliveryRecoveryResultFrame;
      try {
        let prepared = this.prepareJournalRecovery(journal, deliveryId);
        stored = prepared.entry;
        let recovery = prepared.frame;
        try {
          recovered = await this.confirmDeliveryRecovery(recovery);
        } catch (firstError) {
          if (!gateCurrent()) return;
          // If the first CAS committed but its ACK was lost, the journal already
          // contains next_lease_token. Re-read the exact phase/revision before
          // retrying so a concurrent harness transition cannot inherit a stale
          // replay_safe assertion.
          prepared = this.prepareJournalRecovery(journal, stored.delivery.id);
          stored = prepared.entry;
          recovery = prepared.frame;
          try {
            recovered = await this.confirmDeliveryRecovery(recovery);
          } catch (retryError) {
            if (!gateCurrent()) return;
            this.out(
              `claude-channel: could not recover delivery ${stored.delivery.id}: ` +
                `${retryError instanceof Error ? retryError.message : String(retryError)} ` +
                `(first: ${firstError instanceof Error ? firstError.message : String(firstError)})`,
            );
            retryNeeded = true;
            continue;
          }
        }
      if (!gateCurrent()) return;
      let entry: DeliveryRecoveryEntry;
      let ownsActiveLease = recovered.result === "recovered";
      if (recovered.result === "recovered") {
        entry = journal.acceptRecovery(recovered);
      } else {
        const bodyMayHaveBeenReleased =
          stored.phase === "harness_accepted" ||
          stored.phase === "reply_posted" ||
          stored.replyBody !== null ||
          (stored.phase === "harness_issued" && this.options.requireHarnessClaim !== true);
        const delayedClaimIsSafe =
          recovered.result === "terminal_unknown" &&
          this.options.requireHarnessClaim === true &&
          (
            stored.phase === "claimed" ||
            stored.phase === "running_authorized" ||
            stored.phase === "harness_issued"
          );
        const failureAlreadySettled =
          stored.phase === "failed_pending" &&
          (recovered.result === "terminal" || recovered.result === "terminal_unknown");
        const isFinalTerminal = recovered.result === "terminal";
        if (
          (!bodyMayHaveBeenReleased && !delayedClaimIsSafe) ||
          failureAlreadySettled ||
          isFinalTerminal
        ) {
          journal.remove(stored.delivery.id);
          const existing = this.pending.get(stored.message.seq);
          if (existing !== undefined) this.clearPending(stored.message.seq);
          this.out(
            `claude-channel: recovery for delivery ${stored.delivery.id} resolved as ` +
              `${recovered.result}/${recovered.state}; no live harness debt remains`,
          );
          releaseRecoveryGate = true;
          continue;
        }
        // terminal_unknown is deliberately revivable by an exact late replied
        // receipt. The claim may already have released task content, so keep
        // the local reply path and bearer token even though there is no active
        // lease to renew. A superseded_safe result in a post-harness phase
        // violates the protocol invariant; preserving rather than discarding
        // the debt is the fail-closed behavior.
        entry = journal.update(stored.delivery.id, {
          delivery: {
            ...stored.delivery,
            state: recovered.state,
            lease_until: null,
          },
        });
        if (
          delayedClaimIsSafe &&
          (entry.phase === "claimed" || entry.phase === "running_authorized")
        ) {
          entry = journal.update(stored.delivery.id, { phase: "harness_issued" });
        }
        ownsActiveLease = false;
        this.out(
          `claude-channel: recovery for delivery ${stored.delivery.id} resolved as ` +
            `${recovered.result}/${recovered.state}; preserving post-harness reply debt`,
        );
      }
      if (
        ownsActiveLease &&
        (entry.phase === "claimed" || entry.phase === "running_authorized")
      ) {
        if (this.pending.has(entry.message.seq)) this.clearPending(entry.message.seq);
        const injected = await this.inject(entry.message, entry.delivery, true);
        if (!gateCurrent()) return;
        if (!injected) continue;
        releaseRecoveryGate = true;
        continue;
      }
      const pending = this.restorePending(entry);
      if (entry.phase === "reply_posted") {
        pending.replying = true;
        this.stopLeaseRenewal(pending);
        try {
          await this.settlePendingReply(pending);
        } catch (error) {
          if (!gateCurrent()) return;
          pending.replying = false;
          this.scheduleReplyRetry(pending);
          this.out(
            `claude-channel: recovered reply settlement is still pending for ` +
              `${entry.delivery.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        releaseRecoveryGate = true;
        continue;
      }
      if (entry.phase === "failed_pending") {
        await this.failPending(
          pending.message.seq,
          entry.terminalError ?? "recovered delivery was pending failure",
        );
        if (!gateCurrent()) return;
        releaseRecoveryGate = true;
        continue;
      }
      if (entry.replyBody !== null) {
        pending.replying = true;
        this.stopLeaseRenewal(pending);
        try {
          await this.persistAndSettlePendingReply(pending);
        } catch (error) {
          if (!gateCurrent()) return;
          pending.replying = false;
          this.scheduleReplyRetry(pending);
          this.out(
            `claude-channel: recovered idempotent reply is still pending for ${entry.delivery.id}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        releaseRecoveryGate = true;
        continue;
      }
      if (ownsActiveLease) this.startLeaseRenewal(pending);
      if (entry.phase === "harness_issued") {
        if (this.options.requireHarnessClaim === true) {
          // A recovered ownership generation gets a fresh bounded delivery
          // budget. Attempts from the replaced connection cannot suppress the
          // claim-only notification for this new bearer.
          pending.claimNotificationAttempts = 0;
          if (entry.delivery.cause === "owner_answer") {
            let binding: ParkedClaudeContinuation | null;
            try {
              binding = await this.bindingFor(entry.delivery, entry.message);
            } catch (error) {
              if (!gateCurrent()) return;
              this.out(
                `claude-channel: could not restore owner-answer context for ${entry.delivery.id}: ` +
                  `${error instanceof Error ? error.message : String(error)}; claim remains withheld`,
              );
              continue;
            }
            if (!gateCurrent()) return;
            if (binding === null) {
              await this.failPending(
                pending.message.seq,
                "recovered owner answer has no exact parked delivery/work/continuation lineage",
              );
              if (!gateCurrent()) return;
              releaseRecoveryGate = true;
              continue;
            }
            pending.continuationKey = binding.key;
          }
          try {
            await this.notifyHarnessClaim(pending);
          } catch (error) {
            if (!gateCurrent()) return;
            await this.failPending(
              pending.message.seq,
              `could not restore Claude claim notification: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          if (!gateCurrent()) return;
          releaseRecoveryGate = true;
          continue;
        }
        this.preservePostHarnessDebt(
          pending,
          "Claude channel notification outcome remained uncertain after process restart",
        );
        releaseRecoveryGate = true;
      } else if (entry.phase === "harness_accepted") {
        // The prior claim tool may have released the body before the bridge
        // restarted. Preserve that execution and its reply path. After the
        // bounded grace period, stop renewing rather than declaring an
        // ordinary permanent failure: the Worker will converge the expired
        // running lease to terminal_unknown, whose exact bearer token still
        // permits one late idempotent reply from a long-running Claude turn.
        this.preservePostHarnessDebt(
          pending,
          `recovered Claude execution ${entry.delivery.id} may still be running`,
        );
        releaseRecoveryGate = true;
      }
      } finally {
        if (
          releaseRecoveryGate &&
          this.recoveringDeliveryIds.get(deliveryId) === recoveryGate
        ) {
          this.recoveringDeliveryIds.delete(deliveryId);
        } else if (gateCurrent()) {
          // Every current gate must end in either an authoritative release or
          // another recovery pass. This also covers transient failures after
          // the ownership CAS, such as lineage restoration or harness
          // injection, rather than retrying only lost recovery ACKs.
          retryNeeded = true;
        }
      }
    }
    if (this.stopped || generation !== this.welcomeGeneration) return;
    // A harness execution may settle and remove both its WAL entry and pending
    // record while a recovery pass is awaiting another entry or being replaced
    // by a new welcome generation. Such a delivery no longer has ownership
    // debt, so do not retain an orphan gate future snapshots can never visit.
    for (const [deliveryId, recoveryGate] of this.recoveringDeliveryIds) {
      if (journal.get(deliveryId) !== null) continue;
      const stillPending = [...this.pending.values()].some(
        (pending) => pending.delivery?.id === deliveryId,
      );
      if (stillPending) {
        retryNeeded = true;
      } else if (this.recoveringDeliveryIds.get(deliveryId) === recoveryGate) {
        this.recoveringDeliveryIds.delete(deliveryId);
      }
    }
    if (retryNeeded) {
      this.scheduleJournalRecoveryRetry(generation);
    } else {
      this.resetJournalRecoveryBackoff(generation);
    }
  }

  private continuationMatches(
    delivery: DirectedDelivery,
    message: MsgFrame,
    parked: ParkedClaudeContinuation,
  ): boolean {
    const decision = message.decision_response;
    return (
      decision !== undefined &&
      parked.workId === delivery.work_id &&
      parked.continuationRef === delivery.continuation_ref &&
      decision.delivery_id === parked.sourceDeliveryId &&
      decision.origin_seq === parked.sourceMessage.seq &&
      decision.origin_channel === this.options.channel &&
      decision.work_id === parked.workId &&
      decision.continuation_ref === parked.continuationRef &&
      decision.request_seq === parked.questionSeq &&
      message.reply_to === parked.questionSeq
    );
  }

  private async recoverContinuationBinding(
    delivery: DirectedDelivery,
    message: MsgFrame,
    key: string,
    sourcePending: PendingChannelMessage | null,
  ): Promise<ParkedClaudeContinuation | null> {
    const decision = message.decision_response;
    const loadMessage = this.options.loadMessage;
    const recoveryGate = this.recoveringDeliveryIds.get(delivery.id) ?? null;
    if (
      decision === undefined ||
      decision.delivery_id === undefined ||
      decision.origin_seq === undefined ||
      decision.origin_channel !== this.options.channel ||
      decision.work_id !== delivery.work_id ||
      decision.continuation_ref !== delivery.continuation_ref ||
      message.reply_to !== decision.request_seq ||
      loadMessage === undefined
    ) {
      return null;
    }
    const sourceMessage = await loadMessage(decision.origin_seq);
    if (
      recoveryGate !== null &&
      (
        recoveryGate.generation !== this.welcomeGeneration ||
        this.recoveringDeliveryIds.get(delivery.id) !== recoveryGate
      )
    ) {
      return null;
    }
    if (
      sourceMessage === null ||
      sourceMessage.seq !== decision.origin_seq
    ) {
      return null;
    }
    const parked: ParkedClaudeContinuation = {
      key,
      workId: delivery.work_id!,
      continuationRef: delivery.continuation_ref!,
      sourceDeliveryId: decision.delivery_id,
      sourceMessage,
      questionSeq: decision.request_seq,
    };
    if (!this.continuationMatches(delivery, message, parked)) return null;

    // The privileged owner_answer delivery can only be created from the
    // Worker's durable waiting_owner lineage. Together with the exact retained
    // source row and the owner answer's snapshotted prompt/request_seq it is
    // authoritative evidence that a source POST whose HTTP response was lost
    // did persist. The old question itself may already be pruned. Recover its
    // reply seq and stop stale running renewals without reposting the question.
    if (
      sourcePending !== null &&
      sourcePending.delivery?.id === parked.sourceDeliveryId &&
      sourcePending.message.seq === parked.sourceMessage.seq
    ) {
      sourcePending.replySeq = parked.questionSeq;
      this.stopLeaseRenewal(sourcePending);
      if (!sourcePending.replying) this.clearPending(sourcePending.message.seq);
    }
    this.parkedContinuations.set(key, parked);
    return parked;
  }

  private async bindingFor(
    delivery: DirectedDelivery,
    message: MsgFrame,
  ): Promise<ParkedClaudeContinuation | null> {
    const key = continuationKey(delivery);
    const decision = message.decision_response;
    if (
      key === null ||
      this.completedContinuationKeys.has(key) ||
      decision === undefined ||
      delivery.work_id === null ||
      delivery.continuation_ref === null
    ) {
      return null;
    }
    const sourcePending = [...this.pending.values()].find((pending) =>
      pending.delivery !== null &&
      pending.delivery.cause !== "owner_answer" &&
      continuationKey(pending.delivery) === key &&
      pending.delivery.id === decision.delivery_id &&
      pending.message.seq === decision.origin_seq
    ) ?? null;
    const parked = this.parkedContinuations.get(key);
    if (parked !== undefined) {
      return this.continuationMatches(delivery, message, parked) ? parked : null;
    }
    if (sourcePending?.replySeq !== null && sourcePending?.replySeq !== undefined) {
      const inFlight: ParkedClaudeContinuation = {
        key,
        workId: delivery.work_id,
        continuationRef: delivery.continuation_ref,
        sourceDeliveryId: sourcePending.delivery!.id,
        sourceMessage: sourcePending.message,
        questionSeq: sourcePending.replySeq,
      };
      if (!this.continuationMatches(delivery, message, inFlight)) return null;
      // The owner answer can arrive before the source replied ACK finishes.
      // Persist the exact in-memory binding now: claim-gated delivery stores
      // only its key, and the later claim tool must still recover the source
      // body + owner decision even if the source ACK lane is unresolved.
      this.parkedContinuations.set(key, inFlight);
      return inFlight;
    }
    return await this.recoverContinuationBinding(delivery, message, key, sourcePending);
  }

  private parkContinuation(pending: PendingChannelMessage): ParkedClaudeContinuation | null {
    const delivery = pending.delivery;
    const key = delivery === null ? null : continuationKey(delivery);
    if (
      delivery === null ||
      key === null ||
      delivery.work_id === null ||
      delivery.continuation_ref === null ||
      pending.replySeq === null
    ) {
      throw new Error(
        `waiting_owner delivery ${delivery?.id ?? pending.message.seq} has incomplete continuation lineage`,
      );
    }
    if (this.completedContinuationKeys.has(key)) return null;
    const parked = {
      key,
      workId: delivery.work_id,
      continuationRef: delivery.continuation_ref,
      sourceDeliveryId: delivery.id,
      sourceMessage: pending.message,
      questionSeq: pending.replySeq,
    };
    this.parkedContinuations.set(key, parked);
    return parked;
  }

  private releaseParkedContinuation(pending: PendingChannelMessage): void {
    if (pending.delivery?.cause !== "owner_answer" || pending.continuationKey === null) return;
    this.rememberBounded(this.completedContinuationKeys, pending.continuationKey);
    this.parkedContinuations.delete(pending.continuationKey);
  }

  private async failPending(seq: number, error: string): Promise<void> {
    const pending = this.pending.get(seq) ?? null;
    if (!pending) return;
    if (pending.settling) return;
    if (!pending.delivery) {
      this.clearPending(seq);
      return;
    }
    pending.terminalError = error;
    try {
      if (pending.delivery) {
        this.options.recoveryJournal?.update(pending.delivery.id, {
          phase: "failed_pending",
          terminalError: error,
        });
      }
    } catch (journalError) {
      pending.settling = false;
      this.out(
        `claude-channel: could not durably record failed delivery ${pending.delivery.id}: ` +
          `${journalError instanceof Error ? journalError.message : String(journalError)}`,
      );
      this.schedulePendingRetry(pending, "failed-delivery journal", async () => {
        await this.failPending(seq, pending.terminalError ?? error);
      });
      return;
    }
    pending.settling = true;
    this.stopLeaseRenewal(pending);
    try {
      const state = await this.confirmDeliveryUpdate(deliveryUpdate(pending.delivery, "failed", {
        error: error.slice(0, 500),
      }));
      if (state !== "failed") {
        throw new Error(`delivery state is ${state}, expected failed`);
      }
      const completed = this.clearPending(seq);
      if (completed?.delivery) {
        this.options.recoveryJournal?.remove(completed.delivery.id);
        this.rememberBounded(this.settledDeliveryIds, completed.delivery.id);
        this.releaseParkedContinuation(completed);
      }
    } catch (updateError) {
      pending.settling = false;
      this.out(
        `claude-channel: could not confirm failed delivery ${pending.delivery.id}: ` +
          `${updateError instanceof Error ? updateError.message : String(updateError)}`,
      );
      this.schedulePendingRetry(pending, "failed acknowledgement", async () => {
        await this.failPending(seq, error);
      });
    }
  }

  private async inject(
    message: MsgFrame,
    delivery: DirectedDelivery | null,
    claimAlreadyJournaled = false,
  ): Promise<boolean> {
    const existing = this.pending.get(message.seq);
    if (existing) {
      if (
        existing.terminalError !== null &&
        !existing.settling &&
        existing.retryTimer === null
      ) {
        await this.failPending(message.seq, existing.terminalError);
      } else if (
        existing.terminalError === null &&
        existing.replyBody !== null &&
        !existing.replying
      ) {
        // A reconnect/redelivery is another authoritative opportunity to
        // reconcile the same stable REST idempotency key or terminal ACK.
        // Accelerate out of a long cooldown, while retaining one single-flight
        // timer/action for the pending row.
        this.stopPendingRetry(existing);
        existing.retryRound = 0;
        this.scheduleReplyRetry(existing);
      }
      return true;
    }
    if (delivery !== null && !claimAlreadyJournaled) {
      this.options.recoveryJournal?.recordClaim(delivery, message);
    }
    let ownerAnswerBinding: ParkedClaudeContinuation | null = null;
    if (delivery?.cause === "owner_answer") {
      try {
        ownerAnswerBinding = await this.bindingFor(delivery, message);
      } catch (error) {
        // A history outage is not proof that the privileged owner answer is
        // invalid. Leave it claimed so the Worker can retry rather than
        // emitting an irreversible failed receipt from incomplete evidence.
        this.out(
          `claude-channel: could not reconcile owner answer ${delivery.id} from durable history: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }
    if (delivery?.cause === "owner_answer" && ownerAnswerBinding === null) {
      const detail = "owner answer has no exact parked delivery/work/continuation lineage";
      const rejected: PendingChannelMessage = {
        message,
        delivery,
        renewTimer: null,
        renewEpoch: 0,
        renewing: false,
        retryTimer: null,
        retryRound: 0,
        replying: false,
        settling: false,
        terminalError: detail,
        recoveryTimer: null,
        harnessClaimed: false,
        claimReceipt: null,
        claimNotificationAttempts: 0,
        replyIdempotencyKey: replyIdempotencyKey(this.options.channel, message, delivery),
        replyBody: null,
        replySeq: null,
        // An invalid owner answer must not release a possibly unrelated parked
        // continuation even if its failed ACK is accepted.
        continuationKey: null,
      };
      this.pending.set(message.seq, rejected);
      await this.failPending(message.seq, detail);
      this.out(`claude-channel: rejected owner answer ${delivery.id}: ${detail}`);
      return true;
    }
    const pending: PendingChannelMessage = {
      message,
      delivery,
      renewTimer: null,
      renewEpoch: 0,
      renewing: false,
      retryTimer: null,
      retryRound: 0,
      replying: false,
      settling: false,
      terminalError: null,
      recoveryTimer: null,
      harnessClaimed: false,
      claimReceipt: null,
      claimNotificationAttempts: 0,
      replyIdempotencyKey: replyIdempotencyKey(this.options.channel, message, delivery),
      replyBody: null,
      replySeq: null,
      continuationKey: ownerAnswerBinding?.key ?? null,
    };
    this.pending.set(message.seq, pending);
    if (delivery !== null) {
      try {
        const state = await this.confirmDeliveryUpdate(deliveryUpdate(delivery, "running"));
        if (state !== "running") {
          throw new Error(`delivery state is ${state}, expected running`);
        }
        this.options.recoveryJournal?.update(delivery.id, {
          phase: "running_authorized",
          delivery: { ...delivery, state: "running" },
        });
      } catch (error) {
        if (error instanceof DeliveryConnectionReplacedError) {
          this.out(
            `claude-channel: running acknowledgement for ${delivery.id} was interrupted by reconnect; ` +
              "recovering its durable ownership before notification",
          );
          return false;
        }
        const detail = error instanceof Error ? error.message : String(error);
        await this.failPending(
          message.seq,
          `could not confirm running delivery before Claude notification: ${detail}`.slice(0, 500),
        );
        this.out(
          `claude-channel: could not claim running delivery ${delivery.id}: ` +
            detail,
        );
        return false;
      }
      this.startLeaseRenewal(pending);
    }
    try {
      if (delivery !== null) {
        this.options.recoveryJournal?.update(delivery.id, { phase: "harness_issued" });
      }
      if (this.options.requireHarnessClaim === true && delivery !== null) {
        await this.notifyHarnessClaim(pending);
      } else {
        await this.options.notify(
          notificationFor(this.options.channel, message, delivery, ownerAnswerBinding),
        );
      }
      if (delivery !== null && this.options.requireHarnessClaim !== true) {
        pending.harnessClaimed = true;
        this.options.recoveryJournal?.update(delivery.id, { phase: "harness_accepted" });
      }
      this.out(
        `claude-channel: queued #${this.options.channel} seq=${message.seq} from @${message.sender.name}` +
          (delivery === null ? "" : ` delivery=${delivery.id}`),
      );
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (delivery !== null && this.options.requireHarnessClaim !== true) {
        // The full task body was handed to the Channel transport. A rejection
        // and an after-write disconnect are observationally identical here:
        // neither authorizes replay or an ordinary failed receipt.
        this.preservePostHarnessDebt(
          pending,
          `Claude channel notification outcome is uncertain: ${detail}`,
        );
        this.out(`claude-channel: uncertain injection for seq=${message.seq}: ${detail}`);
        return true;
      }
      await this.failPending(
        message.seq,
        `claude channel notification failed: ${detail}`.slice(0, 500),
      );
      this.out(`claude-channel: failed to inject seq=${message.seq}: ${detail}`);
      return false;
    }
  }

  async handleFrame(incoming: ServerFrame): Promise<void> {
    if (incoming.type === "delivery_recovery") {
      this.observeDeliveryRecovery(incoming);
      return;
    }
    if (incoming.type === "delivery_state") {
      this.observeDeliveryAck(incoming);
      return;
    }
    if (incoming.type === "welcome") {
      const reconnect = this.welcomeGeneration > 0;
      this.welcomeGeneration += 1;
      this.resetJournalRecoveryBackoff(this.welcomeGeneration);
      if (reconnect) {
        for (const [requestId, pending] of this.deliveryAcks) {
          clearTimeout(pending.timer);
          pending.reject(new DeliveryConnectionReplacedError(
            "AgentParty websocket was replaced before the delivery acknowledgement arrived",
          ));
          this.deliveryAcks.delete(requestId);
        }
        for (const [requestId, pending] of this.deliveryRecoveries) {
          clearTimeout(pending.timer);
          pending.reject(new DeliveryConnectionReplacedError(
            "AgentParty websocket was replaced before ownership recovery completed",
          ));
          this.deliveryRecoveries.delete(requestId);
        }
        for (const pending of this.pending.values()) {
          this.stopLeaseRenewal(pending);
          if (pending.recoveryTimer) clearTimeout(pending.recoveryTimer);
          pending.recoveryTimer = null;
        }
      }
      this.self = incoming.self;
      this.directedDeliveryMode = incoming.directed_delivery === "v1";
      if (
        this.options.requireHarnessClaim === true &&
        (!this.directedDeliveryMode || incoming.delivery_recovery !== "v1")
      ) {
        this.exitCode = 1;
        this.out(
          "claude-channel: Worker lacks directed_delivery v1 + delivery_recovery v1; " +
            "refusing same-session execution without durable ownership",
        );
        this.options.connection.close();
        return;
      }
      if (this.directedDeliveryMode) {
        this.options.connection.send({ type: "delivery_adapter", adapter: "watch", op: "register" });
        // Recovery starts immediately instead of sitting behind a running-ACK
        // waiter from the dead socket. New work remains behind the joined
        // barrier until both the cancelled old lane and ownership CAS settle.
        const generation = this.welcomeGeneration;
        this.joinJournalRecovery(generation);
      }
      this.out(
        `claude-channel: attached to #${this.options.channel} as @${this.self}` +
          (this.directedDeliveryMode ? " (directed-delivery v1)" : " (legacy message fallback)"),
      );
      return;
    }
    if (incoming.type === "error") {
      // delivery_update errors are not correlated with request_id on the wire.
      // A renewal already in flight can race a REST reply that made the row
      // terminal. Keep the bridge alive and let the bounded ACK waiter
      // timeout/cancel instead of treating that stale receipt as a session-wide
      // fatal error.
      if (
        incoming.code === "bad_request" &&
        (this.deliveryAcks.size > 0 || this.deliveryRecoveries.size > 0)
      ) {
        this.out(
          `claude-channel: ignored uncorrelated delivery update error while awaiting ACK: ${incoming.message}`,
        );
        return;
      }
      this.out(`claude-channel: AgentParty error ${incoming.code}: ${incoming.message}`);
      if (incoming.code === "unauthorized") this.exitCode = EXIT_AUTH;
      else if (incoming.code === "archived") this.exitCode = EXIT_ARCHIVED;
      else this.exitCode = 1;
      this.options.connection.close();
      return;
    }

    const delivery = incoming.type === "delivery" ? incoming.delivery : null;
    const message = incoming.type === "delivery" ? incoming.message : incoming;
    if (message.type !== "msg") return;

    if (delivery !== null) {
      // Server-side membership and target routing are the trust boundary. The
      // adapter additionally fails closed on a mismatched target/state and
      // never lets the current session wake itself.
      if (
        delivery.target_name !== this.self ||
        delivery.state !== "claimed" ||
        message.sender.name === this.self ||
        this.settledDeliveryIds.has(delivery.id)
      ) {
        return;
      }
      await this.inject(message, delivery);
      return;
    }

    const fresh = message.seq > this.options.connection.cursor;
    const mentioned = message.mentions.includes(this.self);
    if (this.directedDeliveryMode && mentioned) {
      if (fresh) this.options.connection.ack(message.seq);
      return;
    }
    if (
      !fresh ||
      !mentioned ||
      message.sender.name === this.self ||
      this.seenPlainSeqs.has(message.seq)
    ) {
      if (fresh) this.options.connection.ack(message.seq);
      return;
    }
    const injected = await this.inject(message, null);
    if (injected) {
      this.rememberBounded(this.seenPlainSeqs, message.seq);
      if (fresh) this.options.connection.ack(message.seq);
    }
  }

  private async postPendingReply(pending: PendingChannelMessage): Promise<void> {
    if (pending.replySeq !== null) return;
    if (pending.replyBody === null) {
      throw new Error(`linked reply for seq=${pending.message.seq} has no persisted body`);
    }
    const posted = await this.options.postReply({
      body: pending.replyBody,
      mentions: [pending.message.sender.name],
      replyTo: pending.message.seq,
      idempotencyKey: pending.replyIdempotencyKey,
    });
    pending.replySeq = posted.seq;
    if (pending.delivery) {
      this.options.recoveryJournal?.update(pending.delivery.id, {
        phase: "reply_posted",
        replyBody: pending.replyBody,
        replySeq: posted.seq,
      });
    }
    pending.retryRound = 0;
  }

  private async settlePendingReply(pending: PendingChannelMessage): Promise<{ seq: number }> {
    const seq = pending.message.seq;
    const replySeq = pending.replySeq;
    if (replySeq === null) {
      throw new Error(`linked reply for seq=${seq} did not return a sequence`);
    }
    if (pending.delivery === null) {
      this.clearPending(seq);
      this.out(`claude-channel: replied to seq=${seq} with seq=${replySeq}`);
      return { seq: replySeq };
    }

    const state = await this.confirmDeliveryUpdate(
      deliveryUpdate(pending.delivery, "replied", { replySeq }),
    );
    if (state === "waiting_owner") {
      if (pending.delivery.cause === "owner_answer") {
        throw new Error("owner answer delivery unexpectedly remained waiting_owner");
      }
      const parked = this.parkContinuation(pending);
      if (parked) {
        this.out(
          `claude-channel: parked delivery ${pending.delivery.id} as ` +
            `${parked.workId}/${parked.continuationRef} until its owner answer arrives`,
        );
      } else {
        this.out(
          `claude-channel: ignored late waiting_owner acknowledgement for completed ` +
            `continuation ${pending.delivery.id}`,
        );
      }
    } else if (state !== "replied") {
      throw new Error(`delivery state is ${state}, expected replied or waiting_owner`);
    }
    const completed = this.clearPending(seq);
    if (completed?.delivery) {
      this.options.recoveryJournal?.remove(completed.delivery.id);
      this.rememberBounded(this.settledDeliveryIds, completed.delivery.id);
      if (state === "replied") this.releaseParkedContinuation(completed);
    }
    this.out(`claude-channel: replied to seq=${seq} with seq=${replySeq}`);
    return { seq: replySeq };
  }

  private async persistAndSettlePendingReply(
    pending: PendingChannelMessage,
  ): Promise<{ seq: number }> {
    try {
      await this.postPendingReply(pending);
    } catch (error) {
      if (pending.replySeq === null) throw error;
      // An owner_answer may have arrived while the source POST response was
      // lost. Its privileged request_seq + durable source history recovered
      // the exact reply sequence, so continue as success instead of returning
      // a false tool error and asking Claude to repost.
      this.out(
        `claude-channel: recovered linked reply seq=${pending.replySeq} for ` +
          `source seq=${pending.message.seq} from authoritative owner answer`,
      );
    }
    return await this.settlePendingReply(pending);
  }

  private scheduleReplyRetry(pending: PendingChannelMessage): void {
    this.schedulePendingRetry(pending, "linked reply settlement", async () => {
      if (this.pending.get(pending.message.seq) !== pending || pending.replying) return;
      pending.replying = true;
      this.stopLeaseRenewal(pending);
      try {
        await this.persistAndSettlePendingReply(pending);
      } catch (error) {
        pending.replying = false;
        if (pending.replySeq === null) this.startLeaseRenewal(pending);
        throw error;
      }
    });
  }

  claim(executionId: string): { claimed: boolean; receipt: string | null; content: string } {
    const pending = [...this.pending.values()].find(
      (candidate) => candidate.delivery?.id === executionId,
    );
    if (pending === undefined || pending.delivery === null) {
      throw new Error(`no recoverable AgentParty execution for ${executionId}`);
    }
    if (pending.terminalError !== null) {
      throw new Error(`AgentParty execution ${executionId} is already failing`);
    }
    if (this.recoveringDeliveryIds.has(executionId)) {
      throw new Error(
        `AgentParty execution ${executionId} is recovering ownership; retry the claim`,
      );
    }
    if (pending.harnessClaimed) {
      return {
        claimed: false,
        receipt: pending.claimReceipt,
        content:
          `Execution ${executionId} receipt ${pending.claimReceipt ?? "(unknown)"} was already accepted. ` +
          "Do not execute it again and do not send another reply.",
      };
    }
    const journal = this.options.recoveryJournal;
    if (journal === undefined) {
      throw new Error(`AgentParty execution ${executionId} has no durable claim journal`);
    }
    let receipt = pending.claimReceipt;
    if (receipt === null) {
      const candidate = randomUUID();
      // Persist the invocation identity before returning any task content.
      // If this commit fails, no body is released. If the MCP response is lost
      // afterward, the same generation returns the same receipt and body.
      const entry = journal.update(executionId, { claimReceipt: candidate });
      receipt = entry.claimReceipt;
      pending.claimReceipt = receipt;
    }
    if (receipt === null) {
      throw new Error(`AgentParty execution ${executionId} could not allocate a claim receipt`);
    }
    const continuation = pending.continuationKey === null
      ? null
      : this.parkedContinuations.get(pending.continuationKey) ?? null;
    return {
      claimed: true,
      receipt,
      content:
        `AgentParty claim receipt: ${receipt}\n` +
        `Before doing any work or causing any side effect, call ${ACCEPT_TOOL} with ` +
        `execution_id=${executionId} and claim_receipt=${receipt}. ` +
        "If this exact receipt is already present in the session, do not execute it twice.\n\n" +
        notificationFor(
          this.options.channel,
          pending.message,
          pending.delivery,
          continuation,
        ).content,
    };
  }

  accept(executionId: string, claimReceipt: string): { accepted: boolean; content: string } {
    const pending = [...this.pending.values()].find(
      (candidate) => candidate.delivery?.id === executionId,
    );
    if (pending === undefined || pending.delivery === null) {
      throw new Error(`no recoverable AgentParty execution for ${executionId}`);
    }
    if (pending.terminalError !== null) {
      throw new Error(`AgentParty execution ${executionId} is already failing`);
    }
    if (this.recoveringDeliveryIds.has(executionId)) {
      throw new Error(
        `AgentParty execution ${executionId} is recovering ownership; retry acceptance`,
      );
    }
    if (
      pending.claimReceipt === null ||
      claimReceipt.length === 0 ||
      claimReceipt !== pending.claimReceipt
    ) {
      throw new Error(
        `claim receipt for AgentParty execution ${executionId} is invalid or belongs to an old ownership generation`,
      );
    }
    if (pending.harnessClaimed) {
      return {
        accepted: false,
        content:
          `Execution ${executionId} receipt ${claimReceipt} was already durably accepted. ` +
          "Continue the existing execution; do not execute it twice.",
      };
    }
    const journal = this.options.recoveryJournal;
    if (journal === undefined) {
      throw new Error(`AgentParty execution ${executionId} has no durable claim journal`);
    }
    const current = journal.get(executionId);
    if (
      current === null ||
      current.phase !== "harness_issued" ||
      current.claimReceipt !== claimReceipt
    ) {
      throw new Error(
        `claim receipt for AgentParty execution ${executionId} is no longer current`,
      );
    }
    // The accept request itself proves the harness received the full claim
    // result (the unpredictable receipt is only present there). Commit before
    // acknowledging the tool call; an ACK loss is therefore idempotent.
    journal.update(executionId, {
      phase: "harness_accepted",
      claimReceipt,
    });
    pending.harnessClaimed = true;
    if (pending.recoveryTimer) clearTimeout(pending.recoveryTimer);
    pending.recoveryTimer = null;
    return {
      accepted: true,
      content:
        `Execution ${executionId} receipt ${claimReceipt} is durably accepted. ` +
        "Execute it once, then send exactly one linked reply.",
    };
  }

  async reply(seq: number, text: string): Promise<{ seq: number }> {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new Error("seq must be a positive integer");
    }
    const body = text.trim();
    if (body.length === 0) throw new Error("reply text must not be empty");
    if (new TextEncoder().encode(body).byteLength > BODY_LIMIT) {
      throw new Error(`reply exceeds ${BODY_LIMIT} UTF-8 bytes`);
    }
    const pending = this.pending.get(seq);
    if (!pending) {
      throw new Error(`no pending AgentParty channel message for seq=${seq}; it may already have been replied to`);
    }
    if (pending.terminalError !== null) {
      throw new Error(`delivery for seq=${seq} already failed before Claude could reply`);
    }
    if (
      this.options.requireHarnessClaim === true &&
      pending.delivery !== null &&
      !pending.harnessClaimed
    ) {
      throw new Error(
        `delivery for seq=${seq} must be claimed with ${CLAIM_TOOL} and accepted with ` +
          `${ACCEPT_TOOL} before replying`,
      );
    }
    if (pending.replying) throw new Error(`reply already in progress for seq=${seq}`);
    pending.replyBody ??= body;
    if (pending.delivery) {
      this.options.recoveryJournal?.update(pending.delivery.id, {
        replyBody: pending.replyBody,
      });
    }
    // A durable reply body supersedes every claim/recovery timeout. Clear the
    // timer before the first asynchronous persistence boundary so no callback
    // can race this exact late-success path into a permanent failed state.
    if (pending.recoveryTimer) clearTimeout(pending.recoveryTimer);
    pending.recoveryTimer = null;
    pending.replying = true;
    this.stopPendingRetry(pending);
    // Stop/epoch-guard renewal before REST persistence starts. The Worker may
    // make the delivery terminal/waiting_owner before the HTTP response reaches
    // us; a stale running update after that point would otherwise be rejected
    // and could tear down the whole channel bridge.
    this.stopLeaseRenewal(pending);

    try {
      return await this.persistAndSettlePendingReply(pending);
    } catch (error) {
      pending.replying = false;
      if (pending.replySeq === null) this.startLeaseRenewal(pending);
      this.scheduleReplyRetry(pending);
      const phase = pending.replySeq === null ? "persistence" : "delivery acknowledgement";
      this.out(
        `claude-channel: linked reply ${phase} did not settle for seq=${seq}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  close(): void {
    this.intentionalClose = true;
    this.stopped = true;
    this.cancelJournalRecoveryRetry();
    for (const seq of [...this.pending.keys()]) this.clearPending(seq);
    this.parkedContinuations.clear();
    this.completedContinuationKeys.clear();
    for (const [requestId, pending] of this.deliveryAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Claude Channel bridge closed"));
      this.deliveryAcks.delete(requestId);
    }
    for (const [requestId, pending] of this.deliveryRecoveries) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Claude Channel bridge closed"));
      this.deliveryRecoveries.delete(requestId);
    }
    this.options.connection.close();
  }

  async run(): Promise<number> {
    try {
      for await (const frame of this.options.connection.frames) {
        if (
          frame.type === "delivery_state" ||
          frame.type === "delivery_recovery" ||
          frame.type === "welcome" ||
          frame.type === "error"
        ) {
          await this.handleFrame(frame);
          continue;
        }
        // Keep the stream reader available for delivery_state ACKs while the
        // ordered work lane waits for those confirmations.
        this.frameWork = this.frameWork
          .then(() => this.handleFrame(frame))
          .catch((error) => {
            this.out(
              `claude-channel: failed to process AgentParty frame: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
    } finally {
      this.stopped = true;
      this.cancelJournalRecoveryRetry();
      for (const [requestId, pending] of this.deliveryAcks) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Claude Channel frame stream stopped"));
        this.deliveryAcks.delete(requestId);
      }
      for (const [requestId, pending] of this.deliveryRecoveries) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Claude Channel frame stream stopped"));
        this.deliveryRecoveries.delete(requestId);
      }
      await this.frameWork;
      for (const seq of [...this.pending.keys()]) this.clearPending(seq);
      this.parkedContinuations.clear();
      this.completedContinuationKeys.clear();
      this.options.connection.close();
    }
    if (this.intentionalClose) return this.exitCode;
    return this.exitCode === 0 ? EXIT_STREAM_ENDED : this.exitCode;
  }
}

function toolResult(text: string, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
} {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, ["channel"]);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  if (positionals.length > 1) {
    console.error("usage: party claude-channel [channel|--channel C]");
    return 1;
  }

  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("claude-channel: no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const serverUrl = auth.server;
  const token = auth.token;
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("claude-channel: no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("claude-channel: channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }

  // Reuse the serve lock namespace: `party serve` and a live-session channel
  // adapter are two delivery consumers for the same identity/channel and must
  // never execute the same work concurrently.
  const lock = acquireInstanceLock(
    "serve",
    instanceLockTarget(serverUrl, token, channel),
    defaultInstanceLockDir(),
  );
  if (!lock.ok) {
    console.error(
      `claude-channel: another serve/session bridge already owns #${channel}` +
        (lock.heldByPid === undefined ? "" : ` (pid=${lock.heldByPid})`),
    );
    return 1;
  }

  const connection = connect(serverUrl, token, channel, loadCursor(channel), {
    directedDelivery: "v1",
    deliveryRecovery: "v1",
    advertiseWakeKind: "daemon",
    onCursor: (cursor) => saveCursor(channel, cursor),
  });
  const recoveryJournal = new DeliveryRecoveryJournal(
    deliveryRecoveryJournalPath("claude", serverUrl, token, channel),
    channel,
    "claude",
  );
  const server = new Server<Request, ClaudeChannelNotification, Result>(
    { name: "agentparty-channel", version: pkg.version },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions:
        `Durable AgentParty inputs must first be fetched with ${CLAIM_TOOL}. The same unaccepted ` +
        "ownership generation returns one stable receipt and body. After reading the complete result, " +
        `call ${ACCEPT_TOOL} with the exact execution id and receipt before doing any work or causing ` +
        `any side effect. Only after that durable acceptance may you execute and reply once with ${REPLY_TOOL}; ` +
        "do not use party_send for a channel reply. A tool success means the linked AgentParty reply was persisted.",
    },
  );
  let markMcpInitialized!: (ready: boolean) => void;
  const mcpInitialized = new Promise<boolean>((resolve) => {
    markMcpInitialized = resolve;
  });
  const bridge = new ClaudeChannelDeliveryBridge({
    channel,
    connection,
    recoveryJournal,
    requireHarnessClaim: true,
    notify: async (notification) => {
      if (!await mcpInitialized) throw new Error("Claude closed the MCP channel before initialization");
      await server.notification({
        method: "notifications/claude/channel",
        params: notification,
      });
    },
    postReply: async ({ body, mentions, replyTo, idempotencyKey }) => {
      const posted = await postMessage(serverUrl, token, channel, {
        kind: "message",
        body,
        mentions,
        reply_to: replyTo,
        idempotency_key: idempotencyKey,
      });
      return { seq: posted.seq };
    },
    loadMessage: async (seq) => {
      const messages = await fetchMessages(
        serverUrl,
        token,
        channel,
        Math.max(0, seq - 1),
        1,
      );
      return messages.find((message) => message.seq === seq) ?? null;
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: CLAIM_TOOL,
        title: "Claim one durable AgentParty delivery",
        description:
          "Fetch a stable claim receipt and task body. Repeating an unaccepted claim in the same ownership generation returns the same receipt and body.",
        inputSchema: {
          type: "object",
          properties: {
            execution_id: {
              type: "string",
              minLength: 1,
              description: "execution_id from the AgentParty channel notification",
            },
          },
          required: ["execution_id"],
          additionalProperties: false,
        },
      },
      {
        name: ACCEPT_TOOL,
        title: "Accept one claimed AgentParty delivery",
        description:
          "Durably acknowledge that the full claim result reached this Claude session. Call this with the exact receipt before any work or side effect.",
        inputSchema: {
          type: "object",
          properties: {
            execution_id: {
              type: "string",
              minLength: 1,
              description: "execution_id returned by the claim notification",
            },
            claim_receipt: {
              type: "string",
              minLength: 1,
              description: "exact stable receipt returned by party_channel_claim",
            },
          },
          required: ["execution_id", "claim_receipt"],
          additionalProperties: false,
        },
      },
      {
        name: REPLY_TOOL,
        title: "Reply to an AgentParty Channel message",
        description:
          "Persist one reply to the exact AgentParty message that entered this Claude session. Use the seq from the channel input.",
        inputSchema: {
          type: "object",
          properties: {
            seq: { type: "integer", minimum: 1, description: "AgentParty message sequence from the channel input" },
            text: { type: "string", minLength: 1, description: "Reply body" },
          },
          required: ["seq", "text"],
          additionalProperties: false,
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === CLAIM_TOOL) {
      const executionId = request.params.arguments?.execution_id;
      if (typeof executionId !== "string") {
        return toolResult(`${CLAIM_TOOL} requires string execution_id`, true);
      }
      try {
        const claimed = bridge.claim(executionId);
        return toolResult(claimed.content, !claimed.claimed);
      } catch (error) {
        return toolResult(error instanceof Error ? error.message : String(error), true);
      }
    }
    if (request.params.name === ACCEPT_TOOL) {
      const executionId = request.params.arguments?.execution_id;
      const claimReceipt = request.params.arguments?.claim_receipt;
      if (typeof executionId !== "string" || typeof claimReceipt !== "string") {
        return toolResult(
          `${ACCEPT_TOOL} requires string execution_id and string claim_receipt`,
          true,
        );
      }
      try {
        const accepted = bridge.accept(executionId, claimReceipt);
        return toolResult(accepted.content);
      } catch (error) {
        return toolResult(error instanceof Error ? error.message : String(error), true);
      }
    }
    if (request.params.name !== REPLY_TOOL) {
      return toolResult(`unknown tool: ${request.params.name}`, true);
    }
    const args = request.params.arguments;
    const seq = args?.seq;
    const text = args?.text;
    if (typeof seq !== "number" || typeof text !== "string") {
      return toolResult(`${REPLY_TOOL} requires integer seq and string text`, true);
    }
    try {
      const posted = await bridge.reply(seq, text);
      return toolResult(`AgentParty reply persisted as seq=${posted.seq} (reply_to=${seq}).`);
    } catch (error) {
      return toolResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  server.oninitialized = () => markMcpInitialized(true);
  server.onclose = () => {
    markMcpInitialized(false);
    bridge.close();
  };
  try {
    await server.connect(new StdioServerTransport());
    return await bridge.run();
  } finally {
    bridge.close();
    try {
      await server.close();
    } catch {
      // Transport may already be closed because Claude ended the session.
    }
    lock.release?.();
  }
}
