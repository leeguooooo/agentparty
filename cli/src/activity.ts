// 模型 session 活动上报（issue #602）的本地契约：hook 进程只写文件、serve 心跳只读文件。
// hook 每次工具调用都会触发，绝不能走网络热路径；serve 本来就有 15s 心跳帧，捎带即可。
// 文件路径由 serve 经 AP_ACTIVITY_FILE env 显式递给 runner（hook 子进程继承），
// 双方对同一路径达成一致，完全绕开「hook 的 session_id 与 serve 已知句柄对不上」的映射问题。
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseAgentActivity, type AgentActivity, type AgentActivityPhase } from "@agentparty/shared";
import { atomicWriteJson } from "./atomic-json";

/** hook 落盘超过这个岁数即视为陈旧，不再随心跳上行（模型进程可能已死，别让频道看僵活动）。 */
export const ACTIVITY_TTL_MS = 5 * 60_000;

/** serve 为某个 runner workdir 约定的 activity 文件路径；经 AP_ACTIVITY_FILE 递给 runner。 */
export function runnerActivityFile(workdir: string): string {
  return join(workdir, "activity.json");
}

// Claude Code hook stdin payload → activity 快照。认不出的事件返回 null（不覆盖现状）：
// SubagentStop 时主 session 还在跑、盲目写 idle 会说谎。tool 只取名字，入参正文绝不落盘。
export function activityFromHookEvent(payload: Record<string, unknown>, now: number): AgentActivity | null {
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const tool = typeof payload.tool_name === "string" && payload.tool_name.length > 0
    ? payload.tool_name.slice(0, 64)
    : undefined;
  const snapshot = (phase: AgentActivityPhase, withTool = false): AgentActivity => ({
    phase,
    ...(withTool && tool !== undefined ? { tool } : {}),
    ts: now,
  });
  switch (event) {
    case "SessionStart":
      return snapshot("starting");
    case "UserPromptSubmit":
    case "PostToolUse":
      return snapshot("working");
    case "PreToolUse":
      return snapshot("tool", true);
    case "PreCompact":
      return snapshot("compacting");
    case "Stop":
    case "SessionEnd":
      return snapshot("idle");
    case "Notification": {
      // Notification 一帧多义：权限请求（headless 最致命的静默挂法）vs 等输入 vs 其它杂音。
      // 按 message 文案区分；认不出的一律忽略，宁可少报不误报。
      const message = typeof payload.message === "string" ? payload.message : "";
      if (/permission/i.test(message)) return snapshot("waiting_permission", true);
      if (/waiting for (your )?input/i.test(message)) return snapshot("waiting_input");
      return null;
    }
    default:
      return null;
  }
}

/** hook 侧原子落盘。失败让它抛——调用方（hook 命令）统一静默吞。 */
export function writeActivityFile(path: string, activity: AgentActivity): void {
  atomicWriteJson(path, activity);
}

/** serve 心跳侧读取：文件缺失/脏值/超 TTL/未来时间戳都返回 null（本拍不带 activity）。 */
export function readActivityFile(path: string, now: number, ttlMs: number = ACTIVITY_TTL_MS): AgentActivity | null {
  try {
    const parsed = parseAgentActivity(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (parsed === undefined) return null;
    // 未来时间戳（写坏/时钟跳变）会让 TTL 永不过期，按脏值丢弃；容忍 1 分钟正常时钟抖动。
    if (parsed.ts - now > 60_000) return null;
    return now - parsed.ts <= ttlMs ? parsed : null;
  } catch {
    return null;
  }
}

/** 任务冷起前清掉上一轮残留，避免新 turn 首个 hook 到来前展示旧活动。 */
export function clearActivityFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // 清不掉就留给 TTL 兜底
  }
}
