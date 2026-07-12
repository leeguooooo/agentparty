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
