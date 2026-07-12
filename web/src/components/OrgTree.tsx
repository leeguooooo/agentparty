// #370 组织架构树：按 channel_roles.reports_to 画办公软件式管理层级。
// 支持跨 owner 挂靠——节点归属账号与其上级不同则显归属徽章。moderator 可就地设「向谁汇报」。
import type { ChannelRoleAssignment, PresenceEntry } from "@agentparty/shared";
import { useT } from "../i18n/useT";
import "../i18n/strings/OrgTree";

export interface OrgNode {
  role: ChannelRoleAssignment;
  children: OrgNode[];
}

// 从 roles 建森林：root = 无 reports_to 或指向不存在成员的节点。防环（沿链遇到已访问即断），
// 保证任何数据下都能渲染出树（不会无限递归 / 丢节点）。
export function buildOrgForest(roles: ChannelRoleAssignment[]): OrgNode[] {
  const byName = new Map(roles.map((r) => [r.name, r]));
  const nodes = new Map<string, OrgNode>(roles.map((r) => [r.name, { role: r, children: [] }]));
  const roots: OrgNode[] = [];
  for (const r of roles) {
    const manager = r.reports_to != null && r.reports_to !== r.name ? byName.get(r.reports_to) : undefined;
    // 防环：从 r 沿 reports_to 上溯，若能回到自己则视为无效上级 → 当 root
    let cyclic = false;
    if (manager) {
      const seen = new Set<string>([r.name]);
      let cur: string | null | undefined = r.reports_to;
      while (cur != null) {
        if (seen.has(cur)) { cyclic = true; break; }
        seen.add(cur);
        cur = byName.get(cur)?.reports_to ?? null;
      }
    }
    if (manager && !cyclic) nodes.get(manager.name)!.children.push(nodes.get(r.name)!);
    else roots.push(nodes.get(r.name)!);
  }
  const sortRec = (list: OrgNode[]) => {
    list.sort((a, b) => a.role.name.localeCompare(b.role.name));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

type NodeStatus = "online" | "wakeable" | "offline";
function statusOf(p: PresenceEntry | undefined): NodeStatus {
  if (p?.live === true) return "online";
  const kind = p?.wake?.kind;
  if (kind === "watch" || kind === "serve" || kind === "webhook") return "wakeable";
  return "offline";
}

function OrgRow({
  node,
  depth,
  presenceByName,
  parentAccount,
  allNames,
  canModerate,
  onSetReportsTo,
  busyName,
  onOpenDetail,
}: {
  node: OrgNode;
  depth: number;
  presenceByName: Map<string, PresenceEntry>;
  parentAccount: string | null;
  allNames: string[];
  canModerate: boolean;
  onSetReportsTo?: (name: string, reportsTo: string | null) => void;
  busyName: string | null;
  onOpenDetail?: (name: string) => void;
}) {
  const t = useT();
  const { role } = node;
  const p = presenceByName.get(role.name);
  const status = statusOf(p);
  const account = role.account ?? null;
  // 跨 owner：本节点归属账号与其上级不同 → 显归属徽章（办公软件里「外部/借调」的意味）
  const crossOwner = account !== null && parentAccount !== null && account !== parentAccount;
  return (
    <li className="org-node">
      <div className="org-row" style={{ paddingLeft: `${depth * 16}px` }}>
        <span className={`org-status org-status--${status}`} aria-hidden="true" />
        <button
          type="button"
          className="org-name"
          onClick={() => onOpenDetail?.(role.name)}
          title={account ?? role.name}
        >
          {role.display ?? role.name}
        </button>
        <span className={`org-role org-role--${role.role}`}>{role.role}</span>
        {crossOwner && (
          <span className="org-owner-badge" title={t("OrgTree.ownerBadge.title", { account: account ?? "" })}>
            {t("OrgTree.ownerBadge.label", { account: shortAccount(account) })}
          </span>
        )}
        <span className={`org-status-text org-status-text--${status}`}>{t(`OrgTree.status.${status}`)}</span>
        {canModerate && onSetReportsTo !== undefined && (
          <select
            className="org-reports-select"
            value={role.reports_to ?? ""}
            disabled={busyName === role.name}
            aria-label={t("OrgTree.reportsTo.label", { name: role.name })}
            onChange={(e) => onSetReportsTo(role.name, e.target.value === "" ? null : e.target.value)}
          >
            <option value="">{t("OrgTree.reportsTo.top")}</option>
            {allNames
              .filter((n) => n !== role.name)
              .map((n) => (
                <option key={n} value={n}>
                  {t("OrgTree.reportsTo.option", { name: n })}
                </option>
              ))}
          </select>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="org-children">
          {node.children.map((child) => (
            <OrgRow
              key={child.role.name}
              node={child}
              depth={depth + 1}
              presenceByName={presenceByName}
              parentAccount={account}
              allNames={allNames}
              canModerate={canModerate}
              onSetReportsTo={onSetReportsTo}
              busyName={busyName}
              onOpenDetail={onOpenDetail}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function shortAccount(account: string | null): string {
  if (account === null) return "";
  const at = account.indexOf("@");
  return at > 0 ? account.slice(0, at) : account;
}

export function OrgTree({
  roles,
  presence,
  canModerate = false,
  onSetReportsTo,
  busyName = null,
  onOpenDetail,
}: {
  roles: ChannelRoleAssignment[];
  presence: PresenceEntry[];
  canModerate?: boolean;
  onSetReportsTo?: (name: string, reportsTo: string | null) => void;
  busyName?: string | null;
  onOpenDetail?: (name: string) => void;
}) {
  const t = useT();
  const forest = buildOrgForest(roles);
  const presenceByName = new Map(presence.map((p) => [p.name, p]));
  const allNames = roles.map((r) => r.name);
  if (forest.length === 0) return <p className="org-empty">{t("OrgTree.empty")}</p>;
  return (
    <ul className="org-tree" aria-label={t("OrgTree.aria")}>
      {forest.map((node) => (
        <OrgRow
          key={node.role.name}
          node={node}
          depth={0}
          presenceByName={presenceByName}
          parentAccount={null}
          allNames={allNames}
          canModerate={canModerate}
          onSetReportsTo={onSetReportsTo}
          busyName={busyName}
          onOpenDetail={onOpenDetail}
        />
      ))}
    </ul>
  );
}
