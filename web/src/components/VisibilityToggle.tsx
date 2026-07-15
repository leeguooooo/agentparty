// 频道可见性切换（issue #38 web；#381 加第三档 public_watch）。三档单选：private / public_watch / public。
// private→(public|public_watch) 服务端要二段确认（会把历史暴露给任何观看者），这里用 409 needs_confirm 弹确认条。
// 只对可写人类会话（moderator）渲染，最终由服务端强制 owner 校验（非 owner → 403，内联报错）。
import { useState } from "react";
import { AuthError, ForbiddenError, setChannelVisibility, type Visibility } from "../lib/api";
import { useT } from "../i18n/useT";
import { FeatureTip } from "./FeatureTip";
import "../i18n/strings/VisibilityToggle";

interface Props {
  slug: string;
  token: string;
  visibility: Visibility;
  onChanged(next: Visibility): void;
  onAuthFailed(message: string): void;
}

const OPTIONS: readonly Visibility[] = ["private", "public_watch", "public"];
const BADGE: Record<Visibility, string> = { private: "PRIVATE", public_watch: "WATCH", public: "PUBLIC" };

export function VisibilityToggle({ slug, token, visibility, onChanged, onAuthFailed }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 待确认的目标档（private→公开/观看公开）：暂存待暴露的历史条数，用于确认条文案。
  const [confirm, setConfirm] = useState<{ target: Visibility; count: number } | null>(null);

  async function apply(target: Visibility, confirmed: boolean) {
    if (target === visibility) return;
    setBusy(true);
    setError(null);
    try {
      const r = await setChannelVisibility(token, slug, target, confirmed);
      if (r.needsConfirm) {
        setConfirm({ target, count: r.messageCount ?? 0 });
        return;
      }
      setConfirm(null);
      onChanged(target);
    } catch (e) {
      if (e instanceof AuthError) {
        onAuthFailed(e.message);
        return;
      }
      setError(e instanceof ForbiddenError ? e.message : e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vis-toggle">
      <span className={`vis-badge vis-badge--${visibility}`}>{BADGE[visibility]}</span>
      <div className="vis-seg" role="group" aria-label={t("Visibility.groupLabel")}>
        {OPTIONS.map((opt) => (
          <button
            key={opt}
            type="button"
            className={"vis-seg-btn" + (visibility === opt ? " is-on" : "")}
            disabled={busy || visibility === opt}
            aria-pressed={visibility === opt}
            onClick={() => apply(opt, false)}
            title={t(`Visibility.opt.${opt}.help`)}
          >
            {busy && confirm?.target === opt ? "…" : t(`Visibility.opt.${opt}`)}
          </button>
        ))}
      </div>
      <FeatureTip tip="Tips.visibility" />
      <p className="vis-help t-mono" title={t(`Visibility.opt.${visibility}.help`)}>
        {t(`Visibility.opt.${visibility}.help`)}
      </p>
      {confirm !== null && (
        <div className="vis-confirm" role="alertdialog" aria-label={t("Visibility.confirmDialogLabel")}>
          <span className="vis-confirm-text">
            {t(`Visibility.confirmText.${confirm.target}`, { count: confirm.count })}
          </span>
          <button
            type="button"
            className="d-btn d-btn--primary"
            disabled={busy}
            onClick={() => apply(confirm.target, true)}
          >
            {t("Visibility.confirmButton")}
          </button>
          <button type="button" className="d-btn" disabled={busy} onClick={() => setConfirm(null)}>
            {t("Visibility.cancel")}
          </button>
        </div>
      )}
      {error !== null && <span className="vis-error">{error}</span>}
    </div>
  );
}
