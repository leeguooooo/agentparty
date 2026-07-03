import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { ADMIN_HEADERS, WsClient, createChannel, seedToken } from "./helpers";

describe("websocket", () => {
  it("welcomes with channel, self, participants and last_seq", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    const welcome = await ws.nextOfType("welcome");
    expect(welcome).toMatchObject({
      type: "welcome",
      channel: slug,
      self: name,
      participants: [{ name, kind: "agent" }],
      last_seq: 0,
      presence: [],
    });

    const other = await seedToken("human");
    const second = await WsClient.open(slug, other.token);
    const welcome2 = await second.nextOfType("welcome");
    expect(welcome2.participants).toContainEqual({ name, kind: "agent" });
    expect(welcome2.participants).toContainEqual({ name: other.name, kind: "human" });
    ws.close();
    second.close();
  });

  it("acks sends with strictly monotonic seq", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    for (let i = 1; i <= 3; i++) {
      ws.send({ type: "send", kind: "message", body: `m${i}`, mentions: [], reply_to: null });
      const sent = await ws.nextOfType("sent");
      expect(sent.seq).toBe(i);
      const echo = await ws.nextOfType("msg");
      expect(echo.seq).toBe(i);
      expect(echo.body).toBe(`m${i}`);
    }
    ws.close();
  });

  it("hello since=1 backfills only seq 2 and 3", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const sender = await WsClient.open(slug, token);
    await sender.nextOfType("welcome");
    for (let i = 1; i <= 3; i++) {
      sender.send({ type: "send", kind: "message", body: `m${i}`, mentions: ["bob"], reply_to: null });
      await sender.nextOfType("sent");
    }
    sender.close();

    const reader = await WsClient.open(slug, token);
    const welcome = await reader.nextOfType("welcome");
    expect(welcome.last_seq).toBe(3);
    reader.send({ type: "hello", since: 1 });
    const first = await reader.nextOfType("msg");
    expect(first).toMatchObject({ seq: 2, body: "m2", mentions: ["bob"], reply_to: null });
    const second = await reader.nextOfType("msg");
    expect(second).toMatchObject({ seq: 3, body: "m3" });
    reader.close();
  });

  it("status occupies a seq, updates presence and broadcasts", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    const watcher = await WsClient.open(slug, human.token);
    await watcher.nextOfType("welcome");

    const worker = await WsClient.open(slug, agent.token);
    await worker.nextOfType("welcome");
    worker.send({ type: "send", kind: "status", state: "working", note: "changing api signature" });
    const sent = await worker.nextOfType("sent");
    expect(sent.seq).toBe(1);

    const msg = await watcher.nextOfType("msg");
    expect(msg).toMatchObject({ seq: 1, kind: "status", state: "working", note: "changing api signature" });
    const presence = await watcher.nextOfType("presence");
    expect(presence).toMatchObject({ name: agent.name, state: "working", note: "changing api signature" });

    const rejoin = await WsClient.open(slug, human.token);
    const welcome = await rejoin.nextOfType("welcome");
    expect(welcome.last_seq).toBe(1);
    expect(welcome.presence).toContainEqual(
      expect.objectContaining({ name: agent.name, state: "working" }),
    );
    watcher.close();
    worker.close();
    rejoin.close();
  });

  it("readonly send gets error unauthorized", async () => {
    const agent = await seedToken("agent");
    const ro = await seedToken("readonly");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, ro.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null });
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("unauthorized");
    ws.close();
  });

  it("answers ping with pong", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    ws.raw('{"type":"ping"}');
    const pong = await ws.next();
    expect(pong.type).toBe("pong");
    ws.close();
  });

  it("revoking a token kicks its live ws with error unauthorized", async () => {
    const { token, name } = await seedToken("agent");
    const other = await seedToken("human");
    const slug = await createChannel(token);
    const victim = await WsClient.open(slug, token);
    await victim.nextOfType("welcome");
    const bystander = await WsClient.open(slug, other.token);
    await bystander.nextOfType("welcome");

    const del = await SELF.fetch(`http://ap.test/api/tokens/${name}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(del.status).toBe(200);

    const err = await victim.nextOfType("error");
    expect(err.code).toBe("unauthorized");

    // 旁观者不受影响，还能收广播
    const msg = await (async () => {
      const res = await SELF.fetch(`http://ap.test/api/channels/${slug}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "message", body: "still here", mentions: [], reply_to: null }),
      });
      expect(res.status).toBe(200);
      return bystander.nextOfType("msg");
    })();
    expect(msg.body).toBe("still here");
    bystander.close();
  });

  it("presence scan marks a silent connection offline", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    const silent = await WsClient.open(slug, agent.token);
    await silent.nextOfType("welcome");
    const watcher = await WsClient.open(slug, human.token);
    await watcher.nextOfType("welcome");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      for (const c of instance.getConnections<{ name: string; lastSeen: number }>()) {
        const st = c.state;
        if (st?.name === agent.name) c.setState({ ...st, lastSeen: Date.now() - 120_000 });
      }
      await instance.onAlarm();
    });

    const presence = await watcher.nextOfType("presence");
    expect(presence).toMatchObject({ name: agent.name, state: "offline" });
    watcher.close();
  });

  it("rejects upgrade with a bad token or unknown channel", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const bad = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws`, {
      headers: { upgrade: "websocket", authorization: "Bearer ap_nope" },
    });
    expect(bad.status).toBe(401);
    const missing = await SELF.fetch("http://ap.test/api/channels/no-such-channel/ws", {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
  });
});
