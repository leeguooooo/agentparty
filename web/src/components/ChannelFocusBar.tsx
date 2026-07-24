// 频道常驻焦点栏（#682）：进频道第一屏就看到「球在谁手里、在等谁、谁在等我」，不用往回翻几十条。
// 纯渲染视图——数据全来自已有的 presence + 任务台账 + 未闭合决策（见 lib/channelFocus），
// 就地更新、不产生 seq、不发帧（不重蹈 #675 刷屏）。三态用不同颜色/图标区分，stalled 单列第四态
// 提示「可能停滞」而非谎报在做（#665）。栏空（无在途项且无 override）时不渲染，不占屏。
//
// 布局（用户反馈：初版全宽带边框卡片顶成了头部第三条）：改成折进 presence-head 的一条紧凑内联行
// ——同一行横排小 chip、无卡片描边，头部回到 2 条（presence + 工具条）。三态语气色/图标、「在等你」
// 珊瑚红高亮、下钻回调全部保留，只是从纵向堆叠卡片压成横向内联。
import { useT } from "../i18n/useT";
import "../i18n/strings/ChannelFocusBar";
import type { ChannelFocus, FocusItem, FocusItemState } from "../lib/channelFocus";
import type { PendingDecisionLoadState } from "../lib/pendingDecisions";

// 三态（+stalled）→ 图标/CSS 修饰。owner 扫「等人拍板」，用醒目 ◆；被卡 ■；在做 ●；停滞 ◌（空心=不确定还活着）。
const STATE_ICON: Record<FocusItemState, string> = {
  waiting_decision: "◆",
  blocked: "■",
  working: "●",
  stalled: "◌",
};

function stateLabel(item: FocusItem, t: ReturnType<typeof useT>): string {
  if (item.state === "blocked" && item.blockedOn !== null) {
    return t("ChannelFocusBar.state.blockedOn", { reason: item.blockedOn });
  }
  return t(`ChannelFocusBar.state.${item.state}`);
}

function pendingDecisionStatusKey(
  state: PendingDecisionLoadState,
): string | null {
  const hasData = state.lastSuccessfulData !== null;
  if (state.error !== null) {
    if (state.error.kind === "forbidden") return "ChannelFocusBar.decisions.forbidden";
    if (hasData) return "ChannelFocusBar.decisions.refreshFailed";
    return "ChannelFocusBar.decisions.loadFailed";
  }
  if (!state.loading) return null;
  return hasData
    ? "ChannelFocusBar.decisions.refreshing"
    : "ChannelFocusBar.decisions.loading";
}

export function PendingDecisionLoadNotice({
  state,
  onRetry,
  onOpenOverview,
  compact = false,
}: {
  state: PendingDecisionLoadState;
  onRetry?: () => void;
  onOpenOverview?: () => void;
  compact?: boolean;
}) {
  const t = useT();
  const statusKey = pendingDecisionStatusKey(state);
  if (statusKey === null) return null;
  const text = t(statusKey);
  return (
    <span
      className={compact ? "t-mono focus-decision-load" : "banner banner--yellow"}
      role={state.error === null ? "status" : "alert"}
      aria-live="polite"
      aria-busy={state.loading}
    >
      {onOpenOverview === undefined ? (
        <span>{text}</span>
      ) : (
        <button type="button" className="focus-decision-load-open" onClick={onOpenOverview}>
          {text}
        </button>
      )}
      {state.error !== null && state.error.kind !== "forbidden" && onRetry !== undefined && (
        <>
          {" "}
          <button type="button" className="d-btn focus-decision-retry" onClick={onRetry}>
            {t("ChannelFocusBar.decisions.retry")}
          </button>
        </>
      )}
    </span>
  );
}

export function ChannelFocusBar({
  focus,
  decisionState,
  viewerIsModerator = false,
  onOpenTask,
  onJumpSeq,
  onOpenOverview,
  onRetryDecisions,
}: {
  focus: ChannelFocus;
  decisionState?: PendingDecisionLoadState;
  /** owner/moderator 视角：把「在等你」文案换成「等你拍板」，更贴 owner 最关心的那一类。 */
  viewerIsModerator?: boolean;
  /** 下钻：点 task 派生项 → 打开任务台账（可定位到该 id）。 */
  onOpenTask?: (taskId: number) => void;
  /** 下钻：点 decision 派生项 → 跳到对应消息。 */
  onJumpSeq?: (seq: number) => void;
  /** 汇总与 +N 进入完整焦点清单；不能把混合的 decision/presence 误送到任务台账。 */
  onOpenOverview?: () => void;
  /** 权威 pending-decision 请求失败后保留当前上下文并原地重试。 */
  onRetryDecisions?: () => void;
}) {
  const t = useT();
  const showDecisionLoadState = decisionState !== undefined
    && (decisionState.loading || decisionState.error !== null);
  // 无 override 焦点 + 无任何在途项 = 什么都不显示（issue：nothing in flight → 不渲染）。
  if (focus.empty && focus.focus === null && !showDecisionLoadState) return null;

  const drill = (item: FocusItem): (() => void) | undefined => {
    if (item.taskId !== null && onOpenTask !== undefined) return () => onOpenTask(item.taskId!);
    if (item.seq !== null && onJumpSeq !== undefined) return () => onJumpSeq(item.seq!);
    return undefined;
  };
  const drillTitle = (item: FocusItem): string | undefined => {
    if (item.taskId !== null) return t("ChannelFocusBar.openTask", { id: item.taskId });
    if (item.seq !== null) return t("ChannelFocusBar.openDecision", { seq: item.seq });
    return undefined;
  };

  const meLabel = viewerIsModerator ? t("ChannelFocusBar.waitingOnMeOwner") : t("ChannelFocusBar.waitingOnMe");

  const renderItem = (item: FocusItem) => {
    const onClick = drill(item);
    const title = drillTitle(item);
    const cls =
      `focus-item focus-item--${item.state}` +
      (item.waitingOnMe ? " focus-item--me" : "") +
      (onClick !== undefined ? " focus-item--drill" : "");
    // 紧凑内联：dot + 名字 + 状态标签（stalled 才带 hint），标题/note 收进 title 悬停，避免撑长头部。
    const body = (
      <>
        <span className={`focus-dot focus-dot--${item.state}`} aria-hidden="true">{STATE_ICON[item.state]}</span>
        <span className="focus-item-name">{item.name}</span>
        <span
          className={`focus-item-state focus-item-state--${item.state}`}
          title={item.state === "stalled" ? t("ChannelFocusBar.stalledHint") : undefined}
        >
          {stateLabel(item, t)}
        </span>
      </>
    );
    const chipTitle = [item.name, stateLabel(item, t), item.label !== item.name ? item.label : null]
      .filter((part): part is string => part !== null)
      .join(" · ");
    if (onClick !== undefined) {
      return (
        <li key={item.key} className={cls} title={chipTitle}>
          <button type="button" className="focus-item-btn" onClick={onClick} title={title}>{body}</button>
        </li>
      );
    }
    return <li key={item.key} className={cls} title={chipTitle}>{body}</li>;
  };

  // 硬两行、永不折（用户反馈）：内联只展开 owner 最关心的「在等你」高亮 chip，且封顶两个；其余全部
  // 状态压成一个定宽小计数丸 ●3 ■1 ◆1 ◌1，点开进完整焦点清单。这样再忙再窄也不会把可见性开关挤下行。
  const WAITING_CAP = 2;
  const waitingShown = focus.waitingOnMe.slice(0, WAITING_CAP);
  const waitingOverflow = focus.waitingOnMe.length - waitingShown.length;
  const openOverview = onOpenOverview;

  // 计数丸的分段：非零状态才列，各自带本态语气色圆点，保留「三态视觉可区分」的原契约（#682）。
  const countSegments = ([
    ["working", focus.counts.working],
    ["blocked", focus.counts.blocked],
    ["waiting_decision", focus.counts.waitingDecision],
    ["stalled", focus.counts.stalled],
  ] as const).filter(([, n]) => n > 0);
  const countsTitle = t("ChannelFocusBar.counts", {
    working: focus.counts.working,
    blocked: focus.counts.blocked,
    decision: focus.counts.waitingDecision,
    stalled: focus.counts.stalled,
  });

  return (
    <div className="focus-inline" aria-label={t("ChannelFocusBar.aria")}>
      <span className="t-mono focus-heading">{t("ChannelFocusBar.heading")}</span>
      {focus.focus !== null && <span className="focus-line" title={focus.focus}>{focus.focus}</span>}
      {decisionState !== undefined && (
        <PendingDecisionLoadNotice
          state={decisionState}
          onRetry={onRetryDecisions}
          onOpenOverview={onOpenOverview}
          compact
        />
      )}

      {focus.waitingOnMe.length > 0 && (
        <span className="focus-me" role="group" aria-label={meLabel}>
          <span className="t-mono focus-me-label">{meLabel}</span>
          <ul className="focus-list focus-list--me">
            {waitingShown.map((item) => renderItem(item))}
          </ul>
          {waitingOverflow > 0 && (
            openOverview !== undefined ? (
              <button type="button" className="t-mono focus-more" onClick={openOverview} title={countsTitle}>
                +{waitingOverflow}
              </button>
            ) : (
              <span className="t-mono focus-more" title={countsTitle}>+{waitingOverflow}</span>
            )
          )}
        </span>
      )}

      {countSegments.length > 0 && (
        openOverview !== undefined ? (
          <button type="button" className="t-mono focus-counts focus-counts--btn" onClick={openOverview} title={countsTitle}>
            {countSegments.map(([state, n]) => (
              <span key={state} className={`focus-count focus-count--${state}`}>
                <span className={`focus-dot focus-dot--${state}`} aria-hidden="true">{STATE_ICON[state]}</span>
                {n}
              </span>
            ))}
          </button>
        ) : (
          <span className="t-mono focus-counts" title={countsTitle}>
            {countSegments.map(([state, n]) => (
              <span key={state} className={`focus-count focus-count--${state}`}>
                <span className={`focus-dot focus-dot--${state}`} aria-hidden="true">{STATE_ICON[state]}</span>
                {n}
              </span>
            ))}
          </span>
        )
      )}
    </div>
  );
}
