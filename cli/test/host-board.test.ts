// #204 buildHostBoard 纯函数契约：open_claims / conflicts / blockers 改由任务台账派生，
// decisions 仍从消息折叠来，legacy status claim 落进 unlinked_claims（按 seq 链接/去重/排序，不用 claimKey）。
// shared 无测试 runner，纯函数测试放在 cli/test 下、经 workspace 从 @agentparty/shared 引入运行。
import { describe, expect, test } from "bun:test";
import { buildHostBoard, type MsgFrame, type StatusState, type TaskRecord } from "@agentparty/shared";

const NOW = 1_000_000;

function task(overrides: Partial<TaskRecord> & { id: number }): TaskRecord {
  return {
    type: "task",
    channel: "dev",
    title: `task-${overrides.id}`,
    desc: null,
    state: "in_progress",
    assignee: null,
    created_by: "creator",
    created_by_kind: "agent",
    priority: 0,
    labels: [],
    parent_id: null,
    anchor_seqs: [],
    scope: [],
    blocked_reason: null,
    completion_artifact: null,
    workflow_id: null,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...overrides,
  };
}

function statusMsg(
  seq: number,
  owner: string,
  state: StatusState,
  scope: string[],
  note: string | null = null,
  blocked_reason: string | null = null,
): MsgFrame {
  return {
    type: "status",
    seq,
    sender: { name: owner, kind: "agent" },
    kind: "status",
    body: note ?? state,
    mentions: [],
    reply_to: null,
    state,
    note,
    status: {
      owner,
      state,
      scope,
      summary_seq: null,
      blocked_reason,
      updated_at: seq * 1000,
    },
    ts: seq * 1000,
  };
}

function decisionMsg(seq: number, owner: string): MsgFrame {
  return {
    type: "status",
    seq,
    sender: { name: owner, kind: "agent" },
    kind: "status",
    body: "decision",
    mentions: [],
    reply_to: null,
    state: "working",
    note: "decision",
    status: {
      owner,
      state: "working",
      scope: [],
      summary_seq: null,
      blocked_reason: null,
      updated_at: seq * 1000,
      decision: { kind: "decision", owner, decision: "ship it", next: null, expires_at: null },
    },
    ts: seq * 1000,
  };
}

describe("buildHostBoard open_claims from task ledger (#204)", () => {
  test("in_progress task with assignee → open_claims，身份 = task id（M1 target）", () => {
    const t = task({ id: 7, state: "in_progress", assignee: { name: "web-a", kind: "agent" }, scope: ["web/src"] });
    const board = buildHostBoard("dev", [], [], [t], NOW);
    expect(board.open_claims).toEqual([
      expect.objectContaining({ task_id: 7, owner: "web-a", state: "working", task_state: "in_progress", scope: ["web/src"] }),
    ]);
  });

  test("同一 task 改 scope 仍是同一条 claim（task id 不变），绝不产生孤儿（M1 target）", () => {
    const before = task({ id: 7, state: "in_progress", assignee: { name: "web-a", kind: "agent" }, scope: ["web/src"] });
    const after = task({ id: 7, state: "in_progress", assignee: { name: "web-a", kind: "agent" }, scope: ["web/src", "cli"] });
    const boardBefore = buildHostBoard("dev", [], [], [before], NOW);
    const boardAfter = buildHostBoard("dev", [], [], [after], NOW);
    expect(boardBefore.open_claims).toHaveLength(1);
    expect(boardAfter.open_claims).toHaveLength(1);
    expect(boardAfter.open_claims[0]!.task_id).toBe(7);
    expect(boardAfter.open_claims[0]!.scope).toEqual(["web/src", "cli"]);
  });

  test("只有 assigned/in_progress/needs_review 且有 assignee 的 task 进 open_claims", () => {
    const tasks = [
      task({ id: 1, state: "in_progress", assignee: { name: "a", kind: "agent" }, scope: ["x"] }),
      task({ id: 2, state: "assigned", assignee: { name: "b", kind: "agent" }, scope: ["y"] }),
      task({ id: 3, state: "needs_review", assignee: { name: "c", kind: "agent" }, scope: ["z"] }),
      task({ id: 4, state: "in_progress", assignee: null, scope: ["w"] }),
      task({ id: 5, state: "triage", assignee: { name: "d", kind: "agent" }, scope: ["q"] }),
      task({ id: 6, state: "done", assignee: { name: "e", kind: "agent" }, scope: ["r"] }),
    ];
    const board = buildHostBoard("dev", [], [], tasks, NOW);
    expect(board.open_claims.map((c) => c.task_id).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3]);
  });
});

describe("buildHostBoard blockers from task ledger (#204)", () => {
  test("blocked task → blockers，带 blocked_reason（M2 target）", () => {
    const t = task({ id: 9, state: "blocked", assignee: { name: "w", kind: "agent" }, scope: ["worker"], blocked_reason: "waiting on secret" });
    const board = buildHostBoard("dev", [], [], [t], NOW);
    expect(board.blockers).toEqual([
      expect.objectContaining({ task_id: 9, owner: "w", state: "blocked", task_state: "blocked", blocked_reason: "waiting on secret" }),
    ]);
    expect(board.open_claims).toEqual([]);
  });

  test("blocked task 无 assignee 时 owner 回退 created_by", () => {
    const t = task({ id: 9, state: "blocked", assignee: null, created_by: "maker", scope: [], blocked_reason: "stuck" });
    expect(buildHostBoard("dev", [], [], [t], NOW).blockers).toEqual([
      expect.objectContaining({ task_id: 9, owner: "maker", blocked_reason: "stuck" }),
    ]);
  });
});

describe("buildHostBoard conflicts from task scope (#204)", () => {
  test("两个不同 assignee、scope 重叠 → conflict（M3 target）", () => {
    const tasks = [
      task({ id: 10, state: "in_progress", assignee: { name: "a", kind: "agent" }, scope: ["web/src"] }),
      task({ id: 11, state: "in_progress", assignee: { name: "b", kind: "agent" }, scope: ["web/src/components"] }),
    ];
    const board = buildHostBoard("dev", [], [], tasks, NOW);
    expect(board.conflicts).toEqual([expect.objectContaining({ scope: "web/src", owners: ["a", "b"] })]);
  });

  test("同一 assignee scope 重叠不算 conflict", () => {
    const tasks = [
      task({ id: 10, state: "in_progress", assignee: { name: "a", kind: "agent" }, scope: ["web/src"] }),
      task({ id: 11, state: "in_progress", assignee: { name: "a", kind: "agent" }, scope: ["web/src/x"] }),
    ];
    expect(buildHostBoard("dev", [], [], tasks, NOW).conflicts).toEqual([]);
  });
});

describe("buildHostBoard unlinked_claims legacy 段 (#204)", () => {
  test("没有 task anchor 指向其 seq 的历史 status claim → 落进 unlinked_claims（M4 target）", () => {
    const messages = [statusMsg(221, "worker-a", "working", ["web/src"])];
    const board = buildHostBoard("dev", [], messages, [], NOW);
    expect(board.unlinked_claims).toEqual([
      expect.objectContaining({ seq: 221, owner: "worker-a", task_id: null, scope: ["web/src"] }),
    ]);
  });

  test("链接判定按 seq（anchor 命中）而非 claimKey（owner+scope）——M5 target", () => {
    const messages = [statusMsg(221, "worker-a", "working", ["web/src"])];
    // task 的 assignee+scope 与 claim 完全一致，但 anchor 不含 221：
    // 按 seq → 仍 unlinked；若错误地按 claimKey 匹配 → 会误判为已链接、从 legacy 段漏掉。
    const matchByClaimKeyNotAnchor = task({
      id: 5,
      state: "in_progress",
      assignee: { name: "worker-a", kind: "agent" },
      scope: ["web/src"],
      anchor_seqs: [999],
    });
    expect(buildHostBoard("dev", [], messages, [matchByClaimKeyNotAnchor], NOW).unlinked_claims.map((c) => c.seq)).toEqual([221]);

    // 对照：task anchor 含 221（owner/scope 完全不同）→ 按 seq 链接 → 不再 unlinked。
    const anchored = task({ id: 6, state: "in_progress", assignee: { name: "zzz", kind: "agent" }, scope: ["unrelated"], anchor_seqs: [221] });
    expect(buildHostBoard("dev", [], messages, [anchored], NOW).unlinked_claims).toEqual([]);
  });

  test("unlinked_claims 按 seq 去重与排序，不用 claimKey（M5 target）", () => {
    // seq 与 claimKey 排序相反：zeta@200 / alpha@100。按 seq 降序 → [200,100]；按 claimKey 升序 → [100,200]。
    const messages = [
      statusMsg(200, "zeta", "working", ["a"]),
      statusMsg(100, "alpha", "working", ["b"]),
    ];
    expect(buildHostBoard("dev", [], messages, [], NOW).unlinked_claims.map((c) => c.seq)).toEqual([200, 100]);
  });
});

describe("buildHostBoard decisions still from messages (#204)", () => {
  test("decisions 仍从消息折叠来", () => {
    const board = buildHostBoard("dev", [], [decisionMsg(50, "host-a")], [], NOW);
    expect(board.decisions).toEqual([
      expect.objectContaining({ seq: 50, owner: "host-a", kind: "decision", decision: "ship it" }),
    ]);
  });
});
