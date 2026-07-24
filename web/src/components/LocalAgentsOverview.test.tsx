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
  let instances = [inst({ name: "planner", channel: "ops", state: "running", instanceId: "a:ops" })];
  const root = await render(adapter({
    statusAll: async () => instances,
    dutyList: async () => [duty({ instanceId: "d:ops", loaded: true })],
    stopInstance: async (id) => {
      stopped.push(id);
      instances = [];
      return inst({ state: "stopped", instanceId: id });
    },
    dutyUnpersist: async (id) => { unloaded.push(id); },
  }));
  await act(async () => {
    byClass(root, "local-agents-stop")[0]!.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(byClass(root, "local-agents-stop")).toHaveLength(0);
  await act(async () => { byClass(root, "local-agents-unload")[0]!.props.onClick(); await Promise.resolve(); });
  expect(stopped).toEqual(["a:ops"]);
  expect(unloaded).toEqual(["d:ops"]);
});

test("旧常驻 job 显示依赖诊断，并用原 runner/workdir/repo 一键修复", async () => {
  const persisted: unknown[] = [];
  let entries = [duty({
    instanceId: "cfg:ops",
    runner: "codex",
    workdir: "/workspace",
    repo: "https://example.com/repo.git",
    runnerExecutable: "/Users/leo/.local/bin/codex",
    dependencyState: "repair-required",
  })];
  const root = await render(adapter({
    dutyList: async () => entries,
    dutyPersist: async (input) => {
      persisted.push(input);
      entries = [duty({
        ...entries[0],
        runner: "codex",
        dependencyState: "ready",
      })];
      return entries[0]!;
    },
  }));

  expect(JSON.stringify(renderer!.toJSON())).toContain("still relies on launchd PATH");
  await act(async () => {
    byClass(root, "local-agents-repair")[0]!.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(persisted).toEqual([{
    configId: "cfg",
    channel: "ops",
    runner: "codex",
    workdir: "/workspace",
    repo: "https://example.com/repo.git",
  }]);
  expect(byClass(root, "local-agents-repair")).toHaveLength(0);
});

test("缺少 runner 时显示安装指引，修复失败不会退化成原始日志", async () => {
  const root = await render(adapter({
    dutyList: async () => [duty({
      instanceId: "cfg:ops",
      runner: "claude",
      dependencyState: "missing",
    })],
    dutyPersist: async () => {
      throw new Error("runner_dependency_missing:claude: internal search detail");
    },
  }));

  expect(JSON.stringify(renderer!.toJSON())).toContain("Install the CLI, then choose Repair");
  await act(async () => {
    byClass(root, "local-agents-repair")[0]!.props.onClick();
    await Promise.resolve();
  });
  const rendered = JSON.stringify(renderer!.toJSON());
  expect(rendered).toContain("claude CLI is unavailable");
  expect(rendered).not.toContain("internal search detail");
});

test("切走期间动作完成会清 busy，且不在隐藏模块里追加刷新", async () => {
  let finishStop!: (value: DesktopAgentStatus) => void;
  const stopPromise = new Promise<DesktopAgentStatus>((resolve) => { finishStop = resolve; });
  let statusLoads = 0;
  const adapterValue = adapter({
    statusAll: async () => {
      statusLoads += 1;
      return [inst({ name: "planner", channel: "ops", instanceId: "a:ops" })];
    },
    stopInstance: async () => stopPromise,
  });

  const root = await render(adapterValue);
  await act(async () => {
    byClass(root, "local-agents-stop")[0]!.props.onClick();
  });
  expect(byClass(root, "local-agents-stop")[0]!.props.disabled).toBe(true);

  await act(async () => {
    renderer!.update(
      <LocaleProvider>
        <LocalAgentsOverview active={false} t={t} adapter={adapterValue} scheduler={noScheduler} />
      </LocaleProvider>,
    );
  });
  await act(async () => {
    finishStop(inst({ state: "stopped", instanceId: "a:ops" }));
    await stopPromise;
  });
  expect(statusLoads).toBe(1);

  await act(async () => {
    renderer!.update(
      <LocaleProvider>
        <LocalAgentsOverview active t={t} adapter={adapterValue} scheduler={noScheduler} />
      </LocaleProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(statusLoads).toBe(2);
  expect(byClass(renderer!.root, "local-agents-stop")[0]!.props.disabled).toBe(false);
});
