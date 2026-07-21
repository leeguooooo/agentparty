// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import type { MsgFrame, PresenceEntry, TaskRecord } from "@agentparty/shared";
import { computeChannelFocus, pendingDecisionsFromMessages, type PendingDecision } from "./channelFocus";

const NOW = 1_700_000_000_000;

function presence(overrides: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return {
    name: overrides.name,
    kind: "agent",
    state: "working",
    note: null,
    ts: NOW,
    last_seen: NOW,
    ...overrides,
  } as PresenceEntry;
}

function task(overrides: Partial<TaskRecord> & { id: number }): TaskRecord {
  return {
    type: "task",
    id: overrides.id,
    channel: "kyc",
    title: `task ${overrides.id}`,
    desc: null,
    state: "in_progress",
    assignee: { name: "Evan", kind: "agent" },
    created_by: "front",
    created_by_kind: "agent",
    priority: 0,
    labels: [],
    parent_id: null,
    anchor_seqs: [],
    scope: [],
    blocked_reason: null,
    external_ref: null,
    completion_artifact: null,
    workflow_id: null,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...overrides,
  } as TaskRecord;
}

function msg(overrides: Partial<MsgFrame> & { seq: number }): MsgFrame {
  return {
    type: "msg",
    seq: overrides.seq,
    sender: { name: "planner", kind: "agent" },
    kind: "message",
    body: "body",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: NOW,
    ...overrides,
  } as MsgFrame;
}

const NO_VIEWER = { name: null, account: null, canModerate: false };

describe("computeChannelFocus — aggregation across the three states", () => {
  test("live assignee on an in_progress task reads as working; drill-down keeps the task id", () => {
    const focus = computeChannelFocus({
      presence: [presence({ name: "Evan", live: true })],
      tasks: [task({ id: 1, title: "真机跑单", assignee: { name: "Evan", kind: "agent" } })],
      decisions: [],
      viewer: NO_VIEWER,
      now: NOW,
    });
    expect(focus.items).toHaveLength(1);
    const [item] = focus.items;
    expect(item!.state).toBe("working");
    expect(item!.name).toBe("Evan");
    expect(item!.label).toBe("真机跑单");
    expect(item!.taskId).toBe(1);
    expect(focus.counts.working).toBe(1);
    expect(focus.empty).toBe(false);
  });

  test("blocked task surfaces the blocked_reason and stays blocked regardless of presence freshness", () => {
    const focus = computeChannelFocus({
      // 全员 offline，但 blocked 与在场无关，不降级为 stalled。
      presence: [presence({ name: "kw", state: "offline", last_seen: NOW - 3_600_000 })],
      tasks: [task({ id: 2, state: "blocked", blocked_reason: "等 KycFeign 结果", assignee: { name: "kw", kind: "agent" } })],
      decisions: [],
      viewer: NO_VIEWER,
      now: NOW,
    });
    const [item] = focus.items;
    expect(item!.state).toBe("blocked");
    expect(item!.blockedOn).toBe("等 KycFeign 结果");
    expect(focus.counts.blocked).toBe(1);
  });

  test("pending decision becomes a waiting_decision item carrying the message seq", () => {
    const focus = computeChannelFocus({
      presence: [],
      tasks: [],
      decisions: [{ seq: 42, prompt: "prod 走 A 还是 B?", asker: "front", expectedResponderOwner: null }],
      viewer: NO_VIEWER,
      now: NOW,
    });
    const [item] = focus.items;
    expect(item!.state).toBe("waiting_decision");
    expect(item!.name).toBe("front");
    expect(item!.label).toBe("prod 走 A 还是 B?");
    expect(item!.seq).toBe(42);
    expect(focus.counts.waitingDecision).toBe(1);
  });

  test("orders items by urgency: waiting_decision > blocked > working > stalled", () => {
    const focus = computeChannelFocus({
      presence: [
        presence({ name: "Live", live: true }),
        presence({ name: "Gone", state: "working", live: false, last_seen: NOW - 3_600_000 }),
      ],
      tasks: [
        task({ id: 1, assignee: { name: "Live", kind: "agent" } }),
        task({ id: 2, assignee: { name: "Gone", kind: "agent" } }),
        task({ id: 3, state: "blocked", blocked_reason: "x", assignee: { name: "kw", kind: "agent" } }),
      ],
      decisions: [{ seq: 9, prompt: "decide", asker: "front", expectedResponderOwner: null }],
      viewer: NO_VIEWER,
      now: NOW,
    });
    expect(focus.items.map((i) => i.state)).toEqual(["waiting_decision", "blocked", "working", "stalled"]);
  });
});

describe("computeChannelFocus — staleness downgrade (#665 guard)", () => {
  test("working task whose assignee is offline/stale downgrades to stalled, not working", () => {
    const focus = computeChannelFocus({
      presence: [presence({ name: "Evan", state: "working", live: false, last_seen: NOW - 10 * 60_000 })],
      tasks: [task({ id: 1, assignee: { name: "Evan", kind: "agent" } })],
      decisions: [],
      viewer: NO_VIEWER,
      now: NOW,
    });
    const [item] = focus.items;
    expect(item!.state).toBe("stalled");
    expect(item!.stale).toBe(true);
    expect(focus.counts.working).toBe(0);
    expect(focus.counts.stalled).toBe(1);
  });

  test("assignee with no presence row at all is treated as stalled, not working", () => {
    const focus = computeChannelFocus({
      presence: [],
      tasks: [task({ id: 1, assignee: { name: "Ghost", kind: "agent" } })],
      decisions: [],
      viewer: NO_VIEWER,
      now: NOW,
    });
    expect(focus.items[0]!.state).toBe("stalled");
  });

  test("fresh last_seen within window keeps working even without a live socket", () => {
    const focus = computeChannelFocus({
      presence: [presence({ name: "Evan", state: "working", live: false, wake: { kind: "serve" }, last_seen: NOW - 30_000 })],
      tasks: [task({ id: 1, assignee: { name: "Evan", kind: "agent" } })],
      decisions: [],
      viewer: NO_VIEWER,
      now: NOW,
    });
    expect(focus.items[0]!.state).toBe("working");
  });
});

describe("computeChannelFocus — presence-only fallback (no task ledger row)", () => {
  test("self-reported blocked member without a task is still surfaced", () => {
    const focus = computeChannelFocus({
      presence: [presence({ name: "solo", state: "blocked", status: { owner: "solo", state: "blocked", scope: [], summary_seq: null, blocked_reason: "waiting on infra", updated_at: NOW } })],
      tasks: [],
      decisions: [],
      viewer: NO_VIEWER,
      now: NOW,
    });
    const [item] = focus.items;
    expect(item!.state).toBe("blocked");
    expect(item!.blockedOn).toBe("waiting on infra");
    expect(item!.taskId).toBeNull();
  });

  test("a member's task item wins over their presence fallback (no double-count)", () => {
    const focus = computeChannelFocus({
      presence: [presence({ name: "Evan", state: "working", live: true })],
      tasks: [task({ id: 1, assignee: { name: "Evan", kind: "agent" } })],
      decisions: [],
      viewer: NO_VIEWER,
      now: NOW,
    });
    expect(focus.items.filter((i) => i.name === "Evan")).toHaveLength(1);
    expect(focus.items[0]!.taskId).toBe(1);
  });

  test("human sessions never occupy the ball via presence fallback", () => {
    const focus = computeChannelFocus({
      presence: [presence({ name: "owner", kind: "human", state: "working", live: true })],
      tasks: [],
      decisions: [],
      viewer: NO_VIEWER,
      now: NOW,
    });
    expect(focus.empty).toBe(true);
  });
});

describe("computeChannelFocus — 'waiting on me' highlight", () => {
  test("owner-only decision matched by account highlights for that viewer", () => {
    const decisions: PendingDecision[] = [{ seq: 1, prompt: "approve prod cutover", asker: "front", expectedResponderOwner: "owner@x.com" }];
    const mine = computeChannelFocus({ presence: [], tasks: [], decisions, viewer: { name: "leo", account: "owner@x.com", canModerate: true }, now: NOW });
    expect(mine.waitingOnMe).toHaveLength(1);
    expect(mine.items[0]!.waitingOnMe).toBe(true);

    const notMine = computeChannelFocus({ presence: [], tasks: [], decisions, viewer: { name: "kw", account: "kw@x.com", canModerate: false }, now: NOW });
    expect(notMine.waitingOnMe).toHaveLength(0);
  });

  test("unrestricted decision highlights for any moderator (owner-scans-for-this)", () => {
    const decisions: PendingDecision[] = [{ seq: 1, prompt: "pick a path", asker: "front", expectedResponderOwner: null }];
    const mod = computeChannelFocus({ presence: [], tasks: [], decisions, viewer: { name: "leo", account: "a", canModerate: true }, now: NOW });
    expect(mod.waitingOnMe).toHaveLength(1);
    const worker = computeChannelFocus({ presence: [], tasks: [], decisions, viewer: { name: "w", account: "b", canModerate: false }, now: NOW });
    expect(worker.waitingOnMe).toHaveLength(0);
  });

  test("a task assigned to the viewing human is 'waiting on me' and sorts first", () => {
    const focus = computeChannelFocus({
      presence: [presence({ name: "Evan", live: true })],
      tasks: [
        task({ id: 1, assignee: { name: "Evan", kind: "agent" } }),
        task({ id: 2, state: "assigned", title: "your call on prod opts", assignee: { name: "leo", kind: "human" } }),
      ],
      decisions: [],
      viewer: { name: "leo", account: "owner@x.com", canModerate: true },
      now: NOW,
    });
    expect(focus.waitingOnMe.map((i) => i.taskId)).toEqual([2]);
    expect(focus.items[0]!.taskId).toBe(2); // waiting-on-me floats to the top
  });
});

describe("computeChannelFocus — focus override + empty state", () => {
  test("host one-liner override sets focus + manual source", () => {
    const focus = computeChannelFocus({
      presence: [], tasks: [], decisions: [],
      viewer: NO_VIEWER, now: NOW,
      focusOverride: "  结果查询 + 上传端到端联调  ",
    });
    expect(focus.focus).toBe("结果查询 + 上传端到端联调");
    expect(focus.focusSource).toBe("manual");
  });

  test("nothing in flight → empty, so the bar can render nothing", () => {
    const focus = computeChannelFocus({
      presence: [presence({ name: "idle", state: "waiting", live: true })],
      tasks: [task({ id: 1, state: "done", assignee: { name: "Evan", kind: "agent" } })],
      decisions: [],
      viewer: NO_VIEWER,
      now: NOW,
    });
    expect(focus.empty).toBe(true);
    expect(focus.items).toHaveLength(0);
    expect(focus.focus).toBeNull();
  });
});

describe("pendingDecisionsFromMessages", () => {
  test("keeps only unresolved, non-retracted decision_request messages", () => {
    const messages: MsgFrame[] = [
      msg({ seq: 1, decision_request: { kind: "choice", prompt: "open one", options: ["a", "b"] }, decision_resolution: { state: "pending" } }),
      msg({ seq: 2, decision_request: { kind: "approval", prompt: "resolved one", options: ["approve", "reject"] }, decision_resolution: { state: "resolved", chosen_index: 0 } }),
      msg({ seq: 3, decision_request: { kind: "approval", prompt: "auto one", options: ["approve", "reject"] }, decision_resolution: { state: "auto_resolved" } }),
      msg({ seq: 4, decision_request: { kind: "choice", prompt: "retracted one", options: ["a"] }, retracted: true }),
      msg({ seq: 5, decision_request: { kind: "choice", prompt: "no-resolution one", options: ["a"] } }),
      msg({ seq: 6, body: "plain message" }),
    ];
    const pending = pendingDecisionsFromMessages(messages);
    expect(pending.map((d) => d.seq)).toEqual([1, 5]);
    expect(pending[0]!.prompt).toBe("open one");
    expect(pending[0]!.asker).toBe("planner");
  });

  test("carries expected_responder_owner through when present", () => {
    const messages: MsgFrame[] = [
      msg({ seq: 1, sender: { name: "front", kind: "agent" }, decision_request: { kind: "approval", prompt: "owner only", options: ["approve", "reject"], expected_responder_owner: "owner@x.com" }, decision_resolution: { state: "pending" } }),
    ];
    expect(pendingDecisionsFromMessages(messages)[0]!.expectedResponderOwner).toBe("owner@x.com");
  });
});
