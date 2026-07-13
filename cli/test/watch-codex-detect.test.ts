// #175：watch --once 对 Claude Code 打印「Codex 不会唤醒你」的警告是错的；#454 另有
// 「后台任务可能在回合边界被回收，只能回合级等待」的专用警告。
//
// 根因（实测）：isCodexRuntimeEnv 只看 CODEX_*/OPENAI_CODEX 前缀。而 Claude Code
// 装了 codex 插件/companion 时，env 里同时有 CODEX_API_TOKEN 之类 —— 于是被误判成
// Codex 运行时。两种 harness 的失败模式不同，不能混用警告。
import { describe, expect, test } from "bun:test";
import { isCodexRuntimeEnv } from "../src/commands/watch";

describe("watch --once 的 Codex 运行时检测 (#175)", () => {
  test("Claude Code（CLAUDECODE）即便 env 有 CODEX_ 变量，也不算 Codex 运行时", () => {
    // 这正是我在 #agentparty 里撞到的真实 env：codex 插件塞了 CODEX_API_TOKEN，
    // 但 harness 是 Claude Code（会在后台退出时唤醒）。
    expect(isCodexRuntimeEnv({ CLAUDECODE: "1", CODEX_API_TOKEN: "x", CODEX_API_BASE_URL: "y" })).toBe(false);
  });

  test("CLAUDE_CODE_* 也算 Claude Code，短路掉 Codex 误判", () => {
    expect(isCodexRuntimeEnv({ CLAUDE_CODE_SESSION_ID: "s", CODEX_HOME: "/x" })).toBe(false);
  });

  test("真·Codex 运行时（有 CODEX_，无 Claude Code 标记）仍算 Codex", () => {
    expect(isCodexRuntimeEnv({ CODEX_HOME: "/x" })).toBe(true);
    expect(isCodexRuntimeEnv({ OPENAI_CODEX_FOO: "1" })).toBe(true);
  });

  test("两者都没有 → 不算 Codex（未知 harness 另有 rearm 提示兜底）", () => {
    expect(isCodexRuntimeEnv({ PATH: "/usr/bin" })).toBe(false);
  });
});
