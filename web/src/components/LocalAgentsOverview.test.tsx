// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { DesktopSettingsStrings } from "../i18n/strings/DesktopSettings";
import { LocalAgentsOverviewStrings } from "../i18n/strings/LocalAgentsOverview";
import type { DesktopAgentAdapter, DesktopAgentStatus, DesktopDutyEntry } from "../lib/desktopAgent";
import { LocalAgentsOverview } from "./LocalAgentsOverview";
import type { DesktopAgentScheduler } from "./DesktopAgentPanel";

const merged: Record<string, string> = { ...DesktopSettingsStrings.en, ...LocalAgentsOverviewStrings.en };
const t = (key: string, vars?: Record<string, string | number>) => {
  const raw = merged[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : raw;
};
const noScheduler: DesktopAgentScheduler = { every: () => () => {} };

function inst(over: Partial<DesktopAgentStatus>): DesktopAgentStatus {
  return {
    state: "running", pid: 1, configId: "cfg", name: "planner", channel: "ops", runner: "codex",
    startedAt: null, exitCode: null, lastError: null, instanceId: "cfg:ops", workdir: null, repo: null, ...over,
  };
}
function duty(over: Partial<DesktopDutyEntry>): DesktopDutyEntry {
  return { label: "l", instanceId: "cfg:ops", plistPath: "/p", logPath: "/log", loaded: true, ...over };
}

function adapter(over: Partial<DesktopAgentAdapter> = {}): DesktopAgentAdapter {
  return {
    listConfigs: async () => [],
    status: async () => inst({ state: "stopped", instanceId: null }),
    statusAll: async () => [],
    start: async () => inst({}),
    stop: async () => inst({ state: "stopped" }),
    stopInstance: async () => inst({ state: "stopped" }),
    logs: async () => [],
    logsInstance: async () => [],
    dutyList: async () => [],
    dutyPersist: async () => { throw new Error("na"); },
    dutyUnpersist: async () => {},
    dutyAdopt: async () => { throw new Error("na"); },
    dutyLogRead: async () => "",
    ...over,
  };
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "en", setItem: () => {}, removeItem: () => {} },
  });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

async function render(a: DesktopAgentAdapter, scopeChannel?: string | null): Promise<ReactTestInstance> {
  await act(async () => {
    renderer = create(
      <LocaleProvider>
        <LocalAgentsOverview t={t} adapter={a} scheduler={noScheduler} scopeChannel={scopeChannel ?? null} />
      </LocaleProvider>,
    );
  });
  // flush the mount refresh() microtasks
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return renderer!.root;
}

function byClass(root: ReactTestInstance, cls: string): ReactTestInstance[] {
  return root.findAll((n) => String(n.props.className ?? "").split(/\s+/).includes(cls));
}
function groupLabels(root: ReactTestInstance): string[] {
  return byClass(root, "local-agents-group").map((g) => String(g.props["aria-label"]));
}
function names(root: ReactTestInstance): string[] {
  return byClass(root, "local-agents-name").map((n) => n.children.filter((c): c is string => typeof c === "string").join(""));
}

test("按频道分组渲染 app 实例 + 常驻，未分配排最后", async () => {
  const root = await render(adapter({
    statusAll: async () => [
      inst({ name: "web-planner", channel: "web", instanceId: "a:web" }),
      inst({ name: "ops-builder", channel: "ops", instanceId: "b:ops" }),
      inst({ name: "orphan", channel: null, instanceId: null, configId: "o" }),
    ],
    dutyList: async () => [duty({ instanceId: "c:ops", loaded: true })],
  }));
  // 频道升序 + 未分配(unassigned)最后
  expect(groupLabels(root)).toEqual(["ops", "web", "unassigned"]);
  // ops 组内常驻(c)在实例(ops-builder)前
  const opsGroup = byClass(root, "local-agents-group")[0]!;
  expect(byClass(opsGroup, "local-agents-name").map((n) => n.children.join(""))).toEqual(["c", "ops-builder"]);
});

test("检索按频道/身份/runner/状态过滤", async () => {
  const root = await render(adapter({
    statusAll: async () => [
      inst({ name: "planner", channel: "ops", runner: "codex", instanceId: "a:ops" }),
      inst({ name: "builder", channel: "web", runner: "claude", state: "failed", instanceId: "b:web" }),
    ],
  }));
  expect(names(root).sort()).toEqual(["builder", "planner"]);
  const search = root.find((n) => n.props.className?.includes?.("local-agents-search"));
  await act(async () => { search.props.onChange({ target: { value: "claude" } }); });
  expect(names(root)).toEqual(["builder"]);
  await act(async () => { search.props.onChange({ target: { value: "ops" } }); });
  expect(names(root)).toEqual(["planner"]);
});

test("scopeChannel 预过滤到当前频道（频道页唤起）", async () => {
  const root = await render(adapter({
    statusAll: async () => [
      inst({ name: "planner", channel: "ops", instanceId: "a:ops" }),
      inst({ name: "builder", channel: "web", instanceId: "b:web" }),
    ],
  }), "web");
  expect(groupLabels(root)).toEqual(["web"]);
  expect(names(root)).toEqual(["builder"]);
});

test("statusAll 与 dutyList 都不可用 → 显示不可用文案", async () => {
  const root = await render(adapter({
    statusAll: async () => { throw new Error("na"); },
    status: async () => { throw new Error("na"); },
    dutyList: async () => { throw new Error("na"); },
  }));
  expect(byClass(root, "local-agents-empty")[0]!.children.join("")).toBe(LocalAgentsOverviewStrings.en["LocalAgents.unavailable"]);
});

test("停止活跃实例调 stopInstance；卸载常驻调 dutyUnpersist", async () => {
  const stopped: string[] = [];
  const unloaded: string[] = [];
  const root = await render(adapter({
    statusAll: async () => [inst({ name: "planner", channel: "ops", state: "running", instanceId: "a:ops" })],
    dutyList: async () => [duty({ instanceId: "d:ops", loaded: true })],
    stopInstance: async (id) => { stopped.push(id); return inst({ state: "stopped" }); },
    dutyUnpersist: async (id) => { unloaded.push(id); },
  }));
  await act(async () => { byClass(root, "local-agents-stop")[0]!.props.onClick(); await Promise.resolve(); });
  await act(async () => { byClass(root, "local-agents-unload")[0]!.props.onClick(); await Promise.resolve(); });
  expect(stopped).toEqual(["a:ops"]);
  expect(unloaded).toEqual(["d:ops"]);
});
