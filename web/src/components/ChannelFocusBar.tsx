// 频道常驻焦点栏（#682）：进频道第一屏就看到「球在谁手里、在等谁、谁在等我」，不用往回翻几十条。
// 纯渲染视图——数据全来自已有的 presence + 任务台账 + 未闭合决策（见 lib/channelFocus），
// 就地更新、不产生 seq、不发帧（不重蹈 #675 刷屏）。三态用不同颜色/图标区分，stalled 单列第四态
// 提示「可能停滞」而非谎报在做（#665）。栏空（无在途项且无 override）时不渲染，不占屏。
import { useT } from "../i18n/useT";
import "../i18n/strings/ChannelFocusBar";
import type { ChannelFocus, FocusItem, FocusItemState } from "../lib/channelFocus";

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

export function ChannelFocusBar({
  focus,
  viewerIsModerator = false,
  onOpenTask,
  onJumpSeq,
}: {
  focus: ChannelFocus;
  /** owner/moderator 视角：把「在等你」文案换成「等你拍板」，更贴 owner 最关心的那一类。 */
  viewerIsModerator?: boolean;
  /** 下钻：点 task 派生项 → 打开任务台账（可定位到该 id）。 */
  onOpenTask?: (taskId: number) => void;
  /** 下钻：点 decision 派生项 → 跳到对应消息。 */
  onJumpSeq?: (seq: number) => void;
}) {
  const t = useT();
  // 无 override 焦点 + 无任何在途项 = 什么都不显示（issue：nothing in flight → 不渲染）。
  if (focus.empty && focus.focus === null) return null;

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

  const renderItem = (item: FocusItem, opts: { me?: boolean } = {}) => {
    const onClick = drill(item);
    const title = drillTitle(item);
    const cls =
      `focus-item focus-item--${item.state}` +
      (item.waitingOnMe ? " focus-item--me" : "") +
      (onClick !== undefined ? " focus-item--drill" : "");
    const body = (
      <>
        <span className={`focus-dot focus-dot--${item.state}`} aria-hidden="true">{STATE_ICON[item.state]}</span>
        <span className="focus-item-name">{item.name}</span>
        <span className="focus-item-label" title={item.label}>{item.label}</span>
        <span className={`focus-item-state focus-item-state--${item.state}`} title={item.state === "stalled" ? t("ChannelFocusBar.stalledHint") : undefined}>
          {stateLabel(item, t)}
        </span>
        {opts.me === true && <span className="focus-item-me-badge t-mono">{meLabel}</span>}
      </>
    );
    if (onClick !== undefined) {
      return (
        <li key={item.key} className={cls}>
          <button type="button" className="focus-item-btn" onClick={onClick} title={title}>{body}</button>
        </li>
      );
    }
    return <li key={item.key} className={cls}>{body}</li>;
  };

  return (
    <section className="channel-focus-bar" aria-label={t("ChannelFocusBar.aria")}>
      <header className="focus-head">
        <span className="t-mono focus-heading">{t("ChannelFocusBar.heading")}</span>
        {focus.focus !== null && <span className="focus-line">{focus.focus}</span>}
        <span className="t-mono focus-counts" aria-hidden="true">
          {t("ChannelFocusBar.counts", {
            working: focus.counts.working,
            blocked: focus.counts.blocked,
            decision: focus.counts.waitingDecision,
            stalled: focus.counts.stalled,
          })}
        </span>
      </header>

      {focus.waitingOnMe.length > 0 && (
        <div className="focus-me" role="group" aria-label={meLabel}>
          <span className="t-mono focus-me-label">{meLabel}</span>
          <ul className="focus-list focus-list--me">
            {focus.waitingOnMe.map((item) => renderItem(item, { me: false }))}
          </ul>
        </div>
      )}

      {focus.items.length > 0 && (
        <>
          <span className="t-mono focus-waiting-label">{t("ChannelFocusBar.waitingOn")}</span>
          <ul className="focus-list">
            {focus.items.map((item) => renderItem(item))}
          </ul>
        </>
      )}
    </section>
  );
}
