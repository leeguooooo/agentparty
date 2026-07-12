import { describe, expect, test } from "bun:test";
import {
  DEPLOY_TARGETS,
  buildDeployPlan,
  parseWranglerLauncher,
} from "../worker/scripts/deploy-ci.mjs";

const metadata = {
  version: "1.2.3",
  commit: "a".repeat(40),
  deployed_at: "2026-07-13T00:00:00.000Z",
};

describe("parseWranglerLauncher", () => {
  test("defaults to native wrangler", () => {
    expect(parseWranglerLauncher({})).toEqual(["wrangler"]);
  });

  test("splits a multi-word launcher (bunx wrangler)", () => {
    expect(parseWranglerLauncher({ AGENTPARTY_WRANGLER_BIN: "bunx wrangler" })).toEqual(["bunx", "wrangler"]);
  });

  test("collapses extra whitespace and empties", () => {
    expect(parseWranglerLauncher({ AGENTPARTY_WRANGLER_BIN: "  bunx   wrangler  " })).toEqual(["bunx", "wrangler"]);
  });
});

describe("buildDeployPlan", () => {
  test("prod: migrate -> verify-schema -> deploy, in that order", () => {
    const plan = buildDeployPlan("prod", metadata, ["bunx", "wrangler"]);
    expect(plan.map((s) => s.label)).toEqual(["migrate", "verify-schema", "deploy"]);

    const [migrate, verify, deploy] = plan;

    expect(migrate.cmd).toBe("bunx");
    expect(migrate.args).toEqual([
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "agentparty",
      "--remote",
      "--config",
      "wrangler.jsonc",
    ]);

    // schema 校验必须在 deploy 之前，且指向同一个 target 的 db/config
    expect(verify.cmd).toBe("node");
    expect(verify.args).toEqual(["scripts/verify-remote-schema.mjs"]);
    expect(verify.env).toEqual({
      AGENTPARTY_D1_DATABASE: "agentparty",
      AGENTPARTY_WRANGLER_CONFIG: "wrangler.jsonc",
    });

    expect(deploy.cmd).toBe("bunx");
    expect(deploy.args.slice(0, 4)).toEqual(["wrangler", "deploy", "--config", "wrangler.jsonc"]);
    // build 元数据 --define 注入，供 /api/health 回读校验
    expect(deploy.args).toContain(`__AGENTPARTY_BUILD_VERSION__:${JSON.stringify(metadata.version)}`);
    expect(deploy.args).toContain(`__AGENTPARTY_BUILD_COMMIT__:${JSON.stringify(metadata.commit)}`);
    expect(deploy.args).toContain(`__AGENTPARTY_DEPLOYED_AT__:${JSON.stringify(metadata.deployed_at)}`);
  });

  test("xdream: uses the xdream config + database", () => {
    const plan = buildDeployPlan("xdream", metadata, ["wrangler"]);
    const [migrate, verify, deploy] = plan;
    expect(migrate.args).toContain("agentparty-xdream");
    expect(migrate.args).toContain("wrangler.xdream.jsonc");
    expect(verify.env?.AGENTPARTY_D1_DATABASE).toBe("agentparty-xdream");
    expect(verify.env?.AGENTPARTY_WRANGLER_CONFIG).toBe("wrangler.xdream.jsonc");
    expect(deploy.args).toContain("wrangler.xdream.jsonc");
  });

  test("single-word launcher has no prefix args", () => {
    const [migrate] = buildDeployPlan("prod", metadata, ["wrangler"]);
    expect(migrate.cmd).toBe("wrangler");
    expect(migrate.args[0]).toBe("d1");
  });

  test("rejects unknown targets", () => {
    expect(() => buildDeployPlan("staging", metadata, ["wrangler"])).toThrow(/unknown deploy target/);
  });

  test("rejects invalid deployment metadata (guards --define injection)", () => {
    expect(() => buildDeployPlan("prod", { ...metadata, commit: "nope" }, ["wrangler"])).toThrow();
  });

  test("rejects an empty launcher", () => {
    expect(() => buildDeployPlan("prod", metadata, [])).toThrow(/non-empty/);
  });

  test("both targets map to distinct public bases", () => {
    expect(DEPLOY_TARGETS.prod.smokeBase).not.toBe(DEPLOY_TARGETS.xdream.smokeBase);
  });
});
