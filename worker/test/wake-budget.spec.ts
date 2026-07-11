// issue #108：per-agent wake 预算/配额硬上限。每个 @ 触发一次完整 runner run，会烧目标的
// LLM 订阅；协议此前无任何总量上限。这里给每个 agent 一个滚动窗口内的 wake 硬上限：窗口内
// 已投 wake 达到 limit 后，再来的 @ 不再投 webhook（不烧订阅），落 wake_delivery_ledger 的
// budget 行 + 频道内 system status 可观测；窗口滚动后自动恢复；不设预算 = 正常流（不限）。
import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function sendMention(slug: string, token: string, target: string) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body: `@${target} ping`, mentions: [target], reply_to: null }),
  });
}

function addWebhook(slug: string, token: string, name: string, url: string, filter = "mentions") {
  return api(`/api/channels/${slug}/webhooks`, token, {
    method: "POST",
    body: JSON.stringify({ name, url, secret: "s", filter }),
  });
}

function setBudget(
  slug: string,
  token: string,
  name: string,
  body: { enabled: boolean; limit?: number; window_ms?: number },
) {
  return api(`/api/channels/${slug}/wake-budget/${encodeURIComponent(name)}`, token, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function getBudget(slug: string, token: string, name: string) {
  return api(`/api/channels/${slug}/wake-budget/${encodeURIComponent(name)}`, token);
}

interface LedgerRow {
  mention_seq: number;
  target_name: string;
  attempt: number;
  result: string;
  http_status: number | null;
  error: string | null;
}

async function ledgerRows(slug: string, target: string): Promise<LedgerRow[]> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_i: ChannelDO, state) =>
    state.storage.sql
      .exec(
        `SELECT mention_seq, target_name, attempt, result, http_status, error
           FROM wake_delivery_ledger WHERE target_name = ? ORDER BY id`,
        target,
      )
      .toArray()
      .map((r) => ({
        mention_seq: Number(r.mention_seq),
        target_name: String(r.target_name),
        attempt: Number(r.attempt),
        result: String(r.result),
        http_status: r.http_status === null ? null : Number(r.http_status),
        error: r.error === null ? null : String(r.error),
      })),
  );
}

async function systemNotes(slug: string, token: string): Promise<string[]> {
  const res = await api(`/api/channels/${slug}/messages?since=0`, token);
  const body = (await res.json()) as { messages: { sender: { name: string }; body: string }[] };
  return body.messages.filter((m) => m.sender.name === "system").map((m) => m.body);
}

describe("per-agent wake 预算（issue #108）", () => {
  it("budget=N：窗口内前 N 个 @ 正常投递，第 N+1 个被抑制（webhook 不投），落 budget 行可观测", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("budget-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, target, "https://budget-wake.test/hook")).status).toBe(201);

    // 预算：窗口内最多 2 次 wake（大窗口，实测不会自然滚动）
    expect((await setBudget(slug, token, target, { enabled: true, limit: 2, window_ms: 3_600_000 })).status).toBe(200);

    // 前两个 @ 应真的投递（各注册一次 interceptor）
    for (let i = 0; i < 2; i++) {
      fetchMock.get("https://budget-wake.test").intercept({ path: "/hook", method: "POST" }).reply(200, "ok");
      expect((await sendMention(slug, token, target)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 60));
    }

    // 第 3 个 @ 超预算：不注册 interceptor——若真投递会因 disableNetConnect 抛错并落 failed 行
    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));

    const rows = await ledgerRows(slug, target);
    // 两次成功首投 + 一次 budget 抑制标记；没有 failed（证明第 3 个从未真的 fetch）
    expect(rows.filter((r) => r.result === "ok" && r.attempt === 1)).toHaveLength(2);
    const budgetRows = rows.filter((r) => r.result === "budget");
    expect(budgetRows).toHaveLength(1);
    expect(rows.some((r) => r.result === "failed")).toBe(false);

    // 归属：budget 行带上是哪条 mention（第 3 条消息）以及被 @ 的目标
    expect(budgetRows[0]).toMatchObject({ mention_seq: 3, target_name: target, attempt: 1, http_status: null });
    expect(budgetRows[0]?.error).toEqual(expect.stringContaining("wake budget"));

    // 频道内可观测：一条 system status 通告预算已用尽
    const notes = await systemNotes(slug, token);
    expect(notes.some((n) => n.includes(target) && n.toLowerCase().includes("wake budget"))).toBe(true);
  });

  it("不设预算 = 正常流：不限次数投递，无 budget 行", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("nobudget-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, target, "https://nobudget-wake.test/hook")).status).toBe(201);

    for (let i = 0; i < 4; i++) {
      fetchMock.get("https://nobudget-wake.test").intercept({ path: "/hook", method: "POST" }).reply(200, "ok");
      expect((await sendMention(slug, token, target)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 60));
    }

    const rows = await ledgerRows(slug, target);
    expect(rows.filter((r) => r.result === "ok" && r.attempt === 1)).toHaveLength(4);
    expect(rows.some((r) => r.result === "budget")).toBe(false);
  });

  it("窗口滚动后恢复投递：把窗口内旧 wake 的 attempted_at 挪到窗口外，下一个 @ 又能投", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("roll-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, target, "https://roll-wake.test/hook")).status).toBe(201);
    expect((await setBudget(slug, token, target, { enabled: true, limit: 1, window_ms: 3_600_000 })).status).toBe(200);

    // 第 1 个投递用满预算
    fetchMock.get("https://roll-wake.test").intercept({ path: "/hook", method: "POST" }).reply(200, "ok");
    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));

    // 第 2 个被抑制（budget 行，无 fetch）
    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));
    expect((await ledgerRows(slug, target)).filter((r) => r.result === "budget")).toHaveLength(1);

    // 把已消耗的那次 wake 挪到窗口之外（模拟时间前进 / 窗口滚动）
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_i: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE wake_delivery_ledger SET attempted_at = ? WHERE target_name = ? AND result = 'ok'",
        Date.now() - 7_200_000,
        target,
      );
    });

    // 现在窗口内已消耗为 0，下一个 @ 又能投
    fetchMock.get("https://roll-wake.test").intercept({ path: "/hook", method: "POST" }).reply(200, "ok");
    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));
    const okRows = (await ledgerRows(slug, target)).filter((r) => r.result === "ok" && r.attempt === 1);
    expect(okRows).toHaveLength(2);
  });

  it("inspect：GET 返回 enabled/limit/window/used/remaining", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("inspect-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, target, "https://inspect-wake.test/hook")).status).toBe(201);
    expect((await setBudget(slug, token, target, { enabled: true, limit: 3, window_ms: 3_600_000 })).status).toBe(200);

    fetchMock.get("https://inspect-wake.test").intercept({ path: "/hook", method: "POST" }).reply(200, "ok");
    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));

    const res = await getBudget(slug, token, target);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      name: target,
      enabled: true,
      limit: 3,
      window_ms: 3_600_000,
      used: 1,
      remaining: 2,
    });
  });

  it("agent 可给自己设预算；持不同名字的 scoped token 不能替别人设（403）", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("self-agent");
    const slug = await createChannel(token);
    // 目标自己的 channel-scoped token（能访问频道，但不是 moderator）
    const { token: selfToken } = await seedToken("agent", target, { channelScope: slug });
    // 自设应放行
    expect((await setBudget(slug, selfToken, target, { enabled: true, limit: 5 })).status).toBe(200);

    // 另一个 agent 的 scoped token 想替 target 设 → 403
    const { token: otherToken } = await seedToken("agent", uniq("other"), { channelScope: slug });
    expect((await setBudget(slug, otherToken, target, { enabled: true, limit: 1 })).status).toBe(403);
  });

  it("--off/清除预算后回到不限：清掉后超额 @ 恢复投递", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("clear-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, target, "https://clear-wake.test/hook")).status).toBe(201);
    expect((await setBudget(slug, token, target, { enabled: true, limit: 1, window_ms: 3_600_000 })).status).toBe(200);

    fetchMock.get("https://clear-wake.test").intercept({ path: "/hook", method: "POST" }).reply(200, "ok");
    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));

    // 超预算，被抑制
    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));
    expect((await ledgerRows(slug, target)).filter((r) => r.result === "budget")).toHaveLength(1);

    // 清除预算
    expect((await setBudget(slug, token, target, { enabled: false })).status).toBe(200);
    const cleared = await getBudget(slug, token, target);
    expect((await cleared.json()) as Record<string, unknown>).toMatchObject({ enabled: false, limit: null });

    // 现在又能投
    fetchMock.get("https://clear-wake.test").intercept({ path: "/hook", method: "POST" }).reply(200, "ok");
    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));
    expect((await ledgerRows(slug, target)).filter((r) => r.result === "ok" && r.attempt === 1)).toHaveLength(2);
  });

  it("limit 必须为正整数，否则 400", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("badlimit-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await setBudget(slug, token, target, { enabled: true, limit: 0 })).status).toBe(400);
    expect((await setBudget(slug, token, target, { enabled: true, limit: -3 })).status).toBe(400);
  });
});
