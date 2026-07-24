// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import {
  createDesktopAgentAdapter,
  dutyDependencyErrorRunner,
  dutyRepairInput,
  type DesktopAgentInvoker,
} from "./desktopAgent";

describe("desktop agent native adapter", () => {
  test("maps the public adapter to the native invoke contract", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: DesktopAgentInvoker = async (command, args) => {
      calls.push({ command, args });
      if (command === "desktop_agent_list_configs") {
        return [{
          configId: "local-main",
          name: "Leo Codex",
          serverOrigin: "https://party.example.com",
          channel: "agentparty",
          kind: "project",
          role: "worker",
        }];
      }
      if (command === "desktop_agent_logs" || command === "desktop_agent_logs_instance") {
        return ["ready", "watching #agentparty"];
      }
      if (command === "desktop_agent_status_all") {
        return [{
          state: "stopped", pid: null, configId: null, name: null, channel: null, runner: null,
          startedAt: null, exitCode: null, lastError: null,
          instanceId: "local-main:agentparty", workdir: "/tmp/duty", repo: null,
        }];
      }
      return {
        state: command === "desktop_agent_start" ? "running" : "stopped",
        pid: command === "desktop_agent_start" ? 42 : null,
        configId: command === "desktop_agent_start" ? "local-main" : null,
        name: command === "desktop_agent_start" ? "Leo Codex" : null,
        channel: command === "desktop_agent_start" ? "agentparty" : null,
        runner: command === "desktop_agent_start" ? "codex" : null,
        startedAt: command === "desktop_agent_start" ? 1234 : null,
        exitCode: null,
        lastError: null,
      };
    };
    const adapter = createDesktopAgentAdapter(invoke);

    expect(await adapter.listConfigs()).toHaveLength(1);
    expect((await adapter.status()).state).toBe("stopped");
    expect((await adapter.start({ configId: "local-main", channel: "agentparty", runner: "codex" })).pid).toBe(42);
    expect((await adapter.stop()).state).toBe("stopped");
    expect(await adapter.logs()).toEqual(["ready", "watching #agentparty"]);
    expect((await adapter.statusAll())[0]!.state).toBe("stopped");
    expect((await adapter.stopInstance("local-main:agentparty")).state).toBe("stopped");
    expect(await adapter.logsInstance("local-main:agentparty")).toEqual(["ready", "watching #agentparty"]);
    expect(calls.slice(-3)).toEqual([
      { command: "desktop_agent_status_all", args: undefined },
      { command: "desktop_agent_stop_instance", args: { instanceId: "local-main:agentparty" } },
      { command: "desktop_agent_logs_instance", args: { instanceId: "local-main:agentparty" } },
    ]);
    expect(calls.slice(0, 5)).toEqual([
      { command: "desktop_agent_list_configs", args: undefined },
      { command: "desktop_agent_status", args: undefined },
      { command: "desktop_agent_start", args: { configId: "local-main", channel: "agentparty", runner: "codex", workdir: null, repo: null } },
      { command: "desktop_agent_stop", args: undefined },
      { command: "desktop_agent_logs", args: undefined },
    ]);
  });

  test("rejects malformed native data instead of exposing unchecked values", async () => {
    const invalidStatus = createDesktopAgentAdapter(async () => ({ state: "unknown", token: "secret" }));
    const invalidConfigs = createDesktopAgentAdapter(async () => [{ configId: "x", configPath: "/private/config" }]);
    const invalidLogs = createDesktopAgentAdapter(async () => ["ok", 42]);

    expect(invalidStatus.status()).rejects.toThrow("invalid desktop agent status");
    expect(invalidConfigs.listConfigs()).rejects.toThrow("invalid desktop agent config list");
    expect(invalidLogs.logs()).rejects.toThrow("invalid desktop agent logs");
  });

  test("accepts the native stopping state while termination is pending", async () => {
    const adapter = createDesktopAgentAdapter(async () => ({
      state: "stopping",
      pid: 42,
      configId: "local-main",
      name: "Leo Codex",
      channel: "agentparty",
      runner: "codex",
      startedAt: 1234,
      exitCode: null,
      lastError: null,
    }));

    expect((await adapter.status()).state).toBe("stopping");
  });

  test("normalizes runner dependency metadata and keeps legacy duty entries repair-safe", async () => {
    const current = createDesktopAgentAdapter(async () => [{
      label: "com.agentparty.duty.cfg.ops",
      instanceId: "cfg:ops",
      plistPath: "/p",
      logPath: "/log",
      loaded: true,
      runner: "codex",
      workdir: "/workspace",
      repo: "https://example.com/repo.git",
      runnerExecutable: "/Users/leo/.local/bin/codex",
      dependencyState: "repair-required",
    }]);
    const [entry] = await current.dutyList();
    expect(entry).toMatchObject({
      runner: "codex",
      runnerExecutable: "/Users/leo/.local/bin/codex",
      dependencyState: "repair-required",
    });
    expect(dutyRepairInput(entry!)).toEqual({
      configId: "cfg",
      channel: "ops",
      runner: "codex",
      workdir: "/workspace",
      repo: "https://example.com/repo.git",
    });

    const legacy = createDesktopAgentAdapter(async () => [{
      label: "com.agentparty.duty.cfg.ops",
      instanceId: "cfg:ops",
      plistPath: "/p",
      logPath: "/log",
      loaded: true,
    }]);
    expect(await legacy.dutyList()).toEqual([expect.objectContaining({
      runner: null,
      runnerExecutable: null,
      dependencyState: "unknown",
    })]);
    expect(dutyDependencyErrorRunner(
      new Error("runner_dependency_missing:codex: codex CLI was not found"),
    )).toBe("codex");
  });
});
