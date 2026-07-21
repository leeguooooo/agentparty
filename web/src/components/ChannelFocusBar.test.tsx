// #682：ChannelFocusBar 渲染——三态视觉可区分、「在等你」高亮、无在途项则不渲染、下钻回调接线。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import type { ChannelFocus, FocusItem } from "../lib/channelFocus";
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

  test("renders the three states with visually distinct modifier classes", () => {
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
    expect(cls).toContain("focus-item--working");
    expect(cls).toContain("focus-item--blocked");
    expect(cls).toContain("focus-item--waiting_decision");
    expect(cls).toContain("focus-item--stalled");
    // distinct dots per state
    expect(cls).toContain("focus-dot--working");
    expect(cls).toContain("focus-dot--blocked");
    expect(cls).toContain("focus-dot--waiting_decision");
    expect(cls).toContain("focus-dot--stalled");
  });

  test("blocked item shows the blocked reason inline", () => {
    render({ focus: focus({ items: [item({ key: "b", state: "blocked", blockedOn: "等 KycFeign 结果", label: "x" })] }) });
    expect(JSON.stringify(renderer!.toJSON())).toContain("等 KycFeign 结果");
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

  test("wires task drill-down to onOpenTask and decision drill-down to onJumpSeq", () => {
    const openedTasks: number[] = [];
    const jumped: number[] = [];
    render({
      focus: focus({
        items: [
          item({ key: "task-3", state: "working", taskId: 3 }),
          item({ key: "decision-9", name: "front", state: "waiting_decision", label: "d", seq: 9 }),
        ],
      }),
      onOpenTask: (id) => openedTasks.push(id),
      onJumpSeq: (seq) => jumped.push(seq),
    });
    // find the two drill buttons and click them
    const buttons = renderer!.root.findAllByType("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    act(() => { buttons[0]!.props.onClick(); });
    act(() => { buttons[1]!.props.onClick(); });
    expect(openedTasks).toEqual([3]);
    expect(jumped).toEqual([9]);
  });

  test("shows a manual focus line when host set an override even with no items", () => {
    render({ focus: focus({ focus: "结果查询 + 上传端到端联调", focusSource: "manual" }) });
    expect(renderer!.toJSON()).not.toBeNull();
    expect(JSON.stringify(renderer!.toJSON())).toContain("结果查询 + 上传端到端联调");
  });
});
