import { describe, expect, test } from "bun:test";
import { buildRollbackPlan } from "../worker/scripts/rollback-ci.mjs";

describe("buildRollbackPlan", () => {
  test("without a deployment id: list then rollback-to-previous", () => {
    const plan = buildRollbackPlan("prod", {}, ["bunx", "wrangler"]);
    expect(plan.map((s) => s.label)).toEqual(["list", "rollback"]);

    const [list, rollback] = plan;
    expect(list.cmd).toBe("bunx");
    expect(list.args).toEqual(["wrangler", "deployments", "list", "--config", "wrangler.jsonc"]);

    expect(rollback.args).toEqual([
      "wrangler",
      "rollback",
      "--config",
      "wrangler.jsonc",
      "--message",
      "CI rollback (#420)",
    ]);
  });

  test("with a deployment id: rollback targets that id", () => {
    const [, rollback] = buildRollbackPlan(
      "xdream",
      { deploymentId: "dep-123", message: "revert bad deploy" },
      ["wrangler"],
    );
    expect(rollback.args).toEqual([
      "rollback",
      "dep-123",
      "--config",
      "wrangler.xdream.jsonc",
      "--message",
      "revert bad deploy",
    ]);
  });

  test("rejects unknown targets", () => {
    expect(() => buildRollbackPlan("staging", {}, ["wrangler"])).toThrow(/unknown rollback target/);
  });

  test("rejects an empty launcher", () => {
    expect(() => buildRollbackPlan("prod", {}, [])).toThrow(/non-empty/);
  });
});
