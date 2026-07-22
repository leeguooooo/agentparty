import { registerDict, type LocaleDict } from "../dict";

// #725：桌面「常驻 agent 日志」查看器的文案。
export const ResidentDutyLogsStrings: LocaleDict = {
  en: {
    "ResidentDutyLogs.title": "Resident agent logs",
    "ResidentDutyLogs.lead": "Launchd-resident agents on this Mac. Open one to read its serve log — useful when a resident agent isn't responding to @-mentions.",
    "ResidentDutyLogs.refresh": "refresh",
    "ResidentDutyLogs.empty": "No resident agents on this Mac. Make one resident from an agent's “make resident”.",
    "ResidentDutyLogs.loaded": "running",
    "ResidentDutyLogs.stopped": "not loaded",
    "ResidentDutyLogs.reload": "reload log",
    "ResidentDutyLogs.loading": "loading…",
    "ResidentDutyLogs.noLog": "Log is empty (the agent may not have woken yet).",
  },
  zh: {
    "ResidentDutyLogs.title": "常驻 agent 日志",
    "ResidentDutyLogs.lead": "本机 launchd 常驻的 agent。点开看它的 serve 日志——「设了常驻、@ 没反应」时靠它排查。",
    "ResidentDutyLogs.refresh": "刷新",
    "ResidentDutyLogs.empty": "本机没有常驻 agent。可在某个 agent 上「转为常驻」。",
    "ResidentDutyLogs.loaded": "运行中",
    "ResidentDutyLogs.stopped": "未加载",
    "ResidentDutyLogs.reload": "重载日志",
    "ResidentDutyLogs.loading": "加载中…",
    "ResidentDutyLogs.noLog": "日志为空（agent 可能还没被唤醒过）。",
  },
};

registerDict(ResidentDutyLogsStrings);
