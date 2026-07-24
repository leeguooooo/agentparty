import type { ChannelFocus, FocusItem } from "../lib/channelFocus";
import type { PendingDecisionLoadState } from "../lib/pendingDecisions";
import { useT } from "../i18n/useT";
import "../i18n/strings/ChannelFocusBar";
import { PendingDecisionLoadNotice } from "./ChannelFocusBar";

function itemState(item: FocusItem, t: ReturnType<typeof useT>): string {
  if (item.state === "blocked" && item.blockedOn !== null) {
    return t("ChannelFocusBar.state.blockedOn", { reason: item.blockedOn });
  }
  return t(`ChannelFocusBar.state.${item.state}`);
}

export function ChannelFocusPanel({
  focus,
  decisionState,
  jumpError = null,
  onOpenTask,
  onJumpSeq,
  onRetryDecisions,
}: {
  focus: ChannelFocus;
  decisionState?: PendingDecisionLoadState;
  jumpError?: string | null;
  onOpenTask: (taskId: number) => void;
  onJumpSeq: (seq: number) => void;
  onRetryDecisions?: () => void;
}) {
  const t = useT();
  const actionFor = (item: FocusItem): { label: string; run: () => void } | null => {
    if (item.taskId !== null) {
      return {
        label: t("ChannelFocusBar.openTask", { id: item.taskId }),
        run: () => onOpenTask(item.taskId!),
      };
    }
    if (item.seq !== null) {
      return {
        label: t("ChannelFocusBar.openDecision", { seq: item.seq }),
        run: () => onJumpSeq(item.seq!),
      };
    }
    return null;
  };

  return (
    <section className="focus-overview" aria-label={t("ChannelFocusBar.overviewAria")}>
      {decisionState !== undefined && (
        <PendingDecisionLoadNotice state={decisionState} onRetry={onRetryDecisions} />
      )}
      {jumpError !== null && (
        <p className="banner banner--yellow" role="alert">{jumpError}</p>
      )}
      {focus.focus !== null && (
        <p className="focus-overview-manual">
          <span className="t-mono">{t("ChannelFocusBar.focusManual")}</span>
          {focus.focus}
        </p>
      )}
      {focus.items.length === 0 && (
        decisionState === undefined || decisionState.lastSuccessfulData !== null
      ) ? (
        <p className="d-empty">{t("ChannelFocusBar.overviewEmpty")}</p>
      ) : (
        <ol className="focus-overview-list">
          {focus.items.map((item) => {
            const action = actionFor(item);
            return (
              <li key={item.key} className={`focus-overview-item focus-overview-item--${item.state}`}>
                <div className="focus-overview-main">
                  <strong>{item.name}</strong>
                  <span className={`t-mono focus-item-state focus-item-state--${item.state}`}>
                    {itemState(item, t)}
                  </span>
                  {item.waitingOnMe && (
                    <span className="t-mono focus-overview-waiting">
                      {t("ChannelFocusBar.waitingOnMe")}
                    </span>
                  )}
                </div>
                <p>{item.label}</p>
                {action !== null && (
                  <button type="button" className="d-btn" onClick={action.run}>
                    {action.label}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
