// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import type { ChannelRoleAssignment } from "@agentparty/shared";
import { buildOrgForest } from "./OrgTree";

function role(name: string, over: Partial<ChannelRoleAssignment> = {}): ChannelRoleAssignment {
  return { name, role: "worker", responsibility: null, assigned_by: "x", assigned_at: 0, ...over };
}

describe("buildOrgForest (#370)", () => {
  test("nests children under their reports_to manager (incl. cross-owner)", () => {
    const roles = [
      role("lead", { role: "host", account: "a@x.com" }),
      role("w1", { account: "a@x.com", reports_to: "lead" }),
      role("w2", { account: "b@y.com", reports_to: "lead" }), // 跨 owner 挂在 lead 下
    ];
    const forest = buildOrgForest(roles);
    expect(forest.map((n) => n.role.name)).toEqual(["lead"]);
    expect(forest[0]!.children.map((n) => n.role.name)).toEqual(["w1", "w2"]);
  });

  test("no-reports_to nodes are roots", () => {
    const forest = buildOrgForest([role("a"), role("b")]);
    expect(forest.map((n) => n.role.name).sort()).toEqual(["a", "b"]);
    expect(forest.every((n) => n.children.length === 0)).toBe(true);
  });

  test("reports_to pointing to a non-member falls back to root (orphan)", () => {
    const forest = buildOrgForest([role("a", { reports_to: "ghost" })]);
    expect(forest.map((n) => n.role.name)).toEqual(["a"]);
  });

  test("cyclic reports_to does not infinite-loop and still renders all nodes as roots", () => {
    const roles = [role("a", { reports_to: "b" }), role("b", { reports_to: "a" })];
    const forest = buildOrgForest(roles);
    // 两者互指成环 → 都当 root，节点不丢、不无限递归
    expect(forest.map((n) => n.role.name).sort()).toEqual(["a", "b"]);
  });

  test("self-reference is treated as root", () => {
    const forest = buildOrgForest([role("a", { reports_to: "a" })]);
    expect(forest.map((n) => n.role.name)).toEqual(["a"]);
  });
});
