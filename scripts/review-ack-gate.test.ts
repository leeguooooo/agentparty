import { describe, expect, test } from "bun:test";
import { evaluateReviewAck } from "./review-ack-gate.mjs";

const headSha = "abc123";
const user = (login: string, type: "User" | "Bot" = "User") => ({ login, type });
const completedChecks = [
  { name: "pr_agent", status: "completed", conclusion: "success", started_at: "2026-07-13T10:00:00Z" },
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

function evaluate(over: Record<string, unknown> = {}) {
  return evaluateReviewAck({
    headSha,
    reviews: [codeRabbitReview],
    comments: [prAgentGuide],
    checkRuns: completedChecks,
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
    expect(workflow).toContain("statuses: write");
    expect(workflow).toContain("run: node scripts/review-ack-gate.mjs");
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
      comments: [
        prAgentGuide,
        { user: user("maintainer"), body: "review-ack: early", created_at: "2026-07-13T10:03:00Z" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("waiting_coderabbit");
  });

  test("waits for the current-head pr_agent workflow to finish", () => {
    const result = evaluate({
      checkRuns: [{ ...completedChecks[0], status: "in_progress", conclusion: null }],
      comments: [{ user: user("maintainer"), body: "review-ack: early", created_at: "2026-07-13T10:03:00Z" }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("waiting_pr_agent");
  });
});
