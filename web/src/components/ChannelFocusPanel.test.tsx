// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import type { ChannelFocus, FocusItem } from "../lib/channelFocus";
import type { PendingDecisionLoadState } from "../lib/pendingDecisions";
import { ChannelFocusPanel } from "./ChannelFocusPanel";

let renderer: ReactTestRenderer | null = null;

const item = (overrides: Partial<FocusItem>): FocusItem => ({
  key: "task-7",
  name: "alice",
  label: "ship the release",
  state: "working",
  blockedOn: null,
  taskId: 7,
  seq: null,
  waitingOnMe: false,
  stale: false,
  ...overrides,
});

const focus = (items: FocusItem[]): ChannelFocus => ({
  focus: null,
  focusSource: null,
  items,
  waitingOnMe: items.filter((entry) => entry.waitingOnMe),
  counts: {
    working: items.filter((entry) => entry.state === "working").length,
    blocked: items.filter((entry) => entry.state === "blocked").length,
    waitingDecision: items.filter((entry) => entry.state === "waiting_decision").length,
    stalled: items.filter((entry) => entry.state === "stalled").length,
  },
  empty: items.length === 0,
});

const decisionState = (
  overrides: Partial<PendingDecisionLoadState> = {},
): PendingDecisionLoadState => ({
  lastSuccessfulData: null,
  loading: false,
  error: null,
  ...overrides,
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer!.unmount());
    renderer = null;
  }
});

describe("ChannelFocusPanel", () => {
  test("routes each row to its real destination", () => {
    const tasks: number[] = [];
    const messages: number[] = [];
    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelFocusPanel
            focus={focus([
              item({}),
              item({
                key: "decision-12",
                taskId: null,
                seq: 12,
                state: "waiting_decision",
                label: "approve production",
              }),
              item({ key: "presence-bob", name: "bob", taskId: null, seq: null }),
            ])}
            onOpenTask={(id) => tasks.push(id)}
            onJumpSeq={(seq) => messages.push(seq)}
          />
        </LocaleProvider>,
      );
    });

    const actions = renderer!.root.findAllByType("button");
    expect(actions).toHaveLength(2);
    act(() => actions[0]!.props.onClick());
    act(() => actions[1]!.props.onClick());
    expect(tasks).toEqual([7]);
    expect(messages).toEqual([12]);
  });

  test("renders a real empty state instead of opening the task board", () => {
    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelFocusPanel focus={focus([])} onOpenTask={() => {}} onJumpSeq={() => {}} />
        </LocaleProvider>,
      );
    });
    expect(renderer!.root.findByProps({ className: "d-empty" }).props.children).toBeTruthy();
  });

  test("shows initial loading without claiming the focus list is empty", () => {
    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelFocusPanel
            focus={focus([])}
            decisionState={decisionState({ loading: true })}
            onOpenTask={() => {}}
            onJumpSeq={() => {}}
          />
        </LocaleProvider>,
      );
    });

    expect(renderer!.root.findAllByProps({ className: "d-empty" })).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Loading pending decisions");
  });

  test("shows an initial failure and retries without invoking a row action", () => {
    let retries = 0;
    let jumps = 0;
    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelFocusPanel
            focus={focus([])}
            decisionState={decisionState({ error: { kind: "load_failed" } })}
            onRetryDecisions={() => { retries += 1; }}
            onOpenTask={() => {}}
            onJumpSeq={() => { jumps += 1; }}
          />
        </LocaleProvider>,
      );
    });

    const retry = renderer!.root.findByProps({ className: "d-btn focus-decision-retry" });
    act(() => retry.props.onClick());
    expect(retries).toBe(1);
    expect(jumps).toBe(0);
    expect(renderer!.root.findAllByProps({ className: "d-empty" })).toHaveLength(0);
  });

  test("keeps the last successful decision row visible after a refresh failure", () => {
    const decision = item({
      key: "decision-12",
      taskId: null,
      seq: 12,
      state: "waiting_decision",
      label: "approve production",
    });
    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelFocusPanel
            focus={focus([decision])}
            decisionState={decisionState({
              lastSuccessfulData: [{
                seq: 12,
                prompt: "approve production",
                asker: "alice",
                waitingOnMe: false,
              }],
              error: { kind: "load_failed" },
            })}
            onRetryDecisions={() => {}}
            onOpenTask={() => {}}
            onJumpSeq={() => {}}
          />
        </LocaleProvider>,
      );
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("approve production");
    expect(JSON.stringify(renderer!.toJSON())).toContain("last successful result");
    expect(renderer!.root.findAllByType("button")).toHaveLength(2);
  });
});
