// Failure-injection coverage for the message / durable-delivery write boundaries.
//
// A message that names an agent is not committed until its directed-delivery row is committed.
// Decision asks additionally park their source lease, while decision responses resolve the request,
// append the response, and create owner-answer work. Every group is one logical commit: retrying
// after any injected SQLite failure must observe the pre-call state, never a half-written workflow.
import type { DirectedDeliveryFrame } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, createChannel, disableLoopGuard, seedToken, uniq } from "./helpers";

interface DeliveryRow {
  id: string;
  message_seq: number;
  target_name: string;
  cause: string;
  state: string;
  parent_delivery_id: string | null;
}

interface MessageRow {
  seq: number;
  idempotency_key: string | null;
  decision_state: string | null;
  decision_request_json: string | null;
  decision_resolution_json: string | null;
  decision_response_json: string | null;
}

async function inChannel<T>(
  slug: string,
  fn: (sql: SqlStorage) => T,
): Promise<T> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => fn(state.storage.sql));
}

async function installTrigger(slug: string, ddl: string): Promise<void> {
  await inChannel(slug, (sql) => {
    sql.exec(ddl);
  });
}

async function dropTrigger(slug: string, name: string): Promise<void> {
  await inChannel(slug, (sql) => {
    sql.exec(`DROP TRIGGER IF EXISTS ${name}`);
  });
}

async function expectInjectedFailure(send: () => Promise<Response>): Promise<void> {
  let response: Response | null = null;
  let rejected = false;
  try {
    response = await send();
  } catch {
    // Depending on the Miniflare boundary, a DO exception can reject SELF.fetch or become HTTP 500.
    rejected = true;
  }
  expect(rejected || (response !== null && !response.ok)).toBe(true);
}

async function messageRows(slug: string): Promise<MessageRow[]> {
  return inChannel(slug, (sql) =>
    sql
      .exec(
        `SELECT seq, idempotency_key, decision_state, decision_request_json,
                decision_resolution_json, decision_response_json
           FROM messages ORDER BY seq`,
      )
      .toArray()
      .map((row) => ({
        seq: Number(row.seq),
        idempotency_key: row.idempotency_key === null ? null : String(row.idempotency_key),
        decision_state: row.decision_state === null ? null : String(row.decision_state),
        decision_request_json:
          row.decision_request_json === null ? null : String(row.decision_request_json),
        decision_resolution_json:
          row.decision_resolution_json === null ? null : String(row.decision_resolution_json),
        decision_response_json:
          row.decision_response_json === null ? null : String(row.decision_response_json),
      })),
  );
}

async function deliveryRows(slug: string): Promise<DeliveryRow[]> {
  return inChannel(slug, (sql) =>
    sql
      .exec(
        `SELECT id, message_seq, target_name, cause, state, parent_delivery_id
           FROM directed_deliveries ORDER BY message_seq, created_at`,
      )
      .toArray()
      .map((row) => ({
        id: String(row.id),
        message_seq: Number(row.message_seq),
        target_name: String(row.target_name),
        cause: String(row.cause),
        state: String(row.state),
        parent_delivery_id:
          row.parent_delivery_id === null ? null : String(row.parent_delivery_id),
      })),
  );
}

async function setupActiveWork() {
  const account = `${uniq("atomic-owner")}@example.com`;
  const owner = await seedToken("human", uniq("atomic-human"), { owner: account });
  const slug = await createChannel(owner.token);
  const agent = await seedToken("agent", uniq("atomic-agent"), {
    owner: account,
    channelScope: slug,
  });
  await disableLoopGuard(slug, owner.token);

  const serve = await WsClient.open(slug, agent.token);
  await serve.nextOfType("welcome");
  serve.send({ type: "hello", since: 0, directed_delivery: "v1" });
  serve.send({ type: "serve_lease", op: "claim" });
  expect((await serve.nextOfType("serve_lease")).held).toBe(true);

  const workResponse = await api(`/api/channels/${slug}/messages`, owner.token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: `@${agent.name} atomic work`,
      mentions: [agent.name],
      reply_to: null,
      idempotency_key: `work-${crypto.randomUUID()}`,
    }),
  });
  expect(workResponse.status).toBe(200);
  const work = (await workResponse.json()) as { seq: number };
  const source = (await serve.nextOfType("delivery")) as DirectedDeliveryFrame;
  expect(source.delivery.message_seq).toBe(work.seq);
  return { slug, owner, agent, serve, work, source };
}

async function setupPendingDecision() {
  const context = await setupActiveWork();
  const questionKey = `question-${crypto.randomUUID()}`;
  const questionResponse = await api(`/api/channels/${context.slug}/messages`, context.agent.token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: "approve atomic operation?",
      mentions: [],
      reply_to: context.work.seq,
      idempotency_key: questionKey,
      decision_request: { prompt: "approve atomic operation?" },
    }),
  });
  expect(questionResponse.status).toBe(200);
  const question = (await questionResponse.json()) as { seq: number };
  const rows = await deliveryRows(context.slug);
  expect(rows.find((row) => row.id === context.source.delivery.id)?.state).toBe("waiting_owner");
  return { ...context, question, questionKey };
}

function respond(slug: string, token: string, requestSeq: number): Promise<Response> {
  return api(`/api/channels/${slug}/messages/${requestSeq}/decision`, token, {
    method: "POST",
    body: JSON.stringify({ action: "approve", reason: "atomic approval" }),
  });
}

async function expectPendingWithoutAnswer(
  slug: string,
  requestSeq: number,
  sourceDeliveryId: string,
): Promise<void> {
  const messages = await messageRows(slug);
  const request = messages.find((row) => row.seq === requestSeq);
  expect(request).toMatchObject({
    decision_state: "pending",
    decision_resolution_json: null,
  });
  expect(messages.filter((row) => row.decision_response_json !== null)).toHaveLength(0);

  const deliveries = await deliveryRows(slug);
  expect(deliveries.find((row) => row.id === sourceDeliveryId)?.state).toBe("waiting_owner");
  expect(deliveries.filter((row) => row.cause === "owner_answer")).toHaveLength(0);
}

async function assertResponseRetryAndCompletion(context: Awaited<ReturnType<typeof setupPendingDecision>>) {
  const resolved = await respond(context.slug, context.owner.token, context.question.seq);
  expect(resolved.status).toBe(200);
  const firstBody = (await resolved.json()) as {
    message: { seq: number; decision_resolution?: { state: string } };
    reply: { seq: number };
  };
  expect(firstBody.message).toMatchObject({
    seq: context.question.seq,
    decision_resolution: { state: "resolved" },
  });

  let messages = await messageRows(context.slug);
  let deliveries = await deliveryRows(context.slug);
  const responseRows = messages.filter((row) => row.decision_response_json !== null);
  const ownerAnswers = deliveries.filter((row) => row.cause === "owner_answer");
  expect(responseRows).toHaveLength(1);
  expect(responseRows[0]?.seq).toBe(firstBody.reply.seq);
  expect(ownerAnswers).toHaveLength(1);
  expect(ownerAnswers[0]).toMatchObject({
    message_seq: firstBody.reply.seq,
    parent_delivery_id: context.source.delivery.id,
  });

  // Same successful response is an idempotent retry, not a second decision or a 409. The original
  // response identity must be returned so a caller can safely retry after losing the HTTP response.
  const duplicate = await respond(context.slug, context.owner.token, context.question.seq);
  expect(duplicate.status).toBe(200);
  const duplicateBody = (await duplicate.json()) as { message: { seq: number }; reply: { seq: number } };
  expect(duplicateBody.message.seq).toBe(firstBody.message.seq);
  expect(duplicateBody.reply.seq).toBe(firstBody.reply.seq);
  messages = await messageRows(context.slug);
  deliveries = await deliveryRows(context.slug);
  expect(messages.filter((row) => row.decision_response_json !== null)).toHaveLength(1);
  expect(deliveries.filter((row) => row.cause === "owner_answer")).toHaveLength(1);

  const completion = await api(`/api/channels/${context.slug}/messages`, context.agent.token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: "completed after atomic owner answer",
      mentions: [],
      reply_to: firstBody.reply.seq,
      idempotency_key: `completion-${crypto.randomUUID()}`,
    }),
  });
  expect(completion.status).toBe(200);
  const completionSeq = ((await completion.json()) as { seq: number }).seq;
  deliveries = await deliveryRows(context.slug);
  expect(deliveries.find((row) => row.id === ownerAnswers[0]!.id)).toMatchObject({ state: "replied" });
  expect(deliveries.find((row) => row.id === context.source.delivery.id)).toMatchObject({
    state: "replied",
  });
  const responseDelivery = await inChannel(context.slug, (sql) =>
    sql
      .exec("SELECT reply_seq FROM directed_deliveries WHERE id = ?", ownerAnswers[0]!.id)
      .toArray()[0],
  );
  expect(Number(responseDelivery?.reply_seq)).toBe(completionSeq);
}

describe("delivery transaction atomicity", () => {
  it("rolls back the idempotent message when directed-delivery INSERT aborts, then retries once", async () => {
    const account = `${uniq("atomic-owner")}@example.com`;
    const sender = await seedToken("human", uniq("atomic-sender"), { owner: account });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("atomic-target"), {
      owner: account,
      channelScope: slug,
    });
    // Creating a channel writes D1 only. Touch its DO once so onStart has materialized the SQLite
    // schema before the test installs a trigger directly through runInDurableObject.
    const warmed = await api(`/api/channels/${slug}/messages?since=0&limit=1`, sender.token);
    expect(warmed.status).toBe(200);
    const key = `mention-${crypto.randomUUID()}`;
    const body = JSON.stringify({
      kind: "message",
      body: `@${target.name} injected delivery failure`,
      mentions: [target.name],
      reply_to: null,
      idempotency_key: key,
    });

    await installTrigger(
      slug,
      `CREATE TRIGGER fail_delivery_insert
         BEFORE INSERT ON directed_deliveries
         BEGIN SELECT RAISE(ABORT, 'injected directed delivery insert failure'); END`,
    );
    await expectInjectedFailure(() =>
      api(`/api/channels/${slug}/messages`, sender.token, { method: "POST", body }),
    );

    expect((await messageRows(slug)).filter((row) => row.idempotency_key === key)).toHaveLength(0);
    expect(await deliveryRows(slug)).toHaveLength(0);

    await dropTrigger(slug, "fail_delivery_insert");
    const retried = await api(`/api/channels/${slug}/messages`, sender.token, {
      method: "POST",
      body,
    });
    expect(retried.status).toBe(200);
    const seq = ((await retried.json()) as { seq: number }).seq;
    expect((await messageRows(slug)).filter((row) => row.idempotency_key === key)).toHaveLength(1);
    expect(await deliveryRows(slug)).toEqual([
      expect.objectContaining({
        message_seq: seq,
        target_name: target.name,
      }),
    ]);
  });

  it("rolls back a decision question when parking its source delivery aborts", async () => {
    const context = await setupActiveWork();
    const key = `question-${crypto.randomUUID()}`;
    const body = JSON.stringify({
      kind: "message",
      body: "should this be atomic?",
      mentions: [],
      reply_to: context.work.seq,
      idempotency_key: key,
      decision_request: { prompt: "should this be atomic?" },
    });

    try {
      await installTrigger(
        context.slug,
        `CREATE TRIGGER fail_waiting_owner_update
           BEFORE UPDATE OF state ON directed_deliveries
           WHEN NEW.state = 'waiting_owner'
           BEGIN SELECT RAISE(ABORT, 'injected waiting owner failure'); END`,
      );
      await expectInjectedFailure(() =>
        api(`/api/channels/${context.slug}/messages`, context.agent.token, { method: "POST", body }),
      );
      expect((await messageRows(context.slug)).filter((row) => row.idempotency_key === key)).toHaveLength(0);
      expect((await deliveryRows(context.slug)).find((row) => row.id === context.source.delivery.id)?.state).toBe(
        "claimed",
      );

      await dropTrigger(context.slug, "fail_waiting_owner_update");
      const retried = await api(`/api/channels/${context.slug}/messages`, context.agent.token, {
        method: "POST",
        body,
      });
      expect(retried.status).toBe(200);
      const questionSeq = ((await retried.json()) as { seq: number }).seq;
      const messages = await messageRows(context.slug);
      expect(messages.filter((row) => row.idempotency_key === key)).toEqual([
        expect.objectContaining({ seq: questionSeq, decision_state: "pending" }),
      ]);
      expect((await deliveryRows(context.slug)).find((row) => row.id === context.source.delivery.id)?.state).toBe(
        "waiting_owner",
      );
    } finally {
      await dropTrigger(context.slug, "fail_waiting_owner_update");
      context.serve.close();
    }
  });

  it("rolls back decision resolution when the decision-response message INSERT aborts", async () => {
    const context = await setupPendingDecision();
    try {
      await installTrigger(
        context.slug,
        `CREATE TRIGGER fail_decision_response_insert
           BEFORE INSERT ON messages
           WHEN NEW.decision_response_json IS NOT NULL
           BEGIN SELECT RAISE(ABORT, 'injected decision response insert failure'); END`,
      );
      await expectInjectedFailure(() => respond(context.slug, context.owner.token, context.question.seq));
      await expectPendingWithoutAnswer(context.slug, context.question.seq, context.source.delivery.id);

      await dropTrigger(context.slug, "fail_decision_response_insert");
      await assertResponseRetryAndCompletion(context);
    } finally {
      await dropTrigger(context.slug, "fail_decision_response_insert");
      context.serve.close();
    }
  });

  it("rolls back resolution and response when owner-answer delivery INSERT aborts", async () => {
    const context = await setupPendingDecision();
    try {
      await installTrigger(
        context.slug,
        `CREATE TRIGGER fail_owner_answer_insert
           BEFORE INSERT ON directed_deliveries
           WHEN NEW.cause = 'owner_answer'
           BEGIN SELECT RAISE(ABORT, 'injected owner answer insert failure'); END`,
      );
      await expectInjectedFailure(() => respond(context.slug, context.owner.token, context.question.seq));
      await expectPendingWithoutAnswer(context.slug, context.question.seq, context.source.delivery.id);

      await dropTrigger(context.slug, "fail_owner_answer_insert");
      await assertResponseRetryAndCompletion(context);
    } finally {
      await dropTrigger(context.slug, "fail_owner_answer_insert");
      context.serve.close();
    }
  });

  it("lets only one concurrent decision CAS append the idempotent response", async () => {
    const context = await setupPendingDecision();
    try {
      const [left, right] = await Promise.all([
        respond(context.slug, context.owner.token, context.question.seq),
        respond(context.slug, context.owner.token, context.question.seq),
      ]);
      expect(left.status).toBe(200);
      expect(right.status).toBe(200);
      const leftBody = (await left.json()) as { reply: { seq: number } };
      const rightBody = (await right.json()) as { reply: { seq: number } };
      expect(rightBody.reply.seq).toBe(leftBody.reply.seq);
      expect((await messageRows(context.slug)).filter((row) => row.decision_response_json !== null)).toHaveLength(1);
      expect((await deliveryRows(context.slug)).filter((row) => row.cause === "owner_answer")).toHaveLength(1);
    } finally {
      context.serve.close();
    }
  });
});
