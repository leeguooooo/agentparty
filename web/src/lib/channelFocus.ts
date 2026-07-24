// 频道「焦点栏」聚合（#682）：把已有的三份原料——任务台账（TaskRecord）、成员 presence/status、
// 未闭合的人类决策请求（decision_request）——跨成员聚成一句「球在谁手里、在等谁、谁在等我」。
//
// 纯函数、无副作用、无网络：栏是「已有数据的一块渲染视图」，绝不产生 seq、绝不发帧（避免 #675 刷屏）。
// staleness 复用 shared 的 autoWakeReachable/presenceLastSeen——status=working 但 presence 不新鲜时
// 降级为「可能停滞」而非谎报「在做」（避免 #665 的 false-presence）。
import type { MsgFrame, PresenceEntry, TaskRecord } from "@agentparty/shared";
import { autoWakeReachable, presenceLastSeen } from "@agentparty/shared";

// 焦点项的四态。前三态即 issue 要求「视觉可区分」的三态；stalled 是 working 因 presence 不新鲜被降级的结果，
// 单独成态好让 UI 用第四种语气标注「可能停滞/离线」，不与真正在做的 working 混淆。
export type FocusItemState = "working" | "blocked" | "waiting_decision" | "stalled";

// 「活跃在做」的新鲜度窗口（#682）：presence 无活连接（live）且 last_seen 超过这个岁数，就不再算「在做」。
// 比 PRESENCE_TIMEOUT_MS(60s) 宽松——面向人类的焦点栏不该因 agent 安静一分钟就翻成「停滞」；
// 真正健康的 serve/watch 有 live=true 会短路这道判定，安静但活着不受影响。
export const FOCUS_STALE_MS = 5 * 60_000;

export interface FocusItem {
  /** 稳定去重键：task-<id> / presence-<name> / decision-<seq>。 */
  key: string;
  /** 球在谁手里（assignee / 自报成员 / 提问者）。 */
  name: string;
  /** 这一项在做/卡在的一句话（task 标题、blocked_reason、decision prompt）。 */
  label: string;
  state: FocusItemState;
  /** blocked 时的阻塞原因（尽量结构化）；其他态为 null。 */
  blockedOn: string | null;
  /** 下钻锚点：关联任务 id（task 派生项）。 */
  taskId: number | null;
  /** 下钻锚点：关联消息 seq（decision 派生项）。 */
  seq: number | null;
  /** 从进来者视角：这一项是否在等本人拍板/交付。owner 最关心第三态里等自己的那些。 */
  waitingOnMe: boolean;
  /** 该项对应成员的 presence 是否已陈旧（working→stalled 的直接原因）。 */
  stale: boolean;
}

export interface ChannelFocus {
  /** 当前焦点一句话：host override 优先，否则最佳努力留空（自动焦点由 items 本身表达）。 */
  focus: string | null;
  focusSource: "manual" | null;
  /** 「球在谁手里」——按紧要度排序（等决策 > 被卡 > 在做 > 停滞）。 */
  items: FocusItem[];
  /** items 中「在等我」的子集（进来者视角高亮）。 */
  waitingOnMe: FocusItem[];
  counts: { working: number; blocked: number; waitingDecision: number; stalled: number };
  /** 没有任何在途项（无活跃任务、无阻塞、无待决）——UI 据此不渲染，不占屏。 */
  empty: boolean;
}

/** 进来者身份：用于判定「谁在等我」。account = OIDC/账号主体；canModerate = 能对无限定决策拍板。 */
export interface FocusViewer {
  name: string | null;
  account: string | null;
  canModerate: boolean;
}

/** 未闭合的人类决策请求（#284）投影，供焦点栏「等人拍板」一项使用。 */
export interface PendingDecision {
  seq: number;
  prompt: string;
  /** 提问者名（球从这里被抛出，在等人类回应）。 */
  asker: string;
  /** 若绑定了指定回应账号（owner-only），据此判「在等我」；服务端可能已从公开投影裁掉，缺省视为任意 moderator 可答。 */
  expectedResponderOwner?: string | null;
  /** 权威待决端点按当前查看者计算的结果；存在时优先于公开消息的降级推断。 */
  waitingOnMe?: boolean;
}

export interface ChannelFocusInput {
  presence: PresenceEntry[];
  tasks: TaskRecord[];
  decisions: PendingDecision[];
  viewer: FocusViewer;
  now: number;
  /** host 一句话 override 当前焦点；空/缺省则不显式设焦点。 */
  focusOverride?: string | null;
  staleMs?: number;
}

// 从消息流里筛出「未闭合」的人类决策请求（#284）：带 decision_request、未撤回、且 resolution 仍为 pending
// （缺 resolution 视同 pending——请求刚落库还没状态）。resolved/auto_resolved 的不再挂到栏上。
export function pendingDecisionsFromMessages(messages: MsgFrame[]): PendingDecision[] {
  const out: PendingDecision[] = [];
  for (const m of messages) {
    const req = m.decision_request;
    if (req === undefined) continue;
    if (m.retracted === true) continue;
    const state = m.decision_resolution?.state ?? "pending";
    if (state !== "pending") continue;
    out.push({
      seq: m.seq,
      prompt: req.prompt,
      asker: m.sender.name,
      expectedResponderOwner: req.expected_responder_owner ?? null,
    });
  }
  return out;
}

// 任务台账里「占着球」的活跃态：有 assignee 且处于这些态。done/triage/backlog 不占球，不上栏。
const ACTIVE_TASK_STATES = new Set<TaskRecord["state"]>(["assigned", "in_progress", "needs_review", "blocked"]);

// 「还在活跃地做」的判定，复用 shared 的可达性/新鲜度口径（#682 要求 reuse the shared helper）：
//   • 有活 WS 连接（live）           → 在场（serve/watch 安静但活着不误判）。
//   • 显式 offline                   → 不在场。
//   • last_seen 超过 staleMs         → 陈旧，不在场。
//   • autoWakeReachable=false        → 叫不醒（supervisor 大概率已死），不在场。
// 都不满足 → 在场。只用来把 working 降级成 stalled；blocked/等决策与在场无关，不受此判定影响。
function activelyPresent(entry: PresenceEntry | undefined, now: number, staleMs: number): boolean {
  if (entry === undefined) return false;
  if (entry.live === true) return true;
  if (entry.state === "offline") return false;
  const seen = presenceLastSeen(entry);
  if (seen === null) return false;
  if (now - seen > staleMs) return false;
  return autoWakeReachable(entry, now);
}

function firstNonEmpty(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

const STATE_ORDER: Record<FocusItemState, number> = { waiting_decision: 0, blocked: 1, working: 2, stalled: 3 };

export function computeChannelFocus(input: ChannelFocusInput): ChannelFocus {
  const { presence, tasks, decisions, viewer, now } = input;
  const staleMs = input.staleMs ?? FOCUS_STALE_MS;
  const presenceByName = new Map(presence.map((p) => [p.name, p]));
  const items: FocusItem[] = [];
  const namesWithTaskItem = new Set<string>();

  // 1) 任务台账 → 「球在谁手里」（主来源）。每条活跃且有 assignee 的任务成一项。
  for (const task of tasks) {
    if (!ACTIVE_TASK_STATES.has(task.state)) continue;
    const assignee = task.assignee;
    if (assignee === null) continue;
    namesWithTaskItem.add(assignee.name);
    const entry = presenceByName.get(assignee.name);
    let state: FocusItemState;
    let stale = false;
    if (task.state === "blocked") {
      state = "blocked";
    } else if (activelyPresent(entry, now, staleMs)) {
      state = "working";
    } else {
      // status=working（有活跃任务）但 presence 不新鲜/叫不醒 → 降级为「可能停滞」，不谎报在做（#665）。
      state = "stalled";
      stale = true;
    }
    // 「在等我」：人类被指派、且就是进来的这个人（等本人交付/推进）。
    const waitingOnMe =
      assignee.kind === "human" && viewer.name !== null && assignee.name === viewer.name;
    items.push({
      key: `task-${task.id}`,
      name: assignee.name,
      label: task.title,
      state,
      blockedOn: task.state === "blocked" ? firstNonEmpty(task.blocked_reason) : null,
      taskId: task.id,
      seq: null,
      waitingOnMe,
      stale,
    });
  }

  // 2) 成员 presence/status → 兜底：自报 blocked / working 但台账里没有对应任务的成员，别漏。
  //    blocked 一定纳入（是强信号）；working 也纳入（#kyc 里 Evan/kw 曾靠 status 才拼出「在做」）。
  for (const entry of presence) {
    if (namesWithTaskItem.has(entry.name)) continue;
    if (entry.kind === "human") continue; // 人类会话不是「在干活的 agent」，不占球
    const reason = firstNonEmpty(entry.status?.blocked_reason, entry.note);
    if (entry.state === "blocked") {
      items.push({
        key: `presence-${entry.name}`,
        name: entry.name,
        label: reason ?? entry.name,
        state: "blocked",
        blockedOn: reason,
        taskId: null,
        seq: null,
        waitingOnMe: false,
        stale: false,
      });
    } else if (entry.state === "working") {
      const present = activelyPresent(entry, now, staleMs);
      items.push({
        key: `presence-${entry.name}`,
        name: entry.name,
        label: firstNonEmpty(entry.note) ?? entry.name,
        state: present ? "working" : "stalled",
        blockedOn: null,
        taskId: null,
        seq: null,
        waitingOnMe: false,
        stale: !present,
      });
    }
  }

  // 3) 未闭合决策 → 「等人拍板」。waitingOnMe：指定了回应账号且匹配本人；或无限定但本人可 moderate（owner 视角）。
  for (const d of decisions) {
    const waitingOnMe =
      d.waitingOnMe ??
      ((d.expectedResponderOwner != null && d.expectedResponderOwner === viewer.account) ||
        (d.expectedResponderOwner == null && viewer.canModerate));
    items.push({
      key: `decision-${d.seq}`,
      name: d.asker,
      label: d.prompt,
      state: "waiting_decision",
      blockedOn: null,
      taskId: null,
      seq: d.seq,
      waitingOnMe,
      stale: false,
    });
  }

  items.sort(
    (a, b) =>
      Number(b.waitingOnMe) - Number(a.waitingOnMe) ||
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      a.name.localeCompare(b.name),
  );

  const counts = {
    working: items.filter((i) => i.state === "working").length,
    blocked: items.filter((i) => i.state === "blocked").length,
    waitingDecision: items.filter((i) => i.state === "waiting_decision").length,
    stalled: items.filter((i) => i.state === "stalled").length,
  };

  const focus = firstNonEmpty(input.focusOverride);
  return {
    focus,
    focusSource: focus !== null ? "manual" : null,
    items,
    waitingOnMe: items.filter((i) => i.waitingOnMe),
    counts,
    empty: items.length === 0,
  };
}
