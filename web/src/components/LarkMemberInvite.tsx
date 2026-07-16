import { useRef, useState, type FormEvent } from "react";
import {
  browseLarkOrganization,
  inviteLarkMember,
  LarkDirectoryApiError,
  removeLarkMember,
  searchLarkDirectory,
  type LarkDirectoryPage,
  type LarkDirectoryUser,
  type LarkDepartment,
} from "../lib/api";
import { useT } from "../i18n/useT";
import "../i18n/strings/LarkMemberInvite";
import "./LarkMemberInvite.css";

interface Props {
  slug: string;
  token: string;
  search?: typeof searchLarkDirectory;
  browse?: typeof browseLarkOrganization;
  invite?: typeof inviteLarkMember;
  remove?: typeof removeLarkMember;
  onInvited?(user: LarkDirectoryUser): void;
  onRemoved?(user: LarkDirectoryUser): void;
}

export function LarkMemberInvite({
  slug,
  token,
  search = searchLarkDirectory,
  browse = browseLarkOrganization,
  invite = inviteLarkMember,
  remove = removeLarkMember,
  onInvited,
  onRemoved,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<LarkDirectoryUser[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const invitingUser = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeQuery = useRef("");
  const queryVersion = useRef(0);
  // #382：部署未开通 Lark 通讯录权限时，撞一次就记住——之后禁用搜索并持久提示，
  // 不让用户反复搜了才报错。权限是 owner 在 Lark 后台配置项，前端只能优雅降级。
  const [directoryUnavailable, setDirectoryUnavailable] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [organizationPath, setOrganizationPath] = useState<LarkDepartment[]>([]);
  const [departments, setDepartments] = useState<LarkDepartment[]>([]);
  const [organizationUsers, setOrganizationUsers] = useState<LarkDirectoryUser[]>([]);
  const [departmentCursor, setDepartmentCursor] = useState<string | null>(null);
  const [userCursor, setUserCursor] = useState<string | null>(null);
  const [organizationBusy, setOrganizationBusy] = useState(false);
  const [organizationUnavailable, setOrganizationUnavailable] = useState(false);
  const [organizationLimited, setOrganizationLimited] = useState(false);
  const organizationVersion = useRef(0);

  function isDirectoryPermissionError(cause: unknown): boolean {
    return (
      cause instanceof LarkDirectoryApiError &&
      cause.code === "lark_contact_permission_required"
    );
  }

  function isDepartmentPermissionError(cause: unknown): boolean {
    return cause instanceof LarkDirectoryApiError && cause.code === "lark_department_permission_required";
  }

  function disableDirectoryActions() {
    setDirectoryUnavailable(true);
    setUsers([]);
    setCursor(null);
    setSearched(false);
    setError(null);
    setOrganizationOpen(false);
    setOrganizationPath([]);
    setDepartments([]);
    setOrganizationUsers([]);
    setDepartmentCursor(null);
    setUserCursor(null);
    setOrganizationUnavailable(false);
    setOrganizationLimited(false);
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
    const version = queryVersion.current;
    setBusy(true);
    setError(null);
    try {
      const page: LarkDirectoryPage = await search(token, slug, normalized, 20, nextCursor);
      if (version !== queryVersion.current || normalized !== activeQuery.current) return;
      setUsers((current) => {
        const merged = nextCursor === null ? [] : [...current];
        const known = new Set(merged.map((user) => user.id));
        for (const user of page.users) {
          if (known.has(user.id)) continue;
          known.add(user.id);
          merged.push(user);
        }
        return merged;
      });
      setCursor(page.next_cursor);
      setSearched(true);
    } catch (cause) {
      if (version !== queryVersion.current || normalized !== activeQuery.current) return;
      if (isDirectoryPermissionError(cause)) disableDirectoryActions();
      else setError(errorLabel(cause, "LarkInvite.error.search"));
    } finally {
      if (version === queryVersion.current && normalized === activeQuery.current) setBusy(false);
    }
  }

  function changeQuery(value: string) {
    setQuery(value);
    const normalized = value.trim();
    if (normalized === activeQuery.current) return;
    activeQuery.current = normalized;
    queryVersion.current += 1;
    setUsers([]);
    setCursor(null);
    setSearched(false);
    setError(null);
    setBusy(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await runSearch(null);
  }

  async function add(user: LarkDirectoryUser) {
    if (invitingUser.current !== null) return;
    invitingUser.current = user.id;
    setInviting(user.id);
    setError(null);
    try {
      const added = await invite(token, slug, user.id);
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, already_member: true } : item));
      setOrganizationUsers((current) => current.map((item) => item.id === user.id ? { ...item, already_member: true } : item));
      onInvited?.(added);
      if (added.notification_status === "failed") setError(t("LarkInvite.error.notification"));
    } catch (cause) {
      if (isDirectoryPermissionError(cause)) disableDirectoryActions();
      else setError(errorLabel(cause, "LarkInvite.error.invite"));
    } finally {
      if (invitingUser.current === user.id) invitingUser.current = null;
      setInviting((current) => current === user.id ? null : current);
    }
  }

  async function removeUser(user: LarkDirectoryUser) {
    if (invitingUser.current !== null) return;
    if (!globalThis.confirm(t("LarkInvite.removeConfirm", { name: user.name }))) return;
    invitingUser.current = user.id;
    setInviting(user.id);
    setError(null);
    try {
      await remove(token, slug, user.id);
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, already_member: false } : item));
      setOrganizationUsers((current) => current.map((item) => item.id === user.id ? { ...item, already_member: false } : item));
      onRemoved?.(user);
    } catch (cause) {
      if (isDirectoryPermissionError(cause)) disableDirectoryActions();
      else setError(errorLabel(cause, "LarkInvite.error.remove"));
    } finally {
      if (invitingUser.current === user.id) invitingUser.current = null;
      setInviting((current) => current === user.id ? null : current);
    }
  }

  function mergeUsers(current: LarkDirectoryUser[], incoming: LarkDirectoryUser[]): LarkDirectoryUser[] {
    const merged = [...current];
    const known = new Set(merged.map((user) => user.id));
    for (const user of incoming) {
      if (!known.has(user.id)) merged.push(user);
      known.add(user.id);
    }
    return merged;
  }

  async function loadOrganization(
    departmentId: string,
    mode: "replace" | "departments" | "users" = "replace",
  ) {
    const version = mode === "replace" ? ++organizationVersion.current : organizationVersion.current;
    setOrganizationBusy(true);
    setError(null);
    if (mode === "replace") {
      setDepartments([]);
      setOrganizationUsers([]);
      setDepartmentCursor(null);
      setUserCursor(null);
      setOrganizationLimited(false);
    }
    try {
      const page = await browse(
        token,
        slug,
        departmentId,
        50,
        mode === "departments" ? departmentCursor : null,
        mode === "users" ? userCursor : null,
        mode !== "users",
        mode !== "departments",
        organizationLimited && mode !== "replace",
      );
      if (version !== organizationVersion.current) return;
      if (mode !== "users") {
        setDepartments((current) => mode === "replace" ? page.departments : [...current, ...page.departments]);
        setDepartmentCursor(page.next_department_cursor);
      }
      if (mode !== "departments") {
        setOrganizationUsers((current) => mode === "replace" ? page.users : mergeUsers(current, page.users));
        setUserCursor(page.next_user_cursor);
      }
      if (mode === "replace") setOrganizationLimited(page.department_names_available === false);
    } catch (cause) {
      if (version !== organizationVersion.current) return;
      if (isDirectoryPermissionError(cause)) disableDirectoryActions();
      else if (isDepartmentPermissionError(cause)) {
        setOrganizationUnavailable(true);
        setOrganizationOpen(false);
        setDepartments([]);
        setOrganizationUsers([]);
        setDepartmentCursor(null);
        setUserCursor(null);
      } else setError(errorLabel(cause, "LarkInvite.error.browse"));
    } finally {
      if (version === organizationVersion.current) setOrganizationBusy(false);
    }
  }

  function toggleOrganization() {
    if (organizationOpen) {
      setOrganizationOpen(false);
      return;
    }
    setOrganizationOpen(true);
    setOrganizationPath([]);
    void loadOrganization("0");
  }

  function selectDepartment(department: LarkDepartment) {
    setOrganizationPath((current) => [...current, department]);
    void loadOrganization(department.id);
  }

  function selectBreadcrumb(index: number) {
    const nextPath = index < 0 ? [] : organizationPath.slice(0, index + 1);
    setOrganizationPath(nextPath);
    void loadOrganization(nextPath.at(-1)?.id ?? "0");
  }

  function userList(items: LarkDirectoryUser[], className = "lark-invite-results") {
    return (
      <ul className={className}>
        {items.map((user) => (
          <li key={user.id}>
            {user.avatar_url
              ? <img src={user.avatar_url} alt="" width={32} height={32} referrerPolicy="no-referrer" />
              : <span className="lark-invite-avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>}
            <span className="lark-invite-name">{user.name}</span>
            <button
              type="button"
              className={`d-btn${user.already_member ? " lark-remove" : ""}`}
              data-lark-user-id={user.id}
              disabled={inviting !== null}
              onClick={() => user.already_member ? removeUser(user) : add(user)}
            >
              {inviting === user.id
                ? t(user.already_member ? "LarkInvite.removing" : "LarkInvite.inviting")
                : t(user.already_member ? "LarkInvite.remove" : "LarkInvite.invite")}
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="lark-invite" aria-labelledby="lark-invite-title">
      <h3 id="lark-invite-title">{t("LarkInvite.title")}</h3>
      {directoryUnavailable ? (
        // #382 优雅降级：权限未开通，持久提示 + 不再显示可徒劳操作的搜索框。
        <p className="lark-invite-unavailable" role="status">{t("LarkInvite.unavailable")}</p>
      ) : (
        <>
          <button type="button" className="d-btn lark-org-toggle" disabled={organizationUnavailable} onClick={toggleOrganization}>
            {organizationOpen ? t("LarkInvite.organization.hide") : t("LarkInvite.organization.show")}
          </button>
          {organizationUnavailable && (
            <p className="lark-invite-unavailable" role="status">{t("LarkInvite.organization.unavailable")}</p>
          )}
          {organizationOpen && (
            <section className="lark-org-browser" aria-label={t("LarkInvite.organization.label")}>
              <nav className="lark-org-breadcrumbs" aria-label={t("LarkInvite.organization.breadcrumbs")}>
                <button type="button" onClick={() => selectBreadcrumb(-1)}>{t("LarkInvite.organization.root")}</button>
                {organizationPath.map((department, index) => (
                  <button type="button" key={department.id} onClick={() => selectBreadcrumb(index)}>{department.name}</button>
                ))}
              </nav>
              {organizationLimited && (
                <p className="lark-invite-unavailable" role="status">{t("LarkInvite.organization.limited")}</p>
              )}
              {organizationBusy && departments.length === 0 && organizationUsers.length === 0 && (
                <p className="lark-invite-empty" role="status">{t("LarkInvite.organization.loading")}</p>
              )}
              {departments.length > 0 && (
                <ul className="lark-org-departments">
                  {departments.map((department) => (
                    <li key={department.id}>
                      <button type="button" data-lark-department-id={department.id} onClick={() => selectDepartment(department)}>
                        <span aria-hidden="true">▸</span>{department.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {departmentCursor !== null && (
                <button type="button" className="d-btn lark-invite-more" disabled={organizationBusy} onClick={() => loadOrganization(organizationPath.at(-1)?.id ?? "0", "departments")}>
                  {t("LarkInvite.organization.moreDepartments")}
                </button>
              )}
              {organizationUsers.length > 0 && userList(organizationUsers, "lark-invite-results lark-org-users")}
              {!organizationBusy && !organizationUnavailable && departments.length === 0 && organizationUsers.length === 0 && (
                <p className="lark-invite-empty">{t("LarkInvite.organization.empty")}</p>
              )}
              {userCursor !== null && (
                <button type="button" className="d-btn lark-invite-more" disabled={organizationBusy} onClick={() => loadOrganization(organizationPath.at(-1)?.id ?? "0", "users")}>
                  {t("LarkInvite.organization.morePeople")}
                </button>
              )}
            </section>
          )}
          <p className="lark-invite-or">{t("LarkInvite.orSearch")}</p>
          <form className="lark-invite-search" onSubmit={submit}>
            <input
              type="search"
              value={query}
              maxLength={64}
              aria-label={t("LarkInvite.searchLabel")}
              placeholder={t("LarkInvite.placeholder")}
              onChange={(event) => changeQuery(event.target.value)}
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
        userList(users)
      )}
      {!directoryUnavailable && cursor !== null && (
        <button type="button" className="d-btn lark-invite-more" disabled={busy} onClick={() => runSearch(cursor)}>
          {t("LarkInvite.more")}
        </button>
      )}
    </section>
  );
}
