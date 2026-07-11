import { env } from "cloudflare:test";
import { fetchMock } from "./fetch-mock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canAccessChannel, type AclIdentity, type ChannelAcl } from "../src/acl";
import { api, postMessage, seedToken, uniq } from "./helpers";

const CLIENT_ID = "ap-web";
const ISSUER = "https://oidc.test";

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
  jwk.kid = "membership-key-1";
  fetchMock.get(ISSUER).intercept({ path: "/jwks.json", method: "GET" }).reply(200, { keys: [jwk] }).persist();
});

afterAll(() => fetchMock.deactivate());

async function jwtFor(sub: string, email: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: "membership-key-1" };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: ISSUER, aud: CLIENT_ID, sub, email, exp: now + 3600, iat: now };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function makeChannel(token: string, visibility: "public" | "private" = "private"): Promise<string> {
  const slug = uniq("mem");
  const res = await api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug, kind: "standing", visibility }),
  });
  expect(res.status).toBe(201);
  return slug;
}

async function memberRows(slug: string) {
  return (await env.DB.prepare("SELECT account, added_by FROM channel_members WHERE channel_slug = ? ORDER BY account")
    .bind(slug)
    .all<{ account: string; added_by: string }>()).results;
}

describe("ACL v3 channel membership", () => {
  it("lets members into private channels without weakening scope or readonly hard stops", () => {
    const member: AclIdentity = { hash: "oidc:member", name: "member", role: "human", account: "m@example.com" };
    const scopedOwner: AclIdentity = { hash: "a".repeat(64), name: "scoped", role: "agent", account: "o@example.com", channel_scope: "other" };
    const readonlyOwner: AclIdentity = { hash: "b".repeat(64), name: "ro", role: "readonly", account: "o@example.com" };
    const channel: ChannelAcl = { slug: "room", visibility: "private", owner_account: "o@example.com" };
    expect(canAccessChannel(member, channel, true)).toBe(true);
    expect(canAccessChannel(member, channel, false)).toBe(false);
    expect(canAccessChannel(scopedOwner, channel, true)).toBe(false);
    expect(canAccessChannel(readonlyOwner, channel, true)).toBe(false);
  });
});

describe("membership management", () => {
  it("moderator adds/removes, member leaves, non-moderator add is forbidden, owner removal is rejected, list includes member channels", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token);
    const memberAcct = `${uniq("member")}@example.com`;
    const member = await seedToken("human", uniq("member"), { owner: memberAcct });

    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(memberAcct)}`, owner.token, { method: "PUT" })).status).toBe(200);
    expect(await memberRows(slug)).toContainEqual({ account: memberAcct, added_by: ownerAcct });
    expect((await api(`/api/channels/${slug}/messages`, member.token)).status).toBe(200);
    const slugs = ((await (await api("/api/channels", member.token)).json()) as { channels: { slug: string }[] }).channels.map((c) => c.slug);
    expect(slugs).toContain(slug);

    const outsider = await seedToken("human", uniq("outsider"), { owner: `${uniq("out")}@example.com` });
    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(`${uniq("x")}@example.com`)}`, outsider.token, { method: "PUT" })).status).toBe(403);
    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(ownerAcct)}`, owner.token, { method: "DELETE" })).status).toBe(400);

    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(memberAcct)}`, member.token, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, member.token)).status).toBe(403);
  });
});

describe("join links", () => {
  it("accepts OIDC humans idempotently, rejects invalid links and ap_ callers, and does not oversell max_uses", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await makeChannel(owner.token);
    const created = await api(`/api/channels/${slug}/join-links`, owner.token, { method: "POST", body: JSON.stringify({ max_uses: 5 }) });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };
    const human = await jwtFor(uniq("human"), `${uniq("human")}@example.com`);
    expect((await api(`/api/join/${code}`, human, { method: "POST" })).status).toBe(200);
    expect((await api(`/api/join/${code}`, human, { method: "POST" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT uses FROM channel_join_links WHERE code = ?").bind(code).first<{ uses: number }>())?.uses).toBe(1);

    const agent = await seedToken("agent", uniq("agent"), { owner: `${uniq("agent")}@example.com` });
    const agentDenied = await api(`/api/join/${code}`, agent.token, { method: "POST" });
    expect(agentDenied.status).toBe(403);
    expect(((await agentDenied.json()) as { error: { message: string } }).error.message).toContain("party-invite");

    const expired = `expired-${uniq("c")}`;
    const revoked = `revoked-${uniq("c")}`;
    const full = `full-${uniq("c")}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO channel_join_links (code, channel_slug, created_by, created_at, expires_at, max_uses, uses, revoked_at)
       VALUES (?, ?, 'owner', ?, ?, NULL, 0, NULL),
              (?, ?, 'owner', ?, NULL, NULL, 0, ?),
              (?, ?, 'owner', ?, NULL, 1, 1, NULL)`,
    )
      .bind(expired, slug, now, now - 1, revoked, slug, now, now, full, slug, now)
      .run();
    expect((await api(`/api/join/${expired}`, human, { method: "POST" })).status).toBe(410);
    expect((await api(`/api/join/${revoked}`, human, { method: "POST" })).status).toBe(410);
    expect((await api(`/api/join/${full}`, human, { method: "POST" })).status).toBe(410);

    const limited = await api(`/api/channels/${slug}/join-links`, owner.token, { method: "POST", body: JSON.stringify({ max_uses: 1 }) });
    const limitedCode = ((await limited.json()) as { code: string }).code;
    const one = await jwtFor(uniq("one"), `${uniq("one")}@example.com`);
    const two = await jwtFor(uniq("two"), `${uniq("two")}@example.com`);
    const results = await Promise.all([api(`/api/join/${limitedCode}`, one, { method: "POST" }), api(`/api/join/${limitedCode}`, two, { method: "POST" })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect((await env.DB.prepare("SELECT uses FROM channel_join_links WHERE code = ?").bind(limitedCode).first<{ uses: number }>())?.uses).toBe(1);
  });

  // 回归：Lark/Feishu 换码铸的是 D1 human token（hash 非 `oidc:` 前缀）。旧闸门按 hash 前缀判，
  // 把这类真人一律 403 —— 只配 Lark 登录的部署上邀请链接彻底不可用，房主只能把频道降级成 public 绕开。
  it("accepts non-OIDC human accounts (Lark/Feishu session tokens), still rejects agent and readonly", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await makeChannel(owner.token);
    const created = await api(`/api/channels/${slug}/join-links`, owner.token, { method: "POST" });
    const { code } = (await created.json()) as { code: string };

    // Lark 登录后的身份：role=human + owner(account)，token 落 D1，hash 是普通 sha256
    const larkAccount = `lark:${uniq("union")}`;
    const larkHuman = await seedToken("human", uniq("lark-human"), { owner: larkAccount });
    const joined = await api(`/api/join/${code}`, larkHuman.token, { method: "POST" });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({ channel_slug: slug, joined: true });
    const member = await env.DB.prepare("SELECT account FROM channel_members WHERE channel_slug = ? AND account = ?")
      .bind(slug, larkAccount)
      .first<{ account: string }>();
    expect(member?.account).toBe(larkAccount);

    // 幂等：再兑换一次不重复计数
    expect((await api(`/api/join/${code}`, larkHuman.token, { method: "POST" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT uses FROM channel_join_links WHERE code = ?").bind(code).first<{ uses: number }>())?.uses).toBe(1);

    // 闸门不放宽：agent 与只读分享 token 依旧 403
    const agent = await seedToken("agent", uniq("agent"), { owner: `${uniq("agent")}@example.com` });
    expect((await api(`/api/join/${code}`, agent.token, { method: "POST" })).status).toBe(403);
    const readonly = await seedToken("readonly", uniq("ro"), { owner: `${uniq("ro")}@example.com` });
    expect((await api(`/api/join/${code}`, readonly.token, { method: "POST" })).status).toBe(403);

    // legacy human token（无 owner → 无 account）仍然 403
    const legacy = await seedToken("human", uniq("legacy"));
    expect((await api(`/api/join/${code}`, legacy.token, { method: "POST" })).status).toBe(403);
  });

  it("moderator lists and revokes join links", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await makeChannel(owner.token);
    const created = await api(`/api/channels/${slug}/join-links`, owner.token, { method: "POST" });
    const code = ((await created.json()) as { code: string }).code;
    expect(((await (await api(`/api/channels/${slug}/join-links`, owner.token)).json()) as { links: { code: string }[] }).links.map((l) => l.code)).toContain(code);
    expect((await api(`/api/channels/${slug}/join-links/${code}`, owner.token, { method: "DELETE" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT revoked_at FROM channel_join_links WHERE code = ?").bind(code).first<{ revoked_at: number | null }>())?.revoked_at).toBeTypeOf("number");
  });
});

describe("visibility switching", () => {
  it("requires moderator, confirms private-to-public with stats, records system status, and public-to-private blocks new access", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const outsider = await seedToken("human", uniq("outsider"), { owner: `${uniq("out")}@example.com` });
    const slug = await makeChannel(owner.token, "private");
    expect((await postMessage(slug, owner.token, "secret")).status).toBe(200);
    expect((await api(`/api/channels/${slug}/visibility`, outsider.token, { method: "PUT", body: JSON.stringify({ visibility: "public", confirm: true }) })).status).toBe(403);
    const needsConfirm = await api(`/api/channels/${slug}/visibility`, owner.token, { method: "PUT", body: JSON.stringify({ visibility: "public" }) });
    expect(needsConfirm.status).toBe(409);
    expect((await needsConfirm.json()) as { needs_confirm: boolean; message_count: number }).toMatchObject({ needs_confirm: true, message_count: 1 });
    expect((await api(`/api/channels/${slug}/visibility`, owner.token, { method: "PUT", body: JSON.stringify({ visibility: "public", confirm: true }) })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, outsider.token)).status).toBe(200);
    expect((await api(`/api/channels/${slug}/visibility`, owner.token, { method: "PUT", body: JSON.stringify({ visibility: "private" }) })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, outsider.token)).status).toBe(403);
    const bodies = ((await (await api(`/api/channels/${slug}/messages?since=0`, owner.token)).json()) as { messages: { body: string }[] }).messages.map((m) => m.body);
    expect(bodies).toContain(`visibility changed to public by ${owner.name}`);
    expect(bodies).toContain(`visibility changed to private by ${owner.name}`);
  });
});
