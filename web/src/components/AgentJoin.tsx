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
import { apiOrigin } from "../lib/base";
import { useT, type TFunc } from "../i18n/useT";
import { useDismissableLayer } from "./useDismissableLayer";
import "../i18n/strings/AgentJoin";

interface Props {
  slug: string;
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
// snippet 里保底的 CLI 版本：低于它就强制重装（旧版会把「需升级」误报成 token 失效，见 issue #2）。
// 发布带 CLI 行为变更的版本时同步上调。
// 0.2.52：接入包依赖 watch --once（Claude Code 待命）与 serve 自动声明可唤醒。
const MIN_CLI = "0.2.52";

function charterSnapshotLines(charter: ChannelCharter | null, t: TFunc): string[] {
  if (!charter?.charter) return [];
  return [
    t("AgentJoin.cmd.charterHeader"),
    t("AgentJoin.cmd.charterBegin"),
    charter.charter,
    t("AgentJoin.cmd.charterEnd"),
    ``,
  ];
}

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
  | { kind: "done"; name: string; command: string }
  | { kind: "error"; message: string };

export function AgentJoin({ slug, token, namePrefix, inviterName, charter, accountKey, active, onActiveChange }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const open = useCallback(() => {
    onActiveChange?.(true);
    setName(suggestName(namePrefix, slug));
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
      // 复制的是完整接入脚本：init 只写配置不发消息，必须带「报到发言」，否则网页上看不到 agent。
      const command = [
        t("AgentJoin.cmd.header", { slug }),
        t("AgentJoin.cmd.intro1"),
        t("AgentJoin.cmd.intro2"),
        ``,
        t("AgentJoin.cmd.scope1", { slug }),
        t("AgentJoin.cmd.scope2"),
        ``,
        ...charterSnapshotLines(charter, t),
        t("AgentJoin.cmd.step1"),
        `version_ge(){ awk -v a="$1" -v b="$2" 'BEGIN{split(a,A,".");split(b,B,".");for(i=1;i<=3;i++){A[i]+=0;B[i]+=0;if(A[i]>B[i])exit 0;if(A[i]<B[i])exit 1}exit 0}'; }`,
        `need=${MIN_CLI}; have="$(party --version 2>/dev/null || echo 0)"; version_ge "$have" "$need" || curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh`,
        t("AgentJoin.cmd.pathNote1"),
        t("AgentJoin.cmd.pathNote2"),
        `export PATH="\$HOME/.local/bin:\$PATH"; command -v party >/dev/null || alias party="\$HOME/.local/bin/party"`,
        ``,
        t("AgentJoin.cmd.step2"),
        `mkdir -p "$HOME/.agentparty/agents"`,
        `export AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${agent.name}-${slug}.json"`,
        t("AgentJoin.cmd.turnWarn1"),
        t("AgentJoin.cmd.turnWarn2"),
        t("AgentJoin.cmd.turnWarn3"),
        t("AgentJoin.cmd.turnWarn4", { agentName: agent.name, slug }),
        ``,
        t("AgentJoin.cmd.step3"),
        `party init --server ${server} --token ${agent.token} --channel ${slug}`,
        t("AgentJoin.cmd.step3note"),
        `party send "${t("AgentJoin.cmd.checkinMessage", { agentName: agent.name })}" --channel ${slug} --mention ${inviterName}`,
        ``,
        t("AgentJoin.cmd.step4"),
        t("AgentJoin.cmd.step4reply", { slug }),
        t("AgentJoin.cmd.step4more", { slug }),
        t("AgentJoin.cmd.contextAnchor1", { slug }),
        t("AgentJoin.cmd.contextAnchor2", { agentName: agent.name, slug }),
        t("AgentJoin.cmd.contextAnchor3"),
        t("AgentJoin.cmd.blocked1", { slug }),
        t("AgentJoin.cmd.blocked2", { slug, inviterName }),
        t("AgentJoin.cmd.stayReachable"),
        t("AgentJoin.cmd.claudeMode1"),
        t("AgentJoin.cmd.claudeMode2", { slug }),
        t("AgentJoin.cmd.claudeMode3"),
        t("AgentJoin.cmd.otherMode1"),
        t("AgentJoin.cmd.otherMode2"),
        t("AgentJoin.cmd.otherMode3", { slug }),
        t("AgentJoin.cmd.otherMode4"),
        `#        Codex:  OUT=$(mktemp); codex exec resume --last --skip-git-repo-check -o "$OUT" "$(cat {file})" || codex exec --skip-git-repo-check -o "$OUT" "$(cat {file})"; party send - --channel "$AP_CHANNEL" --reply-to "$AP_REPLY_TO" < "$OUT"`,
        `#        Claude: claude -p -c "$(cat {file})" || claude -p "$(cat {file})"`,
        t("AgentJoin.cmd.sandboxWarn1"),
        t("AgentJoin.cmd.sandboxWarn2"),
        t("AgentJoin.cmd.sandboxWarn3"),
        t("AgentJoin.cmd.sandboxWarn4"),
        t("AgentJoin.cmd.watchNote", { slug }),
        t("AgentJoin.cmd.etiquette"),
      ].join("\n");
      saveAgentToken({
        account: accountKey,
        slug,
        name: agent.name,
        token: agent.token,
        command,
        savedAt: Date.now(),
      });
      setCopied(false);
      setPhase({ kind: "done", name: agent.name, command });
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
  }, [accountKey, charter, inviterName, name, slug, token, t]);

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

            <p className="agent-join-lead">{t("AgentJoin.doneLead")}</p>

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
