// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { LarkDirectoryApiError } from "../lib/api";
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
afterEach(() => { act(() => renderer?.unmount()); renderer = null; });

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
  expect(JSON.stringify(renderer!.toJSON())).toContain("Added");
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
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => {
            searches += 1;
            return searches === 1
              ? {
                  users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: false }],
                  next_cursor: "next",
                }
              : {
                  users: [
                    { id: "on_alice", name: "Alice", avatar_url: null, already_member: false },
                    { id: "on_bob", name: "Bob", avatar_url: null, already_member: false },
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
