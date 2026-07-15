import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WsClient, api, completeCapabilityHello, createChannel, seedToken, uniq } from "./helpers";

describe("agent spawn lineage", () => {
  it("lets a channel-scoped parent agent spawn a short-lived child token", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: "leo" });
    const slug = await createChannel(owner.token);
    const parent = await seedToken("agent", uniq("parent"), { owner: "leo", channelScope: slug });

    const res = await api("/api/spawn", parent.token, {
      method: "POST",
      body: JSON.stringify({ name: uniq("child"), channel_scope: slug, ttl_sec: 3600, team_id: "team.alpha" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      name: string;
      channel_scope: string;
      lineage: { parent_agent: string; root_agent: string; team_id: string; depth: number; expires_at: number };
    };
    expect(body.channel_scope).toBe(slug);
    expect(body.lineage).toMatchObject({
      parent_agent: parent.name,
      root_agent: parent.name,
      team_id: "team.alpha",
      depth: 1,
    });

    const me = await api("/api/me", body.token);
    expect(await me.json()).toMatchObject({
      name: body.name,
      role: "agent",
      owner: "leo",
      channel_scope: slug,
      lineage: body.lineage,
      caps: {
        send: true,
        create_channel: false,
        mint_agents: false,
        spawn_children: false,
        scoped_to: slug,
      },
    });
  });

  it("rejects unscoped parents, cross-scope spawn, child recursion, and expired child tokens", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: "leo" });
    const slug = await createChannel(owner.token);
    const unscopedParent = await seedToken("agent", uniq("unscoped"), { owner: "leo" });
    const unscoped = await api("/api/spawn", unscopedParent.token, {
      method: "POST",
      body: JSON.stringify({ name: uniq("child"), channel_scope: slug }),
    });
    expect(unscoped.status).toBe(403);

    const parent = await seedToken("agent", uniq("parent"), { owner: "leo", channelScope: slug });
    const cross = await api("/api/spawn", parent.token, {
      method: "POST",
      body: JSON.stringify({ name: uniq("child"), channel_scope: "other-channel" }),
    });
    expect(cross.status).toBe(403);

    const childParent = await seedToken("agent", uniq("child-parent"), {
      owner: "leo",
      channelScope: slug,
      parentAgent: parent.name,
      rootAgent: parent.name,
      teamId: "team",
      spawnDepth: 1,
      childExpiresAt: Date.now() + 60_000,
    });
    const recursive = await api("/api/spawn", childParent.token, {
      method: "POST",
      body: JSON.stringify({ name: uniq("grandchild"), channel_scope: slug }),
    });
    expect(recursive.status).toBe(403);

    const expired = await seedToken("agent", uniq("expired-child"), {
      owner: "leo",
      channelScope: slug,
      parentAgent: parent.name,
      rootAgent: parent.name,
      teamId: "team",
      spawnDepth: 1,
      childExpiresAt: Date.now() - 1000,
    });
    const expiredMe = await SELF.fetch("http://ap.test/api/me", {
      headers: { authorization: `Bearer ${expired.token}` },
    });
    expect(expiredMe.status).toBe(401);
  });

  it("carries child lineage through participants, live messages, and history", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: "leo" });
    const slug = await createChannel(owner.token);
    const parent = await seedToken("agent", uniq("parent"), { owner: "leo", channelScope: slug });
    const childName = uniq("child");
    const spawn = await api("/api/spawn", parent.token, {
      method: "POST",
      body: JSON.stringify({ name: childName, channel_scope: slug, ttl_sec: 3600 }),
    });
    const child = (await spawn.json()) as {
      token: string;
      name: string;
      lineage: { parent_agent: string; root_agent: string; team_id: string; depth: number; expires_at: number };
    };

    const ws = await WsClient.open(slug, child.token);
    const welcome = await completeCapabilityHello(ws);
    expect(welcome.participants).toContainEqual({
      name: child.name,
      kind: "agent",
      owner: "leo",
      lineage: child.lineage,
    });

    ws.send({ type: "send", kind: "message", body: "child reporting", mentions: [], reply_to: null });
    await ws.nextOfType("sent");
    const msg = await ws.nextOfType("msg");
    expect(msg.sender).toEqual({ name: child.name, kind: "agent", owner: "leo", lineage: child.lineage });
    ws.close();

    const hist = await api(`/api/channels/${slug}/messages?since=0&limit=10`, owner.token);
    const messages = ((await hist.json()) as { messages: Array<{ sender: unknown }> }).messages;
    expect(messages.at(-1)?.sender).toEqual({ name: child.name, kind: "agent", owner: "leo", lineage: child.lineage });
  });
});
