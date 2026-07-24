// issue #128：wake_delivery_ledger / message_audit / read_cursor 三张 DO-sqlite 表此前只增不减，
// DO 存储无上限增长。这里给每张表加有界修剪（onAlarm 周期跑），并守住「仍被消费者需要的行不被裁」：
//   - wake_delivery_ledger：保留窗口严格大于预算窗口上限（#108 wakeCountInWindow），预算计数不漏；
//   - message_audit：保留最新 N 行，审计 API 的近期查询（高 id）永不被裁，且不撞 #196 撤回清洗语义；
//   - read_cursor：只裁「陈旧且当前未连接」的游标，绝不动在线身份的活游标（含刚 caught-up 的）。
import {
  MAX_MESSAGE_AUDIT_ROWS,
  READ_CURSOR_RETENTION_MS,
  WAKE_BUDGET_MAX_WINDOW_MS,
  WAKE_LEDGER_RETENTION_MS,
} from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, createChannel, seedToken } from "./helpers";

const PARTICIPANT_REMOVAL_META_RETENTION_MS = 24 * 60 * 60 * 1000;

// 触发一次真实请求以确保 DO onStart 已建表（与生产路径一致），返回 stub。
async function bootDO(slug: string, token: string) {
  expect((await api(`/api/channels/${slug}/read-cursors`, token)).status).toBe(200);
  return env.CHANNELS.get(env.CHANNELS.idFromName(slug));
}

function insertLedgerRow(state: DurableObjectState, mentionSeq: number, target: string, attemptedAt: number) {
  state.storage.sql.exec(
    `INSERT INTO wake_delivery_ledger (
       mention_seq, target_name, webhook_name, adapter_kind, attempt,
       result, http_status, error, attempted_at, ack_seq, resume_seq
     ) VALUES (?, ?, ?, 'webhook', 1, 'ok', 200, NULL, ?, NULL, NULL)`,
    mentionSeq,
    target,
    target,
    attemptedAt,
  );
}

function insertAuditRow(state: DurableObjectState, targetSeq: number, createdAt: number) {
  state.storage.sql.exec(
    `INSERT INTO message_audit (target_seq, action, actor_name, actor_kind, old_body, new_body, created_at)
     VALUES (?, 'edit', 'someone', 'human', 'old', 'new', ?)`,
    targetSeq,
    createdAt,
  );
}

function insertCursorRow(state: DurableObjectState, name: string, seq: number, updatedAt: number) {
  state.storage.sql.exec(
    `INSERT INTO read_cursor (name, session_id, kind, last_seen_seq, updated_at) VALUES (?, ?, 'agent', ?, ?)
     ON CONFLICT(name, session_id) DO UPDATE SET last_seen_seq = excluded.last_seen_seq, updated_at = excluded.updated_at`,
    name,
    `test:${name}`,
    seq,
    updatedAt,
  );
}

describe("DO storage pruning (#128)", () => {
  it("participant removal cache: schedules expiry on write and restores it on hydration", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const stub = await bootDO(slug, token);

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const runtime = instance as unknown as {
        removeParticipantDeliveryAdapters(name: string, now: number): void;
      };
      const removedAt = Date.now();
      await state.storage.deleteAlarm();
      runtime.removeParticipantDeliveryAdapters("removed-agent", removedAt);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const writeAlarm = await state.storage.getAlarm();
      expect(writeAlarm).not.toBeNull();
      expect(
        Math.abs(writeAlarm! - (removedAt + PARTICIPANT_REMOVAL_META_RETENTION_MS)),
      ).toBeLessThan(1_000);

      await state.storage.deleteAlarm();
      instance.onStart();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const hydrationAlarm = await state.storage.getAlarm();
      expect(hydrationAlarm).not.toBeNull();
      expect(
        Math.abs(hydrationAlarm! - (removedAt + PARTICIPANT_REMOVAL_META_RETENTION_MS)),
      ).toBeLessThan(1_000);
    });
  });

  it("participant removal cache: prunes stale meta rows and keeps fresh rows", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const stub = await bootDO(slug, token);

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      const stale = now - 7 * 24 * 60 * 60 * 1000;
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES
           ('participant-removal:stale', ?),
           ('removed-presence:stale', ?),
           ('participant-removal:fresh', ?),
           ('removed-presence:fresh', ?),
           ('unrelated:test', 'keep')`,
        String(stale),
        String(stale),
        String(now),
        String(now),
      );

      await instance.onAlarm();

      const keys = state.storage.sql
        .exec(
          `SELECT key FROM meta
            WHERE key LIKE 'participant-removal:%'
               OR key LIKE 'removed-presence:%'
               OR key = 'unrelated:test'
            ORDER BY key`,
        )
        .toArray()
        .map((row) => String(row.key));
      expect(keys).toEqual([
        "participant-removal:fresh",
        "removed-presence:fresh",
        "unrelated:test",
      ]);
    });
  });

  it("wake_delivery_ledger: prunes rows past the retention window, keeps budget-window rows", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const stub = await bootDO(slug, token);

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      // 保留窗口内（近期）：预算计数还要数它 → 必须活下来
      insertLedgerRow(state, 1, "alice", now - 60_000); // 1 分钟前
      // 预算窗口上限（30d）内、但在保留窗口内：安全余量区 → 也必须活下来
      insertLedgerRow(state, 2, "alice", now - WAKE_BUDGET_MAX_WINDOW_MS + 60_000);
      // 超保留窗口：陈旧，可裁
      insertLedgerRow(state, 3, "alice", now - WAKE_LEDGER_RETENTION_MS - 60_000);
      insertLedgerRow(state, 4, "alice", now - WAKE_LEDGER_RETENTION_MS - 100 * 24 * 3_600_000);

      await instance.onAlarm();

      const rows = state.storage.sql
        .exec("SELECT mention_seq FROM wake_delivery_ledger ORDER BY mention_seq")
        .toArray()
        .map((r) => Number(r.mention_seq));
      expect(rows).toEqual([1, 2]); // 3、4 被裁，1、2（预算仍需）保留
    });
  });

  it("message_audit: caps rows to the newest MAX_MESSAGE_AUDIT_ROWS, keeps the newest", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const stub = await bootDO(slug, token);

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      const extra = 30;
      for (let i = 0; i < MAX_MESSAGE_AUDIT_ROWS + extra; i++) {
        insertAuditRow(state, i + 1, now + i); // target_seq 1..N 递增，id 亦递增
      }
      await instance.onAlarm();

      const n = Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM message_audit").one().n);
      expect(n).toBe(MAX_MESSAGE_AUDIT_ROWS);
      // 裁掉的是最旧的一批（低 id / 低 target_seq），最新的保留
      const min = Number(state.storage.sql.exec("SELECT MIN(target_seq) AS m FROM message_audit").one().m);
      expect(min).toBe(extra + 1);
      const max = Number(state.storage.sql.exec("SELECT MAX(target_seq) AS m FROM message_audit").one().m);
      expect(max).toBe(MAX_MESSAGE_AUDIT_ROWS + extra);
    });
  });

  it("read_cursor: prunes stale disconnected cursors, keeps fresh ones", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const stub = await bootDO(slug, token);

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      insertCursorRow(state, "fresh", 5, now - 60_000); // 近期活跃 → 保留
      insertCursorRow(state, "stale-old", 3, now - READ_CURSOR_RETENTION_MS - 60_000); // 超窗且未连接 → 裁
      await instance.onAlarm();

      const names = state.storage.sql
        .exec("SELECT name FROM read_cursor ORDER BY name")
        .toArray()
        .map((r) => String(r.name));
      expect(names).toContain("fresh");
      expect(names).not.toContain("stale-old");
    });
  });

  it("read_cursor: never prunes a connected identity's live cursor even when stale", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    await bootDO(slug, token);

    // 真实连接：该身份此刻在线
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      // 把这个【在线】身份的游标 updated_at 硬拨到远古（比如频道久无新消息、它早已 caught-up 未再推进）
      insertCursorRow(state, name, 1, now - READ_CURSOR_RETENTION_MS - 100 * 24 * 3_600_000);
      // 另造一个陈旧且未连接的，作为对照——它应被裁
      insertCursorRow(state, "ghost", 1, now - READ_CURSOR_RETENTION_MS - 60_000);
      await instance.onAlarm();

      const names = state.storage.sql
        .exec("SELECT name FROM read_cursor ORDER BY name")
        .toArray()
        .map((r) => String(r.name));
      expect(names).toContain(name); // 在线身份的活游标绝不被裁
      expect(names).not.toContain("ghost");
    });
    ws.close();
  });
});
