import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { api, createChannel, postMessage, seedToken, uniq, WsClient } from "./helpers";

describe("channels", () => {
  it("creates and lists a channel", async () => {
    const { token } = await seedToken("agent");
    const slug = uniq("ch");
    const res = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug, title: "joint debug", kind: "temp" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug, title: "joint debug", kind: "temp" });

    const list = await api("/api/channels", token);
    expect(list.status).toBe(200);
    const { channels } = (await list.json()) as {
      channels: { slug: string; kind: string; archived_at: number | null }[];
    };
    const found = channels.find((c) => c.slug === slug);
    expect(found).toMatchObject({ slug, kind: "temp", archived_at: null });
  });

  it("list stays lightweight by default and aggregates summary only when requested", async () => {
    const { token, name } = await seedToken("agent");
    const slug = uniq("ch");
    const created = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug, kind: "standing" }),
    });
    expect(created.status).toBe(201);

    // 没消息时摘要为空但字段在
    let list = await api("/api/channels", token);
    type Listed = {
      slug: string;
      last_message: { sender: string; kind: string; body: string; ts: number } | null;
      presence: { name: string; state: string }[];
    };
    let found = ((await list.json()) as { channels: Listed[] }).channels.find((c) => c.slug === slug);
    expect(found).toMatchObject({ last_message: null, presence: [] });

    expect((await postMessage(slug, token, "latest news")).status).toBe(200);
    const status = await api(`/api/channels/${slug}/messages`, token, {
      method: "POST",
      body: JSON.stringify({ kind: "status", state: "working", note: "digging" }),
    });
    expect(status.status).toBe(200);

    list = await api("/api/channels", token);
    found = ((await list.json()) as { channels: Listed[] }).channels.find((c) => c.slug === slug);
    expect(found).toMatchObject({ last_message: null, presence: [] });

    list = await api("/api/channels?summary=1", token);
    found = ((await list.json()) as { channels: Listed[] }).channels.find((c) => c.slug === slug);
    expect(found?.last_message).toMatchObject({ sender: name, kind: "status", body: "digging" });
    expect(found?.presence).toContainEqual(expect.objectContaining({ name, state: "working" }));
  });

  it("409 on slug conflict", async () => {
    const { token } = await seedToken("agent");
    const slug = uniq("ch");
    const create = () =>
      api("/api/channels", token, { method: "POST", body: JSON.stringify({ slug, kind: "standing" }) });
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(409);
  });

  it("400 on invalid slug or kind", async () => {
    const { token } = await seedToken("agent");
    const bad = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: "Bad Slug!", kind: "standing" }),
    });
    expect(bad.status).toBe(400);
    const badKind = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: uniq("ch"), kind: "forever" }),
    });
    expect(badKind.status).toBe(400);
  });

  it("403 when readonly token tries to create a channel", async () => {
    const { token } = await seedToken("readonly");
    const res = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: uniq("ro"), kind: "standing" }),
    });
    expect(res.status).toBe(403);
  });

  it("channel-scoped token can create its own scope channel but not others (issue #31)", async () => {
    const scope = uniq("scope");
    const { token } = await seedToken("agent", uniq("guest"), { owner: "leo@x.com", channelScope: scope });
    // 建自己 scope 的频道：放行（invite 先 mint scoped token 再建同名频道的正常路径）
    const own = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: scope, kind: "standing" }),
    });
    expect(own.status).toBe(201);
    // 建任意其它频道：仍 403，越不了 scope
    const other = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: uniq("other"), kind: "standing" }),
    });
    expect(other.status).toBe(403);
  });

  it("401 without a token", async () => {
    const res = await api("/api/channels", "");
    expect(res.status).toBe(401);
  });

  it("query token does not authorize REST, and websocket query auth is readonly-only", async () => {
    const agent = await seedToken("agent");
    const ro = await seedToken("readonly");
    const slug = await createChannel(agent.token);

    const list = await SELF.fetch(`http://ap.test/api/channels?t=${encodeURIComponent(agent.token)}`);
    expect(list.status).toBe(401);

    const write = await SELF.fetch(
      `http://ap.test/api/channels/${slug}/messages?t=${encodeURIComponent(agent.token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "message", body: "nope", mentions: [], reply_to: null }),
      },
    );
    expect(write.status).toBe(401);

    const rejectedWs = await SELF.fetch(
      `http://ap.test/api/channels/${slug}/ws?t=${encodeURIComponent(agent.token)}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(rejectedWs.status).toBe(403);

    const ws = await WsClient.open(slug, ro.token, "query");
    expect((await ws.nextOfType("welcome")).type).toBe("welcome");
    ws.send({ type: "send", kind: "message", body: "readonly", mentions: [], reply_to: null });
    expect((await ws.nextOfType("error")).code).toBe("unauthorized");
    ws.close();
  });

  it("identity map exposes readable labels only after channel ACL passes", async () => {
    const ownerName = "61ec302c-6c31-4bca-a1df-88152372f6d9";
    const ownerAccount = "owner@example.com";
    const owner = await seedToken("human", ownerName, { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const agent = await seedToken("agent", uniq("bot"), { owner: ownerAccount, channelScope: slug });
    expect((await postMessage(slug, agent.token, `@${ownerName} hello`)).status).toBe(200);

    const identitiesRes = await api(`/api/channels/${slug}/identities`, agent.token);
    expect(identitiesRes.status).toBe(200);
    const identities = ((await identitiesRes.json()) as {
      identities: { name: string; display: string; kind?: string; account?: string }[];
    }).identities;
    expect(identities).toContainEqual(
      expect.objectContaining({ name: ownerName, display: ownerAccount, kind: "human", account: ownerAccount }),
    );
    expect(identities).toContainEqual(expect.objectContaining({ name: agent.name, display: agent.name }));

    const outsider = await seedToken("human", uniq("outsider"), { owner: "outsider@example.com" });
    expect((await api(`/api/channels/${slug}/identities`, outsider.token)).status).toBe(403);
  });
});
