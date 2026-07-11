import {
  MAX_CHANNELS_PER_ACCOUNT,
  MAX_CHANNEL_CREATES_PER_WINDOW,
} from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { api, seedToken, uniq, WsClient } from "./helpers";

// #137 成本滥用：每频道一个 Durable Object，无配额时任一带账号的 ap_ token 可无限造 DO + D1 行。
// 下面直接向 D1 播种 channels 行来把某账号推到配额/限速边界，避免真跑上百次建频道 API。

async function seedChannels(
  ownerAccount: string,
  count: number,
  createdAt: number,
): Promise<void> {
  const now = createdAt;
  for (let i = 0; i < count; i++) {
    await env.DB.prepare(
      "INSERT INTO channels (slug, kind, created_by, owner_account, created_at) VALUES (?, 'standing', ?, ?, ?)",
    )
      .bind(uniq("seed"), "seed-creator", ownerAccount, now)
      .run();
  }
}

function createChannelReq(token: string) {
  return api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug: uniq("ch"), kind: "standing" }),
  });
}

describe("per-account channel quota (#137)", () => {
  it("rejects channel creation once the account is at its owned-channel quota", async () => {
    const account = uniq("acct");
    const { token } = await seedToken("agent", uniq("tok"), { owner: account });
    // 播种到「配额 - 1」，用一个 window 之外的时间戳避免撞上创建限速
    const old = Date.now() - 2 * 60 * 60 * 1000;
    await seedChannels(account, MAX_CHANNELS_PER_ACCOUNT - 1, old);

    // 第 N 个（刚好到配额）仍放行
    expect((await createChannelReq(token)).status).toBe(201);

    // 第 N+1 个：超配额，403 quota_exceeded
    const over = await createChannelReq(token);
    expect(over.status).toBe(403);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("quota_exceeded");
  });

  it("lets an under-quota account create channels", async () => {
    const account = uniq("acct");
    const { token } = await seedToken("agent", uniq("tok"), { owner: account });
    expect((await createChannelReq(token)).status).toBe(201);
  });

  it("does not quota-limit legacy tokens without an account (fail-open)", async () => {
    // 一堆无归属账号（owner_account = NULL）的历史频道不该把 legacy token 也卡死
    const old = Date.now() - 2 * 60 * 60 * 1000;
    for (let i = 0; i < MAX_CHANNELS_PER_ACCOUNT + 5; i++) {
      await env.DB.prepare(
        "INSERT INTO channels (slug, kind, created_by, owner_account, created_at) VALUES (?, 'standing', ?, NULL, ?)",
      )
        .bind(uniq("legacy"), "legacy", old)
        .run();
    }
    const { token } = await seedToken("agent"); // 无 owner → account null
    expect((await createChannelReq(token)).status).toBe(201);
  });

  it("rate-limits bursty channel creation within the window (429 rate_limited)", async () => {
    const account = uniq("acct");
    const { token } = await seedToken("agent", uniq("tok"), { owner: account });
    // 窗口内已有「限速 - 1」个刚创建的频道；总数远低于配额，只应触发限速
    await seedChannels(account, MAX_CHANNEL_CREATES_PER_WINDOW - 1, Date.now());

    // 第 N 个（刚好到限速上限）仍放行
    expect((await createChannelReq(token)).status).toBe(201);

    // 第 N+1 个：窗口内创建过多，429 rate_limited
    const over = await createChannelReq(token);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });
});

// 测试环境把每频道连接上限降到 TEST_CONN_CAP（vitest.config.ts 的 miniflare binding
// MAX_CONNECTIONS_PER_CHANNEL 与此值保持一致），避免真开 200 条 WS。
const TEST_CONN_CAP = 10;

describe("per-channel WS connection cap (#137)", () => {
  it("accepts up to the cap and rejects the next connection with channel_full", async () => {
    const account = uniq("acct");
    const { token } = await seedToken("agent", uniq("tok"), { owner: account });
    const slug = uniq("ch");
    expect(
      (
        await api("/api/channels", token, {
          method: "POST",
          body: JSON.stringify({ slug, kind: "standing" }),
        })
      ).status,
    ).toBe(201);

    const open: WsClient[] = [];
    try {
      // cap 条连接全部拿到 welcome
      for (let i = 0; i < TEST_CONN_CAP; i++) {
        const ws = await WsClient.open(slug, token);
        expect((await ws.nextOfType("welcome")).type).toBe("welcome");
        open.push(ws);
      }

      // 第 cap+1 条：被拒，先收到 error:channel_full
      const overflow = await WsClient.open(slug, token);
      const err = await overflow.nextOfType("error");
      expect(err.code).toBe("channel_full");
      overflow.close();
    } finally {
      for (const ws of open) ws.close();
    }
  });
});
