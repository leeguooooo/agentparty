import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface State {
  threadId: string;
  turns: Array<{
    id: string;
    status: "completed" | "inProgress";
    items: Array<Record<string, unknown>>;
  }>;
  nextTurn: number;
  generations: number;
  requests?: string[];
}

const configuredStatePath = process.env.MOCK_CODEX_STATE_PATH;
if (!configuredStatePath) throw new Error("MOCK_CODEX_STATE_PATH is required");
const statePath: string = configuredStatePath;

function load(): State {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as State;
  } catch {
    return {
      threadId: "thread-mock",
      turns: [],
      nextTurn: 1,
      generations: 0,
    };
  }
}

let state = load();
state.requests ??= [];
state.generations += 1;
writeFileSync(statePath, JSON.stringify(state));

function save(): void {
  writeFileSync(statePath, JSON.stringify(state));
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function thread() {
  const active = state.turns.some((turn) => turn.status === "inProgress");
  return {
    id: state.threadId,
    status: { type: active ? "active" : "idle" },
    turns: state.turns,
  };
}

function textFrom(params: Record<string, unknown>): string {
  if (!Array.isArray(params.input)) return "";
  const first = params.input[0];
  return typeof first === "object" && first !== null && "text" in first
    ? String(first.text)
    : "";
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const frame = JSON.parse(line) as {
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
  };
  const params = frame.params ?? {};
  state.requests!.push(frame.method);
  save();
  if (frame.method === "initialized") return;
  if (frame.method === "initialize") {
    send({
      id: frame.id,
      result: {
        userAgent: "mock-codex-app-server/0.144.4",
        codexHome: "/tmp/mock-codex-home",
        platformFamily: "unix",
        platformOs: "test",
      },
    });
    return;
  }
  if (frame.method === "thread/start" || frame.method === "thread/resume" || frame.method === "thread/read") {
    send({ id: frame.id, result: { thread: thread() } });
    return;
  }
  if (frame.method === "turn/start") {
    const id = `turn-${state.nextTurn++}`;
    const clientId = typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : null;
    const turn = {
      id,
      status: "inProgress" as const,
      items: [{
        type: "userMessage",
        id: `user-${id}`,
        clientId,
        content: params.input ?? [],
      }],
    };
    state.turns.push(turn);
    save();
    if (textFrom(params).includes("__disconnect_after_accept__")) {
      process.exit(73);
    }
    send({ id: frame.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: state.threadId, turn } });
    return;
  }
  if (frame.method === "turn/steer") {
    const turnId = String(params.expectedTurnId);
    const turn = state.turns.find((entry) => entry.id === turnId);
    if (turn) {
      turn.items.push({
        type: "userMessage",
        id: `user-${turnId}-${turn.items.length}`,
        clientId: params.clientUserMessageId ?? null,
        content: params.input ?? [],
      });
      save();
    }
    send({ id: frame.id, result: { turnId } });
    return;
  }
  if (frame.method === "mock/complete") {
    const turn = state.turns.find((entry) => entry.id === params.turnId);
    if (!turn) {
      send({ id: frame.id, error: { code: -32_001, message: "unknown turn" } });
      return;
    }
    turn.status = "completed";
    turn.items.push({
      type: "agentMessage",
      id: `agent-${turn.id}`,
      text: String(params.text ?? "mock final"),
    });
    save();
    send({ id: frame.id, result: {} });
    send({ method: "turn/completed", params: { threadId: state.threadId, turn } });
    send({
      method: "thread/status/changed",
      params: { threadId: state.threadId, status: { type: "idle" } },
    });
    return;
  }
  if (frame.method === "mock/serverRequest") {
    send({ id: frame.id, result: {} });
    send({
      id: "server-approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: state.threadId, turnId: "turn-1" },
    });
    return;
  }
  if (frame.method === "mock/disconnect") {
    process.exit(74);
  }
  send({ id: frame.id, result: { echoedMethod: frame.method, params } });
});
