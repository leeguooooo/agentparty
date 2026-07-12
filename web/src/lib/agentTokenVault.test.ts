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
  });
});
