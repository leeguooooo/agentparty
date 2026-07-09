import { registerDict, type LocaleDict } from "../dict";

export const MessageCardStrings: LocaleDict = {
  en: {
    "MessageCard.badge.edited": "edited",
    "MessageCard.badge.retracted": "retracted",
    "MessageCard.retracted": "message retracted",
    "MessageCard.menu.reply": "reply",
    "MessageCard.menu.edit": "edit",
    "MessageCard.menu.task": "turn into task",
    "MessageCard.menu.retract": "retract",
    "MessageCard.menu.copy": "copy text",
    "MessageCard.menu.more": "message actions",
    "MessageCard.copied": "copied",
    "MessageCard.edit.save": "save",
    "MessageCard.edit.saving": "saving…",
    "MessageCard.edit.cancel": "cancel",
    "MessageCard.reply.retracted": "original message retracted",
    "MessageCard.reply.jump": "jump to original message #{seq}",
  },
  zh: {
    "MessageCard.badge.edited": "已编辑",
    "MessageCard.badge.retracted": "已撤回",
    "MessageCard.retracted": "消息已撤回",
    "MessageCard.menu.reply": "引用回复",
    "MessageCard.menu.edit": "编辑",
    "MessageCard.menu.task": "转为任务",
    "MessageCard.menu.retract": "撤回",
    "MessageCard.menu.copy": "复制文本",
    "MessageCard.menu.more": "消息操作",
    "MessageCard.copied": "已复制",
    "MessageCard.edit.save": "保存",
    "MessageCard.edit.saving": "保存中…",
    "MessageCard.edit.cancel": "取消",
    "MessageCard.reply.retracted": "原消息已撤回",
    "MessageCard.reply.jump": "跳转到原消息 #{seq}",
  },
};

registerDict(MessageCardStrings);
