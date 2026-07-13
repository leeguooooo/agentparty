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
  return epoch(run.started_at ?? run.created_at ?? run.completed_at);
}

function statusTime(status) {
  return epoch(status.updated_at ?? status.created_at);
}

export function evaluateReviewAck({
  headSha,
  reviews = [],
  comments = [],
  checkRuns = [],
  statuses = [],
  requireCodeRabbit = true,
}) {
  const prAgentRun = latest(
    checkRuns.filter((run) => run.name === "pr_agent"),
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

async function githubJson(path, token) {
  const all = [];
  let url = `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (url !== null) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    const body = await response.json();
    if (Array.isArray(body)) all.push(...body);
    else return body;
    const next = response.headers
      .get("link")
      ?.split(",")
      .map((part) => part.trim())
      .find((part) => part.endsWith('rel="next"'))
      ?.match(/^<([^>]+)>/)?.[1];
    url = next ?? null;
  }
  return all;
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

async function main() {
  const repo = process.env.REPO;
  const pr = process.env.PR;
  const token = process.env.GH_TOKEN;
  if (!repo || !pr || !token) throw new Error("REPO, PR and GH_TOKEN are required");
  const pull = await githubJson(`/repos/${repo}/pulls/${pr}`, token);
  const headSha = pull.head?.sha;
  if (!headSha) throw new Error(`cannot resolve PR #${pr} head SHA`);
  const dryRun = process.env.DRY_RUN === "true";
  // 同一 head 上可能残留旧 success。先置 failure，再抓 review；后续任何 API 异常都会 fail-safe，
  // 不会因为脚本中途退出而让旧的绿色 review-ack 继续放行。
  if (!dryRun) {
    await postStatus(repo, headSha, token, {
      ok: false,
      description: "正在核验当前 head 的最新 bot review 与人工 ack",
    });
  }
  const [reviews, comments, checksBody, statuses] = await Promise.all([
    githubJson(`/repos/${repo}/pulls/${pr}/reviews`, token),
    githubJson(`/repos/${repo}/issues/${pr}/comments`, token),
    githubJson(`/repos/${repo}/commits/${headSha}/check-runs`, token),
    githubJson(`/repos/${repo}/commits/${headSha}/statuses`, token),
  ]);
  const result = evaluateReviewAck({
    headSha,
    reviews,
    comments,
    checkRuns: checksBody.check_runs ?? [],
    statuses,
    requireCodeRabbit: process.env.REQUIRE_CODERABBIT !== "false",
  });
  if (!dryRun) await postStatus(repo, headSha, token, result);
  console.log(`review-ack=${result.ok ? "success" : "failure"} code=${result.code} @ ${headSha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
