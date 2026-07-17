// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { DesktopSettingsStrings } from "../i18n/strings/DesktopSettings";
import type {
  DesktopAgentAdapter,
  DesktopAgentConfig,
  DesktopAgentStartInput,
  DesktopAgentStatus,
} from "../lib/desktopAgent";
import { DesktopAgentPanel, type DesktopAgentScheduler } from "./DesktopAgentPanel";

const config: DesktopAgentConfig = {
  configId: "local-main",
  name: "Leo Codex",
  serverOrigin: "https://party.example.com",
  channel: "agentparty",
  kind: "project",
  role: "worker",
};

const stopped: DesktopAgentStatus = {
  state: "stopped",
  pid: null,
  configId: null,
  name: null,
  channel: null,
  runner: null,
  startedAt: null,
  exitCode: null,
  lastError: null,
  instanceId: null,
  workdir: null,
  repo: null,
};

function adapter(overrides: Partial<DesktopAgentAdapter> = {}): DesktopAgentAdapter {
  return {
    listConfigs: async () => [config],
    status: async () => stopped,
    // 默认模拟旧 shell：statusAll 不存在 → 面板走单实例回退路径（存量用例语义不变）。
    statusAll: async () => {
      throw new Error("desktop_agent_status_all is not available");
    },
    start: async () => ({ ...stopped, state: "running", pid: 42 }),
    stop: async () => stopped,
    stopInstance: async () => stopped,
    logs: async () => [],
    logsInstance: async () => [],
    dutyList: async () => [],
    dutyPersist: async () => {
      throw new Error("duty persist unavailable");
    },
    dutyUnpersist: async () => {},
    dutyAdopt: async () => {
      throw new Error("duty adopt unavailable");
    },
    ...overrides,
  };
}

let renderer: ReactTestRenderer | null = null;
const t = (key: string) => DesktopSettingsStrings.en[key] ?? key;

async function render(adapterValue: DesktopAgentAdapter, scheduler?: DesktopAgentScheduler) {
  await act(async () => {
    renderer = create(
      <LocaleProvider>
        <DesktopAgentPanel adapter={adapterValue} scheduler={scheduler} t={t} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function button(label: string) {
  return renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === label);
}

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

// #616：statusAll 可用（新 shell）时的多实例路径
describe("DesktopAgentPanel 多实例 (#616)", () => {
  const running: DesktopAgentStatus = {
    ...stopped,
    state: "running",
    pid: 41,
    configId: "local-main",
    name: "Leo Codex",
    channel: "agentparty",
    runner: "codex",
    startedAt: 100,
    instanceId: "local-main:agentparty",
    workdir: "/srv/duty",
  };
  const failed: DesktopAgentStatus = {
    ...stopped,
    state: "failed",
    configId: "local-main",
    name: "Leo Codex",
    channel: "ops",
    runner: "claude",
    startedAt: 90,
    instanceId: "local-main:ops",
    lastError: "party sidecar exited with code 1",
  };

  test("渲染实例列表：每行状态/身份/workdir，活跃行有停止按钮并调 stopInstance", async () => {
    const stops: string[] = [];
    const root = await render(adapter({
      statusAll: async () => [running, failed],
      stopInstance: async (instanceId: string) => {
        stops.push(instanceId);
        return { ...running, state: "stopped", pid: null };
      },
    }));

    const list = root.find((node) => node.props["aria-label"] === "Duty instances");
    expect(list.findAllByType("li")).toHaveLength(2);
    expect(JSON.stringify(renderer!.toJSON())).toContain("/srv/duty");

    const stopButton = button("Stop local-main:agentparty");
    expect(root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Stop local-main:ops")).toHaveLength(0);
    await act(async () => {
      await stopButton.props.onClick();
    });
    expect(stops).toEqual(["local-main:agentparty"]);
  });

  test("start 透传 workdir/repo；同键实例活跃时禁用启动", async () => {
    const starts: DesktopAgentStartInput[] = [];
    const root = await render(adapter({
      statusAll: async () => [failed],
      start: async (input: DesktopAgentStartInput) => {
        starts.push(input);
        return running;
      },
    }));

    const workdirInput = root.find((node) => node.props.name === "desktop-agent-workdir");
    const repoInput = root.find((node) => node.props.name === "desktop-agent-repo");
    await act(async () => {
      workdirInput.props.onChange({ target: { value: "/srv/duty" } });
      repoInput.props.onChange({ target: { value: "https://github.com/org/repo.git" } });
    });
    await act(async () => {
      await button("Start local agent").props.onClick();
    });
    // 初始选中值来自 primary（failed 行：#ops / claude）——断言透传的正是表单当前值。
    expect(starts).toEqual([
      {
        configId: "local-main",
        channel: "ops",
        runner: "claude",
        workdir: "/srv/duty",
        repo: "https://github.com/org/repo.git",
      },
    ]);
  });

  test("同键实例活跃时启动按钮禁用，但可以为其它频道再起实例", async () => {
    const root = await render(adapter({ statusAll: async () => [running] }));
    // 预填频道 = running 实例的 agentparty → 目标键已活跃 → 禁用
    expect(button("Start local agent").props.disabled).toBe(true);
    const channelInput = root.find((node) => node.props.name === "desktop-agent-channel");
    await act(async () => {
      channelInput.props.onChange({ target: { value: "ops" } });
    });
    expect(button("Start local agent").props.disabled).toBe(false);
  });
});

// #616 phase 3：launchd 常驻
describe("DesktopAgentPanel 系统常驻 (#616 phase 3)", () => {
  const duty = {
    label: "com.agentparty.duty.local-main.agentparty",
    instanceId: "local-main:agentparty",
    plistPath: "/Users/x/Library/LaunchAgents/com.agentparty.duty.local-main.agentparty.plist",
    logPath: "/Users/x/.agentparty/desktop/logs/duty.log",
    loaded: true,
  };

  test("勾选常驻后启动走 dutyPersist；常驻列表渲染并可卸载", async () => {
    const persisted: unknown[] = [];
    const removed: string[] = [];
    let entries = [duty];
    const root = await render(adapter({
      dutyList: async () => entries,
      dutyPersist: async (input: unknown) => {
        persisted.push(input);
        return duty;
      },
      dutyUnpersist: async (instanceId: string) => {
        removed.push(instanceId);
        entries = [];
      },
    }));

    const section = root.find((node) => node.props["aria-label"] === "System resident duty");
    expect(section.findAllByType("li")).toHaveLength(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("resident");

    const persistBox = root.find((node) => node.props.name === "desktop-agent-persist");
    await act(async () => {
      persistBox.props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      await button("Start local agent").props.onClick();
    });
    expect(persisted).toHaveLength(1);
    expect((persisted[0] as { channel: string }).channel).toBe("agentparty");

    await act(async () => {
      await button("Remove local-main:agentparty").props.onClick();
    });
    expect(removed).toEqual(["local-main:agentparty"]);
    expect(root.findAll((node) => node.props["aria-label"] === "System resident duty")).toHaveLength(0);
  });

  test("dutyList 不可用（非 macOS/旧 shell）：常驻区块与勾选框整体隐藏/禁用，面板其余功能不受影响", async () => {
    const root = await render(adapter({
      dutyList: async () => {
        throw new Error("unsupported");
      },
    }));
    expect(root.findAll((node) => node.props["aria-label"] === "System resident duty")).toHaveLength(0);
    expect(root.find((node) => node.props.name === "desktop-agent-persist").props.disabled).toBe(true);
    expect(button("Start local agent").props.disabled).toBe(false);
  });
});

describe("DesktopAgentPanel", () => {
  test("shows party init guidance when no local identity is configured", async () => {
    const root = await render(adapter({ listConfigs: async () => [] }));
    const text = JSON.stringify(renderer!.toJSON());

    expect(text).toContain("party init");
    expect(text).not.toContain("token");
    expect(text).not.toContain("config path");
  });

  test("starts the selected identity, channel, and runner as a single-flight action", async () => {
    let resolveStart!: (status: DesktopAgentStatus) => void;
    const starts: DesktopAgentStartInput[] = [];
    const root = await render(adapter({
      start: (input) => {
        starts.push(input);
        return new Promise((resolve) => { resolveStart = resolve; });
      },
    }));
    const selects = root.findAllByType("select");
    const channel = root.findByProps({ name: "desktop-agent-channel" });

    await act(async () => {
      selects[1]!.props.onChange({ target: { value: "claude" } });
      channel.props.onChange({ target: { value: "release" } });
    });
    await act(async () => {
      const start = button("Start local agent");
      void start.props.onClick();
      void start.props.onClick();
    });

    expect(starts).toEqual([{ configId: "local-main", channel: "release", runner: "claude" }]);
    expect(button("Start local agent").props.disabled).toBe(true);

    await act(async () => resolveStart({
      ...stopped,
      state: "running",
      pid: 42,
      configId: "local-main",
      name: "Leo Codex",
      channel: "release",
      runner: "claude",
      startedAt: 1234,
    }));
  });

  test("renders a failed status and its native failure reason", async () => {
    const root = await render(adapter({
      status: async () => ({ ...stopped, state: "failed", exitCode: 1, lastError: "runner exited before ready" }),
    }));
    const text = JSON.stringify(renderer!.toJSON());

    expect(text).toContain("Failed");
    expect(text).toContain("runner exited before ready");
  });

  test("offers a retry when initial native loading fails", async () => {
    let reads = 0;
    await render(adapter({
      listConfigs: async () => {
        reads += 1;
        if (reads === 1) throw new Error("native bridge unavailable");
        return [config];
      },
    }));

    expect(JSON.stringify(renderer!.toJSON())).toContain("native bridge unavailable");
    await act(async () => button("Retry loading").props.onClick());
    expect(reads).toBe(2);
    expect(renderer!.root.findAllByType("select").length).toBe(2);
  });

  test("loads logs only after the collapsed log view is expanded", async () => {
    let reads = 0;
    const root = await render(adapter({ logs: async () => { reads += 1; return ["ready", "watching #agentparty"]; } }));

    expect(reads).toBe(0);
    await act(async () => button("Show local agent logs").props.onClick());

    expect(reads).toBe(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("watching #agentparty");
    expect(button("Hide local agent logs").props["aria-expanded"]).toBe(true);
  });

  test("redacts tokens and config paths from expanded logs", async () => {
    await render(adapter({
      logs: async () => ["token=private-value config=/Users/leo/.agentparty/config.json"],
    }));

    await act(async () => button("Show local agent logs").props.onClick());
    const text = JSON.stringify(renderer!.toJSON());

    expect(text).toContain("token=[redacted]");
    expect(text).toContain("[config path redacted]");
    expect(text).not.toContain("private-value");
    expect(text).not.toContain("/Users/leo/.agentparty/config.json");
  });

  test("reloads logs after a new sidecar lifecycle", async () => {
    let generation = "old run";
    await render(adapter({
      logs: async () => [generation],
      start: async () => ({
        ...stopped,
        state: "running",
        pid: 42,
        configId: config.configId,
        name: config.name,
        channel: config.channel,
        runner: "codex",
        startedAt: 1234,
      }),
    }));

    await act(async () => button("Show local agent logs").props.onClick());
    expect(JSON.stringify(renderer!.toJSON())).toContain("old run");
    await act(async () => button("Hide local agent logs").props.onClick());
    generation = "new run";
    await act(async () => button("Start local agent").props.onClick());
    await act(async () => button("Show local agent logs").props.onClick());
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("new run");
    expect(text).not.toContain("old run");
  });

  test("polls an active agent and cancels polling when unmounted", async () => {
    const polls: Array<() => void> = [];
    let cancelled = 0;
    let statusReads = 0;
    const scheduler: DesktopAgentScheduler = {
      every: (callback) => {
        polls.push(callback);
        return () => { cancelled += 1; };
      },
    };
    await render(adapter({
      status: async () => {
        statusReads += 1;
        return { ...stopped, state: "running", pid: 42 };
      },
    }), scheduler);

    expect(statusReads).toBe(1);
    await act(async () => { polls[0]?.(); });
    expect(statusReads).toBe(2);

    await act(async () => renderer?.unmount());
    renderer = null;
    expect(cancelled).toBe(1);
    polls[0]?.();
    await Promise.resolve();
    expect(statusReads).toBe(2);
  });

  test("provides distinct English and Chinese copy for the local agent controls", () => {
    const keys = [
      "DesktopSettings.agent.title",
      "DesktopSettings.agent.empty",
      "DesktopSettings.agent.start",
      "DesktopSettings.agent.stop",
      "DesktopSettings.agent.state.stopping",
      "DesktopSettings.agent.state.failed",
      "DesktopSettings.agent.logs.show",
    ];
    for (const key of keys) {
      expect(DesktopSettingsStrings.en[key]).toBeTruthy();
      expect(DesktopSettingsStrings.zh[key]).toBeTruthy();
      expect(DesktopSettingsStrings.zh[key]).not.toBe(DesktopSettingsStrings.en[key]);
    }
  });
});
