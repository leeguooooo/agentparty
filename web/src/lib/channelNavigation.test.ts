// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import type { MsgFrame } from "@agentparty/shared";
import {
  focusMessageNavigationTarget,
  planLoadedMessageNavigation,
  resolveMessageNavigationTarget,
} from "./channelNavigation";
import type { AgentFilter } from "./filters";

const all: AgentFilter = { mode: "only", agents: [], kind: null };
const aliceOnly: AgentFilter = { mode: "only", agents: ["alice"], kind: null };
const message = (seq: number, name = "alice"): MsgFrame => ({
  type: "msg",
  seq,
  sender: { name, kind: "agent" },
  kind: "message",
  body: `message ${seq}`,
  mentions: [],
  reply_to: null,
  state: null,
  note: null,
  status: null,
  ts: seq,
});

describe("loaded channel message navigation", () => {
  test("reports a target outside the loaded window instead of claiming success", () => {
    expect(planLoadedMessageNavigation({
      messages: [message(1)],
      seq: 99,
      agentFilter: all,
      completionOnly: false,
      desiredCompletionOnly: false,
    })).toEqual({ found: false });
  });

  test("temporarily clears an agent filter that hides the target", () => {
    expect(planLoadedMessageNavigation({
      messages: [message(2, "bob")],
      seq: 2,
      agentFilter: aliceOnly,
      completionOnly: false,
      desiredCompletionOnly: false,
    })).toMatchObject({
      found: true,
      clearAgentFilter: true,
      changeCompletionView: false,
      preserveCurrentView: true,
    });
  });

  test("leaves an already visible target and its filters untouched", () => {
    expect(planLoadedMessageNavigation({
      messages: [message(3)],
      seq: 3,
      agentFilter: aliceOnly,
      completionOnly: false,
      desiredCompletionOnly: false,
    })).toMatchObject({
      found: true,
      clearAgentFilter: false,
      changeCompletionView: false,
      preserveCurrentView: false,
    });
  });

  test("preserves the completion-only view when revealing a normal timeline target", () => {
    expect(planLoadedMessageNavigation({
      messages: [message(4)],
      seq: 4,
      agentFilter: all,
      completionOnly: true,
      desiredCompletionOnly: false,
    })).toMatchObject({
      found: true,
      changeCompletionView: true,
      preserveCurrentView: true,
    });
  });

  test("treats an explicit completion jump as a destination change, not a hidden-filter restore", () => {
    expect(planLoadedMessageNavigation({
      messages: [message(5)],
      seq: 5,
      agentFilter: all,
      completionOnly: false,
      desiredCompletionOnly: true,
    })).toMatchObject({
      found: true,
      changeCompletionView: true,
      preserveCurrentView: false,
    });
  });
});

describe("channel message navigation resolution", () => {
  test("loads an anchored window for an authoritative decision older than the local 300-message cap", async () => {
    const localWindow = Array.from({ length: 300 }, (_, index) => message(1_001 + index));
    const oldDecision = {
      ...message(7, "owner"),
      kind: "decision_request" as const,
    };
    const requested: number[] = [];

    const resolved = await resolveMessageNavigationTarget({
      messages: localWindow,
      seq: oldDecision.seq,
      loadAround: async (seq) => {
        requested.push(seq);
        return [message(6), oldDecision, message(8)];
      },
    });

    expect(requested).toEqual([7]);
    expect(resolved?.target).toEqual(oldDecision);
    expect(resolved?.messagesToMerge).toHaveLength(3);
  });

  test("does not fetch history when the target is already loaded", async () => {
    let fetches = 0;

    const resolved = await resolveMessageNavigationTarget({
      messages: [message(9)],
      seq: 9,
      loadAround: async () => {
        fetches += 1;
        return [];
      },
    });

    expect(fetches).toBe(0);
    expect(resolved?.target.seq).toBe(9);
    expect(resolved?.messagesToMerge).toEqual([]);
  });
});

describe("message navigation arrival", () => {
  test("scrolls, highlights, focuses, then announces the actual message", () => {
    const events: string[] = [];
    let removeHighlight: (() => void) | null = null;
    const classes = new Set<string>();

    focusMessageNavigationTarget(
      {
        scrollIntoView: (options) => events.push(`scroll:${options?.block}`),
        focus: (options) => events.push(`focus:${String(options?.preventScroll)}`),
        classList: {
          add: (token) => { classes.add(token); events.push(`add:${token}`); },
          remove: (token) => { classes.delete(token); events.push(`remove:${token}`); },
        },
      },
      () => events.push("announce"),
      (callback, delayMs) => {
        events.push(`schedule:${delayMs}`);
        removeHighlight = callback;
      },
    );

    expect(events).toEqual([
      "scroll:center",
      "add:msg-jump-highlight",
      "focus:true",
      "announce",
      "schedule:1200",
    ]);
    expect(classes.has("msg-jump-highlight")).toBe(true);
    removeHighlight?.();
    expect(classes.has("msg-jump-highlight")).toBe(false);
  });
});
