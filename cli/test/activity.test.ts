// 模型 session 活动上报（issue #602）：hook 事件映射、落盘/读取契约、hook 命令的「绝不阻断模型」铁律。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVITY_TTL_MS,
  activityFromHookEvent,
  clearActivityFile,
  readActivityFile,
  runnerActivityFile,
  writeActivityFile,
} from "../src/activity";
import { activityTargetFile } from "../src/commands/hook";
import { claudeHookSettingsJson } from "../src/commands/serve";

const NOW = 1_700_000_000_000;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "party-activity-"));
}

describe("activityFromHookEvent", () => {
  test("maps the hook lifecycle to activity phases", () => {
    expect(activityFromHookEvent({ hook_event_name: "SessionStart" }, NOW)).toEqual({ phase: "starting", ts: NOW });
    expect(activityFromHookEvent({ hook_event_name: "UserPromptSubmit" }, NOW)).toEqual({ phase: "working", ts: NOW });
    expect(activityFromHookEvent({ hook_event_name: "PreToolUse", tool_name: "Bash" }, NOW)).toEqual({
      phase: "tool",
      tool: "Bash",
      ts: NOW,
    });
    expect(activityFromHookEvent({ hook_event_name: "PostToolUse", tool_name: "Bash" }, NOW)).toEqual({
      phase: "working",
      ts: NOW,
    });
    expect(activityFromHookEvent({ hook_event_name: "PreCompact" }, NOW)).toEqual({ phase: "compacting", ts: NOW });
    expect(activityFromHookEvent({ hook_event_name: "Stop" }, NOW)).toEqual({ phase: "idle", ts: NOW });
    expect(activityFromHookEvent({ hook_event_name: "SessionEnd" }, NOW)).toEqual({ phase: "idle", ts: NOW });
  });

  test("splits Notification into waiting_permission / waiting_input, ignores the rest", () => {
    expect(
      activityFromHookEvent(
        { hook_event_name: "Notification", message: "Claude needs your permission to use Bash", tool_name: "Bash" },
        NOW,
      ),
    ).toEqual({ phase: "waiting_permission", tool: "Bash", ts: NOW });
    expect(
      activityFromHookEvent({ hook_event_name: "Notification", message: "Claude is waiting for your input" }, NOW),
    ).toEqual({ phase: "waiting_input", ts: NOW });
    expect(activityFromHookEvent({ hook_event_name: "Notification", message: "something else" }, NOW)).toBeNull();
  });

  test("ignores unknown events and SubagentStop (main session is still running)", () => {
    expect(activityFromHookEvent({ hook_event_name: "SubagentStop" }, NOW)).toBeNull();
    expect(activityFromHookEvent({ hook_event_name: "SomethingNew" }, NOW)).toBeNull();
    expect(activityFromHookEvent({}, NOW)).toBeNull();
  });

  test("carries only the tool NAME, never tool input (secret hygiene)", () => {
    const activity = activityFromHookEvent(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo TOP_SECRET" } },
      NOW,
    );
    expect(JSON.stringify(activity)).not.toContain("TOP_SECRET");
    expect(activity).toEqual({ phase: "tool", tool: "Bash", ts: NOW });
  });

  test("truncates oversized tool names to 64 chars", () => {
    const activity = activityFromHookEvent({ hook_event_name: "PreToolUse", tool_name: "x".repeat(200) }, NOW);
    expect(activity?.tool).toHaveLength(64);
  });
});

describe("activity file contract", () => {
  test("write → read round-trips while fresh, goes null past TTL", () => {
    const file = runnerActivityFile(tempDir());
    writeActivityFile(file, { phase: "tool", tool: "Bash", ts: NOW });
    expect(readActivityFile(file, NOW + 1000)).toEqual({ phase: "tool", tool: "Bash", ts: NOW });
    expect(readActivityFile(file, NOW + ACTIVITY_TTL_MS + 1)).toBeNull();
  });

  test("a future timestamp is rejected (it would defeat the TTL forever)", () => {
    const file = runnerActivityFile(tempDir());
    writeActivityFile(file, { phase: "tool", tool: "Bash", ts: NOW + 10 * 60_000 });
    expect(readActivityFile(file, NOW)).toBeNull();
    // 1 分钟内的正常时钟抖动仍容忍
    writeActivityFile(file, { phase: "tool", tool: "Bash", ts: NOW + 30_000 });
    expect(readActivityFile(file, NOW)).not.toBeNull();
  });

  test("control characters in a stored tool name are stripped on read (terminal-injection hygiene)", () => {
    const file = runnerActivityFile(tempDir());
    writeFileSync(file, JSON.stringify({ phase: "tool", tool: "Bash\u001b[31mevil\u0007", ts: NOW }));
    expect(readActivityFile(file, NOW)?.tool).toBe("Bash[31mevil");
  });

  test("missing file / garbage content read as null, clear is idempotent", () => {
    const dir = tempDir();
    const file = runnerActivityFile(dir);
    expect(readActivityFile(file, NOW)).toBeNull();
    writeFileSync(file, "not json");
    expect(readActivityFile(file, NOW)).toBeNull();
    writeFileSync(file, JSON.stringify({ phase: "hacking", ts: NOW }));
    expect(readActivityFile(file, NOW)).toBeNull();
    clearActivityFile(file);
    clearActivityFile(file); // 已删除再删不抛
    expect(readActivityFile(file, NOW)).toBeNull();
  });
});

describe("party hook report target resolution", () => {
  test("prefers AP_ACTIVITY_FILE (serve-managed lane)", () => {
    const target = activityTargetFile({ AP_ACTIVITY_FILE: "/tmp/x/activity.json" }, { session_id: "abc" }, "/home/.agentparty");
    expect(target).toBe("/tmp/x/activity.json");
  });

  test("falls back to the session-id keyed state file", () => {
    const target = activityTargetFile({}, { session_id: "0199-abc.DEF_1" }, "/home/.agentparty");
    expect(target).toBe(join("/home/.agentparty", "state", "activity", "0199-abc.DEF_1.json"));
  });

  test("rejects traversal-shaped or missing session ids", () => {
    expect(activityTargetFile({}, { session_id: "../../etc/passwd" }, "/home/.agentparty")).toBeNull();
    expect(activityTargetFile({}, { session_id: "a/b" }, "/home/.agentparty")).toBeNull();
    expect(activityTargetFile({}, {}, "/home/.agentparty")).toBeNull();
  });
});

describe("party hook report end-to-end", () => {
  // 铁律验证：真 hook 调用永远 exit 0、stdout 永远为空——坏 JSON 也一样。
  async function runHookReport(stdin: string, activityFile: string): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts"), "hook", "report"], {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AP_ACTIVITY_FILE: activityFile },
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { code, stdout };
  }

  test("records a PreToolUse snapshot from stdin", async () => {
    const file = runnerActivityFile(tempDir());
    const r = await runHookReport(
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1" }),
      file,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const written = JSON.parse(readFileSync(file, "utf8")) as { phase: string; tool: string };
    expect(written.phase).toBe("tool");
    expect(written.tool).toBe("Bash");
  });

  test("bad JSON stays silent and exits 0 (never blocks the model)", async () => {
    const file = runnerActivityFile(tempDir());
    const r = await runHookReport("this is not json", file);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(readActivityFile(file, NOW)).toBeNull();
  });
});

describe("claudeHookSettingsJson", () => {
  test("wires every lifecycle hook to `party hook report`", () => {
    const settings = JSON.parse(claudeHookSettingsJson("/usr/local/bin/party")) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    };
    for (const event of ["PreToolUse", "PostToolUse", "Notification", "Stop", "SessionStart", "SessionEnd", "PreCompact", "UserPromptSubmit"]) {
      const entry = settings.hooks[event]?.[0]?.hooks[0];
      expect(entry?.type).toBe("command");
      // 绝对路径一律加引号转义（不只空白路径）——引号在 POSIX sh 与 cmd 下都成立
      expect(entry?.command).toBe('"/usr/local/bin/party" hook report');
      expect(entry?.timeout).toBe(10);
    }
  });

  test("quotes a party path containing whitespace", () => {
    const settings = JSON.parse(claudeHookSettingsJson("/Applications/My Tools/party")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop[0]!.hooks[0]!.command).toBe('"/Applications/My Tools/party" hook report');
  });

  test("falls back to bare `party` for non-party exec paths (bun dev)", () => {
    const settings = JSON.parse(claudeHookSettingsJson("/opt/homebrew/bin/bun")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop[0]!.hooks[0]!.command).toBe("party hook report");
  });
});
