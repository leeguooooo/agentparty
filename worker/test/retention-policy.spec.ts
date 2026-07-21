// #421: D1-authoritative retention policy + DO alarm physical deletion.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type ChannelDO, DIRECTED_DELIVERY_MAX_AGE_MS, DIRECTED_DELIVERY_QUEUED_TIMEOUT_MS } from "../src/do";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

describe("channel retention policy (#421)", () => {
  it("mirrors policy to the DO and physically deletes expired message/audit/R2 data", async () => {
    const account = `${uniq("retention")}@example.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: account });
    const slug = await createChannel(owner.token);
    const target = await seedToken("agent", uniq("target"), { owner: account, channelScope: slug });
    const oldResponse = await postMessage(slug, owner.token, `@${target.name} expired secret`);
    const oldSeq = ((await oldResponse.json()) as { seq: number }).seq;
    const freshResponse = await postMessage(slug, target.token, "fresh pending question");
    const freshSeq = ((await freshResponse.json()) as { seq: number }).seq;

    const update = await api(`/api/channels/${slug}/retention`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ message_retention_ms: 60_000, audit_retention_ms: 120_000 }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({ message_retention_ms: 60_000, audit_retention_ms: 120_000 });

    const attachmentKey = `${slug}/expired-object`;
    await env.ATTACHMENTS.put(attachmentKey, "secret");
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "UPDATE messages SET ts = ?, attachments_json = ? WHERE seq = ?",
        now - 61_000,
        JSON.stringify([{ key: attachmentKey, filename: "secret.txt", content_type: "text/plain", size: 6, url: `/api/channels/${slug}/attachments/expired-object` }]),
        oldSeq,
      );
      state.storage.sql.exec("UPDATE messages SET ts = ? WHERE seq = ?", now, freshSeq);
      const source = state.storage.sql
        .exec("SELECT id, work_id, continuation_ref FROM directed_deliveries WHERE message_seq = ?", oldSeq)
        .one();
      state.storage.sql.exec(
        `UPDATE directed_deliveries
            SET state = 'waiting_owner', lease_connection_id = NULL, lease_adapter = NULL,
                lease_until = NULL, updated_at = ?
          WHERE id = ?`,
        now - 61_000,
        source.id,
      );
      state.storage.sql.exec(
        `UPDATE messages
            SET reply_to = ?, decision_state = 'pending', decision_request_json = ?
          WHERE seq = ?`,
        oldSeq,
        JSON.stringify({
          kind: "approval",
          prompt: "retain this question?",
          options: ["approve", "reject"],
          delivery_id: source.id,
          origin_seq: oldSeq,
          origin_channel: slug,
          work_id: source.work_id,
          continuation_ref: source.continuation_ref,
        }),
        freshSeq,
      );
      state.storage.sql.exec(
        `INSERT INTO message_audit (target_seq, action, actor_name, actor_kind, old_body, new_body, created_at)
         VALUES (?, 'edit', ?, 'agent', 'expired audit', 'expired audit 2', ?),
                (?, 'edit', ?, 'agent', 'fresh audit', 'fresh audit 2', ?)`,
        oldSeq,
        owner.name,
        now - 121_000,
        freshSeq,
        owner.name,
        now,
      );
      state.storage.sql.exec(
        "INSERT INTO webhook_queue (webhook_name, payload, next_retry_at) VALUES ('hook', ?, ?)",
        JSON.stringify({ seq: oldSeq, body: "expired secret" }),
        now + 60_000,
      );

      await instance.onAlarm();

      expect(state.storage.sql.exec("SELECT seq FROM messages ORDER BY seq").toArray().map((r) => Number(r.seq)))
        .toEqual([freshSeq]);
      expect(state.storage.sql.exec("SELECT target_seq FROM message_audit ORDER BY target_seq").toArray().map((r) => Number(r.target_seq)))
        .toEqual([freshSeq]);
      expect(Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM webhook_queue").one().n)).toBe(0);
      expect(Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM directed_deliveries").one().n)).toBe(0);
      expect(state.storage.sql.exec("SELECT decision_state, decision_request_json FROM messages WHERE seq = ?", freshSeq).one())
        .toMatchObject({ decision_state: null, decision_request_json: null });
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'message_retention_ms'").one().value).toBe("60000");
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'audit_retention_ms'").one().value).toBe("120000");
    });
    expect(await env.ATTACHMENTS.head(attachmentKey)).toBeNull();

    const channel = await env.DB.prepare(
      "SELECT message_retention_ms, audit_retention_ms FROM channels WHERE slug = ?",
    ).bind(slug).first<{ message_retention_ms: number; audit_retention_ms: number }>();
    expect(channel).toEqual({ message_retention_ms: 60_000, audit_retention_ms: 120_000 });
    const audit = await env.DB.prepare(
      "SELECT action, metadata_json FROM management_audit WHERE channel = ? AND action = 'channel.retention.update'",
    ).bind(slug).first<{ action: string; metadata_json: string }>();
    expect(audit?.action).toBe("channel.retention.update");
    expect(JSON.parse(audit!.metadata_json)).toEqual({ message_retention_ms: 60_000, audit_retention_ms: 120_000 });
    const reconcile = await api(`/api/channels/${slug}/reconcile`, owner.token);
    expect(reconcile.status).toBe(200);
    expect((await reconcile.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("rejects non-moderators and invalid windows without changing D1", async () => {
    const account = `${uniq("retention")}@example.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: account });
    const slug = await createChannel(owner.token);
    const member = await seedToken("agent", uniq("member"), { owner: account, channelScope: slug });
    expect((await api(`/api/channels/${slug}/retention`, member.token, {
      method: "PUT", body: JSON.stringify({ message_retention_ms: 60_000 }),
    })).status).toBe(403);
    expect((await api(`/api/channels/${slug}/retention`, owner.token, {
      method: "PUT", body: JSON.stringify({ message_retention_ms: 59_999 }),
    })).status).toBe(400);
    const row = await env.DB.prepare(
      "SELECT message_retention_ms, audit_retention_ms FROM channels WHERE slug = ?",
    ).bind(slug).first<{ message_retention_ms: number | null; audit_retention_ms: number | null }>();
    expect(row).toEqual({ message_retention_ms: null, audit_retention_ms: null });

    const off = await api(`/api/channels/${slug}/retention`, owner.token, {
      method: "PUT", body: JSON.stringify({ message_retention_ms: null, audit_retention_ms: null }),
    });
    expect(off.status).toBe(200);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'message_retention_ms'").one().value).toBe("off");
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'audit_retention_ms'").one().value).toBe("off");
    });
    expect(((await (await api(`/api/channels/${slug}/reconcile`, owner.token)).json()) as { ok: boolean }).ok).toBe(true);
  });

  it("bounds abandoned durable work even when message history retention is off", async () => {
    const account = `${uniq("delivery-retention")}@example.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: account });
    const slug = await createChannel(owner.token);
    const target = await seedToken("agent", uniq("target"), { owner: account, channelScope: slug });
    // #667：暂停接待让这条 queued 投递成为 owner 主动持债的持久工作——10 分钟排队超时闸会跳过它，
    // 于是仍能验证 30 天 delivery_expired 兜底与 7 天终态保留这条更慢的路径（未暂停的死目标已由
    // undelivered_timeout 在 10 分钟收敛，另有独立用例覆盖）。
    // 关键：既然 failStale 永远跳过 paused 目标，排队超时闸就绝不能把它算进 alarm 候选——否则 10 分钟
    // 到点后每秒空转重挂（本用例正守住这条：初始 alarm 应落在 30 天 delivery_expired 兜底，而非 10 分钟线）。
    const paused = await api(`/api/channels/${slug}/presence/${encodeURIComponent(target.name)}/pause`, owner.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(paused.status).toBe(200);
    const sent = await postMessage(slug, owner.token, `@${target.name} keep the history, expire the work`);
    const seq = ((await sent.json()) as { seq: number }).seq;
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      const createdAt = Number(state.storage.sql.exec(
        "SELECT created_at FROM directed_deliveries WHERE message_seq = ?",
        seq,
      ).one().created_at);
      // Simulate an upgraded DO whose historical queued row predates deadline scheduling.
      await state.storage.deleteAlarm();
      instance.onStart();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const initialAlarm = await state.storage.getAlarm();
      expect(initialAlarm).not.toBeNull();
      // #667：paused 目标的 queued 行被排队超时闸排除（否则 10 分钟后每秒空转），故初始 alarm 落在
      // 30 天 delivery_expired 兜底，而非 10 分钟排队超时线。
      expect(Math.abs(initialAlarm! - (createdAt + DIRECTED_DELIVERY_MAX_AGE_MS))).toBeLessThan(1_000);
      // 且明确不是 10 分钟排队超时线（回归守卫：paused 不再触发短周期重挂）。
      expect(Math.abs(initialAlarm! - (createdAt + DIRECTED_DELIVERY_QUEUED_TIMEOUT_MS))).toBeGreaterThan(1_000);
      state.storage.sql.exec(
        "UPDATE directed_deliveries SET created_at = ?, updated_at = ? WHERE message_seq = ?",
        now - 31 * 24 * 60 * 60 * 1000,
        now - 31 * 24 * 60 * 60 * 1000,
        seq,
      );
      await instance.onAlarm();
      expect(state.storage.sql.exec(
        "SELECT state, terminal_reason, work_id, continuation_ref FROM directed_deliveries WHERE message_seq = ?",
        seq,
      ).one()).toMatchObject({
        state: "failed",
        terminal_reason: "delivery_expired",
        work_id: null,
        continuation_ref: null,
      });
      // History retention is explicitly off, so the source body remains while only the capability
      // and work ledger are bounded.
      expect(state.storage.sql.exec("SELECT body FROM messages WHERE seq = ?", seq).one().body)
        .toContain("keep the history");
      const terminalAlarm = await state.storage.getAlarm();
      expect(terminalAlarm).not.toBeNull();
      expect(terminalAlarm!).toBeGreaterThanOrEqual(now + 7 * 24 * 60 * 60 * 1000 - 1_000);
      expect(terminalAlarm!).toBeLessThanOrEqual(now + 7 * 24 * 60 * 60 * 1000 + 1_000);

      state.storage.sql.exec(
        "UPDATE directed_deliveries SET updated_at = ? WHERE message_seq = ?",
        now - 8 * 24 * 60 * 60 * 1000,
        seq,
      );
      await instance.onAlarm();
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM directed_deliveries WHERE message_seq = ?",
        seq,
      ).one().n)).toBe(0);
      expect(Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE seq = ?", seq).one().n)).toBe(1);
    });
  });

  it("advances a queued delivery's 30-day alarm to terminal retention when dispatch fails immediately", async () => {
    const owner = await seedToken("agent", uniq("terminal-alarm-owner"));
    const slug = await createChannel(owner.token);
    const target = await seedToken("agent", uniq("terminal-alarm-target"), { channelScope: slug });
    const sent = await postMessage(slug, owner.token, `@${target.name} unsafe legacy principal`);
    const seq = ((await sent.json()) as { seq: number }).seq;
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const runtime = instance as unknown as { dispatchNextDirectedDelivery(name: string): void };
      const row = state.storage.sql.exec(
        "SELECT id, created_at FROM directed_deliveries WHERE message_seq = ?",
        seq,
      ).one();
      await state.storage.setAlarm(Number(row.created_at) + 30 * 24 * 60 * 60 * 1000);
      state.storage.sql.exec("UPDATE directed_deliveries SET target_owner = NULL WHERE id = ?", row.id);
      const failedAt = Date.now();
      runtime.dispatchNextDirectedDelivery(target.name);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.storage.sql.exec(
        "SELECT state, terminal_reason, last_error FROM directed_deliveries WHERE id = ?",
        row.id,
      ).one()).toMatchObject({
        state: "failed",
        terminal_reason: "delivery_failed",
        last_error: expect.stringContaining("no creation-time target principal"),
      });
      const terminalAlarm = await state.storage.getAlarm();
      expect(terminalAlarm).not.toBeNull();
      expect(terminalAlarm!).toBeGreaterThanOrEqual(failedAt + 7 * 24 * 60 * 60 * 1000 - 1_000);
      expect(terminalAlarm!).toBeLessThanOrEqual(failedAt + 7 * 24 * 60 * 60 * 1000 + 1_000);
    });
  });

  it("fails active deliveries created during R2 deletion before pruning expired rows", async () => {
    const account = `${uniq("retention-race")}@example.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: account });
    const target = await seedToken("agent", uniq("target"), { owner: account });
    const slug = await createChannel(owner.token);
    const oldResponse = await postMessage(slug, owner.token, "expired with race");
    const oldSeq = ((await oldResponse.json()) as { seq: number }).seq;
    await api(`/api/channels/${slug}/retention`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ message_retention_ms: 60_000 }),
    });
    const attachmentKey = `${slug}/race-object`;
    await env.ATTACHMENTS.put(attachmentKey, "secret");
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "UPDATE messages SET ts = ?, attachments_json = ? WHERE seq = ?",
        now - 61_000,
        JSON.stringify([{ key: attachmentKey, filename: "race.txt", content_type: "text/plain", size: 6, url: `/api/channels/${slug}/attachments/race-object` }]),
        oldSeq,
      );
      state.storage.sql.exec(
        `CREATE TRIGGER block_active_delivery_delete
         BEFORE DELETE ON directed_deliveries
         WHEN OLD.state IN ('queued', 'claimed', 'running', 'waiting_owner')
         BEGIN
           SELECT RAISE(ABORT, 'active delivery deleted without terminal transition');
         END`,
      );
      const bucket = env.ATTACHMENTS as unknown as { delete: (keys: string | string[]) => Promise<void> };
      const originalDelete = bucket.delete.bind(bucket);
      let injected = false;
      bucket.delete = async (keys) => {
        if (!injected) {
          injected = true;
          const id = crypto.randomUUID();
          state.storage.sql.exec(
            `INSERT INTO directed_deliveries (
               id, message_seq, target_name, target_owner, cause, state, attempt,
               lease_connection_id, last_lease_connection_id, lease_adapter, lease_until,
               work_id, continuation_ref, reply_seq, last_error, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'mention_edit', 'queued', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
            id,
            oldSeq,
            target.name,
            account,
            Date.now(),
            Date.now(),
          );
        }
        await originalDelete(keys);
      };
      try {
        await instance.onAlarm();
      } finally {
        bucket.delete = originalDelete;
        state.storage.sql.exec("DROP TRIGGER IF EXISTS block_active_delivery_delete");
      }
      expect(injected).toBe(true);
      expect(Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE seq = ?", oldSeq).one().n)).toBe(0);
      expect(Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM directed_deliveries WHERE message_seq = ?", oldSeq).one().n)).toBe(0);
    });
  });
});
