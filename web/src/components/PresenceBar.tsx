// 顶部 presence 条：每参与者一个手绘胶囊（名字 + 蜡笔状态点 + note + 相对时间），
// 右端挂连接状态。"对方卡在哪"一眼可见（spec §9 第 3 块）。
import { evaluateHostLease, type ChannelRoleAssignment, type PresenceEntry, type PresenceState, type Sender } from "@agentparty/shared";
import { useEffect, useState, type CSSProperties } from "react";
import { agentHue } from "../lib/agentColor";
import { fmtRel } from "../lib/time";
import type { SocketStatus } from "../lib/ws";
import { useT } from "../i18n/useT";
import "../i18n/strings/PresenceBar";

interface Props {
  presence: Record<string, PresenceEntry>;
  participants: Sender[];
  status: SocketStatus;
  party?: boolean; // mode=party 的频道在最左挂蜡笔黄 PARTY 徽章
  isPublic?: boolean; // public 频道在最左挂蜡笔绿 PUBLIC 徽章（spec §4）
  canModerate?: boolean;
  removingName?: string | null;
  onRemoveParticipant?: (name: string) => void;
  roles?: ChannelRoleAssignment[];
}

export interface Item {
  name: string;
  kind: Sender["kind"];
  state: PresenceState | "online"; // "online" = 已连接但还没报过 status
  note: string | null;
  ts: number | null;
  lastSeen: number | null;
  role: NonNullable<PresenceEntry["role"]> | null;
  roleSource: NonNullable<PresenceEntry["role_source"]> | null;
  residency: NonNullable<PresenceEntry["residency"]> | null;
  wakeKind: NonNullable<PresenceEntry["wake"]>["kind"] | null;
  wakeVerifiedAt: number | null;
  context: PresenceEntry["context"] | null;
  lineage: NonNullable<PresenceEntry["lineage"]> | null;
  workflow: NonNullable<NonNullable<PresenceEntry["status"]>["workflow"]> | null;
  owner: string | null; // 所属人：agent 的操作者 / 人类的 email，仅连接中的参与者可知
  account: string | null; // 分组锚点：与 owner 同源，但离线也保留（owner 离线出于隐私置空，account 不受影响）
  handle: string | null; // 人类全局昵称，仅人类且已设置时有值；agent 恒为 null，天然回退 owner/name
  displayName: string | null;
  avatarUrl: string | null;
  avatarThumb: string | null;
  display: string;
  responsibility: string | null;
  connectionCount: number;
}

export interface PresenceGroup {
  key: string;
  label: string;
  human: Item | null;
  agents: Item[];
  items: Item[];
}

function hasActiveHostLease(item: Item, now: number): boolean {
  const state: PresenceState = item.state === "online" ? "working" : item.state;
  return evaluateHostLease(
    {
      state,
      ts: item.ts ?? 0,
      ...(item.lastSeen === null ? {} : { last_seen: item.lastSeen }),
      ...(item.role === null ? {} : { role: item.role }),
      ...(item.residency === null ? {} : { residency: item.residency }),
      ...(item.wakeKind === null
        ? {}
        : { wake: item.wakeVerifiedAt === null ? { kind: item.wakeKind } : { kind: item.wakeKind, verified_at: item.wakeVerifiedAt } }),
    },
    now,
  ).lease === "active";
}

function hostBadge(item: Item, now: number): string | null {
  if (item.role !== "host") return null;
  return hasActiveHostLease(item, now) ? "host" : "host stale";
}

function roleBadge(item: Item, now: number): string | null {
  const badge = item.role === null || item.role === "host" ? hostBadge(item, now) : item.role;
  if (badge === null) return null;
  return item.roleSource === "assigned" ? `*${badge}` : badge;
}

function residencyBadge(item: Item): string | null {
  if (item.residency === null) return null;
  if (item.residency === "human_driven") return "manual";
  return item.residency;
}

function wakeabilityBadge(item: Item): { text: string; tone: "off" | "pending" | "on" } | null {
  if (item.residency === "human_driven" || item.residency === "bare" || item.wakeKind === "none") {
    return { text: "not wakeable", tone: "off" };
  }
  if (item.wakeKind === null) return null;
  if (item.wakeVerifiedAt !== null) return { text: "wakeable", tone: "on" };
  return { text: "wake unverified", tone: "pending" };
}

function presenceRank(item: Item, now: number): number {
  if (hasActiveHostLease(item, now)) return 0;
  if (item.state === "blocked") return 1;
  if (item.state === "working") return 2;
  if (item.state !== "offline") return 3;
  if (item.wakeKind === "serve" || item.wakeKind === "watch" || item.wakeKind === "webhook") return 4;
  return 5;
}

// 分组锚点用 account（在线/离线都可得），不用 owner（离线出于隐私置空）——
// 否则同一个人离线时的会话会因 owner 缺失而各自单独成组，撑大人数统计。
export function ownerKey(item: Item): string {
  if (item.account !== null && item.account !== "") return `account:${item.account}`;
  return `${item.kind}:${item.name}`;
}

function ownerLabel(item: Item): string {
  // 显示优先级：handle > SSO display name > owner/account（email）> 原始 name。agent 恒无 handle，不受影响。
  if (item.handle !== null && item.handle !== "") return item.handle;
  if (item.displayName !== null && item.displayName !== "") return item.displayName;
  if (item.owner !== null && item.owner !== "") return item.owner;
  return item.name;
}

// 把已构造好的 Item 列表按账号折叠成组；在线/离线同账号归一组，label 走「人类优先」的 representative。
export function buildGroups(items: Item[]): PresenceGroup[] {
  const groupMap = new Map<string, PresenceGroup>();
  for (const item of items) {
    const key = ownerKey(item);
    const existing = groupMap.get(key);
    const group =
      existing ??
      ({
        key,
        label: ownerLabel(item),
        human: null,
        agents: [],
        items: [],
      } satisfies PresenceGroup);
    group.items.push(item);
    if (item.kind === "human" && group.human === null) group.human = item;
    else group.agents.push(item);
    groupMap.set(key, group);
  }
  // label 初值取自分组时第一个遇到的成员，但 handle 只可能来自人类成员——
  // 若同一账号下 agent 先于人类出现在传入顺序里，初值会漏掉 handle。
  // 分组结束后统一用「人类优先」的 representative 重算，和 renderGroup 里的口径保持一致、且与遍历顺序无关。
  for (const group of groupMap.values()) {
    group.label = ownerLabel(group.human ?? group.items[0]!);
  }
  return [...groupMap.values()];
}

// 顶部 "X/Y live" 计数：按账号折叠后的人数，而非会话行数——一个账号哪怕开多个离线会话也只算一个人。
export function countLiveGroups(groups: PresenceGroup[]): { live: number; total: number } {
  return {
    total: groups.length,
    live: groups.filter((g) => g.items.some((it) => it.state !== "offline")).length,
  };
}

function groupRank(group: PresenceGroup, now: number): number {
  return Math.min(...group.items.map((item) => presenceRank(item, now)));
}

// 展开/折叠偏好：默认折叠（人多时顶部不挤），记住用户上次选择。
const PRESENCE_EXPANDED_KEY = "ap_presence_expanded";

export function readPresenceExpanded(): boolean {
  try {
    return localStorage.getItem(PRESENCE_EXPANDED_KEY) === "1";
  } catch {
    return false; // 私有模式等场景 localStorage 不可用时，默认折叠
  }
}

function writePresenceExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(PRESENCE_EXPANDED_KEY, expanded ? "1" : "0");
  } catch {
    // 写入失败不阻断本次切换，只是刷新/换标签页后会回落到默认折叠
  }
}

export function PresenceBar({
  presence,
  participants,
  status,
  party = false,
  isPublic = false,
  canModerate = false,
  removingName = null,
  onRemoveParticipant,
  roles = [],
}: Props) {
  const t = useT();
  // 相对时间 30s 刷一次
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();

  // 默认折叠，展开态记 localStorage（记住偏好）。
  const [expanded, setExpanded] = useState(() => readPresenceExpanded());

  // 在线 sender 带 owner；离线/最近 presence 带 account。两者都归到同一账号块。
  const byName = new Map(participants.map((p) => [p.name, p]));
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  const names = [...new Set([...participants.map((p) => p.name), ...Object.keys(presence), ...roles.map((role) => role.name)])].sort();
  const items: Item[] = names.map((name) => {
    const entry = presence[name];
    const sender = byName.get(name);
    const assigned = roleByName.get(name);
    const owner = sender?.owner ?? entry?.account ?? assigned?.account ?? null;
    // 人类全局昵称：仅人类且已设置时有值，agent 恒为 null（协议层保证）。
    const handle = sender?.handle ?? entry?.handle ?? null;
    const displayName = sender?.display_name ?? entry?.display_name ?? null;
    const kind = sender?.kind ?? entry?.kind ?? assigned?.kind ?? "agent";
    const connected = byName.has(name);
    const meta = {
      lastSeen: entry?.last_seen ?? null,
      role: assigned?.role ?? entry?.role ?? null,
      roleSource: assigned !== undefined ? "assigned" as const : entry?.role_source ?? null,
      residency: entry?.residency ?? null,
      wakeKind: entry?.wake?.kind ?? null,
      wakeVerifiedAt: entry?.wake?.verified_at ?? null,
      context: entry?.context ?? null,
      lineage: entry?.lineage ?? sender?.lineage ?? null,
      workflow: entry?.status?.workflow ?? null,
      display: assigned?.display ?? handle ?? displayName ?? (kind === "human" && owner !== null ? owner : name),
      displayName,
      avatarUrl: sender?.avatar_url ?? entry?.avatar_url ?? null,
      avatarThumb: sender?.avatar_thumb ?? entry?.avatar_thumb ?? null,
      responsibility: assigned?.responsibility ?? null,
      connectionCount: sender?.connection_count ?? entry?.connection_count ?? (connected ? 1 : 0),
    };
    if (!connected) {
      // owner 本就仅连接中的参与者可知（见上方字段注释）；handle 依赖同一份可信度，一并置空，
      // 避免"显示 handle 但锚点缺失"的半可信状态——离线态照旧回退原始 name，行为与改动前一致。
      // account 不受此限制：它只用于分组锚点、不直接展示，离线也照样保留，
      // 否则同一账号的离线会话会各自单独成组，撑大顶部人数统计。
      return {
        name,
        kind,
        state: "offline",
        note: null,
        ts: entry?.ts ?? null,
        owner: null,
        account: owner,
        handle: null,
        ...meta,
        displayName: null,
        display: assigned?.display ?? name,
      };
    }
    if (entry && entry.state !== "offline") {
      return { name, kind, state: entry.state, note: entry.note, ts: entry.ts, owner, account: owner, handle, ...meta };
    }
    return { name, kind, state: "online", note: null, ts: entry?.ts ?? null, owner, account: owner, handle, ...meta };
  });
  const sortedGroups = buildGroups(items).sort((a, b) => {
    const rank = groupRank(a, now) - groupRank(b, now);
    if (rank !== 0) return rank;
    return a.label.localeCompare(b.label);
  });
  const [hoveredGroup, setHoveredGroup] = useState<{ key: string; left: number; top: number; width: number } | null>(null);
  function toggleExpanded() {
    setHoveredGroup(null); // 折叠会把 chip 移出 DOM，先关掉可能悬着的 popover
    setExpanded((prev) => {
      const next = !prev;
      writePresenceExpanded(next);
      return next;
    });
  }
  // 顶部计数按账号折叠后的人数（非会话行数）——离线会话已在 buildGroups 里按 account 归并。
  const { live: liveGroups, total: totalGroups } = countLiveGroups(sortedGroups);
  const blockedCount = items.filter((it) => it.state === "blocked").length;
  const duplicateCount = items.filter((it) => it.connectionCount > 1).length;
  // 折叠态下 chip 不在 DOM 里，popover 也不该跟着冒出来。
  const activePopoverGroup =
    !expanded || hoveredGroup === null ? null : sortedGroups.find((group) => group.key === hoveredGroup.key) ?? null;

  function showGroupPopover(group: PresenceGroup, rect: DOMRect) {
    const margin = 10;
    const width = Math.min(520, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
    const top = Math.min(rect.bottom + 8, Math.max(margin, window.innerHeight - 120));
    setHoveredGroup({ key: group.key, left, top, width });
  }

  function renderItem(it: Item, mode: "compact" | "full") {
    const badge = roleBadge(it, now);
    const residency = residencyBadge(it);
    const wakeability = wakeabilityBadge(it);
    const activeHost = hasActiveHostLease(it, now);
    const full = mode === "full";
    const titleParts = [
      it.owner !== null && it.owner !== it.name ? `${it.name} · ${it.owner}` : it.name,
      it.handle !== null && it.handle !== "" ? `handle: ${it.handle}` : null,
      it.role !== null ? `role: ${it.role}` : null,
      it.responsibility !== null && it.responsibility !== "" ? `responsibility: ${it.responsibility}` : null,
      it.roleSource !== null ? `role source: ${it.roleSource}` : null,
      it.residency !== null ? `residency: ${it.residency}` : null,
      it.wakeKind !== null ? `wake: ${it.wakeKind}` : null,
      it.wakeVerifiedAt !== null ? `wake verified: ${fmtRel(it.wakeVerifiedAt)}` : null,
      it.context?.config_kind !== undefined ? `config: ${it.context.config_kind}` : null,
      it.context?.config_fingerprint !== undefined ? `fingerprint: ${it.context.config_fingerprint}` : null,
      it.context?.workspace_id !== undefined ? `workspace id: ${it.context.workspace_id}` : null,
      it.context?.workspace_label !== undefined ? `workspace: ${it.context.workspace_label}` : null,
      it.context?.worktree_label !== undefined ? `worktree: ${it.context.worktree_label}` : null,
      it.lineage !== null ? `parent: ${it.lineage.parent_agent}` : null,
      it.lineage !== null ? `root: ${it.lineage.root_agent}` : null,
      it.lineage !== null ? `team: ${it.lineage.team_id}` : null,
      it.lineage !== null ? `depth: ${it.lineage.depth}` : null,
      it.lineage?.expires_at ? `expires: ${fmtRel(it.lineage.expires_at)}` : null,
      it.workflow !== null ? `workflow: ${it.workflow.workflow_id}` : null,
      it.workflow !== null ? `workflow kind: ${it.workflow.kind}` : null,
      it.workflow?.run_id ? `workflow run: ${it.workflow.run_id}` : null,
      it.workflow?.step_id ? `workflow step: ${it.workflow.step_id}` : null,
      it.workflow?.parent_summary_seq ? `parent summary: #${it.workflow.parent_summary_seq}` : null,
      it.connectionCount > 1 ? `${it.connectionCount} live sessions using this identity` : null,
      it.note !== null && it.note !== "" ? `note: ${it.note}` : null,
      it.lastSeen !== null ? `last seen: ${fmtRel(it.lastSeen)}` : null,
    ].filter((part): part is string => part !== null);
    return (
      <span
        key={it.name}
        className={
          `d-pill presence-pill${it.state === "blocked" ? " presence-pill--blocked" : ""}` +
          `${activeHost ? " presence-pill--active-host" : ""}` +
          `${it.connectionCount > 1 ? " presence-pill--duplicate" : ""}` +
          `${full ? " presence-pill--full" : ""}`
        }
        title={titleParts.join(" · ")}
        style={{ "--ah": agentHue(it.name) } as CSSProperties}
      >
        <span className={`d-dot d-dot--${it.state}`} />
        <span className="presence-name">{it.display}</span>
        <span className={`t-mono presence-kind presence-kind--${it.kind}`}>{it.kind}</span>
        {full && it.owner !== null && it.owner !== "" && it.owner !== it.name && (
          <span className="t-mono presence-owner">· {it.owner}</span>
        )}
        {badge !== null && (
          <span className={`t-mono presence-role${activeHost ? " presence-role--active" : ""}`}>
            {badge}
          </span>
        )}
        {full && it.lineage !== null && (
          <span className="t-mono presence-lineage">child:{it.lineage.parent_agent}</span>
        )}
        {full && residency !== null && <span className="t-mono presence-residency">{residency}</span>}
        {full && wakeability !== null && (
          <span className={`t-mono presence-wake presence-wake--${wakeability.tone}`}>{wakeability.text}</span>
        )}
        {full && it.context?.worktree_label !== undefined && (
          <span className="t-mono presence-context">{it.context.worktree_label}</span>
        )}
        {full && it.context?.config_kind !== undefined && (
          <span className="t-mono presence-context">cfg:{it.context.config_kind}</span>
        )}
        {it.connectionCount > 1 && (
          <span className="t-mono presence-duplicate">x{it.connectionCount} sessions</span>
        )}
        {full && it.workflow !== null && <span className="t-mono presence-context">wf:{it.workflow.workflow_id}</span>}
        {full && it.note !== null && it.note !== "" && <span className="t-mono presence-note">{it.note}</span>}
        {full && it.responsibility !== null && it.responsibility !== "" && (
          <span className="t-mono presence-note">{it.responsibility}</span>
        )}
        {it.ts !== null && <span className="t-mono presence-ts">{fmtRel(it.ts)}</span>}
        {full && canModerate && onRemoveParticipant !== undefined && it.name !== "system" && (
          <button
            className="presence-kick"
            type="button"
            disabled={removingName === it.name}
            title={t("PresenceBar.kickTitle", { name: it.name })}
            onClick={(e) => {
              e.stopPropagation();
              onRemoveParticipant(it.name);
            }}
          >
            {t("PresenceBar.kick")}
          </button>
        )}
      </span>
    );
  }

  function renderGroup(group: PresenceGroup, mode: "compact" | "full") {
    const full = mode === "full";
    const representative = group.human ?? group.items[0]!;
    const live = group.items.filter((item) => item.state !== "offline").length;
    const blocked = group.items.filter((item) => item.state === "blocked").length;
    const duplicateSessions = group.items.reduce((sum, item) => sum + Math.max(0, item.connectionCount - 1), 0);
    const previewAgents = group.agents.slice(0, 3);
    const hiddenAgents = group.agents.length - previewAgents.length;
    const title = [
      group.label,
      // group.label 优先显示 handle 时，account/email 锚点在这里补回来，保证底层身份始终可查。
      representative.owner !== null && representative.owner !== group.label ? `account: ${representative.owner}` : null,
      `${live}/${group.items.length} live`,
      duplicateSessions > 0 ? `${duplicateSessions} extra live session${duplicateSessions === 1 ? "" : "s"}` : null,
      group.human !== null ? `human: ${group.human.name}` : null,
      group.agents.length > 0 ? `agents: ${group.agents.map((item) => item.name).join(", ")}` : null,
    ].filter((part): part is string => part !== null).join(" · ");
    return (
      <section
        key={group.key}
        tabIndex={full ? undefined : 0}
        className={
          `presence-group${blocked > 0 ? " presence-group--blocked" : ""}` +
          `${duplicateSessions > 0 ? " presence-group--duplicate" : ""}` +
          `${full ? " presence-group--full" : ""}`
        }
        title={title}
        style={{ "--ah": agentHue(group.label) } as CSSProperties}
        onMouseEnter={(e) => {
          if (!full) showGroupPopover(group, e.currentTarget.getBoundingClientRect());
        }}
        onMouseLeave={() => {
          if (!full) setHoveredGroup(null);
        }}
        onFocus={(e) => {
          if (!full) showGroupPopover(group, e.currentTarget.getBoundingClientRect());
        }}
        onBlur={() => {
          if (!full) setHoveredGroup(null);
        }}
      >
        <div className="presence-group-head">
          {representative.avatarThumb || representative.avatarUrl ? (
            <img className="presence-group-avatar" src={representative.avatarThumb ?? representative.avatarUrl ?? ""} alt="" />
          ) : (
            <span className={`d-dot d-dot--${representative.state}`} />
          )}
          <span className="presence-group-label">{group.label}</span>
          <span className="t-mono presence-group-count">
            {live}/{group.items.length}
          </span>
          {duplicateSessions > 0 && <span className="t-mono presence-group-duplicate">dup</span>}
        </div>
        {!full && (
          <div className="presence-group-agents" aria-label={`agents owned by ${group.label}`}>
            {previewAgents.map((agent) => (
              <span key={agent.name} className="presence-agent-chip">
                <span className={`d-dot d-dot--${agent.state}`} />
                <span>{agent.display}</span>
                <span className={`t-mono presence-agent-kind presence-kind--${agent.kind}`}>{agent.kind}</span>
                {agent.connectionCount > 1 && <span className="t-mono presence-agent-duplicate">x{agent.connectionCount}</span>}
                {roleBadge(agent, now) !== null && <span className="t-mono presence-agent-role">{roleBadge(agent, now)}</span>}
              </span>
            ))}
            {hiddenAgents > 0 && <span className="t-mono presence-agent-more">+{hiddenAgents}</span>}
          </div>
        )}
        {full && <div className="presence-group-detail">{group.items.map((item) => renderItem(item, "full"))}</div>}
      </section>
    );
  }

  return (
    <div className={`presence-bar${expanded ? "" : " presence-bar--collapsed"}`}>
      <div className="presence-head">
        <div className="presence-meta" aria-label="channel presence summary">
          {isPublic && <span className="d-hl public-badge">PUBLIC</span>}
          {party && <span className="d-hl party-badge">PARTY</span>}
          {blockedCount > 0 && <span className="t-mono presence-alert">{blockedCount} blocked</span>}
          {duplicateCount > 0 && <span className="t-mono presence-alert presence-alert--duplicate">{duplicateCount} duplicate</span>}
          {items.length === 0 && (
            <span className="t-mono presence-empty" role="status" aria-live="polite">
              nobody here yet
            </span>
          )}
        </div>
        <span className="conn t-mono" data-s={status} role="status" aria-live="polite">
          {status === "open" ? "● live" : `◌ ${status}…`}
        </span>
      </div>
      <button
        type="button"
        className="presence-toggle"
        aria-expanded={expanded}
        aria-label={t(expanded ? "PresenceBar.collapse" : "PresenceBar.expand")}
        onClick={toggleExpanded}
      >
        <span className="t-mono presence-summary">
          {liveGroups}/{totalGroups} live
        </span>
        <span className="presence-toggle-arrow" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="presence-strip" aria-label="participant groups by owner">
          {sortedGroups.map((group) => renderGroup(group, "compact"))}
        </div>
      )}
      {activePopoverGroup !== null && hoveredGroup !== null && (
        <div
          className="presence-popover"
          role="tooltip"
          style={{
            left: hoveredGroup.left,
            top: hoveredGroup.top,
            width: hoveredGroup.width,
            "--ah": agentHue(activePopoverGroup.label),
          } as CSSProperties}
        >
          <header className="presence-popover-head">
            <span className="presence-popover-title">{activePopoverGroup.label}</span>
            <span className="t-mono presence-popover-count">
              {activePopoverGroup.items.filter((item) => item.state !== "offline").length}/{activePopoverGroup.items.length} live
            </span>
          </header>
          <div className="presence-popover-list">
            {activePopoverGroup.items.map((item) => renderItem(item, "full"))}
          </div>
        </div>
      )}
    </div>
  );
}
