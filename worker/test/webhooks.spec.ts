import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { LOOP_GUARD_N, MAX_WEBHOOKS_PER_CHANNEL, WEBHOOK_MAX_RETRIES } from "@agentparty/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, disableLoopGuard, postMessage, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

interface CapturedRequest {
  headers: Record<string, string>;
  body: string;
}

// undici mock 回调里的 headers/body 形态因版本而异，统一归一化
function normalize(opts: { headers?: unknown; body?: unknown }): CapturedRequest {
  const headers: Record<string, string> = {};
  const h = opts.headers;
  if (Array.isArray(h)) {
    for (let i = 0; i + 1 < h.length; i += 2) headers[String(h[i]).toLowerCase()] = String(h[i + 1]);
  } else if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      headers[k.toLowerCase()] = String(v);
    }
  }
  let body = "";
  if (typeof opts.body === "string") body = opts.body;
  else if (opts.body instanceof ArrayBuffer) body = new TextDecoder().decode(opts.body);
  else if (ArrayBuffer.isView(opts.body)) {
    body = new TextDecoder().decode(opts.body as Uint8Array);
  } else if (opts.body != null) body = String(opts.body);
  return { headers, body };
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sendMessage(slug: string, token: string, body: string, mentions: string[] = []) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null }),
  });
}

function sendStatus(slug: string, token: string, state: "working" | "waiting" | "blocked" | "done", note: string) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "status", state, note }),
  });
}

function addWebhook(
  slug: string,
  token: string,
  hook: { name: string; url: string; secret: string; filter?: string },
) {
  return api(`/api/channels/${slug}/webhooks`, token, {
    method: "POST",
    body: JSON.stringify(hook),
  });
}

async function queueRows(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec("SELECT webhook_name, attempts, next_retry_at FROM webhook_queue")
      .toArray()
      .map((r) => ({ webhook_name: String(r.webhook_name), attempts: Number(r.attempts) })),
  );
}

describe("webhooks", () => {
  it("registers, lists without leaking secret, deletes; readonly is rejected", async () => {
    const agent = await seedToken("agent");
    const ro = await seedToken("readonly");
    const slug = await createChannel(agent.token);

    const forbidden = await addWebhook(slug, ro.token, {
      name: "hermes",
      url: "https://hooks.test/wake",
      secret: "super-secret",
    });
    expect(forbidden.status).toBe(403);

    const bad = await addWebhook(slug, agent.token, {
      name: "hermes",
      url: "not-a-url",
      secret: "s",
    });
    expect(bad.status).toBe(400);
    const noSecret = await api(`/api/channels/${slug}/webhooks`, agent.token, {
      method: "POST",
      body: JSON.stringify({ name: "hermes", url: "https://hooks.test/wake" }),
    });
    expect(noSecret.status).toBe(400);
    const badFilter = await addWebhook(slug, agent.token, {
      name: "hermes",
      url: "https://hooks.test/wake",
      secret: "s",
      filter: "everything",
    });
    expect(badFilter.status).toBe(400);
    for (const url of [
      "http://hooks.test/wake",
      "https://localhost/wake",
      "https://localhost./wake",
      "https://foo.localhost./wake",
      "https://127.0.0.1/wake",
      "https://10.0.0.1/wake",
      "https://0300.0250.0001.0001/wake",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/wake",
      "https://[fd00::1]/wake",
      "https://[fc00::1]/wake",
      "https://[fe80::1]/wake",
      "https://[fe81::1]/wake",
      "https://[febf::1]/wake",
      "https://[::ffff:127.0.0.1]/wake",
      "https://[::ffff:169.254.169.254]/wake",
      "https://user:pass@hooks.test/wake",
    ]) {
      const unsafe = await addWebhook(slug, agent.token, { name: "hermes", url, secret: "s" });
      expect(unsafe.status).toBe(400);
    }
    for (const secret of ["has space", "line\nbreak", "line\rbreak", "tab\tbreak", "del\x7f", "非ascii"]) {
      const unsafe = await addWebhook(slug, agent.token, {
        name: uniq("hook"),
        url: "https://hooks.test/wake",
        secret,
      });
      expect(unsafe.status).toBe(400);
    }

    const created = await addWebhook(slug, agent.token, {
      name: "hermes",
      url: "https://hooks.test/wake",
      secret: "super-secret",
      filter: "mentions",
    });
    expect(created.status).toBe(201);

    const list = await api(`/api/channels/${slug}/webhooks`, agent.token);
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("secret");
    const { webhooks } = JSON.parse(text) as { webhooks: Record<string, unknown>[] };
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]).toMatchObject({ name: "hermes", url: "https://hooks.test/wake", filter: "mentions" });

    const roList = await api(`/api/channels/${slug}/webhooks`, ro.token);
    expect(roList.status).toBe(403);

    const roDelete = await api(`/api/channels/${slug}/webhooks/hermes`, ro.token, { method: "DELETE" });
    expect(roDelete.status).toBe(403);
    const del = await api(`/api/channels/${slug}/webhooks/hermes`, agent.token, { method: "DELETE" });
    expect(del.status).toBe(200);
    const again = await api(`/api/channels/${slug}/webhooks/hermes`, agent.token, { method: "DELETE" });
    expect(again.status).toBe(404);
    const empty = (await (await api(`/api/channels/${slug}/webhooks`, agent.token)).json()) as {
      webhooks: unknown[];
    };
    expect(empty.webhooks).toHaveLength(0);

    const maxSecret = "s".repeat(4096);
    const maxOk = await addWebhook(slug, agent.token, {
      name: "maxlen",
      url: "https://hooks.test/wake",
      secret: maxSecret,
    });
    expect(maxOk.status).toBe(201);
    const tooLong = await addWebhook(slug, agent.token, {
      name: "toolong",
      url: "https://hooks.test/wake",
      secret: "s".repeat(4097),
    });
    expect(tooLong.status).toBe(400);
  });

  it("caps webhook registrations per channel", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    for (let i = 0; i < MAX_WEBHOOKS_PER_CHANNEL; i++) {
      const res = await addWebhook(slug, token, {
        name: `hook-${i}`,
        url: `https://hooks.test/${i}`,
        secret: "s",
      });
      expect(res.status).toBe(201);
    }
    const capped = await addWebhook(slug, token, {
      name: "one-more",
      url: "https://hooks.test/overflow",
      secret: "s",
    });
    expect(capped.status).toBe(429);
  });

  it("rejects webhook management after channel archive", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect(
      (await addWebhook(slug, token, { name: "hermes", url: "https://hooks.test/wake", secret: "s" }))
        .status,
    ).toBe(201);
    expect((await api(`/api/channels/${slug}/archive`, token, { method: "POST" })).status).toBe(200);

    expect(
      (await addWebhook(slug, token, { name: "new-hook", url: "https://hooks.test/new", secret: "s" }))
        .status,
    ).toBe(410);
    expect((await api(`/api/channels/${slug}/webhooks`, token)).status).toBe(410);
    expect((await api(`/api/channels/${slug}/webhooks/hermes`, token, { method: "DELETE" })).status).toBe(410);
  });

  it("mentions filter fires only when mentioned, with bearer auth and a valid hmac signature", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const secret = "hook-tok-1";
    expect(
      (await addWebhook(slug, token, { name: "hermes", url: "https://hooks.test/wake", secret })).status,
    ).toBe(201);

    // 未 @hermes：不投递（disableNetConnect 下若误投会入重试队列）
    expect((await sendMessage(slug, token, "no mention here")).status).toBe(200);
    expect(await queueRows(slug)).toHaveLength(0);

    let captured: CapturedRequest | null = null;
    fetchMock
      .get("https://hooks.test")
      .intercept({ path: "/wake", method: "POST" })
      .reply(200, (opts) => {
        captured = normalize(opts as { headers?: unknown; body?: unknown });
        return "ok";
      });

    expect((await sendMessage(slug, token, "@hermes wake up", ["hermes"])).status).toBe(200);
    expect(captured).not.toBeNull();
    const { headers, body } = captured as unknown as CapturedRequest;

    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "msg",
      kind: "message",
      body: "@hermes wake up",
      mentions: ["hermes"],
      channel: slug,
      permalink: `https://ap.test/c/${slug}`,
    });
    expect(typeof payload.seq).toBe("number");
    expect((payload.sender as { name: string }).name).toBeTruthy();

    expect(headers.authorization).toBe(`Bearer ${secret}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-agentparty-signature"]).toBe(`hmac-sha256=${await hmacHex(secret, body)}`);
    expect(await queueRows(slug)).toHaveLength(0);
  });

  it("mentions filter also wakes on status mentions", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const secret = "status-hook";
    expect(
      (await addWebhook(slug, token, { name: "dispatcher", url: "https://hooks.test/status", secret })).status,
    ).toBe(201);

    let captured: CapturedRequest | null = null;
    fetchMock
      .get("https://hooks.test")
      .intercept({ path: "/status", method: "POST" })
      .reply(200, (opts) => {
        captured = normalize(opts as { headers?: unknown; body?: unknown });
        return "ok";
      });

    const res = await api(`/api/channels/${slug}/messages`, token, {
      method: "POST",
      body: JSON.stringify({
        kind: "status",
        state: "working",
        note: "claimed webhook wake verification",
        mentions: ["dispatcher"],
      }),
    });
    expect(res.status).toBe(200);

    expect(captured).not.toBeNull();
    const { headers, body } = captured as unknown as CapturedRequest;
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "status",
      kind: "status",
      state: "working",
      note: "claimed webhook wake verification",
      body: "claimed webhook wake verification",
      mentions: ["dispatcher"],
      channel: slug,
    });
    expect(headers.authorization).toBe(`Bearer ${secret}`);
    expect(headers["x-agentparty-signature"]).toBe(`hmac-sha256=${await hmacHex(secret, body)}`);
    expect(await queueRows(slug)).toHaveLength(0);
  });

  it("status filter delivers status updates but ignores ordinary messages", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect(
      (
        await addWebhook(slug, token, {
          name: "ops",
          url: "https://hooks.test/status-only",
          secret: "s",
          filter: "status",
        })
      ).status,
    ).toBe(201);

    expect((await sendMessage(slug, token, "ordinary chatter")).status).toBe(200);
    expect(await queueRows(slug)).toHaveLength(0);

    let captured: CapturedRequest | null = null;
    fetchMock
      .get("https://hooks.test")
      .intercept({ path: "/status-only", method: "POST" })
      .reply(200, (opts) => {
        captured = normalize(opts as { headers?: unknown; body?: unknown });
        return "ok";
      });
    expect((await sendStatus(slug, token, "working", "claiming the status lane")).status).toBe(200);

    expect(captured).not.toBeNull();
    const payload = JSON.parse((captured as unknown as CapturedRequest).body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "status",
      kind: "status",
      state: "working",
      note: "claiming the status lane",
      channel: slug,
    });
  });

  it("needs-human filter delivers blocked and done statuses only", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect(
      (
        await addWebhook(slug, token, {
          name: "human-ops",
          url: "https://hooks.test/needs-human",
          secret: "s",
          filter: "needs-human",
        })
      ).status,
    ).toBe(201);

    expect((await sendStatus(slug, token, "working", "routine progress")).status).toBe(200);
    expect((await sendStatus(slug, token, "waiting", "online but idle")).status).toBe(200);
    expect(await queueRows(slug)).toHaveLength(0);

    const captured: Record<string, unknown>[] = [];
    fetchMock
      .get("https://hooks.test")
      .intercept({ path: "/needs-human", method: "POST" })
      .reply(200, (opts) => {
        captured.push(JSON.parse(normalize(opts as { headers?: unknown; body?: unknown }).body) as Record<string, unknown>);
        return "ok";
      })
      .times(2);

    expect((await sendStatus(slug, token, "blocked", "need owner token")).status).toBe(200);
    expect((await sendStatus(slug, token, "done", "ready for review")).status).toBe(200);

    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ type: "status", state: "blocked", note: "need owner token" });
    expect(captured[1]).toMatchObject({ type: "status", state: "done", note: "ready for review" });
  });

  it("needs-human filter does not receive loop guard statuses while loop guard is disabled", async () => {
    const agentA = await seedToken("agent");
    const agentB = await seedToken("agent");
    const slug = await createChannel(agentA.token);
    // #96 起新频道默认开 guard；本用例测的是关闭态，必须显式关闭
    await disableLoopGuard(slug, agentA.token);
    expect(
      (
        await addWebhook(slug, agentA.token, {
          name: "human-ops",
          url: "https://hooks.test/loop-guard",
          secret: "s",
          filter: "needs-human",
        })
      ).status,
    ).toBe(201);

    for (let i = 0; i < LOOP_GUARD_N + 1; i++) {
      const token = i % 2 === 0 ? agentA.token : agentB.token;
      expect((await sendMessage(slug, token, `guard filler ${i}`)).status).toBe(200);
    }
    expect(await queueRows(slug)).toHaveLength(0);
  });

  it("filter all delivers messages without mentions", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect(
      (
        await addWebhook(slug, token, {
          name: uniq("hook"),
          url: "https://hooks.test/all",
          secret: "s",
          filter: "all",
        })
      ).status,
    ).toBe(201);

    let captured: CapturedRequest | null = null;
    fetchMock
      .get("https://hooks.test")
      .intercept({ path: "/all", method: "POST" })
      .reply(200, (opts) => {
        captured = normalize(opts as { headers?: unknown; body?: unknown });
        return "ok";
      });
    expect((await sendMessage(slug, token, "broadcast to all")).status).toBe(200);
    expect(captured).not.toBeNull();
    expect(
      (JSON.parse((captured as unknown as CapturedRequest).body) as { body: string }).body,
    ).toBe("broadcast to all");
  });

  it("failed delivery is queued and the alarm retry drains it on success", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect(
      (await addWebhook(slug, token, { name: "hermes", url: "https://down.test/wake", secret: "s" }))
        .status,
    ).toBe(201);

    // 没有 interceptor + disableNetConnect：立即投递失败 → 入队 attempts=1
    expect((await sendMessage(slug, token, "@hermes ping", ["hermes"])).status).toBe(200);
    let rows = await queueRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ webhook_name: "hermes", attempts: 1 });

    // 到期后 alarm 重投成功 → 队列清空
    fetchMock.get("https://down.test").intercept({ path: "/wake", method: "POST" }).reply(200, "ok");
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE webhook_queue SET next_retry_at = ?", Date.now() - 1);
      await instance.onAlarm();
    });
    rows = await queueRows(slug);
    expect(rows).toHaveLength(0);
  });

  it("drops after 3 failed retries and posts a system status to the channel", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect(
      (await addWebhook(slug, token, { name: "hermes", url: "https://dead.test/wake", secret: "s" }))
        .status,
    ).toBe(201);
    expect((await sendMessage(slug, token, "@hermes ping", ["hermes"])).status).toBe(200);
    expect(await queueRows(slug)).toHaveLength(1);

    // 直接把 attempts 拨到最后一档，下一次失败即达到 3 次上限 → 丢弃 + system status
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE webhook_queue SET attempts = ?, next_retry_at = ?",
        WEBHOOK_MAX_RETRIES,
        Date.now() - 1,
      );
      await instance.onAlarm();
    });
    expect(await queueRows(slug)).toHaveLength(0);

    const history = await api(`/api/channels/${slug}/messages`, token);
    const { messages } = (await history.json()) as {
      messages: {
        sender: { name: string; kind: string };
        kind: string;
        state: string | null;
        note: string | null;
      }[];
    };
    const status = messages.at(-1);
    expect(status).toMatchObject({
      sender: { name: "system", kind: "agent" },
      kind: "status",
      state: "blocked",
    });
    expect(status?.note).toContain("webhook hermes 连续投递失败");
  });
});
