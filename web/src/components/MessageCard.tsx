// 消息渲染：message → doodle 卡片外壳 + mono 元信息 + markdown 正文；
// status → 时间线分隔条（spec §9 第 2 块）。
import type { AgentContext, MsgFrame, PresenceEntry, ReadCursor, Sender } from "@agentparty/shared";
import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { agentHue } from "../lib/agentColor";
import { displayForIdentity, resolveSenderLabel, type IdentityDisplayMap } from "../lib/identityDisplay";
import { readStateFor } from "../lib/readList";
import { summarizeReplyPreview } from "../lib/replyPreview";
import { useT } from "../i18n/useT";
import "../i18n/strings/MessageCard";
import "../i18n/strings/Channel";
import { fmtTime } from "../lib/time";
import type { MentionReceipt } from "../lib/wakeReceipt";
import { AttachmentList } from "./AttachmentList";
import { Markdown } from "./Markdown";
import { MessageStatus } from "./MessageStatus";

interface Props {
  msg: MsgFrame;
  self: string | null;
  identityDisplay?: IdentityDisplayMap;
  receipts?: MentionReceipt[]; // 本条被 @ 的 agent 目标的唤醒/回执状态（Phase 1）
  readCursors?: Record<string, ReadCursor>; // 已读游标（Phase 2）
  participants?: Sender[]; // 当前连着的身份，用于算未读
  // 引用预览：reply_to 解析出的完整原消息（Channel 用 seq → msg 的 Map 查出来的）。
  // null 有两种含义——没有引用（reply_to 本身就是 null）或引用目标不在已加载窗口内；
  // 后一种情况下面渲染时会降级回纯编号 ↩ #N，不强行伪造内容。
  quotedMessage: MsgFrame | null;
  // 消息右键菜单（PR #49）：引用/编辑/撤回/复制
  canModerate: boolean;
  onReply(seq: number): void;
  onEdit(seq: number): void;
  onRetract(seq: number): void;
  canCreateTask: boolean;
  onCreateTask(seq: number): void;
  editing: boolean;
  editDraft: string;
  editSaving: boolean;
  actionError: string | null;
  busy: boolean;
  onEditDraftChange(value: string): void;
  onEditCancel(): void;
  onEditSave(): void;
  // #274：name → presence 条目（Channel 的 state.presence 原样传下来），悬停发送者名/@提及展示实时状态。
  presence?: Record<string, PresenceEntry>;
  // 频道决策协议（#284）：人类/moderator 是否可对本条 decision_request 拍板 + 回调。
  canRespondDecision?: boolean;
  decisionBusy?: boolean;
  onDecisionRespond?(seq: number, choice: { action: "approve" } | { action: "reject"; reason?: string } | { option: number }): void;
}

function contextBits(ctx: AgentContext | undefined): string[] {
  if (ctx === undefined) return [];
  return [
    ctx.worktree_label ? `wt:${ctx.worktree_label}` : null,
    ctx.workspace_label ? `ws:${ctx.workspace_label}` : null,
    ctx.config_kind ? `cfg:${ctx.config_kind}` : null,
    ctx.config_fingerprint ? `fp:${ctx.config_fingerprint}` : null,
  ].filter((part): part is string => part !== null);
}

function workflowBits(msg: MsgFrame): string[] {
  const workflow = msg.status?.workflow;
  if (workflow === undefined) return [];
  return [
    `wf:${workflow.workflow_id}`,
    workflow.run_id !== null ? `run:${workflow.run_id}` : null,
    workflow.step_id !== null ? `step:${workflow.step_id}` : null,
    workflow.parent_summary_seq !== null ? `parent:#${workflow.parent_summary_seq}` : null,
  ].filter((part): part is string => part !== null);
}

function reviewLabel(msg: MsgFrame): string | null {
  const review = msg.completion_review;
  if (review === undefined) return null;
  if (review.state === "pending_review") return "pending review";
  if (review.state === "approved") return "approved";
  return "rejected";
}

function reviewTitle(msg: MsgFrame): string {
  const review = msg.completion_review;
  if (review === undefined) return "";
  return [
    `review: ${review.state}`,
    `policy: ${review.policy}`,
    review.reviewer ? `reviewer: ${review.reviewer.name}` : null,
    review.reviewed_at ? `reviewed: ${fmtTime(review.reviewed_at)}` : null,
    review.replaces_seq ? `replaces: #${review.replaces_seq}` : null,
    review.replaced_by_seq ? `replaced by: #${review.replaced_by_seq}` : null,
    review.reason ? `reason: ${review.reason}` : null,
  ].filter((part): part is string => part !== null).join("\n");
}

/**
 * worker 常把同一句话既写进 status.note 又写进 blocked_reason（两者是独立字段，
 * shared/src/protocol.ts）。时间线把两份同文用 `·` 一拼就成「… · blocked …」的整句
 * 重复（issue #147）。这里判断该不该单列 blocked 那条：与 note 同文时不列。
 */
export function blockedReasonDuplicatesNote(
  note: string | null | undefined,
  blockedReason: string | null | undefined,
): boolean {
  const n = note?.trim() ?? "";
  const b = blockedReason?.trim() ?? "";
  // b === n 且 b 非空 已蕴含 n 非空，不再赘写 n !== ""（变异证明那是死代码）
  return b !== "" && b === n;
}

/**
 * #274：鼠标悬停任意 agent 名字（发送者名/@提及）即见其实时状态。取 presence 里该名字的
 * 条目拼三行：status（busy #103 优先于声明的 state）、task #seq（#228 正在处理的那条 wake）、
 * queued N（#103 排队深度，>0 才列）。presence 查不到该名字 → 空数组，不加空行。
 */
export function presenceTitleBits(entry: PresenceEntry | undefined): string[] {
  if (entry === undefined) return [];
  return [
    `status: ${entry.busy === true ? "busy" : entry.state}`,
    typeof entry.current_task === "number" ? `task: #${entry.current_task}` : null,
    typeof entry.queue_depth === "number" && entry.queue_depth > 0 ? `queued: ${entry.queue_depth}` : null,
  ].filter((part): part is string => part !== null);
}

// memo 化：主输入框每次按键都会重渲染 Channel（draft 是顶层 state），中文 IME 尤其密集。
// 卡片的所有 props（msg / 各 useCallback 回调 / useMemo 出来的 identityDisplay·receipts /
// 逐条标量）在 draft-only 重渲染时引用稳定，浅比较即可跳过整窗口卡片的重渲染，消除输入卡顿
// （issue #399④）。真正变动的那条卡片（新消息 / 编辑中 / 回执变化）props 会变，照常更新。
function MessageCardImpl({
  msg,
  self,
  identityDisplay,
  receipts,
  readCursors,
  participants,
  quotedMessage,
  canModerate,
  onReply,
  onEdit,
  onRetract,
  canCreateTask,
  onCreateTask,
  editing,
  editDraft,
  editSaving,
  actionError,
  busy,
  onEditDraftChange,
  onEditCancel,
  onEditSave,
  presence,
  canRespondDecision,
  decisionBusy,
  onDecisionRespond,
}: Props) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [decisionRejecting, setDecisionRejecting] = useState(false);
  const [decisionRejectDraft, setDecisionRejectDraft] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // 每个 agent 一个确定性色相：CSS 用 --ah 套 hsl() 给头像点/名字/卡片左条上色
  const hueStyle = { "--ah": agentHue(msg.sender.name) } as CSSProperties;
  // 已读/未读名单（Phase 2）：只在有游标数据时算；status 分隔条不显示。
  const read =
    msg.kind === "message" && readCursors !== undefined
      ? readStateFor(msg.seq, msg.sender.name, participants ?? [], readCursors)
      : { readers: [], unread: [] };
  // owner/email 无论是否被 handle 取代，都作为防冒充锚点保留在下方副标签 + tooltip 中（见 senderTitle）。
  const senderLabel = resolveSenderLabel(msg.sender, identityDisplay);
  const owner = msg.sender.owner && msg.sender.owner !== senderLabel ? msg.sender.owner : null;
  const lineage = msg.sender.lineage ?? null;
  const lineageLabel = lineage === null ? null : `child of ${lineage.parent_agent}`;
  const senderTitle = [
    `sender: ${msg.sender.name}`,
    `kind: ${msg.sender.kind}`,
    msg.sender.handle ? `handle: ${msg.sender.handle}` : null,
    owner ? `owner: ${owner}` : null,
    lineage ? `parent: ${lineage.parent_agent}` : null,
    lineage ? `root: ${lineage.root_agent}` : null,
    lineage ? `team: ${lineage.team_id}` : null,
    lineage ? `depth: ${lineage.depth}` : null,
    lineage?.expires_at ? `expires: ${fmtTime(lineage.expires_at)}` : null,
    ...presenceTitleBits(presence?.[msg.sender.name]),
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
  const revisionBadges = [
    msg.completion_artifact !== undefined ? "completion" : null,
    msg.edited ? t("MessageCard.badge.edited") : null,
    msg.retracted ? t("MessageCard.badge.retracted") : null,
    msg.supersedes !== undefined ? `supersedes #${msg.supersedes}` : null,
    msg.superseded_by !== undefined ? `superseded by #${msg.superseded_by}` : null,
  ].filter((part): part is string => part !== null);
  const review = msg.completion_review;
  const reviewBadge = reviewLabel(msg);
  const reviewTitleText = reviewTitle(msg);
  // 决策协议（#284）：decision_request 挂请求 + 落地状态；decision_response 是回应回复。
  const decision = msg.decision_request;
  const resolution = msg.decision_resolution;
  const decisionPending = decision !== undefined && (resolution === undefined || resolution.state === "pending");
  const decisionState = resolution?.state ?? (decision !== undefined ? "pending" : undefined);
  const decisionResponse = msg.decision_response;
  const canRevise = (self !== null && msg.sender.name === self) || canModerate;
  const canShowActions = msg.kind === "message";
  const canReply = canShowActions && !msg.retracted;
  const canTask = canReply && canCreateTask;
  const canEdit = canReply && canRevise;
  const canRetract = canReply && canRevise;
  const saveDisabled = editSaving || editDraft.trim() === "" || editDraft === msg.body;
  const menuItemCount = Number(canReply) + Number(canTask) + Number(canEdit) + Number(canRetract) + 1;
  // 引用预览：quotedMessage 为 null 有两种含义——没引用，或引用目标不在已加载窗口内；
  // 后者在渲染处降级回纯编号 ↩ #N（见下方 JSX），这里只在真有内容时才算标签/预览文字。
  const quotedSenderLabel = quotedMessage !== null ? resolveSenderLabel(quotedMessage.sender, identityDisplay) : null;
  const quotedPreviewText =
    quotedMessage !== null
      ? quotedMessage.retracted
        ? t("MessageCard.reply.retracted")
        : summarizeReplyPreview(quotedMessage.body)
      : null;
  const jumpToQuoted = () => {
    if (msg.reply_to === null) return;
    const target = document.getElementById(`msg-${msg.reply_to}`);
    if (target === null) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("msg-jump-highlight");
    window.setTimeout(() => target.classList.remove("msg-jump-highlight"), 1200);
  };

  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const openMenuAt = (x: number, y: number) => {
    const clampedX = Math.max(8, Math.min(x, window.innerWidth - 188));
    const clampedY = Math.max(8, Math.min(y, window.innerHeight - (menuItemCount * 38 + 18)));
    setMenu({ x: clampedX, y: clampedY });
  };
  const copyText = () => {
    if (navigator.clipboard !== undefined) {
      void navigator.clipboard.writeText(msg.body).then(() => setCopied(true)).catch(() => undefined);
    }
    setMenu(null);
  };

  if (msg.kind === "status") {
    const context = msg.status?.context;
    const statusContextBits = contextBits(context);
    const statusWorkflowBits = workflowBits(msg);
    const statusTitle = [
      senderTitle,
      context?.worktree_label ? `worktree: ${context.worktree_label}` : null,
      context?.workspace_id ? `workspace id: ${context.workspace_id}` : null,
      context?.workspace_label ? `workspace: ${context.workspace_label}` : null,
      context?.config_kind ? `config: ${context.config_kind}` : null,
      context?.config_fingerprint ? `fingerprint: ${context.config_fingerprint}` : null,
      msg.status?.workflow ? `workflow: ${msg.status.workflow.workflow_id}` : null,
      msg.status?.workflow ? `workflow kind: ${msg.status.workflow.kind}` : null,
      msg.status?.workflow?.run_id ? `workflow run: ${msg.status.workflow.run_id}` : null,
      msg.status?.workflow?.step_id ? `workflow step: ${msg.status.workflow.step_id}` : null,
      msg.status?.workflow?.parent_summary_seq ? `parent summary: #${msg.status.workflow.parent_summary_seq}` : null,
    ].filter((part): part is string => part !== null && part !== "").join("\n");
    // worker 常把同一句话既写进 note 又写进 blocked_reason，直接拼接会让时间线出现
    // 「… · blocked …」的整句重复（issue #147）——受阻原因与 note 同文时去掉重复的那一份。
    const blockedReason = msg.status?.blocked_reason ?? null;
    const blockedIsDupOfNote = blockedReasonDuplicatesNote(msg.note, blockedReason);
    const statusBits = [
      msg.note,
      msg.status?.scope.length ? `scope ${msg.status.scope.join(", ")}` : null,
      blockedReason !== null && !blockedIsDupOfNote ? `blocked ${blockedReason}` : null,
      msg.status?.summary_seq !== null && msg.status?.summary_seq !== undefined ? `summary #${msg.status.summary_seq}` : null,
    ].filter((part): part is string => typeof part === "string" && part !== "");
    // #280/#357：紧凑状态行保留 title，同时提供点击/键盘展开，触屏也能读取完整详情。
    const statusFullDetail = [statusBits.join(" · "), statusTitle].filter((part) => part !== "").join("\n");
    const contextDetailBits = [
      owner !== null ? `owner:${owner}` : null,
      lineage !== null ? `parent:${lineage.parent_agent}` : null,
      lineage !== null ? `root:${lineage.root_agent}` : null,
      lineage !== null ? `team:${lineage.team_id}` : null,
      ...statusContextBits,
      ...statusWorkflowBits,
    ].filter((part): part is string => part !== null);
    const toggleStatus = () => setStatusExpanded((expanded) => !expanded);
    return (
      <div id={`msg-${msg.seq}`} className="msg-status" data-state={msg.state ?? undefined} style={hueStyle}>
        <span
          className="msg-status-summary"
          title={statusFullDetail !== "" ? statusFullDetail : undefined}
          role="button"
          tabIndex={0}
          aria-expanded={statusExpanded}
          onClick={toggleStatus}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggleStatus();
          }}
          style={{ cursor: "pointer" }}
        >
          <span className="msg-sender" title={senderTitle}>{senderLabel}</span>
          {" "}
          → {msg.state}
          {statusBits.length > 0 ? ` · ${statusBits.join(" · ")}` : ""} · {fmtTime(msg.ts)}
        </span>
        {contextDetailBits.length > 0 && (
          <button
            type="button"
            className="t-mono msg-context-more"
            aria-label={t("Channel.message.context.toggle")}
            aria-expanded={contextExpanded}
            style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer" }}
            onClick={() => setContextExpanded((expanded) => !expanded)}
          >
            ⋯
          </button>
        )}
        {statusExpanded && statusFullDetail !== "" && <pre className="msg-status-detail t-mono">{statusFullDetail}</pre>}
        {contextExpanded && contextDetailBits.length > 0 && (
          <span className="msg-context msg-context-detail">
            {contextDetailBits.map((bit) => <span key={bit} className="t-mono">{bit}</span>)}
          </span>
        )}
      </div>
    );
  }

  const mine = self !== null && msg.sender.name === self;
  const artifact = msg.completion_artifact;
  const artifactBits =
    artifact === undefined
      ? []
      : [
          `kickoff #${artifact.kickoff_seq}`,
          `${artifact.replies_count} replies`,
          artifact.timeout ? "timeout" : "closed",
          artifact.related_issues.length > 0 ? `issues ${artifact.related_issues.map((n) => `#${n}`).join(", ")}` : null,
          artifact.related_prs.length > 0 ? `PRs ${artifact.related_prs.map((n) => `#${n}`).join(", ")}` : null,
        ].filter((part): part is string => part !== null);
  return (
    <article
      id={`msg-${msg.seq}`}
      className={"d-card msg-card" + (mine ? " msg-card--own" : "")}
      style={hueStyle}
      onContextMenu={
        canShowActions
          ? (event) => {
              event.preventDefault();
              openMenuAt(event.clientX, event.clientY);
            }
          : undefined
      }
    >
      <header className="d-meta msg-head">
        {msg.sender.avatar_thumb || msg.sender.avatar_url ? (
          <img className="msg-avatar msg-avatar--img" src={msg.sender.avatar_thumb ?? msg.sender.avatar_url} alt="" />
        ) : (
          <span className="msg-avatar" aria-hidden="true" />
        )}
        <span className="msg-sender" title={senderTitle}>{senderLabel}</span>
        {/* owner(lark 长 id）不再每条平铺——它已在 senderTitle 里，悬停发送者名即见；
           防冒充锚点保留在 tooltip + kind 徽章，行内只留重要内容（名字/类型/提及）。 */}
        {lineageLabel !== null && (
          <span className="t-mono msg-lineage" title={senderTitle}>
            {lineageLabel}
          </span>
        )}
        <span className={"msg-kind" + (msg.sender.kind === "human" ? " msg-kind--human" : "")}>
          {msg.sender.kind}
        </span>
        {msg.mentions.map((m) => {
          // #274：@提及悬停也能看到该名字的实时状态；原始名与显示名不同时保留 @原名防冒充锚点。
          const mentionTitle = [
            m === displayForIdentity(m, identityDisplay) ? null : `@${m}`,
            ...presenceTitleBits(presence?.[m]),
          ]
            .filter((part): part is string => part !== null)
            .join("\n");
          return (
            <span key={m} className="msg-mention" title={mentionTitle !== "" ? mentionTitle : undefined}>
              @{displayForIdentity(m, identityDisplay)}
            </span>
          );
        })}
        {msg.reply_to !== null && quotedMessage === null && <span className="msg-reply">↩ #{msg.reply_to}</span>}
        {revisionBadges.map((badge) => (
          <span key={badge} className="msg-revision">
            {badge}
          </span>
        ))}
        {review !== undefined && reviewBadge !== null && (
          <span className={`msg-review msg-review--${review.state}`} title={reviewTitleText}>
            {reviewBadge}
          </span>
        )}
        {decisionState !== undefined && (
          <span className={`msg-decision-badge msg-decision-badge--${decisionState}`}>
            {t(`MessageCard.decision.state.${decisionState}`)}
          </span>
        )}
        {decisionResponse !== undefined && (
          <span className="msg-decision-badge msg-decision-badge--response">
            {t("MessageCard.decision.responseBadge")}
          </span>
        )}
        <span className="msg-fill" />
        {copied && <span className="msg-copy-feedback">{t("MessageCard.copied")}</span>}
        {canShowActions && (
          <button
            ref={triggerRef}
            type="button"
            className="d-btn msg-menu-trigger"
            aria-label={t("MessageCard.menu.more")}
            aria-expanded={menu !== null}
            title={t("MessageCard.menu.more")}
            disabled={busy}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openMenuAt(rect.right - 12, rect.bottom + 6);
            }}
          >
            ⋯
          </button>
        )}
        <span>#{msg.seq}</span>
        <time>{fmtTime(msg.ts)}</time>
      </header>
      {msg.reply_to !== null && quotedMessage !== null && (
        <button
          type="button"
          className="msg-quote"
          onClick={jumpToQuoted}
          title={quotedMessage.retracted ? undefined : quotedMessage.body}
          aria-label={t("MessageCard.reply.jump", { seq: msg.reply_to })}
        >
          <span className="msg-quote-icon" aria-hidden="true">↩</span>
          <span className="msg-quote-sender">{quotedSenderLabel}</span>
          <span className="msg-quote-text">{quotedPreviewText}</span>
        </button>
      )}
      <MessageStatus
        receipts={receipts ?? []}
        readers={read.readers}
        unread={read.unread}
        display={(name) => displayForIdentity(name, identityDisplay)}
      />
      {menu !== null && (
        <div ref={menuRef} className="msg-menu" style={{ left: menu.x, top: menu.y }}>
          {canReply && (
            <button
              type="button"
              className="msg-menu-item"
              onClick={() => {
                setMenu(null);
                onReply(msg.seq);
              }}
            >
              {t("MessageCard.menu.reply")}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="msg-menu-item"
              onClick={() => {
                setMenu(null);
                onEdit(msg.seq);
              }}
            >
              {t("MessageCard.menu.edit")}
            </button>
          )}
          {canTask && (
            <button
              type="button"
              className="msg-menu-item"
              onClick={() => {
                setMenu(null);
                onCreateTask(msg.seq);
              }}
            >
              {t("MessageCard.menu.task")}
            </button>
          )}
          {canRetract && (
            <button
              type="button"
              className="msg-menu-item msg-menu-item--danger"
              onClick={() => {
                setMenu(null);
                onRetract(msg.seq);
              }}
            >
              {t("MessageCard.menu.retract")}
            </button>
          )}
          <button type="button" className="msg-menu-item" onClick={copyText}>
            {t("MessageCard.menu.copy")}
          </button>
        </div>
      )}
      {artifact !== undefined && (
        <div className="msg-completion" aria-label="completion artifact">
          {artifactBits.join(" · ")}
        </div>
      )}
      {review !== undefined && (
        <div className={`msg-review-detail msg-review-detail--${review.state}`} title={reviewTitleText}>
          {[
            review.state === "pending_review"
              ? `review pending · policy ${review.policy}`
              : `${review.state} by ${review.reviewer?.name ?? "reviewer"}`,
            review.reviewed_at ? fmtTime(review.reviewed_at) : null,
            review.replaces_seq ? `replaces #${review.replaces_seq}` : null,
            review.replaced_by_seq ? `replaced by #${review.replaced_by_seq}` : null,
            review.reason ? `reason: ${review.reason}` : null,
          ].filter((part): part is string => part !== null).join(" · ")}
        </div>
      )}
      {decision !== undefined && !msg.retracted && (
        <div className={`msg-decision msg-decision--${decisionState}`} aria-label="decision request">
          <div className="msg-decision-prompt">{decision.prompt}</div>
          {decisionPending && canRespondDecision === true && onDecisionRespond !== undefined ? (
            <div className="msg-decision-options">
              {decision.kind === "approval" ? (
                <>
                  <button
                    type="button"
                    className="d-btn d-btn--primary msg-decision-opt"
                    disabled={decisionBusy === true}
                    onClick={() => onDecisionRespond(msg.seq, { action: "approve" })}
                  >
                    {t("MessageCard.decision.approve")}
                  </button>
                  <button
                    type="button"
                    className="d-btn msg-decision-opt msg-decision-opt--reject"
                    disabled={decisionBusy === true}
                    aria-expanded={decisionRejecting}
                    onClick={() => setDecisionRejecting(true)}
                  >
                    {t("MessageCard.decision.reject")}
                  </button>
                </>
              ) : (
                decision.options.map((opt, i) => (
                  <button
                    key={`${i}-${opt}`}
                    type="button"
                    className="d-btn msg-decision-opt"
                    disabled={decisionBusy === true}
                    onClick={() => onDecisionRespond(msg.seq, { option: i })}
                  >
                    {i + 1}. {opt}
                  </button>
                ))
              )}
            </div>
          ) : decisionPending ? (
            <div className="msg-decision-status">
              {t("MessageCard.decision.awaiting")}
              {decision.kind === "choice" ? ` · ${decision.options.map((opt, i) => `${i + 1}. ${opt}`).join(" · ")}` : ""}
            </div>
          ) : (
            <div className="msg-decision-status msg-decision-status--resolved">
              {t(resolution?.state === "auto_resolved" ? "MessageCard.decision.autoResolved" : "MessageCard.decision.resolved", {
                option: resolution?.chosen_option ?? "?",
              })}
              {resolution?.responder ? ` · ${resolution.responder.name}` : ""}
              {resolution?.reason ? ` · ${resolution.reason}` : ""}
            </div>
          )}
          {decisionPending && decisionRejecting && canRespondDecision === true && onDecisionRespond !== undefined && (
            <div className="task-new-form msg-decision-reject-form">
              <textarea
                className="task-new-desc msg-decision-reject-reason"
                aria-label={t("Channel.decision.rejectPrompt")}
                placeholder={t("Channel.decision.rejectPrompt")}
                rows={3}
                autoFocus
                disabled={decisionBusy === true}
                value={decisionRejectDraft}
                onChange={(event) => setDecisionRejectDraft(event.currentTarget.value)}
              />
              <div className="task-new-actions">
                <button
                  type="button"
                  className="task-action-btn msg-decision-reject-confirm"
                  disabled={decisionBusy === true}
                  onClick={() => {
                    const reason = decisionRejectDraft.trim();
                    onDecisionRespond(msg.seq, { action: "reject", ...(reason === "" ? {} : { reason }) });
                    setDecisionRejecting(false);
                    setDecisionRejectDraft("");
                  }}
                >
                  {t("Channel.reject.confirm")}
                </button>
                <button
                  type="button"
                  className="task-action-btn msg-decision-reject-cancel"
                  disabled={decisionBusy === true}
                  onClick={() => { setDecisionRejecting(false); setDecisionRejectDraft(""); }}
                >
                  {t("Channel.reject.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {editing ? (
        <div className="msg-edit">
          <textarea
            className="msg-edit-input t-mono"
            rows={4}
            value={editDraft}
            onChange={(event) => onEditDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                if (!editSaving) onEditCancel();
                return;
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (!saveDisabled) onEditSave();
              }
            }}
          />
          <div className="msg-edit-actions">
            <button type="button" className="d-btn d-btn--primary" disabled={saveDisabled} onClick={onEditSave}>
              {editSaving ? t("MessageCard.edit.saving") : t("MessageCard.edit.save")}
            </button>
            <button type="button" className="d-btn" disabled={editSaving} onClick={onEditCancel}>
              {t("MessageCard.edit.cancel")}
            </button>
          </div>
          {actionError !== null && <p className="banner banner--red msg-action-error">{actionError}</p>}
        </div>
      ) : msg.retracted ? (
        <p className="msg-retracted">{t("MessageCard.retracted")}</p>
      ) : (
        <Markdown source={msg.body} identities={identityDisplay} />
      )}
      {!editing && !msg.retracted && msg.attachments !== undefined && msg.attachments.length > 0 && (
        <AttachmentList attachments={msg.attachments} />
      )}
      {!editing && actionError !== null && <p className="banner banner--red msg-action-error">{actionError}</p>}
    </article>
  );
}

export const MessageCard = memo(MessageCardImpl);
