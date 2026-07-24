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
  lease_epoch: number;
  lease_token: string | null;
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

async function waitFor<T>(probe: () => T | null, timeoutMs = 2_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
                lease_epoch, lease_token,
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
        lease_epoch: Number(row.lease_epoch),
        lease_token: row.lease_token === null ? null : String(row.lease_token),
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
  ws.send({
    type: "hello",
    since: 0,
    directed_delivery: "v1",
    delivery_recovery: "v1",
  });
  ws.send({ type: "delivery_adapter", adapter: "watch", op: "register" });
  expect(await ws.nextOfType("delivery_adapter")).toMatchObject({
    adapter: "watch",
    registered: true,
  });
}

async function claimServe(ws: WsClient) {
  ws.send({
    type: "hello",
    since: 0,
    directed_delivery: "v1",
    delivery_recovery: "v1",
  });
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
  it("watch 在 running ACK 丢失并断连后以 durable token CAS 恢复且不会重复派发", async () => {
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
        lease_epoch: 1,
        lease_token: expect.any(String),
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
    const leaseEpoch = full.delivery.lease_epoch;
    const leaseToken = full.delivery.lease_token;
    expect(leaseEpoch).toEqual(expect.any(Number));
    expect(leaseToken).toEqual(expect.any(String));
    if (leaseEpoch === undefined || leaseToken === undefined) {
      throw new Error("holder delivery omitted recovery ownership");
    }

    // Simulate the precise failure window: Worker commits running, while the
    // direct ACK and the socket disappear before the harness is notified.
    watch.send({
      type: "delivery_update",
      delivery_id: full.delivery.id,
      request_id: "lost-running-ack",
      state: "running",
      attempt: full.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: leaseToken,
      work_id: full.delivery.work_id ?? undefined,
      continuation_ref: full.delivery.continuation_ref ?? undefined,
    });
    watch.close();
    await expect.poll(async () => (await deliveryRows(slug))[0]?.state).toBe("running");
    await expectNoFullDelivery(standby);
    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: full.delivery.id,
      state: "running",
      attempt: 1,
      lease_adapter: "watch",
    });

    const nextLeaseToken = crypto.randomUUID();
    standby.send({
      type: "delivery_recover",
      delivery_id: full.delivery.id,
      request_id: "recover-after-running-ack-loss",
      attempt: full.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: leaseToken,
      next_lease_token: nextLeaseToken,
    });
    expect(await standby.nextOfType("delivery_recovery")).toMatchObject({
      delivery_id: full.delivery.id,
      request_id: "recover-after-running-ack-loss",
      result: "recovered",
      state: "running",
      attempt: 1,
      lease_epoch: leaseEpoch,
      lease_token: nextLeaseToken,
    });
    standby.send({
      type: "delivery_update",
      delivery_id: full.delivery.id,
      request_id: "running-after-recover",
      state: "running",
      attempt: full.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: nextLeaseToken,
      work_id: full.delivery.work_id ?? undefined,
      continuation_ref: full.delivery.continuation_ref ?? undefined,
    });
    for (;;) {
      const state = await standby.nextOfType("delivery_state");
      if (state.request_id === "running-after-recover") {
        expect(state.delivery).toMatchObject({ id: full.delivery.id, state: "running" });
        break;
      }
    }

    const reply = await replyTo(
      slug,
      target.token,
      posted.seq,
      "watch completed",
    );
    expect((await deliveryRows(slug))[0]).toMatchObject({
      id: full.delivery.id,
      state: "replied",
      attempt: 1,
      lease_adapter: null,
      lease_connection_id: null,
      reply_seq: reply.seq,
    });

    // A replacement process may also lose the terminal ACK. The token can
    // reconcile that already-terminal receipt, but it must never recover and
    // reactivate the lease.
    const terminalReconciler = await WsClient.open(slug, target.token);
    await terminalReconciler.nextOfType("welcome");
    await registerWatch(terminalReconciler);
    terminalReconciler.send({
      type: "delivery_update",
      delivery_id: full.delivery.id,
      request_id: "terminal-ack-reconcile",
      state: "replied",
      attempt: full.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: nextLeaseToken,
      work_id: full.delivery.work_id ?? undefined,
      continuation_ref: full.delivery.continuation_ref ?? undefined,
      reply_seq: reply.seq,
    });
    for (;;) {
      const state = await terminalReconciler.nextOfType("delivery_state");
      if (state.request_id === "terminal-ack-reconcile") {
        expect(state.delivery).toMatchObject({ id: full.delivery.id, state: "replied" });
        break;
      }
    }
    terminalReconciler.send({
      type: "delivery_recover",
      delivery_id: full.delivery.id,
      request_id: "terminal-must-not-recover",
      attempt: full.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: nextLeaseToken,
      next_lease_token: crypto.randomUUID(),
    });
    expect(await terminalReconciler.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "terminal-must-not-recover",
      result: "terminal",
      state: "replied",
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
      attempt: 1,
    });
    standby.close();
    terminalReconciler.close();
    serve.close();
  });

  it("delivery recovery fences the old socket and rejects wrong principal, token, epoch, and expired lease", async () => {
    const owner = `${uniq("recover-fence-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("recover-fence-target"), {
      owner,
      channelScope: slug,
    });
    const other = await seedToken("agent", uniq("recover-fence-other"), {
      owner,
      channelScope: slug,
    });
    const first = await WsClient.open(slug, target.token);
    await first.nextOfType("welcome");
    await registerWatch(first);
    const posted = await sendMention(slug, sender.token, target.name, "fence old holder");
    const frame = (await first.nextOfType("delivery")) as DirectedDeliveryFrame;
    const leaseEpoch = frame.delivery.lease_epoch;
    const leaseToken = frame.delivery.lease_token;
    if (leaseEpoch === undefined || leaseToken === undefined) {
      throw new Error("holder delivery omitted recovery ownership");
    }

    const impostor = await WsClient.open(slug, other.token);
    await impostor.nextOfType("welcome");
    await registerWatch(impostor);
    impostor.send({
      type: "delivery_recover",
      delivery_id: frame.delivery.id,
      request_id: "wrong-principal",
      attempt: frame.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: leaseToken,
      next_lease_token: crypto.randomUUID(),
    });
    expect(await impostor.nextOfType("error")).toMatchObject({ code: "bad_request" });

    const replacement = await WsClient.open(slug, target.token);
    await replacement.nextOfType("welcome");
    await registerWatch(replacement);
    replacement.send({
      type: "delivery_recover",
      delivery_id: frame.delivery.id,
      request_id: "wrong-token",
      attempt: frame.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: crypto.randomUUID(),
      next_lease_token: crypto.randomUUID(),
    });
    expect(await replacement.nextOfType("error")).toMatchObject({ code: "bad_request" });
    replacement.send({
      type: "delivery_recover",
      delivery_id: frame.delivery.id,
      request_id: "wrong-epoch",
      attempt: frame.delivery.attempt,
      lease_epoch: leaseEpoch + 1,
      lease_token: leaseToken,
      next_lease_token: crypto.randomUUID(),
    });
    expect(await replacement.nextOfType("error")).toMatchObject({ code: "bad_request" });
    replacement.send({
      type: "delivery_recover",
      delivery_id: frame.delivery.id,
      request_id: "non-literal-replay-safe",
      attempt: frame.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: leaseToken,
      next_lease_token: crypto.randomUUID(),
      replay_safe: "true",
    } as never);
    expect(await replacement.nextOfType("error")).toMatchObject({ code: "bad_request" });

    const rotated = crypto.randomUUID();
    const firstClosed = new Promise<void>((resolve) => {
      first.ws.addEventListener("close", () => resolve(), { once: true });
    });
    replacement.send({
      type: "delivery_recover",
      delivery_id: frame.delivery.id,
      request_id: "valid-recovery",
      attempt: frame.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: leaseToken,
      next_lease_token: rotated,
    });
    expect(await replacement.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "valid-recovery",
      result: "recovered",
      lease_token: rotated,
      state: "claimed",
    });
    await firstClosed;

    // C1 still knows the old secret, but recovery actively evicts the half-open
    // socket instead of leaving it eligible to win a later watch assignment.
    expect((await deliveryRows(slug))[0]).toMatchObject({
      message_seq: posted.seq,
      state: "claimed",
      lease_token: rotated,
    });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE directed_deliveries SET lease_until = ? WHERE id = ?",
        Date.now() - 1,
        frame.delivery.id,
      );
    });
    const afterExpiry = await WsClient.open(slug, target.token);
    await afterExpiry.nextOfType("welcome");
    await registerWatch(afterExpiry);
    afterExpiry.send({
      type: "delivery_recover",
      delivery_id: frame.delivery.id,
      request_id: "expired-recovery",
      attempt: frame.delivery.attempt,
      lease_epoch: leaseEpoch,
      lease_token: rotated,
      next_lease_token: crypto.randomUUID(),
    });
    expect(await afterExpiry.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "expired-recovery",
      result: "superseded_safe",
    });

    first.close();
    replacement.close();
    impostor.close();
    afterExpiry.close();
  });

  it("watch recovery evicts the old holder and keeps the recovered socket ahead of an older standby", async () => {
    const owner = `${uniq("watch-recovery-priority-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("watch-recovery-priority-target"), {
      owner,
      channelScope: slug,
    });
    const original = await WsClient.open(slug, target.token);
    await original.nextOfType("welcome");
    await registerWatch(original);
    const olderStandby = await WsClient.open(slug, target.token);
    await olderStandby.nextOfType("welcome");
    await registerWatch(olderStandby);
    const recovering = await WsClient.open(slug, target.token);
    await recovering.nextOfType("welcome");
    await registerWatch(recovering);

    const firstMessage = await sendMention(
      slug,
      sender.token,
      target.name,
      "recover then keep watch ownership",
    );
    const first = (await original.nextOfType("delivery")) as DirectedDeliveryFrame;
    if (first.delivery.lease_epoch === undefined || first.delivery.lease_token === undefined) {
      throw new Error("holder delivery omitted recovery ownership");
    }
    const originalClosed = new Promise<void>((resolve) => {
      original.ws.addEventListener("close", () => resolve(), { once: true });
    });
    const rotated = crypto.randomUUID();
    recovering.send({
      type: "delivery_recover",
      delivery_id: first.delivery.id,
      request_id: "watch-priority-recovery",
      attempt: first.delivery.attempt,
      lease_epoch: first.delivery.lease_epoch,
      lease_token: first.delivery.lease_token,
      next_lease_token: rotated,
    });
    expect(await recovering.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "watch-priority-recovery",
      result: "recovered",
      lease_token: rotated,
    });
    await originalClosed;
    recovering.send({
      type: "delivery_update",
      delivery_id: first.delivery.id,
      request_id: "watch-priority-running",
      state: "running",
      attempt: first.delivery.attempt,
      lease_epoch: first.delivery.lease_epoch,
      lease_token: rotated,
      work_id: first.delivery.work_id ?? undefined,
      continuation_ref: first.delivery.continuation_ref ?? undefined,
    });
    for (;;) {
      const state = await recovering.nextOfType("delivery_state");
      if (state.request_id === "watch-priority-running") break;
    }
    await replyTo(slug, target.token, firstMessage.seq, "first recovered task complete");

    const secondMessage = await sendMention(
      slug,
      sender.token,
      target.name,
      "second task stays on recovered socket",
    );
    const second = (await recovering.nextOfType("delivery")) as DirectedDeliveryFrame;
    expect(second.delivery).toMatchObject({
      message_seq: secondMessage.seq,
      target_name: target.name,
      state: "claimed",
    });
    await expectNoFullDelivery(olderStandby);

    olderStandby.close();
    recovering.close();
  });

  it("recovery resolves an old journal safely after more than one claimed supersession", async () => {
    const owner = `${uniq("recover-history-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("recover-history-target"), {
      owner,
      channelScope: slug,
    });
    const holders: WsClient[] = [];
    for (let index = 0; index < 3; index += 1) {
      const holder = await WsClient.open(slug, target.token);
      holders.push(holder);
      await holder.nextOfType("welcome");
      await registerWatch(holder);
    }
    await sendMention(slug, sender.token, target.name, "rotate claim twice");
    const first = (await holders[0]!.nextOfType("delivery")) as DirectedDeliveryFrame;
    if (first.delivery.lease_epoch === undefined || first.delivery.lease_token === undefined) {
      throw new Error("holder delivery omitted recovery ownership");
    }
    holders[0]!.close();

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const expireAndAlarm = async () => {
      await runInDurableObject(stub, async (instance: ChannelDO, state) => {
        state.storage.sql.exec(
          "UPDATE directed_deliveries SET lease_until = ? WHERE id = ?",
          Date.now() - 1,
          first.delivery.id,
        );
        await instance.onAlarm();
      });
    };
    await expireAndAlarm();
    const second = (await holders[1]!.nextOfType("delivery")) as DirectedDeliveryFrame;
    expect(second.delivery).toMatchObject({ id: first.delivery.id, attempt: 2, lease_epoch: 2 });
    holders[1]!.close();
    await expireAndAlarm();
    const third = (await holders[2]!.nextOfType("delivery")) as DirectedDeliveryFrame;
    expect(third.delivery).toMatchObject({ id: first.delivery.id, attempt: 3, lease_epoch: 3 });

    const restartedOldProcess = await WsClient.open(slug, target.token);
    await restartedOldProcess.nextOfType("welcome");
    await registerWatch(restartedOldProcess);
    restartedOldProcess.send({
      type: "delivery_recover",
      delivery_id: first.delivery.id,
      request_id: "oldest-attempt-recovery",
      attempt: first.delivery.attempt,
      lease_epoch: first.delivery.lease_epoch,
      lease_token: first.delivery.lease_token,
      next_lease_token: crypto.randomUUID(),
    });
    expect(await restartedOldProcess.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "oldest-attempt-recovery",
      result: "superseded_safe",
      state: "claimed",
      attempt: 3,
      lease_epoch: 3,
    });

    holders[2]!.close();
    restartedOldProcess.close();
  });

  it("A→B→C token rotations retain every generation so delayed A converges as superseded", async () => {
    const owner = `${uniq("recover-token-chain-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("recover-token-chain-target"), {
      owner,
      channelScope: slug,
    });
    const a = await WsClient.open(slug, target.token);
    await a.nextOfType("welcome");
    await registerWatch(a);
    await sendMention(slug, sender.token, target.name, "rotate recovery token A B C");
    const delivery = (await a.nextOfType("delivery")) as DirectedDeliveryFrame;
    if (delivery.delivery.lease_epoch === undefined || delivery.delivery.lease_token === undefined) {
      throw new Error("holder delivery omitted recovery ownership");
    }
    const tokenA = delivery.delivery.lease_token;
    const tokenB = crypto.randomUUID();
    const b = await WsClient.open(slug, target.token);
    await b.nextOfType("welcome");
    await registerWatch(b);
    b.send({
      type: "delivery_recover",
      delivery_id: delivery.delivery.id,
      request_id: "rotate-a-b",
      attempt: delivery.delivery.attempt,
      lease_epoch: delivery.delivery.lease_epoch,
      lease_token: tokenA,
      next_lease_token: tokenB,
    });
    expect(await b.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "rotate-a-b",
      result: "recovered",
      lease_token: tokenB,
    });

    const tokenC = crypto.randomUUID();
    const c = await WsClient.open(slug, target.token);
    await c.nextOfType("welcome");
    await registerWatch(c);
    c.send({
      type: "delivery_recover",
      delivery_id: delivery.delivery.id,
      request_id: "rotate-b-c",
      attempt: delivery.delivery.attempt,
      lease_epoch: delivery.delivery.lease_epoch,
      lease_token: tokenB,
      next_lease_token: tokenC,
    });
    expect(await c.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "rotate-b-c",
      result: "recovered",
      lease_token: tokenC,
    });

    const delayedA = await WsClient.open(slug, target.token);
    await delayedA.nextOfType("welcome");
    await registerWatch(delayedA);
    delayedA.send({
      type: "delivery_recover",
      delivery_id: delivery.delivery.id,
      request_id: "delayed-a-after-c",
      attempt: delivery.delivery.attempt,
      lease_epoch: delivery.delivery.lease_epoch,
      lease_token: tokenA,
      next_lease_token: crypto.randomUUID(),
    });
    expect(await delayedA.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "delayed-a-after-c",
      result: "superseded_safe",
      state: "claimed",
      attempt: delivery.delivery.attempt,
      lease_epoch: delivery.delivery.lease_epoch,
    });
    expect((await deliveryRows(slug))[0]).toMatchObject({
      state: "claimed",
      lease_token: tokenC,
    });

    await replyTo(slug, target.token, delivery.delivery.message_seq, "token C completed");
    delayedA.send({
      type: "delivery_recover",
      delivery_id: delivery.delivery.id,
      request_id: "delayed-a-after-terminal",
      attempt: delivery.delivery.attempt,
      lease_epoch: delivery.delivery.lease_epoch,
      lease_token: tokenA,
      next_lease_token: crypto.randomUUID(),
    });
    expect(await delayedA.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "delayed-a-after-terminal",
      result: "terminal",
      state: "replied",
    });

    a.close();
    b.close();
    c.close();
    delayedA.close();
  });

  it("serve token recovery makes the recovering socket holder ahead of an older standby", async () => {
    const owner = `${uniq("serve-recovery-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("serve-recovery-target"), {
      owner,
      channelScope: slug,
    });
    const c1 = await WsClient.open(slug, target.token);
    await c1.nextOfType("welcome");
    await claimServe(c1);
    const c3OlderStandby = await WsClient.open(slug, target.token);
    await c3OlderStandby.nextOfType("welcome");
    c3OlderStandby.send({
      type: "hello",
      since: 0,
      directed_delivery: "v1",
      delivery_recovery: "v1",
    });
    c3OlderStandby.send({ type: "serve_lease", op: "claim" });
    expect(await c3OlderStandby.nextOfType("serve_lease")).toMatchObject({ held: false });
    const c2Recovering = await WsClient.open(slug, target.token);
    await c2Recovering.nextOfType("welcome");
    c2Recovering.send({
      type: "hello",
      since: 0,
      directed_delivery: "v1",
      delivery_recovery: "v1",
    });
    c2Recovering.send({ type: "serve_lease", op: "claim" });
    expect(await c2Recovering.nextOfType("serve_lease")).toMatchObject({ held: false });

    await sendMention(slug, sender.token, target.name, "recover to exact serve");
    const delivery = (await c1.nextOfType("delivery")) as DirectedDeliveryFrame;
    if (delivery.delivery.lease_epoch === undefined || delivery.delivery.lease_token === undefined) {
      throw new Error("holder delivery omitted recovery ownership");
    }
    const rotated = crypto.randomUUID();
    c2Recovering.send({
      type: "delivery_recover",
      delivery_id: delivery.delivery.id,
      request_id: "serve-c2-recovery",
      attempt: delivery.delivery.attempt,
      lease_epoch: delivery.delivery.lease_epoch,
      lease_token: delivery.delivery.lease_token,
      next_lease_token: rotated,
    });
    expect(await c2Recovering.nextOfType("serve_lease")).toMatchObject({ held: true });
    expect(await c2Recovering.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "serve-c2-recovery",
      result: "recovered",
      lease_token: rotated,
    });
    expect(await c3OlderStandby.nextOfType("serve_lease")).toMatchObject({ held: false });
    c2Recovering.send({
      type: "delivery_update",
      delivery_id: delivery.delivery.id,
      request_id: "serve-c2-running",
      state: "running",
      attempt: delivery.delivery.attempt,
      lease_epoch: delivery.delivery.lease_epoch,
      lease_token: rotated,
      work_id: delivery.delivery.work_id ?? undefined,
      continuation_ref: delivery.delivery.continuation_ref ?? undefined,
    });
    for (;;) {
      const state = await c2Recovering.nextOfType("delivery_state");
      if (state.request_id === "serve-c2-running") {
        expect(state.delivery).toMatchObject({ state: "running" });
        break;
      }
    }

    c1.close();
    c2Recovering.close();
    c3OlderStandby.close();
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
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE directed_deliveries SET lease_until = ? WHERE id = ?",
        Date.now() - 1,
        full.delivery.id,
      );
    });
    const recovery = await WsClient.open(slug, target.token);
    await recovery.nextOfType("welcome");
    await registerWatch(recovery);
    if (full.delivery.lease_epoch === undefined || full.delivery.lease_token === undefined) {
      throw new Error("holder delivery omitted recovery ownership");
    }
    recovery.send({
      type: "delivery_recover",
      delivery_id: full.delivery.id,
      request_id: "running-expired-outcome",
      attempt: full.delivery.attempt,
      lease_epoch: full.delivery.lease_epoch,
      lease_token: full.delivery.lease_token,
      next_lease_token: crypto.randomUUID(),
    });
    expect(await recovery.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "running-expired-outcome",
      result: "terminal_unknown",
      state: "failed",
    });
    expect((await deliveryRows(slug))[0]).toMatchObject({
      state: "failed",
      attempt: 1,
      lease_adapter: null,
      last_error: "runner ownership lost after task start; outcome unknown, not auto-retried",
    });
    recovery.close();
    observer.close();
  });

  it("replay-safe unknown recovery queues old debt behind an active successor and resumes it in order", async () => {
    const owner = `${uniq("recover-order-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("recover-order-target"), {
      owner,
      channelScope: slug,
    });
    const firstHolder = await WsClient.open(slug, target.token);
    await firstHolder.nextOfType("welcome");
    await registerWatch(firstHolder);

    const firstMessage = await sendMention(
      slug,
      sender.token,
      target.name,
      "old pre-harness debt",
    );
    const first = (await firstHolder.nextOfType("delivery")) as DirectedDeliveryFrame;
    if (first.delivery.lease_epoch === undefined || first.delivery.lease_token === undefined) {
      throw new Error("holder delivery omitted recovery ownership");
    }
    firstHolder.send({
      type: "delivery_update",
      delivery_id: first.delivery.id,
      request_id: "old-running-before-crash",
      state: "running",
      attempt: first.delivery.attempt,
      lease_epoch: first.delivery.lease_epoch,
      lease_token: first.delivery.lease_token,
      work_id: first.delivery.work_id ?? undefined,
      continuation_ref: first.delivery.continuation_ref ?? undefined,
    });
    for (;;) {
      const state = await firstHolder.nextOfType("delivery_state");
      if (state.request_id === "old-running-before-crash") break;
    }
    const secondMessage = await sendMention(
      slug,
      sender.token,
      target.name,
      "new successor stays active first",
    );
    expect(await deliveryRows(slug)).toMatchObject([
      { message_seq: firstMessage.seq, state: "running" },
      { message_seq: secondMessage.seq, state: "queued" },
    ]);

    firstHolder.close();
    const successorHolder = await WsClient.open(slug, target.token);
    await successorHolder.nextOfType("welcome");
    await registerWatch(successorHolder);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE directed_deliveries SET lease_until = ? WHERE id = ?",
        Date.now() - 1,
        first.delivery.id,
      );
      await instance.onAlarm();
    });
    const successor = (await successorHolder.nextOfType("delivery")) as DirectedDeliveryFrame;
    expect(successor.delivery).toMatchObject({
      message_seq: secondMessage.seq,
      state: "claimed",
    });

    const restartedOld = await WsClient.open(slug, target.token);
    await restartedOld.nextOfType("welcome");
    await registerWatch(restartedOld);
    restartedOld.send({
      type: "delivery_recover",
      delivery_id: first.delivery.id,
      request_id: "revive-old-behind-successor",
      attempt: first.delivery.attempt,
      lease_epoch: first.delivery.lease_epoch,
      lease_token: first.delivery.lease_token,
      next_lease_token: crypto.randomUUID(),
      replay_safe: true,
    });
    expect(await restartedOld.nextOfType("delivery_recovery")).toMatchObject({
      request_id: "revive-old-behind-successor",
      result: "superseded_safe",
      state: "queued",
    });
    expect(await deliveryRows(slug)).toMatchObject([
      { message_seq: firstMessage.seq, state: "queued", attempt: 1 },
      { message_seq: secondMessage.seq, state: "claimed", attempt: 1 },
    ]);
    await expectNoFullDelivery(restartedOld);

    await replyTo(
      slug,
      target.token,
      secondMessage.seq,
      "successor completed before old debt",
    );
    const resumedOld = (await successorHolder.nextOfType("delivery")) as DirectedDeliveryFrame;
    expect(resumedOld.delivery).toMatchObject({
      id: first.delivery.id,
      message_seq: firstMessage.seq,
      state: "claimed",
      attempt: 2,
    });
    expect(await deliveryRows(slug)).toMatchObject([
      { message_seq: firstMessage.seq, state: "claimed", attempt: 2 },
      { message_seq: secondMessage.seq, state: "replied", attempt: 1 },
    ]);

    successorHolder.close();
    restartedOld.close();
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
    await waitFor(() => captured);
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
    await waitFor(() => captured);
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
