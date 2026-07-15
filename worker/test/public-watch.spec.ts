// #381 第三档访问模式 public_watch：任意人可观看（读），参与（发送）需成员/被邀请。
// 读门与 public 一致；写门在 worker（持 D1 成员表）算好 x-ap-can-write，DO handleSend 强制。
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, completeCapabilityHello, seedToken, uniq, WsClient } from "./helpers";

async function makeChannel(token: string, visibility: string): Promise<string> {
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

async function addMember(slug: string, ownerToken: string, account: string): Promise<void> {
  const res = await api(`/api/channels/${slug}/members/${encodeURIComponent(account)}`, ownerToken, { method: "PUT" });
  if (res.status !== 200) throw new Error(`add member failed: ${res.status}`);
}

describe("public_watch: anyone can watch, participating needs membership/invite (#381)", () => {
  it("creating a public_watch channel is accepted and reported", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("o")}@x.com` });
    const slug = uniq("ch");
    const res = await api("/api/channels", owner.token, {
      method: "POST",
      body: JSON.stringify({ slug, kind: "standing", visibility: "public_watch" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug, visibility: "public_watch" });
  });

  it("stranger (non-member, non-readonly) can READ/watch but is REJECTED from sending; a member CAN send", async () => {
    const ownerAcct = `${uniq("owner")}@x.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token, "public_watch");

    const strangerAcct = `${uniq("stranger")}@x.com`;
    const stranger = await seedToken("agent", uniq("stranger"), { owner: strangerAcct });

    // READ/watch gates: GET history, presence, WS upgrade all pass for the stranger
    expect((await api(`/api/channels/${slug}/messages`, stranger.token)).status).toBe(200);
    expect((await api(`/api/channels/${slug}/presence`, stranger.token)).status).toBe(200);
    expect(await wsUpgradeStatus(slug, stranger.token)).toBe(101);

    // WRITE gate (REST): stranger rejected
    const postRest = await postMsg(slug, stranger.token, "let me participate");
    expect(postRest.status).toBe(403);
    expect((await postRest.json()) as { error: { code: string } }).toMatchObject({ error: { code: "unauthorized" } });

    // WRITE gate (WS): stranger's send frame rejected even though the socket is open (they can watch)
    const ws = await WsClient.open(slug, stranger.token, "protocol");
    expect((await completeCapabilityHello(ws)).type).toBe("welcome");
    ws.send({ type: "send", kind: "message", body: "sneaking in", mentions: [], reply_to: null });
    expect((await ws.nextOfType("error")).code).toBe("unauthorized");
    ws.close();

    // Owner (moderator/account owner) can send
    expect((await postMsg(slug, owner.token, "owner speaks")).status).toBe(200);

    // After being added as a member, the former stranger CAN send
    await addMember(slug, owner.token, strangerAcct);
    expect((await postMsg(slug, stranger.token, "now a member")).status).toBe(200);
    // …and over WS too
    const ws2 = await WsClient.open(slug, stranger.token, "protocol");
    expect((await completeCapabilityHello(ws2)).type).toBe("welcome");
    ws2.send({ type: "send", kind: "message", body: "member ws send", mentions: [], reply_to: null });
    expect((await ws2.nextOfType("sent")).type).toBe("sent");
    ws2.close();
  });

  it("an invited channel-scoped token can participate in a public_watch channel", async () => {
    const ownerAcct = `${uniq("owner")}@x.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token, "public_watch");
    // scoped token = invited to exactly this channel
    const guest = await seedToken("agent", uniq("guest"), { owner: `${uniq("g")}@x.com`, channelScope: slug });
    expect((await postMsg(slug, guest.token, "invited, so i may speak")).status).toBe(200);
  });

  it("readonly token can watch a public_watch channel but not send (unchanged)", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("o")}@x.com` });
    const slug = await makeChannel(owner.token, "public_watch");
    const ro = await seedToken("readonly");
    // can read
    expect((await api(`/api/channels/${slug}/messages`, ro.token)).status).toBe(200);
    // cannot send
    const post = await postMsg(slug, ro.token, "readonly write");
    expect(post.status).toBe(403);
  });

  it("plain public channel still lets any non-readonly stranger send (no regression)", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("o")}@x.com` });
    const slug = await makeChannel(owner.token, "public");
    const stranger = await seedToken("agent", uniq("stranger"), { owner: `${uniq("s")}@x.com` });
    expect((await postMsg(slug, stranger.token, "public is open to all")).status).toBe(200);
    const ws = await WsClient.open(slug, stranger.token, "protocol");
    expect((await completeCapabilityHello(ws)).type).toBe("welcome");
    ws.send({ type: "send", kind: "message", body: "ws in public", mentions: [], reply_to: null });
    expect((await ws.nextOfType("sent")).type).toBe("sent");
    ws.close();
  });

  it("PUT /visibility accepts public_watch; private→public_watch needs confirm (exposes history)", async () => {
    const ownerAcct = `${uniq("owner")}@x.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token, "private");
    // send some history so the confirm gate has something to report
    expect((await postMsg(slug, owner.token, "secret history")).status).toBe(200);

    // without confirm → 409 needs_confirm (same protection as private→public)
    const noConfirm = await api(`/api/channels/${slug}/visibility`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ visibility: "public_watch" }),
    });
    expect(noConfirm.status).toBe(409);
    expect((await noConfirm.json()) as { needs_confirm: boolean }).toMatchObject({ needs_confirm: true });

    // with confirm → 200 and channel becomes public_watch
    const confirmed = await api(`/api/channels/${slug}/visibility`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ visibility: "public_watch", confirm: true }),
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()) as { visibility: string; changed: boolean }).toMatchObject({
      visibility: "public_watch",
      changed: true,
    });
    const row = await env.DB.prepare("SELECT visibility FROM channels WHERE slug = ?").bind(slug).first<{ visibility: string }>();
    expect(row?.visibility).toBe("public_watch");
  });

  it("toggling an existing channel to public_watch immediately gates in-flight WS senders", async () => {
    const ownerAcct = `${uniq("owner")}@x.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token, "public");
    const stranger = await seedToken("agent", uniq("stranger"), { owner: `${uniq("s")}@x.com` });

    // stranger opens WS while public — can send now
    const ws = await WsClient.open(slug, stranger.token, "protocol");
    expect((await completeCapabilityHello(ws)).type).toBe("welcome");
    ws.send({ type: "send", kind: "message", body: "while public", mentions: [], reply_to: null });
    expect((await ws.nextOfType("sent")).type).toBe("sent");

    // owner flips to public_watch (confirm to expose history)
    const put = await api(`/api/channels/${slug}/visibility`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ visibility: "public_watch", confirm: true }),
    });
    expect(put.status).toBe(200);

    // the same in-flight socket can no longer send (authoritative meta refresh gates it)
    ws.send({ type: "send", kind: "message", body: "after flip", mentions: [], reply_to: null });
    expect((await ws.nextOfType("error")).code).toBe("unauthorized");
    ws.close();
  });
});
