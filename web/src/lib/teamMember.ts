import type {
  ChannelRoleAssignment,
  CollaborationRole,
  PresenceEntry,
  Sender,
  SenderKind,
} from "@agentparty/shared";

/**
 * Identity data already resolved by the caller (for example from
 * buildIdentityDisplay). It deliberately excludes role data: identity and
 * channel responsibility have different authorities.
 */
export interface TeamMemberIdentity {
  display?: string;
  kind?: SenderKind;
  account?: string;
}

export interface ConfirmedTeamRole {
  source: "channel_roles";
  confirmation: "confirmed";
  role: CollaborationRole;
  responsibility: string | null;
  reportsTo: string | null;
  assignedBy: string;
  assignedAt: number;
}

export interface SelfReportedTeamRoleClaim {
  source: "presence";
  confirmation: "unconfirmed";
  role: CollaborationRole;
  responsibility: string | null;
  /**
   * Presence lineage describes runtime spawn ancestry, not an assigned
   * management relationship. Keep it out of reportsTo.
   */
  reportsTo: null;
  reportedAt: number;
}

export interface UnassignedTeamRole {
  source: "none";
  confirmation: "none";
  role: null;
  responsibility: null;
  reportsTo: null;
}

export type TeamMemberRole =
  | ConfirmedTeamRole
  | SelfReportedTeamRoleClaim
  | UnassignedTeamRole;

export interface TeamMemberRuntime {
  presence: PresenceEntry | null;
  online: boolean;
  state: PresenceEntry["state"] | null;
  note: string | null;
  /** Runtime spawn ancestry only; never a substitute for channel_roles.reports_to. */
  lineageParent: string | null;
}

export interface TeamMemberView {
  name: string;
  display: string;
  kind: SenderKind;
  account: string | null;
  /** Secondary account label; null when it would merely repeat display. */
  owner: string | null;
  /**
   * The role shown by a roster. channel_roles wins; a presence-only role is
   * explicitly marked as an unconfirmed self-report.
   */
  role: TeamMemberRole;
  /**
   * Preserved even when a formal assignment exists, so callers may surface a
   * conflicting runtime claim without letting it override the assignment.
   */
  selfReportedRoleClaim: SelfReportedTeamRoleClaim | null;
  runtime: TeamMemberRuntime;
}

export interface ResolveTeamMemberInput {
  name: string;
  assignment?: ChannelRoleAssignment | null;
  identity?: TeamMemberIdentity | null;
  presence?: PresenceEntry | null;
  participant?: Sender | null;
}

function nonBlank(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && value.trim() !== "" ? value : null;
}

function matching<T extends { name: string }>(name: string, value: T | null | undefined): T | null {
  return value?.name === name ? value : null;
}

function selfReportedRoleClaim(presence: PresenceEntry | null): SelfReportedTeamRoleClaim | null {
  if (presence?.role_source !== "self" || presence.role === undefined) return null;
  return {
    source: "presence",
    confirmation: "unconfirmed",
    role: presence.role,
    responsibility: nonBlank(presence.note),
    reportsTo: null,
    reportedAt: presence.ts,
  };
}

/**
 * Resolve one channel member for every Team surface.
 *
 * Authority boundary:
 * - channel_roles owns role, responsibility and reportsTo;
 * - presence owns runtime state and may contribute only an unconfirmed
 *   self-reported role claim;
 * - presence lineage remains runtime ancestry and never becomes reportsTo.
 */
export function resolveTeamMemberView(input: ResolveTeamMemberInput): TeamMemberView {
  const { name } = input;
  const assignment = matching(name, input.assignment);
  const presence = matching(name, input.presence);
  const participant = matching(name, input.participant);
  const identity = input.identity ?? null;

  const kind =
    identity?.kind ??
    assignment?.kind ??
    participant?.kind ??
    presence?.kind ??
    "agent";
  const account =
    nonBlank(identity?.account) ??
    nonBlank(assignment?.account) ??
    nonBlank(participant?.owner) ??
    nonBlank(presence?.account);
  const participantHumanDisplay =
    participant?.kind === "human"
      ? nonBlank(participant.display_name) ?? nonBlank(participant.owner)
      : null;
  const presenceHumanDisplay =
    presence?.kind === "human"
      ? nonBlank(presence.display_name) ?? nonBlank(presence.account)
      : null;
  const display =
    nonBlank(identity?.display) ??
    nonBlank(participant?.handle) ??
    nonBlank(presence?.handle) ??
    participantHumanDisplay ??
    presenceHumanDisplay ??
    nonBlank(assignment?.display) ??
    (kind === "human" ? account : null) ??
    name;

  const claim = selfReportedRoleClaim(presence);
  const role: TeamMemberRole =
    assignment !== null
      ? {
          source: "channel_roles",
          confirmation: "confirmed",
          role: assignment.role,
          responsibility: assignment.responsibility ?? null,
          reportsTo: assignment.reports_to ?? null,
          assignedBy: assignment.assigned_by,
          assignedAt: assignment.assigned_at,
        }
      : claim ?? {
          source: "none",
          confirmation: "none",
          role: null,
          responsibility: null,
          reportsTo: null,
        };

  return {
    name,
    display,
    kind,
    account,
    owner: account !== null && account !== display ? account : null,
    role,
    selfReportedRoleClaim: claim,
    runtime: {
      presence,
      online: participant !== null || presence?.live === true,
      state: presence?.state ?? null,
      note: presence?.note ?? null,
      lineageParent: presence?.lineage?.parent_agent ?? null,
    },
  };
}
