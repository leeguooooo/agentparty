import type { DirectedDelivery, DirectedDeliveryFrame, PublicDirectedDelivery } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type ChannelDO, DIRECTED_DELIVERY_QUEUED_TIMEOUT_MS } from "../src/do";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

async function sendMention(slug: string, token: string, target: string, body = `@${target} ping`) {
  const res = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions: [target], reply_to: null }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { seq: number };
}

async function claim(ws: WsClient) {
  ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
  ws.send({ type: "serve_lease", op: "claim" });
  return ws.nextOfType("serve_lease");
}

async function nextDeliveryState(
  ws: WsClient,
  deliveryId: string,
  state: DirectedDelivery["state"],
  requestId?: string,
) {
  for (;;) {
    const frame = await ws.nextOfType("delivery_state");
    if (
      frame.delivery.id === deliveryId &&
      frame.delivery.state === state &&
      (requestId === undefined || frame.request_id === requestId)
    ) return frame;
  }
}

async function deliveryRows(
  slug: string,
): Promise<Array<DirectedDelivery & { lease_connection_id: string | null; lease_adapter: string | null; target_owner: string | null }>> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec("SELECT * FROM directed_deliveries ORDER BY message_seq, target_name")
      .toArray()
      .map((row) => ({
        id: String(row.id),
        message_seq: Number(row.message_seq),
        target_name: String(row.target_name),
        target_owner: row.target_owner === null ? null : String(row.target_owner),
        cause: String(row.cause) as DirectedDelivery["cause"],
        state: String(row.state) as DirectedDelivery["state"],
        attempt: Number(row.attempt),
        lease_until: row.lease_until === null ? null : Number(row.lease_until),
        lease_connection_id: row.lease_connection_id === null ? null : String(row.lease_connection_id),
        lease_adapter: row.lease_adapter === null ? null : String(row.lease_adapter),
        work_id: row.work_id === null ? null : String(row.work_id),
        continuation_ref: row.continuation_ref === null ? null : String(row.continuation_ref),
        reply_seq: row.reply_seq === null ? null : Number(row.reply_seq),
        last_error: row.last_error === null ? null : String(row.last_error),
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
      })),
  );
}

async function messageMentions(slug: string, seq: number): Promise<string[]> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const row = state.storage.sql.exec("SELECT mentions_json FROM messages WHERE seq = ?", seq).toArray()[0];
    return JSON.parse(String(row?.mentions_json ?? "[]")) as string[];
  });
}

async function expectUpgradeRequiredWithoutRaw(ws: WsClient, forbiddenSeq?: number) {
  for (;;) {
    const frame = await ws.next();
    if (frame.type === "msg" && (forbiddenSeq === undefined || frame.seq === forbiddenSeq)) {
      throw new Error(`legacy socket received forbidden raw seq=${frame.seq}`);
    }
    if (frame.type === "error") {
      expect(frame.code).toBe("unavailable");
      expect(frame.message).toContain("upgrade_required");
      return frame;
    }
  }
}

describe("持久定向投递（issue #551）", () => {
  it("does not route explicit mentions to an agent token scoped to another channel", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const sender = await seedToken("agent", uniq("sender"), { owner });
    const scopedElsewhere = await seedToken("agent", uniq("scoped"), { owner, channelScope: "other-channel" });
    const slug = await createChannel(sender.token);

    const response = await api(`/api/channels/${slug}/messages`, sender.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "cross scope", mentions: [scopedElsewhere.name], reply_to: null }),
    });

    expect(response.status).toBe(400);
    expect(await deliveryRows(slug)).toEqual([]);
  });

  it("does not expand squad members whose agent tokens are scoped to another channel", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const sender = await seedToken("agent", uniq("sender"), { owner });
    const inScope = await seedToken("agent", uniq("in-scope"), { owner });
    const outOfScope = await seedToken("agent", uniq("out-scope"), { owner, channelScope: "other-channel" });
    const slug = await createChannel(sender.token);
    const squad = uniq("squad").toLowerCase();
    await env.DB.prepare(
      "INSERT INTO channel_squads (channel_slug, name, leader_name, members_json, created_by, created_by_kind, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, 'agent', ?, ?)",
    ).bind(slug, squad, JSON.stringify([inScope.name, outOfScope.name]), sender.name, Date.now(), Date.now()).run();

    const posted = await sendMention(slug, sender.token, squad, "team work");

    expect(await messageMentions(slug, posted.seq)).toEqual([squad, inScope.name]);
    expect(await deliveryRows(slug)).toMatchObject([{ target_name: inScope.name }]);
  });

  it("keeps historical agent replies ordinary when the current owner no longer matches sender_owner", async () => {
    const oldOwner = `${uniq("old-owner")}@example.com`;
    const newOwner = `${uniq("new-owner")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: oldOwner });
    const target = await seedToken("agent", uniq("reply-agent"), { owner: oldOwner });
    const slug = await createChannel(human.token);
    const posted = await sendMention(slug, human.token, target.name, "old owner question");
    await env.DB.prepare("UPDATE tokens SET owner = ? WHERE name = ?").bind(newOwner, target.name).run();

    const reply = await api(`/api/channels/${slug}/messages`, human.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "following up", mentions: [], reply_to: posted.seq }),
    });

    expect(reply.status).toBe(200);
    const replySeq = ((await reply.json()) as { seq: number }).seq;
    expect(await messageMentions(slug, replySeq)).toEqual([]);
    expect(await deliveryRows(slug)).toHaveLength(1);
  });

  it("pause keeps the original delivery queued and resume dispatches that exact work once", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const holder = await WsClient.open(slug, target.token);
    await holder.nextOfType("welcome");
    expect((await claim(holder)).held).toBe(true);

    const paused = await api(`/api/channels/${slug}/presence/${encodeURIComponent(target.name)}/pause`, sender.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(paused.status).toBe(200);
    const posted = await sendMention(slug, sender.token, target.name, "queued while paused");
    await expect(holder.nextOfType("delivery", 100)).rejects.toThrow("timeout waiting for frame");
    const queued = (await deliveryRows(slug))[0]!;
    expect(queued).toMatchObject({
      message_seq: posted.seq,
      target_name: target.name,
      state: "queued",
      attempt: 0,
      lease_connection_id: null,
    });

    const resumed = await api(`/api/channels/${slug}/presence/${encodeURIComponent(target.name)}/resume`, sender.token, {
      method: "POST",
    });
    expect(resumed.status).toBe(200);
    const work = (await holder.nextOfType("delivery")) as DirectedDeliveryFrame;
    expect(work.delivery).toMatchObject({ id: queued.id, message_seq: posted.seq, state: "claimed", attempt: 1 });
    holder.send({
      type: "delivery_update",
      delivery_id: work.delivery.id,
      state: "running",
      work_id: work.delivery.work_id!,
      continuation_ref: work.delivery.continuation_ref!,
    });
    await nextDeliveryState(holder, work.delivery.id, "running");

    const reply = await api(`/api/channels/${slug}/messages`, target.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "resumed once", mentions: [], reply_to: posted.seq }),
    });
    expect(reply.status).toBe(200);
    const replySeq = ((await reply.json()) as { seq: number }).seq;
    await nextDeliveryState(holder, work.delivery.id, "replied");

    // The runner's inevitable terminal receipt is idempotent after the linked REST reply already
    // settled the row; it must not manufacture another delivery or another channel reply.
    holder.send({
      type: "delivery_update",
      delivery_id: work.delivery.id,
      request_id: "pause-resume-terminal",
      state: "replied",
      reply_seq: replySeq,
    });
    await nextDeliveryState(holder, work.delivery.id, "replied", "pause-resume-terminal");
    const settledSource = (await deliveryRows(slug)).filter(
      (delivery) => delivery.message_seq === posted.seq && delivery.target_name === target.name,
    );
    expect(settledSource).toMatchObject([{
      id: queued.id,
      state: "replied",
      attempt: 1,
      reply_seq: replySeq,
    }]);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM messages WHERE sender_name = ? AND reply_to = ? AND body = 'resumed once'",
        target.name,
        posted.seq,
      ).one().n)).toBe(1);
    });
    holder.close();
  });

  it("legacy serve 已持租时保持 holder，后来的 v1 为 standby 且不重复领取", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);

    const legacy = await WsClient.open(slug, target.token);
    await legacy.nextOfType("welcome");
    legacy.send({ type: "hello", since: 0, client_version: "0.2.117" });
    legacy.send({ type: "serve_lease", op: "claim" });
    expect((await legacy.nextOfType("serve_lease")).held).toBe(true);

    const capable = await WsClient.open(slug, target.token);
    await capable.nextOfType("welcome");
    expect((await claim(capable)).held).toBe(false);

    const posted = await sendMention(slug, sender.token, target.name, "rolling upgrade");
    expect((await legacy.nextOfType("msg")).seq).toBe(posted.seq);
    await expect(legacy.nextOfType("delivery", 100)).rejects.toThrow("timeout waiting for frame");
    await expect(capable.nextOfType("delivery", 100)).rejects.toThrow("timeout waiting for frame");
    expect(await deliveryRows(slug)).toMatchObject([
      {
        message_seq: posted.seq,
        target_name: target.name,
        state: "running",
        attempt: 1,
        lease_adapter: "legacy_serve",
      },
    ]);

    const reply = await api(`/api/channels/${slug}/messages`, target.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "legacy finished", mentions: [], reply_to: posted.seq }),
    });
    expect(reply.status).toBe(200);
    const replySeq = ((await reply.json()) as { seq: number }).seq;
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "replied", reply_seq: replySeq });

    legacy.close();
    expect((await capable.nextOfType("serve_lease")).held).toBe(true);
    await expect(capable.nextOfType("delivery", 100)).rejects.toThrow("timeout waiting for frame");
    capable.close();
  });

  it("legacy raw handoff 超时按 unknown outcome 失败，绝不自动重派", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const legacy = await WsClient.open(slug, target.token);
    await legacy.nextOfType("welcome");
    legacy.send({ type: "hello", since: 0, client_version: "0.2.117" });
    legacy.send({ type: "serve_lease", op: "claim" });
    expect((await legacy.nextOfType("serve_lease")).held).toBe(true);

    const posted = await sendMention(slug, sender.token, target.name, "side effect only");
    expect((await legacy.nextOfType("msg")).seq).toBe(posted.seq);
    const row = (await deliveryRows(slug))[0]!;
    expect(row).toMatchObject({ state: "running", attempt: 1, lease_adapter: "legacy_serve" });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE directed_deliveries SET lease_until = ? WHERE id = ?", Date.now() - 1, row.id);
      await instance.onAlarm();
    });
    expect((await deliveryRows(slug))[0]).toMatchObject({
      state: "failed",
      attempt: 1,
      last_error: "runner ownership lost after task start; outcome unknown, not auto-retried",
    });
    legacy.close();
  });

  it("old-only watch 收到 upgrade_required 且 raw 被抑制，durable row 保持 queued", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const legacy = await WsClient.open(slug, target.token);
    await legacy.nextOfType("welcome");
    legacy.send({ type: "hello", since: 0, client_version: "0.2.117" });
    legacy.raw('{"type":"ping"}');
    await legacy.nextOfType("pong");

    const posted = await sendMention(slug, sender.token, target.name, "upgrade old once");
    await expectUpgradeRequiredWithoutRaw(legacy, posted.seq);
    expect((await deliveryRows(slug))[0]).toMatchObject({
      message_seq: posted.seq,
      state: "queued",
      attempt: 0,
      lease_adapter: null,
    });
  });

  it("hibernated legacy state 的 helloPending=undefined 也会 suppress；old+v1 只执行一次", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const legacy = await WsClient.open(slug, target.token);
    await legacy.nextOfType("welcome");
    legacy.send({ type: "hello", since: 0, client_version: "0.2.117" });
    legacy.raw('{"type":"ping"}');
    await legacy.nextOfType("pong");
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      for (const connection of instance.getConnections<Record<string, unknown>>()) {
        const state = connection.state;
        if (state?.name !== target.name || state.clientVersion !== "0.2.117") continue;
        const persisted = { ...state };
        delete persisted.helloPending;
        delete persisted.helloDeadlineAt;
        connection.setState(persisted);
      }
    });
    const capable = await WsClient.open(slug, target.token);
    await capable.nextOfType("welcome");
    expect((await claim(capable)).held).toBe(true);

    const posted = await sendMention(slug, sender.token, target.name, "persisted state safety");
    const delivery = await capable.nextOfType("delivery");
    await expectUpgradeRequiredWithoutRaw(legacy, posted.seq);
    expect(delivery.delivery).toMatchObject({ message_seq: posted.seq, state: "claimed", attempt: 1 });
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "claimed", lease_adapter: "serve" });
    capable.close();
  });

  it("old once 的 earlier ordinary/@ backfill 不会缓存目标 raw；v1 完成后重连也不重跑", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const other = await seedToken("agent", uniq("other"));
    const slug = await createChannel(sender.token);
    const ordinary = await api(`/api/channels/${slug}/messages`, sender.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "earlier ordinary", mentions: [], reply_to: null }),
    });
    expect(ordinary.status).toBe(200);
    const ordinarySeq = ((await ordinary.json()) as { seq: number }).seq;
    const earlierAt = await sendMention(slug, sender.token, other.name, "earlier other @");
    const posted = await sendMention(slug, sender.token, target.name, "only v1 executes");

    const capable = await WsClient.open(slug, target.token);
    await capable.nextOfType("welcome");
    expect((await claim(capable)).held).toBe(true);
    const delivery = await capable.nextOfType("delivery");
    expect(delivery.delivery).toMatchObject({ message_seq: posted.seq, state: "claimed", attempt: 1 });

    const legacy = await WsClient.open(slug, target.token);
    await legacy.nextOfType("welcome");
    legacy.send({ type: "hello", since: 0, client_version: "0.2.117" });
    expect((await legacy.nextOfType("msg")).seq).toBe(ordinarySeq);
    expect((await legacy.nextOfType("msg")).seq).toBe(earlierAt.seq);
    await expectUpgradeRequiredWithoutRaw(legacy, posted.seq);
    expect((await deliveryRows(slug)).find((row) => row.message_seq === posted.seq)).toMatchObject({
      state: "claimed",
      attempt: 1,
      lease_adapter: "serve",
    });

    const reply = await api(`/api/channels/${slug}/messages`, target.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "done once", mentions: [], reply_to: posted.seq }),
    });
    expect(reply.status).toBe(200);
    expect((await deliveryRows(slug)).find((row) => row.message_seq === posted.seq)).toMatchObject({
      state: "replied",
      attempt: 1,
    });
    capable.close();

    const legacyReconnect = await WsClient.open(slug, target.token);
    await legacyReconnect.nextOfType("welcome");
    legacyReconnect.send({ type: "hello", since: 0, client_version: "0.2.117" });
    expect((await legacyReconnect.nextOfType("msg")).seq).toBe(ordinarySeq);
    expect((await legacyReconnect.nextOfType("msg")).seq).toBe(earlierAt.seq);
    await expectUpgradeRequiredWithoutRaw(legacyReconnect, posted.seq);

    const v1Reconnect = await WsClient.open(slug, target.token);
    await v1Reconnect.nextOfType("welcome");
    expect((await claim(v1Reconnect)).held).toBe(true);
    await expect(v1Reconnect.nextOfType("delivery", 100)).rejects.toThrow("timeout waiting for frame");
    v1Reconnect.close();
  });

  it("v1 已 holder 时 legacy serve 直接 upgrade_required，完成和 holder switch 都不重放 raw", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const capable = await WsClient.open(slug, target.token);
    await capable.nextOfType("welcome");
    expect((await claim(capable)).held).toBe(true);

    const legacy = await WsClient.open(slug, target.token);
    await legacy.nextOfType("welcome");
    legacy.send({ type: "hello", since: 0, client_version: "0.2.117" });
    legacy.send({ type: "serve_lease", op: "claim" });
    await expectUpgradeRequiredWithoutRaw(legacy);

    const posted = await sendMention(slug, sender.token, target.name, "reviewer standby must not cache");
    const delivery = await capable.nextOfType("delivery");
    expect(delivery.delivery).toMatchObject({ message_seq: posted.seq, state: "claimed", attempt: 1 });
    const reply = await api(`/api/channels/${slug}/messages`, target.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "v1 completed", mentions: [], reply_to: posted.seq }),
    });
    expect(reply.status).toBe(200);
    capable.close();

    const oldReconnect = await WsClient.open(slug, target.token);
    await oldReconnect.nextOfType("welcome");
    oldReconnect.send({ type: "hello", since: 0, client_version: "0.2.117" });
    await expectUpgradeRequiredWithoutRaw(oldReconnect, posted.seq);
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "replied", attempt: 1 });
  });

  it("no-hello 持续 ping 也不能延长 deadline；alarm 关闭后 v1 立即领取", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const pending = await WsClient.open(slug, target.token);
    await pending.nextOfType("welcome");
    const capable = await WsClient.open(slug, target.token);
    await capable.nextOfType("welcome");
    expect((await claim(capable)).held).toBe(true);

    const posted = await sendMention(slug, sender.token, target.name, "between welcome and hello");
    await expect(pending.nextOfType("msg", 100)).rejects.toThrow("timeout waiting for frame");
    await expect(capable.nextOfType("delivery", 100)).rejects.toThrow("timeout waiting for frame");
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "queued", attempt: 0 });

    for (let i = 0; i < 3; i++) {
      pending.raw('{"type":"ping"}');
      await pending.nextOfType("pong");
    }
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      for (const connection of instance.getConnections<Record<string, unknown>>()) {
        const state = connection.state;
        if (state?.name === target.name && state.helloPending === true) {
          connection.setState({ ...state, helloDeadlineAt: Date.now() - 1, lastSeen: Date.now() });
        }
      }
      await instance.onAlarm();
    });
    const timeout = await pending.nextOfType("error");
    expect(timeout).toMatchObject({ code: "bad_request" });
    expect(timeout.message).toContain("hello_required");
    const delivery = await capable.nextOfType("delivery");
    expect(delivery.delivery).toMatchObject({ message_seq: posted.seq, state: "claimed", attempt: 1 });
    capable.close();
  });

  it("Web agent 无 client_version 只做观察者，不被 upgrade_required 误伤", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const web = await WsClient.open(slug, target.token);
    await web.nextOfType("welcome");
    web.send({ type: "hello", since: 0 });
    const capable = await WsClient.open(slug, target.token);
    await capable.nextOfType("welcome");
    expect((await claim(capable)).held).toBe(true);
    const posted = await sendMention(slug, sender.token, target.name, "web observer");
    expect((await web.nextOfType("msg")).seq).toBe(posted.seq);
    const delivery = await capable.nextOfType("delivery");
    expect(delivery.delivery).toMatchObject({ message_seq: posted.seq, state: "claimed" });
    expect((await deliveryRows(slug))[0]).toMatchObject({ lease_adapter: "serve" });
    web.close();
    capable.close();
  });

  it("agent 离线时只排队；上线 claim 后收到引用原 message 的 delivery", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("offline"));
    const slug = await createChannel(sender.token);

    const posted = await sendMention(slug, sender.token, target.name, "offline work");
    expect(await deliveryRows(slug)).toMatchObject([
      { message_seq: posted.seq, target_name: target.name, cause: "mention", state: "queued", attempt: 0 },
    ]);

    const serve = await WsClient.open(slug, target.token);
    const welcome = await serve.nextOfType("welcome");
    expect(welcome.directed_delivery).toBe("v1");
    serve.send({ type: "hello", since: 0, directed_delivery: "v1" });
    serve.send({ type: "serve_lease", op: "claim" });
    let sawSourceBackfill = false;
    let sawHeldLease = false;
    let frame: DirectedDeliveryFrame | undefined;
    while (frame === undefined) {
      const next = await serve.next();
      if (next.type === "msg" && next.seq === posted.seq) sawSourceBackfill = true;
      if (next.type === "serve_lease") {
        expect(next.held).toBe(true);
        sawHeldLease = true;
      }
      if (next.type === "delivery") {
        expect(sawSourceBackfill).toBe(true);
        expect(sawHeldLease).toBe(true);
        frame = next;
      }
    }
    expect(frame).toMatchObject({
      delivery: { message_seq: posted.seq, target_name: target.name, state: "claimed", attempt: 1 },
      message: { seq: posted.seq, body: "offline work" },
    });
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "claimed", attempt: 1 });
    serve.close();
  });

  it("同一 target 串行 claim；无问题不能停车；终态回执幂等并释放下一条", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const serve = await WsClient.open(slug, target.token);
    await serve.nextOfType("welcome");
    expect((await claim(serve)).held).toBe(true);

    const first = await sendMention(slug, sender.token, target.name, "first");
    const firstDelivery = await serve.nextOfType("delivery");
    const second = await sendMention(slug, sender.token, target.name, "second");
    // 普通消息游标即使前移到第二条之后，也不能改变独立 delivery 状态。
    serve.send({ type: "seen", seq: second.seq + 100 });
    serve.send({ type: "ping" });
    await serve.nextOfType("pong");
    expect(await deliveryRows(slug)).toMatchObject([
      { message_seq: first.seq, state: "claimed" },
      { message_seq: second.seq, state: "queued" },
    ]);

    serve.send({
      type: "delivery_update",
      delivery_id: firstDelivery.delivery.id,
      state: "waiting_owner",
      work_id: firstDelivery.delivery.work_id,
      continuation_ref: firstDelivery.delivery.continuation_ref,
    });
    expect((await serve.nextOfType("error")).code).toBe("bad_request");
    expect(await deliveryRows(slug)).toMatchObject([
      {
        message_seq: first.seq,
        state: "claimed",
        work_id: firstDelivery.delivery.work_id,
        continuation_ref: firstDelivery.delivery.continuation_ref,
      },
      { message_seq: second.seq, state: "queued" },
    ]);
    serve.send({
      type: "delivery_update",
      delivery_id: firstDelivery.delivery.id,
      request_id: "first-failure",
      state: "failed",
      error: "runner exited",
    });
    const firstBroadcast = await nextDeliveryState(serve, firstDelivery.delivery.id, "failed");
    expect(firstBroadcast.request_id).toBeUndefined();
    const secondDelivery = await serve.nextOfType("delivery");
    expect(secondDelivery.delivery).toMatchObject({ message_seq: second.seq, state: "claimed", attempt: 1 });
    expect(await nextDeliveryState(serve, firstDelivery.delivery.id, "failed", "first-failure")).toMatchObject({
      request_id: "first-failure",
      delivery: { id: firstDelivery.delivery.id, state: "failed" },
    });
    // 同一个终态帧重发只返回权威 ACK，不会再改写或重复释放队列。
    serve.send({
      type: "delivery_update",
      delivery_id: firstDelivery.delivery.id,
      request_id: "retry-failure",
      state: "failed",
      error: "ignored retry",
    });
    expect(await nextDeliveryState(serve, firstDelivery.delivery.id, "failed", "retry-failure")).toMatchObject({
      request_id: "retry-failure",
      delivery: { id: firstDelivery.delivery.id, state: "failed" },
    });
    expect(await deliveryRows(slug)).toMatchObject([
      { message_seq: first.seq, state: "failed", last_error: "runner exited" },
      { message_seq: second.seq, state: "claimed" },
    ]);
    serve.send({
      type: "delivery_update",
      delivery_id: secondDelivery.delivery.id,
      state: "failed",
      error: "second exited",
    });
    await nextDeliveryState(serve, secondDelivery.delivery.id, "failed");
    expect((await deliveryRows(slug))[1]).toMatchObject({ state: "failed", last_error: "second exited" });
    serve.close();
  });

  it("delivery_update 只在本连接的直接 ACK 回显临时 request_id", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const serve = await WsClient.open(slug, target.token);
    await serve.nextOfType("welcome");
    expect((await claim(serve)).held).toBe(true);

    await sendMention(slug, sender.token, target.name, "correlated ack");
    const work = await serve.nextOfType("delivery");
    serve.send({
      type: "delivery_update",
      delivery_id: work.delivery.id,
      request_id: "request-ack-1",
      state: "running",
      work_id: work.delivery.work_id,
      continuation_ref: work.delivery.continuation_ref,
    });

    const broadcast = await serve.nextOfType("delivery_state");
    const direct = await serve.nextOfType("delivery_state");
    expect(broadcast).toMatchObject({ delivery: { id: work.delivery.id, state: "running" } });
    expect(broadcast.request_id).toBeUndefined();
    expect(direct).toMatchObject({
      request_id: "request-ack-1",
      delivery: { id: work.delivery.id, state: "running" },
    });
    serve.close();
  });

  it("holder 断连后同一 delivery 回到 queued 并由 standby 接管", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const holder = await WsClient.open(slug, target.token);
    await holder.nextOfType("welcome");
    expect((await claim(holder)).held).toBe(true);
    const standby = await WsClient.open(slug, target.token);
    await standby.nextOfType("welcome");
    expect((await claim(standby)).held).toBe(false);

    const posted = await sendMention(slug, sender.token, target.name, "survive disconnect");
    const firstAttempt = await holder.nextOfType("delivery");
    holder.close();
    expect((await standby.nextOfType("serve_lease")).held).toBe(true);
    const retry = await standby.nextOfType("delivery");
    expect(retry.delivery).toMatchObject({
      id: firstAttempt.delivery.id,
      message_seq: posted.seq,
      cause: "retry",
      state: "claimed",
      attempt: 2,
    });
    standby.close();
  });

  it("processes an already-received terminal update before disconnect cleanup", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const holder = await WsClient.open(slug, target.token);
    await holder.nextOfType("welcome");
    expect((await claim(holder)).held).toBe(true);
    await sendMention(slug, sender.token, target.name, "reply then close");
    const work = (await holder.nextOfType("delivery")) as DirectedDeliveryFrame;

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const runtime = instance as unknown as {
        isTokenActive(tokenHash: string): Promise<boolean>;
        onMessage(connection: unknown, message: string): Promise<void>;
        onClose(connection: unknown): void | Promise<void>;
      };
      const connection = [...instance.getConnections<{ name?: string; serveLeaseHeld?: boolean }>()]
        .find((candidate) =>
          candidate.state?.name === target.name && candidate.state?.serveLeaseHeld === true
        );
      expect(connection).toBeDefined();
      const replySeq = Number(state.storage.sql.exec("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages").one().seq);
      // Model a reply that was already persisted by another request but whose linkWakeResume side
      // effect has not yet run. The terminal receipt may finish this exact linked reply; a bare
      // zero-exit receipt is covered separately and must fail.
      state.storage.sql.exec(
        `INSERT INTO messages (seq, sender_name, sender_kind, kind, body, mentions_json, reply_to, ts)
         VALUES (?, ?, 'agent', 'message', 'linked reply', '[]', ?, ?)`,
        replySeq,
        target.name,
        work.message.seq,
        Date.now(),
      );

      const realIsTokenActive = runtime.isTokenActive.bind(instance);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const validationEntered = new Promise<void>((resolve) => { entered = resolve; });
      runtime.isTokenActive = async (tokenHash: string) => {
        entered();
        await gate;
        return realIsTokenActive(tokenHash);
      };
      try {
        const update = runtime.onMessage(connection!, JSON.stringify({
          type: "delivery_update",
          delivery_id: work.delivery.id,
          request_id: "reply-before-close",
          state: "replied",
          reply_seq: replySeq,
          work_id: work.delivery.work_id,
          continuation_ref: work.delivery.continuation_ref,
        }));
        await validationEntered;
        const close = Promise.resolve(runtime.onClose(connection!));
        release();
        await Promise.all([update, close]);
      } finally {
        release();
        runtime.isTokenActive = realIsTokenActive;
      }
    });

    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: work.delivery.id,
      state: "replied",
      attempt: 1,
      lease_connection_id: null,
      lease_adapter: null,
    });
    holder.close();
  });

  it("fails a bare success receipt that has no linked channel reply", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const holder = await WsClient.open(slug, target.token);
    await holder.nextOfType("welcome");
    expect((await claim(holder)).held).toBe(true);
    await sendMention(slug, sender.token, target.name, "silent command");
    const work = (await holder.nextOfType("delivery")) as DirectedDeliveryFrame;

    holder.send({
      type: "delivery_update",
      delivery_id: work.delivery.id,
      state: "running",
      ...(work.delivery.work_id === null ? {} : { work_id: work.delivery.work_id }),
      ...(work.delivery.continuation_ref === null ? {} : { continuation_ref: work.delivery.continuation_ref }),
    });
    await nextDeliveryState(holder, work.delivery.id, "running");
    holder.send({
      type: "delivery_update",
      delivery_id: work.delivery.id,
      request_id: "silent-success",
      state: "replied",
    });
    expect(await nextDeliveryState(holder, work.delivery.id, "failed", "silent-success")).toMatchObject({
      delivery: { id: work.delivery.id, state: "failed", reply_seq: null },
    });
    expect((await deliveryRows(slug))[0]).toMatchObject({
      state: "failed",
      reply_seq: null,
      last_error: "runner reported success without a linked channel reply",
    });
    holder.close();
  });

  it("权威 running ACK 后 heartbeat 续租；租约到期显式 failed 而不重放未知副作用", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const holder = await WsClient.open(slug, target.token);
    await holder.nextOfType("welcome");
    expect((await claim(holder)).held).toBe(true);
    const standby = await WsClient.open(slug, target.token);
    await standby.nextOfType("welcome");
    expect((await claim(standby)).held).toBe(false);
    const posted = await sendMention(slug, sender.token, target.name, "long task");
    const firstAttempt = await holder.nextOfType("delivery");

    holder.send({
      type: "delivery_update",
      delivery_id: firstAttempt.delivery.id,
      state: "running",
      work_id: firstAttempt.delivery.work_id,
      continuation_ref: firstAttempt.delivery.continuation_ref,
    });
    await nextDeliveryState(holder, firstAttempt.delivery.id, "running");
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "running", attempt: 1 });
    holder.send({
      type: "heartbeat",
      current_task: posted.seq,
      task_started_at: Date.now() - 1000,
      heartbeat_at: Date.now(),
    });
    holder.send({ type: "ping" });
    await holder.nextOfType("pong");
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "running", attempt: 1 });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE directed_deliveries SET lease_until = ? WHERE id = ?", Date.now() - 1, firstAttempt.delivery.id);
      await instance.onAlarm();
    });
    expect((await standby.nextOfType("serve_lease")).held).toBe(true);
    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: firstAttempt.delivery.id,
      state: "failed",
      attempt: 1,
      last_error: "runner ownership lost after task start; outcome unknown, not auto-retried",
    });
    standby.close();
  });

  it("reply_to 与 status.summary_seq 都自动把对应 delivery 标为 replied", async () => {
    const sender = await seedToken("human", uniq("human"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const serve = await WsClient.open(slug, target.token);
    await serve.nextOfType("welcome");
    expect((await claim(serve)).held).toBe(true);

    const first = await sendMention(slug, sender.token, target.name, "reply please");
    await serve.nextOfType("delivery");
    const reply = await api(`/api/channels/${slug}/messages`, target.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "done", mentions: [], reply_to: first.seq }),
    });
    expect(reply.status).toBe(200);
    const replySeq = ((await reply.json()) as { seq: number }).seq;
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "replied", reply_seq: replySeq });

    const second = await sendMention(slug, sender.token, target.name, "summarize please");
    await serve.nextOfType("delivery");
    const status = await api(`/api/channels/${slug}/messages`, target.token, {
      method: "POST",
      body: JSON.stringify({
        kind: "status",
        state: "done",
        note: "summarized",
        mentions: [],
        summary_seq: second.seq,
      }),
    });
    expect(status.status).toBe(200);
    const statusSeq = ((await status.json()) as { seq: number }).seq;
    expect((await deliveryRows(slug))[1]).toMatchObject({ state: "replied", reply_seq: statusSeq });
    serve.close();
  });

  it("human/squad 本身不建 delivery；squad 只给既有路由展开出的 agent 建唯一 delivery", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const memberA = await seedToken("agent", uniq("agent-a"), { owner });
    const memberB = await seedToken("agent", uniq("agent-b"), { owner });
    const mentionedHuman = await seedToken("human", uniq("mentioned-human"), { owner });
    const slug = await createChannel(human.token);
    const squadName = uniq("squad").toLowerCase();
    const squad = await api(`/api/channels/${slug}/squads`, human.token, {
      method: "POST",
      body: JSON.stringify({ name: squadName, leader: memberA.name, members: [memberA.name, memberB.name] }),
    });
    expect(squad.status).toBe(201);

    await sendMention(slug, human.token, mentionedHuman.name, "human notification");
    await sendMention(slug, human.token, squadName, "squad work");
    const rows = await deliveryRows(slug);
    // 现有 squad 语义：有 leader 时只路由 leader；关键是 human 与 squad 虚拟名本身都不进 work 队列。
    expect(rows.map((row) => row.target_name)).toEqual([memberA.name]);
    expect(rows.every((row) => row.state === "queued" && row.attempt === 0)).toBe(true);
  });

  it("standby 或错误连接不能伪造终态", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const holder = await WsClient.open(slug, target.token);
    await holder.nextOfType("welcome");
    expect((await claim(holder)).held).toBe(true);
    const standby = await WsClient.open(slug, target.token);
    await standby.nextOfType("welcome");
    expect((await claim(standby)).held).toBe(false);
    await sendMention(slug, sender.token, target.name, "strict ownership");
    const work = (await holder.nextOfType("delivery")) as DirectedDeliveryFrame;

    standby.send({ type: "delivery_update", delivery_id: work.delivery.id, state: "replied" });
    expect((await standby.nextOfType("error")).code).toBe("bad_request");
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "claimed" });
    holder.close();
    standby.close();
  });

  it("同名 agent 换 owner 后不能读取或领取旧 principal 的 work，且旧队列不阻塞新 work", async () => {
    const oldOwner = `${uniq("old-owner")}@example.com`;
    const newOwner = `${uniq("new-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner: oldOwner });
    const target = await seedToken("agent", uniq("reused-name"), { owner: oldOwner });
    const slug = await createChannel(sender.token);
    await env.DB.prepare("UPDATE channels SET visibility = 'public' WHERE slug = ?").bind(slug).run();
    const oldMessage = await sendMention(slug, sender.token, target.name, "old owner private work");
    const oldRow = (await deliveryRows(slug))[0]!;
    expect(oldRow).toMatchObject({
      message_seq: oldMessage.seq,
      target_owner: oldOwner,
      state: "queued",
    });

    // persistToken reuses the same D1 row when a revoked name is registered again. Updating owner is
    // enough to reproduce the security boundary while keeping this test independent of token API UX.
    await env.DB.prepare("UPDATE tokens SET owner = ? WHERE name = ?")
      .bind(newOwner, target.name)
      .run();
    const legacyReplacement = await WsClient.open(slug, target.token);
    await legacyReplacement.nextOfType("welcome");
    legacyReplacement.send({ type: "hello", since: 0, client_version: "0.2.117" });
    await expectUpgradeRequiredWithoutRaw(legacyReplacement, oldMessage.seq);
    expect((await deliveryRows(slug))[0]).toMatchObject({ id: oldRow.id, state: "queued" });

    const replacement = await WsClient.open(slug, target.token);
    await replacement.nextOfType("welcome");
    const replacementLease = await claim(replacement).catch((error: unknown) => {
      throw new Error(`replacement did not receive serve lease: ${String(error)}`);
    });
    expect(replacementLease.held).toBe(true);
    expect((await deliveryRows(slug))[0]).toMatchObject({ id: oldRow.id, state: "failed" });

    replacement.send({ type: "hello", since: 0, since_rev: 0 });
    const publicFailure = await replacement.nextOfType("delivery_state").catch((error: unknown) => {
      throw new Error(`missing public failure replay: ${String(error)}`);
    });
    expect(publicFailure.delivery).toMatchObject({ id: oldRow.id, state: "failed" });
    expect(Object.keys(publicFailure.delivery).sort()).toEqual(
      ["created_at", "id", "message_seq", "preview", "reply_seq", "state", "target_name", "updated_at"].sort(),
    );
    expect(publicFailure.delivery).not.toHaveProperty("work_id");
    expect(publicFailure.delivery).not.toHaveProperty("continuation_ref");
    expect(publicFailure.delivery).not.toHaveProperty("last_error");

    const freshMessage = await sendMention(slug, sender.token, target.name, "new owner work");
    const freshDelivery = await replacement.nextOfType("delivery").catch((error: unknown) => {
      throw new Error(`fresh principal did not receive new work: ${String(error)}`);
    });
    expect(freshDelivery.delivery).toMatchObject({
      message_seq: freshMessage.seq,
      target_name: target.name,
      state: "claimed",
    });
    expect(freshDelivery.delivery.id).not.toBe(oldRow.id);
    expect(await deliveryRows(slug)).toMatchObject([
      {
        id: oldRow.id,
        target_owner: oldOwner,
        state: "failed",
        last_error: "target principal changed before delivery; refusing same-name reassignment",
      },
      { target_owner: newOwner, state: "claimed" },
    ]);
    replacement.close();
  });

  it("hello 在 message backfill 后分页回放全部 retained delivery_state", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("target"));
    const slug = await createChannel(sender.token);
    const posted = await sendMention(slug, sender.token, target.name, "reload truth");
    const states: DirectedDelivery["state"][] = [
      "queued",
      "claimed",
      "running",
      "waiting_owner",
      "failed",
      "replied",
    ];
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const now = Date.now();
      // Together with the real row this crosses HELLO_BACKFILL_PAGE_SIZE=1000, proving the
      // compound (message_seq,id) cursor does not stop at the first full page.
      for (let i = 0; i < 1000; i++) {
        const deliveryState = states[i % states.length]!;
        state.storage.sql.exec(
          `INSERT INTO directed_deliveries (
             id, message_seq, target_name, cause, state, attempt,
             lease_connection_id, last_lease_connection_id, lease_until, work_id, continuation_ref,
             reply_seq, last_error, created_at, updated_at
           ) VALUES (?, ?, ?, 'mention', ?, 0, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?)`,
          `page-${String(i).padStart(4, "0")}`,
          posted.seq,
          `target-${String(i).padStart(4, "0")}`,
          deliveryState,
          `work-${i}`,
          `thread-${i}`,
          now + i,
          now + i,
        );
      }
    });

    const viewer = await WsClient.open(slug, sender.token);
    await viewer.nextOfType("welcome");
    viewer.send({ type: "hello", since: 0, since_rev: 0 });
    expect(await viewer.nextOfType("msg")).toMatchObject({ seq: posted.seq, body: "reload truth" });
    const replayed: PublicDirectedDelivery[] = [];
    for (let i = 0; i < 1001; i++) replayed.push((await viewer.nextOfType("delivery_state")).delivery);
    expect(new Set(replayed.map((delivery) => delivery.id)).size).toBe(1001);
    expect(new Set(replayed.map((delivery) => delivery.state))).toEqual(
      new Set(["queued", "running", "failed", "replied"]),
    );
    expect(replayed.every((delivery) => !("work_id" in delivery) && !("last_error" in delivery))).toBe(true);
    viewer.close();
  });

  it("delivery_state 投影携带目标消息的单行截断 preview（Agent 看板不再依赖客户端消息窗口）", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("preview-target"));
    const slug = await createChannel(sender.token);
    const posted = await sendMention(
      slug,
      sender.token,
      target.name,
      `@${target.name} 核对  KYC\n外部 token ${"x".repeat(200)}`,
    );

    const viewer = await WsClient.open(slug, sender.token);
    await viewer.nextOfType("welcome");
    viewer.send({ type: "hello", since: 0, since_rev: 0 });
    const frame = await viewer.nextOfType("delivery_state");
    expect(frame.delivery).toMatchObject({ message_seq: posted.seq, target_name: target.name, state: "queued" });
    const preview = frame.delivery.preview;
    expect(typeof preview).toBe("string");
    // 空白（含换行）折叠成单个空格，超长截到 160 以内并以省略号结尾。
    expect(preview).toContain("核对 KYC 外部 token");
    expect(preview!.length).toBeLessThanOrEqual(160);
    expect(preview!.endsWith("…")).toBe(true);
    viewer.close();
  });

  it("已擦除（[erased] 墓碑）消息的 delivery_state preview 回 null", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("erased-target"));
    const slug = await createChannel(sender.token);
    const posted = await sendMention(slug, sender.token, target.name, "identity to erase");
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE messages SET body = '[erased]' WHERE seq = ?", posted.seq);
    });

    const viewer = await WsClient.open(slug, sender.token);
    await viewer.nextOfType("welcome");
    viewer.send({ type: "hello", since: 0, since_rev: 0 });
    const frame = await viewer.nextOfType("delivery_state");
    expect(frame.delivery).toMatchObject({ message_seq: posted.seq, state: "queued" });
    expect(frame.delivery.preview).toBeNull();
    viewer.close();
  });
});

describe("排队超时收敛为终态（issue #667）", () => {
  async function backdateAndSweep(slug: string, deliveryId: string | null) {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const backdated = Date.now() - (DIRECTED_DELIVERY_QUEUED_TIMEOUT_MS + 1000);
      if (deliveryId === null) {
        state.storage.sql.exec("UPDATE directed_deliveries SET created_at = ?", backdated);
      } else {
        state.storage.sql.exec("UPDATE directed_deliveries SET created_at = ? WHERE id = ?", backdated, deliveryId);
      }
      await instance.onAlarm();
    });
  }

  async function terminalReason(slug: string, deliveryId: string): Promise<string | null> {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    return runInDurableObject(stub, async (_i: ChannelDO, state) => {
      const row = state.storage.sql
        .exec("SELECT terminal_reason AS r FROM directed_deliveries WHERE id = ?", deliveryId)
        .toArray()[0];
      return row?.r === null || row?.r === undefined ? null : String(row.r);
    });
  }

  async function currentAlarm(slug: string): Promise<number | null> {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    return runInDurableObject(stub, async (_i: ChannelDO, state) => state.storage.getAlarm());
  }

  it("paused 目标的超时排队投递不会把 alarm 钉在 now+1000 空转", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("paused-target"));
    const slug = await createChannel(sender.token);
    const paused = await api(`/api/channels/${slug}/presence/${encodeURIComponent(target.name)}/pause`, sender.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(paused.status).toBe(200);
    const posted = await sendMention(slug, sender.token, target.name, `@${target.name} held while paused`);
    const queued = (await deliveryRows(slug))[0]!;
    expect(queued).toMatchObject({ message_seq: posted.seq, state: "queued" });

    // 把 queued 回填到超时线之外后跑 alarm：paused 目标永不被 failStale 收敛，若排队超时闸仍把它算进候选，
    // 候选落在过去 → 被 max(min, now+1000) 钉到 now+1000，导致每秒空转。
    await backdateAndSweep(slug, queued.id);

    // 仍 queued（owner 持债，不被误判），且 alarm 不再是每秒重挂：应落在长期 retention/lease 线（created_at + 30d）附近。
    expect((await deliveryRows(slug))[0]).toMatchObject({ id: queued.id, state: "queued" });
    const alarm = await currentAlarm(slug);
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeGreaterThan(60_000);
  });

  it("对无唤醒通道的死目标，排队超时后转 failed(undelivered) 并广播 delivery_state", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("dead-target"));
    const slug = await createChannel(sender.token);
    // 目标从不连接、无 webhook —— 正是 watcher 被回收的死目标（#665）。
    const posted = await sendMention(slug, sender.token, target.name, `@${target.name} please reply`);
    const queued = (await deliveryRows(slug))[0]!;
    expect(queued).toMatchObject({ message_seq: posted.seq, target_name: target.name, state: "queued", attempt: 0 });

    // 观察者连接在扫描前就位，收广播；它不是 adapter，不会领走这条投递。
    const viewer = await WsClient.open(slug, sender.token);
    await viewer.nextOfType("welcome");

    await backdateAndSweep(slug, queued.id);

    const failedFrame = await nextDeliveryState(viewer, queued.id, "failed");
    expect(failedFrame.delivery.undelivered).toBe(true);
    expect((await deliveryRows(slug))[0]).toMatchObject({ id: queued.id, state: "failed" });
    expect(await terminalReason(slug, queued.id)).toBe("undelivered_timeout");
    viewer.close();
  });

  it("暂停接待（#180）持债的排队投递不被超时闸误判为未送达", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("paused-target"));
    const slug = await createChannel(sender.token);
    const paused = await api(`/api/channels/${slug}/presence/${encodeURIComponent(target.name)}/pause`, sender.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(paused.status).toBe(200);
    const posted = await sendMention(slug, sender.token, target.name, `@${target.name} held while paused`);
    const queued = (await deliveryRows(slug))[0]!;
    expect(queued).toMatchObject({ message_seq: posted.seq, state: "queued" });

    await backdateAndSweep(slug, queued.id);

    expect((await deliveryRows(slug))[0]).toMatchObject({ id: queued.id, state: "queued" });
    expect(await terminalReason(slug, queued.id)).toBeNull();
  });

  it("已回复的投递不受排队超时扫描影响（无回归）", async () => {
    const sender = await seedToken("agent", uniq("sender"));
    const target = await seedToken("agent", uniq("live-target"));
    const slug = await createChannel(sender.token);
    const holder = await WsClient.open(slug, target.token);
    await holder.nextOfType("welcome");
    expect((await claim(holder)).held).toBe(true);
    const posted = await sendMention(slug, sender.token, target.name, `@${target.name} please reply`);
    const work = (await holder.nextOfType("delivery")) as DirectedDeliveryFrame;
    holder.send({
      type: "delivery_update",
      delivery_id: work.delivery.id,
      state: "running",
      work_id: work.delivery.work_id!,
      continuation_ref: work.delivery.continuation_ref!,
    });
    await nextDeliveryState(holder, work.delivery.id, "running");
    const reply = await api(`/api/channels/${slug}/messages`, target.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "done", mentions: [], reply_to: posted.seq }),
    });
    expect(reply.status).toBe(200);
    await nextDeliveryState(holder, work.delivery.id, "replied");

    // 终态 replied 不属 queued，扫描绝不触碰它。
    await backdateAndSweep(slug, null);

    expect((await deliveryRows(slug))[0]).toMatchObject({ id: work.delivery.id, state: "replied" });
    expect(await terminalReason(slug, work.delivery.id)).toBeNull();
    holder.close();
  });
});
