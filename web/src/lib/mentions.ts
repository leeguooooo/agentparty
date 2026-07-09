// @ 提及候选（issue #39）：把 participants（WS 连着）∪ presence（含 wake 信息）合成一个
// 分档的候选列表，供 Composer 的 @ 补全下拉用。"可 @" ≠ "在线连接"——本产品最特别的一档是
// 「可唤醒」：人不在但 @ 了会被 serve/watch/webhook 拉起来。
import { autoWakeReachable, type ChannelRoleAssignment, type PresenceEntry, type Sender, type WakeKind } from "@agentparty/shared";

export type MentionTier = "online" | "wakeable" | "recent";

export interface MentionIdentity {
  name: string;
  display: string;
  kind?: "agent" | "human";
  account?: string;
  handle?: string;
}

export interface MentionCandidate {
  name: string; // @ 目标（token 名；人类网页会话是 UUID）
  display: string; // 可读名：人类优先显示账号 email，否则 name
  kind: "agent" | "human";
  tier: MentionTier;
  group: string; // UI 分组：账号 / 未归属
  account?: string; // 会话背后的账号（人类 = email）
  role?: string; // 协作角色/职责（host/worker/reviewer/observer），hover 显示
  responsibility?: string; // 结构化职责说明（频道分工字段）
  note?: string; // 当前 status note
}

const STALE_MS = 60_000; // 与 PRESENCE_TIMEOUT_MS 一致：serve/watch 超过即算 recent 而非可唤醒
// 幽灵清理：只为防止频道长期累积几个月前的一次性 agent。设得宽松——几天前聊过的 agent
// 仍是合理的 @/唤醒目标，不该被剔。真正的噪声（围观的人类会话）已由 kind/UUID 规则处理。
const DEAD_MS = 14 * 24 * 60 * 60 * 1000; // 14 天没露面才视为幽灵
// 系统生成的人类会话名，永远不是有意义的 @ 目标：网页登录 token 默认名 = 纯 UUID；
// OIDC 设备验证流 = login-verify-*。过渡期旧 presence 行没回填 kind 时靠名字把它们判为 human。
const SYSTEM_HUMAN_SESSION_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|login-verify-.+)$/i;
const NAME_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// 档位：① 在线（当前有 WS 连接） ② 可唤醒（autoWakeReachable 统一口径 #47/#55：
// serve/watch 需不 stale 且不能是 human_driven，webhook 服务端投递、离线也算） ③ 最近活跃（其余 presence）。
// 同名取更高档。
function tierFor(
  name: string,
  online: Set<string>,
  presence: Record<string, PresenceEntry>,
  now: number,
): MentionTier {
  if (online.has(name)) return "online";
  const p = presence[name];
  if (p) {
    if (autoWakeReachable(p, now, STALE_MS)) return "wakeable";
  }
  return "recent";
}

// self 从候选里剔掉（@ 自己没意义）。档内按名字排序，档间 online > wakeable > recent。
// 只把「有意义的 @ 目标」纳入：agent 各档都留；human 只在当前在线时才留（围观的人、尤其是
// 只有 UUID 名的登录会话，不该冒进候选）；超过 14 天没露面的幽灵 presence 一律剔除。
export function mentionCandidates(
  participants: Sender[],
  presence: Record<string, PresenceEntry>,
  self: string | null,
  now: number,
  identities: MentionIdentity[] = [],
  roles: ChannelRoleAssignment[] = [],
): MentionCandidate[] {
  const online = new Set(participants.map((p) => p.name));
  const participantByName = new Map(participants.map((p) => [p.name, p]));
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  const kindOf = new Map<string, "agent" | "human">();
  for (const p of participants) kindOf.set(p.name, p.kind);
  for (const identity of identities) {
    if (identity.kind === "agent" || identity.kind === "human") kindOf.set(identity.name, identity.kind);
  }
  for (const role of roles) {
    if (role.kind === "agent" || role.kind === "human") kindOf.set(role.name, role.kind);
  }
  for (const [name, p] of Object.entries(presence)) {
    if (!kindOf.has(name) && (p.kind === "agent" || p.kind === "human")) kindOf.set(name, p.kind);
  }
  // kind 已知取 kind；未知（旧 presence 行没回填）时：UUID 名当 human，其余当 agent。
  const kindFor = (name: string): "agent" | "human" =>
    kindOf.get(name) ?? (SYSTEM_HUMAN_SESSION_RE.test(name) ? "human" : "agent");

  const names = new Set<string>([
    ...online,
    ...Object.keys(presence),
    ...identities.map((identity) => identity.name),
    ...roles.map((role) => role.name),
  ]);
  const rank: Record<MentionTier, number> = { online: 0, wakeable: 1, recent: 2 };
  return [...names]
    .filter((name) => name !== self && name !== "system")
    .map((name) => {
      const kind = kindFor(name);
      const p = presence[name];
      const identity = identityByName.get(name);
      const assigned = roleByName.get(name);
      const account = identity?.account ?? assigned?.account ?? p?.account;
      // 人类全局唯一昵称（handle）：有则用它做 @ 插入 token 和显示名——UUID 会话名打不出来，
      // handle 才能被后端 R5 按 handle 识别为「被 @」。agent 不适用（其 name 本身就是可读 handle）。
      const identityHandle =
        identity?.handle !== undefined && identity.handle !== "" && NAME_TOKEN_RE.test(identity.handle)
          ? identity.handle
          : undefined;
      const handle = kind === "human" ? (participantByName.get(name)?.handle ?? p?.handle ?? identityHandle) : undefined;
      // 人类网页会话名是 UUID，显示账号 email 才认得出「是谁」；agent 名本身可读，用 name。
      const display = handle
        ? handle
        : identity?.display && identity.display !== ""
          ? identity.display
          : assigned?.display && assigned.display !== ""
            ? assigned.display
            : kind === "human" && account
              ? account
              : name;
      const group = account ?? (kind === "human" ? "human sessions" : "unowned agents");
      return {
        name: handle ?? name,
        display,
        kind,
        tier: tierFor(name, online, presence, now),
        group,
        account,
        role: assigned?.role ?? p?.role,
        responsibility: assigned?.responsibility ?? undefined,
        note: p?.note ?? undefined,
      };
    })
    .filter((c) => {
      if (c.tier === "online") return true; // 当前连着的都留（含在线的人类）
      if (c.kind === "human") {
        // 离线人类也可以是明确收件人：例如 Lark/OIDC 人类已经发过消息，identity API 能给出
        // handle/display；但没有账号/显示名的围观 session 仍然隐藏，避免菜单里出现裸 UUID。
        if (SYSTEM_HUMAN_SESSION_RE.test(c.name)) return c.account !== undefined && c.display !== c.name && c.display !== c.account;
        return c.account !== undefined || (c.display !== c.name && c.display !== c.account);
      }
      if (roleByName.has(c.name)) return true;
      if (identityByName.has(c.name)) return true;
      const p = presence[c.name];
      const seen = p?.last_seen ?? p?.ts ?? 0;
      return now - seen <= DEAD_MS; // 幽灵清理：太久没露面的 agent 也剔除
    })
    .filter((c) => {
      // 可读身份缺失的人类 UUID 不进补全菜单；否则用户只会看到一串无法识别的 session id。
      if (c.kind !== "human") return true;
      if (!SYSTEM_HUMAN_SESSION_RE.test(c.name)) return true;
      return c.account !== undefined && c.display !== c.name;
    })
    .sort((a, b) => a.group.localeCompare(b.group) || rank[a.tier] - rank[b.tier] || a.display.localeCompare(b.display));
}

// Composer 用：光标前若正在打 @<prefix>，返回 { start, query }；否则 null。
// prefix 允许 [a-zA-Z0-9._-]（与 name 字符集一致），@ 前须是行首或空白（不匹配 email 里的 @）。
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0 && /[a-zA-Z0-9._-]/.test(text[i]!)) i--;
  if (i < 0 || text[i] !== "@") return null;
  if (i > 0 && !/\s/.test(text[i - 1]!)) return null; // @ 前不是空白/行首 → 是 email 之类，不触发
  return { start: i, query: text.slice(i + 1, caret) };
}

// 单个 @ 目标的存活判断（发送前预览 + 发送后回执共用）。tier 复用候选逻辑，额外带出
// wake.kind（用于「可唤醒(serve)」这种注解）和 reachable（在线或可唤醒＝这条 @ 现在能落地）。
export interface MentionLiveness {
  tier: MentionTier;
  wakeKind: WakeKind | null;
  reachable: boolean;
}

// Composer 发送前状态条的一行：草稿里的某个 @ 目标 + 它当前的存活档位。
export interface DraftMentionStatus {
  name: string;
  display: string;
  tier: MentionTier;
  wakeKind: WakeKind | null;
}

export function mentionLiveness(
  name: string,
  online: Set<string>,
  presence: Record<string, PresenceEntry>,
  now: number,
): MentionLiveness {
  const tier = tierFor(name, online, presence, now);
  const wakeKind = presence[name]?.wake?.kind ?? null;
  return { tier, wakeKind, reachable: tier === "online" || tier === "wakeable" };
}

// 从草稿正文里提取 @name（与服务端 BODY_MENTION_RE 一致：@ 前须行首/空白，不吃 email 里的 @）。
// 去重、保序，供发送前状态条渲染。
const DRAFT_MENTION_RE = /(^|[^a-zA-Z0-9._@-])@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;
export function parseDraftMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(DRAFT_MENTION_RE)) {
    const name = m[2]!;
    if (name === "system" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function filterCandidates(cands: MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
  const q = query.toLowerCase();
  if (q === "") return cands.slice(0, limit);
  // 前缀命中优先，其次子串命中
  const pref: MentionCandidate[] = [];
  const sub: MentionCandidate[] = [];
  for (const c of cands) {
    // 名字与可读显示名（人类的 email）都参与匹配——这样能直接搜 @thejacks 找到 UUID 会话
    const n = c.name.toLowerCase();
    const d = c.display.toLowerCase();
    if (n.startsWith(q) || d.startsWith(q)) pref.push(c);
    else if (n.includes(q) || d.includes(q)) sub.push(c);
  }
  return [...pref, ...sub].slice(0, limit);
}
