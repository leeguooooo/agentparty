import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, createChannel, postMessage, seedToken, uniq } from "./helpers";

interface MsgLike {
  seq: number;
  body: string;
  mentions?: string[];
  note?: string | null;
  edited?: true;
  retracted?: true;
  supersedes?: number;
  superseded_by?: number;
  revision?: { original_body: string | null };
}

interface AuditLike {
  target_seq: number;
  action: string;
  actor: { name: string; kind: string };
  old_body: string | null;
  new_body: string | null;
  original_byte_length: number | null;
  created_at: number;
}

async function scopedFixture() {
  const acct = `${uniq("acct")}@leeguoo.com`;
  const owner = await seedToken("agent", uniq("owner"), { owner: acct });
  const slug = await createChannel(owner.token);
  const writer = await seedToken("agent", uniq("writer"), { owner: acct, channelScope: slug });
  const other = await seedToken("agent", uniq("other"), { owner: acct, channelScope: slug });
  return { acct, slug, owner, writer, other };
}

describe("message edit/retract/supersede", () => {
  it("lets the sender edit with audit fields and blocks a non-moderator", async () => {
    const { slug, writer, other } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "wrong body");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const denied = await api(`/api/channels/${slug}/messages/${seq}/edit`, other.token, {
      method: "POST",
      body: JSON.stringify({ body: "hijack" }),
    });
    expect(denied.status).toBe(403);

    const edited = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "correct body" }),
    });
    expect(edited.status).toBe(200);
    const editBody = (await edited.json()) as { message: MsgLike };
    expect(editBody.message).toMatchObject({
      seq,
      body: "correct body",
      edited: true,
      revision: { original_body: "wrong body" },
    });

    const history = await api(`/api/channels/${slug}/messages?since=0`, writer.token);
    const messages = ((await history.json()) as { messages: MsgLike[] }).messages;
    expect(messages[0]).toMatchObject({ seq, body: "correct body", edited: true });

    const audit = await api(`/api/channels/${slug}/messages/${seq}/audit`, writer.token);
    expect(audit.status).toBe(200);
    expect((await audit.json()) as { audit: unknown[] }).toMatchObject({
      audit: [{ target_seq: seq, action: "edit", old_body: "wrong body", new_body: "correct body" }],
    });
  });

  it("routes body-derived agent mentions added by an edit into durable work", async () => {
    const { slug, writer, other } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "plain draft");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const edited = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: `请@${other.name}处理这个问题` }),
    });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { message: MsgLike }).message).toMatchObject({
      seq,
      body: `请@${other.name}处理这个问题`,
      mentions: [other.name],
      edited: true,
    });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const deliveries = state.storage.sql
        .exec(
          `SELECT message_seq, target_name, cause, state, target_owner
             FROM directed_deliveries WHERE message_seq = ?`,
          seq,
        )
        .toArray();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        message_seq: seq,
        target_name: other.name,
        cause: "mention_edit",
        state: "queued",
        target_owner: expect.any(String),
      });
    });
  });

  it("does not redeliver a preserved pre-v1 mention while routing a genuinely added target", async () => {
    const { acct, slug, writer, other } = await scopedFixture();
    const added = await seedToken("agent", uniq("added"), { owner: acct, channelScope: slug });
    const sent = await postMessage(slug, writer.token, `@${other.name} legacy wording`);
    const seq = ((await sent.json()) as { seq: number }).seq;
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));

    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      // Model a message created before durable delivery rows and compact target tombstones existed.
      state.storage.sql.exec("DELETE FROM directed_deliveries WHERE message_seq = ?", seq);
      state.storage.sql.exec("UPDATE messages SET delivery_targets_json = '[]' WHERE seq = ?", seq);
    });

    const edited = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: `@${other.name} wording changed; @${added.name} newly assigned` }),
    });
    expect(edited.status).toBe(200);

    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const deliveries = state.storage.sql
        .exec(
          `SELECT target_name, cause
             FROM directed_deliveries WHERE message_seq = ?
             ORDER BY target_name`,
          seq,
        )
        .toArray();
      expect(deliveries).toEqual([{ target_name: added.name, cause: "mention_edit" }]);
      const tombstone = JSON.parse(String(state.storage.sql.exec(
        "SELECT delivery_targets_json FROM messages WHERE seq = ?",
        seq,
      ).one().delivery_targets_json)) as string[];
      expect(tombstone.sort()).toEqual([added.name, other.name].sort());
    });
  });

  it("rejects unknown edited mentions without changing the message or audit", async () => {
    const { slug, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "keep this body");
    const seq = ((await sent.json()) as { seq: number }).seq;
    const missing = uniq("missing-agent");

    const edited = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: `请@${missing}处理` }),
    });
    expect(edited.status).toBe(400);
    expect(await edited.json()).toMatchObject({ error: { code: "mention_not_found" } });

    const history = await api(`/api/channels/${slug}/messages?since=0`, writer.token);
    const messages = ((await history.json()) as { messages: MsgLike[] }).messages;
    expect(messages.find((message) => message.seq === seq)).toMatchObject({
      body: "keep this body",
      mentions: [],
    });
    const audit = await api(`/api/channels/${slug}/messages/${seq}/audit`, writer.token);
    expect((await audit.json()) as { audit: unknown[] }).toEqual({ audit: [] });
  });

  it("rejects removing an already-routed target instead of silently detaching its work", async () => {
    const { slug, writer, other } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, `@${other.name} original work`);
    const seq = ((await sent.json()) as { seq: number }).seq;

    const edited = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "remove the routed target" }),
    });
    expect(edited.status).toBe(400);
    expect(await edited.json()).toMatchObject({
      error: { code: "bad_request", message: expect.stringContaining("retract or supersede") },
    });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const message = state.storage.sql.exec("SELECT body, mentions_json FROM messages WHERE seq = ?", seq).one();
      expect(message).toMatchObject({ body: `@${other.name} original work` });
      expect(JSON.parse(String(message.mentions_json))).toEqual([other.name]);
      const delivery = state.storage.sql
        .exec("SELECT target_name, state FROM directed_deliveries WHERE message_seq = ?", seq)
        .one();
      expect(delivery).toMatchObject({ target_name: other.name, state: "queued" });
    });
  });

  it("keeps an exactly-once target tombstone after terminal delivery retention prunes the row", async () => {
    const { slug, writer, other } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, `@${other.name} original retained work`);
    const seq = ((await sent.json()) as { seq: number }).seq;
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec(
        `UPDATE directed_deliveries
            SET state = 'replied', lease_connection_id = NULL, lease_adapter = NULL,
                lease_until = NULL, updated_at = ?
          WHERE message_seq = ?`,
        Date.now() - 8 * 24 * 60 * 60 * 1000,
        seq,
      );
      await instance.onAlarm();
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM directed_deliveries WHERE message_seq = ?",
        seq,
      ).one().n)).toBe(0);
      expect(JSON.parse(String(state.storage.sql.exec(
        "SELECT delivery_targets_json FROM messages WHERE seq = ?",
        seq,
      ).one().delivery_targets_json))).toEqual([other.name]);
    });

    const edited = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: `@${other.name} wording changed, work identity unchanged` }),
    });
    expect(edited.status).toBe(200);

    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM directed_deliveries WHERE message_seq = ?",
        seq,
      ).one().n)).toBe(0);
    });

    const removal = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "do not recreate or silently detach retained work" }),
    });
    expect(removal.status).toBe(400);
    expect(await removal.json()).toMatchObject({
      error: { code: "bad_request", message: expect.stringContaining("retract or supersede") },
    });
  });

  it("repairs malformed legacy tombstones without re-identifying retracted or erased messages", async () => {
    const { slug, writer, other } = await scopedFixture();
    const normal = await postMessage(slug, writer.token, `@${other.name} legacy normal`);
    const normalSeq = ((await normal.json()) as { seq: number }).seq;
    const retracted = await postMessage(slug, writer.token, `@${other.name} legacy retracted`);
    const retractedSeq = ((await retracted.json()) as { seq: number }).seq;
    const erased = await postMessage(slug, writer.token, `@${other.name} legacy erased`);
    const erasedSeq = ((await erased.json()) as { seq: number }).seq;

    expect((await api(`/api/channels/${slug}/messages/${retractedSeq}/retract`, writer.token, {
      method: "POST",
    })).status).toBe(200);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      // Model the upgrade state: one legacy row has a malformed compact tombstone, while
      // retraction/GDPR scrubbing is authoritative and must remain empty on restart.
      state.storage.sql.exec(
        "UPDATE messages SET delivery_targets_json = '[]' WHERE seq IN (?, ?)",
        retractedSeq,
        erasedSeq,
      );
      state.storage.sql.exec(
        "UPDATE messages SET delivery_targets_json = '{broken' WHERE seq = ?",
        normalSeq,
      );
      state.storage.sql.exec(
        "UPDATE messages SET body = '[erased]', mentions_json = '[]' WHERE seq = ?",
        erasedSeq,
      );
      instance.onStart();

      const rows = state.storage.sql.exec(
        "SELECT seq, delivery_targets_json FROM messages WHERE seq IN (?, ?, ?) ORDER BY seq",
        normalSeq,
        retractedSeq,
        erasedSeq,
      ).toArray();
      expect(rows.map((row) => ({
        seq: Number(row.seq),
        targets: JSON.parse(String(row.delivery_targets_json)),
      }))).toEqual([
        { seq: normalSeq, targets: [other.name] },
        { seq: retractedSeq, targets: [] },
        { seq: erasedSeq, targets: [] },
      ]);
    });
  });

  it("moderator edit response projects stored decision lineage to public fields", async () => {
    const { slug, owner, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "question draft");
    const seq = ((await sent.json()) as { seq: number }).seq;
    const lineage = {
      delivery_id: `delivery-${crypto.randomUUID()}`,
      origin_seq: seq,
      origin_channel: slug,
      work_id: `work-${crypto.randomUUID()}`,
      continuation_ref: `continuation-${crypto.randomUUID()}`,
    };
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE messages SET decision_request_json = ?, decision_state = 'pending' WHERE seq = ?",
        JSON.stringify({ kind: "approval", prompt: "ship?", options: ["approve", "reject"], ...lineage }),
        seq,
      );
    });

    const edited = await api(`/api/channels/${slug}/messages/${seq}/edit`, owner.token, {
      method: "POST",
      body: JSON.stringify({ body: "moderator-corrected question" }),
    });
    expect(edited.status).toBe(200);
    const response = (await edited.json()) as { message: { decision_request?: Record<string, unknown> } };
    expect(response.message.decision_request).toMatchObject({
      kind: "approval",
      prompt: "ship?",
      options: ["approve", "reject"],
    });
    for (const key of ["delivery_id", "origin_seq", "origin_channel", "work_id", "continuation_ref"]) {
      expect(response.message.decision_request).not.toHaveProperty(key);
    }
    const serialized = JSON.stringify(response);
    for (const secret of [lineage.delivery_id, lineage.work_id, lineage.continuation_ref]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("scrubs a retracted message from responses, live/replay frames, history, search, and public audit", async () => {
    const { slug, owner, writer } = await scopedFixture();
    const secret = "needle 🔐 secret";
    const sent = await postMessage(slug, writer.token, secret);
    const seq = ((await sent.json()) as { seq: number }).seq;
    const payloadSecrets = [
      "future-scope-secret",
      "future-blocked-secret",
      "future-context-secret",
      "future-decision-secret",
      "future-status-workflow-secret",
      "future-message-workflow-secret",
      "future-reviewer-secret",
      "future-review-secret",
      "future-decision-prompt-secret",
      "future-decision-reason-secret",
      "future-decision-response-secret",
    ];
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec(
        `UPDATE messages
            SET status_scope_json = ?, status_blocked_reason = ?, status_context_json = ?, status_decision_json = ?,
                status_workflow_json = ?, message_workflow_json = ?, completion_artifact_json = ?,
                completion_review_state = 'rejected', completion_review_policy = 'sender',
                completion_reviewed_by = ?, completion_reviewed_by_kind = 'agent', completion_review_reason = ?,
                decision_request_json = ?, decision_state = 'resolved',
                decision_resolution_json = ?, decision_response_json = ?
          WHERE seq = ?`,
        JSON.stringify([payloadSecrets[0]]),
        payloadSecrets[1],
        JSON.stringify({ config_kind: "explicit", workspace_label: payloadSecrets[2] }),
        JSON.stringify({ kind: "handoff", decision: payloadSecrets[3], next: "stop" }),
        JSON.stringify({ workflow_id: payloadSecrets[4], kind: "orchestrator-workers" }),
        JSON.stringify({ workflow_id: payloadSecrets[5], kind: "orchestrator-workers" }),
        JSON.stringify({ kind: "final_synthesis", kickoff_seq: seq, replies_count: 1, timeout: false, related_issues: [], related_prs: [] }),
        payloadSecrets[6],
        payloadSecrets[7],
        JSON.stringify({ kind: "approval", prompt: payloadSecrets[8], options: ["approve", "reject"] }),
        JSON.stringify({ state: "resolved", reason: payloadSecrets[9] }),
        JSON.stringify({ request_seq: seq, chosen_index: 0, chosen_option: "approve", reason: payloadSecrets[10] }),
        seq,
      );
    });
    const live = await WsClient.open(slug, writer.token);
    await live.nextOfType("welcome");
    live.send({ type: "hello", since: seq });
    live.send({ type: "ping" });
    await live.nextOfType("pong");

    const retracted = await api(`/api/channels/${slug}/messages/${seq}/retract`, owner.token, { method: "POST" });
    expect(retracted.status).toBe(200);
    const responseMessage = ((await retracted.json()) as { message: MsgLike }).message;
    expect(responseMessage).toMatchObject({ seq, body: "[retracted]", note: null, retracted: true });
    expect(responseMessage).not.toHaveProperty("revision");
    for (const value of payloadSecrets) expect(JSON.stringify(responseMessage)).not.toContain(value);

    const update = await live.nextOfType("message_update");
    expect(update).toMatchObject({
      action: "retract",
      target_seq: seq,
      message: { seq, body: "[retracted]", note: null, retracted: true },
    });
    expect(update.message).not.toHaveProperty("revision");
    for (const value of payloadSecrets) expect(JSON.stringify(update)).not.toContain(value);
    live.close();

    const replay = await WsClient.open(slug, writer.token);
    await replay.nextOfType("welcome");
    replay.send({ type: "hello", since: seq });
    const replayed = await replay.nextOfType("msg");
    expect(replayed).toMatchObject({ seq, body: "[retracted]", note: null, retracted: true });
    expect(replayed).not.toHaveProperty("revision");
    for (const value of payloadSecrets) expect(JSON.stringify(replayed)).not.toContain(value);
    replay.close();

    const history = await api(`/api/channels/${slug}/messages?since=0`, writer.token);
    const historical = ((await history.json()) as { messages: MsgLike[] }).messages.find((message) => message.seq === seq);
    expect(historical).toMatchObject({ seq, body: "[retracted]", note: null, retracted: true });
    expect(historical).not.toHaveProperty("revision");
    for (const value of payloadSecrets) expect(JSON.stringify(historical)).not.toContain(value);

    const search = await api(`/api/channels/${slug}/search?q=needle`, writer.token);
    expect(search.status).toBe(200);
    expect(((await search.json()) as { hits: unknown[] }).hits).toEqual([]);

    const audit = await api(`/api/channels/${slug}/messages/${seq}/audit`, owner.token);
    expect(audit.status).toBe(200);
    const auditPayload = (await audit.json()) as { audit: AuditLike[] };
    expect(auditPayload).toMatchObject({
      audit: [
        {
          target_seq: seq,
          action: "retract",
          actor: { name: owner.name, kind: "agent" },
          old_body: null,
          new_body: null,
          original_byte_length: new TextEncoder().encode(secret).byteLength,
          created_at: expect.any(Number),
        },
      ],
    });
    for (const value of [secret, ...payloadSecrets]) expect(JSON.stringify(auditPayload)).not.toContain(value);

    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const row = state.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
      expect(row).toMatchObject({
        body: "[retracted]",
        note: null,
        original_body: null,
        status_scope_json: null,
        status_blocked_reason: null,
        status_context_json: null,
        status_decision_json: null,
        status_workflow_json: null,
        message_workflow_json: null,
        completion_artifact_json: null,
        completion_review_state: null,
        completion_review_policy: null,
        completion_reviewed_by: null,
        completion_reviewed_by_kind: null,
        completion_reviewed_by_owner: null,
        completion_reviewed_at: null,
        completion_review_reason: null,
        decision_request_json: null,
        decision_state: null,
        decision_resolution_json: null,
        decision_response_json: null,
      });
      const audits = state.storage.sql
        .exec("SELECT old_body, new_body FROM message_audit WHERE target_seq = ?", seq)
        .toArray();
      expect(audits.every((entry) => entry.old_body === null && entry.new_body === null)).toBe(true);
    });
  });

  it("scrubs original and edited bodies when an edited message is retracted", async () => {
    const { slug, writer } = await scopedFixture();
    const original = "first secret";
    const editedBody = "second secret";
    const sent = await postMessage(slug, writer.token, original);
    const seq = ((await sent.json()) as { seq: number }).seq;

    expect((await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: editedBody }),
    })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages/${seq}/retract`, writer.token, { method: "POST" })).status).toBe(200);

    const history = await api(`/api/channels/${slug}/messages?since=0`, writer.token);
    expect(JSON.stringify(await history.json())).not.toContain(original);
    const audit = await api(`/api/channels/${slug}/messages/${seq}/audit`, writer.token);
    const auditBody = (await audit.json()) as { audit: AuditLike[] };
    expect(JSON.stringify(auditBody)).not.toContain(original);
    expect(JSON.stringify(auditBody)).not.toContain(editedBody);
    expect(auditBody.audit).toHaveLength(2);
    expect(auditBody.audit.every((entry) => entry.old_body === null && entry.new_body === null)).toBe(true);
    expect(auditBody.audit.find((entry) => entry.action === "retract")).toMatchObject({
      original_byte_length: new TextEncoder().encode(original).byteLength,
    });
  });

  it("idempotently backfills stored retractions and their historical audit bodies on start", async () => {
    const { slug, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "seed");
    const seq = ((await sent.json()) as { seq: number }).seq;
    const original = "stored original 🔐";
    const current = "stored current secret";
    const note = "stored note secret";
    const storedPayloadSecrets = [
      "stored-scope-secret",
      "stored-blocked-secret",
      "stored-context-secret",
      "stored-decision-secret",
      "stored-status-workflow-secret",
      "stored-message-workflow-secret",
      "stored-reviewer-secret",
      "stored-review-secret",
      "stored-decision-prompt-secret",
      "stored-decision-reason-secret",
      "stored-decision-response-secret",
    ];
    const orphanSecret = "pruned message secret";
    const orphanSeq = seq + 100;
    const now = Date.now();
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec(
        `UPDATE messages
            SET kind = 'status', state = 'blocked', body = ?, note = ?, original_body = ?,
                status_scope_json = ?, status_blocked_reason = ?, status_context_json = ?, status_decision_json = ?,
                status_workflow_json = ?, message_workflow_json = ?, completion_artifact_json = ?,
                completion_review_state = 'rejected', completion_review_policy = 'sender',
                completion_reviewed_by = ?, completion_reviewed_by_kind = 'agent', completion_review_reason = ?,
                decision_request_json = ?, decision_state = 'resolved',
                decision_resolution_json = ?, decision_response_json = ?,
                edited_at = ?, edited_by = ?, retracted_at = ?, retracted_by = ?
          WHERE seq = ?`,
        current,
        note,
        original,
        JSON.stringify([storedPayloadSecrets[0]]),
        storedPayloadSecrets[1],
        JSON.stringify({ config_kind: "explicit", workspace_label: storedPayloadSecrets[2] }),
        JSON.stringify({ kind: "handoff", decision: storedPayloadSecrets[3], next: "stop" }),
        JSON.stringify({ workflow_id: storedPayloadSecrets[4], kind: "orchestrator-workers" }),
        JSON.stringify({ workflow_id: storedPayloadSecrets[5], kind: "orchestrator-workers" }),
        JSON.stringify({ kind: "final_synthesis", kickoff_seq: seq, replies_count: 1, timeout: false, related_issues: [], related_prs: [] }),
        storedPayloadSecrets[6],
        storedPayloadSecrets[7],
        JSON.stringify({ kind: "approval", prompt: storedPayloadSecrets[8], options: ["approve", "reject"] }),
        JSON.stringify({ state: "resolved", reason: storedPayloadSecrets[9] }),
        JSON.stringify({ request_seq: seq, chosen_index: 0, chosen_option: "approve", reason: storedPayloadSecrets[10] }),
        now - 1,
        writer.name,
        now,
        writer.name,
        seq,
      );
      state.storage.sql.exec(
        `INSERT INTO message_audit (target_seq, action, actor_name, actor_kind, old_body, new_body, created_at)
         VALUES (?, 'edit', ?, 'agent', ?, ?, ?), (?, 'retract', ?, 'agent', ?, NULL, ?)`,
        seq,
        writer.name,
        original,
        current,
        now - 1,
        seq,
        writer.name,
        current,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO message_audit (target_seq, action, actor_name, actor_kind, old_body, new_body, created_at)
         VALUES (?, 'retract', ?, 'agent', ?, NULL, ?)`,
        orphanSeq,
        writer.name,
        orphanSecret,
        now,
      );
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'retract_scrub_v1'");
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'retract_scrub_v2'");

      instance.onStart();
      instance.onStart();

      const message = state.storage.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one();
      expect(message).toMatchObject({
        state: null,
        body: "[retracted]",
        note: null,
        original_body: null,
        status_scope_json: null,
        status_blocked_reason: null,
        status_context_json: null,
        status_decision_json: null,
        status_workflow_json: null,
        message_workflow_json: null,
        completion_artifact_json: null,
        completion_review_state: null,
        completion_review_policy: null,
        completion_reviewed_by: null,
        completion_reviewed_by_kind: null,
        completion_reviewed_by_owner: null,
        completion_reviewed_at: null,
        completion_review_reason: null,
        decision_request_json: null,
        decision_state: null,
        decision_resolution_json: null,
        decision_response_json: null,
      });
      const audits = state.storage.sql.exec("SELECT * FROM message_audit WHERE target_seq = ? ORDER BY id", seq).toArray();
      expect(audits).toHaveLength(2);
      expect(audits.every((entry) => entry.old_body === null && entry.new_body === null)).toBe(true);
      expect(audits.find((entry) => entry.action === "retract")?.original_byte_length).toBe(
        new TextEncoder().encode(original).byteLength,
      );
      const orphan = state.storage.sql.exec("SELECT * FROM message_audit WHERE target_seq = ?", orphanSeq).one();
      expect(orphan).toMatchObject({
        old_body: null,
        new_body: null,
        original_byte_length: new TextEncoder().encode(orphanSecret).byteLength,
      });
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'retract_scrub_v1'").one().value).toBe("1");
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'retract_scrub_v2'").one().value).toBe("1");
    });

    const history = await api(`/api/channels/${slug}/messages?since=0`, writer.token);
    const audit = await api(`/api/channels/${slug}/messages/${seq}/audit`, writer.token);
    for (const payload of [await history.text(), await audit.text()]) {
      expect(payload).not.toContain(original);
      expect(payload).not.toContain(current);
      expect(payload).not.toContain(note);
      for (const value of storedPayloadSecrets) expect(payload).not.toContain(value);
    }
    const replay = await WsClient.open(slug, writer.token);
    await replay.nextOfType("welcome");
    replay.send({ type: "hello", since: seq });
    const replayed = await replay.nextOfType("status");
    expect(replayed).toMatchObject({ seq, body: "[retracted]", state: null, note: null, status: null, retracted: true });
    for (const value of storedPayloadSecrets) expect(JSON.stringify(replayed)).not.toContain(value);
    replay.close();
    const orphanAudit = await api(`/api/channels/${slug}/messages/${orphanSeq}/audit`, writer.token);
    expect(await orphanAudit.text()).not.toContain(orphanSecret);
  });

  it("supersedes with a new linked message", async () => {
    const { slug, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "old claim");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const supersede = await api(`/api/channels/${slug}/messages/${seq}/supersede`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "new claim" }),
    });
    expect(supersede.status).toBe(200);
    const body = (await supersede.json()) as { message: MsgLike; superseded: MsgLike };
    expect(body.message).toMatchObject({ seq: seq + 1, body: "new claim", supersedes: seq });
    expect(body.superseded).toMatchObject({ seq, superseded_by: seq + 1 });
  });

  it("broadcasts message_update for live clients", async () => {
    const { slug, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "live wrong");
    const seq = ((await sent.json()) as { seq: number }).seq;
    const ws = await WsClient.open(slug, writer.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: seq });
    ws.send({ type: "ping" });
    await ws.nextOfType("pong");

    const edit = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "live correct" }),
    });
    expect(edit.status).toBe(200);
    const update = await ws.nextOfType("message_update");
    expect(update).toMatchObject({
      type: "message_update",
      target_seq: seq,
      action: "edit",
      message: { seq, body: "live correct", edited: true },
    });
    ws.close();
  });
});
