import { useState, type FormEvent } from "react";
import {
  inviteLarkMember,
  LarkDirectoryApiError,
  searchLarkDirectory,
  type LarkDirectoryPage,
  type LarkDirectoryUser,
} from "../lib/api";
import { useT } from "../i18n/useT";
import "../i18n/strings/LarkMemberInvite";
import "./LarkMemberInvite.css";

interface Props {
  slug: string;
  token: string;
  search?: typeof searchLarkDirectory;
  invite?: typeof inviteLarkMember;
  onInvited?(user: LarkDirectoryUser): void;
}

export function LarkMemberInvite({
  slug,
  token,
  search = searchLarkDirectory,
  invite = inviteLarkMember,
  onInvited,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<LarkDirectoryUser[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // #382：部署未开通 Lark 通讯录权限时，撞一次就记住——之后禁用搜索并持久提示，
  // 不让用户反复搜了才报错。权限是 owner 在 Lark 后台配置项，前端只能优雅降级。
  const [directoryUnavailable, setDirectoryUnavailable] = useState(false);

  function isDirectoryPermissionError(cause: unknown): boolean {
    return (
      cause instanceof LarkDirectoryApiError &&
      cause.code === "lark_contact_permission_required"
    );
  }

  function disableDirectoryActions() {
    setDirectoryUnavailable(true);
    setUsers([]);
    setCursor(null);
    setSearched(false);
    setError(null);
  }

  function errorLabel(cause: unknown, fallbackKey: string): string {
    if (cause instanceof LarkDirectoryApiError) {
      if (cause.status === 429 || cause.code === "rate_limited") return t("LarkInvite.error.rateLimited");
      if (cause.status === 403) return t("LarkInvite.error.forbidden");
      if (isDirectoryPermissionError(cause)) return t("LarkInvite.error.permission");
    }
    return t(fallbackKey);
  }

  async function runSearch(nextCursor: string | null) {
    const normalized = query.trim();
    if (!normalized) return;
    setBusy(true);
    setError(null);
    try {
      const page: LarkDirectoryPage = await search(token, slug, normalized, 20, nextCursor);
      setUsers((current) => {
        if (nextCursor === null) return page.users;
        const known = new Set(current.map((user) => user.id));
        return [...current, ...page.users.filter((user) => !known.has(user.id))];
      });
      setCursor(page.next_cursor);
      setSearched(true);
    } catch (cause) {
      if (isDirectoryPermissionError(cause)) disableDirectoryActions();
      else setError(errorLabel(cause, "LarkInvite.error.search"));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await runSearch(null);
  }

  async function add(user: LarkDirectoryUser) {
    setInviting(user.id);
    setError(null);
    try {
      const added = await invite(token, slug, user.id);
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, already_member: true } : item));
      onInvited?.(added);
    } catch (cause) {
      if (isDirectoryPermissionError(cause)) disableDirectoryActions();
      else setError(errorLabel(cause, "LarkInvite.error.invite"));
    } finally {
      setInviting(null);
    }
  }

  return (
    <section className="lark-invite" aria-labelledby="lark-invite-title">
      <h3 id="lark-invite-title">{t("LarkInvite.title")}</h3>
      {directoryUnavailable ? (
        // #382 优雅降级：权限未开通，持久提示 + 不再显示可徒劳操作的搜索框。
        <p className="lark-invite-unavailable" role="status">{t("LarkInvite.unavailable")}</p>
      ) : (
        <>
          <form className="lark-invite-search" onSubmit={submit}>
            <input
              type="search"
              value={query}
              maxLength={64}
              aria-label={t("LarkInvite.searchLabel")}
              placeholder={t("LarkInvite.placeholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="d-btn d-btn--primary" disabled={busy || !query.trim()}>
              {busy ? t("LarkInvite.searching") : t("LarkInvite.search")}
            </button>
          </form>
          {error !== null && <p className="lark-invite-error" role="alert">{error}</p>}
        </>
      )}
      {!directoryUnavailable && searched && users.length === 0 && !busy && <p className="lark-invite-empty">{t("LarkInvite.empty")}</p>}
      {!directoryUnavailable && users.length > 0 && (
        <ul className="lark-invite-results">
          {users.map((user) => (
            <li key={user.id}>
              {user.avatar_url
                ? <img src={user.avatar_url} alt="" width={32} height={32} referrerPolicy="no-referrer" />
                : <span className="lark-invite-avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>}
              <span className="lark-invite-name">{user.name}</span>
              <button
                type="button"
                className="d-btn"
                data-lark-user-id={user.id}
                disabled={user.already_member || inviting === user.id}
                onClick={() => add(user)}
              >
                {user.already_member
                  ? t("LarkInvite.added")
                  : inviting === user.id
                    ? t("LarkInvite.inviting")
                    : t("LarkInvite.invite")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!directoryUnavailable && cursor !== null && (
        <button type="button" className="d-btn lark-invite-more" disabled={busy} onClick={() => runSearch(cursor)}>
          {t("LarkInvite.more")}
        </button>
      )}
    </section>
  );
}
