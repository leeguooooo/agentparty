// 频道页「＋ 让 agent 加入」：登录人类先给 agent 起个能认出来的名字（默认 <你>-<频道>，
// 可改成 drawstyle-review 这类），再铸一枚 channel-scoped agent token，弹出可复制的接入脚本。
// 明文 token 只出现这一次（spec §10）。名字有意义 = 频道里一眼分清谁的哪个项目，不再是随机后缀。
import { useCallback, useEffect, useState } from "react";
import {
  AuthError,
  type ChannelCharter,
  ConflictError,
  createChannelAgent,
  ForbiddenError,
  ValidationError,
} from "../lib/api";
import { copyText, saveAgentToken } from "../lib/agentTokenVault";
import { buildJoinPack, type JoinPackMode } from "../lib/joinPack";
import { desktopAgentAdapter, type DesktopAgentAdapter } from "../lib/desktopAgent";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import { apiOrigin } from "../lib/base";
import { useT } from "../i18n/useT";
import { useDismissableLayer } from "./useDismissableLayer";
import "../i18n/strings/AgentJoin";

interface Props {
  slug: string;
  /** 测试注入；生产恒为默认值。 */
  dutyAdapter?: Pick<DesktopAgentAdapter, "dutyAdopt">;
  desktopDetect?: () => boolean;
  token: string; // 当前登录人类会话 token（铸造凭据）
  namePrefix: string; // 生成 agent 名的前缀来源（email/name 前缀，退回 slug）
  inviterName: string; // 邀请人在频道里的身份名，报到时 @ 他让他知道你来了
  charter: ChannelCharter | null;
  accountKey: string;
  active?: boolean;
  onActiveChange?(open: boolean): void;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const RESERVED = new Set(["system"]);
// 完整接入包 builder（含 MIN_CLI 版本闸、charter 快照、待命指引）在 lib/joinPack ——
// 与 vault「复制接入包」共用同一份，两个入口的产物逐字节同构（#584 复盘）。

// 从前缀清洗出一个合法的名字词根（小写、仅 [a-z0-9._-]、去首尾非字母数字）。
function cleanBase(prefix: string): string {
  const base = prefix
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 24);
  return base || "agent";
}

// 默认建议名：<你>-<频道>，直观且大概率唯一；占用了让用户自己改（不再塞随机后缀糊弄）。
function suggestName(prefix: string, slug: string): string {
  const name = `${cleanBase(prefix)}-${slug}`.slice(0, 64);
  return NAME_RE.test(name) && !RESERVED.has(name) ? name : cleanBase(prefix);
}

type Phase =
  | { kind: "idle" }
  | { kind: "compose" } // 起名中
  | { kind: "loading" }
  | { kind: "done"; name: string; token: string; command: string; mode: JoinPackMode }
  | { kind: "error"; message: string };

export function AgentJoin({ slug, token, namePrefix, inviterName, charter, accountKey, active, onActiveChange, dutyAdapter = desktopAgentAdapter, desktopDetect = isDesktopRuntime }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [name, setName] = useState("");
  // #612：无人值守值守预设——unattended 生成「装 CLI → init → party serve --runner claude」的
  // 运维脚本，interactive 仍是贴给 agent harness 的完整接入包。
  const [mode, setMode] = useState<JoinPackMode>("interactive");
  // #616 phase 4：桌面 webview 内的无人值守一键接管状态
  const [adoptState, setAdoptState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const open = useCallback(() => {
    onActiveChange?.(true);
    setName(suggestName(namePrefix, slug));
    setMode("interactive");
    setNameErr(null);
    setPhase({ kind: "compose" });
  }, [namePrefix, onActiveChange, slug]);

  const reset = useCallback(() => {
    setPhase({ kind: "idle" });
    setName("");
    setCopied(false);
    setNameErr(null);
  }, []);

  const close = useCallback(() => {
    reset();
    onActiveChange?.(false);
  }, [onActiveChange, reset]);

  useEffect(() => {
    if (active === false && phase.kind !== "idle") reset();
  }, [active, phase.kind, reset]);

  const dialogOpen = phase.kind === "compose" || phase.kind === "loading" || phase.kind === "done";
  useDismissableLayer({ active: dialogOpen, onDismiss: close });

  const mint = useCallback(async () => {
    const wanted = name.trim();
    if (!NAME_RE.test(wanted) || RESERVED.has(wanted)) {
      setNameErr(t("AgentJoin.nameError"));
      return;
    }
    setNameErr(null);
    setPhase({ kind: "loading" });
    try {
      const agent = await createChannelAgent(slug, wanted, token);
      // #530：接入包的 server 必须是真实后端。桌面版(Tauri)里 location.origin 是 tauri://localhost /
      // http://tauri.localhost / dev 的 127.0.0.1:5173，agent 拿去 `party init --server` 会因非 http(s)
      // 报错或连不上。优先用打包注入的 apiBase(VITE_API_BASE=真后端)，仅同源 web 部署(apiBase 为空)回退 location.origin。
      const server = apiOrigin();
      const command = buildJoinPack(mode, {
        slug,
        agentName: agent.name,
        agentToken: agent.token,
        server,
        inviterName,
        charter,
        t,
      });
      saveAgentToken({
        account: accountKey,
        slug,
        name: agent.name,
        token: agent.token,
        command,
        mode,
        savedAt: Date.now(),
      });
      setCopied(false);
      setAdoptState("idle");
      setAdoptError(null);
      setPhase({ kind: "done", name: agent.name, token: agent.token, command, mode });
    } catch (err) {
      // 同名占用 → 停在起名步，让用户换个有意义的名字（不静默塞随机后缀）
      if (err instanceof ConflictError) {
        setNameErr(t("AgentJoin.nameConflict"));
        setPhase({ kind: "compose" });
        return;
      }
      const message =
        err instanceof AuthError
          ? t("AgentJoin.errAuth")
          : err instanceof ForbiddenError
            ? t("AgentJoin.errForbidden")
            : err instanceof ValidationError
              ? t("AgentJoin.errValidation")
              : t("AgentJoin.errGeneric");
      setPhase({ kind: "error", message });
    }
  }, [accountKey, charter, inviterName, mode, name, slug, token, t]);

  const adopt = useCallback(async () => {
    if (phase.kind !== "done" || adoptState === "busy" || adoptState === "done") return;
    setAdoptState("busy");
    setAdoptError(null);
    try {
      await dutyAdapter.dutyAdopt({
        server: apiOrigin(),
        token: phase.token,
        name: phase.name,
        channel: slug,
        runner: "claude",
      });
      setAdoptState("done");
    } catch (err) {
      setAdoptState("error");
      setAdoptError(err instanceof Error ? err.message : String(err));
    }
  }, [adoptState, dutyAdapter, phase, slug]);

  const onCopy = useCallback(async () => {
    if (phase.kind !== "done") return;
    const ok = await copyText(phase.command);
    setCopied(ok);
  }, [phase]);

  return (
    <div className="agent-join">
      <button
        type="button"
        className="d-btn d-btn--primary agent-join-btn"
        onClick={open}
        disabled={phase.kind === "loading"}
      >
        {phase.kind === "loading" ? t("AgentJoin.minting") : t("AgentJoin.open")}
      </button>

      {phase.kind === "error" && (
        <p className="banner banner--red agent-join-err" role="alert">
          {phase.message}
        </p>
      )}

      {(phase.kind === "compose" || phase.kind === "loading") && (
        <div className="agent-join-overlay" role="dialog" aria-modal="true" aria-label={t("AgentJoin.dialogNameLabel")}>
          <div className="agent-join-scrim" onClick={close} />
          <div className="d-card agent-join-card">
            <header className="agent-join-card-head">
              <h2 className="d-title agent-join-title">
                {t("AgentJoin.titlePrefix")} <span className="d-hl">#{slug}</span>
              </h2>
              <button type="button" className="agent-join-close t-mono" onClick={close} aria-label={t("AgentJoin.close")}>
                ✕
              </button>
            </header>

            <p className="agent-join-lead">{t("AgentJoin.lead", { examples: "drawstyle-review, leo-debug" })}</p>

            <label className="agent-join-namerow">
              <span className="agent-join-namelabel t-mono">{t("AgentJoin.nameFieldLabel")}</span>
              <input
                className="t-mono agent-join-nameinput"
                value={name}
                autoFocus
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && phase.kind === "compose") mint();
                }}
                placeholder={`${slug}-review`}
                disabled={phase.kind === "loading"}
              />
            </label>
            {nameErr !== null && (
              <p className="banner banner--red agent-join-namewarn" role="alert">
                {nameErr}
              </p>
            )}
            <p className="agent-join-hint t-mono">{t("AgentJoin.nameHint")}</p>

            <fieldset className="agent-join-mode">
              <legend className="agent-join-namelabel t-mono">{t("AgentJoin.modeLabel")}</legend>
              {(["interactive", "unattended"] as const).map((value) => (
                <label key={value} className="agent-join-mode-option">
                  <input
                    type="radio"
                    name="agent-join-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    disabled={phase.kind === "loading"}
                  />
                  <span className="t-mono">
                    {t(value === "interactive" ? "AgentJoin.modeInteractive" : "AgentJoin.modeUnattended")}
                  </span>
                  <span className="agent-join-mode-desc">
                    {t(value === "interactive" ? "AgentJoin.modeInteractiveDesc" : "AgentJoin.modeUnattendedDesc")}
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="agent-join-actions">
              <button
                type="button"
                className="d-btn d-btn--primary"
                onClick={mint}
                disabled={phase.kind === "loading"}
              >
                {phase.kind === "loading" ? t("AgentJoin.minting") : t("AgentJoin.generate")}
              </button>
            </div>
          </div>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="agent-join-overlay" role="dialog" aria-modal="true" aria-label={t("AgentJoin.doneTitleSuffix")}>
          <div className="agent-join-scrim" onClick={close} />
          <div className="d-card agent-join-card">
            <header className="agent-join-card-head">
              <h2 className="d-title agent-join-title">
                <span className="d-hl">{phase.name}</span> {t("AgentJoin.doneTitleSuffix")}
              </h2>
              <button type="button" className="agent-join-close t-mono" onClick={close} aria-label={t("AgentJoin.close")}>
                ✕
              </button>
            </header>

            <p className="agent-join-lead">
              {t(phase.mode === "unattended" ? "AgentJoin.doneLeadUnattended" : "AgentJoin.doneLead")}
            </p>

            {phase.mode === "unattended" && desktopDetect() && (
              <div className="agent-join-adopt">
                <button
                  type="button"
                  className="d-btn d-btn--primary"
                  disabled={adoptState === "busy" || adoptState === "done"}
                  onClick={() => void adopt()}
                >
                  {t(
                    adoptState === "busy"
                      ? "AgentJoin.adoptBusy"
                      : adoptState === "done"
                        ? "AgentJoin.adoptDone"
                        : "AgentJoin.adoptButton",
                  )}
                </button>
                <span className="agent-join-hint t-mono">
                  {adoptState === "done" ? t("AgentJoin.adoptDoneHint") : t("AgentJoin.adoptHint")}
                </span>
                {adoptState === "error" && adoptError !== null && (
                  <p className="banner banner--red" role="alert">{adoptError}</p>
                )}
              </div>
            )}

            <div className="agent-join-cmd">
              <pre className="t-mono agent-join-cmd-text">{phase.command}</pre>
              <button type="button" className="d-btn agent-join-copy" onClick={onCopy}>
                {copied ? t("AgentJoin.copied") : t("AgentJoin.copy")}
              </button>
            </div>

            <p className="banner banner--yellow agent-join-warn" role="status">
              {t("AgentJoin.tokenWarn")}
            </p>
            <p className="agent-join-hint t-mono">
              {t("AgentJoin.footerHintPrefix", { init: "party init" })} <a href="/docs">/docs</a>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
