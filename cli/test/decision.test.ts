// party decision（#284）命令层：ask 上传请求、respond 回应、mode 切模式。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, writeState } from "../src/config";
import { run as decisionRun } from "../src/commands/decision";
import { continuationPath, readRunnerContinuation } from "../src/continuation";
import { startRestMock, type RestMock, type RestRequest } from "./rest-mock";

let home: string;
let mock: RestMock | null = null;
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;
const CONTINUATION_ENV = [
  "AGENTPARTY_CHANNEL",
  "AP_DELIVERY_ID",
  "AP_WORK_ID",
  "AP_CONTINUATION_REF",
  "AP_RUNNER_WORKDIR",
  "AP_RUNNER_HARNESS",
  "AP_RUNNER_SESSION_ID",
  "CODEX_THREAD_ID",
  "CLAUDE_SESSION_ID",
] as const;

function clearContinuationEnv(): void {
  for (const key of CONTINUATION_ENV) delete process.env[key];
}

function decisionHandler(request: RestRequest): Response | undefined {
  if (request.method === "POST" && request.path.endsWith("/messages")) {
    const decision = (request.body as { decision_request?: { prompt?: string } } | null)?.decision_request;
    if (decision?.prompt === "bound question") {
      return Response.json({
        seq: 7,
        decision_request: {
          kind: "choice",
          prompt: "bound question",
          options: ["A", "B"],
          delivery_id: "delivery-7",
          origin_seq: 3,
          origin_channel: "dev",
          work_id: "work-7",
          continuation_ref: "continuation-7",
        },
        decision_resolution: { state: "pending" },
      });
    }
    if (decision?.prompt === "auto question") {
      return Response.json({
        seq: 8,
        decision_request: { kind: "choice", prompt: "auto question", options: ["ship", "wait"] },
        decision_resolution: { state: "auto_resolved", chosen_index: 0, chosen_option: "ship" },
      });
    }
    if (decision?.prompt === "mismatched question") {
      return Response.json({
        seq: 9,
        decision_request: {
          kind: "approval",
          prompt: "mismatched question",
          options: ["approve", "reject"],
          work_id: "server-work",
          continuation_ref: "server-ref",
        },
        decision_resolution: { state: "pending" },
      });
    }
    return Response.json({ seq: 7 });
  }
  if (request.method === "POST" && /\/messages\/\d+\/decision$/.test(request.path)) {
    const body = request.body as { action?: string; option?: number | string };
    const chosenIndex = body.action === "approve" ? 0 : body.action === "reject" ? 1 : typeof body.option === "number" ? body.option : 0;
    return Response.json({
      message: {
        type: "msg",
        seq: 7,
        sender: { name: "agent", kind: "agent" },
        kind: "message",
        body: "plan",
        mentions: [],
        reply_to: null,
        state: null,
        note: null,
        status: null,
        decision_resolution: { state: "resolved", chosen_index: chosenIndex, chosen_option: `opt${chosenIndex}` },
        ts: 1,
      },
      reply: {
        type: "msg",
        seq: 8,
        sender: { name: "leo", kind: "human" },
        kind: "message",
        body: `@agent decision #7 → opt${chosenIndex}`,
        mentions: ["agent"],
        reply_to: 7,
        state: null,
        note: null,
        status: null,
        decision_response: { request_seq: 7, chosen_index: chosenIndex, chosen_option: `opt${chosenIndex}` },
        ts: 2,
      },
    });
  }
  if (request.method === "PUT" && request.path.endsWith("/decision-mode")) {
    return Response.json({ mode: (request.body as { mode: string }).mode });
  }
  return undefined;
}

beforeEach(() => {
  clearContinuationEnv();
  home = mkdtempSync(join(tmpdir(), "ap-decision-"));
  process.env.AGENTPARTY_HOME = home;
  logs = [];
  errs = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  mock = startRestMock(decisionHandler);
  writeConfig({ server: mock.url, token: "ap_x" });
  writeState({ channel: "dev", cursor: 0 });
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.AGENTPARTY_HOME;
  clearContinuationEnv();
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

describe("party decision ask", () => {
  test("posts an approval request (no options) carrying decision_request", async () => {
    const code = await decisionRun(["ask", "approve this plan?"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => r.method === "POST" && r.path === "/api/channels/dev/messages");
    expect((req?.body as { decision_request?: unknown }).decision_request).toEqual({ kind: "approval", prompt: "approve this plan?" });
  });

  test("turns --option into a numbered choice request", async () => {
    const code = await decisionRun(["ask", "which path?", "--option", "ship", "--option", "wait"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => r.method === "POST" && r.path === "/api/channels/dev/messages");
    expect((req?.body as { decision_request?: unknown }).decision_request).toEqual({
      kind: "choice",
      prompt: "which path?",
      options: ["ship", "wait"],
    });
  });

  test("a serve-bound pending decision returns WAITING_OWNER immediately even with --wait", async () => {
    const code = await decisionRun(["ask", "bound question", "--option", "A", "--option", "B", "--wait"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("WAITING_OWNER decision #7 work=work-7");
    expect(mock!.requests.some((request) => request.method === "GET" && request.path.includes("/messages"))).toBe(false);
  });

  test("atomically persists the exact runner continuation before a bound decision is posted", async () => {
    const workdir = join(home, "runner");
    process.env.AP_WORK_ID = "work-7";
    process.env.AP_CONTINUATION_REF = "continuation-7";
    process.env.AP_RUNNER_WORKDIR = workdir;
    process.env.AP_RUNNER_HARNESS = "codex";
    process.env.CODEX_THREAD_ID = "019f35d9-0000-7000-8000-000000000007";

    const code = await decisionRun(["ask", "bound question", "--option", "A", "--option", "B"]);

    expect(code).toBe(0);
    const path = continuationPath(workdir, "continuation-7");
    expect(existsSync(path)).toBe(true);
    expect(readRunnerContinuation(path)).toMatchObject({
      harness: "codex",
      session_id: "019f35d9-0000-7000-8000-000000000007",
      work_id: "work-7",
      continuation_ref: "continuation-7",
      workdir,
    });
    expect(readdirSync(join(workdir, "continuations")).filter((name) => name.endsWith(".json"))).toEqual([
      path.slice(path.lastIndexOf("/") + 1),
    ]);
    expect(mock!.requests.some((request) => request.method === "POST" && request.path.endsWith("/messages"))).toBe(true);
  });

  test("custom process continuation posts on the served channel without inventing a model session", async () => {
    writeState({ channel: "bound-a", cursor: 0 });
    process.env.AGENTPARTY_CHANNEL = "serve-b";
    process.env.AP_DELIVERY_ID = "delivery-7";
    process.env.AP_WORK_ID = "work-7";
    process.env.AP_CONTINUATION_REF = "continuation-7";
    process.env.AP_RUNNER_HARNESS = "custom";

    const code = await decisionRun(["ask", "bound question", "--option", "A", "--option", "B"]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("WAITING_OWNER decision #7 work=work-7");
    expect(mock!.requests.some((request) =>
      request.method === "POST" && request.path === "/api/channels/serve-b/messages"
    )).toBe(true);
    expect(mock!.requests.some((request) => request.path === "/api/channels/bound-a/messages")).toBe(false);
    expect(existsSync(join(home, "runner"))).toBe(false);
  });

  test("custom process continuation rejects a mismatched authoritative delivery after POST", async () => {
    process.env.AP_DELIVERY_ID = "wrong-delivery";
    process.env.AP_WORK_ID = "work-7";
    process.env.AP_CONTINUATION_REF = "continuation-7";
    process.env.AP_RUNNER_HARNESS = "custom";

    const code = await decisionRun(["ask", "bound question", "--option", "A", "--option", "B"]);

    expect(code).toBe(1);
    expect(mock!.requests.some((request) => request.method === "POST" && request.path.endsWith("/messages"))).toBe(true);
    expect(errs.join("\n")).toContain("custom-process continuation was not confirmed");
    expect(errs.join("\n")).toContain("expected work=work-7 ref=continuation-7 delivery=wrong-delivery");
    expect(errs.join("\n")).toContain("received work=work-7 ref=continuation-7 delivery=delivery-7");
  });

  test("refuses before POST when a directed runner has no recoverable session id", async () => {
    process.env.AP_WORK_ID = "work-7";
    process.env.AP_CONTINUATION_REF = "continuation-7";
    process.env.AP_RUNNER_WORKDIR = join(home, "runner");
    process.env.AP_RUNNER_HARNESS = "codex";

    const code = await decisionRun(["ask", "bound question", "--option", "A", "--option", "B"]);

    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("decision ask refused before POST");
    expect(errs.join("\n")).toContain("CODEX_THREAD_ID");
    expect(mock!.requests.some((request) => request.method === "POST" && request.path.endsWith("/messages"))).toBe(false);
  });

  test("blocks the saved continuation when the server confirms different lineage", async () => {
    const workdir = join(home, "runner");
    process.env.AP_WORK_ID = "local-work";
    process.env.AP_CONTINUATION_REF = "local-ref";
    process.env.AP_RUNNER_WORKDIR = workdir;
    process.env.AP_RUNNER_HARNESS = "claude";
    process.env.CLAUDE_SESSION_ID = "claude-local-session";

    const code = await decisionRun(["ask", "mismatched question"]);

    expect(code).toBe(1);
    expect(mock!.requests.some((request) => request.method === "POST" && request.path.endsWith("/messages"))).toBe(true);
    expect(readRunnerContinuation(continuationPath(workdir, "local-ref"))).toMatchObject({
      harness: "claude",
      session_id: "claude-local-session",
      work_id: "local-work",
      continuation_ref: "local-ref",
      resume_blocked_reason: expect.stringContaining("expected work=local-work ref=local-ref"),
    });
    expect(errs.join("\n")).toContain("continuation resume is blocked");
  });

  test("unattended auto-resolution prints the choice without entering the poll loop", async () => {
    const code = await decisionRun(["ask", "auto question", "--option", "ship", "--option", "wait", "--wait"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("decision #8 auto_resolved → ship");
    expect(mock!.requests.some((request) => request.method === "GET" && request.path.includes("/messages"))).toBe(false);
  });
});

describe("party decision respond", () => {
  test("maps approve to an action body", async () => {
    const code = await decisionRun(["respond", "7", "approve"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => /\/messages\/7\/decision$/.test(r.path));
    expect(req?.body).toEqual({ action: "approve" });
  });

  test("converts a 1-based positional index to a 0-based option", async () => {
    const code = await decisionRun(["respond", "7", "2"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => /\/messages\/7\/decision$/.test(r.path));
    expect(req?.body).toEqual({ option: 1 });
  });

  test("passes a reject reason", async () => {
    const code = await decisionRun(["respond", "7", "reject", "-m", "too risky"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => /\/messages\/7\/decision$/.test(r.path));
    expect(req?.body).toEqual({ action: "reject", reason: "too risky" });
  });
});

describe("party decision mode", () => {
  test("PUTs the channel decision mode", async () => {
    const code = await decisionRun(["mode", "unattended"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => r.method === "PUT" && r.path === "/api/channels/dev/decision-mode");
    expect(req?.body).toEqual({ mode: "unattended" });
    expect(logs.join("\n")).toContain("decision mode: unattended");
  });

  test("rejects an invalid mode before any request", async () => {
    const code = await decisionRun(["mode", "bogus"]);
    expect(code).toBe(1);
    expect(mock!.requests.some((r) => r.path.endsWith("/decision-mode"))).toBe(false);
  });
});
