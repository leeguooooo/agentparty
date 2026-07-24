import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/useT";

// #504 团队面板「博客风」外壳：把原来一整页长滚动的三段（分工 / Agent 看板 / 协调）
// 收进三个页签，结构一目了然。页签带角标（分工=未认领数、协调=@数）。内部各段的数据
// 逻辑不动——本组件只负责终端/博客风的头部 + 页签导航 + 页签切换。

export type TeamTab = "division" | "board" | "coordination";

export interface TeamTabsStats {
  roles: number;
  online: number;
  offline: number;
  unclaimed: number;
}

export interface TeamTabsProps {
  stats: TeamTabsStats;
  mentionCount: number;
  division: ReactNode;
  board: ReactNode;
  coordination: ReactNode;
  initialTab?: TeamTab;
  detail?: ReactNode;
  detailBackLabel?: string;
  onBackFromDetail?: () => void;
  // #504：博客风头自带关闭按钮（设计里 关闭 在头右上）。传入后 modal 隐藏它自己的头，避免双 header。
  onClose?: () => void;
}

export function TeamTabs({
  stats,
  mentionCount,
  division,
  board,
  coordination,
  initialTab = "division",
  detail,
  detailBackLabel = "Back",
  onBackFromDetail,
  onClose,
}: TeamTabsProps) {
  const t = useT();
  const [tab, setTab] = useState<TeamTab>(initialTab);
  const idPrefix = useId();
  const tabRefs = useRef<Record<TeamTab, HTMLButtonElement | null>>({ division: null, board: null, coordination: null });
  const detailBackRef = useRef<HTMLButtonElement | null>(null);

  const tabs: Array<{
    id: TeamTab;
    no: string;
    label: string;
    badge: number | null;
    badgeHot: boolean;
    content: ReactNode;
  }> = [
    {
      id: "division",
      no: "01",
      label: t("Channel.team.tab.division"),
      badge: stats.unclaimed > 0 ? stats.unclaimed : null,
      badgeHot: true,
      content: division,
    },
    {
      id: "board",
      no: "02",
      label: t("Channel.team.tab.board"),
      badge: null,
      badgeHot: false,
      content: board,
    },
    {
      id: "coordination",
      no: "03",
      label: t("Channel.team.tab.coordination"),
      badge: mentionCount > 0 ? mentionCount : null,
      badgeHot: true,
      content: coordination,
    },
  ];
  const tabId = (id: TeamTab) => `${idPrefix}-team-tab-${id}`;
  const panelId = (id: TeamTab) => `${idPrefix}-team-panel-${id}`;
  const showingDetail = detail !== undefined && detail !== null;
  const detailWasOpenRef = useRef(false);
  useEffect(() => {
    if (!detailWasOpenRef.current && showingDetail) {
      detailBackRef.current?.focus();
    } else if (detailWasOpenRef.current && !showingDetail) {
      tabRefs.current[tab]?.focus();
    }
    detailWasOpenRef.current = showingDetail;
  }, [showingDetail, tab]);
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, direction: -1 | 1) => {
    event.preventDefault();
    const current = tabs.findIndex((entry) => entry.id === tab);
    const next = tabs[(current + direction + tabs.length) % tabs.length]!;
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <section className="team-blog" aria-label={t("Channel.tools.team")}>
      <header className="team-blog-head">
        <div className="team-blog-title">
          <h2 className="team-blog-name">{t("Channel.team.overview.title")}</h2>
          <span className="t-mono team-blog-prompt">{t("Channel.team.overview.prompt")}</span>
        </div>
        <div className="team-blog-stats" role="list">
          <span className="t-mono team-blog-stat" role="listitem">{t("Channel.team.badge.roles", { count: String(stats.roles) })}</span>
          <span className="t-mono team-blog-stat" role="listitem">{t("Channel.team.badge.online", { count: String(stats.online) })}</span>
          <span className="t-mono team-blog-stat" role="listitem">{t("Channel.team.badge.offline", { count: String(stats.offline) })}</span>
          <span
            className={`t-mono team-blog-stat${stats.unclaimed > 0 ? " team-blog-stat--hot" : ""}`}
            role="listitem"
          >
            {t("Channel.team.badge.unclaimed", { count: String(stats.unclaimed) })}
          </span>
        </div>
        {onClose !== undefined && (
          <button type="button" className="d-btn team-blog-close" onClick={onClose}>
            {t("Channel.tools.close")} ✕
          </button>
        )}
      </header>

      <nav
        className="team-blog-tabs"
        role="tablist"
        aria-label={t("Channel.tools.team")}
        hidden={showingDetail}
      >
        {tabs.map((entry) => (
          <button
            key={entry.id}
            id={tabId(entry.id)}
            ref={(node) => { tabRefs.current[entry.id] = node; }}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls={panelId(entry.id)}
            tabIndex={tab === entry.id ? 0 : -1}
            className={"team-blog-tab" + (tab === entry.id ? " team-blog-tab--active" : "")}
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") moveTab(event, -1);
              if (event.key === "ArrowRight") moveTab(event, 1);
            }}
          >
            <span className="t-mono team-blog-tab-no">{entry.no}</span>
            <span className="team-blog-tab-label">{entry.label}</span>
            {entry.badge !== null && (
              <span className={"t-mono team-blog-tab-badge" + (entry.badgeHot ? " team-blog-tab-badge--hot" : "")}>
                {entry.id === "coordination" ? `@${entry.badge}` : entry.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {tabs.map((entry) => (
        <div
          key={entry.id}
          id={panelId(entry.id)}
          className="team-blog-panel"
          role="tabpanel"
          aria-labelledby={tabId(entry.id)}
          hidden={showingDetail || tab !== entry.id}
        >
          {entry.content}
        </div>
      ))}

      {showingDetail && (
        <div className="team-blog-panel team-blog-detail">
          <button
            ref={detailBackRef}
            type="button"
            className="d-btn team-blog-detail-back"
            onClick={onBackFromDetail}
          >
            ← {detailBackLabel}
          </button>
          {detail}
        </div>
      )}
    </section>
  );
}
