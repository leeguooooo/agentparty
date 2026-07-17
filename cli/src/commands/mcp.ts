// party mcp — stdio MCP server exposing AgentParty as structured tools.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MsgFrame, StatusState, TaskAssigneeKind, TaskState } from "@agentparty/shared";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { stripTerminalControls } from "../format";
import pkg from "../../package.json" with { type: "json" };
import {
  advanceCursorPastOwnMessage,
  clearStuck,
  loadCursor,
  loadRevCursor,
  loadStuck,
  markWatchDirectedStuckAccepted,
  resolveChannel,
  saveCursor,
  saveRevCursor,
  saveWatchStuck,
} from "../config";
import { jsonFrame } from "../json";
import { resolveAuth, resolveAuthDetailed } from "../oidc-cli";
import {
  createTask,
  fetchChannelCharter,
  fetchMe,
  fetchMessages,
  fetchPresence,
  fetchRecentMessages,
  fetchServerVersion,
  handleRestError,
  listChannels,
  listTasks,
  postMessage,
  spawnAgent,
  updateTask,
  type Identity,
} from "../rest";
import { serverVersionUpgradeNotice, upgradeNotice, type UpgradeDeps } from "../upgrade";
import { isName, isSlug } from "../validation";
import { askDecision } from "./decision";
import { uploadAttachmentPaths } from "./send";
import { buildContext } from "./status";
import { EXIT_ALREADY_WATCHING, runWatch } from "./watch";

const HELP = `usage: party mcp

Run an AgentParty stdio MCP server.

Boundary:
  MCP is a structured control plane. In Codex 0.144.4 and Claude Code 2.1.210
  probes, successful server notification sends did not create a new model turn
  after the harness became idle. A client may render a diagnostic event, but
  that is not a model-delivery guarantee. Use persistent directed delivery with
  party serve for unattended wake; never rely on MCP notifications alone.

Example (name the server per agent — a shared name like "party" lets agents in the
same directory overwrite each other's env-pinned identity):
  claude mcp add party-<agent-name> --env AGENTPARTY_CONFIG=<config.json> -- party mcp --channel <slug>

Tools:
  party_whoami
  party_charter
  party_channels
  party_send        (attach: upload local files as attachments)
  party_decision_ask
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
  party_ack         (clear a watch wake that needs no reply, #594)
  party_wake_test

Resources:
  party://charter               charter for the bound channel (--channel or cwd binding, 用前必读)
  party://{channel}/charter     charter for any channel by slug`;

const StateSchema = z.enum(["working", "waiting", "blocked", "done"]);
const TaskStateSchema = z.enum(["triage", "backlog", "assigned", "in_progress", "needs_review", "done", "blocked"]);
const TaskAssigneeKindSchema = z.enum(["agent", "human", "squad"]);

// MCP 客户端常把 content.text 直接在终端渲染，而异常消息、附件路径、chosen_option 等可能由
// 远端/用户控制。统一在 ok/fail 出口剥掉控制字符，防终端注入（structuredContent 是程序消费的
// JSON，不经此路径）。
function ok(data: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: stripTerminalControls(text ?? JSON.stringify(data, null, 2)) }],
    structuredContent: data,
  };
}

function fail(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: stripTerminalControls(message) }],
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

// MCP server 是长驻进程，#485 给 serve 做的升级闭环没有覆盖这里（#588）：磁盘 party 升级后
// 本进程仍是旧二进制，新注册的 party_* 工具不会出现；服务端发新版时旧进程同样不自知。
// 两层检测，提示挂在 whoami / watch_once 两个「重锚点」的结构化结果上：
//   a) 磁盘二进制 > 运行版（upgradeNotice）——命中即短路，零网络。MCP 语境下无需重装、
//      无需重新注册（注册命令按 PATH 解析 party），重启 harness 会话即可加载新版。
//      不做 serve 式 auto re-exec：stdio server 自杀会掐断 MCP 连接、丢掉在途工具调用。
//   b) 服务端 /api/version > 运行版（serverVersionUpgradeNotice）——10 分钟节流缓存；
//      探测失败（老 worker 无该端点、网络错）静默跳过，绝不为提示挡住或拖慢工具调用。
const SERVER_VERSION_PROBE_TTL_MS = 10 * 60_000;
let serverVersionProbe: { at: number; version: string | null } = { at: 0, version: null };

/** 测试缝隙：注入 UpgradeDeps 走磁盘路径、重置节流缓存。 */
export function resetServerVersionProbeForTest(): void {
  serverVersionProbe = { at: 0, version: null };
}

// MCP 语境的升级提示用自己的形状，不复用 CliUpgradeNotice 的 message/command——那套话术是
// serve 专属（「重启 serve」「auto re-exec」「重装命令」），在 MCP 场景是矛盾指令（磁盘已新
// 无需重装；重启对象是 harness 会话不是 serve）。保留 action_required=ask_user 让 runner
// 复用同一条询问用户的处理流；command 只在真有命令要跑时才给（server 路径的升级命令）。
export interface McpUpgradeNotice {
  running_version: string;
  available_version: string;
  /** 磁盘路径才有：已安装、等待会话重启加载的版本。 */
  installed_version?: string;
  source: "disk" | "server";
  action_required: "ask_user";
  message: string;
  /** 需要用户真的跑命令时才给（server 路径的安装/升级命令）；磁盘路径无命令可跑。 */
  command?: string;
}

// 服务端探测是可选增益：3 秒等不到就放弃本轮（缓存留空、下轮再试），
// 绝不让 whoami 被 rest 默认 30s 超时拖住。
const SERVER_VERSION_PROBE_TIMEOUT_MS = 3_000;

export async function mcpUpgradeNotice(
  server: string,
  deps: UpgradeDeps = {},
  options: { probe?: boolean } = {},
): Promise<McpUpgradeNotice | null> {
  const disk = upgradeNotice(false, deps);
  if (disk !== null) {
    return {
      running_version: disk.running_version,
      available_version: disk.available_version,
      ...(disk.installed_version !== undefined ? { installed_version: disk.installed_version } : {}),
      source: "disk",
      action_required: "ask_user",
      message:
        `party CLI on disk is already v${disk.available_version} while this MCP server still runs v${disk.running_version}. ` +
        "No reinstall and no re-registration needed (the MCP registration resolves `party` from PATH) — " +
        "ask the user to restart this harness session so the server respawns on the new binary.",
    };
  }
  // probe=false（watch_once 唤醒路径）只读缓存：唤醒 replay 是延迟敏感的极简路径（#551 的
  // 测试固定了它的请求数），版本探测只允许发生在 whoami 这类非关键调用里。
  const now = Date.now();
  if (options.probe !== false && now - serverVersionProbe.at > SERVER_VERSION_PROBE_TTL_MS) {
    serverVersionProbe = { at: now, version: null };
    try {
      serverVersionProbe.version = await Promise.race([
        fetchServerVersion(server).then((v) => v.version),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("probe timeout")), SERVER_VERSION_PROBE_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // 静默：升级提示是增益信号，不是墙。
    }
  }
  if (serverVersionProbe.version === null) return null;
  const notice = serverVersionUpgradeNotice(serverVersionProbe.version, deps);
  if (notice === null) return null;
  return {
    running_version: notice.running_version,
    available_version: notice.available_version,
    source: "server",
    action_required: "ask_user",
    message:
      `AgentParty server has published party CLI v${notice.available_version}; this MCP server still runs v${notice.running_version}. ` +
      "Ask the user to upgrade with the command below, then restart this harness session so the server respawns on the new binary — " +
      "do NOT re-register (the MCP registration resolves `party` from PATH).",
    command: notice.command,
  };
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
        const upgrade = await mcpUpgradeNotice(cfg.server);
        return ok({
          type: "me",
          server: cfg.server,
          cli_version: pkg.version,
          identity: me,
          protocol_reminder: reminder,
          ...(upgrade !== null ? { cli_upgrade: upgrade } : {}),
        });
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
        body: z.string().optional().describe("Message body. May be empty only when attaching."),
        mentions: z.array(z.string()).optional(),
        reply_to: z.number().int().positive().nullable().optional(),
        attach: z
          .array(z.string())
          .optional()
          .describe("Local file paths to upload as attachments (max 25MB each). Body may be empty only when attaching."),
      },
    },
    async ({ channel, body, mentions, reply_to, attach }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const normalizedMentions = normalizeMentions(mentions);
        const attachPaths = attach ?? [];
        const effectiveBody = body ?? "";
        // 与 CLI 语义对齐（#176）：纯附件消息允许空正文；无附件时正文必填。
        if (effectiveBody === "" && attachPaths.length === 0) {
          throw new Error("missing message body (pass body, or attach a file)");
        }
        // 附件复用 CLI --attach 的同一条 validate+read+upload 链路（#503），任一失败整体不发消息。
        const attachments =
          attachPaths.length > 0
            ? await uploadAttachmentPaths(cfg.server, cfg.token, resolved, attachPaths)
            : undefined;
        const { seq } = await postMessage(cfg.server, cfg.token, resolved, {
          kind: "message",
          body: effectiveBody,
          mentions: normalizedMentions,
          reply_to: reply_to ?? null,
          ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
        });
        advanceCursorPastOwnMessage(resolved, seq);
        return ok({
          type: "send",
          channel: resolved,
          seq,
          ...(attachments !== undefined
            ? { attachments: attachments.map((a) => ({ filename: a.filename, size: a.size, url: a.url })) }
            : {}),
        });
      } catch (e) {
        const code = handleRestError(e);
        return fail(code === 1 && e instanceof Error ? e.message : `send failed with exit ${code}`);
      }
    },
  );

  server.registerTool(
    "party_decision_ask",
    {
      title: "Ask the channel owner for a decision",
      description:
        "Ask the channel's human owner for a decision/approval (choice or approval). Use for permissions, trade-offs, and irreversible actions. Non-blocking: post and continue; a human resolves it later.",
      inputSchema: {
        channel: z.string().optional().describe("Channel slug. Defaults to the workspace-bound channel."),
        prompt: z.string().min(1).describe("One-line question / plan title."),
        options: z
          .array(z.string())
          .max(10)
          .optional()
          .describe("Choice options. Empty or absent makes it an approve/reject request."),
        mentions: z.array(z.string()).optional(),
        body: z.string().optional().describe("Plan body. Defaults to the prompt."),
      },
    },
    async ({ channel, prompt, options, mentions, body }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const normalizedMentions = normalizeMentions(mentions);
        // 业务核心与 `party decision ask` 完全同一份（askDecision，#503）；这里不提供 --wait 等价物：
        // MCP 工具不阻塞轮询，pending/waiting_owner 都交给人类 + serve/owner_answer 唤醒闭环。
        const result = await askDecision(cfg, resolved, { prompt, options, mentions: normalizedMentions, body });
        const data = {
          type: "decision",
          channel: resolved,
          seq: result.seq,
          state: result.state,
          ...(result.chosen_option !== undefined ? { chosen_option: result.chosen_option } : {}),
        };
        const hint =
          result.state === "auto_resolved"
            ? `decision #${result.seq} auto_resolved → ${result.chosen_option ?? "?"} (channel decision mode is unattended)`
            : `decision #${result.seq} posted (${result.state}) — a HUMAN resolves it; this tool does not wait. Check later with party_history, or the serve/owner-answer wake resumes the parked work. Do not busy-poll.`;
        return ok(data, hint);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
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
        external_ref: z
          .string()
          .optional()
          .describe(
            "Idempotency key (e.g. gh:owner/repo#96). Creating with a ref that already exists in the channel returns the existing task instead of a duplicate — safe to rerun an issue→task sync (#141).",
          ),
      },
    },
    async ({ channel, title, desc, state, assignee_name, assignee_kind, priority, labels, parent_id, anchor_seqs, workflow_id, external_ref }) => {
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
          ...(external_ref !== undefined ? { external_ref } : {}),
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
      description:
        "Actively wait until the next matching message arrives, then return its structured frame. The tool call must remain in flight; MCP notifications do not wake an idle model turn.",
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
        const stuck = loadStuck(resolved);
        if (stuck !== null && stuck.source !== "watch") {
          return fail(
            `#${resolved} has a pending serve wake at seq=${stuck.seq}; ` +
              "party_watch_once will not overwrite or replay that delivery debt. Resume the existing party serve supervisor first.",
          );
        }

        // Legacy raw watch debt and directed debt whose running transition was authoritatively ACKed
        // are safe to replay locally. Unconfirmed directed debt is not: the Worker may requeue it to
        // another adapter after lease expiry, so it must re-register and wait for a fresh claim below.
        if (
          stuck !== null &&
          (stuck.delivery_id === undefined || stuck.delivery_acceptance === "accepted")
        ) {
          const [pendingPage, tail] = await Promise.all([
            fetchMessages(cfg.server, cfg.token, resolved, Math.max(0, stuck.seq - 1), 1),
            fetchRecentMessages(cfg.server, cfg.token, resolved, 1),
          ]);
          const pending = pendingPage.find((message) => message.seq === stuck.seq);
          if (pending === undefined) {
            return fail(
              `pending watch wake seq=${stuck.seq} is no longer retained; debt was preserved. ` +
                "Inspect channel history before clearing or advancing this workspace state.",
            );
          }
          const replay = { ...stuck, attempts: stuck.attempts + 1 };
          if (!saveWatchStuck(resolved, replay)) {
            return fail(
              `#${resolved} acquired a pending serve wake while replaying seq=${stuck.seq}; ` +
                "party_watch_once preserved that debt and did not acknowledge this wake.",
            );
          }
          const channelLastSeq = Math.max(stuck.channel_last_seq ?? 0, tail.at(-1)?.seq ?? 0, pending.seq);
          const frame = jsonFrame({
            ...(pending as unknown as Record<string, unknown>),
            watch_replay: true,
            pending_ack: true,
            replay_attempt: replay.attempts,
            ...(stuck.delivery_id !== undefined ? { delivery_id: stuck.delivery_id } : {}),
            ...(stuck.work_id !== undefined ? { work_id: stuck.work_id } : {}),
            ...(stuck.continuation_ref !== undefined ? { continuation_ref: stuck.continuation_ref } : {}),
            ...(stuck.delivery_acceptance !== undefined
              ? { delivery_acceptance: stuck.delivery_acceptance }
              : {}),
            channel_last_seq: channelLastSeq,
            lag: Math.max(0, channelLastSeq - pending.seq),
            skipped_mention_seqs: stuck.skipped_mention_seqs ?? [],
          });
          // 唤醒返回帧＝一轮的起点：旧进程/旧版的升级提示在这里最可能被看见并转达 owner（#588）。
          // probe:false——唤醒路径零额外网络（磁盘检测 + whoami 已填充的缓存）。
          const replayUpgrade = await mcpUpgradeNotice(cfg.server, {}, { probe: false });
          return ok({
            type: "watch_once",
            channel: resolved,
            exit_code: 0,
            frames: [frame],
            ...(replayUpgrade !== null ? { cli_upgrade: replayUpgrade } : {}),
          });
        }

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
          // An unconfirmed directed debt takes priority over a caller's generic watch preference:
          // only the mention-only adapter may wait for the same work's fresh legal claim.
          mentionsOnly: stuck?.delivery_id !== undefined ? true : (mentions_only ?? true),
          json: true,
          onStuck: (next) => {
            if (!saveWatchStuck(resolved, next)) {
              throw new Error(
                `#${resolved} has a pending serve wake; party_watch_once did not overwrite that delivery debt`,
              );
            }
          },
          onDirectedAccepted: (deliveryId) => markWatchDirectedStuckAccepted(resolved, deliveryId),
          onCursor: (c) => saveCursor(resolved, c),
          onRevCursor: (r) => saveRevCursor(resolved, r),
          out: (line) => lines.push(line),
        });
        const frames = lines.map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            // json 模式下仍可能混入人类可读提示（如单实例冲突）；保留为文本帧，别让整个结果炸掉。
            return { type: "text", text: line };
          }
        });
        // #596：单 watcher 冲突对 MCP 调用方是可编程状态，不是不可解析的散文。
        if (code === EXIT_ALREADY_WATCHING) {
          return {
            ...fail(
              `another watcher already holds #${resolved} (likely a CLI \`party watch\` in a terminal). ` +
                "Wait for it to exit or kill it; a second concurrent watcher would double-fire every @.",
            ),
            structuredContent: { type: "watch_once", channel: resolved, exit_code: code, reason: "watcher_conflict", frames },
          };
        }
        // 同 replay 路径：唤醒返回帧带缓存化的升级提示（probe:false，零额外网络）。
        const liveUpgrade = await mcpUpgradeNotice(cfg.server, {}, { probe: false });
        const data = {
          type: "watch_once",
          channel: resolved,
          exit_code: code,
          frames,
          ...(liveUpgrade !== null ? { cli_upgrade: liveUpgrade } : {}),
        };
        return code === 0 ? ok(data) : { ...fail(lines.join("\n") || `watch_once failed with exit ${code}`), structuredContent: data };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_ack",
    {
      title: "Acknowledge a watch wake that needs no reply",
      description:
        "Clear the pending watch wake debt without posting a message (#594). Use after party_watch_once delivered a frame that warrants no reply — replying with empty acks burns the loop guard; leaving the debt makes every later watch replay the same frame. Serve-owned debt is never touched.",
      inputSchema: {
        channel: z.string().optional().describe("Channel slug. Defaults to the workspace-bound channel."),
        seq: z.number().int().positive().optional().describe("Only ack if the pending debt is exactly this seq."),
      },
    },
    async ({ channel, seq }) => {
      try {
        const resolved = normalizeChannel(channel, defaultChannel);
        const stuck = loadStuck(resolved);
        if (stuck === null) return ok({ type: "ack", channel: resolved, acked: false, note: "no pending wake debt" });
        if (stuck.source !== "watch") {
          return fail(
            `refusing to ack: pending debt at seq=${stuck.seq} is owned by party serve (source=${stuck.source}); ` +
              "serve replays it durably — clearing it by hand would silently drop that @",
          );
        }
        if (seq !== undefined && stuck.seq !== seq) {
          return fail(`refusing to ack: pending watch debt is seq=${stuck.seq}, not seq=${seq}`);
        }
        clearStuck(resolved);
        return ok({ type: "ack", channel: resolved, acked: true, seq: stuck.seq });
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
  // #596：stdio 模式下 stdout 是 JSON-RPC 信道。任何库/命令路径的 console.log（如 watch 的
  // 单实例冲突提示）落到 stdout 都会把客户端的解析打碎成 "JSON Parse error"。统一改道 stderr。
  console.log = (...args: unknown[]) => console.error(...args);
  const server = createMcpServer(defaultChannel);
  await server.connect(new StdioServerTransport());
  return new Promise<number>((resolve) => {
    process.stdin.on("close", () => resolve(0));
    process.stdin.on("end", () => resolve(0));
  });
}
