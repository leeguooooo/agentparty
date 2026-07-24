import { describe, expect, test } from "bun:test";
import {
  CodexBridgeQueueFullError,
  CodexInteractiveMutationBlockedError,
  CodexRetryableBeforeWriteError,
  CodexTurnArbiter,
  nonSteerableTurnKind,
  type CodexDispatch,
  type CodexTurnStartParams,
  type CodexTurnSteerParams,
  type CodexTurnTransport,
} from "../src/codex-turn-arbiter";

function input(id: string, text = id) {
  return {
    text,
    clientUserMessageId: `agentparty:${id}`,
    metadata: { delivery_id: id },
  };
}

function transport(over: Partial<CodexTurnTransport> = {}) {
  const starts: CodexTurnStartParams[] = [];
  const steers: CodexTurnSteerParams[] = [];
  let next = 1;
  const value: CodexTurnTransport = {
    async turnStart(params) {
      starts.push(params);
      return { turn: { id: `turn-${next++}` } };
    },
    async turnSteer(params) {
      steers.push(params);
      return { turnId: params.expectedTurnId };
    },
    ...over,
  };
  return { value, starts, steers };
}

function rpcError(data?: unknown): Error & { code: number; data?: unknown } {
  return Object.assign(new Error("app-server rejected request"), {
    code: -32_000,
    ...(data === undefined ? {} : { data }),
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Codex app-server single-writer arbiter", () => {
  test("idle uses turn/start with exact app-server input shape", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({ thread: { status: { type: "idle" }, turns: [] } });

    const result = await arbiter.submit(input("delivery-1", "hello"));
    expect(result).toEqual({ kind: "started", turnId: "turn-1" });
    expect(mock.starts).toEqual([{
      threadId: "thread-1",
      clientUserMessageId: "agentparty:delivery-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      responsesapiClientMetadata: { delivery_id: "delivery-1" },
    }]);
    expect(mock.steers).toHaveLength(0);
  });

  test("running turn always uses turn/steer with expectedTurnId, never turn/start", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [{ id: "active-7", status: "inProgress", items: [] }],
      },
    });

    const result = await arbiter.submit(input("delivery-2", "new channel input"));
    expect(result).toEqual({ kind: "steered", turnId: "active-7" });
    expect(mock.starts).toHaveLength(0);
    expect(mock.steers).toEqual([{
      threadId: "thread-1",
      clientUserMessageId: "agentparty:delivery-2",
      input: [{ type: "text", text: "new channel input", text_elements: [] }],
      responsesapiClientMetadata: { delivery_id: "delivery-2" },
      expectedTurnId: "active-7",
    }]);
  });

  test("two simultaneous idle writers serialize to one start followed by steer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: CodexTurnStartParams[] = [];
    const steers: CodexTurnSteerParams[] = [];
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart(params) {
        starts.push(params);
        await gate;
        return { turn: { id: "turn-race" } };
      },
      async turnSteer(params) {
        steers.push(params);
        return { turnId: params.expectedTurnId };
      },
    });
    await arbiter.observeThreadIdle();

    const first = arbiter.submit(input("race-1"));
    const second = arbiter.submit(input("race-2"));
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(starts).toHaveLength(1);
    expect(steers).toHaveLength(1);
    expect(steers[0]!.expectedTurnId).toBe("turn-race");
  });

  test("a definitive idle start rejection retries automatically and succeeds once", async () => {
    let attempts = 0;
    let rejectedWrites = 0;
    const mock = transport({
      async turnStart(params) {
        attempts += 1;
        if (attempts === 1) throw rpcError();
        return { turn: { id: `retry-${params.clientUserMessageId}` } };
      },
    });
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeThreadIdle();

    expect(await arbiter.submit({
      ...input("start-retry"),
      onWriteRejected: () => {
        rejectedWrites += 1;
      },
    })).toMatchObject({ kind: "queued", reason: "start_rejected" });
    expect(arbiter.snapshot()).toMatchObject({
      phase: { type: "idle" },
      queueDepth: 1,
    });
    await waitFor(
      () => attempts === 2 && arbiter.snapshot().queueDepth === 0,
      "idle start rejection was never retried",
    );
    expect(rejectedWrites).toBe(1);
    expect(attempts).toBe(2);
    expect(arbiter.snapshot().phase.type).toBe("normal");
  });

  test("a queued WAL failure is restored and retried without losing or duplicating input", async () => {
    let walAttempts = 0;
    const queuedErrors: unknown[] = [];
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value, {
      onQueuedError: ({ error }) => {
        queuedErrors.push(error);
      },
    });
    await arbiter.enterUnsteerable("review", "review-wal");
    expect(await arbiter.submit({
      ...input("queued-wal"),
      beforeWrite: () => {
        walAttempts += 1;
        if (walAttempts === 1) {
          throw new CodexRetryableBeforeWriteError("journal ENOSPC");
        }
      },
    })).toMatchObject({ kind: "queued", reason: "review" });

    await arbiter.observeTurnCompleted("review-wal");
    expect(mock.starts).toHaveLength(0);
    expect(arbiter.snapshot().queueDepth).toBe(1);
    await waitFor(
      () => mock.starts.length === 1 && arbiter.snapshot().queueDepth === 0,
      "queued WAL failure was never retried",
    );
    expect(walAttempts).toBe(2);
    expect(queuedErrors).toHaveLength(1);
    expect(mock.starts[0]!.clientUserMessageId).toBe("agentparty:queued-wal");
  });

  test("cancelQueued revokes only a pre-write queue entry", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.enterUnsteerable("review", "review-cancel");
    expect(await arbiter.submit(input("cancel-me"))).toMatchObject({ kind: "queued" });
    expect(await arbiter.cancelQueued("agentparty:cancel-me")).toBe(true);
    expect(await arbiter.cancelQueued("agentparty:cancel-me")).toBe(false);
    await arbiter.observeTurnCompleted("review-cancel");
    expect(mock.starts).toHaveLength(0);
    expect(arbiter.snapshot().queueDepth).toBe(0);
  });

  test("rollback debt is durably retried before a rejected idle start is sent again", async () => {
    const events: string[] = [];
    let transportAttempts = 0;
    let rollbackAttempts = 0;
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart() {
        transportAttempts += 1;
        events.push(`transport-${transportAttempts}`);
        if (transportAttempts === 1) throw rpcError();
        return { turn: { id: "after-rollback" } };
      },
      async turnSteer() {
        throw new Error("must not steer");
      },
    });
    await arbiter.observeThreadIdle();
    expect(await arbiter.submit({
      ...input("rollback-idle"),
      beforeWrite: () => {
        events.push("before-write");
      },
      onWriteRejected: () => {
        rollbackAttempts += 1;
        events.push(`rollback-${rollbackAttempts}`);
        if (rollbackAttempts === 1) throw new Error("rollback WAL ENOSPC");
      },
    })).toMatchObject({ kind: "queued", reason: "start_rejected" });

    await waitFor(
      () => transportAttempts === 2 && arbiter.snapshot().queueDepth === 0,
      "rollback debt never recovered and retried the start",
    );
    expect(events).toEqual([
      "before-write",
      "transport-1",
      "rollback-1",
      "rollback-2",
      "before-write",
      "transport-2",
    ]);
  });

  test("rollback-only retry runs during review without sending a second transport", async () => {
    let rollbackAttempts = 0;
    let steerAttempts = 0;
    const starts: CodexTurnStartParams[] = [];
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart(params) {
        starts.push(params);
        return { turn: { id: "after-review-rollback" } };
      },
      async turnSteer() {
        steerAttempts += 1;
        throw rpcError({
          codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } },
        });
      },
    });
    await arbiter.observeTurnStarted("review-rejection");
    expect(await arbiter.submit({
      ...input("rollback-review"),
      onWriteRejected: () => {
        rollbackAttempts += 1;
        if (rollbackAttempts === 1) throw new Error("rollback WAL ENOSPC");
      },
    })).toMatchObject({ kind: "queued", reason: "review" });
    await waitFor(
      () => rollbackAttempts === 2,
      "rollback debt did not retry independently of the review phase",
    );
    expect(steerAttempts).toBe(1);
    expect(starts).toHaveLength(0);
    expect(arbiter.snapshot().queueDepth).toBe(1);

    await arbiter.observeTurnCompleted("review-rejection");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.clientUserMessageId).toBe("agentparty:rollback-review");
  });

  test("interactive writes cannot cross rollback debt that is still failing", async () => {
    let startAttempts = 0;
    let rollbackAttempts = 0;
    let tuiWrites = 0;
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart() {
        startAttempts += 1;
        if (startAttempts === 1) throw rpcError();
        return { turn: { id: "after-global-rollback-fence" } };
      },
      async turnSteer() {
        throw new Error("AgentParty steer was not expected");
      },
    });
    await arbiter.observeThreadIdle();
    expect(await arbiter.submit({
      ...input("global-rollback-fence"),
      onWriteRejected: () => {
        rollbackAttempts += 1;
        if (rollbackAttempts <= 2) throw new Error("rollback storage unavailable");
      },
    })).toMatchObject({ kind: "queued" });

    await expect(arbiter.runInteractiveMutation(
      "turn/steer",
      { threadId: "thread-1", expectedTurnId: "after-global-rollback-fence" },
      async () => {
        tuiWrites += 1;
        return { turnId: "after-global-rollback-fence" };
      },
    )).rejects.toBeInstanceOf(CodexRetryableBeforeWriteError);
    expect(tuiWrites).toBe(0);
    expect(startAttempts).toBe(1);

    await waitFor(
      () => startAttempts === 2 && arbiter.snapshot().phase.type === "normal",
      "rollback debt did not settle before the queued AgentParty retry",
    );
    await expect(arbiter.runInteractiveMutation(
      "turn/steer",
      { threadId: "thread-1", expectedTurnId: "after-global-rollback-fence" },
      async () => {
        tuiWrites += 1;
        return { turnId: "after-global-rollback-fence" };
      },
    )).resolves.toEqual({ turnId: "after-global-rollback-fence" });
    expect(rollbackAttempts).toBe(3);
    expect(tuiWrites).toBe(1);
  });

  test.each(["review", "compact"] as const)(
    "%s is non-steerable: AgentParty input is bounded-queued until completion",
    async (kind) => {
      const mock = transport();
      const dispatched: string[] = [];
      const arbiter = new CodexTurnArbiter("thread-1", mock.value, {
        maxQueue: 2,
        onQueuedDispatch: ({ input: queued }) => {
          dispatched.push(queued.clientUserMessageId);
        },
      });
      await arbiter.enterUnsteerable(kind, `${kind}-turn`);
      expect(await arbiter.submit(input(`${kind}-1`))).toMatchObject({
        kind: "queued",
        queuePosition: 1,
        reason: kind,
      });
      expect(await arbiter.submit(input(`${kind}-2`))).toMatchObject({
        kind: "queued",
        queuePosition: 2,
        reason: kind,
      });
      await expect(arbiter.submit(input(`${kind}-3`))).rejects.toBeInstanceOf(CodexBridgeQueueFullError);
      expect(mock.starts).toHaveLength(0);
      expect(mock.steers).toHaveLength(0);

      await arbiter.observeTurnCompleted(`${kind}-turn`);
      expect(mock.starts).toHaveLength(1);
      expect(mock.starts[0]!.clientUserMessageId).toBe(`agentparty:${kind}-1`);
      expect(dispatched).toEqual([`agentparty:${kind}-1`]);
      expect(arbiter.snapshot().queueDepth).toBe(1);
    },
  );

  test("structured activeTurnNotSteerable error changes phase and queues without blind start", async () => {
    const starts: CodexTurnStartParams[] = [];
    const steers: CodexTurnSteerParams[] = [];
    const error = rpcError({
      codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } },
    });
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart(params) {
        starts.push(params);
        return { turn: { id: "after-review" } };
      },
      async turnSteer(params) {
        steers.push(params);
        throw error;
      },
    });
    await arbiter.observeTurnStarted("review-turn");

    const result = await arbiter.submit(input("during-review"));
    expect(result).toMatchObject({ kind: "queued", reason: "review" });
    expect(nonSteerableTurnKind(error)).toBe("review");
    expect(starts).toHaveLength(0);
    expect(steers[0]!.expectedTurnId).toBe("review-turn");
    expect(arbiter.snapshot().phase).toEqual({ type: "review", turnId: "review-turn" });

    await arbiter.observeTurnCompleted("review-turn");
    expect(starts).toHaveLength(1);
  });

  test("stale expectedTurnId rejection resyncs and steers the queued input into the new turn", async () => {
    const steers: CodexTurnSteerParams[] = [];
    let calls = 0;
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart() {
        throw new Error("must not start");
      },
      async turnSteer(params) {
        steers.push(params);
        calls += 1;
        if (calls === 1) throw rpcError();
        return { turnId: params.expectedTurnId };
      },
    });
    await arbiter.observeTurnStarted("old-turn");
    expect(await arbiter.submit(input("stale"))).toMatchObject({
      kind: "queued",
      reason: "steer_rejected",
    });
    expect(arbiter.snapshot().phase.type).toBe("unknown");

    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [{ id: "new-turn", status: "inProgress", items: [] }],
      },
    });
    expect(steers.map((entry) => entry.expectedTurnId)).toEqual(["old-turn", "new-turn"]);
  });

  test("active status without an identifiable turn id fails closed and queues", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [],
      },
    });
    expect(await arbiter.submit(input("no-turn-id"))).toMatchObject({
      kind: "queued",
      reason: "unknown",
    });
    expect(mock.starts).toHaveLength(0);
    expect(mock.steers).toHaveLength(0);

    await arbiter.observeTurnStarted("recovered-turn");
    expect(mock.steers).toHaveLength(1);
    expect(mock.steers[0]!.expectedTurnId).toBe("recovered-turn");
  });

  test("a stray completed event cannot turn unknown state into an unsafe start", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({
      thread: { status: { type: "active" }, turns: [] },
    });
    await arbiter.submit(input("wait-for-authority"));

    await arbiter.observeTurnCompleted("some-old-turn");
    expect(mock.starts).toHaveLength(0);
    expect(arbiter.snapshot()).toMatchObject({
      phase: { type: "unknown" },
      queueDepth: 1,
    });

    await arbiter.observeThreadIdle();
    expect(mock.starts).toHaveLength(1);
  });

  test("lost response is uncertain: clientUserMessageId journal prevents duplicate start", async () => {
    let starts = 0;
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart() {
        starts += 1;
        // Simulates: app-server accepted the request, but the JSON-RPC response
        // was lost. A plain Error has no numeric JSON-RPC rejection code.
        throw new Error("socket closed after write");
      },
      async turnSteer() {
        throw new Error("not reached");
      },
    });
    await arbiter.observeThreadIdle();
    const delivery = input("unknown-outcome");

    expect(await arbiter.submit(delivery)).toEqual({
      kind: "uncertain",
      reason: "unknown_outcome",
    });
    expect(await arbiter.submit(delivery)).toEqual({
      kind: "uncertain",
      reason: "unknown_outcome",
    });
    expect(starts).toBe(1);

    // Authoritative resume/read finds ThreadItem.userMessage.clientId.
    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [{
          id: "accepted-turn",
          status: "inProgress",
          items: [{ type: "userMessage", clientId: "agentparty:unknown-outcome" }],
        }],
      },
    });
    expect(await arbiter.submit(delivery)).toEqual({ kind: "duplicate" });
    expect(starts).toBe(1);
    expect(arbiter.snapshot().uncertainCount).toBe(0);
  });

  test("interactive TUI start shares the writer lane and queued AgentParty input steers into it", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeThreadIdle();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tuiStart = arbiter.runInteractiveMutation(
      "turn/start",
      { threadId: "thread-1" },
      async () => {
        await gate;
        return { turn: { id: "tui-turn" } };
      },
    );
    const partyInput = arbiter.submit(input("during-tui-start"));
    await Promise.resolve();
    expect(mock.starts).toHaveLength(0);
    expect(mock.steers).toHaveLength(0);

    release();
    await expect(tuiStart).resolves.toEqual({ turn: { id: "tui-turn" } });
    await expect(partyInput).resolves.toEqual({ kind: "steered", turnId: "tui-turn" });
    expect(mock.starts).toHaveLength(0);
    expect(mock.steers[0]!.expectedTurnId).toBe("tui-turn");
  });

  test("an active-turn shell command blocks steering until its userShell item completes", async () => {
    const mock = transport();
    const queuedDispatches: CodexDispatch[] = [];
    const arbiter = new CodexTurnArbiter("thread-1", mock.value, {
      onQueuedDispatch: ({ dispatch }) => {
        queuedDispatches.push(dispatch);
      },
    });
    await arbiter.observeTurnStarted("active-turn");

    await expect(arbiter.runInteractiveMutation(
      "thread/shellCommand",
      { threadId: "thread-1", command: "git status --short" },
      async () => ({}),
    )).resolves.toEqual({});
    expect(arbiter.snapshot().phase).toEqual({ type: "shell", turnId: "active-turn" });
    expect(await arbiter.submit(input("after-active-shell"))).toMatchObject({
      kind: "queued",
      reason: "shell",
    });
    expect(mock.steers).toHaveLength(0);

    await arbiter.observeUserShellStarted("active-turn", "active-shell-item");
    await arbiter.observeUserShellCompleted("active-turn", "active-shell-item");
    expect(mock.steers).toHaveLength(1);
    expect(mock.steers[0]!.expectedTurnId).toBe("active-turn");
    expect(queuedDispatches).toEqual([{ kind: "steered", turnId: "active-turn" }]);
    expect(arbiter.snapshot().phase).toEqual({ type: "normal", turnId: "active-turn" });
  });

  test("a mismatched userShell item cannot release the exact shell lifecycle", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeTurnStarted("base-turn");
    await arbiter.runInteractiveMutation(
      "thread/shellCommand",
      { threadId: "thread-1", command: "pwd" },
      async () => ({}),
    );
    await arbiter.submit(input("waits-for-exact-item"));

    await arbiter.observeUserShellStarted("base-turn", "shell-item");
    await arbiter.observeUserShellCompleted("base-turn", "other-item");
    await arbiter.observeUserShellCompleted("other-turn", "shell-item");
    expect(mock.steers).toHaveLength(0);
    expect(arbiter.snapshot().phase.type).toBe("shell");

    await arbiter.observeUserShellCompleted("base-turn", "shell-item");
    expect(mock.steers).toHaveLength(1);
    expect(mock.steers[0]!.expectedTurnId).toBe("base-turn");
  });

  test("stale idle before a standalone shell starts cannot flush queued input", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeThreadIdle();
    await arbiter.runInteractiveMutation(
      "thread/shellCommand",
      { threadId: "thread-1", command: "pwd" },
      async () => ({}),
    );
    await arbiter.submit(input("after-standalone-shell"));

    await arbiter.observeThreadIdle();
    expect(mock.starts).toHaveLength(0);
    await arbiter.observeTurnStarted("standalone-shell-turn");
    await arbiter.observeUserShellStarted("standalone-shell-turn", "standalone-shell-item");
    await arbiter.observeTurnCompleted("standalone-shell-turn");
    expect(mock.starts).toHaveLength(0);
    await arbiter.observeUserShellCompleted("standalone-shell-turn", "standalone-shell-item");
    expect(mock.starts).toHaveLength(1);
    expect(mock.starts[0]!.clientUserMessageId).toBe(
      "agentparty:after-standalone-shell",
    );
  });

  test("after-write shell disconnect plus active resume stays fail-closed", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeTurnStarted("base-turn");
    await expect(arbiter.runInteractiveMutation(
      "thread/shellCommand",
      { threadId: "thread-1", command: "pwd" },
      async () => {
        throw new Error("backend disconnected after request write");
      },
    )).rejects.toThrow("after request write");
    expect(await arbiter.submit(input("must-not-steer-after-unknown-shell"))).toMatchObject({
      kind: "queued",
      reason: "shell",
    });

    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [{ id: "base-turn", status: "inProgress", items: [] }],
      },
    });
    expect(arbiter.snapshot().phase).toEqual({ type: "shell", turnId: "base-turn" });
    expect(mock.starts).toHaveLength(0);
    expect(mock.steers).toHaveLength(0);
  });

  test("auxiliary shell handles base completion before or after exact item completion", async () => {
    for (const baseCompletesFirst of [true, false]) {
      const mock = transport();
      const arbiter = new CodexTurnArbiter("thread-1", mock.value);
      await arbiter.observeTurnStarted("base-turn");
      await arbiter.runInteractiveMutation(
        "thread/shellCommand",
        { threadId: "thread-1", command: "pwd" },
        async () => ({}),
      );
      await arbiter.submit(input(`ordered-${baseCompletesFirst}`));
      await arbiter.observeUserShellStarted("base-turn", "shell-item");

      if (baseCompletesFirst) {
        await arbiter.observeTurnCompleted("base-turn");
        expect(mock.starts).toHaveLength(0);
        expect(mock.steers).toHaveLength(0);
        await arbiter.observeUserShellCompleted("base-turn", "shell-item");
        expect(mock.starts).toHaveLength(1);
      } else {
        await arbiter.observeUserShellCompleted("base-turn", "shell-item");
        expect(mock.steers).toHaveLength(1);
        expect(mock.steers[0]!.expectedTurnId).toBe("base-turn");
        await arbiter.observeTurnCompleted("base-turn");
      }
    }
  });

  test("proven-not-written shell request restores the prior steerable phase", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeTurnStarted("base-turn");
    await expect(arbiter.runInteractiveMutation(
      "thread/shellCommand",
      { threadId: "thread-1", command: "pwd" },
      async () => {
        throw Object.assign(new Error("disconnected before write"), {
          codexBridgeRequestWritten: false,
        });
      },
    )).rejects.toThrow("before write");
    expect(arbiter.snapshot().phase).toEqual({ type: "normal", turnId: "base-turn" });

    expect(await arbiter.submit(input("safe-after-no-write"))).toEqual({
      kind: "steered",
      turnId: "base-turn",
    });
  });

  test.each(["review", "compact"] as const)(
    "user shell is auxiliary to an active %s phase and restores it exactly",
    async (kind) => {
      const mock = transport();
      const arbiter = new CodexTurnArbiter("thread-1", mock.value);
      await arbiter.enterUnsteerable(kind, `${kind}-turn`);
      await arbiter.runInteractiveMutation(
        "thread/shellCommand",
        { threadId: "thread-1", command: "pwd" },
        async () => ({}),
      );
      await arbiter.submit(input(`during-${kind}-shell`));
      await arbiter.observeUserShellStarted(`${kind}-turn`, `${kind}-shell-item`);
      await arbiter.observeUserShellCompleted(`${kind}-turn`, `${kind}-shell-item`);

      expect(arbiter.snapshot()).toMatchObject({
        phase: { type: kind, turnId: `${kind}-turn` },
        queueDepth: 1,
      });
      expect(mock.starts).toHaveLength(0);
      expect(mock.steers).toHaveLength(0);
      await arbiter.observeTurnCompleted(`${kind}-turn`);
      expect(mock.starts).toHaveLength(1);
    },
  );

  test("resume rehydrates an exact in-progress shell item and later completion releases it", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({
      thread: {
        status: { type: "idle" },
        turns: [{
          id: "historical-turn",
          status: "completed",
          items: [{
            type: "commandExecution",
            id: "historical-shell-item",
            source: "userShell",
            status: "completed",
          }],
        }],
      },
    });
    await arbiter.runInteractiveMutation(
      "thread/shellCommand",
      { threadId: "thread-1", command: "pwd" },
      async () => ({}),
    );
    await arbiter.submit(input("after-rehydrated-shell"));

    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [
          {
            id: "historical-turn",
            status: "completed",
            items: [{
              type: "commandExecution",
              id: "historical-shell-item",
              source: "userShell",
              status: "completed",
            }],
          },
          {
            id: "live-shell-turn",
            status: "inProgress",
            items: [{
              type: "commandExecution",
              id: "live-shell-item",
              source: "userShell",
              status: "inProgress",
            }],
          },
        ],
      },
    });
    expect(arbiter.snapshot().phase).toEqual({ type: "shell", turnId: "live-shell-turn" });
    await arbiter.observeUserShellCompleted("live-shell-turn", "historical-shell-item");
    expect(mock.starts).toHaveLength(0);
    await arbiter.observeUserShellCompleted("live-shell-turn", "live-shell-item");
    expect(mock.starts).toHaveLength(0);
    await arbiter.observeTurnCompleted("live-shell-turn");
    expect(mock.starts).toHaveLength(1);
  });

  test("resume rehydrates a fully completed shell without matching prior history", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    const priorItem = {
      type: "commandExecution",
      id: "prior-shell-item",
      source: "userShell",
      status: "completed",
    };
    await arbiter.observeResume({
      thread: {
        status: { type: "idle" },
        turns: [{ id: "prior-turn", status: "completed", items: [priorItem] }],
      },
    });
    await arbiter.runInteractiveMutation(
      "thread/shellCommand",
      { threadId: "thread-1", command: "pwd" },
      async () => ({}),
    );
    await arbiter.submit(input("after-completed-recovery"));

    // Returning only the pre-request item is not evidence that this request
    // completed and must retain the shell fence.
    await arbiter.observeResume({
      thread: {
        status: { type: "idle" },
        turns: [{ id: "prior-turn", status: "completed", items: [priorItem] }],
      },
    });
    expect(mock.starts).toHaveLength(0);
    expect(arbiter.snapshot().phase.type).toBe("shell");

    await arbiter.observeResume({
      thread: {
        status: { type: "idle" },
        turns: [
          { id: "prior-turn", status: "completed", items: [priorItem] },
          {
            id: "completed-shell-turn",
            status: "completed",
            items: [{
              type: "commandExecution",
              id: "completed-shell-item",
              source: "userShell",
              status: "completed",
            }],
          },
        ],
      },
    });
    expect(mock.starts).toHaveLength(1);
    expect(mock.starts[0]!.clientUserMessageId).toBe(
      "agentparty:after-completed-recovery",
    );
  });

  test("backend-crash recovery aborts a lossy interrupted shell without replaying it", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeThreadIdle();
    await arbiter.runInteractiveMutation(
      "thread/shellCommand",
      { threadId: "thread-1", command: "python -c 'import time; time.sleep(30)'" },
      async () => ({}),
    );
    await arbiter.observeTurnStarted("lossy-shell-turn");
    await arbiter.observeUserShellStarted("lossy-shell-turn", "lossy-shell-item");
    await arbiter.submit(input("after-lossy-shell-crash"));

    const interrupted = {
      thread: {
        status: { type: "idle" as const },
        turns: [{
          id: "lossy-shell-turn",
          status: "interrupted" as const,
          // Codex 0.144.4 reports itemsView=full but drops the
          // commandExecution item after the backend process dies.
          items: [],
        }],
      },
    };
    await arbiter.observeResume(interrupted);
    expect(arbiter.snapshot().phase.type).toBe("shell");
    expect(mock.starts).toHaveLength(0);

    await arbiter.observeResume(interrupted, { backendRestarted: true });
    expect(mock.starts).toHaveLength(1);
    expect(mock.starts[0]!.clientUserMessageId).toBe(
      "agentparty:after-lossy-shell-crash",
    );
  });

  test("cold resume recognizes an active standalone user shell and never steers into it", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [{
          id: "cold-standalone-shell-turn",
          status: "inProgress",
          items: [{
            type: "commandExecution",
            id: "cold-standalone-shell-item",
            source: "userShell",
            status: "inProgress",
          }],
        }],
      },
    });
    expect(arbiter.snapshot().phase).toEqual({
      type: "shell",
      turnId: "cold-standalone-shell-turn",
    });
    expect(await arbiter.submit(input("cold-standalone-waiter"))).toMatchObject({
      kind: "queued",
      reason: "shell",
    });
    expect(mock.steers).toHaveLength(0);

    await arbiter.observeUserShellCompleted(
      "cold-standalone-shell-turn",
      "cold-standalone-shell-item",
    );
    expect(mock.starts).toHaveLength(0);
    await arbiter.observeTurnCompleted("cold-standalone-shell-turn");
    expect(mock.starts).toHaveLength(1);
  });

  test("cold resume recognizes an auxiliary user shell and restores its model turn", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [{
          id: "cold-model-turn",
          status: "inProgress",
          items: [
            { type: "userMessage", id: "user-1", clientId: null },
            {
              type: "commandExecution",
              id: "cold-aux-shell-item",
              source: "userShell",
              status: "inProgress",
            },
          ],
        }],
      },
    });
    expect(arbiter.snapshot().phase).toEqual({ type: "shell", turnId: "cold-model-turn" });
    expect(await arbiter.submit(input("cold-aux-waiter"))).toMatchObject({
      kind: "queued",
      reason: "shell",
    });
    expect(mock.steers).toHaveLength(0);

    await arbiter.observeUserShellCompleted("cold-model-turn", "cold-aux-shell-item");
    expect(mock.steers).toHaveLength(1);
    expect(mock.steers[0]!.expectedTurnId).toBe("cold-model-turn");
  });

  test("cold resume ignores completed shell history and fences the one current shell item", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [
          {
            id: "old-shell-turn",
            status: "completed",
            items: [{
              type: "commandExecution",
              id: "old-turn-shell-item",
              source: "userShell",
              status: "completed",
            }],
          },
          {
            id: "long-model-turn",
            status: "inProgress",
            items: [
              { type: "userMessage", id: "user-1", clientId: null },
              {
                type: "commandExecution",
                id: "old-aux-shell-item",
                source: "userShell",
                status: "completed",
              },
              {
                type: "commandExecution",
                id: "current-aux-shell-item",
                source: "userShell",
                status: "inProgress",
              },
            ],
          },
        ],
      },
    });
    expect(arbiter.snapshot().phase).toEqual({ type: "shell", turnId: "long-model-turn" });
    expect(await arbiter.submit(input("wait-current-aux-shell"))).toMatchObject({
      kind: "queued",
      reason: "shell",
    });
    expect(mock.steers).toHaveLength(0);

    await arbiter.observeUserShellCompleted("long-model-turn", "old-aux-shell-item");
    expect(mock.steers).toHaveLength(0);
    await arbiter.observeUserShellCompleted("long-model-turn", "current-aux-shell-item");
    expect(mock.steers).toHaveLength(1);
  });

  test("completed user shell in an old turn does not fence a current ordinary model turn", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [
          {
            id: "old-shell-turn",
            status: "completed",
            items: [{
              type: "commandExecution",
              id: "old-shell-item",
              source: "userShell",
              status: "completed",
            }],
          },
          {
            id: "current-model-turn",
            status: "inProgress",
            items: [{ type: "userMessage", id: "current-user", clientId: null }],
          },
        ],
      },
    });
    expect(arbiter.snapshot().phase).toEqual({
      type: "normal",
      turnId: "current-model-turn",
    });
    expect(await arbiter.submit(input("steer-current-model"))).toEqual({
      kind: "steered",
      turnId: "current-model-turn",
    });
  });

  test.each([
    {
      kind: "review" as const,
      items: [{ type: "enteredReviewMode", id: "entered-review" }],
    },
    {
      kind: "compact" as const,
      items: [{ type: "contextCompaction", id: "compaction" }],
    },
  ])("cold resume recognizes an active $kind turn as non-steerable", async ({ kind, items }) => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeResume({
      thread: {
        status: { type: "active" },
        turns: [{
          id: `cold-${kind}-turn`,
          status: "inProgress",
          items: [...items],
        }],
      },
    });
    expect(arbiter.snapshot().phase).toEqual({
      type: kind,
      turnId: `cold-${kind}-turn`,
    });
    expect(await arbiter.submit(input(`cold-${kind}-waiter`))).toMatchObject({
      kind: "queued",
      reason: kind,
    });
    expect(mock.starts).toHaveLength(0);
    expect(mock.steers).toHaveLength(0);
  });

  test("interactive TUI turn/start fails closed unless the authoritative phase is idle", async () => {
    const cases: Array<{
      expectedPhase: "normal" | "review" | "compact" | "unknown";
      prepare: (arbiter: CodexTurnArbiter) => Promise<void>;
    }> = [
      {
        expectedPhase: "normal",
        prepare: async (arbiter) => await arbiter.observeTurnStarted("normal-turn"),
      },
      {
        expectedPhase: "review",
        prepare: async (arbiter) => await arbiter.enterUnsteerable("review", "review-turn"),
      },
      {
        expectedPhase: "compact",
        prepare: async (arbiter) => await arbiter.enterUnsteerable("compact", "compact-turn"),
      },
      {
        expectedPhase: "unknown",
        prepare: async () => {},
      },
    ];

    for (const scenario of cases) {
      const mock = transport();
      const arbiter = new CodexTurnArbiter("thread-1", mock.value);
      await scenario.prepare(arbiter);
      let operationCalls = 0;
      let thrown: unknown;
      try {
        await arbiter.runInteractiveMutation(
          "turn/start",
          { threadId: "thread-1" },
          async () => {
            operationCalls += 1;
            return { turn: { id: "must-not-start" } };
          },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CodexInteractiveMutationBlockedError);
      expect(thrown).toMatchObject({
        code: -32_000,
        data: {
          codexBridgeInfo: {
            type: "interactiveMutationBlocked",
            method: "turn/start",
            reason: "phase_not_idle",
            phase: { type: scenario.expectedPhase },
            uncertainCount: 0,
          },
        },
      });
      expect(operationCalls).toBe(0);
      expect(arbiter.snapshot().phase.type).toBe(scenario.expectedPhase);
    }
  });

  test("one uncertain journal entry freezes all interactive mutations and queue flushes", async () => {
    const starts: CodexTurnStartParams[] = [];
    const steers: CodexTurnSteerParams[] = [];
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart(params) {
        starts.push(params);
        if (params.clientUserMessageId === "agentparty:uncertain-first") {
          throw new Error("stdio proxy disconnected after write");
        }
        return { turn: { id: "reconciled-turn" } };
      },
      async turnSteer(params) {
        steers.push(params);
        return { turnId: params.expectedTurnId };
      },
    }, { maxQueue: 1 });
    await arbiter.observeThreadIdle();

    expect(await arbiter.submit(input("uncertain-first"))).toEqual({
      kind: "uncertain",
      reason: "unknown_outcome",
    });
    await arbiter.observeThreadIdle();
    expect(await arbiter.submit(input("queued-behind-uncertain"))).toMatchObject({
      kind: "queued",
      queuePosition: 1,
      reason: "unknown_outcome",
    });
    await expect(arbiter.submit(input("bounded-overflow"))).rejects.toBeInstanceOf(
      CodexBridgeQueueFullError,
    );

    let interactiveCalls = 0;
    for (
      const method of [
        "turn/start",
        "turn/steer",
        "turn/interrupt",
        "review/start",
        "thread/compact/start",
        "thread/shellCommand",
      ] as const
    ) {
      await expect(arbiter.runInteractiveMutation(
        method,
        {
          threadId: "thread-1",
          ...(method === "turn/steer" ? { expectedTurnId: "possibly-running" } : {}),
          ...(method === "review/start" ? { delivery: "detached" } : {}),
        },
        async () => {
          interactiveCalls += 1;
          return { turn: { id: "must-not-run" } };
        },
      )).rejects.toMatchObject({
        data: {
          codexBridgeInfo: {
            method,
            reason: "uncertain_outcome",
            uncertainCount: 1,
          },
        },
      });
    }
    expect(interactiveCalls).toBe(0);
    expect(starts).toHaveLength(1);
    expect(steers).toHaveLength(0);

    // Only positive clientId evidence clears the uncertainty. The idle phase
    // observed while frozen then becomes eligible to flush the bounded queue.
    await arbiter.observeResume({
      thread: {
        status: { type: "idle" },
        turns: [{
          id: "accepted-earlier",
          status: "completed",
          items: [{ type: "userMessage", clientId: "agentparty:uncertain-first" }],
        }],
      },
    });
    expect(starts.map((entry) => entry.clientUserMessageId)).toEqual([
      "agentparty:uncertain-first",
      "agentparty:queued-behind-uncertain",
    ]);
    expect(arbiter.snapshot()).toMatchObject({
      phase: { type: "normal", turnId: "reconciled-turn" },
      queueDepth: 0,
      uncertainCount: 0,
    });
  });

  test("explicit unknown-outcome resolution unfreezes the current authoritative phase", async () => {
    const starts: CodexTurnStartParams[] = [];
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart(params) {
        starts.push(params);
        if (params.clientUserMessageId === "agentparty:resolve-first") {
          throw new Error("response lost");
        }
        return { turn: { id: "after-resolution" } };
      },
      async turnSteer(params) {
        return { turnId: params.expectedTurnId };
      },
    });
    await arbiter.observeThreadIdle();
    const uncertain = input("resolve-first");
    expect(await arbiter.submit(uncertain)).toMatchObject({ kind: "uncertain" });
    await arbiter.observeThreadIdle();
    expect(await arbiter.submit(input("queued-until-resolution"))).toMatchObject({
      kind: "queued",
      reason: "unknown_outcome",
    });
    expect(starts).toHaveLength(1);

    expect(await arbiter.resolveUnknownOutcome(uncertain, "accepted")).toEqual({
      kind: "duplicate",
    });
    expect(starts.map((entry) => entry.clientUserMessageId)).toEqual([
      "agentparty:resolve-first",
      "agentparty:queued-until-resolution",
    ]);
    expect(arbiter.snapshot().uncertainCount).toBe(0);
  });

  test("abandoned unknown never replays and unfreezes the queued input", async () => {
    const writes: string[] = [];
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart(params) {
        writes.push(params.clientUserMessageId ?? "missing-client-id");
        if (params.clientUserMessageId === "agentparty:abandoned-first") {
          throw new Error("response lost after write");
        }
        return { turn: { id: "after-abandonment" } };
      },
      async turnSteer(params) {
        writes.push(params.clientUserMessageId ?? "missing-client-id");
        return { turnId: params.expectedTurnId };
      },
    });
    await arbiter.observeThreadIdle();
    const abandoned = input("abandoned-first");

    expect(await arbiter.submit(abandoned)).toMatchObject({ kind: "uncertain" });
    await arbiter.observeThreadIdle();
    expect(await arbiter.submit(input("queued-after-abandonment"))).toMatchObject({
      kind: "queued",
      reason: "unknown_outcome",
    });

    expect(await arbiter.resolveUnknownOutcome(abandoned, "abandoned")).toEqual({
      kind: "duplicate",
    });
    expect(arbiter.snapshot()).toEqual({
      phase: { type: "normal", turnId: "after-abandonment" },
      queueDepth: 0,
      uncertainCount: 0,
    });
    expect(await arbiter.submit(abandoned)).toEqual({ kind: "duplicate" });
    expect(writes).toEqual([
      "agentparty:abandoned-first",
      "agentparty:queued-after-abandonment",
    ]);
  });

  test("unresolved unknown inputs contain only unreconciled defensive snapshots", async () => {
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart() {
        throw new Error("response lost after write");
      },
      async turnSteer() {
        throw new Error("not reached");
      },
    });
    await arbiter.observeThreadIdle();
    const first = input("snapshot-first", "original text");
    expect(await arbiter.submit(first)).toMatchObject({ kind: "uncertain" });

    const snapshot = arbiter.unresolvedUnknownInputs();
    expect(snapshot).toEqual([first]);
    snapshot[0]!.text = "mutated text";
    snapshot[0]!.metadata!.delivery_id = "mutated-delivery";
    snapshot.push(input("invented"));
    expect(arbiter.unresolvedUnknownInputs()).toEqual([first]);

    await arbiter.observeResume({
      thread: {
        status: { type: "idle" },
        turns: [{
          id: "positively-reconciled",
          status: "completed",
          items: [{ type: "userMessage", clientId: first.clientUserMessageId }],
        }],
      },
    });
    expect(arbiter.unresolvedUnknownInputs()).toEqual([]);

    const stillUnresolved = input("snapshot-second");
    expect(await arbiter.submit(stillUnresolved)).toMatchObject({ kind: "uncertain" });
    expect(arbiter.unresolvedUnknownInputs()).toEqual([stillUnresolved]);
  });

  test("a rejected interactive steer invalidates the phase instead of restoring a stale turn", async () => {
    const mock = transport();
    const arbiter = new CodexTurnArbiter("thread-1", mock.value);
    await arbiter.observeTurnStarted("stale-turn");

    await expect(arbiter.runInteractiveMutation(
      "turn/steer",
      { threadId: "thread-1", expectedTurnId: "stale-turn" },
      async () => {
        throw rpcError();
      },
    )).rejects.toMatchObject({ code: -32_000 });
    expect(arbiter.snapshot().phase).toEqual({ type: "unknown", turnId: null });
    expect(await arbiter.submit(input("after-stale-tui-steer"))).toMatchObject({
      kind: "queued",
      reason: "unknown",
    });
    expect(mock.starts).toHaveLength(0);
    expect(mock.steers).toHaveLength(0);
  });

  test("absence after reconnect stays uncertain because history is not a negative idempotency proof", async () => {
    const starts: CodexTurnStartParams[] = [];
    const arbiter = new CodexTurnArbiter("thread-1", {
      async turnStart(params) {
        starts.push(params);
        throw new Error("stdio proxy disconnected after write");
      },
      async turnSteer() {
        throw new Error("not reached");
      },
    });
    await arbiter.observeThreadIdle();
    expect(await arbiter.submit(input("not-accepted"))).toMatchObject({ kind: "uncertain" });

    await arbiter.observeResume({ thread: { status: { type: "idle" }, turns: [] } });
    expect(starts).toHaveLength(1);
    expect(await arbiter.submit(input("not-accepted"))).toEqual({
      kind: "uncertain",
      reason: "unknown_outcome",
    });
    expect(await arbiter.submit(input("later-input"))).toMatchObject({
      kind: "queued",
      reason: "unknown_outcome",
    });
    await arbiter.observeThreadIdle();
    expect(starts).toHaveLength(1);
    expect(arbiter.snapshot().uncertainCount).toBe(1);
  });
});
