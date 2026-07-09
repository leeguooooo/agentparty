// party complete — publish a final synthesis as a first-class message artifact.
import { isHelpArg, parseArgs, str, strArray, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel, saveCursor } from "../config";
import { resolveAuth } from "../oidc-cli";
import { handleRestError, postMessage } from "../rest";
import { isName, isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";

const COMPLETE_FLAGS = ["channel", "kickoff-seq", "replaces", "replies", "timeout", "issue", "pr", "mention", "task"];
const HELP = `usage: party complete <text|-> --kickoff-seq seq [--channel C] [--task id] [--replaces seq] [--replies n] [--timeout] [--issue n]... [--pr n]... [--mention name]...

Publish a final synthesis completion artifact. The message replies to kickoff seq.
If review gate is enabled, approve/reject it with: party review approve|reject <seq>
Otherwise mark done with: party status <channel> done --summary-seq <seq>

Options:
  --channel C       send to channel C instead of the bound channel
  --kickoff-seq n   kickoff message seq this synthesis closes
  --replaces n      previous rejected completion seq this synthesis replaces
  --replies n       participant replies counted before synthesis (default 0)
  --timeout         mark that collection ended by timeout
  --issue n         related GitHub issue number; repeatable
  --pr n            related GitHub PR number; repeatable
  --task n          channel task this completion closes
  --mention name    mention a user or agent; repeatable`;

function parsePositiveList(values: string[] | undefined, flag: string): number[] | string {
  const out: number[] = [];
  for (const value of values ?? []) {
    const n = parsePositiveIntFlag(value, flag);
    if (typeof n === "string" || n === undefined) return n ?? `--${flag} must be a positive integer`;
    out.push(n);
  }
  return out;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv)) {
    console.log(HELP);
    return 0;
  }
  const parsed = parseArgs(argv, {
    booleans: ["timeout"],
    repeatable: ["issue", "pr", "mention"],
  });
  const unknown = unknownFlagError(parsed.flags, COMPLETE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(parsed.flags, ["channel", "kickoff-seq", "replaces", "replies", "task"], ["issue", "pr", "mention"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }

  const kickoffSeq = parsePositiveIntFlag(str(parsed.flags["kickoff-seq"]), "kickoff-seq");
  if (typeof kickoffSeq === "string" || kickoffSeq === undefined) {
    console.error(kickoffSeq ?? "--kickoff-seq is required");
    return 1;
  }
  const replies = parseNonNegativeIntFlag(str(parsed.flags.replies) ?? "0", "replies");
  if (typeof replies === "string" || replies === undefined) {
    console.error(replies ?? "--replies must be a non-negative integer");
    return 1;
  }
  const replaces = str(parsed.flags.replaces) === undefined ? undefined : parsePositiveIntFlag(str(parsed.flags.replaces), "replaces");
  if (typeof replaces === "string") {
    console.error(replaces);
    return 1;
  }
  const taskId = str(parsed.flags.task) === undefined ? undefined : parsePositiveIntFlag(str(parsed.flags.task), "task");
  if (typeof taskId === "string") {
    console.error(taskId);
    return 1;
  }
  const relatedIssues = parsePositiveList(strArray(parsed.flags.issue), "issue");
  if (typeof relatedIssues === "string") {
    console.error(relatedIssues);
    return 1;
  }
  const relatedPrs = parsePositiveList(strArray(parsed.flags.pr), "pr");
  if (typeof relatedPrs === "string") {
    console.error(relatedPrs);
    return 1;
  }
  const mentions = strArray(parsed.flags.mention) ?? [];
  if (mentions.some((mention) => !isName(mention))) {
    console.error("--mention must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }

  const channel = resolveChannel(str(parsed.flags.channel));
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const body =
    parsed.positionals.length === 1 && parsed.positionals[0] === "-"
      ? await Bun.stdin.text()
      : parsed.positionals.length > 0
        ? parsed.positionals.join(" ")
        : undefined;
  if (body === undefined || body.trim() === "") {
    console.error("missing completion body (use - to read stdin)");
    return 1;
  }

  const auth = await resolveAuth();
  if (!auth) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  try {
    const { seq, completion_review } = await postMessage(auth.server, auth.token, channel, {
      kind: "message",
      body,
      mentions,
      reply_to: kickoffSeq,
      completion_artifact: {
        kind: "final_synthesis",
        kickoff_seq: kickoffSeq,
        replies_count: replies,
        timeout: parsed.flags.timeout === true,
        related_issues: relatedIssues,
        related_prs: relatedPrs,
        ...(taskId === undefined ? {} : { task_id: taskId }),
      },
      ...(replaces === undefined ? {} : { replaces }),
    });
    saveCursor(channel, seq);
    if (completion_review?.state === "pending_review") {
      console.log(`completion seq=${seq} pending_review`);
      console.log(`next: party review approve ${seq} --channel ${channel}  # or: party review reject ${seq} -m "reason" --channel ${channel}`);
    } else {
      console.log(`completion seq=${seq}`);
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
