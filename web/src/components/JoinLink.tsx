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
  createExternalInvite,
  createJoinLink,
  createShareLink,
  listChannelJoinRequests,
  listExternalInvites,
  listJoinLinks,
  listShareLinks,
  reviewChannelJoinRequest,
  revokeExternalInvite,
  revokeJoinLink,
  revokeShareLink,
  type ExternalInviteInfo,
  type JoinLinkInfo,
  type ChannelJoinRequest,
  type ShareLinkInfo,
} from "../lib/api";
import { useT, type TFunc } from "../i18n/useT";
import { apiOrigin } from "../lib/base";
import { useDismissableLayer } from "./useDismissableLayer";
import { LarkMemberInvite } from "./LarkMemberInvite";
import "../i18n/strings/JoinLink";

interface Props {
  slug: string;
  token: string;
  onAuthFailed(message: string): void;
  /** Render the invitation workflow inside a parent admin module without a nested dialog/toggle. */
  embedded?: boolean;
  active?: boolean;
  onActiveChange?(open: boolean): void;
  larkDirectoryEnabled?: boolean;
}

// external（#593）：外部协作者一次性邀请码——对方登录账号中心后自动入册实例 + 入频道 + 拿到预设昵称。
type InviteMode = "participate" | "watch" | "external";

function expiryOptions(t: TFunc): { label: string; sec?: number }[] {
  return [
    { label: t("JoinLink.expiry.7d"), sec: 7 * 86400 },
    { label: t("JoinLink.expiry.1d"), sec: 86400 },
    { label: t("JoinLink.expiry.30d"), sec: 30 * 86400 },
    { label: t("JoinLink.expiry.never") }, // sec undefined
  ];
}

// 外部邀请的预设昵称：与服务端 HANDLE_RE 同步（2-32 位 ASCII，首字符字母数字）。
const NICKNAME_INPUT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

// 默认单次失效（一个链接只能一个人用）——私有频道更看重隐私。用尽即失效。
function usesOptions(t: TFunc): { label: string; max?: number }[] {
  return [
    { label: t("JoinLink.uses.single"), max: 1 },
    { label: t("JoinLink.uses.5"), max: 5 },
    { label: t("JoinLink.uses.unlimited") }, // max undefined
  ];
}

// #530 同款坑：桌面版(Tauri)里 location.origin 是 agentparty-ui://localhost，复制出去的链接
// 别人打不开。列表接口不回 url，兜底必须拼真实后端 origin（worker 同源服务 /join 落地页）；
// 同源 web 部署 apiBase 为空，仍回退 location.origin。
function linkUrl(link: JoinLinkInfo): string {
  return link.url ?? `${apiOrigin()}/join/${link.code}`;
}

function expiryLabel(link: Pick<JoinLinkInfo, "expires_at">, t: TFunc): string {
  if (link.expires_at === null) return t("JoinLink.neverExpires");
  const left = link.expires_at - Date.now();
  if (left <= 0) return t("JoinLink.expired");
  const days = Math.floor(left / 86400000);
  if (days >= 1) return t("JoinLink.expiresInDays", { days });
  return t("JoinLink.expiresInHours", { hours: Math.max(1, Math.floor(left / 3600000)) });
}

export function JoinLink({
  slug,
  token,
  onAuthFailed,
  embedded = false,
  active,
  onActiveChange,
  larkDirectoryEnabled = false,
}: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const EXPIRY_OPTIONS = expiryOptions(t);
  const USES_OPTIONS = usesOptions(t);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<InviteMode>("participate");
  const [links, setLinks] = useState<JoinLinkInfo[] | null>(null);
  const [shareLinks, setShareLinks] = useState<ShareLinkInfo[] | null>(null);
  const [externalInvites, setExternalInvites] = useState<ExternalInviteInfo[] | null>(null);
  const [nickname, setNickname] = useState("");
  const [watchUrl, setWatchUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [usesIdx, setUsesIdx] = useState(0); // 默认单次
  const [copied, setCopied] = useState<string | null>(null);
  const [joinRequests, setJoinRequests] = useState<ChannelJoinRequest[] | null>(null);
  const [joinRequestsError, setJoinRequestsError] = useState(false);
  const [reviewBusyId, setReviewBusyId] = useState<number | string | null>(null);
  const [rejectingId, setRejectingId] = useState<number | string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const listRequestRef = useRef({ participate: 0, watch: 0, external: 0 });
  const isOpen = embedded || (active ?? open);

  const handleErr = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) {
        onAuthFailed(e.message);
        setJoinRequestsError(true);
        return;
      }
      setError(e instanceof Error ? e.message : "failed");
    },
    [onAuthFailed],
  );

  const refresh = useCallback(async () => {
    const requestId = ++listRequestRef.current.participate;
    try {
      const next = await listJoinLinks(token, slug);
      if (requestId === listRequestRef.current.participate) setLinks(next);
    } catch (e) {
      if (requestId === listRequestRef.current.participate) handleErr(e);
    }
  }, [token, slug, handleErr]);

  const refreshShare = useCallback(async () => {
    const requestId = ++listRequestRef.current.watch;
    try {
      const next = await listShareLinks(token, slug);
      if (requestId === listRequestRef.current.watch) setShareLinks(next);
    } catch (e) {
      if (requestId === listRequestRef.current.watch) handleErr(e);
    }
  }, [token, slug, handleErr]);

  const refreshExternal = useCallback(async () => {
    const requestId = ++listRequestRef.current.external;
    try {
      const next = await listExternalInvites(token, slug);
      if (requestId === listRequestRef.current.external) setExternalInvites(next);
    } catch (e) {
      if (requestId === listRequestRef.current.external) handleErr(e);
    }
  }, [token, slug, handleErr]);

  const refreshJoinRequests = useCallback(async () => {
    setJoinRequests(null);
    setJoinRequestsError(false);
    try {
      setJoinRequests(await listChannelJoinRequests(token, slug, "pending"));
    } catch (e) {
      if (e instanceof AuthError) {
        onAuthFailed(e.message);
        return;
      }
      setJoinRequestsError(true);
    }
  }, [token, slug, onAuthFailed]);

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
  }, [active, close, isOpen, onActiveChange]);

  useDismissableLayer({ active: isOpen && !embedded, onDismiss: close, outsideRef: rootRef });

  useEffect(() => {
    if (isOpen && links === null) void refresh();
  }, [isOpen, links, refresh]);

  useEffect(() => {
    if (isOpen && joinRequests === null && !joinRequestsError) void refreshJoinRequests();
  }, [isOpen, joinRequests, joinRequestsError, refreshJoinRequests]);

  useEffect(() => {
    if (isOpen) return;
    setMode("participate");
    setWatchUrl(null);
    setError(null);
    setExpiryIdx(0);
    setUsesIdx(0);
    setCopied(null);
    setNickname("");
  }, [isOpen]);

  const selectMode = useCallback(
    (next: InviteMode) => {
      setMode(next);
      setError(null);
      if (next === "watch" && shareLinks === null) void refreshShare();
      if (next === "participate" && links === null) void refresh();
      if (next === "external" && externalInvites === null) void refreshExternal();
    },
    [shareLinks, links, externalInvites, refreshShare, refresh, refreshExternal],
  );

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "external") {
        const invite = await createExternalInvite(token, slug, {
          handle: nickname.trim(),
          expiresInSec: EXPIRY_OPTIONS[expiryIdx]?.sec,
        });
        await refreshExternal();
        setBusy(false);
        setNickname("");
        copy(invite.url ?? `${apiOrigin()}/invite/${invite.code}`);
        return;
      }
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

  async function revokeExternal(code: string) {
    setBusy(true);
    try {
      await revokeExternalInvite(token, slug, code);
      await refreshExternal();
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function review(request: ChannelJoinRequest, action: "approve" | "reject") {
    if (request.id === undefined) return;
    const reason = rejectReason.trim();
    if (action === "reject" && reason === "") return;
    setReviewBusyId(request.id);
    setJoinRequestsError(false);
    try {
      await reviewChannelJoinRequest(
        token,
        slug,
        request.id,
        action === "approve" ? { action } : { action, reason },
      );
      setJoinRequests((current) => current?.filter((item) => item.id !== request.id) ?? []);
      setRejectingId(null);
      setRejectReason("");
    } catch (e) {
      if (e instanceof AuthError) onAuthFailed(e.message);
      else setJoinRequestsError(true);
    } finally {
      setReviewBusyId(null);
    }
  }

  const activeLinks = (links ?? []).filter((l) => l.revoked_at === null && (l.expires_at === null || l.expires_at > Date.now()));
  // 外部邀请列表：pending 未过期的可复制/撤销；已兑换的留档展示（谁的昵称已被用掉）；过期未兑换的隐藏。
  const activeExternalInvites = (externalInvites ?? []).filter(
    (i) => i.revoked_at === null && (i.redeemed_by !== null || i.expires_at === null || i.expires_at > Date.now()),
  );

  return (
    <div className="joinlink" ref={rootRef}>
      {!embedded && (
        <button type="button" className="d-btn joinlink-btn" onClick={toggle} aria-expanded={isOpen}>
          {t("JoinLink.button")}
        </button>
      )}
      {isOpen && (
        <div
          className={`joinlink-panel${embedded ? " joinlink-panel--embedded" : ""}`}
          role={embedded ? "region" : "dialog"}
          aria-modal={embedded ? undefined : true}
          aria-label={t("JoinLink.button")}
        >
          <div className="joinlink-mode" role="radiogroup" aria-label={t("JoinLink.modeLabel")}>
            {(["participate", "watch", "external"] as InviteMode[]).map((m) => (
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
          ) : mode === "watch" ? (
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
          ) : (
            <div className="joinlink-gen">
              <span className="joinlink-hint">{t("JoinLink.external.hint")}</span>
              <div className="joinlink-gen-row">
                <label className="joinlink-expiry joinlink-nickname">
                  {t("JoinLink.external.nicknameLabel")}
                  <input
                    className="t-mono joinlink-nickname-input"
                    type="text"
                    value={nickname}
                    placeholder={t("JoinLink.external.nicknamePlaceholder")}
                    disabled={busy}
                    onChange={(e) => setNickname(e.target.value)}
                  />
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
                <button
                  type="button"
                  className="d-btn d-btn--primary"
                  disabled={busy || !NICKNAME_INPUT_RE.test(nickname.trim())}
                  onClick={generate}
                >
                  {busy ? t("JoinLink.generating") : t("JoinLink.generate")}
                </button>
              </div>
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
          ) : mode === "watch" ? (
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
          ) : (
            <>
              {activeExternalInvites.length > 0 && (
                <ul className="joinlink-list">
                  {activeExternalInvites.map((invite) => {
                    // 桌面版 location.origin 是 agentparty-ui://localhost，兜底必须拼真实后端 origin
                    const url = invite.url ?? `${apiOrigin()}/invite/${invite.code}`;
                    const redeemed = invite.redeemed_by !== null;
                    return (
                      <li key={invite.code} className="joinlink-item">
                        <code className="joinlink-url t-mono">{redeemed ? `@${invite.preset_handle}` : url}</code>
                        <span className="joinlink-meta">
                          <span className="joinlink-tag">{t("JoinLink.tag.external")}</span>
                          {" · @"}
                          {invite.preset_handle}
                          {" · "}
                          {redeemed
                            ? t("JoinLink.external.redeemed")
                            : expiryLabel({ expires_at: invite.expires_at }, t)}
                        </span>
                        {!redeemed && (
                          <button type="button" className="d-btn joinlink-copy" onClick={() => copy(url)}>
                            {copied === url ? t("JoinLink.copied") : t("JoinLink.copy")}
                          </button>
                        )}
                        {!redeemed && (
                          <button
                            type="button"
                            className="d-btn joinlink-revoke"
                            disabled={busy}
                            onClick={() => revokeExternal(invite.code)}
                          >
                            {t("JoinLink.revoke")}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {externalInvites !== null && activeExternalInvites.length === 0 && (
                <p className="joinlink-empty">{t("JoinLink.external.empty")}</p>
              )}
            </>
          )}

          <section className="joinrequest-section" aria-labelledby="joinrequest-heading">
            <div className="joinrequest-heading-row">
              <strong id="joinrequest-heading">{t("JoinLink.requests.title")}</strong>
              {joinRequests !== null && <span className="joinrequest-count">{joinRequests.length}</span>}
            </div>
            {joinRequests === null && !joinRequestsError && (
              <p className="joinrequest-loading" role="status">{t("JoinLink.requests.loading")}</p>
            )}
            {joinRequestsError && (
              <p className="joinrequest-error" role="alert">
                {t("JoinLink.requests.error")}{" "}
                <button type="button" className="d-btn joinrequest-retry" onClick={() => void refreshJoinRequests()}>
                  {t("JoinLink.requests.retry")}
                </button>
              </p>
            )}
            {joinRequests !== null && joinRequests.length === 0 && (
              <p className="joinrequest-empty">{t("JoinLink.requests.empty")}</p>
            )}
            {joinRequests !== null && joinRequests.length > 0 && (
              <ul className="joinrequest-list">
                {joinRequests.map((request, index) => {
                  const id = request.id ?? `pending-${index}`;
                  const rejecting = rejectingId === request.id;
                  return (
                    <li className="joinrequest-item" key={id}>
                      <div className="joinrequest-person">
                        <strong>{request.requester_display ?? request.requester_profile?.display_name ?? request.requester_name ?? t("JoinLink.requests.unknown")}</strong>
                        {request.account && <span>{request.account}</span>}
                      </div>
                      {request.note && <p className="joinrequest-note">{request.note}</p>}
                      {rejecting ? (
                        <div className="joinrequest-reject-row">
                          <input
                            className="joinrequest-reason"
                            value={rejectReason}
                            onChange={(event) => setRejectReason(event.target.value)}
                            placeholder={t("JoinLink.requests.reasonPlaceholder")}
                            aria-label={t("JoinLink.requests.reasonLabel")}
                            autoFocus
                          />
                          <button
                            type="button"
                            className="d-btn joinrequest-reject-confirm"
                            disabled={rejectReason.trim() === "" || reviewBusyId === request.id}
                            onClick={() => void review(request, "reject")}
                          >
                            {t("JoinLink.requests.confirmReject")}
                          </button>
                          <button type="button" className="d-btn" onClick={() => { setRejectingId(null); setRejectReason(""); }}>
                            {t("JoinLink.requests.cancel")}
                          </button>
                        </div>
                      ) : (
                        <div className="joinrequest-actions">
                          <button
                            type="button"
                            className="d-btn d-btn--primary joinrequest-approve"
                            disabled={reviewBusyId !== null || request.id === undefined}
                            onClick={() => void review(request, "approve")}
                          >
                            {t("JoinLink.requests.approve")}
                          </button>
                          <button
                            type="button"
                            className="d-btn joinrequest-reject"
                            disabled={reviewBusyId !== null || request.id === undefined}
                            onClick={() => { setRejectingId(request.id ?? null); setRejectReason(""); }}
                          >
                            {t("JoinLink.requests.reject")}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {larkDirectoryEnabled && <LarkMemberInvite slug={slug} token={token} />}
        </div>
      )}
    </div>
  );
}
