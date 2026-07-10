// party mcp — stdio MCP server exposing AgentParty as structured tools.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MsgFrame, StatusState, TaskAssigneeKind, TaskState } from "@agentparty/shared";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { advanceCursorPastOwnMessage, loadCursor, loadRevCursor, resolveChannel, saveCursor, saveRevCursor } from "../config";
import { jsonFrame } from "../json";
import { resolveAuth, resolveAuthDetailed } from "../oidc-cli";
import {
  createTask,
  fetchChannelCharter,
  fetchMe,
  fetchMessages,
  fetchPresence,
  fetchRecentMessages,
  handleRestError,
  listChannels,
  listTasks,
  postMessage,
  spawnAgent,
  updateTask,
  type Identity,
} from "../rest";
import { isName, isSlug } from "../validation";
import { buildContext } from "./status";
import { runWatch } from "./watch";

const HELP = `usage: party mcp

Run an AgentParty stdio MCP server.

Example:
  claude mcp add party -- party mcp

Tools:
  party_whoami
  party_charter
  party_channels
  party_send
  party_status
  party_who
  party_history
  party_digest
  party_task_list
  party_task_create
  party_task_from_message
  party_task_update
  task_list
  task_claim
  task_status
  task_complete
  task_block
  party_spawn_worker
  party_watch_once
  party_wake_test

Resources:
  party://charter               charter for the bound channel (--channel or cwd binding, 用前必读)
  party://{channel}/charter     charter for any channel by slug`;

const StateSchema = z.enum(["working", "waiting", "blocked", "done"]);
const TaskStateSchema = z.enum(["triage", "backlog", "assigned", "in_progress", "needs_review", "done", "blocked"]);
const TaskAssigneeKindSchema = z.enum(["agent", "human", "squad"]);

function ok(data: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function normalizeChannel(channel: string | undefined, defaultChannel?: string): string {
  const resolved = resolveChannel(channel ?? defaultChannel);
  if (!resolved) throw new Error("no channel, pass channel or bind with: party init --channel C");
  if (!isSlug(resolved)) throw new Error("channel must match [a-z0-9][a-z0-9-]{0,63}");
  return resolved;
}

function normalizeMentions(mentions?: string[]): string[] {
  const values = mentions ?? [];
  const bad = values.find((mention) => !isName(mention));
  if (bad !== undefined) throw new Error(`invalid mention: ${bad}`);
  return values;
}

function normalizeLabels(labels?: string[]): string[] | undefined {
  if (labels === undefined) return undefined;
  const trimmed = labels.map((label) => label.trim());
  if (trimmed.some((label) => label === "")) throw new Error("labels must not be empty");
  return [...new Set(trimmed)];
}

function normalizeAssignee(name?: string, kind?: TaskAssigneeKind): { name: string; kind: TaskAssigneeKind } | undefined {
  if (name === undefined) return undefined;
  const normalized = name.replace(/^@/, "");
  if (!isName(normalized)) throw new Error("assignee_name must be a valid AgentParty name");
  return { name: normalized, kind: kind ?? "agent" };
}

function normalizeTaskAssigneeFilter(assignee?: string): string | undefined {
  const normalized = assignee?.replace(/^@/, "");
  if (normalized !== undefined && !isName(normalized)) throw new Error("assignee must be a valid AgentParty name");
  return normalized;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function titleFromMessage(msg: MsgFrame): string {
  const raw = compact(msg.kind === "status" ? (msg.note ?? msg.body) : msg.body);
  const label = raw === "" ? `${msg.sender.name} message #${msg.seq}` : raw;
  return label.length > 120 ? `${label.slice(0, 117)}...` : label;
}

async function auth(): Promise<{ server: string; token: string; me?: Identity }> {
  const cfg = await resolveAuth();
  if (!cfg) throw new Error("no config, run: party login or party init --server URL --token T");
  return cfg;
}

let captureQueue: Promise<void> = Promise.resolve();

async function captureCommand(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let release!: () => void;
  const previous = captureQueue;
  captureQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    const code = await run();
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = oldLog;
    console.error = oldError;
    release();
  }
}

function capturedResult(name: string, captured: { code: number; stdout: string; stderr: string }): CallToolResult {
  const firstJson = captured.stdout
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((value): value is Record<string, unknown> => value !== null);
  const data = {
    type: name,
    exit_code: captured.code,
    stdout: captured.stdout,
    stderr: captured.stderr,
    ...(firstJson !== undefined ? { frame: firstJson } : {}),
  };
  return captured.code === 0 ? ok(data) : { ...fail(captured.stderr || captured.stdout || `${name} failed`), structuredContent: data };
}

// 被 @ 唤起时的第一屏提示：MCP 接入的 agent 没有 serve 的 context file，
// 靠这条把它引到 charter。提示必须与实际注册的资源一致：绑定了频道（flag 或 cwd）才指向
// 具体的 party://charter；否则只指 party_charter 工具与模板 party://{channel}/charter，
// 绝不叫模型去读一个 resources/list 里不存在的资源。
function charterReminder(boundChannel: string | undefined): string {
  const where =
    boundChannel !== undefined
      ? "party_charter tool or party://charter resource"
      : "party_charter tool (pass a channel), or the party://{channel}/charter resource";
  return `read the channel charter first (${where}) — it defines this channel's scope and etiquette before you act.`;
}

async function charterData(channel: string): Promise<Record<string, unknown>> {
  const cfg = await auth();
  const body = await fetchChannelCharter(cfg.server, cfg.token, channel);
  return { type: "charter", channel, ...body };
}

function charterText(data: Record<string, unknown>): string {
  const charter = data.charter;
  return typeof charter === "string" && charter.length > 0
    ? charter
    : `# ${String(data.channel)} charter not set (rev ${String(data.charter_rev ?? 0)})`;
}

export function createMcpServer(defaultChannel?: string): McpServer {
  const server = new McpServer({
    name: "agentparty",
    version: pkg.version,
  });

  // 启动时解析一次「我在哪个频道」——flag 优先，否则吃 cwd 绑定（party init --channel）。
  // 工具、concrete resource、whoami 提示三者共用这一个答案，不能各认各的。
  const resolvedBound = resolveChannel(defaultChannel) ?? undefined;
  const boundChannel = resolvedBound !== undefined && isSlug(resolvedBound) ? resolvedBound : undefined;
  const reminder = charterReminder(boundChannel);

  server.registerTool(
    "party_whoami",
    {
      title: "Current AgentParty identity",
      description: "Return the identity and capability metadata for the current AgentParty config.",
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = await auth();
        const me = await fetchMe(cfg.server, cfg.token);
        return ok({ type: "me", server: cfg.server, identity: me, protocol_reminder: reminder });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_charter",
    {
      title: "Read channel charter",
      description:
        "Read the channel charter / 用前必读 — the channel's scope, etiquette, roles, and current host. Call this FIRST when you are @-woken into a channel, before acting.",
      inputSchema: {
        channel: z.string().optional().describe("Channel slug. Defaults to the workspace-bound channel."),
      },
    },
    async ({ channel }) => {
      try {
        // charter 的三条路径（tool / resource / whoami 提示）必须恒等：resource 与提示在启动时
        // 静态绑定 boundChannel（MCP resources 无法热更新），所以 tool 不传 channel 时也用同一个
        // boundChannel，而不是每次重解析 cwd 绑定——否则运行中 rebind 会让 tool 漂到新频道、
        // 资源/提示仍指旧频道，两者都不报错。显式传 channel 参数仍优先（保留读任意频道的能力）。
        let resolved: string;
        if (channel !== undefined) {
          if (!isSlug(channel)) throw new Error("channel must match [a-z0-9][a-z0-9-]{0,63}");
          resolved = channel;
        } else if (boundChannel !== undefined) {
          resolved = boundChannel;
        } else {
          throw new Error("no channel, pass channel or bind with: party init --channel C");
        }
        return ok(await charterData(resolved));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_channels",
    {
      title: "List channels",
      description: "List channels visible to the current AgentParty identity.",
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = await auth();
        const channels = await listChannels(cfg.server, cfg.token);
        return ok({ type: "channels", channels });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_send",
    {
      title: "Send message",
      description: "Send a message to an AgentParty channel.",
      inputSchema: {
        channel: z.string().optional().describe("Channel slug. Defaults to the workspace-bound channel."),
        body: z.string().min(1),
        mentions: z.array(z.string()).optional(),
        reply_to: z.number().int().positive().nullable().optional(),
      },
    },
    async ({ channel, body, mentions, reply_to }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const normalizedMentions = normalizeMentions(mentions);
        const { seq } = await postMessage(cfg.server, cfg.token, resolved, {
          kind: "message",
          body,
          mentions: normalizedMentions,
          reply_to: reply_to ?? null,
        });
        advanceCursorPastOwnMessage(resolved, seq);
        return ok({ type: "send", channel: resolved, seq });
      } catch (e) {
        const code = handleRestError(e);
        return fail(code === 1 && e instanceof Error ? e.message : `send failed with exit ${code}`);
      }
    },
  );

  server.registerTool(
    "party_status",
    {
      title: "Post status",
      description: "Post a structured AgentParty status frame.",
      inputSchema: {
        channel: z.string().optional(),
        state: StateSchema,
        note: z.string().optional(),
        mentions: z.array(z.string()).optional(),
        scope: z.array(z.string()).optional(),
        summary_seq: z.number().int().positive().optional(),
        task_id: z.number().int().positive().optional(),
      },
    },
    async ({ channel, state, note, mentions, scope, summary_seq, task_id }) => {
      try {
        const authInfo = await resolveAuthDetailed();
        if (!authInfo.server || !authInfo.token) throw new Error("no config, run: party login or party init --server URL --token T");
        const resolved = normalizeChannel(channel, defaultChannel);
        const normalizedMentions = normalizeMentions(mentions);
        const taskScope = task_id === undefined ? [] : [`task:${task_id}`];
        const effectiveScope = [...(scope ?? []), ...taskScope];
        const { seq } = await postMessage(authInfo.server, authInfo.token, resolved, {
          kind: "status",
          state: state as StatusState,
          note: note ?? "",
          mentions: normalizedMentions,
          ...(effectiveScope.length > 0 ? { scope: effectiveScope } : {}),
          ...(summary_seq !== undefined ? { summary_seq } : {}),
          context: buildContext(authInfo),
        });
        let task = undefined;
        if (task_id !== undefined) {
          const taskState: TaskState =
            state === "working" ? "in_progress" :
            state === "waiting" ? "assigned" :
            state as TaskState;
          task = await updateTask(authInfo.server, authInfo.token, resolved, task_id, { state: taskState });
        }
        advanceCursorPastOwnMessage(resolved, seq);
        return ok({ type: "status", channel: resolved, seq, state, ...(task !== undefined ? { task } : {}) });
      } catch (e) {
        const code = handleRestError(e);
        return fail(code === 1 && e instanceof Error ? e.message : `status failed with exit ${code}`);
      }
    },
  );

  server.registerTool(
    "party_who",
    {
      title: "Channel presence",
      description: "Return current presence/wakeability for a channel.",
      inputSchema: {
        channel: z.string().optional(),
      },
    },
    async ({ channel }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const presence = await fetchPresence(cfg.server, cfg.token, resolved);
        return ok({ type: "who", channel: resolved, presence });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_history",
    {
      title: "Channel history",
      description: "Fetch AgentParty channel messages. Defaults to the MOST RECENT --limit messages (pass since/before to page explicitly).",
      inputSchema: {
        channel: z.string().optional(),
        since: z.number().int().min(0).optional(),
        before: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async ({ channel, since, before, limit }) => {
      // since 与 before 都未给 → 走 tail，这样才对得上工具描述里的"recent"；给了任一个就照给的来
      if (since !== undefined && before !== undefined) {
        return fail("since and before are mutually exclusive");
      }
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const messages =
          since !== undefined
            ? await fetchMessages(cfg.server, cfg.token, resolved, since, limit ?? 100)
            : before !== undefined
              ? await fetchMessages(cfg.server, cfg.token, resolved, 0, limit ?? 100, { before })
              : await fetchRecentMessages(cfg.server, cfg.token, resolved, limit ?? 100);
        return ok({ type: "history", channel: resolved, messages });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_digest",
    {
      title: "Channel digest",
      description: "Run the existing AgentParty digest command and return its structured frame.",
      inputSchema: {
        channel: z.string().optional(),
        since: z.union([z.number().int().min(0), z.literal("last-seen")]).optional(),
        limit: z.number().int().positive().max(1000).optional(),
        for_name: z.string().optional(),
      },
    },
    async ({ channel, since, limit, for_name }) => {
      const resolved = channel ?? defaultChannel;
      const argv = [
        ...(resolved ? ["--channel", resolved] : []),
        ...(since !== undefined ? ["--since", String(since)] : []),
        ...(limit !== undefined ? ["--limit", String(limit)] : []),
        ...(for_name !== undefined ? ["--for", for_name] : []),
        "--json",
      ];
      const captured = await captureCommand(async () => (await import("./digest")).run(argv));
      return capturedResult("digest", captured);
    },
  );

  server.registerTool(
    "party_task_list",
    {
      title: "List channel tasks",
      description: "List AgentParty channel tasks from the task ledger.",
      inputSchema: {
        channel: z.string().optional(),
        state: TaskStateSchema.optional(),
        assignee: z.string().optional().describe("Assignee name, with or without @ prefix."),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ channel, state, assignee, limit }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const normalizedAssignee = normalizeTaskAssigneeFilter(assignee);
        const tasks = await listTasks(cfg.server, cfg.token, resolved, {
          ...(state !== undefined ? { state: state as TaskState } : {}),
          ...(normalizedAssignee !== undefined ? { assignee: normalizedAssignee } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return ok({ type: "task_list", channel: resolved, tasks });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "task_list",
    {
      title: "List task board tasks",
      description: "List channel-scoped task board tasks visible to the current AgentParty identity.",
      inputSchema: {
        channel: z.string().optional(),
        state: TaskStateSchema.optional(),
        assignee: z.string().optional().describe("Assignee name, with or without @ prefix."),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ channel, state, assignee, limit }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const normalizedAssignee = normalizeTaskAssigneeFilter(assignee);
        const tasks = await listTasks(cfg.server, cfg.token, resolved, {
          ...(state !== undefined ? { state: state as TaskState } : {}),
          ...(normalizedAssignee !== undefined ? { assignee: normalizedAssignee } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return ok({ type: "task_list", channel: resolved, tasks });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_task_create",
    {
      title: "Create channel task",
      description: "Create an AgentParty channel task.",
      inputSchema: {
        channel: z.string().optional(),
        title: z.string().min(1),
        desc: z.string().optional(),
        state: TaskStateSchema.optional(),
        assignee_name: z.string().optional().describe("Assignee name, with or without @ prefix."),
        assignee_kind: TaskAssigneeKindSchema.optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        labels: z.array(z.string()).optional(),
        parent_id: z.number().int().positive().optional(),
        anchor_seqs: z.array(z.number().int().positive()).optional(),
        workflow_id: z.string().optional(),
      },
    },
    async ({ channel, title, desc, state, assignee_name, assignee_kind, priority, labels, parent_id, anchor_seqs, workflow_id }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const normalizedLabels = normalizeLabels(labels);
        const assignee = normalizeAssignee(assignee_name, assignee_kind as TaskAssigneeKind | undefined);
        const task = await createTask(cfg.server, cfg.token, resolved, {
          title,
          ...(desc !== undefined ? { desc } : {}),
          ...(state !== undefined ? { state: state as TaskState } : {}),
          ...(assignee !== undefined ? { assignee } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(normalizedLabels !== undefined && normalizedLabels.length > 0 ? { labels: normalizedLabels } : {}),
          ...(parent_id !== undefined ? { parent_id } : {}),
          ...(anchor_seqs !== undefined && anchor_seqs.length > 0 ? { anchor_seqs } : {}),
          ...(workflow_id !== undefined ? { workflow_id } : {}),
        });
        return ok({ type: "task_create", channel: resolved, task });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_task_from_message",
    {
      title: "Create task from message",
      description: "Create an AgentParty task from an existing message and anchor the source seq.",
      inputSchema: {
        channel: z.string().optional(),
        source_seq: z.number().int().positive(),
        title: z.string().min(1).optional(),
        desc: z.string().optional(),
        state: TaskStateSchema.optional(),
        assignee_name: z.string().optional(),
        assignee_kind: TaskAssigneeKindSchema.optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        labels: z.array(z.string()).optional(),
        parent_id: z.number().int().positive().optional(),
        anchor_seqs: z.array(z.number().int().positive()).optional(),
        workflow_id: z.string().optional(),
      },
    },
    async ({ channel, source_seq, title, desc, state, assignee_name, assignee_kind, priority, labels, parent_id, anchor_seqs, workflow_id }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const source = (await fetchMessages(cfg.server, cfg.token, resolved, source_seq - 1, 1)).find((msg) => msg.seq === source_seq);
        if (source === undefined) throw new Error(`message #${source_seq} not found`);
        const normalizedLabels = normalizeLabels(labels);
        const assignee = normalizeAssignee(assignee_name, assignee_kind as TaskAssigneeKind | undefined);
        const anchors = [...new Set([source_seq, ...(anchor_seqs ?? [])])];
        const task = await createTask(cfg.server, cfg.token, resolved, {
          title: title ?? titleFromMessage(source),
          ...(desc !== undefined ? { desc } : {}),
          ...(state !== undefined ? { state: state as TaskState } : {}),
          ...(assignee !== undefined ? { assignee } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(normalizedLabels !== undefined && normalizedLabels.length > 0 ? { labels: normalizedLabels } : {}),
          ...(parent_id !== undefined ? { parent_id } : {}),
          anchor_seqs: anchors,
          ...(workflow_id !== undefined ? { workflow_id } : {}),
        });
        return ok({ type: "task_from_message", channel: resolved, source_seq, task });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_task_update",
    {
      title: "Update channel task",
      description: "Update title, state, assignee, priority, labels, or description for an AgentParty task.",
      inputSchema: {
        channel: z.string().optional(),
        id: z.number().int().positive(),
        title: z.string().min(1).optional(),
        desc: z.string().nullable().optional(),
        state: TaskStateSchema.optional(),
        assignee_name: z.string().optional(),
        assignee_kind: TaskAssigneeKindSchema.optional(),
        clear_assignee: z.boolean().optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    async ({ channel, id, title, desc, state, assignee_name, assignee_kind, clear_assignee, priority, labels }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        if (clear_assignee === true && assignee_name !== undefined) throw new Error("clear_assignee cannot be combined with assignee_name");
        const normalizedLabels = normalizeLabels(labels);
        const assignee = clear_assignee === true ? null : normalizeAssignee(assignee_name, assignee_kind as TaskAssigneeKind | undefined);
        const body = {
          ...(title !== undefined ? { title } : {}),
          ...(desc !== undefined ? { desc } : {}),
          ...(state !== undefined ? { state: state as TaskState } : {}),
          ...(assignee !== undefined ? { assignee } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(normalizedLabels !== undefined ? { labels: normalizedLabels } : {}),
        };
        if (Object.keys(body).length === 0) throw new Error("no task fields to update");
        const task = await updateTask(cfg.server, cfg.token, resolved, id, body);
        return ok({ type: "task_update", channel: resolved, task });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "task_claim",
    {
      title: "Claim task",
      description: "Mark a channel task as in_progress through the existing task ledger.",
      inputSchema: {
        channel: z.string().optional(),
        id: z.number().int().positive(),
      },
    },
    async ({ channel, id }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const task = await updateTask(cfg.server, cfg.token, resolved, id, { state: "in_progress" });
        return ok({ type: "task_claim", channel: resolved, task });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "task_status",
    {
      title: "Set task status",
      description: "Set a channel task's ledger state through the existing task REST endpoint.",
      inputSchema: {
        channel: z.string().optional(),
        id: z.number().int().positive(),
        state: TaskStateSchema,
      },
    },
    async ({ channel, id, state }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const task = await updateTask(cfg.server, cfg.token, resolved, id, { state: state as TaskState });
        return ok({ type: "task_status", channel: resolved, task });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "task_complete",
    {
      title: "Complete task",
      description: "Mark a channel task as done through the existing task ledger.",
      inputSchema: {
        channel: z.string().optional(),
        id: z.number().int().positive(),
      },
    },
    async ({ channel, id }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const task = await updateTask(cfg.server, cfg.token, resolved, id, { state: "done" });
        return ok({ type: "task_complete", channel: resolved, task });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "task_block",
    {
      title: "Block task",
      description: "Mark a channel task as blocked through the existing task ledger.",
      inputSchema: {
        channel: z.string().optional(),
        id: z.number().int().positive(),
      },
    },
    async ({ channel, id }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const task = await updateTask(cfg.server, cfg.token, resolved, id, { state: "blocked" });
        return ok({ type: "task_block", channel: resolved, task });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_spawn_worker",
    {
      title: "Spawn worker agent",
      description: "Create a short-lived channel-scoped worker identity for a front agent to delegate work.",
      inputSchema: {
        name: z.string().describe("Worker agent name."),
        channel: z.string().optional().describe("Channel slug for the worker scope. Defaults to the MCP server channel."),
        ttl_sec: z.number().int().positive().optional().describe("Optional worker lifetime in seconds."),
        team_id: z.string().optional().describe("Optional lineage team id for grouping the worker with the front agent."),
      },
    },
    async ({ name, channel, ttl_sec, team_id }) => {
      try {
        if (!isName(name)) throw new Error("name must be a valid AgentParty name");
        if (team_id !== undefined && !isName(team_id)) throw new Error("team_id must be a valid AgentParty name");
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const worker = await spawnAgent(cfg.server, cfg.token, name, resolved, {
          ...(ttl_sec !== undefined ? { ttlSec: ttl_sec } : {}),
          ...(team_id !== undefined ? { teamId: team_id } : {}),
        });
        return ok({ type: "spawn_worker", channel: resolved, worker });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_watch_once",
    {
      title: "Wait for one matching mention",
      description: "Wait until the next matching message arrives, then return the structured watch frame.",
      inputSchema: {
        channel: z.string().optional(),
        timeout_sec: z.number().int().positive().max(600).optional(),
        mentions_only: z.boolean().optional(),
      },
    },
    async ({ channel, timeout_sec, mentions_only }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const lines: string[] = [];
        const code = await runWatch({
          server: cfg.server,
          token: cfg.token,
          channel: resolved,
          since: loadCursor(resolved),
          sinceRev: loadRevCursor(resolved),
          timeoutSec: timeout_sec ?? 240,
          follow: false,
          once: true,
          mentionsOnly: mentions_only ?? true,
          json: true,
          onCursor: (c) => saveCursor(resolved, c),
          onRevCursor: (r) => saveRevCursor(resolved, r),
          out: (line) => lines.push(line),
        });
        const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        const data = { type: "watch_once", channel: resolved, exit_code: code, frames };
        return code === 0 ? ok(data) : { ...fail(lines.join("\n") || `watch_once failed with exit ${code}`), structuredContent: data };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_wake_test",
    {
      title: "Wake test",
      description: "Run the existing wake contract test and return its structured frame.",
      inputSchema: {
        channel: z.string().optional(),
        target: z.string().describe("Agent name, with or without @ prefix."),
        timeout_sec: z.number().int().positive().max(600).optional(),
      },
    },
    async ({ channel, target, timeout_sec }) => {
      const normalizedTarget = target.startsWith("@") ? target : `@${target}`;
      const resolved = channel ?? defaultChannel;
      const argv = [
        "test",
        normalizedTarget,
        ...(resolved ? ["--channel", resolved] : []),
        ...(timeout_sec !== undefined ? ["--timeout", String(timeout_sec)] : []),
        "--json",
      ];
      const captured = await captureCommand(async () => (await import("./wake")).run(argv));
      return capturedResult("wake_test", captured);
    },
  );

  // Resources make the charter machine-discoverable via resources/list (#136) and give the
  // MCP接入路径 a first-screen "用前必读" it otherwise never sees (#134). The concrete
  // party://charter is registered whenever a channel resolves — from --channel OR the cwd
  // binding (party init --channel) — so it stays consistent with the party_charter tool and
  // the whoami reminder, which resolve the same way. Any channel is still readable via the
  // template below. Only when neither flag nor binding names a channel is resources/list empty.
  if (boundChannel !== undefined) {
    server.registerResource(
      "channel-charter",
      "party://charter",
      {
        title: `Charter for #${boundChannel}`,
        description: "The bound channel's charter / 用前必读: scope, etiquette, roles, current host. Read before acting.",
        mimeType: "text/markdown",
      },
      async (uri) => {
        const data = await charterData(boundChannel);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: charterText(data) }] };
      },
    );
  }

  server.registerResource(
    "channel-charter-by-slug",
    new ResourceTemplate("party://{channel}/charter", { list: undefined }),
    {
      title: "Channel charter by slug",
      description: "Read any channel's charter / 用前必读 by slug: party://<channel>/charter.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const raw = Array.isArray(variables.channel) ? variables.channel[0] : variables.channel;
      const resolved = normalizeChannel(typeof raw === "string" ? raw : undefined, defaultChannel);
      const data = await charterData(resolved);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: charterText(data) }] };
    },
  );

  return server;
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  let defaultChannel: string | undefined;
  if (argv.length === 2 && argv[0] === "--channel") {
    defaultChannel = argv[1];
    if (!isSlug(defaultChannel)) {
      console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
      return 1;
    }
  } else if (argv.length > 0) {
    console.error("usage: party mcp [--channel C]");
    return 1;
  }
  const server = createMcpServer(defaultChannel);
  await server.connect(new StdioServerTransport());
  return new Promise<number>((resolve) => {
    process.stdin.on("close", () => resolve(0));
    process.stdin.on("end", () => resolve(0));
  });
}
