// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";

// 桩掉 ../lib/api：只 redeemJoinLink + AuthError 会被组件用到。解析/校验走真实的 lib/invitePaste。
const redeemCalls: Array<{ token: string; code: string }> = [];
let redeemImpl: (token: string, code: string) => Promise<{ channel_slug: string; joined: boolean }> = async () => ({
  channel_slug: "secret-room",
  joined: true,
});

class AuthError extends Error {}

mock.module("../lib/api", () => ({
  AuthError,
  redeemJoinLink: mock(async (token: string, code: string) => {
    redeemCalls.push({ token, code });
    return redeemImpl(token, code);
  }),
}));

const { DesktopInvitePaste } = await import("./DesktopInvitePaste");

const ALLOWED = ["https://agentparty.leeguoo.com", "https://agentparty.pwtk-dev.work"] as const;

let renderer: ReactTestRenderer | null = null;
const joined: string[] = [];
const authFailures: string[] = [];

beforeEach(() => {
  redeemCalls.length = 0;
  joined.length = 0;
  authFailures.length = 0;
  redeemImpl = async () => ({ channel_slug: "secret-room", joined: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (k === "ap_locale" ? "en" : null),
      setItem: () => {},
      removeItem: () => {},
    },
  });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
});

async function render(activeOrigin = "https://agentparty.leeguoo.com"): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      <LocaleProvider>
        <DesktopInvitePaste
          token="desk-token"
          activeOrigin={activeOrigin}
          allowedOrigins={ALLOWED}
          onJoined={(slug) => joined.push(slug)}
          onAuthFailed={(m) => authFailures.push(m)}
        />
      </LocaleProvider>,
    );
  });
  renderer = r;
  return r;
}

function type(r: ReactTestRenderer, value: string): void {
  const input = r.root.find((n) => n.props.className === "invitepaste-input t-mono");
  act(() => input.props.onChange({ target: { value } }));
}

async function clickJoin(r: ReactTestRenderer): Promise<void> {
  const button = r.root.find((n) => typeof n.props.className === "string" && n.props.className.includes("invitepaste-join"));
  await act(async () => {
    await button.props.onClick();
  });
}

function errorText(r: ReactTestRenderer): string | null {
  const node = r.root.findAll((n) => n.props.className === "invitepaste-error")[0];
  return node ? String(node.props.children) : null;
}

describe("DesktopInvitePaste", () => {
  test("redeems a valid join link on the active server and reports the joined channel", async () => {
    const r = await render();
    type(r, "https://agentparty.leeguoo.com/join/abc123");
    await clickJoin(r);
    expect(redeemCalls).toEqual([{ token: "desk-token", code: "abc123" }]);
    expect(joined).toEqual(["secret-room"]);
    expect(errorText(r)).toBeNull();
  });

  test("opens a channel share link directly without redeeming", async () => {
    const r = await render();
    type(r, "https://agentparty.leeguoo.com/c/general?t=share");
    await clickJoin(r);
    expect(redeemCalls).toEqual([]);
    expect(joined).toEqual(["general"]);
  });

  test("shows an error and never redeems a malformed paste", async () => {
    const r = await render();
    type(r, "https://evil.example/join/abc123");
    await clickJoin(r);
    expect(redeemCalls).toEqual([]);
    expect(joined).toEqual([]);
    expect(errorText(r)).toContain("valid AgentParty invite link");
  });

  test("refuses an invite meant for a different server", async () => {
    const r = await render("https://agentparty.pwtk-dev.work");
    type(r, "https://agentparty.leeguoo.com/join/abc123");
    await clickJoin(r);
    expect(redeemCalls).toEqual([]);
    expect(joined).toEqual([]);
    expect(errorText(r)).toContain("different server");
  });

  test("surfaces a redeem failure and routes auth failures to session restore", async () => {
    redeemImpl = async () => {
      throw new AuthError("invalid or revoked token");
    };
    const r = await render();
    type(r, "https://agentparty.leeguoo.com/join/abc123");
    await clickJoin(r);
    expect(joined).toEqual([]);
    expect(authFailures).toEqual(["invalid or revoked token"]);
    expect(errorText(r)).toContain("invalid or revoked token");
  });
});
