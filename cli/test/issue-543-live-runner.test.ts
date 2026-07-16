import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  executeIssue543LiveRunner,
  ISSUE_543_TIMEOUT_MS,
  type PartyCommandResult,
} from "../scripts/issue-543-live-runner";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ap-543-live-runner-"));
  tempDirs.push(dir);
  return dir;
}

function contextFile(over: Record<string, unknown> = {}): string {
  const path = join(tempDir(), "wake-context.json");
  writeFileSync(path, JSON.stringify({
    channel: "qa-543",
    seq: 41,
    body: "ordinary wake",
    self: "v118-primary",
    delivery: {
      id: "delivery-41",
      work_id: "work-41",
      continuation_ref: "continuation-41",
      cause: "mention",
      attempt: 1,
    },
    decision_response: null,
    ...over,
  }));
  return path;
}

function env(file: string, over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    AP_CONTEXT_FILE: file,
    AP_CHANNEL: "qa-543",
    AP_SEQ: "41",
    AP_SELF: "v118-primary",
    AP_DELIVERY_ID: "delivery-41",
    AP_WORK_ID: "work-41",
    AP_CONTINUATION_REF: "continuation-41",
    ...over,
  };
}

function successful(stdout = "sent seq=99\n"): PartyCommandResult {
  return { code: 0, stdout, stderr: "" };
}

describe("#543 reusable live runner", () => {
  test("ordinary wakes send exactly one linked reply carrying QA543_NODE", async () => {
    const file = contextFile();
    const calls: string[][] = [];
    const result = await executeIssue543LiveRunner({
      env: env(file, { QA543_NODE: "release-v118" }),
      runParty: async (args) => {
        calls.push(args);
        return successful();
      },
    });

    expect(result).toEqual({ kind: "linked_reply", triggerSeq: 41, node: "release-v118" });
    expect(calls).toEqual([[
      "send",
      "QA543-LINKED-REPLY QA543_NODE=release-v118 trigger_seq=41 delivery=delivery-41 attempt=1",
      "--channel", "qa-543",
      "--reply-to", "41",
      "--no-reach",
    ]]);
  });

  test("timeout marker sleeps past the outer timeout and never calls party", async () => {
    const file = contextFile({ body: "please run QA543-TIMEOUT" });
    const sleeps: number[] = [];
    let partyCalls = 0;
    await expect(executeIssue543LiveRunner({
      env: env(file),
      sleep: async (ms) => { sleeps.push(ms); },
      runParty: async () => {
        partyCalls += 1;
        return successful();
      },
    })).rejects.toThrow("outer runner timeout did not fire");
    expect(sleeps).toEqual([ISSUE_543_TIMEOUT_MS]);
    expect(partyCalls).toBe(0);
  });

  test("unattended marker requires auto-resolution then replies in the same invocation", async () => {
    const file = contextFile({ body: "请处理 QA543-UNATTENDED" });
    const calls: string[][] = [];
    const result = await executeIssue543LiveRunner({
      env: env(file),
      runParty: async (args) => {
        calls.push(args);
        if (args[0] === "decision") {
          return successful(JSON.stringify({
            seq: 52,
            decision_resolution: { state: "auto_resolved", chosen_index: 0, chosen_option: "proceed" },
          }));
        }
        return successful();
      },
    });

    expect(result).toEqual({
      kind: "unattended_reply",
      triggerSeq: 41,
      decisionSeq: 52,
      node: "v118-primary",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "decision", "ask", "QA543 unattended choice for trigger seq 41",
      "--option", "proceed", "--option", "stop",
      "--channel", "qa-543", "--json",
    ]);
    expect(calls[1]).toEqual([
      "send",
      "QA543-UNATTENDED-REPLY QA543_NODE=v118-primary trigger_seq=41 decision_seq=52 delivery=delivery-41 attempt=1",
      "--channel", "qa-543",
      "--reply-to", "41",
      "--no-reach",
    ]);
  });

  test("unattended marker refuses a pending decision instead of pretending it resumed", async () => {
    const file = contextFile({ body: "QA543-UNATTENDED" });
    let calls = 0;
    await expect(executeIssue543LiveRunner({
      env: env(file),
      runParty: async () => {
        calls += 1;
        return successful(JSON.stringify({
          seq: 53,
          decision_resolution: { state: "pending" },
        }));
      },
    })).rejects.toThrow("was not auto_resolved");
    expect(calls).toBe(1);
  });

  test("unattended marker rejects a decision whose index and option disagree", async () => {
    const file = contextFile({ body: "QA543-UNATTENDED" });
    let calls = 0;
    await expect(executeIssue543LiveRunner({
      env: env(file),
      runParty: async () => {
        calls += 1;
        return successful(JSON.stringify({
          seq: 54,
          // Self-contradictory receipt: option "proceed" but index points at the second option.
          decision_resolution: { state: "auto_resolved", chosen_index: 1, chosen_option: "proceed" },
        }));
      },
    })).rejects.toThrow("was not auto_resolved");
    expect(calls).toBe(1);
  });

  test("owner marker parks one lineage-bound decision without posting a premature reply", async () => {
    const file = contextFile({ body: "QA543-OWNER-ASK" });
    const calls: string[][] = [];
    const result = await executeIssue543LiveRunner({
      env: env(file),
      runParty: async (args) => {
        calls.push(args);
        return successful(JSON.stringify({
          seq: 60,
          state: "waiting_owner",
          decision_resolution: { state: "pending" },
        }));
      },
    });

    expect(result).toEqual({ kind: "waiting_owner", triggerSeq: 41, decisionSeq: 60, node: "v118-primary" });
    expect(calls).toEqual([[
      "decision", "ask", "QA543 owner approval for trigger seq 41",
      "--option", "continue", "--option", "stop",
      "--channel", "qa-543", "--json",
    ]]);
  });

  test("owner_answer verifies exact work/ref/channel lineage and replies to the answer frame", async () => {
    const file = contextFile({
      seq: 72,
      body: "@qa-agent decision #60 → continue",
      delivery: {
        id: "delivery-owner-72",
        work_id: "work-41",
        continuation_ref: "continuation-41",
        cause: "owner_answer",
        attempt: 1,
      },
      decision_response: {
        request_seq: 60,
        chosen_index: 0,
        chosen_option: "continue",
        prompt: "QA543 owner approval for trigger seq 41",
        delivery_id: "delivery-41",
        origin_seq: 41,
        origin_channel: "qa-543",
        work_id: "work-41",
        continuation_ref: "continuation-41",
      },
    });
    const calls: string[][] = [];
    const result = await executeIssue543LiveRunner({
      env: env(file, { AP_SEQ: "72", AP_DELIVERY_ID: "delivery-owner-72" }),
      runParty: async (args) => {
        calls.push(args);
        return successful();
      },
    });

    expect(result).toEqual({ kind: "owner_resumed", triggerSeq: 72, originSeq: 41, node: "v118-primary" });
    expect(calls).toEqual([[
      "send",
      "QA543-OWNER-RESUMED QA543_NODE=v118-primary origin_seq=41 answer=continue origin_delivery=delivery-41 delivery=delivery-own attempt=1",
      "--channel", "qa-543",
      "--reply-to", "72",
      "--no-reach",
    ]]);
  });

  test("owner_answer fails closed before party when continuation lineage is crossed", async () => {
    const file = contextFile({
      seq: 72,
      body: "owner answer",
      delivery: {
        id: "delivery-owner-72",
        work_id: "work-41",
        continuation_ref: "continuation-41",
        cause: "owner_answer",
        attempt: 1,
      },
      decision_response: {
        request_seq: 60,
        chosen_index: 0,
        chosen_option: "continue",
        prompt: "QA543 owner approval for trigger seq 41",
        delivery_id: "delivery-41",
        origin_seq: 41,
        origin_channel: "qa-543",
        work_id: "work-other",
        continuation_ref: "continuation-41",
      },
    });
    let calls = 0;
    await expect(executeIssue543LiveRunner({
      env: env(file, { AP_SEQ: "72", AP_DELIVERY_ID: "delivery-owner-72" }),
      runParty: async () => {
        calls += 1;
        return successful();
      },
    })).rejects.toThrow("owner response work id does not match current work");
    expect(calls).toBe(0);
  });

  test("ambiguous control markers fail before party", async () => {
    const file = contextFile({ body: "QA543-TIMEOUT QA543-UNATTENDED" });
    let calls = 0;
    await expect(executeIssue543LiveRunner({
      env: env(file),
      sleep: async () => {},
      runParty: async () => {
        calls += 1;
        return successful();
      },
    })).rejects.toThrow("multiple QA543 control markers");
    expect(calls).toBe(0);
  });

  test("QA543_REQUIRE_DIRECTED rejects a legacy raw wake before posting evidence", async () => {
    const file = contextFile({ delivery: null });
    let calls = 0;
    await expect(executeIssue543LiveRunner({
      env: env(file, {
        QA543_REQUIRE_DIRECTED: "1",
        AP_DELIVERY_ID: undefined,
        AP_WORK_ID: undefined,
        AP_CONTINUATION_REF: undefined,
      }),
      runParty: async () => {
        calls += 1;
        return successful();
      },
    })).rejects.toThrow("directed delivery context is required");
    expect(calls).toBe(0);
  });

  test("owner_answer requires the original delivery id before posting evidence", async () => {
    const file = contextFile({
      seq: 72,
      body: "owner answer",
      delivery: {
        id: "delivery-owner-72",
        work_id: "work-41",
        continuation_ref: "continuation-41",
        cause: "owner_answer",
        attempt: 1,
      },
      decision_response: {
        request_seq: 60,
        chosen_index: 0,
        chosen_option: "continue",
        prompt: "QA543 owner approval for trigger seq 41",
        origin_seq: 41,
        origin_channel: "qa-543",
        work_id: "work-41",
        continuation_ref: "continuation-41",
      },
    });
    let calls = 0;
    await expect(executeIssue543LiveRunner({
      env: env(file, { AP_SEQ: "72", AP_DELIVERY_ID: "delivery-owner-72" }),
      runParty: async () => {
        calls += 1;
        return successful();
      },
    })).rejects.toThrow("context.decision_response.delivery_id is required");
    expect(calls).toBe(0);
  });

  test("the executable resolves literal party from PATH and passes no token/server", async () => {
    const root = tempDir();
    const bin = join(root, "bin");
    const capture = join(root, "argv.txt");
    const context = join(root, "context.json");
    mkdirSync(bin, { recursive: true });
    writeFileSync(context, JSON.stringify({
      channel: "qa-path",
      seq: 9,
      body: "ordinary",
      self: "qa-agent",
      delivery: null,
      decision_response: null,
    }));
    const fakeParty = join(bin, "party");
    writeFileSync(fakeParty, `#!/bin/sh\nprintf '%s\\n' "$@" > "$QA543_CAPTURE"\nprintf 'sent seq=10\\n'\n`);
    chmodSync(fakeParty, 0o755);
    const script = resolve(import.meta.dir, "../scripts/issue-543-live-runner.ts");
    const child = Bun.spawn([process.execPath, script], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        QA543_CAPTURE: capture,
        AP_CONTEXT_FILE: context,
        AP_CHANNEL: "qa-path",
        AP_SEQ: "9",
        AP_SELF: "qa-agent",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, kind: "linked_reply", node: "qa-agent" });
    const argv = readFileSync(capture, "utf8").trim().split("\n");
    expect(argv).toEqual([
      "send",
      "QA543-LINKED-REPLY QA543_NODE=qa-agent trigger_seq=9",
      "--channel", "qa-path",
      "--reply-to", "9",
      "--no-reach",
    ]);
    expect(argv.join(" ")).not.toContain("token");
    expect(argv.join(" ")).not.toContain("server");
  });
});
