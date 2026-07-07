// 频道页：presence 条 + 实时消息流 + 内联错误条幅 + 插话框。
// App 用 key={slug} 挂载本组件，切频道即整体重建（socket/状态零残留）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { buildHostBoard, type HostBoard, type MsgFrame, type SearchHit } from "@agentparty/shared";
import { AgentJoin } from "../components/AgentJoin";
import { Composer } from "../components/Composer";
import { MessageCard } from "../components/MessageCard";
import { PresenceBar } from "../components/PresenceBar";
import { AuthError, ForbiddenError, fetchMessages, resetGuard, searchMessages } from "../lib/api";
import { agentHue } from "../lib/agentColor";
import { completionMessages } from "../lib/completions";
import { catchupKey, summarizeCatchup, type CatchupDigest } from "../lib/digest";
import {
  agentFilterSearch,
  filterByAgent,
  parseAgentFilter,
  toggleAgent,
  type AgentFilter,
  type AgentFilterMode,
} from "../lib/filters";
import { fmtTime } from "../lib/time";
import { groupTeamMessages, summarizeTeams, type TeamMessageThread, type TeamSummary } from "../lib/teams";
import { ChannelSocket } from "../lib/ws";
import { channelReducer, initialChannelState } from "../state";

interface Props {
  slug: string;
  token: string;
  mode: "normal" | "party";
  isPublic: boolean; // 顶栏 PUBLIC 徽章（spec §4）
  shareMode: boolean;
  // 有可写人类账号会话（me.role==="human" 且非分享链接）才允许铸 agent（spec §10）
  canMintAgent: boolean;
  canResetGuard: boolean;
  agentNamePrefix: string; // 生成 agent 名的前缀来源（email/name 前缀，退回 slug）
  inviterName: string; // 当前邀请人的频道身份名，接入包报到时 @ 他
  onAuthFailed(message: string): void;
}

const MENTION_RE = /@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;

// IM 式加载：初始/上翻每页条数，与 DOM 消息窗口上限（贴底时超出即丢最老页，上翻可拉回）
const PAGE_SIZE = 50;
const MESSAGE_CAP = 300;
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

function AgentFilterPanel({
  senders,
  filter,
  visible,
  total,
  onMode,
  onToggle,
  onClear,
}: {
  senders: string[];
  filter: AgentFilter;
  visible: number;
  total: number;
  onMode: (mode: AgentFilterMode) => void;
  onToggle: (agent: string) => void;
  onClear: () => void;
}) {
  const active = filter.agents.length > 0;
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
            <span>Only</span>
          </button>
          <button
            className={"d-btn agent-filter-mode" + (filter.mode === "except" ? " is-active" : "")}
            type="button"
            aria-pressed={filter.mode === "except"}
            onClick={() => onMode("except")}
          >
            <span>Hide</span>
          </button>
        </div>
        <span className="t-mono agent-filter-count">
          {active ? `${visible}/${total}` : `${total}`}
        </span>
        {active && (
          <button className="d-btn agent-filter-clear" type="button" onClick={onClear}>
            <span>Clear</span>
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
          <h2 className="catchup-title">While you were away</h2>
          <p className="catchup-range t-mono">
            #{seenSeq + 1}..#{latestSeq}
          </p>
        </div>
        <button className="d-btn catchup-action" type="button" onClick={onCaughtUp}>
          <span>Caught up</span>
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
  if (completions.length === 0) return null;

  return (
    <section className="completion-panel" aria-label="completion artifacts">
      <div className="completion-panel-head">
        <h2 className="completion-title">Completions</h2>
        <span className="t-mono completion-count">
          {visible}/{completions.length}
        </span>
        <button className={"d-btn completion-toggle" + (enabled ? " is-active" : "")} type="button" onClick={onToggle}>
          <span>{enabled ? "All" : "Only"}</span>
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
  const decisions = messages
    .filter((m) => m.kind === "status" && m.status?.decision !== undefined)
    .slice(-5)
    .reverse();
  if (decisions.length === 0) return null;

  return (
    <section className="decision-panel" aria-label="host decisions">
      <div className="decision-panel-head">
        <h2 className="decision-title">Host Decisions</h2>
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
  if (teams.length === 0) return null;

  return (
    <section className="team-panel" aria-label="agent teams">
      <div className="team-panel-head">
        <h2 className="team-title">Teams</h2>
        <span className="t-mono team-count">{teams.length}</span>
      </div>
      <ol className="team-list">
        {teams.map((team) => {
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
                <span className="t-mono team-active">
                  {team.activeCount}/{team.memberCount} active
                </span>
                <span className={`t-mono team-residency team-residency--${team.residency}`}>
                  {team.residency === "human_driven" ? "manual" : team.residency}
                </span>
              </div>
              <div className="t-mono team-meta">{meta.join(" · ")}</div>
              <div className="team-members">
                {team.members.map((member) => (
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
  if (board.hosts.length === 0 && board.recommended_actions.length === 0 && board.conflicts.length === 0) return null;

  return (
    <section className="host-board-panel" aria-label="host board">
      <div className="host-board-head">
        <h2 className="host-board-title">Host Board</h2>
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

function TeamThread({ thread, self }: { thread: TeamMessageThread; self: string | null }) {
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
          <MessageCard key={message.seq} msg={message} self={self} />
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
  shareMode,
  canMintAgent,
  canResetGuard,
  agentNamePrefix,
  inviterName,
  onAuthFailed,
}: Props) {
  const [state, dispatch] = useReducer(channelReducer, initialChannelState);
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
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const [teamNow, setTeamNow] = useState(() => Date.now());
  const [completionOnly, setCompletionOnly] = useState(false);
  const [agentFilter, setAgentFilter] = useState<AgentFilter>(() => parseAgentFilter(window.location.search));
  const sockRef = useRef<ChannelSocket | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const pendingDraftsRef = useRef<string[]>([]);
  const stickBottom = useRef(true);
  const authFailedRef = useRef(onAuthFailed);
  authFailedRef.current = onAuthFailed;
  // IM 式加载：初始只拉最新一页、ws 从页尾游标接力；触顶上翻加载更早页
  const [bootstrapped, setBootstrapped] = useState(false); // 初始页已就绪，ws 才连
  const hasMoreRef = useRef(true); // 还有更早的历史可上翻
  const loadingOlderRef = useRef(false); // 上翻请求进行中（去抖）
  const initialCursorRef = useRef(0); // ws hello 的起始游标 = 初始页最后一条 seq
  const pendingAnchorRef = useRef<{ height: number; top: number } | null>(null); // prepend 前的滚动锚
  const oldestSeqRef = useRef(0);
  oldestSeqRef.current = state.messages.length > 0 ? state.messages[0]!.seq : 0;

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
          // 窗口下界防御（review P1 双保险）：低于已加载窗口的旧消息/旧修订不进窗口——
          // 插进去会把上翻分页的 before 起点拽到远古 seq，中段历史被永久跳过。
          // 上翻时 REST 本来就返回当前正文，丢掉这些帧无信息损失。
          const floor = oldestSeqRef.current;
          if (floor > 0) {
            if ((frame.type === "msg" || frame.type === "status") && frame.seq < floor) return;
            if (frame.type === "message_update" && frame.message.seq < floor) return;
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
  }, [slug, token, shareMode, bootstrapped]);

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
  useEffect(() => {
    const el = streamRef.current;
    if (el !== null && stickBottom.current) el.scrollTop = el.scrollHeight;
    // 贴底时收窄消息窗口：DOM 不挂几千条；被丢弃的最老页上翻会重新拉回
    if (stickBottom.current && state.messages.length > MESSAGE_CAP + PAGE_SIZE) {
      dispatch({ type: "trim", keep: MESSAGE_CAP });
      hasMoreRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq]);

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
    if (el.scrollTop < TOP_LOAD_PX) loadOlder();
  }, [loadOlder]);

  // 服务端 sent 确认后才清对应草稿；用户已输入的新内容不能被旧 ack 清掉。
  useEffect(() => {
    if (state.lastSentSeq <= 0) return;
    const submitted = pendingDraftsRef.current.shift();
    if (submitted === undefined) return;
    setDraft((current) => (current === submitted ? "" : current));
  }, [state.lastSentSeq]);

  const send = useCallback(() => {
    const body = draft.trim();
    if (body === "") return;
    const mentions = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]!))];
    const ok =
      sockRef.current?.send({ type: "send", kind: "message", body, mentions, reply_to: null }) ??
      false;
    // ⌘⏎ 不受按钮 disabled 门控，断线窗口内发送失败要内联提示（草稿保留）
    if (ok) pendingDraftsRef.current.push(draft);
    else dispatch({ type: "send_failed", message: "not connected — message not sent, draft kept" });
  }, [draft]);

  const canWrite = state.self !== null && !state.archived && !state.readonly;
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
      ...state.messages.map((m) => m.sender.name),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const senderListId = `senders-${slug}`;
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
  const agentFilterActive = agentFilter.agents.length > 0;
  const totalInView = q === "" ? timelineMessages.length : searchHits.length;
  const visibleInView = q === "" ? visibleMessages.length : visibleSearchHits.length;

  const setAgentMode = useCallback((mode: AgentFilterMode) => {
    setAgentFilter((current) => ({ ...current, mode }));
  }, []);

  const toggleAgentFilter = useCallback((agent: string) => {
    setAgentFilter((current) => toggleAgent(current, agent));
  }, []);

  const clearAgentFilter = useCallback(() => {
    setAgentFilter((current) => ({ ...current, agents: [] }));
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
          这是私有频道，你没有访问权限
        </p>
      </div>
    );
  }

  return (
    <div className="chan">
      <PresenceBar
        presence={state.presence}
        participants={state.participants}
        status={state.status}
        party={mode === "party" || state.mode === "party"}
        isPublic={isPublic}
      />
      {canMintAgent && !state.archived && (
        <div className="chan-toolbar">
          <AgentJoin slug={slug} token={token} namePrefix={agentNamePrefix} inviterName={inviterName} />
        </div>
      )}
      {/* chat-first：这些协调/元信息面板默认折叠，避免把核心对话流挤出首屏。展开查看 digest/过滤/host board 等。 */}
      <details className="chan-panels">
        <summary className="chan-panels-summary t-mono">
          ▸ 协调面板 · digest / 过滤 / host board / teams / decisions / completions（默认折叠，点开查看）
        </summary>
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
      </details>
      {(state.messages.length > 0 || q !== "") && (
        <div className="chan-search-panel">
          <div className="chan-search-row">
            <input
              className="t-mono chan-search"
              type="search"
              value={search}
              spellCheck={false}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜本频道消息"
              aria-label="search messages"
            />
            {q !== "" && (
              <span className="t-mono chan-search-count">
                {searchLoading
                  ? "searching"
                  : agentFilterActive
                    ? `${visibleSearchHits.length}/${searchHits.length} hits`
                    : `${searchHits.length} hits`}
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
                placeholder="from agent"
                aria-label="search sender filter"
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
                placeholder="since seq"
                aria-label="search since sequence"
              />
              <input
                className="t-mono chan-filter-input chan-filter-input--short"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={searchLimit}
                onChange={(e) => setSearchLimit(e.target.value)}
                placeholder="limit"
                aria-label="search result limit"
              />
            </div>
          )}
        </div>
      )}
      {/* overflow-anchor:none —— 浏览器原生滚动锚定会和我们手动的 prepend 锚定打架 */}
      <div className="stream" ref={streamRef} onScroll={onScroll} style={{ overflowAnchor: "none" }}>
        {q === ""
          ? visibleTimeline.map((item) =>
              item.type === "message" ? (
                <MessageCard key={item.message.seq} msg={item.message} self={state.self} />
              ) : (
                <TeamThread key={item.key + `:${item.firstSeq}-${item.lastSeq}`} thread={item} self={state.self} />
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
            {completionOnly ? "no completion artifacts match selected agents" : "no messages match selected agents"}
          </p>
        )}
        {q !== "" && !searchLoading && searchHits.length === 0 && searchInputError === null && searchError === null && (
          <p className="d-empty" role="status" aria-live="polite">
            没有匹配「{search.trim()}」的消息
          </p>
        )}
        {q !== "" && !searchLoading && searchHits.length > 0 && visibleSearchHits.length === 0 && (
          <p className="d-empty" role="status" aria-live="polite">
            no search hits match selected agents
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
      {canWrite && (
        <Composer draft={draft} setDraft={setDraft} onSend={send} ready={state.status === "open"} />
      )}
    </div>
  );
}
