// #588：party mcp 是长驻进程，磁盘/服务端升级后旧 server 必须能自知并给出可执行指引。
// 单测走 mcpUpgradeNotice 的 deps 注入（磁盘路径、零网络）；集成测走真 MCP stdio server +
// mock /api/version（服务端路径 + 节流）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpUpgradeNotice, resetServerVersionProbeForTest } from "../src/commands/mcp";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

describe("mcpUpgradeNotice 磁盘路径（deps 注入，零网络）", () => {
  test("磁盘二进制更新 → 短路返回 restart 指引，不打服务端", async () => {
    const notice = await mcpUpgradeNotice("http://127.0.0.1:9", {
      runningVersion: "0.2.100",
      execPath: "/usr/local/bin/party",
      readInstalledVersion: () => "0.2.101",
    });
    expect(notice).not.toBeNull();
    expect(notice!.source).toBe("disk");
    expect(notice!.installed_version).toBe("0.2.101");
    expect(notice!.running_version).toBe("0.2.100");
    // MCP 专属话术全部收敛进 message，不再继承 serve 的「重启 serve / 重装」矛盾指令；
    // 磁盘路径没有可跑的命令——command 必须缺席，否则 runner 会把安装命令当必要步骤。
    expect(notice!.message).toContain("No reinstall and no re-registration needed");
    expect(notice!.message).toContain("restart this harness session");
    expect(notice!.message).not.toMatch(/\bserve\b/); // serve 专属话术不得渗入（“server” 不算）
    expect(notice!.command).toBeUndefined();
  });

  test("磁盘与运行版一致且服务端不可达 → null（静默，不因提示报错）", async () => {
    resetServerVersionProbeForTest();
    const notice = await mcpUpgradeNotice("http://127.0.0.1:9", {
      runningVersion: "0.2.100",
      execPath: "/usr/local/bin/party",
      readInstalledVersion: () => "0.2.100",
    });
    expect(notice).toBeNull();
  });
});

describe("party mcp 服务端版本路径（真 stdio server + mock /api/version）", () => {
  let home: string;
  let restServer: ReturnType<typeof Bun.serve> | null = null;
  let versionHits = 0;
  let serverVersion = "9.9.9";

  function startRest(): void {
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
        }
        if (url.pathname === "/api/version") {
          versionHits += 1;
          return Response.json({
            version: serverVersion,
            commit: "deadbeef",
            deployed_at: null,
            min_client_version: "0.0.0",
            min_client_enforced: false,
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
  }

  async function connect(): Promise<Client> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "AGENTPARTY_CONFIG") env[k] = v;
    }
    env.AGENTPARTY_HOME = home;
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "mcp", "--channel", "dev"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-mcp-upgrade-"));
    versionHits = 0;
    serverVersion = "9.9.9";
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    restServer?.stop(true);
    restServer = null;
  });

  test("服务端已发新版 → whoami 带 cli_upgrade + mcp_note；节流让两次调用只探测一次", async () => {
    startRest();
    const client = await connect();
    try {
      const r1 = await client.callTool({ name: "party_whoami", arguments: {} });
      expect(r1.isError).not.toBe(true);
      const c1 = r1.structuredContent as { cli_version?: string; cli_upgrade?: Record<string, unknown> };
      expect(typeof c1.cli_version).toBe("string");
      expect(c1.cli_upgrade).toBeDefined();
      expect(c1.cli_upgrade!.available_version).toBe("9.9.9");
      expect(c1.cli_upgrade!.source).toBe("server");
      // server 路径的三件套必须互不矛盾：message 讲清升级+重启会话+不重注册，command 是
      // 真正要跑的安装命令，action_required 走 runner 既有的 ask_user 流。
      expect(String(c1.cli_upgrade!.message)).toContain("restart this harness session");
      expect(String(c1.cli_upgrade!.message)).toContain("do NOT re-register");
      expect(String(c1.cli_upgrade!.message)).not.toMatch(/\bserve\b/); // 任何 serve 指令（含 restart serve）都不得出现
      expect(String(c1.cli_upgrade!.command)).toContain("install.sh");
      expect(c1.cli_upgrade!.action_required).toBe("ask_user");

      const r2 = await client.callTool({ name: "party_whoami", arguments: {} });
      expect((r2.structuredContent as { cli_upgrade?: unknown }).cli_upgrade).toBeDefined();
      // 10 分钟 TTL 内第二次 whoami 用缓存，不再打 /api/version。
      expect(versionHits).toBe(1);
    } finally {
      await client.close();
    }
  }, 20000);

  test("服务端版本不高于运行版 → 无 cli_upgrade", async () => {
    serverVersion = "0.0.1";
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_whoami", arguments: {} });
      expect(r.isError).not.toBe(true);
      expect((r.structuredContent as { cli_upgrade?: unknown }).cli_upgrade).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 20000);
});
