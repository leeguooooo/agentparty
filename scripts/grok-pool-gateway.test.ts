import { describe, expect, it } from "bun:test";
import { createGrokPool, type PoolCredential } from "./grok-pool-gateway";

const credentials = (): PoolCredential[] => [
  { id: "grok-a", secret: "secret-a" },
  { id: "grok-b", secret: "secret-b" },
  { id: "grok-c", secret: "secret-c" },
];

const request = () => new Request("http://pool.local/v1/chat/completions", {
  method: "POST",
  headers: { authorization: "Bearer client-token", "content-type": "application/json" },
  body: JSON.stringify({ model: "grok-4.5", messages: [{ role: "user", content: "hi" }] }),
});

describe("authorized Grok credential pool", () => {
  it("switches once when the first credential has exhausted its spending limit", async () => {
    const attempts: string[] = [];
    const pool = createGrokPool({ credentials: credentials() });

    const response = await pool.handle(request(), async (credential) => {
      attempts.push(credential.id);
      if (credential.id === "grok-a") {
        return Response.json({ error: { message: "personal-team-blocked:spending-limit" } }, { status: 403 });
      }
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });

    expect(response.status).toBe(200);
    expect(attempts).toEqual(["grok-a", "grok-b"]);
    expect(pool.snapshot()).toMatchObject([
      { id: "grok-a", state: "exhausted" },
      { id: "grok-b", state: "healthy" },
      { id: "grok-c", state: "healthy" },
    ]);
  });

  it("classifies a spending-limit marker as exhausted regardless of HTTP status", async () => {
    const pool = createGrokPool({ credentials: credentials() });

    const response = await pool.handle(request(), async (credential) => credential.id === "grok-a"
      ? Response.json({ error: { message: "personal-team-blocked:spending-limit" } }, { status: 400 })
      : Response.json({ ok: true }));

    expect(response.status).toBe(200);
    expect(pool.snapshot()[0]).toMatchObject({ id: "grok-a", state: "exhausted" });
  });

  it("puts a rate-limited credential into cooldown before switching", async () => {
    let now = 1_000;
    const attempts: string[] = [];
    const pool = createGrokPool({ credentials: credentials(), now: () => now, cooldownMs: 30_000 });

    const response = await pool.handle(request(), async (credential) => {
      attempts.push(credential.id);
      return credential.id === "grok-a"
        ? Response.json({ error: { message: "rate limited" } }, { status: 429 })
        : Response.json({ ok: true });
    });

    expect(response.status).toBe(200);
    expect(attempts).toEqual(["grok-a", "grok-b"]);
    expect(pool.snapshot()[0]).toMatchObject({ state: "cooldown", retryAt: 31_000 });

    now = 31_001;
    expect(pool.snapshot()[0]).toMatchObject({ state: "healthy" });
  });

  it("revokes unauthorized credentials without logging plaintext secrets", async () => {
    const logs: unknown[] = [];
    const pool = createGrokPool({ credentials: credentials(), logger: (event) => logs.push(event) });

    await pool.handle(request(), async (credential) => credential.id === "grok-a"
      ? Response.json({ error: { message: "invalid oauth token secret-a" } }, { status: 401 })
      : Response.json({ ok: true }));

    expect(pool.snapshot()[0]).toMatchObject({ state: "revoked" });
    expect(JSON.stringify(logs)).not.toContain("secret-a");
    expect(JSON.stringify(logs)).not.toContain("secret-b");
    expect(JSON.stringify(logs)).not.toContain("client-token");
  });

  it("tries at most one fallback and returns an explicit pool_exhausted response", async () => {
    const attempts: string[] = [];
    const pool = createGrokPool({ credentials: credentials() });

    const response = await pool.handle(request(), async (credential) => {
      attempts.push(credential.id);
      return Response.json({ error: { message: "upstream unavailable" } }, { status: 503 });
    });

    expect(attempts).toEqual(["grok-a", "grok-b"]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "pool_exhausted", message: "No authorized Grok credential is currently available" },
    });
  });

  it("replays the same buffered JSON body for the fallback", async () => {
    const bodies: string[] = [];
    const pool = createGrokPool({ credentials: credentials() });

    const response = await pool.handle(request(), async (credential, forwarded) => {
      bodies.push(await forwarded.text());
      return credential.id === "grok-a"
        ? Response.json({ error: { message: "upstream unavailable" } }, { status: 503 })
        : Response.json({ ok: true });
    });

    expect(response.status).toBe(200);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0] ?? "{}").messages[0].content).toBe("hi");
  });

  it("short-circuits a client abort without attempting a fallback", async () => {
    const attempts: string[] = [];
    const controller = new AbortController();
    const aborted = new Request(request(), { signal: controller.signal });
    const pool = createGrokPool({ credentials: credentials() });

    const pending = pool.handle(aborted, async (credential) => {
      attempts.push(credential.id);
      controller.abort();
      throw new DOMException("client left", "AbortError");
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toEqual(["grok-a"]);
    expect(pool.snapshot()[0]).toMatchObject({ state: "healthy" });
  });

  it("temporarily cools down timeout and network failures", async () => {
    let now = 5_000;
    const pool = createGrokPool({ credentials: credentials(), now: () => now, transientCooldownMs: 5_000 });

    const response = await pool.handle(request(), async (credential) => {
      if (credential.id === "grok-a") throw new DOMException("timed out", "TimeoutError");
      throw new TypeError("network unavailable");
    });

    expect(response.status).toBe(503);
    expect(pool.snapshot().slice(0, 2)).toMatchObject([
      { id: "grok-a", state: "cooldown", retryAt: 10_000 },
      { id: "grok-b", state: "cooldown", retryAt: 10_000 },
    ]);
    now = 10_001;
    expect(pool.snapshot().slice(0, 2)).toMatchObject([
      { id: "grok-a", state: "healthy" },
      { id: "grok-b", state: "healthy" },
    ]);
  });

  it("shares failure state across concurrent requests without exposing secrets", async () => {
    const logs: unknown[] = [];
    const pool = createGrokPool({ credentials: credentials(), logger: (event) => logs.push(event) });
    let releaseFirst!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = pool.handle(request(), async (credential) => {
      if (credential.id === "grok-a") {
        await barrier;
        return Response.json({ error: { message: "invalid secret-a" } }, { status: 401 });
      }
      return Response.json({ request: "first" });
    });
    const second = pool.handle(request(), async (credential) => {
      releaseFirst();
      return credential.id === "grok-a"
        ? Response.json({ error: { message: "invalid secret-a" } }, { status: 401 })
        : Response.json({ request: "second" });
    });

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(pool.snapshot()[0]).toMatchObject({ state: "revoked" });
    expect(JSON.stringify(logs)).not.toContain("secret-a");
  });

  it("does not replay a streaming request after a successful response starts", async () => {
    const attempts: string[] = [];
    const pool = createGrokPool({ credentials: credentials() });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first-token\n\n"));
        controller.error(new Error("stream interrupted"));
      },
    });

    const response = await pool.handle(request(), async (credential) => {
      attempts.push(credential.id);
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    await expect(response.text()).rejects.toThrow("stream interrupted");
    expect(attempts).toEqual(["grok-a"]);
  });

  it("preserves failure state for unchanged credentials during hot replacement", async () => {
    const pool = createGrokPool({ credentials: credentials() });
    await pool.handle(request(), async (credential) => credential.id === "grok-a"
      ? Response.json({ error: { message: "personal-team-blocked:spending-limit" } }, { status: 403 })
      : Response.json({ ok: true }));

    pool.replaceCredentials([
      { id: "grok-a", secret: "secret-a" },
      { id: "grok-b", secret: "secret-b" },
      { id: "grok-new", secret: "secret-new" },
    ]);

    expect(pool.snapshot()).toMatchObject([
      { id: "grok-a", state: "exhausted" },
      { id: "grok-b", state: "healthy" },
      { id: "grok-new", state: "healthy" },
    ]);
  });
});
