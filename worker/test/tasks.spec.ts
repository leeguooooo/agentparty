import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

describe("channel task ledger", () => {
  it("creates, lists, filters, and updates channel-scoped tasks", async () => {
    const owner = `owner-${uniq("task")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(human.token);

    const fromAgent = await api(`/api/channels/${slug}/tasks`, agent.token, {
      method: "POST",
      body: JSON.stringify({
        title: "Investigate broken login",
        labels: ["bug", "frontend"],
        anchor_seqs: [1, 2],
        priority: 3,
      }),
    });
    expect(fromAgent.status).toBe(201);
    const agentTask = (await fromAgent.json()) as { id: number; state: string; labels: string[]; anchor_seqs: number[]; priority: number };
    expect(agentTask).toMatchObject({
      type: "task",
      channel: slug,
      state: "triage",
      labels: ["bug", "frontend"],
      anchor_seqs: [1, 2],
      priority: 3,
    });

    const fromHuman = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({
        title: "Ship docs",
        assignee: { name: agent.name, kind: "agent" },
      }),
    });
    expect(fromHuman.status).toBe(201);
    const humanTask = (await fromHuman.json()) as { id: number; state: string; assignee: { name: string; kind: string } };
    expect(humanTask).toMatchObject({
      state: "assigned",
      assignee: { name: agent.name, kind: "agent" },
    });

    const listed = await api(`/api/channels/${slug}/tasks`, human.token);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { tasks: { id: number }[] };
    expect(listedBody.tasks.map((task) => task.id).sort((a, b) => a - b)).toEqual([agentTask.id, humanTask.id].sort((a, b) => a - b));

    const triage = await api(`/api/channels/${slug}/tasks?state=triage`, human.token);
    expect(triage.status).toBe(200);
    expect(((await triage.json()) as { tasks: { id: number }[] }).tasks.map((task) => task.id)).toEqual([agentTask.id]);

    const patched = await api(`/api/channels/${slug}/tasks/${agentTask.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({
        state: "in_progress",
        assignee: { name: agent.name, kind: "agent" },
      }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      id: agentTask.id,
      state: "in_progress",
      assignee: { name: agent.name, kind: "agent" },
    });
  });

  it("enforces channel access and readonly write restrictions", async () => {
    const owner = `owner-${uniq("task-acl")}@example.com`;
    const outsider = `outsider-${uniq("task-acl")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const readonly = await seedToken("readonly", uniq("ro"), { owner });
    const otherHuman = await seedToken("human", uniq("other"), { owner: outsider });
    const slug = await createChannel(human.token);

    expect((await api(`/api/channels/${slug}/tasks`, readonly.token, {
      method: "POST",
      body: JSON.stringify({ title: "read only cannot write" }),
    })).status).toBe(403);

    expect((await api(`/api/channels/${slug}/tasks`, otherHuman.token)).status).toBe(403);
  });
});
