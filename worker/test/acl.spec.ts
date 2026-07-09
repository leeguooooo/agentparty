// 公开/私有频道访问控制（spec §3.2 矩阵 + §5 踢人）
// 单元：canAccessChannel / isChannelModerator 全矩阵
// 集成：WS 升级 / REST GET / REST POST 三处强制 + 踢人
import { SELF, env, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canAccessChannel, isChannelModerator, type AclIdentity, type ChannelAcl } from "../src/acl";
import { ADMIN_HEADERS, api, seedToken, uniq, WsClient } from "./helpers";

// ── 单元：canAccessChannel v2 全矩阵（账号模型 spec §5.4/§5.5）──────────────────

const LEO = "leo@leeguoo.com";

// 带 owner 的普通 ap_ token（account = owner，无 scope）：leo 自己的 agent / human
const apAgent: AclIdentity = { hash: "a".repeat(64), name: "leo-agent", role: "agent", account: LEO };
const apHuman: AclIdentity = { hash: "b".repeat(64), name: "leo-human", role: "human", account: LEO };
// legacy 存量 token（owner=null → account undefined）：过渡期当部署管理员放行
const legacyAgent: AclIdentity = { hash: "d".repeat(64), name: "legacy", role: "agent" };
const legacyReadonly: AclIdentity = { hash: "e".repeat(64), name: "legacy-ro", role: "readonly" };
// channel-scoped token（account=owner，scope=collab）：给 B 公司 / 分享链接
const scopedAgent: AclIdentity = {
  hash: "f".repeat(64), name: "b-corp", role: "agent", account: LEO, channel_scope: "collab",
};
const scopedReadonly: AclIdentity = {
  hash: "1".repeat(64), name: "share", role: "readonly", account: LEO, channel_scope: "collab",
};
// 带 owner 但无 scope 的 readonly（不该再签发）：私有一律拒
const roNoScope: AclIdentity = { hash: "2".repeat(64), name: "ro-plain", role: "readonly", account: LEO };
// OIDC 房主（account=email）与粉丝
const oidcOwner: AclIdentity = { hash: "oidc:owner-sub", name: "owner-sub", role: "human", email: LEO, account: LEO };
const oidcFan: AclIdentity = {
  hash: "oidc:fan-sub", name: "fan-sub", role: "human", email: "fan@leeguoo.com", account: "fan@leeguoo.com",
};

const publicCh: ChannelAcl = { slug: "pub", visibility: "public", owner_account: LEO };
const privateOwned: ChannelAcl = { slug: "mine", visibility: "private", owner_account: LEO }; // leo 名下私有
const collabCh: ChannelAcl = { slug: "collab", visibility: "private", owner_account: LEO }; // scope 目标频道
const otherOwned: ChannelAcl = { slug: "other", visibility: "private", owner_account: "other@leeguoo.com" };
const legacyCh: ChannelAcl = { slug: "old", visibility: "private", owner_account: null }; // 老频道无 owner_account

describe("canAccessChannel v2 matrix (spec §5.4/§5.5)", () => {
  it("public channel: every identity may enter (public 先于 scope)", () => {
    for (const id of [apAgent, apHuman, legacyAgent, legacyReadonly, scopedAgent, scopedReadonly, roNoScope, oidcOwner, oidcFan]) {
      expect(canAccessChannel(id, publicCh, false)).toBe(true);
    }
  });

  it("account owner (self / own agent / OIDC owner) enters own private channels", () => {
    for (const id of [apAgent, apHuman, oidcOwner]) {
      expect(canAccessChannel(id, privateOwned, false)).toBe(true);
      expect(canAccessChannel(id, collabCh, false)).toBe(true); // 同账号名下另一私有频道也进
    }
  });

  it("account owner cannot enter another account's private, nor an owner_account=null legacy channel", () => {
    for (const id of [apAgent, apHuman, oidcOwner]) {
      expect(canAccessChannel(id, otherOwned, false)).toBe(false);
      expect(canAccessChannel(id, legacyCh, false)).toBe(false); // owner_account=null → 带 owner 的 token / OIDC 进不去（§6）
    }
  });

  it("channel-scoped token: only its scope channel, others (even same owner) forbidden", () => {
    expect(canAccessChannel(scopedAgent, collabCh, false)).toBe(true); // scope 命中
    expect(canAccessChannel(scopedAgent, privateOwned, false)).toBe(false); // 同 owner 也拒（scope 硬上限）
    expect(canAccessChannel(scopedAgent, otherOwned, false)).toBe(false);
    expect(canAccessChannel(scopedAgent, publicCh, false)).toBe(true); // 公开频道可发
  });

  it("channel-scoped readonly: read-only single channel; scope mismatch forbidden (连读都拒)", () => {
    expect(canAccessChannel(scopedReadonly, collabCh, false)).toBe(true); // 只读单频道
    expect(canAccessChannel(scopedReadonly, privateOwned, false)).toBe(false); // scope 不匹配连读都拒
    expect(canAccessChannel(scopedReadonly, otherOwned, false)).toBe(false);
    expect(canAccessChannel(scopedReadonly, publicCh, false)).toBe(true);
  });

  it("readonly without scope: private denied (不该再签发)", () => {
    expect(canAccessChannel(roNoScope, privateOwned, false)).toBe(false); // 即便 account===owner_account
    expect(canAccessChannel(roNoScope, collabCh, false)).toBe(false);
  });

  it("legacy ap_ token (owner=null) transitional passthrough on private (agent & readonly)", () => {
    for (const id of [legacyAgent, legacyReadonly]) {
      expect(canAccessChannel(id, privateOwned, false)).toBe(true);
      expect(canAccessChannel(id, otherOwned, false)).toBe(true);
      expect(canAccessChannel(id, legacyCh, false)).toBe(true);
    }
  });

  it("OIDC fan denied on any private channel", () => {
    expect(canAccessChannel(oidcFan, privateOwned, false)).toBe(false);
    expect(canAccessChannel(oidcFan, collabCh, false)).toBe(false);
    expect(canAccessChannel(oidcFan, legacyCh, false)).toBe(false);
  });
});

describe("isChannelModerator v2 (spec §5)", () => {
  it("account owner (ap_ with owner / OIDC owner) moderates own channels only", () => {
    expect(isChannelModerator(apAgent, privateOwned)).toBe(true);
    expect(isChannelModerator(apHuman, publicCh)).toBe(true);
    expect(isChannelModerator(oidcOwner, privateOwned)).toBe(true);
    expect(isChannelModerator(apAgent, otherOwned)).toBe(false); // 别账号的频道不能管
    expect(isChannelModerator(apAgent, legacyCh)).toBe(false); // owner_account=null 不命中
  });

  it("legacy ap_ token moderates (transitional); OIDC fan does not", () => {
    expect(isChannelModerator(legacyAgent, privateOwned)).toBe(true);
    expect(isChannelModerator(oidcFan, publicCh)).toBe(false);
    expect(isChannelModerator(oidcFan, privateOwned)).toBe(false);
  });

  it("readonly never moderates; scoped token is not a moderator (even in its scope channel)", () => {
    expect(isChannelModerator(legacyReadonly, privateOwned)).toBe(false);
    expect(isChannelModerator(scopedReadonly, collabCh)).toBe(false);
    expect(isChannelModerator(scopedAgent, collabCh)).toBe(false); // scoped agent 不是 moderator
  });
});

// ── 集成：三处强制 + 踢人（造 oidc: 身份模拟粉丝）────────────────────────────

const CLIENT_ID = "ap-web";
const ISSUER = "https://oidc.test"; // 与 vitest.config 静态绑定一致

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
  jwk.kid = "acl-key-1";
  // persist：JWKS 缓存可能被其它 spec 预热，也可能未热，两种情况都放行
  fetchMock.get(ISSUER).intercept({ path: "/jwks.json", method: "GET" }).reply(200, { keys: [jwk] }).persist();
});
afterAll(() => fetchMock.deactivate());

async function jwtFor(sub: string, email: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: "acl-key-1" };
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

async function makeChannel(token: string, visibility: "public" | "private"): Promise<string> {
  const slug = uniq("ch");
  const res = await api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug, kind: "standing", visibility }),
  });
  if (res.status !== 201) throw new Error(`create channel failed: ${res.status}`);
  return slug;
}

function postMsg(slug: string, token: string, body: string): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions: [], reply_to: null }),
  });
}

async function wsUpgradeStatus(slug: string, token: string): Promise<number> {
  const res = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws`, {
    headers: { upgrade: "websocket", "sec-websocket-protocol": `agentparty, ${token}` },
  });
  return res.status;
}

// 私有频道拒粉丝：worker 不进 do，accept-then-close(1008,"forbidden")。
// 返回握手状态 + close code/reason，供断言终局语义（web ws.ts 据此停重连）。
async function wsForbiddenClose(
  slug: string,
  token: string,
): Promise<{ status: number; code?: number; reason?: string }> {
  const res = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws`, {
    headers: { upgrade: "websocket", "sec-websocket-protocol": `agentparty, ${token}` },
  });
  if (res.status !== 101 || !res.webSocket) return { status: res.status };
  const ws = res.webSocket;
  ws.accept();
  return await new Promise((resolve) => {
    ws.addEventListener("close", (e) => resolve({ status: 101, code: e.code, reason: e.reason }));
    ws.addEventListener("error", () => resolve({ status: 101 }));
  });
}

describe("channel visibility enforcement (spec §3.2)", () => {
  it("POST /api/channels defaults to private and rejects invalid visibility", async () => {
    const { token } = await seedToken("agent");
    const created = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: uniq("ch"), kind: "standing" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ visibility: "private" });

    const bad = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: uniq("ch"), kind: "standing", visibility: "secret" }),
    });
    expect(bad.status).toBe(400);
  });

  it("GET /api/channels returns visibility", async () => {
    const { token } = await seedToken("agent");
    const slug = await makeChannel(token, "public");
    const list = await api("/api/channels", token);
    const found = ((await list.json()) as { channels: { slug: string; visibility: string }[] }).channels.find(
      (c) => c.slug === slug,
    );
    expect(found?.visibility).toBe("public");
  });

  it("private channel: ap_ token passes all three gates", async () => {
    const { token } = await seedToken("agent");
    const slug = await makeChannel(token, "private");
    expect(await wsUpgradeStatus(slug, token)).toBe(101);
    expect((await postMsg(slug, token, "hi")).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, token)).status).toBe(200);
  });

  it("private channel: fan (OIDC non-owner) is forbidden at WS/GET/POST", async () => {
    const { token: apToken } = await seedToken("agent");
    const slug = await makeChannel(apToken, "private"); // created_by = ap agent name
    const fan = await jwtFor("fan-1", "fan-1@leeguoo.com");

    const denied = await wsForbiddenClose(slug, fan);
    expect(denied.status).toBe(101); // 握手成功后立刻 close，非 HTTP 403
    expect(denied.code).toBe(1008);
    expect(denied.reason).toBe("forbidden");

    const get = await api(`/api/channels/${slug}/messages`, fan);
    expect(get.status).toBe(403);
    expect((await get.json()) as { error: { code: string } }).toMatchObject({ error: { code: "forbidden" } });

    // presence（party who）走同一个 ACL 门，粉丝不得窥私有频道的在场名单
    const pres = await api(`/api/channels/${slug}/presence`, fan);
    expect(pres.status).toBe(403);

    const post = await postMsg(slug, fan, "let me in");
    expect(post.status).toBe(403);
    expect((await post.json()) as { error: { code: string } }).toMatchObject({ error: { code: "forbidden" } });
  });

  it("public channel: fan may enter, read and post", async () => {
    const { token: apToken } = await seedToken("agent");
    const slug = await makeChannel(apToken, "public");
    const fan = await jwtFor("fan-2", "fan-2@leeguoo.com");

    expect(await wsUpgradeStatus(slug, fan)).toBe(101);
    expect((await api(`/api/channels/${slug}/messages`, fan)).status).toBe(200);
    const pres = await api(`/api/channels/${slug}/presence`, fan);
    expect(pres.status).toBe(200);
    expect((await pres.json()) as { presence: unknown[] }).toHaveProperty("presence");
    const post = await postMsg(slug, fan, "hello everyone");
    expect(post.status).toBe(200);
    expect((await post.json()) as { seq: number }).toMatchObject({ seq: 1 });
  });

  it("private channel: OIDC owner (creator) passes all three gates", async () => {
    const owner = await jwtFor("owner-x", "owner-x@leeguoo.com");
    const slug = await makeChannel(owner, "private"); // created_by = owner sub
    expect(await wsUpgradeStatus(slug, owner)).toBe(101);
    expect((await postMsg(slug, owner, "my room")).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, owner)).status).toBe(200);

    // 另一个 OIDC 粉丝进不去房主的私有频道
    const fan = await jwtFor("fan-3", "fan-3@leeguoo.com");
    const denied = await wsForbiddenClose(slug, fan);
    expect(denied.status).toBe(101);
    expect(denied.code).toBe(1008);
    expect(denied.reason).toBe("forbidden");
  });
});

describe("kick (spec §5)", () => {
  it("disconnect mode leaves the channel-scoped token valid", async () => {
    const ownerAcct = `${uniq("owner")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token, "private");
    const guest = await seedToken("agent", uniq("guest"), { owner: `${uniq("guest")}@leeguoo.com`, channelScope: slug });

    const kick = await api(`/api/channels/${slug}/kick`, owner.token, {
      method: "POST",
      body: JSON.stringify({ name: guest.name }),
    });
    expect(kick.status).toBe(200);

    expect((await postMsg(slug, guest.token, "still valid after disconnect")).status).toBe(200);
    const tokenRow = await env.DB.prepare("SELECT revoked_at FROM tokens WHERE name = ?")
      .bind(guest.name)
      .first<{ revoked_at: number | null }>();
    expect(tokenRow?.revoked_at).toBeNull();
  });

  it("remove mode revokes scoped token, clears presence, removes membership, and writes a status trace", async () => {
    const ownerAcct = `${uniq("owner")}@leeguoo.com`;
    const guestAcct = `${uniq("guest")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token, "private");
    const guest = await seedToken("agent", uniq("guest"), { owner: guestAcct, channelScope: slug });
    await env.DB.prepare("INSERT INTO channel_members (channel_slug, account, added_by, added_at) VALUES (?, ?, ?, ?)")
      .bind(slug, guestAcct, ownerAcct, Date.now())
      .run();
    // presence 由 status 帧建立（普通 message 不建 presence）——发一条 status 让 guest 进在场名单
    expect(
      (await api(`/api/channels/${slug}/messages`, guest.token, {
        method: "POST",
        body: JSON.stringify({ kind: "status", state: "working", note: "before removal", mentions: [] }),
      })).status,
    ).toBe(200);
    const before = ((await (await api(`/api/channels/${slug}/presence`, owner.token)).json()) as { presence: { name: string }[] }).presence;
    expect(before.map((p) => p.name)).toContain(guest.name);

    const kick = await api(`/api/channels/${slug}/kick`, owner.token, {
      method: "POST",
      body: JSON.stringify({ name: guest.name, mode: "remove" }),
    });
    expect(kick.status).toBe(200);

    const tokenRow = await env.DB.prepare("SELECT revoked_at FROM tokens WHERE name = ?")
      .bind(guest.name)
      .first<{ revoked_at: number | null }>();
    expect(tokenRow?.revoked_at).toBeTypeOf("number");
    expect((await postMsg(slug, guest.token, "after removal")).status).toBe(401);
    expect((await api(`/api/channels/${slug}/messages`, guest.token)).status).toBe(401);
    const after = ((await (await api(`/api/channels/${slug}/presence`, owner.token)).json()) as { presence: { name: string }[] }).presence;
    expect(after.map((p) => p.name)).not.toContain(guest.name);
    const member = await env.DB.prepare("SELECT account FROM channel_members WHERE channel_slug = ? AND account = ?")
      .bind(slug, guestAcct)
      .first<{ account: string }>();
    expect(member).toBeNull();
    const history = ((await (await api(`/api/channels/${slug}/messages?since=0`, owner.token)).json()) as { messages: { kind: string; body: string }[] }).messages;
    expect(history).toContainEqual(expect.objectContaining({ kind: "status", body: `removed ${guest.name} from channel` }));
  });

  it("owner cannot kick themselves", async () => {
    const ownerAcct = `${uniq("owner")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token, "private");

    expect((await api(`/api/channels/${slug}/kick`, owner.token, {
      method: "POST",
      body: JSON.stringify({ name: owner.name, mode: "remove" }),
    })).status).toBe(403);
    expect((await api(`/api/channels/${slug}/kick`, owner.token, {
      method: "POST",
      body: JSON.stringify({ name: ownerAcct, mode: "remove" }),
    })).status).toBe(403);
  });

  it("owner/ap_ can kick a live fan; fan/readonly cannot", async () => {
    const { token: apToken } = await seedToken("agent");
    const ro = await seedToken("readonly");
    const slug = await makeChannel(apToken, "public");
    const fan = await jwtFor("fan-kick", "fan-kick@leeguoo.com");

    // 粉丝进公开频道并挂着 ws
    const fanWs = await WsClient.open(slug, fan, "protocol");
    expect((await fanWs.nextOfType("welcome")).type).toBe("welcome");

    // 粉丝无权踢自己/别人
    const fanKick = await api(`/api/channels/${slug}/kick`, fan, {
      method: "POST",
      body: JSON.stringify({ name: "fan-kick" }),
    });
    expect(fanKick.status).toBe(403);

    // readonly ap_ 无权踢
    const roKick = await api(`/api/channels/${slug}/kick`, ro.token, {
      method: "POST",
      body: JSON.stringify({ name: "fan-kick" }),
    });
    expect(roKick.status).toBe(403);

    // 缺 name → 400
    const badKick = await api(`/api/channels/${slug}/kick`, apToken, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(badKick.status).toBe(400);

    // ap_ token 踢粉丝 → 200，粉丝 ws 收到 error 并被关
    const kick = await api(`/api/channels/${slug}/kick`, apToken, {
      method: "POST",
      body: JSON.stringify({ name: "fan-kick" }),
    });
    expect(kick.status).toBe(200);
    expect((await fanWs.nextOfType("error")).code).toBe("unauthorized");
    fanWs.close();
  });

  it("OIDC owner can kick in their own channel; 404 for missing channel", async () => {
    const owner = await jwtFor("owner-kick", "owner-kick@leeguoo.com");
    const slug = await makeChannel(owner, "public");
    const ok = await api(`/api/channels/${slug}/kick`, owner, {
      method: "POST",
      body: JSON.stringify({ name: "nobody" }),
    });
    expect(ok.status).toBe(200);

    const missing = await api(`/api/channels/${uniq("nope")}/kick`, owner, {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("channel role assignments (issues #14/#17)", () => {
  it("moderator-assigned role overrides self-asserted status role in history and presence", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: acct });
    const worker = await seedToken("agent", uniq("worker"), { owner: acct });
    const slug = await makeChannel(owner.token, "private");

    const assign = await api(`/api/channels/${slug}/roles/${worker.name}`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ role: "host", responsibility: "main handoff owner" }),
    });
    expect(assign.status).toBe(200);
    expect((await assign.json()) as { name: string; role: string; responsibility: string; kind: string; account: string; display: string }).toMatchObject({
      name: worker.name,
      role: "host",
      responsibility: "main handoff owner",
      kind: "agent",
      account: acct,
      display: worker.name,
    });

    const roleList = (await (await api(`/api/channels/${slug}/roles`, owner.token)).json()) as {
      roles: { name: string; role: string; responsibility: string | null; assigned_by: string; account?: string }[];
    };
    expect(roleList.roles).toContainEqual(
      expect.objectContaining({ name: worker.name, role: "host", responsibility: "main handoff owner", assigned_by: owner.name, account: acct }),
    );

    expect(
      (await api(`/api/channels/${slug}/roles/${worker.name}`, owner.token, {
        method: "PUT",
        body: JSON.stringify({ role: "reviewer" }),
      })).status,
    ).toBe(200);
    const roleListAfterRoleOnly = (await (await api(`/api/channels/${slug}/roles`, owner.token)).json()) as {
      roles: { name: string; role: string; responsibility: string | null }[];
    };
    expect(roleListAfterRoleOnly.roles).toContainEqual(
      expect.objectContaining({ name: worker.name, role: "reviewer", responsibility: "main handoff owner" }),
    );

    expect(
      (await api(`/api/channels/${slug}/roles/${worker.name}`, owner.token, {
        method: "PUT",
        body: JSON.stringify({ role: "host", responsibility: "" }),
      })).status,
    ).toBe(200);
    const roleListAfterClear = (await (await api(`/api/channels/${slug}/roles`, owner.token)).json()) as {
      roles: { name: string; role: string; responsibility: string | null }[];
    };
    expect(roleListAfterClear.roles).toContainEqual(
      expect.objectContaining({ name: worker.name, role: "host", responsibility: null }),
    );

    const status = await api(`/api/channels/${slug}/messages`, worker.token, {
      method: "POST",
      body: JSON.stringify({
        kind: "status",
        state: "working",
        note: "claiming role from status frame",
        mentions: [],
        role: "worker",
      }),
    });
    expect(status.status).toBe(200);

    const history = (await (await api(`/api/channels/${slug}/messages`, owner.token)).json()) as {
      messages: { role?: string; role_source?: string }[];
    };
    expect(history.messages[0]).toMatchObject({ role: "host", role_source: "assigned" });

    const presenceBody = (await (await api(`/api/channels/${slug}/presence`, owner.token)).json()) as {
      presence: { name: string; role?: string; role_source?: string }[];
    };
    const found = presenceBody.presence.find((p) => p.name === worker.name);
    expect(found).toMatchObject({ name: worker.name, role: "host", role_source: "assigned" });
  });

  it("non-moderators cannot assign roles and clearing an assigned role removes the authoritative badge", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: acct });
    const worker = await seedToken("agent", uniq("worker"), { owner: acct });
    const readonly = await seedToken("readonly", uniq("ro"), { owner: acct, channelScope: "placeholder" });
    const slug = await makeChannel(owner.token, "private");

    const denied = await api(`/api/channels/${slug}/roles/${worker.name}`, readonly.token, {
      method: "PUT",
      body: JSON.stringify({ role: "host" }),
    });
    expect(denied.status).toBe(403);

    expect(
      (await api(`/api/channels/${slug}/roles/${worker.name}`, owner.token, {
        method: "PUT",
        body: JSON.stringify({ role: "reviewer" }),
      })).status,
    ).toBe(200);
    expect(
      (await api(`/api/channels/${slug}/messages`, worker.token, {
        method: "POST",
        body: JSON.stringify({ kind: "status", state: "working", note: "reviewing", mentions: [] }),
      })).status,
    ).toBe(200);

    const cleared = await api(`/api/channels/${slug}/roles/${worker.name}`, owner.token, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    const presenceBody = (await (await api(`/api/channels/${slug}/presence`, owner.token)).json()) as {
      presence: { name: string; role?: string; role_source?: string }[];
    };
    const found = presenceBody.presence.find((p) => p.name === worker.name);
    expect(found?.role).toBeUndefined();
    expect(found?.role_source).toBeUndefined();
  });
});

describe("completion gate channel config (#34)", () => {
  it("lets moderators configure completion gate and rejects invalid bodies", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: acct });
    const slug = await makeChannel(owner.token, "private");

    const enabled = await api(`/api/channels/${slug}/completion-gate`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ gate: "reviewer", policy: "owner" }),
    });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()) as { gate: string; policy: string }).toEqual({
      gate: "reviewer",
      policy: "owner",
    });
    const row = await env.DB.prepare(
      "SELECT completion_gate, completion_review_policy FROM channels WHERE slug = ?",
    )
      .bind(slug)
      .first<{ completion_gate: string; completion_review_policy: string }>();
    expect(row).toEqual({ completion_gate: "reviewer", completion_review_policy: "owner" });

    const off = await api(`/api/channels/${slug}/completion-gate`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ gate: "off" }),
    });
    expect(off.status).toBe(200);
    expect((await off.json()) as { gate: string; policy: string }).toEqual({ gate: "off", policy: "owner" });

    const badGate = await api(`/api/channels/${slug}/completion-gate`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ gate: "quorum" }),
    });
    expect(badGate.status).toBe(400);
    const badPolicy = await api(`/api/channels/${slug}/completion-gate`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ gate: "reviewer", policy: "assigned_reviewer" }),
    });
    expect(badPolicy.status).toBe(400);
  });

  it("requires channel moderator permissions", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: acct });
    const scoped = await seedToken("agent", uniq("scoped"), { owner: acct, channelScope: "placeholder" });
    const readonly = await seedToken("readonly", uniq("ro"), { owner: acct, channelScope: "placeholder" });
    const slug = await makeChannel(owner.token, "private");

    const scopedDenied = await api(`/api/channels/${slug}/completion-gate`, scoped.token, {
      method: "PUT",
      body: JSON.stringify({ gate: "reviewer" }),
    });
    expect(scopedDenied.status).toBe(403);

    const readonlyDenied = await api(`/api/channels/${slug}/completion-gate`, readonly.token, {
      method: "PUT",
      body: JSON.stringify({ gate: "reviewer" }),
    });
    expect(readonlyDenied.status).toBe(403);
  });
});

// ── webhook 管理仅限房主/ap_（spec §7/§15）── 补 bypass #1：粉丝不得注册/查看/删除 webhook ──
describe("webhook management is moderator-only (spec §7/§15)", () => {
  const hook = { name: "hermes", url: "https://hooks.test/wake", secret: "s", filter: "mentions" };

  it("fan (OIDC non-owner) is forbidden on POST/GET/DELETE for a private channel", async () => {
    const { token: apToken } = await seedToken("agent");
    const slug = await makeChannel(apToken, "private"); // created_by = ap agent，粉丝无权
    const fan = await jwtFor("wh-fan", "wh-fan@leeguoo.com");

    const post = await api(`/api/channels/${slug}/webhooks`, fan, {
      method: "POST",
      body: JSON.stringify(hook),
    });
    expect(post.status).toBe(403);
    expect((await post.json()) as { error: { code: string } }).toMatchObject({ error: { code: "forbidden" } });

    const list = await api(`/api/channels/${slug}/webhooks`, fan);
    expect(list.status).toBe(403);

    const del = await api(`/api/channels/${slug}/webhooks/hermes`, fan, { method: "DELETE" });
    expect(del.status).toBe(403);

    // 确认粉丝确实什么都没写进去：房主查列表为空
    const ownerList = (await (await api(`/api/channels/${slug}/webhooks`, apToken)).json()) as {
      webhooks: unknown[];
    };
    expect(ownerList.webhooks).toHaveLength(0);
  });

  it("fan is forbidden on webhooks even for a PUBLIC channel (可读写≠可管理)", async () => {
    const { token: apToken } = await seedToken("agent");
    const slug = await makeChannel(apToken, "public");
    const fan = await jwtFor("wh-fan-pub", "wh-fan-pub@leeguoo.com");
    const post = await api(`/api/channels/${slug}/webhooks`, fan, {
      method: "POST",
      body: JSON.stringify(hook),
    });
    expect(post.status).toBe(403);
    expect((await post.json()) as { error: { code: string } }).toMatchObject({ error: { code: "forbidden" } });
  });

  it("ap_ token (creator) may register, list and delete", async () => {
    const { token: apToken } = await seedToken("agent");
    const slug = await makeChannel(apToken, "private");
    expect(
      (await api(`/api/channels/${slug}/webhooks`, apToken, { method: "POST", body: JSON.stringify(hook) }))
        .status,
    ).toBe(201);
    expect((await api(`/api/channels/${slug}/webhooks`, apToken)).status).toBe(200);
    expect(
      (await api(`/api/channels/${slug}/webhooks/hermes`, apToken, { method: "DELETE" })).status,
    ).toBe(200);
  });

  it("OIDC channel owner may manage webhooks in their own channel", async () => {
    const owner = await jwtFor("wh-owner", "wh-owner@leeguoo.com");
    const slug = await makeChannel(owner, "private"); // created_by = owner sub
    expect(
      (await api(`/api/channels/${slug}/webhooks`, owner, { method: "POST", body: JSON.stringify(hook) }))
        .status,
    ).toBe(201);
    expect((await api(`/api/channels/${slug}/webhooks`, owner)).status).toBe(200);
    expect(
      (await api(`/api/channels/${slug}/webhooks/hermes`, owner, { method: "DELETE" })).status,
    ).toBe(200);
  });
});

// ── 频道列表按 ACL 过滤（spec §3.2）── 补 bypass #2：无权私有频道连名字都不出现 ──
describe("GET /api/channels hides inaccessible private channels (spec §3.2)", () => {
  it("fan sees public but not someone else's private; ap_ and OIDC owner see their own private", async () => {
    const { token: apToken } = await seedToken("agent");
    const priv = await makeChannel(apToken, "private"); // created_by = ap agent，粉丝无权
    const pub = await makeChannel(apToken, "public");
    const fan = await jwtFor("list-fan", "list-fan@leeguoo.com");

    const fanRes = await api("/api/channels", fan);
    expect(fanRes.status).toBe(200);
    const fanChannels = ((await fanRes.json()) as {
      channels: { slug: string; created_by?: unknown }[];
    }).channels;
    const fanSlugs = fanChannels.map((ch) => ch.slug);
    expect(fanSlugs).not.toContain(priv); // 私有频道连名字都不给
    expect(fanSlugs).toContain(pub);
    // created_by 不得回给客户端（仅用于服务端 ACL 判定）
    for (const ch of fanChannels) expect(ch.created_by).toBeUndefined();

    // ap_ token 能看到该私有频道
    const apSlugs = ((await (await api("/api/channels", apToken)).json()) as {
      channels: { slug: string }[];
    }).channels.map((ch) => ch.slug);
    expect(apSlugs).toContain(priv);

    // OIDC 房主看得到自己的私有频道，但仍看不到别人的私有频道
    const owner = await jwtFor("list-owner", "list-owner@leeguoo.com");
    const ownerPriv = await makeChannel(owner, "private");
    const ownerSlugs = ((await (await api("/api/channels", owner)).json()) as {
      channels: { slug: string }[];
    }).channels.map((ch) => ch.slug);
    expect(ownerSlugs).toContain(ownerPriv);
    expect(ownerSlugs).not.toContain(priv);
  });
});

// ── channel-scoped token 硬上限（spec §5.3/§5.4/§5.5）── 跨公司隔离的真正手段 ──
describe("channel_scope enforcement (spec §5.4/§5.5)", () => {
  it("scoped agent token: only its scope channel; same-owner other private is forbidden; public ok", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const { token: ownerTok } = await seedToken("agent", uniq("owner"), { owner: acct });
    const collab = await makeChannel(ownerTok, "private"); // owner_account = acct
    const mine = await makeChannel(ownerTok, "private"); // 同账号名下另一私有频道
    const pub = await makeChannel(ownerTok, "public");
    const { token: scoped } = await seedToken("agent", uniq("bcorp"), { owner: acct, channelScope: collab });

    // scope 频道：WS/GET/POST 三关全过
    expect(await wsUpgradeStatus(collab, scoped)).toBe(101);
    expect((await api(`/api/channels/${collab}/messages`, scoped)).status).toBe(200);
    expect((await postMsg(collab, scoped, "hi from b-corp")).status).toBe(200);

    // 同 owner 的另一私有频道：scope 硬上限，连读都拒（WS accept-then-close 1008 / GET 403 / POST 403）
    const denied = await wsForbiddenClose(mine, scoped);
    expect(denied.code).toBe(1008);
    expect(denied.reason).toBe("forbidden");
    expect((await api(`/api/channels/${mine}/messages`, scoped)).status).toBe(403);
    expect((await postMsg(mine, scoped, "let me in")).status).toBe(403);

    // 公开频道仍可进可发
    expect(await wsUpgradeStatus(pub, scoped)).toBe(101);
    expect((await postMsg(pub, scoped, "public hello")).status).toBe(200);

    // scoped token 不在别账号私有频道的列表里，只看得到 scope 频道 + public
    const listSlugs = ((await (await api("/api/channels", scoped)).json()) as {
      channels: { slug: string }[];
    }).channels.map((ch) => ch.slug);
    expect(listSlugs).toContain(collab);
    expect(listSlugs).toContain(pub);
    expect(listSlugs).not.toContain(mine);
  });

  it("scoped token cannot create channels (不得借建频道逃出 scope)", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const { token: scoped } = await seedToken("agent", uniq("bcorp"), { owner: acct, channelScope: "collab" });
    const res = await api("/api/channels", scoped, {
      method: "POST",
      body: JSON.stringify({ slug: uniq("squat"), kind: "standing", visibility: "public" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "forbidden" } });
  });

  it("scoped readonly share token: read-only single channel; can't send; scope mismatch forbidden", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const { token: ownerTok } = await seedToken("agent", uniq("owner"), { owner: acct });
    const collab = await makeChannel(ownerTok, "private");
    const mine = await makeChannel(ownerTok, "private");
    const { token: share } = await seedToken("readonly", uniq("share"), { owner: acct, channelScope: collab });

    // scope 频道可读（WS/GET），但 readonly 不能发（do 侧 403 unauthorized）
    expect(await wsUpgradeStatus(collab, share)).toBe(101);
    expect((await api(`/api/channels/${collab}/messages`, share)).status).toBe(200);
    const post = await postMsg(collab, share, "nope");
    expect(post.status).toBe(403);
    expect((await post.json()) as { error: { code: string } }).toMatchObject({ error: { code: "unauthorized" } });

    // scope 不匹配的私有频道连读都拒
    expect((await api(`/api/channels/${mine}/messages`, share)).status).toBe(403);
    const denied = await wsForbiddenClose(mine, share);
    expect(denied.code).toBe(1008);
  });

  it("readonly token WITHOUT scope: private channels denied (不该再签发无 scope readonly)", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const { token: ownerTok } = await seedToken("agent", uniq("owner"), { owner: acct });
    const priv = await makeChannel(ownerTok, "private");
    // 带 owner 但无 channel_scope 的 readonly：即便 account===owner_account 也拒私有
    const { token: roPlain } = await seedToken("readonly", uniq("ro-plain"), { owner: acct });
    expect((await api(`/api/channels/${priv}/messages`, roPlain)).status).toBe(403);
    const denied = await wsForbiddenClose(priv, roPlain);
    expect(denied.code).toBe(1008);
  });

  it("account owner cannot enter an owner_account=null legacy channel (spec §6)", async () => {
    // legacy token（无 owner）建的频道 owner_account = null
    const { token: legacyTok } = await seedToken("agent", uniq("legacy"));
    const legacyCh = await makeChannel(legacyTok, "private"); // owner_account = null
    // 带 owner 的 token / OIDC 都进不去 owner_account=null 的老频道
    const { token: ownedTok } = await seedToken("agent", uniq("owned"), { owner: `${uniq("a")}@leeguoo.com` });
    expect((await api(`/api/channels/${legacyCh}/messages`, ownedTok)).status).toBe(403);
    const oidc = await jwtFor(uniq("sub"), `${uniq("u")}@leeguoo.com`);
    expect((await api(`/api/channels/${legacyCh}/messages`, oidc)).status).toBe(403);
    // 但 legacy token 自己（过渡放行）仍进得去
    expect((await api(`/api/channels/${legacyCh}/messages`, legacyTok)).status).toBe(200);
  });
});

// ── P1 起强制新铸 token 带 owner（spec §6 修复3）+ 接受 channel_scope ──
describe("token mint requires owner and accepts channel_scope (spec §6/§5.3)", () => {
  function mintToken(body: Record<string, unknown>, headers: Record<string, string> = ADMIN_HEADERS) {
    return SELF.fetch("http://ap.test/api/tokens", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects minting without owner (400 owner required), even with ADMIN_SECRET", async () => {
    const res = await mintToken({ name: uniq("no-owner"), role: "agent" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { message: string } }).toMatchObject({
      error: { message: "owner required" },
    });
  });

  it("mints a scoped agent token and echoes channel_scope; the token is limited to that channel", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const { token: ownerTok } = await seedToken("agent", uniq("owner"), { owner: acct });
    const collab = await makeChannel(ownerTok, "private");
    const mine = await makeChannel(ownerTok, "private");

    // 模拟 party invite 的 worker mint：带 owner + channel_scope
    const res = await mintToken({ name: uniq("invitee"), role: "agent", owner: acct, channel_scope: collab });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; owner: string; channel_scope: string };
    expect(body.owner).toBe(acct);
    expect(body.channel_scope).toBe(collab);

    // scope 生效：只进 collab，进不了同 owner 的 mine
    expect((await postMsg(collab, body.token, "scoped hi")).status).toBe(200);
    expect((await api(`/api/channels/${mine}/messages`, body.token)).status).toBe(403);
  });

  it("mints a scoped readonly share token (invite 分享链接)", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const { token: ownerTok } = await seedToken("agent", uniq("owner"), { owner: acct });
    const collab = await makeChannel(ownerTok, "private");
    const res = await mintToken({ name: uniq("shared"), role: "readonly", owner: acct, channel_scope: collab });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; channel_scope: string };
    expect(body.channel_scope).toBe(collab);
    // 可读单频道
    expect((await api(`/api/channels/${collab}/messages`, body.token)).status).toBe(200);
  });

  it("rejects an invalid channel_scope (not a valid slug)", async () => {
    const res = await mintToken({ name: uniq("badscope"), role: "agent", owner: "leo@leeguoo.com", channel_scope: "Bad Slug!" });
    expect(res.status).toBe(400);
  });

  it("plain (unscoped) token minted with owner has no channel_scope in response", async () => {
    const res = await mintToken({ name: uniq("plain"), role: "agent", owner: "leo@leeguoo.com" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ owner: "leo@leeguoo.com" });
    expect(body).not.toHaveProperty("channel_scope");
  });
});
