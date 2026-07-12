import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedToken, uniq } from "./helpers";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challenge(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

function desktop(path: string, body: unknown, token?: string, ip = "203.0.113.10") {
  return SELF.fetch(`http://ap.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function startPairing(ip = "203.0.113.10") {
  const verifier = `verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const deviceSecret = `device-secret-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const res = await desktop(
    "/api/desktop/pairings",
    {
      code_challenge_method: "S256",
      code_challenge: await challenge(verifier),
      device_secret_challenge: await challenge(deviceSecret),
      device: { name: "Leo Mac", platform: "darwin", app_version: "0.3.0" },
    },
    undefined,
    ip,
  );
  expect(res.status).toBe(201);
  return {
    res,
    verifier,
    deviceSecret,
    body: (await res.clone().json()) as {
      pairing_id: string;
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    },
  };
}

async function approve(userCode: string, humanToken: string) {
  return desktop("/api/desktop/pairings/decision", { user_code: userCode, decision: "approve" }, humanToken);
}

async function approvedPairing(ip: string) {
  const started = await startPairing(ip);
  const human = await seedToken("human", uniq("desktop-human"), { owner: uniq("account") });
  expect((await approve(started.body.user_code, human.token)).status).toBe(200);
  return started;
}

async function exchangeApproved(ip: string) {
  const started = await approvedPairing(ip);
  const response = await desktop("/api/desktop/pairings/token", {
    device_code: started.body.device_code,
    code_verifier: started.verifier,
  });
  expect(response.status).toBe(200);
  return { started, response, body: await response.clone().text() };
}

function expectSensitiveHeaders(res: Response) {
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.headers.get("cache-control")).toContain("no-cache");
  expect(res.headers.get("pragma")).toBe("no-cache");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("desktop device pairing", () => {
  it("starts an unauthenticated S256 pairing without persisting plaintext credentials", async () => {
    const started = await startPairing();

    expect(started.res.status).toBe(201);
    expect(started.body).toMatchObject({ expires_in: 300, interval: 3 });
    expect(started.body.pairing_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.body.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.body.user_code).toMatch(/^[23456789BCDFGHJKLMNP]{5}-[23456789BCDFGHJKLMNP]{5}$/);
    expect(started.body.verification_uri).toBe("http://ap.test/pair");
    expect(started.body.verification_uri_complete).toBe(`http://ap.test/pair?code=${started.body.user_code}`);
    expectSensitiveHeaders(started.res);

    const row = await env.DB.prepare("SELECT * FROM desktop_pairings WHERE id = ?")
      .bind(started.body.pairing_id)
      .first<Record<string, unknown>>();
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(started.body.device_code);
    expect(stored).not.toContain(started.body.user_code.replace("-", ""));
    expect(stored).not.toContain(started.verifier);
    expect(stored).not.toContain(started.deviceSecret);
    expect(Number(row?.expires_at) - Number(row?.created_at)).toBe(300_000);
  });

  it("rejects malformed or non-S256 start requests", async () => {
    const res = await desktop("/api/desktop/pairings", {
      code_challenge_method: "plain",
      code_challenge: "verifier",
      device_secret_challenge: "secret",
      device: { name: "Mac" },
    });
    expect(res.status).toBe(400);
  });

  it("publishes the complete desktop Device Flow contract in OpenAPI", async () => {
    const res = await SELF.fetch("http://ap.test/openapi.json");
    expect(res.status).toBe(200);
    const document = (await res.json()) as {
      paths: Record<string, { post?: { description?: string; responses?: Record<string, unknown> } }>;
    };
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/api/desktop/pairings",
        "/api/desktop/pairings/inspect",
        "/api/desktop/pairings/decision",
        "/api/desktop/pairings/token",
        "/api/desktop/sessions/refresh",
        "/api/desktop/sessions",
        "/api/desktop/sessions/{id}",
        "/api/desktop/sessions/revoke",
      ]),
    );
    const refresh = document.paths["/api/desktop/sessions/refresh"]?.post;
    expect(refresh?.description).toContain("5-minute recovery window");
    expect(refresh?.description).toContain("device secret");
    expect(refresh?.responses).toHaveProperty("409");
  });

  it("allows only a human bearer to inspect and decide by user code", async () => {
    const started = await startPairing("203.0.113.11");
    const human = await seedToken("human", uniq("desktop-human"), { owner: uniq("account") });
    const agent = await seedToken("agent", uniq("desktop-agent"), { owner: uniq("account") });

    const unauthenticated = await desktop("/api/desktop/pairings/inspect", { user_code: started.body.user_code });
    expect(unauthenticated.status).toBe(401);
    expectSensitiveHeaders(unauthenticated);
    expect((await desktop("/api/desktop/pairings/inspect", { user_code: started.body.user_code }, agent.token)).status).toBe(403);

    const inspect = await desktop("/api/desktop/pairings/inspect", { user_code: started.body.user_code }, human.token);
    expect(inspect.status).toBe(200);
    expect(await inspect.json()).toMatchObject({
      pairing_id: started.body.pairing_id,
      status: "pending",
      device: { name: "Leo Mac", platform: "darwin", app_version: "0.3.0" },
    });

    const decided = await approve(started.body.user_code, human.token);
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ pairing_id: started.body.pairing_id, status: "approved" });
  });

  it("requires an independently authenticated browser session to approve another desktop", async () => {
    const paired = await exchangeApproved("203.0.113.48");
    const desktopTokens = JSON.parse(paired.body) as { access_token: string };
    const next = await startPairing("203.0.113.49");

    const inspect = await desktop(
      "/api/desktop/pairings/inspect",
      { user_code: next.body.user_code },
      desktopTokens.access_token,
    );
    const decide = await desktop(
      "/api/desktop/pairings/decision",
      { user_code: next.body.user_code, decision: "approve" },
      desktopTokens.access_token,
    );

    expect(inspect.status).toBe(403);
    expect(decide.status).toBe(403);
  });

  it("returns pending, slows rapid polls, and never accepts the short user code for redemption", async () => {
    const started = await startPairing("203.0.113.12");
    const pending = await desktop("/api/desktop/pairings/token", {
      device_code: started.body.device_code,
      code_verifier: started.verifier,
    });
    expect(pending.status).toBe(202);

    const rapid = await desktop("/api/desktop/pairings/token", {
      device_code: started.body.device_code,
      code_verifier: started.verifier,
    });
    expect(rapid.status).toBe(429);
    expect(rapid.headers.get("retry-after")).toBe("10");
    expect(await rapid.json()).toMatchObject({ interval: 10 });

    const shortCode = await desktop("/api/desktop/pairings/token", {
      device_code: started.body.user_code,
      code_verifier: started.verifier,
    });
    expect(shortCode.status).toBe(400);
  });

  it("returns denied and expired terminal states", async () => {
    const human = await seedToken("human", uniq("desktop-human"), { owner: uniq("account") });
    const denied = await startPairing("203.0.113.13");
    const deny = await desktop(
      "/api/desktop/pairings/decision",
      { user_code: denied.body.user_code, decision: "deny" },
      human.token,
    );
    expect(deny.status).toBe(200);
    const deniedToken = await desktop("/api/desktop/pairings/token", {
      device_code: denied.body.device_code,
      code_verifier: denied.verifier,
    });
    expect(deniedToken.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM desktop_token_recoveries WHERE pairing_id = ?")
      .bind(denied.body.pairing_id)
      .first<{ n: number }>()).toEqual({ n: 0 });

    const expired = await startPairing("203.0.113.14");
    await env.DB.prepare("UPDATE desktop_pairings SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expired.body.pairing_id)
      .run();
    const expiredToken = await desktop("/api/desktop/pairings/token", {
      device_code: expired.body.device_code,
      code_verifier: expired.verifier,
    });
    expect(expiredToken.status).toBe(410);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM desktop_token_recoveries WHERE pairing_id = ?")
      .bind(expired.body.pairing_id)
      .first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("returns the exact same response under concurrent exchange while creating one session", async () => {
    const started = await approvedPairing("203.0.113.15");

    const exchange = () =>
      desktop("/api/desktop/pairings/token", {
        device_code: started.body.device_code,
        code_verifier: started.verifier,
      });
    const responses = await Promise.all([exchange(), exchange()]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    const payloads = await Promise.all(responses.map((response) => response.text()));
    expect(payloads[1]).toBe(payloads[0]);

    const tokens = JSON.parse(payloads[0]) as { access_token: string; refresh_token: string; expires_in: number; session_id: string };
    expect(tokens.access_token).toMatch(/^apd_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^apr_[A-Za-z0-9_-]{43}$/);
    expect(tokens.expires_in).toBeGreaterThan(0);
    expect((await SELF.fetch("http://ap.test/api/me", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(200);
    expectSensitiveHeaders(responses[0]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM desktop_sessions WHERE pairing_id = ?")
      .bind(started.body.pairing_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("recovers an identical encrypted token response for 60 seconds after exchange, even after pairing expiry", async () => {
    const started = await approvedPairing("203.0.113.41");
    await env.DB.prepare("UPDATE desktop_pairings SET expires_at = ? WHERE id = ?")
      .bind(Date.now() + 1_000, started.body.pairing_id)
      .run();
    const response = await desktop("/api/desktop/pairings/token", {
      device_code: started.body.device_code,
      code_verifier: started.verifier,
    });
    const body = await response.text();
    const issued = JSON.parse(body) as { access_token: string; refresh_token: string; session_id: string };
    await env.DB.prepare("UPDATE desktop_pairings SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, started.body.pairing_id)
      .run();
    const recovered = await desktop("/api/desktop/pairings/token", {
      device_code: started.body.device_code,
      code_verifier: started.verifier,
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe(body);
    expectSensitiveHeaders(response);
    expectSensitiveHeaders(recovered);

    const recovery = await env.DB.prepare("SELECT * FROM desktop_token_recoveries WHERE pairing_id = ?")
      .bind(started.body.pairing_id)
      .first<Record<string, unknown>>();
    const pairing = await env.DB.prepare("SELECT expires_at FROM desktop_pairings WHERE id = ?")
      .bind(started.body.pairing_id)
      .first<{ expires_at: number }>();
    expect(recovery).not.toBeNull();
    expect(recovery?.session_id).toBe(issued.session_id);
    expect(Number(recovery?.expires_at) - Number(recovery?.created_at)).toBeGreaterThanOrEqual(59_000);
    expect(Number(recovery?.expires_at) - Number(recovery?.created_at)).toBeLessThanOrEqual(60_000);
    expect(Number(recovery?.expires_at)).toBeGreaterThan(Number(pairing?.expires_at));
    const stored = JSON.stringify(recovery);
    expect(stored).not.toContain(issued.access_token);
    expect(stored).not.toContain(issued.refresh_token);
    expect(stored).not.toContain(body);
  });

  it("does not recover for a wrong verifier and does not consume another session", async () => {
    const { started, body } = await exchangeApproved("203.0.113.42");
    const wrong = await desktop("/api/desktop/pairings/token", {
      device_code: started.body.device_code,
      code_verifier: `wrong-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    });
    expect(wrong.status).toBe(400);
    const wrongBody = await wrong.text();
    expect(JSON.parse(wrongBody)).toEqual({ error: { code: "invalid_grant", message: "invalid device grant" } });
    expect(await desktop("/api/desktop/pairings/token", {
      device_code: started.body.device_code,
      code_verifier: started.verifier,
    }).then((response) => response.text())).toBe(body);
    await env.DB.prepare("UPDATE desktop_token_recoveries SET expires_at = ? WHERE pairing_id = ?")
      .bind(Date.now() - 1, started.body.pairing_id)
      .run();
    const stale = await desktop("/api/desktop/pairings/token", {
      device_code: started.body.device_code,
      code_verifier: started.verifier,
    });
    expect(stale.status).toBe(wrong.status);
    expect(await stale.text()).toBe(wrongBody);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM desktop_sessions WHERE pairing_id = ?")
      .bind(started.body.pairing_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects recovery after its bounded window without creating another session", async () => {
    const { started } = await exchangeApproved("203.0.113.43");
    await env.DB.prepare("UPDATE desktop_token_recoveries SET expires_at = ? WHERE pairing_id = ?")
      .bind(Date.now() - 1, started.body.pairing_id)
      .run();
    const retry = await desktop("/api/desktop/pairings/token", {
      device_code: started.body.device_code,
      code_verifier: started.verifier,
    });
    expect(retry.status).toBe(400);
    expect(await retry.json()).toEqual({ error: { code: "invalid_grant", message: "invalid device grant" } });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM desktop_sessions WHERE pairing_id = ?")
      .bind(started.body.pairing_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("opportunistically deletes expired encrypted recoveries through the expiry index", async () => {
    const { started } = await exchangeApproved("203.0.113.46");
    await env.DB.prepare("UPDATE desktop_token_recoveries SET expires_at = ? WHERE pairing_id = ?")
      .bind(Date.now() - 1, started.body.pairing_id)
      .run();

    await startPairing("203.0.113.47");

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM desktop_token_recoveries WHERE pairing_id = ?")
      .bind(started.body.pairing_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
    const index = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_desktop_token_recoveries_expires_at'",
    ).first<{ name: string }>();
    expect(index?.name).toBe("idx_desktop_token_recoveries_expires_at");
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT pairing_id FROM desktop_token_recoveries
        WHERE expires_at <= ?
        ORDER BY expires_at
        LIMIT 100`,
    )
      .bind(Date.now())
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("idx_desktop_token_recoveries_expires_at"))).toBe(true);
  });

  it.each(["ciphertext", "device_code_hash"] as const)(
    "rejects authenticated recovery when %s is mutated",
    async (column) => {
      const ip = column === "ciphertext" ? "203.0.113.44" : "203.0.113.45";
      const { started } = await exchangeApproved(ip);
      if (column === "ciphertext") {
        await env.DB.prepare(
          `UPDATE desktop_token_recoveries
              SET ciphertext = CASE substr(ciphertext, 1, 1)
                WHEN 'A' THEN 'B' || substr(ciphertext, 2)
                ELSE 'A' || substr(ciphertext, 2)
              END
            WHERE pairing_id = ?`,
        )
          .bind(started.body.pairing_id)
          .run();
      } else {
        await env.DB.prepare("UPDATE desktop_token_recoveries SET device_code_hash = ? WHERE pairing_id = ?")
          .bind("0".repeat(64), started.body.pairing_id)
          .run();
      }
      const retry = await desktop("/api/desktop/pairings/token", {
        device_code: started.body.device_code,
        code_verifier: started.verifier,
      });
      expect(retry.status).toBe(400);
      expect(await retry.json()).toEqual({ error: { code: "invalid_grant", message: "invalid device grant" } });
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM desktop_sessions WHERE pairing_id = ?")
        .bind(started.body.pairing_id)
        .first<{ n: number }>();
      expect(count?.n).toBe(1);
    },
  );

  it("denies a pairing after five PKCE proof failures", async () => {
    const started = await startPairing("203.0.113.16");
    const human = await seedToken("human", uniq("desktop-human"), { owner: uniq("account") });
    await approve(started.body.user_code, human.token);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await env.DB.prepare("UPDATE desktop_pairings SET next_poll_at = 0 WHERE id = ?").bind(started.body.pairing_id).run();
      const res = await desktop("/api/desktop/pairings/token", {
        device_code: started.body.device_code,
        code_verifier: `wrong-${attempt}-${crypto.randomUUID()}`,
      });
      expect(res.status).toBe(attempt === 4 ? 403 : 401);
    }

    const correct = await desktop("/api/desktop/pairings/token", {
      device_code: started.body.device_code,
      code_verifier: started.verifier,
    });
    expect(correct.status).toBe(403);
  });

  it("limits pairing starts to 20 per IP in ten minutes", async () => {
    const ip = "198.51.100.199";
    const verifier = `verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const deviceSecret = `device-secret-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const body = {
      code_challenge_method: "S256",
      code_challenge: await challenge(verifier),
      device_secret_challenge: await challenge(deviceSecret),
      device: { name: "Rate Mac", platform: "darwin", app_version: "0.3.0" },
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await desktop("/api/desktop/pairings", body, undefined, ip)).status).toBe(201);
    }
    const limited = await desktop("/api/desktop/pairings", body, undefined, ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("blocks both the IP and account for one hour after five wrong user codes", async () => {
    const started = await startPairing("203.0.113.31");
    const human = await seedToken("human", uniq("desktop-human"), { owner: uniq("rate-account") });
    const ip = "203.0.113.32";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrongCode = `BCDFG-HJKLM`.slice(0, 10) + BASE20_FOR_TEST(attempt);
      const res = await desktop("/api/desktop/pairings/inspect", { user_code: wrongCode }, human.token, ip);
      expect(res.status).toBe(attempt === 4 ? 429 : 404);
    }

    const ipBlocked = await desktop(
      "/api/desktop/pairings/inspect",
      { user_code: started.body.user_code },
      (await seedToken("human", uniq("desktop-human"), { owner: uniq("other-account") })).token,
      ip,
    );
    expect(ipBlocked.status).toBe(429);
    const accountBlocked = await desktop(
      "/api/desktop/pairings/inspect",
      { user_code: started.body.user_code },
      human.token,
      "203.0.113.33",
    );
    expect(accountBlocked.status).toBe(429);
    expect(Number(accountBlocked.headers.get("retry-after"))).toBeGreaterThan(3500);
  });
});

function BASE20_FOR_TEST(attempt: number): string {
  return "23456789BCDFGHJKLMNP"[attempt];
}
