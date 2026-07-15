import { WEBHOOK_MAX_RETRIES, type DirectedDeliveryFrame, type MsgFrame } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { fetchMock } from "./fetch-mock";
import {
  WsClient,
  api,
  completeCapabilityHello,
  createChannel,
  disableLoopGuard,
  seedToken,
  uniq,
} from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

interface StoredDelivery {
  id: string;
  message_seq: number;
  cause: string;
  state: string;
  parent_delivery_id: string | null;
  work_id: string | null;
  continuation_ref: string | null;
  last_error: string | null;
  terminal_reason: string | null;
  lease_connection_id: string | null;
  last_lease_connection_id: string | null;
  lease_adapter: string | null;
  lease_until: number | null;
}

interface StoredMessage {
  seq: number;
  reply_to: number | null;
  decision_state: string | null;
  decision_request_json: string | null;
  decision_response_json: string | null;
  retracted_at: number | null;
}

interface WebhookTestSurface {
  dispatchWebhooks(msg: MsgFrame): Promise<void>;
  retryWebhooks(now: number): Promise<void>;
  redeliverDeadLetters(name: string | null): Promise<unknown>;
}

async function inChannel<T>(slug: string, fn: (instance: ChannelDO, sql: SqlStorage) => T | Promise<T>) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, (instance: ChannelDO, state) => fn(instance, state.storage.sql));
}

async function deliveries(slug: string): Promise<StoredDelivery[]> {
  return inChannel(slug, (_instance, sql) =>
    sql
      .exec(
        `SELECT id, message_seq, cause, state, parent_delivery_id, work_id,
                continuation_ref, last_error, terminal_reason, lease_connection_id,
                last_lease_connection_id, lease_adapter, lease_until
           FROM directed_deliveries ORDER BY message_seq, created_at`,
      )
      .toArray()
      .map((row) => ({
        id: String(row.id),
        message_seq: Number(row.message_seq),
        cause: String(row.cause),
        state: String(row.state),
        parent_delivery_id: row.parent_delivery_id === null ? null : String(row.parent_delivery_id),
        work_id: row.work_id === null ? null : String(row.work_id),
        continuation_ref: row.continuation_ref === null ? null : String(row.continuation_ref),
        last_error: row.last_error === null ? null : String(row.last_error),
        terminal_reason: row.terminal_reason === null ? null : String(row.terminal_reason),
        lease_connection_id: row.lease_connection_id === null ? null : String(row.lease_connection_id),
        last_lease_connection_id:
          row.last_lease_connection_id === null ? null : String(row.last_lease_connection_id),
        lease_adapter: row.lease_adapter === null ? null : String(row.lease_adapter),
        lease_until: row.lease_until === null ? null : Number(row.lease_until),
      })),
  );
}

async function messages(slug: string): Promise<StoredMessage[]> {
  return inChannel(slug, (_instance, sql) =>
    sql
      .exec(
        `SELECT seq, reply_to, decision_state, decision_request_json,
                decision_response_json, retracted_at
           FROM messages ORDER BY seq`,
      )
      .toArray()
      .map((row) => ({
        seq: Number(row.seq),
        reply_to: row.reply_to === null ? null : Number(row.reply_to),
        decision_state: row.decision_state === null ? null : String(row.decision_state),
        decision_request_json:
          row.decision_request_json === null ? null : String(row.decision_request_json),
        decision_response_json:
          row.decision_response_json === null ? null : String(row.decision_response_json),
        retracted_at: row.retracted_at === null ? null : Number(row.retracted_at),
      })),
  );
}

async function webhookArtifactCounts(slug: string, seq: number) {
  return inChannel(slug, (_instance, sql) => {
    const queue = Number(
      sql
        .exec(
          `SELECT COUNT(*) AS n FROM webhook_queue
            WHERE json_valid(payload)
              AND CAST(json_extract(payload, '$.seq') AS INTEGER) = ?`,
          seq,
        )
        .one().n,
    );
    const dead = Number(
      sql
        .exec(
          `SELECT COUNT(*) AS n FROM webhook_dead_letters
            WHERE mention_seq = ?
               OR (json_valid(payload) AND CAST(json_extract(payload, '$.seq') AS INTEGER) = ?)`,
          seq,
          seq,
        )
        .one().n,
    );
    return { queue, dead };
  });
}

async function setupPendingDecision(options: { questionTarget?: boolean } = {}) {
  const account = `${uniq("retract-owner")}@example.com`;
  const owner = await seedToken("human", uniq("retract-human"), { owner: account });
  const slug = await createChannel(owner.token);
  const agent = await seedToken("agent", uniq("retract-agent"), {
    owner: account,
    channelScope: slug,
  });
  const questionTarget = await seedToken("agent", uniq("question-target"), {
    owner: account,
    channelScope: slug,
  });
  await disableLoopGuard(slug, owner.token);

  const serve = await WsClient.open(slug, agent.token);
  await completeCapabilityHello(serve);
  serve.send({ type: "serve_lease", op: "claim" });
  expect((await serve.nextOfType("serve_lease")).held).toBe(true);

  const originResponse = await api(`/api/channels/${slug}/messages`, owner.token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: `@${agent.name} start retract-sensitive work`,
      mentions: [agent.name],
      reply_to: null,
    }),
  });
  expect(originResponse.status).toBe(200);
  const origin = (await originResponse.json()) as { seq: number };
  const source = (await serve.nextOfType("delivery")) as DirectedDeliveryFrame;

  const questionResponse = await api(`/api/channels/${slug}/messages`, agent.token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: options.questionTarget
        ? `@${questionTarget.name} approve continuation?`
        : "approve continuation?",
      mentions: options.questionTarget ? [questionTarget.name] : [],
      reply_to: origin.seq,
      decision_request: { prompt: "approve continuation?" },
    }),
  });
  expect(questionResponse.status).toBe(200);
  const question = (await questionResponse.json()) as { seq: number };
  expect((await deliveries(slug)).find((row) => row.id === source.delivery.id)?.state).toBe(
    "waiting_owner",
  );
  return { slug, owner, agent, questionTarget, serve, origin, source, question };
}

function retract(slug: string, token: string, seq: number) {
  return api(`/api/channels/${slug}/messages/${seq}/retract`, token, { method: "POST" });
}

function respond(slug: string, token: string, seq: number) {
  return api(`/api/channels/${slug}/messages/${seq}/decision`, token, {
    method: "POST",
    body: JSON.stringify({ action: "approve", reason: "approved before retract race" }),
  });
}

async function createWebhookRaceFixture() {
  const sender = await seedToken("agent", uniq("webhook-retract-sender"));
  const slug = await createChannel(sender.token);
  const sent = await api(`/api/channels/${slug}/messages`, sender.token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body: "private stale webhook source", mentions: [], reply_to: null }),
  });
  expect(sent.status).toBe(200);
  const { seq } = (await sent.json()) as { seq: number };
  const history = await api(`/api/channels/${slug}/messages?since=0&limit=100`, sender.token);
  const stale = ((await history.json()) as { messages: MsgFrame[] }).messages.find((msg) => msg.seq === seq)!;
  const name = uniq("notify-retract");
  const registration = await api(`/api/channels/${slug}/webhooks`, sender.token, {
    method: "POST",
    body: JSON.stringify({
      name,
      url: "https://retract-race.test/wake",
      secret: "retract-race-secret",
      filter: "all",
      mode: "notify",
    }),
  });
  expect(registration.status).toBe(201);
  return { sender, slug, seq, stale, name };
}

describe("retract closes durable decision lineage", () => {
  it("retracting a pending question atomically fails both its own delivery and source waiting_owner work", async () => {
    const context = await setupPendingDecision({ questionTarget: true });
    try {
      expect((await deliveries(context.slug)).find((row) => row.message_seq === context.question.seq)).toMatchObject({
        state: "queued",
      });
      expect((await retract(context.slug, context.owner.token, context.question.seq)).status).toBe(200);

      const rows = await deliveries(context.slug);
      expect(rows.find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "failed",
        last_error: "source retracted, no retry",
        terminal_reason: "source_retracted",
        work_id: null,
        continuation_ref: null,
        parent_delivery_id: null,
        lease_connection_id: null,
        last_lease_connection_id: null,
        lease_adapter: null,
        lease_until: null,
      });
      expect(rows.find((row) => row.message_seq === context.question.seq)).toMatchObject({
        state: "failed",
        last_error: "source retracted, no retry",
        terminal_reason: "source_retracted",
        work_id: null,
        continuation_ref: null,
        parent_delivery_id: null,
        lease_connection_id: null,
        last_lease_connection_id: null,
        lease_adapter: null,
        lease_until: null,
      });
      expect(rows.filter((row) => row.state === "waiting_owner")).toHaveLength(0);
      const presence = await api(`/api/channels/${context.slug}/presence`, context.owner.token);
      const mine = ((await presence.json()) as { presence: Array<{ name: string; waiting_owner_count?: number }> })
        .presence.find((entry) => entry.name === context.agent.name);
      expect(mine?.waiting_owner_count).toBeUndefined();
    } finally {
      context.serve.close();
    }
  });

  it("retracting the origin prevents its still-pending question from creating owner-answer work", async () => {
    const context = await setupPendingDecision();
    try {
      expect((await retract(context.slug, context.owner.token, context.origin.seq)).status).toBe(200);
      const rejected = await respond(context.slug, context.owner.token, context.question.seq);
      expect(rejected.ok).toBe(false);

      const stored = await messages(context.slug);
      expect(stored.find((row) => row.seq === context.question.seq)).toMatchObject({
        decision_state: null,
        decision_request_json: null,
      });
      expect(stored.filter((row) => row.decision_response_json !== null)).toHaveLength(0);
      const rows = await deliveries(context.slug);
      expect(rows.find((row) => row.id === context.source.delivery.id)?.state).toBe("failed");
      expect(rows.filter((row) => row.cause === "owner_answer")).toHaveLength(0);
    } finally {
      context.serve.close();
    }
  });

  it.each(["delivery_id", "origin_seq", "origin_channel", "work_id", "continuation_ref"] as const)(
    "rejects a decision whose stored %s no longer exactly matches the parked source",
    async (field) => {
      const context = await setupPendingDecision();
      try {
        await inChannel(context.slug, (_instance, sql) => {
          const row = sql
            .exec("SELECT decision_request_json FROM messages WHERE seq = ?", context.question.seq)
            .one();
          const request = JSON.parse(String(row.decision_request_json)) as Record<string, unknown>;
          request[field] = field === "origin_seq" ? context.origin.seq + 100 : `corrupt-${field}`;
          sql.exec(
            "UPDATE messages SET decision_request_json = ? WHERE seq = ?",
            JSON.stringify(request),
            context.question.seq,
          );
        });

        const rejected = await respond(context.slug, context.owner.token, context.question.seq);
        expect(rejected.ok).toBe(false);
        expect((await messages(context.slug)).filter((row) => row.decision_response_json !== null)).toHaveLength(0);
        expect((await deliveries(context.slug)).filter((row) => row.cause === "owner_answer")).toHaveLength(0);
        expect((await deliveries(context.slug)).find((row) => row.id === context.source.delivery.id)?.state).toBe(
          "waiting_owner",
        );
      } finally {
        context.serve.close();
      }
    },
  );

  it("rejects an otherwise exact decision after its source has terminally failed", async () => {
    const context = await setupPendingDecision();
    try {
      await inChannel(context.slug, (_instance, sql) => {
        sql.exec(
          `UPDATE directed_deliveries
              SET state = 'failed', terminal_reason = 'delivery_failed',
                  last_error = 'terminal runner failure'
            WHERE id = ?`,
          context.source.delivery.id,
        );
      });
      const rejected = await respond(context.slug, context.owner.token, context.question.seq);
      expect(rejected.status).toBe(409);
      expect((await messages(context.slug)).filter((row) => row.decision_response_json !== null)).toHaveLength(0);
      expect((await deliveries(context.slug)).filter((row) => row.cause === "owner_answer")).toHaveLength(0);
      expect((await deliveries(context.slug)).find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "failed",
        terminal_reason: "delivery_failed",
      });
    } finally {
      context.serve.close();
    }
  });

  it("a late owner-answer reply cannot revive an ancestor terminally failed by origin retract", async () => {
    const context = await setupPendingDecision();
    try {
      const resolved = await respond(context.slug, context.owner.token, context.question.seq);
      expect(resolved.status).toBe(200);
      const responseSeq = ((await resolved.json()) as { reply: { seq: number } }).reply.seq;
      const ownerAnswer = (await deliveries(context.slug)).find((row) => row.cause === "owner_answer")!;

      expect((await retract(context.slug, context.owner.token, context.origin.seq)).status).toBe(200);
      const afterRetract = await deliveries(context.slug);
      expect(afterRetract.find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "failed",
        terminal_reason: "source_retracted",
        work_id: null,
        continuation_ref: null,
        parent_delivery_id: null,
        lease_connection_id: null,
        last_lease_connection_id: null,
        lease_adapter: null,
        lease_until: null,
      });
      expect(afterRetract.find((row) => row.id === ownerAnswer.id)).toMatchObject({
        state: "failed",
        terminal_reason: "source_retracted",
        work_id: null,
        continuation_ref: null,
        parent_delivery_id: null,
        lease_connection_id: null,
        last_lease_connection_id: null,
        lease_adapter: null,
        lease_until: null,
      });

      const lateReply = await api(`/api/channels/${context.slug}/messages`, context.agent.token, {
        method: "POST",
        body: JSON.stringify({
          kind: "message",
          body: "late completion after retract",
          mentions: [],
          reply_to: responseSeq,
        }),
      });
      expect(lateReply.status).toBe(200);
      const finalRows = await deliveries(context.slug);
      expect(finalRows.find((row) => row.id === context.source.delivery.id)?.state).toBe("failed");
      expect(finalRows.find((row) => row.id === ownerAnswer.id)?.state).toBe("failed");
    } finally {
      context.serve.close();
    }
  });

  it("onStart terminally closes a historical waiting_owner row with no exact pending question", async () => {
    const context = await setupPendingDecision();
    try {
      await inChannel(context.slug, (instance, sql) => {
        sql.exec(
          `UPDATE messages
              SET decision_request_json = NULL, decision_state = NULL
            WHERE seq = ?`,
          context.question.seq,
        );
        sql.exec("DELETE FROM meta WHERE key = 'retract_scrub_v3'");
        instance.onStart();
      });
      expect((await deliveries(context.slug)).find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "failed",
        terminal_reason: "orphaned_waiting_owner",
        work_id: null,
        continuation_ref: null,
        parent_delivery_id: null,
        lease_connection_id: null,
        last_lease_connection_id: null,
        lease_adapter: null,
        lease_until: null,
      });
    } finally {
      context.serve.close();
    }
  });

  it("still lets an exact late reply converge a typed unknown-outcome delivery", async () => {
    const context = await setupPendingDecision();
    try {
      await inChannel(context.slug, (_instance, sql) => {
        sql.exec(
          `UPDATE directed_deliveries
              SET state = 'failed', terminal_reason = 'unknown_outcome',
                  last_error = 'runner outcome unknown', lease_connection_id = NULL,
                  lease_adapter = NULL, lease_until = NULL
            WHERE id = ?`,
          context.source.delivery.id,
        );
      });
      const late = await api(`/api/channels/${context.slug}/messages`, context.agent.token, {
        method: "POST",
        body: JSON.stringify({
          kind: "message",
          body: "late success from the exact original principal",
          mentions: [],
          reply_to: context.origin.seq,
        }),
      });
      expect(late.status).toBe(200);
      expect((await deliveries(context.slug)).find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "replied",
        terminal_reason: null,
        last_error: null,
      });
    } finally {
      context.serve.close();
    }
  });

  it("reclassifies a revivable unknown-outcome row when its origin is later retracted", async () => {
    const context = await setupPendingDecision();
    try {
      await inChannel(context.slug, (_instance, sql) => {
        sql.exec(
          `UPDATE directed_deliveries
              SET state = 'failed', terminal_reason = 'unknown_outcome',
                  last_error = 'runner outcome unknown', lease_connection_id = NULL,
                  lease_adapter = NULL, lease_until = NULL
            WHERE id = ?`,
          context.source.delivery.id,
        );
      });
      expect((await retract(context.slug, context.owner.token, context.origin.seq)).status).toBe(200);
      expect((await deliveries(context.slug)).find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "failed",
        terminal_reason: "source_retracted",
        work_id: null,
        continuation_ref: null,
        parent_delivery_id: null,
        lease_connection_id: null,
        last_lease_connection_id: null,
        lease_adapter: null,
        lease_until: null,
      });
      expect((await messages(context.slug)).find((row) => row.seq === context.question.seq)).toMatchObject({
        decision_state: null,
        decision_request_json: null,
      });

      const late = await api(`/api/channels/${context.slug}/messages`, context.agent.token, {
        method: "POST",
        body: JSON.stringify({
          kind: "message",
          body: "late reply must not revive retracted unknown work",
          mentions: [],
          reply_to: context.origin.seq,
        }),
      });
      expect(late.status).toBe(200);
      expect((await deliveries(context.slug)).find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "failed",
        terminal_reason: "source_retracted",
      });
    } finally {
      context.serve.close();
    }
  });

  it("v3 scrubs a historical pending question and backfills a legacy retracted failure tombstone", async () => {
    const context = await setupPendingDecision();
    try {
      await inChannel(context.slug, (instance, sql) => {
        sql.exec(
          `UPDATE messages
              SET body = '[retracted]', mentions_json = '[]', retracted_at = ?
            WHERE seq = ?`,
          Date.now(),
          context.origin.seq,
        );
        sql.exec(
          `UPDATE directed_deliveries
              SET state = 'failed', last_error = 'source retracted, no retry',
                  terminal_reason = NULL, lease_connection_id = NULL,
                  lease_adapter = NULL, lease_until = NULL
            WHERE id = ?`,
          context.source.delivery.id,
        );
        sql.exec("DELETE FROM meta WHERE key = 'retract_scrub_v3'");
        instance.onStart();
      });
      expect((await messages(context.slug)).find((row) => row.seq === context.question.seq)).toMatchObject({
        decision_state: null,
        decision_request_json: null,
      });
      expect((await deliveries(context.slug)).find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "failed",
        last_error: "source retracted, no retry",
        terminal_reason: "source_retracted",
        work_id: null,
        continuation_ref: null,
        parent_delivery_id: null,
        lease_connection_id: null,
        last_lease_connection_id: null,
        lease_adapter: null,
        lease_until: null,
      });
    } finally {
      context.serve.close();
    }
  });

  it("v3 types a legacy source-retracted failure whose live origin cannot reveal erased question lineage", async () => {
    const context = await setupPendingDecision();
    try {
      await inChannel(context.slug, (instance, sql) => {
        sql.exec(
          `UPDATE messages
              SET body = '[retracted]', mentions_json = '[]', retracted_at = ?,
                  decision_request_json = NULL, decision_state = NULL
            WHERE seq = ?`,
          Date.now(),
          context.question.seq,
        );
        sql.exec(
          `UPDATE directed_deliveries
              SET state = 'failed', last_error = 'source retracted, no retry',
                  terminal_reason = NULL, lease_connection_id = NULL,
                  lease_adapter = NULL, lease_until = NULL
            WHERE id = ?`,
          context.source.delivery.id,
        );
        sql.exec("DELETE FROM meta WHERE key = 'retract_scrub_v3'");
        instance.onStart();
      });
      expect((await deliveries(context.slug)).find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "failed",
        terminal_reason: "source_retracted",
        work_id: null,
        continuation_ref: null,
        parent_delivery_id: null,
        lease_connection_id: null,
        last_lease_connection_id: null,
        lease_adapter: null,
        lease_until: null,
      });

      const late = await api(`/api/channels/${context.slug}/messages`, context.agent.token, {
        method: "POST",
        body: JSON.stringify({
          kind: "message",
          body: "legacy tombstone must remain non-revivable",
          mentions: [],
          reply_to: context.origin.seq,
        }),
      });
      expect(late.status).toBe(200);
      expect((await deliveries(context.slug)).find((row) => row.id === context.source.delivery.id)).toMatchObject({
        state: "failed",
        terminal_reason: "source_retracted",
      });
    } finally {
      context.serve.close();
    }
  });
});

describe("retract is a durable webhook persistence barrier", () => {
  it("an in-flight stale afterSend failure cannot recreate a retry after retract commits", async () => {
    const context = await createWebhookRaceFixture();
    fetchMock
      .get("https://retract-race.test")
      .intercept({ path: "/wake", method: "POST" })
      .reply(503, "down")
      .delay(120);

    const pending = inChannel(context.slug, (instance) =>
      (instance as unknown as WebhookTestSurface).dispatchWebhooks(context.stale),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await retract(context.slug, context.sender.token, context.seq)).status).toBe(200);
    await pending;
    expect(await webhookArtifactCounts(context.slug, context.seq)).toEqual({ queue: 0, dead: 0 });
  });

  it("an in-flight final retry failure cannot recreate a dead letter after retract commits", async () => {
    const context = await createWebhookRaceFixture();
    await inChannel(context.slug, (_instance, sql) => {
      const binding = sql
        .exec("SELECT registration_id FROM webhooks WHERE name = ?", context.name)
        .one();
      sql.exec(
        `INSERT INTO webhook_queue (
           webhook_name, registration_id, webhook_mode, target_owner,
           payload, attempts, next_retry_at
         ) VALUES (?, ?, 'notify', NULL, ?, ?, ?)`,
        context.name,
        String(binding.registration_id),
        JSON.stringify(context.stale),
        WEBHOOK_MAX_RETRIES,
        Date.now() - 1,
      );
    });
    fetchMock
      .get("https://retract-race.test")
      .intercept({ path: "/wake", method: "POST" })
      .reply(503, "still down")
      .delay(120);

    const pending = inChannel(context.slug, (instance) =>
      (instance as unknown as WebhookTestSurface).retryWebhooks(Date.now()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await retract(context.slug, context.sender.token, context.seq)).status).toBe(200);
    await pending;
    expect(await webhookArtifactCounts(context.slug, context.seq)).toEqual({ queue: 0, dead: 0 });
  });

  it("an in-flight moderator redelivery cannot restore a dead letter after retract commits", async () => {
    const context = await createWebhookRaceFixture();
    await inChannel(context.slug, (_instance, sql) => {
      const binding = sql
        .exec("SELECT registration_id FROM webhooks WHERE name = ?", context.name)
        .one();
      sql.exec(
        `INSERT INTO webhook_dead_letters (
           webhook_name, registration_id, webhook_mode, target_owner, mention_seq,
           payload, attempts, last_status, last_error, dead_lettered_at
         ) VALUES (?, ?, 'notify', NULL, ?, ?, 3, 503, 'legacy failure', ?)`,
        context.name,
        String(binding.registration_id),
        context.seq,
        JSON.stringify(context.stale),
        Date.now(),
      );
    });
    fetchMock
      .get("https://retract-race.test")
      .intercept({ path: "/wake", method: "POST" })
      .reply(503, "still down")
      .delay(120);

    const pending = inChannel(context.slug, (instance) =>
      (instance as unknown as WebhookTestSurface).redeliverDeadLetters(context.name),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await retract(context.slug, context.sender.token, context.seq)).status).toBe(200);
    await pending;
    expect(await webhookArtifactCounts(context.slug, context.seq)).toEqual({ queue: 0, dead: 0 });
  });

  it("onStart idempotently scrubs historical queue and dead-letter rows for retracted messages", async () => {
    const context = await createWebhookRaceFixture();
    expect((await retract(context.slug, context.sender.token, context.seq)).status).toBe(200);
    await inChannel(context.slug, (instance, sql) => {
      const binding = sql
        .exec("SELECT registration_id FROM webhooks WHERE name = ?", context.name)
        .one();
      const payload = JSON.stringify(context.stale);
      sql.exec(
        `INSERT INTO webhook_queue (
           webhook_name, registration_id, webhook_mode, target_owner,
           payload, attempts, next_retry_at
         ) VALUES (?, ?, 'notify', NULL, ?, 1, ?)`,
        context.name,
        String(binding.registration_id),
        payload,
        Date.now() + 60_000,
      );
      sql.exec(
        `INSERT INTO webhook_dead_letters (
           webhook_name, registration_id, webhook_mode, target_owner, mention_seq,
           payload, attempts, last_status, last_error, dead_lettered_at
         ) VALUES (?, ?, 'notify', NULL, ?, ?, 3, 503, 'legacy failure', ?)`,
        context.name,
        String(binding.registration_id),
        context.seq,
        payload,
        Date.now(),
      );
      sql.exec("DELETE FROM meta WHERE key = 'retract_scrub_v3'");
      instance.onStart();
    });
    expect(await webhookArtifactCounts(context.slug, context.seq)).toEqual({ queue: 0, dead: 0 });
  });
});
