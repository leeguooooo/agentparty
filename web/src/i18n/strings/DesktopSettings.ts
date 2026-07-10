import { registerDict, type LocaleDict } from "../dict";

export const DesktopSettingsStrings: LocaleDict = {
  en: {
    "DesktopSettings.control.label": "Application settings",
    "DesktopSettings.panel.title": "Desktop settings",
    "DesktopSettings.autostart.label": "Launch at login",
    "DesktopSettings.autostart.description": "Start AgentParty in the background when you sign in.",
    "DesktopSettings.autostart.loading": "Reading system setting",
    "DesktopSettings.autostart.error": "Couldn't update this setting.",
  },
  zh: {
    "DesktopSettings.control.label": "应用设置",
    "DesktopSettings.panel.title": "桌面版设置",
    "DesktopSettings.autostart.label": "登录时启动",
    "DesktopSettings.autostart.description": "登录系统后在后台启动 AgentParty。",
    "DesktopSettings.autostart.loading": "正在读取系统设置",
    "DesktopSettings.autostart.error": "无法更新此设置。",
  },
};

registerDict(DesktopSettingsStrings);
