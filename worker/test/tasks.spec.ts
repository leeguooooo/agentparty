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

    const summary = await api(`/api/channels/${slug}/tasks/summary`, agent.token);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      type: "task_summary",
      channel: slug,
      total: 2,
      open: 2,
      assigned: 1,
      in_progress: 1,
      done: 0,
      mine: 2,
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

  it("round-trips scope and blocked_reason; enforces scope/blocked_reason validation (#204)", async () => {
    const owner = `owner-${uniq("scope")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(human.token);

    // create 带 scope（含重复项，服务端去重）+ blocked_reason
    const created = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({
        title: "scoped task",
        assignee: { name: agent.name, kind: "agent" },
        // state=blocked：blocked_reason 只在 blocked 状态保留（#204 不变量），故 round-trip 用例落 blocked
        state: "blocked",
        scope: ["web/src", "cli/src", "web/src"],
        blocked_reason: "waiting on token",
      }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: number; scope: string[]; blocked_reason: string | null };
    expect(task.scope).toEqual(["web/src", "cli/src"]);
    expect(task.blocked_reason).toBe("waiting on token");

    // GET 单条往返一致
    const got = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ scope: ["web/src", "cli/src"], blocked_reason: "waiting on token" });

    // 列表也带出 scope/blocked_reason
    const listed = await api(`/api/channels/${slug}/tasks`, human.token);
    const listedTask = ((await listed.json()) as { tasks: Array<{ id: number; scope: string[]; blocked_reason: string | null }> }).tasks.find((t) => t.id === task.id)!;
    expect(listedTask.scope).toEqual(["web/src", "cli/src"]);
    expect(listedTask.blocked_reason).toBe("waiting on token");

    // PATCH 改 scope、清空 blocked_reason（null）
    const patched = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({ scope: ["worker/src"], blocked_reason: null }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ scope: ["worker/src"], blocked_reason: null });

    // PATCH 不带 scope → 保留原 scope（不被清空）
    const patched2 = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({ state: "in_progress" }),
    });
    expect(await patched2.json()).toMatchObject({ scope: ["worker/src"] });

    // 非法 scope：含非字符串项 → 400
    expect((await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", scope: [123] }),
    })).status).toBe(400);

    // 非法 scope：空字符串项 → 400
    expect((await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", scope: [""] }),
    })).status).toBe(400);

    // 非法 blocked_reason：类型错误 → 400
    expect((await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", blocked_reason: 5 }),
    })).status).toBe(400);

    // 省略时默认 scope=[]、blocked_reason=null
    const plain = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "plain" }),
    });
    expect(plain.status).toBe(201);
    expect(await plain.json()).toMatchObject({ scope: [], blocked_reason: null });
  });

  it("clears blocked_reason on any non-blocked state (invariant #204)", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);

    // create 非 blocked 状态却带 blocked_reason → 服务端落 null（不信任客户端一致性）
    const created = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "not blocked", state: "in_progress", blocked_reason: "should be dropped" }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { blocked_reason: string | null }).blocked_reason).toBe(null);

    // create blocked + reason → 保留
    const blocked = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "blocked", state: "blocked", blocked_reason: "waiting on secret" }),
    });
    const blockedTask = (await blocked.json()) as { id: number; blocked_reason: string | null };
    expect(blockedTask.blocked_reason).toBe("waiting on secret");

    // 转出 blocked（→done，且 PATCH 不带 blocked_reason 字段）→ 旧 reason 也被清
    const done = await api(`/api/channels/${slug}/tasks/${blockedTask.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({ state: "done" }),
    });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { blocked_reason: string | null }).blocked_reason).toBe(null);
  });

  it("round-trips task attachments and rejects invalid ones (#369)", async () => {
    const owner = `owner-${uniq("task")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const slug = await createChannel(human.token);
    const att = {
      key: `${slug}/11111111-1111-1111-1111-111111111111/spec.png`,
      filename: "spec.png",
      content_type: "image/png",
      size: 2048,
      url: `/api/channels/${slug}/attachments/11111111-1111-1111-1111-111111111111/spec.png`,
    };

    // create 带一个附件引用 → 201，返回体带 attachments
    const created = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "task with attachment", attachments: [att] }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: number; attachments?: typeof att[] };
    expect(task.attachments).toEqual([att]);

    // GET 单条 + 列表都往返一致
    const got = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token);
    expect(((await got.json()) as { attachments?: typeof att[] }).attachments).toEqual([att]);
    const listed = await api(`/api/channels/${slug}/tasks`, human.token);
    const listedTask = ((await listed.json()) as { tasks: Array<{ id: number; attachments?: typeof att[] }> }).tasks.find((t) => t.id === task.id)!;
    expect(listedTask.attachments).toEqual([att]);

    // 无附件的任务：字段省略（不落 attachments 键）
    const plain = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "no attachment" }),
    });
    expect((await plain.json() as Record<string, unknown>).attachments).toBeUndefined();

    // 非法附件（缺 key）→ 400
    const bad = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", attachments: [{ filename: "x", content_type: "image/png", size: 1, url: "/x" }] }),
    });
    expect(bad.status).toBe(400);

    // 超过 MAX_ATTACHMENTS(20) → 400
    const tooMany = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "too many", attachments: Array.from({ length: 21 }, (_, i) => ({ ...att, filename: `f${i}.png` })) }),
    });
    expect(tooMany.status).toBe(400);
  });

  it("stores exactly one channel-visible solution attachment and supports replace/clear (#464)", async () => {
    const owner = `owner-${uniq("solution")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const channelAgent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(human.token);
    const solution = {
      key: `${slug}/11111111-1111-1111-1111-111111111111/solution.html`,
      filename: "solution.html",
      content_type: "text/html",
      size: 4096,
      url: `/api/channels/${slug}/attachments/11111111-1111-1111-1111-111111111111/solution.html`,
    };

    const created = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "task with solution", solution }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: number; solution?: typeof solution };
    expect(task.solution).toEqual(solution);

    const replacement = { ...solution, key: solution.key.replace("solution.html", "solution-v2.html"), filename: "solution-v2.html", url: solution.url.replace("solution.html", "solution-v2.html") };
    const replaced = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({ solution: replacement }),
    });
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as { solution?: typeof solution }).solution).toEqual(replacement);

    // 同频道另一身份无需原创建者的私有 artifact 会话，也能从任务记录看到鉴权下载引用。
    const listed = await api(`/api/channels/${slug}/tasks`, channelAgent.token);
    expect(((await listed.json()) as { tasks: Array<{ id: number; solution?: typeof solution }> }).tasks.find((entry) => entry.id === task.id)?.solution).toEqual(replacement);

    const invalid = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({ solution: [solution, replacement] }),
    });
    expect(invalid.status).toBe(400);

    const crossChannel = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({ solution: { ...solution, key: `other/${solution.filename}`, url: `/api/channels/other/attachments/${solution.filename}` } }),
    });
    expect(crossChannel.status).toBe(400);
    expect(await crossChannel.json()).toMatchObject({ error: { message: "solution must belong to the current channel" } });

    const cleared = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({ solution: null }),
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as Record<string, unknown>).solution).toBeUndefined();
  });

});
