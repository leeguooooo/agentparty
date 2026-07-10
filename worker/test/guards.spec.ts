import { env, runInDurableObject } from "cloudflare:test";
import { BODY_LIMIT, LOOP_GUARD_N, RATE_LIMIT_PER_MIN } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { api, createChannel, disableLoopGuard, postMessage, seedToken, WsClient } from "./helpers";

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

// 速率桶按分钟切，起跑点离整分太近就等到下一分钟
async function avoidMinuteBoundary() {
  const into = Date.now() % 60_000;
  if (into > 50_000) {
    await new Promise((r) => setTimeout(r, 60_200 - into));
  }
}

describe("guards", () => {
  it("disabled loop guard allows agent messages beyond the old global threshold", async () => {
    const agentA = await seedToken("agent");
    const agentB = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agentA.token);
    // #96 起新频道默认开 guard；本用例测的是关闭态，必须显式关闭
    await disableLoopGuard(slug, agentA.token);

    for (let i = 0; i < LOOP_GUARD_N + 5; i++) {
      const token = i % 2 === 0 ? agentA.token : agentB.token;
      const res = await postMessage(slug, token, `working-${i}`);
      expect(res.status).toBe(200);
    }

    const history = await api(`/api/channels/${slug}/messages?since=0&limit=50`, human.token);
    expect(history.status).toBe(200);
    const { messages } = (await history.json()) as {
      messages: { sender: { name: string; kind: string }; kind: string; body: string }[];
    };
    expect(messages.some((m) => m.sender.name === "system" && m.body.includes("loop guard tripped"))).toBe(false);
  });

  it("welcome does not expose loop guard state while loop guard is disabled", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    // #96 起新频道默认开 guard；本用例测的是关闭态，必须显式关闭
    await disableLoopGuard(slug, agent.token);
    const init = await WsClient.open(slug, agent.token);
    await init.nextOfType("welcome");
    init.close();
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('agent_streak', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(LOOP_GUARD_N),
      );
    });

    const ws = await WsClient.open(slug, human.token);
    const welcome = await ws.nextOfType("welcome");
    expect(welcome.loop_guard).toBeNull();
    ws.close();
  });

  it("disabled loop guard does not block the old 31st consecutive agent message", async () => {
    const agentA = await seedToken("agent");
    const agentB = await seedToken("agent");
    const slug = await createChannel(agentA.token);
    // #96 起新频道默认开 guard；本用例测的是关闭态，必须显式关闭
    await disableLoopGuard(slug, agentA.token);

    // 两个 agent token 交替，避开单 token 速率限制，streak 仍按 kind 累计
    for (let i = 0; i < LOOP_GUARD_N; i++) {
      const res = await postMessage(slug, i % 2 === 0 ? agentA.token : agentB.token, `m${i}`);
      expect(res.status).toBe(200);
    }
    const allowed = await postMessage(slug, agentA.token, "one more still allowed");
    expect(allowed.status).toBe(200);
  }, 30_000);

  it("loop guard can be enabled per channel with a configurable limit and disabled again", async () => {
    const agentA = await seedToken("agent");
    const agentB = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agentA.token);

    const enable = await api(`/api/channels/${slug}/loop-guard`, agentA.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 3 }),
    });
    expect(enable.status).toBe(200);
    expect(await enable.json()).toEqual({ enabled: true, limit: 3 });

    for (let i = 0; i < 3; i++) {
      const token = i % 2 === 0 ? agentA.token : agentB.token;
      expect((await postMessage(slug, token, `guarded-${i}`)).status).toBe(200);
    }
    const blocked = await postMessage(slug, agentA.token, "needs human");
    expect(blocked.status).toBe(409);
    expect(await errorCode(blocked)).toBe("loop_guard");

    const disable = await api(`/api/channels/${slug}/loop-guard`, human.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(200);
    expect(await disable.json()).toEqual({ enabled: false, limit: null });
    expect((await postMessage(slug, agentB.token, "unlimited again")).status).toBe(200);
  });

  it("rate limits the 31st message of a token within a minute", async () => {
    await avoidMinuteBoundary();
    const human = await seedToken("human");
    const slug = await createChannel(human.token);
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) {
      const res = await postMessage(slug, human.token, `m${i}`);
      expect(res.status).toBe(200);
    }
    const limited = await postMessage(slug, human.token, "over the limit");
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("rate_limited");
  }, 90_000);

  it("rate limit slides across the minute boundary (previous bucket counts)", async () => {
    await avoidMinuteBoundary();
    const { token, name } = await seedToken("human");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "warm")).status).toBe(200);

    // 把上一分钟灌满，折算后无论当前处于本分钟哪个位置都应超限
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance, state) => {
      const bucket = Math.floor(Date.now() / 60_000);
      state.storage.sql.exec(
        "INSERT INTO rate (name, bucket, count) VALUES (?, ?, ?)",
        name,
        bucket - 1,
        RATE_LIMIT_PER_MIN * 100,
      );
    });

    const limited = await postMessage(slug, token, "spill over");
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("rate_limited");
  }, 90_000);

  it("rejects a body over the byte limit", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const res = await postMessage(slug, token, "a".repeat(BODY_LIMIT + 1));
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("too_large");
  });

  it("readonly rest send gets unauthorized", async () => {
    const agent = await seedToken("agent");
    const ro = await seedToken("readonly");
    const slug = await createChannel(agent.token);
    const res = await postMessage(slug, ro.token, "hi");
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  it("rejects invalid or oversized mentions arrays", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const invalid = await api(`/api/channels/${slug}/messages`, token, {
      method: "POST",
      body: JSON.stringify({
        kind: "message",
        body: "small body",
        mentions: ["ok", "../bad"],
        reply_to: null,
      }),
    });
    expect(invalid.status).toBe(400);

    const tooMany = await api(`/api/channels/${slug}/messages`, token, {
      method: "POST",
      body: JSON.stringify({
        kind: "message",
        body: "small body",
        mentions: Array.from({ length: 51 }, (_, i) => `agent-${i}`),
        reply_to: null,
      }),
    });
    expect(tooMany.status).toBe(400);
  });

  it("rate limits repeated invalid send payloads", async () => {
    await avoidMinuteBoundary();
    const { token } = await seedToken("human");
    const slug = await createChannel(token);
    const body = JSON.stringify({ kind: "message", body: "small", mentions: ["../bad"], reply_to: null });
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) {
      const res = await api(`/api/channels/${slug}/messages`, token, { method: "POST", body });
      expect(res.status).toBe(400);
    }
    const limited = await api(`/api/channels/${slug}/messages`, token, { method: "POST", body });
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("rate_limited");
  }, 90_000);

  it("rejects invalid reply_to values", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    for (const reply_to of [0, -1, 1.5, "1"]) {
      const res = await api(`/api/channels/${slug}/messages`, token, {
        method: "POST",
        body: JSON.stringify({
          kind: "message",
          body: "small body",
          mentions: [],
          reply_to,
        }),
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("bad_request");
    }
  });
});
