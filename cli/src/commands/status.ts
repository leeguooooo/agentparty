// party status — 发 status 消息（rest）
import type {
  AgentContext,
  CollaborationRole,
  HostDecisionKind,
  Residency,
  SendHostDecision,
  SendStatusWorkflow,
  StatusState,
  TaskState,
  WakeKind,
  WorkflowKind,
} from "@agentparty/shared";
import { isHelpArg, parseArgs, str, strArray, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel, saveCursor, workspaceId, workspaceLabel, worktreeLabel } from "../config";
import { formatAuthDebugLine, resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, handleRestError, postMessage, updateTask } from "../rest";
import { isName, isSlug, parsePositiveIntFlag } from "../validation";

const STATES: StatusState[] = ["working", "waiting", "blocked", "done"];
const COLLAB_ROLES: CollaborationRole[] = ["host", "worker", "reviewer", "observer"];
const RESIDENCIES: Residency[] = ["supervised", "webhook", "bare", "human_driven", "unknown"];
const WAKE_KINDS: WakeKind[] = ["none", "watch", "serve", "webhook"];
const DECISION_KINDS: HostDecisionKind[] = ["decision", "handoff", "takeover"];
const WORKFLOW_KINDS: WorkflowKind[] = ["pipeline", "parallel", "orchestrator-workers", "evaluator-optimizer"];
const WORKFLOW_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const STATUS_FLAGS = [
  "channel",
  "note",
  "mention",
  "scope",
  "summary-seq",
  "blocked-reason",
  "role",
  "residency",
  "wake-kind",
  "decision-kind",
  "decision",
  "next",
  "expires-at",
  "handoff-to",
  "takeover-from",
  "workflow-id",
  "workflow-kind",
  "workflow-run",
  "workflow-step",
  "workflow-parent-summary-seq",
  "task",
  "debug-auth",
];
const HELP = `usage: party status [channel|--channel C] working|waiting|blocked|done [-m note] [--mention name]... [--debug-auth]

Publish agent status/presence into a channel.

Options:
  --channel C      post status in channel C
  -m, --note text  status note
  --mention name   mention a user or agent; repeatable
  --scope item     claimed file/module/task scope; repeatable
  --summary-seq N  seq containing the summary/completion artifact
  --blocked-reason text
                   structured blocker reason for dispatcher boards
  --role role      collaboration role: host|worker|reviewer|observer
  --residency r    wake residency: supervised|webhook|bare|human_driven|unknown
  --wake-kind k    wake layer kind: none|watch|serve|webhook
  --decision text  structured host decision/handoff note
  --decision-kind k
                   decision type: decision|handoff|takeover
  --next text      next action for the decision
  --expires-at N   decision expiry as Unix epoch milliseconds
  --handoff-to name
                   agent taking over host/coordinator work
  --takeover-from name
                   stale host/coordinator being superseded
  --workflow-id id workflow/delegation graph id
  --workflow-kind k
                   workflow type: pipeline|parallel|orchestrator-workers|evaluator-optimizer
  --workflow-run id
                   workflow run id
  --workflow-step id
                   workflow step id
  --workflow-parent-summary-seq N
                   parent summary/status seq this workflow status refines
  --task N         link this status to a channel task and update its task state
  --debug-auth     print resolved auth/config source to stderr`;

export function buildContext(auth: Awaited<ReturnType<typeof resolveAuthDetailed>>): AgentContext {
  const wt = worktreeLabel();
  return {
    config_kind: auth.config.kind,
    ...(auth.config.token_fingerprint !== undefined ? { config_fingerprint: auth.config.token_fingerprint } : {}),
    workspace_id: workspaceId(),
    workspace_label: workspaceLabel(),
    ...(wt !== undefined ? { worktree_label: wt } : {}),
  };
}

function validWorkflowId(value: string): boolean {
  return WORKFLOW_ID_RE.test(value);
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, {
    aliases: { m: "note" },
    booleans: ["debug-auth"],
    repeatable: ["mention", "scope"],
  });
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
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
  const flagError = valueFlagError(
    flags,
    [
      "channel",
      "note",
      "summary-seq",
      "blocked-reason",
      "role",
      "residency",
      "wake-kind",
      "decision-kind",
      "decision",
      "next",
      "expires-at",
      "handoff-to",
      "takeover-from",
      "workflow-id",
      "workflow-kind",
      "workflow-run",
      "workflow-step",
      "workflow-parent-summary-seq",
      "task",
    ],
    ["mention", "scope"],
  );
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
  const scope = strArray(flags.scope) ?? [];
  if (scope.some((item) => item.trim() === "")) {
    console.error("--scope must not be empty");
    return 1;
  }
  const taskId = parsePositiveIntFlag(str(flags.task), "task");
  if (typeof taskId === "string") {
    console.error(taskId);
    return 1;
  }
  const summarySeq = parsePositiveIntFlag(str(flags["summary-seq"]), "summary-seq");
  if (typeof summarySeq === "string") {
    console.error(summarySeq);
    return 1;
  }
  const blockedReason = str(flags["blocked-reason"]);
  const role = str(flags.role);
  if (role !== undefined && !COLLAB_ROLES.includes(role as CollaborationRole)) {
    console.error(`--role must be one of: ${COLLAB_ROLES.join("|")}`);
    return 1;
  }
  const residency = str(flags.residency);
  if (residency !== undefined && !RESIDENCIES.includes(residency as Residency)) {
    console.error(`--residency must be one of: ${RESIDENCIES.join("|")}`);
    return 1;
  }
  const wakeKind = str(flags["wake-kind"]);
  if (wakeKind !== undefined && !WAKE_KINDS.includes(wakeKind as WakeKind)) {
    console.error(`--wake-kind must be one of: ${WAKE_KINDS.join("|")}`);
    return 1;
  }
  const decisionKind = str(flags["decision-kind"]);
  if (decisionKind !== undefined && !DECISION_KINDS.includes(decisionKind as HostDecisionKind)) {
    console.error(`--decision-kind must be one of: ${DECISION_KINDS.join("|")}`);
    return 1;
  }
  const decisionText = str(flags.decision);
  const next = str(flags.next);
  const expiresAt = parsePositiveIntFlag(str(flags["expires-at"]), "expires-at");
  if (typeof expiresAt === "string") {
    console.error(expiresAt);
    return 1;
  }
  const handoffTo = str(flags["handoff-to"]);
  if (handoffTo !== undefined && !isName(handoffTo)) {
    console.error("--handoff-to must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  const takeoverFrom = str(flags["takeover-from"]);
  if (takeoverFrom !== undefined && !isName(takeoverFrom)) {
    console.error("--takeover-from must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  const decisionFlagUsed =
    decisionKind !== undefined ||
    next !== undefined ||
    expiresAt !== undefined ||
    handoffTo !== undefined ||
    takeoverFrom !== undefined;
  if (decisionFlagUsed && decisionText === undefined) {
    console.error("--decision is required when using decision metadata flags");
    return 1;
  }
  const decision: SendHostDecision | undefined =
    decisionText === undefined
      ? undefined
      : {
          decision: decisionText,
          ...(decisionKind !== undefined ? { kind: decisionKind as HostDecisionKind } : {}),
          ...(next !== undefined ? { next } : {}),
          ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
          ...(handoffTo !== undefined ? { handoff_to: handoffTo } : {}),
          ...(takeoverFrom !== undefined ? { takeover_from: takeoverFrom } : {}),
        };
  const workflowId = str(flags["workflow-id"]);
  const workflowKind = str(flags["workflow-kind"]);
  const workflowRun = str(flags["workflow-run"]);
  const workflowStep = str(flags["workflow-step"]);
  const workflowParentSummarySeq = parsePositiveIntFlag(str(flags["workflow-parent-summary-seq"]), "workflow-parent-summary-seq");
  if (typeof workflowParentSummarySeq === "string") {
    console.error(workflowParentSummarySeq);
    return 1;
  }
  const workflowFlagUsed =
    workflowId !== undefined ||
    workflowKind !== undefined ||
    workflowRun !== undefined ||
    workflowStep !== undefined ||
    workflowParentSummarySeq !== undefined;
  if (workflowFlagUsed && (workflowId === undefined || workflowKind === undefined)) {
    console.error("--workflow-id and --workflow-kind are required when using workflow metadata flags");
    return 1;
  }
  if (workflowId !== undefined && !validWorkflowId(workflowId)) {
    console.error("--workflow-id must match [a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}");
    return 1;
  }
  if (workflowKind !== undefined && !WORKFLOW_KINDS.includes(workflowKind as WorkflowKind)) {
    console.error(`--workflow-kind must be one of: ${WORKFLOW_KINDS.join("|")}`);
    return 1;
  }
  if (workflowRun !== undefined && !validWorkflowId(workflowRun)) {
    console.error("--workflow-run must match [a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}");
    return 1;
  }
  if (workflowStep !== undefined && !validWorkflowId(workflowStep)) {
    console.error("--workflow-step must match [a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}");
    return 1;
  }
  const workflow: SendStatusWorkflow | undefined =
    workflowId === undefined || workflowKind === undefined
      ? undefined
      : {
          workflow_id: workflowId,
          kind: workflowKind as WorkflowKind,
          ...(workflowRun !== undefined ? { run_id: workflowRun } : {}),
          ...(workflowStep !== undefined ? { step_id: workflowStep } : {}),
          ...(workflowParentSummarySeq !== undefined ? { parent_summary_seq: workflowParentSummarySeq } : {}),
        };
  try {
    if (flags["debug-auth"] === true || process.env.AGENTPARTY_DEBUG_AUTH === "1") {
      try {
        console.error(formatAuthDebugLine(auth, await fetchMe(auth.server, auth.token)));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`${formatAuthDebugLine(auth)} runtime-error=${message}`);
      }
    }
    const taskScope = taskId === undefined ? [] : [`task:${taskId}`];
    const effectiveScope = [...scope, ...taskScope];
    const { seq } = await postMessage(auth.server, auth.token, channel, {
      kind: "status",
      state: state as StatusState,
      note: str(flags.note) ?? "",
      mentions,
      ...(effectiveScope.length > 0 ? { scope: effectiveScope } : {}),
      ...(summarySeq !== undefined ? { summary_seq: summarySeq } : {}),
      ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}),
      ...(role !== undefined ? { role: role as CollaborationRole } : {}),
      ...(residency !== undefined ? { residency: residency as Residency } : {}),
      ...(wakeKind !== undefined ? { wake: { kind: wakeKind as WakeKind } } : {}),
      ...(decision !== undefined ? { decision } : {}),
      ...(workflow !== undefined ? { workflow } : {}),
      context: buildContext(auth),
    });
    if (taskId !== undefined) {
      const taskState: TaskState =
        state === "working" ? "in_progress" :
        state === "waiting" ? "assigned" :
        state as TaskState;
      await updateTask(auth.server, auth.token, channel, taskId, { state: taskState });
    }
    saveCursor(channel, seq);
    console.log(`status seq=${seq}`);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
