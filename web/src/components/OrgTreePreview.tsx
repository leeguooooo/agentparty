import type { ReactElement } from "react";
import type { TFunc } from "../i18n/useT";
import type { OrgTree, OrgTreeNode } from "../lib/orgTree";

// issue #281 + #370：频道组织/汇报关系整体预览。DivisionBoard 逐行标注汇报对象，这里折成
// 一棵可整体查看的组织架构图（办公软件式管理层级）。数据源优先 channel_roles.reports_to
// （#370 正式管理层级，可跨 owner），回落 lineage。moderator 可就地设「向谁汇报」（可交互）。
// 树构建（含环/孤儿处理）在 lib/orgTree.ts。

interface OrgInteractive {
  canModerate: boolean;
  allNames: string[];
  busyName: string | null;
  onSetReportsTo: (name: string, reportsTo: string | null) => void;
}

function OrgNodeRow({ node, t, interactive }: { node: OrgTreeNode; t: TFunc; interactive?: OrgInteractive }): ReactElement {
  const roleText = node.role !== null && !node.isLead ? node.role : null;
  return (
    <li className="org-node">
      <div className="org-node-self">
        <span className="org-node-name t-mono">{node.display}</span>
        <span className={`role-kind role-kind--${node.kind}`}>{t(`Composer.kind.${node.kind}`)}</span>
        {node.isLead && <span className="org-lead-tag t-mono">{t("Channel.roles.channelLead")}</span>}
        {roleText !== null && <span className="org-node-role t-mono">{roleText}</span>}
        {node.accountLabel !== null && node.accountLabel !== node.display && (
          <span className="org-node-owner t-mono">{node.accountLabel}</span>
        )}
        {node.reportsTo !== null && (
          <span className={"org-report t-mono" + (node.reportsToExternal ? " org-report--external" : "")}>
            {node.reportsToExternal
              ? t("Channel.roles.reportsToExternal", { parent: node.reportsTo })
              : t("Channel.roles.reportsTo", { parent: node.reportsTo })}
          </span>
        )}
        {node.skipLevel && node.reportsTo !== null && (
          <span
            className="org-report org-report--skip t-mono"
            title={t("Channel.roles.skipLevelHint", { parent: node.reportsTo })}
          >
            {t("Channel.roles.skipLevel", { parent: node.reportsTo })}
          </span>
        )}
        {interactive?.canModerate && (
          <select
            className="org-report-select"
            value={node.reportsTo ?? ""}
            disabled={interactive.busyName === node.name}
            aria-label={t("Channel.org.setReportsToAria", { name: node.name })}
            onChange={(e) => interactive.onSetReportsTo(node.name, e.target.value === "" ? null : e.target.value)}
          >
            <option value="">{t("Channel.org.reportsToTop")}</option>
            {interactive.allNames
              .filter((n) => n !== node.name)
              .map((n) => (
                <option key={n} value={n}>
                  {t("Channel.org.reportsToOption", { name: n })}
                </option>
              ))}
          </select>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="org-children">
          {node.children.map((child) => (
            <OrgNodeRow key={child.name} node={child} t={t} interactive={interactive} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgTreePreview({
  tree,
  t,
  interactive,
}: {
  tree: OrgTree;
  t: TFunc;
  interactive?: OrgInteractive;
}): ReactElement {
  const isEmpty = tree.roots.length === 0 && tree.unassigned.length === 0;
  return (
    <details className="org-tree" aria-label={t("Channel.org.label")}>
      <summary className="org-tree-head">
        <div>
          <h3>{t("Channel.org.label")}</h3>
          <p className="t-mono">{t("Channel.org.help")}</p>
        </div>
        <span className="t-mono org-tree-count">{t("Channel.org.count", { count: String(tree.memberCount) })}</span>
      </summary>
      <div className="org-tree-body">
        {isEmpty ? (
          <p className="charter-empty">{t("Channel.org.empty")}</p>
        ) : (
          <>
            {tree.roots.length > 0 && (
              <ul className="org-roots">
                {tree.roots.map((node) => (
                  <OrgNodeRow key={node.name} node={node} t={t} interactive={interactive} />
                ))}
              </ul>
            )}
            {tree.unassigned.length > 0 && (
              <section className="org-unassigned">
                <header className="org-unassigned-head t-mono">{t("Channel.org.unassignedGroup")}</header>
                <ul className="org-roots">
                  {tree.unassigned.map((node) => (
                    <OrgNodeRow key={node.name} node={node} t={t} interactive={interactive} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </details>
  );
}
