// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { AgentDetailModal, filterAgentHistory } from "./AgentDetailModal";

// issue #272（审计重开）：单 Agent 详情弹窗——点某个 agent 能看到它的工作状态、
// 历史工作内容、在线状态，而不再只有频道级平铺看板。

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;

function msg(overrides: Partial<MsgFrame> & { seq: number; senderName: string }): MsgFrame {
  const { senderName, ...rest } = overrides;
  return {
    type: "msg",
    kind: "message",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    body: "hello",
    ts: 1000,
    sender: { name: senderName, kind: "agent" },
    ...rest,
  } as MsgFrame;
}

function render(props: Parameters<typeof AgentDetailModal>[0]) {
  localStorage.setItem("ap_locale", "zh");
  act(() => {
    renderer = create(
      <LocaleProvider>
        <AgentDetailModal {...props} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

let fakeWindow: EventTarget | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  // component listens on window for Esc-to-close (see ChannelPanelModal's established pattern) —
  // bun's runtime has no DOM, so stand in a real EventTarget (supports add/removeEventListener + dispatchEvent).
  fakeWindow = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = null;
  }
  Reflect.deleteProperty(globalThis, "window");
  fakeWindow = null;
});

function pressEscape(): void {
  const event = new Event("keydown") as Event & { key: string };
  event.key = "Escape";
  fakeWindow!.dispatchEvent(event);
}

describe("filterAgentHistory (#272)", () => {
  test("keeps only messages from the given agent, newest seq first", () => {
    const messages: MsgFrame[] = [
      msg({ seq: 1, senderName: "worker-a", body: "first" }),
      msg({ seq: 2, senderName: "worker-b", body: "not mine" }),
      msg({ seq: 3, senderName: "worker-a", body: "second" }),
    ];
    const result = filterAgentHistory(messages, "worker-a");
    expect(result.map((m) => m.seq)).toEqual([3, 1]);
  });

  test("caps to the limit", () => {
    const messages: MsgFrame[] = Array.from({ length: 25 }, (_, i) => msg({ seq: i, senderName: "worker-a" }));
    expect(filterAgentHistory(messages, "worker-a", 20).length).toBe(20);
  });
});

describe("AgentDetailModal (#272)", () => {
  function presenceEntry(overrides: Partial<PresenceEntry> = {}): PresenceEntry {
    return { name: "worker-a", state: "working", note: null, ts: 1, kind: "agent", ...overrides };
  }

  test("renders the agent's presence fields: state, busy/queue, current task, paused, wake, resume session", () => {
    const root = render({
      name: "worker-a",
      display: "worker-a",
      kind: "agent",
      owner: "leo",
      online: true,
      presence: presenceEntry({
        busy: true,
        queue_depth: 3,
        waiting_owner_count: 2,
        current_task: 510,
        heartbeat_at: Date.now(),
        paused: true,
        wake: { kind: "serve" },
        residency: "supervised",
        agent_session: {
          harness: "codex",
          session_id: "019f35d9-0000-7000-8000-000000000522",
          updated_at: Date.now(),
          cwd: "/workspace/agentparty",
        },
      }),
      messages: [],
      onClose: () => {},
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("忙碌 · 排队 3 条");
    expect(text).toContain("有2 项工作等待 owner");
    expect(text).toContain("510");
    expect(text).toContain("已暂停");
    expect(text).toContain("codex");
    expect(text).toContain("019f35d9-0000-7000-8000-000000000522");
    expect(text).toContain('" · ","now"');
    expect(text).toContain("/workspace/agentparty");
  });

  test("history section lists only that agent's messages", () => {
    const root = render({
      name: "worker-a",
      display: "worker-a",
      kind: "agent",
      owner: null,
      online: true,
      presence: null,
      messages: [
        msg({ seq: 1, senderName: "worker-a", body: "did the thing" }),
        msg({ seq: 2, senderName: "worker-b", body: "unrelated message from someone else" }),
      ],
      onClose: () => {},
    });
    const items = root.findAll((n) => n.props.className === "agent-detail-history-item");
    expect(items.length).toBe(1);
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("did the thing");
    expect(text).not.toContain("unrelated message from someone else");
  });

  test("shows online/offline badge based on the online prop", () => {
    const rootOnline = render({
      name: "worker-a", display: "worker-a", kind: "agent", owner: null, online: true,
      presence: null, messages: [], onClose: () => {},
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("在线");
    act(() => renderer!.unmount());
    renderer = null;

    const rootOffline = render({
      name: "worker-a", display: "worker-a", kind: "agent", owner: null, online: false,
      presence: null, messages: [], onClose: () => {},
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("离线");
  });

  test("Esc key closes the modal", () => {
    let closed = false;
    render({
      name: "worker-a", display: "worker-a", kind: "agent", owner: null, online: true,
      presence: null, messages: [], onClose: () => { closed = true; },
    });
    act(() => {
      pressEscape();
    });
    expect(closed).toBe(true);
  });

  test("clicking the scrim closes the modal", () => {
    let closed = false;
    const root = render({
      name: "worker-a", display: "worker-a", kind: "agent", owner: null, online: true,
      presence: null, messages: [], onClose: () => { closed = true; },
    });
    const scrim = root.find((n) => n.props.className === "channel-panel-scrim");
    act(() => scrim.props.onClick());
    expect(closed).toBe(true);
  });
});
