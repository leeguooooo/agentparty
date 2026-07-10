import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error The deployment smoke is intentionally plain Node ESM.
import { desktopPairingSmokePayload, smokeDesktopPairing } from "../worker/scripts/smoke-desktop-pairing.mjs";

const dualDeploy = readFileSync(resolve(import.meta.dir, "../worker/scripts/deploy-dual.mjs"), "utf8");

describe("desktop pairing deploy smoke", () => {
  test("sends an S256 Device Flow probe and validates the target origin", async () => {
    const requests: Request[] = [];
    const result = await smokeDesktopPairing("https://party.example.com", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      return new Response(JSON.stringify({
        pairing_id: "00000000-0000-4000-8000-000000000000",
        device_code: "A".repeat(43),
        user_code: "ABCDE-FGHIJ",
        verification_uri: "https://party.example.com/pair",
        verification_uri_complete: "https://party.example.com/pair?code=ABCDE-FGHIJ",
        expires_in: 300,
        interval: 3,
      }), {
        status: 201,
        headers: { "cache-control": "no-store, no-cache", pragma: "no-cache" },
      });
    });

    expect(result).toEqual({ pairingId: "00000000-0000-4000-8000-000000000000", origin: "https://party.example.com" });
    expect(requests[0]?.url).toBe("https://party.example.com/api/desktop/pairings");
    const payload = JSON.parse(await requests[0]!.text());
    expect(payload.code_challenge_method).toBe("S256");
    expect(payload.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.device_secret_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("fails release verification when desktop pairing is unavailable", async () => {
    await expect(smokeDesktopPairing("https://party.example.com", async () => (
      new Response('{"error":{"code":"unavailable"}}', { status: 503 })
    ))).rejects.toThrow("desktop pairing smoke failed (503)");
  });

  test("generates fresh independent device challenges", () => {
    const first = desktopPairingSmokePayload();
    const second = desktopPairingSmokePayload();
    expect(first.device_secret_challenge).not.toBe(first.code_challenge);
    expect(first.device_secret_challenge).not.toBe(second.device_secret_challenge);
  });

  test("runs the Device Flow smoke unconditionally after every target deploy", () => {
    const deploy = dualDeploy.indexOf('"deploy", "--config", target.config');
    const pairingSmoke = dualDeploy.indexOf('run("node", ["scripts/smoke-desktop-pairing.mjs"]');
    const optionalAuthenticatedSmoke = dualDeploy.indexOf("if (target.smokeToken && target.smokeWriteToken)");
    expect(deploy).toBeGreaterThan(-1);
    expect(pairingSmoke).toBeGreaterThan(deploy);
    expect(optionalAuthenticatedSmoke).toBeGreaterThan(pairingSmoke);
  });
});
