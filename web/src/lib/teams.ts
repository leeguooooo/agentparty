import { PRESENCE_TIMEOUT_MS, type CollaborationRole, type MsgFrame, type PresenceEntry, type Residency, type Sender } from "@agentparty/shared";

export type TeamResidency = Residency | "mixed";

export interface TeamMemberSummary {
  name: string;
  parentAgent: string;
  rootAgent: string;
  teamId: string;
  depth: number;
  state: string;
  role: CollaborationRole | null;
  residency: Residency | "unknown";
  active: boolean;
  connected: boolean;
  lastSeen: number | null;
  expiresAt: number | null;
}

export interface TeamSummary {
  key: string;
  rootAgent: string;
  teamId: string;
  parentAgents: string[];
  activeCount: number;
  staleCount: number;
  memberCount: number;
  maxDepth: number;
  residency: TeamResidency;
  expiresAt: number | null;
  lastSeen: number | null;
  frontAgent: TeamMemberSummary | null;
  members: TeamMemberSummary[];
}

export interface TeamMessageThread {
  type: "team_thread";
  key: string;
  rootAgent: string;
  teamId: string;
  parentAgents: string[];
  members: string[];
  messages: MsgFrame[];
  firstSeq: number;
  lastSeq: number;
  lastTs: number;
}

export type MessageTimelineItem =
  | { type: "message"; message: MsgFrame }
  | TeamMessageThread;

interface SummarizeTeamsInput {
  presence: Record<string, PresenceEntry>;
  participants: Sender[];
  messages: MsgFrame[];
  now?: number;
  /** Current channel roster. Historical messages cannot recreate members absent from this authority. */
  memberNames?: ReadonlySet<string>;
}

interface MemberDraft {
  name: string;
  lineage: Sender["lineage"] | null;
  state: string;
  role: CollaborationRole | null;
  residency: Residency | "unknown";
  connected: boolean;
  lastSeen: number | null;
}

const RESIDENCY_RANK: Record<TeamResidency, number> = {
  webhook: 5,
  // daemon（#688）：内嵌 SDK 的第一方常驻活体，与 supervised 同为「服务端见其在线」的强档，同 rank。
  daemon: 4,
  supervised: 4,
  bare: 3,
  human_driven: 2,
  unknown: 1,
  mixed: 0,
};

function teamKey(rootAgent: string, teamId: string): string {
  return `${rootAgent}::${teamId}`;
}

function lineageTeamKey(msg: MsgFrame): string | null {
  const lineage = msg.sender.lineage;
  if (lineage === undefined) return null;
  return teamKey(lineage.root_agent, lineage.team_id);
}

function newer(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function sooner(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function isActive(state: string, lastSeen: number | null, now: number): boolean {
  return state !== "offline" && lastSeen !== null && now - lastSeen <= PRESENCE_TIMEOUT_MS;
}

function mergeMember(map: Map<string, MemberDraft>, name: string, patch: Partial<MemberDraft>) {
  const prev = map.get(name) ?? {
    name,
    lineage: null,
    state: "offline",
    role: null,
    residency: "unknown",
    connected: false,
    lastSeen: null,
  };
  map.set(name, {
    ...prev,
    ...patch,
    lineage: patch.lineage ?? prev.lineage,
    role: patch.role ?? prev.role,
    residency: patch.residency ?? prev.residency,
    connected: prev.connected || patch.connected === true,
    lastSeen: newer(prev.lastSeen, patch.lastSeen ?? null),
  });
}

function summarizeResidency(values: Array<Residency | "unknown">): TeamResidency {
  const unique = [...new Set(values)];
  if (unique.length === 0) return "unknown";
  if (unique.length === 1) return unique[0]!;
  const known = unique.filter((value) => value !== "unknown");
  if (known.length === 1) return known[0]!;
  return "mixed";
}

export function summarizeTeams({
  presence,
  participants,
  messages,
  now = Date.now(),
  memberNames,
}: SummarizeTeamsInput): TeamSummary[] {
  const members = new Map<string, MemberDraft>();
  const participantByName = new Map(participants.map((sender) => [sender.name, sender]));
  const included = (name: string) => memberNames === undefined || memberNames.has(name);

  for (const sender of participants) {
    if (!included(sender.name)) continue;
    mergeMember(members, sender.name, {
      lineage: sender.lineage ?? null,
      state: "online",
      connected: true,
      lastSeen: now,
    });
  }

  for (const msg of messages) {
    if (!included(msg.sender.name)) continue;
    mergeMember(members, msg.sender.name, {
      lineage: msg.sender.lineage ?? null,
      role: msg.role ?? null,
      lastSeen: msg.ts,
    });
  }

  for (const entry of Object.values(presence)) {
    if (!included(entry.name)) continue;
    const connected = participantByName.has(entry.name);
    mergeMember(members, entry.name, {
      lineage: entry.lineage ?? participantByName.get(entry.name)?.lineage ?? null,
      state: connected && entry.state === "offline" ? "online" : entry.state,
      role: entry.role ?? null,
      residency: entry.residency ?? "unknown",
      connected,
      lastSeen: entry.last_seen ?? entry.ts,
    });
  }

  const grouped = new Map<string, TeamMemberSummary[]>();
  for (const member of members.values()) {
    if (member.lineage === null || member.lineage === undefined) continue;
    const active = isActive(member.state, member.lastSeen, now);
    const summary: TeamMemberSummary = {
      name: member.name,
      parentAgent: member.lineage.parent_agent,
      rootAgent: member.lineage.root_agent,
      teamId: member.lineage.team_id,
      depth: member.lineage.depth,
      state: member.state,
      role: member.role,
      residency: member.residency,
      active,
      connected: member.connected,
      lastSeen: member.lastSeen,
      expiresAt: member.lineage.expires_at,
    };
    const key = teamKey(summary.rootAgent, summary.teamId);
    grouped.set(key, [...(grouped.get(key) ?? []), summary]);
  }

  return [...grouped.entries()]
    .map(([key, rawMembers]) => {
      const sortedMembers = rawMembers.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.name.localeCompare(b.name);
      });
      const activeCount = sortedMembers.filter((member) => member.active).length;
      const parentAgents = [...new Set(sortedMembers.map((member) => member.parentAgent))].sort((a, b) => a.localeCompare(b));
      const residency = summarizeResidency(sortedMembers.map((member) => member.residency));
      const frontAgent =
        sortedMembers.find((member) => member.role === "host") ??
        sortedMembers.find((member) =>
          member.depth === 1 && member.parentAgent === member.rootAgent && member.teamId === member.rootAgent,
        ) ??
        null;
      return {
        key,
        rootAgent: sortedMembers[0]!.rootAgent,
        teamId: sortedMembers[0]!.teamId,
        parentAgents,
        activeCount,
        staleCount: sortedMembers.length - activeCount,
        memberCount: sortedMembers.length,
        maxDepth: Math.max(...sortedMembers.map((member) => member.depth)),
        residency,
        expiresAt: sortedMembers.reduce<number | null>((acc, member) => sooner(acc, member.expiresAt), null),
        lastSeen: sortedMembers.reduce<number | null>((acc, member) => newer(acc, member.lastSeen), null),
        frontAgent,
        members: sortedMembers,
      };
    })
    .sort((a, b) => {
      if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
      if (RESIDENCY_RANK[a.residency] !== RESIDENCY_RANK[b.residency]) {
        return RESIDENCY_RANK[b.residency] - RESIDENCY_RANK[a.residency];
      }
      return (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.key.localeCompare(b.key);
    });
}

function toThread(messages: MsgFrame[], key: string): TeamMessageThread {
  const members = [...new Set(messages.map((msg) => msg.sender.name))].sort((a, b) => a.localeCompare(b));
  const parentAgents = [
    ...new Set(
      messages
        .map((msg) => msg.sender.lineage?.parent_agent)
        .filter((parent): parent is string => parent !== undefined),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const lineage = first.sender.lineage!;
  return {
    type: "team_thread",
    key,
    rootAgent: lineage.root_agent,
    teamId: lineage.team_id,
    parentAgents,
    members,
    messages,
    firstSeq: first.seq,
    lastSeq: last.seq,
    lastTs: last.ts,
  };
}

export function groupTeamMessages(messages: MsgFrame[]): MessageTimelineItem[] {
  const items: MessageTimelineItem[] = [];
  let pendingKey: string | null = null;
  let pending: MsgFrame[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (pendingKey !== null && pending.length > 1) {
      items.push(toThread(pending, pendingKey));
    } else {
      for (const message of pending) items.push({ type: "message", message });
    }
    pendingKey = null;
    pending = [];
  };

  for (const message of messages) {
    const key = lineageTeamKey(message);
    if (key === null) {
      flush();
      items.push({ type: "message", message });
      continue;
    }
    if (pendingKey !== key) flush();
    pendingKey = key;
    pending.push(message);
  }

  flush();
  return items;
}
