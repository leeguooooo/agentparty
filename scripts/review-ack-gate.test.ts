import { describe, expect, test } from "bun:test";
import {
  evaluateReviewAck,
  githubJson,
  runReviewAckGate,
  selectWorkflowPullNumber,
  type ReviewAckInput,
} from "./review-ack-gate.mjs";

const headSha = "abc123";
const user = (login: string, type: "User" | "Bot" = "User") => ({ login, type });
const completedChecks = [
  {
    name: "PR Agent (qwen · soft-gate)",
    path: ".github/workflows/pr-agent.yml",
    head_sha: headSha,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-07-13T10:00:00Z",
  },
];
const codeRabbitStatus = [{ context: "CodeRabbit", state: "success", updated_at: "2026-07-13T10:02:00Z" }];
const codeRabbitReview = {
  user: user("coderabbitai[bot]", "Bot"),
  state: "COMMENTED",
  commit_id: headSha,
  submitted_at: "2026-07-13T10:02:00Z",
};
const prAgentGuide = {
  user: user("github-actions[bot]", "Bot"),
  body: "## PR Reviewer Guide 🔍",
  created_at: "2026-07-13T10:01:00Z",
  updated_at: "2026-07-13T10:01:00Z",
};

function evaluate(over: Partial<ReviewAckInput> = {}) {
  return evaluateReviewAck({
    headSha,
    reviews: [codeRabbitReview],
    comments: [prAgentGuide],
    prAgentRuns: completedChecks,
    statuses: codeRabbitStatus,
    ...over,
  });
}

describe("review-ack ordering gate (#460)", () => {
  test("workflow reruns after PR Agent completion with the permissions the script needs", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/review-ack.yml", import.meta.url),
    ).text();

    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain('workflows: ["PR Agent (qwen · soft-gate)"]');
    expect(workflow).toContain("checks: read");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("statuses: write");
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("run: node scripts/review-ack-gate.mjs");
    expect(workflow).toContain("WORKFLOW_HEAD_SHA: ${{ github.event.workflow_run.head_sha }}");
    expect(workflow).toContain(
      "KNOWN_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.event.workflow_run.head_sha }}",
    );
    expect(workflow).not.toContain("id: target");
    expect(workflow).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(workflow).not.toContain("workflow_run.pull_requests[0]");
  });

  test("object pagination finds the intended PR Agent workflow on a later page", async () => {
    const decoys = Array.from({ length: 100 }, (_, index) => ({
      name: `decoy-${index}`,
      path: ".github/workflows/other.yml",
      head_sha: headSha,
      event: "pull_request",
      status: "completed",
      run_started_at: "2026-07-13T09:00:00Z",
    }));
    const pages = [
      new Response(JSON.stringify({ total_count: 101, workflow_runs: decoys }), {
        headers: { link: '<https://api.github.com/next>; rel="next"' },
      }),
      new Response(JSON.stringify({ total_count: 101, workflow_runs: completedChecks })),
    ];
    const body = await githubJson<(typeof completedChecks)[number]>(
      "/repos/owner/repo/actions/workflows/pr-agent.yml/runs",
      "token",
      "workflow_runs",
      async () => pages.shift()!,
    );
    expect(body.workflow_runs).toHaveLength(101);
    expect(evaluate({ prAgentRuns: body.workflow_runs }).code).toBe("missing_ack");
  });

  test("a same-name run from another workflow cannot satisfy the PR Agent gate", () => {
    const result = evaluate({
      prAgentRuns: [{ ...completedChecks[0], path: ".github/workflows/attacker.yml" }],
    });
    expect(result.code).toBe("waiting_pr_agent");
  });

  test("known event head is marked failure before PR resolution can fail", async () => {
    const statusCalls: Array<{ sha: string; ok: boolean; description: string }> = [];
    await expect(
      runReviewAckGate(
        { REPO: "owner/repo", GH_TOKEN: "token", PR: "42", KNOWN_HEAD_SHA: headSha },
        {
          githubJson,
          request: async () => new Response("simulated pull lookup failure", { status: 500 }),
          postStatus: async (_repo, sha, _token, result) => {
            statusCalls.push({ sha, ok: result.ok, description: result.description });
          },
        },
      ),
    ).rejects.toThrow("simulated pull lookup failure");
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    expect(statusCalls[0]).toEqual({
      sha: headSha,
      ok: false,
      description: "正在解析 PR 并核验当前 head 的 bot review 与人工 ack",
    });
  });

  test("issue_comment falls back to the pull ref and marks red before pull lookup fails", async () => {
    const statusCalls: Array<{ sha: string; ok: boolean; description: string }> = [];
    let pullLookups = 0;
    await expect(
      runReviewAckGate(
        { REPO: "owner/repo", GH_TOKEN: "token", PR: "42" },
        {
          githubJson,
          request: async (url) => {
            const path = new URL(url).pathname;
            if (path.endsWith("/pulls/42")) {
              pullLookups += 1;
              return new Response("simulated pull lookup failure", { status: 500 });
            }
            if (path.endsWith("/git/ref/pull/42/head")) {
              return Response.json({ object: { sha: headSha } });
            }
            throw new Error(`unexpected path ${path}`);
          },
          postStatus: async (_repo, sha, _token, result) => {
            statusCalls.push({ sha, ok: result.ok, description: result.description });
          },
        },
      ),
    ).rejects.toThrow("simulated pull lookup failure");
    expect(pullLookups).toBe(2);
    expect(statusCalls[0]).toEqual({
      sha: headSha,
      ok: false,
      description: "正在解析 PR 并核验当前 head 的 bot review 与人工 ack",
    });
  });

  test("workflow_run uses head SHA to resolve the only open PR", () => {
    expect(
      selectWorkflowPullNumber(headSha, [
        { number: 40, state: "closed", head: { sha: headSha } },
        { number: 41, state: "open", head: { sha: "old-head" } },
        { number: 42, state: "open", head: { sha: headSha } },
      ]),
    ).toBe("42");
    expect(() => selectWorkflowPullNumber(headSha, [])).toThrow("found 0");
    expect(() =>
      selectWorkflowPullNumber(headSha, [
        { number: 42, state: "open", head: { sha: headSha } },
        { number: 43, state: "open", head: { sha: headSha } },
      ]),
    ).toThrow("found 2");
  });

  test("ack posted before bot reviews stays red", () => {
    const result = evaluate({
      comments: [
        { user: user("maintainer"), body: "review-ack: looks good", created_at: "2026-07-13T09:59:00Z" },
        prAgentGuide,
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("stale_ack");
  });

  test("ack posted after pr_agent and CodeRabbit reviews turns green", () => {
    const result = evaluate({
      comments: [
        prAgentGuide,
        { user: user("maintainer"), body: "review-ack: valid findings fixed", created_at: "2026-07-13T10:03:00Z" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("ack_after_reviews");
  });

  test("pr_agent endpoint failure does not block when its workflow completed without a comment", () => {
    const result = evaluate({
      comments: [
        { user: user("maintainer"), body: "review-ack: read CodeRabbit", created_at: "2026-07-13T10:03:00Z" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("waits for current-head CodeRabbit review even if a stale review exists", () => {
    const result = evaluate({
      reviews: [{ ...codeRabbitReview, commit_id: "old-head" }],
      statuses: [{ ...codeRabbitStatus[0], state: "pending" }],
      comments: [
        prAgentGuide,
        { user: user("maintainer"), body: "review-ack: early", created_at: "2026-07-13T10:03:00Z" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("waiting_coderabbit");
  });

  test("rejects a human reviewer whose login only looks like CodeRabbit", () => {
    const result = evaluate({
      reviews: [{ ...codeRabbitReview, user: user("coderabbit-fan", "User") }],
      statuses: [],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("waiting_coderabbit");
  });

  test("current-head CodeRabbit success status is a bot artifact even without a formal review", () => {
    const result = evaluate({ reviews: [], comments: [] });
    expect(result.code).toBe("missing_ack");
  });

  test("never accepts an ack when no bot review artifact exists", () => {
    const result = evaluate({
      requireCodeRabbit: false,
      reviews: [],
      statuses: [],
      comments: [
        { user: user("maintainer"), body: "review-ack: no bot review", created_at: "2026-07-13T10:03:00Z" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_bot_review");
  });

  test("waits for the current-head pr_agent workflow to finish", () => {
    const result = evaluate({
      prAgentRuns: [{ ...completedChecks[0], status: "in_progress", conclusion: null }],
      comments: [{ user: user("maintainer"), body: "review-ack: early", created_at: "2026-07-13T10:03:00Z" }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("waiting_pr_agent");
  });
});
