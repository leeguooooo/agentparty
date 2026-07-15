// 显示所属人（spec §10）：铸 token 时写入 owner → 该身份的 Sender（welcome participants / msg 帧 /
// 历史补拉）都带 owner；/api/me 回显登录身份的 owner。无 owner 的 token 保持旧形状（不带 owner 字段）。
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_HEADERS, WsClient, completeCapabilityHello, createChannel, seedToken, uniq } from "./helpers";

async function mintWithOwner(name: string, role: string, owner?: string) {
  const res = await SELF.fetch("http://ap.test/api/tokens", {
    method: "POST",
    headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(owner === undefined ? { name, role } : { name, role, owner }),
  });
  const body = (await res.json()) as { token: string; name: string; role: string; owner?: string };
  return { status: res.status, body };
}

describe("token owner propagation", () => {
  it("mints an ap_ token with owner and echoes it back", async () => {
    const { status, body } = await mintWithOwner(uniq("owned"), "agent", "leo@leeguoo.com");
    expect(status).toBe(201);
    expect(body.owner).toBe("leo@leeguoo.com");
  });

  it("rejects a non-ascii / oversized owner", async () => {
    const cjk = await mintWithOwner(uniq("bad-owner"), "agent", "老板");
    expect(cjk.status).toBe(400);
    const big = await mintWithOwner(uniq("big-owner"), "agent", "x".repeat(129));
    expect(big.status).toBe(400);
  });

  it("carries owner through welcome participants and the msg frame it sends", async () => {
    const name = uniq("agent-owned");
    const { body } = await mintWithOwner(name, "agent", "leo");
    const slug = await createChannel(body.token);
    const ws = await WsClient.open(slug, body.token);

    const welcome = await completeCapabilityHello(ws);
    expect(welcome.participants).toContainEqual({ name, kind: "agent", owner: "leo" });

    ws.send({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null });
    await ws.nextOfType("sent");
    const msg = await ws.nextOfType("msg");
    expect(msg.sender).toEqual({ name, kind: "agent", owner: "leo" });
    ws.close();
  });

  it("backfills owner from stored history on hello", async () => {
    const name = uniq("hist-owned");
    const { body } = await mintWithOwner(name, "agent", "leo");
    const slug = await createChannel(body.token);
    const sender = await WsClient.open(slug, body.token);
    await completeCapabilityHello(sender);
    sender.send({ type: "send", kind: "message", body: "m1", mentions: [], reply_to: null });
    await sender.nextOfType("sent");
    sender.close();

    const reader = await WsClient.open(slug, body.token);
    await completeCapabilityHello(reader);
    const back = await reader.nextOfType("msg");
    expect(back.sender).toEqual({ name, kind: "agent", owner: "leo" });
    reader.close();
  });

  // P1 起 owner 必填，无 owner 只可能是 P1 之前的 legacy 存量 token（直插 D1 模拟）
  it("omits owner for a legacy token stored without one", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    const welcome = await completeCapabilityHello(ws);
    expect(welcome.participants).toContainEqual({ name, kind: "agent" });
    expect(welcome.participants.find((p) => p.name === name)).not.toHaveProperty("owner");
    ws.close();
  });

  it("GET /api/me returns owner for an ap_ token and null when unset", async () => {
    const owned = await mintWithOwner(uniq("me-owned"), "human", "leo@leeguoo.com");
    const meOwned = await SELF.fetch("http://ap.test/api/me", {
      headers: { authorization: `Bearer ${owned.body.token}` },
    });
    expect(meOwned.status).toBe(200);
    expect(await meOwned.json()).toMatchObject({
      kind: "human",
      role: "human",
      email: null,
      owner: "leo@leeguoo.com",
    });

    // legacy 存量 token（无 owner）：/api/me 的 owner 回 null
    const plain = await seedToken("agent");
    const mePlain = await SELF.fetch("http://ap.test/api/me", {
      headers: { authorization: `Bearer ${plain.token}` },
    });
    expect(await mePlain.json()).toMatchObject({ kind: "agent", role: "agent", owner: null });
  });

  it("GET /api/me exposes caps for scoped agent and readonly tokens", async () => {
    const scopedAgent = await seedToken("agent", uniq("scoped-agent"), {
      owner: "leo@leeguoo.com",
      channelScope: "collab",
    });
    const meAgent = await SELF.fetch("http://ap.test/api/me", {
      headers: { authorization: `Bearer ${scopedAgent.token}` },
    });
    expect(await meAgent.json()).toMatchObject({
      kind: "agent",
      role: "agent",
      owner: "leo@leeguoo.com",
      channel_scope: "collab",
      caps: {
        send: true,
        create_channel: false,
        mint_agents: false,
        scoped_to: "collab",
      },
    });

    const scopedReadonly = await seedToken("readonly", uniq("scoped-ro"), {
      owner: "leo@leeguoo.com",
      channelScope: "collab",
    });
    const meReadonly = await SELF.fetch("http://ap.test/api/me", {
      headers: { authorization: `Bearer ${scopedReadonly.token}` },
    });
    expect(await meReadonly.json()).toMatchObject({
      kind: "human",
      role: "readonly",
      owner: "leo@leeguoo.com",
      channel_scope: "collab",
      caps: {
        send: false,
        create_channel: false,
        mint_agents: false,
        scoped_to: "collab",
      },
    });
  });

  it("GET /api/me requires a bearer token", async () => {
    const res = await SELF.fetch("http://ap.test/api/me");
    expect(res.status).toBe(401);
  });
});
