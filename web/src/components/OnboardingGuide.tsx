// 首次进入的 1-2-3-4 引导浮层（#146）。只在浏览器第一次进来时出现，关掉后落一个
// localStorage 标记（复用 ap_locale 那套持久化模式，不造新机制），之后不再打扰。
// 范围克制：一张可关闭的四步卡片，讲清「加入频道 → @唤醒 → 认领任务 → 提交」主线。
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/Onboarding";

const STORAGE_KEY = "ap_onboarded";

function alreadyOnboarded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // localStorage 不可用（隐私模式等）→ 当作没引导过：本次会话显示一次，只是刷新不记
    return false;
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // 静默：写不进就本次会话内关掉，不炸 UI
  }
}

const STEP_KEYS = ["step1", "step2", "step3", "step4"] as const;

export function OnboardingGuide({
  forceOpen = false,
  onClose,
  returnFocusRef,
}: {
  forceOpen?: boolean;
  onClose?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  // 「是否首次进入」判定：读 localStorage 标记。改这里（比如恒为 false）会让首次显示的测试红。
  const [open, setOpen] = useState(() => !alreadyOnboarded());
  const visible = forceOpen || open;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const dismiss = useCallback(() => {
    markOnboarded();
    setOpen(false);
    onCloseRef.current?.();
  }, []);

  // 与其它模态一致：显式接管焦点、困住 Tab、Esc 关闭，并在退出后还给来源控件。
  useEffect(() => {
    if (!visible) return;
    const doc = typeof document === "undefined" ? null : document;
    const previouslyFocused = (doc?.activeElement ?? null) as HTMLElement | null;
    const focusables = (): HTMLElement[] => {
      const card = cardRef.current;
      if (card === null || typeof card.querySelectorAll !== "function") return [];
      return Array.from(
        card.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.tabIndex >= 0);
    };

    (closeRef.current ?? focusables()[0] ?? cardRef.current)?.focus?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      const card = cardRef.current;
      if (items.length === 0) {
        e.preventDefault();
        card?.focus?.();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = (doc?.activeElement ?? null) as HTMLElement | null;
      if (e.shiftKey && (active === first || active === card)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const explicitTarget = returnFocusRef?.current;
      if (explicitTarget !== null && explicitTarget !== undefined && explicitTarget.isConnected !== false) {
        explicitTarget.focus?.();
      } else if (previouslyFocused?.isConnected !== false) {
        previouslyFocused?.focus?.();
      }
    };
  }, [dismiss, returnFocusRef, visible]);

  if (!visible) return null;

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding-backdrop" onClick={dismiss} aria-hidden="true" />
      <div className="d-card onboarding-card" ref={cardRef} tabIndex={-1}>
        <button
          ref={closeRef}
          type="button"
          className="d-btn onboarding-close"
          onClick={dismiss}
          aria-label={t("Onboarding.close")}
        >
          ✕
        </button>
        <h2 className="d-title onboarding-title" id="onboarding-title">
          {t("Onboarding.title")}
        </h2>
        <p className="d-hand onboarding-subtitle">{t("Onboarding.subtitle")}</p>
        <ol className="onboarding-steps">
          {STEP_KEYS.map((key, i) => (
            <li className="onboarding-step" key={key}>
              <span className="onboarding-step-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="onboarding-step-body">
                <strong className="onboarding-step-title">{t(`Onboarding.${key}.title`)}</strong>
                <span className="onboarding-step-desc t-mono">{t(`Onboarding.${key}.desc`)}</span>
              </span>
            </li>
          ))}
        </ol>
        <button type="button" className="d-btn onboarding-dismiss" onClick={dismiss}>
          {t("Onboarding.dismiss")}
        </button>
      </div>
    </div>
  );
}
