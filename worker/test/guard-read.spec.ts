import { LOOP_GUARD_N } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { api, createChannel, disableLoopGuard, postMessage, seedToken } from "./helpers";

interface GuardState {
  enabled: boolean;
  limit: number;
  streak: number;
  remaining: number;
  resets_on: string;
}

async function guardState(slug: string, token: string): Promise<GuardState> {
  const res = await api(`/api/channels/${slug}/loop-guard`, token);
  expect(res.status).toBe(200);
  return (await res.json()) as GuardState;
}

describe("loop guard read path", () => {
  it("exposes enabled/limit/streak/remaining/resets_on for a fresh channel", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    // #96 起新频道默认开 guard，limit 落到 normal 默认
    expect(await guardState(slug, agent.token)).toEqual({
      enabled: true,
      limit: LOOP_GUARD_N,
      streak: 0,
      remaining: LOOP_GUARD_N,
      resets_on: "human",
    });
  });

  it("increments streak by exactly one per agent message and decrements remaining", async () => {
    const agentA = await seedToken("agent");
    const agentB = await seedToken("agent");
    const slug = await createChannel(agentA.token);

    expect((await guardState(slug, agentA.token)).streak).toBe(0);

    await postMessage(slug, agentA.token, "m0");
    let g = await guardState(slug, agentA.token);
    expect(g.streak).toBe(1);
    expect(g.remaining).toBe(LOOP_GUARD_N - 1);

    await postMessage(slug, agentB.token, "m1");
    g = await guardState(slug, agentA.token);
    expect(g.streak).toBe(2);
    expect(g.remaining).toBe(LOOP_GUARD_N - 2);

    await postMessage(slug, agentA.token, "m2");
    g = await guardState(slug, agentA.token);
    expect(g.streak).toBe(3);
    expect(g.remaining).toBe(LOOP_GUARD_N - 3);
  });

  it("resets streak to zero after a human speaks", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);

    await postMessage(slug, agent.token, "a0");
    await postMessage(slug, agent.token, "a1");
    expect((await guardState(slug, agent.token)).streak).toBe(2);

    await postMessage(slug, human.token, "human here");
    const g = await guardState(slug, agent.token);
    expect(g.streak).toBe(0);
    expect(g.remaining).toBe(LOOP_GUARD_N);
  });

  it("reflects a per-channel configured limit", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const enable = await api(`/api/channels/${slug}/loop-guard`, agent.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 3 }),
    });
    expect(enable.status).toBe(200);

    const g = await guardState(slug, agent.token);
    expect(g.enabled).toBe(true);
    expect(g.limit).toBe(3);
    expect(g.remaining).toBe(3);

    await postMessage(slug, agent.token, "one");
    const g2 = await guardState(slug, agent.token);
    expect(g2.streak).toBe(1);
    expect(g2.remaining).toBe(2);
  });

  it("reports enabled=false once a human disables the guard", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    await disableLoopGuard(slug, human.token);
    const g = await guardState(slug, agent.token);
    expect(g.enabled).toBe(false);
  });

  it("denies reading guard state to a token scoped to another private channel", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    // channel-scoped token 硬上限单频道：scope 不匹配则 ACL 拒（acl.ts canAccessChannel）
    const stranger = await seedToken("agent", undefined, { channelScope: "some-other-channel" });
    const res = await api(`/api/channels/${slug}/loop-guard`, stranger.token);
    expect(res.status).toBe(403);
  });
});
