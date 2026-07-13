// #96：新建频道默认开启 loop guard。
// c3c4cdb 把 guard 改成 opt-in 后，新频道一律无熔断——两个 agent 在无人值守下可以
// 互相唤醒到天亮，唯一约束是 30 msg/min。产品的核心承诺（agents talk, humans watch）
// 要求新频道开箱就有这道刹车；存量频道不动（强开会立刻熔断正在工作的频道）。
import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

describe("new channels enable the loop guard by default (#96)", () => {
  it("a freshly created channel reports loop_guard_enabled = 1", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);

    const list = (await (await api("/api/channels", human.token)).json()) as {
      channels: { slug: string; loop_guard_enabled?: number; loop_guard_limit?: number | null }[];
    };
    const ch = list.channels.find((c) => c.slug === slug);
    expect(ch).toBeDefined();
    expect(ch?.loop_guard_enabled).toBe(1);
    // 不写死 limit：留空表示回退 mode 默认（normal 30 / party 200）
    expect(ch?.loop_guard_limit ?? null).toBeNull();
  });

  it("the default guard actually trips at the normal-channel threshold", async () => {
    const agentA = await seedToken("agent", uniq("ga"));
    const agentB = await seedToken("agent", uniq("gb"));
    const slug = await createChannel(agentA.token);

    // LOOP_GUARD_N = 30：前 30 条连续 agent 消息放行，第 31 条熔断
    for (let i = 0; i < 30; i++) {
      const token = i % 2 === 0 ? agentA.token : agentB.token;
      expect((await postMessage(slug, token, `msg-${i}`)).status).toBe(200);
    }
    const tripped = await postMessage(slug, agentA.token, "one too many");
    expect(tripped.status).toBe(409);
    const body = (await tripped.json()) as { error: { code: string } };
    expect(body.error.code).toBe("loop_guard");
  });

  it("status frames do not consume the message loop-guard quota (#466)", async () => {
    const agentA = await seedToken("agent", uniq("sa"));
    const agentB = await seedToken("agent", uniq("sb"));
    const slug = await createChannel(agentA.token);

    // status 是 presence 协调信息：即使达到消息阈值数量，也不应消耗熔断额度。
    for (let i = 0; i < 30; i++) {
      const token = i % 2 === 0 ? agentA.token : agentB.token;
      const res = await api(`/api/channels/${slug}/messages`, token, {
        method: "POST",
        body: JSON.stringify({ kind: "status", state: "blocked", note: `streak ${i}`, mentions: [] }),
      });
      expect(res.status).toBe(200);
    }
    expect((await postMessage(slug, agentA.token, "first real message")).status).toBe(200);

    // 只有真实 agent message 会累计：再发送 29 条后，第 31 条 message 才熔断。
    for (let i = 1; i < 30; i++) {
      const token = i % 2 === 0 ? agentA.token : agentB.token;
      expect((await postMessage(slug, token, `msg-${i}`)).status).toBe(200);
    }
    const tripped = await postMessage(slug, agentA.token, "one message too many");
    expect(tripped.status).toBe(409);
    expect(((await tripped.json()) as { error: { code: string } }).error.code).toBe("loop_guard");
  });

  it("owners can still turn the default guard off per channel", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);

    const off = await api(`/api/channels/${slug}/loop-guard`, human.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enabled: false, limit: null });
  });
});
