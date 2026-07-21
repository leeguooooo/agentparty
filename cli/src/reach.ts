// party send 后即时反馈：一个 @ 目标现在能不能收到。是网页发送前状态条的终端版——不用开网页，
// 发完就知道会不会白发。与 who 的 classify 不同：这里对「找不到/离线/幽灵」一律回 offline（要提醒
// 「重连前收不到」），不返回 null；档位判定与网页 mentions.ts 保持一致（online / wakeable / offline）。
import { autoWakeReachable, type PresenceEntry, type WakeKind } from "@agentparty/shared";

// 档位窗口与 `party who` 的 classify 保持一致，避免 who 说「可唤醒」而 send --reach 说「离线」自相矛盾：
// online 需当前连着且新鲜(<STALE_MS)；wakeable 按 wakeReachable 统一口径（#47）：serve/watch 需
// presence 新鲜（supervisor 活着才叫得醒），webhook 服务端投递、离线也算，但都不越过 14 天幽灵线。
const STALE_MS = 60_000; // 与 DO presence 扫描一致
const DEAD_MS = 14 * 24 * 60 * 60 * 1000; // 超过即视为幽灵，不再算可唤醒

export type Reach = "online" | "wakeable" | "offline";

export interface Reachability {
  name: string;
  reach: Reach;
  wake?: WakeKind;
  // busy（#103）：目标可达但正串行处理一条 wake，回复会慢。让调用方把 ask 超时当「忙」而非「失联」，
  // 别反复 @ 堆重复唤醒。仅在服务端标了 busy（即目标在线且自报忙）时带出。
  busy?: true;
  // 忙时排在身后、尚未处理的 wake 数（#103）；>0 才带出。
  queueDepth?: number;
}

// busy/queue_depth 只在目标「可达」（online/wakeable）时有意义——offline 谈不上忙。
function busyBits(e: PresenceEntry | undefined): Pick<Reachability, "busy" | "queueDepth"> {
  if (e?.busy !== true) return {};
  const depth = typeof e.queue_depth === "number" && e.queue_depth > 0 ? e.queue_depth : undefined;
  return { busy: true, ...(depth !== undefined ? { queueDepth: depth } : {}) };
}

export function reachOf(name: string, presence: PresenceEntry[], now: number): Reachability {
  const e = presence.find((p) => p.name === name);
  if (e === undefined) return { name, reach: "offline" };
  const seen = e.last_seen ?? e.ts ?? 0;
  const age = now - seen;
  const wake = e.wake?.kind;
  // online：与 web mentions 一致以「当前有活 WS 连接」为准（#97 的 live，DO 从 getConnections 权威判定）；
  // 无 live 信号（旧 worker 响应）时回退到旧的新鲜度启发式，不回归。
  if (e.state !== "offline" && (e.live === true || age < STALE_MS))
    return { name, reach: "online", ...(wake ? { wake } : {}), ...busyBits(e) };
  if (wake !== undefined && autoWakeReachable(e, now, STALE_MS) && age <= DEAD_MS)
    return { name, reach: "wakeable", wake, ...busyBits(e) };
  return { name, reach: "offline", ...(wake ? { wake } : {}) };
}

const DOT: Record<Reach, string> = { online: "●", wakeable: "◐", offline: "○" };

// 忙态后缀：「· busy」或「· busy, N queued」。目标可达但正忙——回复会慢，别当失联。
function busyNote(r: Reachability): string {
  if (r.busy !== true) return "";
  return r.queueDepth !== undefined ? ` · busy, ${r.queueDepth} queued` : " · busy";
}

export function formatReach(r: Reachability): string {
  if (r.reach === "online") return `@${r.name} ${DOT.online} online${busyNote(r)}`;
  if (r.reach === "wakeable") return `@${r.name} ${DOT.wakeable} wakeable${r.wake ? `(${r.wake})` : ""}${busyNote(r)}`;
  return `@${r.name} ${DOT.offline} offline — reconnect to reach`;
}

// 发送后打印的一行：→ @a ● online  ·  @b ◐ wakeable(serve)  ·  @c ○ offline — reconnect to reach
export function formatReachLine(rs: Reachability[]): string {
  return "→ " + rs.map(formatReach).join("  ·  ");
}

// #664：`--mention X` 时 X 既不在线也无活 wake 通道——@ 只落进历史、永远不会唤醒任何人。发送方
// 之前对此零反馈（reach 行仅在 TTY/--reach 下出，agent 循环里静默）。这里给一个独立的、非阻断的
// 「不可达」判定，供 send 在 stderr 打醒目 warning，并支撑 --require-wakeable 的非零退出。
// 判定严格镜像 reachOf/who.classify 的 online / wakeable 门限（同 autoWakeReachable 权威口径），
// 只对「不在线 + 不可自动唤醒 + 已陈旧」的目标告警，避免误伤刚断线（<STALE_MS）或在线的目标。
export interface Unreachable {
  name: string;
  // 距最近一次露面的毫秒；无 last_seen/ts 时为 null（几乎不出现，presence 行通常带 ts）。
  ageMs: number | null;
  // 声明的 wake 类型（用于文案区分「压根没 wake 通道」与「适配器陈旧」）；缺省即无。
  wake?: WakeKind;
  // no_wake：wake=none/缺失，压根没有唤醒路径；stale_adapter：声明了 serve/watch 但心跳陈旧（supervisor 大概率已死）；
  // paused：owner 主动暂停接待（#180），被 @ 也不唤醒——有唤醒通道也无用。
  reason: "no_wake" | "stale_adapter" | "paused";
}

// 返回该 @ 目标的不可达详情，或 null（在线 / 可自动唤醒 / 刚断线未过 STALE / 不在 presence / 人类）。
// 不在 presence：#663 已让服务端硬校验显式 --mention 名字，走到这里名字必然合法；缺 presence 行
// 说明该身份从未在频道露面，无可靠信号，从简不告警。人类会话异步看通知，@ 离线人类不算「白发」，跳过。
export function unreachableOf(name: string, presence: PresenceEntry[], now: number): Unreachable | null {
  const e = presence.find((p) => p.name === name);
  if (e === undefined) return null;
  if (e.kind === "human") return null;
  const seen = e.last_seen ?? e.ts ?? 0;
  const age = now - seen;
  // online：与 reachOf/who 一致——当前有活 WS 连接（live）或新鲜即视为在线，@ 直达，不告警。
  if (e.state !== "offline" && (e.live === true || age < STALE_MS)) return null;
  // #664：paused（#180）优先于任何 wake 通道判定——owner 主动暂停接待，被 @ 也不唤醒，
  // 即便声明了 serve/watch/webhook 也不会响应，故直接判不可达（distinct reason=paused）供发送方知情。
  if (e.paused === true) {
    const wake = e.wake?.kind;
    return { name, ageMs: seen > 0 ? age : null, ...(wake !== undefined ? { wake } : {}), reason: "paused" };
  }
  // 可自动唤醒且未越幽灵线：webhook 服务端投递、或 serve/watch 心跳新鲜 → 叫得醒，不告警。
  if (e.wake?.kind !== undefined && autoWakeReachable(e, now, STALE_MS) && age <= DEAD_MS) return null;
  // 刚断线（<STALE_MS）：给一个宽限，可能马上重连，先不判死。
  if (age < STALE_MS) return null;
  const wake = e.wake?.kind;
  const reason: Unreachable["reason"] = wake === undefined || wake === "none" ? "no_wake" : "stale_adapter";
  return { name, ageMs: seen > 0 ? age : null, ...(wake !== undefined ? { wake } : {}), reason };
}

// 紧凑的时龄文案：45m / 88h / 15d，用于 warning 里的 last_seen 提示。刻意把「小时」一路显示到 10 天，
// 因为「88h」比「3d」更能让发送方一眼感到「死太久了」（issue #664 的原始诉求就用小时表达陈旧）。
function ageText(ageMs: number | null): string {
  if (ageMs === null) return "last_seen unknown";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `last_seen ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `last_seen ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 240) return `last_seen ${h}h ago`;
  return `last_seen ${Math.floor(h / 24)}d ago`;
}

// stderr 上打的一行非阻断 warning。示意：
//   warn: kyc-claude has no live wake channel (last_seen 88h ago) — mention delivered to history only; run 'party wake test @kyc-claude' to verify
export function formatUnreachable(u: Unreachable): string {
  const what =
    u.reason === "paused"
      ? `${u.name} is paused, 被 @ 也不唤醒`
      : u.reason === "stale_adapter"
        ? `${u.name}'s ${u.wake ?? "wake"} adapter looks dead`
        : `${u.name} has no live wake channel`;
  return `warn: ${what} (${ageText(u.ageMs)}) — mention delivered to history only; run 'party wake test @${u.name}' to verify`;
}

// ask 超时提示（#103）：party ask 委托 watch，超时只吐裸 TIMEOUT，看不出对方是「忙」还是「失联」。
// 用 reachOf 查被 @ 的目标此刻是否仍标 busy（serve 正串行处理一条 wake）：若有，返回一行富提示，
// 让调用方把超时当「忙、回复慢」而非「离线」，别反复 @ 堆重复唤醒。无 busy 目标返回 null，
// 调用方保持原裸 TIMEOUT 行为（查不到就不无中生有）。
export function busyTimeoutHint(mentions: string[], presence: PresenceEntry[], now: number): string | null {
  const busy = mentions.map((m) => reachOf(m, presence, now)).filter((r) => r.busy === true);
  if (busy.length === 0) return null;
  const parts = busy.map((r) => `@${r.name} 忙碌中${r.queueDepth !== undefined ? `, ${r.queueDepth} 排队` : ""}`);
  return `TIMEOUT — ${parts.join("; ")}; 稍后再试, 勿重复 @（对方在忙, 不是失联）`;
}
