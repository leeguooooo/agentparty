import { env, runInDurableObject } from "cloudflare:test";
import { BODY_LIMIT, LOOP_GUARD_N, RATE_LIMIT_PER_MIN } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { createChannel, postMessage, seedToken } from "./helpers";

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
  it("loop guard blocks the 31st consecutive agent message, human resets", async () => {
    const agentA = await seedToken("agent");
    const agentB = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agentA.token);

    // 两个 agent token 交替，避开单 token 速率限制，streak 仍按 kind 累计
    for (let i = 0; i < LOOP_GUARD_N; i++) {
      const res = await postMessage(slug, i % 2 === 0 ? agentA.token : agentB.token, `m${i}`);
      expect(res.status).toBe(200);
    }
    const blocked = await postMessage(slug, agentA.token, "one too many");
    expect(blocked.status).toBe(409);
    expect(await errorCode(blocked)).toBe("loop_guard");

    const humanMsg = await postMessage(slug, human.token, "humans are here");
    expect(humanMsg.status).toBe(200);
    const resumed = await postMessage(slug, agentB.token, "back to work");
    expect(resumed.status).toBe(200);
  }, 30_000);

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
  });

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
});
