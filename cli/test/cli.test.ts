// 子进程级冒烟：真实 argv 路由 + 退出码
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceId } from "../src/config";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let server: MockServer | null = null;
let restServer: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  server?.stop();
  server = null;
  restServer?.stop(true);
  restServer = null;
});

async function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv: Record<string, string | undefined> = { ...process.env, AGENTPARTY_HOME: home };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("cli subprocess", () => {
  test("--help exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("party <command>");
  });

  test("non-json subcommands support --help without auth or config", async () => {
    const commands = [
      "init",
      "send",
      "status",
      "channel",
      "invite",
      "webhook",
      "token",
      "login",
      "logout",
      "agent",
      "serve",
      "mcp",
      "lark",
      "task",
      "board",
      "squad",
      "charter",
      "statusline",
    ];
    for (const cmd of commands) {
      const r = await runCli([cmd, "--help"]);
      expect(r.code, cmd).toBe(0);
      expect(r.stdout, cmd).toContain(`usage: party ${cmd}`);
      expect(r.stderr, cmd).toBe("");
    }
  });

  test("board renders channel task ledger as JSON", async () => {
    const seen: { method: string; path: string; auth: string | null }[] = [];
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ method: req.method, path: `${url.pathname}${url.search}`, auth: req.headers.get("authorization") });
        if (url.pathname === "/api/me") {
          return Response.json({ name: "worker-a", email: null, kind: "agent", role: "agent", owner: null });
        }
        if (url.pathname === "/api/channels/dev/tasks" && req.method === "GET") {
          return Response.json({
            tasks: [
              {
                type: "task",
                id: 1,
                channel: "dev",
                title: "Ship task board",
                desc: null,
                state: "in_progress",
                assignee: { name: "worker-a", kind: "agent" },
                created_by: "lead",
                created_by_kind: "human",
                priority: 1,
                labels: ["ui"],
                parent_id: null,
                anchor_seqs: [],
                completion_artifact: null,
                workflow_id: null,
                created_at: 1,
                updated_at: 1,
              },
            ],
          });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );
    const result = await runCli(["board", "dev", "--mine", "--json"]);
    expect(result.code).toBe(0);
    const frame = JSON.parse(result.stdout) as { type: string; channel: string; active: number; columns: { state: string; count: number }[] };
    expect(frame.type).toBe("board");
    expect(frame.channel).toBe("dev");
    expect(frame.active).toBe(1);
    expect(frame.columns.find((column) => column.state === "in_progress")?.count).toBe(1);
    expect(seen).toContainEqual(expect.objectContaining({ method: "GET", path: "/api/me", auth: "Bearer ap_tok" }));
    expect(seen).toContainEqual(expect.objectContaining({ method: "GET", path: "/api/channels/dev/tasks?assignee=worker-a&limit=200", auth: "Bearer ap_tok" }));
  });

  test("json-capable subcommands support --help without auth or config", async () => {
    for (const cmd of ["whoami", "watch", "history", "digest", "wake"]) {
      const r = await runCli([cmd, "--help"]);
      expect(r.code, cmd).toBe(0);
      expect(r.stdout, cmd).toContain(`usage: party ${cmd}`);
      expect(r.stderr, cmd).toBe("");
    }
  });

  test("--version 输出非空版本号并 exit 0", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("mcp server lists tools and sends via REST（#66）", async () => {
    const seen: { method: string; path: string; auth: string | null; body: unknown }[] = [];
    const task = {
      type: "task",
      id: 1,
      channel: "dev",
      title: "Fix login",
      desc: null,
      state: "triage",
      assignee: null,
      created_by: "me",
      created_by_kind: "agent",
      priority: 2,
      labels: ["bug"],
      parent_id: null,
      anchor_seqs: [7],
      completion_artifact: null,
      workflow_id: null,
      created_at: 1,
      updated_at: 1,
    };
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        let body: unknown = null;
        if (req.method !== "GET") {
          body = await req.json().catch(() => null);
        }
        seen.push({ method: req.method, path: `${url.pathname}${url.search}`, auth: req.headers.get("authorization"), body });
        if (url.pathname === "/api/channels/dev/messages" && req.method === "POST") {
          return Response.json({ seq: 42 });
        }
        if (url.pathname === "/api/channels/dev/messages" && req.method === "GET") {
          return Response.json({
            messages: [
              {
                type: "msg",
                channel: "dev",
                seq: 7,
                ts: 1,
                sender: { name: "evan", kind: "human" },
                kind: "message",
                body: "Fix login from message",
                mentions: [],
                reply_to: null,
              },
            ],
          });
        }
        if (url.pathname === "/api/channels/dev/tasks" && req.method === "GET") {
          return Response.json({ tasks: [task] });
        }
        if (url.pathname === "/api/channels/dev/tasks" && req.method === "POST") {
          return Response.json(task, { status: 201 });
        }
        if (url.pathname === "/api/channels/dev/tasks/1" && req.method === "PATCH") {
          return Response.json({ ...task, ...(body && typeof body === "object" ? body : {}) });
        }
        if (url.pathname === "/api/spawn" && req.method === "POST") {
          return Response.json({
            token: "ap_child",
            name: "worker-a",
            role: "agent",
            owner: "me",
            channel_scope: "dev",
            lineage: { parent_agent: "me", root_agent: "me", depth: 1, team_id: "team-a", expires_at: 1234 },
            expires_at: 1234,
          });
        }
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );

    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "mcp", "--channel", "dev"],
      env: { ...process.env, AGENTPARTY_HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("party_send");
      expect(tools.tools.map((tool) => tool.name)).toContain("party_watch_once");
      expect(tools.tools.map((tool) => tool.name)).toContain("party_task_create");
      expect(tools.tools.map((tool) => tool.name)).toContain("party_task_from_message");
      expect(tools.tools.map((tool) => tool.name)).toContain("party_task_list");
      expect(tools.tools.map((tool) => tool.name)).toContain("party_task_update");
      expect(tools.tools.map((tool) => tool.name)).toContain("task_list");
      expect(tools.tools.map((tool) => tool.name)).toContain("task_claim");
      expect(tools.tools.map((tool) => tool.name)).toContain("task_status");
      expect(tools.tools.map((tool) => tool.name)).toContain("task_complete");
      expect(tools.tools.map((tool) => tool.name)).toContain("task_block");
      expect(tools.tools.map((tool) => tool.name)).toContain("party_spawn_worker");

      const result = await client.callTool({
        name: "party_send",
        arguments: { body: "hello mcp", mentions: ["bob"] },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ type: "send", channel: "dev", seq: 42 });
      expect(seen).toContainEqual(expect.objectContaining({
        method: "POST",
        path: "/api/channels/dev/messages",
        auth: "Bearer ap_tok",
        // body 还带一个随机 idempotency_key（#98），故用 objectContaining 容忍它
        body: expect.objectContaining({ kind: "message", body: "hello mcp", mentions: ["bob"], reply_to: null }),
      }));

      const created = await client.callTool({
        name: "party_task_create",
        arguments: { title: "Fix login", labels: ["bug"], priority: 2, anchor_seqs: [7] },
      });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({ type: "task_create", channel: "dev", task: { id: 1 } });

      const fromMessage = await client.callTool({
        name: "party_task_from_message",
        arguments: { source_seq: 7, labels: ["bug"] },
      });
      expect(fromMessage.isError).not.toBe(true);
      expect(fromMessage.structuredContent).toMatchObject({ type: "task_from_message", source_seq: 7, task: { id: 1 } });

      const listed = await client.callTool({
        name: "party_task_list",
        arguments: { state: "triage", assignee: "@alice" },
      });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({ type: "task_list", channel: "dev", tasks: [{ id: 1 }] });

      const updated = await client.callTool({
        name: "party_task_update",
        arguments: { id: 1, state: "assigned", assignee_name: "@alice" },
      });
      expect(updated.isError).not.toBe(true);
      expect(updated.structuredContent).toMatchObject({ type: "task_update", task: { id: 1, state: "assigned" } });

      const boardList = await client.callTool({
        name: "task_list",
        arguments: { state: "assigned", assignee: "alice", limit: 10 },
      });
      expect(boardList.isError).not.toBe(true);
      expect(boardList.structuredContent).toMatchObject({ type: "task_list", channel: "dev", tasks: [{ id: 1 }] });

      const claimed = await client.callTool({
        name: "task_claim",
        arguments: { id: 1 },
      });
      expect(claimed.isError).not.toBe(true);
      expect(claimed.structuredContent).toMatchObject({ type: "task_claim", task: { id: 1, state: "in_progress" } });

      const taskStatus = await client.callTool({
        name: "task_status",
        arguments: { id: 1, state: "needs_review" },
      });
      expect(taskStatus.isError).not.toBe(true);
      expect(taskStatus.structuredContent).toMatchObject({ type: "task_status", task: { id: 1, state: "needs_review" } });

      const taskComplete = await client.callTool({
        name: "task_complete",
        arguments: { id: 1 },
      });
      expect(taskComplete.isError).not.toBe(true);
      expect(taskComplete.structuredContent).toMatchObject({ type: "task_complete", task: { id: 1, state: "done" } });

      const taskBlock = await client.callTool({
        name: "task_block",
        arguments: { id: 1 },
      });
      expect(taskBlock.isError).not.toBe(true);
      expect(taskBlock.structuredContent).toMatchObject({ type: "task_block", task: { id: 1, state: "blocked" } });

      const status = await client.callTool({
        name: "party_status",
        arguments: { state: "working", note: "started", task_id: 1 },
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ type: "status", task: { id: 1, state: "in_progress" } });

      const spawned = await client.callTool({
        name: "party_spawn_worker",
        arguments: { name: "worker-a", ttl_sec: 3600, team_id: "team-a" },
      });
      expect(spawned.isError).not.toBe(true);
      expect(spawned.structuredContent).toMatchObject({ type: "spawn_worker", channel: "dev", worker: { name: "worker-a", channel_scope: "dev" } });

      expect(seen).toContainEqual(expect.objectContaining({
        method: "POST",
        path: "/api/channels/dev/tasks",
        body: { title: "Fix login", priority: 2, labels: ["bug"], anchor_seqs: [7] },
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "GET",
        path: "/api/channels/dev/messages?since=6&limit=1",
        body: null,
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "POST",
        path: "/api/channels/dev/tasks",
        body: { title: "Fix login from message", labels: ["bug"], anchor_seqs: [7] },
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "GET",
        path: "/api/channels/dev/tasks?state=triage&assignee=alice",
        body: null,
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "GET",
        path: "/api/channels/dev/tasks?state=assigned&assignee=alice&limit=10",
        body: null,
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "PATCH",
        path: "/api/channels/dev/tasks/1",
        body: { state: "assigned", assignee: { name: "alice", kind: "agent" } },
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "PATCH",
        path: "/api/channels/dev/tasks/1",
        body: { state: "in_progress" },
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "PATCH",
        path: "/api/channels/dev/tasks/1",
        body: { state: "needs_review" },
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "PATCH",
        path: "/api/channels/dev/tasks/1",
        body: { state: "done" },
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "PATCH",
        path: "/api/channels/dev/tasks/1",
        body: { state: "blocked" },
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "POST",
        path: "/api/channels/dev/messages",
        // body 还带一个随机 idempotency_key（#98），故用 objectContaining 容忍它
        body: expect.objectContaining({ kind: "status", state: "working", note: "started", mentions: [], scope: ["task:1"], context: expect.any(Object) }),
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "PATCH",
        path: "/api/channels/dev/tasks/1",
        body: { state: "in_progress" },
      }));
      expect(seen).toContainEqual(expect.objectContaining({
        method: "POST",
        path: "/api/spawn",
        body: { name: "worker-a", channel_scope: "dev", ttl_sec: 3600, team_id: "team-a" },
      }));
    } finally {
      await client.close();
    }
  }, 15_000);

  test("task command creates, lists, and assigns through REST", async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const tasks = [
      {
        type: "task",
        id: 1,
        channel: "dev",
        title: "Fix login",
        desc: null,
        state: "triage",
        assignee: null,
        created_by: "me",
        created_by_kind: "agent",
        priority: 2,
        labels: ["bug"],
        parent_id: null,
        anchor_seqs: [7],
        completion_artifact: null,
        workflow_id: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? null : await req.json().catch(() => null);
        seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
        if (url.pathname === "/api/channels/dev/tasks" && req.method === "POST") {
          return Response.json(tasks[0], { status: 201 });
        }
        if (url.pathname === "/api/channels/dev/tasks" && req.method === "GET") {
          return Response.json({ tasks });
        }
        if (url.pathname === "/api/channels/dev/tasks/1" && req.method === "PATCH") {
          return Response.json({ ...tasks[0], state: "assigned", assignee: { name: "alice", kind: "agent" } });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );

    const create = await runCli(["task", "create", "Fix login", "--channel", "dev", "--label", "bug", "--priority", "2", "--anchor", "7"]);
    expect(create.code).toBe(0);
    expect(create.stdout).toContain("created #1");

    const list = await runCli(["task", "list", "--channel", "dev", "--state", "triage"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("#1\ttriage");

    const assign = await runCli(["task", "assign", "1", "@alice", "--channel", "dev"]);
    expect(assign.code).toBe(0);
    expect(assign.stdout).toContain("@alice");

    expect(seen).toContainEqual({
      method: "POST",
      path: "/api/channels/dev/tasks",
      body: { title: "Fix login", priority: 2, labels: ["bug"], anchor_seqs: [7] },
    });
    expect(seen).toContainEqual({ method: "GET", path: "/api/channels/dev/tasks?state=triage", body: null });
    expect(seen).toContainEqual({
      method: "PATCH",
      path: "/api/channels/dev/tasks/1",
      body: { state: "assigned", assignee: { name: "alice", kind: "agent" } },
    });
  });

  test("task from creates a task anchored to the source message", async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const task = {
      type: "task",
      id: 2,
      channel: "dev",
      title: "Investigate login timeout with traces",
      desc: "needs owner",
      state: "triage",
      assignee: null,
      created_by: "me",
      created_by_kind: "agent",
      priority: 0,
      labels: ["bug"],
      parent_id: null,
      anchor_seqs: [7],
      completion_artifact: null,
      workflow_id: null,
      created_at: 1,
      updated_at: 1,
    };
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? null : await req.json().catch(() => null);
        seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
        if (url.pathname === "/api/channels/dev/messages" && req.method === "GET") {
          return Response.json({
            messages: [
              {
                type: "msg",
                channel: "dev",
                seq: 7,
                ts: 1,
                sender: { name: "evan", kind: "human" },
                kind: "message",
                body: "Investigate login timeout\nwith traces",
                mentions: [],
                reply_to: null,
              },
            ],
          });
        }
        if (url.pathname === "/api/channels/dev/tasks" && req.method === "POST") {
          return Response.json(task, { status: 201 });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );

    const result = await runCli(["task", "from", "7", "--channel", "dev", "--label", "bug", "--desc", "needs owner"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("created #2");

    expect(seen).toContainEqual({ method: "GET", path: "/api/channels/dev/messages?since=6&limit=1", body: null });
    expect(seen).toContainEqual({
      method: "POST",
      path: "/api/channels/dev/tasks",
      body: {
        title: "Investigate login timeout with traces",
        desc: "needs owner",
        labels: ["bug"],
        anchor_seqs: [7],
      },
    });
  });

  test("squad command creates, lists, updates, and deletes through REST", async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const squad = {
      type: "squad",
      channel: "dev",
      name: "frontend",
      title: "Frontend",
      description: null,
      leader: "alice",
      members: ["alice", "bob"],
      created_by: "me",
      created_by_kind: "agent",
      created_at: 1,
      updated_at: 1,
    };
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
        seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
        if (url.pathname === "/api/channels/dev/squads" && req.method === "POST") {
          return Response.json(squad, { status: 201 });
        }
        if (url.pathname === "/api/channels/dev/squads" && req.method === "GET") {
          return Response.json({ squads: [squad] });
        }
        if (url.pathname === "/api/channels/dev/squads/frontend" && req.method === "PATCH") {
          return Response.json({ ...squad, leader: "bob", members: ["bob"] });
        }
        if (url.pathname === "/api/channels/dev/squads/frontend" && req.method === "DELETE") {
          return Response.json({ ok: true, squad });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );

    const create = await runCli(["squad", "create", "frontend", "--channel", "dev", "--member", "alice", "--member", "bob", "--leader", "alice", "--title", "Frontend"]);
    expect(create.code).toBe(0);
    expect(create.stdout).toContain("created @frontend");

    const list = await runCli(["squad", "list", "--channel", "dev"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("@frontend");

    const update = await runCli(["squad", "update", "frontend", "--channel", "dev", "--member", "bob", "--leader", "bob"]);
    expect(update.code).toBe(0);
    expect(update.stdout).toContain("leader:@bob");

    const del = await runCli(["squad", "delete", "frontend", "--channel", "dev"]);
    expect(del.code).toBe(0);
    expect(del.stdout).toContain("deleted @frontend");

    expect(seen).toContainEqual({
      method: "POST",
      path: "/api/channels/dev/squads",
      body: { name: "frontend", members: ["alice", "bob"], leader: "alice", title: "Frontend" },
    });
    expect(seen).toContainEqual({ method: "GET", path: "/api/channels/dev/squads", body: null });
    expect(seen).toContainEqual({
      method: "PATCH",
      path: "/api/channels/dev/squads/frontend",
      body: { members: ["bob"], leader: "bob" },
    });
    expect(seen).toContainEqual({ method: "DELETE", path: "/api/channels/dev/squads/frontend", body: null });
  });

  test("charter template works without config", async () => {
    const r = await runCli(["charter", "template"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("# 本频道用前必读");
  });

  test("unknown command exits 1", async () => {
    const r = await runCli(["nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command");
  });

  test("watch without config exits 1", async () => {
    const r = await runCli(["watch", "dev", "--timeout", "1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no config");
  });

  test("watch help documents explicit --latest and --since cursor choices", async () => {
    const r = await runCli(["watch", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--latest");
    expect(r.stdout).toContain("--since seq");
  });

  test("watch rejects --latest with --since before auth or network access", async () => {
    const r = await runCli(["watch", "dev", "--latest", "--since", "4"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--latest and --since are mutually exclusive");
    expect(r.stderr).not.toContain("no config");
  });

  test("watch timeout exits 2 and prints TIMEOUT", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    const r = await runCli(["watch", "dev", "--timeout", "1"]);
    expect(r.code).toBe(2);
    expect(r.stdout.trim()).toBe("TIMEOUT");
  }, 15_000);

  test("watch accepts --exclude-self as an explicit no-op flag", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    const r = await runCli(["watch", "dev", "--exclude-self", "--timeout", "1"]);
    expect(r.code).toBe(2);
    expect(r.stdout.trim()).toBe("TIMEOUT");
    expect(r.stderr).toBe("");
  }, 15_000);

  test("watch --follow 把假在线警告发到 stderr，stdout 流不受污染（#55/#60）", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    const r = await runCli(["watch", "dev", "--follow", "--mentions-only", "--timeout", "1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--once");
    expect(r.stderr).toContain("party wake test");
    expect(r.stdout).not.toContain("party wake test");
  }, 15_000);

  test("watch --once 在 Codex 环境下警告不能当作 wake 层（#65）", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0, "me"));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    // 真正模拟 Codex 环境：剥掉测试宿主（可能是 Claude Code）的 harness 标记，否则
    // 子进程继承 CLAUDECODE，isCodexRuntimeEnv 会短路（#175），警告就不打了。
    const clearClaudeCode = Object.fromEntries(
      Object.keys(process.env)
        .filter((k) => k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_"))
        .map((k) => [k, undefined as string | undefined]),
    );
    const r = await runCli(
      ["watch", "dev", "--once", "--mentions-only", "--since", "0", "--timeout", "1"],
      { ...clearClaudeCode, CODEX_CI: "1" },
    );
    expect(r.code).toBe(2);
    expect(r.stdout.trim()).toBe("TIMEOUT");
    expect(r.stderr).toContain("Codex CLI does not resume");
    expect(r.stderr).toContain("party serve");
    expect(r.stderr).toContain("party wake test");
  }, 15_000);

  test("watch --once 在 Claude Code 下明确是回合级等待，不得宣称耐久 presence（#454）", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0, "me"));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: server.url, token: "ap_tok" }));
    const r = await runCli(
      ["watch", "dev", "--once", "--mentions-only", "--since", "0", "--timeout", "1"],
      { CLAUDECODE: "1", CODEX_CI: undefined },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("turn boundary");
    expect(r.stderr).toContain("--runner claude");
    expect(r.stderr).not.toContain("Codex CLI does not resume");
  }, 15_000);

  test("watch --once 成功后提醒这是一次性 watcher 且不污染 stdout（#65）", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0, "me"));
        setTimeout(() => sock.send(msgFrame(1, "@me wake", { sender: { name: "bob", kind: "human" }, mentions: ["me"] })), 20);
      }
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    const r = await runCli(["watch", "dev", "--once", "--mentions-only", "--since", "0", "--timeout", "2"], { CODEX_CI: undefined });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("[1] bob(human): @me wake");
    expect(r.stderr).toContain("--once is single-shot");
    expect(r.stdout).not.toContain("--once is single-shot");
  }, 15_000);

  test("watch --channel 优先于绑定频道", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ channel: "dev", cursor: 0 }));

    const r = await runCli(["watch", "--channel", "ops", "--timeout", "1"]);
    expect(r.code).toBe(2);
    expect(server.paths).toContain("/api/channels/ops/ws");
    expect(server.paths).not.toContain("/api/channels/dev/ws");
  }, 15_000);

  test("watch --channel 缺值不会回退到绑定频道", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ channel: "dev", cursor: 0 }));

    const r = await runCli(["watch", "--channel", "--timeout", "1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--channel requires a value");
    expect(server.paths).toHaveLength(0);
  });

  test("watch --timeout 必须是正整数，不会进入阻塞连接", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    for (const value of ["0", "-1", "1.5", "2147484"]) {
      const r = await runCli(["watch", "dev", "--timeout", value]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--timeout must be (a positive integer|<=)/);
    }
    expect(server.paths).toHaveLength(0);
  });
});
