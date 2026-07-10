// #119：削弱 guard 的权限必须不弱于重置 guard。
// reset-guard 严格要求 kind==="human"（loop guard 防的就是 agent 失控刷屏，不能让它
// 重置自己的熔断）；但 PUT loop-guard / workflow-guard 只查 canConfigureChannel。
// 于是被熔断的 agent 可以直接 {enabled:false} 关掉熔断——比 reset 更强的动作，门禁更松。
//
// 边界取「削弱 vs 加强」，不是一刀切 human-only：
//   削弱（关闭、放宽阈值）→ human-only；加强（开启、调低阈值）→ 任何 configurer 都行。
// 一刀切会打断 agent 合法地给频道加刹车的流程。
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

describe("guard config ACL (#119)", () => {
  it("an agent cannot disable the loop guard, mirroring reset-guard's human-only rule", async () => {
    const ownerAccount = `${uniq("acct")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerAccount });
    const agent = await seedToken("agent", uniq("agent"), { owner: ownerAccount });
    const slug = await createChannel(human.token);

    // agent 与房主同账号 → canConfigureChannel 放行，但 kind 是 agent
    const off = await api(`/api/channels/${slug}/loop-guard`, agent.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(403);

    // 同一个 agent 去 reset 也是 403 —— 两条门禁现在一致
    const reset = await api(`/api/channels/${slug}/reset-guard`, agent.token, { method: "POST" });
    expect(reset.status).toBe(403);
  });

  it("an agent cannot disable the workflow guard either", async () => {
    const ownerAccount = `${uniq("acct")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerAccount });
    const agent = await seedToken("agent", uniq("agent"), { owner: ownerAccount });
    const slug = await createChannel(human.token);

    const off = await api(`/api/channels/${slug}/workflow-guard`, agent.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(403);
  });

  it("a human moderator can still configure both guards", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);

    const loopOn = await api(`/api/channels/${slug}/loop-guard`, human.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 5 }),
    });
    expect(loopOn.status).toBe(200);
    expect(await loopOn.json()).toEqual({ enabled: true, limit: 5 });

    const wfOn = await api(`/api/channels/${slug}/workflow-guard`, human.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 4 }),
    });
    expect(wfOn.status).toBe(200);

    const loopOff = await api(`/api/channels/${slug}/loop-guard`, human.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(loopOff.status).toBe(200);
  });

  it("an agent CAN strengthen the guard (enable it, or lower the limit)", async () => {
    const ownerAccount = `${uniq("acct")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerAccount });
    const agent = await seedToken("agent", uniq("agent"), { owner: ownerAccount });
    const slug = await createChannel(human.token);

    // 新频道默认 enabled=1、limit 空（回退 mode 默认 30）。调低到 5 = 加强 → 放行
    const tighten = await api(`/api/channels/${slug}/loop-guard`, agent.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 5 }),
    });
    expect(tighten.status).toBe(200);

    // 但放宽到 9000 = 削弱 → 403
    const loosen = await api(`/api/channels/${slug}/loop-guard`, agent.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 9000 }),
    });
    expect(loosen.status).toBe(403);
  });

  it("an agent can enable a guard that was off (off → on is strengthening)", async () => {
    const ownerAccount = `${uniq("acct")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerAccount });
    const agent = await seedToken("agent", uniq("agent"), { owner: ownerAccount });
    const slug = await createChannel(human.token);

    // 人类先关掉
    expect((await api(`/api/channels/${slug}/loop-guard`, human.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);

    // agent 再打开 → 放行
    const on = await api(`/api/channels/${slug}/loop-guard`, agent.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 10 }),
    });
    expect(on.status).toBe(200);
  });
});
