import { registerDict, type LocaleDict } from "../dict";

export const PresenceBarStrings: LocaleDict = {
  en: {
    "PresenceBar.kickTitle": "Kick {name}",
    "PresenceBar.kick": "kick",
    "PresenceBar.expand": "expand participants",
    "PresenceBar.collapse": "collapse",
    "PresenceBar.pause": "pause…",
    "PresenceBar.pauseTitle": "Pause {name}'s reception — it won't be woken by @-mentions",
    "PresenceBar.pause1h": "for 1 hour",
    "PresenceBar.pause4h": "for 4 hours",
    "PresenceBar.pause8h": "for 8 hours",
    "PresenceBar.pauseTomorrow": "until tomorrow 9am",
    "PresenceBar.pauseIndefinite": "until I resume it",
    "PresenceBar.resume": "resume",
    "PresenceBar.resumeTitle": "Resume {name}'s reception",
    "PresenceBar.pausedChip": "⏸ paused",
    "PresenceBar.pausedChipUntil": "⏸ paused · resumes {time}",
    "PresenceBar.pausedManual": "Paused — won't be woken by @-mentions until resumed manually",
    "PresenceBar.pausedUntil": "Paused — won't be woken by @-mentions; auto-resumes {time}",
    // 每任务进度/心跳（#228）
    "PresenceBar.taskChip": "▶ #{seq}",
    "PresenceBar.taskChipBeat": "▶ #{seq} · ♥ {age}",
    "PresenceBar.taskTitle": "running the wake from #{seq}",
    "PresenceBar.taskTitleBeat": "running the wake from #{seq} — last heartbeat {age} (still alive; a stale heartbeat means stuck)",
  },
  zh: {
    "PresenceBar.kickTitle": "踢出 {name}",
    "PresenceBar.kick": "踢出",
    "PresenceBar.expand": "展开参与者",
    "PresenceBar.collapse": "收起",
    "PresenceBar.pause": "暂停…",
    "PresenceBar.pauseTitle": "暂停 {name} 的接待——被 @ 也不再唤醒",
    "PresenceBar.pause1h": "暂停 1 小时",
    "PresenceBar.pause4h": "暂停 4 小时",
    "PresenceBar.pause8h": "暂停 8 小时",
    "PresenceBar.pauseTomorrow": "到明早 9 点",
    "PresenceBar.pauseIndefinite": "直到我手动恢复",
    "PresenceBar.resume": "恢复",
    "PresenceBar.resumeTitle": "恢复 {name} 的接待",
    "PresenceBar.pausedChip": "⏸ 已暂停",
    "PresenceBar.pausedChipUntil": "⏸ 已暂停 · {time} 恢复",
    "PresenceBar.pausedManual": "已暂停接待——被 @ 也不唤醒，需手动恢复",
    "PresenceBar.pausedUntil": "已暂停接待——被 @ 也不唤醒；将于 {time} 自动恢复",
    // 每任务进度/心跳（#228）
    "PresenceBar.taskChip": "▶ #{seq}",
    "PresenceBar.taskChipBeat": "▶ #{seq} · ♥ {age}",
    "PresenceBar.taskTitle": "正在处理 #{seq} 的唤醒",
    "PresenceBar.taskTitleBeat": "正在处理 #{seq} 的唤醒——最近心跳 {age}（还活着；心跳很旧多半卡死了）",
  },
};

registerDict(PresenceBarStrings);
