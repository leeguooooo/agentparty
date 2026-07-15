// 顶部 presence 条：每参与者一个手绘胶囊（名字 + 蜡笔状态点 + note + 相对时间），
// 右端挂连接状态。"对方卡在哪"一眼可见（spec §9 第 3 块）。
import { evaluateHostLease, wakeableState, type ChannelRoleAssignment, type PresenceEntry, type PresenceState, type Sender } from "@agentparty/shared";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
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
  isPublic?: boolean; // public / public_watch 频道在最左挂蜡笔绿徽章（spec §4）
  publicWatch?: boolean; // #381：public_watch 时徽章文案显「WATCH」（观看公开）区分纯 public
  canModerate?: boolean;
  removingName?: string | null;
  onRemoveParticipant?: (name: string) => void;
  // 人为暂停/恢复某 agent 的接待（#180）。resumeAt=null 即开放式暂停（手动恢复）。
  pausingName?: string | null;
  onPauseAgent?: (name: string, resumeAt: number | null) => void;
  onResumeAgent?: (name: string) => void;
  roles?: ChannelRoleAssignment[];
  headerControls?: ReactElement | null;
  // issue #272（审计重开）：点 presence roster 里的某个人/agent，打开它的单 Agent 详情弹窗。
  onOpenAgentDetail?: (name: string) => void;
}

// 暂停时长预设（#180）：值 → 相对 now 的恢复时刻（epoch ms），"indefinite" 返回 null（手动恢复）。
export function pauseResumeAt(preset: string, now: number): number | null {
  switch (preset) {
    case "1h":
      return now + 3_600_000;
    case "4h":
      return now + 4 * 3_600_000;
    case "8h":
      return now + 8 * 3_600_000;
    case "tomorrow": {
      // 次日 09:00（本地时区）——常见「明早再说」语义。
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    default:
      return null; // indefinite
  }
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
  clientVersion: string | null;
  // 人为暂停接待（#180）：被 @ 也不唤醒（webhook 不投、serve/watch 自我抑制），消息仍进历史。
  paused: boolean;
  resumeAt: number | null; // 定时恢复时刻（epoch ms）；null = 需手动恢复
  // busy（#103）：serve 正串行处理一条 wake，可达但回复会慢。working = 在干活，busy = 正忙无法即时响应新 @。
  busy: boolean;
  queueDepth: number | null; // 忙时身后排队、尚未处理的 wake 数；>0 才有值
  // 已挂起等待 owner 的 work 数；不占 runner，与 busy/queue 分开展示。
  waitingOwnerCount: number;
  // 每任务进度/心跳（#228）：正在处理哪条 wake（触发 seq）、最近心跳时刻。比 busy 更细——能区分
  // 「还在干、活到 T」与「卡死」。null = 无活跃任务。
  currentTask: number | null;
  heartbeatAt: number | null; // 最近心跳（epoch ms）；据 now-heartbeatAt 算新鲜度
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

// busy 标签（#103）：「⏳ busy」或「⏳ busy · N queued」。null = 不忙，不渲染。
export function busyLabel(item: Item): string | null {
  if (!item.busy) return null;
  return item.queueDepth !== null ? `⏳ busy · ${item.queueDepth} queued` : "⏳ busy";
}

export function waitingOwnerLabel(item: Item): string | null {
  return item.waitingOwnerCount > 0 ? `💬 ${item.waitingOwnerCount} waiting owner` : null;
}

// 每任务进度/心跳 chip（#228）：「▶ #510」或「▶ #510 · ♥ 8s」。比 busy 更细——不仅「在忙」，还标明
// 正在处理哪条 wake（触发 seq）和心跳新鲜度。心跳还在推进 = 活着；很旧 = 大概率卡死。null = 无活跃任务。
export function taskLabel(item: Item, now: number): string | null {
  if (item.currentTask === null) return null;
  const beat = item.heartbeatAt !== null ? ` · ♥ ${fmtRel(item.heartbeatAt, now)}` : "";
  return `▶ #${item.currentTask}${beat}`;
}

// #191：presence 的可唤醒徽章。三档一律走共享的 wakeableState（与 CLI `party who` / 服务端同口径），
// 返回 i18n key + 语气色。verified＝服务端确认（webhook，或观测到被 @ 后 resume 盖了 verified_at）；
// unverified＝自报的 serve/watch，服务端没验证过，别当它一定叫得醒；off＝无 wake layer / human_driven / bare。
// bare（无常驻）与 wake=none 同待遇：不承诺可唤醒。verified_at **只信服务端**下发的值，不受客户端自报影响。
export function wakeabilityBadge(item: Item, now: number): { key: string; tone: "off" | "pending" | "on" } | null {
  if (item.wakeKind === null) return null; // 没有 wake 元数据，不渲染徽章
  const state =
    item.residency === "bare"
      ? "offline"
      : wakeableState(
          {
            wake: { kind: item.wakeKind, ...(item.wakeVerifiedAt !== null ? { verified_at: item.wakeVerifiedAt } : {}) },
            ...(item.residency !== null ? { residency: item.residency } : {}),
          },
          now,
        );
  if (state === "wakeable_verified") return { key: "PresenceBar.wake.verified", tone: "on" };
  if (state === "wakeable_unverified") return { key: "PresenceBar.wake.unverified", tone: "pending" };
  return { key: "PresenceBar.wake.off", tone: "off" };}

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

export function PresenceBar({
  presence,
  participants,
  status,
  party = false,
  isPublic = false,
  publicWatch = false,
  canModerate = false,
  removingName = null,
  onRemoveParticipant,
  pausingName = null,
  onPauseAgent,
  onResumeAgent,
  roles = [],
  headerControls,
  onOpenAgentDetail,
}: Props) {
  const t = useT();
  // 相对时间 30s 刷一次
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();

  // #484：姓名 roster 不再挤占频道顶部；点 live 计数后在独立弹框里查看和操作。
  const [rosterOpen, setRosterOpen] = useState(false);
  const rosterToggleRef = useRef<HTMLButtonElement | null>(null);
  const rosterCloseRef = useRef<HTMLButtonElement | null>(null);

  // 在线 sender 带 owner；离线/最近 presence 带 account。两者都归到同一账号块。
  const byName = new Map(participants.map((p) => [p.name, p]));
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  const names = [...new Set([...participants.map((p) => p.name), ...Object.keys(presence), ...roles.map((role) => role.name)])].sort();
  const items: Item[] = names.map((name) => {
    const entry = presence[name];
    const clientVersion = entry?.client_version ?? null;
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
      clientVersion,
      // 暂停接待（#180）：即使 agent 离线也保留 paused（人主动设的状态，不随连接消失）。
      paused: entry?.paused === true,
      resumeAt: entry?.resume_at ?? null,
      // busy/queueDepth（#103）：服务端只在 state != offline 且真忙时下发 busy，故离线项天然为 false。
      busy: entry?.busy === true,
      queueDepth: entry?.busy === true && typeof entry.queue_depth === "number" && entry.queue_depth > 0 ? entry.queue_depth : null,
      waitingOwnerCount:
        typeof entry?.waiting_owner_count === "number" && entry.waiting_owner_count > 0 ? entry.waiting_owner_count : 0,
      // 每任务进度/心跳（#228）：服务端只在 state != offline 且有活跃任务时下发 current_task，故离线项天然为 null。
      currentTask: typeof entry?.current_task === "number" ? entry.current_task : null,
      heartbeatAt: typeof entry?.current_task === "number" && typeof entry?.heartbeat_at === "number" ? entry.heartbeat_at : null,
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
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);
  const popoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelPopoverClose() {
    if (popoverCloseTimer.current === null) return;
    clearTimeout(popoverCloseTimer.current);
    popoverCloseTimer.current = null;
  }

  function schedulePopoverClose() {
    cancelPopoverClose();
    // #457：chip 与 fixed popover 之间有 8px 间隙。立即关闭会让鼠标永远跨不过去；
    // 留一个短 grace period，进入 popover 后取消，既可操作又不会把浮层粘在页面上。
    popoverCloseTimer.current = setTimeout(() => {
      popoverCloseTimer.current = null;
      setHoveredGroup(null);
    }, 160);
  }

  useEffect(
    () => () => {
      if (popoverCloseTimer.current === null) return;
      clearTimeout(popoverCloseTimer.current);
      popoverCloseTimer.current = null;
    },
    [],
  );
  const closeRoster = useCallback(() => {
    setHoveredGroup(null);
    setExpandedGroupKey(null);
    setRosterOpen(false);
    rosterToggleRef.current?.focus();
  }, []);

  function toggleRoster() {
    if (rosterOpen) closeRoster();
    else setRosterOpen(true);
  }
  // 顶部计数按账号折叠后的人数（非会话行数）——离线会话已在 buildGroups 里按 account 归并。
  const { live: liveGroups, total: totalGroups } = countLiveGroups(sortedGroups);
  const blockedCount = items.filter((it) => it.state === "blocked").length;
  const busyCount = items.filter((it) => it.busy).length;
  const duplicateCount = items.filter((it) => it.connectionCount > 1).length;
  // 折叠态下 chip 不在 DOM 里，popover 也不该跟着冒出来。
  const activePopoverGroup =
    !rosterOpen || hoveredGroup === null ? null : sortedGroups.find((group) => group.key === hoveredGroup.key) ?? null;

  useEffect(() => {
    if (!rosterOpen) return;
    rosterCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRoster();
    };
    window.addEventListener?.("keydown", onKeyDown);
    return () => window.removeEventListener?.("keydown", onKeyDown);
  }, [closeRoster, rosterOpen]);

  function openAgentDetail(name: string) {
    if (onOpenAgentDetail === undefined) return;
    closeRoster();
    onOpenAgentDetail(name);
  }

  function showGroupPopover(group: PresenceGroup, rect: DOMRect) {
    cancelPopoverClose();
    const margin = 10;
    const width = Math.min(520, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
    const top = Math.min(rect.bottom + 8, Math.max(margin, window.innerHeight - 120));
    setHoveredGroup({ key: group.key, left, top, width });
  }

  function renderItem(it: Item, mode: "compact" | "full") {
    const badge = roleBadge(it, now);
    const residency = residencyBadge(it);
    const wakeability = wakeabilityBadge(it, now);
    const busy = busyLabel(it);
    const waitingOwner = waitingOwnerLabel(it);
    const task = taskLabel(it, now);
    const taskTitle =
      it.currentTask === null
        ? null
        : it.heartbeatAt !== null
          ? t("PresenceBar.taskTitleBeat", { seq: it.currentTask, age: fmtRel(it.heartbeatAt, now) })
          : t("PresenceBar.taskTitle", { seq: it.currentTask });
    const activeHost = hasActiveHostLease(it, now);
    const full = mode === "full";
    const titleParts = [
      it.owner !== null && it.owner !== it.name ? `${it.name} · ${it.owner}` : it.name,
      it.busy ? `busy${it.queueDepth !== null ? ` · ${it.queueDepth} queued` : ""} (reachable, reply may be slow — do not re-@)` : null,
      it.waitingOwnerCount > 0 ? `${it.waitingOwnerCount} work waiting for owner (runner remains available)` : null,
      taskTitle,
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
      it.kind === "agent" && it.clientVersion !== null ? `cli v${it.clientVersion}` : null,
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
          `${full ? " presence-pill--full" : ""}` +
          `${onOpenAgentDetail !== undefined ? " presence-pill--clickable" : ""}`
        }
        title={titleParts.join(" · ")}
        role={onOpenAgentDetail !== undefined ? "button" : undefined}
        tabIndex={onOpenAgentDetail !== undefined ? 0 : undefined}
        onClick={onOpenAgentDetail !== undefined ? () => openAgentDetail(it.name) : undefined}
        onKeyDown={
          onOpenAgentDetail !== undefined
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openAgentDetail(it.name);
                }
              }
            : undefined
        }
        style={{ "--ah": agentHue(it.name) } as CSSProperties}
      >
        <span className={`d-dot d-dot--${it.state}${it.paused ? " d-dot--paused" : ""}`} />
        <span className="presence-name">{it.display}</span>
        <span className={`t-mono presence-kind presence-kind--${it.kind}`}>{it.kind}</span>
        {it.paused && (
          <span
            className="t-mono presence-paused"
            title={
              it.resumeAt !== null
                ? t("PresenceBar.pausedUntil", { time: new Date(it.resumeAt).toLocaleString() })
                : t("PresenceBar.pausedManual")
            }
          >
            {it.resumeAt !== null
              ? t("PresenceBar.pausedChipUntil", {
                  time: new Date(it.resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                })
              : t("PresenceBar.pausedChip")}
          </span>
        )}
        {full && it.owner !== null && it.owner !== "" && it.owner !== it.name && (
          <span className="t-mono presence-owner">· {it.owner}</span>
        )}
        {badge !== null && (
          <span className={`t-mono presence-role${activeHost ? " presence-role--active" : ""}`}>
            {badge}
          </span>
        )}
        {busy !== null && <span className="t-mono presence-busy">{busy}</span>}
        {waitingOwner !== null && <span className="t-mono presence-busy presence-waiting-owner">{waitingOwner}</span>}
        {task !== null && (
          <span className="t-mono presence-busy presence-task" title={taskTitle ?? undefined}>
            {task}
          </span>
        )}
        {full && it.lineage !== null && (
          <span className="t-mono presence-lineage">child:{it.lineage.parent_agent}</span>
        )}
        {full && residency !== null && <span className="t-mono presence-residency">{residency}</span>}
        {full && wakeability !== null && (
          <span className={`t-mono presence-wake presence-wake--${wakeability.tone}`}>{t(wakeability.key)}</span>
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
        {full && it.kind === "agent" && it.clientVersion !== null && (
          <span className="t-mono presence-client-version">cli v{it.clientVersion}</span>
        )}
        {full && it.workflow !== null && <span className="t-mono presence-context">wf:{it.workflow.workflow_id}</span>}
        {full && it.note !== null && it.note !== "" && <span className="t-mono presence-note">{it.note}</span>}
        {full && it.responsibility !== null && it.responsibility !== "" && (
          <span className="t-mono presence-note">{it.responsibility}</span>
        )}
        {it.ts !== null && <span className="t-mono presence-ts">{fmtRel(it.ts)}</span>}
        {full && canModerate && it.kind === "agent" && it.name !== "system" && it.paused && onResumeAgent !== undefined && (
          <button
            className="presence-resume"
            type="button"
            disabled={pausingName === it.name}
            title={t("PresenceBar.resumeTitle", { name: it.name })}
            onClick={(e) => {
              e.stopPropagation();
              onResumeAgent(it.name);
            }}
          >
            {t("PresenceBar.resume")}
          </button>
        )}
        {full && canModerate && it.kind === "agent" && it.name !== "system" && !it.paused && onPauseAgent !== undefined && (
          <select
            className="presence-pause-select"
            aria-label={t("PresenceBar.pauseTitle", { name: it.name })}
            title={t("PresenceBar.pauseTitle", { name: it.name })}
            disabled={pausingName === it.name}
            value=""
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const preset = e.target.value;
              e.currentTarget.value = "";
              if (preset === "") return;
              onPauseAgent(it.name, pauseResumeAt(preset, Date.now()));
            }}
          >
            <option value="">{t("PresenceBar.pause")}</option>
            <option value="1h">{t("PresenceBar.pause1h")}</option>
            <option value="4h">{t("PresenceBar.pause4h")}</option>
            <option value="8h">{t("PresenceBar.pause8h")}</option>
            <option value="tomorrow">{t("PresenceBar.pauseTomorrow")}</option>
            <option value="indefinite">{t("PresenceBar.pauseIndefinite")}</option>
          </select>
        )}
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
      ...group.agents
        .filter((item) => item.clientVersion !== null)
        .map((item) => `${item.name}: cli v${item.clientVersion}`),
    ].filter((part): part is string => part !== null).join(" · ");
    return (
      <section
        key={group.key}
        tabIndex={0}
        aria-expanded={full}
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
          if (!full) schedulePopoverClose();
        }}
        onFocus={(e) => {
          if (!full) showGroupPopover(group, e.currentTarget.getBoundingClientRect());
        }}
        onBlur={() => {
          if (!full) setHoveredGroup(null);
        }}
        onClick={(e) => {
          if ((e.target as Element).closest(".presence-group-detail, button, select")) return;
          setHoveredGroup(null);
          setExpandedGroupKey(full ? null : group.key);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          setHoveredGroup(null);
          setExpandedGroupKey(full ? null : group.key);
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
              <span
                key={agent.name}
                className={`presence-agent-chip${onOpenAgentDetail !== undefined ? " presence-agent-chip--clickable" : ""}`}
                role={onOpenAgentDetail !== undefined ? "button" : undefined}
                tabIndex={onOpenAgentDetail !== undefined ? 0 : undefined}
                onClick={
                  onOpenAgentDetail !== undefined
                    ? (e) => {
                        e.stopPropagation();
                        openAgentDetail(agent.name);
                      }
                    : undefined
                }
                onKeyDown={
                  onOpenAgentDetail !== undefined
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          openAgentDetail(agent.name);
                        }
                      }
                    : undefined
                }
              >
                <span className={`d-dot d-dot--${agent.state}${agent.paused ? " d-dot--paused" : ""}`} />
                <span>{agent.display}</span>
                <span className={`t-mono presence-agent-kind presence-kind--${agent.kind}`}>{agent.kind}</span>
                {agent.paused && (
                  <span
                    className="t-mono presence-paused"
                    title={
                      agent.resumeAt !== null
                        ? t("PresenceBar.pausedUntil", { time: new Date(agent.resumeAt).toLocaleString() })
                        : t("PresenceBar.pausedManual")
                    }
                  >
                    {agent.resumeAt !== null
                      ? t("PresenceBar.pausedChipUntil", {
                          time: new Date(agent.resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                        })
                      : t("PresenceBar.pausedChip")}
                  </span>
                )}
                {agent.clientVersion !== null && (
                  <span className="t-mono presence-client-version">cli v{agent.clientVersion}</span>
                )}
                {agent.connectionCount > 1 && <span className="t-mono presence-agent-duplicate">x{agent.connectionCount}</span>}
                {roleBadge(agent, now) !== null && <span className="t-mono presence-agent-role">{roleBadge(agent, now)}</span>}
                {busyLabel(agent) !== null && <span className="t-mono presence-busy presence-busy--chip">{busyLabel(agent)}</span>}
                {waitingOwnerLabel(agent) !== null && (
                  <span className="t-mono presence-busy presence-busy--chip presence-waiting-owner">
                    {waitingOwnerLabel(agent)}
                  </span>
                )}
                {taskLabel(agent, now) !== null && (
                  <span className="t-mono presence-busy presence-busy--chip presence-task">{taskLabel(agent, now)}</span>
                )}
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
    <div className="presence-bar">
      <div className="presence-head">
        <div className="presence-meta" aria-label="channel presence summary">
          {isPublic && <span className="d-hl public-badge">{publicWatch ? "WATCH" : "PUBLIC"}</span>}
          {party && <span className="d-hl party-badge">PARTY</span>}
          {blockedCount > 0 && <span className="t-mono presence-alert">{blockedCount} blocked</span>}
          {busyCount > 0 && (
            <span className="t-mono presence-alert presence-alert--busy" title="serially handling a wake — reachable, reply may be slow">
              ⏳ {busyCount} busy
            </span>
          )}
          {duplicateCount > 0 && <span className="t-mono presence-alert presence-alert--duplicate">{duplicateCount} duplicate</span>}
          {items.length === 0 && (
            <span className="t-mono presence-empty" role="status" aria-live="polite">
              nobody here yet
            </span>
          )}
          <button
            ref={rosterToggleRef}
            type="button"
            className="presence-toggle"
            aria-expanded={rosterOpen}
            aria-haspopup="dialog"
            aria-label={t(rosterOpen ? "PresenceBar.collapse" : "PresenceBar.expand")}
            onClick={toggleRoster}
          >
            <span className="t-mono presence-summary">
              {liveGroups}/{totalGroups} live
            </span>
            <span className="presence-toggle-arrow" aria-hidden="true">{rosterOpen ? "▾" : "▸"}</span>
          </button>
        </div>
        {headerControls !== undefined && headerControls !== null && (
          <div className="presence-channel-controls">{headerControls}</div>
        )}
        <span className="conn t-mono" data-s={status} role="status" aria-live="polite">
          {status === "open" ? "● live" : `◌ ${status}…`}
        </span>
      </div>
      {rosterOpen && (
        <div className="channel-panel-overlay presence-roster-overlay" role="dialog" aria-modal="true" aria-labelledby="presence-roster-title">
          <button className="channel-panel-scrim" type="button" aria-label={t("PresenceBar.close")} onClick={closeRoster} />
          <section className="channel-panel-card presence-roster-card">
            <header className="channel-panel-head">
              <div className="channel-panel-titlebox">
                <h2 id="presence-roster-title">{t("PresenceBar.dialogTitle")}</h2>
                <p className="t-mono">{liveGroups}/{totalGroups} live</p>
              </div>
              <button ref={rosterCloseRef} className="d-btn channel-panel-close" type="button" aria-label={t("PresenceBar.close")} onClick={closeRoster}>
                {t("PresenceBar.close")}
              </button>
            </header>
            <div className="channel-panel-body presence-roster-body">
              <div className="presence-strip" aria-label={t("PresenceBar.participantGroupsByOwner")}>
                {sortedGroups.map((group) => renderGroup(group, expandedGroupKey === group.key ? "full" : "compact"))}
              </div>
            </div>
          </section>
        </div>
      )}
      {activePopoverGroup !== null && hoveredGroup !== null && (
        <div
          className="presence-popover"
          role="tooltip"
          onMouseEnter={cancelPopoverClose}
          onMouseLeave={schedulePopoverClose}
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
            {activePopoverGroup.items.slice(0, 10).map((item) => renderItem(item, "full"))}
            {activePopoverGroup.items.length > 10 && (
              <span className="t-mono presence-popover-more">
                +{activePopoverGroup.items.length - 10} · {t("PresenceBar.expand")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
