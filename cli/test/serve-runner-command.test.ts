import { describe, expect, test } from "bun:test";
import { builtinRunnerCommand } from "../src/commands/serve";

describe("builtin runner executable binding", () => {
  test("uses the launchd-persisted absolute executable instead of PATH lookup", () => {
    expect(
      builtinRunnerCommand("codex", {
        PATH: "/usr/bin:/bin",
        AGENTPARTY_RUNNER_BIN: "/Users/leo/.local/bin/codex",
      }),
    ).toBe("/Users/leo/.local/bin/codex");
    expect(
      builtinRunnerCommand("claude", {
        PATH: "/usr/bin:/bin",
        AGENTPARTY_RUNNER_BIN: "/Users/leo/.local/bin/claude",
      }),
    ).toBe("/Users/leo/.local/bin/claude");
  });

  test("keeps terminal-started serve backward compatible when no binding is present", () => {
    expect(builtinRunnerCommand("codex", { PATH: "/custom/bin" })).toBe("codex");
    expect(builtinRunnerCommand("claude", {})).toBe("claude");
  });

  test("rejects a relative explicit binding instead of silently falling back to PATH", () => {
    expect(() =>
      builtinRunnerCommand("codex", { AGENTPARTY_RUNNER_BIN: "./codex" })
    ).toThrow("AGENTPARTY_RUNNER_BIN must be absolute");
  });
});
