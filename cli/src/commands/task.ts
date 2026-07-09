// party task — channel-scoped task ledger.
import type { TaskAssigneeKind, TaskRecord, TaskState } from "../rest";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { createTask, handleRestError, listTasks, updateTask } from "../rest";
import { isName, isSlug, parsePositiveIntFlag } from "../validation";

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
  "priority",
  "parent",
  "anchor",
  "workflow",
  "limit",
  "json",
];

const HELP = `usage: party task create <title|-> [--channel C] [--desc text] [--assignee @name] [--label bug]... [--priority N] [--parent ID] [--anchor seq]...
  party task list [--channel C] [--state S] [--assignee @name] [--limit N] [--json]
  party task assign <id> @name [--channel C] [--assignee-kind agent|human|squad]
  party task claim <id> [--channel C]
  party task status <id> triage|backlog|assigned|in_progress|needs_review|done|blocked [--channel C]
  party task block <id> [--channel C]
  party task done <id> [--channel C]

Create and move channel tasks. Agent-created tasks default to triage; human-created
tasks default to backlog unless an assignee/state is provided.`;

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
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"], repeatable: ["label", "anchor"] });
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "title", "desc", "description", "state", "assignee", "assignee-kind", "priority", "parent", "workflow", "limit"], ["label", "anchor"]);
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
    if (sub === "list" || sub === undefined) {
      const state = parseState(str(flags.state));
      if (state === null) {
        console.error("--state must be triage|backlog|assigned|in_progress|needs_review|done|blocked");
        return 1;
      }
      const assignee = str(flags.assignee)?.replace(/^@/, "");
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
      for (const task of tasks) {
        console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : formatTask(task));
      }
      return 0;
    }

    if (sub === "create") {
      const title = await titleArg(str(flags.title) ?? positionals[1]);
      if (!title) {
        console.error("usage: party task create <title|-> [--channel C]");
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
      for (const item of anchorRaw) {
        const anchor = parsePositiveIntFlag(typeof item === "string" ? item : undefined, "anchor");
        if (typeof anchor === "string" || anchor === undefined) {
          console.error(typeof anchor === "string" ? anchor : "--anchor requires a value");
          return 1;
        }
        anchors.push(anchor);
      }
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
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state: "assigned", assignee });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    if (sub === "claim") {
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state: "in_progress" });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    if (sub === "block") {
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state: "blocked" });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    if (sub === "done") {
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state: "done" });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    if (sub === "status") {
      const state = parseState(positionals[2]);
      if (state === null || state === undefined) {
        console.error("usage: party task status <id> triage|backlog|assigned|in_progress|needs_review|done|blocked");
        return 1;
      }
      const task = await updateTask(cfg.server, cfg.token, slug, id, { state });
      console.log(flags.json === true ? JSON.stringify(jsonFrame(task as unknown as Record<string, unknown>)) : `updated ${formatTask(task)}`);
      return 0;
    }
    console.error("usage: party task create|list|assign|claim|status|block|done");
    return 1;
  } catch (e) {
    return handleRestError(e);
  }
}
