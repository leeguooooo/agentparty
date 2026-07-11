// 频道页：presence 条 + 实时消息流 + 内联错误条幅 + 插话框。
// App 用 key={slug} 挂载本组件，切频道即整体重建（socket/状态零残留）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { buildHostBoard, type ChannelSquad, type CollaborationRole, type HostBoard, type MsgFrame, type PresenceEntry, type ReadCursor, type SearchHit, type Sender, type TaskAssigneeKind, type TaskRecord, type TaskState, type TaskSummary, type WakeDelivery } from "@agentparty/shared";
import { AgentJoin } from "../components/AgentJoin";
import { AgentTokens } from "../components/AgentTokens";
import { VisibilityToggle } from "../components/VisibilityToggle";
import { JoinLink } from "../components/JoinLink";
import { Composer } from "../components/Composer";
import { Markdown } from "../components/Markdown";
import { MessageCard } from "../components/MessageCard";
import { MentionToast, type MentionToastItem } from "../components/MentionToast";
import { NotifyToggle, readNotifyOptin } from "../components/NotifyToggle";
import { PresenceBar } from "../components/PresenceBar";
import {
  archiveChannel,
  AuthError,
  type ChannelCharter,
  type ChannelIdentity,
  type ChannelRoleInfo,
  createTask,
  deleteChannelRole,
  ForbiddenError,
  fetchChannelCharter,
  fetchChannelIdentities,
  fetchChannelRoles,
  fetchSquads,
  fetchMessages,
  fetchTaskSummary,
  fetchTasks,
  fetchWakeDeliveries,
  kickParticipant,
  resetGuard,
  reviseMessage,
  reviewCompletion,
  searchMessages,
  setChannelCharter,
  setLoopGuard,
  setWorkflowGuard,
  setChannelRole,
  updateTask,
  ValidationError,
} from "../lib/api";
import { agentHue } from "../lib/agentColor";
import { buildIdentityDisplay, type IdentityDisplayMap } from "../lib/identityDisplay";
import { mentionCandidates, mentionLiveness, parseDraftMentions, type DraftMentionStatus } from "../lib/mentions";
import { buildReceipts, type MentionReceipt } from "../lib/wakeReceipt";
import { completionMessages } from "../lib/completions";
import { catchupKey, summarizeCatchup, type CatchupDigest } from "../lib/digest";
import {
  isDesktopRuntime,
  sendMentionNotification,
  setDesktopBadge,
} from "../lib/desktopRuntime";
import {
  agentFilterSearch,
  filterByAgent,
  parseAgentFilter,
  setKind,
  toggleAgent,
  type AgentFilter,
  type AgentFilterKind,
  type AgentFilterMode,
} from "../lib/filters";
import { nextMentionBadgeCount, shouldMarkSeen, shouldNotify, shouldToast } from "../lib/notify";
import { summarizeReplyPreview } from "../lib/replyPreview";
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
  loopGuardEnabled: boolean;
  loopGuardLimit: number | null;
  workflowGuardEnabled: boolean;
  workflowGuardLimit: number;
  shareMode: boolean;
  // 有可写人类账号会话（me.role==="human" 且非分享链接）才允许铸 agent（spec §10）
  canMintAgent: boolean;
  canResetGuard: boolean;
  canModerate: boolean; // owner/admin 才 true：决定是否渲染可见性切换等管理控件（issue #38）
  agentNamePrefix: string; // 生成 agent 名的前缀来源（email/name 前缀，退回 slug）
  accountKey: string | null;
  inviterName: string; // 当前邀请人的频道身份名，接入包报到时 @ 他
  selfHandle: string | null; // 当前人类账号的 @handle（Task C2 被@通知用；agent/未设置 handle 时为 null）
  onAuthFailed(message: string): void;
}

// IM 式加载：初始/上翻每页条数，与 DOM 消息窗口上限（贴底时超出即丢最老页，上翻可拉回）
const PAGE_SIZE = 50;
const MESSAGE_CAP = 300;
const COLLAB_ROLES: CollaborationRole[] = ["host", "worker", "reviewer", "observer"];
// 触顶阈值：滚动到离顶部这么近就预取上一页
const TOP_LOAD_PX = 80;

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

export interface RoleDraft {
  role: CollaborationRole;
  responsibility: string;
}

type ChannelPanel = "charter" | "roles" | "coordination" | "tasks" | "search" | "settings";
type AdminSurface = "agentJoin" | "agentTokens" | "joinLink";
const TASK_BOARD_STATES: readonly TaskState[] = ["triage", "backlog", "assigned", "in_progress", "needs_review", "blocked", "done"];

function taskCompletionSeq(task: TaskRecord): number | null {
  if (task.state !== "needs_review" || task.completion_artifact === null) return null;
  const seq = task.anchor_seqs.at(-1);
  return Number.isInteger(seq) && (seq ?? 0) > 0 ? seq! : null;
}

function compactTaskTitle(text: string, fallback: string): string {
  const raw = text.replace(/\s+/g, " ").trim();
  const label = raw === "" ? fallback : raw;
  return label.length > 120 ? `${label.slice(0, 117)}...` : label;
}

function roleDraftFrom(role: ChannelRoleInfo): RoleDraft {
  return { role: role.role, responsibility: role.responsibility ?? "" };
}

function roleViewFor(role: ChannelRoleInfo, identity: ChannelIdentity | undefined, t: TFunc) {
  const kind = role.kind ?? identity?.kind ?? "agent";
  const account = role.account ?? identity?.account;
  const display = role.display ?? identity?.display ?? (kind === "human" && account ? account : role.name);
  const accountLabel = account && account !== "" ? account : kind === "human" ? display : t("Channel.roles.unowned");
  const owner = account && account !== display ? account : null;
  return { role, display, accountLabel, owner, kind };
}

export interface GuardSettingsPanelProps {
  canModerate: boolean;
  loopEnabled: boolean;
  loopLimit: string;
  workflowEnabled: boolean;
  workflowLimit: string;
  saving: "loop" | "workflow" | null;
  error: string | null;
  onLoopEnabled(next: boolean): void;
  onLoopLimit(next: string): void;
  onWorkflowEnabled(next: boolean): void;
  onWorkflowLimit(next: string): void;
  onSaveLoop(): void;
  onSaveWorkflow(): void;
  onLoopUnlimited(): void;
  onWorkflowUnlimited(): void;
}

export function GuardSettingsPanel({
  canModerate,
  loopEnabled,
  loopLimit,
  workflowEnabled,
  workflowLimit,
  saving,
  error,
  onLoopEnabled,
  onLoopLimit,
  onWorkflowEnabled,
  onWorkflowLimit,
  onSaveLoop,
  onSaveWorkflow,
  onLoopUnlimited,
  onWorkflowUnlimited,
}: GuardSettingsPanelProps) {
  const t = useT();
  return (
    <div className="guard-settings">
      <section className="guard-setting-row">
        <div className="guard-setting-head">
          <h3>{t("Channel.settings.loopGuard")}</h3>
          <label className="guard-switch">
            <input
              type="checkbox"
              checked={loopEnabled}
              disabled={!canModerate || saving !== null}
              onChange={(event) => onLoopEnabled(event.currentTarget.checked)}
            />
            <span>{loopEnabled ? t("Channel.settings.enabled") : t("Channel.settings.unlimited")}</span>
          </label>
        </div>
        <div className="guard-setting-controls">
          <input
            className="guard-limit-input"
            inputMode="numeric"
            pattern="[0-9]*"
            value={loopLimit}
            placeholder={loopEnabled ? t("Channel.settings.loopRange") : t("Channel.settings.unlimited")}
            disabled={!canModerate || !loopEnabled || saving !== null}
            onChange={(event) => onLoopLimit(event.currentTarget.value)}
          />
          <button type="button" className="d-btn d-btn--primary" disabled={!canModerate || saving !== null} onClick={onSaveLoop}>
            {saving === "loop" ? t("Channel.settings.saving") : t("Channel.settings.save")}
          </button>
          <button
            type="button"
            className="d-btn guard-unlimited-btn"
            disabled={!canModerate || saving !== null || !loopEnabled}
            onClick={onLoopUnlimited}
          >
            {t("Channel.settings.setUnlimited")}
          </button>
        </div>
      </section>
      <section className="guard-setting-row">
        <div className="guard-setting-head">
          <h3>{t("Channel.settings.workflowGuard")}</h3>
          <label className="guard-switch">
            <input
              type="checkbox"
              checked={workflowEnabled}
              disabled={!canModerate || saving !== null}
              onChange={(event) => onWorkflowEnabled(event.currentTarget.checked)}
            />
            <span>{workflowEnabled ? t("Channel.settings.enabled") : t("Channel.settings.off")}</span>
          </label>
        </div>
        <div className="guard-setting-controls">
          <input
            className="guard-limit-input"
            inputMode="numeric"
            pattern="[0-9]*"
            value={workflowLimit}
            placeholder={workflowEnabled ? t("Channel.settings.workflowRange") : t("Channel.settings.off")}
            disabled={!canModerate || !workflowEnabled || saving !== null}
            onChange={(event) => onWorkflowLimit(event.currentTarget.value)}
          />
          <button type="button" className="d-btn d-btn--primary" disabled={!canModerate || saving !== null} onClick={onSaveWorkflow}>
            {saving === "workflow" ? t("Channel.settings.saving") : t("Channel.settings.save")}
          </button>
          <button
            type="button"
            className="d-btn guard-unlimited-btn"
            disabled={!canModerate || saving !== null || !workflowEnabled}
            onClick={onWorkflowUnlimited}
          >
            {t("Channel.settings.turnOff")}
          </button>
        </div>
      </section>
      {error !== null && <p className="guard-setting-error">{error}</p>}
    </div>
  );
}

function roleCountLabel(role: CollaborationRole, count: number, t: TFunc): string {
  return t("Channel.roles.roleCount", { role, count: String(count) });
}

function selfReportedRoles(
  assignedRoles: ChannelRoleInfo[],
  presence: Record<string, PresenceEntry>,
  identities: ChannelIdentity[],
): ChannelRoleInfo[] {
  const assigned = new Set(assignedRoles.map((role) => role.name));
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));
  const roles: ChannelRoleInfo[] = [];
  for (const [name, entry] of Object.entries(presence)) {
    if (assigned.has(name)) continue;
    if (entry.role_source !== "self") continue;
    if (entry.role === undefined || !COLLAB_ROLES.includes(entry.role)) continue;
    const identity = identityByName.get(name);
    const kind = entry.kind ?? identity?.kind;
    const account = entry.account ?? identity?.account;
    roles.push({
      name,
      role: entry.role,
      responsibility: entry.note && entry.note.trim() !== "" ? entry.note : null,
      assigned_by: name,
      assigned_at: entry.ts ?? entry.last_seen ?? 0,
      ...(kind === undefined ? {} : { kind }),
      ...(account === undefined ? {} : { account }),
      display: identity?.display ?? name,
    });
  }
  return roles;
}

interface UnassignedMember {
  name: string;
  display: string;
  accountLabel: string;
  owner: string | null;
  kind: Sender["kind"];
}

// issue #169：分工面板此前只收录「已分配角色」（roles）+「self-report 过角色」
// （presence role_source==="self"）的成员——已连接但从没声明过角色的 agent 会被
// 整条跳过，界面上直接消失（"频道四个 agent 分工面板只有两个"）。这里把他们也
// 收进名单，用「未分工」占位展示，而不是从 roster 里彻底丢失。
// 名单来源取 presence（当前/最近连接过）∪ identities（channel 曾经见过的身份）
// 的并集，与 PresenceBar 的 names 并集口径一致；已在 roles/selfRoles 里出现的
// 名字（assigned 或 self）不重复收录。
function unassignedMembers(
  assignedRoles: ChannelRoleInfo[],
  selfRoles: ChannelRoleInfo[],
  presence: Record<string, PresenceEntry>,
  identities: ChannelIdentity[],
  t: TFunc,
): UnassignedMember[] {
  const known = new Set([...assignedRoles, ...selfRoles].map((role) => role.name));
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));
  const names = new Set([...Object.keys(presence), ...identities.map((identity) => identity.name)]);
  const members: UnassignedMember[] = [];
  for (const name of names) {
    if (name === "system" || known.has(name)) continue;
    const entry = presence[name];
    const identity = identityByName.get(name);
    const kind = entry?.kind ?? identity?.kind ?? "agent";
    const account = entry?.account ?? identity?.account;
    const display = identity?.display ?? name;
    const accountLabel = account && account !== "" ? account : kind === "human" ? display : t("Channel.roles.unowned");
    const owner = account && account !== display ? account : null;
    members.push({ name, display, accountLabel, owner, kind });
  }
  return members;
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
  lockedOpen = false,
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
  lockedOpen?: boolean;
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
        {lockedOpen ? (
          <div className="charter-toggle charter-toggle--static">
            <span>{t("Channel.charter.label")}</span>
            {charter ? <span className="t-mono">rev {charter.charter_rev}</span> : null}
            {updated ? <span className="charter-updated">{t("Channel.charter.updated")}</span> : null}
          </div>
        ) : (
          <button className="charter-toggle" type="button" onClick={onToggle} aria-expanded={open}>
            <span>{t("Channel.charter.label")}</span>
            {charter ? <span className="t-mono">rev {charter.charter_rev}</span> : null}
            {updated ? <span className="charter-updated">{t("Channel.charter.updated")}</span> : null}
          </button>
        )}
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

export interface DivisionBoardProps {
  canModerate: boolean;
  slug: string;
  roles: ChannelRoleInfo[];
  roleDrafts: Record<string, RoleDraft>;
  roleError: string | null;
  roleSaving: string | null;
  roleName: string;
  roleDraft: RoleDraft;
  identities: ChannelIdentity[];
  presence: Record<string, PresenceEntry>;
  onRoleDraft: (name: string, draft: RoleDraft) => void;
  onNewRoleName: (name: string) => void;
  onNewRoleDraft: (draft: RoleDraft) => void;
  onSaveRole: (name: string, draft: RoleDraft) => void;
  onDeleteRole: (name: string) => void;
  forceOpen?: boolean;
}

export function DivisionBoard({
  canModerate,
  slug,
  roles,
  roleDrafts,
  roleError,
  roleSaving,
  roleName,
  roleDraft,
  identities,
  presence,
  onRoleDraft,
  onNewRoleName,
  onNewRoleDraft,
  onSaveRole,
  onDeleteRole,
  forceOpen = false,
}: DivisionBoardProps) {
  const t = useT();
  const [selfHintOpen, setSelfHintOpen] = useState(false);
  const [selfHintCopied, setSelfHintCopied] = useState(false);
  useEffect(() => {
    if (!selfHintCopied) return;
    const timer = window.setTimeout(() => setSelfHintCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [selfHintCopied]);
  const selfReportCmd = `party status --channel ${slug} working --role worker --note ${JSON.stringify(
    t("Channel.roles.selfReport.exampleNote"),
  )}`;
  const copySelfReportCmd = () => {
    if (navigator.clipboard !== undefined) {
      void navigator.clipboard
        .writeText(selfReportCmd)
        .then(() => setSelfHintCopied(true))
        .catch(() => undefined);
    }
  };
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));
  const selfRoles = selfReportedRoles(roles, presence, identities);
  // issue #169：unassigned 也并入同一份 roleViews，保证 role-account-group 按
  // accountLabel 分组、渲染时 roster 完整——但 header 上的「N 个分工」徽标只数
  // 「已声明角色」（assigned + self），语义与 Channel.tools.roles 按钮上的
  // structuredRoleCount 徽标保持一致，不把「未分工」的人也算进"分工数"里。
  const unassigned = unassignedMembers(roles, selfRoles, presence, identities, t);
  const declaredCount = roles.length + selfRoles.length;
  const roleViews = [
    ...roles.map((role) => ({ ...roleViewFor(role, identityByName.get(role.name), t), source: "assigned" as const, name: role.name })),
    ...selfRoles.map((role) => ({ ...roleViewFor(role, identityByName.get(role.name), t), source: "self" as const, name: role.name })),
    ...unassigned.map((member) => ({ ...member, role: null, source: "unassigned" as const })),
  ]
    .sort(
      (a, b) =>
        a.accountLabel.localeCompare(b.accountLabel) ||
        (a.role?.role ?? "\uffff").localeCompare(b.role?.role ?? "\uffff") ||
        a.display.localeCompare(b.display),
    );
  const groups: Array<{ accountLabel: string; roles: typeof roleViews }> = [];
  for (const view of roleViews) {
    const current = groups.at(-1);
    if (current !== undefined && current.accountLabel === view.accountLabel) current.roles.push(view);
    else groups.push({ accountLabel: view.accountLabel, roles: [view] });
  }
  const roleCounts = COLLAB_ROLES
    .map((role) => ({ role, count: roleViews.filter((item) => item.role?.role === role).length }))
    .filter((item) => item.count > 0);

  return (
    <details className="role-board" aria-label={t("Channel.roles.label")} open={forceOpen ? true : undefined}>
      <summary className="role-board-head">
        <div>
          <h2>{t("Channel.roles.label")}</h2>
          <p className="t-mono">{t("Channel.roles.help")}</p>
        </div>
        <div className="role-board-summary">
          <span className="t-mono role-board-count">{t("Channel.roles.count", { count: String(declaredCount) })}</span>
          {roleCounts.map((item) => (
            <span key={item.role} className="t-mono role-board-role-count">
              {roleCountLabel(item.role, item.count, t)}
            </span>
          ))}
        </div>
      </summary>
      <div className="role-board-body">
        <div className="role-selfhint">
          <button
            type="button"
            className="role-selfhint-toggle t-mono"
            aria-expanded={selfHintOpen}
            onClick={() => setSelfHintOpen((v) => !v)}
          >
            <span>{t("Channel.roles.selfReport.summary")}</span>
            <span className="role-selfhint-arrow" aria-hidden="true">{selfHintOpen ? "▾" : "▸"}</span>
          </button>
          {selfHintOpen && (
            <div className="role-selfhint-body">
              <p>{t("Channel.roles.selfReport.intro")}</p>
              <div className="role-selfhint-cmd">
                <code className="t-mono">{selfReportCmd}</code>
                <button type="button" className="d-btn role-selfhint-copy" onClick={copySelfReportCmd}>
                  {selfHintCopied ? t("Channel.roles.selfReport.copied") : t("Channel.roles.selfReport.copy")}
                </button>
              </div>
              <p className="t-mono role-selfhint-meta">{t("Channel.roles.selfReport.roles")}</p>
              <p className="role-selfhint-caveat">{t("Channel.roles.selfReport.hostCaveat")}</p>
            </div>
          )}
        </div>
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
                  {group.roles.map(({ role, display, owner, accountLabel, kind, source, name }) => {
                    // issue #169：role 为 null 代表「已连接/曾出现过，但从没声明过角色」的
                    // 未分工成员——只读展示占位文案，不接可编辑的 role-select/input（那需要一个
                    // 真实的 ChannelRoleInfo；moderator 要给他分工，走下面的「添加」新建行）。
                    const draftForRole = role !== null ? roleDrafts[role.name] ?? roleDraftFrom(role) : null;
                    const title = [
                      name !== display ? name : null,
                      t("Composer.owner", { account: accountLabel }),
                      t(`Composer.kind.${kind}`),
                      role !== null ? t("Composer.role", { role: role.role }) : null,
                      role?.responsibility ? t("Composer.responsibility", { responsibility: role.responsibility }) : null,
                    ].filter((part): part is string => part !== null).join("\n");
                    return (
                      <div key={name} className="role-row">
                        <div className="role-person" title={title}>
                          <span className="role-person-name t-mono">{display}</span>
                          <span className={`role-kind role-kind--${kind}`}>{t(`Composer.kind.${kind}`)}</span>
                          {source === "self" && <span className="role-source t-mono">{t("Channel.roles.selfReported")}</span>}
                          {source === "unassigned" && (
                            <span className="role-source role-source--unassigned t-mono">{t("Channel.roles.unassigned")}</span>
                          )}
                          {owner !== null && <span className="role-owner t-mono">{owner}</span>}
                        </div>
                        {role === null || draftForRole === null ? (
                          <span className="role-text role-text--unassigned">{t("Channel.roles.noRoleYet")}</span>
                        ) : canModerate ? (
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
                              {roleSaving === role.name ? t("Channel.roles.saving") : source === "self" ? t("Channel.roles.register") : t("Channel.roles.save")}
                            </button>
                            {source === "assigned" && (
                              <button className="d-btn" type="button" disabled={roleSaving === role.name} onClick={() => onDeleteRole(role.name)}>
                                {t("Channel.roles.clear")}
                              </button>
                            )}
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

function ChannelPanelModal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="channel-panel-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <button className="channel-panel-scrim" type="button" aria-label={t("Channel.tools.close")} onClick={onClose} />
      <section className="channel-panel-card">
        <header className="channel-panel-head">
          <div className="channel-panel-titlebox">
            <h2>{title}</h2>
            {subtitle !== undefined && subtitle !== "" && <p className="t-mono">{subtitle}</p>}
          </div>
          <button className="d-btn channel-panel-close" type="button" onClick={onClose}>
            {t("Channel.tools.close")}
          </button>
        </header>
        <div className="channel-panel-body">{children}</div>
      </section>
    </div>
  );
}

function AgentFilterPanel({
  senders,
  filter,
  visible,
  total,
  onMode,
  onToggle,
  onKind,
  onClear,
}: {
  senders: string[];
  filter: AgentFilter;
  visible: number;
  total: number;
  onMode: (mode: AgentFilterMode) => void;
  onToggle: (agent: string) => void;
  onKind: (kind: AgentFilterKind) => void;
  onClear: () => void;
}) {
  const t = useT();
  const active = filter.agents.length > 0 || filter.kind !== null;
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
            <span>{t("Channel.filter.only")}</span>
          </button>
          <button
            className={"d-btn agent-filter-mode" + (filter.mode === "except" ? " is-active" : "")}
            type="button"
            aria-pressed={filter.mode === "except"}
            onClick={() => onMode("except")}
          >
            <span>{t("Channel.filter.hide")}</span>
          </button>
        </div>
        <div className="agent-filter-kinds" role="group" aria-label="agent filter kind">
          <button
            className={"d-btn agent-filter-kind" + (filter.kind === "human" ? " is-active" : "")}
            type="button"
            aria-pressed={filter.kind === "human"}
            onClick={() => onKind("human")}
          >
            <span>{t("Channel.filter.humans")}</span>
          </button>
          <button
            className={"d-btn agent-filter-kind" + (filter.kind === "agent" ? " is-active" : "")}
            type="button"
            aria-pressed={filter.kind === "agent"}
            onClick={() => onKind("agent")}
          >
            <span>{t("Channel.filter.agents")}</span>
          </button>
        </div>
        <span className="t-mono agent-filter-count">
          {active ? `${visible}/${total}` : `${total}`}
        </span>
        {active && (
          <button className="d-btn agent-filter-clear" type="button" onClick={onClear}>
            <span>{t("Channel.filter.clear")}</span>
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
  const t = useT();
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
          <h2 className="catchup-title">{t("Channel.heading.catchup")}</h2>
          <p className="catchup-range t-mono">
            #{seenSeq + 1}..#{latestSeq}
          </p>
        </div>
        <button className="d-btn catchup-action" type="button" onClick={onCaughtUp}>
          <span>{t("Channel.caughtUp")}</span>
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
  const t = useT();
  if (completions.length === 0) return null;

  return (
    <section className="completion-panel" aria-label="completion artifacts">
      <div className="completion-panel-head">
        <h2 className="completion-title">{t("Channel.heading.completions")}</h2>
        <span className="t-mono completion-count">
          {visible}/{completions.length}
        </span>
        <button className={"d-btn completion-toggle" + (enabled ? " is-active" : "")} type="button" onClick={onToggle}>
          <span>{enabled ? t("Channel.filter.all") : t("Channel.filter.only")}</span>
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
  const t = useT();
  const decisions = messages
    .filter((m) => m.kind === "status" && m.status?.decision !== undefined)
    .slice(-5)
    .reverse();
  if (decisions.length === 0) return null;

  return (
    <section className="decision-panel" aria-label="host decisions">
      <div className="decision-panel-head">
        <h2 className="decision-title">{t("Channel.heading.decisions")}</h2>
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
  const t = useT();
  if (teams.length === 0) return null;

  return (
    <section className="team-panel" aria-label="agent teams">
      <div className="team-panel-head">
        <h2 className="team-title">{t("Channel.heading.teams")}</h2>
        <span className="t-mono team-count">{teams.length}</span>
      </div>
      <ol className="team-list">
        {teams.map((team) => {
          const front = team.frontAgent;
          const workerMembers = front === null ? team.members : team.members.filter((member) => member.name !== front.name);
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
                <span
                  className={"t-mono team-front" + (front?.active ? " is-active" : "")}
                  title={front === null ? `front: ${team.rootAgent}` : `front: ${front.name} · state: ${front.state} · residency: ${front.residency}`}
                >
                  <span className={`d-dot d-dot--${front?.active ? front.state : "offline"}`} />
                  front {front?.name ?? team.rootAgent}
                </span>
                <span className="t-mono team-active">
                  {team.activeCount}/{team.memberCount} active
                </span>
                <span className={`t-mono team-residency team-residency--${team.residency}`}>
                  {team.residency === "human_driven" ? "manual" : team.residency}
                </span>
              </div>
              <div className="t-mono team-meta">{meta.join(" · ")}</div>
              <div className="team-members">
                {workerMembers.length === 0 && <span className="t-mono team-member team-member--empty">no workers</span>}
                {workerMembers.map((member) => (
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
  const t = useT();
  if (board.hosts.length === 0 && board.recommended_actions.length === 0 && board.conflicts.length === 0) return null;

  return (
    <section className="host-board-panel" aria-label="host board">
      <div className="host-board-head">
        <h2 className="host-board-title">{t("Channel.heading.hostBoard")}</h2>
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

export function TaskLedgerPanel({
  tasks,
  loading,
  error,
  canWrite,
  busyTaskId,
  actionError,
  creating,
  createError,
  onRefresh,
  onSetState,
  onAssign,
  onReview,
  onCreateTask,
}: {
  tasks: TaskRecord[];
  loading: boolean;
  error: string | null;
  canWrite: boolean;
  busyTaskId: number | null;
  actionError: string | null;
  creating: boolean;
  createError: string | null;
  onRefresh: () => void;
  onSetState: (id: number, state: TaskState) => void;
  onAssign: (id: number, name: string, kind: TaskAssigneeKind) => void;
  onReview: (task: TaskRecord, action: "approve" | "reject") => void;
  onCreateTask: (input: { title: string; desc: string }) => Promise<boolean>;
}) {
  const t = useT();
  const [assignDrafts, setAssignDrafts] = useState<Record<number, string>>({});
  const [assignKinds, setAssignKinds] = useState<Record<number, TaskAssigneeKind>>({});
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const counts = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.state] = (acc[task.state] ?? 0) + 1;
    return acc;
  }, {});
  const tasksByState = new Map<TaskState, TaskRecord[]>(TASK_BOARD_STATES.map((state) => [state, []]));
  for (const task of tasks) tasksByState.get(task.state)?.push(task);
  const disabled = loading || !canWrite;
  const stateLabel = (state: TaskState) => t(`Channel.tasks.state.${state}`);
  const submitNewTask = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (title === "" || creating) return;
    void onCreateTask({ title, desc: newDesc.trim() }).then((ok) => {
      if (!ok) return;
      setNewTitle("");
      setNewDesc("");
      setComposerOpen(false);
    });
  };
  const renderTask = (task: TaskRecord) => {
    const taskBusy = busyTaskId === task.id;
    const assignDraft = assignDrafts[task.id] ?? task.assignee?.name ?? "";
    const assignKind = assignKinds[task.id] ?? task.assignee?.kind ?? "agent";
    const reviewSeq = taskCompletionSeq(task);
    return (
      <li
        key={task.id}
        className={"task-card" + (dragTaskId === task.id ? " is-dragging" : "")}
        draggable={!disabled && !taskBusy}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", String(task.id));
          setDragTaskId(task.id);
        }}
        onDragEnd={() => setDragTaskId(null)}
      >
        <div className="task-card-main">
          <span className="t-mono task-id">#{task.id}</span>
          <strong>{task.title}</strong>
          <span className={`t-mono task-state task-state--${task.state}`}>{stateLabel(task.state)}</span>
        </div>
        {task.desc !== null && <p className="task-card-desc">{task.desc}</p>}
        <div className="task-card-meta">
          <span className="t-mono">P{task.priority}</span>
          {task.assignee !== null && <span className="t-mono">@{task.assignee.name}</span>}
          {task.parent_id !== null && <span className="t-mono">{t("Channel.tasks.meta.parent", { id: task.parent_id })}</span>}
          {task.anchor_seqs.map((seq) => <span key={seq} className="t-mono">{t("Channel.tasks.meta.msg", { seq })}</span>)}
          {task.labels.map((label) => <span key={label} className="t-mono task-label">{label}</span>)}
        </div>
        <div className="task-card-actions">
          <button className="task-action-btn" type="button" disabled={disabled || taskBusy || task.state === "in_progress"} onClick={() => onSetState(task.id, "in_progress")}>
            {t("Channel.tasks.action.claim")}
          </button>
          <button className="task-action-btn" type="button" disabled={disabled || taskBusy || task.state === "blocked"} onClick={() => onSetState(task.id, "blocked")}>
            {t("Channel.tasks.action.block")}
          </button>
          <button className="task-action-btn" type="button" disabled={disabled || taskBusy || task.state === "done"} onClick={() => onSetState(task.id, "done")}>
            {t("Channel.tasks.action.done")}
          </button>
          {reviewSeq !== null && (
            <>
              <button className="task-action-btn task-action-btn--review" type="button" disabled={disabled || taskBusy} onClick={() => onReview(task, "approve")}>
                {t("Channel.tasks.action.approve")}
              </button>
              <button className="task-action-btn" type="button" disabled={disabled || taskBusy} onClick={() => onReview(task, "reject")}>
                {t("Channel.tasks.action.reject")}
              </button>
            </>
          )}
          <form
            className="task-assign-form"
            onSubmit={(event) => {
              event.preventDefault();
              onAssign(task.id, assignDraft, assignKind);
            }}
          >
            <input
              aria-label={t("Channel.tasks.assignAria", { id: task.id })}
              disabled={disabled || taskBusy}
              value={assignDraft}
              placeholder={t("Channel.tasks.assignPlaceholder")}
              onChange={(event) => setAssignDrafts((current) => ({ ...current, [task.id]: event.currentTarget.value }))}
            />
            <select
              aria-label={t("Channel.tasks.kindAria", { id: task.id })}
              disabled={disabled || taskBusy}
              value={assignKind}
              onChange={(event) => setAssignKinds((current) => ({ ...current, [task.id]: event.currentTarget.value as TaskAssigneeKind }))}
            >
              <option value="agent">{t("Channel.tasks.kind.agent")}</option>
              <option value="human">{t("Channel.tasks.kind.human")}</option>
              <option value="squad">{t("Channel.tasks.kind.squad")}</option>
            </select>
            <button className="task-action-btn" type="submit" disabled={disabled || taskBusy || assignDraft.trim() === ""}>
              {t("Channel.tasks.action.assign")}
            </button>
          </form>
        </div>
      </li>
    );
  };
  return (
    <section className="task-ledger-panel" aria-label={t("Channel.tasks.panelAria")}>
      <header className="task-ledger-head">
        <p className="t-mono task-ledger-total">{t("Channel.tasks.total", { count: tasks.length })}</p>
        <div className="task-ledger-head-actions">
          {canWrite && (
            <button
              className="d-btn task-new-btn"
              type="button"
              aria-label={t("Channel.tasks.new")}
              aria-expanded={composerOpen}
              disabled={loading}
              onClick={() => setComposerOpen((open) => !open)}
            >
              + {t("Channel.tasks.new")}
            </button>
          )}
          <button className="d-btn" type="button" disabled={loading} onClick={onRefresh}>
            {loading ? t("Channel.tasks.refreshing") : t("Channel.tasks.refresh")}
          </button>
        </div>
      </header>
      {composerOpen && canWrite && (
        <form className="task-new-form" onSubmit={submitNewTask}>
          <input
            className="task-new-title"
            aria-label={t("Channel.tasks.newTitleAria")}
            placeholder={t("Channel.tasks.newTitlePlaceholder")}
            value={newTitle}
            disabled={creating}
            autoFocus
            onChange={(event) => setNewTitle(event.currentTarget.value)}
          />
          <textarea
            className="task-new-desc"
            aria-label={t("Channel.tasks.newDescAria")}
            placeholder={t("Channel.tasks.newDescPlaceholder")}
            value={newDesc}
            disabled={creating}
            rows={2}
            onChange={(event) => setNewDesc(event.currentTarget.value)}
          />
          {createError !== null && <p className="banner banner--red">{createError}</p>}
          <div className="task-new-actions">
            <button className="task-action-btn" type="submit" disabled={creating || newTitle.trim() === ""}>
              {creating ? t("Channel.tasks.newSubmitting") : t("Channel.tasks.newSubmit")}
            </button>
            <button
              className="task-action-btn"
              type="button"
              disabled={creating}
              onClick={() => { setComposerOpen(false); setNewTitle(""); setNewDesc(""); }}
            >
              {t("Channel.tasks.newCancel")}
            </button>
          </div>
        </form>
      )}
      {Object.keys(counts).length > 0 && (
        <div className="task-ledger-counts">
          {Object.entries(counts).map(([state, count]) => (
            <span key={state} className={`t-mono task-state task-state--${state}`}>{stateLabel(state as TaskState)} {count}</span>
          ))}
        </div>
      )}
      {error !== null && <p className="banner banner--red">{error}</p>}
      {actionError !== null && <p className="banner banner--red">{actionError}</p>}
      {tasks.length === 0 && error === null ? (
        <p className="charter-empty">{t("Channel.tasks.empty")}</p>
      ) : (
        <div className="task-board" role="list" aria-label={t("Channel.tasks.boardAria")}>
          {TASK_BOARD_STATES.map((state) => {
            const columnTasks = tasksByState.get(state) ?? [];
            return (
              <section
                key={state}
                className={"task-column" + (dragTaskId !== null ? " task-column--drop" : "")}
                aria-label={t("Channel.tasks.columnAria", { state: stateLabel(state) })}
                onDragOver={(event) => {
                  if (dragTaskId !== null && !disabled) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const rawId = event.dataTransfer.getData("text/plain");
                  const id = Number.parseInt(rawId, 10);
                  setDragTaskId(null);
                  if (!Number.isInteger(id) || disabled) return;
                  const task = tasks.find((item) => item.id === id);
                  if (task === undefined || task.state === state) return;
                  onSetState(id, state);
                }}
              >
                <header className="task-column-head">
                  <span className={`t-mono task-state task-state--${state}`}>{stateLabel(state)}</span>
                  <span className="t-mono task-column-count">{columnTasks.length}</span>
                </header>
                {columnTasks.length === 0 ? (
                  <p className="t-mono task-column-empty">{t("Channel.tasks.columnEmpty")}</p>
                ) : (
                  <ol className="task-list">{columnTasks.map(renderTask)}</ol>
                )}
              </section>
            );
          })}
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
  messageBySeq,
  onReply,
  onEdit,
  onRetract,
  canCreateTask,
  onCreateTask,
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
  // seq → 消息，用于把 reply_to 解析成完整的被引用消息（同一份 Map 从 ChannelPage 传下来，不在这里重建）
  messageBySeq: Map<number, MsgFrame>;
  onReply: (seq: number) => void;
  onEdit: (seq: number) => void;
  onRetract: (seq: number) => void;
  canCreateTask: boolean;
  onCreateTask: (seq: number) => void;
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
            quotedMessage={message.reply_to !== null ? messageBySeq.get(message.reply_to) ?? null : null}
            onReply={onReply}
            onEdit={onEdit}
            onRetract={onRetract}
            canCreateTask={canCreateTask}
            onCreateTask={onCreateTask}
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
  loopGuardEnabled,
  loopGuardLimit,
  workflowGuardEnabled,
  workflowGuardLimit,
  shareMode,
  canMintAgent,
  canResetGuard,
  canModerate,
  agentNamePrefix,
  accountKey,
  inviterName,
  selfHandle,
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
  const [wakeDeliveries, setWakeDeliveries] = useState<WakeDelivery[]>([]); // @ 唤醒台账（webhook 侧硬证据）
  const [charterEditing, setCharterEditing] = useState(false);
  const [charterDraft, setCharterDraft] = useState("");
  const [charterSaving, setCharterSaving] = useState(false);
  const [charterError, setCharterError] = useState<string | null>(null);
  const [channelRoles, setChannelRoles] = useState<ChannelRoleInfo[]>([]);
  const [channelSquads, setChannelSquads] = useState<ChannelSquad[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [taskSummary, setTaskSummary] = useState<TaskSummary | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [taskActionBusyId, setTaskActionBusyId] = useState<number | null>(null);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [taskCreating, setTaskCreating] = useState(false);
  const [taskCreateError, setTaskCreateError] = useState<string | null>(null);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RoleDraft>>({});
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDraft, setNewRoleDraft] = useState<RoleDraft>({ role: "worker", responsibility: "" });
  const [roleSaving, setRoleSaving] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [seenCharterRev, setSeenCharterRev] = useState(() => readSeenCharterRev(slug));
  const [activePanel, setActivePanel] = useState<ChannelPanel | null>(null);
  const [activeAdminSurface, setActiveAdminSurface] = useState<AdminSurface | null>(null);
  const [localLoopGuardEnabled, setLocalLoopGuardEnabled] = useState(loopGuardEnabled);
  const [localLoopGuardLimit, setLocalLoopGuardLimit] = useState(loopGuardLimit === null ? "" : String(loopGuardLimit));
  const [localWorkflowGuardEnabled, setLocalWorkflowGuardEnabled] = useState(workflowGuardEnabled);
  const [localWorkflowGuardLimit, setLocalWorkflowGuardLimit] = useState(String(workflowGuardLimit));
  const [guardSaving, setGuardSaving] = useState<"loop" | "workflow" | null>(null);
  const [guardConfigError, setGuardConfigError] = useState<string | null>(null);
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
  // 被@浏览器通知（Task C2）：opt-in 是全局 localStorage 设置，铃铛开关组件读/写；这里只持有一份
  // 供 ws 入帧点判定用。optin/selfHandle/t 都放 ref：onFrame 挂在 socket 连接的 effect 里，
  // 若把它们放进依赖数组，切铃铛/切语言会连累整个 ws 重连——用 ref 让判定读到最新值又不触发重连。
  const [optin, setOptin] = useState<boolean>(() => readNotifyOptin());
  const optinRef = useRef(optin);
  optinRef.current = optin;
  const selfHandleRef = useRef(selfHandle);
  selfHandleRef.current = selfHandle;
  const tRef = useRef(t);
  tRef.current = t;
  const notifiedSeqRef = useRef<Set<number>>(new Set()); // seq 去重：防同一帧被重复处理时重复弹通知
  const desktopMentionBadgeRef = useRef(0);
  const toastedSeqRef = useRef<Set<number>>(new Set()); // seq 去重：页内 toast 同一帧只弹一次
  const [toasts, setToasts] = useState<MentionToastItem[]>([]);
  const dismissToast = useCallback((seq: number) => {
    setToasts((cur) => cur.filter((tt) => tt.seq !== seq));
  }, []);
  const jumpToMention = useCallback((seq: number) => {
    setToasts((cur) => cur.filter((tt) => tt.seq !== seq));
    const el = document.getElementById(`msg-${seq}`);
    if (el === null) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("msg-jump-highlight");
    window.setTimeout(() => el.classList.remove("msg-jump-highlight"), 1200);
  }, []);
  const sockRef = useRef<ChannelSocket | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const pendingSendsRef = useRef<Array<{ draft: string; replyTo: number | null }>>([]);
  const stickBottom = useRef(true);
  const authFailedRef = useRef(onAuthFailed);
  authFailedRef.current = onAuthFailed;

  useEffect(() => {
    setLocalLoopGuardEnabled(loopGuardEnabled);
    setLocalLoopGuardLimit(loopGuardLimit === null ? "" : String(loopGuardLimit));
    setLocalWorkflowGuardEnabled(workflowGuardEnabled);
    setLocalWorkflowGuardLimit(String(workflowGuardLimit));
    setGuardConfigError(null);
    setGuardSaving(null);
  }, [loopGuardEnabled, loopGuardLimit, slug, workflowGuardEnabled, workflowGuardLimit]);
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

  const loadSquads = useCallback(() => {
    return fetchSquads(token, slug)
      .then((squads) => {
        setChannelSquads(squads);
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (!(err instanceof ForbiddenError)) setChannelSquads([]);
      });
  }, [slug, token]);

  const loadTaskLedger = useCallback(() => {
    setTasksLoading(true);
    return Promise.all([fetchTasks(token, slug), fetchTaskSummary(token, slug)])
      .then(([items, summary]) => {
        setTasks(items);
        setTaskSummary(summary);
        setTasksError(null);
        setTaskActionError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setTasksError(t("Channel.tasks.error.notVisible"));
        else setTasksError(t("Channel.tasks.error.loadFailed"));
      })
      .finally(() => setTasksLoading(false));
  }, [slug, token, t]);

  const loadTaskSummary = useCallback(() => {
    return fetchTaskSummary(token, slug)
      .then(setTaskSummary)
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
      });
  }, [slug, token]);

  const applyTaskUpdate = useCallback((id: number, body: Parameters<typeof updateTask>[3]) => {
    if (taskActionBusyId !== null) return;
    setTaskActionBusyId(id);
    setTaskActionError(null);
    updateTask(token, slug, id, body)
      .then((task) => {
        setTasks((current) => current.map((item) => item.id === task.id ? task : item));
        void loadTaskSummary();
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setTaskActionError(t("Channel.tasks.error.updateForbidden"));
        else if (err instanceof ValidationError) setTaskActionError(t("Channel.tasks.error.updateRejected"));
        else setTaskActionError(t("Channel.tasks.error.updateFailed"));
      })
      .finally(() => setTaskActionBusyId(null));
  }, [loadTaskSummary, slug, taskActionBusyId, token, t]);

  const setTaskState = useCallback((id: number, state: TaskState) => {
    applyTaskUpdate(id, { state });
  }, [applyTaskUpdate]);

  const assignTask = useCallback((id: number, rawName: string, kind: TaskAssigneeKind) => {
    const name = rawName.trim().replace(/^@/, "");
    if (name === "") {
      setTaskActionError(t("Channel.tasks.error.assigneeRequired"));
      return;
    }
    applyTaskUpdate(id, { state: "assigned", assignee: { name, kind } });
  }, [applyTaskUpdate, t]);

  // 面板内「新建任务」：复用后端既有 POST /api/channels/:slug/tasks（与 createTaskFromMessage 同一端点，
  // 不新造接口）。返回 boolean 让 composer 知道成功后才清空并收起。
  const createTaskDraft = useCallback((input: { title: string; desc: string }): Promise<boolean> => {
    if (taskCreating) return Promise.resolve(false);
    setTaskCreating(true);
    setTaskCreateError(null);
    return createTask(token, slug, {
      title: input.title,
      ...(input.desc === "" ? {} : { desc: input.desc }),
    })
      .then((task) => {
        setTasks((current) => current.some((item) => item.id === task.id) ? current : [task, ...current]);
        void loadTaskSummary();
        setTasksError(null);
        return true;
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setTaskCreateError(t("Channel.tasks.error.createForbidden"));
        else if (err instanceof ValidationError) setTaskCreateError(t("Channel.tasks.error.createRejected"));
        else setTaskCreateError(t("Channel.tasks.error.createFailed"));
        return false;
      })
      .finally(() => setTaskCreating(false));
  }, [loadTaskSummary, slug, taskCreating, token, t]);

  const reviewTask = useCallback((task: TaskRecord, action: "approve" | "reject") => {
    if (taskActionBusyId !== null) return;
    const seq = taskCompletionSeq(task);
    if (seq === null) {
      setTaskActionError(t("Channel.tasks.error.noReviewable"));
      return;
    }
    const reason = action === "reject" ? window.prompt(t("Channel.tasks.rejectPrompt"))?.trim() : undefined;
    if (action === "reject" && !reason) return;
    setTaskActionBusyId(task.id);
    setTaskActionError(null);
    reviewCompletion(
      token,
      slug,
      seq,
      action === "approve" ? { action: "approve" } : { action: "reject", reason: reason! },
    )
      .then(() => loadTaskLedger())
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setTaskActionError(t("Channel.tasks.error.reviewForbidden"));
        else if (err instanceof ValidationError) setTaskActionError(t("Channel.tasks.error.reviewRejected"));
        else setTaskActionError(t("Channel.tasks.error.reviewFailed"));
      })
      .finally(() => setTaskActionBusyId(null));
  }, [loadTaskLedger, slug, taskActionBusyId, token, t]);

  useEffect(() => {
    void loadTaskSummary();
  }, [loadTaskSummary]);

  const createTaskFromMessage = useCallback((seq: number) => {
    if (messageActionBusySeq !== null) return;
    const message = state.messages.find((item) => item.seq === seq);
    if (message === undefined || message.kind !== "message" || message.retracted) return;
    setMessageActionBusySeq(seq);
    setMessageActionError(null);
    createTask(token, slug, {
      title: compactTaskTitle(message.body, `${message.sender.name} message #${message.seq}`),
      anchor_seqs: [message.seq],
    })
      .then((task) => {
        setTasks((current) => current.some((item) => item.id === task.id) ? current : [task, ...current]);
        void loadTaskSummary();
        setTasksError(null);
        setActiveAdminSurface(null);
        setActivePanel("tasks");
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setMessageActionError({ seq, message: t("Channel.tasks.error.createForbidden") });
        else if (err instanceof ValidationError) setMessageActionError({ seq, message: t("Channel.tasks.error.createRejected") });
        else setMessageActionError({ seq, message: t("Channel.tasks.error.createFailed") });
      })
      .finally(() => setMessageActionBusySeq(null));
  }, [loadTaskSummary, messageActionBusySeq, slug, state.messages, token, t]);

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
    setCharterEditing(false);
    void loadCharter();
    void loadRoles();
    void loadSquads();
  }, [loadCharter, loadRoles, loadSquads, slug]);

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
          // 被@浏览器通知（Task C2）：每条 ws 入帧只处理一次，天然按 seq 去重；notifiedSeqRef 兜底
          // 防万一同一帧被重复送进这个回调（例如未来重连语义变化）时重复弹窗。
          if (
            frame.type === "msg" &&
            !notifiedSeqRef.current.has(frame.seq) &&
            shouldNotify(frame, selfHandleRef.current, document.hidden, optinRef.current)
          ) {
            notifiedSeqRef.current.add(frame.seq);
            const title = tRef.current("Channel.notify.title", { channel: slug });
            const body = summarizeReplyPreview(frame.body);
            if (isDesktopRuntime()) {
              void sendMentionNotification({ title, body, slug, seq: frame.seq });
            } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              const notification = new Notification(title, { body });
              notification.onclick = () => {
                window.focus();
                window.location.hash = `#msg-${frame.seq}`;
                notification.close();
              };
            }
          }
          if (frame.type === "msg") {
            const nextBadge = nextMentionBadgeCount(
              desktopMentionBadgeRef.current,
              frame,
              selfHandleRef.current,
              document.hidden,
            );
            if (nextBadge !== desktopMentionBadgeRef.current) {
              desktopMentionBadgeRef.current = nextBadge;
              void setDesktopBadge(nextBadge);
            }
          }
          // 被@页内 toast（聚焦态）：与上面的系统通知按 document.hidden 互斥，各自 seq 去重
          if (
            frame.type === "msg" &&
            !toastedSeqRef.current.has(frame.seq) &&
            shouldToast(frame, selfHandleRef.current, document.hidden, optinRef.current)
          ) {
            toastedSeqRef.current.add(frame.seq);
            setToasts((cur) =>
              [
                ...cur,
                {
                  seq: frame.seq,
                  sender: frame.sender, // 存原始 sender，渲染时用 resolveSenderLabel 解析，与消息卡显示保持一致
                  body: summarizeReplyPreview(frame.body),
                },
              ].slice(-3),
            );
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
    url.searchParams.delete("agentKind");
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
    if (shouldMarkSeen(document.hidden, stickBottom.current)) sendSeen(lastSeq);
    // 贴底时收窄消息窗口：DOM 不挂几千条；被丢弃的最老页上翻会重新拉回
    if (stickBottom.current && state.messages.length > MESSAGE_CAP + PAGE_SIZE) {
      dispatch({ type: "trim", keep: MESSAGE_CAP });
      hasMoreRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq]);

  useEffect(() => {
    const markVisible = () => {
      if (document.hidden) return;
      desktopMentionBadgeRef.current = 0;
      void setDesktopBadge(0);
      if (stickBottom.current) sendSeen(lastSeqRef.current);
    };
    document.addEventListener("visibilitychange", markVisible);
    window.addEventListener("focus", markVisible);
    markVisible();
    return () => {
      document.removeEventListener("visibilitychange", markVisible);
      window.removeEventListener("focus", markVisible);
      desktopMentionBadgeRef.current = 0;
      void setDesktopBadge(0);
    };
  }, [sendSeen]);

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
    // 与草稿 chips / 服务端 BODY_MENTION_RE 同一份语义：@ 前须行首或非标识符字符，不吃 email 里的 @
    const mentions = parseDraftMentions(body);
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

  const openPanel = useCallback((panel: ChannelPanel) => {
    setActiveAdminSurface(null);
    if (panel === "charter" && charter !== null) {
      writeSeenCharterRev(slug, charter.charter_rev);
      setSeenCharterRev(charter.charter_rev);
    }
    if (panel === "tasks") void loadTaskLedger();
    setActivePanel(panel);
  }, [charter, loadTaskLedger, slug]);

  const setAdminSurface = useCallback((surface: AdminSurface, open: boolean) => {
    setActivePanel(null);
    setActiveAdminSurface(open ? surface : null);
  }, []);

  const editCharter = useCallback(() => {
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

  const saveLoopGuard = useCallback(() => {
    if (guardSaving !== null) return;
    const limit = Number(localLoopGuardLimit);
    if (localLoopGuardEnabled && (!Number.isInteger(limit) || limit < 1 || limit > 10_000)) {
      setGuardConfigError(t("Channel.settings.invalidLoop"));
      return;
    }
    setGuardSaving("loop");
    setGuardConfigError(null);
    setLoopGuard(token, slug, localLoopGuardEnabled, localLoopGuardEnabled ? limit : undefined)
      .then((result) => {
        setLocalLoopGuardEnabled(result.enabled);
        setLocalLoopGuardLimit(result.limit === null ? "" : String(result.limit));
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setGuardConfigError(t("Channel.settings.forbidden"));
        else if (err instanceof ValidationError) setGuardConfigError(t("Channel.settings.invalidLoop"));
        else setGuardConfigError(t("Channel.settings.saveFailed"));
      })
      .finally(() => setGuardSaving(null));
  }, [guardSaving, localLoopGuardEnabled, localLoopGuardLimit, slug, t, token]);

  const saveWorkflowGuard = useCallback(() => {
    if (guardSaving !== null) return;
    const limit = Number(localWorkflowGuardLimit);
    if (localWorkflowGuardEnabled && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
      setGuardConfigError(t("Channel.settings.invalidWorkflow"));
      return;
    }
    setGuardSaving("workflow");
    setGuardConfigError(null);
    setWorkflowGuard(token, slug, localWorkflowGuardEnabled, localWorkflowGuardEnabled ? limit : undefined)
      .then((result) => {
        setLocalWorkflowGuardEnabled(result.enabled);
        setLocalWorkflowGuardLimit(String(result.limit ?? limit));
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setGuardConfigError(t("Channel.settings.forbidden"));
        else if (err instanceof ValidationError) setGuardConfigError(t("Channel.settings.invalidWorkflow"));
        else setGuardConfigError(t("Channel.settings.saveFailed"));
      })
      .finally(() => setGuardSaving(null));
  }, [guardSaving, localWorkflowGuardEnabled, localWorkflowGuardLimit, slug, t, token]);

  // 一键无限（issue #182）：直接把守卫置为 disabled=无限/关闭并落库，
  // 不需要用户先取消勾选再保存——把「无限」从复选框语义提升成显式动作。
  const setLoopUnlimited = useCallback(() => {
    if (guardSaving !== null) return;
    setGuardSaving("loop");
    setGuardConfigError(null);
    setLoopGuard(token, slug, false)
      .then((result) => {
        setLocalLoopGuardEnabled(result.enabled);
        setLocalLoopGuardLimit(result.limit === null ? "" : String(result.limit));
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setGuardConfigError(t("Channel.settings.forbidden"));
        else setGuardConfigError(t("Channel.settings.saveFailed"));
      })
      .finally(() => setGuardSaving(null));
  }, [guardSaving, slug, t, token]);

  const setWorkflowUnlimited = useCallback(() => {
    if (guardSaving !== null) return;
    setGuardSaving("workflow");
    setGuardConfigError(null);
    setWorkflowGuard(token, slug, false)
      .then((result) => {
        setLocalWorkflowGuardEnabled(result.enabled);
        setLocalWorkflowGuardLimit(result.limit === null ? String(workflowGuardLimit) : String(result.limit));
      })
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setGuardConfigError(t("Channel.settings.forbidden"));
        else setGuardConfigError(t("Channel.settings.saveFailed"));
      })
      .finally(() => setGuardSaving(null));
  }, [guardSaving, slug, t, token, workflowGuardLimit]);

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
    const mentions = parseDraftMentions(editDraft);
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
      ...channelSquads.map((squad) => squad.name),
      ...state.messages.map((m) => m.sender.name),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const senderListId = `senders-${slug}`;
  // seq → 消息：给引用预览用，把 reply_to 解析成完整消息（含发送者/正文/撤回状态）而不止一个编号。
  // 只在已加载窗口内查得到——超出 MESSAGE_CAP 或翻页边界外的历史引用会查不到，MessageCard 侧降级回纯编号。
  const messageBySeq = useMemo(() => new Map(state.messages.map((m) => [m.seq, m])), [state.messages]);
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
    () => mentionCandidates(state.participants, state.presence, state.self, teamNow, channelIdentities, channelRoles, channelSquads),
    [channelIdentities, channelRoles, channelSquads, state.participants, state.presence, state.self, teamNow],
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
    for (const identity of channelIdentities) if (!kind.has(identity.name) && identity.kind) kind.set(identity.name, identity.kind);
    for (const role of channelRoles) if (!kind.has(role.name) && role.kind) kind.set(role.name, role.kind);
    return (name: string): boolean => kind.get(name) === "agent";
  }, [channelIdentities, channelRoles, state.participants, state.presence, state.messages]);
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
    const known = new Set<string>([
      ...online,
      ...Object.keys(state.presence),
      ...channelIdentities.map((identity) => identity.name),
      ...channelRoles.map((role) => role.name),
      ...channelSquads.map((squad) => squad.name),
    ]);
    return parseDraftMentions(draft)
      .filter((name) => known.has(name) && name !== state.self)
      .map((name) => {
        const squad = channelSquads.find((item) => item.name === name);
        if (squad) return { name, display: squad.title ?? squad.name, tier: "wakeable", wakeKind: "webhook" };
        const live = mentionLiveness(name, online, state.presence, teamNow);
        return { name, display: identityDisplay[name]?.display ?? name, tier: live.tier, wakeKind: live.wakeKind };
      });
  }, [channelIdentities, channelRoles, channelSquads, draft, state.participants, state.presence, state.self, teamNow, identityDisplay]);
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
  const agentFilterActive = agentFilter.agents.length > 0 || agentFilter.kind !== null;
  const totalInView = q === "" ? timelineMessages.length : searchHits.length;
  const visibleInView = q === "" ? visibleMessages.length : visibleSearchHits.length;
  const structuredRoleCount = channelRoles.length + selfReportedRoles(channelRoles, state.presence, channelIdentities).length;
  const taskOpenCount = taskSummary?.open ?? tasks.filter((task) => task.state !== "done").length;
  const taskReviewCount = taskSummary?.needs_review ?? tasks.filter((task) => task.state === "needs_review").length;
  const taskBlockedCount = taskSummary?.blocked ?? tasks.filter((task) => task.state === "blocked").length;
  const taskMineCount = taskSummary?.mine ?? 0;

  const setAgentMode = useCallback((mode: AgentFilterMode) => {
    setAgentFilter((current) => ({ ...current, mode }));
  }, []);

  const toggleAgentFilter = useCallback((agent: string) => {
    setAgentFilter((current) => toggleAgent(current, agent));
  }, []);

  const setAgentKind = useCallback((kind: AgentFilterKind) => {
    setAgentFilter((current) => setKind(current, kind));
  }, []);

  const clearAgentFilter = useCallback(() => {
    setAgentFilter((current) => ({ ...current, agents: [], kind: null }));
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

  const coordinationContent = (
    <>
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
          onKind={setAgentKind}
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
    </>
  );

  const searchContent = (
    <div className="chan-search-panel">
      <div className="chan-search-row">
        <input
          className="t-mono chan-search"
          type="search"
          value={search}
          spellCheck={false}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("Channel.search.placeholder")}
          aria-label={t("Channel.search.aria")}
          autoFocus
        />
        {q !== "" && (
          <span className="t-mono chan-search-count">
            {searchLoading
              ? t("Channel.search.searching")
              : agentFilterActive
                ? t("Channel.search.hitsFiltered", { visible: visibleSearchHits.length, total: searchHits.length })
                : t("Channel.search.hits", { count: searchHits.length })}
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
            placeholder={t("Channel.search.fromPlaceholder")}
            aria-label={t("Channel.search.fromAria")}
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
            placeholder={t("Channel.search.sincePlaceholder")}
            aria-label={t("Channel.search.sinceAria")}
          />
          <input
            className="t-mono chan-filter-input chan-filter-input--short"
            type="number"
            min={1}
            max={1000}
            step={1}
            value={searchLimit}
            onChange={(e) => setSearchLimit(e.target.value)}
            placeholder={t("Channel.search.limitPlaceholder")}
            aria-label={t("Channel.search.limitAria")}
          />
        </div>
      )}
    </div>
  );

  return (
    <div className="chan">
      <MentionToast
        items={toasts}
        channel={slug}
        identityDisplay={identityDisplay}
        onJump={jumpToMention}
        onDismiss={dismissToast}
      />
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
      <div className="chan-toolstrip" aria-label={t("Channel.tools.label")}>
        <div className="chan-tool-buttons">
          <button
            type="button"
            className={"d-btn chan-tool-btn" + (charterUpdated ? " chan-tool-btn--updated" : "")}
            onClick={() => openPanel("charter")}
          >
            <span className="ap-sprite ap-sprite--announcement" aria-hidden="true" />
            <span>{t("Channel.tools.charter")}</span>
            {charter !== null && <span className="t-mono chan-tool-badge">rev {charter.charter_rev}</span>}
            {charterUpdated && <span className="t-mono chan-tool-badge chan-tool-badge--hot">{t("Channel.tools.updated")}</span>}
          </button>
          <button type="button" className="d-btn chan-tool-btn" onClick={() => openPanel("roles")}>
            <span className="ap-sprite ap-sprite--division" aria-hidden="true" />
            <span>{t("Channel.tools.roles")}</span>
            <span className="t-mono chan-tool-badge">{structuredRoleCount}</span>
          </button>
          <button type="button" className="d-btn chan-tool-btn" onClick={() => openPanel("coordination")}>
            <span className="ap-sprite ap-sprite--coordination" aria-hidden="true" />
            <span>{t("Channel.tools.coordination")}</span>
            {(agentFilterActive || completionOnly) && (
              <span className="t-mono chan-tool-badge chan-tool-badge--hot">{t("Channel.tools.active")}</span>
            )}
          </button>
          <button type="button" className="d-btn chan-tool-btn" onClick={() => openPanel("tasks")}>
            <span className="ap-sprite ap-sprite--tasks" aria-hidden="true" />
            <span>{t("Channel.tasks.title")}</span>
            <span className="t-mono chan-tool-badge">{taskOpenCount}</span>
          </button>
          {(taskOpenCount > 0 || taskReviewCount > 0 || taskBlockedCount > 0 || taskMineCount > 0) && (
            <div className="task-strip-summary" aria-label={t("Channel.tasks.summaryAria")}>
              <span className="t-mono chan-tool-badge">{t("Channel.tasks.summary.open", { count: taskOpenCount })}</span>
              {taskReviewCount > 0 && <span className="t-mono chan-tool-badge chan-tool-badge--hot">{t("Channel.tasks.summary.review", { count: taskReviewCount })}</span>}
              {taskBlockedCount > 0 && <span className="t-mono chan-tool-badge task-strip-summary--blocked">{t("Channel.tasks.summary.blocked", { count: taskBlockedCount })}</span>}
              {taskMineCount > 0 && <span className="t-mono chan-tool-badge">{t("Channel.tasks.summary.mine", { count: taskMineCount })}</span>}
            </div>
          )}
          <button type="button" className={"d-btn chan-tool-btn" + (q !== "" ? " is-active" : "")} onClick={() => openPanel("search")}>
            <span className="ap-sprite ap-sprite--search" aria-hidden="true" />
            <span>{t("Channel.tools.search")}</span>
            {q !== "" && <span className="t-mono chan-tool-badge">{searchLoading ? "..." : searchHits.length}</span>}
          </button>
          {canModerate && (
            <button type="button" className="d-btn chan-tool-btn" onClick={() => openPanel("settings")}>
              <span className="ap-sprite ap-sprite--settings" aria-hidden="true" />
              <span>{t("Channel.tools.settings")}</span>
              <span className="t-mono chan-tool-badge">
                {localLoopGuardEnabled ? localLoopGuardLimit : t("Channel.settings.unlimited")}
              </span>
            </button>
          )}
        </div>
        <div className="chan-tool-actions">
          <NotifyToggle optin={optin} onChange={setOptin} />
          {(canMintAgent || canModerate) && !state.archived && (
            <div className="chan-admin-actions">
              {canMintAgent && accountKey !== null && (
                <AgentJoin
                  slug={slug}
                  token={token}
                  namePrefix={agentNamePrefix}
                  inviterName={inviterName}
                  charter={charter}
                  accountKey={accountKey}
                  active={activeAdminSurface === "agentJoin"}
                  onActiveChange={(open) => setAdminSurface("agentJoin", open)}
                />
              )}
              {canMintAgent && accountKey !== null && (
                <AgentTokens
                  slug={slug}
                  token={token}
                  accountKey={accountKey}
                  inviterName={inviterName}
                  onAuthFailed={onAuthFailed}
                  active={activeAdminSurface === "agentTokens"}
                  onActiveChange={(open) => setAdminSurface("agentTokens", open)}
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
              {canModerate && (
                <JoinLink
                  slug={slug}
                  token={token}
                  onAuthFailed={onAuthFailed}
                  active={activeAdminSurface === "joinLink"}
                  onActiveChange={(open) => setAdminSurface("joinLink", open)}
                />
              )}
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
        </div>
      </div>
      {activePanel !== null && (
        <ChannelPanelModal
          title={
            activePanel === "charter" ? t("Channel.tools.charter") :
            activePanel === "roles" ? t("Channel.tools.roles") :
            activePanel === "coordination" ? t("Channel.tools.coordination") :
            activePanel === "tasks" ? t("Channel.tasks.title") :
            activePanel === "settings" ? t("Channel.tools.settings") :
            t("Channel.tools.search")
          }
          subtitle={
            activePanel === "charter" && charter !== null ? `rev ${charter.charter_rev}` :
            activePanel === "roles" ? t("Channel.roles.count", { count: String(structuredRoleCount) }) :
            activePanel === "tasks" ? t("Channel.tasks.subtitle", { open: taskOpenCount, review: taskReviewCount, blocked: taskBlockedCount }) :
            activePanel === "settings" ? (localLoopGuardEnabled ? t("Channel.settings.enabled") : t("Channel.settings.unlimited")) :
            activePanel === "search" && q !== "" ? t("Channel.search.hits", { count: searchHits.length }) :
            undefined
          }
          onClose={() => setActivePanel(null)}
        >
          {activePanel === "charter" && (
            <CharterBanner
              charter={charter}
              open={true}
              canModerate={canModerate}
              updated={charterUpdated}
              draft={charterDraft}
              saving={charterSaving}
              editing={charterEditing}
              error={charterError}
              lockedOpen
              onToggle={() => {}}
              onDraft={setCharterDraft}
              onEdit={editCharter}
              onCancel={cancelCharterEdit}
              onSave={saveCharter}
            />
          )}
          {activePanel === "roles" && (
            <DivisionBoard
              canModerate={canModerate}
              slug={slug}
              roles={channelRoles}
              roleDrafts={roleDrafts}
              roleError={roleError}
              roleSaving={roleSaving}
              roleName={newRoleName}
              roleDraft={newRoleDraft}
              identities={channelIdentities}
              presence={state.presence}
              forceOpen
              onRoleDraft={updateRoleDraft}
              onNewRoleName={setNewRoleName}
              onNewRoleDraft={setNewRoleDraft}
              onSaveRole={saveRole}
              onDeleteRole={clearRole}
            />
          )}
          {activePanel === "coordination" && coordinationContent}
          {activePanel === "tasks" && (
            <TaskLedgerPanel
              tasks={tasks}
              loading={tasksLoading}
              error={tasksError}
              canWrite={canWrite}
              busyTaskId={taskActionBusyId}
              actionError={taskActionError}
              creating={taskCreating}
              createError={taskCreateError}
              onRefresh={loadTaskLedger}
              onSetState={setTaskState}
              onAssign={assignTask}
              onReview={reviewTask}
              onCreateTask={createTaskDraft}
            />
          )}
          {activePanel === "settings" && (
            <GuardSettingsPanel
              canModerate={canModerate}
              loopEnabled={localLoopGuardEnabled}
              loopLimit={localLoopGuardLimit}
              workflowEnabled={localWorkflowGuardEnabled}
              workflowLimit={localWorkflowGuardLimit}
              saving={guardSaving}
              error={guardConfigError}
              onLoopEnabled={setLocalLoopGuardEnabled}
              onLoopLimit={setLocalLoopGuardLimit}
              onWorkflowEnabled={setLocalWorkflowGuardEnabled}
              onWorkflowLimit={setLocalWorkflowGuardLimit}
              onSaveLoop={saveLoopGuard}
              onSaveWorkflow={saveWorkflowGuard}
              onLoopUnlimited={setLoopUnlimited}
              onWorkflowUnlimited={setWorkflowUnlimited}
            />
          )}
          {activePanel === "search" && searchContent}
        </ChannelPanelModal>
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
                  quotedMessage={item.message.reply_to !== null ? messageBySeq.get(item.message.reply_to) ?? null : null}
                  onReply={startReply}
                  onEdit={startEdit}
                  onRetract={retractMessage}
                  canCreateTask={canWrite}
                  onCreateTask={createTaskFromMessage}
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
                  messageBySeq={messageBySeq}
                  onReply={startReply}
                  onEdit={startEdit}
                  onRetract={retractMessage}
                  canCreateTask={canWrite}
                  onCreateTask={createTaskFromMessage}
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
            {completionOnly ? t("Channel.empty.completionsFiltered") : t("Channel.empty.messagesFiltered")}
          </p>
        )}
        {q !== "" && !searchLoading && searchHits.length === 0 && searchInputError === null && searchError === null && (
          <p className="d-empty" role="status" aria-live="polite">
            {t("Channel.search.noMatch", { query: search.trim() })}
          </p>
        )}
        {q !== "" && !searchLoading && searchHits.length > 0 && visibleSearchHits.length === 0 && (
          <p className="d-empty" role="status" aria-live="polite">
            {t("Channel.empty.searchFiltered")}
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
