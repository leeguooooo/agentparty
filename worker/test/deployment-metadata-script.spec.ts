import { describe, expect, it } from "vitest";
import {
  deploymentDefineArgs,
  verifyDualDeployment,
  verifyDeploymentMetadata,
} from "../scripts/deployment-metadata.mjs";

const metadata = {
  version: "0.2.89",
  commit: "0123456789abcdef0123456789abcdef01234567",
  deployed_at: "2026-07-11T00:00:00.000Z",
};

describe("deployment metadata script", () => {
  it("encodes build identity as Wrangler compile-time defines", () => {
    expect(deploymentDefineArgs(metadata)).toEqual([
      "--define", '__AGENTPARTY_BUILD_VERSION__:"0.2.89"',
      "--define", '__AGENTPARTY_BUILD_COMMIT__:"0123456789abcdef0123456789abcdef01234567"',
      "--define", '__AGENTPARTY_DEPLOYED_AT__:"2026-07-11T00:00:00.000Z"',
    ]);
  });

  it("accepts only the exact deployed identity", async () => {
    const fetcher = async () => new Response(JSON.stringify({ ok: true, ...metadata }), {
      headers: { "content-type": "application/json" },
    });

    await expect(verifyDeploymentMetadata("https://example.test", metadata, fetcher)).resolves.toEqual(metadata);
    await expect(verifyDeploymentMetadata("https://example.test", { ...metadata, commit: "f".repeat(40) }, fetcher))
      .rejects.toThrow("commit mismatch");
  });

  it("verifies prod and xdream against one expected build", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.startsWith("https://prod.test")
        ? { ok: true, ...metadata }
        : { ok: true, ...metadata, commit: "f".repeat(40) };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };

    await expect(verifyDualDeployment({ prod: "https://prod.test" }, metadata, fetcher))
      .resolves.toEqual({ prod: metadata });
    await expect(verifyDualDeployment({ prod: "https://prod.test", xdream: "https://xdream.test" }, metadata, fetcher))
      .rejects.toThrow("xdream: commit mismatch");
  });

});
