// party host board — derived coordinator board from presence + retained status history.
import {
  buildHostBoard,
  type HostBoard,
} from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { fetchMessages, fetchPresence, handleRestError } from "../rest";
import { isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";

const HOST_FLAGS = ["channel", "since", "limit", "json"];
const HELP = `usage: party host board [channel|--channel C] [--since seq] [--limit n] [--json]

Show a derived coordinator board for host/failover review.

The board is read-only and uses existing data only:
  - /api/channels/:channel/presence for host lease/residency
  - retained status history for open claims, blockers, and host decisions

Options:
  --channel C   read channel C instead of the bound channel
  --since seq   only inspect status messages after seq
  --limit n     maximum messages to inspect (default 500, max 1000)
  --json        emit one structured JSON frame`;

function scopeLabel(scope: string[]): string {
  return scope.length > 0 ? scope.join(",") : "(no scope)";
}

function printBoard(board: HostBoard) {
  console.log(`host board ${board.channel} last_seq=${board.last_seq}`);
  console.log(`hosts: ${board.hosts.length}`);
  for (const host of board.hosts) {
    const reason = host.stale_reason === null ? "" : ` reason=${host.stale_reason}`;
    console.log(`- ${host.name} ${host.lease} residency=${host.residency} wake=${host.wake_kind}${reason}`);
  }
  console.log(`open claims: ${board.open_claims.length}`);
  for (const claim of board.open_claims) {
    const blocked = claim.blocked_reason === null ? "" : ` blocked=${claim.blocked_reason}`;
    const workflow = claim.workflow === null ? "" : ` workflow=${claim.workflow.workflow_id}/${claim.workflow.kind}`;
    console.log(`- #${claim.seq} ${claim.owner} ${claim.state} scope=${scopeLabel(claim.scope)}${workflow}${blocked}`);
  }
  console.log(`blockers: ${board.blockers.length}`);
  for (const blocker of board.blockers) {
    console.log(`- #${blocker.seq} ${blocker.owner} ${blocker.blocked_reason ?? blocker.note ?? "blocked"}`);
  }
  console.log(`conflicts: ${board.conflicts.length}`);
  for (const conflict of board.conflicts) {
    const claims = conflict.claims.map((claim) => `#${claim.seq} ${claim.owner}`).join(" vs ");
    console.log(`- ${conflict.scope}: ${claims}`);
  }
  console.log(`decisions: ${board.decisions.length}`);
  for (const decision of board.decisions) {
    const handoff = decision.handoff_to === null ? "" : ` handoff=${decision.handoff_to}`;
    const takeover = decision.takeover_from === null ? "" : ` takeover=${decision.takeover_from}`;
    console.log(`- #${decision.seq} ${decision.owner} ${decision.kind}: ${decision.decision}${handoff}${takeover}`);
  }
  console.log(`recommended actions: ${board.recommended_actions.length}`);
  for (const action of board.recommended_actions) {
    const human = action.requires_human ? " human" : "";
    const target = action.target === null ? "" : ` target=${action.target}`;
    const command = action.command === null ? "" : ` command=${action.command}`;
    console.log(`- ${action.kind}${human}${target}: ${action.reason}${command}`);
  }
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const [subcmd, ...rest] = argv;
  if (subcmd !== "board") {
    console.error("usage: party host board [channel|--channel C] [--since seq] [--limit n] [--json]");
    return 1;
  }
  const { positionals, flags } = parseArgs(rest, { booleans: ["json"] });
  const unknown = unknownFlagError(flags, HOST_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "since", "limit"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const since = parseNonNegativeIntFlag(str(flags.since), "since");
  if (typeof since === "string") {
    console.error(since);
    return 1;
  }
  const limit = parsePositiveIntFlag(str(flags.limit), "limit", 1000);
  if (typeof limit === "string") {
    console.error(limit);
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }

  try {
    const [presence, messages] = await Promise.all([
      fetchPresence(cfg.server, cfg.token, channel),
      fetchMessages(cfg.server, cfg.token, channel, since ?? 0, limit ?? 500),
    ]);
    const board = buildHostBoard(channel, presence, messages);
    if (flags.json === true) console.log(JSON.stringify(jsonFrame(board as unknown as Record<string, unknown>)));
    else printBoard(board);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
