// 被@浏览器通知的铃铛开关（Task C2）。opt-in 是全局设置（跨频道生效），落 localStorage；
// 真正的“要不要弹”判定在纯函数 shouldNotify（lib/notify.ts）里，本组件只管开关本身：
// 读/写 opt-in、申请浏览器通知权限、把结果上报给持有 optin state 的父组件（ChannelPage）。
import { useState } from "react";
import { useT } from "../i18n/useT";
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

function writeNotifyOptin(on: boolean) {
  try {
    localStorage.setItem(OPTIN_KEY, on ? "1" : "0");
  } catch {
    // 写入失败不阻断本次切换，只是刷新/换标签页后会回落到默认关闭
  }
}

interface Props {
  optin: boolean;
  onChange(next: boolean): void;
}

export function NotifyToggle({ optin, onChange }: Props) {
  const t = useT();
  const [hint, setHint] = useState<string | null>(null);
  const desktop = isDesktopRuntime();
  const supported = desktop || (typeof window !== "undefined" && "Notification" in window);

  const toggle = () => {
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
    // 额外能力：切走标签时的系统通知需要浏览器授权，best-effort 申请；拒绝/不支持不回滚 optin，只提示
    if (!supported) {
      setHint(t("Channel.notify.inAppOnly"));
      return;
    }
    if (desktop) {
      void requestDesktopNotificationPermission().then((permission) => {
        if (permission !== "granted") setHint(t("Channel.notify.inAppOnly"));
      });
      return;
    }
    if (Notification.permission === "granted") return;
    if (Notification.permission === "denied") {
      setHint(t("Channel.notify.inAppOnly"));
      return;
    }
    void Notification.requestPermission().then((permission) => {
      if (permission !== "granted") setHint(t("Channel.notify.inAppOnly"));
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
      {hint !== null && <span className="notify-toggle-hint t-mono">{hint}</span>}
    </span>
  );
}
