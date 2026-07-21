// #675：watch 挂载默认静默——不再往时间线发一条 waiting 状态消息（per-turn 重挂刷屏、推高 seq）。
// 「可被唤醒」改由带内 presence 声明：hello 带 wake_kind=watch，服务端在这条连接的 presence 行上
// 落 wake_kind=watch + residency=supervised，不产生任何时间线消息/seq。断开由 markOffline 撤销。
import { wakeableState, type PresenceEntry } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, seedToken } from "./helpers";

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence;
}

async function messageCount(slug: string, token: string): Promise<number> {
  const res = await api(`/api/channels/${slug}/messages`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: unknown[] }).messages.length;
}

describe("hello.wake_kind 带内 watch presence 声明 (#675)", () => {
  it("hello 带 wake_kind=watch → presence 落 wake_kind=watch，零时间线消息", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const before = await messageCount(slug, agent.token);

    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0, directed_delivery: "v1", wake_kind: "watch" });
    // 等一个 presence 广播以确保服务端已处理 hello
    await ws.nextOfType("presence");

    const me = (await fetchPresence(slug, agent.token)).find((p) => p.name === agent.name)!;
    expect(me.wake?.kind).toBe("watch");
    expect(me.residency).toBe("supervised");
    // #191：自报绝不算已验证。
    expect(me.wake?.verified_at).toBeUndefined();
    expect(wakeableState(me, Date.now())).toBe("wakeable_unverified");

    // 关键：没有往时间线塞任何消息（默认静默）。
    expect(await messageCount(slug, agent.token)).toBe(before);
    ws.close();
  });

  it("不带 wake_kind 的 hello 不改 wake_kind（旧客户端保持旧行为）", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
    // 发一帧 ping 让服务端处理完 hello（ping→pong 往返证明 hello 已消费）。
    ws.send({ type: "ping" });
    await ws.nextOfType("pong");

    // 无 wake 声明的 agent 不会被凭空标成 wakeable（要么没 presence 行，要么行里无 wake_kind）。
    const me = (await fetchPresence(slug, agent.token)).find((p) => p.name === agent.name);
    expect(me?.wake?.kind ?? undefined).toBeUndefined();
    ws.close();
  });

  it("wake_kind=watch 的连接断开后撤销 wake 声明 (#454)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0, directed_delivery: "v1", wake_kind: "watch" });
    await ws.nextOfType("presence");
    expect((await fetchPresence(slug, agent.token)).find((p) => p.name === agent.name)?.wake?.kind).toBe("watch");

    ws.close();
    // 断连回收后 wake_kind 撤销（markOffline 对 wake_kind='watch' 清零）。固定 50ms 等待在 CI 上会抖：
    // 有界轮询直到 presence 里的 wake.kind 消失（最多 ~2s），既不 flaky 也不掩盖真回归。
    let after: PresenceEntry | undefined;
    for (let i = 0; i < 40; i++) {
      after = (await fetchPresence(slug, agent.token)).find((p) => p.name === agent.name);
      if ((after?.wake?.kind ?? undefined) === undefined) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(after?.wake?.kind ?? undefined).toBeUndefined();
  });
});
