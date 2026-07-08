// 人类网页 OIDC 登录（spec §10 双轨）：ap_ token 走 D1，OIDC access token（RS256 JWT）走 issuer/jwks.json 验签
import { SELF, env, fetchMock } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { lookupToken, oidcConfigFromEnv } from "../src/auth";
import { createChannel, uniq } from "./helpers";

const CLIENT_ID = "ap-web";
const CONFIGURED_ISSUER = "https://oidc.test"; // 与 vitest.config 的静态绑定一致

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey & { kid?: string };

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & { kid?: string };
  jwk.kid = "test-key-1";
});

afterEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => fetchMock.deactivate());

function mockJwks(issuer: string) {
  fetchMock.get(issuer).intercept({ path: "/jwks.json", method: "GET" }).reply(200, { keys: [jwk] });
}

async function signJwt(claims: Record<string, unknown>, opts: { kid?: string; tamper?: boolean } = {}): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: opts.kid ?? "test-key-1" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const bytes = new Uint8Array(sig);
  if (opts.tamper) bytes[0] ^= 0xff;
  return `${signingInput}.${b64url(bytes)}`;
}

function claims(issuer: string, over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: issuer, aud: CLIENT_ID, sub: "user-abc", email: "u@leeguoo.com", exp: now + 3600, iat: now, ...over };
}

// 每个需要验签的单元用例用独立 issuer，避开 JWKS 内存缓存，让 interceptor 恰好消费一次
function freshIssuer(): string {
  return `https://${uniq("oidc")}.example`;
}

const oidc = (issuer: string) => oidcConfigFromEnv({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT_ID });

describe("oidcConfigFromEnv", () => {
  it("returns null unless both issuer and client_id are set", () => {
    expect(oidcConfigFromEnv({})).toBeNull();
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "https://x" })).toBeNull();
    expect(oidcConfigFromEnv({ OIDC_CLIENT_ID: "c" })).toBeNull();
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "https://x/", OIDC_CLIENT_ID: "c" })).toEqual({
      issuer: "https://x",
      clientId: "c",
      acceptedClientIds: ["c"],
    });
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "https://x/", OIDC_CLIENT_ID: "web" }, ["cli"])).toEqual({
      issuer: "https://x",
      clientId: "web",
      acceptedClientIds: ["web", "cli"],
    });
  });
});

describe("lookupToken OIDC verification", () => {
  it("verifies a valid RS256 JWT into a human identity", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    const id = await lookupToken(env.DB, await signJwt(claims(issuer)), oidc(issuer));
    expect(id).toEqual({
      name: "user-abc",
      email: "u@leeguoo.com",
      role: "human",
      kind: "human",
      hash: "oidc:user-abc",
      // 所属人：有 email 用 email
      owner: "u@leeguoo.com",
      // 账号锚点（spec §5.1）：OIDC 人类 account = email ?? sub
      account: "u@leeguoo.com",
    });
  });

  it("falls back owner to sub when the JWT has no email", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    const id = await lookupToken(env.DB, await signJwt(claims(issuer, { email: undefined })), oidc(issuer));
    expect(id).toMatchObject({ name: "user-abc", email: undefined, owner: "user-abc" });
  });

  it("rejects an expired JWT (no JWKS fetch)", async () => {
    const issuer = freshIssuer();
    const now = Math.floor(Date.now() / 1000);
    expect(await lookupToken(env.DB, await signJwt(claims(issuer, { exp: now - 10 })), oidc(issuer))).toBeNull();
  });

  it("rejects a JWT whose aud is not the client_id", async () => {
    const issuer = freshIssuer();
    expect(await lookupToken(env.DB, await signJwt(claims(issuer, { aud: "other" })), oidc(issuer))).toBeNull();
  });

  it("accepts a JWT whose aud is an extra trusted client_id", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    const config = oidcConfigFromEnv({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT_ID }, ["agentparty-cli"]);
    const id = await lookupToken(env.DB, await signJwt(claims(issuer, { aud: "agentparty-cli" })), config);
    expect(id).toMatchObject({ role: "human", account: "u@leeguoo.com" });
  });

  it("rejects a JWT whose iss mismatches the configured issuer", async () => {
    const issuer = freshIssuer();
    expect(await lookupToken(env.DB, await signJwt(claims("https://evil.example")), oidc(issuer))).toBeNull();
  });

  it("rejects a JWT with a tampered signature", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    expect(await lookupToken(env.DB, await signJwt(claims(issuer), { tamper: true }), oidc(issuer))).toBeNull();
  });

  it("rejects a JWT signed with an unknown kid", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer); // 只有 test-key-1，kid 不匹配且强制刷新后仍找不到
    expect(await lookupToken(env.DB, await signJwt(claims(issuer), { kid: "ghost" }), oidc(issuer))).toBeNull();
  });

  it("degrades to D1 (returns null) when OIDC is not configured", async () => {
    const issuer = freshIssuer();
    // oidc=null：JWT 不走验证，落 D1 hash 查询 → 未命中 → null（保持机器 token 现状）
    expect(await lookupToken(env.DB, await signJwt(claims(issuer)), null)).toBeNull();
  });
});

describe("oidc end-to-end via SELF.fetch", () => {
  it("GET /api/config exposes the configured issuer + client_id", async () => {
    const res = await SELF.fetch("http://ap.test/api/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      oidc: { issuer: CONFIGURED_ISSUER, client_id: CLIENT_ID },
      cli_client_id: "agentparty-cli",
    });
  });

  it("accepts an OIDC human end-to-end: list, create channel, post message", async () => {
    mockJwks(CONFIGURED_ISSUER); // 首次验签拉一次 JWKS，其后命中缓存
    const jwt = await signJwt(claims(CONFIGURED_ISSUER));
    const auth = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };

    const list = await SELF.fetch("http://ap.test/api/channels", { headers: auth });
    expect(list.status).toBe(200);

    // /api/me 暴露登录身份：OIDC 人类 owner = email，name = sub
    const me = await SELF.fetch("http://ap.test/api/me", { headers: auth });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      name: "user-abc",
      email: "u@leeguoo.com",
      kind: "human",
      role: "human",
      owner: "u@leeguoo.com",
      channel_scope: null,
      lineage: null,
      handle: null,
      // OIDC 人类：非 readonly 能发/建频道；有 account 能自助铸 agent；无 scope；spawn 只给 scoped parent agent
      caps: { send: true, create_channel: true, mint_agents: true, spawn_children: false, scoped_to: null },
    });

    const cliAudJwt = await signJwt(
      claims(CONFIGURED_ISSUER, { aud: "agentparty-cli", sub: "cli-user", email: "cli@leeguoo.com" }),
    );
    const cliMe = await SELF.fetch("http://ap.test/api/me", { headers: { authorization: `Bearer ${cliAudJwt}` } });
    expect(cliMe.status).toBe(200);
    expect(await cliMe.json()).toMatchObject({
      name: "cli-user",
      email: "cli@leeguoo.com",
      role: "human",
      caps: { send: true, create_channel: true, mint_agents: true, spawn_children: false, scoped_to: null },
    });

    // DO 的 isTokenActive 认 oidc: 前哨（不走 D1 吊销扫描），OIDC 人类可建频道并发消息
    const slug = await createChannel(jwt);
    const post = await SELF.fetch(`http://ap.test/api/channels/${slug}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "message", body: "hi from human", mentions: [], reply_to: null }),
    });
    expect(post.status).toBe(200);
    expect((await post.json()) as { seq: number }).toMatchObject({ seq: 1 });
  });
});
