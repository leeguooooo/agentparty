#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ACK_RE = /^\s*(?:review-ack:|合并前已读|合并者 review 结论)/iu;
const PR_AGENT_RE = /PR Reviewer Guide/iu;

function epoch(value) {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function isBot(user) {
  return user?.type === "Bot" || /\[bot\]$/iu.test(user?.login ?? "");
}

function latest(items, timeOf) {
  return items.reduce((best, item) => (best === undefined || timeOf(item) > timeOf(best) ? item : best), undefined);
}

function reviewTime(review) {
  return epoch(review.submitted_at ?? review.updated_at ?? review.created_at);
}

function commentTime(comment) {
  return epoch(comment.updated_at ?? comment.created_at);
}

function runTime(run) {
  return epoch(run.run_started_at ?? run.created_at ?? run.updated_at);
}

function statusTime(status) {
  return epoch(status.updated_at ?? status.created_at);
}

export function evaluateReviewAck({
  headSha,
  reviews = [],
  comments = [],
  prAgentRuns = [],
  statuses = [],
  requireCodeRabbit = true,
}) {
  const prAgentRun = latest(
    prAgentRuns.filter(
      (run) =>
        run.path === ".github/workflows/pr-agent.yml" &&
        run.head_sha === headSha &&
        run.event === "pull_request",
    ),
    runTime,
  );
  if (prAgentRun === undefined || prAgentRun.status !== "completed") {
    return { ok: false, code: "waiting_pr_agent", description: "等待当前 head 的 pr_agent workflow 完成" };
  }

  const codeRabbitStatus = latest(
    statuses.filter((status) => status.context === "CodeRabbit"),
    statusTime,
  );
  if (requireCodeRabbit && (codeRabbitStatus === undefined || codeRabbitStatus.state === "pending")) {
    return { ok: false, code: "waiting_coderabbit", description: "等待当前 head 的 CodeRabbit review 落地" };
  }

  const codeRabbitReviews = reviews.filter(
    (review) =>
      review.commit_id === headSha &&
      isBot(review.user) &&
      /coderabbit/iu.test(review.user?.login ?? "") &&
      review.state !== "PENDING" &&
      review.state !== "DISMISSED",
  );
  if (requireCodeRabbit && codeRabbitReviews.length === 0) {
    return { ok: false, code: "waiting_coderabbit", description: "等待当前 head 的 CodeRabbit review 落地" };
  }

  // pr_agent 端点失败时 job 仍会 completed/success，但没有评论；按设计不因缺评论永久卡红。
  // 有评论时，只接受当前 pr_agent run 启动后创建/更新的 Reviewer Guide，避免拿旧 head 的评论充数。
  const prAgentArtifacts = comments.filter(
    (comment) =>
      isBot(comment.user) &&
      PR_AGENT_RE.test(comment.body ?? "") &&
      commentTime(comment) >= runTime(prAgentRun),
  );
  const botArtifactTimes = [
    ...prAgentArtifacts.map(commentTime),
    ...codeRabbitReviews.map(reviewTime),
  ].filter((time) => time > 0);
  if (botArtifactTimes.length === 0) {
    return {
      ok: false,
      code: "missing_bot_review",
      description: "当前 head 尚无任何 bot review，无法判定 ack",
    };
  }
  const latestBotReviewAt = botArtifactTimes.length > 0 ? Math.max(...botArtifactTimes) : 0;

  const humanReviews = reviews.filter(
    (review) => !isBot(review.user) && review.state !== "PENDING" && review.state !== "DISMISSED",
  );
  const ackComments = comments.filter((comment) => !isBot(comment.user) && ACK_RE.test(comment.body ?? ""));
  const ackTimes = [...humanReviews.map(reviewTime), ...ackComments.map(commentTime)].filter((time) => time > 0);
  if (ackTimes.length === 0) {
    return { ok: false, code: "missing_ack", description: "请在读完最新 bot review 后留下 review-ack 结论" };
  }
  const latestAckAt = Math.max(...ackTimes);
  if (latestAckAt <= latestBotReviewAt) {
    return { ok: false, code: "stale_ack", description: "已有 ack 早于最新 bot review；请读完后重新 ack" };
  }
  return {
    ok: true,
    code: "ack_after_reviews",
    description: "ack 晚于当前 head 的最新 bot review",
    latestAckAt,
    latestBotReviewAt,
  };
}

export async function githubJson(path, token, collectionKey, request = fetch) {
  const all = [];
  let objectPage;
  let url = `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (url !== null) {
    const response = await request(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    const body = await response.json();
    if (Array.isArray(body)) all.push(...body);
    else if (collectionKey !== undefined) {
      if (!Array.isArray(body?.[collectionKey])) {
        throw new Error(`GitHub API response is missing collection ${collectionKey}`);
      }
      objectPage ??= body;
      all.push(...body[collectionKey]);
    } else return body;
    const next = response.headers
      .get("link")
      ?.split(",")
      .map((part) => part.trim())
      .find((part) => part.endsWith('rel="next"'))
      ?.match(/^<([^>]+)>/)?.[1];
    url = next ?? null;
  }
  return collectionKey === undefined ? all : { ...objectPage, [collectionKey]: all };
}

async function postStatus(repo, sha, token, result) {
  const response = await fetch(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      state: result.ok ? "success" : "failure",
      context: "review-ack",
      description: result.description.slice(0, 140),
    }),
  });
  if (!response.ok) throw new Error(`status POST ${response.status}: ${await response.text()}`);
}

export function selectWorkflowPullNumber(headSha, pulls) {
  const matches = pulls.filter((pull) => pull.state === "open" && pull.head?.sha === headSha);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one open PR for workflow head ${headSha}, found ${matches.length}`);
  }
  return String(matches[0].number);
}

export async function runReviewAckGate(env, dependencies = { githubJson, postStatus }) {
  const repo = env.REPO;
  const token = env.GH_TOKEN;
  if (!repo || !token) throw new Error("REPO and GH_TOKEN are required");
  const dryRun = env.DRY_RUN === "true";
  let pr = env.PR;
  let knownHeadSha = env.KNOWN_HEAD_SHA ?? env.WORKFLOW_HEAD_SHA;
  let redHeadSha;
  const markRed = async (sha, description) => {
    if (dryRun) return;
    await dependencies.postStatus(repo, sha, token, { ok: false, description });
    redHeadSha = sha;
  };

  try {
    // pull_request/review 与 workflow_run 事件都已携带 head SHA：在任何解析 API 请求前先置红，
    // 即使反查 PR 或读取 pull 失败，也不能让同一 SHA 上旧的 success 原样残留。
    if (knownHeadSha) {
      await markRed(knownHeadSha, "正在解析 PR 并核验当前 head 的 bot review 与人工 ack");
    }
    if (!pr) {
      const workflowHeadSha = env.WORKFLOW_HEAD_SHA;
      if (!workflowHeadSha) throw new Error("PR or WORKFLOW_HEAD_SHA is required");
      const pulls = await dependencies.githubJson(`/repos/${repo}/commits/${workflowHeadSha}/pulls`, token);
      pr = selectWorkflowPullNumber(workflowHeadSha, pulls);
    }
    const pull = await dependencies.githubJson(`/repos/${repo}/pulls/${pr}`, token);
    const headSha = pull.head?.sha;
    if (!headSha) throw new Error(`cannot resolve PR #${pr} head SHA`);
    if (knownHeadSha && knownHeadSha !== headSha) {
      throw new Error(`event head ${knownHeadSha} does not match PR #${pr} head ${headSha}`);
    }
    knownHeadSha = headSha;
    if (redHeadSha !== headSha) {
      await markRed(headSha, "正在核验当前 head 的最新 bot review 与人工 ack");
    }
    const [reviews, comments, runsBody, statuses] = await Promise.all([
      dependencies.githubJson(`/repos/${repo}/pulls/${pr}/reviews`, token),
      dependencies.githubJson(`/repos/${repo}/issues/${pr}/comments`, token),
      dependencies.githubJson(
        `/repos/${repo}/actions/workflows/pr-agent.yml/runs?head_sha=${encodeURIComponent(headSha)}`,
        token,
        "workflow_runs",
      ),
      dependencies.githubJson(`/repos/${repo}/commits/${headSha}/statuses`, token),
    ]);
    const result = evaluateReviewAck({
      headSha,
      reviews,
      comments,
      prAgentRuns: runsBody.workflow_runs ?? [],
      statuses,
      requireCodeRabbit: env.REQUIRE_CODERABBIT !== "false",
    });
    if (!dryRun) await dependencies.postStatus(repo, headSha, token, result);
    return { pr, headSha, result };
  } catch (error) {
    if (knownHeadSha && !dryRun) {
      await dependencies
        .postStatus(repo, knownHeadSha, token, {
          ok: false,
          description: `review-ack 评估异常，fail-closed：${error instanceof Error ? error.message : String(error)}`,
        })
        .catch(() => undefined);
    }
    throw error;
  }
}

async function main() {
  const { headSha, result } = await runReviewAckGate(process.env);
  console.log(`review-ack=${result.ok ? "success" : "failure"} code=${result.code} @ ${headSha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
