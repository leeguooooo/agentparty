// 公开/私有频道访问控制（spec §3.2 矩阵 + §5 踢人）
// 单元：canAccessChannel / isChannelModerator 全矩阵
// 集成：WS 升级 / REST GET / REST POST 三处强制 + 踢人
import { SELF, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canAccessChannel, isChannelModerator, type AclIdentity, type ChannelAcl } from "../src/acl";
import { api, seedToken, uniq, WsClient } from "./helpers";

// ── 单元：矩阵 ──────────────────────────────────────────────────────────────

const apAgent: AclIdentity = { hash: "a".repeat(64), name: "leo-agent", role: "agent" };
const apHuman: AclIdentity = { hash: "b".repeat(64), name: "leo-human", role: "human" };
const apReadonly: AclIdentity = { hash: "c".repeat(64), name: "share-link", role: "readonly" };
const oidcOwner: AclIdentity = {
  hash: "oidc:owner-sub",
  name: "owner-sub",
  role: "human",
  email: "owner@leeguoo.com",
};
const oidcFan: AclIdentity = { hash: "oidc:fan-sub", name: "fan-sub", role: "human", email: "fan@leeguoo.com" };

const publicCh: ChannelAcl = { visibility: "public", created_by: "owner-sub" };
const privateBySub: ChannelAcl = { visibility: "private", created_by: "owner-sub" };
const privateByEmail: ChannelAcl = { visibility: "private", created_by: "owner@leeguoo.com" };
const privateNoOwner: ChannelAcl = { visibility: "private", created_by: null };

describe("canAccessChannel matrix (spec §3.2)", () => {
  it("public channel: every authenticated identity may enter", () => {
    for (const id of [apAgent, apHuman, apReadonly, oidcOwner, oidcFan]) {
      expect(canAccessChannel(id, publicCh)).toBe(true);
    }
  });

  it("private channel: every ap_ token (agent/human/readonly) may enter", () => {
    for (const id of [apAgent, apHuman, apReadonly]) {
      expect(canAccessChannel(id, privateBySub)).toBe(true);
      expect(canAccessChannel(id, privateNoOwner)).toBe(true);
    }
  });

  it("private channel: OIDC owner may enter (name===created_by or email===created_by)", () => {
    expect(canAccessChannel(oidcOwner, privateBySub)).toBe(true); // name(sub) 命中
    expect(canAccessChannel(oidcOwner, privateByEmail)).toBe(true); // email 命中
  });

  it("private channel: OIDC non-owner (fan) is denied", () => {
    expect(canAccessChannel(oidcFan, privateBySub)).toBe(false);
    expect(canAccessChannel(oidcFan, privateByEmail)).toBe(false);
    expect(canAccessChannel(oidcFan, privateNoOwner)).toBe(false);
    // created_by 为 null 时房主也不会误命中（undefined/null 不等）
    expect(canAccessChannel(oidcOwner, privateNoOwner)).toBe(false);
  });

  it("public channel: OIDC fan may enter", () => {
    expect(canAccessChannel(oidcFan, publicCh)).toBe(true);
  });
});

describe("isChannelModerator (spec §5 kick)", () => {
  it("ap_ agent/human may moderate any channel", () => {
    expect(isChannelModerator(apAgent, privateBySub)).toBe(true);
    expect(isChannelModerator(apHuman, publicCh)).toBe(true);
  });

  it("readonly ap_ token may not moderate", () => {
    expect(isChannelModerator(apReadonly, privateBySub)).toBe(false);
    expect(isChannelModerator(apReadonly, publicCh)).toBe(false);
  });

  it("OIDC owner may moderate own channel, fan may not", () => {
    expect(isChannelModerator(oidcOwner, privateBySub)).toBe(true);
    expect(isChannelModerator(oidcFan, publicCh)).toBe(false);
    expect(isChannelModerator(oidcFan, privateBySub)).toBe(false);
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
