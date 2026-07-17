export type DesktopAgentState = "stopped" | "starting" | "running" | "stopping" | "failed";
export type DesktopAgentRunner = "codex" | "claude" | "codex-sdk";

export interface DesktopAgentConfig {
  configId: string;
  name: string;
  serverOrigin: string;
  channel: string | null;
  kind: string;
  role: string;
}

export interface DesktopAgentStatus {
  state: DesktopAgentState;
  pid: number | null;
  configId: string | null;
  name: string | null;
  channel: string | null;
  runner: string | null;
  startedAt: number | null;
  exitCode: number | null;
  lastError: string | null;
  // #616 多实例字段；旧 shell 不下发时为 null（parse 兜底），面板据此回退单实例视图。
  instanceId: string | null;
  workdir: string | null;
  repo: string | null;
}

export interface DesktopAgentStartInput {
  configId: string;
  channel: string;
  runner: DesktopAgentRunner;
  workdir?: string;
  repo?: string;
}

// #616 phase 3：launchd 系统级常驻值守条目。
export interface DesktopDutyEntry {
  label: string;
  instanceId: string;
  plistPath: string;
  logPath: string;
  loaded: boolean;
}

export interface DesktopAgentAdapter {
  listConfigs(): Promise<DesktopAgentConfig[]>;
  status(): Promise<DesktopAgentStatus>;
  /** #616：全部实例（含终止态）。旧 shell 无此命令时 reject——调用方回退 status()。 */
  statusAll(): Promise<DesktopAgentStatus[]>;
  start(input: DesktopAgentStartInput): Promise<DesktopAgentStatus>;
  stop(): Promise<DesktopAgentStatus>;
  stopInstance(instanceId: string): Promise<DesktopAgentStatus>;
  logs(): Promise<string[]>;
  logsInstance(instanceId: string): Promise<string[]>;
  /** #616 phase 3：系统级常驻（launchd）。非 macOS / 旧 shell 会 reject，调用方按不可用处理。 */
  dutyList(): Promise<DesktopDutyEntry[]>;
  dutyPersist(input: DesktopAgentStartInput): Promise<DesktopDutyEntry>;
  dutyUnpersist(instanceId: string): Promise<void>;
  /** #616 phase 4：web 无人值守流程一键接管——token 经本机 IPC 直达，绝不进 URL/剪贴板。 */
  dutyAdopt(input: { server: string; token: string; name: string; channel: string; runner: DesktopAgentRunner }): Promise<DesktopDutyEntry>;
}

export type DesktopAgentInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function parseConfig(value: unknown): DesktopAgentConfig | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.configId !== "string" || value.configId.length === 0 ||
    typeof value.name !== "string" || value.name.length === 0 ||
    typeof value.serverOrigin !== "string" ||
    !isNullableString(value.channel) ||
    typeof value.kind !== "string" ||
    typeof value.role !== "string"
  ) return null;
  return {
    configId: value.configId,
    name: value.name,
    serverOrigin: value.serverOrigin,
    channel: value.channel,
    kind: value.kind,
    role: value.role,
  };
}

function parseConfigs(value: unknown): DesktopAgentConfig[] {
  if (!Array.isArray(value)) throw new Error("invalid desktop agent config list");
  const configs = value.map(parseConfig);
  if (configs.some((config) => config === null)) throw new Error("invalid desktop agent config list");
  return configs as DesktopAgentConfig[];
}

function parseStatus(value: unknown): DesktopAgentStatus {
  if (!isRecord(value)) throw new Error("invalid desktop agent status");
  const state = value.state;
  if (
    (state !== "stopped" && state !== "starting" && state !== "running" && state !== "stopping" && state !== "failed") ||
    !isNullableNumber(value.pid) ||
    !isNullableString(value.configId) ||
    !isNullableString(value.name) ||
    !isNullableString(value.channel) ||
    !isNullableString(value.runner) ||
    !isNullableNumber(value.startedAt) ||
    !isNullableNumber(value.exitCode) ||
    !isNullableString(value.lastError)
  ) throw new Error("invalid desktop agent status");
  // #616 的三个新字段对旧 shell 是 undefined——按 null 归一，不因缺字段拒帧。
  const optional = (field: unknown): string | null => (typeof field === "string" ? field : null);
  return {
    state,
    pid: value.pid,
    configId: value.configId,
    name: value.name,
    channel: value.channel,
    runner: value.runner,
    startedAt: value.startedAt,
    exitCode: value.exitCode,
    lastError: value.lastError,
    instanceId: optional(value.instanceId),
    workdir: optional(value.workdir),
    repo: optional(value.repo),
  };
}

function parseDutyEntry(value: unknown): DesktopDutyEntry {
  if (!isRecord(value)) throw new Error("invalid desktop duty entry");
  if (
    typeof value.label !== "string" ||
    typeof value.instanceId !== "string" ||
    typeof value.plistPath !== "string" ||
    typeof value.logPath !== "string" ||
    typeof value.loaded !== "boolean"
  ) throw new Error("invalid desktop duty entry");
  return {
    label: value.label,
    instanceId: value.instanceId,
    plistPath: value.plistPath,
    logPath: value.logPath,
    loaded: value.loaded,
  };
}

function parseLogs(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((line) => typeof line === "string")) {
    throw new Error("invalid desktop agent logs");
  }
  return value;
}

export function createDesktopAgentAdapter(invoke: DesktopAgentInvoker): DesktopAgentAdapter {
  return {
    async listConfigs() {
      return parseConfigs(await invoke<unknown>("desktop_agent_list_configs"));
    },
    async status() {
      return parseStatus(await invoke<unknown>("desktop_agent_status"));
    },
    async statusAll() {
      const value = await invoke<unknown>("desktop_agent_status_all");
      if (!Array.isArray(value)) throw new Error("invalid desktop agent status list");
      return value.map(parseStatus);
    },
    async start(input) {
      return parseStatus(await invoke<unknown>("desktop_agent_start", {
        configId: input.configId,
        channel: input.channel,
        runner: input.runner,
        workdir: input.workdir ?? null,
        repo: input.repo ?? null,
      }));
    },
    async stop() {
      return parseStatus(await invoke<unknown>("desktop_agent_stop"));
    },
    async stopInstance(instanceId) {
      return parseStatus(await invoke<unknown>("desktop_agent_stop_instance", { instanceId }));
    },
    async logs() {
      return parseLogs(await invoke<unknown>("desktop_agent_logs"));
    },
    async logsInstance(instanceId) {
      return parseLogs(await invoke<unknown>("desktop_agent_logs_instance", { instanceId }));
    },
    async dutyList() {
      const value = await invoke<unknown>("desktop_duty_list");
      if (!Array.isArray(value)) throw new Error("invalid desktop duty list");
      return value.map(parseDutyEntry);
    },
    async dutyPersist(input) {
      return parseDutyEntry(await invoke<unknown>("desktop_duty_persist", {
        configId: input.configId,
        channel: input.channel,
        runner: input.runner,
        workdir: input.workdir ?? null,
        repo: input.repo ?? null,
      }));
    },
    async dutyUnpersist(instanceId) {
      await invoke<unknown>("desktop_duty_unpersist", { instanceId });
    },
    async dutyAdopt(input) {
      return parseDutyEntry(await invoke<unknown>("desktop_duty_adopt", {
        server: input.server,
        token: input.token,
        name: input.name,
        channel: input.channel,
        runner: input.runner,
      }));
    },
  };
}

const nativeInvoke: DesktopAgentInvoker = async <T>(command: string, args?: Record<string, unknown>) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(command, args);
};

export const desktopAgentAdapter = createDesktopAgentAdapter(nativeInvoke);
