import { registerDict, type LocaleDict } from "../dict";

// 频道焦点栏（#682）词典：一眼看清「球在谁手里、在等谁、谁在等我」。zh/en 双语。
export const ChannelFocusBarStrings: LocaleDict = {
  en: {
    "ChannelFocusBar.aria": "Channel focus — who the ball is with",
    "ChannelFocusBar.heading": "focus",
    "ChannelFocusBar.focusManual": "focus",
    "ChannelFocusBar.waitingOn": "waiting on",
    "ChannelFocusBar.waitingOnMe": "waiting on you",
    "ChannelFocusBar.waitingOnMeOwner": "needs your call",
    "ChannelFocusBar.state.working": "working",
    "ChannelFocusBar.state.blocked": "blocked",
    "ChannelFocusBar.state.blockedOn": "blocked on {reason}",
    "ChannelFocusBar.state.waiting_decision": "waiting on human decision",
    "ChannelFocusBar.state.stalled": "possibly stalled / offline",
    "ChannelFocusBar.stalledHint": "reported working but presence is stale — may be stalled or offline",
    "ChannelFocusBar.openTask": "open task #{id}",
    "ChannelFocusBar.openDecision": "open decision #{seq}",
    "ChannelFocusBar.counts": "{working} working · {blocked} blocked · {decision} awaiting decision · {stalled} stalled",
  },
  zh: {
    "ChannelFocusBar.aria": "频道焦点——球在谁手里",
    "ChannelFocusBar.heading": "焦点",
    "ChannelFocusBar.focusManual": "焦点",
    "ChannelFocusBar.waitingOn": "在等",
    "ChannelFocusBar.waitingOnMe": "在等你",
    "ChannelFocusBar.waitingOnMeOwner": "等你拍板",
    "ChannelFocusBar.state.working": "在做",
    "ChannelFocusBar.state.blocked": "被卡",
    "ChannelFocusBar.state.blockedOn": "被卡：{reason}",
    "ChannelFocusBar.state.waiting_decision": "等人拍板",
    "ChannelFocusBar.state.stalled": "可能停滞 / 离线",
    "ChannelFocusBar.stalledHint": "自报在做，但 presence 已陈旧——可能已停滞或离线",
    "ChannelFocusBar.openTask": "打开任务 #{id}",
    "ChannelFocusBar.openDecision": "打开决策 #{seq}",
    "ChannelFocusBar.counts": "{working} 在做 · {blocked} 被卡 · {decision} 待拍板 · {stalled} 停滞",
  },
};

registerDict(ChannelFocusBarStrings);
