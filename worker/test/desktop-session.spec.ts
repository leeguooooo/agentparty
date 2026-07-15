import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, completeCapabilityHello, createChannel, seedToken, uniq, WsClient } from "./helpers";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challenge(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

function post(path: string, body: unknown, token?: string) {
  return SELF.fetch(`http://ap.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function pairedSession(account = uniq("desktop-account")) {
  const verifier = `verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const deviceSecret = `device-secret-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const started = await post("/api/desktop/pairings", {
    code_challenge_method: "S256",
    code_challenge: await challenge(verifier),
    device_secret_challenge: await challenge(deviceSecret),
    device: { name: "Session Mac", platform: "darwin", app_version: "0.3.0" },
  });
  expect(started.status).toBe(201);
  const pairing = (await started.json()) as { device_code: string; user_code: string };
  const human = await seedToken("human", uniq("desktop-human"), { owner: account });
  expect((await post("/api/desktop/pairings/decision", { user_code: pairing.user_code, decision: "approve" }, human.token)).status).toBe(200);
  const exchange = await post("/api/desktop/pairings/token", { device_code: pairing.device_code, code_verifier: verifier });
  expect(exchange.status).toBe(200);
  return {
    account,
    humanToken: human.token,
    deviceSecret,
    tokens: (await exchange.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_expires_in: number;
      session_id: string;
    },
  };
}

describe("desktop sessions", () => {
  it("rotates refresh and access tokens using the device secret", async () => {
    const paired = await pairedSession();
    const refreshed = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.access_token).not.toBe(paired.tokens.access_token);
    expect(next.refresh_token).not.toBe(paired.tokens.refresh_token);
    expect((await api("/api/me", paired.tokens.access_token)).status).toBe(401);
    expect((await api("/api/me", next.access_token)).status).toBe(200);

    const session = await env.DB.prepare("SELECT * FROM desktop_sessions WHERE id = ?")
      .bind(paired.tokens.session_id)
      .first<Record<string, unknown>>();
    const stored = JSON.stringify(session);
    expect(stored).not.toContain(paired.tokens.access_token);
    expect(stored).not.toContain(paired.tokens.refresh_token);
    expect(stored).not.toContain(next.access_token);
    expect(stored).not.toContain(next.refresh_token);
    expect(stored).not.toContain(paired.deviceSecret);

    const audit = await env.DB.prepare("SELECT * FROM desktop_audit WHERE session_id = ?")
      .bind(paired.tokens.session_id)
      .all<Record<string, unknown>>();
    const auditStored = JSON.stringify(audit.results);
    expect(auditStored).not.toContain(paired.tokens.access_token);
    expect(auditStored).not.toContain(paired.tokens.refresh_token);
    expect(auditStored).not.toContain(paired.deviceSecret);
  });

  it("recovers a recently rotated refresh token with the bound device secret", async () => {
    const paired = await pairedSession();
    const refreshed = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    const generationTwo = (await refreshed.json()) as { access_token: string; refresh_token: string };
    await env.DB.prepare("UPDATE desktop_refresh_history SET rotated_at = ? WHERE session_id = ?")
      .bind(Date.now() - 2_000, paired.tokens.session_id)
      .run();

    const recovered = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    expect(recovered.status).toBe(200);
    const generationThree = (await recovered.json()) as { access_token: string; refresh_token: string };
    expect(generationThree.access_token).not.toBe(generationTwo.access_token);
    expect(generationThree.refresh_token).not.toBe(generationTwo.refresh_token);
    expect((await api("/api/me", generationTwo.access_token)).status).toBe(401);
    expect((await api("/api/me", generationThree.access_token)).status).toBe(200);

    const history = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM desktop_refresh_history WHERE session_id = ?",
    )
      .bind(paired.tokens.session_id)
      .first<{ count: number }>();
    expect(history?.count).toBe(2);
  });

  it("rejects an old refresh token with the wrong device proof without revoking the session", async () => {
    const paired = await pairedSession();
    const refreshed = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    const next = (await refreshed.json()) as { access_token: string };

    const replay = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: `wrong-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    });
    expect(replay.status).toBe(401);
    expect((await api("/api/me", next.access_token)).status).toBe(200);

    const audit = await env.DB.prepare(
      "SELECT event FROM desktop_audit WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(paired.tokens.session_id)
      .first<{ event: string }>();
    expect(audit?.event).toBe("refresh_recovery_device_proof_failed");
  });

  it("revokes the whole session when an old refresh token is replayed outside the recovery window", async () => {
    const paired = await pairedSession();
    const refreshed = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    const next = (await refreshed.json()) as { access_token: string };
    await env.DB.prepare("UPDATE desktop_refresh_history SET rotated_at = ? WHERE session_id = ?")
      .bind(Date.now() - 5 * 60_000 - 1, paired.tokens.session_id)
      .run();

    const replay = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    expect(replay.status).toBe(403);
    expect((await api("/api/me", next.access_token)).status).toBe(401);
  });

  it("allows only one concurrent recovery rotation and keeps the winner usable", async () => {
    const paired = await pairedSession();
    await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    await env.DB.prepare("UPDATE desktop_refresh_history SET rotated_at = ? WHERE session_id = ?")
      .bind(Date.now() - 2_000, paired.tokens.session_id)
      .run();
    const recover = () =>
      post("/api/desktop/sessions/refresh", {
        refresh_token: paired.tokens.refresh_token,
        device_secret: paired.deviceSecret,
      });

    const responses = await Promise.all([recover(), recover()]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    const winner = responses.find((res) => res.status === 200)!;
    const next = (await winner.json()) as { access_token: string };
    expect((await api("/api/me", next.access_token)).status).toBe(200);
  });

  it("allows only one concurrent initial rotation and keeps the winner usable", async () => {
    const paired = await pairedSession();
    const refresh = () =>
      post("/api/desktop/sessions/refresh", {
        refresh_token: paired.tokens.refresh_token,
        device_secret: paired.deviceSecret,
      });

    const responses = await Promise.all([refresh(), refresh()]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    const winner = responses.find((res) => res.status === 200)!;
    const next = (await winner.json()) as { access_token: string };
    expect((await api("/api/me", next.access_token)).status).toBe(200);
  });

  it("detects replay of a refresh token older than the immediately previous generation", async () => {
    const paired = await pairedSession();
    const first = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    const generationTwo = (await first.json()) as { access_token: string; refresh_token: string };
    const second = await post("/api/desktop/sessions/refresh", {
      refresh_token: generationTwo.refresh_token,
      device_secret: paired.deviceSecret,
    });
    const generationThree = (await second.json()) as { access_token: string };
    await env.DB.prepare("UPDATE desktop_refresh_history SET rotated_at = ? WHERE session_id = ?")
      .bind(Date.now() - 5 * 60_000 - 1, paired.tokens.session_id)
      .run();

    const replay = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    expect(replay.status).toBe(403);
    expect((await api("/api/me", generationThree.access_token)).status).toBe(401);
  });

  it("rejects refresh with the wrong device secret", async () => {
    const paired = await pairedSession();
    const res = await post("/api/desktop/sessions/refresh", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: `wrong-${crypto.randomUUID()}`,
    });
    expect(res.status).toBe(401);
  });

  it("lets humans list and delete only their own device sessions", async () => {
    const mine = await pairedSession(uniq("owner-a"));
    const other = await pairedSession(uniq("owner-b"));

    const list = await api("/api/desktop/sessions", mine.humanToken);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sessions: Array<{ id: string; device: { name: string } }> };
    expect(body.sessions.map((session) => session.id)).toContain(mine.tokens.session_id);
    expect(body.sessions.map((session) => session.id)).not.toContain(other.tokens.session_id);
    expect(body.sessions[0]).not.toHaveProperty("access_token");

    expect((await api(`/api/desktop/sessions/${other.tokens.session_id}`, mine.humanToken, { method: "DELETE" })).status).toBe(404);
    expect((await api(`/api/desktop/sessions/${mine.tokens.session_id}`, mine.humanToken, { method: "DELETE" })).status).toBe(204);
    expect((await api("/api/me", mine.tokens.access_token)).status).toBe(401);
  });

  it("lets a device revoke itself", async () => {
    const paired = await pairedSession();
    const wrongProof = await post("/api/desktop/sessions/revoke", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: `wrong-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    });
    expect(wrongProof.status).toBe(204);
    expect((await api("/api/me", paired.tokens.access_token)).status).toBe(200);

    const revoked = await post("/api/desktop/sessions/revoke", {
      refresh_token: paired.tokens.refresh_token,
      device_secret: paired.deviceSecret,
    });
    expect(revoked.status).toBe(204);
    expect((await api("/api/me", paired.tokens.access_token)).status).toBe(401);

    const unknown = await post("/api/desktop/sessions/revoke", {
      refresh_token: `apr_${"A".repeat(43)}`,
      device_secret: paired.deviceSecret,
    });
    expect(unknown.status).toBe(204);
  });

  it("makes desktop access revocation immediately visible to Durable Objects", async () => {
    const paired = await pairedSession();
    const slug = await createChannel(paired.tokens.access_token);
    const ws = await WsClient.open(slug, paired.tokens.access_token);
    await completeCapabilityHello(ws);

    expect((await api(`/api/desktop/sessions/${paired.tokens.session_id}`, paired.humanToken, { method: "DELETE" })).status).toBe(204);
    ws.send({ type: "message", body: "after revoke", mentions: [] });
    const error = await ws.nextOfType("error");
    expect(error).toMatchObject({ code: "unauthorized" });
    ws.close();
  });

  it("expires short-lived desktop access tokens", async () => {
    const paired = await pairedSession();
    await env.DB.prepare("UPDATE desktop_sessions SET access_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, paired.tokens.session_id)
      .run();
    expect((await api("/api/me", paired.tokens.access_token)).status).toBe(401);
  });
});
