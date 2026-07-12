// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";

const savedAgents: Array<{ name: string; token: string }> = [];

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ConflictError: class ConflictError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  ValidationError: class ValidationError extends Error {},
  createChannelAgent: mock(async (_slug: string, name: string) => ({ name, token: "ap_created" })),
}));

mock.module("../lib/agentTokenVault", () => ({
  copyText: async () => true,
  saveAgentToken: (record: { name: string; token: string }) => savedAgents.push(record),
}));

const { AgentJoin } = await import("./AgentJoin");

class TestEventTarget {
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

let renderer: ReactTestRenderer | null = null;
let windowEvents: TestEventTarget;

beforeEach(() => {
  savedAgents.length = 0;
  windowEvents = new TestEventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://party.test" } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "location");
});

function render(onActiveChange?: (open: boolean) => void): ReactTestRenderer {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <AgentJoin
          slug="demo"
          token="owner-token"
          namePrefix="leo"
          inviterName="host"
          charter={null}
          accountKey="acct-1"
          onActiveChange={onActiveChange}
        />
      </LocaleProvider>,
    );
  });
  return renderer as ReactTestRenderer;
}

function open(r: ReactTestRenderer) {
  act(() => r.root.find((node) => node.props.className === "d-btn d-btn--primary agent-join-btn").props.onClick());
}

describe("AgentJoin dismiss behavior", () => {
  test("Escape closes the compose dialog, reports controlled state, and removes its listener", () => {
    const changes: boolean[] = [];
    const r = render((value) => changes.push(value));
    open(r);

    const dialog = r.root.find((node) => node.props.role === "dialog");
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(windowEvents.count("keydown")).toBe(1);

    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(changes).toEqual([true, false]);
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
    expect(windowEvents.count("keydown")).toBe(0);
  });

  test("scrim closes but clicking the card itself has no dismiss handler", () => {
    const r = render();
    open(r);
    const card = r.root.find((node) => node.props.className === "d-card agent-join-card");
    expect(card.props.onClick).toBeUndefined();

    act(() => r.root.find((node) => node.props.className === "agent-join-scrim").props.onClick());
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
  });

  test("Escape closes the completed dialog without undoing the saved agent token", async () => {
    const r = render();
    open(r);
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });
    expect(savedAgents.map(({ name, token }) => ({ name, token }))).toEqual([{ name: "leo-demo", token: "ap_created" }]);

    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
    expect(savedAgents.map(({ name, token }) => ({ name, token }))).toEqual([{ name: "leo-demo", token: "ap_created" }]);

    open(r);
    const input = r.root.find((node) => node.props.className === "t-mono agent-join-nameinput");
    expect(input.props.value).toBe("leo-demo");
  });
});
