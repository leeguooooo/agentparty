// #191：presence 的 wake.verified_at 必须由**服务端**在亲眼看到「被 @ 后 resume」时盖，绝不信客户端自报
// （否则回到 issue #55/#60 的「自称可唤醒实则叫不醒」）。这里端到端验证那道服务端校验：
//   • agent 声明 wake=watch 但从没回过 @ → verified_at 缺失（wakeableState 会判 unverified）。
//   • 另一身份 @ 它、它回复（reply_to 指向那条 @）→ 服务端观测到 resume，盖 verified_at（判 verified）。
//   • status 帧里客户端塞进来的 verified_at 一律不采信。
import { wakeableState, type PresenceEntry } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { WsClient, api, completeCapabilityHello, createChannel, seedToken } from "./helpers";

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence;
}

async function declareWatch(ws: WsClient, extra: Record<string, unknown> = {}): Promise<void> {
  ws.send({
    type: "send",
    kind: "status",
    state: "waiting",
    note: "standby",
    mentions: [],
    residency: "supervised",
    wake: { kind: "watch", ...extra },
  });
  await ws.nextOfType("sent");
}

describe("server-side wake verification (issue #191)", () => {
  it("声明 watch 但从未回过 @ → 服务端不盖 verified_at（wakeableState=unverified）", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    await declareWatch(ws);

    const me = (await fetchPresence(slug, agent.token)).find((p) => p.name === agent.name)!;
    expect(me.wake?.kind).toBe("watch");
    expect(me.wake?.verified_at).toBeUndefined();
    expect(wakeableState(me, Date.now())).toBe("wakeable_unverified");
    ws.close();
  });

  it("客户端在 status 里自报的 verified_at 不被采信（服务端只信自己观测的事实）", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    // 客户端谎称早已验证
    await declareWatch(ws, { verified_at: 5 });

    const me = (await fetchPresence(slug, agent.token)).find((p) => p.name === agent.name)!;
    expect(me.wake?.kind).toBe("watch");
    expect(me.wake?.verified_at).toBeUndefined(); // 自报被丢弃
    ws.close();
  });

  it("被 @ 后回复（reply_to 指向那条 @）→ 服务端盖 verified_at（wakeableState=verified）", async () => {
    const target = await seedToken("agent");
    const prober = await seedToken("agent");
    const slug = await createChannel(target.token);

    const targetWs = await WsClient.open(slug, target.token);
    await completeCapabilityHello(targetWs);
    await declareWatch(targetWs);

    // 另一身份 @ target
    const proberWs = await WsClient.open(slug, prober.token);
    await completeCapabilityHello(proberWs);
    proberWs.send({ type: "send", kind: "message", body: `@${target.name} wake test`, mentions: [target.name], reply_to: null });
    const probeSent = await proberWs.nextOfType("sent");
    const probeSeq = probeSent.seq as number;

    // target 回复那条 @（模拟被唤醒后 resume）
    targetWs.send({ type: "send", kind: "message", body: "on it", mentions: [], reply_to: probeSeq });
    await targetWs.nextOfType("sent");

    const me = (await fetchPresence(slug, target.token)).find((p) => p.name === target.name)!;
    expect(me.wake?.kind).toBe("watch");
    expect(typeof me.wake?.verified_at).toBe("number");
    expect(wakeableState(me, Date.now())).toBe("wakeable_verified");
    targetWs.close();
    proberWs.close();
  });

  it("回复一条**没 @ 自己**的消息不算验证（不能靠随便回帖伪造 verified）", async () => {
    const target = await seedToken("agent");
    const other = await seedToken("agent");
    const slug = await createChannel(target.token);

    const targetWs = await WsClient.open(slug, target.token);
    await completeCapabilityHello(targetWs);
    await declareWatch(targetWs);

    const otherWs = await WsClient.open(slug, other.token);
    await completeCapabilityHello(otherWs);
    // 一条不 @ target 的消息
    otherWs.send({ type: "send", kind: "message", body: "hello all", mentions: [], reply_to: null });
    const sent = await otherWs.nextOfType("sent");
    const seq = sent.seq as number;

    targetWs.send({ type: "send", kind: "message", body: "reply", mentions: [], reply_to: seq });
    await targetWs.nextOfType("sent");

    const me = (await fetchPresence(slug, target.token)).find((p) => p.name === target.name)!;
    expect(me.wake?.verified_at).toBeUndefined();
    targetWs.close();
    otherWs.close();
  });
});
