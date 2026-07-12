import { describe, expect, test } from "bun:test";
import { buildOrgTree, type OrgMemberInput, type OrgTreeNode } from "./orgTree";

function member(name: string, over: Partial<OrgMemberInput> = {}): OrgMemberInput {
  return {
    name,
    display: over.display ?? name,
    role: over.role ?? null,
    reportsTo: over.reportsTo ?? null,
    kind: over.kind ?? "agent",
    accountLabel: over.accountLabel,
    source: over.source,
  };
}

function names(nodes: OrgTreeNode[]): string[] {
  return nodes.map((node) => node.name);
}

function findNode(nodes: OrgTreeNode[], name: string): OrgTreeNode | null {
  for (const node of nodes) {
    if (node.name === name) return node;
    const inChild = findNode(node.children, name);
    if (inChild !== null) return inChild;
  }
  return null;
}

// flatten every node reachable in the whole tree (roots + unassigned), for count assertions
function allNodes(nodes: OrgTreeNode[]): OrgTreeNode[] {
  const out: OrgTreeNode[] = [];
  const walk = (list: OrgTreeNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

describe("buildOrgTree", () => {
  test("nests reports under their parent, lead is the root", () => {
    const tree = buildOrgTree([
      member("lead", { role: "host", display: "Lead" }),
      member("mid", { role: "worker", reportsTo: "lead", display: "Mid" }),
      member("ic", { role: "worker", reportsTo: "mid", display: "IC" }),
    ]);

    // root of the org tree is the channel lead (host)
    expect(names(tree.roots)).toEqual(["lead"]);
    const lead = tree.roots[0]!;
    expect(lead.isLead).toBe(true);
    // mid reports to lead → nested under it
    expect(names(lead.children)).toEqual(["mid"]);
    // ic reports to mid → nested recursively (two levels deep)
    const mid = lead.children[0]!;
    expect(names(mid.children)).toEqual(["ic"]);
    // nothing dangling
    expect(tree.unassigned).toHaveLength(0);
    expect(tree.memberCount).toBe(3);
  });

  test("multiple leads become sibling roots", () => {
    const tree = buildOrgTree([
      member("lead-a", { role: "host" }),
      member("lead-b", { role: "host" }),
      member("w", { role: "worker", reportsTo: "lead-a" }),
    ]);
    expect(names(tree.roots).sort()).toEqual(["lead-a", "lead-b"]);
    expect(names(findNode(tree.roots, "lead-a")!.children)).toEqual(["w"]);
  });

  test("agent with no report target lands in unassigned, not the tree", () => {
    const tree = buildOrgTree([
      member("lead", { role: "host" }),
      member("floater", { role: "worker", reportsTo: null }),
    ]);
    expect(names(tree.roots)).toEqual(["lead"]);
    expect(names(tree.unassigned)).toEqual(["floater"]);
    expect(tree.unassigned[0]!.reportsToExternal).toBe(false);
  });

  test("report target outside the roster is flagged external and grouped as unassigned", () => {
    const tree = buildOrgTree([
      member("lead", { role: "host" }),
      member("outsider", { role: "worker", reportsTo: "ghost-manager" }),
    ]);
    const outsider = tree.unassigned.find((node) => node.name === "outsider")!;
    expect(outsider).toBeDefined();
    expect(outsider.reportsToExternal).toBe(true);
    expect(outsider.reportsTo).toBe("ghost-manager");
  });

  test("a reporting cycle does not infinite-loop and every node still renders once", () => {
    // b → c → b : a degenerate cycle with no host and no valid root
    const tree = buildOrgTree([
      member("b", { role: "worker", reportsTo: "c" }),
      member("c", { role: "worker", reportsTo: "b" }),
    ]);
    const rendered = allNodes([...tree.roots, ...tree.unassigned]);
    // both nodes appear exactly once — the back-edge is broken, not followed forever
    expect(rendered.map((node) => node.name).sort()).toEqual(["b", "c"]);
    expect(rendered).toHaveLength(2);
  });

  test("self-report (parent === self) is treated as no manager, not a self-loop", () => {
    const tree = buildOrgTree([member("solo", { role: "worker", reportsTo: "solo" })]);
    const rendered = allNodes([...tree.roots, ...tree.unassigned]);
    expect(rendered.map((node) => node.name)).toEqual(["solo"]);
    expect(rendered[0]!.reportsToExternal).toBe(false);
  });

  test("a non-lead manager with reports anchors as a root even without its own manager", () => {
    const tree = buildOrgTree([
      member("mgr", { role: "worker", reportsTo: null }),
      member("report", { role: "worker", reportsTo: "mgr" }),
    ]);
    expect(names(tree.roots)).toEqual(["mgr"]);
    expect(names(findNode(tree.roots, "mgr")!.children)).toEqual(["report"]);
    expect(tree.unassigned).toHaveLength(0);
  });

  test("assigns tree depth from each structural root", () => {
    const tree = buildOrgTree([
      member("lead", { role: "host" }),
      member("mid", { role: "worker", reportsTo: "lead" }),
      member("ic", { role: "worker", reportsTo: "mid" }),
    ]);
    const lead = tree.roots[0]!;
    expect(lead.depth).toBe(0);
    expect(findNode(tree.roots, "mid")!.depth).toBe(1);
    expect(findNode(tree.roots, "ic")!.depth).toBe(2);
  });

  test("#168 direct report to its immediate manager is NOT flagged skip-level", () => {
    // proper chain: ic → mid → lead. ic reports to its direct manager, mid.
    const tree = buildOrgTree([
      member("lead", { role: "host" }),
      member("mid", { role: "worker", reportsTo: "lead" }),
      member("ic", { role: "worker", reportsTo: "mid" }),
    ]);
    for (const node of allNodes(tree.roots)) {
      expect(node.skipLevel, `${node.name} should not be skip-level`).toBe(false);
    }
  });

  test("#168 leaf reporting to the lead over an existing manager layer is skip-level", () => {
    // lead has a real management layer (mid → ic_real). ic_skip attaches straight to lead,
    // bypassing that layer → skip-level. The manager (mid) and the proper report (ic_real) are not.
    const tree = buildOrgTree([
      member("lead", { role: "host" }),
      member("mid", { role: "worker", reportsTo: "lead" }),
      member("ic_real", { role: "worker", reportsTo: "mid" }),
      member("ic_skip", { role: "worker", reportsTo: "lead" }),
    ]);
    expect(findNode(tree.roots, "ic_skip")!.skipLevel).toBe(true);
    expect(findNode(tree.roots, "ic_real")!.skipLevel).toBe(false);
    expect(findNode(tree.roots, "mid")!.skipLevel).toBe(false);
    expect(findNode(tree.roots, "lead")!.skipLevel).toBe(false);
  });

  test("#168 a flat team with no manager layer is not skip-level", () => {
    // lead has two leaf reports and no sub-manager → reporting straight to lead is fine.
    const tree = buildOrgTree([
      member("lead", { role: "host" }),
      member("a", { role: "worker", reportsTo: "lead" }),
      member("b", { role: "worker", reportsTo: "lead" }),
    ]);
    expect(findNode(tree.roots, "a")!.skipLevel).toBe(false);
    expect(findNode(tree.roots, "b")!.skipLevel).toBe(false);
  });

  test("#168 a sub-manager reporting high alongside another manager is not flagged (only leaf ICs)", () => {
    // both dir-a and dir-b report to lead; each has its own report. Neither is a leaf → not flagged.
    const tree = buildOrgTree([
      member("lead", { role: "host" }),
      member("dir-a", { role: "worker", reportsTo: "lead" }),
      member("ic-a", { role: "worker", reportsTo: "dir-a" }),
      member("dir-b", { role: "worker", reportsTo: "lead" }),
      member("ic-b", { role: "worker", reportsTo: "dir-b" }),
    ]);
    expect(findNode(tree.roots, "dir-a")!.skipLevel).toBe(false);
    expect(findNode(tree.roots, "dir-b")!.skipLevel).toBe(false);
    expect(findNode(tree.roots, "ic-a")!.skipLevel).toBe(false);
    expect(findNode(tree.roots, "ic-b")!.skipLevel).toBe(false);
  });

  test("empty input yields an empty tree", () => {
    const tree = buildOrgTree([]);
    expect(tree.roots).toHaveLength(0);
    expect(tree.unassigned).toHaveLength(0);
    expect(tree.memberCount).toBe(0);
  });
});
