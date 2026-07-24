import { describe, expect, test } from "bun:test";
import type {
  ClientFrame,
  DirectedDeliveryFrame,
  ServerFrame,
} from "@agentparty/shared";
import {
  CodexAgentPartyBridge,
  CodexSessionController,
  type CodexRpcPeer,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../src/codex-app-server-bridge";
import { DeliveryRecoveryJournal } from "../src/delivery-recovery-journal";
import { deliveryFrame, welcomeDirectedFrame } from "./mock-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class DeliveryRpcPeer implements CodexRpcPeer {
  readonly initializeResult = {};
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  private readonly messages = new Set<(message: JsonRpcRequest | JsonRpcNotification) => void | Promise<void>>();
  private readonly reconnects = new Set<(generation: number) => void | Promise<void>>();
  connectionGeneration = 1;
  blockRestore: Promise<void> | null = null;
  restoreFailures = 0;
  disconnectTurnStarts = 0;
  turnIds: string[] = [];
  threadId = "thread-delivery";
  restoredTurns: Array<{
    id: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    items: Array<Record<string, unknown>>;
  }> = [];
  restoredStatus: "idle" | "active" = "idle";

  async start(): Promise<void> {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume" || method === "thread/read") {
      if (method === "thread/resume" || method === "thread/read") await this.blockRestore;
      if (method === "thread/resume" && this.restoreFailures > 0) {
        this.restoreFailures -= 1;
        throw new Error("restore failed once");
      }
      return {
        thread: {
          id: this.threadId,
          status: { type: this.restoredStatus },
          turns: this.restoredTurns,
        },
      };
    }
    if (method === "turn/start") {
      if (this.disconnectTurnStarts > 0) {
        this.disconnectTurnStarts -= 1;
        throw new Error("stdio proxy disconnected after write");
      }
      const turnId = this.turnIds.shift() ?? "turn-delivery";
      return {
        turn: {
          id: turnId,
          status: "inProgress",
          items: [{
            type: "userMessage",
            clientId: (params as { clientUserMessageId: string }).clientUserMessageId,
          }],
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  }

  async requestConnected(
    method: string,
    params?: unknown,
    expectedGeneration?: number,
  ): Promise<unknown> {
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== this.connectionGeneration
    ) {
      throw new Error("fake generation changed before request write");
    }
    return await this.request(method, params);
  }

  async notify(): Promise<void> {}
  respond(_id: JsonRpcId, _result?: unknown, _error?: JsonRpcResponse["error"]): void {}

  onMessage(
    listener: (message: JsonRpcRequest | JsonRpcNotification) => void | Promise<void>,
  ): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onReconnect(listener: (generation: number) => void | Promise<void>): () => void {
    this.reconnects.add(listener);
    return () => this.reconnects.delete(listener);
  }

  emit(message: JsonRpcRequest | JsonRpcNotification): void {
    for (const listener of this.messages) void listener(message);
  }

  emitReconnect(): void {
    this.connectionGeneration += 1;
    for (const listener of this.reconnects) {
      void Promise.resolve(listener(this.connectionGeneration)).catch(() => {});
    }
  }
}

function fakeConnection() {
  let cursor = 0;
  const sent: ClientFrame[] = [];
  const acked: number[] = [];
  let closed = false;
  return {
    sent,
    acked,
    get closed() {
      return closed;
    },
    connection: {
      frames: (async function* (): AsyncGenerator<ServerFrame> {})(),
      send(frame: ClientFrame) {
        sent.push(frame);
        return true;
      },
      ack(seq: number) {
        acked.push(seq);
        cursor = Math.max(cursor, seq);
      },
      close() {
        closed = true;
      },
      get cursor() {
        return cursor;
      },
    },
  };
}

function streamingConnection() {
  let cursor = 0;
  const sent: ClientFrame[] = [];
  const acked: number[] = [];
  const queued: ServerFrame[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const signal = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const frames = (async function* (): AsyncGenerator<ServerFrame> {
    for (;;) {
      const frame = queued.shift();
      if (frame) {
        yield frame;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  return {
    sent,
    acked,
    push(frame: ServerFrame) {
      queued.push(frame);
      signal();
    },
    connection: {
      frames,
      send(frame: ClientFrame) {
        sent.push(frame);
        return true;
      },
      ack(seq: number) {
        acked.push(seq);
        cursor = Math.max(cursor, seq);
      },
      close() {
        ended = true;
        signal();
      },
      get cursor() {
        return cursor;
      },
    },
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function ownerAnswerFrame(options: {
  seq: number;
  deliveryId: string;
  sourceDeliveryId: string;
  sourceSeq: number;
  workId: string;
  continuationRef: string;
  requestSeq: number;
}): DirectedDeliveryFrame {
  const source = deliveryFrame(options.seq, "owner approved", {
    id: options.deliveryId,
    target_name: "me",
    work_id: options.workId,
    continuation_ref: options.continuationRef,
    sender: { name: "alice", kind: "human" },
  }) as unknown as DirectedDeliveryFrame;
  return {
    ...source,
    delivery: { ...source.delivery, cause: "owner_answer" },
    message: {
      ...source.message,
      reply_to: options.requestSeq,
      decision_response: {
        request_seq: options.requestSeq,
        chosen_index: 0,
        chosen_option: "approve",
        delivery_id: options.sourceDeliveryId,
        origin_seq: options.sourceSeq,
        origin_channel: "dev",
        work_id: options.workId,
        continuation_ref: options.continuationRef,
      },
    },
  };
}

describe("Codex AgentParty delivery integration", () => {
  test("same-generation recovery retries transient restore failures before releasing writers", async () => {
    const rpc = new DeliveryRpcPeer();
    const session = new CodexSessionController(rpc, {
      recoveryRetryDelayMs: 50,
    });
    await session.request("thread/start", {});
    rpc.restoreFailures = 2;
    rpc.emitReconnect();
    const submission = session.submit({
      text: "first write after successful recovery",
      clientUserMessageId: "agentparty:restore-retry",
    });
    await waitFor(
      () => rpc.calls.filter((call) => call.method === "thread/resume").length === 2,
      "same connection did not retry its first transient restore failure",
    );
    expect(rpc.connectionGeneration).toBe(2);
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
    await expect(submission).resolves.toEqual({
      kind: "started",
      turnId: "turn-delivery",
    });
    expect(rpc.connectionGeneration).toBe(2);
    expect(rpc.calls.filter((call) => call.method === "thread/resume")).toHaveLength(3);
  });

  test("holds new writes behind thread resume/read after the backend reconnects", async () => {
    const rpc = new DeliveryRpcPeer();
    const session = new CodexSessionController(rpc);
    await session.request("thread/start", {});
    let release!: () => void;
    rpc.blockRestore = new Promise<void>((resolve) => {
      release = resolve;
    });
    rpc.emitReconnect();
    await waitFor(
      () => rpc.calls.some((call) => call.method === "thread/resume"),
      "restore did not begin",
    );
    const submission = session.submit({
      text: "wait for restore",
      clientUserMessageId: "agentparty:restore-barrier",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
    release();
    await expect(submission).resolves.toMatchObject({
      kind: "started",
      turnId: "turn-delivery",
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  });

  test("the production frame loop keeps reading while a delivery waits for its running ACK", async () => {
    const rpc = new DeliveryRpcPeer();
    const session = new CodexSessionController(rpc);
    const conn = streamingConnection();
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: conn.connection,
      session,
      deliveryAckTimeoutMs: 1_000,
      postReply: async () => ({ seq: 1 }),
    });
    const run = bridge.run();
    conn.push(welcomeDirectedFrame(0, "me") as ServerFrame);
    const incoming = deliveryFrame(14, "read the ACK on the same stream", {
      id: "delivery-14",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
    });
    conn.push(incoming as ServerFrame);
    await waitFor(
      () => conn.sent.some((frame) => frame.type === "delivery_update"),
      "running update was not sent",
    );
    const running = conn.sent.find((frame) => frame.type === "delivery_update") as
      Extract<ClientFrame, { type: "delivery_update" }> & { request_id: string };
    conn.push({
      type: "delivery_state",
      request_id: running.request_id,
      delivery: {
        ...incoming.delivery,
        state: "running",
      },
    } as ServerFrame);
    await waitFor(
      () => bridge.pendingCount === 1,
      "delivery ACK from the production frame loop did not unblock injection",
    );
    bridge.close();
    await expect(run).resolves.toBe(0);
  });

  test("does not inject until Worker confirms the authoritative running state", async () => {
    const rpc = new DeliveryRpcPeer();
    const session = new CodexSessionController(rpc);
    const conn = fakeConnection();
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: conn.connection,
      session,
      deliveryAckTimeoutMs: 1_000,
      postReply: async () => ({ seq: 1 }),
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    const incoming = deliveryFrame(13, "must wait for running ack", {
      id: "delivery-13",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
    });
    const handling = bridge.handleFrame(incoming as ServerFrame);
    await waitFor(
      () => conn.sent.some((frame) => frame.type === "delivery_update"),
      "running update was not sent",
    );
    expect(rpc.calls.filter((call) => call.method.startsWith("turn/"))).toHaveLength(0);
    const running = conn.sent.find((frame) => frame.type === "delivery_update") as
      Extract<ClientFrame, { type: "delivery_update" }> & { request_id: string };
    await bridge.handleFrame({
      type: "delivery_state",
      request_id: running.request_id,
      delivery: {
        ...incoming.delivery,
        state: "running",
      },
    } as ServerFrame);
    await handling;
    expect(bridge.pendingCount).toBe(1);
    bridge.close();
  });

  test("holds a delivery before TUI thread attach, injects it once, and persists the final linked reply", async () => {
    const rpc = new DeliveryRpcPeer();
    const session = new CodexSessionController(rpc);
    const conn = fakeConnection();
    const posts: unknown[] = [];
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: conn.connection,
      session,
      leaseRenewIntervalMs: 60_000,
      confirmDeliveryUpdate: async (update) => {
        conn.connection.send(update);
      },
      postReply: async (reply) => {
        posts.push(reply);
        return { seq: 88 };
      },
    });

    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(12, "same-session work", {
      id: "delivery-12",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
    }) as ServerFrame);
    expect(bridge.pendingCount).toBe(1);
    expect(rpc.calls.filter((call) => call.method.startsWith("turn/"))).toHaveLength(0);
    expect(conn.sent).toContainEqual(expect.objectContaining({
      type: "delivery_update",
      delivery_id: "delivery-12",
      state: "running",
    }));

    await session.request("thread/start", {});
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(rpc.calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
      threadId: "thread-delivery",
      clientUserMessageId: "agentparty:delivery-12",
      responsesapiClientMetadata: {
        source: "agentparty",
        channel: "dev",
        seq: "12",
        sender: "alice",
        delivery_id: "delivery-12",
      },
    });
    await expect(session.request("thread/start", {})).rejects.toThrow(
      "while 1 AgentParty delivery is still pending",
    );
    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);

    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-delivery",
        turn: {
          id: "turn-delivery",
          status: "completed",
          items: [{
            type: "agentMessage",
            id: "agent-final",
            text: "same-session answer",
          }],
        },
      },
    });
    await waitFor(() => posts.length === 1, "linked reply was not posted");
    await waitFor(() => bridge.pendingCount === 0, "linked reply did not settle the delivery");
    expect(posts).toEqual([{
      body: "same-session answer",
      idempotencyKey: "codex-bridge-reply:delivery-12",
      mentions: ["alice"],
      replyTo: 12,
    }]);
    expect(conn.sent).toContainEqual(expect.objectContaining({
      type: "delivery_update",
      delivery_id: "delivery-12",
      state: "replied",
      reply_seq: 88,
    }));
    expect(bridge.pendingCount).toBe(0);
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    bridge.close();
  });

  test("persists the exact attached thread at the writer boundary and cold-recovers an unknown write without replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-codex-write-boundary-"));
    let bridge: CodexAgentPartyBridge | null = null;
    let restartedBridge: CodexAgentPartyBridge | null = null;
    try {
      const path = join(root, "journal.json");
      const rpc = new DeliveryRpcPeer();
      rpc.threadId = "thread-exact-write-boundary";
      const session = new CodexSessionController(rpc);
      const conn = fakeConnection();
      const journal = new DeliveryRecoveryJournal(
        path,
        "dev",
        "codex",
      );
      bridge = new CodexAgentPartyBridge({
        channel: "dev",
        connection: conn.connection,
        session,
        recoveryJournal: journal,
        leaseRenewIntervalMs: 60_000,
        confirmDeliveryUpdate: async (update) => update.state,
        postReply: async () => ({ seq: 1 }),
      });

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(deliveryFrame(112, "queued before thread attach", {
        id: "delivery-write-boundary",
        target_name: "me",
      }) as ServerFrame);
      expect(rpc.calls.filter((call) => call.method.startsWith("turn/"))).toHaveLength(0);
      expect(journal.get("delivery-write-boundary")).toMatchObject({
        phase: "running_authorized",
        threadId: null,
      });

      rpc.disconnectTurnStarts = 1;
      await session.request("thread/start", {});
      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
      expect(journal.get("delivery-write-boundary")).toMatchObject({
        phase: "harness_issued",
        threadId: "thread-exact-write-boundary",
        turnId: null,
      });
      expect(rpc.calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
        threadId: "thread-exact-write-boundary",
        clientUserMessageId: "agentparty:delivery-write-boundary",
      });
      bridge.close();
      bridge = null;

      const restartedJournal = new DeliveryRecoveryJournal(path, "dev", "codex");
      expect(restartedJournal.get("delivery-write-boundary")).toMatchObject({
        phase: "harness_issued",
        threadId: "thread-exact-write-boundary",
        turnId: null,
      });

      const restartedRpc = new DeliveryRpcPeer();
      restartedRpc.threadId = "thread-exact-write-boundary";
      restartedRpc.restoredTurns = [];
      const restartedSession = new CodexSessionController(restartedRpc);
      await restartedSession.request("thread/resume", {
        threadId: "thread-exact-write-boundary",
      });
      const restartedConnection = fakeConnection();
      restartedBridge = new CodexAgentPartyBridge({
        channel: "dev",
        connection: restartedConnection.connection,
        session: restartedSession,
        recoveryJournal: restartedJournal,
        requireDeliveryRecovery: true,
        leaseRenewIntervalMs: 60_000,
        deliveryAckTimeoutMs: 1_000,
        confirmDeliveryUpdate: async (update) => update.state,
        postReply: async () => ({ seq: 1 }),
      });
      await restartedBridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await waitFor(
        () => restartedConnection.sent.some((frame) => frame.type === "delivery_recover"),
        "cold bridge did not request exact ownership recovery",
      );
      const recovery = restartedConnection.sent.find((frame) =>
        frame.type === "delivery_recover"
      ) as Extract<ClientFrame, { type: "delivery_recover" }>;
      await restartedBridge.handleFrame({
        type: "delivery_recovery",
        delivery_id: recovery.delivery_id,
        request_id: recovery.request_id,
        result: "recovered",
        state: "running",
        attempt: recovery.attempt,
        lease_epoch: recovery.lease_epoch,
        lease_token: recovery.next_lease_token,
        lease_until: Date.now() + 90_000,
      } as ServerFrame);
      await waitFor(
        () =>
          restartedJournal.get("delivery-write-boundary")?.delivery.lease_token ===
            recovery.next_lease_token,
        "cold bridge did not durably accept recovered ownership",
      );

      expect(restartedBridge.pendingCount).toBe(1);
      expect(restartedJournal.get("delivery-write-boundary")).toMatchObject({
        phase: "harness_issued",
        threadId: "thread-exact-write-boundary",
        turnId: null,
      });
      expect(restartedRpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
    } finally {
      restartedBridge?.close();
      bridge?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists active-thread affinity before the running ACK can reach the writer", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-codex-pre-writer-thread-"));
    let bridge: CodexAgentPartyBridge | null = null;
    try {
      const path = join(root, "journal.json");
      const rpc = new DeliveryRpcPeer();
      rpc.threadId = "thread-pre-writer-crash";
      rpc.restoredStatus = "active";
      rpc.restoredTurns = [{
        id: "review-pre-writer",
        status: "inProgress",
        items: [{ type: "enteredReviewMode", id: "entered-review" }],
      }];
      const session = new CodexSessionController(rpc);
      await session.request("thread/resume", { threadId: rpc.threadId });
      const journal = new DeliveryRecoveryJournal(path, "dev", "codex");
      bridge = new CodexAgentPartyBridge({
        channel: "dev",
        connection: fakeConnection().connection,
        session,
        recoveryJournal: journal,
        leaseRenewIntervalMs: 60_000,
        confirmDeliveryUpdate: async (update) => update.state,
        postReply: async () => ({ seq: 1 }),
      });

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(deliveryFrame(113, "queue on the exact active thread", {
        id: "delivery-pre-writer-thread",
        target_name: "me",
      }) as ServerFrame);
      expect(rpc.calls.filter((call) => call.method.startsWith("turn/"))).toHaveLength(0);
      expect(journal.get("delivery-pre-writer-thread")).toMatchObject({
        phase: "running_authorized",
        threadId: "thread-pre-writer-crash",
      });

      bridge.close();
      bridge = null;
      const restarted = new DeliveryRecoveryJournal(path, "dev", "codex");
      expect(restarted.entries().map((entry) => entry.threadId)).toEqual([
        "thread-pre-writer-crash",
      ]);
    } finally {
      bridge?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not POST until replyBody WAL succeeds, then retries once and settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-codex-reply-wal-"));
    let bridge: CodexAgentPartyBridge | null = null;
    try {
      let failNextCommit = false;
      let walFailures = 0;
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "codex",
        {
          persist: (commit) => {
            if (failNextCommit) {
              failNextCommit = false;
              walFailures += 1;
              const error = new Error("replyBody WAL is full") as NodeJS.ErrnoException;
              error.code = "ENOSPC";
              throw error;
            }
            commit();
          },
        },
      );
      const rpc = new DeliveryRpcPeer();
      const session = new CodexSessionController(rpc);
      const conn = fakeConnection();
      const posts: string[] = [];
      const repliedUpdates: number[] = [];
      bridge = new CodexAgentPartyBridge({
        channel: "dev",
        connection: conn.connection,
        session,
        recoveryJournal: journal,
        leaseRenewIntervalMs: 60_000,
        retryDelayMs: 100,
        confirmDeliveryUpdate: async (update) => {
          if (update.state === "replied" && update.reply_seq !== undefined) {
            repliedUpdates.push(update.reply_seq);
          }
          return update.state;
        },
        postReply: async ({ idempotencyKey }) => {
          posts.push(idempotencyKey);
          return { seq: 1_181 };
        },
      });

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(deliveryFrame(118, "persist before REST", {
        id: "delivery-reply-wal",
        target_name: "me",
        sender: { name: "alice", kind: "human" },
      }) as ServerFrame);
      await session.request("thread/start", {});
      failNextCommit = true;
      rpc.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-delivery",
          turn: {
            id: "turn-delivery",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "reply-wal-final",
              text: "durable before posting",
            }],
          },
        },
      });

      await waitFor(() => walFailures === 1, "replyBody WAL fault was not injected");
      expect(posts).toHaveLength(0);
      expect(repliedUpdates).toHaveLength(0);
      expect(bridge.pendingCount).toBe(1);
      expect(journal.get("delivery-reply-wal")).toMatchObject({
        phase: "harness_accepted",
        replyBody: null,
        replySeq: null,
      });

      await waitFor(
        () => bridge?.pendingCount === 0,
        "replyBody WAL retry did not settle the delivery",
      );
      expect(posts).toEqual(["codex-bridge-reply:delivery-reply-wal"]);
      expect(repliedUpdates).toEqual([1_181]);
      expect(journal.get("delivery-reply-wal")).toBeNull();
    } finally {
      bridge?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retries a lost REST response with one stable linked-reply idempotency key", async () => {
    const rpc = new DeliveryRpcPeer();
    const session = new CodexSessionController(rpc);
    const conn = fakeConnection();
    const postKeys: string[] = [];
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: conn.connection,
      session,
      leaseRenewIntervalMs: 60_000,
      retryDelayMs: 1,
      confirmDeliveryUpdate: async (update) => {
        conn.connection.send(update);
      },
      postReply: async ({ idempotencyKey }) => {
        postKeys.push(idempotencyKey);
        if (postKeys.length === 1) throw new Error("response lost after persistence");
        return { seq: 91 };
      },
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(15, "reply once", {
      id: "delivery-15",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
    }) as ServerFrame);
    await session.request("thread/start", {});
    const completed = {
      method: "turn/completed",
      params: {
        threadId: "thread-delivery",
        turn: {
          id: "turn-delivery",
          status: "completed",
          items: [{ type: "agentMessage", id: "agent-final", text: "one reply" }],
        },
      },
    } as const;
    rpc.emit(completed);
    await waitFor(() => bridge.pendingCount === 0, "stable-key retry did not settle the delivery");
    expect(postKeys).toEqual([
      "codex-bridge-reply:delivery-15",
      "codex-bridge-reply:delivery-15",
    ]);
    expect(conn.sent).toContainEqual(expect.objectContaining({
      type: "delivery_update",
      delivery_id: "delivery-15",
      state: "replied",
      reply_seq: 91,
    }));
    bridge.close();
  });

  test("cold reconnect preserves an absent after-write input for one exact late reply without replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-codex-after-write-"));
    try {
      const rpc = new DeliveryRpcPeer();
      const session = new CodexSessionController(rpc);
      const conn = fakeConnection();
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "codex",
      );
      const failedUpdates: string[] = [];
      const repliedUpdates: number[] = [];
      const posts: Array<{ replyTo: number; body: string }> = [];
      const bridge = new CodexAgentPartyBridge({
        channel: "dev",
        connection: conn.connection,
        session,
        recoveryJournal: journal,
        leaseRenewIntervalMs: 60_000,
        retryDelayMs: 1,
        confirmDeliveryUpdate: async (update) => {
          if (update.state === "failed") failedUpdates.push(update.error ?? "");
          if (update.state === "replied" && update.reply_seq !== undefined) {
            repliedUpdates.push(update.reply_seq);
          }
          return update.state;
        },
        postReply: async ({ replyTo, body }) => {
          posts.push({ replyTo, body });
          return { seq: 117 };
        },
      });

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await session.request("thread/start", {});
      rpc.disconnectTurnStarts = 1;
      await bridge.handleFrame(deliveryFrame(17, "unknown write", {
        id: "delivery-17",
        target_name: "me",
        sender: { name: "alice", kind: "human" },
      }) as ServerFrame);
      expect(bridge.pendingCount).toBe(1);
      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
      expect(journal.get("delivery-17")).toMatchObject({ phase: "harness_issued" });

      rpc.emitReconnect();
      await waitFor(
        () => rpc.calls.filter((call) => call.method === "thread/read").length >= 1,
        "cold recovery did not scan authoritative Codex history",
      );
      await expect(session.submit({
        text: "independent later work",
        clientUserMessageId: "agentparty:after-terminal-unknown",
      })).resolves.toMatchObject({ kind: "started" });
      expect(bridge.pendingCount).toBe(1);
      expect(failedUpdates).toHaveLength(0);
      expect(
        rpc.calls
          .filter((call) => call.method === "turn/start")
          .map((call) => (call.params as { clientUserMessageId?: string }).clientUserMessageId),
      ).toEqual([
        "agentparty:delivery-17",
        "agentparty:after-terminal-unknown",
      ]);

      rpc.restoredTurns = [{
        id: "turn-late-delivery-17",
        status: "completed",
        items: [
          { type: "userMessage", clientId: "agentparty:delivery-17" },
          { type: "agentMessage", id: "late-final", text: "late authoritative result" },
        ],
      }];
      rpc.emitReconnect();
      await waitFor(
        () => bridge.pendingCount === 0,
        "late authoritative Codex result did not settle preserved delivery debt",
      );
      expect(posts).toEqual([{ replyTo: 17, body: "late authoritative result" }]);
      expect(repliedUpdates).toEqual([117]);
      expect(failedUpdates).toHaveLength(0);
      expect(journal.get("delivery-17")).toBeNull();
      bridge.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cold recovery promotes reply_posted plus terminal waiting_owner into a durable parked binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-codex-waiting-owner-crash-"));
    let bridgeA: CodexAgentPartyBridge | null = null;
    let bridgeB: CodexAgentPartyBridge | null = null;
    try {
      const path = join(root, "journal.json");
      const journalA = new DeliveryRecoveryJournal(path, "dev", "codex");
      const rpcA = new DeliveryRpcPeer();
      rpcA.turnIds = ["turn-waiting-owner-crash"];
      const sessionA = new CodexSessionController(rpcA);
      const connA = fakeConnection();
      let sourceAckRequested = false;
      const neverAck = new Promise<"waiting_owner">(() => {});
      bridgeA = new CodexAgentPartyBridge({
        channel: "dev",
        connection: connA.connection,
        session: sessionA,
        recoveryJournal: journalA,
        leaseRenewIntervalMs: 60_000,
        confirmDeliveryUpdate: async (update) => {
          if (
            update.delivery_id === "delivery-waiting-owner-crash" &&
            update.state === "replied"
          ) {
            sourceAckRequested = true;
            return await neverAck;
          }
          return update.state;
        },
        postReply: async () => ({ seq: 2_120 }),
      });

      await bridgeA.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await sessionA.request("thread/start", {});
      await bridgeA.handleFrame(deliveryFrame(120, "persist reply before waiting-owner ACK", {
        id: "delivery-waiting-owner-crash",
        target_name: "me",
        work_id: "work-waiting-owner-crash",
        continuation_ref: "continuation-waiting-owner-crash",
        sender: { name: "alice", kind: "human" },
      }) as ServerFrame);
      rpcA.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-delivery",
          turn: {
            id: "turn-waiting-owner-crash",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "waiting-owner-crash-final",
              text: "waiting on the owner",
            }],
          },
        },
      });
      await waitFor(
        () =>
          sourceAckRequested &&
          journalA.get("delivery-waiting-owner-crash")?.phase === "reply_posted",
        "source did not cross reply_posted before the simulated crash",
      );
      expect(journalA.get("delivery-waiting-owner-crash")).toMatchObject({
        phase: "reply_posted",
        replyBody: "waiting on the owner",
        replySeq: 2_120,
        threadId: "thread-delivery",
      });
      bridgeA.close();
      bridgeA = null;

      const journalB = new DeliveryRecoveryJournal(path, "dev", "codex");
      const rpcB = new DeliveryRpcPeer();
      rpcB.turnIds = ["turn-owner-after-crash"];
      const sessionB = new CodexSessionController(rpcB);
      await sessionB.request("thread/resume", { threadId: "thread-delivery" });
      const connB = streamingConnection();
      const postsAfterCrash: string[] = [];
      bridgeB = new CodexAgentPartyBridge({
        channel: "dev",
        connection: connB.connection,
        session: sessionB,
        recoveryJournal: journalB,
        requireDeliveryRecovery: true,
        leaseRenewIntervalMs: 60_000,
        deliveryAckTimeoutMs: 1_000,
        confirmDeliveryUpdate: async (update) => update.state,
        postReply: async ({ idempotencyKey }) => {
          postsAfterCrash.push(idempotencyKey);
          return { seq: 2_121 };
        },
      });
      const runB = bridgeB.run();
      connB.push(welcomeDirectedFrame(0, "me") as ServerFrame);
      await waitFor(
        () =>
          connB.sent.some((frame) =>
            frame.type === "delivery_recover" &&
            frame.delivery_id === "delivery-waiting-owner-crash"
          ),
        "cold bridge did not request source ownership reconciliation",
      );
      const recovery = connB.sent.find((frame) =>
        frame.type === "delivery_recover" &&
        frame.delivery_id === "delivery-waiting-owner-crash"
      ) as Extract<ClientFrame, { type: "delivery_recover" }>;
      connB.push({
        type: "delivery_recovery",
        delivery_id: recovery.delivery_id,
        request_id: recovery.request_id,
        result: "terminal",
        state: "waiting_owner",
        attempt: recovery.attempt,
        lease_epoch: recovery.lease_epoch,
      } as ServerFrame);
      await waitFor(
        () =>
          bridgeB?.parkedContinuationCount === 1 &&
          journalB.get("delivery-waiting-owner-crash")?.phase === "waiting_owner",
        "terminal waiting_owner did not promote the durable parked binding",
      );
      expect(bridgeB.pendingCount).toBe(0);
      expect(postsAfterCrash).toHaveLength(0);
      expect(journalB.get("delivery-waiting-owner-crash")).toMatchObject({
        phase: "waiting_owner",
        replyBody: "waiting on the owner",
        replySeq: 2_120,
        threadId: "thread-delivery",
        delivery: {
          id: "delivery-waiting-owner-crash",
          state: "waiting_owner",
          reply_seq: 2_120,
        },
      });

      connB.push(ownerAnswerFrame({
        seq: 121,
        deliveryId: "delivery-owner-after-crash",
        sourceDeliveryId: "delivery-waiting-owner-crash",
        sourceSeq: 120,
        workId: "work-waiting-owner-crash",
        continuationRef: "continuation-waiting-owner-crash",
        requestSeq: 2_120,
      }) as ServerFrame);
      await waitFor(
        () =>
          rpcB.calls.some((call) =>
            call.method === "turn/start" &&
            (call.params as { clientUserMessageId?: string }).clientUserMessageId ===
              "agentparty:delivery-owner-after-crash"
          ),
        "owner answer did not consume the recovered parked binding",
      );
      rpcB.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-delivery",
          turn: {
            id: "turn-owner-after-crash",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "owner-after-crash-final",
              text: "continued after recovery",
            }],
          },
        },
      });
      await waitFor(
        () =>
          bridgeB?.pendingCount === 0 &&
          bridgeB.parkedContinuationCount === 0 &&
          journalB.entries().length === 0,
        "owner answer did not atomically clear the recovered source binding",
      );
      expect(postsAfterCrash).toEqual([
        "codex-bridge-reply:delivery-owner-after-crash",
      ]);
      bridgeB.close();
      await runB;
      bridgeB = null;
    } finally {
      bridgeB?.close();
      bridgeA?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(["replied", "failed", "waiting_owner"] as const)(
    "cold waiting_owner WAL follows authoritative terminal %s instead of blind local restore",
    async (authoritativeState) => {
      const root = mkdtempSync(join(tmpdir(), `ap-codex-stale-waiting-${authoritativeState}-`));
      let bridge: CodexAgentPartyBridge | null = null;
      try {
        const journal = new DeliveryRecoveryJournal(
          join(root, "journal.json"),
          "dev",
          "codex",
        );
        const seeded = deliveryFrame(127, "parked before another holder settles", {
          id: `delivery-stale-waiting-${authoritativeState}`,
          target_name: "me",
          work_id: "work-stale-waiting",
          continuation_ref: "continuation-stale-waiting",
        }) as unknown as DirectedDeliveryFrame;
        journal.recordClaim(seeded.delivery, seeded.message);
        journal.update(seeded.delivery.id, {
          phase: "waiting_owner",
          delivery: {
            ...seeded.delivery,
            state: "waiting_owner",
            reply_seq: 8_127,
            lease_until: null,
          },
          threadId: "thread-delivery",
          turnId: "turn-stale-waiting",
          replyBody: "waiting for owner",
          replySeq: 8_127,
        });

        const rpc = new DeliveryRpcPeer();
        const session = new CodexSessionController(rpc);
        await session.request("thread/resume", { threadId: "thread-delivery" });
        const conn = streamingConnection();
        bridge = new CodexAgentPartyBridge({
          channel: "dev",
          connection: conn.connection,
          session,
          recoveryJournal: journal,
          requireDeliveryRecovery: true,
          leaseRenewIntervalMs: 60_000,
          deliveryAckTimeoutMs: 1_000,
          confirmDeliveryUpdate: async (update) => update.state,
          postReply: async () => ({ seq: 1 }),
        });
        const run = bridge.run();
        conn.push(welcomeDirectedFrame(0, "me") as ServerFrame);
        await waitFor(
          () => conn.sent.some((frame) =>
            frame.type === "delivery_recover" &&
            frame.delivery_id === seeded.delivery.id
          ),
          "waiting_owner recovery was not requested",
        );
        // A local waiting_owner snapshot is not enough to park anything before
        // the Worker classifies the current source state.
        expect(bridge.parkedContinuationCount).toBe(0);
        const recovery = conn.sent.find((frame) =>
          frame.type === "delivery_recover" &&
          frame.delivery_id === seeded.delivery.id
        ) as Extract<ClientFrame, { type: "delivery_recover" }>;
        expect(recovery.replay_safe).toBeUndefined();
        conn.push({
          type: "delivery_recovery",
          delivery_id: recovery.delivery_id,
          request_id: recovery.request_id,
          result: "terminal",
          state: authoritativeState,
          attempt: recovery.attempt,
          lease_epoch: recovery.lease_epoch,
        } as ServerFrame);

        if (authoritativeState === "waiting_owner") {
          await waitFor(
            () => bridge?.parkedContinuationCount === 1,
            "authoritative waiting_owner did not restore the parked binding",
          );
          expect(journal.get(seeded.delivery.id)?.phase).toBe("waiting_owner");
          conn.push({
            type: "delivery_state",
            delivery: {
              id: seeded.delivery.id,
              message_seq: seeded.delivery.message_seq,
              target_name: seeded.delivery.target_name,
              state: "replied",
              reply_seq: 8_128,
              created_at: seeded.delivery.created_at,
              updated_at: Date.now(),
            },
          } as ServerFrame);
          await waitFor(
            () =>
              bridge?.parkedContinuationCount === 0 &&
              journal.get(seeded.delivery.id) === null,
            "unsolicited authoritative source terminal did not clear stale parked state",
          );
        } else {
          await waitFor(
            () => journal.get(seeded.delivery.id) === null,
            `authoritative ${authoritativeState} did not clear stale waiting_owner WAL`,
          );
          expect(bridge.parkedContinuationCount).toBe(0);
        }
        bridge.close();
        await run;
        bridge = null;
      } finally {
        bridge?.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("cold recovery re-POSTs a response-lost reply with the same idempotency key and restores waiting_owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-codex-response-lost-crash-"));
    let bridgeA: CodexAgentPartyBridge | null = null;
    let bridgeB: CodexAgentPartyBridge | null = null;
    try {
      const path = join(root, "journal.json");
      const postKeys: string[] = [];
      const journalA = new DeliveryRecoveryJournal(path, "dev", "codex");
      const rpcA = new DeliveryRpcPeer();
      rpcA.turnIds = ["turn-response-lost"];
      const sessionA = new CodexSessionController(rpcA);
      const connA = fakeConnection();
      bridgeA = new CodexAgentPartyBridge({
        channel: "dev",
        connection: connA.connection,
        session: sessionA,
        recoveryJournal: journalA,
        leaseRenewIntervalMs: 60_000,
        retryDelayMs: 60_000,
        confirmDeliveryUpdate: async (update) => update.state,
        postReply: async ({ idempotencyKey }) => {
          postKeys.push(idempotencyKey);
          throw new Error("REST response lost after durable persistence");
        },
      });

      await bridgeA.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await sessionA.request("thread/start", {});
      await bridgeA.handleFrame(deliveryFrame(122, "response lost before reply seq", {
        id: "delivery-response-lost-crash",
        target_name: "me",
        work_id: "work-response-lost-crash",
        continuation_ref: "continuation-response-lost-crash",
        sender: { name: "alice", kind: "human" },
      }) as ServerFrame);
      rpcA.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-delivery",
          turn: {
            id: "turn-response-lost",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "response-lost-final",
              text: "durably persisted but response was lost",
            }],
          },
        },
      });
      await waitFor(
        () =>
          postKeys.length === 1 &&
          journalA.get("delivery-response-lost-crash")?.replyBody !== null,
        "first process did not retain replyBody after losing the REST response",
      );
      expect(journalA.get("delivery-response-lost-crash")).toMatchObject({
        phase: "harness_accepted",
        replyBody: "durably persisted but response was lost",
        replySeq: null,
        threadId: "thread-delivery",
      });
      bridgeA.close();
      bridgeA = null;

      const journalB = new DeliveryRecoveryJournal(path, "dev", "codex");
      const rpcB = new DeliveryRpcPeer();
      const sessionB = new CodexSessionController(rpcB);
      await sessionB.request("thread/resume", { threadId: "thread-delivery" });
      const connB = streamingConnection();
      bridgeB = new CodexAgentPartyBridge({
        channel: "dev",
        connection: connB.connection,
        session: sessionB,
        recoveryJournal: journalB,
        requireDeliveryRecovery: true,
        leaseRenewIntervalMs: 60_000,
        deliveryAckTimeoutMs: 1_000,
        confirmDeliveryUpdate: async (update) =>
          update.state === "replied" &&
            update.delivery_id === "delivery-response-lost-crash"
            ? "waiting_owner"
            : update.state,
        postReply: async ({ idempotencyKey }) => {
          postKeys.push(idempotencyKey);
          return { seq: 2_122 };
        },
      });
      const runB = bridgeB.run();
      connB.push(welcomeDirectedFrame(0, "me") as ServerFrame);
      await waitFor(
        () =>
          connB.sent.some((frame) =>
            frame.type === "delivery_recover" &&
            frame.delivery_id === "delivery-response-lost-crash"
          ),
        "cold bridge did not reconcile the response-lost source",
      );
      const recovery = connB.sent.find((frame) =>
        frame.type === "delivery_recover" &&
        frame.delivery_id === "delivery-response-lost-crash"
      ) as Extract<ClientFrame, { type: "delivery_recover" }>;
      connB.push({
        type: "delivery_recovery",
        delivery_id: recovery.delivery_id,
        request_id: recovery.request_id,
        result: "terminal",
        state: "waiting_owner",
        attempt: recovery.attempt,
        lease_epoch: recovery.lease_epoch,
      } as ServerFrame);
      await waitFor(
        () =>
          bridgeB?.pendingCount === 0 &&
          bridgeB.parkedContinuationCount === 1 &&
          journalB.get("delivery-response-lost-crash")?.phase === "waiting_owner",
        "same-key re-POST did not reconstruct the waiting_owner binding",
      );
      expect(postKeys).toEqual([
        "codex-bridge-reply:delivery-response-lost-crash",
        "codex-bridge-reply:delivery-response-lost-crash",
      ]);
      expect(journalB.get("delivery-response-lost-crash")).toMatchObject({
        phase: "waiting_owner",
        replyBody: "durably persisted but response was lost",
        replySeq: 2_122,
        delivery: {
          id: "delivery-response-lost-crash",
          state: "waiting_owner",
          reply_seq: 2_122,
        },
      });
      bridgeB.close();
      await runB;
      bridgeB = null;
    } finally {
      bridgeB?.close();
      bridgeA?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("owner_answer atomically removes its journal and an in-flight source before a late waiting_owner ACK", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-codex-owner-atomic-remove-"));
    let bridge: CodexAgentPartyBridge | null = null;
    try {
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "codex",
      );
      const rpc = new DeliveryRpcPeer();
      rpc.turnIds = ["turn-atomic-source", "turn-atomic-owner"];
      const session = new CodexSessionController(rpc);
      const conn = fakeConnection();
      let sourceAckRequested = false;
      let resolveSourceAck!: (state: "waiting_owner") => void;
      const sourceAck = new Promise<"waiting_owner">((resolve) => {
        resolveSourceAck = resolve;
      });
      bridge = new CodexAgentPartyBridge({
        channel: "dev",
        connection: conn.connection,
        session,
        recoveryJournal: journal,
        leaseRenewIntervalMs: 60_000,
        confirmDeliveryUpdate: async (update) => {
          if (
            update.delivery_id === "delivery-atomic-source" &&
            update.state === "replied"
          ) {
            sourceAckRequested = true;
            return await sourceAck;
          }
          return update.state;
        },
        postReply: async ({ replyTo }) => ({ seq: 3_000 + replyTo }),
      });

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await session.request("thread/start", {});
      await bridge.handleFrame(deliveryFrame(123, "source ACK will arrive late", {
        id: "delivery-atomic-source",
        target_name: "me",
        work_id: "work-atomic-remove",
        continuation_ref: "continuation-atomic-remove",
        sender: { name: "alice", kind: "human" },
      }) as ServerFrame);
      rpc.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-delivery",
          turn: {
            id: "turn-atomic-source",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "atomic-source-final",
              text: "ask owner",
            }],
          },
        },
      });
      await waitFor(
        () =>
          sourceAckRequested &&
          journal.get("delivery-atomic-source")?.phase === "reply_posted",
        "source did not reach its delayed waiting_owner ACK",
      );

      await bridge.handleFrame(ownerAnswerFrame({
        seq: 124,
        deliveryId: "delivery-atomic-owner",
        sourceDeliveryId: "delivery-atomic-source",
        sourceSeq: 123,
        workId: "work-atomic-remove",
        continuationRef: "continuation-atomic-remove",
        requestSeq: 3_123,
      }) as ServerFrame);
      rpc.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-delivery",
          turn: {
            id: "turn-atomic-owner",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "atomic-owner-final",
              text: "owner resolved",
            }],
          },
        },
      });
      await waitFor(
        () =>
          bridge?.pendingCount === 1 &&
          journal.get("delivery-atomic-source") === null &&
          journal.get("delivery-atomic-owner") === null,
        "owner answer did not atomically remove both durable obligations",
      );
      expect(journal.entries()).toHaveLength(0);
      expect(bridge.parkedContinuationCount).toBe(0);

      resolveSourceAck("waiting_owner");
      await waitFor(
        () => bridge?.pendingCount === 0,
        "late source ACK left the source pending",
      );
      expect(bridge.parkedContinuationCount).toBe(0);
      expect(journal.entries()).toHaveLength(0);
    } finally {
      bridge?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an ENOSPC during atomic owner/source removal retains pending state and retries without resurrection", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-codex-owner-remove-enospc-"));
    let bridge: CodexAgentPartyBridge | null = null;
    try {
      let insideAtomicRemoval = false;
      let failAtomicRemoval = true;
      let atomicRemovalFailures = 0;
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "codex",
        {
          persist: (commit) => {
            if (insideAtomicRemoval && failAtomicRemoval) {
              failAtomicRemoval = false;
              atomicRemovalFailures += 1;
              const error = new Error("atomic owner/source WAL is full") as NodeJS.ErrnoException;
              error.code = "ENOSPC";
              throw error;
            }
            commit();
          },
        },
      );
      const durableRemoveMany = journal.removeMany.bind(journal);
      journal.removeMany = (deliveryIds) => {
        insideAtomicRemoval = true;
        try {
          durableRemoveMany(deliveryIds);
        } finally {
          insideAtomicRemoval = false;
        }
      };

      const rpc = new DeliveryRpcPeer();
      rpc.turnIds = ["turn-enospc-source", "turn-enospc-owner"];
      const session = new CodexSessionController(rpc);
      const conn = fakeConnection();
      let sourceAckRequested = false;
      let resolveSourceAck!: (state: "waiting_owner") => void;
      const sourceAck = new Promise<"waiting_owner">((resolve) => {
        resolveSourceAck = resolve;
      });
      bridge = new CodexAgentPartyBridge({
        channel: "dev",
        connection: conn.connection,
        session,
        recoveryJournal: journal,
        leaseRenewIntervalMs: 60_000,
        retryDelayMs: 100,
        confirmDeliveryUpdate: async (update) => {
          if (
            update.delivery_id === "delivery-enospc-source" &&
            update.state === "replied"
          ) {
            sourceAckRequested = true;
            return await sourceAck;
          }
          return update.state;
        },
        postReply: async ({ replyTo }) => ({ seq: 4_000 + replyTo }),
      });

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await session.request("thread/start", {});
      await bridge.handleFrame(deliveryFrame(125, "source survives atomic remove ENOSPC", {
        id: "delivery-enospc-source",
        target_name: "me",
        work_id: "work-remove-enospc",
        continuation_ref: "continuation-remove-enospc",
        sender: { name: "alice", kind: "human" },
      }) as ServerFrame);
      rpc.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-delivery",
          turn: {
            id: "turn-enospc-source",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "enospc-source-final",
              text: "owner required",
            }],
          },
        },
      });
      await waitFor(
        () =>
          sourceAckRequested &&
          journal.get("delivery-enospc-source")?.phase === "reply_posted",
        "source did not reach the delayed ACK before ENOSPC",
      );

      await bridge.handleFrame(ownerAnswerFrame({
        seq: 126,
        deliveryId: "delivery-enospc-owner",
        sourceDeliveryId: "delivery-enospc-source",
        sourceSeq: 125,
        workId: "work-remove-enospc",
        continuationRef: "continuation-remove-enospc",
        requestSeq: 4_125,
      }) as ServerFrame);
      rpc.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-delivery",
          turn: {
            id: "turn-enospc-owner",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "enospc-owner-final",
              text: "owner resolved after WAL retry",
            }],
          },
        },
      });
      await waitFor(
        () => atomicRemovalFailures === 1,
        "atomic owner/source removal did not hit the ENOSPC seam",
      );
      expect(bridge.pendingCount).toBe(2);
      expect(journal.get("delivery-enospc-source")).not.toBeNull();
      expect(journal.get("delivery-enospc-owner")).not.toBeNull();

      await waitFor(
        () =>
          bridge?.pendingCount === 1 &&
          journal.get("delivery-enospc-source") === null &&
          journal.get("delivery-enospc-owner") === null,
        "owner/source removal retry did not durably clear both entries",
      );
      expect(journal.entries()).toHaveLength(0);

      resolveSourceAck("waiting_owner");
      await waitFor(
        () => bridge?.pendingCount === 0,
        "late source ACK left a resurrected pending obligation",
      );
      expect(bridge.parkedContinuationCount).toBe(0);
      expect(journal.entries()).toHaveLength(0);
    } finally {
      bridge?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("waiting_owner parks the original Codex thread and owner_answer resumes that affinity", async () => {
    const rpc = new DeliveryRpcPeer();
    rpc.turnIds = ["turn-source", "turn-owner-answer"];
    const session = new CodexSessionController(rpc);
    const conn = fakeConnection();
    const posts: Array<{ replyTo: number; idempotencyKey: string }> = [];
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: conn.connection,
      session,
      leaseRenewIntervalMs: 60_000,
      confirmDeliveryUpdate: async (update) => {
        if (update.state === "replied" && update.delivery_id === "delivery-source") {
          return "waiting_owner";
        }
        return update.state;
      },
      postReply: async ({ replyTo, idempotencyKey }) => {
        posts.push({ replyTo, idempotencyKey });
        return { seq: 80 + posts.length };
      },
    });

    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await session.request("thread/start", {});
    await bridge.handleFrame(deliveryFrame(18, "ask the owner", {
      id: "delivery-source",
      target_name: "me",
      work_id: "work-affinity",
      continuation_ref: "continuation-affinity",
      sender: { name: "alice", kind: "human" },
    }) as ServerFrame);
    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-delivery",
        turn: {
          id: "turn-source",
          status: "completed",
          items: [{ type: "agentMessage", id: "source-final", text: "waiting for owner" }],
        },
      },
    });
    await waitFor(
      () => bridge.parkedContinuationCount === 1 && bridge.pendingCount === 0,
      "source delivery was not parked on waiting_owner",
    );
    await expect(session.request("thread/fork", {
      threadId: "thread-delivery",
    })).rejects.toThrow("still pending or parked");
    await expect(session.request("thread/rollback", {
      threadId: "thread-delivery",
      numTurns: 1,
    })).rejects.toThrow("mutate the history");
    await expect(session.request("thread/inject_items", {
      threadId: "thread-delivery",
      items: [],
    })).rejects.toThrow("mutate the history");
    expect(rpc.calls.filter((call) => call.method === "thread/fork")).toHaveLength(0);
    expect(rpc.calls.filter((call) => call.method === "thread/rollback")).toHaveLength(0);
    expect(rpc.calls.filter((call) => call.method === "thread/inject_items")).toHaveLength(0);

    const ownerFrame = ownerAnswerFrame({
      seq: 19,
      deliveryId: "delivery-owner-answer",
      sourceDeliveryId: "delivery-source",
      sourceSeq: 18,
      workId: "work-affinity",
      continuationRef: "continuation-affinity",
      requestSeq: 1_018,
    });
    await bridge.handleFrame(ownerFrame as ServerFrame);
    expect(
      rpc.calls
        .filter((call) => call.method === "turn/start")
        .at(-1)?.params,
    ).toMatchObject({
      threadId: "thread-delivery",
      clientUserMessageId: "agentparty:delivery-owner-answer",
      responsesapiClientMetadata: {
        work_id: "work-affinity",
        continuation_ref: "continuation-affinity",
      },
    });

    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-delivery",
        turn: {
          id: "turn-owner-answer",
          status: "completed",
          items: [{ type: "agentMessage", id: "owner-final", text: "continued answer" }],
        },
      },
    });
    await waitFor(
      () => bridge.pendingCount === 0 && bridge.parkedContinuationCount === 0,
      "owner answer did not settle the parked continuation",
    );
    expect(posts).toEqual([
      { replyTo: 18, idempotencyKey: "codex-bridge-reply:delivery-source" },
      { replyTo: 19, idempotencyKey: "codex-bridge-reply:delivery-owner-answer" },
    ]);
    bridge.close();
  });

  test("a new bridge process reconstructs owner_answer affinity from exact recovered thread history", async () => {
    const rpcA = new DeliveryRpcPeer();
    rpcA.turnIds = ["turn-restart-source"];
    const sessionA = new CodexSessionController(rpcA);
    const connA = fakeConnection();
    const bridgeA = new CodexAgentPartyBridge({
      channel: "dev",
      connection: connA.connection,
      session: sessionA,
      leaseRenewIntervalMs: 60_000,
      confirmDeliveryUpdate: async (update) =>
        update.state === "replied" && update.delivery_id === "delivery-restart-source"
          ? "waiting_owner"
          : update.state,
      postReply: async () => ({ seq: 2_022 }),
    });
    await bridgeA.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await sessionA.request("thread/start", {});
    await bridgeA.handleFrame(deliveryFrame(22, "ask owner before restart", {
      id: "delivery-restart-source",
      target_name: "me",
      work_id: "work-restart",
      continuation_ref: "continuation-restart",
      sender: { name: "alice", kind: "human" },
    }) as ServerFrame);
    rpcA.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-delivery",
        turn: {
          id: "turn-restart-source",
          status: "completed",
          items: [{
            type: "agentMessage",
            id: "source-restart-final",
            text: "waiting for owner",
          }],
        },
      },
    });
    await waitFor(
      () => bridgeA.parkedContinuationCount === 1,
      "source continuation was not parked before restart",
    );
    bridgeA.close();

    const rpcB = new DeliveryRpcPeer();
    rpcB.turnIds = ["turn-after-restart-owner"];
    rpcB.restoredTurns = [{
      id: "turn-restart-source",
      status: "completed",
      items: [{
        type: "userMessage",
        id: "source-restart-user",
        clientId: "agentparty:delivery-restart-source",
      }],
    }];
    const sessionB = new CodexSessionController(rpcB);
    await sessionB.request("thread/resume", { threadId: "thread-delivery" });
    const connB = fakeConnection();
    const bridgeB = new CodexAgentPartyBridge({
      channel: "dev",
      connection: connB.connection,
      session: sessionB,
      leaseRenewIntervalMs: 60_000,
      confirmDeliveryUpdate: async (update) => update.state,
      postReply: async () => ({ seq: 2_023 }),
    });
    await bridgeB.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridgeB.handleFrame(ownerAnswerFrame({
      seq: 23,
      deliveryId: "delivery-restart-owner",
      sourceDeliveryId: "delivery-restart-source",
      sourceSeq: 22,
      workId: "work-restart",
      continuationRef: "continuation-restart",
      requestSeq: 2_022,
    }) as ServerFrame);

    expect(
      rpcB.calls
        .filter((call) => call.method === "turn/start")
        .at(-1)?.params,
    ).toMatchObject({
      threadId: "thread-delivery",
      clientUserMessageId: "agentparty:delivery-restart-owner",
      responsesapiClientMetadata: {
        work_id: "work-restart",
        continuation_ref: "continuation-restart",
      },
    });
    bridgeB.close();
  });

  test("recovered owner_answer affinity fails closed when history is absent or belongs to a prior thread", async () => {
    for (const priorThreadOnly of [false, true]) {
      const rpc = new DeliveryRpcPeer();
      const session = new CodexSessionController(rpc);
      if (priorThreadOnly) {
        rpc.restoredTurns = [{
          id: "source-prior-turn",
          status: "completed",
          items: [{
            type: "userMessage",
            id: "source-prior-user",
            clientId: "agentparty:delivery-restart-source",
          }],
        }];
        await session.request("thread/resume", { threadId: "thread-delivery" });
        rpc.threadId = "thread-other";
        rpc.restoredTurns = [];
      }
      await session.request("thread/resume", {
        threadId: priorThreadOnly ? "thread-other" : "thread-delivery",
      });
      const conn = fakeConnection();
      const failed: string[] = [];
      const bridge = new CodexAgentPartyBridge({
        channel: "dev",
        connection: conn.connection,
        session,
        leaseRenewIntervalMs: 60_000,
        confirmDeliveryUpdate: async (update) => {
          if (update.state === "failed") failed.push(update.error ?? "");
          return update.state;
        },
        postReply: async () => ({ seq: 1 }),
      });
      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(ownerAnswerFrame({
        seq: priorThreadOnly ? 25 : 24,
        deliveryId: priorThreadOnly
          ? "delivery-owner-prior-thread"
          : "delivery-owner-missing-history",
        sourceDeliveryId: "delivery-restart-source",
        sourceSeq: 22,
        workId: "work-restart",
        continuationRef: "continuation-restart",
        requestSeq: 2_022,
      }) as ServerFrame);

      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain("no matching parked");
      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
      bridge.close();
    }
  });

  test("a late source waiting_owner ACK cannot resurrect a completed owner continuation", async () => {
    const rpc = new DeliveryRpcPeer();
    rpc.turnIds = ["turn-source-late", "turn-owner-fast"];
    const session = new CodexSessionController(rpc);
    const conn = fakeConnection();
    let sourceAckRequested = false;
    let resolveSourceAck!: (state: "waiting_owner") => void;
    const sourceAck = new Promise<"waiting_owner">((resolve) => {
      resolveSourceAck = resolve;
    });
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: conn.connection,
      session,
      leaseRenewIntervalMs: 60_000,
      confirmDeliveryUpdate: async (update) => {
        if (update.delivery_id === "delivery-late-source" && update.state === "replied") {
          sourceAckRequested = true;
          return await sourceAck;
        }
        return update.state;
      },
      postReply: async ({ replyTo }) => ({ seq: 100 + replyTo }),
    });

    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await session.request("thread/start", {});
    await bridge.handleFrame(deliveryFrame(20, "source waits on owner", {
      id: "delivery-late-source",
      target_name: "me",
      work_id: "work-late",
      continuation_ref: "continuation-late",
      sender: { name: "alice", kind: "human" },
    }) as ServerFrame);
    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-delivery",
        turn: {
          id: "turn-source-late",
          status: "completed",
          items: [{ type: "agentMessage", id: "source-late-final", text: "owner needed" }],
        },
      },
    });
    await waitFor(() => sourceAckRequested, "source replied ACK was not delayed");

    const ownerFrame = ownerAnswerFrame({
      seq: 21,
      deliveryId: "delivery-owner-fast",
      sourceDeliveryId: "delivery-late-source",
      sourceSeq: 20,
      workId: "work-late",
      continuationRef: "continuation-late",
      requestSeq: 1_020,
    });
    await bridge.handleFrame(ownerFrame as ServerFrame);
    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-delivery",
        turn: {
          id: "turn-owner-fast",
          status: "completed",
          items: [{ type: "agentMessage", id: "owner-fast-final", text: "done" }],
        },
      },
    });
    await waitFor(
      () => bridge.pendingCount === 1 && bridge.parkedContinuationCount === 0,
      "owner answer did not finish before the delayed source ACK",
    );

    resolveSourceAck("waiting_owner");
    await waitFor(
      () => bridge.pendingCount === 0 && bridge.parkedContinuationCount === 0,
      "late source ACK resurrected a completed parked continuation",
    );
    await expect(session.request("thread/start", {})).resolves.toMatchObject({
      thread: { id: "thread-delivery" },
    });
    bridge.close();
  });

  test("keeps a failed delivery unsettled until Worker confirms the failed state", async () => {
    const rpc = new DeliveryRpcPeer();
    const session = new CodexSessionController(rpc);
    const conn = fakeConnection();
    let failedUpdates = 0;
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: conn.connection,
      session,
      leaseRenewIntervalMs: 60_000,
      confirmDeliveryUpdate: async (update) => {
        if (update.state !== "failed") return;
        failedUpdates += 1;
        if (failedUpdates === 1) throw new Error("failed ACK was lost");
      },
      postReply: async () => ({ seq: 1 }),
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    const incoming = deliveryFrame(16, "terminal failure", {
      id: "delivery-16",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
    }) as ServerFrame;
    await bridge.handleFrame(incoming);
    await session.request("thread/start", {});
    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-delivery",
        turn: {
          id: "turn-delivery",
          status: "failed",
          items: [],
        },
      },
    });
    await waitFor(() => failedUpdates === 1, "first failed update was not attempted");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.pendingCount).toBe(1);

    await bridge.handleFrame(incoming);
    expect(failedUpdates).toBe(2);
    expect(bridge.pendingCount).toBe(0);
    bridge.close();
  });

  test("retries failed_pending WAL after ENOSPC before sending one failed update", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-codex-failed-wal-"));
    let bridge: CodexAgentPartyBridge | null = null;
    try {
      let failNextCommit = false;
      let walFailures = 0;
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "codex",
        {
          persist: (commit) => {
            if (failNextCommit) {
              failNextCommit = false;
              walFailures += 1;
              const error = new Error("failed_pending WAL is full") as NodeJS.ErrnoException;
              error.code = "ENOSPC";
              throw error;
            }
            commit();
          },
        },
      );
      const rpc = new DeliveryRpcPeer();
      const session = new CodexSessionController(rpc);
      const conn = fakeConnection();
      const failedUpdates: string[] = [];
      bridge = new CodexAgentPartyBridge({
        channel: "dev",
        connection: conn.connection,
        session,
        recoveryJournal: journal,
        leaseRenewIntervalMs: 60_000,
        retryDelayMs: 100,
        confirmDeliveryUpdate: async (update) => {
          if (update.state === "failed") failedUpdates.push(update.error ?? "");
          return update.state;
        },
        postReply: async () => ({ seq: 1 }),
      });

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(deliveryFrame(119, "fail after durable terminal WAL", {
        id: "delivery-failed-wal",
        target_name: "me",
        sender: { name: "alice", kind: "human" },
      }) as ServerFrame);
      await session.request("thread/start", {});
      failNextCommit = true;
      rpc.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-delivery",
          turn: {
            id: "turn-delivery",
            status: "failed",
            items: [],
          },
        },
      });

      await waitFor(() => walFailures === 1, "failed_pending WAL fault was not injected");
      expect(failedUpdates).toHaveLength(0);
      expect(bridge.pendingCount).toBe(1);
      expect(journal.get("delivery-failed-wal")).toMatchObject({
        phase: "harness_accepted",
        terminalError: null,
      });

      await waitFor(
        () => bridge?.pendingCount === 0,
        "failed_pending WAL retry left the delivery permanently settling",
      );
      expect(failedUpdates).toHaveLength(1);
      expect(failedUpdates[0]).toContain("turn-delivery ended with failed");
      expect(journal.get("delivery-failed-wal")).toBeNull();
    } finally {
      bridge?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
