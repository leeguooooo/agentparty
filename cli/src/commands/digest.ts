// party digest — structured catch-up over recent history, separating mention/wake/resume.
import type { MsgFrame, StatusState, WakeDelivery } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { loadCursor, resolveChannel } from "../config";
import { jsonFrame, nowTs } from "../json";
import { resolveAuth } from "../oidc-cli";
import { RestError, fetchMe, fetchMessages, fetchWakeDeliveries, handleRestError } from "../rest";
import { isName, isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";

const DIGEST_FLAGS = ["channel", "since", "limit", "for", "json"];
const HELP = `usage: party digest [channel|--channel C] [--since seq|last-seen] [--limit n] [--for name] [--json]

Summarize channel catch-up from structured history.

Options:
  --channel C         read channel C instead of the bound channel
  --since seq         only include messages after seq
  --since last-seen   use this workspace/channel cursor
  --limit n           maximum messages to scan
  --for name          summarize mentions for name instead of current identity
  --json              emit one structured digest frame`;

interface InboxMentionDigest {
  seq: number;
  from: string;
  body: string;
  ts: number;
  wake_invoked: boolean;
}

interface RespondedMentionDigest extends InboxMentionDigest {
  response_seq: number;
  evidence: "reply_to" | "status.summary_seq";
}

interface WokenMentionDigest extends InboxMentionDigest {
  adapter: string;
  attempt: number;
  result: "ok" | "failed";
  http_status: number | null;
  error: string | null;
  attempted_at: number;
}

interface StatusDigest {
  seq: number;
  owner: string;
  state: StatusState;
  note: string;
  scope: string[];
  summary_seq: number | null;
  blocked_reason: string | null;
  ts: number;
}

function firstLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 180);
}

function statusOwner(m: MsgFrame): string {
  return m.status?.owner ?? m.sender.name;
}

function statusScope(m: MsgFrame): string[] {
  return m.status?.scope ?? [];
}

function summarizeStatuses(messages: MsgFrame[]): StatusDigest[] {
  return messages
    .filter((m) => m.kind === "status" && m.state !== null)
    .map((m) => ({
      seq: m.seq,
      owner: statusOwner(m),
      state: m.state!,
      note: m.note ?? "",
      scope: statusScope(m),
      summary_seq: m.status?.summary_seq ?? null,
      blocked_reason: m.status?.blocked_reason ?? null,
      ts: m.ts,
    }));
}

function responseEvidence(mention: MsgFrame, candidate: MsgFrame): RespondedMentionDigest["evidence"] | null {
  if (candidate.reply_to === mention.seq) return "reply_to";
  if (candidate.status?.summary_seq === mention.seq) return "status.summary_seq";
  return null;
}

function summarizeMentions(
  messages: MsgFrame[],
  viewer: string | null,
  deliveries: Map<number, WakeDelivery>,
): { inbox: InboxMentionDigest[]; responded: RespondedMentionDigest[]; woken: WokenMentionDigest[] } {
  if (viewer === null) return { inbox: [], responded: [], woken: [] };
  const inbox: InboxMentionDigest[] = [];
  const responded: RespondedMentionDigest[] = [];
  const woken: WokenMentionDigest[] = [];
  for (const mention of messages.filter((m) => m.mentions.includes(viewer))) {
    const delivery = deliveries.get(mention.seq) ?? null;
    const base = {
      seq: mention.seq,
      from: mention.sender.name,
      body: firstLine(mention.body),
      ts: mention.ts,
      wake_invoked: delivery !== null,
    };
    if (delivery !== null) {
      woken.push({
        ...base,
        adapter: delivery.adapter_kind,
        attempt: delivery.attempt,
        result: delivery.result,
        http_status: delivery.http_status,
        error: delivery.error,
        attempted_at: delivery.attempted_at,
      });
    }
    const response = messages
      .filter((candidate) => candidate.seq > mention.seq && candidate.sender.name === viewer)
      .map((candidate) => ({ candidate, evidence: responseEvidence(mention, candidate) }))
      .find((item) => item.evidence !== null);
    if (response?.evidence) {
      responded.push({
        ...base,
        response_seq: response.candidate.seq,
        evidence: response.evidence,
      });
    } else {
      inbox.push(base);
    }
  }
  return { inbox, responded, woken };
}

function latestWakeDeliveries(deliveries: WakeDelivery[]): Map<number, WakeDelivery> {
  const byMention = new Map<number, WakeDelivery>();
  for (const d of deliveries) {
    const prev = byMention.get(d.mention_seq);
    if (
      prev === undefined ||
      d.attempt > prev.attempt ||
      (d.attempt === prev.attempt && d.attempted_at > prev.attempted_at)
    ) {
      byMention.set(d.mention_seq, d);
    }
  }
  return byMention;
}

async function fetchDigestWakeDeliveries(
  server: string,
  token: string,
  channel: string,
  viewer: string | null,
  since: number,
  limit: number,
): Promise<WakeDelivery[]> {
  if (viewer === null) return [];
  try {
    return await fetchWakeDeliveries(server, token, channel, {
      since: since + 1,
      target: viewer,
      limit: Math.min(limit, 100),
    });
  } catch (e) {
    if (e instanceof RestError && (e.status === 404 || e.status === 501)) return [];
    throw e;
  }
}

function printHuman(input: {
  channel: string;
  since: number;
  lastSeq: number;
  viewer: string | null;
  total: number;
  statuses: StatusDigest[];
  inboxMentions: InboxMentionDigest[];
  respondedMentions: RespondedMentionDigest[];
  wokenMentions: WokenMentionDigest[];
}) {
  console.log(`digest ${input.channel} #${input.since + 1}..#${input.lastSeq} (${input.total} messages)`);
  console.log(`viewer: ${input.viewer ?? "unknown"}`);
  console.log("wake: delivery ledger is separate from linked fresh ack/status");
  if (input.inboxMentions.length > 0) {
    console.log("");
    console.log("inbox mentions:");
    for (const m of input.inboxMentions) {
      console.log(`- #${m.seq} ${m.from}: ${m.body}`);
    }
  }
  if (input.respondedMentions.length > 0) {
    console.log("");
    console.log("responded mentions:");
    for (const m of input.respondedMentions) {
      console.log(`- #${m.seq} ${m.from} -> #${m.response_seq} evidence=${m.evidence}${m.wake_invoked ? " wake=invoked" : ""}`);
    }
  }
  if (input.wokenMentions.length > 0) {
    console.log("");
    console.log("wake deliveries:");
    for (const m of input.wokenMentions) {
      const status = m.http_status === null ? "" : ` status=${m.http_status}`;
      const error = m.error ? ` error=${m.error}` : "";
      console.log(`- #${m.seq} ${m.adapter} attempt=${m.attempt} result=${m.result}${status}${error}`);
    }
  }
  if (input.statuses.length > 0) {
    console.log("");
    console.log("statuses:");
    for (const s of input.statuses) {
      const bits = [
        s.note,
        s.scope.length > 0 ? `scope=${s.scope.join(",")}` : "",
        s.blocked_reason ? `blocked=${s.blocked_reason}` : "",
        s.summary_seq !== null ? `summary=#${s.summary_seq}` : "",
      ].filter(Boolean);
      console.log(`- #${s.seq} ${s.owner} ${s.state}${bits.length > 0 ? ` — ${bits.join(" · ")}` : ""}`);
    }
  }
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"] });
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, DIGEST_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "since", "limit", "for"]);
  if (flagError !== null) {
    console.error(flagError);
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
  const sinceFlag = str(flags.since);
  const since =
    sinceFlag === undefined || sinceFlag === "last-seen"
      ? loadCursor(channel)
      : parseNonNegativeIntFlag(sinceFlag, "since");
  if (typeof since === "string") {
    console.error(since);
    return 1;
  }
  const sinceSeq = since ?? 0;
  const limit = parsePositiveIntFlag(str(flags.limit), "limit", 1000);
  if (typeof limit === "string") {
    console.error(limit);
    return 1;
  }
  const scanLimit = limit ?? 100;
  const forName = str(flags.for);
  if (forName !== undefined && !isName(forName)) {
    console.error("--for must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }

  try {
    const viewer =
      forName ??
      (await fetchMe(cfg.server, cfg.token)
        .then((me) => me.name)
        .catch(() => null));
    const messages = await fetchMessages(cfg.server, cfg.token, channel, sinceSeq, scanLimit);
    const deliveries = await fetchDigestWakeDeliveries(cfg.server, cfg.token, channel, viewer, sinceSeq, scanLimit);
    const statuses = summarizeStatuses(messages);
    const mentions = summarizeMentions(messages, viewer, latestWakeDeliveries(deliveries));
    const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), sinceSeq);
    const frame = {
      type: "digest",
      channel,
      since: sinceSeq,
      last_seq: lastSeq,
      generated_at: nowTs(),
      viewer,
      counts: {
        messages: messages.length,
        statuses: statuses.length,
        inbox_mentions: mentions.inbox.length,
        responded_mentions: mentions.responded.length,
        wake_invoked: mentions.woken.length,
        resumed: mentions.responded.length,
      },
      statuses,
      inbox_mentions: mentions.inbox,
      responded_mentions: mentions.responded,
      woken_mentions: mentions.woken,
      wake_contract: {
        mentioned: "durable inbox item only",
        wake_invoked: "durable adapter delivery ledger",
        resumed: "requires linked fresh ack/status",
      },
    };
    if (flags.json === true) console.log(JSON.stringify(jsonFrame(frame)));
    else
      printHuman({
        channel,
        since: sinceSeq,
        lastSeq,
        viewer,
        total: messages.length,
        statuses,
        inboxMentions: mentions.inbox,
        respondedMentions: mentions.responded,
        wokenMentions: mentions.woken,
      });
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
