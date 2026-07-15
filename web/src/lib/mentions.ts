// @ 提及候选（issue #39）：把 participants（WS 连着）∪ presence（含 wake 信息）合成一个
// 分档的候选列表，供 Composer 的 @ 补全下拉用。"可 @" ≠ "在线连接"——本产品最特别的一档是
// 「可唤醒」：人不在但 @ 了会被 serve/watch/webhook 拉起来。
import { autoWakeReachable, type ChannelRoleAssignment, type ChannelSquad, type PresenceEntry, type Sender, type WakeKind } from "@agentparty/shared";
import {
  extractMentionTokens,
  isMentionStart,
  mentionMatchKey,
  readMentionToken,
  resolveMentionToken,
  type MentionAlias,
} from "@agentparty/shared/mentions";
import { MENTION_SENDER_RETENTION_MS, mergeSenderIdentity, type SenderIdentitySnapshot } from "./senderIdentity";

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
  kind: "agent" | "human" | "squad";
  tier: MentionTier;
  group: string; // UI 分组：账号 / 未归属
  account?: string; // 会话背后的账号（人类 = email）
  role?: string; // 协作角色/职责（host/worker/reviewer/observer），hover 显示
  responsibility?: string; // 结构化职责说明（频道分工字段）
  note?: string; // 当前 status note
  wakeKind?: WakeKind | null; // 当前唤醒层；发送前状态条直接复用最终候选，避免身份集合漂移
}

const STALE_MS = 60_000; // 与 PRESENCE_TIMEOUT_MS 一致：serve/watch 超过即算 recent 而非可唤醒
// 幽灵清理：只为防止频道长期累积几个月前的一次性 agent。设得宽松——几天前聊过的 agent
// 仍是合理的 @/唤醒目标，不该被剔。真正的噪声（围观的人类会话）已由 kind/UUID 规则处理。
const DEAD_MS = MENTION_SENDER_RETENTION_MS; // 14 天没露面才视为幽灵
// 系统生成的人类会话名，永远不是有意义的 @ 目标：网页登录 token 默认名 = 纯 UUID；
// OIDC 设备验证流 = login-verify-*。过渡期旧 presence 行没回填 kind 时靠名字把它们判为 human。
const SYSTEM_HUMAN_SESSION_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|login-verify-.+)$/i;
// #165：昵称可含 unicode（中文），故放开首字为任意字母/数字（与后端 NICKNAME_RE 对齐）。
const NAME_TOKEN_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

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
  squads: ChannelSquad[] = [],
  messages: SenderIdentitySnapshot[] = [],
): MentionCandidate[] {
  const online = new Set(participants.map((p) => p.name));
  const participantByName = new Map(participants.map((p) => [p.name, p]));
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  // identities REST 只在频道 mount 时抓一次。页面打开后才发言、又没有补 status/presence 帧的成员
  // 仍应立即可 @；消息 sender 是服务端已鉴权的频道身份，按同一 14 天窗口补进候选即可。
  const recentSenderByName = new Map<string, Sender>();
  const recentMentionNames = new Set<string>();
  for (const message of messages) {
    if (now - message.ts > DEAD_MS) continue;
    const previous = recentSenderByName.get(message.sender.name);
    // 同一身份的历史帧可能新旧协议混杂：较新的稀疏 sender 不能擦掉较早帧里已有的 owner/handle/display。
    recentSenderByName.set(message.sender.name, mergeSenderIdentity(previous, message.sender));
    recentMentionNames.add(message.sender.name);
    if (message.sender.handle) recentMentionNames.add(message.sender.handle);
  }
  const kindOf = new Map<string, "agent" | "human">();
  for (const p of participants) kindOf.set(p.name, p.kind);
  for (const sender of recentSenderByName.values()) kindOf.set(sender.name, sender.kind);
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
    ...recentSenderByName.keys(),
  ]);
  const rank: Record<MentionTier, number> = { online: 0, wakeable: 1, recent: 2 };
  const base = [...names]
    .filter((name) => name !== self && name !== "system")
    .map((name) => {
      const kind = kindFor(name);
      const p = presence[name];
      const identity = identityByName.get(name);
      const assigned = roleByName.get(name);
      const recentSender = recentSenderByName.get(name);
      const account =
        identity?.account ??
        assigned?.account ??
        p?.account ??
        participantByName.get(name)?.owner ??
        recentSender?.owner;
      // 全局唯一昵称（handle）：有则用它做 @ 插入 token 和显示名。人类=account handle（UUID 会话名打不出来，
      // 只有 handle 能被后端识别为「被 @」）；agent=自设昵称（#165，可中文，其 ASCII name 由后端解析回填）。
      const identityHandle =
        identity?.handle !== undefined && identity.handle !== "" && NAME_TOKEN_RE.test(identity.handle)
          ? identity.handle
          : undefined;
      const handle = participantByName.get(name)?.handle ?? p?.handle ?? identityHandle ?? recentSender?.handle;
      // 人类网页会话名是 UUID，显示账号 email 才认得出「是谁」；agent 名本身可读，用 name。
      const display = handle
        ? handle
        : identity?.display && identity.display !== ""
          ? identity.display
          : assigned?.display && assigned.display !== ""
            ? assigned.display
            : kind === "human" && account
              ? recentSender?.display_name || account
              : name;
      const group = account ?? (kind === "human" ? "human sessions" : "unowned agents");
      return {
        sourceName: name,
        name: handle ?? name,
        display,
        kind,
        tier: tierFor(name, online, presence, now),
        group,
        account,
        role: assigned?.role ?? p?.role,
        responsibility: assigned?.responsibility ?? undefined,
        note: p?.note ?? undefined,
        wakeKind: p?.wake?.kind ?? null,
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
      if (roleByName.has(c.sourceName)) return true;
      if (identityByName.has(c.sourceName)) return true;
      if (recentMentionNames.has(c.sourceName) || recentMentionNames.has(c.name)) return true;
      const p = presence[c.sourceName];
      const seen = p?.last_seen ?? p?.ts ?? 0;
      return now - seen <= DEAD_MS; // 幽灵清理：太久没露面的 agent 也剔除
    })
    .filter((c) => {
      // 可读身份缺失的人类 UUID 不进补全菜单；否则用户只会看到一串无法识别的 session id。
      if (c.kind !== "human") return true;
      if (!SYSTEM_HUMAN_SESSION_RE.test(c.name)) return true;
      return c.account !== undefined && c.display !== c.name;
    })
    .sort((a, b) => a.group.localeCompare(b.group) || rank[a.tier] - rank[b.tier] || a.display.localeCompare(b.display))
    .map(({ sourceName: _sourceName, ...candidate }) => candidate);
  const squadCandidates: MentionCandidate[] = squads
    .filter((squad) => squad.name !== self && squad.name !== "system")
    .map((squad) => ({
      name: squad.name,
      display: squad.title && squad.title !== "" ? squad.title : squad.name,
      kind: "squad" as const,
      tier: "wakeable" as const,
      group: "squads",
      role: squad.leader === null ? undefined : `leader:${squad.leader}`,
      responsibility: `${squad.members.length} members`,
      note: squad.description ?? undefined,
      wakeKind: "webhook" as const,
    }));
  return [...squadCandidates, ...base];
}

// Composer 用：光标前若正在打 @<prefix>，返回 { start, query }；否则 null。
// 中文正文不强制 @ 前留空格；ASCII 单词/email 与 URL 仍由共享词法规则排除。
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  // React/DOM selection snapshots can briefly point one code unit past a freshly updated draft.
  // Clamp that stale caret instead of letting an out-of-range character participate in the lexer.
  const boundedCaret = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, boundedCaret);
  // A suffix regex walks Unicode code points, unlike text[i], which can split
  // supplementary-plane letters into two surrogate code units.
  const active = /@[\p{L}\p{N}\p{M}._-]*$/u.exec(prefix);
  if (active === null) return null;
  const start = active.index;
  if (!isMentionStart(text, start)) return null;
  if (boundedCaret === start + 1) return { start, query: "" };
  const parsed = readMentionToken(prefix, start);
  // `readMentionToken` leaves terminal sentence punctuation out of the token,
  // so a caret after "@codex." is no longer treated as an active completion.
  return parsed !== null && parsed.end === boundedCaret ? { start, query: parsed.value } : null;
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

// 从草稿正文提取 mention。knownNames 来自最终补全候选；提供时可把无空格中文正文
// "请@小明看一下" 唯一解析为 "小明"。未知或歧义 token 仍原样上报，让服务端返回明确错误。
// #555：ASCII token 分支优先，避免把紧跟 agent 名的中文正文吞进去；URL/email/npm/code
// 仍完全交给 rich lexer 判定，不能退回单一正则。
export function parseDraftMentions(text: string, knownNames: readonly string[] = []): string[] {
  const aliases: MentionAlias[] = knownNames.map((name) => ({ alias: name, target: name, kind: "canonical" }));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const mention of extractMentionTokens(text)) {
    const fullResolution = aliases.length === 0 ? null : resolveMentionToken(mention.value, aliases);
    const ascii = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/.exec(mention.value)?.[0];
    // A decomposed Unicode alias can begin with ASCII (A + combining diaeresis).
    // Do not apply the legacy ASCII-prefix shortcut across that combining mark.
    const lexicalValue = ascii !== undefined && !/^\p{M}/u.test(mention.value.slice(ascii.length))
      ? ascii
      : mention.value;
    const fallbackResolution = aliases.length === 0 ? null : resolveMentionToken(lexicalValue, aliases);
    const name = fullResolution?.status === "resolved"
      ? fullResolution.target
      : fullResolution?.status === "ambiguous"
        ? mention.value
        : fallbackResolution?.status === "resolved"
          ? fallbackResolution.target
          : lexicalValue;
    const key = mentionMatchKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
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
