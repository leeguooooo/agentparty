import { describe, expect, test } from "bun:test";
import type { AgentLineage, MsgFrame, PresenceEntry, Sender } from "@agentparty/shared";
import { groupTeamMessages, summarizeTeams } from "./teams";

const NOW = 2_000_000;

function lineage(input: Partial<AgentLineage> = {}): AgentLineage {
  return {
    parent_agent: input.parent_agent ?? "codex-main",
    root_agent: input.root_agent ?? "codex-main",
    team_id: input.team_id ?? "review-team",
    depth: input.depth ?? 1,
    expires_at: input.expires_at ?? NOW + 60_000,
  };
}

function sender(name: string, over: Partial<Sender> = {}): Sender {
  return { name, kind: "agent", ...over };
}

function message(name: string, seq: number, over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    type: "msg",
    seq,
    sender: sender(name, { lineage: over.sender?.lineage ?? lineage({ depth: 2 }) }),
    kind: "message",
    body: "",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: NOW - 10_000,
    ...over,
  };
}

function presence(name: string, over: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    name,
    state: "working",
    note: null,
    ts: NOW - 5_000,
    last_seen: NOW - 5_000,
    lineage: lineage({ depth: 2 }),
    ...over,
  };
}

describe("team summaries", () => {
  test("rolls child agents up by root and team id", () => {
    const teams = summarizeTeams({
      now: NOW,
      participants: [sender("child-a", { lineage: lineage({ depth: 1 }) })],
      presence: {
        "child-a": presence("child-a", { residency: "supervised" }),
        "child-b": presence("child-b", {
          last_seen: NOW - 300_000,
          ts: NOW - 300_000,
          residency: "bare",
        }),
      },
      messages: [message("child-b", 10, { ts: NOW - 300_000 })],
    });

    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      rootAgent: "codex-main",
      teamId: "review-team",
      activeCount: 1,
      staleCount: 1,
      memberCount: 2,
      residency: "mixed",
    });
    expect(teams[0]!.members.map((member) => member.name)).toEqual(["child-a", "child-b"]);
  });

  test("keeps latest observed activity and ignores agents without lineage", () => {
    const teams = summarizeTeams({
      now: NOW,
      participants: [sender("human-owner", { kind: "human" })],
      presence: {
        "child-a": presence("child-a", {
          last_seen: NOW - 30_000,
          ts: NOW - 30_000,
          residency: "webhook",
        }),
      },
      messages: [
        message("child-a", 20, { ts: NOW - 20_000 }),
        message("standalone", 21, { sender: sender("standalone"), ts: NOW - 1_000 }),
      ],
    });

    expect(teams).toHaveLength(1);
    expect(teams[0]!.members[0]).toMatchObject({
      name: "child-a",
      active: true,
      lastSeen: NOW - 20_000,
      residency: "webhook",
    });
  });

  test("uses the soonest child expiry for the team", () => {
    const teams = summarizeTeams({
      now: NOW,
      participants: [],
      presence: {
        "child-a": presence("child-a", { lineage: lineage({ expires_at: NOW + 90_000 }) }),
        "child-b": presence("child-b", { lineage: lineage({ expires_at: NOW + 30_000 }) }),
      },
      messages: [],
    });

    expect(teams[0]!.expiresAt).toBe(NOW + 30_000);
  });

  test("identifies the host profile runtime as the front agent for its workers", () => {
    const teams = summarizeTeams({
      now: NOW,
      participants: [sender("agentparty-agentparty-abc123", { lineage: lineage({ team_id: "codex-main" }) })],
      presence: {
        "agentparty-agentparty-abc123": presence("agentparty-agentparty-abc123", {
          role: "host",
          residency: "supervised",
          lineage: lineage({ team_id: "codex-main" }),
        }),
        "agentparty-build-1": presence("agentparty-build-1", {
          role: "worker",
          residency: "bare",
          lineage: lineage({ parent_agent: "agentparty-agentparty-abc123", team_id: "codex-main", depth: 1 }),
        }),
      },
      messages: [],
    });

    expect(teams).toHaveLength(1);
    expect(teams[0]!.teamId).toBe("codex-main");
    expect(teams[0]!.frontAgent).toMatchObject({
      name: "agentparty-agentparty-abc123",
      role: "host",
      active: true,
    });
    expect(teams[0]!.members.map((member) => [member.name, member.role])).toEqual([
      ["agentparty-agentparty-abc123", "host"],
      ["agentparty-build-1", "worker"],
    ]);
  });

  test("current roster prevents historical messages from recreating a removed team member", () => {
    const historical = message("removed-child", 10, {
      sender: sender("removed-child", { lineage: lineage({ team_id: "old-team" }) }),
    });
    const memberNames = new Set<string>();

    expect(summarizeTeams({
      now: NOW,
      participants: [],
      presence: {},
      messages: [historical],
      memberNames,
    })).toEqual([]);

    memberNames.add("removed-child");
    expect(summarizeTeams({
      now: NOW,
      participants: [{ name: "removed-child", kind: "agent", lineage: lineage({ team_id: "old-team" }) }],
      presence: {},
      messages: [historical],
      memberNames,
    })[0]!.members.map((member) => member.name)).toEqual(["removed-child"]);
  });
});

describe("team message grouping", () => {
  test("folds consecutive child messages from the same team", () => {
    const items = groupTeamMessages([
      message("child-a", 1, { sender: sender("child-a", { lineage: lineage({ team_id: "alpha" }) }) }),
      message("child-b", 2, { sender: sender("child-b", { lineage: lineage({ team_id: "alpha" }) }) }),
      message("standalone", 3, { sender: sender("standalone") }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "team_thread",
      teamId: "alpha",
      firstSeq: 1,
      lastSeq: 2,
      members: ["child-a", "child-b"],
    });
    expect(items[1]).toMatchObject({ type: "message" });
  });

  test("does not fold across standalone messages or different teams", () => {
    const items = groupTeamMessages([
      message("child-a", 1, { sender: sender("child-a", { lineage: lineage({ team_id: "alpha" }) }) }),
      message("human", 2, { sender: sender("human", { kind: "human" }) }),
      message("child-b", 3, { sender: sender("child-b", { lineage: lineage({ team_id: "alpha" }) }) }),
      message("child-c", 4, { sender: sender("child-c", { lineage: lineage({ team_id: "beta" }) }) }),
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "message", "message", "message"]);
  });
});
