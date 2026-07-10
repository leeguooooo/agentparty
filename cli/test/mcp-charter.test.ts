import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { workspaceId } from "../src/config";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let restServer: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-mcp-charter-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restServer?.stop(true);
  restServer = null;
});

function startRest(): void {
  restServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/channels/dev/charter" && req.method === "GET") {
        return Response.json({
          charter: "Scope: reproduce the IM issue. Do not touch prod.",
          charter_rev: 7,
          updated_at: 123,
          updated_by: "host",
        });
      }
      if (url.pathname === "/api/channels/other/charter" && req.method === "GET") {
        return Response.json({ charter: "OTHER scope", charter_rev: 9, updated_at: 1, updated_by: "host" });
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
}

// cwd 绑定：写 state.json（party init --channel 落盘的位置），让不带 --channel 的
// `party mcp` 也能 resolveChannel 到 dev。
function bindCwdChannel(channel: string): void {
  const sp = join(home, "state", workspaceId(process.cwd()), "state.json");
  mkdirSync(dirname(sp), { recursive: true });
  writeFileSync(sp, JSON.stringify({ channel, cursor: 0 }));
}

async function connect(channelFlag?: string): Promise<Client> {
  // 别继承真实环境的 AGENTPARTY_CONFIG 指针，否则 state 路径漂走；顺便过滤 undefined 值。
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "AGENTPARTY_CONFIG") env[k] = v;
  }
  env.AGENTPARTY_HOME = home;
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", indexPath, "mcp", ...(channelFlag ? ["--channel", channelFlag] : [])],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "agentparty-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function reminderOf(structuredContent: unknown): string {
  const rec = structuredContent as { protocol_reminder?: unknown } | null;
  return typeof rec?.protocol_reminder === "string" ? rec.protocol_reminder : "";
}

// #134/#136: the MCP接入路径 must be able to read the channel charter —
// both as an explicit tool AND as a machine-discoverable resource.
describe("mcp charter surface", () => {
  test("exposes party_charter tool and party://charter resource（#134/#136）", async () => {
    startRest();
    const client = await connect("dev");
    try {
      // 1) party_charter tool exists and returns the charter body + rev.
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("party_charter");
      const charter = await client.callTool({ name: "party_charter", arguments: {} });
      expect(charter.isError).not.toBe(true);
      expect(charter.structuredContent).toMatchObject({
        type: "charter",
        channel: "dev",
        charter: "Scope: reproduce the IM issue. Do not touch prod.",
        charter_rev: 7,
      });

      // 2) charter is discoverable as an MCP resource (resources/list is non-empty).
      const resources = await client.listResources();
      const charterResource = resources.resources.find((r) => r.uri === "party://charter");
      expect(charterResource).toBeDefined();

      // 3) reading the resource returns the charter markdown.
      const read = await client.readResource({ uri: "party://charter" });
      expect(JSON.stringify(read.contents)).toContain("reproduce the IM issue");

      // 4) whoami nudges reading the charter first (first-screen context).
      const whoami = await client.callTool({ name: "party_whoami", arguments: {} });
      expect(reminderOf(whoami.structuredContent)).toContain("party://charter");
    } finally {
      await client.close();
    }
  }, 20000);

  // 反例回炉（PR #224 P2）：cwd 已绑定频道、启动不传 --channel 时，
  // 资源注册与 whoami 提示必须与 party_charter 工具走同一条频道解析路径。
  test("registers party://charter from cwd binding when no --channel flag（#224 P2）", async () => {
    startRest();
    bindCwdChannel("dev");
    const client = await connect(); // 注意：不传 --channel
    try {
      // 工具能读（此前已可）。
      const charter = await client.callTool({ name: "party_charter", arguments: {} });
      expect(charter.isError).not.toBe(true);
      expect(charter.structuredContent).toMatchObject({ type: "charter", channel: "dev", charter_rev: 7 });

      // 资源也必须注册——这正是被打回的缺口。
      const resources = await client.listResources();
      expect(resources.resources.find((r) => r.uri === "party://charter")).toBeDefined();
      const read = await client.readResource({ uri: "party://charter" });
      expect(JSON.stringify(read.contents)).toContain("reproduce the IM issue");

      // whoami 提示指向真实存在的资源。
      const whoami = await client.callTool({ name: "party_whoami", arguments: {} });
      expect(reminderOf(whoami.structuredContent)).toContain("party://charter");
    } finally {
      await client.close();
    }
  }, 20000);

  // 既无 flag 也无 cwd 绑定：不能凭空注册 concrete 资源，whoami 也不能指向不存在的 party://charter，
  // 而应引导到模板 party://{channel}/charter。
  test("without any bound channel, whoami points to the template, not a missing resource（#224 P2）", async () => {
    startRest(); // 不 bindCwdChannel，不传 --channel
    const client = await connect();
    try {
      const resources = await client.listResources();
      expect(resources.resources.find((r) => r.uri === "party://charter")).toBeUndefined();

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain("party://{channel}/charter");

      const whoami = await client.callTool({ name: "party_whoami", arguments: {} });
      const reminder = reminderOf(whoami.structuredContent);
      expect(reminder).not.toContain("party://charter"); // 不指向不存在的 concrete 资源
      expect(reminder).toContain("party://{channel}/charter"); // 指向模板
    } finally {
      await client.close();
    }
  }, 20000);

  // 第三处同形状不一致（LEO-MAIN followup）：resources/list 与 whoami 提示在启动时静态绑定，
  // 无法热更新；party_charter 工具若每次调用重解析 cwd 绑定，运行中 rebind 就会让工具漂到新频道、
  // 而资源/提示仍指旧频道，两条路径对「我在哪个频道」给出不同答案且都不报错。工具的默认频道必须
  // 恒等于启动时的 boundChannel（显式传 channel 参数仍优先）。
  test("party_charter without arg stays on the startup-bound channel even after cwd rebind（#224 P2 followup）", async () => {
    startRest();
    bindCwdChannel("dev");
    const client = await connect(); // 无 --channel；启动时 boundChannel = dev
    try {
      // 运行中有人把 cwd 绑定改到 other（模拟 party init --channel other）。
      bindCwdChannel("other");

      // 不传 channel 参数：必须仍返回启动时那个频道 dev，而非漂到 other。
      const charter = await client.callTool({ name: "party_charter", arguments: {} });
      expect(charter.isError).not.toBe(true);
      expect(charter.structuredContent).toMatchObject({ type: "charter", channel: "dev", charter_rev: 7 });

      // 显式传 channel 参数仍然优先——不牺牲「读任意频道」的能力。
      const explicit = await client.callTool({ name: "party_charter", arguments: { channel: "other" } });
      expect(explicit.isError).not.toBe(true);
      expect(explicit.structuredContent).toMatchObject({ type: "charter", channel: "other", charter_rev: 9 });
    } finally {
      await client.close();
    }
  }, 20000);
});
