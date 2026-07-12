import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGrokPoolConfig, startGrokPoolServer, type RunningGrokPoolServer } from "./grok-pool-server";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function credentialsFile(contents: unknown = [
  { id: "grok-a", token: "upstream-secret-a" },
  { id: "grok-b", token: "upstream-secret-b" },
]) {
  const directory = await mkdtemp(join(tmpdir(), "grok-pool-test-"));
  directories.push(directory);
  const path = join(directory, "credentials.json");
  await writeFile(path, JSON.stringify(contents));
  return path;
}

async function startUpstream(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function startPool(baseUrl: string, overrides: Record<string, string> = {}): Promise<RunningGrokPoolServer> {
  const server = await startGrokPoolServer({
    env: {
      GROK_POOL_CREDENTIALS_FILE: await credentialsFile(),
      GROK_POOL_CLIENT_TOKEN: "client-secret",
      GROK_POOL_BASE_URL: baseUrl,
      GROK_POOL_PORT: "8789",
      ...overrides,
    },
    port: 0,
  });
  servers.push(server.server);
  return server;
}

function chat(url: string, token = "client-secret", body: unknown = { model: "grok-test", custom: { passthrough: true } }) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-client-header": "kept" },
    body: JSON.stringify(body),
  });
}

describe("authorized Grok pool server", () => {
  it("rejects missing, empty, duplicate, malformed and tracked credential configuration", async () => {
    const valid = {
      GROK_POOL_CLIENT_TOKEN: "client-secret",
      GROK_POOL_BASE_URL: "https://example.test",
      GROK_POOL_PORT: "8789",
    };
    await expect(loadGrokPoolConfig(valid)).rejects.toThrow("GROK_POOL_CREDENTIALS_FILE");
    await expect(loadGrokPoolConfig({ ...valid, GROK_POOL_CREDENTIALS_FILE: await credentialsFile([]) })).rejects.toThrow("empty");
    await expect(loadGrokPoolConfig({
      ...valid,
      GROK_POOL_CREDENTIALS_FILE: await credentialsFile([{ id: "same", token: "a" }, { id: "same", token: "b" }]),
    })).rejects.toThrow("duplicate credential id: same");
    await expect(loadGrokPoolConfig({
      ...valid,
      GROK_POOL_CREDENTIALS_FILE: await credentialsFile([{ id: "safe", token: "" }]),
    })).rejects.toThrow("credential safe has an invalid token");
    await expect(loadGrokPoolConfig({ ...valid, GROK_POOL_CREDENTIALS_FILE: "scripts/grok-pool-gateway.ts" })).rejects.toThrow("version controlled");
    await expect(loadGrokPoolConfig({ ...valid, GROK_POOL_CLIENT_TOKEN: "" , GROK_POOL_CREDENTIALS_FILE: await credentialsFile() })).rejects.toThrow("GROK_POOL_CLIENT_TOKEN");
    const malformed = await credentialsFile([]);
    await writeFile(malformed, '{"token":"plaintext-secret",');
    try {
      await loadGrokPoolConfig({ ...valid, GROK_POOL_CREDENTIALS_FILE: malformed });
      throw new Error("expected malformed credentials to fail");
    } catch (error) {
      expect(String(error)).toContain("valid credential JSON");
      expect(String(error)).not.toContain("plaintext-secret");
    }
  });

  it("only accepts loopback listener settings and bounded positive timing values", async () => {
    const base = {
      GROK_POOL_CREDENTIALS_FILE: await credentialsFile(),
      GROK_POOL_CLIENT_TOKEN: "client-secret",
      GROK_POOL_BASE_URL: "https://example.test",
      GROK_POOL_PORT: "8789",
    };
    await expect(loadGrokPoolConfig({ ...base, GROK_POOL_HOST: "0.0.0.0" })).rejects.toThrow("127.0.0.1");
    await expect(loadGrokPoolConfig({ ...base, GROK_POOL_PORT: "0" })).rejects.toThrow("GROK_POOL_PORT");
    await expect(loadGrokPoolConfig({ ...base, GROK_POOL_COOLDOWN_SECONDS: "601" })).rejects.toThrow("10 minutes");
  });

  it("requires client authorization before health or upstream use", async () => {
    let upstreamCalls = 0;
    const upstream = await startUpstream(() => { upstreamCalls += 1; return Response.json({ ok: true }); });
    const pool = await startPool(upstream);

    expect((await chat(pool.url, "wrong")).status).toBe(401);
    expect((await fetch(`${pool.url}/health`)).status).toBe(401);
    expect(upstreamCalls).toBe(0);
  });

  it("transparently forwards authorized JSON while replacing Authorization", async () => {
    const seen: Array<{ authorization: string | null; body: unknown; customHeader: string | null }> = [];
    const upstream = await startUpstream(async (request) => {
      seen.push({
        authorization: request.headers.get("authorization"),
        body: await request.json(),
        customHeader: request.headers.get("x-client-header"),
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], extra: 7 }), {
        status: 201,
        headers: { "content-type": "application/json", "x-upstream": "yes" },
      });
    });
    const pool = await startPool(upstream);
    const body = { model: "grok-test", messages: [{ role: "user", content: "authorized smoke" }], unknown: 42 };

    const response = await chat(pool.url, "client-secret", body);

    expect(response.status).toBe(201);
    expect(response.headers.get("x-upstream")).toBe("yes");
    expect(await response.json()).toEqual({ choices: [{ message: { content: "ok" } }], extra: 7 });
    expect(seen).toEqual([{ authorization: "Bearer upstream-secret-a", body, customHeader: "kept" }]);
  });

  it("replays the buffered body once when an HTTP failure occurs before success", async () => {
    const attempts: Array<{ auth: string | null; body: string }> = [];
    const upstream = await startUpstream(async (request) => {
      attempts.push({ auth: request.headers.get("authorization"), body: await request.text() });
      return attempts.length === 1
        ? Response.json({ error: { message: "personal-team-blocked:spending-limit" } }, { status: 403 })
        : Response.json({ ok: true });
    });
    const pool = await startPool(upstream);

    expect((await chat(pool.url)).status).toBe(200);
    expect(attempts.map(({ auth }) => auth)).toEqual(["Bearer upstream-secret-a", "Bearer upstream-secret-b"]);
    expect(attempts[0]?.body).toBe(attempts[1]?.body);
  });

  it("switches a stream request after an HTTP failure before delivering SSE", async () => {
    let attempts = 0;
    const authorizations: Array<string | null> = [];
    const upstream = await startUpstream((request) => {
      attempts += 1;
      authorizations.push(request.headers.get("authorization"));
      if (attempts === 1) return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
      return new Response("data: recovered\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const pool = await startPool(upstream);

    const response = await chat(pool.url, "client-secret", { model: "grok-test", stream: true });

    expect({ status: response.status, attempts, authorizations }).toEqual({
      status: 200,
      attempts: 2,
      authorizations: ["Bearer upstream-secret-a", "Bearer upstream-secret-b"],
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe("data: recovered\n\n");
  });

  it("streams successful SSE without replaying after the client stops reading", async () => {
    let attempts = 0;
    const upstream = await startUpstream(() => {
      attempts += 1;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first-token\n\n"));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const pool = await startPool(upstream);

    const response = await chat(pool.url, "client-secret", { model: "grok-test", stream: true });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("data: first-token");
    await reader?.cancel();
    expect(attempts).toBe(1);
  });

  it("returns redacted health and stable pool_exhausted errors", async () => {
    const logs: unknown[] = [];
    const upstream = await startUpstream(() => Response.json({ error: { message: "leaked upstream-secret-a body" } }, { status: 401 }));
    const pool = await startGrokPoolServer({
      env: {
        GROK_POOL_CREDENTIALS_FILE: await credentialsFile(),
        GROK_POOL_CLIENT_TOKEN: "client-secret",
        GROK_POOL_BASE_URL: upstream,
        GROK_POOL_PORT: "8789",
      },
      port: 0,
      logger: (event) => logs.push(event),
    });
    servers.push(pool.server);

    const failed = await chat(pool.url, "client-secret", { model: "grok-test", messages: [{ content: "private request body" }] });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: { code: "pool_exhausted", message: "No authorized Grok credential is currently available" },
    });
    const health = await fetch(`${pool.url}/health`, { headers: { authorization: "Bearer client-secret" } });
    const serialized = JSON.stringify({ health: await health.json(), logs });
    expect(serialized).toContain("grok-a");
    expect(serialized).toContain("revoked");
    for (const secret of ["upstream-secret-a", "upstream-secret-b", "client-secret", "private request body", "leaked"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("hot reloads a valid credential file and keeps the old pool when reload is invalid", async () => {
    const credentialsPath = await credentialsFile([{ id: "grok-a", token: "upstream-secret-a" }]);
    const seen: Array<string | null> = [];
    const upstream = await startUpstream((request) => {
      seen.push(request.headers.get("authorization"));
      return Response.json({ ok: true });
    });
    const pool = await startGrokPoolServer({
      env: {
        GROK_POOL_CREDENTIALS_FILE: credentialsPath,
        GROK_POOL_CLIENT_TOKEN: "client-secret",
        GROK_POOL_BASE_URL: upstream,
        GROK_POOL_PORT: "8789",
        GROK_POOL_RELOAD_INTERVAL_SECONDS: "1",
      },
      port: 0,
    });
    servers.push(pool.server);

    expect((await chat(pool.url)).status).toBe(200);
    await writeFile(credentialsPath, JSON.stringify([{ id: "grok-b", token: "upstream-secret-b" }]));
    expect(await pool.reloadNow()).toBe(true);
    expect((await chat(pool.url)).status).toBe(200);

    await writeFile(credentialsPath, "not-json");
    expect(await pool.reloadNow()).toBe(false);
    expect((await chat(pool.url)).status).toBe(200);
    expect(seen).toEqual([
      "Bearer upstream-secret-a",
      "Bearer upstream-secret-b",
      "Bearer upstream-secret-b",
    ]);

    const health = await fetch(`${pool.url}/health`, { headers: { authorization: "Bearer client-secret" } });
    expect(await health.json()).toMatchObject({ credentials: [{ id: "grok-b", state: "healthy" }] });
  });
});
