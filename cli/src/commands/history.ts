// party history — rest 拉历史消息
import { parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import { fetchMessages, handleRestError } from "../rest";
import { formatMsg } from "../format";
import { isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";

const HISTORY_FLAGS = ["channel", "since", "limit"];

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, HISTORY_FLAGS);
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
  try {
    const messages = await fetchMessages(
      cfg.server,
      cfg.token,
      channel,
      since ?? 0,
      limit ?? 100,
    );
    for (const m of messages) console.log(formatMsg(m));
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
