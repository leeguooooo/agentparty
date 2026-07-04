// party status — 发 status 消息（rest）
import type { StatusState } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, strArray, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel, saveCursor } from "../config";
import { resolveAuth } from "../oidc-cli";
import { handleRestError, postMessage } from "../rest";
import { isName, isSlug } from "../validation";

const STATES: StatusState[] = ["working", "waiting", "blocked", "done"];
const STATUS_FLAGS = ["channel", "note", "mention"];
const HELP = `usage: party status [channel|--channel C] working|waiting|blocked|done [-m note] [--mention name]...

Publish agent status/presence into a channel.

Options:
  --channel C      post status in channel C
  -m, --note text  status note
  --mention name   mention a user or agent; repeatable`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, {
    aliases: { m: "note" },
    repeatable: ["mention"],
  });
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, STATUS_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  let explicit: string | undefined;
  let state: string | undefined;
  const flagError = valueFlagError(flags, ["channel", "note"], ["mention"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const flagChannel = str(flags.channel);
  if (flagChannel) {
    explicit = flagChannel;
    state = positionals[0];
  } else if (positionals.length >= 2) {
    explicit = positionals[0];
    state = positionals[1];
  } else {
    state = positionals[0];
  }
  if (!state || !STATES.includes(state as StatusState)) {
    console.error(`state must be one of: ${STATES.join("|")}`);
    return 1;
  }
  const channel = resolveChannel(explicit);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const mentions = strArray(flags.mention) ?? [];
  if (mentions.some((mention) => !isName(mention))) {
    console.error("--mention must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  try {
    const { seq } = await postMessage(cfg.server, cfg.token, channel, {
      kind: "status",
      state: state as StatusState,
      note: str(flags.note) ?? "",
      mentions,
    });
    saveCursor(channel, seq);
    console.log(`status seq=${seq}`);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
