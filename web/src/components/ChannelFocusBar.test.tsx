// #682：ChannelFocusBar 渲染——三态视觉可区分、「在等你」高亮、无在途项则不渲染、下钻回调接线。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import type { ChannelFocus, FocusItem } from "../lib/channelFocus";
import type { PendingDecisionLoadState } from "../lib/pendingDecisions";
import { ChannelFocusBar } from "./ChannelFocusBar";

let renderer: ReactTestRenderer | null = null;

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

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = null;
});

function item(overrides: Partial<FocusItem> & { key: string }): FocusItem {
  return {
    name: "Evan",
    label: "真机跑单",
    state: "working",
    blockedOn: null,
    taskId: null,
    seq: null,
    waitingOnMe: false,
    stale: false,
    ...overrides,
  };
}

function focus(overrides: Partial<ChannelFocus> = {}): ChannelFocus {
  const items = overrides.items ?? [];
  return {
    focus: null,
    focusSource: null,
    items,
    waitingOnMe: items.filter((i) => i.waitingOnMe),
    counts: { working: 0, blocked: 0, waitingDecision: 0, stalled: 0 },
    empty: items.length === 0,
    ...overrides,
  };
}

function decisionState(
  overrides: Partial<PendingDecisionLoadState> = {},
): PendingDecisionLoadState {
  return {
    lastSuccessfulData: null,
    loading: false,
    error: null,
    ...overrides,
  };
}

function render(props: Parameters<typeof ChannelFocusBar>[0]) {
  localStorage.setItem("ap_locale", "en");
  act(() => {
    renderer = create(
      <LocaleProvider>
        <ChannelFocusBar {...props} />
      </LocaleProvider>,
    );
  });
}

function classNames(): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    const el = node as { props?: { className?: string }; children?: unknown[] };
    if (typeof el.props?.className === "string") out.push(el.props.className);
    if (Array.isArray(el.children)) el.children.forEach(walk);
  };
  const json = renderer!.toJSON();
  (Array.isArray(json) ? json : [json]).forEach(walk);
  return out;
}

describe("ChannelFocusBar (#682)", () => {
  test("renders nothing when nothing is in flight and there is no override", () => {
    render({ focus: focus() });
    expect(renderer!.toJSON()).toBeNull();
  });

  test("does not disguise the initial decision load as an empty focus bar", () => {
    render({
      focus: focus(),
      decisionState: decisionState({ loading: true }),
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Loading pending decisions");
  });

  test("shows a retry action when the first decision load fails", () => {
    let retries = 0;
    render({
      focus: focus(),
      decisionState: decisionState({ error: { kind: "load_failed" } }),
      onRetryDecisions: () => { retries += 1; },
    });

    const retry = renderer!.root.findByProps({ className: "d-btn focus-decision-retry" });
    act(() => retry.props.onClick());
    expect(retries).toBe(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("could not be loaded");
  });

  test("keeps stale decision counts visible beside a refresh failure", () => {
    render({
      focus: focus({
        items: [item({
          key: "decision-7",
          state: "waiting_decision",
          seq: 7,
          taskId: null,
        })],
        counts: { working: 0, blocked: 0, waitingDecision: 1, stalled: 0 },
      }),
      decisionState: decisionState({
        lastSuccessfulData: [{
          seq: 7,
          prompt: "ship?",
          asker: "alice",
          waitingOnMe: false,
        }],
        error: { kind: "load_failed" },
      }),
    });

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("focus-count--waiting_decision");
    expect(rendered).toContain("last successful result");
  });

  test("shows forbidden ahead of stale data and does not offer a meaningless retry", () => {
    render({
      focus: focus(),
      decisionState: decisionState({
        lastSuccessfulData: [{
          seq: 7,
          prompt: "ship?",
          asker: "alice",
          waitingOnMe: false,
        }],
        error: { kind: "forbidden" },
      }),
      onRetryDecisions: () => {
        throw new Error("forbidden decisions must not be retried");
      },
    });

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("not available to this account");
    expect(rendered).not.toContain("last successful result");
    expect(renderer!.root.findAllByProps({ className: "d-btn focus-decision-retry" })).toHaveLength(0);
  });

  test("still renders nothing after a successful genuinely empty decision result", () => {
    render({
      focus: focus(),
      decisionState: decisionState({ lastSuccessfulData: [] }),
    });
    expect(renderer!.toJSON()).toBeNull();
  });

  // 紧凑内联版（用户要求「硬两行、永不折」）：非「在等你」的在途项不再逐条铺开，而是压进定宽计数丸——
  // 每个非零状态段各带本态语气色圆点，保留「三态视觉可区分」的原契约。
  test("summarizes non-waiting states as a distinct-per-state counts pill", () => {
    render({
      focus: focus({
        items: [
          item({ key: "a", name: "Evan", state: "working" }),
          item({ key: "b", name: "kw", state: "blocked", blockedOn: "等结果", label: "x" }),
          item({ key: "c", name: "front", state: "waiting_decision", label: "prod A/B?", seq: 9 }),
          item({ key: "d", name: "ghost", state: "stalled", stale: true }),
        ],
        counts: { working: 1, blocked: 1, waitingDecision: 1, stalled: 1 },
      }),
    });
    const cls = classNames().join(" ");
    // 计数丸按状态分段，各段带本态类 + 本态色圆点。
    expect(cls).toContain("focus-count--working");
    expect(cls).toContain("focus-count--blocked");
    expect(cls).toContain("focus-count--waiting_decision");
    expect(cls).toContain("focus-count--stalled");
    expect(cls).toContain("focus-dot--working");
    expect(cls).toContain("focus-dot--blocked");
    expect(cls).toContain("focus-dot--waiting_decision");
    expect(cls).toContain("focus-dot--stalled");
  });

  test("zero-count states are omitted from the counts pill", () => {
    render({
      focus: focus({
        items: [item({ key: "a", name: "Evan", state: "working" })],
        counts: { working: 1, blocked: 0, waitingDecision: 0, stalled: 0 },
      }),
    });
    const cls = classNames().join(" ");
    expect(cls).toContain("focus-count--working");
    expect(cls).not.toContain("focus-count--blocked");
    expect(cls).not.toContain("focus-count--stalled");
  });

  // 「在等你」是 owner 最关心的一类，仍逐条展开成高亮 chip（含阻塞原因），不折进计数丸。
  test("expands a waiting-on-you item as a highlighted chip with its blocked reason", () => {
    render({
      focus: focus({
        items: [item({ key: "b", name: "kw", state: "blocked", blockedOn: "等 KycFeign 结果", label: "x", waitingOnMe: true })],
        counts: { working: 0, blocked: 1, waitingDecision: 0, stalled: 0 },
      }),
      viewerIsModerator: true,
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("等 KycFeign 结果");
  });

  // 「在等你」封顶两个，其余折成 +N 溢出计数，点开进任务台账。
  test("caps waiting-on-you chips at two and shows a +N overflow", () => {
    const opened: number[] = [];
    const mine = [1, 2, 3, 4].map((n) =>
      item({ key: `d${n}`, name: `front${n}`, state: "waiting_decision", label: "approve", seq: n, waitingOnMe: true }),
    );
    render({
      focus: focus({ items: mine, counts: { working: 0, blocked: 0, waitingDecision: 4, stalled: 0 } }),
      viewerIsModerator: true,
      onOpenOverview: () => opened.push(1),
    });
    // 只展开前两个 chip，其余折成 +N（4 - 2 = 2）。
    const chips = renderer!.root.findAll(
      (n) => typeof n.props.className === "string" && n.props.className.includes("focus-item--me"),
    );
    expect(chips.length).toBe(2);
    const overflow = renderer!.root.findAll(
      (n) => typeof n.props.className === "string" && n.props.className.includes("focus-more"),
    )[0];
    expect(overflow!.props.children).toEqual(["+", 2]);
    act(() => { overflow!.props.onClick(); });
    expect(opened.length).toBe(1);
  });

  test("highlights the 'waiting on you' block for owner/moderator", () => {
    const me = item({ key: "d", name: "front", state: "waiting_decision", label: "approve prod", seq: 5, waitingOnMe: true });
    render({ focus: focus({ items: [me], counts: { working: 0, blocked: 0, waitingDecision: 1, stalled: 0 } }), viewerIsModerator: true });
    const cls = classNames().join(" ");
    expect(cls).toContain("focus-me");
    expect(cls).toContain("focus-item--me");
    // moderator wording
    expect(JSON.stringify(renderer!.toJSON())).toContain("needs your call");
  });

  // 下钻只从展开的「在等你」chip 触发（其余项已折进计数丸）：task 派生项 → onOpenTask，decision 派生项 → onJumpSeq。
  test("wires waiting-on-you task drill-down to onOpenTask and decision drill-down to onJumpSeq", () => {
    const openedTasks: number[] = [];
    const jumped: number[] = [];
    render({
      focus: focus({
        items: [
          item({ key: "task-3", name: "me", state: "blocked", taskId: 3, waitingOnMe: true }),
          item({ key: "decision-9", name: "front", state: "waiting_decision", label: "d", seq: 9, waitingOnMe: true }),
        ],
        counts: { working: 0, blocked: 1, waitingDecision: 1, stalled: 0 },
      }),
      onOpenTask: (id) => openedTasks.push(id),
      onJumpSeq: (seq) => jumped.push(seq),
    });
    // 两个 chip 的下钻按钮 + 计数丸按钮都可点；chip 按 items 顺序在前。
    const drills = renderer!.root.findAll(
      (n) => typeof n.props.className === "string" && n.props.className.includes("focus-item-btn"),
    );
    expect(drills.length).toBe(2);
    act(() => { drills[0]!.props.onClick(); });
    act(() => { drills[1]!.props.onClick(); });
    expect(openedTasks).toEqual([3]);
    expect(jumped).toEqual([9]);
  });

  test("counts pill opens the mixed focus overview instead of inventing a task destination", () => {
    let opened = 0;
    render({
      focus: focus({
        items: [item({ key: "decision-9", name: "Evan", state: "waiting_decision", seq: 9 })],
        counts: { working: 0, blocked: 0, waitingDecision: 1, stalled: 0 },
      }),
      onOpenOverview: () => { opened += 1; },
    });
    const pill = renderer!.root.findAll(
      (n) => typeof n.props.className === "string" && n.props.className.includes("focus-counts--btn"),
    )[0];
    act(() => { pill!.props.onClick(); });
    expect(opened).toBe(1);
  });

  test("shows a manual focus line when host set an override even with no items", () => {
    render({ focus: focus({ focus: "结果查询 + 上传端到端联调", focusSource: "manual" }) });
    expect(renderer!.toJSON()).not.toBeNull();
    expect(JSON.stringify(renderer!.toJSON())).toContain("结果查询 + 上传端到端联调");
  });
});
