// #143 回归：信息类系统事件不得落成 blocked。
// blocked 在 party etiquette 里是「停手等人类」的信号；建 task / 改可见性 / 增删 squad
// 这些是常态推进事件，误报成 blocked 会让守规矩的 agent 集体停摆。
import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

interface StatusMsg {
  kind: string;
  state: string | null;
  body: string;
  status?: { state: string; blocked_reason: string | null } | null;
}

async function statusMessages(slug: string, token: string): Promise<StatusMsg[]> {
  const res = await api(`/api/channels/${slug}/messages?since=0&limit=100`, token);
  const body = (await res.json()) as { messages: StatusMsg[] };
  return body.messages.filter((m) => m.kind === "status");
}

function find(messages: StatusMsg[], bodyPrefix: string): StatusMsg | undefined {
  return messages.find((m) => m.body.startsWith(bodyPrefix));
}

describe("system status state (#143)", () => {
  it("task creation reports waiting, not blocked, and leaves blocked_reason null", async () => {
    const owner = `owner-${uniq("sys")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const slug = await createChannel(human.token);

    const created = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "ship the thing" }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: number };

    const msg = find(await statusMessages(slug, human.token), `task #${task.id} created:`);
    expect(msg).toBeDefined();
    expect(msg?.state).toBe("waiting");
    // blocked_reason 曾被填成 task 标题——那是 blocked 语义泄漏的痕迹
    expect(msg?.status?.blocked_reason ?? null).toBeNull();
  });

  it("task state changes map to waiting / blocked / done rather than always blocked", async () => {
    const owner = `owner-${uniq("sys")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const slug = await createChannel(human.token);

    const created = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "map states" }),
    });
    const task = (await created.json()) as { id: number };

    const move = async (state: string) => {
      const res = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token, {
        method: "PATCH",
        body: JSON.stringify({ state }),
      });
      expect(res.status).toBe(200);
    };

    await move("in_progress");
    await move("blocked");
    await move("done");

    const statuses = await statusMessages(slug, human.token);
    // 推进中 → waiting
    expect(find(statuses, `task #${task.id} in_progress`)?.state).toBe("waiting");
    // task 自己 blocked → 确实报 blocked（这条不该被"修掉"）
    expect(find(statuses, `task #${task.id} blocked`)?.state).toBe("blocked");
    // 完成 → done
    expect(find(statuses, `task #${task.id} done`)?.state).toBe("done");
  });

  it("visibility change and squad lifecycle report waiting", async () => {
    const owner = `owner-${uniq("sys")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const slug = await createChannel(human.token);

    // private→public 需要二段确认（否则 409 needs_confirm），这里直接带上 confirm
    const vis = await api(`/api/channels/${slug}/visibility`, human.token, {
      method: "PUT",
      body: JSON.stringify({ visibility: "public", confirm: true }),
    });
    expect(vis.status).toBe(200);

    const member = await seedToken("agent", uniq("agent"), { owner });
    const squadName = uniq("sq").toLowerCase();
    const squad = await api(`/api/channels/${slug}/squads`, human.token, {
      method: "POST",
      body: JSON.stringify({ name: squadName, members: [member.name], leader: member.name }),
    });
    expect(squad.status).toBe(201);

    const statuses = await statusMessages(slug, human.token);
    expect(find(statuses, "visibility changed to public")?.state).toBe("waiting");
    expect(find(statuses, `squad @${squadName} created`)?.state).toBe("waiting");
    // 整个频道生命周期里不该出现任何 blocked——没有 webhook 死信、没有 guard 熔断
    expect(statuses.filter((m) => m.state === "blocked")).toEqual([]);
  });

  // 反向兜底：真 blocked 的路径不能被"默认值翻转"顺手打反。
  // 修复 #143 时 workflow guard tripped 原本依赖默认 blocked，翻转默认值会让它静默降级成
  // waiting——当时靠人工审计才发现，没有任何测试会失败。这两条就是补上那道网。
  it("loop guard tripped still reports blocked with a blocked_reason", async () => {
    const agentA = await seedToken("agent", uniq("ga"));
    const agentB = await seedToken("agent", uniq("gb"));
    const slug = await createChannel(agentA.token);

    const enable = await api(`/api/channels/${slug}/loop-guard`, agentA.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 2 }),
    });
    expect(enable.status).toBe(200);

    expect((await postMessage(slug, agentA.token, "one")).status).toBe(200);
    expect((await postMessage(slug, agentB.token, "two")).status).toBe(200);
    expect((await postMessage(slug, agentA.token, "tripped")).status).toBe(409);

    const guard = find(await statusMessages(slug, agentA.token), "loop guard tripped:");
    expect(guard).toBeDefined();
    expect(guard?.state).toBe("blocked");
    expect(guard?.status?.blocked_reason).toContain("loop guard tripped:");
  });
});
