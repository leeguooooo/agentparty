import { describe, expect, test } from "bun:test";
import type { ClientFrame, MsgFrame, ServerFrame } from "@agentparty/shared";
import { buildClaudeBridgeLaunch, parseClaudeVersion, run as runBridge, supportsClaudeChannels } from "../src/commands/bridge";
import {
  ClaudeChannelDeliveryBridge,
  type ChannelNotification,
  type ChannelPostReply,
} from "../src/commands/claude-channel";
import { DeliveryRecoveryJournal } from "../src/delivery-recovery-journal";
import { deliveryFrame, msgFrame, welcomeDirectedFrame, welcomeFrame } from "./mock-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeConnection(initialCursor = 0) {
  let cursor = initialCursor;
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
  questionSeq: number;
  workId: string;
  continuationRef: string;
  body?: string;
}): Extract<ServerFrame, { type: "delivery" }> {
  const frame = deliveryFrame(options.seq, options.body ?? "owner approved", {
    id: options.deliveryId,
    target_name: "me",
    sender: { name: "owner", kind: "human" },
    work_id: options.workId,
    continuation_ref: options.continuationRef,
  }) as Extract<ServerFrame, { type: "delivery" }>;
  frame.delivery.cause = "owner_answer";
  frame.message = {
    ...frame.message,
    reply_to: options.questionSeq,
    decision_response: {
      request_seq: options.questionSeq,
      chosen_index: 0,
      chosen_option: "approve",
      prompt: "May this continue?",
      delivery_id: options.sourceDeliveryId,
      origin_seq: options.sourceSeq,
      origin_channel: "dev",
      work_id: options.workId,
      continuation_ref: options.continuationRef,
    },
  };
  return frame;
}

describe("party bridge claude capability preflight", () => {
  test("parses Claude's decorated version output and enforces the Channels boundary", () => {
    expect(parseClaudeVersion("2.1.218 (Claude Code)")).toEqual([2, 1, 218]);
    expect(parseClaudeVersion("claude v2.1.80")).toEqual([2, 1, 80]);
    expect(parseClaudeVersion("not-semver")).toBeNull();
    expect(supportsClaudeChannels("2.1.79 (Claude Code)")).toBe(false);
    expect(supportsClaudeChannels("2.1.80 (Claude Code)")).toBe(true);
    expect(supportsClaudeChannels("2.2.0 (Claude Code)")).toBe(true);
  });

  test("launch config uses the dedicated channel capability and preserves Claude args", () => {
    const launch = buildClaudeBridgeLaunch({
      channel: "dev",
      claudeArgs: ["--model", "opus"],
      execPath: "/opt/homebrew/bin/bun",
      processArgv: ["/opt/homebrew/bin/bun", "/repo/cli/src/index.ts", "bridge", "claude"],
    });
    expect(launch.command).toBe("claude");
    expect(launch.args).toContain("--dangerously-load-development-channels");
    expect(launch.args).toContain("server:agentparty-channel");
    expect(launch.args.slice(-2)).toEqual(["--model", "opus"]);
    expect(launch.mcpConfig.mcpServers["agentparty-channel"]).toEqual({
      type: "stdio",
      command: "/opt/homebrew/bin/bun",
      args: ["/repo/cli/src/index.ts", "claude-channel", "--channel", "dev"],
    });
  });

  test("old Claude fails closed without launching or choosing an unsafe resume path", async () => {
    let launches = 0;
    const errors: string[] = [];
    const oldError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      const code = await runBridge(["claude", "dev"], {
        probeClaudeVersion: async () => "2.1.79 (Claude Code)",
        launch: async () => {
          launches += 1;
          return 0;
        },
      });
      expect(code).toBe(1);
      expect(launches).toBe(0);
      expect(errors.join("\n")).toContain("will not fall back to PTY injection or concurrently resume");
    } finally {
      console.error = oldError;
    }
  });
});

describe("Claude Channel directed-delivery ledger", () => {
  test("production frame loop waits for the authoritative running ACK before notifying Claude", async () => {
    const stream = streamingConnection();
    const notifications: ChannelNotification[] = [];
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: stream.connection,
      notify: async (notification) => {
        notifications.push(notification);
      },
      postReply: async () => ({ seq: 1 }),
      deliveryAckTimeoutMs: 1_000,
      out: () => {},
    });
    const run = bridge.run();
    stream.push(welcomeDirectedFrame(0, "me") as ServerFrame);
    const incoming = deliveryFrame(6, "wait for Worker", {
      id: "delivery-6",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
    });
    stream.push(incoming as ServerFrame);
    await waitFor(
      () => stream.sent.some((frame) => frame.type === "delivery_update"),
      "running update was not sent",
    );
    expect(notifications).toHaveLength(0);
    const running = stream.sent.find((frame) => frame.type === "delivery_update") as
      Extract<ClientFrame, { type: "delivery_update" }> & { request_id: string };
    expect(running.request_id).toEqual(expect.any(String));
    stream.push({
      type: "delivery_state",
      request_id: running.request_id,
      delivery: {
        ...incoming.delivery,
        state: "running",
      },
    } as ServerFrame);
    await waitFor(() => notifications.length === 1, "running ACK did not release notification");
    bridge.close();
    await expect(run).resolves.toBe(0);
  });

  test("production ACK path returns waiting_owner and keeps the source parked", async () => {
    const stream = streamingConnection();
    let notifications = 0;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: stream.connection,
      notify: async () => {
        notifications += 1;
      },
      postReply: async () => ({ seq: 101 }),
      deliveryAckTimeoutMs: 1_000,
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });
    const run = bridge.run();
    stream.push(welcomeDirectedFrame(0, "me") as ServerFrame);
    const incoming = deliveryFrame(24, "production waiting owner", {
      id: "delivery-production-park",
      target_name: "me",
      work_id: "work-production-park",
      continuation_ref: "continuation-production-park",
    });
    stream.push(incoming as ServerFrame);
    await waitFor(
      () => stream.sent.some((frame) =>
        frame.type === "delivery_update" &&
        frame.delivery_id === "delivery-production-park" &&
        frame.state === "running"
      ),
      "running update was not sent",
    );
    const running = stream.sent.find((frame) =>
      frame.type === "delivery_update" &&
      frame.delivery_id === "delivery-production-park" &&
      frame.state === "running"
    ) as Extract<ClientFrame, { type: "delivery_update" }> & { request_id: string };
    stream.push({
      type: "delivery_state",
      request_id: running.request_id,
      delivery: { ...incoming.delivery, state: "running" },
    } as ServerFrame);
    await waitFor(() => notifications === 1, "notification was not released");

    const reply = bridge.reply(24, "owner question persisted");
    await waitFor(
      () => stream.sent.some((frame) =>
        frame.type === "delivery_update" &&
        frame.delivery_id === "delivery-production-park" &&
        frame.state === "replied"
      ),
      "replied update was not sent",
    );
    expect(bridge.pendingCount).toBe(1);
    const replied = stream.sent.find((frame) =>
      frame.type === "delivery_update" &&
      frame.delivery_id === "delivery-production-park" &&
      frame.state === "replied"
    ) as Extract<ClientFrame, { type: "delivery_update" }> & { request_id: string };
    stream.push({
      type: "delivery_state",
      request_id: replied.request_id,
      delivery: { ...incoming.delivery, state: "waiting_owner", reply_seq: 101 },
    } as ServerFrame);
    await expect(reply).resolves.toEqual({ seq: 101 });
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.parkedContinuationCount).toBe(1);
    bridge.close();
    await expect(run).resolves.toBe(0);
  });

  test("running ACK timeout never notifies Claude or silently clears unsettled work", async () => {
    const fake = fakeConnection();
    let notifications = 0;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {
        notifications += 1;
      },
      postReply: async () => ({ seq: 1 }),
      deliveryAckTimeoutMs: 20,
      deliveryAckMaxAttempts: 1,
      deliverySettleRetryMaxRounds: 0,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(5, "do not notify", {
      id: "delivery-5",
      target_name: "me",
    }) as ServerFrame);
    expect(notifications).toBe(0);
    expect(bridge.pendingCount).toBe(1);
    expect(fake.sent).toContainEqual(expect.objectContaining({
      type: "delivery_update",
      delivery_id: "delivery-5",
      state: "running",
      request_id: expect.any(String),
    }));
    bridge.close();
  });

  test("a running update applied with a lost direct ACK retries before Claude is notified", async () => {
    const fake = fakeConnection();
    let runningAttempts = 0;
    let workerState: "claimed" | "running" = "claimed";
    let notifications = 0;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {
        notifications += 1;
      },
      postReply: async () => ({ seq: 1 }),
      confirmDeliveryUpdate: async (update) => {
        if (update.state !== "running") return update.state;
        runningAttempts += 1;
        if (runningAttempts === 1) {
          workerState = "running";
          throw new Error("direct running ACK was lost after apply");
        }
        expect(workerState).toBe("running");
        return "running";
      },
      deliveryAckRetryDelayMs: 0,
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(55, "claim exactly once", {
      id: "delivery-running-ack-loss",
      target_name: "me",
    }) as ServerFrame);

    expect(runningAttempts).toBe(2);
    expect(notifications).toBe(1);
    expect(bridge.pendingCount).toBe(1);
    bridge.close();
  });

  test("an unaccepted claim keeps the same receipt and body across process restart recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-claude-recovery-"));
    const path = join(root, "journal.json");
    try {
      const incoming = deliveryFrame(57, "recover after process restart", {
        id: "delivery-process-restart",
        target_name: "me",
      });
      const firstJournal = new DeliveryRecoveryJournal(path, "dev", "claude");
      const first = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: fakeConnection().connection,
        recoveryJournal: firstJournal,
        requireHarnessClaim: true,
        notify: async () => {},
        postReply: async () => ({ seq: 1 }),
        confirmDeliveryUpdate: async (update) => update.state,
        leaseRenewIntervalMs: 60_000,
        out: () => {},
      });
      await first.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await first.handleFrame(incoming as ServerFrame);
      const originalClaim = first.claim(incoming.delivery.id);
      const originalReceipt = originalClaim.receipt;
      expect(originalClaim.claimed).toBe(true);
      expect(typeof originalReceipt).toBe("string");
      expect(originalClaim.content).toContain("recover after process restart");
      expect(firstJournal.get(incoming.delivery.id)).toMatchObject({
        phase: "harness_issued",
        claimReceipt: originalReceipt,
      });
      first.close();

      const secondStream = streamingConnection();
      let notifications = 0;
      const restartedJournal = new DeliveryRecoveryJournal(path, "dev", "claude");
      expect(restartedJournal.get("delivery-process-restart")).toMatchObject({
        phase: "harness_issued",
        claimReceipt: originalReceipt,
      });
      const second = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: secondStream.connection,
        recoveryJournal: restartedJournal,
        requireHarnessClaim: true,
        notify: async () => {
          notifications += 1;
        },
        postReply: async () => ({ seq: 1 }),
        deliveryAckTimeoutMs: 1_000,
        leaseRenewIntervalMs: 60_000,
        out: () => {},
      });
      const secondRun = second.run();
      secondStream.push(welcomeDirectedFrame(57, "me") as ServerFrame);
      await waitFor(
        () => secondStream.sent.some((frame) => frame.type === "delivery_recover"),
        "replacement process did not request ownership recovery",
      );
      const recover = secondStream.sent.find((frame) =>
        frame.type === "delivery_recover"
      ) as Extract<ClientFrame, { type: "delivery_recover" }>;
      secondStream.push({
        type: "delivery_recovery",
        delivery_id: recover.delivery_id,
        request_id: recover.request_id,
        result: "recovered",
        state: "running",
        attempt: recover.attempt,
        lease_epoch: recover.lease_epoch,
        lease_token: recover.next_lease_token,
        lease_until: Date.now() + 90_000,
      });
      await waitFor(() => notifications === 1, "recovered claim notification was not queued");
      const recoveredClaim = second.claim(recover.delivery_id);
      expect(recoveredClaim).toEqual(originalClaim);
      expect(second.accept(recover.delivery_id, recoveredClaim.receipt!)).toMatchObject({
        accepted: true,
      });
      expect(notifications).toBe(1);
      expect(restartedJournal.get(recover.delivery_id)).toMatchObject({
        phase: "harness_accepted",
        claimReceipt: originalReceipt,
        delivery: { lease_token: recover.next_lease_token },
      });
      second.close();
      await expect(secondRun).resolves.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reply persistence stops lease renewal before the HTTP response returns", async () => {
    const fake = fakeConnection();
    let runningUpdates = 0;
    let lateRunningUpdates = 0;
    let workerTerminal = false;
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {},
      postReply: async () => {
        workerTerminal = true;
        await responseGate;
        return { seq: 56 };
      },
      confirmDeliveryUpdate: async (update) => {
        if (update.state === "running") {
          runningUpdates += 1;
          if (workerTerminal) {
            lateRunningUpdates += 1;
            throw new Error("stale running update reached terminal Worker row");
          }
        }
        return update.state;
      },
      leaseRenewIntervalMs: 2,
      deliveryAckRetryDelayMs: 0,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(56, "persist before response", {
      id: "delivery-stop-renewal-before-post",
      target_name: "me",
    }) as ServerFrame);
    const runningBeforeReply = runningUpdates;
    const reply = bridge.reply(56, "done");
    await waitFor(() => workerTerminal, "postReply did not enter its response delay");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runningUpdates).toBe(runningBeforeReply);
    expect(lateRunningUpdates).toBe(0);
    releaseResponse();
    await expect(reply).resolves.toEqual({ seq: 56 });
    expect(bridge.pendingCount).toBe(0);
    bridge.close();
  });

  test("an in-flight renewal cannot retry after reply settlement supersedes its epoch", async () => {
    const fake = fakeConnection();
    let runningUpdates = 0;
    let renewalEntered = false;
    let workerTerminal = false;
    let releaseRenewal!: () => void;
    const renewalGate = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {},
      postReply: async () => {
        workerTerminal = true;
        return { seq: 57 };
      },
      confirmDeliveryUpdate: async (update) => {
        if (update.state !== "running") return update.state;
        runningUpdates += 1;
        if (runningUpdates === 2) {
          renewalEntered = true;
          await renewalGate;
          if (workerTerminal) throw new Error("late renewal rejected by terminal row");
        }
        return "running";
      },
      leaseRenewIntervalMs: 2,
      deliveryAckRetryDelayMs: 0,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(57, "renewal race", {
      id: "delivery-renewal-epoch",
      target_name: "me",
    }) as ServerFrame);
    await waitFor(() => renewalEntered, "lease renewal did not enter its ACK wait");
    await bridge.reply(57, "settle while renewal is in flight");
    releaseRenewal();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runningUpdates).toBe(2);
    expect(bridge.pendingCount).toBe(0);
    bridge.close();
  });

  test("dedicated channel notification stays running until a linked reply is persisted", async () => {
    const fake = fakeConnection();
    const notifications: ChannelNotification[] = [];
    const posts: Parameters<ChannelPostReply>[0][] = [];
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async (notification) => {
        notifications.push(notification);
      },
      postReply: async (reply) => {
        posts.push(reply);
        return { seq: 91 };
      },
      confirmDeliveryUpdate: async (update) => {
        fake.connection.send(update);
      },
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });

    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(7, "please inspect this", {
      id: "delivery-7",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
      work_id: "work-7",
      continuation_ref: "turn-7",
    }) as ServerFrame);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.meta).toMatchObject({
      source: "agentparty",
      channel: "dev",
      seq: "7",
      sender: "alice",
      delivery_id: "delivery-7",
    });
    expect(notifications[0]!.content).toContain("party_channel_reply");
    expect(bridge.pendingCount).toBe(1);
    expect(fake.sent).toContainEqual({ type: "delivery_adapter", adapter: "watch", op: "register" });
    expect(fake.sent).toContainEqual(expect.objectContaining({
      type: "delivery_update",
      delivery_id: "delivery-7",
      state: "running",
      work_id: "work-7",
      continuation_ref: "turn-7",
    }));

    await bridge.reply(7, "done");
    expect(posts).toEqual([{
      body: "done",
      mentions: ["alice"],
      replyTo: 7,
      idempotencyKey: "claude-channel-reply:delivery-7",
    }]);
    expect(bridge.pendingCount).toBe(0);
    expect(fake.sent).toContainEqual(expect.objectContaining({
      type: "delivery_update",
      delivery_id: "delivery-7",
      state: "replied",
      work_id: "work-7",
      continuation_ref: "turn-7",
      reply_seq: 91,
    }));
  });

  test("waiting_owner parks exact lineage, retries a lost ACK without reposting, and restores source context", async () => {
    const fake = fakeConnection();
    const notifications: ChannelNotification[] = [];
    const posts: Parameters<ChannelPostReply>[0][] = [];
    const updates: Array<Extract<ClientFrame, { type: "delivery_update" }>> = [];
    let sourceReplyAcks = 0;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async (notification) => {
        notifications.push(notification);
      },
      postReply: async (reply) => {
        posts.push(reply);
        return { seq: 70 + posts.length };
      },
      confirmDeliveryUpdate: async (update) => {
        updates.push(update);
        if (update.delivery_id === "delivery-source" && update.state === "replied") {
          sourceReplyAcks += 1;
          if (sourceReplyAcks === 1) throw new Error("replied ACK was lost");
          return "waiting_owner";
        }
        return update.state;
      },
      leaseRenewIntervalMs: 10,
      out: () => {},
    });

    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(18, "original source details survive /clear", {
      id: "delivery-source",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
      work_id: "work-affinity",
      continuation_ref: "continuation-affinity",
    }) as ServerFrame);

    await bridge.reply(18, "I need owner approval");
    expect(sourceReplyAcks).toBe(2);
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.parkedContinuationCount).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.idempotencyKey).toBe("claude-channel-reply:delivery-source");

    expect(posts).toHaveLength(1);
    const runningAtPark = updates.filter((update) =>
      update.delivery_id === "delivery-source" && update.state === "running"
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updates.filter((update) =>
      update.delivery_id === "delivery-source" && update.state === "running"
    )).toHaveLength(runningAtPark);

    const owner = ownerAnswerFrame({
      seq: 19,
      deliveryId: "delivery-owner-answer",
      sourceDeliveryId: "delivery-source",
      sourceSeq: 18,
      questionSeq: 71,
      workId: "work-affinity",
      continuationRef: "continuation-affinity",
    });
    await bridge.handleFrame(owner);
    expect(bridge.pendingCount).toBe(1);
    expect(bridge.parkedContinuationCount).toBe(1);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]!.content).toContain("Original source message");
    expect(notifications[1]!.content).toContain("original source details survive /clear");
    expect(notifications[1]!.content).toContain("Owner decision for \"May this continue?\": approve");
    expect(notifications[1]!.meta).toMatchObject({
      delivery_id: "delivery-owner-answer",
      delivery_cause: "owner_answer",
      work_id: "work-affinity",
      continuation_ref: "continuation-affinity",
      continuation_source_delivery_id: "delivery-source",
      continuation_source_seq: "18",
      continuation_source_sender: "alice",
    });

    await bridge.reply(19, "continued after approval");
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.parkedContinuationCount).toBe(0);
    expect(posts.map((post) => ({
      replyTo: post.replyTo,
      key: post.idempotencyKey,
    }))).toEqual([
      { replyTo: 18, key: "claude-channel-reply:delivery-source" },
      { replyTo: 19, key: "claude-channel-reply:delivery-owner-answer" },
    ]);
    bridge.close();
  });

  test("a fresh bridge restores waiting_owner lineage when the old question was pruned", async () => {
    const fake = fakeConnection();
    const notifications: ChannelNotification[] = [];
    const source = deliveryFrame(60, "durable source survives bridge restart", {
      id: "delivery-restart-source",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
      work_id: "work-restart",
      continuation_ref: "continuation-restart",
    }).message as MsgFrame;
    const loadedSeqs: number[] = [];
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async (notification) => {
        notifications.push(notification);
      },
      postReply: async () => ({ seq: 903 }),
      loadMessage: async (seq) => {
        loadedSeqs.push(seq);
        // The decision question can be pruned after a long wait. The Worker's
        // privileged owner_answer snapshots its prompt and private lineage;
        // only the still-retained source row is required from public history.
        return seq === source.seq ? source : null;
      },
      confirmDeliveryUpdate: async (update) => update.state,
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    const owner = ownerAnswerFrame({
      seq: 62,
      deliveryId: "delivery-restart-owner",
      sourceDeliveryId: "delivery-restart-source",
      sourceSeq: 60,
      questionSeq: 61,
      workId: "work-restart",
      continuationRef: "continuation-restart",
    });
    await bridge.handleFrame(owner);

    expect(loadedSeqs).toEqual([60]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.content).toContain("durable source survives bridge restart");
    expect(notifications[0]!.content).toContain("Owner decision for \"May this continue?\": approve");
    expect(bridge.parkedContinuationCount).toBe(1);
    await bridge.reply(62, "continued in the restored current session");
    expect(bridge.parkedContinuationCount).toBe(0);
    expect(bridge.pendingCount).toBe(0);
    bridge.close();
  });

  test("an owner answer reconciles a persisted source POST whose HTTP response is still lost", async () => {
    const fake = fakeConnection();
    const notifications: ChannelNotification[] = [];
    const posts: Parameters<ChannelPostReply>[0][] = [];
    let sourcePostEntered = false;
    let releaseSourceResponse!: () => void;
    const sourceResponseGate = new Promise<void>((resolve) => {
      releaseSourceResponse = resolve;
    });
    const sourceFrame = deliveryFrame(70, "source persisted before its HTTP response", {
      id: "delivery-source-http-loss",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
      work_id: "work-http-loss",
      continuation_ref: "continuation-http-loss",
    }) as Extract<ServerFrame, { type: "delivery" }>;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async (notification) => {
        notifications.push(notification);
      },
      postReply: async (reply) => {
        posts.push(reply);
        if (reply.replyTo === 70) {
          sourcePostEntered = true;
          await sourceResponseGate;
          throw new Error("HTTP response was lost after Worker persistence");
        }
        return { seq: 73 };
      },
      loadMessage: async (seq) => seq === 70 ? sourceFrame.message : null,
      confirmDeliveryUpdate: async (update) => {
        if (update.delivery_id === "delivery-source-http-loss" && update.state === "replied") {
          return "waiting_owner";
        }
        return update.state;
      },
      leaseRenewIntervalMs: 2,
      deliveryAckRetryDelayMs: 0,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(sourceFrame);
    const sourceReply = bridge.reply(70, "ask owner");
    await waitFor(() => sourcePostEntered, "source post did not reach its response-loss window");

    await bridge.handleFrame(ownerAnswerFrame({
      seq: 72,
      deliveryId: "delivery-owner-http-loss",
      sourceDeliveryId: "delivery-source-http-loss",
      sourceSeq: 70,
      questionSeq: 71,
      workId: "work-http-loss",
      continuationRef: "continuation-http-loss",
    }));
    expect(notifications).toHaveLength(2);
    expect(notifications[1]!.content).toContain("source persisted before its HTTP response");
    expect(bridge.parkedContinuationCount).toBe(1);

    releaseSourceResponse();
    await expect(sourceReply).resolves.toEqual({ seq: 71 });
    await bridge.reply(72, "continue after authoritative reconciliation");
    expect(posts.map((post) => post.idempotencyKey)).toEqual([
      "claude-channel-reply:delivery-source-http-loss",
      "claude-channel-reply:delivery-owner-http-loss",
    ]);
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.parkedContinuationCount).toBe(0);
    bridge.close();
  });

  test("an early owner answer cannot be rejected or resurrected by a late source ACK", async () => {
    const fake = fakeConnection();
    const notifications: ChannelNotification[] = [];
    const posts: Parameters<ChannelPostReply>[0][] = [];
    let sourceAckRequested = false;
    let releaseSourceAck: (() => void) | null = null;
    const sourceAck = new Promise<"waiting_owner">((resolve) => {
      releaseSourceAck = () => resolve("waiting_owner");
    });
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async (notification) => {
        notifications.push(notification);
      },
      postReply: async (reply) => {
        posts.push(reply);
        return { seq: 120 + posts.length };
      },
      confirmDeliveryUpdate: async (update) => {
        if (update.delivery_id === "delivery-source-race" && update.state === "replied") {
          sourceAckRequested = true;
          return await sourceAck;
        }
        return update.state;
      },
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(30, "source whose ACK arrives late", {
      id: "delivery-source-race",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
      work_id: "work-race",
      continuation_ref: "continuation-race",
    }) as ServerFrame);

    const sourceReply = bridge.reply(30, "ask the owner");
    await waitFor(() => sourceAckRequested, "source reply did not reach its ACK wait");
    const owner = ownerAnswerFrame({
      seq: 31,
      deliveryId: "delivery-owner-race",
      sourceDeliveryId: "delivery-source-race",
      sourceSeq: 30,
      questionSeq: 121,
      workId: "work-race",
      continuationRef: "continuation-race",
    });
    await bridge.handleFrame(owner);
    expect(notifications[1]!.content).toContain("source whose ACK arrives late");

    await bridge.reply(31, "continued before the source ACK returned");
    expect(bridge.parkedContinuationCount).toBe(0);
    releaseSourceAck!();
    await sourceReply;
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.parkedContinuationCount).toBe(0);
    expect(posts.map((post) => post.idempotencyKey)).toEqual([
      "claude-channel-reply:delivery-source-race",
      "claude-channel-reply:delivery-owner-race",
    ]);
    bridge.close();
  });

  test("owner_answer is never injected unless every parked lineage field matches", async () => {
    const fake = fakeConnection();
    const notifications: ChannelNotification[] = [];
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async (notification) => {
        notifications.push(notification);
      },
      postReply: async () => ({ seq: 81 }),
      confirmDeliveryUpdate: async (update) => {
        if (update.delivery_id === "delivery-source-strict" && update.state === "replied") {
          return "waiting_owner";
        }
        return update.state;
      },
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(20, "strict source", {
      id: "delivery-source-strict",
      target_name: "me",
      work_id: "work-strict",
      continuation_ref: "continuation-strict",
    }) as ServerFrame);
    await bridge.reply(20, "owner question");
    expect(bridge.parkedContinuationCount).toBe(1);

    const crossed = ownerAnswerFrame({
      seq: 21,
      deliveryId: "delivery-crossed-answer",
      sourceDeliveryId: "wrong-source-delivery",
      sourceSeq: 20,
      questionSeq: 81,
      workId: "work-strict",
      continuationRef: "continuation-strict",
    });
    await bridge.handleFrame(crossed);
    expect(notifications).toHaveLength(1);
    expect(fake.sent).toContainEqual(expect.objectContaining({
      type: "delivery_adapter",
      adapter: "watch",
      op: "register",
    }));
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.parkedContinuationCount).toBe(1);
    await expect(bridge.reply(21, "must not run")).rejects.toThrow("no pending");
    bridge.close();
  });

  test("owner_answer notification uncertainty keeps parked lineage for an exact late reply", async () => {
    const fake = fakeConnection();
    let notifications = 0;
    let ownerFailureAcks = 0;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {
        notifications += 1;
        if (notifications === 2) throw new Error("Claude cleared the channel");
      },
      postReply: async () => ({ seq: 91 }),
      confirmDeliveryUpdate: async (update) => {
        if (update.delivery_id === "delivery-source-failure" && update.state === "replied") {
          return "waiting_owner";
        }
        if (update.delivery_id === "delivery-owner-failure" && update.state === "failed") {
          ownerFailureAcks += 1;
          if (ownerFailureAcks === 1) throw new Error("failed ACK was lost");
        }
        return update.state;
      },
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(22, "source awaiting owner", {
      id: "delivery-source-failure",
      target_name: "me",
      work_id: "work-owner-failure",
      continuation_ref: "continuation-owner-failure",
    }) as ServerFrame);
    await bridge.reply(22, "owner question");
    expect(bridge.parkedContinuationCount).toBe(1);

    const owner = ownerAnswerFrame({
      seq: 23,
      deliveryId: "delivery-owner-failure",
      sourceDeliveryId: "delivery-source-failure",
      sourceSeq: 22,
      questionSeq: 91,
      workId: "work-owner-failure",
      continuationRef: "continuation-owner-failure",
    });
    await bridge.handleFrame(owner);
    expect(ownerFailureAcks).toBe(0);
    expect(notifications).toBe(2);
    expect(bridge.pendingCount).toBe(1);
    expect(bridge.parkedContinuationCount).toBe(1);
    await expect(bridge.reply(23, "late owner continuation success")).resolves.toEqual({ seq: 91 });
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.parkedContinuationCount).toBe(0);
    bridge.close();
  });

  test("claim and accept are WAL-first, receipt-stable, and idempotent across lost MCP responses", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-claude-claim-gate-"));
    const path = join(root, "journal.json");
    try {
      let failNextCommit = false;
      const journal = new DeliveryRecoveryJournal(path, "dev", "claude", {
        persist(commit) {
          if (failNextCommit) {
            failNextCommit = false;
            throw Object.assign(new Error("claim WAL is full"), { code: "ENOSPC" });
          }
          commit();
        },
      });
      const fake = fakeConnection();
      const notifications: ChannelNotification[] = [];
      let failedUpdates = 0;
      const bridge = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: fake.connection,
        recoveryJournal: journal,
        requireHarnessClaim: true,
        harnessClaimRetryDelayMs: 1,
        harnessClaimMaxNotifications: 3,
        leaseRenewIntervalMs: 60_000,
        notify: async (notification) => {
          notifications.push(notification);
          if (notifications.length === 1) throw new Error("transient channel write failure");
        },
        postReply: async () => ({ seq: 1 }),
        confirmDeliveryUpdate: async (update) => {
          fake.connection.send(update);
          if (update.state === "failed") failedUpdates += 1;
          return update.state;
        },
        out: () => {},
      });
      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(deliveryFrame(8, "secret body exactly once", {
        id: "delivery-claim-gate",
        target_name: "me",
      }) as ServerFrame);
      await waitFor(
        () => notifications.length >= 2,
        "claim-only notification did not retry its transient transport failure",
      );

      expect(failedUpdates).toBe(0);
      expect(bridge.pendingCount).toBe(1);
      expect(notifications.every((notification) =>
        !notification.content.includes("secret body exactly once")
      )).toBe(true);
      expect(journal.get("delivery-claim-gate")).toMatchObject({ phase: "harness_issued" });

      failNextCommit = true;
      let claimWalError: Error | null = null;
      try {
        bridge.claim("delivery-claim-gate");
      } catch (error) {
        claimWalError = error instanceof Error ? error : new Error(String(error));
      }
      expect(claimWalError?.message).toContain("claim WAL is full");
      expect(claimWalError?.message).not.toContain("secret body exactly once");
      expect(journal.get("delivery-claim-gate")).toMatchObject({
        phase: "harness_issued",
        claimReceipt: null,
      });

      // Treat the first successful return as if the MCP response were lost:
      // an equivalent retry must expose the exact same invocation identity
      // and body until that receipt is durably accepted.
      const firstClaim = bridge.claim("delivery-claim-gate");
      const firstReceipt = firstClaim.receipt;
      expect(firstClaim.claimed).toBe(true);
      expect(typeof firstReceipt).toBe("string");
      expect(firstClaim.content).toContain("secret body exactly once");
      const retriedClaim = bridge.claim("delivery-claim-gate");
      expect(retriedClaim).toEqual(firstClaim);
      expect(journal.get("delivery-claim-gate")).toMatchObject({
        phase: "harness_issued",
        claimReceipt: firstReceipt,
      });
      await expect(bridge.reply(8, "must wait for durable acceptance")).rejects.toThrow(
        "accepted",
      );
      expect(bridge.claim("delivery-claim-gate")).toEqual(firstClaim);
      expect(() =>
        bridge.accept("delivery-claim-gate", "receipt-from-an-old-generation")
      ).toThrow("invalid or belongs to an old ownership generation");
      expect(bridge.claim("delivery-claim-gate")).toEqual(firstClaim);

      // Likewise, ignore the first accept result to model an ACK lost after
      // its WAL commit. Repeating the exact receipt succeeds idempotently and
      // never releases another copy of the body.
      const accepted = bridge.accept("delivery-claim-gate", firstReceipt!);
      expect(accepted).toMatchObject({ accepted: true });
      expect(journal.get("delivery-claim-gate")).toMatchObject({
        phase: "harness_accepted",
        claimReceipt: firstReceipt,
      });
      expect(bridge.accept("delivery-claim-gate", firstReceipt!)).toMatchObject({
        accepted: false,
        content: expect.stringContaining("already durably accepted"),
      });
      expect(bridge.claim("delivery-claim-gate")).toMatchObject({
        claimed: false,
        receipt: firstReceipt,
        content: expect.not.stringContaining("secret body exactly once"),
      });
      await expect(bridge.reply(8, "accepted linked response")).resolves.toEqual({ seq: 1 });
      expect(journal.get("delivery-claim-gate")).toBeNull();
      bridge.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("A-to-B-to-C ownership recovery keeps claim and accept closed until the newest CAS completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-claude-recovery-gate-"));
    try {
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "claude",
      );
      const stream = streamingConnection();
      const notifications: ChannelNotification[] = [];
      const bridge = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: stream.connection,
        recoveryJournal: journal,
        requireHarnessClaim: true,
        harnessClaimRetryDelayMs: 60_000,
        notify: async (notification) => {
          notifications.push(notification);
        },
        postReply: async () => ({ seq: 1 }),
        confirmDeliveryUpdate: async (update) => update.state,
        leaseRenewIntervalMs: 60_000,
        deliveryAckTimeoutMs: 1_000,
        out: () => {},
      });
      const incoming = deliveryFrame(58, "one logical invocation across A B C", {
        id: "delivery-recovery-gate",
        target_name: "me",
      }) as Extract<ServerFrame, { type: "delivery" }>;

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(incoming);
      expect(notifications).toHaveLength(1);
      const claimOnA = bridge.claim(incoming.delivery.id);
      const receiptOnA = claimOnA.receipt;
      expect(claimOnA.claimed).toBe(true);
      expect(typeof receiptOnA).toBe("string");
      expect(claimOnA.content).toContain("one logical invocation across A B C");

      await bridge.handleFrame(welcomeDirectedFrame(58, "me") as ServerFrame);
      await waitFor(
        () => stream.sent.filter((frame) => frame.type === "delivery_recover").length === 1,
        "B did not begin ownership recovery",
      );
      const recoveryB = stream.sent.find((frame) =>
        frame.type === "delivery_recover"
      ) as Extract<ClientFrame, { type: "delivery_recover" }>;
      expect(() => bridge.claim(incoming.delivery.id)).toThrow("recovering ownership");
      expect(() => bridge.accept(incoming.delivery.id, receiptOnA!)).toThrow(
        "recovering ownership",
      );

      await bridge.handleFrame(welcomeDirectedFrame(58, "me") as ServerFrame);
      await waitFor(
        () => stream.sent.filter((frame) => frame.type === "delivery_recover").length === 2,
        "C did not replace B's ownership recovery",
      );
      const recoveryC = stream.sent.filter((frame) =>
        frame.type === "delivery_recover"
      )[1] as Extract<ClientFrame, { type: "delivery_recover" }>;
      expect(recoveryC.request_id).not.toBe(recoveryB.request_id);

      // B's delayed result is no longer correlated. In particular, B's
      // finally block must not delete C's object-identity claim gate.
      await bridge.handleFrame({
        type: "delivery_recovery",
        delivery_id: recoveryB.delivery_id,
        request_id: recoveryB.request_id,
        result: "recovered",
        state: "running",
        attempt: recoveryB.attempt,
        lease_epoch: recoveryB.lease_epoch,
        lease_token: recoveryB.next_lease_token,
        lease_until: Date.now() + 90_000,
      });
      expect(() => bridge.claim(incoming.delivery.id)).toThrow("recovering ownership");
      expect(() => bridge.accept(incoming.delivery.id, receiptOnA!)).toThrow(
        "recovering ownership",
      );

      await bridge.handleFrame({
        type: "delivery_recovery",
        delivery_id: recoveryC.delivery_id,
        request_id: recoveryC.request_id,
        result: "recovered",
        state: "running",
        attempt: recoveryC.attempt,
        lease_epoch: recoveryC.lease_epoch,
        lease_token: recoveryC.next_lease_token,
        lease_until: Date.now() + 90_000,
      });
      await waitFor(
        () =>
          journal.get(incoming.delivery.id)?.delivery.lease_token ===
            recoveryC.next_lease_token &&
          notifications.length === 2,
        "C did not finish recovery and restore the claim-only notification",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const claimOnC = bridge.claim(incoming.delivery.id);
      expect(claimOnC).toEqual(claimOnA);
      expect(bridge.accept(incoming.delivery.id, claimOnC.receipt!)).toMatchObject({
        accepted: true,
      });
      expect(journal.get(incoming.delivery.id)).toMatchObject({
        phase: "harness_accepted",
        claimReceipt: receiptOnA,
        delivery: { lease_token: recoveryC.next_lease_token },
      });
      bridge.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("one journal snapshot gates every claim before its first recovery await", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-claude-multi-recovery-gate-"));
    try {
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "claude",
      );
      const stream = streamingConnection();
      const notifications: ChannelNotification[] = [];
      const bridge = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: stream.connection,
        recoveryJournal: journal,
        requireHarnessClaim: true,
        harnessClaimRetryDelayMs: 60_000,
        notify: async (notification) => {
          notifications.push(notification);
        },
        postReply: async () => ({ seq: 1 }),
        confirmDeliveryUpdate: async (update) => update.state,
        leaseRenewIntervalMs: 60_000,
        deliveryAckTimeoutMs: 1_000,
        out: () => {},
      });
      const first = deliveryFrame(60, "first recovery blocks on its CAS", {
        id: "delivery-multi-recovery-first",
        target_name: "me",
      }) as Extract<ServerFrame, { type: "delivery" }>;
      const second = deliveryFrame(61, "second body must already be gated", {
        id: "delivery-multi-recovery-second",
        target_name: "me",
      }) as Extract<ServerFrame, { type: "delivery" }>;

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(first);
      await bridge.handleFrame(second);
      const firstClaim = bridge.claim(first.delivery.id);
      const secondClaim = bridge.claim(second.delivery.id);
      expect(notifications).toHaveLength(2);

      await bridge.handleFrame(welcomeDirectedFrame(61, "me") as ServerFrame);
      await waitFor(
        () => stream.sent.filter((frame) => frame.type === "delivery_recover").length === 1,
        "first journal entry did not begin ownership recovery",
      );
      const firstRecovery = stream.sent.find((frame) =>
        frame.type === "delivery_recover"
      ) as Extract<ClientFrame, { type: "delivery_recover" }>;
      expect(firstRecovery.delivery_id).toBe(first.delivery.id);

      // The recovery loop has not reached the second entry yet. Its gate must
      // nevertheless have been installed synchronously from the same snapshot.
      expect(() => bridge.claim(second.delivery.id)).toThrow("recovering ownership");
      expect(() =>
        bridge.accept(second.delivery.id, secondClaim.receipt!)
      ).toThrow("recovering ownership");

      await bridge.handleFrame({
        type: "delivery_recovery",
        delivery_id: firstRecovery.delivery_id,
        request_id: firstRecovery.request_id,
        result: "recovered",
        state: "running",
        attempt: firstRecovery.attempt,
        lease_epoch: firstRecovery.lease_epoch,
        lease_token: firstRecovery.next_lease_token,
        lease_until: Date.now() + 90_000,
      });
      await waitFor(
        () => stream.sent.filter((frame) => frame.type === "delivery_recover").length === 2,
        "second journal entry did not begin ownership recovery",
      );
      const secondRecovery = stream.sent.filter((frame) =>
        frame.type === "delivery_recover"
      )[1] as Extract<ClientFrame, { type: "delivery_recover" }>;
      expect(secondRecovery.delivery_id).toBe(second.delivery.id);
      expect(() => bridge.claim(second.delivery.id)).toThrow("recovering ownership");
      expect(() =>
        bridge.accept(second.delivery.id, secondClaim.receipt!)
      ).toThrow("recovering ownership");

      await bridge.handleFrame({
        type: "delivery_recovery",
        delivery_id: secondRecovery.delivery_id,
        request_id: secondRecovery.request_id,
        result: "recovered",
        state: "running",
        attempt: secondRecovery.attempt,
        lease_epoch: secondRecovery.lease_epoch,
        lease_token: secondRecovery.next_lease_token,
        lease_until: Date.now() + 90_000,
      });
      await waitFor(
        () =>
          notifications.length === 4 &&
          journal.get(second.delivery.id)?.delivery.lease_token ===
            secondRecovery.next_lease_token,
        "second journal entry did not finish its own reconciliation",
      );

      expect(bridge.claim(first.delivery.id)).toEqual(firstClaim);
      expect(bridge.claim(second.delivery.id)).toEqual(secondClaim);
      expect(bridge.accept(second.delivery.id, secondClaim.receipt!)).toMatchObject({
        accepted: true,
      });
      bridge.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reconnect resets an exhausted claim-notification budget and retries on the new ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-claude-reconnect-notify-budget-"));
    try {
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "claude",
      );
      const stream = streamingConnection();
      const notifications: ChannelNotification[] = [];
      let reconnecting = false;
      let reconnectNotifications = 0;
      const bridge = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: stream.connection,
        recoveryJournal: journal,
        requireHarnessClaim: true,
        harnessClaimRetryDelayMs: 20,
        harnessClaimMaxNotifications: 2,
        notify: async (notification) => {
          notifications.push(notification);
          if (!reconnecting) return;
          reconnectNotifications += 1;
          if (reconnectNotifications === 1) {
            throw new Error("first notification on replacement connection failed");
          }
        },
        postReply: async () => ({ seq: 1 }),
        confirmDeliveryUpdate: async (update) => update.state,
        leaseRenewIntervalMs: 60_000,
        deliveryAckTimeoutMs: 1_000,
        out: () => {},
      });
      const incoming = deliveryFrame(62, "retry this receipt after reconnect", {
        id: "delivery-reconnect-notify-budget",
        target_name: "me",
      }) as Extract<ServerFrame, { type: "delivery" }>;

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(incoming);
      const originalClaim = bridge.claim(incoming.delivery.id);
      await waitFor(
        () => notifications.length === 2,
        "initial ownership did not consume its bounded notification attempts",
      );

      // At this point the counter is at its maximum and the old generation
      // still owns a scheduled timer. Reconnect must cancel that timer and
      // grant the recovered bearer a fresh budget.
      reconnecting = true;
      await bridge.handleFrame(welcomeDirectedFrame(62, "me") as ServerFrame);
      await waitFor(
        () => stream.sent.some((frame) => frame.type === "delivery_recover"),
        "replacement connection did not begin ownership recovery",
      );
      const recovery = stream.sent.find((frame) =>
        frame.type === "delivery_recover"
      ) as Extract<ClientFrame, { type: "delivery_recover" }>;
      await bridge.handleFrame({
        type: "delivery_recovery",
        delivery_id: recovery.delivery_id,
        request_id: recovery.request_id,
        result: "recovered",
        state: "running",
        attempt: recovery.attempt,
        lease_epoch: recovery.lease_epoch,
        lease_token: recovery.next_lease_token,
        lease_until: Date.now() + 90_000,
      });
      await waitFor(
        () => reconnectNotifications === 2,
        "replacement ownership did not retry its first failed notification",
      );

      expect(notifications.every((notification) =>
        !notification.content.includes("retry this receipt after reconnect")
      )).toBe(true);
      expect(bridge.claim(incoming.delivery.id)).toEqual(originalClaim);
      expect(bridge.accept(incoming.delivery.id, originalClaim.receipt!)).toMatchObject({
        accepted: true,
      });
      bridge.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("authoritative recovery retries on the same connection and keeps the receipt gated until success", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-claude-recovery-failure-gate-"));
    try {
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "claude",
      );
      const stream = streamingConnection();
      const logs: string[] = [];
      const bridge = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: stream.connection,
        recoveryJournal: journal,
        requireHarnessClaim: true,
        harnessClaimRetryDelayMs: 60_000,
        notify: async () => {},
        postReply: async () => ({ seq: 1 }),
        confirmDeliveryUpdate: async (update) => update.state,
        leaseRenewIntervalMs: 60_000,
        deliveryAckTimeoutMs: 50,
        deliveryRecoveryRetryDelayMs: 50,
        out: (line) => logs.push(line),
      });
      const incoming = deliveryFrame(59, "withhold until recovery is authoritative", {
        id: "delivery-recovery-failure-gate",
        target_name: "me",
      }) as Extract<ServerFrame, { type: "delivery" }>;

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(incoming);
      const originalClaim = bridge.claim(incoming.delivery.id);
      const originalReceipt = originalClaim.receipt;
      expect(typeof originalReceipt).toBe("string");

      // Neither of the two bounded recovery attempts receives an authoritative
      // result. That is uncertainty, not evidence that the old bearer or the
      // harness invocation is safe to use.
      await bridge.handleFrame(welcomeDirectedFrame(59, "me") as ServerFrame);
      await waitFor(
        () => stream.sent.filter((frame) => frame.type === "delivery_recover").length >= 2,
        "recovery did not reach its second immediate attempt",
      );
      expect(() => bridge.claim(incoming.delivery.id)).toThrow("recovering ownership");
      expect(() => bridge.accept(incoming.delivery.id, originalReceipt!)).toThrow(
        "recovering ownership",
      );
      expect(journal.get(incoming.delivery.id)).toMatchObject({
        phase: "harness_issued",
        claimReceipt: originalReceipt,
      });

      // The bridge must keep reconciling on this healthy websocket rather than
      // waiting forever for another welcome frame. A CAS from the next
      // recovery pass receives the authoritative result and is the only event
      // that re-opens the gate.
      await waitFor(
        () =>
          logs.some((line) => line.includes("could not recover delivery")) &&
          stream.sent.filter((frame) => frame.type === "delivery_recover").length >= 3,
        "recovery did not retry on the same connection",
      );
      const recoveries = stream.sent.filter((frame) =>
        frame.type === "delivery_recover"
      ) as Array<Extract<ClientFrame, { type: "delivery_recover" }>>;
      expect(new Set(recoveries.map((frame) => frame.request_id)).size).toBeGreaterThanOrEqual(3);
      const retryRecovery = recoveries.at(-1)!;
      expect(() => bridge.claim(incoming.delivery.id)).toThrow("recovering ownership");
      await bridge.handleFrame({
        type: "delivery_recovery",
        delivery_id: retryRecovery.delivery_id,
        request_id: retryRecovery.request_id,
        result: "recovered",
        state: "running",
        attempt: retryRecovery.attempt,
        lease_epoch: retryRecovery.lease_epoch,
        lease_token: retryRecovery.next_lease_token,
        lease_until: Date.now() + 90_000,
      });
      await waitFor(
        () =>
          journal.get(incoming.delivery.id)?.delivery.lease_token ===
          retryRecovery.next_lease_token,
        "same-connection retry result did not become authoritative",
      );
      expect(bridge.claim(incoming.delivery.id)).toEqual(originalClaim);
      expect(bridge.accept(incoming.delivery.id, originalReceipt!)).toMatchObject({
        accepted: true,
      });
      bridge.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an early owner answer claim retains exact source context while the source replied ACK is pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-claude-owner-claim-race-"));
    try {
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "claude",
      );
      const fake = fakeConnection();
      const notifications: ChannelNotification[] = [];
      const posts: Parameters<ChannelPostReply>[0][] = [];
      let sourceAckRequested = false;
      let releaseSourceAck!: () => void;
      const sourceAck = new Promise<"waiting_owner">((resolve) => {
        releaseSourceAck = () => resolve("waiting_owner");
      });
      const bridge = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: fake.connection,
        recoveryJournal: journal,
        requireHarnessClaim: true,
        harnessClaimRetryDelayMs: 60_000,
        notify: async (notification) => {
          notifications.push(notification);
        },
        postReply: async (reply) => {
          posts.push(reply);
          return { seq: reply.replyTo === 30 ? 121 : 122 };
        },
        confirmDeliveryUpdate: async (update) => {
          if (update.delivery_id === "delivery-source-claim-race" && update.state === "replied") {
            sourceAckRequested = true;
            return await sourceAck;
          }
          return update.state;
        },
        leaseRenewIntervalMs: 60_000,
        out: () => {},
      });
      const source = deliveryFrame(30, "private source survives the early owner race", {
        id: "delivery-source-claim-race",
        target_name: "me",
        sender: { name: "alice", kind: "human" },
        work_id: "work-claim-race",
        continuation_ref: "continuation-claim-race",
      }) as Extract<ServerFrame, { type: "delivery" }>;

      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(source);
      const sourceClaim = bridge.claim(source.delivery.id);
      bridge.accept(source.delivery.id, sourceClaim.receipt!);
      const sourceReply = bridge.reply(30, "ask the owner");
      await waitFor(() => sourceAckRequested, "source reply did not enter its ACK window");

      const owner = ownerAnswerFrame({
        seq: 31,
        deliveryId: "delivery-owner-claim-race",
        sourceDeliveryId: "delivery-source-claim-race",
        sourceSeq: 30,
        questionSeq: 121,
        workId: "work-claim-race",
        continuationRef: "continuation-claim-race",
      });
      await bridge.handleFrame(owner);
      expect(notifications).toHaveLength(2);
      const ownerClaim = bridge.claim(owner.delivery.id);
      expect(ownerClaim.content).toContain("private source survives the early owner race");
      expect(ownerClaim.content).toContain('Owner decision for "May this continue?": approve');
      expect(ownerClaim.content).toContain("owner approved");
      bridge.accept(owner.delivery.id, ownerClaim.receipt!);
      await expect(bridge.reply(31, "continued exactly once")).resolves.toEqual({ seq: 122 });
      expect(bridge.pendingCount).toBe(1);
      expect(bridge.parkedContinuationCount).toBe(0);

      releaseSourceAck();
      await expect(sourceReply).resolves.toEqual({ seq: 121 });
      expect(bridge.pendingCount).toBe(0);
      expect(bridge.parkedContinuationCount).toBe(0);
      expect(posts.map((post) => post.idempotencyKey)).toEqual([
        "claude-channel-reply:delivery-source-claim-race",
        "claude-channel-reply:delivery-owner-claim-race",
      ]);
      bridge.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hung claim-only transport attempt times out and retries without releasing the body", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-claude-claim-timeout-"));
    try {
      const journal = new DeliveryRecoveryJournal(
        join(root, "journal.json"),
        "dev",
        "claude",
      );
      const fake = fakeConnection();
      const notifications: ChannelNotification[] = [];
      let failedUpdates = 0;
      const bridge = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: fake.connection,
        recoveryJournal: journal,
        requireHarnessClaim: true,
        harnessClaimNotifyTimeoutMs: 5,
        harnessClaimRetryDelayMs: 1,
        harnessClaimMaxNotifications: 3,
        leaseRenewIntervalMs: 60_000,
        notify: async (notification) => {
          notifications.push(notification);
          if (notifications.length === 1) await new Promise<never>(() => {});
        },
        postReply: async () => ({ seq: 1 }),
        confirmDeliveryUpdate: async (update) => {
          if (update.state === "failed") failedUpdates += 1;
          return update.state;
        },
        out: () => {},
      });
      await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await bridge.handleFrame(deliveryFrame(9, "body remains behind claim", {
        id: "delivery-hung-claim-notify",
        target_name: "me",
      }) as ServerFrame);
      await waitFor(
        () => notifications.length >= 2,
        "hung claim notification did not yield to a bounded retry",
      );
      expect(notifications.every((notification) =>
        !notification.content.includes("body remains behind claim")
      )).toBe(true);
      expect(failedUpdates).toBe(0);
      expect(bridge.pendingCount).toBe(1);
      expect(journal.get("delivery-hung-claim-notify")).toMatchObject({
        phase: "harness_issued",
      });
      bridge.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a full-body notification error remains late-reply debt instead of ordinary failed", async () => {
    const fake = fakeConnection();
    let notifications = 0;
    let failedUpdates = 0;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {
        notifications += 1;
        throw new Error("response lost after Channel transport write");
      },
      postReply: async () => ({ seq: 108 }),
      confirmDeliveryUpdate: async (update) => {
        fake.connection.send(update);
        if (update.state === "failed") failedUpdates += 1;
        return update.state;
      },
      recoveryUncertaintyTimeoutMs: 5,
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(8, "may already be in Claude", {
      id: "delivery-after-write-unknown",
      target_name: "me",
    }) as ServerFrame);
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(notifications).toBe(1);
    expect(failedUpdates).toBe(0);
    expect(bridge.pendingCount).toBe(1);
    await expect(bridge.reply(8, "late success")).resolves.toEqual({ seq: 108 });
    expect(bridge.pendingCount).toBe(0);
    bridge.close();
  });

  test("restart never replays an uncertain full-body notification and still accepts its late reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "ap-claude-after-write-"));
    const path = join(root, "journal.json");
    try {
      const incoming = deliveryFrame(80, "do not replay this body", {
        id: "delivery-after-write-restart",
        target_name: "me",
      }) as Extract<ServerFrame, { type: "delivery" }>;
      const firstJournal = new DeliveryRecoveryJournal(path, "dev", "claude");
      const first = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: fakeConnection().connection,
        recoveryJournal: firstJournal,
        notify: async () => {
          throw new Error("stdio disconnected after notification write");
        },
        postReply: async () => ({ seq: 1 }),
        confirmDeliveryUpdate: async (update) => update.state,
        leaseRenewIntervalMs: 60_000,
        recoveryUncertaintyTimeoutMs: 5,
        out: () => {},
      });
      await first.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
      await first.handleFrame(incoming);
      expect(firstJournal.get(incoming.delivery.id)).toMatchObject({ phase: "harness_issued" });
      first.close();

      const stream = streamingConnection();
      const restartedJournal = new DeliveryRecoveryJournal(path, "dev", "claude");
      let replayedNotifications = 0;
      let failedUpdates = 0;
      const restarted = new ClaudeChannelDeliveryBridge({
        channel: "dev",
        connection: stream.connection,
        recoveryJournal: restartedJournal,
        notify: async () => {
          replayedNotifications += 1;
        },
        postReply: async () => ({ seq: 180 }),
        confirmDeliveryUpdate: async (update) => {
          if (update.state === "failed") failedUpdates += 1;
          return update.state;
        },
        recoveryUncertaintyTimeoutMs: 5,
        leaseRenewIntervalMs: 60_000,
        out: () => {},
      });
      const run = restarted.run();
      stream.push(welcomeDirectedFrame(80, "me") as ServerFrame);
      await waitFor(
        () => stream.sent.some((frame) => frame.type === "delivery_recover"),
        "restart did not request durable ownership recovery",
      );
      const recovery = stream.sent.find((frame) =>
        frame.type === "delivery_recover"
      ) as Extract<ClientFrame, { type: "delivery_recover" }>;
      expect(recovery.replay_safe).toBeUndefined();
      stream.push({
        type: "delivery_recovery",
        delivery_id: recovery.delivery_id,
        request_id: recovery.request_id,
        result: "recovered",
        state: "running",
        attempt: recovery.attempt,
        lease_epoch: recovery.lease_epoch,
        lease_token: recovery.next_lease_token,
        lease_until: Date.now() + 90_000,
      });
      await waitFor(() => restarted.pendingCount === 1, "late-reply debt was not restored");
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(replayedNotifications).toBe(0);
      expect(failedUpdates).toBe(0);
      await expect(restarted.reply(80, "late recovered success")).resolves.toEqual({ seq: 180 });
      expect(restarted.pendingCount).toBe(0);
      restarted.close();
      await expect(run).resolves.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a persisted reply ACK settles in the background after a longer websocket outage", async () => {
    const fake = fakeConnection();
    let replyPosts = 0;
    let repliedAttempts = 0;
    let acknowledgeReply = false;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {},
      postReply: async () => {
        replyPosts += 1;
        return { seq: 181 };
      },
      confirmDeliveryUpdate: async (update) => {
        if (update.state !== "replied") return update.state;
        repliedAttempts += 1;
        if (!acknowledgeReply) throw new Error("replied ACK path unavailable");
        return "replied";
      },
      deliveryAckMaxAttempts: 2,
      deliveryAckRetryDelayMs: 0,
      deliverySettleRetryDelayMs: 5,
      deliverySettleRetryMaxRounds: 1,
      deliverySettleRetryCooldownMs: 5,
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(81, "reply across reconnect", {
      id: "delivery-replied-background-retry",
      target_name: "me",
    }) as ServerFrame);
    await expect(bridge.reply(81, "persisted once")).rejects.toThrow("replied ACK path unavailable");
    expect(replyPosts).toBe(1);
    expect(bridge.pendingCount).toBe(1);
    await waitFor(() => repliedAttempts >= 6, "cooldown replied ACK reconciliation did not continue");
    acknowledgeReply = true;
    await waitFor(() => bridge.pendingCount === 0, "persisted reply did not settle after recovery");

    expect(replyPosts).toBe(1);
    expect(repliedAttempts).toBeGreaterThanOrEqual(7);
    bridge.close();
  });

  test("redelivery restarts settlement from an exhausted cooldown without reposting", async () => {
    const fake = fakeConnection();
    let replyPosts = 0;
    let repliedAttempts = 0;
    let acknowledgeReply = false;
    const incoming = deliveryFrame(82, "redelivered settlement", {
      id: "delivery-redelivery-reconcile",
      target_name: "me",
    }) as ServerFrame;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {},
      postReply: async () => {
        replyPosts += 1;
        return { seq: 182 };
      },
      confirmDeliveryUpdate: async (update) => {
        if (update.state !== "replied") return update.state;
        repliedAttempts += 1;
        if (!acknowledgeReply) throw new Error("replied ACK unavailable");
        return "replied";
      },
      deliveryAckMaxAttempts: 1,
      deliveryAckRetryDelayMs: 0,
      deliverySettleRetryDelayMs: 5,
      deliverySettleRetryMaxRounds: 1,
      deliverySettleRetryCooldownMs: 60_000,
      leaseRenewIntervalMs: 60_000,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(incoming);
    await expect(bridge.reply(82, "persist once")).rejects.toThrow("replied ACK unavailable");
    await waitFor(() => repliedAttempts >= 2, "fast settlement round did not exhaust");
    expect(bridge.pendingCount).toBe(1);

    acknowledgeReply = true;
    await bridge.handleFrame(incoming);
    await waitFor(() => bridge.pendingCount === 0, "redelivery did not restart settlement");
    expect(replyPosts).toBe(1);
    expect(repliedAttempts).toBe(3);
    bridge.close();
  });

  test("a lost REST response retries automatically with one stable logical reply", async () => {
    const fake = fakeConnection();
    let notifications = 0;
    let attempts = 0;
    let returnPersistedResponse = false;
    const keys: string[] = [];
    const logicalReplies = new Map<string, number>();
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {
        notifications += 1;
      },
      postReply: async (reply) => {
        attempts += 1;
        keys.push(reply.idempotencyKey);
        const persisted = logicalReplies.get(reply.idempotencyKey) ?? 100;
        logicalReplies.set(reply.idempotencyKey, persisted);
        if (!returnPersistedResponse) throw new Error("response lost after persistence");
        return { seq: persisted };
      },
      confirmDeliveryUpdate: async (update) => {
        fake.connection.send(update);
      },
      deliverySettleRetryDelayMs: 5,
      deliverySettleRetryMaxRounds: 1,
      deliverySettleRetryCooldownMs: 5,
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    const delivery = deliveryFrame(9, "retry me", { id: "delivery-9" }) as ServerFrame;
    await bridge.handleFrame(delivery);
    await bridge.handleFrame(delivery);
    expect(notifications).toBe(1);
    await expect(bridge.reply(9, "first")).rejects.toThrow("response lost after persistence");
    expect(bridge.pendingCount).toBe(1);
    await waitFor(() => attempts >= 3, "cooldown REST reconciliation did not continue");
    returnPersistedResponse = true;
    await waitFor(() => bridge.pendingCount === 0, "REST reply did not settle after response recovery");
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(new Set(keys)).toEqual(new Set(["claude-channel-reply:delivery-9"]));
    expect(logicalReplies.size).toBe(1);
    expect(notifications).toBe(1);
    bridge.close();
  });

  test("directed mode suppresses duplicate plain @ frames; legacy mode keeps a bounded fallback", async () => {
    const directed = fakeConnection();
    let directedNotifications = 0;
    const directedBridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: directed.connection,
      notify: async () => {
        directedNotifications += 1;
      },
      postReply: async () => ({ seq: 1 }),
      confirmDeliveryUpdate: async (update) => {
        directed.connection.send(update);
      },
      out: () => {},
    });
    await directedBridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await directedBridge.handleFrame(msgFrame(1, "plain duplicate", { mentions: ["me"] }) as ServerFrame);
    expect(directedNotifications).toBe(0);
    expect(directed.acked).toEqual([1]);

    const legacy = fakeConnection();
    let legacyNotifications = 0;
    const legacyBridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: legacy.connection,
      notify: async () => {
        legacyNotifications += 1;
      },
      postReply: async () => ({ seq: 2 }),
      out: () => {},
    });
    await legacyBridge.handleFrame(welcomeFrame(0, "me") as ServerFrame);
    const plain = msgFrame(1, "legacy wake", { mentions: ["me"] }) as ServerFrame;
    await legacyBridge.handleFrame(plain);
    await legacyBridge.handleFrame(plain);
    expect(legacyNotifications).toBe(1);
    expect(legacy.acked).toEqual([1]);
  });

  test("concurrent reply tool calls cannot persist two linked replies", async () => {
    const fake = fakeConnection();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: fake.connection,
      notify: async () => {},
      postReply: async () => {
        posts += 1;
        await gate;
        return { seq: 42 };
      },
      confirmDeliveryUpdate: async (update) => {
        fake.connection.send(update);
      },
      out: () => {},
    });
    await bridge.handleFrame(welcomeDirectedFrame(0, "me") as ServerFrame);
    await bridge.handleFrame(deliveryFrame(10, "reply once", { id: "delivery-10" }) as ServerFrame);

    const first = bridge.reply(10, "first");
    await Promise.resolve();
    await expect(bridge.reply(10, "second")).rejects.toThrow("reply already in progress");
    release();
    await first;
    expect(posts).toBe(1);
  });
});
