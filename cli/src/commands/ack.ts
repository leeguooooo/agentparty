// party ack — 显式了结 watch 欠账（#594）：纯读场景（读到别人的 status/不需要回应的消息）
// 没有合法的清账手段，被迫发一条无信息量的消息——这正是频道礼仪劝阻的行为。
// 只清 watch 源的债；serve 的 directed 债由 serve 闭环自己管（误清=静默丢 @，#198 红线）。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { clearStuck, loadStuck, resolveChannel } from "../config";
import { isSlug, parsePositiveIntFlag } from "../validation";

const FLAGS = ["channel", "seq"];
const HELP = `usage: party ack [--channel C] [--seq N]

Acknowledge the pending watch wake debt without posting a message. Use it after
a watch --once delivered a frame that warrants no reply (someone else's status,
FYI messages) — replying with empty acks burns the loop guard; leaving the debt
unacknowledged makes every later watch replay the same frame (#594).

Only watch-sourced debt can be acked. Debt owned by party serve is never touched
here: serve replays it durably and clearing it by hand would silently drop an @.

Options:
  --channel C   channel to ack in (defaults to the bound channel)
  --seq N       only ack if the pending debt is exactly seq N (guard against races)`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "seq"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const seqFlag = parsePositiveIntFlag(str(flags.seq), "seq");
  if (typeof seqFlag === "string") {
    console.error(seqFlag);
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const stuck = loadStuck(channel);
  if (stuck === null) {
    console.log(`no pending wake debt in #${channel}`);
    return 0;
  }
  if (stuck.source !== "watch") {
    console.error(
      `refusing to ack: pending debt at seq=${stuck.seq} is owned by party serve (source=${stuck.source}); ` +
        "serve replays it durably — clearing it by hand would silently drop that @",
    );
    return 1;
  }
  if (seqFlag !== undefined && stuck.seq !== seqFlag) {
    console.error(`refusing to ack: pending watch debt is seq=${stuck.seq}, not seq=${seqFlag}`);
    return 1;
  }
  clearStuck(channel);
  console.log(`acked watch wake seq=${stuck.seq} in #${channel}`);
  return 0;
}
