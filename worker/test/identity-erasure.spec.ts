// GDPR 按身份硬擦除 + 导出（#421）。验证：
//  - moderator 能导出某身份在频道的全部可归因数据；擦除后这些数据不可查、消息正文被抹成 [erased]。
//  - 非 moderator 无论导出还是擦除都被 403 拒。
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

interface ExportShape {
  name: string;
  messages: {
    seq: number;
    body: string;
    sender: { name: string; owner?: string; handle?: string; display_name?: string; avatar_url?: string };
    attachments?: unknown[];
    rev_seq?: number;
  }[];
  audit: { target_seq: number; action: string; actor: { name: string } }[];
  wake_deliveries: { target_name: string }[];
  read_cursor: { name: string } | null;
  presence: { name: string }[];
}

async function fixture() {
  const acct = `${uniq("acct")}@leeguoo.com`;
  const owner = await seedToken("agent", uniq("owner"), { owner: acct });
  const slug = await createChannel(owner.token);
  const writer = await seedToken("agent", uniq("writer"), { owner: acct, channelScope: slug });
  const other = await seedToken("agent", uniq("other"), { owner: acct, channelScope: slug });
  return { slug, owner, writer, other };
}

// 直接往 DO 塞 presence / wake 账本 / 读游标行，绕开 WS 时序，做确定性的擦除断言。
async function seedIdentityRows(slug: string, name: string): Promise<void> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (_do: ChannelDO, state) => {
    const now = Date.now();
    state.storage.sql.exec(
      "INSERT INTO presence (name, session_id, state, updated_at) VALUES (?, ?, 'online', ?)",
      name,
      "sess-1",
      now,
    );
    state.storage.sql.exec(
      `INSERT INTO wake_delivery_ledger (mention_seq, target_name, webhook_name, adapter_kind, attempt, result, attempted_at)
       VALUES (?, ?, ?, 'webhook', 1, 'ok', ?)`,
      1,
      name,
      name,
      now,
    );
    state.storage.sql.exec(
      "INSERT INTO read_cursor (name, session_id, kind, last_seen_seq, updated_at) VALUES (?, ?, 'agent', ?, ?)",
      name,
      "sess-1",
      2,
      now,
    );
  });
}

describe("gdpr identity erasure + export (#421)", () => {
  it("exports an identity's data and then hard-erases it (moderator only)", async () => {
    const { slug, owner, writer, other } = await fixture();

    // 造可归因数据：两条消息 + 一次编辑（产生 message_audit 行，actor = writer）。
    const first = await postMessage(slug, writer.token, "first body");
    const firstSeq = ((await first.json()) as { seq: number }).seq;
    await postMessage(slug, writer.token, "second body");
    await postMessage(slug, other.token, "other body");
    const edited = await api(`/api/channels/${slug}/messages/${firstSeq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "edited body" }),
    });
    expect(edited.status).toBe(200);
    await seedIdentityRows(slug, writer.name);
    await seedIdentityRows(slug, other.name);

    // 导出（moderator）：能看到全部维度。
    const exportRes = await api(`/api/channels/${slug}/identity/${encodeURIComponent(writer.name)}/data`, owner.token);
    expect(exportRes.status).toBe(200);
    const dump = (await exportRes.json()) as ExportShape;
    expect(dump.name).toBe(writer.name);
    expect(dump.messages.length).toBe(2);
    expect(dump.audit.length).toBeGreaterThanOrEqual(1);
    expect(dump.audit.every((a) => a.actor.name === writer.name || a.target_seq === firstSeq)).toBe(true);
    expect(dump.wake_deliveries.length).toBe(1);
    expect(dump.read_cursor?.name).toBe(writer.name);
    expect(dump.presence.length).toBe(1);

    // 擦除（moderator）：返回各表命中数。
    const eraseRes = await api(`/api/channels/${slug}/identity/${encodeURIComponent(writer.name)}/data`, owner.token, {
      method: "DELETE",
    });
    expect(eraseRes.status).toBe(200);
    const summary = (await eraseRes.json()) as {
      messages_scrubbed: number;
      audit_deleted: number;
      wake_ledger_deleted: number;
      read_cursors_deleted: number;
      presence_deleted: number;
    };
    expect(summary.messages_scrubbed).toBe(2);
    expect(summary.audit_deleted).toBeGreaterThanOrEqual(1);
    expect(summary.wake_ledger_deleted).toBe(1);
    expect(summary.read_cursors_deleted).toBe(1);
    expect(summary.presence_deleted).toBe(1);

    // 擦除后：该身份数据不可查——消息正文被抹成 [erased]，审计/账本/游标/presence 清零。
    const after = (await (
      await api(`/api/channels/${slug}/identity/${encodeURIComponent(writer.name)}/data`, owner.token)
    ).json()) as ExportShape;
    expect(after.messages.length).toBe(2);
    expect(after.messages.every((m) => m.body === "[erased]")).toBe(true);
    expect(after.messages.every((m) => m.sender.name === writer.name)).toBe(true);
    expect(after.messages.every((m) => m.sender.owner === undefined && m.sender.handle === undefined)).toBe(true);
    expect(after.messages.every((m) => m.sender.display_name === undefined && m.sender.avatar_url === undefined)).toBe(true);
    expect(after.messages.every((m) => m.attachments === undefined)).toBe(true);
    expect(after.messages.every((m) => typeof m.rev_seq === "number")).toBe(true);
    expect(after.audit.length).toBe(0);
    expect(after.wake_deliveries.length).toBe(0);
    expect(after.read_cursor).toBeNull();
    expect(after.presence.length).toBe(0);

    const otherAfter = (await (
      await api(`/api/channels/${slug}/identity/${encodeURIComponent(other.name)}/data`, owner.token)
    ).json()) as ExportShape;
    expect(otherAfter.messages.some((m) => m.body === "other body")).toBe(true);
    expect(otherAfter.presence.length).toBe(1);

    // 频道历史里也不再有原文。
    const history = await api(`/api/channels/${slug}/messages?since=0`, owner.token);
    const messages = ((await history.json()) as { messages: { body: string }[] }).messages;
    expect(messages.some((m) => m.body === "first body" || m.body === "second body" || m.body === "edited body")).toBe(
      false,
    );
  });

  it("rejects export and erase from a non-moderator", async () => {
    const { slug, owner, writer, other } = await fixture();
    await postMessage(slug, writer.token, "sensitive");

    const exportDenied = await api(
      `/api/channels/${slug}/identity/${encodeURIComponent(writer.name)}/data`,
      other.token,
    );
    expect(exportDenied.status).toBe(403);

    const eraseDenied = await api(
      `/api/channels/${slug}/identity/${encodeURIComponent(writer.name)}/data`,
      other.token,
      { method: "DELETE" },
    );
    expect(eraseDenied.status).toBe(403);

    // 拒绝后原文仍在，未被误删。
    const stillThere = await api(`/api/channels/${slug}/identity/${encodeURIComponent(writer.name)}/data`, owner.token);
    expect(stillThere.status).toBe(200);
    const stillThereData = (await stillThere.json()) as ExportShape;
    expect(stillThereData.messages.some((m) => m.body === "sensitive")).toBe(true);
  });
});
