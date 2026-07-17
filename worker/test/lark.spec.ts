import { SELF, env, runInDurableObject } from "cloudflare:test";
import { fetchMock } from "./fetch-mock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import {
  buildMentionCard,
  clearLarkTokenCache,
  inferReceiveIdType,
  verifyWebhookSignature,
} from "../src/integrations/lark";
import { api, createChannel, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => {
  clearLarkTokenCache();
  fetchMock.assertNoPendingInterceptors();
});
afterAll(() => {
  fetchMock.deactivate();
});

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seedLarkProfile(account: string, handle = uniq("lark")) {
  await env.DB.prepare(
    `INSERT INTO account_profiles (
       account, handle, display_name, provider, provider_user_id, tenant_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(account, handle, "Lark User", "lark-main", "on_test_user", "tenant-test", Date.now(), Date.now())
    .run();
  return { account, handle, receiveId: "on_test_user" };
}

async function webhookRows(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec("SELECT name, url, filter FROM webhooks ORDER BY name")
      .toArray()
      .map((row) => ({ name: String(row.name), url: String(row.url), filter: String(row.filter) })),
  );
}

describe("lark notification integration", () => {
  it("infers receive id type and verifies DO webhook signatures", async () => {
    expect(inferReceiveIdType("ou_abc")).toBe("open_id");
    expect(inferReceiveIdType("on_abc")).toBe("union_id");
    expect(inferReceiveIdType("user@example.com")).toBe("email");

    const body = JSON.stringify({ ok: true });
    const sig = await hmacHex("secret", body);
    expect(await verifyWebhookSignature("secret", body, `hmac-sha256=${sig}`)).toBe(true);
    expect(await verifyWebhookSignature("secret", body, `hmac-sha256=${sig.slice(0, -1)}0`)).toBe(false);
  });

  it("escapes parentheses in attachment URLs before embedding them in Lark markdown", () => {
    const card = buildMentionCard({
      type: "msg",
      seq: 1,
      kind: "message",
      body: "proof",
      mentions: ["reviewer"],
      reply_to: null,
      state: null,
      note: null,
      status: null,
      ts: 1_700_000_000_000,
      channel: "qa",
      permalink: "https://ap.test/c/qa",
      sender: { name: "codex", kind: "agent" },
      attachments: [{
        key: "qa/hash/proof(1).png",
        filename: "proof(1).png",
        content_type: "image/png",
        size: 3,
        url: "https://ap.test/api/channels/qa/attachments/hash/proof(1).png?exp=1&sig=test",
      }],
    });
    const markdown = String((card.elements as Array<Record<string, unknown>>)[0]?.content);
    expect(markdown).toContain("proof%281%29.png?exp=1&sig=test");
    expect(markdown).not.toContain("proof(1).png?exp=1&sig=test");
  });

  it("enables a human subscription by registering a mentions webhook in the channel DO", async () => {
    const account = `lark-email:${uniq("owner")}@example.com`;
    const profile = await seedLarkProfile(account, "larkalice");
    const human = await seedToken("human", uniq("human"), { owner: account });
    const slug = await createChannel(human.token);
    const agent = await seedToken("agent", uniq("agent"), { owner: account });
    expect((await api(`/api/channels/${slug}/lark-notify`, agent.token, { method: "POST" })).status).toBe(403);

    const enabled = await api(`/api/channels/${slug}/lark-notify`, human.token, { method: "POST" });
    expect(enabled.status).toBe(201);
    expect(await enabled.json()).toMatchObject({
      enabled: true,
      channel_slug: slug,
      target_name: profile.handle,
      provider_id: "lark-main",
    });

    const status = await api(`/api/channels/${slug}/lark-notify`, human.token);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ enabled: true, target_name: profile.handle });
    expect(await webhookRows(slug)).toEqual([
      { name: profile.handle, url: `https://ap.test/api/integrations/lark/relay`, filter: "mentions" },
    ]);

    const off = await api(`/api/channels/${slug}/lark-notify`, human.token, { method: "DELETE" });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, channel_slug: slug });
    expect(await webhookRows(slug)).toEqual([]);
  });

  async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 2000): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("#595: adding a lark member auto-enrolls the mention subscription (idempotent, optout respected)", async () => {
    const ownerAccount = `lark-email:${uniq("owner")}@example.com`;
    await seedLarkProfile(ownerAccount, "larkowner");
    const owner = await seedToken("human", uniq("human"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);

    const memberAccount = "lark:on_auto_enroll_target";
    const memberProfile = await seedLarkProfile(memberAccount, "larkkarl");
    // 被拉进频道 → waitUntil 自动入册。
    const add = await api(`/api/channels/${slug}/members/${encodeURIComponent(memberAccount)}`, owner.token, { method: "PUT" });
    expect(add.status).toBe(200);
    // waitUntil 的落库时机不保证：条件轮询而非固定 sleep（评审意见）。
    const sub = await waitFor(() => env.DB.prepare(
      "SELECT target_name FROM lark_notify_subscriptions WHERE channel_slug = ? AND account = ?",
    ).bind(slug, memberAccount).first<{ target_name: string }>());
    expect(sub?.target_name).toBe(memberProfile.handle);
    expect((await webhookRows(slug)).some((row) => row.name === memberProfile.handle)).toBe(true);

    // 显式退订 → optout 记忆；再次入会不得重开。
    const member = await seedToken("human", uniq("member"), { owner: memberAccount });
    expect((await api(`/api/channels/${slug}/lark-notify`, member.token, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(memberAccount)}`, owner.token, { method: "PUT" })).status).toBe(200);
    // 负向断言没有「落库事件」可等：等一个足以让 waitUntil 完成的窗口（轮询确认始终为空）。
    const reappeared = await waitFor(() => env.DB.prepare(
      "SELECT 1 FROM lark_notify_subscriptions WHERE channel_slug = ? AND account = ?",
    ).bind(slug, memberAccount).first(), 300);
    expect(reappeared).toBeNull();

    // 手动重新开启 → optout 撤销。
    expect((await api(`/api/channels/${slug}/lark-notify`, member.token, { method: "POST" })).status).toBe(201);
    const optout = await env.DB.prepare(
      "SELECT 1 FROM lark_notify_optouts WHERE channel_slug = ? AND account = ?",
    ).bind(slug, memberAccount).first();
    expect(optout).toBeNull();
  });

  it("relays a valid signed mention webhook to a Lark private card", async () => {
    const account = `lark-email:${uniq("relay")}@example.com`;
    const profile = await seedLarkProfile(account, "larkrelay");
    const human = await seedToken("human", uniq("human"), { owner: account });
    const slug = await createChannel(human.token);
    const attachmentPath = `hash-${uniq("image")}/proof.png`;
    await env.ATTACHMENTS.put(`${slug}/${attachmentPath}`, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });
    expect((await api(`/api/channels/${slug}/lark-notify`, human.token, { method: "POST" })).status).toBe(201);
    const sub = await env.DB.prepare("SELECT secret FROM lark_notify_subscriptions WHERE channel_slug = ? AND account = ?")
      .bind(slug, account)
      .first<{ secret: string }>();
    expect(sub?.secret).toBeTruthy();

    const payload = JSON.stringify({
      type: "msg",
      kind: "message",
      seq: 7,
      body: `@${profile.handle} please check`,
      mentions: [profile.handle],
      reply_to: null,
      ts: Date.now(),
      channel: slug,
      permalink: `https://ap.test/c/${slug}`,
      sender: { name: "codex", kind: "agent", role: "agent", display: "Codex" },
      attachments: [{
        key: `${slug}/${attachmentPath}`,
        filename: "proof.png",
        content_type: "image/png",
        size: 3,
        url: `/api/channels/${slug}/attachments/${attachmentPath}`,
      }, {
        key: `other-private-channel/${attachmentPath}`,
        filename: "must-not-sign.png",
        content_type: "image/png",
        size: 3,
        url: `/api/channels/other-private-channel/attachments/${attachmentPath}`,
      }],
    });

    let larkMessage: Record<string, unknown> | null = null;
    fetchMock
      .get("https://open.larksuite.com")
      .intercept({ path: "/open-apis/auth/v3/tenant_access_token/internal", method: "POST" })
      .reply(200, { code: 0, tenant_access_token: "tenant-token", expire: 7200 });
    fetchMock
      .get("https://open.larksuite.com")
      .intercept({ path: "/open-apis/im/v1/messages?receive_id_type=union_id", method: "POST" })
      .reply(200, (opts) => {
        larkMessage = JSON.parse(String(opts.body)) as Record<string, unknown>;
        return { code: 0, data: { message_id: "om_test" } };
      });

    const relay = await SELF.fetch("http://ap.test/api/integrations/lark/relay", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sub!.secret}`,
        "content-type": "application/json",
        "x-agentparty-signature": `hmac-sha256=${await hmacHex(sub!.secret, payload)}`,
      },
      body: payload,
    });
    expect(relay.status).toBe(200);
    expect(await relay.json()).toEqual({ ok: true });
    const sent = larkMessage as unknown as Record<string, unknown>;
    expect(sent).toMatchObject({
      receive_id: "on_test_user",
      msg_type: "interactive",
    });
    const content = JSON.parse(String(sent.content)) as Record<string, unknown>;
    const markdown = String((content.elements as Array<Record<string, unknown>>)[0]?.content);
    const signedUrl = markdown.match(/\((http:\/\/ap\.test\/api\/channels\/[^)]+\?exp=\d+&sig=[A-Za-z0-9_-]+)\)/)?.[1];
    expect(signedUrl).toBeTypeOf("string");
    expect(markdown).toContain("proof.png");
    expect(markdown).not.toContain("must-not-sign.png");
    const image = await SELF.fetch(signedUrl!);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
  });

  it("rejects bad relay auth/signature and turns Lark nonzero code into retryable 502", async () => {
    const account = `lark-email:${uniq("bad")}@example.com`;
    const profile = await seedLarkProfile(account, "larkbad");
    const human = await seedToken("human", uniq("human"), { owner: account });
    const slug = await createChannel(human.token);
    expect((await api(`/api/channels/${slug}/lark-notify`, human.token, { method: "POST" })).status).toBe(201);
    const sub = await env.DB.prepare("SELECT secret FROM lark_notify_subscriptions WHERE channel_slug = ? AND account = ?")
      .bind(slug, account)
      .first<{ secret: string }>();
    const payload = JSON.stringify({
      type: "msg",
      kind: "message",
      seq: 8,
      body: `@${profile.handle} retry`,
      mentions: [profile.handle],
      reply_to: null,
      ts: Date.now(),
      channel: slug,
      permalink: `https://ap.test/c/${slug}`,
      sender: { name: "codex", kind: "agent", role: "agent" },
    });

    const unknown = await SELF.fetch("http://ap.test/api/integrations/lark/relay", {
      method: "POST",
      headers: { authorization: "Bearer missing", "x-agentparty-signature": "hmac-sha256=00" },
      body: payload,
    });
    expect(unknown.status).toBe(404);
    const badSig = await SELF.fetch("http://ap.test/api/integrations/lark/relay", {
      method: "POST",
      headers: { authorization: `Bearer ${sub!.secret}`, "x-agentparty-signature": "hmac-sha256=00" },
      body: payload,
    });
    expect(badSig.status).toBe(401);

    fetchMock
      .get("https://open.larksuite.com")
      .intercept({ path: "/open-apis/auth/v3/tenant_access_token/internal", method: "POST" })
      .reply(200, { code: 0, tenant_access_token: "tenant-token", expire: 7200 });
    fetchMock
      .get("https://open.larksuite.com")
      .intercept({ path: "/open-apis/im/v1/messages?receive_id_type=union_id", method: "POST" })
      .reply(200, { code: 999, msg: "permission denied" });
    const failed = await SELF.fetch("http://ap.test/api/integrations/lark/relay", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sub!.secret}`,
        "x-agentparty-signature": `hmac-sha256=${await hmacHex(sub!.secret, payload)}`,
      },
      body: payload,
    });
    expect(failed.status).toBe(502);
  });
});
