// 被@浏览器通知的铃铛开关（Task C2）。opt-in 是全局设置（跨频道生效），落 localStorage；
// 真正的“要不要弹”判定在纯函数 shouldNotify（lib/notify.ts）里，本组件只管开关本身：
// 读/写 opt-in、申请浏览器通知权限、把结果上报给持有 optin state 的应用 header。
import { useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { FeatureTip } from "./FeatureTip";
import { isDesktopRuntime, requestDesktopNotificationPermission } from "../lib/desktopRuntime";
import "../i18n/strings/Channel";

const OPTIN_KEY = "ap_notify_optin";

export function readNotifyOptin(): boolean {
  try {
    return localStorage.getItem(OPTIN_KEY) === "1";
  } catch {
    return false; // 私有模式等场景 localStorage 不可用时，默认关闭（不静默弹通知）
  }
}

export function writeNotifyOptin(on: boolean) {
  try {
    localStorage.setItem(OPTIN_KEY, on ? "1" : "0");
  } catch {
    // 写入失败不阻断本次切换，只是刷新/换标签页后会回落到默认关闭
  }
}

/**
 * One permission path for every notification preference surface.
 * The preference remains enabled when system permission is unavailable because
 * in-app mention toasts do not require that permission.
 */
export async function requestNotifySystemPermission(): Promise<boolean> {
  if (isDesktopRuntime()) {
    return (await requestDesktopNotificationPermission()) === "granted";
  }
  if (typeof window === "undefined" || !("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

interface Props {
  optin: boolean;
  onChange(next: boolean): void;
}

export function NotifyToggle({ optin, onChange }: Props) {
  const t = useT();
  const [hint, setHint] = useState<string | null>(null);
  const requestRef = useRef(0);

  const toggle = () => {
    const requestId = ++requestRef.current;
    setHint(null);
    if (optin) {
      // 关闭：立即生效
      writeNotifyOptin(false);
      onChange(false);
      return;
    }
    // 开启：立即生效——页内 toast 不需要浏览器授权，铃铛先开起来
    writeNotifyOptin(true);
    onChange(true);
    // 系统通知只是额外能力；拒绝/不支持不回滚页内通知，只提示降级。
    void requestNotifySystemPermission().then((granted) => {
      if (requestId === requestRef.current && !granted) setHint(t("Channel.notify.inAppOnly"));
    });
  };

  return (
    <span className="notify-toggle">
      <button
        type="button"
        className={"d-btn notify-toggle-btn" + (optin ? " is-active" : "")}
        onClick={toggle}
        aria-pressed={optin}
        aria-label={optin ? t("Channel.notify.onTitle") : t("Channel.notify.offTitle")}
        title={optin ? t("Channel.notify.onTitle") : t("Channel.notify.offTitle")}
      >
        <span className={`ap-sprite ${optin ? "ap-sprite--bell-on" : "ap-sprite--bell-off"}`} aria-hidden="true" />
      </button>
      <FeatureTip tip="Tips.notify" />
      {hint !== null && <span className="notify-toggle-hint t-mono">{hint}</span>}
    </span>
  );
}
