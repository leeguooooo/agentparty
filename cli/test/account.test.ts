// party login/logout/whoami/agent add + 账号会话 bearer 优先与自动刷新
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountPath, readAccount, writeAccount, clearAccount } from "../src/account";
import { writeConfig } from "../src/config";
import {
  challengeFor,
  decodeJwtPayload,
  ensureFreshAccess,
  exchangeCode,
  loginFlow,
  makeVerifier,
  refreshTokens,
  resolveAuth,
} from "../src/oidc-cli";
import { createHash } from "node:crypto";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-acct-"));
  process.env.AGENTPARTY_HOME = home;
});

afterEach(() => {
  delete process.env.AGENTPARTY_HOME;
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

describe("account storage", () => {
  test("write/read roundtrip + 0600", () => {
    expect(readAccount()).toBeNull();
    writeAccount({ server: "https://ap.example.com", refresh_token: "ref-x", email: "a@b.c" });
    expect(readAccount()).toEqual({
      server: "https://ap.example.com",
      refresh_token: "ref-x",
      email: "a@b.c",
    });
    expect(statSync(accountPath()).mode & 0o777).toBe(0o600);
  });

  test("clear returns whether a session existed", () => {
    expect(clearAccount()).toBe(false);
    writeAccount({ server: "s", refresh_token: "r" });
    expect(clearAccount()).toBe(true);
    expect(readAccount()).toBeNull();
  });
});

describe("pkce + jwt helpers", () => {
  test("challenge = base64url(sha256(verifier))", () => {
    const v = makeVerifier();
    const expected = createHash("sha256").update(v).digest("base64url");
    expect(challengeFor(v)).toBe(expected);
    expect(v).not.toContain("=");
    expect(v).not.toContain("+");
  });

  test("decodeJwtPayload reads claims, tolerates junk", () => {
    const jwt = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "u1", email: "x@y.z" }),
    ).toString("base64url")}.sig`;
    expect(decodeJwtPayload(jwt)).toEqual({ sub: "u1", email: "x@y.z" });
    expect(decodeJwtPayload("not-a-jwt")).toEqual({});
  });
});

describe("token exchange + refresh", () => {
  test("exchangeCode posts authorization_code with verifier", async () => {
    mock = startOidcMock();
    const t = await exchangeCode(mock.url, "agentparty-cli", "the-code", "http://127.0.0.1:8976/callback", "verif");
    expect(t.access_token).toBe("acc-authcode");
    expect(t.refresh_token).toBe("ref-1");
    const params = mock.tokenCalls[0]!;
    expect(params).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: "agentparty-cli",
      code_verifier: "verif",
      redirect_uri: "http://127.0.0.1:8976/callback",
    });
  });

  test("refreshTokens posts refresh_token grant", async () => {
    mock = startOidcMock();
    const t = await refreshTokens(mock.url, "agentparty-cli", "ref-old");
    expect(t.access_token).toBe("acc-refreshed");
    expect(mock.tokenCalls[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref-old" });
  });
});

describe("ensureFreshAccess", () => {
  test("fresh token → no network", async () => {
    mock = startOidcMock();
    const sess = {
      server: mock.url,
      refresh_token: "ref",
      access_token: "still-good",
      expires_at: nowSec() + 3600,
    };
    const { token } = await ensureFreshAccess(sess);
    expect(token).toBe("still-good");
    expect(mock.tokenCalls).toHaveLength(0);
  });

  test("expired token → refresh + persist rotated refresh_token", async () => {
    mock = startOidcMock();
    writeAccount({
      server: mock.url,
      refresh_token: "ref-old",
      access_token: "expired",
      expires_at: nowSec() - 10,
    });
    const { token, session } = await ensureFreshAccess(readAccount()!);
    expect(token).toBe("acc-refreshed");
    expect(session.refresh_token).toBe("ref-2");
    // 落盘：下次读到刷新后的会话
    const persisted = readAccount()!;
    expect(persisted.access_token).toBe("acc-refreshed");
    expect(persisted.refresh_token).toBe("ref-2");
    expect(persisted.expires_at!).toBeGreaterThan(nowSec());
  });
});

describe("resolveAuth precedence", () => {
  test("account session wins as bearer; server prefers config", async () => {
    writeConfig({ server: "https://ap.example.com", token: "ap_old" });
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: nowSec() + 3600,
    });
    const auth = await resolveAuth();
    expect(auth).toEqual({ server: "https://ap.example.com", token: "acc-live" });
  });

  test("falls back to config ap_ token when logged out", async () => {
    writeConfig({ server: "https://ap.example.com", token: "ap_only" });
    const auth = await resolveAuth();
    expect(auth).toEqual({ server: "https://ap.example.com", token: "ap_only" });
  });

  test("account-only (no config) uses account server", async () => {
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: nowSec() + 3600,
    });
    const auth = await resolveAuth();
    expect(auth).toEqual({ server: "https://issuer.example.com", token: "acc-live" });
  });

  test("null when neither present", async () => {
    expect(await resolveAuth()).toBeNull();
  });
});

describe("loginFlow (loopback pkce)", () => {
  const ports = [45871, 45872, 45873];

  test("full flow: authorize → code → token → session", async () => {
    mock = startOidcMock();
    const sess = await loginFlow(mock.url, {
      ports,
      openUrl: async (url) => {
        // 模拟 IdP：解析 redirect_uri + state，带 code 回调
        const q = new URL(url).searchParams;
        expect(q.get("code_challenge_method")).toBe("S256");
        expect(q.get("client_id")).toBe("agentparty-cli");
        const redirect = q.get("redirect_uri")!;
        const state = q.get("state")!;
        await fetch(`${redirect}?code=auth-code-xyz&state=${encodeURIComponent(state)}`);
      },
    });
    expect(sess.email).toBe("fan@example.com");
    expect(sess.sub).toBe("user-123");
    expect(sess.refresh_token).toBe("ref-1");
    expect(sess.access_token).toBe("acc-authcode");
    expect(sess.expires_at!).toBeGreaterThan(nowSec());
    expect(mock.tokenCalls[0]).toMatchObject({ grant_type: "authorization_code", code: "auth-code-xyz" });
  });

  test("state mismatch is rejected (CSRF guard)", async () => {
    mock = startOidcMock();
    await expect(
      loginFlow(mock.url, {
        ports,
        openUrl: async (url) => {
          const redirect = new URL(url).searchParams.get("redirect_uri")!;
          await fetch(`${redirect}?code=x&state=WRONG`);
        },
      }),
    ).rejects.toThrow(/state mismatch/);
    // 状态不匹配不应换取 token
    expect(mock.tokenCalls).toHaveLength(0);
  });

  test("falls back to web client_id when cli_client_id absent", async () => {
    mock = startOidcMock({ cliClientId: null });
    await loginFlow(mock.url, {
      ports,
      openUrl: async (url) => {
        const q = new URL(url).searchParams;
        expect(q.get("client_id")).toBe("agentparty-web");
        const redirect = q.get("redirect_uri")!;
        const state = q.get("state")!;
        await fetch(`${redirect}?code=c&state=${encodeURIComponent(state)}`);
      },
    });
  });
});
