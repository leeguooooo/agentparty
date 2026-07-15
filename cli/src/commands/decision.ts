// party decision — 频道人类决策协议（#284）。
//   ask     agent 上传一个方案/问题，请人类审批或选项回答
//   respond 人类/moderator 在频道内对某条 decision_request 拍板
//   mode    切频道决策模式：approval（人类审批）↔ unattended（无人值守，自动放行）
import { isHelpArg, parseArgs, str, strArray, unknownFlagError, valueFlagError } from "../args";
import { advanceCursorPastOwnMessage, resolveChannel } from "../config";
import { formatMsg } from "../format";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { fetchMessages, handleRestError, postMessage, respondDecision, setDecisionMode } from "../rest";
import type { DecisionMode, MsgFrame } from "@agentparty/shared";
import { isName, isSlug } from "../validation";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  blockRunnerContinuation,
  continuationPath,
  continuationSessionId,
  mergeRunnerContinuation,
  readRunnerContinuation,
  type RunnerContinuationHarness,
  type RunnerContinuationState,
} from "../continuation";

const HELP = `usage:
  party decision ask <prompt|-> [--channel C] [--option opt]... [--body text|-] [--mention name]... [--wait] [--json]
  party decision respond <seq> <approve|reject|N|text> [-m reason] [--channel C] [--json]
  party decision mode approval|unattended [--channel C] [--json]

ask     upload a plan/question for a human to approve/reject or answer 1/2/3.
        With no --option it is an approve/reject request; --option turns it into
        a numbered choice. --wait blocks until a human responds (or unattended
        mode auto-resolves), then prints the chosen option.
respond a human (or moderator) settles a pending decision. Positional choice is
        approve|reject for approval requests, or a 1-based index / option text.
mode    approval keeps requests pending for a human; unattended auto-resolves.

Options:
  --channel C     act in channel C instead of the bound channel
  --option opt    a choice option (repeatable); presence makes it a numbered choice
  --body text|-   plan body (defaults to the prompt); "-" reads stdin
  --mention name  mention on the request; repeatable
  --wait          (ask) block until the decision resolves
  -m, --message   (respond) reject reason / note
  --json          emit frames as json`;

const ASK_FLAGS = ["channel", "option", "body", "mention", "wait", "json"];
const RESPOND_FLAGS = ["channel", "message", "json"];
const MODE_FLAGS = ["channel", "json"];
const WAIT_TIMEOUT_MS = 240_000;
const WAIT_POLL_MS = 2_000;

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

type DecisionContinuationContext =
  | {
      mode: "model-session";
      workId: string;
      continuationRef: string;
      deliveryId: string | null;
      workdir: string;
      harness: RunnerContinuationHarness;
      sessionId: string;
      path: string;
    }
  | {
      mode: "custom-process";
      workId: string;
      continuationRef: string;
      deliveryId: string;
      harness: "custom";
    };

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function runnerSessionFromEnv(
  harness: RunnerContinuationHarness,
  env: NodeJS.ProcessEnv,
): string | null {
  const explicit = nonEmpty(env.AP_RUNNER_SESSION_ID);
  if (explicit !== null) return explicit;
  return harness === "claude"
    ? nonEmpty(env.CLAUDE_SESSION_ID)
    : nonEmpty(env.CODEX_THREAD_ID);
}

/**
 * Built-in model turns park only after their local session mapping is crash-safe. A custom
 * `--on-mention` command has a different, explicitly stateless contract: owner_answer launches the
 * same command as a fresh process with the same delivery/work/ref and a new AP_CONTEXT_FILE. It has
 * no party-managed model session, so only server-authoritative lineage is prepared here.
 */
export function prepareDecisionContinuation(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): DecisionContinuationContext | null {
  const workId = nonEmpty(env.AP_WORK_ID);
  const continuationRef = nonEmpty(env.AP_CONTINUATION_REF);
  if (workId === null && continuationRef === null) return null;
  if (workId === null || continuationRef === null) {
    throw new Error("runner continuation is incomplete: AP_WORK_ID and AP_CONTINUATION_REF must both be set");
  }
  if (workId.length > 128 || continuationRef.length > 512) {
    throw new Error("runner continuation exceeds the server work/ref limits");
  }
  const harnessRaw = nonEmpty(env.AP_RUNNER_HARNESS);
  if (harnessRaw === "custom") {
    const deliveryId = nonEmpty(env.AP_DELIVERY_ID);
    if (deliveryId === null || deliveryId.length > 128) {
      throw new Error("custom runner continuation is missing a valid AP_DELIVERY_ID");
    }
    return {
      mode: "custom-process",
      workId,
      continuationRef,
      deliveryId,
      harness: "custom",
    };
  }
  const workdir = nonEmpty(env.AP_RUNNER_WORKDIR);
  if (workdir === null || !isAbsolute(workdir)) {
    throw new Error("runner continuation is missing an absolute AP_RUNNER_WORKDIR");
  }
  if (harnessRaw !== "codex" && harnessRaw !== "claude" && harnessRaw !== "codex-sdk") {
    throw new Error("runner continuation is missing AP_RUNNER_HARNESS (custom, codex, claude, or codex-sdk)");
  }
  const sessionId = runnerSessionFromEnv(harnessRaw, env);
  if (sessionId === null) {
    const expected = harnessRaw === "claude" ? "CLAUDE_SESSION_ID" : "CODEX_THREAD_ID";
    throw new Error(
      `runner continuation has no live session id; expected AP_RUNNER_SESSION_ID or ${expected}`,
    );
  }

  const path = continuationPath(workdir, continuationRef);
  const existing = readRunnerContinuation(path);
  if (existing === null && existsSync(path)) {
    throw new Error(`runner continuation mapping is invalid: ${path}`);
  }
  if (existing !== null) {
    if (
      existing.harness !== harnessRaw ||
      existing.work_id !== workId ||
      existing.continuation_ref !== continuationRef ||
      continuationSessionId(existing) !== sessionId
    ) {
      throw new Error("runner continuation mapping conflicts with the current work/session; refusing to park");
    }
    if (typeof existing.resume_blocked_reason === "string" && existing.resume_blocked_reason.length > 0) {
      throw new Error(`runner continuation resume is blocked: ${existing.resume_blocked_reason}`);
    }
  }

  const state: RunnerContinuationState = existing ?? {
    harness: harnessRaw,
    ...(harnessRaw === "codex-sdk" ? { thread_id: sessionId } : { session_id: sessionId }),
    created_at: now,
    last_wake_ts: now,
    wakes: 0,
  };
  const committed = mergeRunnerContinuation(path, {
    ...state,
    workdir,
    work_id: workId,
    continuation_ref: continuationRef,
  });
  if (typeof committed.resume_blocked_reason === "string" && committed.resume_blocked_reason.length > 0) {
    throw new Error(`runner continuation resume is blocked: ${committed.resume_blocked_reason}`);
  }
  return {
    mode: "model-session",
    workId,
    continuationRef,
    deliveryId: nonEmpty(env.AP_DELIVERY_ID),
    workdir,
    harness: harnessRaw,
    sessionId,
    path,
  };
}

function resolveSlug(flags: Flags): string | null {
  const channel = resolveChannel(str(flags.channel));
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return null;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return null;
  }
  return channel;
}

async function readPrompt(positional: string | undefined): Promise<string | null> {
  if (positional === undefined) return null;
  if (positional === "-") return (await Bun.stdin.text()).trim();
  return positional;
}

async function runAsk(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { booleans: ["wait", "json"], repeatable: ["option", "mention"] });
  const unknown = unknownFlagError(flags, ASK_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "body"], ["option", "mention"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const prompt = await readPrompt(positionals[0]);
  if (!prompt) {
    console.error("usage: party decision ask <prompt|-> [--option opt]...");
    return 1;
  }
  const options = strArray(flags.option) ?? [];
  const mentions = strArray(flags.mention) ?? [];
  if (mentions.some((m) => !isName(m))) {
    console.error("--mention must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  const bodyFlag = str(flags.body);
  const body = bodyFlag === "-" ? (await Bun.stdin.text()).trim() : (bodyFlag ?? prompt);
  const channel = resolveSlug(flags);
  if (!channel) return 1;
  const auth = await resolveAuth();
  if (!auth) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const decisionRequest =
    options.length > 0 ? { kind: "choice" as const, prompt, options } : { kind: "approval" as const, prompt };
  let continuation: DecisionContinuationContext | null;
  try {
    // This is deliberately the last local step before POST. Once the Worker parks the delivery,
    // a process crash must still leave enough durable state for the future owner_answer wake.
    continuation = prepareDecisionContinuation();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`decision ask refused before POST: ${reason}`);
    return 1;
  }
  try {
    const posted = await postMessage(auth.server, auth.token, channel, {
      kind: "message",
      body,
      mentions,
      reply_to: null,
      decision_request: decisionRequest,
    });
    const { seq } = posted;
    advanceCursorPastOwnMessage(channel, seq);
    const boundRequest = posted.decision_request as
      | (NonNullable<typeof posted.decision_request> & { work_id?: string; continuation_ref?: string })
      | undefined;
    if (continuation !== null) {
      const authoritativeWorkId = boundRequest?.work_id;
      const authoritativeRef = boundRequest?.continuation_ref;
      const authoritativeDeliveryId = boundRequest?.delivery_id;
      if (
        authoritativeWorkId !== continuation.workId ||
        authoritativeRef !== continuation.continuationRef ||
        (continuation.deliveryId !== null && authoritativeDeliveryId !== continuation.deliveryId)
      ) {
        const reason =
          "server did not confirm the active runner continuation lineage " +
          `(expected work=${continuation.workId} ref=${continuation.continuationRef} delivery=${continuation.deliveryId ?? "unchecked"}; ` +
          `received work=${authoritativeWorkId ?? "missing"} ref=${authoritativeRef ?? "missing"} delivery=${authoritativeDeliveryId ?? "missing"})`;
        if (continuation.mode === "model-session") {
          blockRunnerContinuation(continuation.path, reason);
          console.error(`decision ask posted but continuation resume is blocked: ${reason}`);
        } else {
          console.error(`decision ask posted but custom-process continuation was not confirmed: ${reason}`);
        }
        return 1;
      }
    }
    const boundWork = typeof boundRequest?.work_id === "string" && boundRequest.work_id.length > 0;
    const immediate = posted.decision_resolution;
    if (immediate?.state === "auto_resolved") {
      if (flags.json === true) {
        console.log(JSON.stringify({ seq, decision_request: boundRequest, decision_resolution: immediate }));
      } else {
        console.log(`decision #${seq} auto_resolved → ${immediate.chosen_option ?? "?"}`);
      }
      return 0;
    }
    // A serve-owned work must never park its single runner in the CLI poll loop. The Worker has
    // durably moved it to waiting_owner and released the next delivery; owner resolution will create
    // a new owner_answer delivery for the same work/continuation.
    if (boundWork && immediate?.state === "pending") {
      if (flags.json === true) {
        console.log(JSON.stringify({ seq, state: "waiting_owner", decision_request: boundRequest, decision_resolution: immediate }));
      } else {
        console.log(`WAITING_OWNER decision #${seq} work=${boundRequest!.work_id}`);
      }
      return 0;
    }
    if (flags.wait !== true) {
      if (flags.json === true) console.log(JSON.stringify({ seq }));
      else console.log(`decision #${seq} posted — waiting for a human (party decision respond ${seq} ...)`);
      return 0;
    }
    const resolved = await waitForResolution(auth.server, auth.token, channel, seq);
    if (!resolved) {
      console.error(`TIMEOUT waiting for decision #${seq}`);
      return 2;
    }
    if (flags.json === true) {
      console.log(JSON.stringify(jsonFrame(resolved as unknown as Record<string, unknown>)));
    } else {
      const res = resolved.decision_resolution;
      console.log(`decision #${seq} ${res?.state ?? "resolved"} → ${res?.chosen_option ?? "?"}${res?.reason ? `: ${res.reason}` : ""}`);
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}

async function waitForResolution(server: string, token: string, slug: string, seq: number): Promise<MsgFrame | null> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const messages = await fetchMessages(server, token, slug, seq - 1, 100);
    const request = messages.find((m) => m.seq === seq);
    const state = request?.decision_resolution?.state;
    if (state !== undefined && state !== "pending") return request ?? null;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

async function runRespond(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"], aliases: { m: "message" } });
  const unknown = unknownFlagError(flags, RESPOND_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "message"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const seqArg = positionals[0];
  if (seqArg === undefined || !/^[1-9]\d*$/.test(seqArg)) {
    console.error("seq must be a positive integer");
    return 1;
  }
  const choice = positionals[1];
  if (choice === undefined) {
    console.error("usage: party decision respond <seq> <approve|reject|N|text> [-m reason]");
    return 1;
  }
  const reason = str(flags.message)?.trim();
  let payload: { action?: "approve" | "reject"; option?: number | string; reason?: string };
  if (choice === "approve") {
    payload = { action: "approve" };
  } else if (choice === "reject") {
    payload = { action: "reject", ...(reason ? { reason } : {}) };
  } else if (/^[1-9]\d*$/.test(choice)) {
    // 人类友好的 1 基下标 → 服务端 0 基
    payload = { option: Number(choice) - 1, ...(reason ? { reason } : {}) };
  } else {
    payload = { option: choice, ...(reason ? { reason } : {}) };
  }
  const channel = resolveSlug(flags);
  if (!channel) return 1;
  const auth = await resolveAuth();
  if (!auth) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  try {
    const result = await respondDecision(auth.server, auth.token, channel, Number(seqArg), payload);
    advanceCursorPastOwnMessage(channel, result.reply.seq);
    if (flags.json === true) {
      console.log(JSON.stringify(jsonFrame(result.message as unknown as Record<string, unknown>)));
    } else {
      const res = result.message.decision_resolution;
      console.log(`decision #${seqArg} → ${res?.chosen_option ?? "?"}`);
      console.log(formatMsg(result.reply));
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}

async function runMode(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"] });
  const unknown = unknownFlagError(flags, MODE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const mode = positionals[0];
  if (mode !== "approval" && mode !== "unattended") {
    console.error("usage: party decision mode approval|unattended");
    return 1;
  }
  const channel = resolveSlug(flags);
  if (!channel) return 1;
  const auth = await resolveAuth();
  if (!auth) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  try {
    const result = await setDecisionMode(auth.server, auth.token, channel, mode as DecisionMode);
    if (flags.json === true) console.log(JSON.stringify(result));
    else console.log(`decision mode: ${result.mode}`);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "ask":
      return runAsk(rest);
    case "respond":
      return runRespond(rest);
    case "mode":
      return runMode(rest);
    default:
      console.error("usage: party decision ask|respond|mode ...");
      console.log(HELP);
      return 1;
  }
}
