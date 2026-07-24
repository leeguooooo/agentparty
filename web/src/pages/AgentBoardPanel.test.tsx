// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame, PresenceEntry, PublicDirectedDelivery, Sender, TaskRecord } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

const { AgentBoardPanel, agentPresenceSummary } = await import("./Channel");

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

function message(seq: number, body: string, over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    type: "msg", seq, sender: { name: "human-owner", kind: "human" }, kind: "message", body,
    mentions: [], reply_to: null, state: null, note: null, status: null, ts: seq, ...over,
  };
}

function delivery(
  id: string,
  targetName: string,
  messageSeq: number,
  state: PublicDirectedDelivery["state"],
  preview?: string | null,
): PublicDirectedDelivery {
  return {
    id,
    message_seq: messageSeq,
    target_name: targetName,
    state,
    reply_seq: null,
    created_at: messageSeq,
    updated_at: messageSeq,
    ...(preview === undefined ? {} : { preview }),
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

function render(
  locale: "en" | "zh",
  presenceList: PresenceEntry[],
  tasks: TaskRecord[],
  participants: Sender[] = [],
  deliveries: PublicDirectedDelivery[] = [],
  messages: MsgFrame[] = [],
  onOpenAgentDetail?: (name: string) => void,
  memberNames?: ReadonlySet<string>,
): ReactTestRenderer {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage({ ap_locale: locale }) });
  let r!: ReactTestRenderer;
  void act(() => {
    r = create(
      <LocaleProvider>
        <AgentBoardPanel
          presence={presenceList}
          participants={participants}
          tasks={tasks}
          deliveries={deliveries}
          messages={messages}
          onOpenAgentDetail={onOpenAgentDetail}
          memberNames={memberNames}
        />
      </LocaleProvider>,
    );
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

  test("marks only empty active lanes while preserving the offline disclosure (#504)", () => {
    const r = render(
      "en",
      [presence("alice", { state: "working", live: true })],
      [task(1, "alice", "in_progress")],
    );

    expect(r.root.findByProps({ "data-status": "busy" }).props["data-empty"]).toBe(false);
    expect(r.root.findByProps({ "data-status": "blocked" }).props["data-empty"]).toBe(true);
    expect(r.root.findByProps({ "data-status": "idle" }).props["data-empty"]).toBe(true);
    const offline = r.root.findByProps({ "data-status": "offline" });
    expect(offline.type).toBe("details");
    expect(offline.props["data-empty"]).toBeUndefined();
  });

  test("offline agent with backlog still shows (from task assignee union)", () => {
    // 一个不在 presence 里但有任务的 agent 也要显示（离线但手里有活）
    const txt = allText(render("en", [], [task(1, "ghost", "assigned")]));
    expect(txt).toContain("ghost");
    expect(txt).toContain("offline");
  });

  test("authoritative roster keeps removed task and delivery targets out of Team", () => {
    const txt = allText(render(
      "en",
      [],
      [task(1, "removed-agent", "assigned")],
      [],
      [delivery("removed-work", "removed-agent", 12, "queued", "stale assignment")],
      [],
      undefined,
      new Set(),
    ));

    expect(txt).not.toContain("removed-agent");
    expect(txt).not.toContain("stale assignment");
    expect(txt).toContain("No agents yet");
  });

  test("participant-only agent is visible and online before its first presence row (#514)", () => {
    const r = render("en", [], [], [{ name: "fresh-agent", kind: "agent" }]);
    const idleLane = r.root.findByProps({ "data-status": "idle" });
    const offlineLane = r.root.findByProps({ "data-status": "offline" });
    expect(treeText(idleLane)).toContain("fresh-agent");
    expect(treeText(offlineLane)).not.toContain("fresh-agent");
  });

  test("member names route into the shared Team detail instead of opening a nested modal", () => {
    let opened: string | null = null;
    const r = render(
      "en",
      [presence("alice", { state: "working", live: true })],
      [],
      [],
      [],
      [],
      (name) => { opened = name; },
    );

    const member = r.root.findByProps({ "data-team-member": "alice" });
    expect(member.type).toBe("button");
    act(() => member.props.onClick());
    expect(opened).toBe("alice");
  });

  test("treats presence.busy as busy and shows the current message instead of only a status label", () => {
    const r = render(
      "zh",
      [presence("evan-agent", { state: "waiting", live: true, busy: true, current_task: 42, heartbeat_at: 100 })],
      [],
      [],
      [],
      [message(42, "核对 KYC 外部 token 的签发方和 claim 契约")],
    );

    const busyLane = r.root.findByProps({ "data-status": "busy" });
    expect(treeText(busyLane)).toContain("evan-agent");
    expect(treeText(busyLane)).toContain("# 42");
    expect(treeText(busyLane)).toContain("核对 KYC 外部 token");
    expect(treeText(busyLane)).toContain("处理中");
  });

  test("surfaces a delivery-only target and its queued work in the visible busy lane", () => {
    const r = render(
      "zh",
      [],
      [],
      [],
      [delivery("delivery-evan", "Evan-Claude-Kyc", 147, "queued")],
      [message(147, "确认 message-bottle token 的归属和验证方式")],
    );

    const busyLane = r.root.findByProps({ "data-status": "busy" });
    expect(treeText(busyLane)).toContain("Evan-Claude-Kyc");
    expect(treeText(busyLane)).toContain("# 147");
    expect(treeText(busyLane)).toContain("确认 message-bottle token");
    expect(treeText(busyLane)).toContain("已排队");
    expect(treeText(r.root.findByProps({ "data-status": "offline" }))).not.toContain("Evan-Claude-Kyc");
  });

  test("falls back to the worker preview when the delivery message is outside the loaded window", () => {
    // 排队投递常指向历史窗口之外的老消息——此时用 worker 投影带的 preview，而不是占位符。
    const r = render(
      "zh",
      [],
      [],
      [],
      [delivery("old-work", "backlog-agent", 400, "queued", "为压缩全链路联调时间，两件事：kyc-claude 先接 SDK")],
      [],
    );

    const busyLane = r.root.findByProps({ "data-status": "busy" });
    expect(treeText(busyLane)).toContain("为压缩全链路联调时间");
    expect(treeText(busyLane)).not.toContain("工作内容暂不可用");
  });

  test("never shows a retracted message's local body or a stale preview for it", () => {
    // 撤回后本地行是 [retracted] 占位；delivery.preview 是撤回前的历史残留——都不能上看板。
    const r = render(
      "zh",
      [],
      [],
      [],
      [delivery("retracted-work", "tidy-agent", 42, "queued", "撤回前的敏感内容")],
      [message(42, "[retracted]", { retracted: true, retracted_at: 42 })],
    );

    const busyLane = treeText(r.root.findByProps({ "data-status": "busy" }));
    expect(busyLane).not.toContain("[retracted]");
    expect(busyLane).not.toContain("撤回前的敏感内容");
    expect(busyLane).toContain("工作内容暂不可用");
  });

  test("collapses a deep queued backlog into a summary row instead of listing every delivery", () => {
    const deliveries = Array.from({ length: 8 }, (_, i) =>
      delivery(`d${i}`, "swamped-agent", 100 + i, "queued", `任务 ${100 + i}`));
    const r = render("zh", [], [], [], deliveries, []);

    const busyLane = treeText(r.root.findByProps({ "data-status": "busy" }));
    // updated_at 倒序：展示最近 5 条（107..103），其余折叠成一行计数。
    expect(busyLane).toContain("任务 107");
    expect(busyLane).toContain("任务 103");
    expect(busyLane).not.toContain("任务 102");
    expect(busyLane).toContain("还有 3 条");
  });

  test("puts waiting-owner work in the blocked lane and ignores terminal deliveries", () => {
    const r = render(
      "en",
      [],
      [],
      [],
      [
        delivery("waiting", "needs-owner", 51, "waiting_owner"),
        delivery("done", "finished-agent", 52, "replied"),
      ],
      [message(51, "Choose the production rollout window"), message(52, "Already complete")],
    );

    expect(treeText(r.root.findByProps({ "data-status": "blocked" }))).toContain("needs-owner");
    expect(allText(r)).toContain("waiting for owner");
    expect(allText(r)).not.toContain("finished-agent");
    expect(allText(r)).not.toContain("Already complete");
  });

  test("live participants override a stale persisted offline row (#514)", () => {
    const r = render(
      "en",
      [presence("reconnected", { state: "offline", live: false })],
      [],
      [{ name: "reconnected", kind: "agent" }],
    );
    expect(treeText(r.root.findByProps({ "data-status": "idle" }))).toContain("reconnected");
    expect(treeText(r.root.findByProps({ "data-status": "offline" }))).not.toContain("reconnected");
  });

  test("human-only participant is excluded from every Agent lane (#514)", () => {
    const txt = allText(render("en", [], [], [{ name: "human-owner", kind: "human" }]));
    expect(txt).not.toContain("human-owner");
    expect(txt).toContain("No agents yet");
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

describe("agentPresenceSummary (#514)", () => {
  test("unions live and tasked agents, excludes humans, and keeps unmatched entries offline", () => {
    const summary = agentPresenceSummary(
      [
        presence("reconnected", { state: "offline", live: false }),
        presence("offline-agent", { state: "waiting", live: false }),
        presence("human-presence", { kind: "human", live: true }),
      ],
      [
        { name: "reconnected", kind: "agent" },
        { name: "participant-only", kind: "agent" },
        { name: "human-only", kind: "human" },
        { name: "human-presence", kind: "human" },
      ],
      ["task-only"],
    );

    expect([...summary.agentNames].sort()).toEqual(["offline-agent", "participant-only", "reconnected", "task-only"]);
    expect([...summary.onlineNames].sort()).toEqual(["participant-only", "reconnected"]);
    expect(summary.online).toBe(2);
    expect(summary.offline).toBe(2);
  });
});
