import { describe, expect, test } from "bun:test";
import { buildMinimalAgentCommand } from "./agentTokenVault";

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
    expect(command).toContain("app-server, MCP, or project-local channel workflow (for example, Trellis)");
    expect(command).toContain("do not delegate onboarding");
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
