import { env, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, completeCapabilityHello, createChannel, seedToken, uniq, WsClient } from "./helpers";
import { fetchMock } from "./fetch-mock";

const LARK_ORIGIN = "https://open.larksuite.com";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => fetchMock.deactivate());

describe("Lark OAuth human presence (#527)", () => {
  it("keeps a no-email Lark profile across first join, reconnect, messages, and a new channel", async () => {
    const openId = uniq("on_profile");
    const displayName = "Lark Profile User";
    const avatarUrl = "https://cdn.example/lark-profile.png";
    const avatarThumb = "https://cdn.example/lark-profile-thumb.png";

    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/authen/v2/oauth/token", method: "POST" })
      .reply(200, { code: 0, access_token: "oauth-user-token", expires_in: 3600 });
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/authen/v1/user_info", method: "GET" })
      .reply(200, {
        code: 0,
        data: {
          open_id: openId,
          name: displayName,
          avatar_url: avatarUrl,
          avatar_thumb: avatarThumb,
          tenant_key: "tenant-test",
        },
      });

    const callback = await SELF.fetch("http://ap.test/api/auth/lark-main/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", redirect_uri: "https://app.example/callback" }),
    });
    expect(callback.status).toBe(200);
    const session = (await callback.json()) as { access_token: string; email: string | null };
    expect(session.email).toBeNull();

    const profile = await env.DB.prepare(
      `SELECT account, handle, display_name, avatar_url, avatar_thumb, provider, provider_user_id
         FROM account_profiles WHERE provider = 'lark-main' AND provider_user_id = ?`,
    )
      .bind(openId)
      .first<Record<string, string>>();
    expect(profile).toMatchObject({
      display_name: displayName,
      avatar_url: avatarUrl,
      avatar_thumb: avatarThumb,
      provider: "lark-main",
      provider_user_id: openId,
    });

    const expectedPresence = {
      kind: "human",
      account: profile!.account,
      handle: profile!.handle,
      display_name: displayName,
      avatar_url: avatarUrl,
      avatar_thumb: avatarThumb,
    };
    const firstSlug = await createChannel(session.access_token);
    const watcher = await seedToken("agent", uniq("watcher"), { channelScope: firstSlug });
    const watcherWs = await WsClient.open(firstSlug, watcher.token);
    await completeCapabilityHello(watcherWs);

    const first = await WsClient.open(firstSlug, session.access_token);
    const firstWelcome = await completeCapabilityHello(first);
    expect(firstWelcome.presence).toContainEqual(expect.objectContaining(expectedPresence));

    first.send({ type: "send", kind: "message", body: "profile snapshot", mentions: [], reply_to: null });
    await first.nextOfType("sent");
    const sent = await watcherWs.nextOfType("msg");
    expect(sent.sender).toMatchObject({
      kind: "human",
      handle: profile!.handle,
      display_name: displayName,
      avatar_url: avatarUrl,
      avatar_thumb: avatarThumb,
    });

    first.close();
    const offline = await watcherWs.nextOfType("presence");
    expect(offline).toMatchObject({ name: firstWelcome.self, state: "offline", ...expectedPresence });

    const reconnected = await WsClient.open(firstSlug, session.access_token);
    const reconnectWelcome = await completeCapabilityHello(reconnected);
    expect(reconnectWelcome.presence).toContainEqual(expect.objectContaining(expectedPresence));

    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/authen/v2/oauth/token", method: "POST" })
      .reply(200, { code: 0, access_token: "oauth-user-token-refreshed", expires_in: 3600 });
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/authen/v1/user_info", method: "GET" })
      .reply(200, {
        code: 0,
        data: {
          open_id: openId,
          name: displayName,
          avatar_url: avatarUrl,
          avatar_thumb: avatarThumb,
          tenant_key: "tenant-test",
        },
      });
    const refreshedCallback = await SELF.fetch("http://ap.test/api/auth/lark-main/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code-refreshed", redirect_uri: "https://app.example/callback" }),
    });
    expect(refreshedCallback.status).toBe(200);
    const refreshedSession = (await refreshedCallback.json()) as { access_token: string };
    expect(refreshedSession.access_token).not.toBe(session.access_token);

    reconnected.close();
    await watcherWs.nextOfType("presence");
    const refreshed = await WsClient.open(firstSlug, refreshedSession.access_token);
    const refreshedWelcome = await completeCapabilityHello(refreshed);
    expect(refreshedWelcome.presence).toContainEqual(expect.objectContaining(expectedPresence));

    refreshed.send({ type: "send", kind: "message", body: "profile after refresh", mentions: [], reply_to: null });
    await refreshed.nextOfType("sent");
    const refreshedSent = await watcherWs.nextOfType("msg");
    expect(refreshedSent.sender).toMatchObject({
      kind: "human",
      handle: profile!.handle,
      display_name: displayName,
      avatar_url: avatarUrl,
      avatar_thumb: avatarThumb,
    });

    const secondSlug = await createChannel(refreshedSession.access_token);
    const second = await WsClient.open(secondSlug, refreshedSession.access_token);
    const secondWelcome = await completeCapabilityHello(second);
    expect(secondWelcome.presence).toContainEqual(expect.objectContaining(expectedPresence));

    const restPresence = await api(`/api/channels/${secondSlug}/presence`, refreshedSession.access_token);
    expect(restPresence.status).toBe(200);
    expect((await restPresence.json()) as unknown).toMatchObject({
      presence: [expect.objectContaining(expectedPresence)],
    });

    second.close();
    refreshed.close();
    watcherWs.close();
  });
});
