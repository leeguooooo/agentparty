// party task — channel-scoped task ledger.
import type { Attachment, MsgFrame, TaskAssigneeKind, TaskRecord, TaskState } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { createTask, fetchMe, fetchMessages, handleRestError, listTasks, updateTask } from "../rest";
import { isName, isSlug, parsePositiveIntFlag } from "../validation";
import { collectAttachments, resolveAttachments } from "./send";

const TASK_STATES: readonly string[] = ["triage", "backlog", "assigned", "in_progress", "needs_review", "done", "blocked"] satisfies TaskState[];
const FLAGS = [
  "channel",
  "title",
  "desc",
  "description",
  "state",
  "assignee",
  "assignee-kind",
  "label",
  "scope",
  "blocked-reason",
  "priority",
  "parent",
  "anchor",
  "workflow",
  "external-ref",
  "limit",
  "mine",
  "json",
  "clear",
];

const HELP = `usage: party task create <title|-> [--channel C] [--desc text] [--assignee @name] [--label bug]... [--scope path]... [--blocked-reason text] [--priority N] [--parent ID] [--anchor seq]... [--external-ref ref]
  party task from <seq> [--channel C] [--title text] [--desc text] [--assignee @name] [--label bug]... [--scope path]...
  party task list [--channel C] [--state S] [--assignee @name|--mine] [--limit N] [--json]
  party task assign <id> @name [--channel C] [--assignee-kind agent|human|squad] [--scope path]...
  party task claim <id> [--channel C] [--scope path]...
  party task status <id> triage|backlog|assigned|in_progress|needs_review|done|blocked [--channel C] [--scope path]... [--blocked-reason text]
  party task block <id> [--channel C] [--blocked-reason text] [--scope path]...
  party task done <id> [--channel C]
  party task solution <id> <file> [--channel C] [--json]
  party task solution <id> --clear [--channel C] [--json]

--scope declares the files/dirs a task claims (repeatable); host board conflicts and open claims
derive from it. --blocked-reason attaches a structured reason when a task is blocked.
--external-ref (create only) is an idempotency key (e.g. gh:owner/repo#96): creating with a ref
that already exists in the channel returns the existing task instead of a duplicate — safe to
rerun an issue→task sync (#141).
solution uploads one channel-authenticated file as the task's canonical deliverable (#464).
Replacing it keeps exactly one current solution; --clear removes the reference.

Create and move channel tasks. Agent-created tasks default to triage; human-created
tasks default to backlog unless an assignee/state is provided.

  --json   emit one JSON document: { schema, type: "task_list", channel, tasks, count }`;

function parseState(value: string | undefined): TaskState | null | undefined {
  if (value === undefined) return undefined;
  return TASK_STATES.includes(value) ? (value as TaskState) : null;
}

function labelsFrom(value: string | boolean | Array<string | boolean> | undefined): string[] | null {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  const labels: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item === "") return null;
    if (!labels.includes(item)) labels.push(item);
  }
  return labels;
}

function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function titleFromMessage(msg: MsgFrame): string {
  const raw = compact(msg.kind === "status" ? (msg.note ?? msg.body) : msg.body);
  const label = raw === "" ? `${msg.sender.name} message #${msg.seq}` : raw;
  return label.length > 120 ? `${label.slice(0, 117)}...` : label;
}

function formatTask(task: TaskRecord): string {
  const assignee = task.assignee ? ` @${task.assignee.name}` : "";
  const labels = task.labels.length > 0 ? ` [${task.labels.join(",")}]` : "";
  const parent = task.parent_id === null ? "" : ` parent:${task.parent_id}`;
  return `#${task.id}\t${task.state}\tP${task.priority}${assignee}${labels}${parent}\t${compact(task.title)}`;
}

function parseAssignee(raw: string | undefined, kindRaw: string | undefined): { name: string; kind: TaskAssigneeKind } | null | undefined {
  if (raw === undefined) return undefined;
  const name = raw.replace(/^@/, "");
  const kind = kindRaw ?? "agent";
  if (!isName(name) || (kind !== "agent" && kind !== "human" && kind !== "squad")) return null;
  return { name, kind };
}

function parsePriority(raw: string | undefined): number | string | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw)) return "--priority must be an integer";
  const n = Number(raw);
  if (n < -100 || n > 100) return "--priority must be between -100 and 100";
  return n;
}

async function titleArg(value: string | undefined): Promise<string | null> {
  if (value === undefined) return null;
  return value === "-" ? (await readStdin()).trim() : value;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json", "mine", "clear"], repeatable: ["label", "anchor", "scope"] });
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "title", "desc", "description", "state", "assignee", "assignee-kind", "priority", "parent", "workflow", "limit", "blocked-reason", "external-ref"], ["label", "anchor", "scope"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const sub = positionals[0];
  const slug = resolveChannel(str(flags.channel));
  if (!slug) {
    console.error("channel required: pass --channel C or run party init --channel C");
    return 1;
  }
  if (!isSlug(slug)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }

  try {
    // #204 --scope（repeatable）/ --blocked-reason：create 与各 patch 子命令共用。
    // 只有 flag 实际出现时才纳入请求体，避免 patch 时把未提供的 scope 误清空。
    const scopeProvided = flags.scope !== undefined;
    const scope = scopeProvided ? labelsFrom(flags.scope) : undefined;
    if (scope === null) {
      console.error("--scope requires non-empty values");
      return 1;
    }
    const blockedReason = flags["blocked-reason"] !== undefined ? str(flags["blocked-reason"]) : undefined;

    if (sub === "list" || sub === undefined) {
      const state = parseState(str(flags.state));
      if (state === null) {
        console.error("--state must be triage|backlog|assigned|in_progress|needs_review|done|blocked");
        return 1;
      }
      if (flags.mine === true && str(flags.assignee) !== undefined) {
        console.error("--mine cannot be combined with --assignee");
        return 1;
      }
      const assignee = flags.mine === true ? (await fetchMe(cfg.server, cfg.token)).name : str(flags.assignee)?.replace(/^@/, "");
      if (assignee !== undefined && !isName(assignee)) {
        console.error("--assignee must be a valid name");
        return 1;
      }
      const limit = parsePositiveIntFlag(str(flags.limit), "limit", 500);
      if (typeof limit === "string") {
        console.error(limit);
        return 1;
      }
      const tasks = await listTasks(cfg.server, cfg.token, slug, {
        ...(state !== undefined ? { state } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (flags.json === true) {
        // Single JSON document (never zero bytes), mirroring the REST
        // {tasks:[]} envelope so agents can JSON.parse stdout and read .tasks.
        console.log(JSON.stringify(jsonFrame({ type: "task_list", channel: slug, tasks, count: tasks.length })));
      } else if (tasks.length === 0) {
        console.log(`no tasks in #${slug}`);
      } else {
        for (const task of tasks) console.log(formatTask(task));
      }
      return 0;
    }

    if (sub === "create" || sub === "from") {
      const sourceSeq = sub === "from" ? parsePositiveIntFlag(positionals[1], "seq") : undefined;
      if (typeof sourceSeq === "string") {
        console.error(sourceSeq);
        return 1;
      }
      if (sub === "from" && sourceSeq === undefined) {
        console.error("usage: party task from <seq> [--channel C]");
        return 1;
      }
      const source =
        sourceSeq === undefined
          ? undefined
          : (await fetchMessages(cfg.server, cfg.token, slug, sourceSeq - 1, 1)).find((msg) => msg.seq === sourceSeq);
      if (sourceSeq !== undefined && source === undefined) {
        console.error(`message #${sourceSeq} not found`);
        return 1;
      }
      const title = await titleArg(str(flags.title) ?? (sub === "create" ? positionals[1] : undefined)) ?? (source === undefined ? null : titleFromMessage(source));
      if (!title) {
        console.error(sub === "from" ? "usage: party task from <seq> [--channel C]" : "usage: party task create <title|-> [--channel C]");
        return 1;
      }
      const state = parseState(str(flags.state));
      if (state === null) {
        console.error("--state must be triage|backlog|assigned|in_progress|needs_review|done|blocked");
        return 1;
      }
      const assignee = parseAssignee(str(flags.assignee), str(flags["assignee-kind"]));
      if (assignee === null) {
        console.error("--assignee must be a valid @name and --assignee-kind must be agent|human|squad");
        return 1;
      }
      const labels = labelsFrom(flags.label);
      if (labels === null) {
        console.error("--label requires a value");
        return 1;
      }
      const priority = parsePriority(str(flags.priority));
      if (typeof priority === "string") {
        console.error(priority);
        return 1;
      }
      const desc = str(flags.desc) ?? str(flags.description);
      const parent = parsePositiveIntFlag(str(flags.parent), "parent");
      if (typeof parent === "string") {
        console.error(parent);
        return 1;
      }
      const anchorRaw = Array.isArray(flags.anchor) ? flags.anchor : flags.anchor === undefined ? [] : [flags.anchor];
      const anchors: number[] = [];
      if (sourceSeq !== undefined) anchors.push(sourceSeq);
      for (const item of anchorRaw) {
        const anchor = parsePositiveIntFlag(typeof item === "string" ? item : undefined, "anchor");
        if (typeof anchor === "string" || anchor === undefined) {
          console.error(typeof anchor === "string" ? anchor : "--anchor requires a value");
          return 1;
        }
        anchors.push(anchor);
      }
      const externalRef = str(flags["external-ref"]);
      const task = await createTask(cfg.server, cfg.token, slug, {
        title,
        ...(desc !== undefined ? { desc } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(labels.length > 0 ? { labels } : {}),
        ...(parent !== undefined ? { parent_id: parent } : {}),
        ...(anchors.length > 0 ? { anchor_seqs: anchors } : {}),
        ...(str(flags.workflow) !== undefined ? { workflow_id: str(flags.workflow) } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}),
        ...(externalRef !== undefined ? { external_ref: externalRef } : {}),
      });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `created ${formatTask(task)}`);
      return 0;
    }

    const id = parsePositiveIntFlag(positionals[1], "id");
    if (typeof id === "string" || id === undefined) {
      console.error("task id required");
      return 1;
    }
    if (sub === "assign") {
      const assignee = parseAssignee(positionals[2], str(flags["assignee-kind"]));
      if (!assignee) {
        console.error("usage: party task assign <id> @name [--assignee-kind agent|human|squad]");
        return 1;
      }
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state: "assigned", assignee, ...(scope !== undefined ? { scope } : {}), ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}) });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    if (sub === "solution") {
      const path = positionals[2];
      if (flags.clear === true && path !== undefined) {
        console.error("party task solution: --clear cannot be combined with a file");
        return 1;
      }
      if (flags.clear !== true && path === undefined) {
        console.error("usage: party task solution <id> <file> [--channel C] | party task solution <id> --clear [--channel C]");
        return 1;
      }
      let solution: Attachment | null = null;
      if (flags.clear !== true) {
        const uploaded = await collectAttachments(cfg.server, cfg.token, slug, await resolveAttachments([path!]));
        if (uploaded.length !== 1) throw new Error("party task solution: upload did not return exactly one attachment");
        solution = uploaded[0]!;
      }
      const task = await updateTask(cfg.server, cfg.token, slug, id, { solution });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    if (sub === "claim") {
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state: "in_progress", ...(scope !== undefined ? { scope } : {}), ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}) });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    if (sub === "block") {
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state: "blocked", ...(scope !== undefined ? { scope } : {}), ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}) });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    if (sub === "done") {
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state: "done", ...(scope !== undefined ? { scope } : {}), ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}) });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    if (sub === "status") {
      const state = parseState(positionals[2]);
      if (state === null || state === undefined) {
        console.error("usage: party task status <id> triage|backlog|assigned|in_progress|needs_review|done|blocked");
        return 1;
      }
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state, ...(scope !== undefined ? { scope } : {}), ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}) });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    console.error("usage: party task create|list|assign|claim|status|block|done|solution");
    return 1;
  } catch (e) {
    return handleRestError(e);
  }
}
