// 私有频道邀请链接（issue #38 web）。只对 moderator（房主）渲染——隐私性靠「只有创建者能生成」，
// 服务端 isChannelModerator 再强制。折叠面板：生成（可选有效期）+ 一键复制 + 列出未撤销链接 + 撤销。
//
// 邀请模式一等选择（#186）：
//   · 参与模式（participate）→ /join/<code> 成员链接，对方登录后成为正式成员，可读可发。
//   · 观看模式（watch）→ /c/<slug>?t=<token> 只读围观链接，无需登录，可读但发送禁用（复用 readonly 角色）。
// token 明文只在创建时回一次，所以观看链接只在生成时展示一次；列表只列 name + 撤销。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthError,
  createJoinLink,
  createShareLink,
  listJoinLinks,
  listShareLinks,
  revokeJoinLink,
  revokeShareLink,
  type JoinLinkInfo,
  type ShareLinkInfo,
} from "../lib/api";
import { useT, type TFunc } from "../i18n/useT";
import { useDismissableLayer } from "./useDismissableLayer";
import "../i18n/strings/JoinLink";

interface Props {
  slug: string;
  token: string;
  onAuthFailed(message: string): void;
  active?: boolean;
  onActiveChange?(open: boolean): void;
}

type InviteMode = "participate" | "watch";

function expiryOptions(t: TFunc): { label: string; sec?: number }[] {
  return [
    { label: t("JoinLink.expiry.7d"), sec: 7 * 86400 },
    { label: t("JoinLink.expiry.1d"), sec: 86400 },
    { label: t("JoinLink.expiry.30d"), sec: 30 * 86400 },
    { label: t("JoinLink.expiry.never") }, // sec undefined
  ];
}

// 默认单次失效（一个链接只能一个人用）——私有频道更看重隐私。用尽即失效。
function usesOptions(t: TFunc): { label: string; max?: number }[] {
  return [
    { label: t("JoinLink.uses.single"), max: 1 },
    { label: t("JoinLink.uses.5"), max: 5 },
    { label: t("JoinLink.uses.unlimited") }, // max undefined
  ];
}

function linkUrl(link: JoinLinkInfo): string {
  return link.url ?? `${location.origin}/join/${link.code}`;
}

function expiryLabel(link: JoinLinkInfo, t: TFunc): string {
  if (link.expires_at === null) return t("JoinLink.neverExpires");
  const left = link.expires_at - Date.now();
  if (left <= 0) return t("JoinLink.expired");
  const days = Math.floor(left / 86400000);
  if (days >= 1) return t("JoinLink.expiresInDays", { days });
  return t("JoinLink.expiresInHours", { hours: Math.max(1, Math.floor(left / 3600000)) });
}

export function JoinLink({ slug, token, onAuthFailed, active, onActiveChange }: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const EXPIRY_OPTIONS = expiryOptions(t);
  const USES_OPTIONS = usesOptions(t);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<InviteMode>("participate");
  const [links, setLinks] = useState<JoinLinkInfo[] | null>(null);
  const [shareLinks, setShareLinks] = useState<ShareLinkInfo[] | null>(null);
  const [watchUrl, setWatchUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [usesIdx, setUsesIdx] = useState(0); // 默认单次
  const [copied, setCopied] = useState<string | null>(null);
  const isOpen = active ?? open;

  const handleErr = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) {
        onAuthFailed(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : "failed");
    },
    [onAuthFailed],
  );

  const refresh = useCallback(async () => {
    try {
      setLinks(await listJoinLinks(token, slug));
    } catch (e) {
      handleErr(e);
    }
  }, [token, slug, handleErr]);

  const refreshShare = useCallback(async () => {
    try {
      setShareLinks(await listShareLinks(token, slug));
    } catch (e) {
      handleErr(e);
    }
  }, [token, slug, handleErr]);

  const close = useCallback(() => {
    if (active === undefined) setOpen(false);
    onActiveChange?.(false);
  }, [active, onActiveChange]);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    if (active === undefined) setOpen(true);
    onActiveChange?.(true);
    if (links === null) void refresh();
  }, [active, close, isOpen, links, onActiveChange, refresh]);

  useDismissableLayer({ active: isOpen, onDismiss: close, outsideRef: rootRef });

  useEffect(() => {
    if (isOpen) return;
    setMode("participate");
    setWatchUrl(null);
    setError(null);
    setExpiryIdx(0);
    setUsesIdx(0);
    setCopied(null);
  }, [isOpen]);

  const selectMode = useCallback(
    (next: InviteMode) => {
      setMode(next);
      setError(null);
      if (next === "watch" && shareLinks === null) void refreshShare();
      if (next === "participate" && links === null) void refresh();
    },
    [shareLinks, links, refreshShare, refresh],
  );

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "watch") {
        const link = await createShareLink(token, slug);
        await refreshShare();
        setBusy(false);
        if (link.url) {
          setWatchUrl(link.url);
          copy(link.url);
        }
        return;
      }
      const link = await createJoinLink(token, slug, {
        expiresInSec: EXPIRY_OPTIONS[expiryIdx]?.sec,
        maxUses: USES_OPTIONS[usesIdx]?.max,
      });
      await refresh(); // 先把新链接列出来（关键路径）
      setBusy(false);
      copy(linkUrl(link)); // best-effort：剪贴板在非聚焦标签会挂起/拒绝，绝不能阻塞上面的列表刷新
      return;
    } catch (e) {
      handleErr(e);
      setBusy(false);
    }
  }

  // 不 await、不阻塞调用方：writeText 在未聚焦文档会 reject 甚至挂起，失败只提示手动复制。
  function copy(url: string) {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(url);
        setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
      })
      .catch(() => setError(t("JoinLink.copyFailed")));
  }

  async function revoke(code: string) {
    setBusy(true);
    try {
      await revokeJoinLink(token, slug, code);
      await refresh();
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function revokeWatch(name: string) {
    setBusy(true);
    try {
      await revokeShareLink(token, slug, name);
      await refreshShare();
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(false);
    }
  }

  const activeLinks = (links ?? []).filter((l) => l.revoked_at === null && (l.expires_at === null || l.expires_at > Date.now()));

  return (
    <div className="joinlink" ref={rootRef}>
      <button type="button" className="d-btn joinlink-btn" onClick={toggle} aria-expanded={isOpen}>
        {t("JoinLink.button")}
      </button>
      {isOpen && (
        <div className="joinlink-panel" role="dialog" aria-modal="true" aria-label={t("JoinLink.button")}>
          <div className="joinlink-mode" role="radiogroup" aria-label={t("JoinLink.modeLabel")}>
            {(["participate", "watch"] as InviteMode[]).map((m) => (
              <label key={m} className={`joinlink-mode-opt${mode === m ? " is-active" : ""}`}>
                <input
                  type="radio"
                  name="joinlink-mode"
                  value={m}
                  checked={mode === m}
                  disabled={busy}
                  onChange={() => selectMode(m)}
                />
                {t(`JoinLink.mode.${m}`)}
              </label>
            ))}
          </div>
          <span className="joinlink-mode-desc">{t(`JoinLink.mode.${mode}.desc`)}</span>

          {mode === "participate" ? (
            <div className="joinlink-gen">
              <span className="joinlink-hint">{t("JoinLink.hint")}</span>
              <div className="joinlink-gen-row">
                <label className="joinlink-expiry">
                  {t("JoinLink.usesLabel")}
                  <select value={usesIdx} onChange={(e) => setUsesIdx(Number(e.target.value))} disabled={busy}>
                    {USES_OPTIONS.map((o, i) => (
                      <option key={o.label} value={i}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="joinlink-expiry">
                  {t("JoinLink.expiryLabel")}
                  <select value={expiryIdx} onChange={(e) => setExpiryIdx(Number(e.target.value))} disabled={busy}>
                    {EXPIRY_OPTIONS.map((o, i) => (
                      <option key={o.label} value={i}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="d-btn d-btn--primary" disabled={busy} onClick={generate}>
                  {busy ? t("JoinLink.generating") : t("JoinLink.generate")}
                </button>
              </div>
            </div>
          ) : (
            <div className="joinlink-gen">
              <span className="joinlink-hint">{t("JoinLink.watch.hint")}</span>
              <div className="joinlink-gen-row">
                <button type="button" className="d-btn d-btn--primary" disabled={busy} onClick={generate}>
                  {busy ? t("JoinLink.generating") : t("JoinLink.watch.generate")}
                </button>
              </div>
              {watchUrl !== null && (
                <div className="joinlink-watch-oneshot">
                  <span className="joinlink-meta">{t("JoinLink.watch.oneTime")}</span>
                  <code className="joinlink-url t-mono">{watchUrl}</code>
                  <button type="button" className="d-btn joinlink-copy" onClick={() => copy(watchUrl)}>
                    {copied === watchUrl ? t("JoinLink.copied") : t("JoinLink.copy")}
                  </button>
                </div>
              )}
            </div>
          )}

          {error !== null && <p className="joinlink-error">{error}</p>}

          {mode === "participate" ? (
            <>
              {activeLinks.length > 0 && (
                <ul className="joinlink-list">
                  {activeLinks.map((l) => {
                    const url = linkUrl(l);
                    return (
                      <li key={l.code} className="joinlink-item">
                        <code className="joinlink-url t-mono">{url}</code>
                        <span className="joinlink-meta">
                          <span className="joinlink-tag">{t("JoinLink.tag.participate")}</span>
                          {" · "}
                          {expiryLabel(l, t)}
                          {" · "}
                          {l.max_uses !== null
                            ? t("JoinLink.usesOf", { uses: l.uses, max: l.max_uses })
                            : t("JoinLink.usesCount", { uses: l.uses })}
                        </span>
                        <button type="button" className="d-btn joinlink-copy" onClick={() => copy(url)}>
                          {copied === url ? t("JoinLink.copied") : t("JoinLink.copy")}
                        </button>
                        <button type="button" className="d-btn joinlink-revoke" disabled={busy} onClick={() => revoke(l.code)}>
                          {t("JoinLink.revoke")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {links !== null && activeLinks.length === 0 && <p className="joinlink-empty">{t("JoinLink.empty")}</p>}
            </>
          ) : (
            <>
              {(shareLinks ?? []).length > 0 && (
                <ul className="joinlink-list">
                  {(shareLinks ?? []).map((l) => (
                    <li key={l.name} className="joinlink-item">
                      <code className="joinlink-url t-mono">{l.name}</code>
                      <span className="joinlink-meta">
                        <span className="joinlink-tag">{t("JoinLink.tag.watch")}</span>
                      </span>
                      <button type="button" className="d-btn joinlink-revoke" disabled={busy} onClick={() => revokeWatch(l.name)}>
                        {t("JoinLink.revoke")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {shareLinks !== null && (shareLinks ?? []).length === 0 && <p className="joinlink-empty">{t("JoinLink.watch.empty")}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
