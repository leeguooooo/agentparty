import type { CollaborationRole } from "@agentparty/shared";

// issue #281：整个频道的组织/汇报结构应该可以「预览」。#168 已经在 DivisionBoard 的每一行
// 上标出了「汇报给谁 / 谁是主负责人」，但那是逐行的碎片；这里把同一份 presence/lineage 数据
// 折成一棵可整体查看的汇报树——根是频道主负责人（role=host），子节点是通过
// lineage.parent_agent 汇报上来的 agent，递归嵌套。纯函数、无 React 依赖，便于回归。
//
// 数据只来自现有的 presence/lineage/role/昵称，不新造后端模型。真正的「管理层级」（超出
// spawn-lineage 的正式汇报线）需要后端支持，现有数据做不到，见 #168 交接说明——那是后续项。

export interface OrgMemberInput {
  /** roster 里的唯一标识（agent/session name 或 UUID） */
  name: string;
  /** 展示名，已在上层解析过昵称（#165）/SSO display */
  display: string;
  /** 协作角色；host 视为频道主负责人（频道 lead） */
  role: CollaborationRole | null;
  /** 汇报对象 = presence.lineage.parent_agent；无则 null */
  reportsTo: string | null;
  kind?: "agent" | "human";
  accountLabel?: string | null;
  source?: "assigned" | "self" | "unassigned";
}

export interface OrgTreeNode {
  name: string;
  display: string;
  role: CollaborationRole | null;
  kind: "agent" | "human";
  accountLabel: string | null;
  source: "assigned" | "self" | "unassigned";
  /** 原始汇报对象（可能指向本频道之外/不存在的名字） */
  reportsTo: string | null;
  /** reportsTo 指向的名字不在本频道 roster 里（跨频道/未知汇报线，#168 已有同款红色提示） */
  reportsToExternal: boolean;
  /** 是否频道主负责人（role=host） */
  isLead: boolean;
  /** 该节点在汇报树里的深度（结构根 = 0，逐级 +1）。#168 跨级判定基于此 */
  depth: number;
  /**
   * #168「尽量避免跨级汇报」：本节点为叶子 IC（自己没有下属）、非主负责人，但其汇报对象
   * 下面已经存在一层中层管理者（另有一个同级兄弟带着自己的下属）——也就是它越过了这层
   * 管理者、直接汇报给了更高的上级。与 reportsToExternal（跨频道/外部）是两码事。
   */
  skipLevel: boolean;
  children: OrgTreeNode[];
}

export interface OrgTree {
  /** 组织树的根：频道主负责人，以及虽无上级但带下属的中层管理者 */
  roots: OrgTreeNode[];
  /** 无有效汇报对象、也没人向其汇报的散兵（含汇报对象在频道外的）——单独归堆，不塞进树里 */
  unassigned: OrgTreeNode[];
  /** 去重后的成员总数 */
  memberCount: number;
}

function isLeadMember(member: OrgMemberInput): boolean {
  return member.role === "host";
}

export function buildOrgTree(members: OrgMemberInput[]): OrgTree {
  // 去重（同名只留第一次出现），并建立 name → member 映射
  const byName = new Map<string, OrgMemberInput>();
  for (const member of members) {
    if (!byName.has(member.name)) byName.set(member.name, member);
  }
  const uniqueMembers = [...byName.values()];

  // 解析每个成员的「有效父节点」：
  // - host（频道 lead）一律锚定到顶层（父 = null），保证主负责人永远是根，即便它自己也挂了 lineage
  // - 汇报给自己（parent === name）视为「没有上级」，不做自环
  // - 汇报对象不在本频道 roster 里 → 也当作顶层（父 = null），但保留 reportsTo 以便标注 external
  const parentOf = new Map<string, string | null>();
  for (const member of uniqueMembers) {
    if (isLeadMember(member)) {
      parentOf.set(member.name, null);
      continue;
    }
    const parent = member.reportsTo;
    const valid = parent !== null && parent !== member.name && byName.has(parent);
    parentOf.set(member.name, valid ? parent : null);
  }

  // 反向邻接：父 → 子名字列表（只连有效边）
  const childrenNames = new Map<string, string[]>();
  for (const member of uniqueMembers) childrenNames.set(member.name, []);
  for (const member of uniqueMembers) {
    const parent = parentOf.get(member.name) ?? null;
    if (parent !== null) childrenNames.get(parent)!.push(member.name);
  }

  // 子节点排序：主负责人优先，其次按展示名，稳定可复现
  const sortNames = (list: string[]): string[] =>
    [...list].sort((a, b) => {
      const ma = byName.get(a)!;
      const mb = byName.get(b)!;
      if (isLeadMember(ma) !== isLeadMember(mb)) return isLeadMember(ma) ? -1 : 1;
      return ma.display.localeCompare(mb.display) || a.localeCompare(b);
    });

  // visited 是环保护的核心：DFS 时绝不重复进入同一个节点，
  // 因此哪怕数据里出现 b→c→b 这样的环，回边也只会被跳过而不会无限递归。
  const visited = new Set<string>();
  const build = (name: string, depth: number): OrgTreeNode => {
    visited.add(name);
    const member = byName.get(name)!;
    const reportsToExternal =
      member.reportsTo !== null && member.reportsTo !== name && !byName.has(member.reportsTo);
    const children = sortNames(childrenNames.get(name) ?? [])
      .filter((child) => !visited.has(child))
      .map((child) => build(child, depth + 1));
    // #168 跨级检测：本节点（作为某些孩子的汇报对象）下面是否已经存在一层中层管理者，
    // 即有没有一个带下属的孩子。若有，则那些「自己没下属」的叶子孩子就是越级直报到本节点。
    const hasManagerChild = children.some((child) => child.children.length > 0);
    if (hasManagerChild) {
      for (const child of children) {
        if (child.children.length === 0 && !child.isLead) child.skipLevel = true;
      }
    }
    return {
      name: member.name,
      display: member.display,
      role: member.role,
      kind: member.kind ?? "agent",
      accountLabel: member.accountLabel ?? null,
      source: member.source ?? (member.role === null ? "unassigned" : "assigned"),
      reportsTo: member.reportsTo,
      reportsToExternal,
      isLead: isLeadMember(member),
      depth,
      skipLevel: false,
      children,
    };
  };

  // 结构根：有效父 = null 的成员（host、无上级的中层、以及纯散兵都在此）
  const structuralRoots = sortNames(
    uniqueMembers.filter((member) => (parentOf.get(member.name) ?? null) === null).map((m) => m.name),
  );
  const rootNodes: OrgTreeNode[] = [];
  for (const name of structuralRoots) {
    if (!visited.has(name)) rootNodes.push(build(name, 0));
  }
  // 残留的环成员（从任何结构根都到不了）——每个当作独立根重建，visited 保证环被打断
  for (const member of uniqueMembers) {
    if (!visited.has(member.name)) rootNodes.push(build(member.name, 0));
  }

  // 分堆：主负责人 或 「有下属」的节点进组织树；其余叶子散兵进 unassigned
  const roots: OrgTreeNode[] = [];
  const unassigned: OrgTreeNode[] = [];
  for (const node of rootNodes) {
    if (node.isLead || node.children.length > 0) roots.push(node);
    else unassigned.push(node);
  }

  return { roots, unassigned, memberCount: uniqueMembers.length };
}
