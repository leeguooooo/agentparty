// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";

// #593 外部邀请落地页：未登录展示预览+登录按钮；已登录自动兑换；失效态只展示不给按钮。
let previewResult: Record<string, unknown> | null = null;
const redeemCalls: Array<{ token: string; code: string }> = [];
let redeemError: Error | null = null;
const loginCalls: string[] = [];

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  ValidationError: class ValidationError extends Error {},
  getInvitePreview: async () => {
    if (previewResult === null) throw new Error("preview failed");
    return previewResult;
  },
  redeemExternalInvite: async (token: string, code: string) => {
    redeemCalls.push({ token, code });
    if (redeemError) throw redeemError;
    return { channel_slug: "devchan", handle: "alice", joined: true };
  },
}));

mock.module("../lib/oidc", () => ({
  beginLogin: async (provider: { id: string }) => {
    loginCalls.push(provider.id);
  },
}));

const { InviteLanding } = await import("./InviteLanding");

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  previewResult = { channel_slug: "devchan", channel_title: "Dev Channel", preset_handle: "alice", state: "pending" };
  redeemCalls.length = 0;
  redeemError = null;
  loginCalls.length = 0;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const OIDC_PROVIDER = { type: "oidc" as const, id: "@oidc" as const, label: "", issuer: "https://idp", clientId: "web" };

function render(props: Partial<Parameters<typeof InviteLanding>[0]> = {}) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <InviteLanding
          code="ext123"
          token={null}
          providers={[OIDC_PROVIDER]}
          providersResolved={true}
          onBeforeLogin={() => {}}
          onLoginFailed={() => {}}
          onRedeemed={() => {}}
          onAuthFailed={() => {}}
          {...props}
        />
      </LocaleProvider>,
    );
  });
  return renderer as ReactTestRenderer;
}

describe("InviteLanding (#593)", () => {
  test("logged out: shows channel + preset nickname preview and a provider button; no redeem attempt", async () => {
    const r = render();
    await act(async () => {});
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Dev Channel");
    expect(text).toContain("alice"); // JSX 子节点为 ["@","alice"]，序列化后不含连写的 "@alice"
    expect(redeemCalls).toEqual([]);

    const beforeLogin: string[] = [];
    act(() => r.unmount());
    renderer = null;
    const r2 = render({ onBeforeLogin: () => beforeLogin.push("stored") });
    await act(async () => {});
    const btn = r2.root.findAll((n) => n.type === "button")[0]!;
    await act(async () => {
      (btn.props.onClick as () => void)();
    });
    expect(beforeLogin).toEqual(["stored"]); // 先落 pending code 再跳登录
    expect(loginCalls).toEqual(["@oidc"]);
  });

  test("logged in: auto-redeems and reports the joined channel", async () => {
    const redeemed: string[] = [];
    render({ token: "ap_guest", onRedeemed: (slug) => redeemed.push(slug) });
    await act(async () => {});
    expect(redeemCalls).toEqual([{ token: "ap_guest", code: "ext123" }]);
    expect(redeemed).toEqual(["devchan"]);
  });

  test("dead invite states render as a message, not a sign-in button", async () => {
    previewResult = { channel_slug: "devchan", channel_title: null, preset_handle: "alice", state: "redeemed" };
    const r = render();
    await act(async () => {});
    expect(r.root.findAll((n) => n.type === "button")).toHaveLength(0);
    expect(JSON.stringify(r.toJSON())).toContain("banner--red");
  });
});
