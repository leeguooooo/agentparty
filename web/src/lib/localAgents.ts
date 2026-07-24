// #700：把「本机 agent」从设置里埋着的一段列表，抽成一个「全局按频道视角 + 可检索」的概览。
// 数据来源两路——app 内实例（statusAll，DesktopAgentStatus）+ launchd 常驻（dutyList，DesktopDutyEntry），
// 归一成 LocalAgentRow，按频道分组、可按频道/身份/runner/状态检索。纯函数，便于单测；渲染与动作在组件层。
import type { DesktopAgentStatus, DesktopDutyEntry } from "./desktopAgent";

export type LocalAgentKind = "instance" | "duty";

export interface LocalAgentRow {
  /** 稳定 react key。 */
  key: string;
  kind: LocalAgentKind;
  /** 归属频道；未知（拿不到）时为 ""，分组时归入「未分配」并排最后。 */
  channel: string;
  /** 展示名：实例用 name，常驻用 instanceId 的 configId 段。 */
  name: string;
  runner: string | null;
  /** 归一状态标签：实例用 state；常驻用 loaded→"loaded"/"unloaded"。 */
  state: string;
  instanceId: string | null;
  /** 原始引用，供动作层（停止/卸载/看日志）回指。 */
  instance?: DesktopAgentStatus;
  duty?: DesktopDutyEntry;
}

// 常驻 instanceId 形如 `${configId}:${channel}`：configId 无冒号、channel 是 slug（无冒号），
// 取第一个冒号后为 channel、之前为 configId。无冒号则整体当 configId、频道未知。
export function channelOfInstanceId(instanceId: string): string {
  const idx = instanceId.indexOf(":");
  return idx >= 0 ? instanceId.slice(idx + 1) : "";
}

export function configIdOfInstanceId(instanceId: string): string {
  const idx = instanceId.indexOf(":");
  return idx >= 0 ? instanceId.slice(0, idx) : instanceId;
}

// 归一两路数据源为统一行。instances 的 channel 直接来自字段（可能为 null → ""）；
// duties 的 channel 从 instanceId 解析。不去重：同一 (configId,channel) 既可有 app 内实例、也可有
// launchd 常驻（转常驻会停 app 内同键实例，但列表是各自的真相，都要看得见）。
export function aggregateLocalAgents(
  instances: readonly DesktopAgentStatus[],
  duties: readonly DesktopDutyEntry[],
): LocalAgentRow[] {
  const rows: LocalAgentRow[] = [];
  for (const item of instances) {
    const instanceId = item.instanceId ?? (item.configId !== null && item.channel !== null ? `${item.configId}:${item.channel}` : null);
    rows.push({
      key: `instance:${instanceId ?? `${item.configId ?? "?"}:${item.channel ?? "?"}`}`,
      kind: "instance",
      // channel 字段优先；缺失时从 instanceId(configId:channel) 回退解析，别把带 instanceId 的实例
      // 误归「未分配」而被频道页 scopeChannel 过滤掉（#707 评审）。
      channel: item.channel ?? (instanceId === null ? "" : channelOfInstanceId(instanceId)),
      name: item.name ?? item.configId ?? "?",
      runner: item.runner,
      state: item.state,
      instanceId,
      instance: item,
    });
  }
  for (const duty of duties) {
    rows.push({
      key: `duty:${duty.instanceId}`,
      kind: "duty",
      channel: channelOfInstanceId(duty.instanceId),
      name: configIdOfInstanceId(duty.instanceId),
      runner: duty.runner ?? null,
      state: duty.loaded ? "loaded" : "unloaded",
      instanceId: duty.instanceId,
      duty,
    });
  }
  return rows;
}

// 大小写不敏感、按频道/身份/runner/状态任一子串匹配。空查询=全通过。
export function filterLocalAgents(rows: readonly LocalAgentRow[], query: string): LocalAgentRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((row) => {
    const haystack = [
      row.channel,
      row.name,
      row.runner ?? "",
      row.state,
      row.kind,
      row.duty?.dependencyState ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

export interface LocalAgentChannelGroup {
  channel: string;
  rows: LocalAgentRow[];
}

// 按频道分组：频道名升序（localeCompare），未分配（channel==""）永远排最后。
// 组内先常驻后实例、再按名字，给出稳定顺序。
export function groupLocalAgentsByChannel(rows: readonly LocalAgentRow[]): LocalAgentChannelGroup[] {
  const byChannel = new Map<string, LocalAgentRow[]>();
  for (const row of rows) {
    const list = byChannel.get(row.channel);
    if (list === undefined) byChannel.set(row.channel, [row]);
    else list.push(row);
  }
  const channels = [...byChannel.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
  const kindRank: Record<LocalAgentKind, number> = { duty: 0, instance: 1 };
  return channels.map((channel) => ({
    channel,
    rows: byChannel.get(channel)!.slice().sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.name.localeCompare(b.name)),
  }));
}
