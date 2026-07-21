// #662：owner 视角的过时 CLI 汇总提醒。bun react-test-renderer 无 window，useMinClientVersion 恒 null，
// 故用 minVersion prop 注入服务端最低版本，覆盖「只列过时 + 只列本 owner」「min 未知不渲染」「边界不误报」「关闭即隐藏」。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { PresenceEntry } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { OutdatedAgentsNotice } from "./OutdatedAgentsNotice";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  // 每个用例独立的 sessionStorage 存根，避免「已忽略」跨用例串味。
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    },
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function entry(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "working", note: null, ts: 1, ...over } as PresenceEntry;
}

function render(props: React.ComponentProps<typeof OutdatedAgentsNotice>): ReactTestInstance {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <OutdatedAgentsNotice {...props} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function byClass(root: ReactTestInstance, cls: string): ReactTestInstance[] {
  return root.findAll((n) => String(n.props.className ?? "").split(/\s+/).includes(cls));
}

function labels(root: ReactTestInstance): string[] {
  return byClass(root, "outdated-agents-notice-name").map((n) => n.children.filter((c): c is string => typeof c === "string").join(""));
}

const MINE = "me@corp.dev";
const OTHER = "someone@else.dev";

// 混合版本 + 混合归属：只有「我名下 + 过时」的 agent 该被列出。
const mixedPresence: Record<string, PresenceEntry> = {
  planner: entry({ name: "planner", kind: "agent", account: MINE, client_version: "0.2.100" }), // 我的、过时 → 列
  builder: entry({ name: "builder", kind: "agent", account: MINE, client_version: "0.3.5" }), // 我的、够新 → 不列
  edge: entry({ name: "edge", kind: "agent", account: MINE, client_version: "0.3.0" }), // 我的、恰等 min → 不列（边界）
  scout: entry({ name: "scout", kind: "agent", account: OTHER, client_version: "0.1.0" }), // 别人的、过时 → 不列
  human: entry({ name: "human", kind: "human", account: MINE, client_version: "0.1.0" }), // 我的人类会话 → 排除
  nover: entry({ name: "nover", kind: "agent", account: MINE }), // 我的、无版本（未知）→ 不误报
};

test("只列出本 owner 名下且过时的 agent（边界等于 min 不算过时）", () => {
  const root = render({ presence: mixedPresence, accountKey: MINE, minVersion: "0.3.0" });
  expect(labels(root)).toEqual(["planner"]);
  // 计数标注也应为 1。
  expect(byClass(root, "outdated-agents-notice")[0]!.props["data-outdated-count"]).toBe(1);
});

test("min 未知（离线/拿不到 /api/version）→ 不渲染", () => {
  const root = render({ presence: mixedPresence, accountKey: MINE, minVersion: null });
  expect(root.findAllByType("div")).toHaveLength(0);
});

test("accountKey 为空 → 不渲染", () => {
  const root = render({ presence: mixedPresence, accountKey: null, minVersion: "0.3.0" });
  expect(root.findAllByType("div")).toHaveLength(0);
});

test("无过时 agent → 不渲染", () => {
  const fresh: Record<string, PresenceEntry> = {
    builder: entry({ name: "builder", kind: "agent", account: MINE, client_version: "0.3.5" }),
  };
  const root = render({ presence: fresh, accountKey: MINE, minVersion: "0.3.0" });
  expect(root.findAllByType("div")).toHaveLength(0);
});

test("点关闭后即隐藏（本会话不再骚扰）", () => {
  const root = render({ presence: mixedPresence, accountKey: MINE, minVersion: "0.3.0" });
  expect(labels(root).length).toBe(1);
  act(() => byClass(root, "outdated-agents-notice-dismiss")[0]!.props.onClick());
  expect(root.findAllByType("div")).toHaveLength(0);
});

test("dismissal 按 min 独立记忆：关掉 0.3.0 后升到 0.4.0 仍提示，回退 0.3.0 不再骚扰（#670）", () => {
  // 关掉当前 min=0.3.0
  let root = render({ presence: mixedPresence, accountKey: MINE, minVersion: "0.3.0" });
  expect(labels(root).length).toBe(1);
  act(() => byClass(root, "outdated-agents-notice-dismiss")[0]!.props.onClick());
  expect(root.findAllByType("div")).toHaveLength(0);
  // 服务端升到新 min=0.4.0：这是不同版本，应重新提示（不被 0.3.0 的忽略顶掉）。
  root = render({ presence: mixedPresence, accountKey: MINE, minVersion: "0.4.0" });
  expect(labels(root).length).toBeGreaterThan(0);
  act(() => byClass(root, "outdated-agents-notice-dismiss")[0]!.props.onClick());
  expect(root.findAllByType("div")).toHaveLength(0);
  // 服务端回退到曾被忽略的 0.3.0：不再提示（每个 min 的忽略独立持久）。
  root = render({ presence: mixedPresence, accountKey: MINE, minVersion: "0.3.0" });
  expect(root.findAllByType("div")).toHaveLength(0);
});

test("每个过时 agent 有升级 CTA，点击回调带 agent name", () => {
  const opened: string[] = [];
  const root = render({ presence: mixedPresence, accountKey: MINE, minVersion: "0.3.0", onUpgrade: (name) => opened.push(name) });
  act(() => byClass(root, "outdated-agents-notice-upgrade")[0]!.props.onClick());
  expect(opened).toEqual(["planner"]);
});
