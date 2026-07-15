import { MAX_WEBHOOK_QUEUE_ROWS, WEBHOOK_MAX_RETRIES, type DecisionRequest, type DecisionResponse, type DirectedDelivery } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { fetchMock } from "./fetch-mock";
import { WsClient, api, createChannel, disableLoopGuard, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

interface MessageResult {
  seq: number;
  decision_request?: DecisionRequest;
  decision_resolution?: { state: "pending" | "resolved" | "auto_resolved"; chosen_option?: string };
}

interface DeliveryRow extends DirectedDelivery {
  lease_connection_id: string | null;
  last_lease_connection_id: string | null;
}

async function deliveryRows(slug: string): Promise<DeliveryRow[]> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec("SELECT * FROM directed_deliveries ORDER BY message_seq, created_at")
      .toArray()
      .map((row) => ({
        id: String(row.id),
        message_seq: Number(row.message_seq),
        target_name: String(row.target_name),
        cause: String(row.cause) as DirectedDelivery["cause"],
        state: String(row.state) as DirectedDelivery["state"],
        attempt: Number(row.attempt),
        lease_until: row.lease_until === null ? null : Number(row.lease_until),
        lease_connection_id: row.lease_connection_id === null ? null : String(row.lease_connection_id),
        last_lease_connection_id:
          row.last_lease_connection_id === null ? null : String(row.last_lease_connection_id),
        work_id: row.work_id === null ? null : String(row.work_id),
        continuation_ref: row.continuation_ref === null ? null : String(row.continuation_ref),
        reply_seq: row.reply_seq === null ? null : Number(row.reply_seq),
        last_error: row.last_error === null ? null : String(row.last_error),
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
      })),
  );
}

async function fixture(mode: "approval" | "unattended" = "approval") {
  const account = `${uniq("owner")}@example.com`;
  const owner = await seedToken("human", uniq("owner"), { owner: account });
  const slug = await createChannel(owner.token);
  const agent = await seedToken("agent", uniq("agent"), {
    owner: `${uniq("agent-owner")}@example.com`,
    channelScope: slug,
  });
  await disableLoopGuard(slug, owner.token);
  if (mode !== "approval") {
    const configured = await api(`/api/channels/${slug}/decision-mode`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
    expect(configured.status).toBe(200);
  }
  const serve = await WsClient.open(slug, agent.token);
  await serve.nextOfType("welcome");
  serve.send({ type: "hello", since: 0, directed_delivery: "v1" });
  serve.send({ type: "serve_lease", op: "claim" });
  expect((await serve.nextOfType("serve_lease")).held).toBe(true);
  return { slug, owner, agent, serve };
}

async function sendWork(slug: string, token: string, target: string, label: string) {
  const response = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body: `@${target} ${label}`, mentions: [target], reply_to: null }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as MessageResult;
}

async function askDecision(
  slug: string,
  token: string,
  originSeq: number | null,
  prompt: string,
  extras: Record<string, unknown> = {},
) {
  const response = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: prompt,
      mentions: [],
      reply_to: originSeq,
      decision_request: { prompt, ...extras },
    }),
  });
  return { response, body: response.ok ? ((await response.json()) as MessageResult) : null };
}

async function resolveDecision(
  slug: string,
  token: string,
  requestSeq: number,
  reason = "owner says yes",
) {
  const response = await api(`/api/channels/${slug}/messages/${requestSeq}/decision`, token, {
    method: "POST",
    body: JSON.stringify({ action: "approve", reason }),
  });
  const body = response.ok
    ? ((await response.json()) as {
        message: MessageResult;
        reply: { seq: number; decision_response?: DecisionResponse };
      })
    : null;
  return { response, body };
}

async function reply(slug: string, token: string, replyTo: number, body: string) {
  const response = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions: [], reply_to: replyTo }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { seq: number };
}

async function nextDeliveryState(
  ws: WsClient,
  deliveryId: string,
  state: DirectedDelivery["state"],
) {
  for (;;) {
    const frame = await ws.nextOfType("delivery_state");
    if (frame.delivery.id === deliveryId && frame.delivery.state === state) return frame;
  }
}

async function parkSourceWork() {
  const context = await fixture();
  const origin = await sendWork(context.slug, context.owner.token, context.agent.name, "terminal matrix");
  const source = await context.serve.nextOfType("delivery");
  const asked = await askDecision(context.slug, context.agent.token, origin.seq, "continue?");
  expect(asked.response.status).toBe(200);
  await nextDeliveryState(context.serve, source.delivery.id, "waiting_owner");
  return { ...context, origin, source, asked: asked.body! };
}

async function closeServeAndWait(
  slug: string,
  ownerToken: string,
  agentName: string,
  serve: WsClient,
) {
  const observer = await WsClient.open(slug, ownerToken);
  await observer.nextOfType("welcome");
  serve.close();
  for (;;) {
    const presence = await observer.nextOfType("presence");
    if (presence.name === agentName && presence.state === "offline") break;
  }
  observer.close();
}

function expectOwnerAnswerChainFailed(rows: DeliveryRow[]) {
  expect(rows.filter((row) => row.state === "waiting_owner")).toHaveLength(0);
  expect(rows.find((row) => row.cause === "owner_answer")).toMatchObject({ state: "failed" });
  expect(rows.find((row) => row.cause !== "owner_answer")).toMatchObject({ state: "failed" });
}

describe("decision ↔ durable delivery lineage (#548)", () => {
  it("binds only the server-observed active work, parks it without busy, ACKs a late receipt, and closes it after owner-answer work", async () => {
    const { slug, owner, agent, serve } = await fixture();
    const origin = await sendWork(slug, owner.token, agent.name, "needs a decision");
    const first = await serve.nextOfType("delivery");
    expect(first.delivery.message_seq).toBe(origin.seq);

    // Materialize a busy/current_task presence so the waiting_owner transition can prove it clears
    // only the parked task instead of relying on a later client heartbeat.
    const status = await api(`/api/channels/${slug}/messages`, agent.token, {
      method: "POST",
      body: JSON.stringify({
        kind: "status",
        state: "working",
        note: "running",
        mentions: [],
        busy: true,
        queue_depth: 0,
      }),
    });
    expect(status.status).toBe(200);
    serve.send({
      type: "heartbeat",
      current_task: origin.seq,
      task_started_at: Date.now() - 1000,
      heartbeat_at: Date.now(),
    });

    const asked = await askDecision(slug, agent.token, origin.seq, "ship it?", {
      // Deliberately forged: public input must be overwritten, never merely trusted/echoed.
      delivery_id: "client-forged",
      origin_seq: 999999,
      origin_channel: "wrong-channel",
      work_id: "wrong-work",
      continuation_ref: "wrong-thread",
    });
    expect(asked.response.status).toBe(200);
    expect(asked.body?.decision_resolution).toEqual({ state: "pending" });
    expect(asked.body?.decision_request).toMatchObject({
      delivery_id: first.delivery.id,
      origin_seq: origin.seq,
      origin_channel: slug,
      work_id: first.delivery.work_id,
      continuation_ref: first.delivery.continuation_ref,
    });
    const parkedState = await nextDeliveryState(serve, first.delivery.id, "waiting_owner");
    expect(parkedState.delivery).toMatchObject({ id: first.delivery.id, state: "waiting_owner" });

    const parked = (await deliveryRows(slug))[0]!;
    expect(parked).toMatchObject({
      id: first.delivery.id,
      state: "waiting_owner",
      lease_connection_id: null,
      work_id: first.delivery.work_id,
      continuation_ref: first.delivery.continuation_ref,
    });
    expect(parked.last_lease_connection_id).not.toBeNull();
    const presenceResponse = await api(`/api/channels/${slug}/presence`, owner.token);
    const presence = (await presenceResponse.json()) as {
      presence: Array<{ name: string; busy?: boolean; current_task?: number; waiting_owner_count?: number }>;
    };
    expect(presence.presence.find((entry) => entry.name === agent.name)).toMatchObject({
      waiting_owner_count: 1,
    });
    expect(presence.presence.find((entry) => entry.name === agent.name)?.busy).toBeUndefined();
    expect(presence.presence.find((entry) => entry.name === agent.name)?.current_task).toBeUndefined();

    // The question turn returns normally, so a serve client may race in with replied. It must receive
    // an authoritative waiting_owner ACK and must not restart/fail or duplicate the work.
    serve.send({
      type: "delivery_update",
      delivery_id: first.delivery.id,
      state: "replied",
      work_id: first.delivery.work_id ?? undefined,
      continuation_ref: first.delivery.continuation_ref ?? undefined,
    });
    const lateAck = await nextDeliveryState(serve, first.delivery.id, "waiting_owner");
    expect(lateAck.delivery).toMatchObject({ id: first.delivery.id, state: "waiting_owner" });
    expect((await deliveryRows(slug))[0]?.state).toBe("waiting_owner");

    const resolved = await resolveDecision(slug, owner.token, asked.body!.seq, "safe to ship");
    expect(resolved.response.status).toBe(200);
    expect(resolved.body?.reply.decision_response).toMatchObject({
      request_seq: asked.body!.seq,
      prompt: "ship it?",
      reason: "safe to ship",
    });
    expect(resolved.body?.reply.decision_response).not.toHaveProperty("delivery_id");
    expect(resolved.body?.reply.decision_response).not.toHaveProperty("work_id");
    expect(resolved.body?.reply.decision_response).not.toHaveProperty("continuation_ref");
    const answerWork = await serve.nextOfType("delivery");
    expect(answerWork.delivery).toMatchObject({
      cause: "owner_answer",
      target_name: agent.name,
      work_id: first.delivery.work_id,
      continuation_ref: first.delivery.continuation_ref,
    });
    const duplicate = await resolveDecision(slug, owner.token, asked.body!.seq, "must not duplicate");
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body?.reply.seq).toBe(resolved.body?.reply.seq);
    expect((await deliveryRows(slug)).filter((row) => row.cause === "owner_answer")).toHaveLength(1);
    expect((await deliveryRows(slug)).find((row) => row.id === first.delivery.id)?.state).toBe("waiting_owner");

    const final = await reply(slug, agent.token, answerWork.message.seq, "completed after owner answer");
    const rows = await deliveryRows(slug);
    expect(rows.find((row) => row.id === answerWork.delivery.id)).toMatchObject({
      state: "replied",
      reply_seq: final.seq,
    });
    expect(rows.find((row) => row.id === first.delivery.id)).toMatchObject({
      state: "replied",
      reply_seq: final.seq,
    });
    serve.close();
  });

  it("keeps A/B lineage stable when owners answer B before A", async () => {
    const { slug, owner, agent, serve } = await fixture();
    const originA = await sendWork(slug, owner.token, agent.name, "A");
    const deliveryA = await serve.nextOfType("delivery");
    const askedA = await askDecision(slug, agent.token, originA.seq, "approve A?");
    expect(askedA.response.status).toBe(200);
    await nextDeliveryState(serve, deliveryA.delivery.id, "waiting_owner");

    const originB = await sendWork(slug, owner.token, agent.name, "B");
    const deliveryB = await serve.nextOfType("delivery");
    const askedB = await askDecision(slug, agent.token, originB.seq, "approve B?");
    expect(askedB.response.status).toBe(200);
    await nextDeliveryState(serve, deliveryB.delivery.id, "waiting_owner");
    expect(deliveryA.delivery.work_id).not.toBe(deliveryB.delivery.work_id);

    const resolvedB = await resolveDecision(slug, owner.token, askedB.body!.seq, "B first");
    expect(resolvedB.response.status).toBe(200);
    const answerB = await serve.nextOfType("delivery");
    expect(answerB.delivery).toMatchObject({
      work_id: deliveryB.delivery.work_id,
      continuation_ref: deliveryB.delivery.continuation_ref,
    });

    const resolvedA = await resolveDecision(slug, owner.token, askedA.body!.seq, "A second");
    expect(resolvedA.response.status).toBe(200);
    expect((await deliveryRows(slug)).find((row) => row.work_id === deliveryA.delivery.work_id && row.cause === "owner_answer")).toMatchObject({
      state: "queued",
    });

    await reply(slug, agent.token, answerB.message.seq, "B done");
    const answerA = await serve.nextOfType("delivery");
    expect(answerA.delivery).toMatchObject({
      work_id: deliveryA.delivery.work_id,
      continuation_ref: deliveryA.delivery.continuation_ref,
    });
    await reply(slug, agent.token, answerA.message.seq, "A done");
    const rows = await deliveryRows(slug);
    expect(rows.filter((row) => row.state === "waiting_owner")).toHaveLength(0);
    expect(rows.filter((row) => row.cause === "owner_answer")).toHaveLength(2);
    expect(rows.every((row) => row.state === "replied")).toBe(true);
    serve.close();
  });

  it("explicit owner_answer failure closes its exact waiting_owner ancestor", async () => {
    const { slug, owner, serve, source, asked } = await parkSourceWork();
    const resolved = await resolveDecision(slug, owner.token, asked.seq, "run then fail");
    expect(resolved.response.status).toBe(200);
    const answer = await serve.nextOfType("delivery");
    serve.send({
      type: "delivery_update",
      delivery_id: answer.delivery.id,
      state: "failed",
      work_id: answer.delivery.work_id ?? undefined,
      continuation_ref: answer.delivery.continuation_ref ?? undefined,
      error: "model failed deterministically",
    });
    await nextDeliveryState(serve, answer.delivery.id, "failed");
    const rows = await deliveryRows(slug);
    expectOwnerAnswerChainFailed(rows);
    expect(rows.find((row) => row.id === source.delivery.id)?.last_error).toContain("owner answer failed");
    serve.close();
  });

  it("running owner_answer lease expiry fails unknown and closes waiting_owner ancestor without replay", async () => {
    const { slug, owner, serve, source, asked } = await parkSourceWork();
    const resolved = await resolveDecision(slug, owner.token, asked.seq, "long continuation");
    expect(resolved.response.status).toBe(200);
    const answer = await serve.nextOfType("delivery");
    serve.send({
      type: "delivery_update",
      delivery_id: answer.delivery.id,
      state: "running",
      work_id: answer.delivery.work_id ?? undefined,
      continuation_ref: answer.delivery.continuation_ref ?? undefined,
    });
    await nextDeliveryState(serve, answer.delivery.id, "running");
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE directed_deliveries SET lease_until = ? WHERE id = ?",
        Date.now() - 1,
        answer.delivery.id,
      );
      await instance.onAlarm();
    });
    const rows = await deliveryRows(slug);
    expectOwnerAnswerChainFailed(rows);
    expect(rows.find((row) => row.id === answer.delivery.id)?.last_error).toContain("outcome unknown");
    expect(rows.find((row) => row.id === source.delivery.id)?.last_error).toContain("owner answer failed");
    serve.close();
  });

  it("principal mismatch before owner_answer dispatch closes the parked source", async () => {
    const { slug, owner, agent, serve, asked } = await parkSourceWork();
    await closeServeAndWait(slug, owner.token, agent.name, serve);
    const resolved = await resolveDecision(slug, owner.token, asked.seq, "old principal answer");
    expect(resolved.response.status).toBe(200);
    await env.DB.prepare("UPDATE tokens SET owner = ? WHERE name = ?")
      .bind(`${uniq("replacement-owner")}@example.com`, agent.name)
      .run();
    const replacement = await WsClient.open(slug, agent.token);
    await replacement.nextOfType("welcome");
    replacement.send({ type: "hello", since: 0, directed_delivery: "v1" });
    replacement.send({ type: "serve_lease", op: "claim" });
    await replacement.nextOfType("serve_lease");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expectOwnerAnswerChainFailed(await deliveryRows(slug));
    replacement.close();
  });

  it("missing owner_answer source message closes the parked source", async () => {
    const { slug, owner, agent, serve, asked } = await parkSourceWork();
    await closeServeAndWait(slug, owner.token, agent.name, serve);
    const resolved = await resolveDecision(slug, owner.token, asked.seq, "message will disappear");
    expect(resolved.response.status).toBe(200);
    const answerSeq = resolved.body!.reply.seq;
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec("DELETE FROM messages WHERE seq = ?", answerSeq);
    });
    const replacement = await WsClient.open(slug, agent.token);
    await replacement.nextOfType("welcome");
    replacement.send({ type: "hello", since: 0, directed_delivery: "v1" });
    replacement.send({ type: "serve_lease", op: "claim" });
    await replacement.nextOfType("serve_lease");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = await deliveryRows(slug);
    expectOwnerAnswerChainFailed(rows);
    expect(rows.find((row) => row.cause === "owner_answer")?.last_error).toBe("source message is no longer retained");
    replacement.close();
  });

  it("agent webhook retry exhaustion closes owner_answer and waiting_owner source", async () => {
    const { slug, owner, agent, serve, asked } = await parkSourceWork();
    await closeServeAndWait(slug, owner.token, agent.name, serve);
    expect((await api(`/api/channels/${slug}/webhooks`, agent.token, {
      method: "POST",
      body: JSON.stringify({
        name: agent.name,
        url: "https://answer-retry.test/run",
        secret: "answer-secret",
        filter: "mentions",
        mode: "agent",
      }),
    })).status).toBe(201);
    fetchMock
      .get("https://answer-retry.test")
      .intercept({ path: "/run", method: "POST" })
      .reply(503, "down");
    const resolved = await resolveDecision(slug, owner.token, asked.seq, "webhook retry");
    expect(resolved.response.status).toBe(200);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE webhook_queue SET attempts = ?, next_retry_at = ?",
        WEBHOOK_MAX_RETRIES,
        Date.now() - 1,
      );
      await instance.onAlarm();
    });
    expectOwnerAnswerChainFailed(await deliveryRows(slug));
  });

  it("agent webhook queue-full and removal terminal paths both close waiting_owner ancestors", async () => {
    // Queue-full on a failed initial handoff.
    const full = await parkSourceWork();
    await closeServeAndWait(full.slug, full.owner.token, full.agent.name, full.serve);
    expect((await api(`/api/channels/${full.slug}/webhooks`, full.agent.token, {
      method: "POST",
      body: JSON.stringify({
        name: full.agent.name,
        url: "https://answer-full.test/run",
        secret: "answer-secret",
        filter: "mentions",
        mode: "agent",
      }),
    })).status).toBe(201);
    const fullStub = env.CHANNELS.get(env.CHANNELS.idFromName(full.slug));
    await runInDurableObject(fullStub, async (_instance: ChannelDO, state) => {
      for (let index = 0; index < MAX_WEBHOOK_QUEUE_ROWS; index++) {
        state.storage.sql.exec(
          "INSERT INTO webhook_queue (webhook_name, payload, attempts, next_retry_at) VALUES (?, ?, 1, ?)",
          `filler-${index}`,
          JSON.stringify({ seq: 1000 + index }),
          Date.now() + 86_400_000,
        );
      }
    });
    fetchMock
      .get("https://answer-full.test")
      .intercept({ path: "/run", method: "POST" })
      .reply(503, "down");
    expect((await resolveDecision(full.slug, full.owner.token, full.asked.seq)).response.status).toBe(200);
    expectOwnerAnswerChainFailed(await deliveryRows(full.slug));

    // Removal after a 2xx accepted handoff is an unknown terminal outcome, not a replay signal.
    const removed = await parkSourceWork();
    await closeServeAndWait(removed.slug, removed.owner.token, removed.agent.name, removed.serve);
    expect((await api(`/api/channels/${removed.slug}/webhooks`, removed.agent.token, {
      method: "POST",
      body: JSON.stringify({
        name: removed.agent.name,
        url: "https://answer-remove.test/run",
        secret: "answer-secret",
        filter: "mentions",
        mode: "agent",
      }),
    })).status).toBe(201);
    fetchMock
      .get("https://answer-remove.test")
      .intercept({ path: "/run", method: "POST" })
      .reply(200, "accepted");
    expect((await resolveDecision(removed.slug, removed.owner.token, removed.asked.seq)).response.status).toBe(200);
    expect((await deliveryRows(removed.slug)).find((row) => row.cause === "owner_answer")?.state).toBe("running");
    const deleted = await api(
      `/api/channels/${removed.slug}/webhooks/${encodeURIComponent(removed.agent.name)}`,
      removed.owner.token,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expectOwnerAnswerChainFailed(await deliveryRows(removed.slug));
  });

  it("keeps unattended decisions on the active delivery until real work completion", async () => {
    const { slug, owner, agent, serve } = await fixture("unattended");
    const origin = await sendWork(slug, owner.token, agent.name, "unattended");
    const delivery = await serve.nextOfType("delivery");
    const asked = await askDecision(slug, agent.token, origin.seq, "auto choose");
    expect(asked.response.status).toBe(200);
    expect(asked.body?.decision_resolution).toMatchObject({ state: "auto_resolved", chosen_option: "approve" });
    expect(asked.body?.decision_request).toMatchObject({
      delivery_id: delivery.delivery.id,
      work_id: delivery.delivery.work_id,
      continuation_ref: delivery.delivery.continuation_ref,
    });
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "claimed" });
    const done = await reply(slug, agent.token, origin.seq, "continued and done");
    expect((await deliveryRows(slug))[0]).toMatchObject({ state: "replied", reply_seq: done.seq });
    serve.close();
  });

  it("keeps decision lineage private on live broadcasts and reconnect history", async () => {
    const { slug, owner, agent, serve } = await fixture();
    const origin = await sendWork(slug, owner.token, agent.name, "private lineage");
    const source = await serve.nextOfType("delivery");

    const observer = await WsClient.open(slug, owner.token);
    await observer.nextOfType("welcome");
    observer.send({ type: "hello", since: 0 });
    expect((await observer.nextOfType("msg")).seq).toBe(origin.seq);
    const asked = await askDecision(slug, agent.token, origin.seq, "keep secrets private?");
    expect(asked.response.status).toBe(200);
    expect(asked.body?.decision_request).toMatchObject({
      delivery_id: source.delivery.id,
      work_id: source.delivery.work_id,
      continuation_ref: source.delivery.continuation_ref,
    });

    const liveQuestion = await observer.nextOfType("msg");
    expect(liveQuestion.seq).toBe(asked.body!.seq);
    expect(liveQuestion.decision_request).toEqual({
      kind: "approval",
      prompt: "keep secrets private?",
      options: ["approve", "reject"],
    });
    const publicWaiting = await nextDeliveryState(observer, source.delivery.id, "running");
    expect(Object.keys(publicWaiting.delivery).sort()).toEqual(
      ["created_at", "id", "message_seq", "reply_seq", "state", "target_name", "updated_at"].sort(),
    );

    const resolved = await resolveDecision(slug, owner.token, asked.body!.seq, "approved privately");
    expect(resolved.response.status).toBe(200);
    expect(resolved.body?.reply.decision_response).toMatchObject({
      request_seq: asked.body!.seq,
      chosen_option: "approve",
    });
    expect(resolved.body?.reply.decision_response).not.toHaveProperty("delivery_id");
    expect(resolved.body?.reply.decision_response).not.toHaveProperty("work_id");
    expect(resolved.body?.reply.decision_response).not.toHaveProperty("continuation_ref");
    const liveUpdate = await observer.nextOfType("message_update");
    expect(liveUpdate.message.decision_request).toEqual({
      kind: "approval",
      prompt: "keep secrets private?",
      options: ["approve", "reject"],
    });
    const liveAnswer = await observer.nextOfType("msg");
    expect(liveAnswer.decision_response).toEqual({
      request_seq: asked.body!.seq,
      chosen_index: 0,
      chosen_option: "approve",
      prompt: "keep secrets private?",
      reason: "approved privately",
    });

    const answerWork = await serve.nextOfType("delivery");
    expect(answerWork.delivery).toMatchObject({
      cause: "owner_answer",
      work_id: source.delivery.work_id,
      continuation_ref: source.delivery.continuation_ref,
    });
    expect(answerWork.message.decision_response).toMatchObject({
      delivery_id: source.delivery.id,
      work_id: source.delivery.work_id,
      continuation_ref: source.delivery.continuation_ref,
    });

    const historyResponse = await api(`/api/channels/${slug}/messages?since=0`, owner.token);
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as { messages: Array<{
      seq: number;
      decision_request?: DecisionRequest;
      decision_response?: DecisionResponse;
    }> };
    expect(history.messages.find((message) => message.seq === asked.body!.seq)?.decision_request).toEqual({
      kind: "approval",
      prompt: "keep secrets private?",
      options: ["approve", "reject"],
    });
    expect(history.messages.find((message) => message.seq === resolved.body!.reply.seq)?.decision_response).toEqual({
      request_seq: asked.body!.seq,
      chosen_index: 0,
      chosen_option: "approve",
      prompt: "keep secrets private?",
      reason: "approved privately",
    });

    observer.close();
    const reconnect = await WsClient.open(slug, owner.token);
    await reconnect.nextOfType("welcome");
    reconnect.send({ type: "hello", since: 0, since_rev: 0 });
    let replayedQuestion: MessageResult | undefined;
    let replayedAnswer: { decision_response?: DecisionResponse } | undefined;
    while (replayedQuestion === undefined || replayedAnswer === undefined) {
      const frame = await reconnect.nextOfType("msg");
      if (frame.seq === asked.body!.seq) replayedQuestion = frame;
      if (frame.seq === resolved.body!.reply.seq) replayedAnswer = frame;
    }
    expect(replayedQuestion.decision_request).toEqual({
      kind: "approval",
      prompt: "keep secrets private?",
      options: ["approve", "reject"],
    });
    expect(replayedAnswer.decision_response).toEqual({
      request_seq: asked.body!.seq,
      chosen_index: 0,
      chosen_option: "approve",
      prompt: "keep secrets private?",
      reason: "approved privately",
    });
    reconnect.close();
    serve.close();
  });

  it("leaves missing-active requests ordinary and rejects ambiguous active lineage", async () => {
    const account = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: account });
    const slug = await createChannel(owner.token);
    const agent = await seedToken("agent", uniq("agent"), { owner: account, channelScope: slug });
    await disableLoopGuard(slug, owner.token);

    const ordinary = await askDecision(slug, agent.token, null, "ordinary question", {
      delivery_id: "forged",
      origin_seq: 1,
      origin_channel: "forged",
      work_id: "forged",
      continuation_ref: "forged",
    });
    expect(ordinary.response.status).toBe(200);
    expect(ordinary.body?.decision_request).toEqual({
      kind: "approval",
      prompt: "ordinary question",
      options: ["approve", "reject"],
    });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const now = Date.now();
      for (const [id, seq] of [["ambiguous-a", 1001], ["ambiguous-b", 1002]] as const) {
        state.storage.sql.exec(
          `INSERT INTO directed_deliveries (
             id, message_seq, target_name, target_owner, cause, state, attempt,
             lease_connection_id, last_lease_connection_id, lease_until, work_id, continuation_ref,
             reply_seq, last_error, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'mention', 'claimed', 1, 'holder', 'holder', ?, ?, ?, NULL, NULL, ?, ?)`,
          id,
          seq,
          agent.name,
          account,
          now + 60_000,
          `work-${id}`,
          `thread-${id}`,
          now,
          now,
        );
      }
    });
    const ambiguous = await askDecision(slug, agent.token, null, "must fail closed");
    expect(ambiguous.response.status).toBe(400);
    expect(await ambiguous.response.json()).toMatchObject({
      error: { code: "bad_request", message: expect.stringContaining("multiple active directed deliveries") },
    });
  });
});
