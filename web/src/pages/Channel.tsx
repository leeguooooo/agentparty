// 频道页：presence 条 + 实时消息流 + 内联错误条幅 + 插话框。
// App 用 key={slug} 挂载本组件，切频道即整体重建（socket/状态零残留）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { buildHostBoard, type Attachment, type ChannelSquad, type CollaborationRole, type HostBoard, type MsgFrame, type PresenceEntry, type ReadCursor, type SearchHit, type Sender, type TaskAssigneeKind, type TaskRecord, type TaskState, type TaskSummary, type WakeDelivery } from "@agentparty/shared";
import { AgentDetailModal } from "../components/AgentDetailModal";
import { AgentJoin } from "../components/AgentJoin";
import { AgentTokens } from "../components/AgentTokens";
import { VisibilityToggle } from "../components/VisibilityToggle";
import { JoinLink } from "../components/JoinLink";
import { Composer, type UploadItem } from "../components/Composer";
import { Markdown } from "../components/Markdown";
import { MessageCard } from "../components/MessageCard";
import { MentionToast, type MentionToastItem } from "../components/MentionToast";
import { NotifyToggle, readNotifyOptin } from "../components/NotifyToggle";
import { PresenceBar } from "../components/PresenceBar";
import { OrgTreePreview } from "../components/OrgTreePreview";
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
  fetchMessagesWithRetry,
  fetchTaskSummary,
  fetchTasks,
  fetchWakeDeliveries,
  kickParticipant,
  pauseAgent,
  resumeAgent,
  resetGuard,
  respondDecision,
  reviseMessage,
  reviewCompletion,
  searchMessages,
  setChannelCharter,
  setLoopGuard,
  setWorkflowGuard,
  setChannelRole,
  TooLargeError,
  updateTask,
  uploadAttachment,
  ValidationError,
} from "../lib/api";
import { agentHue } from "../lib/agentColor";
import { buildIdentityDisplay, type IdentityDisplayMap } from "../lib/identityDisplay";
import { mentionCandidates, mentionLiveness, parseDraftMentions, type DraftMentionStatus } from "../lib/mentions";
import { buildReceipts, type MentionReceipt } from "../lib/wakeReceipt";
import { completionMessages } from "../lib/completions";
import { catchupKey, summarizeCatchup, type CatchupDigest } from "../lib/digest";
import { buildOrgTree, type OrgMemberInput } from "../lib/orgTree";
import { formatDivisionSection, mergeDivisionIntoCharter, type DivisionCharterRole } from "../lib/divisionCharter";
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
import { historyFallbackRecovered } from "../lib/historyRecovery";
import { summarizeReplyPreview } from "../lib/replyPreview";
import { fmtTime } from "../lib/time";
import { groupTeamMessages, summarizeTeams, type TeamMessageThread, type TeamSummary } from "../lib/teams";
import { ChannelSocket } from "../lib/ws";
import { channelReducer, initialChannelState } from "../state";
import { useT, type TFunc } from "../i18n/useT";
import { ChannelToolstrip } from "../components/ChannelToolstrip";
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

type ChannelPanel = "charter" | "roles" | "coordination" | "tasks" | "agents" | "search" | "settings";
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

// #204 P1②：worker 更新 task 时广播的 system status note 形如 `task #12 in_progress`。
// 任一客户端收到就刷新任务台账，否则 board 的 open_claims/conflicts/blockers 会长期陈旧
// （本地 setTasks 只覆盖本客户端发起的更新）。抽成纯函数便于回归。
export function isTaskLedgerStatusNote(note: string): boolean {
  return /^task #\d+ /.test(note);
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
  // issue #150：一键把当前已声明分工同步进公告——DivisionBoard 只负责拼内容，
  // 落盘（网络请求 + rev 刷新）交给上层（Channel.tsx 已有 charter 状态机）。
  charterText: string | null;
  onSyncToCharter: (text: string) => void;
  syncingCharter: boolean;
  // issue #171：分工面板到「查看/编辑每个 agent 自己的规则」（AgentTokens，已在
  // commit 7f7e8e1 落地）的入口——门禁复用 Channel.tsx 里 AgentTokens 本身的门禁
  // （canMintAgent && accountKey !== null），不在这里重新定义一套。
  canManageAgentRules: boolean;
  onOpenAgentRules: () => void;
  // issue #272（审计重开）：点分工面板里的某个成员，打开它的单 Agent 详情弹窗
  // （工作状态/历史工作内容/在线状态）。可选——未接的调用方（如既有测试）行内保持只读展示。
  onOpenAgentDetail?: (name: string) => void;
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
  charterText,
  onSyncToCharter,
  syncingCharter,
  canManageAgentRules,
  onOpenAgentRules,
  onOpenAgentDetail,
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
  // issue #168\uff1a\u5206\u5de5\u8981\u770b\u5f97\u51fa\u7ec4\u7ec7\u67b6\u6784\u5173\u7cfb\u3002\u6c47\u62a5\u4eba\u53d6 presence.lineage.parent_agent\u2014\u2014
  // \u5728 agentparty \u7684 agent-dispatch \u6a21\u578b\u91cc\uff0c"\u8c01 spawn \u6211" \u672c\u5c31\u7b49\u4ef7\u4e8e "\u6211\u5411\u8c01\u6c47\u62a5/
  // \u4ea4\u4ed8"\uff0c\u4e0d\u662f\u53e6\u9020\u4e00\u5957\u4eba\u4e8b\u5173\u7cfb\u3002roster \u91cc\u540c\u65f6\u6536 assigned/self/unassigned \u4e09\u7c7b
  // \u540d\u5b57\uff0c\u7528\u6765\u5224\u65ad\u6c47\u62a5\u5bf9\u8c61\u300c\u662f\u5426\u5728\u672c\u9891\u9053\u53ef\u89c1\u300d\u2014\u2014\u4e0d\u5728\u573a\u5c31\u63d0\u793a\uff0c\u5e2e\u52a9\u53d1\u73b0/\u907f\u514d
  // \u8de8\u51fa\u672c\u9891\u9053\u8fb9\u754c\u7684\u6c47\u62a5\u5173\u7cfb\uff08\u771f\u6b63\u610f\u4e49\u4e0a\u7684\u7ec4\u7ec7\u5c42\u7ea7\u8df3\u7ea7\u5224\u5b9a\uff0c\u9700\u8981\u4e00\u4e2a\u6b63\u5f0f\u7684
  // \u7ba1\u7406\u5c42\u7ea7\u6a21\u578b\uff0c\u73b0\u6709\u6570\u636e\u505a\u4e0d\u5230\uff0c\u89c1\u4ea4\u63a5\u62a5\u544a\uff09\u3002
  const knownNames = new Set(roleViews.map((view) => view.name));
  const roleViewsWithReports = roleViews.map((view) => ({
    ...view,
    reportsTo: presence[view.name]?.lineage?.parent_agent ?? null,
  }));
  // issue #281：把同一份 roleViews（assigned/self/unassigned + reportsTo）喂给 buildOrgTree，
  // 折成一棵可整体预览的频道组织/汇报树——纯函数在 lib/orgTree.ts，环/孤儿处理都在那里。
  const orgMembers: OrgMemberInput[] = roleViewsWithReports.map((view) => ({
    name: view.name,
    display: view.display,
    role: view.role?.role ?? null,
    reportsTo: view.reportsTo,
    kind: view.kind,
    accountLabel: view.accountLabel,
    source: view.source,
  }));
  const orgTree = buildOrgTree(orgMembers);
  const groups: Array<{ accountLabel: string; roles: typeof roleViewsWithReports }> = [];
  for (const view of roleViewsWithReports) {
    const current = groups.at(-1);
    if (current !== undefined && current.accountLabel === view.accountLabel) current.roles.push(view);
    else groups.push({ accountLabel: view.accountLabel, roles: [view] });
  }
  const roleCounts = COLLAB_ROLES
    .map((role) => ({ role, count: roleViews.filter((item) => item.role?.role === role).length }))
    .filter((item) => item.count > 0);

  // issue #150\uff1a\u62ff\u5f53\u524d\u5df2\u58f0\u660e\u5206\u5de5\uff08assigned + self\uff0c\u4e0d\u542b\u672a\u5206\u5de5\u5360\u4f4d\uff09\u62fc\u6210 markdown
  // \u5c0f\u8282\uff0c\u5408\u5e76\u8fdb\u73b0\u6709\u516c\u544a\u6587\u672c\uff0c\u4ea4\u7ed9\u4e0a\u5c42\u843d\u76d8\u3002
  const syncDivisionToCharter = () => {
    const declared: DivisionCharterRole[] = roleViews
      .filter((view): view is typeof view & { role: NonNullable<typeof view.role> } => view.role !== null)
      .map((view) => ({
        display: view.display,
        accountLabel: view.accountLabel,
        role: view.role.role,
        responsibility: view.role.responsibility,
      }));
    const section = formatDivisionSection(declared, {
      heading: t("Channel.roles.syncHeading"),
      empty: t("Channel.roles.syncEmpty"),
    });
    onSyncToCharter(mergeDivisionIntoCharter(charterText ?? "", section));
  };

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
        {(canModerate || canManageAgentRules) && (
          <div className="role-board-actions">
            {canModerate && (
              <button
                type="button"
                className="d-btn role-sync-charter-btn"
                disabled={syncingCharter}
                onClick={syncDivisionToCharter}
              >
                {syncingCharter ? t("Channel.roles.syncingCharter") : t("Channel.roles.syncToCharter")}
              </button>
            )}
            {canManageAgentRules && (
              <button type="button" className="d-btn role-open-rules-btn" onClick={onOpenAgentRules}>
                {t("Channel.roles.openAgentRules")}
              </button>
            )}
          </div>
        )}
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
        <OrgTreePreview tree={orgTree} t={t} />
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
                  {group.roles.map(({ role, display, owner, accountLabel, kind, source, name, reportsTo }) => {
                    // issue #169：role 为 null 代表「已连接/曾出现过，但从没声明过角色」的
                    // 未分工成员——只读展示占位文案，不接可编辑的 role-select/input（那需要一个
                    // 真实的 ChannelRoleInfo；moderator 要给他分工，走下面的「添加」新建行）。
                    const draftForRole = role !== null ? roleDrafts[role.name] ?? roleDraftFrom(role) : null;
                    // issue #168：汇报对象是否在本频道 roster 里可见——不可见就提示，帮助
                    // 发现/避免跨出本频道边界的汇报关系。
                    const reportsToVisible = reportsTo !== null && knownNames.has(reportsTo);
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
                          {onOpenAgentDetail !== undefined ? (
                            <button
                              type="button"
                              className="role-person-name role-person-name--btn t-mono"
                              onClick={() => onOpenAgentDetail(name)}
                            >
                              {display}
                            </button>
                          ) : (
                            <span className="role-person-name t-mono">{display}</span>
                          )}
                          <span className={`role-kind role-kind--${kind}`}>{t(`Composer.kind.${kind}`)}</span>
                          {role !== null && role.role === "host" && (
                            <span className="role-lead-tag t-mono">{t("Channel.roles.channelLead")}</span>
                          )}
                          {source === "self" && <span className="role-source t-mono">{t("Channel.roles.selfReported")}</span>}
                          {source === "unassigned" && (
                            <span className="role-source role-source--unassigned t-mono">{t("Channel.roles.unassigned")}</span>
                          )}
                          {owner !== null && <span className="role-owner t-mono">{owner}</span>}
                          {reportsTo !== null && (
                            <span
                              className={"role-report" + (reportsToVisible ? "" : " role-report--external") + " t-mono"}
                            >
                              {reportsToVisible
                                ? t("Channel.roles.reportsTo", { parent: reportsTo })
                                : t("Channel.roles.reportsToExternal", { parent: reportsTo })}
                            </span>
                          )}
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

function SearchHitCard({ hit, onJump }: { hit: SearchHit; onJump: (seq: number) => void }) {
  const t = useT();
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
        <button
          className="t-mono completion-jump"
          type="button"
          title={t("Channel.search.jumpTitle")}
          onClick={() => onJump(hit.seq)}
        >
          #{hit.seq}
        </button>
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

// #187：agent 维度看板——每个 agent 在忙/空闲/阻塞/离线，手里在做/排队/待审/受阻多少任务。
// 纯只读聚合：数据全来自已有的 presence（状态/note）+ task 台账（按 assignee 归组），不新增后端。
type AgentBoardStatus = "busy" | "blocked" | "idle" | "offline";
const AGENT_STATUS_ORDER: Record<AgentBoardStatus, number> = { busy: 0, blocked: 1, idle: 2, offline: 3 };

export function AgentBoardPanel({ presence, tasks }: { presence: PresenceEntry[]; tasks: TaskRecord[] }) {
  const t = useT();
  const counts = new Map<string, { inProgress: number; queued: number; review: number; blocked: number }>();
  const bump = (name: string, key: "inProgress" | "queued" | "review" | "blocked") => {
    const cur = counts.get(name) ?? { inProgress: 0, queued: 0, review: 0, blocked: 0 };
    cur[key] += 1;
    counts.set(name, cur);
  };
  for (const task of tasks) {
    const name = task.assignee?.name;
    if (!name) continue;
    if (task.state === "in_progress") bump(name, "inProgress");
    else if (task.state === "assigned") bump(name, "queued");
    else if (task.state === "needs_review") bump(name, "review");
    else if (task.state === "blocked") bump(name, "blocked");
  }
  const presenceByName = new Map(presence.map((p) => [p.name, p]));
  const names = new Set<string>();
  for (const p of presence) if (p.kind !== "human") names.add(p.name);
  for (const name of counts.keys()) names.add(name);
  const statusOf = (p: PresenceEntry | undefined): AgentBoardStatus => {
    if (!p || p.live !== true) return "offline";
    if (p.state === "blocked") return "blocked";
    if (p.state === "working") return "busy";
    return "idle";
  };
  const rows = [...names]
    .map((name) => {
      const p = presenceByName.get(name);
      const c = counts.get(name) ?? { inProgress: 0, queued: 0, review: 0, blocked: 0 };
      return { name, status: statusOf(p), note: p?.note ?? null, ...c };
    })
    .sort((a, b) => AGENT_STATUS_ORDER[a.status] - AGENT_STATUS_ORDER[b.status] || b.inProgress - a.inProgress || a.name.localeCompare(b.name));

  if (rows.length === 0) {
    return (
      <section className="agent-board-panel" aria-label="agent board">
        <p className="agent-board-empty">{t("Channel.agents.empty")}</p>
      </section>
    );
  }
  return (
    <section className="agent-board-panel" aria-label="agent board">
      {rows.map((row) => (
        <div key={row.name} className={`agent-board-row agent-board-row--${row.status}`}>
          <div className="agent-board-row-head">
            <span className="agent-board-name">{row.name}</span>
            <span className={`t-mono agent-board-status agent-board-status--${row.status}`}>{t(`Channel.agents.status.${row.status}`)}</span>
          </div>
          {row.note !== null && row.note.trim() !== "" && <p className="agent-board-note">{row.note}</p>}
          <div className="agent-board-counts t-mono">
            <span title={t("Channel.agents.count.inProgress")}>▶ {row.inProgress}</span>
            <span title={t("Channel.agents.count.queued")}>⏳ {row.queued}</span>
            <span title={t("Channel.agents.count.review")}>👁 {row.review}</span>
            {row.blocked > 0 && <span className="agent-board-count-blocked" title={t("Channel.agents.count.blocked")}>⛔ {row.blocked}</span>}
          </div>
        </div>
      ))}
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
  identities = [],
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
  // #271(b)：频道身份（presence/identities），给指派输入框做可检索的 datalist 候选。
  identities?: ChannelIdentity[];
}) {
  const t = useT();
  const [assignDrafts, setAssignDrafts] = useState<Record<number, string>>({});
  const [assignKinds, setAssignKinds] = useState<Record<number, TaskAssigneeKind>>({});
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  // #271(a)：按受理人筛选看板。"all" 全量，"__unassigned__" 只看未指派。
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  // #271(d)：展开放大——CSS class 切宽度，外层 channel-panel-card 用 :has() 跟随。
  const [expandedView, setExpandedView] = useState(false);
  // #271(c)：任务详情弹层。存 id 不存快照，刷新后始终显示最新记录。
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const detailTask = detailTaskId === null ? null : tasks.find((task) => task.id === detailTaskId) ?? null;
  const counts = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.state] = (acc[task.state] ?? 0) + 1;
    return acc;
  }, {});
  const assigneeOptions = [...new Set(
    tasks.flatMap((task) => (task.assignee !== null ? [task.assignee.name] : [])),
  )].sort();
  const visibleTasks =
    assigneeFilter === "all" ? tasks :
    assigneeFilter === "__unassigned__" ? tasks.filter((task) => task.assignee === null) :
    tasks.filter((task) => task.assignee?.name === assigneeFilter);
  const tasksByState = new Map<TaskState, TaskRecord[]>(TASK_BOARD_STATES.map((state) => [state, []]));
  for (const task of visibleTasks) tasksByState.get(task.state)?.push(task);
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
          <button
            type="button"
            className="task-card-title"
            aria-label={t("Channel.tasks.detailOpenAria", { id: task.id })}
            onClick={() => setDetailTaskId(task.id)}
          >
            <strong>{task.title}</strong>
          </button>
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
              list="task-assignee-targets"
              autoComplete="off"
              spellCheck={false}
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
    <section
      className={"task-ledger-panel" + (expandedView ? " task-ledger-panel--expanded" : "")}
      aria-label={t("Channel.tasks.panelAria")}
    >
      {/* #271(b)：所有任务卡的指派输入共用同一份候选（参照 channel-role-targets 的写法） */}
      <datalist id="task-assignee-targets">
        {identities.map((identity) => (
          <option key={identity.name} value={identity.name}>{identity.display}</option>
        ))}
      </datalist>
      <header className="task-ledger-head">
        <p className="t-mono task-ledger-total">{t("Channel.tasks.total", { count: tasks.length })}</p>
        <div className="task-ledger-head-actions">
          {assigneeOptions.length > 0 && (
            <select
              className="task-filter-select t-mono"
              aria-label={t("Channel.tasks.filterAria")}
              value={assigneeFilter}
              onChange={(event) => setAssigneeFilter(event.currentTarget.value)}
            >
              <option value="all">{t("Channel.tasks.filterAll")}</option>
              <option value="__unassigned__">{t("Channel.tasks.filterUnassigned")}</option>
              {assigneeOptions.map((name) => (
                <option key={name} value={name}>@{name}</option>
              ))}
            </select>
          )}
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
          <button
            className="d-btn task-expand-btn"
            type="button"
            aria-label={t("Channel.tasks.expandAria")}
            aria-pressed={expandedView}
            onClick={() => setExpandedView((open) => !open)}
          >
            {expandedView ? t("Channel.tasks.collapse") : t("Channel.tasks.expand")}
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
      {detailTask !== null && (
        <div
          className="task-detail-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("Channel.tasks.detailAria", { id: detailTask.id })}
        >
          <button
            className="task-detail-scrim"
            type="button"
            aria-label={t("Channel.tasks.detailClose")}
            onClick={() => setDetailTaskId(null)}
          />
          <section className="task-detail-card">
            <header className="task-detail-head">
              <span className="t-mono task-id">#{detailTask.id}</span>
              <strong className="task-detail-title">{detailTask.title}</strong>
              <span className={`t-mono task-state task-state--${detailTask.state}`}>{stateLabel(detailTask.state)}</span>
              <button className="d-btn task-detail-close" type="button" onClick={() => setDetailTaskId(null)}>
                {t("Channel.tasks.detailClose")}
              </button>
            </header>
            {detailTask.desc !== null && detailTask.desc !== "" ? (
              <p className="task-detail-desc">{detailTask.desc}</p>
            ) : (
              <p className="charter-empty">{t("Channel.tasks.detailNoDesc")}</p>
            )}
            <dl className="task-detail-meta">
              <dt>{t("Channel.tasks.detail.priority")}</dt>
              <dd className="t-mono">P{detailTask.priority}</dd>
              <dt>{t("Channel.tasks.detail.assignee")}</dt>
              <dd className="t-mono">{detailTask.assignee !== null ? `@${detailTask.assignee.name} · ${detailTask.assignee.kind}` : "—"}</dd>
              <dt>{t("Channel.tasks.detail.createdBy")}</dt>
              <dd className="t-mono">{`${detailTask.created_by} · ${detailTask.created_by_kind}`}</dd>
              {detailTask.labels.length > 0 && (
                <>
                  <dt>{t("Channel.tasks.detail.labels")}</dt>
                  <dd className="t-mono">{detailTask.labels.join(", ")}</dd>
                </>
              )}
              {detailTask.parent_id !== null && (
                <>
                  <dt>{t("Channel.tasks.detail.parent")}</dt>
                  <dd className="t-mono">#{detailTask.parent_id}</dd>
                </>
              )}
              {detailTask.anchor_seqs.length > 0 && (
                <>
                  <dt>{t("Channel.tasks.detail.msgs")}</dt>
                  <dd className="t-mono">{detailTask.anchor_seqs.map((seq) => `#${seq}`).join(", ")}</dd>
                </>
              )}
              {detailTask.blocked_reason !== null && (
                <>
                  <dt>{t("Channel.tasks.detail.blockedReason")}</dt>
                  <dd>{detailTask.blocked_reason}</dd>
                </>
              )}
              {detailTask.external_ref !== null && (
                <>
                  <dt>{t("Channel.tasks.detail.externalRef")}</dt>
                  <dd className="t-mono">{detailTask.external_ref}</dd>
                </>
              )}
              <dt>{t("Channel.tasks.detail.created")}</dt>
              <dd className="t-mono">{fmtTime(detailTask.created_at)}</dd>
              <dt>{t("Channel.tasks.detail.updated")}</dt>
              <dd className="t-mono">{fmtTime(detailTask.updated_at)}</dd>
              {detailTask.completed_at !== null && (
                <>
                  <dt>{t("Channel.tasks.detail.completed")}</dt>
                  <dd className="t-mono">{fmtTime(detailTask.completed_at)}</dd>
                </>
              )}
            </dl>
          </section>
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
  presence,
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
  // #274：name → presence 条目，MessageCard 悬停发送者名/@提及展示实时状态
  presence: Record<string, PresenceEntry>;
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
            presence={presence}
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
  // 附件（#176）：已上传待随下一条消息发出的引用（attachments）+ 在途/失败的每文件上传态（uploads）。
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  // 失败重试要拿回原始 File；uploads 里只存元数据，File 本体放这个 ref（不进 render）。
  const uploadFilesRef = useRef<Map<string, File>>(new Map());
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
  const [pausingName, setPausingName] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [charter, setCharter] = useState<ChannelCharter | null>(null);
  const [wakeDeliveries, setWakeDeliveries] = useState<WakeDelivery[]>([]); // @ 唤醒台账（webhook 侧硬证据）
  // issue #272（审计重开）：单 Agent 详情弹窗——存被点开的 agent name，null = 关闭。
  const [openAgentDetail, setOpenAgentDetail] = useState<string | null>(null);
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

  useEffect(() => {
    if (historyError !== null && historyFallbackRecovered(state.status)) setHistoryError(null);
  }, [historyError, state.status]);
  const [messageActionBusySeq, setMessageActionBusySeq] = useState<number | null>(null);
  // 频道决策协议（#284）：人类/moderator 在频道内对某条 decision_request 拍板
  const [decisionBusySeq, setDecisionBusySeq] = useState<number | null>(null);
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

  // 人类对某条 decision_request 点选项/审批（#284）。reject 走一次 prompt 收理由（同 reviewTask 手法）。
  const respondToDecision = useCallback(
    (seq: number, choice: { action: "approve" | "reject" } | { option: number }) => {
      if (decisionBusySeq !== null) return;
      let body: { action: "approve" | "reject"; reason?: string } | { option: number };
      if ("action" in choice && choice.action === "reject") {
        const reason = window.prompt(t("Channel.decision.rejectPrompt"))?.trim();
        body = reason ? { action: "reject", reason } : { action: "reject" };
      } else {
        body = choice;
      }
      setDecisionBusySeq(seq);
      respondDecision(token, slug, seq, body)
        .catch((err: unknown) => {
          if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
          else if (err instanceof ForbiddenError) setMessageActionError({ seq, message: t("Channel.decision.error.forbidden") });
          else if (err instanceof ValidationError) setMessageActionError({ seq, message: t("Channel.decision.error.rejected") });
          else setMessageActionError({ seq, message: t("Channel.decision.error.failed") });
        })
        .finally(() => setDecisionBusySeq(null));
    },
    [decisionBusySeq, slug, token, t],
  );

  // #204：host board 的 conflicts 与 resolve-conflict / review-blockers 建议都从任务台账派生。
  // HostBoardPanel 在进频道时就渲染，若这里只拉 summary，board 会一直显示「无冲突」直到用户碰巧
  // 点开任务面板——空的 board 与「确实没有冲突」在界面上无法区分。故挂载时拉完整台账
  // （loadTaskLedger 同时取 tasks 与 summary，替代原先单拉 summary 的调用）。
  useEffect(() => {
    void loadTaskLedger();
  }, [loadTaskLedger]);

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
    const ok = window.confirm(t("Channel.kick.confirm", { name }));
    if (!ok) return;
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

  // 人为暂停某 agent 的接待（#180）：被 @ 也不唤醒（webhook 不投、serve/watch 自我抑制），消息仍进历史。
  const pauseAgentReception = useCallback((name: string, resumeAt: number | null) => {
    if (pausingName !== null) return;
    setPausingName(name);
    setPauseError(null);
    pauseAgent(token, slug, name, resumeAt ?? undefined)
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setPauseError(t("Channel.pause.forbidden"));
        else setPauseError(t("Channel.pause.failed"));
      })
      .finally(() => setPausingName(null));
  }, [pausingName, slug, token, t]);

  const resumeAgentReception = useCallback((name: string) => {
    if (pausingName !== null) return;
    setPausingName(name);
    setPauseError(null);
    resumeAgent(token, slug, name)
      .catch((err: unknown) => {
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) setPauseError(t("Channel.pause.forbidden"));
        else setPauseError(t("Channel.pause.failed"));
      })
      .finally(() => setPausingName(null));
  }, [pausingName, slug, token, t]);

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
    fetchMessagesWithRetry(token, slug, { before: Number.MAX_SAFE_INTEGER, limit: PAGE_SIZE })
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
          // #204 P1②：任一客户端更新 task 会广播一条 `task #N <state>` system status。
          // 收到就刷新台账，否则 board 的 open_claims/conflicts/blockers 会长期陈旧——本地
          // setTasks 只覆盖本客户端发起的更新，看不到别人改的（门禁 P1）。
          if (
            (frame.type === "msg" || frame.type === "status") &&
            frame.kind === "status" &&
            isTaskLedgerStatusNote(frame.note ?? frame.body)
          ) {
            void loadTaskLedger();
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
                  fullBody: frame.body, // #280：完整正文，供 toast 悬停看全文
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
  }, [slug, token, shareMode, bootstrapped, loadCharter, loadTaskLedger]);

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
    // 上传在途时按下 ⌘⏎ 不发（按钮已 disabled，但快捷键绕过它）——否则会漏掉还没落 R2 的引用。
    if (uploads.some((u) => u.status === "uploading")) return;
    // 有附件时允许空正文（纯图片/文件消息）
    if (body === "" && attachments.length === 0) return;
    // 与草稿 chips / 服务端 BODY_MENTION_RE 同一份语义：@ 前须行首或非标识符字符，不吃 email 里的 @
    const mentions = parseDraftMentions(body);
    const ok =
      sockRef.current?.send({
        type: "send",
        kind: "message",
        body,
        mentions,
        reply_to: replyTo,
        ...(attachments.length > 0 ? { attachments } : {}),
      }) ?? false;
    // ⌘⏎ 不受按钮 disabled 门控，断线窗口内发送失败要内联提示（草稿保留）
    if (ok) {
      pendingSendsRef.current.push({ draft, replyTo });
      // 附件已落 R2，ws 已接收帧 → 乐观清空待发引用（失败上传一并丢弃，失败时保留草稿由 ack 逻辑处理）
      setAttachments([]);
      setUploads([]);
      uploadFilesRef.current.clear();
    } else {
      dispatch({ type: "send_failed", message: "not connected — message not sent, draft kept" });
    }
  }, [draft, replyTo, attachments, uploads]);

  // 单文件上传：先落一条 uploading 态，成功转入 attachments、失败转 error 态（可重试）。
  const runUpload = useCallback(
    async (id: string, file: File) => {
      setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: "uploading", error: undefined } : u)));
      try {
        const meta = await uploadAttachment(token, slug, file);
        uploadFilesRef.current.delete(id);
        setUploads((prev) => prev.filter((u) => u.id !== id));
        setAttachments((prev) => (prev.some((a) => a.key === meta.key) ? prev : [...prev, meta]));
      } catch (err) {
        if (err instanceof AuthError) {
          authFailedRef.current("token revoked — paste a new one");
          return;
        }
        const error =
          err instanceof TooLargeError
            ? "file too large (max 25MB)"
            : err instanceof ForbiddenError
              ? "not allowed to upload here"
              : "upload failed";
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: "error", error } : u)));
      }
    },
    [token, slug],
  );

  // 选/拖/粘贴文件 → 每文件一条上传态并行上传；上限 25MB / 20 个由服务端强制，前端只报错不拦。
  const onPickFiles = useCallback(
    (files: FileList) => {
      for (const file of Array.from(files)) {
        const id = crypto.randomUUID();
        uploadFilesRef.current.set(id, file);
        setUploads((prev) => [...prev, { id, filename: file.name, size: file.size, status: "uploading" }]);
        void runUpload(id, file);
      }
    },
    [runUpload],
  );

  const onRetryUpload = useCallback(
    (id: string) => {
      const file = uploadFilesRef.current.get(id);
      if (file !== undefined) void runUpload(id, file);
    },
    [runUpload],
  );

  const onCancelUpload = useCallback((id: string) => {
    uploadFilesRef.current.delete(id);
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const onRemoveAttachment = useCallback((key: string) => {
    setAttachments((prev) => prev.filter((a) => a.key !== key));
  }, []);

  const canWrite = state.self !== null && !state.archived && !state.readonly;
  // 谁能回应决策（#284）：人类账号会话（canMintAgent ⟹ me.role==="human"）或频道 moderator。
  // 服务端才是权威（human OR moderator）；这里只决定是否给这位查看者渲染选项按钮。
  const canRespondDecision = !state.archived && (canModerate || canMintAgent);
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
    if (panel === "tasks" || panel === "agents") void loadTaskLedger();
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

  // issue #150：分工面板「同步到公告」——DivisionBoard 已经把分工内容拼好、合并进
  // 现有公告文本，这里只负责落盘，复用与 saveCharter 相同的 setChannelCharter 写路径
  // 和错误处理，唯一区别是写入的文本来自调用方而不是 charterDraft 状态。
  const syncDivisionToCharter = useCallback((nextText: string) => {
    if (charterSaving) return;
    setCharterSaving(true);
    setCharterError(null);
    setChannelCharter(token, slug, nextText)
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
  }, [charterSaving, slug, token]);

  // issue #171：分工面板到 AgentTokens（已有的 project-agent 规则查看/编辑面板，
  // commit 7f7e8e1）的入口——复用 setAdminSurface（关掉分工弹层，打开 AgentTokens），
  // 不重复造轮子。
  const openAgentRulesFromDivision = useCallback(() => {
    setAdminSurface("agentTokens", true);
  }, [setAdminSurface]);

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
    const ok = window.confirm(t("Channel.roles.clearConfirm", { name }));
    if (!ok) return;
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
  // #339 触顶上翻只挂在 onScroll 上：开 agent 筛选/completionOnly 后内容可能撑不满视口，
  // 元素不可滚动 → scroll 永不触发 → 历史永远加载不出来。这里主动补拉，
  // 每页 prepend 后随 firstSeq/可见条数变化重新评估，直到内容可滚或历史拉尽（loadOlder 自带防重入与终止）。
  useEffect(() => {
    const el = streamRef.current;
    if (el !== null && hasMoreRef.current && !loadingOlderRef.current && el.scrollHeight <= el.clientHeight) loadOlder();
  }, [visibleTimeline.length, firstSeq, loadOlder]);
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
    // #204 open_claims / conflicts / blockers 改由任务台账派生：把已加载的 tasks 一并喂进 buildHostBoard。
    // 注：tasks 目前在打开任务面板时惰性加载，未打开时 board 的 task 派生段为空（详见 loadTaskLedger）。
    () => buildHostBoard(slug, Object.values(state.presence), state.messages, tasks, teamNow, { loopGuardActive: state.loopGuard !== null }),
    [slug, state.loopGuard, state.messages, state.presence, tasks, teamNow],
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

  // #342 搜索命中跳回原消息。不复用 jumpToCompletion：它会 setCompletionOnly(true)，
  // 把非 completion 的命中从消息流里滤掉。清空搜索恢复消息流后再滚动+高亮（同 jumpToMention）；
  // 消息不在已加载窗口（MESSAGE_CAP/翻页边界外）时 getElementById 为 null → 停在原地，按钮 title 已注明。
  const jumpToSearchHit = useCallback((seq: number) => {
    setSearch("");
    window.setTimeout(() => {
      const el = document.getElementById(`msg-${seq}`);
      if (el === null) return;
      el.scrollIntoView({ block: "center" });
      el.classList.add("msg-jump-highlight");
      window.setTimeout(() => el.classList.remove("msg-jump-highlight"), 1200);
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
        pausingName={pausingName}
        onPauseAgent={pauseAgentReception}
        onResumeAgent={resumeAgentReception}
        roles={channelRoles}
        onOpenAgentDetail={setOpenAgentDetail}
      />
      {kickError !== null && <p className="banner banner--red">{kickError}</p>}
      {pauseError !== null && <p className="banner banner--red">{pauseError}</p>}
      {archiveError !== null && <p className="banner banner--red">{archiveError}</p>}
      <ChannelToolstrip
        buttons={
          <>
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
          <button type="button" className="d-btn chan-tool-btn" onClick={() => openPanel("agents")}>
            <span>{t("Channel.agents.title")}</span>
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
          </>
        }
        actions={
          <>
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
          </>
        }
      />
      {activePanel !== null && (
        <ChannelPanelModal
          title={
            activePanel === "charter" ? t("Channel.tools.charter") :
            activePanel === "roles" ? t("Channel.tools.roles") :
            activePanel === "coordination" ? t("Channel.tools.coordination") :
            activePanel === "tasks" ? t("Channel.tasks.title") :
            activePanel === "agents" ? t("Channel.agents.title") :
            activePanel === "settings" ? t("Channel.tools.settings") :
            t("Channel.tools.search")
          }
          subtitle={
            activePanel === "charter" && charter !== null ? `rev ${charter.charter_rev}` :
            activePanel === "roles" ? t("Channel.roles.count", { count: String(structuredRoleCount) }) :
            activePanel === "tasks" ? t("Channel.tasks.subtitle", { open: taskOpenCount, review: taskReviewCount, blocked: taskBlockedCount }) :
            activePanel === "agents" ? t("Channel.agents.subtitle") :
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
              charterText={charter?.charter ?? null}
              onSyncToCharter={syncDivisionToCharter}
              syncingCharter={charterSaving}
              canManageAgentRules={canMintAgent && accountKey !== null}
              onOpenAgentRules={openAgentRulesFromDivision}
              onOpenAgentDetail={setOpenAgentDetail}
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
              identities={channelIdentities}
            />
          )}
          {activePanel === "agents" && (
            <AgentBoardPanel presence={Object.values(state.presence)} tasks={tasks} />
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
      {openAgentDetail !== null && (
        <AgentDetailModal
          name={openAgentDetail}
          display={identityDisplay[openAgentDetail]?.display ?? openAgentDetail}
          kind={identityDisplay[openAgentDetail]?.kind ?? state.presence[openAgentDetail]?.kind ?? "agent"}
          owner={identityDisplay[openAgentDetail]?.account ?? state.presence[openAgentDetail]?.account ?? null}
          online={state.participants.some((p) => p.name === openAgentDetail)}
          presence={state.presence[openAgentDetail] ?? null}
          messages={state.messages}
          onClose={() => setOpenAgentDetail(null)}
        />
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
                  presence={state.presence}
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
                  canRespondDecision={canRespondDecision}
                  decisionBusy={decisionBusySeq === item.message.seq}
                  onDecisionRespond={respondToDecision}
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
                  presence={state.presence}
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
          : visibleSearchHits.map((hit) => <SearchHitCard key={hit.seq} hit={hit} onJump={jumpToSearchHit} />)}
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
      {canWrite && (state.status === "reconnecting" || state.status === "closed") && (
        <p className="banner banner--yellow conn-banner" role="alert">
          {state.status === "closed" ? t("Channel.conn.closed") : t("Channel.conn.reconnecting")}
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
          attachments={attachments}
          onPickFiles={onPickFiles}
          onRemoveAttachment={onRemoveAttachment}
          uploads={uploads}
          onRetryUpload={onRetryUpload}
          onCancelUpload={onCancelUpload}
        />
      )}
    </div>
  );
}
