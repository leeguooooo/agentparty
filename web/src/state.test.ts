import { describe, expect, test } from "bun:test";
import type { MsgFrame, PresenceFrame } from "@agentparty/shared";
import { channelReducer, initialChannelState } from "./state";

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
    // 低于上限时不动原状态（引用相等，避免无谓重渲染）
    expect(channelReducer(trimmed, { type: "trim", keep: 4 })).toBe(trimmed);
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
      current_task: 45,
      task_started_at: 1_725_000_000_100,
      heartbeat_at: 1_725_000_001_000,
    };
    const next = channelReducer(initialChannelState, { type: "frame", frame });

    expect(next.presence["runner-a"]).toMatchObject({
      live: true,
      busy: true,
      queue_depth: 2,
      current_task: 45,
      task_started_at: 1_725_000_000_100,
      heartbeat_at: 1_725_000_001_000,
    });
  });
});
