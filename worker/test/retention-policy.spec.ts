// #421: D1-authoritative retention policy + DO alarm physical deletion.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

describe("channel retention policy (#421)", () => {
  it("mirrors policy to the DO and physically deletes expired message/audit/R2 data", async () => {
    const account = `${uniq("retention")}@example.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: account });
    const slug = await createChannel(owner.token);
    const oldResponse = await postMessage(slug, owner.token, "expired secret");
    const oldSeq = ((await oldResponse.json()) as { seq: number }).seq;
    const freshResponse = await postMessage(slug, owner.token, "fresh body");
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
});
