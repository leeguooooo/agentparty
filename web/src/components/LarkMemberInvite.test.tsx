// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { LarkDirectoryApiError, type LarkDirectoryPage } from "../lib/api";
import { LarkMemberInvite } from "./LarkMemberInvite";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "confirm");
});

test("searches and directly invites a Lark organization user", async () => {
  const invited: string[] = [];
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => ({ users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: false }], next_cursor: null })}
          invite={async (_token, _slug, id) => { invited.push(id); return { id, name: "Alice", avatar_url: null, already_member: false }; }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByProps({ "aria-label": "Search Lark organization" });
  act(() => input.props.onChange({ target: { value: "Alice" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  const button = renderer!.root.findByProps({ "data-lark-user-id": "on_alice" });
  await act(async () => button.props.onClick());
  expect(invited).toEqual(["on_alice"]);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Remove");
});

test("keeps the added member visible and reports a bot notification failure", async () => {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => ({ users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: false }], next_cursor: null })}
          invite={async (_token, _slug, id) => ({
            id,
            name: "Alice",
            avatar_url: null,
            already_member: false,
            notification_status: "failed",
          })}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByProps({ "aria-label": "Search Lark organization" });
  act(() => input.props.onChange({ target: { value: "Alice" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  await act(async () => renderer!.root.findByProps({ "data-lark-user-id": "on_alice" }).props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("Remove");
  expect(renderer!.root.findByProps({ role: "alert" }).children.join(" ")).toContain("bot could not send");
});

test("removes an existing member after confirmation and makes them inviteable again", async () => {
  const removed: string[] = [];
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: () => true });
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => ({ users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: true }], next_cursor: null })}
          remove={async (_token, _slug, id) => { removed.push(id); }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByProps({ "aria-label": "Search Lark organization" });
  act(() => input.props.onChange({ target: { value: "Alice" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  await act(async () => renderer!.root.findByProps({ "data-lark-user-id": "on_alice" }).props.onClick());
  expect(removed).toEqual(["on_alice"]);
  expect(renderer!.root.findByProps({ "data-lark-user-id": "on_alice" }).children.join(" ")).toContain("Invite");
});

test("serializes invitations until the active request finishes", async () => {
  let finishAlice!: () => void;
  const alicePending = new Promise<void>((resolve) => { finishAlice = resolve; });
  const invited: string[] = [];
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => ({
            users: [
              { id: "on_alice", name: "Alice", avatar_url: null, already_member: false },
              { id: "on_bob", name: "Bob", avatar_url: null, already_member: false },
            ],
            next_cursor: null,
          })}
          invite={async (_token, _slug, id) => {
            invited.push(id);
            if (id === "on_alice") await alicePending;
            return { id, name: id === "on_alice" ? "Alice" : "Bob", avatar_url: null, already_member: false };
          }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByProps({ "aria-label": "Search Lark organization" });
  act(() => input.props.onChange({ target: { value: "team" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  let aliceRequest!: Promise<void>;
  await act(async () => {
    aliceRequest = renderer!.root.findByProps({ "data-lark-user-id": "on_alice" }).props.onClick();
    await Promise.resolve();
  });
  const bob = renderer!.root.findByProps({ "data-lark-user-id": "on_bob" });
  expect(bob.props.disabled).toBe(true);
  await act(async () => bob.props.onClick());
  expect(invited).toEqual(["on_alice"]);
  await act(async () => {
    finishAlice();
    await aliceRequest;
  });
  expect(renderer!.root.findByProps({ "data-lark-user-id": "on_bob" }).props.disabled).toBe(false);
});

test("browses departments and directly invites a selected organization user", async () => {
  const browsed: string[] = [];
  const invited: string[] = [];
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          browse={async (_token, _slug, departmentId) => {
            const selectedDepartment = departmentId ?? "0";
            browsed.push(selectedDepartment);
            return selectedDepartment === "0"
              ? {
                  departments: [{ id: "od_app", name: "APP-Dev", parent_id: "0" }],
                  users: [],
                  next_department_cursor: null,
                  next_user_cursor: null,
                }
              : {
                  departments: [],
                  users: [{ id: "on_evan", name: "陈文捷", avatar_url: null, already_member: false }],
                  next_department_cursor: null,
                  next_user_cursor: null,
                };
          }}
          invite={async (_token, _slug, id) => {
            invited.push(id);
            return { id, name: "陈文捷", avatar_url: null, already_member: false };
          }}
        />
      </LocaleProvider>,
    );
  });
  await act(async () => renderer!.root.findByProps({ className: "d-btn lark-org-toggle" }).props.onClick());
  await act(async () => renderer!.root.findByProps({ "data-lark-department-id": "od_app" }).props.onClick());
  await act(async () => renderer!.root.findByProps({ "data-lark-user-id": "on_evan" }).props.onClick());
  expect(browsed).toEqual(["0", "od_app"]);
  expect(invited).toEqual(["on_evan"]);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Remove");
});

test("keeps name search available when department-name permission is missing", async () => {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          browse={async () => { throw new LarkDirectoryApiError("missing field", 503, "lark_department_permission_required", null); }}
        />
      </LocaleProvider>,
    );
  });
  await act(async () => renderer!.root.findByProps({ className: "d-btn lark-org-toggle" }).props.onClick());
  expect(renderer!.root.findAllByType("form")).toHaveLength(1);
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain("Department names are not enabled");
  expect(renderer!.root.findByProps({ className: "d-btn lark-org-toggle" }).props.disabled).toBe(true);
});

test("shows visible employees and keeps flat pagination usable while department names await approval", async () => {
  const flatModes: boolean[] = [];
  let calls = 0;
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          browse={async (_token, _slug, _departmentId, _limit, _departmentCursor, _userCursor, _departments, _users, flat) => {
            flatModes.push(flat ?? false);
            calls += 1;
            return {
              departments: [],
              users: [{ id: calls === 1 ? "on_evan" : "on_alice", name: calls === 1 ? "陈文捷" : "Alice", avatar_url: null, already_member: false }],
              next_department_cursor: null,
              next_user_cursor: calls === 1 ? "next" : null,
              department_names_available: false,
            };
          }}
        />
      </LocaleProvider>,
    );
  });
  await act(async () => renderer!.root.findByProps({ className: "d-btn lark-org-toggle" }).props.onClick());
  expect(renderer!.root.findByProps({ role: "status" }).children.join(" ")).toContain("awaiting admin approval");
  expect(renderer!.root.findByProps({ "data-lark-user-id": "on_evan" })).toBeTruthy();
  await act(async () => renderer!.root.findByProps({ className: "d-btn lark-invite-more" }).props.onClick());
  expect(renderer!.root.findByProps({ "data-lark-user-id": "on_alice" })).toBeTruthy();
  expect(flatModes).toEqual([false, true]);
});

test("renders Chinese labels and a contact-permission error", async () => {
  localStorage.setItem("ap_locale", "zh");
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => { throw new LarkDirectoryApiError("opaque upstream wording", 503, "lark_contact_permission_required", null); }}
        />
      </LocaleProvider>,
    );
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("搜索同组织成员");
  const input = renderer!.root.findByType("input");
  act(() => input.props.onChange({ target: { value: "张" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(JSON.stringify(renderer!.toJSON())).toContain("当前部署尚未开通 Lark 通讯录权限");
  expect(renderer!.root.findAllByType("form")).toHaveLength(0);
  expect(renderer!.root.findByProps({ role: "status" })).toBeTruthy();
});

test("does not disable directory actions for an ordinary 503 even when its message mentions permission", async () => {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => { throw new LarkDirectoryApiError("permission proxy failure", 503, "unavailable", null); }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByType("input");
  act(() => input.props.onChange({ target: { value: "Alice" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(renderer!.root.findAllByType("form")).toHaveLength(1);
  expect(renderer!.root.findByProps({ role: "alert" }).children).toContain("The Lark directory is unavailable.");
});

test("clears results and pagination when contact permission is revoked during load more", async () => {
  let searches = 0;
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => {
            searches += 1;
            if (searches === 1) {
              return {
                users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: false }],
                next_cursor: "next",
              };
            }
            throw new LarkDirectoryApiError("denied", 503, "lark_contact_permission_required", null);
          }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByType("input");
  act(() => input.props.onChange({ target: { value: "Alice" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(renderer!.root.findByProps({ "data-lark-user-id": "on_alice" })).toBeTruthy();
  await act(async () => renderer!.root.findByProps({ className: "d-btn lark-invite-more" }).props.onClick());
  expect(renderer!.root.findAllByProps({ "data-lark-user-id": "on_alice" })).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ className: "d-btn lark-invite-more" })).toHaveLength(0);
  expect(renderer!.root.findByProps({ role: "status" })).toBeTruthy();
});

test("deduplicates users returned through multiple department pages", async () => {
  let searches = 0;
  const cursors: Array<string | null> = [];
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async (_token, _slug, _query, _limit, cursor) => {
            searches += 1;
            cursors.push(cursor ?? null);
            return searches === 1
              ? {
                  users: [
                    { id: "on_alice", name: "Alice", avatar_url: null, already_member: false },
                    { id: "on_alice", name: "Alice duplicate", avatar_url: null, already_member: false },
                  ],
                  next_cursor: "next",
                }
              : {
                  users: [
                    { id: "on_alice", name: "Alice", avatar_url: null, already_member: false },
                    { id: "on_bob", name: "Bob", avatar_url: null, already_member: false },
                    { id: "on_bob", name: "Bob duplicate", avatar_url: null, already_member: false },
                  ],
                  next_cursor: null,
                };
          }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByType("input");
  act(() => input.props.onChange({ target: { value: "a" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  await act(async () => renderer!.root.findByProps({ className: "d-btn lark-invite-more" }).props.onClick());
  expect(renderer!.root.findAllByProps({ "data-lark-user-id": "on_alice" })).toHaveLength(1);
  expect(renderer!.root.findAllByProps({ "data-lark-user-id": "on_bob" })).toHaveLength(1);
  expect(cursors).toEqual([null, "next"]);
});

test("clears old results and pagination when the query changes", async () => {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async (_token, _slug, query) => query === "Alice"
            ? {
                users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: false }],
                next_cursor: "alice-next",
              }
            : {
                users: [{ id: "on_bob", name: "Bob", avatar_url: null, already_member: false }],
                next_cursor: null,
              }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByType("input");
  act(() => input.props.onChange({ target: { value: "Alice" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(renderer!.root.findByProps({ "data-lark-user-id": "on_alice" })).toBeTruthy();
  expect(renderer!.root.findByProps({ className: "d-btn lark-invite-more" })).toBeTruthy();

  act(() => input.props.onChange({ target: { value: "Bob" } }));
  expect(renderer!.root.findAllByProps({ "data-lark-user-id": "on_alice" })).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ className: "d-btn lark-invite-more" })).toHaveLength(0);
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(renderer!.root.findByProps({ "data-lark-user-id": "on_bob" })).toBeTruthy();
});

test("ignores a stale response after the query changes", async () => {
  let resolveAlice!: (page: LarkDirectoryPage) => void;
  const alicePage = new Promise<LarkDirectoryPage>((resolve) => { resolveAlice = resolve; });
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async (_token, _slug, query) => query === "Alice"
            ? alicePage
            : {
                users: [{ id: "on_bob", name: "Bob", avatar_url: null, already_member: false }],
                next_cursor: null,
              }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByType("input");
  act(() => input.props.onChange({ target: { value: "Alice" } }));
  let firstRequest!: Promise<void>;
  act(() => { firstRequest = renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  act(() => input.props.onChange({ target: { value: "Bob" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  resolveAlice({
    users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: false }],
    next_cursor: "stale-next",
  });
  await act(async () => { await firstRequest; });
  expect(renderer!.root.findAllByProps({ "data-lark-user-id": "on_alice" })).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ "data-lark-user-id": "on_bob" })).toHaveLength(1);
  expect(renderer!.root.findAllByProps({ className: "d-btn lark-invite-more" })).toHaveLength(0);
});

test("disables stale invite actions when contact permission is revoked during invite", async () => {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => ({
            users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: false }],
            next_cursor: null,
          })}
          invite={async () => { throw new LarkDirectoryApiError("denied", 503, "lark_contact_permission_required", null); }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByType("input");
  act(() => input.props.onChange({ target: { value: "Alice" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  await act(async () => renderer!.root.findByProps({ "data-lark-user-id": "on_alice" }).props.onClick());
  expect(renderer!.root.findAllByProps({ "data-lark-user-id": "on_alice" })).toHaveLength(0);
  expect(renderer!.root.findByProps({ role: "status" })).toBeTruthy();
});
