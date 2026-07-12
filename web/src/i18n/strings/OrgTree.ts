import { registerDict, type LocaleDict } from "../dict";

export const OrgTreeStrings: LocaleDict = {
  en: {
    "OrgTree.heading": "Org chart · reporting lines",
    "OrgTree.aria": "org chart by reporting line",
    "OrgTree.empty": "No roles assigned yet — assign roles to build the org chart.",
    "OrgTree.status.online": "online",
    "OrgTree.status.wakeable": "wakeable",
    "OrgTree.status.offline": "offline",
    "OrgTree.ownerBadge.label": "owner: {account}",
    "OrgTree.ownerBadge.title": "belongs to a different account ({account}) than its manager (cross-org delegation)",
    "OrgTree.reportsTo.label": "set who {name} reports to",
    "OrgTree.reportsTo.top": "— top level —",
    "OrgTree.reportsTo.option": "reports to {name}",
  },
  zh: {
    "OrgTree.heading": "组织架构 · 汇报线",
    "OrgTree.aria": "按汇报线的组织架构图",
    "OrgTree.empty": "还没有分工——先给成员分配角色来生成组织架构图。",
    "OrgTree.status.online": "在线",
    "OrgTree.status.wakeable": "可唤醒",
    "OrgTree.status.offline": "离线",
    "OrgTree.ownerBadge.label": "归属：{account}",
    "OrgTree.ownerBadge.title": "归属账号（{account}）与其上级不同——跨组织挂靠",
    "OrgTree.reportsTo.label": "设置 {name} 向谁汇报",
    "OrgTree.reportsTo.top": "— 顶层 —",
    "OrgTree.reportsTo.option": "向 {name} 汇报",
  },
};

registerDict(OrgTreeStrings);
