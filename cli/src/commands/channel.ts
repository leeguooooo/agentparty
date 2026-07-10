// party channel create|list|archive|reset-guard
import { isHelpArg, parseArgs, str, strArray, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import {
  createJoinLink,
  archiveChannel,
  clearChannelRole,
  createChannel,
  getLoopGuard,
  handleRestError,
  inviteProjectAgent,
  fetchChannelPerms,
  kickParticipant,
  listChannelMembers,
  listChannelRoles,
  listChannels,
  removeChannelMember,
  removeProjectAgentInvite,
  resetGuard,
  revokeJoinLink,
  setChannelRole,
  setChannelPerms,
  setChannelVisibility,
  setCompletionGate,
  setLoopGuard,
  setWorkflowGuard,
  type AgentChannelPermPolicy,
  type ChannelPerms,
  type ChannelPermsUpdate,
  type HumanChannelListPolicy,
  type HumanChannelPermPolicy,
} from "../rest";
import { isName, isSlug } from "../validation";

const CHANNEL_FLAGS = [
  "title",
  "temp",
  "party",
  "public",
  "policy",
  "confirm",
  "expires",
  "max-uses",
  "remove",
  "responsibility",
  "charter-write",
  "charter-write-agents",
  "agent",
  "members-list",
  "members-list-agents",
  "members-agent",
  "json",
];
const COLLAB_ROLES = ["host", "worker", "reviewer", "observer"] as const;
const COMPLETION_GATES = ["reviewer", "off"] as const;
const COMPLETION_REVIEW_POLICIES = ["sender", "owner"] as const;
const VISIBILITIES = ["public", "private"] as const;
const HUMAN_PERM_POLICIES = ["owner", "moderators", "members"] as const;
const HUMAN_LIST_POLICIES = ["off", "owner", "moderators", "members"] as const;
const AGENT_PERM_POLICIES = ["off", "moderators", "members", "allowlist"] as const;
const HELP = `usage: party channel create <slug> [--title t] [--temp] [--party] [--public]
       party channel list
       party channel archive [slug]                 archive, kick live agents, keep history
       party channel reset-guard [slug]
       party channel kick <name> [slug] [--remove]
       party channel invite-agent <owner>/<handle> [slug]
       party channel remove-agent <owner>/<handle> [slug]
       party channel gate reviewer|off [slug] [--policy sender|owner]
       party channel guard unlimited|off|<limit> [slug]
       party channel guard status [slug] [--json]   read limit/streak/remaining before exit 4
       party channel workflow-guard off|<limit> [slug]
       party channel visibility <slug> public|private [--confirm]
       party channel members <slug>
       party channel perms <slug> [--json]
       party channel perms <slug> [--charter-write owner|moderators|members]
                                  [--charter-write-agents off|moderators|members|allowlist]
                                  [--agent name ...]
                                  [--members-list off|owner|moderators|members]
                                  [--members-list-agents off|moderators|members|allowlist]
                                  [--members-agent name ...]
       party channel join-link <slug> [--expires 7d] [--max-uses N]
       party channel join-link revoke <slug> <code>
       party channel leave <slug>
       party channel role list [slug]
       party channel role set <name> host|worker|reviewer|observer [slug] [--responsibility text]
       party channel role unset <name> [slug]

Manage channels.

Archived channels are terminal: live agents are kicked with an archived error, future writes/watch exits stop
with the archived exit code, and history stays readable. Hard delete is intentionally not exposed.

Options:
  --title t   channel title when creating
  --temp      create a temporary channel
  --party     create a party-mode channel
  --public    create a public channel
  --policy p  completion review policy: sender or owner
  guard limit consecutive agent messages before human intervention; off/unlimited disables it
  --confirm   confirm private-to-public visibility switch
  --remove    revoke the channel-scoped token and remove membership when kicking
  --expires d join-link expiry like 7d, 12h, 30m, 60s
  --max-uses n join-link redemption limit
  --json      output channel permission policy as JSON
  --charter-write p
              human charter writers: owner, moderators, or members
  --charter-write-agents p
              agent charter writers: off, moderators, members, or allowlist
  --agent n   repeatable allowlist entry for --charter-write-agents allowlist
  --members-list p
              human member-list readers: off, owner, moderators, or members
  --members-list-agents p
              agent member-list readers: off, moderators, members, or allowlist
  --members-agent n
              repeatable allowlist entry for --members-list-agents allowlist
  --responsibility text, -m text
              structured responsibility shown in web division board and @ suggestions`;

function parseDurationSec(input: string | undefined): number | null | undefined {
  if (input === undefined) return undefined;
  const m = input.match(/^([1-9]\d*)([smhd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
}

function parsePositiveIntFlag(input: string | undefined): number | null | undefined {
  if (input === undefined) return undefined;
  const n = Number(input);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseProfileRef(input: string | undefined): { owner: string; handle: string } | null {
  if (!input) return null;
  const slash = input.lastIndexOf("/");
  if (slash <= 0 || slash === input.length - 1) return null;
  const owner = input.slice(0, slash);
  const handle = input.slice(slash + 1);
  if (owner.length > 320 || /[\x00-\x1f\x7f]/.test(owner) || !isName(handle)) return null;
  return { owner, handle };
}

function printPerms(slug: string, perms: ChannelPerms, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ channel_slug: slug, permissions: perms }, null, 2));
    return;
  }
  console.log(`channel ${slug} permissions`);
  console.log(`charter_write\t${perms.charter_write}`);
  console.log(`charter_write_agents\t${perms.charter_write_agents}\t${perms.charter_write_agent_allowlist.join(",")}`);
  console.log(`members_list\t${perms.members_list}`);
  console.log(`members_list_agents\t${perms.members_list_agents}\t${perms.members_list_agent_allowlist.join(",")}`);
}

function repeatedNames(value: string[] | undefined, label: string): string[] | null | undefined {
  if (value === undefined) return undefined;
  const names = [...new Set(value.map((item) => item.trim()).filter(Boolean))].sort();
  if (names.some((name) => !isName(name))) {
    console.error(`${label} must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}`);
    return null;
  }
  return names;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, {
    booleans: ["temp", "party", "public", "confirm", "remove", "json"],
    repeatable: ["agent", "members-agent"],
    aliases: { m: "responsibility" },
  });
  const unknown = unknownFlagError(flags, CHANNEL_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(
    flags,
    ["title", "policy", "expires", "max-uses", "responsibility", "charter-write", "charter-write-agents", "members-list", "members-list-agents"],
    ["agent", "members-agent"],
  );
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const sub = positionals[0];
  try {
    switch (sub) {
      case "create": {
        const slug = positionals[1];
        if (!slug) {
          console.error(
            "usage: party channel create <slug> [--title t] [--temp] [--party] [--public]",
          );
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await createChannel(cfg.server, cfg.token, {
          slug,
          title: str(flags.title),
          kind: flags.temp === true ? "temp" : "standing",
          mode: flags.party === true ? "party" : "normal",
          visibility: flags.public === true ? "public" : "private",
        });
        console.log(`created ${slug}`);
        return 0;
      }
      case "list": {
        const channels = await listChannels(cfg.server, cfg.token);
        for (const c of channels) {
          const state = c.archived_at ? "archived" : "active";
          const vis = c.visibility ?? "private";
          console.log(
            `${c.slug}\t${c.kind}\t${c.mode ?? "normal"}\t${vis}\t${state}\t${c.title ?? ""}`,
          );
        }
        return 0;
      }
      case "archive": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel archive [slug]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await archiveChannel(cfg.server, cfg.token, slug);
        console.log(`archived ${slug}`);
        console.log("  live agents were kicked with error: archived");
        console.log("  future watch/send calls stop with exit code 5 (archived)");
        console.log("  history is kept; hard delete is not exposed");
        return 0;
      }
      case "reset-guard": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel reset-guard [slug]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await resetGuard(cfg.server, cfg.token, slug);
        console.log(`guard reset ${slug}`);
        return 0;
      }
      case "kick": {
        const name = positionals[1];
        const slug = resolveChannel(positionals[2]);
        if (!name || !slug) {
          console.error("usage: party channel kick <name> [slug] [--remove]");
          return 1;
        }
        if (!isName(name)) {
          console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const mode = flags.remove === true ? "remove" : "disconnect";
        await kickParticipant(cfg.server, cfg.token, slug, name, mode);
        console.log(mode === "remove" ? `removed ${name} from ${slug}` : `kicked ${name} from ${slug}`);
        return 0;
      }
      case "invite-agent": {
        const profile = parseProfileRef(positionals[1]);
        const slug = resolveChannel(positionals[2]);
        if (!profile || !slug) {
          console.error("usage: party channel invite-agent <owner>/<handle> [slug]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const invite = await inviteProjectAgent(cfg.server, cfg.token, slug, profile.owner, profile.handle);
        const state = invite.already_invited ? "already invited" : "invited";
        console.log(`${state} ${profile.owner}/${profile.handle} to ${slug}`);
        return 0;
      }
      case "remove-agent": {
        const profile = parseProfileRef(positionals[1]);
        const slug = resolveChannel(positionals[2]);
        if (!profile || !slug) {
          console.error("usage: party channel remove-agent <owner>/<handle> [slug]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await removeProjectAgentInvite(cfg.server, cfg.token, slug, profile.owner, profile.handle);
        console.log(`removed ${profile.owner}/${profile.handle} from ${slug}`);
        return 0;
      }
      case "gate": {
        const gate = positionals[1];
        const slug = resolveChannel(positionals[2]);
        const policy = str(flags.policy);
        if (!gate || !slug) {
          console.error("usage: party channel gate reviewer|off [slug] [--policy sender|owner]");
          return 1;
        }
        if (!COMPLETION_GATES.includes(gate as (typeof COMPLETION_GATES)[number])) {
          console.error("gate must be reviewer or off");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        if (policy !== undefined && !COMPLETION_REVIEW_POLICIES.includes(policy as (typeof COMPLETION_REVIEW_POLICIES)[number])) {
          console.error("policy must be sender or owner");
          return 1;
        }
        const result = await setCompletionGate(cfg.server, cfg.token, slug, {
          gate: gate as (typeof COMPLETION_GATES)[number],
          ...(policy === undefined ? {} : { policy: policy as (typeof COMPLETION_REVIEW_POLICIES)[number] }),
        });
        console.log(`completion gate ${slug}: ${result.gate} policy=${result.policy}`);
        return 0;
      }
      case "guard": {
        const value = positionals[1];
        // #174 读路径：熔断前读 limit/streak/remaining，与 set 语义共用 guard 子命令。
        if (value === "status") {
          const slug = resolveChannel(positionals[2]);
          if (!slug) {
            console.error("usage: party channel guard status [slug] [--json]");
            return 1;
          }
          if (!isSlug(slug)) {
            console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
            return 1;
          }
          const state = await getLoopGuard(cfg.server, cfg.token, slug);
          if (flags.json === true) {
            console.log(JSON.stringify(state));
          } else {
            const onoff = state.enabled ? "on" : "off";
            console.log(
              `loop guard ${slug}: ${onoff} streak=${state.streak}/${state.limit} remaining=${state.remaining} resets_on=${state.resets_on}`,
            );
          }
          return 0;
        }
        const slug = resolveChannel(positionals[2]);
        if (!value || !slug) {
          console.error("usage: party channel guard status|unlimited|off|<limit> [slug]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const disabled = value === "off" || value === "unlimited";
        const limit = disabled ? undefined : parsePositiveIntFlag(value);
        if (!disabled && limit === null) {
          console.error("guard must be off, unlimited, or a positive integer");
          return 1;
        }
        const result = disabled
          ? await setLoopGuard(cfg.server, cfg.token, slug, { enabled: false })
          : await setLoopGuard(cfg.server, cfg.token, slug, { enabled: true, limit: limit as number });
        console.log(`loop guard ${slug}: ${result.enabled ? `${result.limit} messages` : "unlimited"}`);
        return 0;
      }
      case "workflow-guard": {
        const value = positionals[1];
        const slug = resolveChannel(positionals[2]);
        if (!value || !slug) {
          console.error("usage: party channel workflow-guard off|<limit> [slug]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const disabled = value === "off" || value === "unlimited";
        const limit = disabled ? undefined : parsePositiveIntFlag(value);
        if (!disabled && limit === null) {
          console.error("workflow-guard must be off, unlimited, or a positive integer");
          return 1;
        }
        const result = disabled
          ? await setWorkflowGuard(cfg.server, cfg.token, slug, { enabled: false })
          : await setWorkflowGuard(cfg.server, cfg.token, slug, { enabled: true, limit: limit as number });
        console.log(`workflow guard ${slug}: ${result.enabled ? `${result.limit} messages` : "off"}`);
        return 0;
      }
      case "visibility": {
        const first = positionals[1];
        const second = positionals[2];
        const slug = second === undefined ? resolveChannel(undefined) : first;
        const visibility = second === undefined ? first : second;
        if (!slug || !visibility) {
          console.error("usage: party channel visibility <slug> public|private [--confirm]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        if (!VISIBILITIES.includes(visibility as (typeof VISIBILITIES)[number])) {
          console.error("visibility must be public or private");
          return 1;
        }
        const result = await setChannelVisibility(cfg.server, cfg.token, slug, {
          visibility: visibility as (typeof VISIBILITIES)[number],
          ...(flags.confirm === true ? { confirm: true as const } : {}),
        });
        console.log(`visibility ${slug}: ${result.visibility}`);
        return 0;
      }
      case "members": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel members <slug>");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const members = await listChannelMembers(cfg.server, cfg.token, slug);
        for (const m of members) {
          console.log(`${m.account}\t${m.added_by}\t${new Date(m.added_at).toISOString()}`);
        }
        return 0;
      }
      case "perms": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel perms <slug> [--json] [--charter-write owner|moderators|members] [--charter-write-agents off|moderators|members|allowlist] [--agent name]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const charterWrite = str(flags["charter-write"]);
        const charterWriteAgents = str(flags["charter-write-agents"]);
        const membersList = str(flags["members-list"]);
        const membersListAgents = str(flags["members-list-agents"]);
        if (charterWrite !== undefined && !HUMAN_PERM_POLICIES.includes(charterWrite as HumanChannelPermPolicy)) {
          console.error("--charter-write must be owner, moderators, or members");
          return 1;
        }
        if (charterWriteAgents !== undefined && !AGENT_PERM_POLICIES.includes(charterWriteAgents as AgentChannelPermPolicy)) {
          console.error("--charter-write-agents must be off, moderators, members, or allowlist");
          return 1;
        }
        if (membersList !== undefined && !HUMAN_LIST_POLICIES.includes(membersList as HumanChannelListPolicy)) {
          console.error("--members-list must be off, owner, moderators, or members");
          return 1;
        }
        if (membersListAgents !== undefined && !AGENT_PERM_POLICIES.includes(membersListAgents as AgentChannelPermPolicy)) {
          console.error("--members-list-agents must be off, moderators, members, or allowlist");
          return 1;
        }
        const charterAgents = repeatedNames(strArray(flags.agent), "--agent");
        if (charterAgents === null) return 1;
        const membersAgents = repeatedNames(strArray(flags["members-agent"]), "--members-agent");
        if (membersAgents === null) return 1;
        const update: ChannelPermsUpdate = {
          ...(charterWrite === undefined ? {} : { charter_write: charterWrite as HumanChannelPermPolicy }),
          ...(charterWriteAgents === undefined ? {} : { charter_write_agents: charterWriteAgents as AgentChannelPermPolicy }),
          ...(charterAgents === undefined ? {} : { charter_write_agent_allowlist: charterAgents }),
          ...(membersList === undefined ? {} : { members_list: membersList as HumanChannelListPolicy }),
          ...(membersListAgents === undefined ? {} : { members_list_agents: membersListAgents as AgentChannelPermPolicy }),
          ...(membersAgents === undefined ? {} : { members_list_agent_allowlist: membersAgents }),
        };
        const changed = Object.keys(update).length > 0;
        const perms = changed
          ? await setChannelPerms(cfg.server, cfg.token, slug, update)
          : await fetchChannelPerms(cfg.server, cfg.token, slug);
        printPerms(slug, perms, flags.json === true);
        return 0;
      }
      case "join-link": {
        const actionOrSlug = positionals[1];
        if (actionOrSlug === "revoke") {
          const slug = positionals[2];
          const code = positionals[3];
          if (!slug || !code) {
            console.error("usage: party channel join-link revoke <slug> <code>");
            return 1;
          }
          if (!isSlug(slug)) {
            console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
            return 1;
          }
          await revokeJoinLink(cfg.server, cfg.token, slug, code);
          console.log(`revoked join link ${code} for ${slug}`);
          return 0;
        }
        const slug = actionOrSlug;
        if (!slug) {
          console.error("usage: party channel join-link <slug> [--expires 7d] [--max-uses N]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const expires = parseDurationSec(str(flags.expires));
        if (expires === null) {
          console.error("--expires must look like 7d, 12h, 30m, or 60s");
          return 1;
        }
        const maxUses = parsePositiveIntFlag(str(flags["max-uses"]));
        if (maxUses === null) {
          console.error("--max-uses must be a positive integer");
          return 1;
        }
        const link = await createJoinLink(cfg.server, cfg.token, slug, {
          ...(expires === undefined ? {} : { expires_in_sec: expires }),
          ...(maxUses === undefined ? {} : { max_uses: maxUses }),
        });
        console.log(link.url ?? `${cfg.server.replace(/\/+$/, "")}/join/${link.code}`);
        return 0;
      }
      case "leave": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel leave <slug>");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await removeChannelMember(cfg.server, cfg.token, slug, "me");
        console.log(`left ${slug}`);
        return 0;
      }
      case "role": {
        const action = positionals[1];
        if (action === "list") {
          const slug = resolveChannel(positionals[2]);
          if (!slug) {
            console.error("usage: party channel role list [slug]");
            return 1;
          }
          if (!isSlug(slug)) {
            console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
            return 1;
          }
          const roles = await listChannelRoles(cfg.server, cfg.token, slug);
          for (const r of roles) {
            const responsibility = r.responsibility === null ? "" : `\t${r.responsibility}`;
            console.log(`${r.name}\t${r.role}\t${r.assigned_by}\t${new Date(r.assigned_at).toISOString()}${responsibility}`);
          }
          return 0;
        }
        if (action === "set") {
          const name = positionals[2];
          const role = positionals[3];
          const slug = resolveChannel(positionals[4]);
          if (!name || !role || !slug) {
            console.error("usage: party channel role set <name> host|worker|reviewer|observer [slug] [--responsibility text]");
            return 1;
          }
          if (!isName(name)) {
            console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
            return 1;
          }
          if (!COLLAB_ROLES.includes(role as (typeof COLLAB_ROLES)[number])) {
            console.error("role must be host, worker, reviewer, or observer");
            return 1;
          }
          if (!isSlug(slug)) {
            console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
            return 1;
          }
          const responsibility = str(flags.responsibility);
          await setChannelRole(cfg.server, cfg.token, slug, name, role as (typeof COLLAB_ROLES)[number], responsibility);
          console.log(`assigned ${name} as ${role} in ${slug}`);
          return 0;
        }
        if (action === "unset") {
          const name = positionals[2];
          const slug = resolveChannel(positionals[3]);
          if (!name || !slug) {
            console.error("usage: party channel role unset <name> [slug]");
            return 1;
          }
          if (!isName(name)) {
            console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
            return 1;
          }
          if (!isSlug(slug)) {
            console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
            return 1;
          }
          await clearChannelRole(cfg.server, cfg.token, slug, name);
          console.log(`cleared role for ${name} in ${slug}`);
          return 0;
        }
        console.error("usage: party channel role list|set|unset");
        return 1;
      }
      default:
        console.error("usage: party channel create|list|archive|reset-guard|kick|invite-agent|gate|visibility|members|perms|join-link|leave|role");
        return 1;
    }
  } catch (e) {
    return handleRestError(e);
  }
}
