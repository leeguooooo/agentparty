import type { DirectedDeliveryFrame } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { fetchMock } from "./fetch-mock";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

interface DeliveryRow {
  id: string;
  message_seq: number;
  target_name: string;
  target_owner: string | null;
  state: string;
  attempt: number;
  lease_connection_id: string | null;
  lease_adapter: string | null;
  work_id: string | null;
  continuation_ref: string | null;
  reply_seq: number | null;
  last_error: string | null;
}

interface CapturedRequest {
  headers: Record<string, string>;
  body: string;
}

function normalizeRequest(opts: {
  headers?: unknown;
  body?: unknown;
}): CapturedRequest {
  const headers: Record<string, string> = {};
  if (Array.isArray(opts.headers)) {
    for (let i = 0; i + 1 < opts.headers.length; i += 2) {
      headers[String(opts.headers[i]).toLowerCase()] = String(
        opts.headers[i + 1],
      );
    }
  } else if (opts.headers && typeof opts.headers === "object") {
    for (const [key, value] of Object.entries(
      opts.headers as Record<string, unknown>,
    )) {
      headers[key.toLowerCase()] = String(value);
    }
  }
  let body = "";
  if (typeof opts.body === "string") body = opts.body;
  else if (opts.body instanceof ArrayBuffer)
    body = new TextDecoder().decode(opts.body);
  else if (ArrayBuffer.isView(opts.body))
    body = new TextDecoder().decode(opts.body as Uint8Array);
  else if (opts.body != null) body = String(opts.body);
  return { headers, body };
}

async function deliveryRows(slug: string): Promise<DeliveryRow[]> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec(
        `SELECT id, message_seq, target_name, target_owner, state, attempt,
                lease_connection_id, lease_adapter, work_id, continuation_ref,
                reply_seq, last_error
           FROM directed_deliveries
          ORDER BY message_seq, target_name`,
      )
      .toArray()
      .map((row) => ({
        id: String(row.id),
        message_seq: Number(row.message_seq),
        target_name: String(row.target_name),
        target_owner:
          row.target_owner === null ? null : String(row.target_owner),
        state: String(row.state),
        attempt: Number(row.attempt),
        lease_connection_id:
          row.lease_connection_id === null
            ? null
            : String(row.lease_connection_id),
        lease_adapter:
          row.lease_adapter === null ? null : String(row.lease_adapter),
        work_id: row.work_id === null ? null : String(row.work_id),
        continuation_ref:
          row.continuation_ref === null ? null : String(row.continuation_ref),
        reply_seq: row.reply_seq === null ? null : Number(row.reply_seq),
        last_error: row.last_error === null ? null : String(row.last_error),
      })),
  );
}

async function sendMention(
  slug: string,
  token: string,
  target: string,
  body: string,
) {
  const response = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: `@${target} ${body}`,
      mentions: [target],
      reply_to: null,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { seq: number };
}

async function replyTo(slug: string, token: string, seq: number, body: string) {
  const response = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body,
      mentions: [],
      reply_to: seq,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { seq: number };
}

async function registerWatch(ws: WsClient) {
  ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
  ws.send({ type: "delivery_adapter", adapter: "watch", op: "register" });
  expect(await ws.nextOfType("delivery_adapter")).toMatchObject({
    adapter: "watch",
    registered: true,
  });
}

async function claimServe(ws: WsClient) {
  ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
  ws.send({ type: "serve_lease", op: "claim" });
  expect(await ws.nextOfType("serve_lease")).toMatchObject({ held: true });
}

async function expectNoFullDelivery(ws: WsClient, timeoutMs = 200) {
  await expect(ws.nextOfType("delivery", timeoutMs)).rejects.toThrow(
    "timeout waiting for frame",
  );
}

async function registerWebhook(
  slug: string,
  token: string,
  input: { name: string; url: string; mode?: "notify" | "agent" },
) {
  const response = await api(`/api/channels/${slug}/webhooks`, token, {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      url: input.url,
      secret: "adapter-test-secret",
      filter: "mentions",
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    }),
  });
  expect(response.status).toBe(201);
}

describe("unified durable directed-delivery adapters", () => {
  it("watch 在 running ACK 前断连会立即把同一 work 重派给 standby", async () => {
    const owner = `${uniq("watch-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("watch-target"), {
      owner,
      channelScope: slug,
    });

    const watch = await WsClient.open(slug, target.token);
    await watch.nextOfType("welcome");
    await registerWatch(watch);
    const standby = await WsClient.open(slug, target.token);
    await standby.nextOfType("welcome");
    await registerWatch(standby);

    const posted = await sendMention(
      slug,
      sender.token,
      target.name,
      "watch work",
    );
    let raw: Awaited<ReturnType<WsClient["nextOfType"]>> | undefined;
    let full: DirectedDeliveryFrame | undefined;
    while (raw === undefined || full === undefined) {
      const frame = await watch.next();
      if (frame.type === "msg" && frame.seq === posted.seq) raw = frame;
      if (
        frame.type === "delivery" &&
        frame.delivery.message_seq === posted.seq
      )
        full = frame;
    }
    expect(raw).toMatchObject({
      seq: posted.seq,
      body: `@${target.name} watch work`,
    });
    watch.send({ type: "seen", seq: posted.seq });
    expect(full).toMatchObject({
      delivery: {
        message_seq: posted.seq,
        target_name: target.name,
        state: "claimed",
        attempt: 1,
      },
      message: { seq: posted.seq, body: `@${target.name} watch work` },
    });
    expect(await deliveryRows(slug)).toMatchObject([
      {
        id: full.delivery.id,
        state: "claimed",
        attempt: 1,
        lease_adapter: "watch",
        work_id: full.delivery.work_id,
        continuation_ref: full.delivery.continuation_ref,
        reply_seq: null,
      },
    ]);

    watch.close();
    const reassigned = (await standby.nextOfType("delivery")) as DirectedDeliveryFrame;
    expect(reassigned).toMatchObject({
      delivery: {
        id: full.delivery.id,
        message_seq: posted.seq,
        target_name: target.name,
        state: "claimed",
        attempt: 2,
        work_id: full.delivery.work_id,
        continuation_ref: full.delivery.continuation_ref,
      },
      message: { seq: posted.seq, body: `@${target.name} watch work` },
    });
    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: full.delivery.id,
      state: "claimed",
      attempt: 2,
      lease_adapter: "watch",
    });

    const reply = await replyTo(
      slug,
      target.token,
      posted.seq,
      "watch completed",
    );
    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: full.delivery.id,
      state: "replied",
      attempt: 2,
      lease_adapter: null,
      lease_connection_id: null,
      reply_seq: reply.seq,
    });

    const serve = await WsClient.open(slug, target.token);
    await serve.nextOfType("welcome");
    await claimServe(serve).catch((error: unknown) => {
      throw new Error(
        `serve did not receive lease after watch completion: ${String(error)}`,
      );
    });
    await expectNoFullDelivery(serve);
    expect((await deliveryRows(slug))[0]).toMatchObject({
      state: "replied",
      attempt: 2,
    });
    standby.close();
    serve.close();
  });

  it("serve 与 watch 同时在线时由 serve 优先领取，watch 不收到 full delivery", async () => {
    const owner = `${uniq("priority-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("priority-target"), {
      owner,
      channelScope: slug,
    });

    const watch = await WsClient.open(slug, target.token);
    await watch.nextOfType("welcome");
    await registerWatch(watch);
    const serve = await WsClient.open(slug, target.token);
    await serve.nextOfType("welcome");
    await claimServe(serve);

    const posted = await sendMention(
      slug,
      sender.token,
      target.name,
      "prefer serve",
    );
    const claimed = (await serve.nextOfType(
      "delivery",
    )) as DirectedDeliveryFrame;
    expect(claimed.delivery).toMatchObject({
      message_seq: posted.seq,
      target_name: target.name,
      state: "claimed",
      attempt: 1,
    });
    await expectNoFullDelivery(watch);
    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: claimed.delivery.id,
      state: "claimed",
      attempt: 1,
      lease_adapter: "serve",
    });

    watch.close();
    serve.close();
  });

  it("watch 只有客户端 running ACK 才 accepted，accepted 超时 fail unknown 且不重派", async () => {
    const owner = `${uniq("watch-ack-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("watch-ack-target"), {
      owner,
      channelScope: slug,
    });
    const watch = await WsClient.open(slug, target.token);
    await watch.nextOfType("welcome");
    await registerWatch(watch);
    await sendMention(slug, sender.token, target.name, "watch accepted work");
    const full = (await watch.nextOfType("delivery")) as DirectedDeliveryFrame;
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "claimed", lease_adapter: "watch" });

    watch.send({
      type: "delivery_update",
      delivery_id: full.delivery.id,
      state: "running",
      work_id: full.delivery.work_id ?? undefined,
      continuation_ref: full.delivery.continuation_ref ?? undefined,
    });
    for (;;) {
      const state = await watch.nextOfType("delivery_state");
      if (state.delivery.id === full.delivery.id && state.delivery.state === "running") break;
    }
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "running", attempt: 1 });

    const observer = await WsClient.open(slug, sender.token);
    await observer.nextOfType("welcome");
    observer.send({ type: "hello", since: 0 });
    watch.close();
    for (;;) {
      const presence = await observer.nextOfType("presence");
      if (presence.name === target.name && presence.state === "offline") break;
    }
    // A running ACK proves that the caller accepted the work. Disconnect is an unknown outcome,
    // so eager reassignment would duplicate model or external side effects.
    expect((await deliveryRows(slug))[0]).toMatchObject({
      state: "running",
      attempt: 1,
      lease_adapter: "watch",
    });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE directed_deliveries SET lease_until = ? WHERE id = ?",
        Date.now() - 1,
        full.delivery.id,
      );
      await instance.onAlarm();
    });
    expect((await deliveryRows(slug))[0]).toMatchObject({
      state: "failed",
      attempt: 1,
      lease_adapter: null,
      last_error: "runner ownership lost after task start; outcome unknown, not auto-retried",
    });
    observer.close();
  });

  it("agent webhook 2xx 持久 accepted/running：payload/请求 ID 稳定，target reply 后 serve 不会重跑", async () => {
    const owner = `${uniq("webhook-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("webhook-target"), {
      owner,
      channelScope: slug,
    });
    const url = "https://agent-adapter.test/directed";
    await registerWebhook(slug, target.token, {
      name: target.name,
      url,
      mode: "agent",
    });

    let captured: CapturedRequest | null = null;
    fetchMock
      .get("https://agent-adapter.test")
      .intercept({ path: "/directed", method: "POST" })
      .reply(200, (opts) => {
        captured = normalizeRequest(
          opts as { headers?: unknown; body?: unknown },
        );
        return "ok";
      });

    const posted = await sendMention(
      slug,
      sender.token,
      target.name,
      "webhook work",
    );
    expect(captured).not.toBeNull();
    const request = captured as unknown as CapturedRequest;
    const payload = JSON.parse(request.body) as {
      seq: number;
      directed_delivery: {
        id: string;
        message_seq: number;
        target_name: string;
        state: string;
        attempt: number;
        work_id: string;
        continuation_ref: string;
      };
    };
    expect(payload).toMatchObject({
      seq: posted.seq,
      directed_delivery: {
        message_seq: posted.seq,
        target_name: target.name,
        state: "claimed",
        attempt: 1,
      },
    });
    expect(payload.directed_delivery.id).not.toBe(
      payload.directed_delivery.work_id,
    );
    expect(payload.directed_delivery.work_id).toBeTruthy();
    expect(payload.directed_delivery.continuation_ref).toBeTruthy();
    expect(request.headers["x-request-id"]).toBe(
      `agentparty-delivery-${payload.directed_delivery.id}`,
    );
    expect(await deliveryRows(slug)).toMatchObject([
      {
        id: payload.directed_delivery.id,
        state: "running",
        attempt: 1,
        lease_adapter: "webhook",
        work_id: payload.directed_delivery.work_id,
        continuation_ref: payload.directed_delivery.continuation_ref,
        reply_seq: null,
      },
    ]);

    const reply = await replyTo(
      slug,
      target.token,
      posted.seq,
      "webhook completed",
    );
    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: payload.directed_delivery.id,
      state: "replied",
      attempt: 1,
      lease_adapter: null,
      lease_connection_id: null,
      reply_seq: reply.seq,
    });

    const serve = await WsClient.open(slug, target.token);
    await serve.nextOfType("welcome");
    await claimServe(serve);
    await expectNoFullDelivery(serve);
    expect((await deliveryRows(slug))[0]).toMatchObject({
      state: "replied",
      attempt: 1,
    });
    serve.close();
  });

  it("agent webhook 2xx accepted/running 超过租约后 fail unknown，不自动转给 serve", async () => {
    const owner = `${uniq("webhook-expiry-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("webhook-expiry-target"), {
      owner,
      channelScope: slug,
    });
    await registerWebhook(slug, target.token, {
      name: target.name,
      url: "https://agent-expiry.test/directed",
      mode: "agent",
    });
    fetchMock
      .get("https://agent-expiry.test")
      .intercept({ path: "/directed", method: "POST" })
      .reply(200, "accepted");
    await sendMention(slug, sender.token, target.name, "long webhook work");
    const accepted = (await deliveryRows(slug))[0]!;
    expect(accepted).toMatchObject({ state: "running", lease_adapter: "webhook", attempt: 1 });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE directed_deliveries SET lease_until = ? WHERE id = ?",
        Date.now() - 1,
        accepted.id,
      );
      await instance.onAlarm();
    });
    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: accepted.id,
      state: "failed",
      attempt: 1,
      lease_connection_id: null,
      lease_adapter: null,
      last_error: "runner ownership lost after task start; outcome unknown, not auto-retried",
    });

    const serve = await WsClient.open(slug, target.token);
    await serve.nextOfType("welcome");
    await claimServe(serve);
    await expectNoFullDelivery(serve);
    serve.close();
  });

  it("同名 webhook 被新 owner 重注册后，旧 agent payload 自动重试和死信重投都拒绝新 URL", async () => {
    const oldOwner = `${uniq("old-webhook-owner")}@example.com`;
    const newOwner = `${uniq("new-webhook-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner: oldOwner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("rotated-agent-hook"), {
      owner: oldOwner,
      channelScope: slug,
    });
    await registerWebhook(slug, target.token, {
      name: target.name,
      url: "https://old-agent-hook.test/run",
      mode: "agent",
    });
    fetchMock
      .get("https://old-agent-hook.test")
      .intercept({ path: "/run", method: "POST" })
      .reply(503, "down");
    await sendMention(slug, sender.token, target.name, "private old work");
    const old = (await deliveryRows(slug))[0]!;
    expect(old).toMatchObject({ state: "claimed", target_owner: oldOwner });

    await env.DB.prepare("UPDATE tokens SET owner = ? WHERE name = ?")
      .bind(newOwner, target.name)
      .run();
    await registerWebhook(slug, target.token, {
      name: target.name,
      url: "https://new-agent-hook.test/run",
      mode: "agent",
    });
    let newUrlCalls = 0;
    fetchMock
      .get("https://new-agent-hook.test")
      .intercept({ path: "/run", method: "POST" })
      .reply(200, () => {
        newUrlCalls++;
        return "ok";
      });
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE webhook_queue SET next_retry_at = ?", Date.now() - 1);
      await instance.onAlarm();
      const dead = state.storage.sql
        .exec("SELECT registration_id, webhook_mode, target_owner, last_error FROM webhook_dead_letters")
        .one();
      expect(dead.webhook_mode).toBe("agent");
      expect(dead.target_owner).toBe(oldOwner);
      expect(String(dead.registration_id)).toBeTruthy();
      expect(dead.last_error).toBe("webhook registration changed; refusing cross-registration retry");
    });
    expect(newUrlCalls).toBe(0);
    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: old.id,
      state: "failed",
      target_owner: oldOwner,
      last_error: "webhook registration changed; refusing cross-registration retry",
    });

    const redeliver = await api(
      `/api/channels/${slug}/webhooks/${encodeURIComponent(target.name)}/redeliver`,
      sender.token,
      { method: "POST" },
    );
    expect(redeliver.status).toBe(200);
    expect(await redeliver.json()).toMatchObject({ redelivered: 0, failed: 1, remaining: 1 });
    expect(newUrlCalls).toBe(0);
    // Consume the interceptor only after both security assertions so the global mock has no pending entry.
    await fetch("https://new-agent-hook.test/run", { method: "POST" });
    expect(newUrlCalls).toBe(1);
  });

  it("notify webhook 只通知，不 claim 同名 agent 的 durable work", async () => {
    const owner = `${uniq("notify-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("notify-target"), {
      owner,
      channelScope: slug,
    });
    const url = "https://notify-adapter.test/wake";
    await registerWebhook(slug, sender.token, {
      name: target.name,
      url,
      mode: "notify",
    });

    let captured: CapturedRequest | null = null;
    fetchMock
      .get("https://notify-adapter.test")
      .intercept({ path: "/wake", method: "POST" })
      .reply(200, (opts) => {
        captured = normalizeRequest(
          opts as { headers?: unknown; body?: unknown },
        );
        return "ok";
      });

    const posted = await sendMention(
      slug,
      sender.token,
      target.name,
      "notify only",
    );
    expect(captured).not.toBeNull();
    const payload = JSON.parse(
      (captured as unknown as CapturedRequest).body,
    ) as {
      seq: number;
      mentions: string[];
      directed_delivery: Record<string, unknown>;
    };
    expect(payload).toMatchObject({ seq: posted.seq, mentions: [target.name] });
    // notify 可携带公开 correlation state，但绝不能拿到 holder-only work identity 或领取租约。
    expect(payload.directed_delivery).toMatchObject({
      message_seq: posted.seq,
      target_name: target.name,
      state: "queued",
    });
    expect(payload.directed_delivery).not.toHaveProperty("work_id");
    expect(payload.directed_delivery).not.toHaveProperty("continuation_ref");
    expect(payload.directed_delivery).not.toHaveProperty("attempt");
    expect(await deliveryRows(slug)).toMatchObject([
      {
        message_seq: posted.seq,
        target_name: target.name,
        target_owner: owner,
        state: "queued",
        attempt: 0,
        lease_connection_id: null,
        lease_adapter: null,
      },
    ]);
  });

  it("同名不同 owner 的 agent webhook 不能领取旧 principal 的 work", async () => {
    const oldOwner = `${uniq("old-owner")}@example.com`;
    const newOwner = `${uniq("new-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), {
      owner: oldOwner,
    });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("reused-webhook"), {
      owner: oldOwner,
      channelScope: slug,
    });

    const posted = await sendMention(
      slug,
      sender.token,
      target.name,
      "old principal work",
    );
    const oldWork = (await deliveryRows(slug))[0]!;
    expect(oldWork).toMatchObject({
      message_seq: posted.seq,
      target_owner: oldOwner,
      state: "queued",
      attempt: 0,
    });

    await env.DB.prepare("UPDATE tokens SET owner = ? WHERE name = ?")
      .bind(newOwner, target.name)
      .run();
    await registerWebhook(slug, target.token, {
      name: target.name,
      url: "https://wrong-principal.test/directed",
      mode: "agent",
    });

    expect(await deliveryRows(slug)).toMatchObject([
      {
        id: oldWork.id,
        target_owner: oldOwner,
        state: "failed",
        attempt: 0,
        lease_connection_id: null,
        lease_adapter: null,
        last_error:
          "target principal changed before delivery; refusing same-name reassignment",
      },
    ]);
  });
});
