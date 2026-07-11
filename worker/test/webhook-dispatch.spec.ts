import { WEBHOOK_TIMEOUT_MS } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { fetchMock } from "./fetch-mock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function sendMessage(slug: string, token: string, body: string, mentions: string[] = []) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null }),
  });
}

function addWebhook(slug: string, token: string, name: string, url: string, filter = "all") {
  return api(`/api/channels/${slug}/webhooks`, token, {
    method: "POST",
    body: JSON.stringify({ name, url, secret: "s", filter }),
  });
}

async function ledgerRows(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec(
        `SELECT mention_seq, target_name, webhook_name, adapter_kind, attempt,
                result, http_status, error, ack_seq, resume_seq
         FROM wake_delivery_ledger
         ORDER BY id`,
      )
      .toArray()
      .map((r) => ({
        mention_seq: Number(r.mention_seq),
        target_name: String(r.target_name),
        webhook_name: String(r.webhook_name),
        adapter_kind: String(r.adapter_kind),
        attempt: Number(r.attempt),
        result: String(r.result),
        http_status: r.http_status === null ? null : Number(r.http_status),
        error: r.error === null ? null : String(r.error),
        ack_seq: r.ack_seq === null ? null : Number(r.ack_seq),
        resume_seq: r.resume_seq === null ? null : Number(r.resume_seq),
      })),
  );
}

describe("webhook dispatch is off the send path", () => {
  // 修复 3：坏/慢端点不得同步阻塞发送。首投走 waitUntil，send 立即返回 seq。
  it("returns seq well under the webhook timeout even with a slow endpoint", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, uniq("slow"), "https://slow.test/hook")).status).toBe(201);

    // 端点拖到 3s 才回；旧实现会同步 await，send 至少阻塞 3s
    fetchMock
      .get("https://slow.test")
      .intercept({ path: "/hook", method: "POST" })
      .reply(200, "ok")
      .delay(3_000);

    const start = Date.now();
    const res = await sendMessage(slug, token, "hi");
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect((await res.json()) as { seq: number }).toMatchObject({ seq: 1 });
    // 远小于 10s 的 webhook 超时，也远小于端点 3s 延迟
    expect(elapsed).toBeLessThan(1_500);
    expect(elapsed).toBeLessThan(WEBHOOK_TIMEOUT_MS);

    // 让后台 waitUntil 投递把 mock 消费掉，afterEach 才不报未消费 interceptor
    await new Promise((r) => setTimeout(r, 3_200));
  });

  it("records webhook wake delivery attempts durably", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const hook = uniq("wake");
    expect((await addWebhook(slug, token, hook, "https://ledger.test/wake")).status).toBe(201);

    fetchMock.get("https://ledger.test").intercept({ path: "/wake", method: "POST" }).reply(202, "accepted");
    expect((await sendMessage(slug, token, `@${hook} ping`, [hook])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    expect(await ledgerRows(slug)).toEqual([
      {
        mention_seq: 1,
        target_name: hook,
        webhook_name: hook,
        adapter_kind: "webhook",
        attempt: 1,
        result: "ok",
        http_status: 202,
        error: null,
        ack_seq: null,
        resume_seq: null,
      },
    ]);

    const apiRes = await api(`/api/channels/${slug}/wake-deliveries?since=1&target=${hook}`, token);
    expect(apiRes.status).toBe(200);
    expect((await apiRes.json()) as { deliveries: unknown[] }).toMatchObject({
      deliveries: [
        {
          mention_seq: 1,
          target_name: hook,
          webhook_name: hook,
          adapter_kind: "webhook",
          attempt: 1,
          result: "ok",
          http_status: 202,
          error: null,
          ack_seq: null,
          resume_seq: null,
        },
      ],
    });
  });

  it("records failed webhook attempts and successful alarm retries", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const hook = uniq("wake");
    expect((await addWebhook(slug, token, hook, "https://retry-ledger.test/wake")).status).toBe(201);

    expect((await sendMessage(slug, token, `@${hook} ping`, [hook])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    fetchMock.get("https://retry-ledger.test").intercept({ path: "/wake", method: "POST" }).reply(200, "ok");
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE webhook_queue SET next_retry_at = ?", Date.now() - 1);
      await instance.onAlarm();
    });

    const rows = await ledgerRows(slug);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      mention_seq: 1,
      target_name: hook,
      webhook_name: hook,
      adapter_kind: "webhook",
      attempt: 1,
      result: "failed",
      http_status: null,
      ack_seq: null,
      resume_seq: null,
    });
    expect(rows[0]?.error).toEqual(expect.any(String));
    expect(rows[1]).toMatchObject({
      mention_seq: 1,
      target_name: hook,
      webhook_name: hook,
      adapter_kind: "webhook",
      attempt: 2,
      result: "ok",
      http_status: 200,
      error: null,
      ack_seq: null,
      resume_seq: null,
    });
  });

  it("links wake delivery ledger rows to target replies and status resumes", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("wake-target");
    const { token: targetToken } = await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, target, "https://resume-ledger.test/wake", "mentions")).status).toBe(201);

    fetchMock.get("https://resume-ledger.test").intercept({ path: "/wake", method: "POST" }).reply(202, "accepted");
    expect((await sendMessage(slug, token, `@${target} ping`, [target])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      (
        await api(`/api/channels/${slug}/messages`, targetToken, {
          method: "POST",
          body: JSON.stringify({ kind: "message", body: "ack", mentions: [], reply_to: 1 }),
        })
      ).status,
    ).toBe(200);

    fetchMock.get("https://resume-ledger.test").intercept({ path: "/wake", method: "POST" }).reply(200, "ok");
    expect((await sendMessage(slug, token, `@${target} status please`, [target])).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      (
        await api(`/api/channels/${slug}/messages`, targetToken, {
          method: "POST",
          body: JSON.stringify({
            kind: "status",
            state: "done",
            note: "resumed",
            mentions: [],
            summary_seq: 3,
          }),
        })
      ).status,
    ).toBe(200);

    expect(await ledgerRows(slug)).toEqual([
      expect.objectContaining({ mention_seq: 1, target_name: target, ack_seq: 2, resume_seq: null }),
      expect.objectContaining({ mention_seq: 3, target_name: target, ack_seq: null, resume_seq: 4 }),
    ]);

    const apiRes = await api(`/api/channels/${slug}/wake-deliveries?since=1&target=${target}`, token);
    expect(apiRes.status).toBe(200);
    expect((await apiRes.json()) as { deliveries: unknown[] }).toMatchObject({
      deliveries: [
        { mention_seq: 1, target_name: target, ack_seq: 2, resume_seq: null },
        { mention_seq: 3, target_name: target, ack_seq: null, resume_seq: 4 },
      ],
    });
  });

  it("links wake delivery rows when the target resumes before delivery is recorded", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("wake-target");
    const { token: targetToken } = await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, target, "https://race-ledger.test/wake", "mentions")).status).toBe(201);

    fetchMock
      .get("https://race-ledger.test")
      .intercept({ path: "/wake", method: "POST" })
      .reply(200, "ok")
      .delay(150);

    expect((await sendMessage(slug, token, `@${target} ping`, [target])).status).toBe(200);
    expect(
      (
        await api(`/api/channels/${slug}/messages`, targetToken, {
          method: "POST",
          body: JSON.stringify({
            kind: "status",
            state: "done",
            note: "resumed before ledger insert",
            mentions: [],
            summary_seq: 1,
          }),
        })
      ).status,
    ).toBe(200);
    await new Promise((r) => setTimeout(r, 250));

    expect(await ledgerRows(slug)).toEqual([
      expect.objectContaining({ mention_seq: 1, target_name: target, ack_seq: null, resume_seq: 2 }),
    ]);
  });
});
