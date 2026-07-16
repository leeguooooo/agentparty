#!/usr/bin/env bun

// Deterministic live runner for the #543 reachability closeout smoke.
//
// It deliberately knows nothing about tokens, servers, or fixed channels. `party serve`
// supplies the authoritative AP_* delivery context, and every channel operation goes
// through the released `party` executable resolved from PATH.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const ISSUE_543_TIMEOUT_MS = 5 * 60_000;

const TIMEOUT_MARKER = "QA543-TIMEOUT";
const UNATTENDED_MARKER = "QA543-UNATTENDED";
const OWNER_MARKER = "QA543-OWNER-ASK";
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface ContextDelivery {
  id: string;
  work_id: string | null;
  continuation_ref: string | null;
  cause: string;
  attempt: number;
}

interface ContextDecisionResponse {
  request_seq: number;
  chosen_index: number;
  chosen_option: string;
  prompt?: string;
  delivery_id?: string;
  origin_seq?: number;
  origin_channel?: string;
  work_id?: string;
  continuation_ref?: string;
}

interface WakeContext {
  channel: string;
  seq: number;
  body: string;
  self: string;
  delivery: ContextDelivery | null;
  decision_response: ContextDecisionResponse | null;
}

export interface PartyCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Issue543RunnerDeps {
  env?: NodeJS.ProcessEnv;
  runParty?: (args: string[]) => Promise<PartyCommandResult>;
  sleep?: (ms: number) => Promise<void>;
}

export type Issue543RunnerOutcome =
  | { kind: "linked_reply"; triggerSeq: number; node: string }
  | { kind: "unattended_reply"; triggerSeq: number; decisionSeq: number; node: string }
  | { kind: "waiting_owner"; triggerSeq: number; decisionSeq: number; node: string }
  | { kind: "owner_resumed"; triggerSeq: number; originSeq: number; node: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function parseDelivery(value: unknown): ContextDelivery | null {
  if (value === null || value === undefined) return null;
  const raw = recordOf(value);
  if (raw === null) throw new Error("context.delivery must be an object or null");
  const workId = raw.work_id;
  const continuationRef = raw.continuation_ref;
  if (workId !== null && typeof workId !== "string") throw new Error("context.delivery.work_id is invalid");
  if (continuationRef !== null && typeof continuationRef !== "string") {
    throw new Error("context.delivery.continuation_ref is invalid");
  }
  return {
    id: requiredString(raw.id, "context.delivery.id"),
    work_id: workId as string | null,
    continuation_ref: continuationRef as string | null,
    cause: requiredString(raw.cause, "context.delivery.cause"),
    attempt: positiveInteger(raw.attempt, "context.delivery.attempt"),
  };
}

function parseDecisionResponse(value: unknown): ContextDecisionResponse | null {
  if (value === null || value === undefined) return null;
  const raw = recordOf(value);
  if (raw === null) throw new Error("context.decision_response must be an object or null");
  const chosenIndex = raw.chosen_index;
  if (!Number.isInteger(chosenIndex) || Number(chosenIndex) < 0) {
    throw new Error("context.decision_response.chosen_index must be a non-negative integer");
  }
  return {
    request_seq: positiveInteger(raw.request_seq, "context.decision_response.request_seq"),
    chosen_index: Number(chosenIndex),
    chosen_option: requiredString(raw.chosen_option, "context.decision_response.chosen_option"),
    prompt: optionalString(raw.prompt, "context.decision_response.prompt"),
    delivery_id: optionalString(raw.delivery_id, "context.decision_response.delivery_id"),
    origin_seq: raw.origin_seq === undefined
      ? undefined
      : positiveInteger(raw.origin_seq, "context.decision_response.origin_seq"),
    origin_channel: optionalString(raw.origin_channel, "context.decision_response.origin_channel"),
    work_id: optionalString(raw.work_id, "context.decision_response.work_id"),
    continuation_ref: optionalString(raw.continuation_ref, "context.decision_response.continuation_ref"),
  };
}

function readWakeContext(path: string): WakeContext {
  if (!isAbsolute(path)) throw new Error("AP_CONTEXT_FILE must be an absolute path");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`AP_CONTEXT_FILE is unreadable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = recordOf(parsed);
  if (raw === null) throw new Error("AP_CONTEXT_FILE must contain a JSON object");
  return {
    channel: requiredString(raw.channel, "context.channel"),
    seq: positiveInteger(raw.seq, "context.seq"),
    body: requiredString(raw.body, "context.body"),
    self: requiredString(raw.self, "context.self"),
    delivery: parseDelivery(raw.delivery),
    decision_response: parseDecisionResponse(raw.decision_response),
  };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  return requiredString(env[name], name);
}

function parseEnvSeq(env: NodeJS.ProcessEnv): number {
  const raw = envValue(env, "AP_SEQ");
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("AP_SEQ must be a positive integer");
  return Number(raw);
}

function ownerPrompt(originSeq: number): string {
  return `QA543 owner approval for trigger seq ${originSeq}`;
}

function assertContextEnvelope(context: WakeContext, env: NodeJS.ProcessEnv): { channel: string; node: string } {
  const channel = envValue(env, "AP_CHANNEL");
  const self = envValue(env, "AP_SELF");
  const seq = parseEnvSeq(env);
  // Optional non-secret label distinguishes two released binaries serving the same agent during
  // the rolling-upgrade lease smoke. Normal runs fall back to the authoritative agent name.
  const node = env.QA543_NODE ?? self;
  if (!NODE_RE.test(node)) throw new Error("QA543_NODE/AP_SELF must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  if (context.channel !== channel) throw new Error("context.channel does not match AP_CHANNEL");
  if (context.seq !== seq) throw new Error("context.seq does not match AP_SEQ");
  if (context.self !== self) throw new Error("context.self does not match AP_SELF");
  return { channel, node };
}

function assertCurrentDeliveryLineage(context: WakeContext, env: NodeJS.ProcessEnv): ContextDelivery {
  const delivery = context.delivery;
  if (delivery === null) throw new Error("directed delivery context is required for decision smoke");
  const deliveryId = envValue(env, "AP_DELIVERY_ID");
  const workId = envValue(env, "AP_WORK_ID");
  const continuationRef = envValue(env, "AP_CONTINUATION_REF");
  if (delivery.id !== deliveryId) throw new Error("context delivery id does not match AP_DELIVERY_ID");
  if (delivery.work_id !== workId) throw new Error("context work id does not match AP_WORK_ID");
  if (delivery.continuation_ref !== continuationRef) {
    throw new Error("context continuation does not match AP_CONTINUATION_REF");
  }
  return delivery;
}

function smokeDelivery(
  context: WakeContext,
  env: NodeJS.ProcessEnv,
  alwaysRequired = false,
): ContextDelivery | null {
  const setting = env.QA543_REQUIRE_DIRECTED;
  if (setting !== undefined && setting !== "0" && setting !== "1") {
    throw new Error("QA543_REQUIRE_DIRECTED must be 0 or 1");
  }
  if (alwaysRequired || setting === "1" || context.delivery !== null) {
    return assertCurrentDeliveryLineage(context, env);
  }
  return null;
}

function deliveryEvidence(delivery: ContextDelivery | null): string {
  if (delivery === null) return "";
  return ` delivery=${delivery.id.slice(0, 12)} attempt=${delivery.attempt}`;
}

function assertOwnerAnswerLineage(context: WakeContext, env: NodeJS.ProcessEnv): ContextDecisionResponse {
  const delivery = assertCurrentDeliveryLineage(context, env);
  if (delivery.cause !== "owner_answer") throw new Error("owner response delivery cause must be owner_answer");
  const response = context.decision_response;
  if (response === null) throw new Error("owner_answer delivery is missing decision_response");
  if (response.origin_channel !== context.channel) throw new Error("owner response origin_channel is not this channel");
  const originSeq = positiveInteger(response.origin_seq, "context.decision_response.origin_seq");
  if (response.prompt !== ownerPrompt(originSeq)) throw new Error("owner response prompt does not match this smoke work");
  if (response.work_id !== delivery.work_id) throw new Error("owner response work id does not match current work");
  if (response.continuation_ref !== delivery.continuation_ref) {
    throw new Error("owner response continuation does not match current continuation");
  }
  const originDeliveryId = requiredString(
    response.delivery_id,
    "context.decision_response.delivery_id",
  );
  if (originDeliveryId === delivery.id) {
    throw new Error("owner response origin delivery must differ from the owner_answer delivery");
  }
  if (response.chosen_option !== "continue" && response.chosen_option !== "stop") {
    throw new Error("owner response chose an option outside the smoke request");
  }
  const expectedIndex = response.chosen_option === "continue" ? 0 : 1;
  if (response.chosen_index !== expectedIndex) {
    throw new Error("owner response chosen_index does not match chosen_option");
  }
  return response;
}

function markerIn(body: string): "timeout" | "unattended" | "owner" | "ordinary" {
  const markers = [
    body.includes(TIMEOUT_MARKER) ? "timeout" as const : null,
    body.includes(UNATTENDED_MARKER) ? "unattended" as const : null,
    body.includes(OWNER_MARKER) ? "owner" as const : null,
  ].filter((value): value is "timeout" | "unattended" | "owner" => value !== null);
  if (markers.length > 1) throw new Error("wake body contains multiple QA543 control markers");
  return markers[0] ?? "ordinary";
}

export async function runPartyFromPath(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<PartyCommandResult> {
  const child = (() => {
    try {
      return Bun.spawn(["party", ...args], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw new Error(`failed to start party from PATH: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function checkedParty(
  runParty: (args: string[]) => Promise<PartyCommandResult>,
  args: string[],
  label: string,
): Promise<PartyCommandResult> {
  const result = await runParty(args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

function parseDecisionOutput(result: PartyCommandResult, label: string): Record<string, unknown> {
  const output = result.stdout.trim();
  try {
    const parsed = JSON.parse(output);
    const record = recordOf(parsed);
    if (record === null) throw new Error("not an object");
    return record;
  } catch (error) {
    throw new Error(`${label} did not return one JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decisionSeq(output: Record<string, unknown>, label: string): number {
  return positiveInteger(output.seq, `${label}.seq`);
}

async function sendLinkedReply(
  runParty: (args: string[]) => Promise<PartyCommandResult>,
  channel: string,
  replyTo: number,
  body: string,
): Promise<void> {
  await checkedParty(
    runParty,
    ["send", body, "--channel", channel, "--reply-to", String(replyTo), "--no-reach"],
    "party send",
  );
}

export async function executeIssue543LiveRunner(
  deps: Issue543RunnerDeps = {},
): Promise<Issue543RunnerOutcome> {
  const env = deps.env ?? process.env;
  const contextPath = envValue(env, "AP_CONTEXT_FILE");
  const context = readWakeContext(contextPath);
  const { channel, node } = assertContextEnvelope(context, env);
  const runParty = deps.runParty ?? ((args: string[]) => runPartyFromPath(args, env));
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

  if (context.decision_response !== null) {
    const response = assertOwnerAnswerLineage(context, env);
    const delivery = context.delivery!;
    const originSeq = positiveInteger(response.origin_seq, "context.decision_response.origin_seq");
    await sendLinkedReply(
      runParty,
      channel,
      context.seq,
      `QA543-OWNER-RESUMED QA543_NODE=${node} origin_seq=${originSeq} answer=${response.chosen_option}`
        + ` origin_delivery=${response.delivery_id!.slice(0, 12)}${deliveryEvidence(delivery)}`,
    );
    return { kind: "owner_resumed", triggerSeq: context.seq, originSeq, node };
  }

  const marker = markerIn(context.body);
  if (marker === "timeout") {
    smokeDelivery(context, env);
    await sleep(ISSUE_543_TIMEOUT_MS);
    throw new Error(`QA543 timeout marker survived ${ISSUE_543_TIMEOUT_MS}ms; outer runner timeout did not fire`);
  }

  if (marker === "unattended") {
    const delivery = smokeDelivery(context, env, true)!;
    if (delivery.cause === "owner_answer") throw new Error("unattended request cannot start from owner_answer");
    const decision = parseDecisionOutput(
      await checkedParty(
        runParty,
        [
          "decision", "ask", `QA543 unattended choice for trigger seq ${context.seq}`,
          "--option", "proceed", "--option", "stop",
          "--channel", channel, "--json",
        ],
        "party decision ask (unattended)",
      ),
      "unattended decision",
    );
    const resolution = recordOf(decision.decision_resolution);
    if (
      resolution?.state !== "auto_resolved"
      || resolution.chosen_index !== 0
      || resolution.chosen_option !== "proceed"
    ) {
      throw new Error("unattended decision was not auto_resolved to the first option");
    }
    const seq = decisionSeq(decision, "unattended decision");
    await sendLinkedReply(
      runParty,
      channel,
      context.seq,
      `QA543-UNATTENDED-REPLY QA543_NODE=${node} trigger_seq=${context.seq} decision_seq=${seq}`
        + deliveryEvidence(delivery),
    );
    return { kind: "unattended_reply", triggerSeq: context.seq, decisionSeq: seq, node };
  }

  if (marker === "owner") {
    const delivery = smokeDelivery(context, env, true)!;
    if (delivery.cause === "owner_answer") throw new Error("owner request cannot start from owner_answer");
    const decision = parseDecisionOutput(
      await checkedParty(
        runParty,
        [
          "decision", "ask", ownerPrompt(context.seq),
          "--option", "continue", "--option", "stop",
          "--channel", channel, "--json",
        ],
        "party decision ask (owner)",
      ),
      "owner decision",
    );
    if (decision.state !== "waiting_owner") throw new Error("owner decision did not park as waiting_owner");
    const resolution = recordOf(decision.decision_resolution);
    if (resolution?.state !== "pending") throw new Error("owner decision is not pending");
    const seq = decisionSeq(decision, "owner decision");
    return { kind: "waiting_owner", triggerSeq: context.seq, decisionSeq: seq, node };
  }

  const delivery = smokeDelivery(context, env);
  await sendLinkedReply(
    runParty,
    channel,
    context.seq,
    `QA543-LINKED-REPLY QA543_NODE=${node} trigger_seq=${context.seq}${deliveryEvidence(delivery)}`,
  );
  return { kind: "linked_reply", triggerSeq: context.seq, node };
}

// Strip C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F) control characters so
// untrusted server/command output cannot inject terminal escape sequences.
export function terminalSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export async function main(): Promise<number> {
  try {
    const outcome = await executeIssue543LiveRunner();
    console.log(JSON.stringify({ ok: true, ...outcome }));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`issue-543 live runner failed: ${terminalSafe(message)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
