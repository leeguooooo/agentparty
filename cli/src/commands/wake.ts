// party wake test — prove mention/wake/resume as separate phases.
import { autoWakeReachable, EXIT_TIMEOUT, type MsgFrame, type PresenceEntry, type WakeDelivery } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig, resolveChannel } from "../config";
import { jsonFrame, nowTs } from "../json";
import { resolveAuth } from "../oidc-cli";
import { RestError, fetchMessages, fetchPresence, fetchWakeDeliveries, handleRestError, postMessage } from "../rest";
import { MAX_TIMEOUT_SEC, isName, isSlug, parsePositiveIntFlag } from "../validation";

const WAKE_FLAGS = ["channel", "timeout", "json"];
const DEFAULT_TIMEOUT_SEC = 30;
const STALE_MS = 60_000; // keep serve/watch wakeability aligned with `party who` and mention receipts
const HELP = `usage: party wake test @agent [channel|--channel C] [--timeout N] [--json]

Run a wake contract test. This separates mention delivery, wake adapter delivery,
and linked agent resume. Only a fresh reply/status linked to the test mention
counts as resumed.

A target that advertises no wake adapter is still probed empirically (the mention is
delivered and the reply/timeout is conclusive), because "no adapter" is not proof of
"unreachable" — the harness may be polling. Targeting your own identity fails fast
without sending a probe (serve/watch ignore self-messages).

Options:
  --channel C    test in channel C instead of the bound channel
  --timeout N    seconds to wait for linked ack/status (default: 30)
  --json         emit one structured wake_test frame`;

type WakeResult = "not_auto_wakeable" | "healthy" | "timeout" | "self_target";
type AckEvidence = "reply_to" | "status.summary_seq";

interface WakePresence {
  state: string | null;
  residency: string | null;
  wake_kind: string | null;
  wake_verified_at: number | null;
  last_seen: number | null;
}

interface WakeTestFrame extends Record<string, unknown> {
  type: "wake_test";
  channel: string;
  target: string;
  result: WakeResult;
  generated_at: number;
  timeout_sec: number;
  presence: WakePresence;
  phases: {
    mention_delivered: { ok: boolean; seq: number | null; evidence: string };
    wake_invoked: { ok: boolean | null; adapter: string | null; evidence: string };
    agent_resumed: { ok: boolean; seq: number | null; evidence: AckEvidence | null };
  };
  reason: string | null;
}

function normalizeTarget(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

function summarizePresence(p: PresenceEntry | null): WakePresence {
  return {
    state: p?.state ?? null,
    residency: p?.residency ?? null,
    wake_kind: p?.wake?.kind ?? null,
    wake_verified_at: p?.wake?.verified_at ?? null,
    last_seen: p?.last_seen ?? p?.ts ?? null,
  };
}

// wake test 的探针闸门（issue #181）。把「送不送探针」和「heartbeat 怎么判」拆开：
//  - block !== null  → 不发探针，直接结论 not_auto_wakeable（沿用旧语义 + 现有测试）。
//    仅在「探针无处可去」时 block：没 presence（不在频道）、human_driven（只进收件箱）、
//    声明了适配器却无心跳、或适配器陈旧（serve/watch 的常驻 supervisor 已死，#47/#97）。
//  - advisory !== null → 仍发探针，但 heartbeat 视角是负面的（没声明任何适配器）。#181 的实锤：
//    没声明适配器 ≠ 不可达——agent 可能在轮询或人盯着，是 wake 模型没表达的模式。此时从
//    self-reported 元数据下「不可达」结论是不可证伪的，必须发探针、按「观测到的答复」定论。
//  - 两者皆 null → 声明了新鲜适配器，正常发探针。
function wakeProbeGate(p: PresenceEntry | null, now: number): { block: string | null; advisory: string | null } {
  if (p === null) return { block: "no presence for target", advisory: null };
  if (p.residency === "human_driven") return { block: "target is human-driven; mention is inbox only", advisory: null };
  if (p.wake === undefined || p.wake.kind === "none") {
    const advisory =
      p.residency === "bare"
        ? "target has bare residency and advertises no wake adapter"
        : "target advertises no wake adapter";
    return { block: null, advisory };
  }
  const seen = p.last_seen ?? p.ts ?? null;
  if (seen === null) return { block: "target wake adapter has no last_seen heartbeat", advisory: null };
  if (!autoWakeReachable(p, now, STALE_MS)) {
    return { block: `target ${p.wake.kind} wake adapter is stale; last seen ${Math.max(0, now - seen)}ms ago`, advisory: null };
  }
  return { block: null, advisory: null };
}

function ackEvidence(mentionSeq: number, candidate: MsgFrame): AckEvidence | null {
  if (candidate.reply_to === mentionSeq) return "reply_to";
  if (candidate.status?.summary_seq === mentionSeq) return "status.summary_seq";
  return null;
}

function findLinkedAck(messages: MsgFrame[], target: string, mentionSeq: number): { seq: number; evidence: AckEvidence } | null {
  for (const m of messages) {
    if (m.seq <= mentionSeq || m.sender.name !== target) continue;
    const evidence = ackEvidence(mentionSeq, m);
    if (evidence !== null) return { seq: m.seq, evidence };
  }
  return null;
}

function ackFromWakeDelivery(delivery: WakeDelivery | null): { seq: number; evidence: AckEvidence } | null {
  if (delivery === null) return null;
  if (delivery.ack_seq !== null) return { seq: delivery.ack_seq, evidence: "reply_to" };
  if (delivery.resume_seq !== null) return { seq: delivery.resume_seq, evidence: "status.summary_seq" };
  return null;
}

function summarizeWakeDelivery(delivery: WakeDelivery | null, adapter: string | null): { ok: boolean | null; adapter: string | null; evidence: string } {
  if (delivery === null) {
    return {
      ok: null,
      adapter,
      evidence: "adapter delivery is not audited by the worker yet; only linked resume is conclusive",
    };
  }
  if (delivery.result === "ok") {
    const status = delivery.http_status === null ? "" : ` status=${delivery.http_status}`;
    return {
      ok: true,
      adapter,
      evidence: `webhook delivery attempt ${delivery.attempt}${status} for mention #${delivery.mention_seq}`,
    };
  }
  const status = delivery.http_status === null ? "" : ` status=${delivery.http_status}`;
  const error = delivery.error ? ` error=${delivery.error}` : "";
  return {
    ok: false,
    adapter,
    evidence: `webhook delivery attempt ${delivery.attempt} failed${status}${error} for mention #${delivery.mention_seq}`,
  };
}

async function fetchLatestWebhookDelivery(
  server: string,
  token: string,
  channel: string,
  target: string,
  mentionSeq: number,
): Promise<WakeDelivery | null> {
  try {
    const deliveries = await fetchWakeDeliveries(server, token, channel, { since: mentionSeq, target, limit: 20 });
    return deliveries
      .filter((d) => d.mention_seq === mentionSeq && d.adapter_kind === "webhook")
      .at(-1) ?? null;
  } catch (e) {
    if (e instanceof RestError && (e.status === 404 || e.status === 501)) return null;
    throw e;
  }
}

function printHuman(frame: WakeTestFrame) {
  console.log(`wake test ${frame.channel} @${frame.target}: ${frame.result}`);
  if (frame.reason) console.log(`reason: ${frame.reason}`);
  const presenceBits = [
    frame.presence.state ? `state=${frame.presence.state}` : null,
    frame.presence.residency ? `residency=${frame.presence.residency}` : null,
    frame.presence.wake_kind ? `wake=${frame.presence.wake_kind}` : null,
  ].filter((bit): bit is string => bit !== null);
  if (presenceBits.length > 0) console.log(`presence: ${presenceBits.join(" ")}`);
  console.log(
    `mention: ${frame.phases.mention_delivered.ok ? `delivered #${frame.phases.mention_delivered.seq}` : "not sent"}`,
  );
  console.log(`wake invoked: ${frame.phases.wake_invoked.ok === null ? "not audited" : frame.phases.wake_invoked.ok ? "yes" : "no"}`);
  console.log(
    `resumed: ${
      frame.phases.agent_resumed.ok
        ? `yes #${frame.phases.agent_resumed.seq} evidence=${frame.phases.agent_resumed.evidence}`
        : "no"
    }`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const parsed = parseArgs(argv, { booleans: ["json"] });
  const [subcmd, targetArg, channelArg, ...extra] = parsed.positionals;
  if (subcmd !== "test" || extra.length > 0) {
    console.error("usage: party wake test @agent [channel|--channel C] [--timeout N] [--json]");
    return 1;
  }
  const { flags } = parsed;
  const unknown = unknownFlagError(flags, WAKE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "timeout"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const target = normalizeTarget(targetArg);
  if (target === null || !isName(target)) {
    console.error("target must be a valid name, e.g. @agent");
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? channelArg);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const timeout = parsePositiveIntFlag(str(flags.timeout), "timeout", MAX_TIMEOUT_SEC);
  if (typeof timeout === "string") {
    console.error(timeout);
    return 1;
  }
  const timeoutSec = timeout ?? DEFAULT_TIMEOUT_SEC;
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }

  // #194: 目标解析为自己身份时立刻失败——serve/watch 按设计忽略发送者自己的消息，
  // 自测必然 resumed:no。这个条件用本地缓存身份即可在发探针前判定，不必真往频道发一条
  // mention（白烧 loop-guard 名额），更不必空等满 --timeout（把「误用」伪装成「agent 死了」）。
  // 仅凭本地缓存身份判定（零网络请求）；身份未缓存时优雅降级到旧路径（发探针→timeout）。
  const selfName = readConfig()?.identity?.name ?? null;
  if (selfName !== null && selfName === target) {
    const reason =
      `wake test: @${target} is your own identity; serve/watch ignore self-messages. ` +
      "Ask another identity to run this test.";
    if (flags.json === true) {
      const frame: WakeTestFrame = {
        type: "wake_test",
        channel,
        target,
        result: "self_target",
        generated_at: nowTs(),
        timeout_sec: timeoutSec,
        presence: summarizePresence(null),
        phases: {
          mention_delivered: { ok: false, seq: null, evidence: "not sent because target is the caller's own identity" },
          wake_invoked: { ok: false, adapter: null, evidence: reason },
          agent_resumed: { ok: false, seq: null, evidence: null },
        },
        reason,
      };
      console.log(JSON.stringify(jsonFrame(frame)));
    } else {
      console.error(reason);
    }
    return 1;
  }

  try {
    const presenceList = await fetchPresence(cfg.server, cfg.token, channel);
    const presence = presenceList.find((p) => p.name === target) ?? null;
    const generatedAt = nowTs();
    const gate = wakeProbeGate(presence, generatedAt);
    const adapter = presence?.wake?.kind ?? null;
    if (gate.block !== null) {
      const frame: WakeTestFrame = {
        type: "wake_test",
        channel,
        target,
        result: "not_auto_wakeable",
        generated_at: generatedAt,
        timeout_sec: timeoutSec,
        presence: summarizePresence(presence),
        phases: {
          mention_delivered: { ok: false, seq: null, evidence: "not sent because target is not auto-wakeable" },
          wake_invoked: { ok: false, adapter, evidence: gate.block },
          agent_resumed: { ok: false, seq: null, evidence: null },
        },
        reason: gate.block,
      };
      if (flags.json === true) console.log(JSON.stringify(jsonFrame(frame)));
      else printHuman(frame);
      return EXIT_TIMEOUT;
    }

    const { seq } = await postMessage(cfg.server, cfg.token, channel, {
      kind: "message",
      body: `@${target} wake test: please reply to this message or post a status linked with summary_seq`,
      mentions: [target],
      reply_to: null,
    });
    const deadline = Date.now() + timeoutSec * 1000;
    let ack: { seq: number; evidence: AckEvidence } | null = null;
    let wakeDelivery: WakeDelivery | null = null;
    do {
      if (adapter === "webhook") {
        wakeDelivery = await fetchLatestWebhookDelivery(cfg.server, cfg.token, channel, target, seq);
        ack = ackFromWakeDelivery(wakeDelivery);
        if (ack !== null) break;
      }
      ack = findLinkedAck(await fetchMessages(cfg.server, cfg.token, channel, seq, 100), target, seq);
      if (ack !== null) break;
      await sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
    } while (Date.now() < deadline);
    if (adapter === "webhook" && wakeDelivery === null) {
      wakeDelivery = await fetchLatestWebhookDelivery(cfg.server, cfg.token, channel, target, seq);
    }

    // serve/watch are local supervisors reading the channel stream; they filter out the
    // sender's own messages to avoid self-trigger loops. So a self-test (mentioning your own
    // agent) always times out even when the supervisor is healthy — spell that out so the next
    // person doesn't burn a debugging session on it (as happened with serve+bare self-tests).
    const selfTestProne = adapter === "serve" || adapter === "watch";
    const timeoutReason = selfTestProne
      ? "timed out waiting for linked reply_to/status.summary_seq (serve/watch ignore the sender's own messages — if @" +
        target +
        " is your own identity, retry from a different one)"
      : "timed out waiting for linked reply_to/status.summary_seq";
    // #181: 探针已投递，按观测定论。收到 ack → healthy（哪怕它没声明任何 wake 适配器，
    // 只要它真的答复了就是可达的）。没 ack 时，若 heartbeat 视角本就负面（没声明适配器），
    // 结论仍是 not_auto_wakeable 但标注「探针已投递、未答复、未确认」——把 heartbeat 判定
    // 和投递判定摊开，而不是当初那句不可证伪的 mention: not sent。
    const result: WakeResult = ack !== null ? "healthy" : gate.advisory !== null ? "not_auto_wakeable" : "timeout";
    const frameReason =
      ack !== null
        ? null
        : gate.advisory !== null
          ? `${gate.advisory} (unconfirmed — probe delivered #${seq}, no reply within ${timeoutSec}s)`
          : timeoutReason;
    const wakeInvoked =
      gate.advisory !== null && wakeDelivery === null
        ? { ok: false as const, adapter, evidence: gate.advisory }
        : summarizeWakeDelivery(wakeDelivery, adapter);
    const frame: WakeTestFrame = {
      type: "wake_test",
      channel,
      target,
      result,
      generated_at: nowTs(),
      timeout_sec: timeoutSec,
      presence: summarizePresence(presence),
      phases: {
        mention_delivered: { ok: true, seq, evidence: "message accepted by channel history" },
        wake_invoked: wakeInvoked,
        agent_resumed: { ok: ack !== null, seq: ack?.seq ?? null, evidence: ack?.evidence ?? null },
      },
      reason: frameReason,
    };
    if (flags.json === true) console.log(JSON.stringify(jsonFrame(frame)));
    else printHuman(frame);
    return ack === null ? EXIT_TIMEOUT : 0;
  } catch (e) {
    return handleRestError(e);
  }
}
