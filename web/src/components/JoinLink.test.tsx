// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";

// 观看/参与模式选择必须把模式接进 create 调用（#186）：
//   participate → createJoinLink，watch → createShareLink。整体桩掉 ../lib/api，不打网络。
const joinCalls: Array<{ slug: string }> = [];
const shareCalls: Array<{ slug: string }> = [];
const externalCalls: Array<{ slug: string; handle: string }> = [];
const externalRevokeCalls: Array<{ code: string }> = [];
let externalInvitesList: Array<Record<string, unknown>> = [];
const reviewCalls: Array<{ id: string | number; body: { action: "approve" } | { action: "reject"; reason: string } }> = [];
let pendingRequests: Array<{ id: string | number; state: string; requester_name: string; requester_handle?: string; note: string | null }> = [];
let pendingError: Error | null = null;
let joinLinksList: Array<Record<string, unknown>> = [];

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  ValidationError: class ValidationError extends Error {},
  LarkDirectoryApiError: class LarkDirectoryApiError extends Error {},
  createJoinLink: mock(async (_token: string, slug: string) => {
    joinCalls.push({ slug });
    return { code: "abc123", url: "https://x/join/abc123", channel_slug: slug, created_by: "o", created_at: 0, expires_at: null, max_uses: null, uses: 0, revoked_at: null };
  }),
  createShareLink: mock(async (_token: string, slug: string) => {
    shareCalls.push({ slug });
    return { name: "watch_deadbeef", created_at: 0, url: `https://x/c/${slug}?t=ap_watchtoken`, token: "ap_watchtoken" };
  }),
  listJoinLinks: async () => joinLinksList,
  listShareLinks: async () => [],
  listChannelJoinRequests: async () => {
    if (pendingError) throw pendingError;
    return pendingRequests;
  },
  reviewChannelJoinRequest: async (_token: string, _slug: string, id: string | number, body: { action: "approve" } | { action: "reject"; reason: string }) => {
    reviewCalls.push({ id, body });
    pendingRequests = pendingRequests.filter((request) => request.id !== id);
    return { id, state: body.action === "approve" ? "approved" : "rejected" };
  },
  searchLarkDirectory: async () => ({ users: [], next_cursor: null }),
  browseLarkOrganization: async () => ({
    departments: [],
    users: [],
    next_department_cursor: null,
    next_user_cursor: null,
  }),
  inviteLarkMember: async () => ({ id: "", name: "", avatar_url: null, already_member: true }),
  removeLarkMember: async () => {},
  revokeJoinLink: async () => {},
  revokeShareLink: async () => {},
  createExternalInvite: mock(async (_token: string, slug: string, opts: { handle: string }) => {
    externalCalls.push({ slug, handle: opts.handle });
    return {
      code: "ext123",
      url: "https://x/invite/ext123",
      channel_slug: slug,
      preset_handle: opts.handle,
      created_by: "o",
      created_at: 0,
      expires_at: null,
      redeemed_by: null,
      redeemed_at: null,
      revoked_at: null,
    };
  }),
  listExternalInvites: async () => externalInvitesList,
  revokeExternalInvite: async (_token: string, _slug: string, code: string) => {
    externalRevokeCalls.push({ code });
  },
}));

const { JoinLink } = await import("./JoinLink");
const { setApiBase, clearApiBase } = await import("../lib/base");

let renderer: ReactTestRenderer | null = null;
let windowEvents: TestEventTarget;
let documentEvents: TestEventTarget;
const insideTarget = {};

class TestEventTarget {
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

beforeEach(() => {
  joinCalls.length = 0;
  shareCalls.length = 0;
  externalCalls.length = 0;
  externalRevokeCalls.length = 0;
  externalInvitesList = [];
  reviewCalls.length = 0;
  pendingRequests = [
    { id: "jr_1", state: "pending", requester_name: "Alice", requester_handle: "alice", note: "I can help" },
  ];
  pendingError = null;
  joinLinksList = [];
  clearApiBase();
  windowEvents = new TestEventTarget();
  documentEvents = new TestEventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowEvents });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentEvents });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

function render(props: { active?: boolean; onActiveChange?(open: boolean): void; larkDirectoryEnabled?: boolean } = { active: true }) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <JoinLink slug="devchan" token="ap_owner" onAuthFailed={() => {}} {...props} />
      </LocaleProvider>,
      {
        createNodeMock(element) {
          if ((element.props as { className?: string }).className === "joinlink") {
            return { contains: (target: unknown) => target === insideTarget };
          }
          return {};
        },
      },
    );
  });
  return renderer as ReactTestRenderer;
}

function clickPrimary(r: ReactTestRenderer) {
  const btn = r.root.findAll((n) => n.type === "button" && String(n.props.className ?? "").includes("d-btn--primary"))[0]!;
  act(() => {
    (btn.props.onClick as () => void)();
  });
}

describe("JoinLink invite mode selector", () => {
  test("shows the organization directory only when Lark invitation is enabled", async () => {
    const disabled = render();
    await act(async () => {});
    expect(disabled.root.findAllByProps({ className: "lark-invite" })).toHaveLength(0);
    act(() => disabled.unmount());
    renderer = null;

    const enabled = render({ active: true, larkDirectoryEnabled: true });
    await act(async () => {});
    expect(enabled.root.findByProps({ className: "lark-invite" })).toBeTruthy();
  });

  test("default participate mode wires generate into createJoinLink", async () => {
    const r = render();
    clickPrimary(r);
    await act(async () => {});
    expect(joinCalls).toEqual([{ slug: "devchan" }]);
    expect(shareCalls).toEqual([]);
  });

  test("listed links without url fall back to the API origin, not the desktop custom scheme", async () => {
    // 桌面版(Tauri)里 location.origin 是 agentparty-ui://localhost；列表兜底必须拼真实后端 origin。
    setApiBase("https://party.example");
    joinLinksList = [
      { code: "zzz", channel_slug: "devchan", created_by: "o", created_at: 0, expires_at: null, max_uses: null, uses: 0, revoked_at: null },
    ];
    const r = render();
    clickPrimary(r); // generate → refresh → listJoinLinks
    await act(async () => {});
    const urls = r.root
      .findAllByProps({ className: "joinlink-url t-mono" })
      .map((node) => node.children.join(""));
    expect(urls).toContain("https://party.example/join/zzz");
  });

  test("selecting watch mode wires generate into createShareLink (readonly), not createJoinLink", async () => {
    const r = render();
    const watchRadio = r.root.findAll((n) => n.type === "input" && n.props.value === "watch")[0]!;
    await act(async () => {
      (watchRadio.props.onChange as () => void)();
    });
    clickPrimary(r);
    await act(async () => {});
    expect(shareCalls).toEqual([{ slug: "devchan" }]);
    expect(joinCalls).toEqual([]);
  });

  // #593 外部协作者：昵称必填且合法才可生成；生成走 createExternalInvite 而非另两条通道
  test("external mode requires a valid nickname, then wires generate into createExternalInvite", async () => {
    const r = render();
    const externalRadio = r.root.findAll((n) => n.type === "input" && n.props.value === "external")[0]!;
    await act(async () => {
      (externalRadio.props.onChange as () => void)();
    });
    const primary = () =>
      r.root.findAll((n) => n.type === "button" && String(n.props.className ?? "").includes("d-btn--primary"))[0]!;
    // 昵称为空 → 生成按钮禁用
    expect(primary().props.disabled).toBe(true);

    const nicknameInput = r.root.findAll(
      (n) => n.type === "input" && String(n.props.className ?? "").includes("joinlink-nickname-input"),
    )[0]!;
    await act(async () => {
      (nicknameInput.props.onChange as (e: unknown) => void)({ target: { value: "中文" } });
    });
    expect(primary().props.disabled).toBe(true); // 非 ASCII handle 不放行

    await act(async () => {
      (nicknameInput.props.onChange as (e: unknown) => void)({ target: { value: "alice" } });
    });
    expect(primary().props.disabled).toBe(false);
    clickPrimary(r);
    await act(async () => {});
    expect(externalCalls).toEqual([{ slug: "devchan", handle: "alice" }]);
    expect(joinCalls).toEqual([]);
    expect(shareCalls).toEqual([]);
  });

  // #593：pending 邀请可复制/撤销；已兑换的只留档（不可复制、不可撤销）
  test("external list shows pending invites with revoke, redeemed ones as archive", async () => {
    externalInvitesList = [
      {
        code: "pend01",
        url: "https://x/invite/pend01",
        channel_slug: "devchan",
        preset_handle: "alice",
        created_by: "o",
        created_at: 0,
        expires_at: null,
        redeemed_by: null,
        redeemed_at: null,
        revoked_at: null,
      },
      {
        code: "used01",
        url: "https://x/invite/used01",
        channel_slug: "devchan",
        preset_handle: "bob",
        created_by: "o",
        created_at: 0,
        expires_at: null,
        redeemed_by: "ext-bob@example.com",
        redeemed_at: 1,
        revoked_at: null,
      },
    ];
    const r = render();
    const externalRadio = r.root.findAll((n) => n.type === "input" && n.props.value === "external")[0]!;
    await act(async () => {
      (externalRadio.props.onChange as () => void)();
    });
    await act(async () => {});
    const urls = r.root.findAllByProps({ className: "joinlink-url t-mono" }).map((node) => node.children.join(""));
    expect(urls).toContain("https://x/invite/pend01");
    expect(urls).toContain("@bob"); // 已兑换：不再展示链接，只留昵称档

    const revokeButtons = r.root.findAll(
      (n) => n.type === "button" && String(n.props.className ?? "").includes("joinlink-revoke"),
    );
    expect(revokeButtons).toHaveLength(1); // 只有 pending 那条可撤销
    await act(async () => {
      (revokeButtons[0]!.props.onClick as () => void)();
    });
    expect(externalRevokeCalls).toEqual([{ code: "pend01" }]);
  });
});

describe("JoinLink dismiss behavior", () => {
  test("exposes the open panel as a modal dialog", () => {
    const r = render();
    const panel = r.root.find((node) => node.props.className === "joinlink-panel");
    expect(panel.props.role).toBe("dialog");
    expect(panel.props["aria-modal"]).toBe("true");
  });

  test("Escape and an outside pointer press request controlled close, while an inside press does not", () => {
    const changes: boolean[] = [];
    render({ active: true, onActiveChange: (open) => changes.push(open) });

    act(() => documentEvents.emit("pointerdown", { target: insideTarget }));
    expect(changes).toEqual([]);

    act(() => documentEvents.emit("pointerdown", { target: {} }));
    expect(changes).toEqual([false]);

    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(changes).toEqual([false, false]);
  });

  test("uncontrolled close resets panel-only mode and removes global listeners", async () => {
    const r = render({});
    const trigger = r.root.find((node) => node.props.className === "d-btn joinlink-btn");
    await act(async () => trigger.props.onClick());
    const watchRadio = r.root.find((node) => node.type === "input" && node.props.value === "watch");
    await act(async () => watchRadio.props.onChange());

    expect(windowEvents.count("keydown")).toBe(1);
    expect(documentEvents.count("pointerdown")).toBe(1);
    act(() => documentEvents.emit("pointerdown", { target: {} }));
    expect(windowEvents.count("keydown")).toBe(0);
    expect(documentEvents.count("pointerdown")).toBe(0);

    act(() => trigger.props.onClick());
    const participateRadio = r.root.find((node) => node.type === "input" && node.props.value === "participate");
    expect(participateRadio.props.checked).toBe(true);
  });
});

describe("JoinLink join request moderation", () => {
  test("shows the pending count and approves a request", async () => {
    const r = render();
    await act(async () => {});

    expect(r.root.findByProps({ className: "joinrequest-count" }).children.join("")).toContain("1");
    const approve = r.root.findByProps({ className: "d-btn d-btn--primary joinrequest-approve" });
    await act(async () => approve.props.onClick());

    expect(reviewCalls).toEqual([{ id: "jr_1", body: { action: "approve" } }]);
    expect(r.root.findAllByProps({ className: "joinrequest-item" })).toHaveLength(0);
  });

  test("collects an inline reason before rejecting", async () => {
    const r = render();
    await act(async () => {});

    await act(async () => r.root.findByProps({ className: "d-btn joinrequest-reject" }).props.onClick());
    const reason = r.root.findByProps({ className: "joinrequest-reason" });
    await act(async () => reason.props.onChange({ target: { value: "  channel is full  " } }));
    await act(async () => r.root.findByProps({ className: "d-btn joinrequest-reject-confirm" }).props.onClick());

    expect(reviewCalls).toEqual([{ id: "jr_1", body: { action: "reject", reason: "channel is full" } }]);
  });
  test("renders empty and retry states", async () => {
    pendingRequests = [];
    const empty = render();
    await act(async () => {});
    expect(empty.root.findByProps({ className: "joinrequest-empty" })).toBeTruthy();
    act(() => empty.unmount());
    renderer = null;

    pendingError = new Error("offline");
    const failed = render();
    await act(async () => {});
    expect(failed.root.findByProps({ className: "joinrequest-error" })).toBeTruthy();
    pendingError = null;
    await act(async () => failed.root.findByProps({ className: "d-btn joinrequest-retry" }).props.onClick());
    expect(failed.root.findByProps({ className: "joinrequest-empty" })).toBeTruthy();
  });
});
