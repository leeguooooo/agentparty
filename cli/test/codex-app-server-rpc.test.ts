import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexRpcDisconnectedError,
  CodexRpcClient,
  CodexSessionController,
  type CodexFrontendRecovery,
  type CodexRpcPeer,
  type CodexTurn,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../src/codex-app-server-bridge";
import type { CodexTurnArbiter } from "../src/codex-turn-arbiter";

const fixture = join(import.meta.dir, "fixtures", "mock-codex-app-server.ts");

let temp: string;
let clients: CodexRpcClient[];

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ap-codex-rpc-"));
  clients = [];
});

afterEach(() => {
  for (const client of clients) client.close();
  rmSync(temp, { recursive: true, force: true });
});

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface RpcCall {
  method: string;
  params?: unknown;
  generation: number;
}

type RpcResponder = (params: unknown) => unknown | Promise<unknown>;

class ScriptedCodexRpc implements CodexRpcPeer {
  readonly initializeResult = {
    userAgent: "scripted-codex-app-server/0.144.4",
    platformFamily: "unix",
  };
  readonly calls: RpcCall[] = [];
  connected = true;
  connectionGeneration = 1;
  startCalls = 0;
  private readonly responders = new Map<string, RpcResponder[]>();
  private readonly reconnects = new Set<(generation: number) => void | Promise<void>>();
  private readonly disconnects = new Set<(generation: number) => void>();
  private readonly messages =
    new Set<(message: JsonRpcRequest | JsonRpcNotification) => void | Promise<void>>();

  queue(method: string, responder: RpcResponder | unknown): void {
    const responses = this.responders.get(method) ?? [];
    responses.push(
      typeof responder === "function"
        ? responder as RpcResponder
        : () => responder,
    );
    this.responders.set(method, responses);
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.connected) return;
    this.connected = true;
    this.connectionGeneration += 1;
    for (const listener of this.reconnects) {
      void Promise.resolve(listener(this.connectionGeneration)).catch(() => {});
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return await this.dispatch(method, params);
  }

  async requestConnected(
    method: string,
    params?: unknown,
    expectedGeneration?: number,
  ): Promise<unknown> {
    if (!this.connected || (
      expectedGeneration !== undefined &&
      expectedGeneration !== this.connectionGeneration
    )) {
      throw new CodexRpcDisconnectedError(
        "disconnected before scripted request write",
        { requestWritten: false },
      );
    }
    const generation = this.connectionGeneration;
    const result = await this.dispatch(method, params);
    if (
      expectedGeneration !== undefined &&
      (!this.connected || generation !== this.connectionGeneration)
    ) {
      throw new CodexRpcDisconnectedError("scripted request lost its backend generation");
    }
    return result;
  }

  async notify(_method: string, _params?: unknown): Promise<void> {}

  respond(
    _id: JsonRpcId,
    _result?: unknown,
    _error?: JsonRpcResponse["error"],
  ): void {}

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

  onDisconnect(listener: (generation: number) => void): () => void {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of this.disconnects) listener(this.connectionGeneration);
  }

  async emit(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    await Promise.all([...this.messages].map(async (listener) => await listener(message)));
  }

  reconnect(): Promise<void> {
    this.connected = true;
    this.connectionGeneration += 1;
    return Promise.all(
      [...this.reconnects].map(async (listener) => await listener(this.connectionGeneration)),
    ).then(() => {});
  }

  private async dispatch(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({
      method,
      generation: this.connectionGeneration,
      ...(params === undefined ? {} : { params }),
    });
    const responses = this.responders.get(method);
    const responder = responses?.shift();
    if (!responder) throw new Error(`unexpected RPC call: ${method}`);
    return await responder(params);
  }
}

function idleThread(id: string): {
  thread: {
    id: string;
    status: { type: "idle" };
    turns: [];
  };
} {
  return {
    thread: {
      id,
      status: { type: "idle" },
      turns: [],
    },
  };
}

describe("Codex app-server stdio JSON-RPC and reconnect recovery", () => {
  for (const method of ["thread/start", "thread/resume"] as const) {
    test(`${method} serializes a concurrent submit behind the thread switch`, async () => {
      const rpc = new ScriptedCodexRpc();
      const switchResponse = deferred<ReturnType<typeof idleThread>>();
      rpc.queue("thread/start", idleThread("thread-old"));
      rpc.queue(method, () => switchResponse.promise);
      rpc.queue("turn/start", (params: unknown) => {
        const threadId = (params as { threadId?: unknown }).threadId;
        return { turn: { id: `turn-for-${String(threadId)}` } };
      });
      const session = new CodexSessionController(rpc);

      await session.start();
      await session.request("thread/start", {});
      expect(session.activeThreadId).toBe("thread-old");

      const switching = session.request(
        method,
        method === "thread/resume" ? { threadId: "thread-new" } : {},
      );
      const expectedSwitchCalls = method === "thread/start" ? 2 : 1;
      await waitFor(
        () => rpc.calls.filter((call) => call.method === method).length === expectedSwitchCalls,
        `${method} did not reach the backend`,
      );

      let submitSettled = false;
      const submitted = session.submit({
        text: "must use the replacement thread",
        clientUserMessageId: `agentparty:${method}:concurrent`,
      }).finally(() => {
        submitSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
      expect(submitSettled).toBe(false);

      switchResponse.resolve(idleThread("thread-new"));
      await switching;
      expect(session.activeThreadId).toBe("thread-new");
      expect(await submitted).toEqual({
        kind: "started",
        turnId: "turn-for-thread-new",
      });
      expect(rpc.calls.filter((call) => call.method === "turn/start")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            threadId: "thread-new",
            clientUserMessageId: `agentparty:${method}:concurrent`,
          }),
        }),
      ]);
    });
  }

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
    test(`${method} cannot overtake an in-flight thread switch`, async () => {
      const rpc = new ScriptedCodexRpc();
      const switchResponse = deferred<ReturnType<typeof idleThread>>();
      rpc.queue("thread/start", idleThread("thread-old"));
      rpc.queue("thread/resume", () => switchResponse.promise);
      const session = new CodexSessionController(rpc);

      await session.start();
      await session.request("thread/start", {});
      const switching = session.request("thread/resume", { threadId: "thread-new" });
      await waitFor(
        () => rpc.calls.some((call) => call.method === "thread/resume"),
        "thread switch did not reach the backend",
      );
      const mutation = session.request(method, {
        threadId: "thread-old",
        ...(method === "turn/steer" ? { expectedTurnId: "turn-old" } : {}),
        ...(method === "review/start" ? { delivery: "detached" } : {}),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rpc.calls.filter((call) => call.method === method)).toHaveLength(0);

      switchResponse.resolve(idleThread("thread-new"));
      await switching;
      await expect(mutation).rejects.toThrow(`inactive thread thread-old`);
      expect(rpc.calls.filter((call) => call.method === method)).toHaveLength(0);
    });
  }

  test("a pre-thread-start disconnect emits a safe restart only after cancelling the old request", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    rpc.disconnect();
    const starting = session.request("thread/start", {
      prompt: "the TUI positional prompt is still local",
    });
    await expect(starting).rejects.toThrow(
      "disconnected before the initial thread/start write",
    );
    await waitFor(
      () => recoveries.length === 1,
      "proven-not-written recovery was not published",
    );

    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(0);
    expect(recoveries).toEqual([{
      disposition: "restart",
      threadId: null,
      generation: 2,
    }]);
  });

  test("the transport requestWritten marker is authoritative for safe initial replay", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    rpc.queue(
      "thread/start",
      () => {
        throw new CodexRpcDisconnectedError(
          "scripted disconnect before write",
          { requestWritten: false },
        );
      },
    );
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    await expect(session.request("thread/start", {})).rejects.toThrow(
      "disconnected before the initial thread/start write",
    );
    rpc.disconnect();
    await rpc.reconnect();

    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(recoveries).toEqual([{
      disposition: "restart",
      threadId: null,
      generation: 2,
    }]);
  });

  test("an after-write initial thread/start disconnect is terminal-unknown and never replayed", async () => {
    const rpc = new ScriptedCodexRpc();
    const startResponse = deferred<ReturnType<typeof idleThread>>();
    const recoveries: CodexFrontendRecovery[] = [];
    rpc.queue("thread/start", () => startResponse.promise);
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    const starting = session.request("thread/start", { prompt: "run once" });
    await waitFor(
      () => rpc.calls.some((call) => call.method === "thread/start"),
      "initial thread/start did not cross the scripted transport",
    );
    rpc.disconnect();
    startResponse.reject(new CodexRpcDisconnectedError("lost after write"));
    await expect(starting).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
    await rpc.reconnect();

    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(recoveries).toEqual([{
      disposition: "unknown",
      threadId: null,
      generation: 2,
      reason:
        "Codex backend disconnected after the initial thread/start write; " +
        "its outcome is unknown, so the initial prompt will not be replayed",
    }]);
  });

  test("a created bootstrap thread replays its prompt without creating the thread twice", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    rpc.queue("thread/start", idleThread("thread-bootstrap"));
    rpc.queue("thread/resume", idleThread("thread-bootstrap"));
    rpc.queue("thread/read", idleThread("thread-bootstrap"));
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    await session.request("thread/start", {});
    rpc.disconnect();
    await rpc.reconnect();

    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(recoveries).toEqual([{
      disposition: "restart_thread_with_prompt",
      threadId: "thread-bootstrap",
      generation: 2,
    }]);
  });

  test("bootstrap prompt stays ahead of queued AgentParty input across same-thread read and resume", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-bootstrap-order"));
    rpc.queue("thread/read", idleThread("thread-bootstrap-order"));
    rpc.queue("thread/resume", idleThread("thread-bootstrap-order"));
    rpc.queue("turn/start", {
      turn: { id: "turn-bootstrap-order", status: "inProgress", items: [] },
    });
    rpc.queue("turn/steer", { turnId: "turn-bootstrap-order" });
    const session = new CodexSessionController(rpc, {
      expectBootstrapPrompt: true,
    });

    await session.request("thread/start", {});
    expect(await session.submit({
      text: "recovered AgentParty delivery",
      clientUserMessageId: "agentparty:bootstrap-order",
    })).toMatchObject({ kind: "queued", reason: "unknown" });
    await session.request("thread/read", {
      threadId: "thread-bootstrap-order",
      includeTurns: true,
    });
    await session.request("thread/resume", {
      threadId: "thread-bootstrap-order",
    });
    expect(
      rpc.calls.filter((call) =>
        call.method === "turn/start" || call.method === "turn/steer"
      ),
    ).toHaveLength(0);

    await session.request("turn/start", {
      threadId: "thread-bootstrap-order",
      clientUserMessageId: null,
      input: [{
        type: "text",
        text: "the user's initial prompt",
        text_elements: [],
      }],
    });
    const writes = rpc.calls.filter((call) =>
      call.method === "turn/start" || call.method === "turn/steer"
    );
    expect(writes.map((call) => call.method)).toEqual(["turn/start", "turn/steer"]);
    expect(writes[1]!.params).toMatchObject({
      threadId: "thread-bootstrap-order",
      expectedTurnId: "turn-bootstrap-order",
      clientUserMessageId: "agentparty:bootstrap-order",
    });
  });

  test("initial prompt replay requires the turn/start transport to prove not-written", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    const initialInput = [{
      type: "text",
      text: "WIRE_PROMPT_746",
      text_elements: [],
    }];
    rpc.queue("thread/start", idleThread("thread-bootstrap"));
    rpc.queue("turn/start", () => {
      throw new CodexRpcDisconnectedError(
        "scripted initial turn disconnect before write",
        { requestWritten: false },
      );
    });
    rpc.queue("thread/resume", idleThread("thread-bootstrap"));
    rpc.queue("thread/read", idleThread("thread-bootstrap"));
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    await session.request("thread/start", {});
    await expect(session.request("turn/start", {
      threadId: "thread-bootstrap",
      clientUserMessageId: null,
      input: initialInput,
    })).rejects.toThrow("disconnected before the initial turn/start write");
    rpc.disconnect();
    await rpc.reconnect();

    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(recoveries).toEqual([{
      disposition: "restart_thread_with_prompt",
      threadId: "thread-bootstrap",
      generation: 2,
      initialInput,
    }]);
  });

  test("an after-write initial prompt is unknown unless full history positively matches it", async () => {
    for (const historyMatches of [false, true]) {
      const rpc = new ScriptedCodexRpc();
      const turnResponse = deferred<unknown>();
      const recoveries: CodexFrontendRecovery[] = [];
      const initialInput = [{
        type: "text",
        text: "WIRE_PROMPT_746",
        text_elements: [],
      }];
      rpc.queue("thread/start", idleThread("thread-bootstrap"));
      rpc.queue("turn/start", () => turnResponse.promise);
      rpc.queue("thread/resume", idleThread("thread-bootstrap"));
      rpc.queue("thread/read", historyMatches
        ? {
          thread: {
            id: "thread-bootstrap",
            status: { type: "active" },
            turns: [{
              id: "turn-bootstrap",
              status: "inProgress",
              items: [{
                type: "userMessage",
                id: "user-bootstrap",
                clientId: null,
                content: initialInput,
              }],
            }],
          },
        }
        : idleThread("thread-bootstrap"));
      const session = new CodexSessionController(rpc);
      session.onFrontendRecovery((event) => {
        recoveries.push(event);
      });

      await session.request("thread/start", {});
      const starting = session.request("turn/start", {
        threadId: "thread-bootstrap",
        clientUserMessageId: null,
        input: initialInput,
      });
      await waitFor(
        () => rpc.calls.some((call) => call.method === "turn/start"),
        "initial prompt did not cross the scripted transport",
      );
      rpc.disconnect();
      turnResponse.reject(new CodexRpcDisconnectedError("lost after initial prompt write"));
      await expect(starting).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
      await rpc.reconnect();

      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
      if (historyMatches) {
        expect(recoveries).toEqual([{
          disposition: "resume",
          threadId: "thread-bootstrap",
          generation: 2,
        }]);
      } else {
        expect(recoveries).toEqual([{
          disposition: "unknown",
          threadId: "thread-bootstrap",
          generation: 2,
          reason:
            "Codex backend disconnected after the initial turn/start write; " +
            "its outcome is unknown, so the initial prompt will not be replayed",
        }]);
      }
    }
  });

  test("an accepted initial turn resumes even if the backend drops before the TUI sees its response", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    const initialInput = [{
      type: "text",
      text: "WIRE_PROMPT_746",
      text_elements: [],
    }];
    rpc.queue("thread/start", idleThread("thread-bootstrap"));
    rpc.queue("turn/start", {
      turn: {
        id: "turn-bootstrap",
        status: "inProgress",
        items: [{
          type: "userMessage",
          id: "user-bootstrap",
          clientId: null,
          content: initialInput,
        }],
      },
    });
    rpc.queue("thread/resume", idleThread("thread-bootstrap"));
    rpc.queue("thread/read", {
      thread: {
        id: "thread-bootstrap",
        status: { type: "active" },
        turns: [{
          id: "turn-bootstrap",
          status: "inProgress",
          items: [{
            type: "userMessage",
            id: "user-bootstrap",
            clientId: null,
            content: initialInput,
          }],
        }],
      },
    });
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    await session.request("thread/start", {});
    await session.request("turn/start", {
      threadId: "thread-bootstrap",
      clientUserMessageId: null,
      input: initialInput,
    });
    rpc.disconnect();
    await rpc.reconnect();

    expect(recoveries).toEqual([{
      disposition: "resume",
      threadId: "thread-bootstrap",
      generation: 2,
    }]);
  });

  test("shellCommand owns the turn until authoritative completion before AgentParty starts", async () => {
    const rpc = new ScriptedCodexRpc();
    const shellAccepted = deferred<Record<string, never>>();
    rpc.queue("thread/start", idleThread("thread-shell"));
    rpc.queue("thread/shellCommand", () => shellAccepted.promise);
    rpc.queue("turn/start", { turn: { id: "turn-agentparty" } });
    const session = new CodexSessionController(rpc);

    await session.start();
    await session.request("thread/start", {});
    const shell = session.request("thread/shellCommand", {
      threadId: "thread-shell",
      command: "git status --short",
    });
    await waitFor(
      () => rpc.calls.some((call) => call.method === "thread/shellCommand"),
      "shellCommand did not reach the backend",
    );
    const submitted = session.submit({
      text: "must wait for the user shell command",
      clientUserMessageId: "agentparty:after-shell",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

    shellAccepted.resolve({});
    await shell;
    await expect(submitted).resolves.toMatchObject({
      kind: "queued",
      reason: "shell",
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

    await rpc.emit({
      method: "turn/started",
      params: {
        threadId: "thread-shell",
        turn: { id: "turn-user-shell", status: "inProgress", items: [] },
      },
    });
    await rpc.emit({
      method: "item/started",
      params: {
        threadId: "thread-shell",
        turnId: "turn-user-shell",
        item: {
          id: "item-user-shell",
          type: "commandExecution",
          source: "userShell",
        },
      },
    });
    await rpc.emit({
      method: "item/completed",
      params: {
        threadId: "thread-shell",
        turnId: "turn-user-shell",
        item: {
          id: "item-user-shell",
          type: "commandExecution",
          source: "userShell",
        },
      },
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

    await rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-shell",
        turn: { id: "turn-user-shell", status: "completed", items: [] },
      },
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: "thread-shell",
          clientUserMessageId: "agentparty:after-shell",
        }),
      }),
    ]);
  });

  test("an after-write thread switch disconnect stays unknown while later submit restores the prior thread", async () => {
    const rpc = new ScriptedCodexRpc();
    const switchResponse = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-old"));
    rpc.queue("thread/start", () => switchResponse.promise);
    rpc.queue("thread/resume", idleThread("thread-old"));
    rpc.queue("thread/read", idleThread("thread-old"));
    rpc.queue("turn/start", {
      turn: { id: "turn-after-restore" },
    });
    const session = new CodexSessionController(rpc);

    await session.start();
    await session.request("thread/start", {});
    const switching = session.request("thread/start", {});
    await waitFor(
      () => rpc.calls.filter((call) => call.method === "thread/start").length === 2,
      "replacement thread/start did not take the session lane",
    );
    const expectedStartCalls = rpc.startCalls + 1;
    const submitted = session.submit({
      text: "must wait for reconnect restoration",
      clientUserMessageId: "agentparty:lane-disconnect",
    });
    await waitFor(
      () => rpc.startCalls >= expectedStartCalls,
      "submit did not pass its first readiness barrier",
    );

    rpc.connected = false;
    switchResponse.resolve(idleThread("thread-new"));
    await expect(switching).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
    await expect(submitted).resolves.toEqual({
      kind: "started",
      turnId: "turn-after-restore",
    });
    expect(
      rpc.calls
        .filter((call) => call.method === "turn/start")
        .map((call) => call.params),
    ).toEqual([
      expect.objectContaining({
        threadId: "thread-old",
        clientUserMessageId: "agentparty:lane-disconnect",
      }),
    ]);
    expect(rpc.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    expect(rpc.calls.filter((call) => call.method === "thread/read")).toHaveLength(1);
  });

  test("overlapping reconnects run a distinct full recovery for the newest generation", async () => {
    const rpc = new ScriptedCodexRpc();
    const generationTwoResume = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-recovery"));
    rpc.queue("thread/resume", () => generationTwoResume.promise);
    rpc.queue("thread/resume", idleThread("thread-recovery"));
    rpc.queue("thread/read", idleThread("thread-recovery"));
    const session = new CodexSessionController(rpc);

    await session.request("thread/start", {});
    const generationTwo = rpc.reconnect();
    await waitFor(
      () => rpc.calls.some((call) =>
        call.method === "thread/resume" && call.generation === 2
      ),
      "generation 2 restore did not start",
    );
    const generationThree = rpc.reconnect();
    generationTwoResume.resolve(idleThread("thread-recovery"));
    await Promise.all([generationTwo, generationThree]);

    expect(
      rpc.calls
        .filter((call) => call.method === "thread/resume")
        .map((call) => call.generation),
    ).toEqual([2, 3]);
    expect(
      rpc.calls
        .filter((call) => call.method === "thread/read")
        .map((call) => call.generation),
    ).toEqual([3]);
  });

  test("a writer waiting on interrupted recovery drives the next generation without spinning", async () => {
    const rpc = new ScriptedCodexRpc();
    const generationTwoResume = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-recovery-waiter"));
    rpc.queue("thread/resume", () => generationTwoResume.promise);
    rpc.queue("thread/resume", idleThread("thread-recovery-waiter"));
    rpc.queue("thread/read", idleThread("thread-recovery-waiter"));
    rpc.queue("turn/start", { turn: { id: "turn-after-recovery-waiter" } });
    const session = new CodexSessionController(rpc);

    await session.request("thread/start", {});
    const generationTwo = rpc.reconnect();
    await waitFor(
      () => rpc.calls.some((call) =>
        call.method === "thread/resume" && call.generation === 2
      ),
      "generation 2 restore did not start",
    );
    const submission = session.submit({
      text: "resume only after generation 3 is authoritative",
      clientUserMessageId: "agentparty:recovery-waiter-generation-three",
    });

    rpc.disconnect();
    generationTwoResume.resolve(idleThread("thread-recovery-waiter"));
    await generationTwo;
    await expect(submission).resolves.toEqual({
      kind: "started",
      turnId: "turn-after-recovery-waiter",
    });

    expect(
      rpc.calls
        .filter((call) => call.method === "thread/resume" || call.method === "thread/read")
        .map((call) => `${call.method}@${call.generation}`),
    ).toEqual([
      "thread/resume@2",
      "thread/resume@3",
      "thread/read@3",
    ]);
    expect(
      rpc.calls
        .filter((call) => call.method === "turn/start")
        .map((call) => call.generation),
    ).toEqual([3]);
    expect(rpc.startCalls).toBeGreaterThanOrEqual(2);
  });

  test("a partial restore cannot apply a stale snapshot or continue its read on a new generation", async () => {
    const rpc = new ScriptedCodexRpc();
    const generationTwoResume = deferred<{
      thread: {
        id: string;
        status: { type: "active" };
        turns: Array<{
          id: string;
          status: "inProgress";
          items: Array<{ type: "userMessage"; clientId: string }>;
        }>;
      };
    }>();
    rpc.queue("thread/start", idleThread("thread-fenced"));
    rpc.queue("thread/resume", () => generationTwoResume.promise);
    rpc.queue("thread/resume", idleThread("thread-fenced"));
    rpc.queue("thread/read", idleThread("thread-fenced"));
    const session = new CodexSessionController(rpc);
    const recoveredClientIds: string[] = [];
    session.onDispatch((input) => {
      recoveredClientIds.push(input.clientUserMessageId);
    });

    await session.request("thread/start", {});
    const generationTwo = rpc.reconnect();
    await waitFor(
      () => rpc.calls.some((call) =>
        call.method === "thread/resume" && call.generation === 2
      ),
      "generation 2 resume did not start",
    );
    generationTwoResume.resolve({
      thread: {
        id: "thread-fenced",
        status: { type: "active" },
        turns: [{
          id: "stale-turn",
          status: "inProgress",
          items: [{
            type: "userMessage",
            clientId: "agentparty:stale-generation-two",
          }],
        }],
      },
    });
    const generationThree = rpc.reconnect();
    await Promise.all([generationTwo, generationThree]);

    expect(
      rpc.calls
        .filter((call) => call.method === "thread/resume" || call.method === "thread/read")
        .map((call) => `${call.method}@${call.generation}`),
    ).toEqual([
      "thread/resume@2",
      "thread/resume@3",
      "thread/read@3",
    ]);
    expect(recoveredClientIds).not.toContain("agentparty:stale-generation-two");
  });

  test("a superseded restore failure cannot poison the healthy generation", async () => {
    const rpc = new ScriptedCodexRpc();
    const generationTwoResume = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-failure-fence"));
    rpc.queue("thread/resume", () => generationTwoResume.promise);
    rpc.queue("thread/resume", idleThread("thread-failure-fence"));
    rpc.queue("thread/read", idleThread("thread-failure-fence"));
    rpc.queue("turn/start", { turn: { id: "turn-after-healthy-recovery" } });
    const session = new CodexSessionController(rpc);

    await session.request("thread/start", {});
    const generationTwo = rpc.reconnect();
    await waitFor(
      () => rpc.calls.some((call) =>
        call.method === "thread/resume" && call.generation === 2
      ),
      "generation 2 resume did not start",
    );
    const generationThree = rpc.reconnect();
    generationTwoResume.reject(new Error("restore-generation-two-failed"));
    await Promise.all([generationTwo, generationThree]);

    await expect(session.submit({
      text: "healthy generation must remain usable",
      clientUserMessageId: "agentparty:healthy-generation",
    })).resolves.toEqual({
      kind: "started",
      turnId: "turn-after-healthy-recovery",
    });
    expect(
      rpc.calls
        .filter((call) => call.method === "turn/start")
      .map((call) => call.generation),
    ).toEqual([3]);
  });

  test.each([
    ["missing", {}],
    ["mismatched", idleThread("thread-wrong-recovery-target")],
  ] as const)(
    "a %s full-history snapshot keeps recovery closed until the exact thread is readable",
    async (_kind, invalidRead) => {
      const threadId = "thread-strict-recovery";
      const validRead = deferred<ReturnType<typeof idleThread>>();
      const rpc = new ScriptedCodexRpc();
      rpc.queue("thread/start", idleThread(threadId));
      rpc.queue("thread/resume", idleThread(threadId));
      rpc.queue("thread/read", invalidRead);
      rpc.queue("thread/resume", idleThread(threadId));
      rpc.queue("thread/read", () => validRead.promise);
      rpc.queue("turn/start", { turn: { id: "turn-after-strict-recovery" } });
      const session = new CodexSessionController(rpc, {
        recoveryRetryDelayMs: 20,
      });

      await session.request("thread/start", {});
      const recovery = rpc.reconnect();
      const submission = session.submit({
        text: "must wait for an exact recovery snapshot",
        clientUserMessageId: `agentparty:strict-recovery-${_kind}`,
      });
      await waitFor(
        () => rpc.calls.filter((call) => call.method === "thread/read").length === 2,
        "invalid recovery snapshot was not retried on the same generation",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

      validRead.resolve(idleThread(threadId));
      await recovery;
      await expect(submission).resolves.toEqual({
        kind: "started",
        turnId: "turn-after-strict-recovery",
      });
      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
      expect(
        rpc.calls
          .filter((call) => call.method === "thread/resume" || call.method === "thread/read")
          .map((call) => `${call.method}@${call.generation}`),
      ).toEqual([
        "thread/resume@2",
        "thread/read@2",
        "thread/resume@2",
        "thread/read@2",
      ]);
    },
  );

  test("a reconnect while submit waits on the arbiter cannot write before same-generation recovery", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-operation-fence"));
    rpc.queue("thread/resume", idleThread("thread-operation-fence"));
    rpc.queue("thread/read", idleThread("thread-operation-fence"));
    rpc.queue("turn/start", { turn: { id: "turn-after-operation-fence" } });
    const session = new CodexSessionController(rpc);
    await session.request("thread/start", {});

    const arbiter = (session as unknown as {
      arbiter: CodexTurnArbiter | null;
    }).arbiter!;
    const releaseArbiter = deferred<void>();
    const occupyingArbiter = arbiter.runInteractiveMutation(
      "turn/steer",
      { threadId: "thread-operation-fence", expectedTurnId: "turn-before-reconnect" },
      async () => {
        await releaseArbiter.promise;
        return { turnId: "turn-before-reconnect" };
      },
    );
    const expectedStartCalls = rpc.startCalls + 1;
    const submitted = session.submit({
      text: "must not write before generation recovery",
      clientUserMessageId: "agentparty:operation-generation-fence",
    });
    await waitFor(
      () => rpc.startCalls >= expectedStartCalls,
      "submit did not pass its initial readiness barrier",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const recovery = rpc.reconnect();
    releaseArbiter.resolve();
    await occupyingArbiter;
    await expect(submitted).resolves.toMatchObject({
      kind: "queued",
      reason: "steer_rejected",
    });
    await recovery;

    expect(
      rpc.calls
        .filter((call) =>
          call.method === "thread/resume" ||
          call.method === "thread/read" ||
          call.method === "turn/start" ||
          call.method === "turn/steer"
        )
        .map((call) => `${call.method}@${call.generation}`),
    ).toEqual([
      "thread/resume@2",
      "thread/read@2",
      "turn/start@2",
    ]);
  });

  test("thread/fork passes the switch guard and attaches the returned thread", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-old"));
    rpc.queue("thread/fork", idleThread("thread-forked"));
    rpc.queue("turn/start", (params: unknown) => {
      const threadId = (params as { threadId?: unknown }).threadId;
      return { turn: { id: `turn-for-${String(threadId)}` } };
    });
    const session = new CodexSessionController(rpc);
    const switchAttempts: Array<{
      method: string;
      currentThreadId: string;
      targetThreadId: string | null;
    }> = [];
    session.onThreadSwitch((attempt) => {
      switchAttempts.push(attempt);
    });

    await session.start();
    await session.request("thread/start", {});
    expect(session.activeThreadId).toBe("thread-old");

    await session.request("thread/fork", { threadId: "thread-old" });
    expect(switchAttempts).toEqual([{
      method: "thread/fork",
      currentThreadId: "thread-old",
      targetThreadId: null,
    }]);
    expect(session.activeThreadId).toBe("thread-forked");

    await expect(session.submit({
      text: "continue in the fork",
      clientUserMessageId: "agentparty:forked-thread",
    })).resolves.toEqual({
      kind: "started",
      turnId: "turn-for-thread-forked",
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: "thread-forked",
          clientUserMessageId: "agentparty:forked-thread",
        }),
      }),
    ]);
  });

  test("thread/rollback serializes a concurrent AgentParty submit behind authoritative history", async () => {
    const rpc = new ScriptedCodexRpc();
    const rollbackResponse = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-rollback"));
    rpc.queue("thread/rollback", () => rollbackResponse.promise);
    rpc.queue("turn/start", { turn: { id: "turn-after-rollback" } });
    const session = new CodexSessionController(rpc);
    await session.start();
    await session.request("thread/start", {});

    const rollback = session.request("thread/rollback", {
      threadId: "thread-rollback",
      numTurns: 1,
    });
    await waitFor(
      () => rpc.calls.some((call) => call.method === "thread/rollback"),
      "rollback did not reach the backend",
    );
    const submitted = session.submit({
      text: "must see post-rollback history",
      clientUserMessageId: "agentparty:after-rollback",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

    rollbackResponse.resolve(idleThread("thread-rollback"));
    await rollback;
    await expect(submitted).resolves.toEqual({
      kind: "started",
      turnId: "turn-after-rollback",
    });
  });

  test("thread/rollback rebuilds same-thread clientId affinity instead of retaining removed turns", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/resume", {
      thread: {
        id: "thread-rollback-affinity",
        status: { type: "idle" },
        turns: [{
          id: "source-turn",
          status: "completed",
          items: [{
            type: "userMessage",
            id: "source-user",
            clientId: "agentparty:source-delivery",
          }],
        }],
      },
    });
    rpc.queue("thread/rollback", idleThread("thread-rollback-affinity"));
    const session = new CodexSessionController(rpc);
    await session.start();
    await session.request("thread/resume", { threadId: "thread-rollback-affinity" });
    expect(session.turnForClientId("agentparty:source-delivery")?.id).toBe("source-turn");

    await session.request("thread/rollback", {
      threadId: "thread-rollback-affinity",
      numTurns: 1,
    });
    expect(session.turnForClientId("agentparty:source-delivery")).toBeNull();
  });

  test("a submit that triggers reconnect restores before taking the arbiter lane", async () => {
    const statePath = join(temp, "state.json");
    const logs: string[] = [];
    let spawns = 0;
    const rpc = new CodexRpcClient({
      reconnectDelayMs: 1_000,
      maxReconnectDelayMs: 1_000,
      log: (line) => logs.push(line),
      spawnProxy: () => {
        spawns += 1;
        return spawn("bun", ["run", fixture], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, MOCK_CODEX_STATE_PATH: statePath },
        });
      },
    });
    clients.push(rpc);
    const session = new CodexSessionController(rpc, {
      log: (line) => logs.push(line),
    });
    await session.start();
    await session.request("thread/start", {});
    await expect(rpc.request("mock/disconnect", {})).rejects.toThrow(
      "Codex app-server control connection closed",
    );

    const dispatch = await Promise.race([
      session.submit({
        text: "submit owns the reconnect",
        clientUserMessageId: "agentparty:submit-reconnect",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("submit deadlocked during reconnect")), 2_000);
      }),
    ]);
    expect(dispatch).toEqual({ kind: "started", turnId: "turn-1" });
    expect(spawns).toBeGreaterThanOrEqual(2);
    expect(logs.some((line) => line.includes("restored thread thread-mock"))).toBe(true);
  }, 10_000);

  test("initializes real JSONL, resumes after an unknown write, and reconciles clientId without duplicate start", async () => {
    const statePath = join(temp, "state.json");
    let spawns = 0;
    const logs: string[] = [];
    const rpc = new CodexRpcClient({
      reconnectDelayMs: 5,
      maxReconnectDelayMs: 20,
      log: (line) => logs.push(line),
      spawnProxy: () => {
        spawns += 1;
        return spawn("bun", ["run", fixture], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, MOCK_CODEX_STATE_PATH: statePath },
        });
      },
    });
    clients.push(rpc);
    const session = new CodexSessionController(rpc, {
      log: (line) => logs.push(line),
    });
    const completed: CodexTurn[] = [];
    session.onTurnCompleted((turn) => {
      completed.push(turn);
    });

    await session.start();
    expect(rpc.initializeResult).toMatchObject({
      userAgent: "mock-codex-app-server/0.144.4",
      platformFamily: "unix",
    });
    await session.request("thread/start", {});
    expect(session.activeThreadId).toBe("thread-mock");

    const input = {
      text: "__disconnect_after_accept__",
      clientUserMessageId: "agentparty:delivery-lost-response",
      metadata: { delivery_id: "delivery-lost-response" },
    };
    await expect(session.submit(input)).resolves.toEqual({
      kind: "uncertain",
      reason: "unknown_outcome",
    });

    await waitFor(
      () => session.turnForClientId(input.clientUserMessageId) !== null,
      "reconnected controller did not recover the accepted client id",
    );
    expect(spawns).toBeGreaterThanOrEqual(2);
    expect(await session.submit(input)).toEqual({
      kind: "duplicate",
    });

    const recovered = session.turnForClientId(input.clientUserMessageId)!;
    await rpc.request("mock/complete", {
      turnId: recovered.id,
      text: "linked answer after reconnect",
    });
    await waitFor(() => completed.some((turn) => turn.id === recovered.id), "completion notification not routed");
    expect(completed.find((turn) => turn.id === recovered.id)?.items).toContainEqual(
      expect.objectContaining({
        type: "agentMessage",
        text: "linked answer after reconnect",
      }),
    );

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      generations: number;
      turns: unknown[];
    };
    expect(state.generations).toBeGreaterThanOrEqual(2);
    expect(state.turns).toHaveLength(1);
    expect(logs.some((line) => line.includes("restored thread thread-mock"))).toBe(true);
  }, 15_000);

  test("routes app-server requests to the frontend and sends the frontend response back", async () => {
    const statePath = join(temp, "state.json");
    const rpc = new CodexRpcClient({
      spawnProxy: () => spawn("bun", ["run", fixture], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MOCK_CODEX_STATE_PATH: statePath },
      }),
    });
    clients.push(rpc);
    const session = new CodexSessionController(rpc);
    const frontend: Array<{ method: string; id?: string | number | null }> = [];
    session.onFrontendMessage((message) => {
      frontend.push(message);
      if ("id" in message) session.respond(message.id, { decision: "accept" });
    });
    await session.start();
    await session.request("thread/start", {});
    await rpc.request("mock/serverRequest", {});
    await waitFor(
      () => frontend.some((message) => message.method === "item/commandExecution/requestApproval"),
      "server request was not forwarded",
    );
    expect(frontend).toContainEqual(expect.objectContaining({
      id: "server-approval-1",
      method: "item/commandExecution/requestApproval",
    }));
  });
});
