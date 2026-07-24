import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { Visibility } from "../lib/api";
import { useT } from "../i18n/useT";
import "../i18n/strings/Channel";
import "../i18n/strings/VisibilityToggle";
import "../i18n/strings/ChannelAdminView";

export type ChannelAdminSection = "access" | "members" | "safety" | "lifecycle";

export interface ChannelAdminMember {
  name: string;
  display: string;
  kind: "agent" | "human";
  account?: string | null;
  detail?: string | null;
  canRemove: boolean;
  /** Session-local snapshot retained after an authoritative participant_removed frame. */
  removed?: boolean;
  canRestore?: boolean;
}

export interface ChannelAdminCapabilities {
  manageAccess: boolean;
  manageMembers: boolean;
  manageSafety: boolean;
  archive: boolean;
}

export interface ChannelAdminViewProps {
  slug: string;
  visibility: Visibility;
  archived: boolean;
  capabilities: ChannelAdminCapabilities;
  members: readonly ChannelAdminMember[];
  /** A render function receives whether Access is the visible tab, for lifecycle-sensitive confirmations. */
  accessControls?: ReactNode | ((active: boolean) => ReactNode);
  invitationControls?: ReactNode;
  safetyControls?: ReactNode;
  initialSection?: ChannelAdminSection;
  activeSection?: ChannelAdminSection;
  detail?: ReactNode;
  detailBackLabel?: string;
  removingMember?: string | null;
  restoringMember?: string | null;
  memberError?: string | null;
  archiving?: boolean;
  lifecycleError?: string | null;
  onSectionChange?: (section: ChannelAdminSection) => void;
  onEditAccess?: () => void;
  onManageInvitations?: () => void;
  onOpenMember?: (name: string) => void;
  onBackFromDetail?: () => void;
  onRemoveMember?: (name: string) => void;
  onRestoreMember?: (member: ChannelAdminMember) => void;
  onArchive?: () => void;
  onClose?: () => void;
}

const SECTION_ORDER: readonly ChannelAdminSection[] = [
  "access",
  "members",
  "safety",
  "lifecycle",
];

function sectionFromKey(
  key: string,
  current: number,
): ChannelAdminSection | null {
  if (key === "Home") return SECTION_ORDER[0]!;
  if (key === "End") return SECTION_ORDER[SECTION_ORDER.length - 1]!;
  if (key === "ArrowRight") return SECTION_ORDER[(current + 1) % SECTION_ORDER.length]!;
  if (key === "ArrowLeft") {
    return SECTION_ORDER[(current - 1 + SECTION_ORDER.length) % SECTION_ORDER.length]!;
  }
  return null;
}

/**
 * Channel-scoped administration shell.
 *
 * API calls stay with the parent. Access and invitation actions are routed
 * through callbacks so this view never nests another modal inside the channel
 * panel. The existing inline guard controls can be mounted in the safety slot.
 * Tabs remain mounted so in-progress form state is not lost between sections.
 */
export function ChannelAdminView({
  slug,
  visibility,
  archived,
  capabilities,
  members,
  accessControls,
  invitationControls,
  safetyControls,
  initialSection = "access",
  activeSection: controlledSection,
  detail,
  detailBackLabel = "Back",
  removingMember = null,
  restoringMember = null,
  memberError = null,
  archiving = false,
  lifecycleError = null,
  onSectionChange,
  onEditAccess,
  onManageInvitations,
  onOpenMember,
  onBackFromDetail,
  onRemoveMember,
  onRestoreMember,
  onArchive,
  onClose,
}: ChannelAdminViewProps) {
  const t = useT();
  const idPrefix = useId();
  const [internalSection, setInternalSection] = useState<ChannelAdminSection>(initialSection);
  const activeSection = controlledSection ?? internalSection;
  const tabRefs = useRef(new Map<ChannelAdminSection, HTMLButtonElement>());
  const memberOpenRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailBackRef = useRef<HTMLButtonElement | null>(null);
  const detailReturnMemberRef = useRef<string | null>(null);
  const detailWasOpenRef = useRef(false);
  const showingDetail = detail !== undefined && detail !== null;
  const activeMemberCount = members.filter((member) => member.removed !== true).length;

  useEffect(() => {
    if (!detailWasOpenRef.current && showingDetail) {
      detailBackRef.current?.focus();
    } else if (detailWasOpenRef.current && !showingDetail) {
      const memberName = detailReturnMemberRef.current;
      detailReturnMemberRef.current = null;
      if (memberName !== null) memberOpenRefs.current.get(memberName)?.focus();
    }
    detailWasOpenRef.current = showingDetail;
  }, [showingDetail]);

  const selectSection = (section: ChannelAdminSection, focus = false) => {
    if (controlledSection === undefined) setInternalSection(section);
    onSectionChange?.(section);
    if (focus) tabRefs.current.get(section)?.focus();
  };

  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const next = sectionFromKey(event.key, currentIndex);
    if (next === null) return;
    event.preventDefault();
    selectSection(next, true);
  };

  const tabs: Array<{
    id: ChannelAdminSection;
    label: string;
    content: ReactNode;
  }> = [
    {
      id: "access",
      label: t("ChannelAdmin.tab.access"),
      content: (
        <>
          <h3 className="settings-module-title">{t("ChannelAdmin.access.title")}</h3>
          <section className="settings-section">
            <div className="settings-label">{t("ChannelAdmin.access.visibility")}</div>
            <p className="settings-hint">
              {t("ChannelAdmin.access.current", {
                visibility: t(`Visibility.opt.${visibility}`),
              })}
            </p>
            {!archived && capabilities.manageAccess && accessControls !== undefined
              ? typeof accessControls === "function"
                ? accessControls(activeSection === "access")
                : accessControls
              : !archived && capabilities.manageAccess && onEditAccess !== undefined && (
              <button type="button" className="d-btn" onClick={onEditAccess}>
                {t("ChannelAdmin.access.edit")}
              </button>
              )}
            {!archived
              && capabilities.manageAccess
              && accessControls === undefined
              && onEditAccess === undefined
              && (
              <p className="settings-hint">{t("ChannelAdmin.actionUnavailable")}</p>
            )}
          </section>
          <section className="settings-section">
            <div className="settings-label">{t("ChannelAdmin.access.invitations")}</div>
            {!archived && capabilities.manageAccess && invitationControls !== undefined
              ? invitationControls
              : !archived && capabilities.manageAccess && onManageInvitations !== undefined && (
              <button type="button" className="d-btn" onClick={onManageInvitations}>
                {t("ChannelAdmin.access.manageInvitations")}
              </button>
              )}
            {(archived || !capabilities.manageAccess) && (
              <p className="settings-hint">
                {archived
                  ? t("ChannelAdmin.access.archived")
                  : t("ChannelAdmin.access.readOnly")}
              </p>
            )}
            {!archived
              && capabilities.manageAccess
              && invitationControls === undefined
              && onManageInvitations === undefined
              && (
              <p className="settings-hint">{t("ChannelAdmin.actionUnavailable")}</p>
            )}
          </section>
        </>
      ),
    },
    {
      id: "members",
      label: t("ChannelAdmin.tab.members"),
      content: (
        <>
          <h3 className="settings-module-title">{t("ChannelAdmin.members.title")}</h3>
          {members.length === 0
            ? <p className="settings-hint">{t("ChannelAdmin.members.empty")}</p>
            : (
                <div role="list" aria-label={t("ChannelAdmin.members.listLabel")}>
                  {members.map((member) => {
                    const removing = removingMember === member.name;
                    const restoring = restoringMember === member.name;
                    return (
                      <article key={member.name} role="listitem" className="settings-section">
                        <div className="settings-account">
                          <strong className="settings-account-name">{member.display}</strong>
                          <span className={`settings-account-chip settings-account-chip--${member.kind}`}>
                            {t(`ChannelAdmin.memberKind.${member.kind}`)}
                          </span>
                          {member.removed === true && (
                            <span className="t-mono settings-hint">
                              {t("ChannelAdmin.members.removed")}
                            </span>
                          )}
                          {member.display !== member.name && (
                            <span className="t-mono settings-hint">@{member.name}</span>
                          )}
                        </div>
                        {member.detail != null && member.detail !== "" && (
                          <p className="settings-hint">{member.detail}</p>
                        )}
                        {(
                          (member.removed !== true && onOpenMember !== undefined)
                          || member.canRemove
                          || (
                            member.removed === true
                            && member.canRestore === true
                            && capabilities.manageMembers
                            && onRestoreMember !== undefined
                          )
                        ) && (
                          <div className="settings-account">
                            {member.removed !== true && onOpenMember !== undefined && (
                              <button
                                ref={(node) => {
                                  if (node === null) memberOpenRefs.current.delete(member.name);
                                  else memberOpenRefs.current.set(member.name, node);
                                }}
                                type="button"
                                className="d-btn"
                                data-admin-member-open={member.name}
                                onClick={() => {
                                  detailReturnMemberRef.current = member.name;
                                  onOpenMember(member.name);
                                }}
                              >
                                {t("ChannelAdmin.members.view")}
                              </button>
                            )}
                            {member.canRemove && onRemoveMember !== undefined && (
                              <button
                                type="button"
                                className="d-btn"
                                data-admin-member-remove={member.name}
                                disabled={
                                  archived
                                  || !capabilities.manageMembers
                                  || removingMember !== null
                                  || restoringMember !== null
                                }
                                aria-busy={removing}
                                aria-label={t("ChannelAdmin.members.removeLabel", { name: member.display })}
                                onClick={() => onRemoveMember(member.name)}
                              >
                                {removing
                                  ? t("ChannelAdmin.members.removing")
                                  : t("ChannelAdmin.members.remove")}
                              </button>
                            )}
                            {member.removed === true
                              && member.canRestore === true
                              && capabilities.manageMembers
                              && onRestoreMember !== undefined
                              && (
                                <button
                                  type="button"
                                  className="d-btn"
                                  data-admin-member-restore={member.name}
                                  disabled={
                                    archived
                                    || removingMember !== null
                                    || restoringMember !== null
                                  }
                                  aria-busy={restoring}
                                  aria-label={t("ChannelAdmin.members.restoreLabel", { name: member.display })}
                                  onClick={() => onRestoreMember(member)}
                                >
                                  {restoring
                                    ? t("ChannelAdmin.members.restoring")
                                    : t("ChannelAdmin.members.restore")}
                                </button>
                              )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
          {members.some((member) => (
            (member.removed === true && member.canRestore === true && onRestoreMember === undefined)
            || (member.removed !== true && member.canRemove && onRemoveMember === undefined)
          ))
            && capabilities.manageMembers
            && (
              <p className="settings-hint">{t("ChannelAdmin.actionUnavailable")}</p>
            )}
        </>
      ),
    },
    {
      id: "safety",
      label: t("ChannelAdmin.tab.safety"),
      content: (
        <>
          <h3 className="settings-module-title">{t("ChannelAdmin.safety.title")}</h3>
          {!archived && capabilities.manageSafety && safetyControls !== undefined
            ? safetyControls
            : (
                <p className="settings-hint">
                  {
                    archived
                      ? t("ChannelAdmin.safety.archived")
                      : !capabilities.manageSafety
                        ? t("ChannelAdmin.safety.readOnly")
                        : t("ChannelAdmin.actionUnavailable")
                  }
                </p>
              )}
        </>
      ),
    },
    {
      id: "lifecycle",
      label: t("ChannelAdmin.tab.lifecycle"),
      content: (
        <>
          <h3 className="settings-module-title">{t("ChannelAdmin.lifecycle.title")}</h3>
          <section className="settings-section">
            <div className="settings-label">{t("ChannelAdmin.lifecycle.status")}</div>
            <p className="settings-hint">
              {archived
                ? t("ChannelAdmin.lifecycle.archived")
                : t("ChannelAdmin.lifecycle.active")}
            </p>
            {!archived && (!capabilities.archive || onArchive !== undefined) && (
              <button
                type="button"
                className="d-btn archive-channel-btn"
                data-admin-archive
                disabled={!capabilities.archive || archiving || onArchive === undefined}
                aria-busy={archiving}
                onClick={onArchive}
                title={t("Channel.archive.buttonTitle")}
              >
                {archiving
                  ? t("Channel.archive.archiving")
                  : t("Channel.archive.button")}
              </button>
            )}
            {!archived && capabilities.archive && onArchive === undefined && (
              <p className="settings-hint">{t("ChannelAdmin.actionUnavailable")}</p>
            )}
          </section>
        </>
      ),
    },
  ];

  const titleId = `${idPrefix}-channel-admin-title`;
  const tabId = (section: ChannelAdminSection) => `${idPrefix}-channel-admin-tab-${section}`;
  const panelId = (section: ChannelAdminSection) => `${idPrefix}-channel-admin-panel-${section}`;

  return (
    <section className="team-blog channel-admin-view" aria-labelledby={titleId}>
      <header className="team-blog-head">
        <div className="team-blog-title">
          <h2 id={titleId} className="team-blog-name">{t("ChannelAdmin.title")}</h2>
          <span className="t-mono team-blog-prompt">
            {t("ChannelAdmin.subtitle", { slug })}
          </span>
        </div>
        <div className="team-blog-stats" role="list">
          <span className="t-mono team-blog-stat" role="listitem">
            {t(`Visibility.opt.${visibility}`)}
          </span>
          <span className="t-mono team-blog-stat" role="listitem">
            {t("ChannelAdmin.memberCount", { count: activeMemberCount })}
          </span>
          <span
            className={`t-mono team-blog-stat${archived ? " team-blog-stat--hot" : ""}`}
            role="listitem"
          >
            {archived ? t("ChannelAdmin.status.archived") : t("ChannelAdmin.status.active")}
          </span>
        </div>
        {onClose !== undefined && (
          <button type="button" className="d-btn team-blog-close" onClick={onClose}>
            {t("ChannelAdmin.close")} ✕
          </button>
        )}
      </header>

      <nav
        className="team-blog-tabs"
        role="tablist"
        aria-label={t("ChannelAdmin.navigation")}
        aria-orientation="horizontal"
        hidden={showingDetail}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={tabId(tab.id)}
            ref={(node) => {
              if (node === null) tabRefs.current.delete(tab.id);
              else tabRefs.current.set(tab.id, node);
            }}
            type="button"
            role="tab"
            data-admin-section={tab.id}
            aria-selected={activeSection === tab.id}
            aria-controls={panelId(tab.id)}
            tabIndex={activeSection === tab.id ? 0 : -1}
            className={`team-blog-tab${activeSection === tab.id ? " team-blog-tab--active" : ""}`}
            onClick={() => selectSection(tab.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            <span className="t-mono team-blog-tab-no">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="team-blog-tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      {(memberError !== null || lifecycleError !== null) && (
        <div className="guard-setting-error" role="alert" aria-atomic="true">
          {memberError !== null && <p>{memberError}</p>}
          {lifecycleError !== null && <p>{lifecycleError}</p>}
        </div>
      )}

      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={panelId(tab.id)}
          className="team-blog-panel settings-module"
          role="tabpanel"
          aria-labelledby={tabId(tab.id)}
          hidden={showingDetail || activeSection !== tab.id}
        >
          {tab.content}
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
