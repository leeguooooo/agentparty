// 全局设置只承载个人与设备设置。跨频道的本机 Agent 监控、启停、常驻和日志
// 已移到独立 LocalAgentCenter，避免打开偏好设置就启动多套本机 IPC/轮询。
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/useT";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { HandleSetup } from "./HandleSetup";
import {
  requestNotifySystemPermission,
  writeNotifyOptin,
} from "./NotifyToggle";
import {
  SectionedDialog,
  type SectionedDialogSection,
} from "./SectionedDialog";
import { applyTheme, readStoredTheme, SUPPORTED_THEMES, type Theme } from "../lib/theme";
import "../i18n/strings/App";

export interface SettingsMe {
  name: string;
  kind: string;
  role: string;
  handle: string | null;
  display_name: string | null;
  owner: string | null;
  email?: string | null;
  provider?: string | null;
}

export type SettingsSectionId = "preferences" | "account" | "desktop" | "help";

export function SettingsPanel({
  me,
  notifyOptin,
  canSetHandle = false,
  onClose,
  onLogout,
  onNotifyOptinChange,
  onHandleSaved,
  onShowOnboarding,
  desktopAppSettings = null,
  initialSection = "preferences",
  restoreFocusOnUnmount = true,
}: {
  me: SettingsMe | null;
  notifyOptin: boolean;
  canSetHandle?: boolean;
  onClose: () => void;
  onLogout: (() => void) | null;
  onNotifyOptinChange: (value: boolean) => void;
  onHandleSaved?: (value: string) => void;
  onShowOnboarding?: () => void;
  desktopAppSettings?: ReactNode;
  initialSection?: SettingsSectionId;
  restoreFocusOnUnmount?: boolean;
}) {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [notifyHint, setNotifyHint] = useState<string | null>(null);
  const notifyRequestRef = useRef(0);

  const pickTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setTheme(next);
  }, []);

  const toggleNotify = useCallback(() => {
    const next = !notifyOptin;
    const requestId = ++notifyRequestRef.current;
    setNotifyHint(null);
    writeNotifyOptin(next);
    onNotifyOptinChange(next);
    if (next) {
      void requestNotifySystemPermission().then((granted) => {
        if (requestId === notifyRequestRef.current && !granted) {
          setNotifyHint(t("App.settings.notify.inAppOnly"));
        }
      });
    }
  }, [notifyOptin, onNotifyOptinChange, t]);

  const sections: SectionedDialogSection<SettingsSectionId>[] = [
    {
      id: "preferences",
      label: t("App.settings.section.preferences"),
      content: (
        <>
          <h3 className="settings-module-title">{t("App.settings.section.preferences")}</h3>
          <section className="settings-section">
            <div className="settings-label">{t("App.settings.language")}</div>
            <LanguageSwitcher />
          </section>

          <section className="settings-section">
            <div className="settings-label">{t("App.settings.theme")}</div>
            <div className="settings-theme" role="group" aria-label={t("App.settings.theme")}>
              {SUPPORTED_THEMES.map((option) => (
                <button
                  key={option.code}
                  type="button"
                  data-theme-code={option.code}
                  className={"settings-theme-btn" + (option.code === theme ? " is-active" : "")}
                  aria-pressed={option.code === theme}
                  onClick={() => pickTheme(option.code)}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-label">{t("App.settings.notifications")}</div>
            <button
              type="button"
              className={"settings-toggle" + (notifyOptin ? " is-on" : "")}
              aria-pressed={notifyOptin}
              onClick={toggleNotify}
            >
              <span className="settings-toggle-dot" aria-hidden="true" />
              {notifyOptin ? t("App.settings.notify.on") : t("App.settings.notify.off")}
            </button>
            <p className="settings-hint">{t("App.settings.notify.hint")}</p>
            {notifyHint !== null && (
              <p className="settings-hint" role="status">{notifyHint}</p>
            )}
          </section>
        </>
      ),
    },
  ];

  if (me !== null) {
    sections.push({
      id: "account",
      label: t("App.settings.section.account"),
      content: (
        <>
          <h3 className="settings-module-title">{t("App.settings.section.account")}</h3>
          <section className="settings-section">
            <div className="settings-account">
              <span className="settings-account-name">{me.display_name ?? me.handle ?? me.name}</span>
              <span className={`settings-account-chip settings-account-chip--${me.kind}`}>{me.kind}</span>
              {me.role !== me.kind && <span className="settings-account-chip">{me.role}</span>}
            </div>
            {me.owner !== null && me.owner !== me.name && (
              <p className="settings-hint">owner: {me.owner}</p>
            )}
            {(me.email != null || me.provider != null) && (
              <dl className="settings-facts">
                {me.email != null && (
                  <div><dt>{t("App.settings.email")}</dt><dd>{me.email}</dd></div>
                )}
                {me.provider != null && (
                  <div><dt>{t("App.settings.provider")}</dt><dd>{me.provider}</dd></div>
                )}
              </dl>
            )}
            {canSetHandle && (
              <div className="settings-handle">
                <HandleSetup
                  current={me.handle}
                  mode={me.kind === "agent" ? "nickname" : "handle"}
                  onSaved={(value) => onHandleSaved?.(value)}
                />
              </div>
            )}
            {onLogout !== null && (
              <button type="button" className="settings-logout" onClick={onLogout}>
                {t("App.settings.logout")}
              </button>
            )}
          </section>
        </>
      ),
    });
  }

  if (desktopAppSettings !== null) {
    sections.push({
      id: "desktop",
      label: t("App.settings.section.desktop"),
      content: desktopAppSettings,
    });
  }

  if (onShowOnboarding !== undefined) {
    sections.push({
      id: "help",
      label: t("App.settings.section.help"),
      content: (
        <>
          <h3 className="settings-module-title">{t("App.settings.section.help")}</h3>
          <section className="settings-section">
            <button type="button" className="d-btn settings-onboarding" onClick={onShowOnboarding}>
              {t("App.settings.onboarding")}
            </button>
          </section>
        </>
      ),
    });
  }

  return (
    <SectionedDialog
      idPrefix="global-settings"
      title={t("App.settings.title")}
      closeLabel={t("App.settings.close")}
      navigationLabel={t("App.settings.navigation")}
      sections={sections}
      initialSection={initialSection}
      onClose={onClose}
      restoreFocusOnUnmount={restoreFocusOnUnmount}
    />
  );
}
