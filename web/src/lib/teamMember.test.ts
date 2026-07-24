import { describe, expect, test } from "bun:test";
import type { ChannelRoleAssignment, PresenceEntry, Sender } from "@agentparty/shared";
import { resolveTeamMemberView } from "./teamMember";

function assignment(over: Partial<ChannelRoleAssignment> = {}): ChannelRoleAssignment {
  return {
    name: "builder",
    role: "worker",
    responsibility: "Ship the web app",
    reports_to: "lead",
    assigned_by: "owner",
    assigned_at: 100,
    kind: "agent",
    display: "Builder",
    ...over,
  };
}

function presence(over: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    name: "builder",
    state: "working",
    note: "Working on the settings split",
    ts: 200,
    kind: "agent",
    ...over,
  };
}

describe("resolveTeamMemberView", () => {
  test("keeps channel_roles authoritative when presence makes a conflicting self-report", () => {
    const member = resolveTeamMemberView({
      name: "builder",
      assignment: assignment(),
      presence: presence({
        role: "host",
        role_source: "self",
        note: "I lead everything",
        lineage: {
          parent_agent: "runtime-parent",
          root_agent: "root",
          team_id: "team",
          depth: 1,
          expires_at: null,
        },
      }),
    });

    expect(member.role).toEqual({
      source: "channel_roles",
      confirmation: "confirmed",
      role: "worker",
      responsibility: "Ship the web app",
      reportsTo: "lead",
      assignedBy: "owner",
      assignedAt: 100,
    });
    expect(member.selfReportedRoleClaim).toEqual({
      source: "presence",
      confirmation: "unconfirmed",
      role: "host",
      responsibility: "I lead everything",
      reportsTo: null,
      reportedAt: 200,
    });
    expect(member.runtime.lineageParent).toBe("runtime-parent");
  });

  test("does not fill an intentionally empty formal responsibility or reportsTo from presence", () => {
    const member = resolveTeamMemberView({
      name: "builder",
      assignment: assignment({ responsibility: null, reports_to: null }),
      presence: presence({
        role: "host",
        role_source: "self",
        note: "Runtime-only claim",
        lineage: {
          parent_agent: "spawn-parent",
          root_agent: "root",
          team_id: "team",
          depth: 1,
          expires_at: null,
        },
      }),
    });

    expect(member.role).toMatchObject({
      source: "channel_roles",
      responsibility: null,
      reportsTo: null,
    });
    expect(member.selfReportedRoleClaim?.responsibility).toBe("Runtime-only claim");
    expect(member.runtime.lineageParent).toBe("spawn-parent");
  });

  test("represents a presence-only role as an unconfirmed claim without promoting lineage to reportsTo", () => {
    const member = resolveTeamMemberView({
      name: "builder",
      presence: presence({
        role: "reviewer",
        role_source: "self",
        lineage: {
          parent_agent: "spawn-parent",
          root_agent: "root",
          team_id: "team",
          depth: 1,
          expires_at: null,
        },
      }),
    });

    expect(member.role).toEqual({
      source: "presence",
      confirmation: "unconfirmed",
      role: "reviewer",
      responsibility: "Working on the settings split",
      reportsTo: null,
      reportedAt: 200,
    });
    expect(member.runtime.lineageParent).toBe("spawn-parent");
  });

  test("does not treat assigned-looking presence as a formal assignment when channel_roles has no row", () => {
    const member = resolveTeamMemberView({
      name: "builder",
      presence: presence({ role: "host", role_source: "assigned" }),
    });

    expect(member.role).toEqual({
      source: "none",
      confirmation: "none",
      role: null,
      responsibility: null,
      reportsTo: null,
    });
    expect(member.selfReportedRoleClaim).toBeNull();
  });

  test("keeps blank self-report notes out of responsibility", () => {
    const member = resolveTeamMemberView({
      name: "builder",
      presence: presence({ role: "worker", role_source: "self", note: "   " }),
    });

    expect(member.role.responsibility).toBeNull();
  });

  test("resolves identity and online state once for roster, board and detail consumers", () => {
    const participant: Sender = {
      name: "builder",
      kind: "agent",
      owner: "runtime@example.com",
      handle: "runtime-handle",
    };
    const member = resolveTeamMemberView({
      name: "builder",
      assignment: assignment({ account: "assigned@example.com" }),
      identity: { display: "Build Bot", kind: "agent", account: "team@example.com" },
      presence: presence({ live: false }),
      participant,
    });

    expect(member).toMatchObject({
      name: "builder",
      display: "Build Bot",
      kind: "agent",
      account: "team@example.com",
      owner: "team@example.com",
      runtime: {
        online: true,
        state: "working",
        note: "Working on the settings split",
      },
    });
    expect(member.runtime.presence).toBeTruthy();
  });

  test("uses human profile fallbacks and suppresses a duplicate owner label", () => {
    const member = resolveTeamMemberView({
      name: "session-id",
      presence: {
        ...presence({ name: "session-id" }),
        kind: "human",
        account: "leo@example.com",
        display_name: "Leo",
      },
    });

    expect(member.display).toBe("Leo");
    expect(member.kind).toBe("human");
    expect(member.account).toBe("leo@example.com");
    expect(member.owner).toBe("leo@example.com");

    const emailOnly = resolveTeamMemberView({
      name: "other-session",
      identity: { kind: "human", account: "owner@example.com" },
    });
    expect(emailOnly.display).toBe("owner@example.com");
    expect(emailOnly.owner).toBeNull();
  });

  test("ignores accidentally mismatched rows instead of borrowing another member's authority", () => {
    const member = resolveTeamMemberView({
      name: "builder",
      assignment: assignment({ name: "other", role: "host" }),
      presence: presence({ name: "other", role: "reviewer", role_source: "self" }),
      participant: { name: "other", kind: "human" },
    });

    expect(member.kind).toBe("agent");
    expect(member.role.source).toBe("none");
    expect(member.runtime.presence).toBeNull();
    expect(member.runtime.online).toBe(false);
  });
});
