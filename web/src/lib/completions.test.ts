import { describe, expect, test } from "bun:test";
import type { MsgFrame } from "@agentparty/shared";
import { completionMessages, isCompletionMessage } from "./completions";

function message(seq: number, over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    type: "msg",
    seq,
    sender: { name: "bob", kind: "agent" },
    kind: "message",
    body: "",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1_725_000_000_000 + seq,
    ...over,
  };
}

describe("completion helpers", () => {
  test("selects only final synthesis completion artifacts", () => {
    const plain = message(1);
    const status = message(2, { kind: "status", state: "done", note: "done" });
    const completion = message(3, {
      reply_to: 1,
      completion_artifact: {
        kickoff_seq: 1,
        replies_count: 2,
        timeout: false,
        related_issues: [5],
        related_prs: [],
      },
    });

    expect(isCompletionMessage(plain)).toBe(false);
    expect(isCompletionMessage(status)).toBe(false);
    expect(isCompletionMessage(completion)).toBe(true);
    expect(completionMessages([plain, status, completion]).map((m) => m.seq)).toEqual([3]);
  });
});

