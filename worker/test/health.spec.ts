import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("deployment health metadata", () => {
  it("exposes an uncached build identity", async () => {
    const response = await SELF.fetch("http://ap.test/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      version: "dev",
      commit: "unknown",
      deployed_at: null,
    });
  });
});
