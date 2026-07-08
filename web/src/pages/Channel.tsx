// 频道页：presence 条 + 实时消息流 + 内联错误条幅 + 插话框。
// App 用 key={slug} 挂载本组件，切频道即整体重建（socket/状态零残留）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { buildHostBoard, type CollaborationRole, type HostBoard, type MsgFrame, type ReadCursor, type SearchHit, type Sender, type WakeDelivery } from "@agentparty/shared";
import { AgentJoin } from "../components/AgentJoin";
import { AgentTokens } from "../components/AgentTokens";
import { VisibilityToggle } from "../components/VisibilityToggle";
import { JoinLink } from "../components/JoinLink";
import { Composer } from "../components/Composer";
import { Markdown } from "../components/Markdown";
import { MessageCard } from "../components/MessageCard";
import { PresenceBar } from "../components/PresenceBar";
import {
  archiveChannel,
  AuthError,
  type ChannelCharter,
  type ChannelIdentity,
  type ChannelRoleInfo,
  deleteChannelRole,
  ForbiddenError,
  fetchChannelCharter,
  fetchChannelIdentities,
  fetchChannelRoles,
  fetchMessages,
  fetchWakeDeliveries,
  kickParticipant,
  resetGuard,
  reviseMessage,
  searchMessages,
  setChannelCharter,
  setChannelRole,
  ValidationError,
} from "../lib/api";
import { agentHue } from "../lib/agentColor";
import { buildIdentityDisplay, type IdentityDisplayMap } from "../lib/identityDisplay";
import { mentionCandidates, mentionLiveness, parseDraftMentions, type DraftMentionStatus } from "../lib/mentions";
import { buildReceipts, type MentionReceipt } from "../lib/wakeReceipt";
import { completionMessages } from "../lib/completions";
import { catchupKey, summarizeCatchup, type CatchupDigest } from "../lib/digest";
import {
  agentFilterSearch,
  filterByAgent,
  parseAgentFilter,
  toggleAgent,
  type AgentFilter,
  type AgentFilterMode,
} from "../lib/filters";
import { fmtTime } from "../lib/time";
import { groupTeamMessages, summarizeTeams, type TeamMessageThread, type TeamSummary } from "../lib/teams";
import { ChannelSocket } from "../lib/ws";
import { channelReducer, initialChannelState } from "../state";
import { useT, type TFunc } from "../i18n/useT";
import "../i18n/strings/Channel";
import "../i18n/strings/Composer";

interface Props {
  slug: string;
  token: string;
  mode: "normal" | "party";
  isPublic: boolean; // 顶栏 PUBLIC 徽章（spec §4）
  shareMode: boolean;
  // 有可写人类账号会话（me.role==="human" 且非分享链接）才允许铸 agent（spec §10）
  canMintAgent: boolean;
  canResetGuard: boolean;
  canModerate: boolean; // owner/admin 才 true：决定是否渲染可见性切换等管理控件（issue #38）
  agentNamePrefix: string; // 生成 agent 名的前缀来源（email/name 前缀，退回 slug）
  accountKey: string | null;
  inviterName: string; // 当前邀请人的频道身份名，接入包报到时 @ 他
  onAuthFailed(message: string): void;
}

const MENTION_RE = /@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;

// IM 式加载：初始/上翻每页条数，与 DOM 消息窗口上限（贴底时超出即丢最老页，上翻可拉回）
const PAGE_SIZE = 50;
const MESSAGE_CAP = 300;
const COLLAB_ROLES: CollaborationRole[] = ["host", "worker", "reviewer", "observer"];
// 触顶阈值：滚动到离顶部这么近就预取上一页
const TOP_LOAD_PX = 80;

function summarizeReplyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 96) return collapsed;
  return `${collapsed.slice(0, 93)}...`;
}

function positiveInt(value: string, fallback: number, max: number): number | null {
  if (value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

function nonNegativeInt(value: string): number | null {
  if (value.trim() === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function readSeenSeq(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeSeenSeq(key: string, seq: number) {
  try {
    localStorage.setItem(key, String(seq));
  } catch {
    // Storage can be unavailable in private contexts; the digest still renders for this session.
  }
}

function charterSeenKey(slug: string): string {
  return `ap_charter_seen:${slug}`;
}

function readSeenCharterRev(slug: string): number {
  try {
    const n = Number(localStorage.getItem(charterSeenKey(slug)) ?? "0");
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeSeenCharterRev(slug: string, rev: number) {
  try {
    localStorage.setItem(charterSeenKey(slug), String(rev));
  } catch {
    // localStorage may be unavailable; the banner still works for this session.
  }
}

interface RoleDraft {
  role: CollaborationRole;
  responsibility: string;
}

function roleDraftFrom(role: ChannelRoleInfo): RoleDraft {
  return { role: role.role, responsibility: role.responsibility ?? "" };
}

function displayRoleName(role: ChannelRoleInfo, identities: ChannelIdentity[]): string {
  const identity = identities.find((item) => item.name === role.name);
  return identity?.display ?? role.display ?? (role.kind === "human" && role.account ? role.account : role.name);
}

function roleAccountLabel(role: ChannelRoleInfo, display: string, t: TFunc): string {
  if (role.account && role.account !== "") return role.account;
  if (role.kind === "human") return display;
  return t("Channel.roles.unowned");
}

function CharterBanner({
  charter,
  open,
  canModerate,
  updated,
  draft,
  saving,
  editing,
  error,
  onToggle,
  onDraft,
  onEdit,
  onCancel,
  onSave,
}: {
  charter: ChannelCharter | null;
  open: boolean;
  canModerate: boolean;
  updated: boolean;
  draft: string;
  saving: boolean;
  editing: boolean;
  error: string | null;
  onToggle: () => void;
  onDraft: (value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const t = useT();
  const hasCharter = Boolean(charter?.charter);
  return (
    <section className={"charter-banner" + (updated ? " charter-banner--updated" : "")}>
      <header className="charter-head">
        <button className="charter-toggle" type="button" onClick={onToggle} aria-expanded={open}>
          <span>{t("Channel.charter.label")}</span>
          {charter ? <span className="t-mono">rev {charter.charter_rev}</span> : null}
          {updated ? <span className="charter-updated">{t("Channel.charter.updated")}</span> : null}
        </button>
        {canModerate && (
          <button className="d-btn charter-edit" type="button" onClick={onEdit}>
            {t("Channel.charter.edit")}
          </button>
        )}
      </header>
      {open && (
        <div className="charter-body">
          {canModerate && editing ? (
            <div className="charter-editor">
              <textarea
                className="charter-textarea t-mono"
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
              />
              <div className="charter-actions">
                <button className="d-btn d-btn--primary" type="button" disabled={saving} onClick={onSave}>
                  {saving ? t("Channel.charter.saving") : t("Channel.charter.save")}
                </button>
                <button className="d-btn" type="button" disabled={saving} onClick={onCancel}>
                  {t("Channel.charter.cancel")}
                </button>
              </div>
              {error !== null && <p className="banner banner--red">{error}</p>}
            </div>
          ) : hasCharter ? (
            <Markdown source={charter!.charter!} />
          ) : (
            <p className="charter-empty">{t("Channel.charter.empty")}</p>
          )}
        </div>
      )}
    </section>
  );
}

function DivisionBoard({
  canModerate,
  roles,
  roleDrafts,
  roleError,
  roleSaving,
  roleName,
  roleDraft,
  identities,
  onRoleDraft,
  onNewRoleName,
  onNewRoleDraft,
  onSaveRole,
  onDeleteRole,
}: {
  canModerate: boolean;
  roles: ChannelRoleInfo[];
  roleDrafts: Record<string, RoleDraft>;
  roleError: string | null;
  roleSaving: string | null;
  roleName: string;
  roleDraft: RoleDraft;
  identities: ChannelIdentity[];
  onRoleDraft: (name: string, draft: RoleDraft) => void;
  onNewRoleName: (name: string) => void;
  onNewRoleDraft: (draft: RoleDraft) => void;
  onSaveRole: (name: string, draft: RoleDraft) => void;
  onDeleteRole: (name: string) => void;
}) {
  const t = useT();
  const roleViews = [...roles]
    .map((role) => {
      const display = displayRoleName(role, identities);
      const accountLabel = roleAccountLabel(role, display, t);
      const owner = role.account && role.account !== display ? role.account : null;
      return { role, display, accountLabel, owner };
    })
    .sort(
      (a, b) =>
        a.accountLabel.localeCompare(b.accountLabel) ||
        a.role.role.localeCompare(b.role.role) ||
        a.display.localeCompare(b.display),
    );
  const groups: Array<{ accountLabel: string; roles: typeof roleViews }> = [];
  for (const view of roleViews) {
    const current = groups.at(-1);
    if (current !== undefined && current.accountLabel === view.accountLabel) current.roles.push(view);
    else groups.push({ accountLabel: view.accountLabel, roles: [view] });
  }

  return (
    <details className="role-board" aria-label={t("Channel.roles.label")}>
      <summary className="role-board-head">
        <div>
          <h2>{t("Channel.roles.label")}</h2>
          <p className="t-mono">{t("Channel.roles.help")}</p>
        </div>
        <span className="t-mono role-board-count">{t("Channel.roles.count", { count: String(roles.length) })}</span>
      </summary>
      <div className="role-board-body">
        {groups.length > 0 ? (
          <div className="role-account-list">
            {groups.map((group) => (
              <section key={group.accountLabel} className="role-account-group">
                <header className="role-account-head">
                  <span className="role-account-label">{group.accountLabel}</span>
                  <span className="t-mono role-account-count">
                    {t("Channel.roles.accountCount", { count: String(group.roles.length) })}
                  </span>
                </header>
                <div className="role-list">
                  {group.roles.map(({ role, display, owner, accountLabel }) => {
                    const draftForRole = roleDrafts[role.name] ?? roleDraftFrom(role);
                    const kind = role.kind ?? "agent";
                    const title = [
                      role.name !== display ? role.name : null,
                      t("Composer.owner", { account: accountLabel }),
                      t(`Composer.kind.${kind}`),
                      t("Composer.role", { role: role.role }),
                      role.responsibility ? t("Composer.responsibility", { responsibility: role.responsibility }) : null,
                    ].filter((part): part is string => part !== null).join("\n");
                    return (
                      <div key={role.name} className="role-row">
                        <div className="role-person" title={title}>
                          <span className="role-person-name t-mono">{display}</span>
                          <span className={`role-kind role-kind--${kind}`}>{t(`Composer.kind.${kind}`)}</span>
                          {owner !== null && <span className="role-owner t-mono">{owner}</span>}
                        </div>
                        {canModerate ? (
                          <>
                            <select
                              className="role-select t-mono"
                              value={draftForRole.role}
                              onChange={(e) => onRoleDraft(role.name, { ...draftForRole, role: e.target.value as CollaborationRole })}
                            >
                              {COLLAB_ROLES.map((item) => (
                                <option key={item} value={item}>{item}</option>
                              ))}
                            </select>
                            <input
                              className="role-input"
                              value={draftForRole.responsibility}
                              onChange={(e) => onRoleDraft(role.name, { ...draftForRole, responsibility: e.target.value })}
                              autoComplete="off"
                              placeholder={t("Channel.roles.responsibilityPlaceholder")}
                            />
                            <button className="d-btn" type="button" disabled={roleSaving === role.name} onClick={() => onSaveRole(role.name, draftForRole)}>
                              {roleSaving === role.name ? t("Channel.roles.saving") : t("Channel.roles.save")}
                            </button>
                            <button className="d-btn" type="button" disabled={roleSaving === role.name} onClick={() => onDeleteRole(role.name)}>
                              {t("Channel.roles.clear")}
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="role-badge t-mono">{role.role}</span>
                            <span className="role-text">{role.responsibility ?? t("Channel.roles.noResponsibility")}</span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="charter-empty">{t("Channel.roles.empty")}</p>
        )}
        {canModerate && (
          <div className="role-row role-row--new">
            <input
              className="role-name-input t-mono"
              value={roleName}
              onChange={(e) => onNewRoleName(e.target.value)}
              list="channel-role-targets"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("Channel.roles.namePlaceholder")}
            />
            <select
              className="role-select t-mono"
              value={roleDraft.role}
              onChange={(e) => onNewRoleDraft({ ...roleDraft, role: e.target.value as CollaborationRole })}
            >
              {COLLAB_ROLES.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <input
              className="role-input"
              value={roleDraft.responsibility}
              onChange={(e) => onNewRoleDraft({ ...roleDraft, responsibility: e.target.value })}
              autoComplete="off"
              placeholder={t("Channel.roles.responsibilityPlaceholder")}
            />
            <button className="d-btn d-btn--primary" type="button" disabled={roleSaving === "__new__"} onClick={() => onSaveRole(roleName, roleDraft)}>
              {roleSaving === "__new__" ? t("Channel.roles.saving") : t("Channel.roles.add")}
            </button>
            <datalist id="channel-role-targets">
              {identities.map((identity) => (
                <option key={identity.name} value={identity.name}>{identity.display}</option>
              ))}
            </datalist>
          </div>
        )}
        {roleError !== null && <p className="banner banner--red">{roleError}</p>}
      </div>
    </details>
  );
}

function AgentFilterPanel({
  senders,
  filter,
  visible,
  total,
  onMode,
  onToggle,
  onClear,
}: {
  senders: string[];
  filter: AgentFilter;
  visible: number;
  total: number;
  onMode: (mode: AgentFilterMode) => void;
  onToggle: (agent: string) => void;
  onClear: () => void;
}) {
  const active = filter.agents.length > 0;
  return (
    <section className="agent-filter-panel" aria-label="agent filters">
      <div className="agent-filter-head">
        <div className="agent-filter-modes" role="group" aria-label="agent filter mode">
          <button
            className={"d-btn agent-filter-mode" + (filter.mode === "only" ? " is-active" : "")}
            type="button"
            aria-pressed={filter.mode === "only"}
            onClick={() => onMode("only")}
          >
            <span>Only</span>
          </button>
          <button
            className={"d-btn agent-filter-mode" + (filter.mode === "except" ? " is-active" : "")}
            type="button"
            aria-pressed={filter.mode === "except"}
            onClick={() => onMode("except")}
          >
            <span>Hide</span>
          </button>
        </div>
        <span className="t-mono agent-filter-count">
          {active ? `${visible}/${total}` : `${total}`}
        </span>
        {active && (
          <button className="d-btn agent-filter-clear" type="button" onClick={onClear}>
            <span>Clear</span>
          </button>
        )}
      </div>
      {senders.length > 0 && (
        <div className="agent-filter-chips">
          {senders.map((name) => {
            const selected = filter.agents.includes(name);
            return (
              <button
                key={name}
                className={"agent-filter-chip t-mono" + (selected ? " is-active" : "")}
                type="button"
                aria-pressed={selected}
                title={name}
                style={{ "--ah": agentHue(name) } as CSSProperties}
                onClick={() => onToggle(name)}
              >
                <span className="agent-filter-dot" aria-hidden="true" />
                <span>{name}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CatchupPanel({
  digest,
  seenSeq,
  latestSeq,
  onCaughtUp,
}: {
  digest: CatchupDigest;
  seenSeq: number;
  latestSeq: number;
  onCaughtUp: () => void;
}) {
  const chips = [
    `${digest.messages} new`,
    digest.mentions > 0 ? `${digest.mentions} @you` : null,
    digest.respondedMentions > 0 ? `${digest.respondedMentions} handled` : null,
    digest.blocked > 0 ? `${digest.blocked} blocked` : null,
    digest.done > 0 ? `${digest.done} done` : null,
    digest.releases > 0 ? `${digest.releases} release` : null,
    digest.questions > 0 ? `${digest.questions} question` : null,
    digest.replies > 0 ? `${digest.replies} replies` : null,
  ].filter((chip): chip is string => chip !== null);

  return (
    <section className="catchup-panel" aria-label="while you were away">
      <div className="catchup-head">
        <div>
          <h2 className="catchup-title">While you were away</h2>
          <p className="catchup-range t-mono">
            #{seenSeq + 1}..#{latestSeq}
          </p>
        </div>
        <button className="d-btn catchup-action" type="button" onClick={onCaughtUp}>
          <span>Caught up</span>
        </button>
      </div>
      <div className="catchup-chips t-mono">
        {chips.map((chip) => (
          <span key={chip} className="catchup-chip">
            {chip}
          </span>
        ))}
      </div>
      {digest.items.length > 0 && (
        <ol className="catchup-items">
          {digest.items.map((item) => (
            <li key={item.seq}>
              <span className="t-mono catchup-item-meta">
                #{item.seq} {item.label}
              </span>
              <span>{item.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SearchHitCard({ hit }: { hit: SearchHit }) {
  const hueStyle = { "--ah": agentHue(hit.sender.name) } as CSSProperties;
  return (
    <article className="d-card msg-card search-hit-card" style={hueStyle}>
      <header className="d-meta msg-head">
        <span className="msg-avatar" aria-hidden="true" />
        <span className="msg-sender">{hit.sender.name}</span>
        <span className={"msg-kind" + (hit.sender.kind === "human" ? " msg-kind--human" : "")}>
          {hit.sender.kind}
        </span>
        <span className="search-hit-field">{hit.match_field}</span>
        <span className="msg-fill" />
        <span>#{hit.seq}</span>
        <time>{fmtTime(hit.ts)}</time>
      </header>
      <p className="search-hit-snippet">{hit.snippet === "" ? "(empty)" : hit.snippet}</p>
    </article>
  );
}

function CompletionPanel({
  completions,
  visible,
  enabled,
  onToggle,
  onJump,
}: {
  completions: MsgFrame[];
  visible: number;
  enabled: boolean;
  onToggle: () => void;
  onJump: (seq: number) => void;
}) {
  if (completions.length === 0) return null;

  return (
    <section className="completion-panel" aria-label="completion artifacts">
      <div className="completion-panel-head">
        <h2 className="completion-title">Completions</h2>
        <span className="t-mono completion-count">
          {visible}/{completions.length}
        </span>
        <button className={"d-btn completion-toggle" + (enabled ? " is-active" : "")} type="button" onClick={onToggle}>
          <span>{enabled ? "All" : "Only"}</span>
        </button>
      </div>
      <ol className="completion-list">
        {completions.slice(-6).reverse().map((message) => {
          const artifact = message.completion_artifact!;
          const meta = [
            `kickoff #${artifact.kickoff_seq}`,
            `${artifact.replies_count} replies`,
            artifact.timeout ? "timeout" : "closed",
          ];
          return (
            <li key={message.seq} className="completion-item">
              <button className="t-mono completion-jump" type="button" onClick={() => onJump(message.seq)}>
                #{message.seq}
              </button>
              <span className="completion-item-body">{message.body === "" ? "(empty)" : message.body}</span>
              <span className="t-mono completion-meta">{meta.join(" · ")}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function DecisionPanel({ messages }: { messages: MsgFrame[] }) {
  const decisions = messages
    .filter((m) => m.kind === "status" && m.status?.decision !== undefined)
    .slice(-5)
    .reverse();
  if (decisions.length === 0) return null;

  return (
    <section className="decision-panel" aria-label="host decisions">
      <div className="decision-panel-head">
        <h2 className="decision-title">Host Decisions</h2>
        <span className="t-mono decision-count">{decisions.length}</span>
      </div>
      <ol className="decision-list">
        {decisions.map((m) => {
          const decision = m.status!.decision!;
          const meta = [
            decision.next !== null ? `next: ${decision.next}` : null,
            decision.handoff_to !== undefined ? `handoff: ${decision.handoff_to}` : null,
            decision.takeover_from !== undefined ? `takeover: ${decision.takeover_from}` : null,
            decision.expires_at !== null ? `expires ${fmtTime(decision.expires_at)}` : null,
          ].filter((part): part is string => part !== null);
          return (
            <li key={m.seq} className="decision-item">
              <div className="decision-item-head">
                <span className={`t-mono decision-kind decision-kind--${decision.kind}`}>{decision.kind}</span>
                <span className="decision-owner">{decision.owner}</span>
                <span className="t-mono decision-seq">#{m.seq}</span>
              </div>
              <p>{decision.decision}</p>
              {meta.length > 0 && <div className="t-mono decision-meta">{meta.join(" · ")}</div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TeamPanel({ teams }: { teams: TeamSummary[] }) {
  if (teams.length === 0) return null;

  return (
    <section className="team-panel" aria-label="agent teams">
      <div className="team-panel-head">
        <h2 className="team-title">Teams</h2>
        <span className="t-mono team-count">{teams.length}</span>
      </div>
      <ol className="team-list">
        {teams.map((team) => {
          const meta = [
            `root: ${team.rootAgent}`,
            team.parentAgents.length === 1 ? `parent: ${team.parentAgents[0]}` : `${team.parentAgents.length} parents`,
            `depth ${team.maxDepth}`,
            team.expiresAt !== null ? `expires ${fmtTime(team.expiresAt)}` : null,
            team.lastSeen !== null ? `seen ${fmtTime(team.lastSeen)}` : null,
          ].filter((part): part is string => part !== null);
          return (
            <li key={team.key} className="team-item">
              <div className="team-item-head">
                <span className="team-name">{team.teamId}</span>
                <span className="t-mono team-active">
                  {team.activeCount}/{team.memberCount} active
                </span>
                <span className={`t-mono team-residency team-residency--${team.residency}`}>
                  {team.residency === "human_driven" ? "manual" : team.residency}
                </span>
              </div>
              <div className="t-mono team-meta">{meta.join(" · ")}</div>
              <div className="team-members">
                {team.members.map((member) => (
                  <span
                    key={member.name}
                    className={"t-mono team-member" + (member.active ? " is-active" : "")}
                    title={[
                      member.name,
                      `parent: ${member.parentAgent}`,
                      `state: ${member.state}`,
                      `residency: ${member.residency}`,
                      member.expiresAt !== null ? `expires: ${fmtTime(member.expiresAt)}` : null,
                      member.lastSeen !== null ? `last seen: ${fmtTime(member.lastSeen)}` : null,
                    ].filter((part): part is string => part !== null).join(" · ")}
                  >
                    <span className={`d-dot d-dot--${member.active ? member.state : "offline"}`} />
                    <span>{member.name}</span>
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function HostBoardPanel({ board }: { board: HostBoard }) {
  if (board.hosts.length === 0 && board.recommended_actions.length === 0 && board.conflicts.length === 0) return null;

  return (
    <section className="host-board-panel" aria-label="host board">
      <div className="host-board-head">
        <h2 className="host-board-title">Host Board</h2>
        <span className="t-mono host-board-count">#{board.last_seq}</span>
      </div>
      {board.recommended_actions.length > 0 && (
        <ol className="host-action-list">
          {board.recommended_actions.map((action, index) => (
            <li key={`${action.kind}:${action.target ?? "channel"}:${index}`} className={`host-action host-action--${action.kind}`}>
              <div className="host-action-head">
                <span className="t-mono host-action-kind">{action.kind}</span>
                {action.target !== null && <span className="host-action-target">{action.target}</span>}
                {action.requires_human && <span className="t-mono host-action-human">human</span>}
              </div>
              <p>{action.reason}</p>
              {action.command !== null && <code>{action.command}</code>}
            </li>
          ))}
        </ol>
      )}
      {board.conflicts.length > 0 && (
        <ol className="host-conflict-list">
          {board.conflicts.map((conflict) => (
            <li key={conflict.scope} className="host-conflict">
              <span className="t-mono host-conflict-scope">{conflict.scope}</span>
              <span>{conflict.owners.join(" vs ")}</span>
            </li>
          ))}
        </ol>
      )}
      {board.hosts.length > 0 && (
        <div className="host-board-hosts">
          {board.hosts.map((host) => (
            <span
              key={host.name}
              className={`t-mono host-board-host host-board-host--${host.lease}`}
              title={[
                `state: ${host.state}`,
                `residency: ${host.residency}`,
                `wake: ${host.wake_kind}`,
                host.stale_reason !== null ? `reason: ${host.stale_reason}` : null,
              ].filter((part): part is string => part !== null).join("\n")}
            >
              {host.name} · {host.lease}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function TeamThread({
  thread,
  self,
  identityDisplay,
  receiptsBySeq,
  readCursors,
  participants,
  canModerate,
  editingSeq,
  editDraft,
  editSaving,
  actionError,
  busySeq,
  onReply,
  onEdit,
  onRetract,
  onEditDraftChange,
  onEditCancel,
  onEditSave,
}: {
  thread: TeamMessageThread;
  self: string | null;
  identityDisplay: IdentityDisplayMap;
  receiptsBySeq: Map<number, MentionReceipt[]>;
  readCursors: Record<string, ReadCursor>;
  participants: Sender[];
  canModerate: boolean;
  editingSeq: number | null;
  editDraft: string;
  editSaving: boolean;
  actionError: { seq: number; message: string } | null;
  busySeq: number | null;
  onReply: (seq: number) => void;
  onEdit: (seq: number) => void;
  onRetract: (seq: number) => void;
  onEditDraftChange: (value: string) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
}) {
  const parentLabel =
    thread.parentAgents.length === 1 ? `parent ${thread.parentAgents[0]}` : `${thread.parentAgents.length} parents`;
  const memberLabel = thread.members.length === 1 ? thread.members[0]! : `${thread.members.length} members`;
  const title = [
    `team: ${thread.teamId}`,
    `root: ${thread.rootAgent}`,
    parentLabel,
    `members: ${thread.members.join(", ")}`,
    `seq: #${thread.firstSeq}..#${thread.lastSeq}`,
  ].join("\n");
  return (
    <details className="team-thread" title={title}>
      <summary className="team-thread-summary">
        <span className="team-thread-dot" aria-hidden="true" />
        <span className="team-thread-name">{thread.teamId}</span>
        <span className="t-mono team-thread-meta">{memberLabel}</span>
        <span className="t-mono team-thread-meta">
          #{thread.firstSeq}..#{thread.lastSeq}
        </span>
        <span className="team-thread-fill" />
        <time className="t-mono">{fmtTime(thread.lastTs)}</time>
      </summary>
      <div className="team-thread-messages">
        {thread.messages.map((message) => (
          <MessageCard
            key={message.seq}
            msg={message}
            self={self}
            identityDisplay={identityDisplay}
            receipts={receiptsBySeq.get(message.seq)}
            readCursors={readCursors}
            participants={participants}
            canModerate={canModerate}
            onReply={onReply}
            onEdit={onEdit}
            onRetract={onRetract}
            editing={editingSeq === message.seq}
            editDraft={editingSeq === message.seq ? editDraft : message.body}
            editSaving={editSaving && editingSeq === message.seq}
            actionError={actionError?.seq === message.seq ? actionError.message : null}
            busy={busySeq === message.seq}
            onEditDraftChange={onEditDraftChange}
            onEditCancel={onEditCancel}
            onEditSave={onEditSave}
          />
        ))}
      </div>
    </details>
  );
}

export function ChannelPage({
  slug,
  token,
  mode,
  isPublic,
  shareMode,
  canMintAgent,
  canResetGuard,
  canModerate,
  agentNamePrefix,
  accountKey,
  inviterName,
  onAuthFailed,
}: Props) {
  const t = useT();
  const [state, dispatch] = useReducer(channelReducer, initialChannelState);
  const [channelIdentities, setChannelIdentities] = useState<ChannelIdentity[]>([]);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [searchFrom, setSearchFrom] = useState("");
  const [searchSince, setSearchSince] = useState("");
  const [searchLimit, setSearchLimit] = useState("100");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [guardResetting, setGuardResetting] = useState(false);
  const [guardResetError, setGuardResetError] = useState<string | null>(null);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [kickError, setKickError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [charter, setCharter] = useState<ChannelCharter | null>(null);
  const [charterOpen, setCharterOpen] = useState(false);
  const [wakeDeliveries, setWakeDeliveries] = useState<WakeDelivery[]>([]); // @ 唤醒台账（webhook 侧硬证据）
  const [charterEditing, setCharterEditing] = useState(false);
  const [charterDraft, setCharterDraft] = useState("");
  const [charterSaving, setCharterSaving] = useState(false);
  const [charterError, setCharterError] = useState<string | null>(null);
  const [channelRoles, setChannelRoles] = useState<ChannelRoleInfo[]>([]);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RoleDraft>>({});
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDraft, setNewRoleDraft] = useState<RoleDraft>({ role: "worker", responsibility: "" });
  const [roleSaving, setRoleSaving] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [seenCharterRev, setSeenCharterRev] = useState(() => readSeenCharterRev(slug));
  // 可见性可在会话内切换（issue #38 web），本地 state 让顶栏徽章即时反映，无需重载
  const [localPublic, setLocalPublic] = useState(isPublic);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const [teamNow, setTeamNow] = useState(() => Date.now());
  const [completionOnly, setCompletionOnly] = useState(false);
  const [agentFilter, setAgentFilter] = useState<AgentFilter>(() => parseAgentFilter(window.location.search));
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [messageActionError, setMessageActionError] = useState<{ seq: number; message: string } | null>(null);
  const [messageActionBusySeq, setMessageActionBusySeq] = useState<number | null>(null);
  const sockRef = useRef<ChannelSocket | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const pendingSendsRef = useRef<Array<{ draft: string; replyTo: number | null }>>([]);
  const stickBottom = useRef(true);
  const authFailedRef = useRef(onAuthFailed);
  authFailedRef.current = onAuthFailed;
  // IM 式加载：初始只拉最新一页、ws 从页尾游标接力；触顶上翻加载更早页
  const [bootstrapped, setBootstrapped] = useState(false); // 初始页已就绪，ws 才连
  const hasMoreRef = useRef(true); // 还有更早的历史可上翻
  const loadingOlderRef = useRef(false); // 上翻请求进行中（去抖）
  const initialCursorRef = useRef(0); // ws hello 的起始游标 = 初始页最后一条 seq
  const pendingAnchorRef = useRef<{ height: number; top: number } | null>(null); // prepend 前的滚动锚
  const oldestSeqRef = useRef(0);
  const charterRevRef = useRef(0);
  oldestSeqRef.current = state.messages.length > 0 ? state.messages[0]!.seq : 0;
  charterRevRef.current = charter?.charter_rev ?? 0;

  const loadCharter = useCallback(() => {
    return fetchChannelCharter(token, slug)
      .then((body) => {
        setCharter(body);
        setCharterDraft(body.charter ?? "");
        setCharterError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (!(err instanceof ForbiddenError)) setCharterError("charter failed to load");
      });
  }, [slug, token]);

  const loadRoles = useCallback(() => {
    return fetchChannelRoles(token, slug)
      .then((roles) => {
        setChannelRoles(roles);
        setRoleDrafts(Object.fromEntries(roles.map((role) => [role.name, roleDraftFrom(role)])));
        setRoleError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (!(err instanceof ForbiddenError)) setRoleError(t("Channel.roles.loadFailed"));
      });
  }, [slug, token, t]);

  const removeParticipant = useCallback((name: string) => {
    if (removingName !== null) return;
    setRemovingName(name);
    setKickError(null);
    kickParticipant(token, slug, name, "remove")
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setKickError(t("Channel.kick.forbidden"));
        else setKickError(t("Channel.kick.failed"));
      })
      .finally(() => setRemovingName(null));
  }, [removingName, slug, token, t]);

  const archiveCurrentChannel = useCallback(() => {
    if (archiving || state.archived) return;
    const ok = window.confirm(t("Channel.archive.confirm", { slug }));
    if (!ok) return;
    setArchiving(true);
    setArchiveError(null);
    archiveChannel(token, slug)
      .then(() => {
        dispatch({ type: "fatal", reason: "archived" });
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setArchiveError(t("Channel.archive.forbidden"));
        else setArchiveError(t("Channel.archive.failed"));
      })
      .finally(() => setArchiving(false));
  }, [archiving, slug, state.archived, token, t]);

  useEffect(() => {
    setSeenCharterRev(readSeenCharterRev(slug));
    setCharterOpen(false);
    setCharterEditing(false);
    void loadCharter();
    void loadRoles();
  }, [loadCharter, loadRoles, slug]);

  useEffect(() => {
    let alive = true;
    setChannelIdentities([]);
    fetchChannelIdentities(token, slug)
      .then((identities) => {
        if (alive) setChannelIdentities(identities);
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
      });
    return () => {
      alive = false;
    };
  }, [slug, token]);

  // IM 式初始加载：先用 rest 拉最新一页（打开即到底部），把 ws 起始游标 seed 到页尾，
  // ws 只补拉/直播页尾之后的新消息——不再全量重放整个频道历史。
  // 归档频道同样被这条覆盖（ws 会被 1008 踢掉，历史靠这页 + 上翻）。
  useEffect(() => {
    let alive = true;
    fetchMessages(token, slug, { before: Number.MAX_SAFE_INTEGER, limit: PAGE_SIZE })
      .then((msgs) => {
        if (!alive) return;
        setHistoryError(null);
        for (const m of msgs) dispatch({ type: "frame", frame: m }); // 按 seq 去重，与 ws 交叠无害
        hasMoreRef.current = msgs.length >= PAGE_SIZE;
        initialCursorRef.current = msgs.length > 0 ? msgs[msgs.length - 1]!.seq : 0;
        setBootstrapped(true);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof AuthError) {
          authFailedRef.current("token revoked — paste a new one");
          return;
        }
        if (err instanceof ForbiddenError) {
          dispatch({ type: "fatal", reason: "forbidden" });
          return;
        }
        // 初始页失败：退回 ws 全量重放（since=0），页面仍可用
        setHistoryError("history failed to load");
        initialCursorRef.current = 0;
        hasMoreRef.current = false;
        setBootstrapped(true);
      });
    return () => {
      alive = false;
    };
  }, [slug, token]);

  useEffect(() => {
    if (!bootstrapped) return;
    const sock = new ChannelSocket(
      slug,
      token,
      {
        onFrame: (frame) => {
          if (frame.type === "welcome" && typeof frame.charter_rev === "number" && frame.charter_rev > charterRevRef.current) {
            void loadCharter();
          }
          if (
            (frame.type === "msg" || frame.type === "status") &&
            frame.kind === "status" &&
            (frame.note ?? frame.body).startsWith("charter updated to rev ")
          ) {
            void loadCharter();
          }
          // 窗口下界防御（review P1 双保险）：低于已加载窗口的旧消息/旧修订不进窗口——
          // 插进去会把上翻分页的 before 起点拽到远古 seq，中段历史被永久跳过。
          // 上翻时 REST 本来就返回当前正文，丢掉这些帧无信息损失。
          const floor = oldestSeqRef.current;
          if (floor > 0) {
            if ((frame.type === "msg" || frame.type === "status") && frame.seq < floor) return;
            if (frame.type === "message_update" && frame.message.seq < floor) return;
          }
          dispatch({ type: "frame", frame });
        },
        onStatus: (status) => dispatch({ type: "status", status }),
        onFatal: (reason) => {
          if (reason === "revoked") authFailedRef.current("token revoked — paste a new one");
          else dispatch({ type: "fatal", reason });
        },
      },
      { queryToken: shareMode, initialCursor: initialCursorRef.current },
    );
    sockRef.current = sock;
    sock.connect();
    return () => {
      sock.dispose();
      sockRef.current = null;
    };
  }, [slug, token, shareMode, bootstrapped, loadCharter]);

  useEffect(() => {
    const onPopState = () => setAgentFilter(parseAgentFilter(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setTeamNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("agent");
    url.searchParams.delete("agentMode");
    const filterSearch = agentFilterSearch(agentFilter);
    if (filterSearch !== "") {
      const params = new URLSearchParams(filterSearch);
      for (const [key, value] of params) url.searchParams.set(key, value);
    }
    const next = `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(null, "", next);
  }, [agentFilter]);

  // 新消息贴底滚动；用户上翻回看时不打扰
  const lastSeq = state.messages.length > 0 ? state.messages[state.messages.length - 1]!.seq : 0;
  const seenKey = state.self === null ? null : catchupKey(slug, state.self);
  // 已读游标（Phase 2）：贴底看到最新消息时回一个 seen，声明「我读到 lastSeq」。分享只读链接不上报
  // （避免匿名 UUID 混进已读名单）。sentSeenRef 去重，发送失败（断线）不推进、下次贴底重试。
  const sentSeenRef = useRef(0);
  const lastSeqRef = useRef(lastSeq);
  lastSeqRef.current = lastSeq;
  const sendSeen = useCallback(
    (seq: number) => {
      if (shareMode || seq <= sentSeenRef.current) return;
      const ok = sockRef.current?.send({ type: "seen", seq }) ?? false;
      if (ok) sentSeenRef.current = seq;
    },
    [shareMode],
  );
  useEffect(() => {
    const el = streamRef.current;
    if (el !== null && stickBottom.current) el.scrollTop = el.scrollHeight;
    if (stickBottom.current) sendSeen(lastSeq);
    // 贴底时收窄消息窗口：DOM 不挂几千条；被丢弃的最老页上翻会重新拉回
    if (stickBottom.current && state.messages.length > MESSAGE_CAP + PAGE_SIZE) {
      dispatch({ type: "trim", keep: MESSAGE_CAP });
      hasMoreRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq]);

  // prepend 老页后的 scroll anchoring：绘制前把 scrollTop 平移新增高度，视口纹丝不动
  const firstSeq = state.messages.length > 0 ? state.messages[0]!.seq : 0;
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const el = streamRef.current;
    if (anchor === null || el === null) return;
    pendingAnchorRef.current = null;
    el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSeq]);

  useEffect(() => {
    if (seenKey === null) return;
    const stored = readSeenSeq(seenKey);
    if (stored === null) {
      if (lastSeq <= 0) return;
      writeSeenSeq(seenKey, lastSeq);
      setSeenSeq(lastSeq);
      return;
    }
    setSeenSeq(stored);
  }, [lastSeq, seenKey]);

  // 触顶上翻：拉 before=<已加载最老 seq> 的上一页，并记录滚动锚（useLayoutEffect 恢复）
  const loadOlder = useCallback(() => {
    const el = streamRef.current;
    if (el === null || loadingOlderRef.current || !hasMoreRef.current) return;
    const oldest = oldestSeqRef.current;
    if (oldest <= 1) {
      hasMoreRef.current = false;
      return;
    }
    loadingOlderRef.current = true;
    fetchMessages(token, slug, { before: oldest, limit: PAGE_SIZE })
      .then((msgs) => {
        if (msgs.length < PAGE_SIZE) hasMoreRef.current = false;
        if (msgs.length === 0) return;
        // 锚在 dispatch 前一刻采样（review P2）：请求飞行期间用户可能已滚走/来了新消息，
        // 用请求发出时的旧锚会把视口拽回触顶位置
        const now = streamRef.current;
        if (now !== null) pendingAnchorRef.current = { height: now.scrollHeight, top: now.scrollTop };
        for (const m of msgs) dispatch({ type: "frame", frame: m });
        // 整页都被去重（firstSeq 没变 → layout effect 不跑）时，别让残锚泄漏到下一次
        requestAnimationFrame(() => {
          pendingAnchorRef.current = null;
        });
      })
      .catch(() => {
        // 失败不锚定；下次触顶重试
      })
      .finally(() => {
        loadingOlderRef.current = false;
      });
  }, [token, slug]);

  const onScroll = useCallback(() => {
    const el = streamRef.current;
    if (el === null) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (stickBottom.current) sendSeen(lastSeqRef.current); // 滚到底＝看到了最新，回执已读
    if (el.scrollTop < TOP_LOAD_PX) loadOlder();
  }, [loadOlder, sendSeen]);

  // 服务端 sent 确认后才清对应草稿；用户已输入的新内容不能被旧 ack 清掉。
  useEffect(() => {
    if (state.lastSentSeq <= 0) return;
    const submitted = pendingSendsRef.current.shift();
    if (submitted === undefined) return;
    setDraft((current) => (current === submitted.draft ? "" : current));
    setReplyTo((current) => (current === submitted.replyTo ? null : current));
  }, [state.lastSentSeq]);

  const send = useCallback(() => {
    const body = draft.trim();
    if (body === "") return;
    const mentions = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]!))];
    const ok =
      sockRef.current?.send({ type: "send", kind: "message", body, mentions, reply_to: replyTo }) ??
      false;
    // ⌘⏎ 不受按钮 disabled 门控，断线窗口内发送失败要内联提示（草稿保留）
    if (ok) pendingSendsRef.current.push({ draft, replyTo });
    else dispatch({ type: "send_failed", message: "not connected — message not sent, draft kept" });
  }, [draft, replyTo]);

  const canWrite = state.self !== null && !state.archived && !state.readonly;
  const charterUpdated = charter !== null && charter.charter_rev > seenCharterRev;
  const catchupDigest =
    state.self !== null && seenSeq !== null && lastSeq > seenSeq
      ? summarizeCatchup(state.messages, state.self, seenSeq)
      : null;

  const onResetGuard = useCallback(() => {
    if (guardResetting) return;
    setGuardResetting(true);
    setGuardResetError(null);
    resetGuard(token, slug)
      .then(() => {
        dispatch({ type: "guard_reset" });
        setGuardResetError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setGuardResetError("only a human owner can reset guard");
        else setGuardResetError("guard reset failed");
      })
      .finally(() => setGuardResetting(false));
  }, [guardResetting, slug, token]);

  const onCaughtUp = useCallback(() => {
    if (seenKey !== null) writeSeenSeq(seenKey, lastSeq);
    setSeenSeq(lastSeq);
  }, [lastSeq, seenKey]);

  const toggleCharter = useCallback(() => {
    setCharterOpen((current) => {
      const next = !current;
      if (next && charter !== null) {
        writeSeenCharterRev(slug, charter.charter_rev);
        setSeenCharterRev(charter.charter_rev);
      }
      return next;
    });
  }, [charter, slug]);

  const editCharter = useCallback(() => {
    setCharterOpen(true);
    setCharterEditing(true);
    setCharterDraft(charter?.charter ?? "");
    setCharterError(null);
  }, [charter]);

  const cancelCharterEdit = useCallback(() => {
    setCharterEditing(false);
    setCharterDraft(charter?.charter ?? "");
    setCharterError(null);
  }, [charter]);

  const saveCharter = useCallback(() => {
    if (charterSaving) return;
    setCharterSaving(true);
    setCharterError(null);
    setChannelCharter(token, slug, charterDraft)
      .then((body) => {
        setCharter(body);
        setCharterDraft(body.charter ?? "");
        setCharterEditing(false);
        setCharterOpen(true);
        writeSeenCharterRev(slug, body.charter_rev);
        setSeenCharterRev(body.charter_rev);
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setCharterError("only moderators or hosts can edit the charter");
        else if (err instanceof ValidationError) setCharterError("charter must be 16KB or less");
        else setCharterError("charter save failed");
      })
      .finally(() => setCharterSaving(false));
  }, [charterDraft, charterSaving, slug, token]);

  const updateRoleDraft = useCallback((name: string, next: RoleDraft) => {
    setRoleDrafts((current) => ({ ...current, [name]: next }));
  }, []);

  const saveRole = useCallback((rawName: string, roleDraft: RoleDraft) => {
    const name = rawName.trim();
    if (name === "" || roleSaving !== null) return;
    const savingKey = channelRoles.some((role) => role.name === name) ? name : "__new__";
    setRoleSaving(savingKey);
    setRoleError(null);
    setChannelRole(token, slug, name, roleDraft.role, roleDraft.responsibility)
      .then((saved) => {
        setChannelRoles((current) => {
          const previous = current.find((role) => role.name === saved.name);
          return [...current.filter((role) => role.name !== saved.name), { ...previous, ...saved }];
        });
        setRoleDrafts((current) => ({ ...current, [saved.name]: roleDraftFrom(saved) }));
        if (savingKey === "__new__") {
          setNewRoleName("");
          setNewRoleDraft({ role: "worker", responsibility: "" });
        }
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setRoleError(t("Channel.roles.forbidden"));
        else if (err instanceof ValidationError) setRoleError(t("Channel.roles.invalid"));
        else setRoleError(t("Channel.roles.saveFailed"));
      })
      .finally(() => setRoleSaving(null));
  }, [channelRoles, roleSaving, slug, token, t]);

  const clearRole = useCallback((name: string) => {
    if (roleSaving !== null) return;
    setRoleSaving(name);
    setRoleError(null);
    deleteChannelRole(token, slug, name)
      .then(() => {
        setChannelRoles((current) => current.filter((role) => role.name !== name));
        setRoleDrafts((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setRoleError(t("Channel.roles.forbidden"));
        else setRoleError(t("Channel.roles.saveFailed"));
      })
      .finally(() => setRoleSaving(null));
  }, [roleSaving, slug, token, t]);

  const replyMessage = useMemo(
    () => (replyTo === null ? null : state.messages.find((message) => message.seq === replyTo) ?? null),
    [replyTo, state.messages],
  );
  const editingMessage = useMemo(
    () => (editingSeq === null ? null : state.messages.find((message) => message.seq === editingSeq) ?? null),
    [editingSeq, state.messages],
  );
  const replyPreview =
    replyMessage === null
      ? t("Channel.reply.unavailable")
      : replyMessage.retracted
        ? t("Channel.reply.retracted")
        : summarizeReplyPreview(replyMessage.body);

  useEffect(() => {
    if (editingSeq === null) return;
    if (editingMessage !== null && editingMessage.kind === "message" && !editingMessage.retracted) return;
    setEditingSeq(null);
    setEditDraft("");
    setEditSaving(false);
    setMessageActionError((current) => (current?.seq === editingSeq ? null : current));
  }, [editingMessage, editingSeq]);

  const startReply = useCallback((seq: number) => {
    setReplyTo(seq);
    setMessageActionError((current) => (current?.seq === seq ? null : current));
  }, []);

  const cancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  const startEdit = useCallback((seq: number) => {
    const target = state.messages.find((message) => message.seq === seq);
    if (target === undefined || target.kind !== "message" || target.retracted) return;
    setEditingSeq(seq);
    setEditDraft(target.body);
    setMessageActionError(null);
  }, [state.messages]);

  const cancelEdit = useCallback(() => {
    setEditingSeq(null);
    setEditDraft("");
    setEditSaving(false);
    setMessageActionError(null);
  }, []);

  const saveEdit = useCallback(() => {
    if (editingSeq === null || editSaving || editingMessage === null || editingMessage.kind !== "message") return;
    if (editDraft.trim() === "" || editDraft === editingMessage.body) return;
    setEditSaving(true);
    setMessageActionBusySeq(editingSeq);
    setMessageActionError(null);
    const mentions = [...new Set([...editDraft.matchAll(MENTION_RE)].map((match) => match[1]!))];
    reviseMessage(slug, editingSeq, "edit", { body: editDraft, mentions })
      .then(({ message }) => {
        dispatch({ type: "frame", frame: message });
        setEditingSeq(null);
        setEditDraft("");
        setMessageActionError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setMessageActionError({ seq: editingSeq, message: t("Channel.revise.edit.forbidden") });
        else if (err instanceof ValidationError) setMessageActionError({ seq: editingSeq, message: t("Channel.revise.edit.invalid") });
        else setMessageActionError({ seq: editingSeq, message: t("Channel.revise.edit.failed") });
      })
      .finally(() => {
        setEditSaving(false);
        setMessageActionBusySeq((current) => (current === editingSeq ? null : current));
      });
  }, [editDraft, editSaving, editingMessage, editingSeq, slug, t]);

  const retractMessage = useCallback((seq: number) => {
    if (messageActionBusySeq !== null) return;
    if (!window.confirm(t("Channel.revise.retract.confirm", { seq }))) return;
    setMessageActionBusySeq(seq);
    setMessageActionError(null);
    reviseMessage(slug, seq, "retract")
      .then(({ message }) => {
        dispatch({ type: "frame", frame: message });
        if (editingSeq === seq) {
          setEditingSeq(null);
          setEditDraft("");
          setEditSaving(false);
        }
        setReplyTo((current) => (current === seq ? null : current));
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setMessageActionError({ seq, message: t("Channel.revise.retract.forbidden") });
        else setMessageActionError({ seq, message: t("Channel.revise.retract.failed") });
      })
      .finally(() => {
        setMessageActionBusySeq((current) => (current === seq ? null : current));
      });
  }, [editingSeq, messageActionBusySeq, slug, t]);

  const q = search.trim();
  const from = searchFrom.trim();
  const since = nonNegativeInt(searchSince);
  const limit = positiveInt(searchLimit, 100, 1000);
  const searchInputError =
    q !== "" && since === null ? "since must be a non-negative integer" :
    q !== "" && limit === null ? "limit must be 1..1000" :
    null;
  const knownSenders = [
    ...new Set([
      ...state.participants.map((p) => p.name),
      ...Object.keys(state.presence),
      ...channelRoles.map((role) => role.name),
      ...state.messages.map((m) => m.sender.name),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const senderListId = `senders-${slug}`;
  const completions = useMemo(() => completionMessages(state.messages), [state.messages]);
  const timelineMessages = completionOnly ? completions : state.messages;
  const visibleMessages = useMemo(() => filterByAgent(timelineMessages, agentFilter), [agentFilter, timelineMessages]);
  const visibleCompletions = useMemo(() => filterByAgent(completions, agentFilter), [agentFilter, completions]);
  const visibleTimeline = useMemo(
    () => completionOnly ? visibleMessages.map((message) => ({ type: "message" as const, message })) : groupTeamMessages(visibleMessages),
    [completionOnly, visibleMessages],
  );
  const visibleSearchHits = useMemo(() => filterByAgent(searchHits, agentFilter), [agentFilter, searchHits]);
  const teamSummaries = useMemo(
    () =>
      summarizeTeams({
        presence: state.presence,
        participants: state.participants,
        messages: state.messages,
        now: teamNow,
      }),
    [state.messages, state.participants, state.presence, teamNow],
  );
  const hostBoard = useMemo(
    () => buildHostBoard(slug, Object.values(state.presence), state.messages, teamNow, { loopGuardActive: state.loopGuard !== null }),
    [slug, state.loopGuard, state.messages, state.presence, teamNow],
  );
  // @ 补全候选：participants ∪ presence，分档（在线/可唤醒/最近）。teamNow 30s 刷新驱动 stale 判定。
  const mentionOptions = useMemo(
    () => mentionCandidates(state.participants, state.presence, state.self, teamNow, channelIdentities, channelRoles),
    [channelIdentities, channelRoles, state.participants, state.presence, state.self, teamNow],
  );
  const identityDisplay = useMemo(
    () =>
      buildIdentityDisplay({
        channelIdentities,
        mentionOptions,
        messages: state.messages,
        participants: state.participants,
        presence: state.presence,
      }),
    [channelIdentities, mentionOptions, state.messages, state.participants, state.presence],
  );
  // 只给「确定是 agent」的 @ 目标算回执：kind 已知 agent 才纳入，未知/人类不标（避免把人误标成待唤醒）。
  const isAgentMention = useMemo(() => {
    const kind = new Map<string, "agent" | "human">();
    for (const p of state.participants) kind.set(p.name, p.kind);
    for (const [name, p] of Object.entries(state.presence)) if (!kind.has(name) && p.kind) kind.set(name, p.kind);
    for (const m of state.messages) if (!kind.has(m.sender.name)) kind.set(m.sender.name, m.sender.kind);
    return (name: string): boolean => kind.get(name) === "agent";
  }, [state.participants, state.presence, state.messages]);
  // 发送后回执：seq → 每个被 @ 的 agent 目标的状态（已回复/已唤醒/唤醒失败/在线已送达/待唤醒/待重连）。
  const receiptsBySeq = useMemo(
    () =>
      buildReceipts(
        state.messages,
        wakeDeliveries,
        new Set(state.participants.map((p) => p.name)),
        state.presence,
        teamNow,
        isAgentMention,
      ),
    [state.messages, wakeDeliveries, state.participants, state.presence, teamNow, isAgentMention],
  );
  // 发送前状态条：草稿里已 @ 的、且在频道里认得的目标 + 当前存活档位。
  const draftMentionStatuses = useMemo<DraftMentionStatus[]>(() => {
    const online = new Set(state.participants.map((p) => p.name));
    const known = new Set<string>([...online, ...Object.keys(state.presence)]);
    return parseDraftMentions(draft)
      .filter((name) => known.has(name) && name !== state.self)
      .map((name) => {
        const live = mentionLiveness(name, online, state.presence, teamNow);
        return { name, display: identityDisplay[name]?.display ?? name, tier: live.tier, wakeKind: live.wakeKind };
      });
  }, [draft, state.participants, state.presence, state.self, teamNow, identityDisplay]);
  // 轮询 @ 唤醒台账（仅 webhook 侧有行；serve/watch 靠 presence + 回复链接补齐）。用 ref 保持 7s 稳定
  // 间隔，不因每条新消息重挂定时器；标签页隐藏或频道无 agent @ 时跳过，端点失败也不影响其余回执渲染。
  const messagesRef = useRef(state.messages);
  messagesRef.current = state.messages;
  const isAgentMentionRef = useRef(isAgentMention);
  isAgentMentionRef.current = isAgentMention;
  useEffect(() => {
    if (shareMode) return;
    let alive = true;
    const poll = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const msgs = messagesRef.current;
      const hasAgentMention = msgs.some(
        (m) => m.kind === "message" && !m.retracted && m.mentions.some(isAgentMentionRef.current),
      );
      if (!hasAgentMention) return;
      const since = Math.max(0, (msgs[0]?.seq ?? 1) - 1);
      fetchWakeDeliveries(token, slug, { since, limit: 100 })
        .then((d) => {
          if (alive) setWakeDeliveries(d);
        })
        .catch(() => {
          /* 台账拉取失败不致命：回执仍能从 presence + 客户端回复链接渲染 */
        });
    };
    poll();
    const id = window.setInterval(poll, 7000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [token, slug, shareMode]);
  const agentFilterActive = agentFilter.agents.length > 0;
  const totalInView = q === "" ? timelineMessages.length : searchHits.length;
  const visibleInView = q === "" ? visibleMessages.length : visibleSearchHits.length;

  const setAgentMode = useCallback((mode: AgentFilterMode) => {
    setAgentFilter((current) => ({ ...current, mode }));
  }, []);

  const toggleAgentFilter = useCallback((agent: string) => {
    setAgentFilter((current) => toggleAgent(current, agent));
  }, []);

  const clearAgentFilter = useCallback(() => {
    setAgentFilter((current) => ({ ...current, agents: [] }));
  }, []);

  const jumpToCompletion = useCallback((seq: number) => {
    setSearch("");
    setCompletionOnly(true);
    window.setTimeout(() => {
      document.getElementById(`msg-${seq}`)?.scrollIntoView({ block: "center" });
    }, 0);
  }, []);

  useEffect(() => {
    if (q === "") {
      setSearchHits([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    if (searchInputError !== null || since === null || limit === null) {
      setSearchHits([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      searchMessages(
        token,
        slug,
        { query: q, from: from === "" ? undefined : from, since, limit },
        controller.signal,
      )
        .then((hits) => {
          setSearchHits(hits);
          setSearchError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setSearchHits([]);
          if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
          else if (err instanceof ForbiddenError) dispatch({ type: "fatal", reason: "forbidden" });
          else setSearchError("search failed to load");
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [from, limit, q, searchInputError, since, slug, token]);

  // 私有频道拒入（spec §3）：ws 已停止重连，给一条友好红条，不留空白 / 不无限转圈
  if (state.forbidden) {
    return (
      <div className="chan chan--forbidden">
        <p className="banner banner--red" role="alert">
          {t("Channel.forbidden")}
        </p>
      </div>
    );
  }

  return (
    <div className="chan">
      <PresenceBar
        presence={state.presence}
        participants={state.participants}
        status={state.status}
        party={mode === "party" || state.mode === "party"}
        isPublic={localPublic}
        canModerate={canModerate}
        removingName={removingName}
        onRemoveParticipant={removeParticipant}
        roles={channelRoles}
      />
      {kickError !== null && <p className="banner banner--red">{kickError}</p>}
      {archiveError !== null && <p className="banner banner--red">{archiveError}</p>}
      {(canMintAgent || canModerate) && !state.archived && (
        <div className="chan-toolbar">
          {canMintAgent && accountKey !== null && (
            <AgentJoin
              slug={slug}
              token={token}
              namePrefix={agentNamePrefix}
              inviterName={inviterName}
              charter={charter}
              accountKey={accountKey}
            />
          )}
          {canMintAgent && accountKey !== null && (
            <AgentTokens
              slug={slug}
              token={token}
              accountKey={accountKey}
              inviterName={inviterName}
              onAuthFailed={onAuthFailed}
            />
          )}
          {canModerate && (
            <VisibilityToggle
              slug={slug}
              token={token}
              isPublic={localPublic}
              onChanged={setLocalPublic}
              onAuthFailed={onAuthFailed}
            />
          )}
          {canModerate && <JoinLink slug={slug} token={token} onAuthFailed={onAuthFailed} />}
          {canModerate && (
            <button
              type="button"
              className="d-btn archive-channel-btn"
              disabled={archiving}
              onClick={archiveCurrentChannel}
              title={t("Channel.archive.buttonTitle")}
            >
              {archiving ? t("Channel.archive.archiving") : t("Channel.archive.button")}
            </button>
          )}
        </div>
      )}
      <CharterBanner
        charter={charter}
        open={charterOpen}
        canModerate={canModerate}
        updated={charterUpdated}
        draft={charterDraft}
        saving={charterSaving}
        editing={charterEditing}
        error={charterError}
        onToggle={toggleCharter}
        onDraft={setCharterDraft}
        onEdit={editCharter}
        onCancel={cancelCharterEdit}
        onSave={saveCharter}
      />
      <DivisionBoard
        canModerate={canModerate}
        roles={channelRoles}
        roleDrafts={roleDrafts}
        roleError={roleError}
        roleSaving={roleSaving}
        roleName={newRoleName}
        roleDraft={newRoleDraft}
        identities={channelIdentities}
        onRoleDraft={updateRoleDraft}
        onNewRoleName={setNewRoleName}
        onNewRoleDraft={setNewRoleDraft}
        onSaveRole={saveRole}
        onDeleteRole={clearRole}
      />
      {/* chat-first：这些协调/元信息面板默认折叠，避免把核心对话流挤出首屏。展开查看 digest/过滤/host board 等。 */}
      <details className="chan-panels">
        <summary className="chan-panels-summary t-mono">
          {t("Channel.panels.summary")}
        </summary>
        {catchupDigest !== null && catchupDigest.messages > 0 && seenSeq !== null && (
          <CatchupPanel
            digest={catchupDigest}
            seenSeq={seenSeq}
            latestSeq={lastSeq}
            onCaughtUp={onCaughtUp}
          />
        )}
        {knownSenders.length > 0 && (
          <AgentFilterPanel
            senders={knownSenders}
            filter={agentFilter}
            visible={visibleInView}
            total={totalInView}
            onMode={setAgentMode}
            onToggle={toggleAgentFilter}
            onClear={clearAgentFilter}
          />
        )}
        {q === "" && <HostBoardPanel board={hostBoard} />}
        {q === "" && <TeamPanel teams={teamSummaries} />}
        {q === "" && <DecisionPanel messages={state.messages} />}
        {q === "" && (
          <CompletionPanel
            completions={completions}
            visible={visibleCompletions.length}
            enabled={completionOnly}
            onToggle={() => setCompletionOnly((current) => !current)}
            onJump={jumpToCompletion}
          />
        )}
      </details>
      {(state.messages.length > 0 || q !== "") && (
        <div className="chan-search-panel">
          <div className="chan-search-row">
            <input
              className="t-mono chan-search"
              type="search"
              value={search}
              spellCheck={false}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Channel.search.placeholder")}
              aria-label="search messages"
            />
            {q !== "" && (
              <span className="t-mono chan-search-count">
                {searchLoading
                  ? "searching"
                  : agentFilterActive
                    ? `${visibleSearchHits.length}/${searchHits.length} hits`
                    : `${searchHits.length} hits`}
              </span>
            )}
          </div>
          {q !== "" && (
            <div className="chan-search-filters">
              <input
                className="t-mono chan-filter-input"
                value={searchFrom}
                spellCheck={false}
                list={senderListId}
                onChange={(e) => setSearchFrom(e.target.value)}
                placeholder="from agent"
                aria-label="search sender filter"
              />
              <datalist id={senderListId}>
                {knownSenders.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <input
                className="t-mono chan-filter-input"
                type="number"
                min={0}
                step={1}
                value={searchSince}
                onChange={(e) => setSearchSince(e.target.value)}
                placeholder="since seq"
                aria-label="search since sequence"
              />
              <input
                className="t-mono chan-filter-input chan-filter-input--short"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={searchLimit}
                onChange={(e) => setSearchLimit(e.target.value)}
                placeholder="limit"
                aria-label="search result limit"
              />
            </div>
          )}
        </div>
      )}
      {/* overflow-anchor:none —— 浏览器原生滚动锚定会和我们手动的 prepend 锚定打架 */}
      <div className="stream" ref={streamRef} onScroll={onScroll} style={{ overflowAnchor: "none" }}>
        {q === ""
          ? visibleTimeline.map((item) =>
              item.type === "message" ? (
                <MessageCard
                  key={item.message.seq}
                  msg={item.message}
                  self={state.self}
                  identityDisplay={identityDisplay}
                  receipts={receiptsBySeq.get(item.message.seq)}
                  readCursors={state.readCursors}
                  participants={state.participants}
                  canModerate={canModerate}
                  onReply={startReply}
                  onEdit={startEdit}
                  onRetract={retractMessage}
                  editing={editingSeq === item.message.seq}
                  editDraft={editingSeq === item.message.seq ? editDraft : item.message.body}
                  editSaving={editSaving && editingSeq === item.message.seq}
                  actionError={messageActionError?.seq === item.message.seq ? messageActionError.message : null}
                  busy={messageActionBusySeq === item.message.seq}
                  onEditDraftChange={setEditDraft}
                  onEditCancel={cancelEdit}
                  onEditSave={saveEdit}
                />
              ) : (
                <TeamThread
                  key={item.key + `:${item.firstSeq}-${item.lastSeq}`}
                  thread={item}
                  self={state.self}
                  identityDisplay={identityDisplay}
                  receiptsBySeq={receiptsBySeq}
                  readCursors={state.readCursors}
                  participants={state.participants}
                  canModerate={canModerate}
                  editingSeq={editingSeq}
                  editDraft={editDraft}
                  editSaving={editSaving}
                  actionError={messageActionError}
                  busySeq={messageActionBusySeq}
                  onReply={startReply}
                  onEdit={startEdit}
                  onRetract={retractMessage}
                  onEditDraftChange={setEditDraft}
                  onEditCancel={cancelEdit}
                  onEditSave={saveEdit}
                />
              ),
            )
          : visibleSearchHits.map((hit) => <SearchHitCard key={hit.seq} hit={hit} />)}
        {state.messages.length === 0 && q === "" && (
          <p className="d-empty" role="status" aria-live="polite">
            party watch {slug}
          </p>
        )}
        {state.messages.length > 0 && q === "" && visibleMessages.length === 0 && (
          <p className="d-empty" role="status" aria-live="polite">
            {completionOnly ? "no completion artifacts match selected agents" : "no messages match selected agents"}
          </p>
        )}
        {q !== "" && !searchLoading && searchHits.length === 0 && searchInputError === null && searchError === null && (
          <p className="d-empty" role="status" aria-live="polite">
            {t("Channel.search.noMatch", { query: search.trim() })}
          </p>
        )}
        {q !== "" && !searchLoading && searchHits.length > 0 && visibleSearchHits.length === 0 && (
          <p className="d-empty" role="status" aria-live="polite">
            no search hits match selected agents
          </p>
        )}
      </div>
      {searchInputError !== null && (
        <p className="banner banner--yellow" role="alert">
          {searchInputError}
        </p>
      )}
      {searchError !== null && searchInputError === null && (
        <p className="banner banner--red" role="alert">
          {searchError}
        </p>
      )}
      {state.archived && (
        <p className="banner banner--gray" role="status" aria-live="polite">
          channel archived — read-only from here on
        </p>
      )}
      {historyError !== null && (
        <p className="banner banner--red" role="alert">
          {historyError}
        </p>
      )}
      {state.loopGuard !== null && (
        <div className="banner banner--yellow guard-banner" role="alert">
          <span>
            loop guard: agents hit the back-and-forth cap — a human message or reset clears it
            {guardResetError !== null ? ` · ${guardResetError}` : ""}
          </span>
          {canResetGuard && (
            <button
              className="d-btn guard-reset"
              type="button"
              onClick={onResetGuard}
              disabled={guardResetting}
            >
              <span>{guardResetting ? "Resetting" : "Reset guard"}</span>
            </button>
          )}
        </div>
      )}
      {state.readonly && !state.archived && (
        <p className="banner banner--gray" role="status" aria-live="polite">
          read-only link — you're watching the party
        </p>
      )}
      {state.sendError !== null && canWrite && (
        <p className="banner banner--red" role="alert">
          {state.sendError}
        </p>
      )}
      {canWrite && replyTo !== null && (
        <div className="reply-banner">
          <span className="reply-banner-text">{t("Channel.reply.label", { seq: replyTo, preview: replyPreview })}</span>
          <button type="button" className="d-btn reply-banner-dismiss" onClick={cancelReply}>
            {t("Channel.reply.cancel")}
          </button>
        </div>
      )}
      {canWrite && (
        <Composer
          draft={draft}
          setDraft={setDraft}
          onSend={send}
          ready={state.status === "open"}
          candidates={mentionOptions}
          mentionStatuses={draftMentionStatuses}
        />
      )}
    </div>
  );
}
