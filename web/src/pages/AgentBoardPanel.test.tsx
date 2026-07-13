// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PresenceEntry, TaskRecord } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

const { AgentBoardPanel } = await import("./Channel");

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function presence(name: string, over: Partial<PresenceEntry> = {}): PresenceEntry {
  return { name, kind: "agent", state: "waiting", note: null, ts: 0, ...over } as PresenceEntry;
}

function task(
  id: number,
  assignee: string | null,
  state: TaskRecord["state"],
  assigneeKind: "agent" | "human" | "squad" = "agent",
): TaskRecord {
  return {
    type: "task", id, channel: "c", title: `t${id}`, desc: null, state,
    assignee: assignee === null ? null : { name: assignee, kind: assigneeKind },
    created_by: "h", created_by_kind: "human", priority: 0, labels: [], parent_id: null,
    anchor_seqs: [], completion_artifact: null, workflow_id: null, scope: [], blocked_reason: null,
    external_ref: null, created_at: 0, updated_at: 0, completed_at: null,
  };
}

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
});

function render(locale: "en" | "zh", presenceList: PresenceEntry[], tasks: TaskRecord[]): ReactTestRenderer {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage({ ap_locale: locale }) });
  let r!: ReactTestRenderer;
  void act(() => {
    r = create(<LocaleProvider><AgentBoardPanel presence={presenceList} tasks={tasks} /></LocaleProvider>);
  });
  renderer = r;
  return r;
}
function treeText(node: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object" && "children" in (node as Record<string, unknown>)) walk((node as { children: unknown }).children);
  };
  walk(node);
  return out.join(" ");
}
function allText(r: ReactTestRenderer): string {
  return treeText(r.toJSON());
}

describe("AgentBoardPanel (#187)", () => {
  test("groups tasks by assignee and derives busy/offline status from presence", () => {
    const p = [
      presence("alice", { state: "working", live: true }),
      presence("bob", { live: false }),
      presence("carol", { state: "waiting", live: true }),
      presence("dave", { state: "blocked", live: true }),
    ];
    const tasks = [
      task(1, "alice", "in_progress"), task(2, "alice", "in_progress"), task(3, "alice", "assigned"),
      task(4, "bob", "needs_review"),
      task(5, null, "in_progress"), // 无 assignee 不计入任何 agent
      task(6, "alice", "done"), // done 不计入在手
      task(7, "dave", "blocked"),
      task(8, "carol", "assigned"),
      task(9, "human-owner", "assigned", "human"),
      task(10, "review-squad", "in_progress", "squad"),
    ];
    const r = render("en", p, tasks);
    const txt = allText(r);
    // alice：busy + 2 in progress + 1 queued
    expect(txt).toContain("alice");
    expect(txt).toContain("busy");
    expect(txt).toContain("2"); // in progress
    // bob：live=false → offline，且有 1 待审
    expect(txt).toContain("bob");
    expect(txt).toContain("offline");
    // 每个状态是一列，agent 卡片落在对应列，并直接展示真实任务进度。
    const busyLane = r.root.findByProps({ "data-status": "busy" });
    const blockedLane = r.root.findByProps({ "data-status": "blocked" });
    const idleLane = r.root.findByProps({ "data-status": "idle" });
    const offlineLane = r.root.findByProps({ "data-status": "offline" });
    expect(treeText(busyLane)).toContain("alice");
    expect(treeText(busyLane)).toContain("t1");
    expect(treeText(blockedLane)).toContain("dave");
    expect(treeText(blockedLane)).toContain("t7");
    expect(treeText(idleLane)).toContain("carol");
    expect(treeText(idleLane)).toContain("t8");
    expect(treeText(offlineLane)).toContain("bob");
    expect(treeText(offlineLane)).toContain("t4");
    // 无 assignee 的 task5 不产生「未命名」agent 行
    expect(txt).not.toContain("t5");
    // 已完成任务不再属于在手工作。
    expect(txt).not.toContain("t6");
    // human/squad 任务不能凭空生成 Agent 卡片。
    expect(txt).not.toContain("human-owner");
    expect(txt).not.toContain("review-squad");
    expect(txt).not.toContain("t9");
    expect(txt).not.toContain("t10");
  });

  test("empty when no agents and no assigned tasks", () => {
    const txt = allText(render("zh", [], []));
    expect(txt).toContain("还没有 agent");
  });

  test("offline agent with backlog still shows (from task assignee union)", () => {
    // 一个不在 presence 里但有任务的 agent 也要显示（离线但手里有活）
    const txt = allText(render("en", [], [task(1, "ghost", "assigned")]));
    expect(txt).toContain("ghost");
    expect(txt).toContain("offline");
  });

  test("surfaces scheduling: paused agent with resume_at shows resume time (#187 排期)", () => {
    // 定时恢复：paused + resume_at → 本行展示「暂停至 HH:MM」，时间来自 presence.resume_at
    const at = new Date();
    at.setHours(14, 30, 0, 0);
    const p = [presence("alice", { state: "working", live: true, paused: true, resume_at: at.getTime() })];
    const txt = allText(render("zh", p, [task(1, "alice", "in_progress")]));
    expect(txt).toContain("alice");
    expect(txt).toContain("暂停至");
    expect(txt).toContain("14:30");
  });

  test("surfaces scheduling: paused without resume_at shows manual-pause label", () => {
    // 只能手动恢复：paused 但无 resume_at → 展示暂停但不含具体恢复时刻
    const p = [presence("bob", { state: "waiting", live: true, paused: true })];
    const txt = allText(render("en", p, []));
    expect(txt).toContain("bob");
    expect(txt).toContain("paused");
  });

  test("does not surface schedule line when not paused", () => {
    const p = [presence("carol", { state: "working", live: true })];
    const txt = allText(render("en", p, [task(1, "carol", "in_progress")]));
    expect(txt).toContain("carol");
    expect(txt).not.toContain("paused");
  });
});
