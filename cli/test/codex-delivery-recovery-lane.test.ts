import { expect, test } from "bun:test";
import type { ClientFrame, ServerFrame } from "@agentparty/shared";
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

class LaneRpcPeer implements CodexRpcPeer {
  readonly initializeResult = {};
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  startCalls = 0;
  steerBlock: Promise<void> | null = null;
  onSteer: (() => void) | null = null;
  private readonly messages = new Set<
    (message: JsonRpcRequest | JsonRpcNotification) => void | Promise<void>
  >();
  connectionGeneration = 1;

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      return {
        thread: {
          id: "thread-lane",
          status: { type: "idle" },
          turns: [],
        },
      };
    }
    if (method === "turn/start") {
      return {
        turn: {
          id: "turn-lane",
          status: "inProgress",
          items: [{
            type: "userMessage",
            clientId: (params as { clientUserMessageId: string }).clientUserMessageId,
          }],
        },
      };
    }
    if (method === "turn/steer") {
      this.onSteer?.();
      await this.steerBlock;
      return {
        turnId: (params as { expectedTurnId: string }).expectedTurnId,
      };
    }
    if (method === "review/start") return {};
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
  onReconnect(_listener: (generation: number) => void | Promise<void>): () => void {
    return () => {};
  }

  async emit(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    await Promise.all([...this.messages].map((listener) => listener(message)));
  }
}

function streamingConnection() {
  let cursor = 0;
  const sent: ClientFrame[] = [];
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

test("reconnect fences an in-flight pre-harness claim and replays only after recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "ap-codex-recovery-lane-"));
  try {
    const rpc = new LaneRpcPeer();
    const session = new CodexSessionController(rpc);
    await session.request("thread/start", { cwd: root });

    const stream = streamingConnection();
    const journal = new DeliveryRecoveryJournal(
      join(root, "recovery.json"),
      "dev",
      "codex",
    );
    let releaseRunning!: () => void;
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    let runningStarted!: () => void;
    const enteredRunning = new Promise<void>((resolve) => {
      runningStarted = resolve;
    });
    let firstRunning = true;
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: stream.connection,
      session,
      recoveryJournal: journal,
      requireDeliveryRecovery: true,
      leaseRenewIntervalMs: 60_000,
      postReply: async () => ({ seq: 1 }),
      confirmDeliveryUpdate: async (update) => {
        if (update.state === "running" && firstRunning) {
          firstRunning = false;
          runningStarted();
          await runningGate;
        }
        return update.state;
      },
      log: () => {},
    });
    const run = bridge.run();
    stream.push(welcomeDirectedFrame(0, "me") as ServerFrame);
    await waitFor(
      () => stream.sent.some((frame) => frame.type === "delivery_adapter"),
      "initial watch registration was not sent",
    );

    stream.push(deliveryFrame(41, "write exactly once", {
      id: "delivery-recovery-lane",
      target_name: "me",
    }) as ServerFrame);
    await enteredRunning;
    expect(journal.get("delivery-recovery-lane")).toMatchObject({ phase: "claimed" });

    // The welcome synchronously invalidates the old generation, then queues
    // recovery behind the delivery whose running acknowledgement is still in
    // flight. Releasing that stale ACK must not cross the app-server boundary.
    stream.push(welcomeDirectedFrame(41, "me") as ServerFrame);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stream.sent.some((frame) => frame.type === "delivery_recover")).toBe(false);

    releaseRunning();
    await waitFor(
      () => stream.sent.some((frame) => frame.type === "delivery_recover"),
      "recovery did not run after the prior writer lane settled",
    );
    const recovery = stream.sent.find(
      (frame): frame is Extract<ClientFrame, { type: "delivery_recover" }> =>
        frame.type === "delivery_recover",
    )!;
    expect(recovery.replay_safe).toBe(true);
    expect(journal.get("delivery-recovery-lane")).toMatchObject({
      phase: "claimed",
      threadId: "thread-lane",
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

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
    await waitFor(
      () => journal.get("delivery-recovery-lane")?.phase === "harness_accepted",
      "recovered delivery was not written exactly once",
    );
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);

    bridge.close();
    expect(await run).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transport disconnect fences an autonomously flushed queue until token recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "ap-codex-disconnect-lane-"));
  try {
    const rpc = new LaneRpcPeer();
    const session = new CodexSessionController(rpc);
    await session.request("thread/start", { cwd: root });
    const stream = streamingConnection();
    const journal = new DeliveryRecoveryJournal(
      join(root, "recovery.json"),
      "dev",
      "codex",
    );
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: stream.connection,
      session,
      recoveryJournal: journal,
      requireDeliveryRecovery: true,
      leaseRenewIntervalMs: 60_000,
      retryDelayMs: 5,
      postReply: async () => ({ seq: 1 }),
      confirmDeliveryUpdate: async (update) => update.state,
      log: () => {},
    });
    const run = bridge.run();
    stream.push(welcomeDirectedFrame(0, "me") as ServerFrame);
    await waitFor(
      () => stream.sent.some((frame) => frame.type === "delivery_adapter"),
      "initial watch registration was not sent",
    );

    await session.request("review/start", {
      threadId: "thread-lane",
      delivery: "inline",
    });
    await rpc.emit({
      method: "turn/started",
      params: {
        threadId: "thread-lane",
        turn: { id: "review-turn", status: "inProgress", items: [] },
      },
    });
    stream.push(deliveryFrame(51, "must wait for recovered ownership", {
      id: "delivery-disconnect-lane",
      target_name: "me",
    }) as ServerFrame);
    await waitFor(
      () => journal.get("delivery-disconnect-lane")?.phase === "running_authorized",
      "delivery did not reach the replay-safe local queue",
    );

    bridge.handleConnectionStatus("reconnecting");
    await rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-lane",
        turn: { id: "review-turn", status: "completed", items: [] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
    expect(journal.get("delivery-disconnect-lane")).toMatchObject({
      phase: "running_authorized",
      threadId: "thread-lane",
    });

    stream.push(welcomeDirectedFrame(51, "me") as ServerFrame);
    await waitFor(
      () => stream.sent.some((frame) =>
        frame.type === "delivery_recover" &&
        frame.delivery_id === "delivery-disconnect-lane"
      ),
      "disconnect recovery was not requested",
    );
    const recovery = stream.sent.find((frame) =>
      frame.type === "delivery_recover" &&
      frame.delivery_id === "delivery-disconnect-lane"
    ) as Extract<ClientFrame, { type: "delivery_recover" }>;
    expect(recovery.replay_safe).toBe(true);
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

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
    } as ServerFrame);
    await waitFor(
      () => rpc.calls.filter((call) => call.method === "turn/start").length === 1,
      "recovered queued delivery did not flush exactly once",
    );
    expect(journal.get("delivery-disconnect-lane")).toMatchObject({
      phase: "harness_accepted",
      threadId: "thread-lane",
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);

    bridge.close();
    expect(await run).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final synchronous authorization check closes the WAL-to-transport microtask gap", async () => {
  const root = mkdtempSync(join(tmpdir(), "ap-codex-final-fence-"));
  try {
    const rpc = new LaneRpcPeer();
    const session = new CodexSessionController(rpc);
    await session.request("thread/start", { cwd: root });
    const stream = streamingConnection();
    const journal = new DeliveryRecoveryJournal(
      join(root, "recovery.json"),
      "dev",
      "codex",
    );
    let bridge!: CodexAgentPartyBridge;
    let disconnectAtHarnessWal = true;
    const update = journal.update.bind(journal);
    journal.update = ((deliveryId, patch) => {
      const result = update(deliveryId, patch);
      if (patch.phase === "harness_issued" && disconnectAtHarnessWal) {
        disconnectAtHarnessWal = false;
        queueMicrotask(() => bridge.handleConnectionStatus("reconnecting"));
      }
      return result;
    }) as typeof journal.update;

    bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: stream.connection,
      session,
      recoveryJournal: journal,
      requireDeliveryRecovery: true,
      leaseRenewIntervalMs: 60_000,
      postReply: async () => ({ seq: 1 }),
      confirmDeliveryUpdate: async (updateFrame) => updateFrame.state,
      log: () => {},
    });
    const run = bridge.run();
    stream.push(welcomeDirectedFrame(0, "me") as ServerFrame);
    await waitFor(
      () => stream.sent.some((frame) => frame.type === "delivery_adapter"),
      "initial watch registration was not sent",
    );
    stream.push(deliveryFrame(61, "disconnect after WAL, before transport", {
      id: "delivery-final-fence",
      target_name: "me",
    }) as ServerFrame);
    await waitFor(
      () => journal.get("delivery-final-fence")?.phase === "running_authorized",
      "pre-transport generation failure did not roll the WAL back",
    );
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

    stream.push(welcomeDirectedFrame(61, "me") as ServerFrame);
    await waitFor(
      () => stream.sent.some((frame) =>
        frame.type === "delivery_recover" &&
        frame.delivery_id === "delivery-final-fence"
      ),
      "rolled-back delivery did not request recovery",
    );
    const recovery = stream.sent.find((frame) =>
      frame.type === "delivery_recover" &&
      frame.delivery_id === "delivery-final-fence"
    ) as Extract<ClientFrame, { type: "delivery_recover" }>;
    expect(recovery.replay_safe).toBe(true);
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
    } as ServerFrame);
    await waitFor(
      () => rpc.calls.filter((call) => call.method === "turn/start").length === 1,
      "recovered delivery did not cross the transport exactly once",
    );
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(journal.get("delivery-final-fence")?.phase).toBe("harness_accepted");

    bridge.close();
    expect(await run).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive writer rechecks recovery readiness after waiting for the arbiter lane", async () => {
  const root = mkdtempSync(join(tmpdir(), "ap-codex-tui-recovery-fence-"));
  try {
    const rpc = new LaneRpcPeer();
    const session = new CodexSessionController(rpc);
    await session.request("thread/start", { cwd: root });
    const stream = streamingConnection();
    const journal = new DeliveryRecoveryJournal(
      join(root, "recovery.json"),
      "dev",
      "codex",
    );
    const bridge = new CodexAgentPartyBridge({
      channel: "dev",
      connection: stream.connection,
      session,
      recoveryJournal: journal,
      requireDeliveryRecovery: true,
      leaseRenewIntervalMs: 60_000,
      postReply: async () => ({ seq: 1 }),
      confirmDeliveryUpdate: async (update) => update.state,
      log: () => {},
    });
    const run = bridge.run();
    stream.push(welcomeDirectedFrame(0, "me") as ServerFrame);
    await waitFor(
      () => stream.sent.some((frame) => frame.type === "delivery_adapter"),
      "initial watch registration was not sent",
    );
    stream.push(deliveryFrame(71, "keep a durable delivery obligation", {
      id: "delivery-tui-fence",
      target_name: "me",
    }) as ServerFrame);
    await waitFor(
      () => journal.get("delivery-tui-fence")?.phase === "harness_accepted",
      "AgentParty delivery did not establish the active turn",
    );

    let releaseFirstSteer!: () => void;
    rpc.steerBlock = new Promise<void>((resolve) => {
      releaseFirstSteer = resolve;
    });
    let firstSteerEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      firstSteerEntered = resolve;
    });
    rpc.onSteer = firstSteerEntered;
    const firstSteer = session.request("turn/steer", {
      threadId: "thread-lane",
      expectedTurnId: "turn-lane",
      input: [{ type: "text", text: "first TUI steer", text_elements: [] }],
    });
    await firstEntered;

    const readinessCallsBeforeSecond = rpc.startCalls;
    const secondSteer = session.request("turn/steer", {
      threadId: "thread-lane",
      expectedTurnId: "turn-lane",
      input: [{ type: "text", text: "second TUI steer", text_elements: [] }],
    });
    await waitFor(
      () => rpc.startCalls > readinessCallsBeforeSecond,
      "second mutation did not pass the outer readiness check",
    );
    bridge.handleConnectionStatus("reconnecting");
    rpc.steerBlock = null;
    rpc.onSteer = null;
    releaseFirstSteer();
    await firstSteer;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rpc.calls.filter((call) => call.method === "turn/steer")).toHaveLength(1);

    stream.push(welcomeDirectedFrame(71, "me") as ServerFrame);
    await waitFor(
      () => stream.sent.some((frame) =>
        frame.type === "delivery_recover" &&
        frame.delivery_id === "delivery-tui-fence"
      ),
      "TUI fence did not request durable delivery recovery",
    );
    const recovery = stream.sent.find((frame) =>
      frame.type === "delivery_recover" &&
      frame.delivery_id === "delivery-tui-fence"
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
    } as ServerFrame);
    await secondSteer;
    expect(rpc.calls.filter((call) => call.method === "turn/steer")).toHaveLength(2);

    bridge.close();
    expect(await run).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
