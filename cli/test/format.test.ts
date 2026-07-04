import { describe, expect, test } from "bun:test";
import type { MsgFrame } from "@agentparty/shared";
import { formatMsg } from "../src/format";

function msgFrame(over: Partial<MsgFrame> = {}): MsgFrame {
  const base: MsgFrame = {
    type: "msg",
    seq: 7,
    sender: { name: "agent-a", kind: "agent", owner: "team-a" },
    kind: "message",
    body: "hello",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1_725_000_000_000,
  };
  return { ...base, ...over };
}

describe("formatMsg", () => {
  test("prints owner context when available", () => {
    expect(formatMsg(msgFrame())).toBe("[7] agent-a(agent owner=team-a): hello");
  });

  test("omits redundant owner context", () => {
    expect(formatMsg(msgFrame({ sender: { name: "agent-a", kind: "agent", owner: "agent-a" } }))).toBe(
      "[7] agent-a(agent): hello",
    );
  });

  test("prints completion artifact context", () => {
    expect(
      formatMsg(
        msgFrame({
          reply_to: 3,
          completion_artifact: {
            kind: "final_synthesis",
            kickoff_seq: 3,
            replies_count: 0,
            timeout: true,
            related_issues: [5],
            related_prs: [],
          },
        }),
      ),
    ).toBe("[7] agent-a(agent owner=team-a) {completion}: hello\n    [completion: kickoff=#3 · replies=0 · timeout=true · issues=#5]");
  });

  test("prints lineage context when available", () => {
    expect(
      formatMsg(
        msgFrame({
          sender: {
            name: "child-a",
            kind: "agent",
            owner: "team-a",
            lineage: {
              parent_agent: "parent-a",
              root_agent: "parent-a",
              team_id: "team-run",
              depth: 1,
              expires_at: 1_725_000_060_000,
            },
          },
        }),
      ),
    ).toBe("[7] child-a(agent owner=team-a parent=parent-a team=team-run): hello");
  });
});
