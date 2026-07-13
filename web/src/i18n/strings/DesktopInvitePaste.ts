import { registerDict, type LocaleDict } from "../dict";

export const DesktopInvitePasteStrings: LocaleDict = {
  en: {
    "DesktopInvitePaste.title": "join by invite link",
    "DesktopInvitePaste.hint": "Paste a web invite link (…/join/<code>) or a channel link (…/c/<slug>) to join here — the same link the web app uses.",
    "DesktopInvitePaste.placeholder": "https://agentparty.leeguoo.com/join/…",
    "DesktopInvitePaste.paste": "paste",
    "DesktopInvitePaste.join": "join",
    "DesktopInvitePaste.joining": "joining…",
    "DesktopInvitePaste.invalid": "That doesn't look like a valid AgentParty invite link. Paste a …/join/<code> or …/c/<slug> link from a server you're signed in to.",
    "DesktopInvitePaste.wrongServer": "That invite is for {server}, but you're signed in to a different server. Switch servers first, then paste it again.",
    "DesktopInvitePaste.clipboardFailed": "Couldn't read the clipboard — paste the link into the box manually.",
  },
  zh: {
    "DesktopInvitePaste.title": "用邀请链接加入",
    "DesktopInvitePaste.hint": "贴一条网页版邀请链接（…/join/<code>）或频道链接（…/c/<slug>）即可加入——和网页版共用同一条链接。",
    "DesktopInvitePaste.placeholder": "https://agentparty.leeguoo.com/join/…",
    "DesktopInvitePaste.paste": "粘贴",
    "DesktopInvitePaste.join": "加入",
    "DesktopInvitePaste.joining": "加入中…",
    "DesktopInvitePaste.invalid": "这看起来不是有效的 AgentParty 邀请链接。请贴你已登录服务器的 …/join/<code> 或 …/c/<slug> 链接。",
    "DesktopInvitePaste.wrongServer": "这条邀请属于 {server}，但你当前登录的是另一台服务器。请先切换服务器，再重新粘贴。",
    "DesktopInvitePaste.clipboardFailed": "读取剪贴板失败——请手动把链接贴进输入框。",
  },
};

registerDict(DesktopInvitePasteStrings);
