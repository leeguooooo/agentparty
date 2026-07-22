// #662：owner 进入/刷新页面时主动汇总——列出自己名下跑着过时 CLI 的 agent，引导用接入包升级。
// 与 MessageCard 的单条被动徽标（msg-client-version--outdated）互补：那是「某条消息发送时的快照」，
// 这里是 presence 级、owner 视角的一次性提醒，落点是「重跑接入包 = 重装最新 CLI」。
//
// 判定复用 lib/clientVersion（isClientVersionOutdated），不另写版本比较，三端口径一致。
// 基准取「最新发布版本」= 服务端当前部署版本（useLatestClientVersion），而非 min_client_version 硬地板——
// 后者是兼容底线（如 0.2.0，鲜少上移），拿它判过时几乎永不触发（#662 owner 反馈「进频道看不到提醒」的根因）；
// owner 要的是「落后于最新就引导升级」，故与最新版本比。基准未知（离线/拿不到）一律不渲染（未知不误报）。
import { useMemo, useState } from "react";
import type { PresenceEntry } from "@agentparty/shared";
import { isClientVersionOutdated, useLatestClientVersion } from "../lib/clientVersion";
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
  // 测试注入用：覆盖 useLatestClientVersion() 的结果（bun react-test-renderer 无 window，hook 恒 null）。
  latestVersion?: string | null;
}

// 过时 agent 的展示名：全局昵称 > SSO display name > 原始 name。
function agentLabel(entry: PresenceEntry): string {
  return entry.handle ?? entry.display_name ?? entry.name;
}

// 按「每个目标版本」独立记忆 dismissal（#670 评审）：忽略 0.4.0 不会顶掉 0.3.0 的忽略；
// 服务端回退到某个曾被忽略的旧版本时不再骚扰。用版本后缀 key，而非单一覆盖值。
// #662 起基准从 min 地板改为 latest：键前缀随之从 …DismissedMin 改名为 …DismissedLatest，
// 与旧 min 语义的持久记录彻底隔离（旧记录以 min 版本为键，绝不会误抑制新的 latest 提醒）。
const DISMISS_KEY_PREFIX = "ap:outdatedAgentsNoticeDismissedLatest:";

function isDismissed(version: string): boolean {
  try {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(DISMISS_KEY_PREFIX + version) === "1";
  } catch {
    return false;
  }
}

function persistDismissed(version: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(DISMISS_KEY_PREFIX + version, "1");
  } catch {
    // sessionStorage 不可用（隐私模式/无 DOM）时静默——本会话内的 React state 仍能隐藏。
  }
}

export function OutdatedAgentsNotice({ presence, accountKey, onUpgrade, latestVersion }: Props) {
  const t = useT();
  const hookLatest = useLatestClientVersion();
  const latest = latestVersion !== undefined ? latestVersion : hookLatest;
  // 本会话内点过「忽略」的目标版本集合；与 sessionStorage 的持久记忆并用（后者覆盖跨挂载/刷新）。
  const [dismissedVersions, setDismissedVersions] = useState<Set<string>>(() => new Set());

  const outdated = useMemo<OutdatedAgent[]>(() => {
    if (accountKey === null || latest === null) return [];
    const rows: OutdatedAgent[] = [];
    for (const entry of Object.values(presence)) {
      // 只看自己名下的 agent：human 会话排除（网页人类无 CLI 版本），account 需与当前身份同源。
      if (entry.kind === "human") continue;
      if (entry.account !== accountKey) continue;
      if (!isClientVersionOutdated(entry.client_version, latest)) continue;
      rows.push({ name: entry.name, label: agentLabel(entry), version: entry.client_version! });
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [presence, accountKey, latest]);

  // 空态一律不渲染：最新版本未知 / 无过时 agent / 本目标版本已被忽略（本会话或已持久化）。
  const dismissed = latest !== null && (dismissedVersions.has(latest) || isDismissed(latest));
  if (latest === null || outdated.length === 0 || dismissed) return null;

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
            persistDismissed(latest);
            setDismissedVersions((s) => new Set(s).add(latest));
          }}
        >
          {t("OutdatedAgentsNotice.dismiss")}
        </button>
      </div>
      <p className="outdated-agents-notice-lead">{t("OutdatedAgentsNotice.lead", { latest })}</p>
      <ul className="outdated-agents-notice-list">
        {outdated.map((agent) => (
          <li key={agent.name} className="outdated-agents-notice-item">
            <span className="outdated-agents-notice-name">{agent.label}</span>
            <span className="outdated-agents-notice-ver t-mono">{t("OutdatedAgentsNotice.agentVersion", { current: agent.version, latest })}</span>
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
