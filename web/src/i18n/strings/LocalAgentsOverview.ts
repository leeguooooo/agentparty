import { registerDict, type LocaleDict } from "../dict";

// #700：本机 agent 概览——按频道分组 + 可检索的独立面板/弹窗。文案与 DesktopSettings.agent.* 互补，
// 复用其 state.* / instanceStop / dutyUnload / dutyLoaded 等键，这里只加概览特有的标题、搜索、空态。
export const LocalAgentsOverviewStrings: LocaleDict = {
  en: {
    "LocalAgents.title": "Local agents",
    "LocalAgents.subtitle": "Every agent running on this machine — app instances and system-resident (launchd) duties — grouped by channel.",
    "LocalAgents.search": "Search by channel, identity, runner, or state",
    "LocalAgents.searchLabel": "Search local agents",
    "LocalAgents.empty": "No local agents are running on this machine.",
    "LocalAgents.emptyFiltered": "No local agents match this search.",
    "LocalAgents.unavailable": "Local agents are unavailable (non-macOS host or an older desktop shell).",
    "LocalAgents.unassigned": "unassigned",
    "LocalAgents.kind.instance": "app",
    "LocalAgents.kind.duty": "resident",
    "LocalAgents.count": "{count} agent(s)",
    "LocalAgents.close": "Close",
    "LocalAgents.actionFailed": "Couldn't complete this local agent action.",
  },
  zh: {
    "LocalAgents.title": "本机 agent",
    "LocalAgents.subtitle": "这台机器上跑着的每个 agent——app 内实例 + 系统常驻（launchd）——按频道归组。",
    "LocalAgents.search": "按频道、身份、运行器或状态检索",
    "LocalAgents.searchLabel": "检索本机 agent",
    "LocalAgents.empty": "这台机器上没有本机 agent 在跑。",
    "LocalAgents.emptyFiltered": "没有匹配此检索的本机 agent。",
    "LocalAgents.unavailable": "本机 agent 不可用（非 macOS 或较旧的桌面壳）。",
    "LocalAgents.unassigned": "未分配频道",
    "LocalAgents.kind.instance": "app",
    "LocalAgents.kind.duty": "常驻",
    "LocalAgents.count": "{count} 个",
    "LocalAgents.close": "关闭",
    "LocalAgents.actionFailed": "无法完成此本机 agent 操作。",
  },
};

registerDict(LocalAgentsOverviewStrings);
