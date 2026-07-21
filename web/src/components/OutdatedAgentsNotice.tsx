// #662：owner 进入/刷新页面时主动汇总——列出自己名下跑着过时 CLI 的 agent，引导用接入包升级。
// 与 MessageCard 的单条被动徽标（msg-client-version--outdated）互补：那是「某条消息发送时的快照」，
// 这里是 presence 级、owner 视角的一次性提醒，落点是「重跑接入包 = 重装最新 CLI」。
//
// 判定复用 lib/clientVersion（isClientVersionOutdated / useMinClientVersion），不另写版本比较，
// 三端口径一致；min 未知（离线/拿不到 /api/version）一律不渲染（沿用「未知不误报」原则）。
import { useMemo, useState } from "react";
import type { PresenceEntry } from "@agentparty/shared";
import { isClientVersionOutdated, useMinClientVersion } from "../lib/clientVersion";
import { useT } from "../i18n/useT";
import "../i18n/strings/OutdatedAgentsNotice";

interface OutdatedAgent {
  name: string;
  label: string;
  version: string;
}

interface Props {
  // 频道 presence（按 name 索引），每个 agent 最近一次 hello 上报的 client_version 随之下发。
  presence: Record<string, PresenceEntry>;
  // 当前登录身份的账号锚点（App 传入的 accountKey）；agent 的 account 与其 owner 同源，据此筛「我名下的」。
  accountKey: string | null;
  // 「用接入包升级」CTA：打开 AgentJoin 接入面板（复用现有 join-pack 生成流程）。
  onUpgrade?: (agentName: string) => void;
  // 测试注入用：覆盖 useMinClientVersion() 的结果（bun react-test-renderer 无 window，hook 恒 null）。
  minVersion?: string | null;
}

// 过时 agent 的展示名：全局昵称 > SSO display name > 原始 name。
function agentLabel(entry: PresenceEntry): string {
  return entry.handle ?? entry.display_name ?? entry.name;
}

// 按「每个 min 版本」独立记忆 dismissal（#670 评审）：忽略 0.4.0 不会顶掉 0.3.0 的忽略；
// 服务端回退到某个曾被忽略的旧 min 时不再骚扰。用版本后缀 key，而非单一覆盖值。
const DISMISS_KEY_PREFIX = "ap:outdatedAgentsNoticeDismissedMin:";

function isDismissed(min: string): boolean {
  try {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(DISMISS_KEY_PREFIX + min) === "1";
  } catch {
    return false;
  }
}

function persistDismissed(min: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(DISMISS_KEY_PREFIX + min, "1");
  } catch {
    // sessionStorage 不可用（隐私模式/无 DOM）时静默——本会话内的 React state 仍能隐藏。
  }
}

export function OutdatedAgentsNotice({ presence, accountKey, onUpgrade, minVersion }: Props) {
  const t = useT();
  const hookMin = useMinClientVersion();
  const min = minVersion !== undefined ? minVersion : hookMin;
  // 本会话内点过「忽略」的 min 集合；与 sessionStorage 的持久记忆并用（后者覆盖跨挂载/刷新）。
  const [dismissedMins, setDismissedMins] = useState<Set<string>>(() => new Set());

  const outdated = useMemo<OutdatedAgent[]>(() => {
    if (accountKey === null || min === null) return [];
    const rows: OutdatedAgent[] = [];
    for (const entry of Object.values(presence)) {
      // 只看自己名下的 agent：human 会话排除（网页人类无 CLI 版本），account 需与当前身份同源。
      if (entry.kind === "human") continue;
      if (entry.account !== accountKey) continue;
      if (!isClientVersionOutdated(entry.client_version, min)) continue;
      rows.push({ name: entry.name, label: agentLabel(entry), version: entry.client_version! });
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [presence, accountKey, min]);

  // 空态一律不渲染：min 未知 / 无过时 agent / 本 min 已被忽略（本会话或已持久化）。
  const dismissed = min !== null && (dismissedMins.has(min) || isDismissed(min));
  if (min === null || outdated.length === 0 || dismissed) return null;

  const title =
    outdated.length === 1
      ? t("OutdatedAgentsNotice.title.one")
      : t("OutdatedAgentsNotice.title.many", { count: outdated.length });

  return (
    <div className="banner banner--yellow outdated-agents-notice" role="status" aria-live="polite" data-outdated-count={outdated.length}>
      <div className="outdated-agents-notice-head">
        <span className="outdated-agents-notice-title">⚠ {title}</span>
        <button
          type="button"
          className="d-btn outdated-agents-notice-dismiss"
          onClick={() => {
            persistDismissed(min);
            setDismissedMins((s) => new Set(s).add(min));
          }}
        >
          {t("OutdatedAgentsNotice.dismiss")}
        </button>
      </div>
      <p className="outdated-agents-notice-lead">{t("OutdatedAgentsNotice.lead", { min })}</p>
      <ul className="outdated-agents-notice-list">
        {outdated.map((agent) => (
          <li key={agent.name} className="outdated-agents-notice-item">
            <span className="outdated-agents-notice-name">{agent.label}</span>
            <span className="outdated-agents-notice-ver t-mono">{t("OutdatedAgentsNotice.agentVersion", { current: agent.version, min })}</span>
            {onUpgrade && (
              <button type="button" className="d-btn d-btn--primary outdated-agents-notice-upgrade" onClick={() => onUpgrade(agent.name)}>
                {t("OutdatedAgentsNotice.upgrade")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
