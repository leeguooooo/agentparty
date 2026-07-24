// 单 Agent 详情弹窗（#272 审计重开）：分工面板/presence roster 里点某个 agent，
// 独立看它的工作状态（presence 已有字段）、历史工作内容（本频道已加载消息里过滤出它发的）、
// 在线状态。不建新后端——所有数据来自调用方已经持有的 presence/messages。
import type { CollaborationRole, MsgFrame, PresenceEntry, Sender } from "@agentparty/shared";
import { autoWakeReachable, wakeableState } from "@agentparty/shared";
import { useEffect } from "react";
import { fmtRel } from "../lib/time";
import { useT } from "../i18n/useT";
import "../i18n/strings/AgentDetailModal";

export type AgentDetailAssignmentSource = "assigned" | "self_reported" | "none";

export interface AgentDetailAssignment {
  role: CollaborationRole | null;
  responsibility: string | null;
  reportsTo: string | null;
  source: AgentDetailAssignmentSource;
}

export interface AgentDetailPanelProps {
  name: string;
  display: string;
  kind: Sender["kind"];
  owner: string | null;
  online: boolean;
  presence: PresenceEntry | null;
  messages: MsgFrame[];
  /**
   * Resolved channel assignment. When omitted, presence role/lineage remains visible
   * as explicitly unconfirmed self-report; an assigned value replaces that fallback.
   */
  assignment?: AgentDetailAssignment;
}

export interface AgentDetailModalProps extends AgentDetailPanelProps {
  onClose: () => void;
}

const HISTORY_LIMIT = 20;

// 历史工作：从已加载的频道消息里过滤出这个 agent 发的，按 seq 倒序取最近 N 条。
// 纯函数、单独导出——是这块唯一有「过滤对不对」这个是非判断的地方。
export function filterAgentHistory(messages: MsgFrame[], name: string, limit = HISTORY_LIMIT): MsgFrame[] {
  return messages
    .filter((m) => m.sender.name === name)
    .slice()
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit);
}

function firstLine(body: string): string {
  const line = (body.split("\n")[0] ?? "").trim();
  if (line.length <= 140) return line;
  return `${line.slice(0, 140)}…`;
}

function AgentDetailContent({
  name,
  display,
  kind,
  owner,
  online,
  presence,
  messages,
  assignment,
  onClose,
}: AgentDetailPanelProps & { onClose?: () => void }) {
  const t = useT();

  const now = Date.now();
  const history = filterAgentHistory(messages, name);
  const state = presence !== null && presence.state !== "offline" ? presence.state : online ? "online" : "offline";
  const wake = presence !== null ? wakeableState(presence, now) : null;
  // #666：wakeableState 只看 wake layer + 服务端校验，不看 freshness——一个被 harness 收割的 watch --once
  // 会仍报 wakeable_unverified，让人误以为叫得醒。离线且 autoWakeReachable 判不可达时，如实标 unreachable，
  // 与 PresenceBar 的未监听徽章同口径（watch 已退出 / 从未验证，@ 只进历史）。
  const unreachable = state === "offline" && wake !== null && wake !== "offline" && !(presence !== null && autoWakeReachable(presence, now));
  const busy = presence?.busy === true;
  const queueDepth = busy && typeof presence?.queue_depth === "number" ? presence.queue_depth : null;
  const waitingOwnerCount =
    typeof presence?.waiting_owner_count === "number" && presence.waiting_owner_count > 0 ? presence.waiting_owner_count : 0;
  const currentTask = typeof presence?.current_task === "number" ? presence.current_task : null;
  const heartbeatAt = currentTask !== null && typeof presence?.heartbeat_at === "number" ? presence.heartbeat_at : null;
  const paused = presence?.paused === true;
  const resumeAt = presence?.resume_at ?? null;
  const presenceRole = presence?.role ?? null;
  const hasSelfReportedRole = presence?.role_source === "self" && presenceRole !== null;
  const source =
    assignment?.source ??
    (hasSelfReportedRole ? "self_reported" : "none");
  // A supplied assignment is authoritative even when one of its values is null:
  // null means the owner deliberately left/cleared that field, not "fall back to presence".
  const role = source === "none" ? null : assignment !== undefined ? assignment.role : presenceRole;
  const responsibility =
    source === "none"
      ? null
      : assignment !== undefined
        ? assignment.responsibility
        : presence?.note?.trim() || null;
  // Presence lineage is runtime spawn ancestry, not an assigned reporting relationship.
  const reportsTo = source === "none" || assignment === undefined ? null : assignment.reportsTo;
  const clientVersion = presence?.client_version ?? null;
  const agentSession = presence?.agent_session ?? null;
  const confidenceLabel = () =>
    source === "self_reported" ? (
      <span className="agent-detail-assignment-source"> · {t("AgentDetailModal.roleSelfReported")}</span>
    ) : null;

  return (
    <>
      <header className="channel-panel-head">
        <div className="channel-panel-titlebox">
          <h2>
            {display}
            {display !== name && <span className="t-mono agent-detail-alias"> · {name}</span>}
          </h2>
          <p className="t-mono agent-detail-meta">
            <span className={`d-dot d-dot--${state}${paused ? " d-dot--paused" : ""}`} />
            <span className="agent-detail-online-badge">
              {online ? t("AgentDetailModal.online") : t("AgentDetailModal.offline")}
            </span>
            <span className={`t-mono agent-detail-kind agent-detail-kind--${kind}`}>{kind}</span>
            {owner !== null && owner !== "" && <span className="agent-detail-owner">{owner}</span>}
          </p>
        </div>
        {onClose !== undefined && (
          <button className="d-btn channel-panel-close" type="button" onClick={onClose}>
            {t("Channel.tools.close")}
          </button>
        )}
      </header>
      <div className="channel-panel-body agent-detail-body">
        <section className="agent-detail-section" aria-label={t("AgentDetailModal.status")}>
          <h3>{t("AgentDetailModal.status")}</h3>
          <dl className="agent-detail-facts">
            <div className="agent-detail-fact">
              <dt>{t("AgentDetailModal.state")}</dt>
              <dd className="t-mono">{state}</dd>
            </div>
            <div className="agent-detail-fact">
              <dt>{t("AgentDetailModal.waitingOwner")}</dt>
              <dd className="t-mono">
                {waitingOwnerCount > 0
                  ? t("AgentDetailModal.waitingOwnerCount", { count: String(waitingOwnerCount) })
                  : t("AgentDetailModal.waitingOwnerNone")}
              </dd>
            </div>
            {presence?.note !== null && presence?.note !== undefined && presence.note !== "" && (
              <div className="agent-detail-fact">
                <dt>{t("AgentDetailModal.note")}</dt>
                <dd>{presence.note}</dd>
              </div>
            )}
            <div className="agent-detail-fact">
              <dt>{t("AgentDetailModal.busy")}</dt>
              <dd className="t-mono">
                {busy
                  ? queueDepth !== null
                    ? t("AgentDetailModal.busyQueued", { count: String(queueDepth) })
                    : t("AgentDetailModal.busyYes")
                  : t("AgentDetailModal.busyNo")}
              </dd>
            </div>
            {currentTask !== null && (
              <div className="agent-detail-fact">
                <dt>{t("AgentDetailModal.currentTask")}</dt>
                <dd className="t-mono">
                  #{currentTask}
                  {heartbeatAt !== null ? ` · ♥ ${fmtRel(heartbeatAt, now)}` : ""}
                </dd>
              </div>
            )}
            <div className="agent-detail-fact">
              <dt>{t("AgentDetailModal.paused")}</dt>
              <dd className="t-mono">
                {paused
                  ? resumeAt !== null
                    ? t("AgentDetailModal.pausedUntil", { time: new Date(resumeAt).toLocaleString() })
                    : t("AgentDetailModal.pausedManual")
                  : t("AgentDetailModal.notPaused")}
              </dd>
            </div>
            {wake !== null && (
              <div className="agent-detail-fact">
                <dt>{t("AgentDetailModal.wake")}</dt>
                <dd className={`t-mono agent-detail-wake agent-detail-wake--${unreachable ? "unreachable" : wake}`}>
                  {t(unreachable ? "AgentDetailModal.wake.unreachable" : `AgentDetailModal.wake.${wake}`)}
                </dd>
              </div>
            )}
          </dl>
        </section>
        <section className="agent-detail-section" aria-label={t("AgentDetailModal.history")}>
          <h3>{t("AgentDetailModal.history")}</h3>
          {history.length === 0 ? (
            <p className="t-mono agent-detail-empty">{t("AgentDetailModal.historyEmpty")}</p>
          ) : (
            <ul className="agent-detail-history-list">
              {history.map((m) => (
                <li key={m.seq} className="agent-detail-history-item">
                  <span className="t-mono agent-detail-history-seq">#{m.seq}</span>
                  <span className="t-mono agent-detail-history-time">{fmtRel(m.ts, now)}</span>
                  <span className="agent-detail-history-body">{firstLine(m.body)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="agent-detail-section" aria-label={t("AgentDetailModal.info")}>
          <h3>{t("AgentDetailModal.info")}</h3>
          <dl className="agent-detail-facts">
            <div className="agent-detail-fact">
              <dt>{t("AgentDetailModal.role")}</dt>
              <dd className="t-mono">
                {role ?? t("AgentDetailModal.roleNone")}
                {role !== null && confidenceLabel()}
              </dd>
            </div>
            {responsibility !== null && responsibility !== "" && (
              <div className="agent-detail-fact">
                <dt>{t("AgentDetailModal.responsibility")}</dt>
                <dd>{responsibility}</dd>
              </div>
            )}
            {reportsTo !== null && (
              <div className="agent-detail-fact">
                <dt>{t("AgentDetailModal.reportsTo")}</dt>
                <dd className="t-mono">{reportsTo}</dd>
              </div>
            )}
            {clientVersion !== null && (
              <div className="agent-detail-fact">
                <dt>{t("AgentDetailModal.clientVersion")}</dt>
                <dd className="t-mono">v{clientVersion}</dd>
              </div>
            )}
            {agentSession !== null && (
              <>
                <div className="agent-detail-fact">
                  <dt>{t("AgentDetailModal.session")}</dt>
                  <dd className="t-mono">
                    {agentSession.harness}:{agentSession.session_id} · {fmtRel(agentSession.updated_at, now)}
                  </dd>
                </div>
                {agentSession.cwd !== undefined && (
                  <div className="agent-detail-fact">
                    <dt>{t("AgentDetailModal.sessionCwd")}</dt>
                    <dd className="t-mono">{agentSession.cwd}</dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </section>
      </div>
    </>
  );
}

/**
 * Inline member detail surface. Deliberately owns no modal chrome or global
 * keyboard behavior so it can live inside the Team module without nesting dialogs.
 */
export function AgentDetailPanel(props: AgentDetailPanelProps) {
  return (
    <section className="agent-detail-panel">
      <AgentDetailContent {...props} />
    </section>
  );
}

/** Backward-compatible modal wrapper for existing callers. */
export function AgentDetailModal({ onClose, ...props }: AgentDetailModalProps) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="channel-panel-overlay agent-detail-overlay" role="dialog" aria-modal="true" aria-label={t("AgentDetailModal.title", { name: props.display })}>
      <button className="channel-panel-scrim" type="button" aria-label={t("Channel.tools.close")} onClick={onClose} />
      <section className="channel-panel-card agent-detail-card">
        <AgentDetailContent {...props} onClose={onClose} />
      </section>
    </div>
  );
}
