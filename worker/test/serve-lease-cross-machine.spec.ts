// issue #99 跨机那半：同名多个 serve（工位机 + 家里机各一）都连着同一频道，服务端广播把每条 @ 发给
// 所有同名连接 → 旧行为下两台都跑完整 runner、双份回帖、git push 类副作用执行两遍。同机单实例锁（#237，
// 本地 pid 锁）挡不住跨机器。这里补服务端 serve 租约：同名 serve 连接各自 claim，服务端只让最早 claim 的
// 那条持租（held=true）、其余转 standby（held=false）；持租者断连后租约转给下一条 standby（held=true）。
// 只有持租的那条才跑 runner —— 重复执行被服务端互斥掉，而不只是事后在 who 里看见 x2。
import type { PresenceEntry, ServeLeaseFrame } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, seedToken } from "./helpers";

async function claimServeLease(ws: WsClient): Promise<ServeLeaseFrame> {
  ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
  ws.send({ type: "serve_lease", op: "claim" });
  return ws.nextOfType("serve_lease");
}

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { presence: PresenceEntry[] };
  return body.presence;
}

describe("同名 serve 跨机租约（issue #99）", () => {
  it("两条同名 serve 都 claim：最早 claim 的持租，第二条转 standby（held=false）", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    const first = await WsClient.open(slug, agent.token);
    await first.nextOfType("welcome");
    const firstLease = await claimServeLease(first);
    expect(firstLease.held).toBe(true);
    expect(firstLease.name).toBe(agent.name);

    const second = await WsClient.open(slug, agent.token);
    await second.nextOfType("welcome");
    const secondLease = await claimServeLease(second);
    // 关键互斥：第二条同名 serve 不持租 → 它不会跑 runner，跨机重复执行被挡住
    expect(secondLease.held).toBe(false);
    expect(secondLease.name).toBe(agent.name);

    first.close();
    second.close();
  });

  it("持租者断连：租约转给 standby，补发 held=true（takeover）", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);

    // 人类观察者常驻，用它的 presence 帧同步 onClose 时机，避免竞态
    const watcher = await WsClient.open(slug, human.token);
    await watcher.nextOfType("welcome");

    const holder = await WsClient.open(slug, agent.token);
    await holder.nextOfType("welcome");
    expect((await claimServeLease(holder)).held).toBe(true);

    const standby = await WsClient.open(slug, agent.token);
    await standby.nextOfType("welcome");
    expect((await claimServeLease(standby)).held).toBe(false);

    // 持租者掉线（进程被 kill / 网络断） → 服务端把租约让给 standby
    holder.close();
    const takeover = await standby.nextOfType("serve_lease");
    expect(takeover.held).toBe(true);

    standby.close();
    watcher.close();
  });

  it("standby 顶替后原持租者重连：baton 不被抢回，新连接进 standby（软租约）", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    const watcher = await WsClient.open(slug, human.token);
    await watcher.nextOfType("welcome");

    const holder = await WsClient.open(slug, agent.token);
    await holder.nextOfType("welcome");
    expect((await claimServeLease(holder)).held).toBe(true);
    const standby = await WsClient.open(slug, agent.token);
    await standby.nextOfType("welcome");
    expect((await claimServeLease(standby)).held).toBe(false);

    holder.close();
    expect((await standby.nextOfType("serve_lease")).held).toBe(true); // standby 顶上

    // 原持租者重连并重新 claim：当前 standby 正持租且在跑，重连者不该抢回租约（否则两台抢跑）
    const rejoin = await WsClient.open(slug, agent.token);
    await rejoin.nextOfType("welcome");
    expect((await claimServeLease(rejoin)).held).toBe(false);

    standby.close();
    rejoin.close();
    watcher.close();
  });

  it("/presence 暴露 serve standby 数：同名 2 台 serve → serve_standbys=1", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    // 人类观察者常驻，用它的 participants 帧同步第二台断连的 onClose 时机，避免竞态。
    const watcher = await WsClient.open(slug, human.token);
    await watcher.nextOfType("welcome");

    const first = await WsClient.open(slug, agent.token);
    await first.nextOfType("welcome");
    expect((await claimServeLease(first)).held).toBe(true);
    // 真实 serve 挂上即 advertise 一条 status（residency=supervised、wake=serve）→ 建 presence 行。
    first.send({
      type: "send",
      kind: "status",
      state: "waiting",
      note: "serving",
      mentions: [],
      residency: "supervised",
      wake: { kind: "serve", verified_at: 1 },
    });
    await first.nextOfType("sent");
    const second = await WsClient.open(slug, agent.token);
    await second.nextOfType("welcome");
    expect((await claimServeLease(second)).held).toBe(false);

    const list = await fetchPresence(slug, agent.token);
    const me = list.find((p) => p.name === agent.name)!;
    expect(me).toBeDefined();
    expect(me.serve_standbys).toBe(1);

    // 只剩一台 serve：standby 数归零（省略）。等 watcher 收到断连引发的 participants 帧，确保 onClose 已结算。
    second.close();
    await watcher.nextOfType("participants");
    const soloList = await fetchPresence(slug, agent.token);
    const solo = soloList.find((p) => p.name === agent.name)!;
    expect(solo.serve_standbys).toBeUndefined();

    first.close();
    watcher.close();
  });
});
