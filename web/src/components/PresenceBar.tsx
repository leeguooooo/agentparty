// 顶部 presence 条：每参与者一个手绘胶囊（名字 + 蜡笔状态点 + note + 相对时间），
// 右端挂连接状态。"对方卡在哪"一眼可见（spec §9 第 3 块）。
import { PRESENCE_TIMEOUT_MS, type PresenceEntry, type Sender } from "@agentparty/shared";
import { useEffect, useState, type CSSProperties } from "react";
import { agentHue } from "../lib/agentColor";
import { fmtRel } from "../lib/time";
import type { SocketStatus } from "../lib/ws";

interface Props {
  presence: Record<string, PresenceEntry>;
  participants: Sender[];
  status: SocketStatus;
  party?: boolean; // mode=party 的频道在最左挂蜡笔黄 PARTY 徽章
  isPublic?: boolean; // public 频道在最左挂蜡笔绿 PUBLIC 徽章（spec §4）
}

interface Item {
  name: string;
  state: string; // PresenceState | "online"（已连接但还没报过 status）
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
  owner: string | null; // 所属人：agent 的操作者 / 人类的 email，仅连接中的参与者可知
}

function hasActiveHostLease(item: Item, now: number): boolean {
  const lastSeen = item.lastSeen ?? item.ts;
  if (item.role !== "host" || lastSeen === null) return false;
  if (item.residency !== "supervised" && item.residency !== "webhook") return false;
  if (item.wakeKind === null || item.wakeKind === "none") return false;
  return item.state !== "offline" && now - lastSeen <= PRESENCE_TIMEOUT_MS;
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

export function PresenceBar({ presence, participants, status, party = false, isPublic = false }: Props) {
  // 相对时间 30s 刷一次
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();

  // 所属人只有连接中的参与者带（presence 快照不含 owner），按 name 建索引
  const byName = new Map(participants.map((p) => [p.name, p]));
  const names = [...new Set([...participants.map((p) => p.name), ...Object.keys(presence)])].sort();
  const items: Item[] = names.map((name) => {
    const entry = presence[name];
    const sender = byName.get(name);
    const owner = sender?.owner ?? null;
    const connected = byName.has(name);
    const meta = {
      lastSeen: entry?.last_seen ?? null,
      role: entry?.role ?? null,
      roleSource: entry?.role_source ?? null,
      residency: entry?.residency ?? null,
      wakeKind: entry?.wake?.kind ?? null,
      wakeVerifiedAt: entry?.wake?.verified_at ?? null,
      context: entry?.context ?? null,
      lineage: entry?.lineage ?? sender?.lineage ?? null,
    };
    if (!connected) {
      return { name, state: "offline", note: null, ts: entry?.ts ?? null, owner: null, ...meta };
    }
    if (entry && entry.state !== "offline") {
      return { name, state: entry.state, note: entry.note, ts: entry.ts, owner, ...meta };
    }
    return { name, state: "online", note: null, ts: entry?.ts ?? null, owner, ...meta };
  });

  return (
    <div className="presence-bar">
      {isPublic && <span className="d-hl public-badge">PUBLIC</span>}
      {party && <span className="d-hl party-badge">PARTY</span>}
      {items.map((it) => {
        const badge = roleBadge(it, now);
        const residency = residencyBadge(it);
        const wakeability = wakeabilityBadge(it);
        const activeHost = hasActiveHostLease(it, now);
        const titleParts = [
          it.owner !== null && it.owner !== it.name ? `${it.name} · ${it.owner}` : it.name,
          it.role !== null ? `role: ${it.role}` : null,
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
          it.lastSeen !== null ? `last seen: ${fmtRel(it.lastSeen)}` : null,
        ].filter((part): part is string => part !== null);
        return (
          <span
            key={it.name}
            className={
              `d-pill presence-pill${it.state === "blocked" ? " presence-pill--blocked" : ""}` +
              `${activeHost ? " presence-pill--active-host" : ""}`
            }
            title={titleParts.join(" · ")}
            style={{ "--ah": agentHue(it.name) } as CSSProperties}
          >
            <span className={`d-dot d-dot--${it.state}`} />
            <span className="presence-name">{it.name}</span>
            {it.owner !== null && it.owner !== "" && it.owner !== it.name && (
              <span className="t-mono presence-owner">· {it.owner}</span>
            )}
            {badge !== null && (
              <span className={`t-mono presence-role${activeHost ? " presence-role--active" : ""}`}>
                {badge}
              </span>
            )}
            {it.lineage !== null && (
              <span className="t-mono presence-lineage">child:{it.lineage.parent_agent}</span>
            )}
            {residency !== null && <span className="t-mono presence-residency">{residency}</span>}
            {wakeability !== null && (
              <span className={`t-mono presence-wake presence-wake--${wakeability.tone}`}>
                {wakeability.text}
              </span>
            )}
            {it.context?.worktree_label !== undefined && (
              <span className="t-mono presence-context">{it.context.worktree_label}</span>
            )}
            {it.context?.config_kind !== undefined && (
              <span className="t-mono presence-context">cfg:{it.context.config_kind}</span>
            )}
            {it.note !== null && it.note !== "" && <span className="t-mono presence-note">{it.note}</span>}
            {it.ts !== null && <span className="t-mono presence-ts">{fmtRel(it.ts)}</span>}
          </span>
        );
      })}
      {items.length === 0 && (
        <span className="t-mono presence-empty" role="status" aria-live="polite">
          nobody here yet
        </span>
      )}
      <span className="t-mono presence-count" title="connected participants">
        {participants.length} in
      </span>
      <span className="conn t-mono" data-s={status} role="status" aria-live="polite">
        {status === "open" ? "● live" : `◌ ${status}…`}
      </span>
    </div>
  );
}
