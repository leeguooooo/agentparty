import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
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

  it("fails the final spawn CAS when the parent is revoked immediately before child persistence", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: "leo" });
    const slug = await createChannel(owner.token);
    const parent = await seedToken("agent", uniq("parent"), { owner: "leo", channelScope: slug });
    const childName = uniq("child-cas");
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let intercepted = false;
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      const statement = originalPrepare(query);
      if (
        !query.includes("INSERT INTO tokens (") ||
        !query.includes("SELECT ?, ?, 'agent'") ||
        !query.includes("parent.parent_agent IS NULL")
      ) {
        return statement;
      }
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            run: async () => {
              intercepted = true;
              await originalPrepare(
                "UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL",
              ).bind(Date.now(), parent.name).run();
              return bound.run();
            },
          } as D1PreparedStatement;
        },
      } as D1PreparedStatement;
    });

    let response: Response;
    try {
      response = await api("/api/spawn", parent.token, {
        method: "POST",
        body: JSON.stringify({ name: childName, channel_scope: slug, ttl_sec: 3600 }),
      });
    } finally {
      prepare.mockRestore();
    }

    expect(intercepted).toBe(true);
    expect(response!.status).toBe(409);
    expect(await response!.json()).toMatchObject({ error: { code: "participant_removed" } });
    expect(await env.DB.prepare("SELECT name FROM tokens WHERE name = ?").bind(childName).first()).toBeNull();
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
