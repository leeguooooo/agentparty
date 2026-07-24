import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

describe("channel squads", () => {
  it("creates, lists, updates, deletes, and validates task squad assignees", async () => {
    const owner = `owner-${uniq("squad")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const agentA = await seedToken("agent", uniq("agent-a"), { owner });
    const agentB = await seedToken("agent", uniq("agent-b"), { owner });
    const slug = await createChannel(human.token);

    const created = await api(`/api/channels/${slug}/squads`, human.token, {
      method: "POST",
      body: JSON.stringify({
        name: "frontend",
        title: "Frontend",
        leader: agentA.name,
        members: [agentA.name, agentB.name],
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      type: "squad",
      channel: slug,
      name: "frontend",
      title: "Frontend",
      leader: agentA.name,
      members: [agentA.name, agentB.name],
    });

    const listed = await api(`/api/channels/${slug}/squads`, human.token);
    expect(listed.status).toBe(200);
    expect((await listed.json()) as { squads: unknown[] }).toMatchObject({
      squads: [{ name: "frontend", members: [agentA.name, agentB.name] }],
    });

    const assigned = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({
        title: "Fix mobile layout",
        assignee: { name: "frontend", kind: "squad" },
      }),
    });
    expect(assigned.status).toBe(201);
    expect(await assigned.json()).toMatchObject({
      state: "assigned",
      assignee: { name: "frontend", kind: "squad" },
    });

    const missingSquad = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({
        title: "Fix backend",
        assignee: { name: "backend", kind: "squad" },
      }),
    });
    expect(missingSquad.status).toBe(404);

    const mention = await postMessage(slug, human.token, "@frontend please take this");
    expect(mention.status).toBe(200);
    const history = await api(`/api/channels/${slug}/messages?since=0&limit=20`, human.token);
    expect(history.status).toBe(200);
    const messages = ((await history.json()) as { messages: { body: string; mentions: string[] }[] }).messages;
    const routed = messages.find((message) => message.body === "@frontend please take this");
    expect(routed?.mentions).toEqual(expect.arrayContaining(["frontend", agentA.name]));

    const updated = await api(`/api/channels/${slug}/squads/frontend`, human.token, {
      method: "PATCH",
      body: JSON.stringify({
        leader: agentB.name,
        members: [agentB.name],
        description: "Owns web UI polish",
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      leader: agentB.name,
      members: [agentB.name],
      description: "Owns web UI polish",
    });

    const deleted = await api(`/api/channels/${slug}/squads/frontend`, human.token, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ ok: true, squad: { name: "frontend" } });
    expect((await api(`/api/channels/${slug}/squads/frontend`, human.token)).status).toBe(404);
  });

  it("enforces channel access and readonly write restrictions", async () => {
    const owner = `owner-${uniq("squad-acl")}@example.com`;
    const outsider = `outsider-${uniq("squad-acl")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const readonly = await seedToken("readonly", uniq("ro"), { owner });
    const otherHuman = await seedToken("human", uniq("other"), { owner: outsider });
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(human.token);

    expect((await api(`/api/channels/${slug}/squads`, readonly.token, {
      method: "POST",
      body: JSON.stringify({ name: "qa", members: [agent.name] }),
    })).status).toBe(403);

    expect((await api(`/api/channels/${slug}/squads`, otherHuman.token)).status).toBe(403);
  });

  it("canonicalizes squad members through D1 token names", async () => {
    const owner = `owner-${uniq("squad-canonical")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const agent = await seedToken("agent", uniq("CaseAgent"), { owner });
    const slug = await createChannel(human.token);
    const name = uniq("canonical-squad").toLowerCase();
    expect((await api(`/api/channels/${slug}/squads`, human.token, {
      method: "POST",
      body: JSON.stringify({ name, leader: null, members: [agent.name] }),
    })).status).toBe(201);
    await env.DB.prepare(
      "UPDATE channel_squads SET leader_name = NULL, members_json = ? WHERE channel_slug = ? AND name = ?",
    ).bind(JSON.stringify([agent.name.toUpperCase()]), slug, name).run();

    const sent = await postMessage(slug, human.token, `@${name} canonical route`);
    expect(sent.status).toBe(200);
    const history = await api(`/api/channels/${slug}/messages?since=0`, human.token);
    const messages = (await history.json()) as { messages: { body: string; mentions: string[] }[] };
    expect(messages.messages.find((message) => message.body.includes("canonical route"))?.mentions).toEqual(
      expect.arrayContaining([name, agent.name]),
    );
  });

  it("fails closed when squad member authority lookup is unavailable", async () => {
    const owner = `owner-${uniq("squad-unavailable")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(human.token);
    const name = uniq("unavailable-squad").toLowerCase();
    expect((await api(`/api/channels/${slug}/squads`, human.token, {
      method: "POST",
      body: JSON.stringify({ name, leader: null, members: [agent.name] }),
    })).status).toBe(201);

    const originalPrepare = env.DB.prepare.bind(env.DB);
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.includes("FROM tokens t") && query.includes("role = 'agent'")) {
        throw new Error("agent directory unavailable");
      }
      return originalPrepare(query);
    });
    let response: Response;
    try {
      response = await postMessage(slug, human.token, `@${name} must not persist`);
    } finally {
      prepare.mockRestore();
    }
    expect(response!.status).toBe(503);
    expect(await response!.json()).toMatchObject({ error: { code: "unavailable" } });
    const history = await api(`/api/channels/${slug}/messages?since=0`, human.token);
    expect(
      ((await history.json()) as { messages: { body: string }[] }).messages.some((message) =>
        message.body.includes("must not persist")
      ),
    ).toBe(false);
  });

  it("rejects a 50-member squad expansion because the squad alias would be target 51", async () => {
    const owner = `owner-${uniq("squad-limit")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const slug = await createChannel(human.token);
    const members: string[] = [];
    for (let index = 0; index < 50; index++) {
      members.push((await seedToken("agent", uniq(`limit-${index}`), { owner })).name);
    }
    const name = uniq("limit-squad").toLowerCase();
    expect((await api(`/api/channels/${slug}/squads`, human.token, {
      method: "POST",
      body: JSON.stringify({ name, leader: null, members }),
    })).status).toBe(201);
    const response = await postMessage(slug, human.token, `@${name} overflow`);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "too_large" } });
    const history = await api(`/api/channels/${slug}/messages?since=0`, human.token);
    expect(
      ((await history.json()) as { messages: { body: string }[] }).messages.some((message) =>
        message.body.includes("overflow")
      ),
    ).toBe(false);
  });
});
