import { describe, expect, test } from "bun:test";
import { buildMinimalAgentCommand, mcpServerName, MIN_CLI } from "./agentTokenVault";

describe("buildMinimalAgentCommand", () => {
  test("stores the agent config in a persistent per-agent directory", () => {
    const command = buildMinimalAgentCommand({
      server: "https://agentparty.example.com",
      slug: "release-room",
      name: "desktop-worker",
      token: "ap_fixture",
      inviterName: "leo",
      checkinMessage: "checking in",
    });

    expect(command).toContain(
      'export AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-desktop-worker-release-room.json"',
    );
    expect(command).not.toContain("TMPDIR");
    const guardIndex = command.indexOf("AgentParty onboarding scope: join the existing channel #release-room");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(command.indexOf("party init "));
    expect(command).toContain("only the supplied party commands");
    expect(command).toContain("Do not create or select another channel");
    expect(command).toContain("third-party or project-local channel workflows (for example, Trellis)");
    expect(command).toContain("do not delegate onboarding");
    expect(command).toContain("After onboarding, you are the front agent with three responsibilities");
    expect(command).toContain("stay in the main channel and communicate with its members");
    expect(command).toContain("communicate with the owner for permissions, trade-offs, and decisions");
    expect(command).toContain("dispatch work to sub-agents/workers, follow up, accept their evidence");
    expect(command).toContain("long-running execution MUST go to a harness sub-agent/worker");
    expect(command).toContain("report blocked instead of doing worker work yourself");
  });

  test("registers the MCP server MCP-first: env-pinned identity + channel binding, CLI kept as fallback", () => {
    const command = buildMinimalAgentCommand({
      server: "https://agentparty.example.com",
      slug: "release-room",
      name: "desktop-worker",
      token: "ap_fixture",
      inviterName: "leo",
      checkinMessage: "checking in",
    });

    // Check-in stays CLI (the harness only gains tools after MCP registration/restart)…
    const checkinIndex = command.indexOf('party send "checking in" --channel release-room');
    // …then the pack registers the MCP server carrying identity via env + the channel binding.
    // Server name is per-agent (`party-<name>`), never the bare `party`: two agents onboarding
    // from the same project directory must not overwrite each other's registration (env-pinned
    // identity — last writer would silently impersonate the first after a session restart).
    const mcpAddLine =
      'claude mcp add party-desktop-worker --env AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-desktop-worker-release-room.json" -- party mcp --channel release-room';
    expect(checkinIndex).toBeGreaterThan(-1);
    expect(command.indexOf(mcpAddLine)).toBeGreaterThan(checkinIndex);
    expect(command).toContain(
      '# Codex: codex mcp add party-desktop-worker --env AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-desktop-worker-release-room.json" -- party mcp --channel release-room',
    );
    expect(command).toContain("use the party_* tools");
    expect(command).toContain("carry your identity automatically");
    expect(command).toContain("Non-MCP harnesses: keep using the party CLI with the AGENTPARTY_CONFIG prefix");
  });

  test("mcpServerName：`.` 消毒成 `-`，且消毒必须单射——a.b 与 a-b 不得同名（否则同目录注册互相覆盖=串号）", () => {
    expect(mcpServerName("desktop-worker")).toBe("party-desktop-worker");
    // 有损清洗追加原名短哈希；无损名字保持干净、稳定。
    expect(mcpServerName("leo.g_2")).toMatch(/^party-leo-g_2-[0-9a-z]+$/);
    expect(mcpServerName("a.b")).not.toBe(mcpServerName("a-b"));
    expect(mcpServerName("a-b")).toBe("party-a-b");
    expect(mcpServerName("a.b")).toBe(mcpServerName("a.b"));
  });

  test("桌面最小接入包带 MIN_CLI 版本闸：只查 command -v 会放过装着旧版、缺 MCP 工具的机器", () => {
    const command = buildMinimalAgentCommand({
      server: "https://agentparty.example.com",
      slug: "release-room",
      name: "desktop-worker",
      token: "ap_fixture",
      inviterName: "leo",
      checkinMessage: "checking in",
    });
    expect(command).toContain("version_ge(){ awk");
    expect(command).toContain(`need=${MIN_CLI}; have=`);
    expect(command).toContain('version_ge "$have" "$need" || curl -fsSL');
    expect(command).not.toContain("command -v party >/dev/null || curl");
  });

  test("#530 桌面接入包：把传入的真实后端 server 原样写进 party init --server", () => {
    // 桌面版(Tauri)注入的 apiBase(=真后端)会作为 server 传进来，
    // 命令必须原样使用它，绝不能出现桌面端的 tauri://localhost 伪源。
    const command = buildMinimalAgentCommand({
      server: "https://agentparty.leeguoo.com",
      slug: "demo",
      name: "desktop-worker",
      token: "ap_fixture",
      inviterName: "leo",
      checkinMessage: "checking in",
    });

    expect(command).toContain(
      "party init --server https://agentparty.leeguoo.com --token ap_fixture --channel demo",
    );
    expect(command).not.toContain("tauri://localhost");
  });
});
