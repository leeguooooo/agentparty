import { describe, expect, test } from "bun:test";
import type { DirectedDelivery, MsgFrame, PresenceFrame } from "@agentparty/shared";
import { channelReducer, initialChannelState } from "./state";

const NOW_FOR_RETENTION = 1_725_000_000_000;

function msgFrame(seq: number, body: string, over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    type: "msg",
    seq,
    sender: { name: "bob", kind: "agent" },
    kind: "message",
    body,
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    ts: 1_725_000_000_000 + seq,
    ...over,
  };
}

function delivery(over: Partial<DirectedDelivery> = {}): DirectedDelivery {
  return {
    id: "delivery-1",
    message_seq: 6,
    target_name: "builder",
    cause: "mention",
    state: "queued",
    attempt: 0,
    lease_until: null,
    work_id: "work-1",
    continuation_ref: null,
    reply_seq: null,
    last_error: null,
    created_at: 100,
    updated_at: 100,
    ...over,
  };
}

describe("channel state", () => {
  test("ignores duplicate history frames without revision metadata", () => {
    const first = channelReducer(initialChannelState, { type: "frame", frame: msgFrame(6, "original") });
    const duplicate = channelReducer(first, { type: "frame", frame: msgFrame(6, "stale duplicate") });

    expect(duplicate.messages).toHaveLength(1);
    expect(duplicate.messages[0]?.body).toBe("original");
  });

  test("replaces same-seq history frames when they carry revision metadata", () => {
    const first = channelReducer(initialChannelState, { type: "frame", frame: msgFrame(6, "original") });
    const revised = channelReducer(first, {
      type: "frame",
      frame: msgFrame(6, "edited", { edited: true, edited_at: 1_725_000_000_999, edited_by: "bob" }),
    });

    expect(revised.messages).toHaveLength(1);
    expect(revised.messages[0]).toMatchObject({ seq: 6, body: "edited", edited: true });
  });

  test("message_update replaces the message and refreshes the stable mention sender snapshot", () => {
    const original = msgFrame(6, "original", {
      sender: { name: "external", kind: "agent", owner: "lark:on_cross" },
    });
    const first = channelReducer(initialChannelState, { type: "frame", frame: original });
    const edited = msgFrame(6, "edited", {
      sender: { name: "external", kind: "agent", handle: "external-handle" },
      edited: true,
      edited_at: original.ts + 1,
      edited_by: "external",
    });
    const revised = channelReducer(first, {
      type: "frame",
      frame: {
        type: "message_update",
        target_seq: 6,
        action: "edit",
        actor: { name: "external", kind: "agent" },
        ts: edited.ts,
        message: edited,
      },
    });

    expect(revised.messages[0]).toMatchObject({ seq: 6, body: "edited", edited: true });
    expect(revised.mentionSenders.external).toMatchObject({
      ts: edited.ts,
      sender: { name: "external", owner: "lark:on_cross", handle: "external-handle" },
    });
  });

  test("prepending an older page keeps messages sorted and deduped (IM scroll-up)", () => {
    let s = initialChannelState;
    for (const seq of [51, 52, 53]) s = channelReducer(s, { type: "frame", frame: msgFrame(seq, `m${seq}`) });
    // 上翻拉回的老页乱序/交叠 prepend，仍应升序去重
    for (const seq of [49, 50, 51]) s = channelReducer(s, { type: "frame", frame: msgFrame(seq, `m${seq}`) });
    expect(s.messages.map((m) => m.seq)).toEqual([49, 50, 51, 52, 53]);
  });

  test("trim keeps only the newest N messages and is a no-op below the cap", () => {
    let s = initialChannelState;
    for (let seq = 1; seq <= 10; seq++) s = channelReducer(s, { type: "frame", frame: msgFrame(seq, `m${seq}`) });
    const trimmed = channelReducer(s, { type: "trim", keep: 4 });
    expect(trimmed.messages.map((m) => m.seq)).toEqual([7, 8, 9, 10]);
    expect(trimmed.mentionSenders.bob?.ts).toBe(msgFrame(10, "").ts); // @ 身份窗口不随 DOM 消息窗口一起裁掉
    // 低于上限时不动原状态（引用相等，避免无谓重渲染）
    expect(channelReducer(trimmed, { type: "trim", keep: 4 })).toBe(trimmed);
  });

  test("mention sender snapshot survives trim and merges complete identity fields", () => {
    let s = channelReducer(initialChannelState, {
      type: "frame",
      frame: msgFrame(1, "complete", {
        sender: { name: "external", kind: "agent", owner: "lark:on_cross", handle: "external-handle" },
      }),
    });
    s = channelReducer(s, {
      type: "frame",
      frame: msgFrame(2, "sparse", { sender: { name: "external", kind: "agent" } }),
    });
    s = channelReducer(s, { type: "trim", keep: 1 });

    expect(s.messages.map((m) => m.seq)).toEqual([2]);
    expect(s.mentionSenders.external).toMatchObject({
      ts: msgFrame(2, "").ts,
      sender: { name: "external", owner: "lark:on_cross", handle: "external-handle" },
    });
  });

  test("an older loaded frame only fills gaps and never overwrites a newer sender identity", () => {
    let s = channelReducer(initialChannelState, {
      type: "frame",
      frame: msgFrame(20, "new", {
        sender: { name: "external", kind: "agent", owner: "new-owner", handle: "new-handle" },
      }),
    });
    s = channelReducer(s, {
      type: "frame",
      frame: msgFrame(10, "old", {
        sender: { name: "external", kind: "agent", owner: "old-owner", display_name: "Old display" },
      }),
    });

    expect(s.mentionSenders.external).toMatchObject({
      ts: msgFrame(20, "").ts,
      sender: {
        name: "external",
        owner: "new-owner",
        handle: "new-handle",
        display_name: "Old display",
      },
    });
    expect(s.mentionSenders.external).not.toHaveProperty("body");
  });

  test("mention sender snapshots older than 14 days are evicted on the next write", () => {
    const DAY = 24 * 60 * 60 * 1000;
    let s = channelReducer(initialChannelState, {
      type: "frame",
      frame: msgFrame(1, "old", { ts: NOW_FOR_RETENTION, sender: { name: "old-agent", kind: "agent" } }),
    });
    s = channelReducer(s, {
      type: "frame",
      frame: msgFrame(2, "new", { ts: NOW_FOR_RETENTION + 15 * DAY, sender: { name: "new-agent", kind: "agent" } }),
    });

    expect(Object.keys(s.mentionSenders)).toEqual(["new-agent"]);
  });

  test("read_cursor frame upserts monotonically; welcome snapshot seeds cursors", () => {
    // welcome 带 read_cursors 快照 → 初始化
    let s = channelReducer(initialChannelState, {
      type: "frame",
      frame: {
        type: "welcome",
        channel: "c",
        self: "me",
        participants: [],
        last_seq: 10,
        presence: [],
        read_cursors: [{ name: "alice", kind: "agent", last_seen_seq: 5, updated_at: 1 }],
      },
    });
    expect(s.readCursors.alice?.last_seen_seq).toBe(5);
    // 前移 → 更新
    s = channelReducer(s, { type: "frame", frame: { type: "read_cursor", name: "alice", kind: "agent", last_seen_seq: 8, updated_at: 2 } });
    expect(s.readCursors.alice?.last_seen_seq).toBe(8);
    // 回退 → 忽略（引用相等，不触发重渲染）
    const before = s;
    s = channelReducer(s, { type: "frame", frame: { type: "read_cursor", name: "alice", kind: "agent", last_seen_seq: 3, updated_at: 3 } });
    expect(s).toBe(before);
    expect(s.readCursors.alice?.last_seen_seq).toBe(8);
  });

  test("delivery_state is monotonic, accepts same-millisecond progress, and ignores exact replays", () => {
    let s = channelReducer(initialChannelState, {
      type: "frame",
      frame: { type: "delivery_state", delivery: delivery() },
    });
    expect(s.directedDeliveries["delivery-1"]).toMatchObject({ state: "queued", updated_at: 100 });

    s = channelReducer(s, {
      type: "frame",
      frame: { type: "delivery_state", delivery: delivery({ state: "running", attempt: 1, updated_at: 200 }) },
    });
    expect(s.directedDeliveries["delivery-1"]).toMatchObject({ state: "running", updated_at: 200 });
    expect(s.directedDeliveries["delivery-1"]).not.toHaveProperty("attempt");

    const current = s;
    s = channelReducer(s, {
      type: "frame",
      frame: { type: "delivery_state", delivery: delivery({ state: "failed", updated_at: 150 }) },
    });
    expect(s).toBe(current);
    expect(s.directedDeliveries["delivery-1"]?.state).toBe("running");

    const sameMillisecondProgress = channelReducer(s, {
      type: "frame",
      frame: { type: "delivery_state", delivery: delivery({ state: "replied", updated_at: 200 }) },
    });
    expect(sameMillisecondProgress.directedDeliveries["delivery-1"]?.state).toBe("replied");

    const replay = channelReducer(sameMillisecondProgress, {
      type: "frame",
      frame: { type: "delivery_state", delivery: delivery({ state: "replied", updated_at: 200 }) },
    });
    expect(replay).toBe(sameMillisecondProgress);
  });

  test("projects delivery and delivery_state frames onto an exact public allow-list", () => {
    const privateKeys = [
      "cause",
      "attempt",
      "lease_until",
      "work_id",
      "continuation_ref",
      "last_error",
      "error",
    ];
    const maliciousStateDelivery = {
      ...delivery({
        id: "public-state",
        state: "waiting_owner",
        attempt: 7,
        lease_until: 999,
        work_id: "secret-work",
        continuation_ref: "secret-thread",
        last_error: "secret-stack",
      }),
      error: "secret-generic-error",
    };

    const fromStateFrame = channelReducer(initialChannelState, {
      type: "frame",
      frame: { type: "delivery_state", delivery: maliciousStateDelivery },
    });
    expect(fromStateFrame.directedDeliveries["public-state"]).toEqual({
      id: "public-state",
      message_seq: 6,
      target_name: "builder",
      state: "waiting_owner",
      reply_seq: null,
      created_at: 100,
      updated_at: 100,
    });
    for (const key of privateKeys) {
      expect(fromStateFrame.directedDeliveries["public-state"]).not.toHaveProperty(key);
    }

    // A replay that changes only private fields is still an exact public replay and must not churn state.
    const privateOnlyReplay = channelReducer(fromStateFrame, {
      type: "frame",
      frame: {
        type: "delivery_state",
        delivery: { ...maliciousStateDelivery, work_id: "different-secret", attempt: 99 },
      },
    });
    expect(privateOnlyReplay).toBe(fromStateFrame);

    const message = msgFrame(7, "@builder holder payload", { mentions: ["builder"] });
    const maliciousHolderDelivery = {
      ...delivery({
        id: "holder-frame",
        message_seq: 7,
        state: "running",
        cause: "retry",
        attempt: 3,
        lease_until: 1_000,
        work_id: "holder-work",
        continuation_ref: "holder-thread",
        last_error: "holder-stack",
      }),
      error: "holder-generic-error",
    };
    const fromHolderFrame = channelReducer(fromStateFrame, {
      type: "frame",
      frame: { type: "delivery", delivery: maliciousHolderDelivery, message },
    });
    expect(fromHolderFrame.directedDeliveries["holder-frame"]).toEqual({
      id: "holder-frame",
      message_seq: 7,
      target_name: "builder",
      state: "running",
      reply_seq: null,
      created_at: 100,
      updated_at: 100,
    });
    for (const key of privateKeys) {
      expect(fromHolderFrame.directedDeliveries["holder-frame"]).not.toHaveProperty(key);
    }
  });

  test("delivery frame stores its status and referenced message once", () => {
    const message = msgFrame(6, "@builder please investigate", { mentions: ["builder"] });
    const first = channelReducer(initialChannelState, {
      type: "frame",
      frame: { type: "delivery", delivery: delivery({ state: "claimed", attempt: 1 }), message },
    });
    expect(first.messages.map((item) => item.seq)).toEqual([6]);
    expect(first.directedDeliveries["delivery-1"]?.state).toBe("claimed");

    const duplicate = channelReducer(first, {
      type: "frame",
      frame: { type: "delivery", delivery: delivery({ state: "claimed", attempt: 1 }), message },
    });
    expect(duplicate).toBe(first);

    const revised = channelReducer(first, {
      type: "frame",
      frame: {
        type: "message_update",
        target_seq: 6,
        action: "edit",
        actor: { name: "bob", kind: "agent" },
        ts: message.ts + 1,
        message: msgFrame(6, "edited request", { edited: true, edited_at: message.ts + 1, edited_by: "bob" }),
      },
    });
    const lateDeliverySnapshot = channelReducer(revised, {
      type: "frame",
      frame: {
        type: "delivery",
        delivery: delivery({ state: "running", attempt: 1, updated_at: 101 }),
        message,
      },
    });
    expect(lateDeliverySnapshot.messages[0]?.body).toBe("edited request");
    expect(lateDeliverySnapshot.directedDeliveries["delivery-1"]?.state).toBe("running");
  });

  test("preserves lineage on incremental presence frames", () => {
    const frame: PresenceFrame = {
      type: "presence",
      name: "child-a",
      kind: "human",
      account: "owner@example.com",
      state: "working",
      note: "checking",
      ts: 1_725_000_000_000,
      status: {
        owner: "child-a",
        state: "working",
        scope: ["web/src"],
        summary_seq: null,
        blocked_reason: null,
        updated_at: 1_725_000_000_000,
        workflow: {
          workflow_id: "wf-ui",
          kind: "parallel",
          run_id: "run-1",
          step_id: "render",
          parent_summary_seq: 4,
        },
      },
      lineage: {
        parent_agent: "parent-a",
        root_agent: "parent-a",
        team_id: "team-a",
        depth: 1,
        expires_at: 1_725_000_060_000,
      },
    };
    const next = channelReducer(initialChannelState, { type: "frame", frame });

    expect(next.presence["child-a"]?.lineage).toEqual(frame.lineage);
    expect(next.presence["child-a"]?.status?.workflow).toEqual(frame.status?.workflow);
    expect(next.presence["child-a"]?.kind).toBe("human");
    expect(next.presence["child-a"]?.account).toBe("owner@example.com");
  });

  test("carries handle through standalone presence frames", () => {
    const frame: PresenceFrame = {
      type: "presence",
      name: "child-a",
      kind: "human",
      account: "owner@example.com",
      state: "working",
      note: null,
      ts: 1_725_000_000_000,
      handle: "leo",
    };
    const next = channelReducer(initialChannelState, { type: "frame", frame });

    expect(next.presence["child-a"]?.handle).toBe("leo");
  });

  test("carries active-task heartbeat fields through incremental presence frames (#472)", () => {
    const frame: PresenceFrame = {
      type: "presence",
      name: "runner-a",
      kind: "agent",
      state: "working",
      note: "handling wake",
      ts: 1_725_000_000_000,
      live: true,
      busy: true,
      queue_depth: 2,
      waiting_owner_count: 3,
      current_task: 45,
      task_started_at: 1_725_000_000_100,
      heartbeat_at: 1_725_000_001_000,
    };
    const next = channelReducer(initialChannelState, { type: "frame", frame });

    expect(next.presence["runner-a"]).toMatchObject({
      live: true,
      busy: true,
      queue_depth: 2,
      waiting_owner_count: 3,
      current_task: 45,
      task_started_at: 1_725_000_000_100,
      heartbeat_at: 1_725_000_001_000,
    });

    const cleared = channelReducer(next, {
      type: "frame",
      frame: { ...frame, ts: frame.ts + 1, waiting_owner_count: undefined },
    });
    expect(cleared.presence["runner-a"]?.waiting_owner_count).toBeUndefined();
  });
});
