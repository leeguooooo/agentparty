// CI worker 回滚（#420）。
//
// wrangler 无「D1 回滚」，只能回滚 worker 代码到上一个已发布 deployment。本脚本只做
// worker 代码回滚这一件可自动化的事：
//   1. wrangler deployments list   —— 打印可回退的版本（审计 / 供操作者挑 id）
//   2. wrangler rollback [<id>]    —— 不带 id 回退到上一个 deployment；带 id 回退到指定
//   3. 读回线上 /api/health        —— 打印回滚后线上实际 version+commit（不做强校验，
//                                     因为回退目标的 commit 不一定等于当前 HEAD）
//
// D1 schema 的回退是破坏性且不可自动化的（time-travel 会丢数据），只能人工兜底——见
// docs/deploy-rollback.md。本脚本刻意不碰 D1。
//
// 凭据同 deploy-ci：CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 由 job 环境注入，
// wrangler 启动器由 AGENTPARTY_WRANGLER_BIN 决定（CI 传 "bunx wrangler"）。

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseWranglerLauncher, DEPLOY_TARGETS } from "./deploy-ci.mjs";
import { readDeploymentMetadata } from "./deployment-metadata.mjs";

// 返回一个 target 回滚的有序执行计划（纯函数，便于单测）。
export function buildRollbackPlan(targetName, options = {}, launcher = ["wrangler"]) {
  const target = DEPLOY_TARGETS[targetName];
  if (!target) {
    throw new Error(`unknown rollback target: ${targetName} (expected one of ${Object.keys(DEPLOY_TARGETS).join(", ")})`);
  }
  if (!Array.isArray(launcher) || launcher.length === 0) {
    throw new Error("wrangler launcher must be a non-empty argv array");
  }
  const { deploymentId, message } = options;
  const [bin, ...prefix] = launcher;
  const wrangler = (args) => ({ cmd: bin, args: [...prefix, ...args] });
  const rollbackArgs = ["rollback"];
  if (deploymentId) rollbackArgs.push(deploymentId);
  rollbackArgs.push("--config", target.config, "--message", message ?? "CI rollback (#420)");

  return [
    { label: "list", ...wrangler(["deployments", "list", "--config", target.config]) },
    { label: "rollback", ...wrangler(rollbackArgs) },
  ];
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit ${res.status}`);
  }
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--deployment-id") options.deploymentId = argv[++i];
    else if (arg === "--message") options.message = argv[++i];
    else if (arg.startsWith("-")) throw new Error(`unknown argument: ${arg}`);
    else positionals.push(arg);
  }
  return { positionals, options };
}

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  if (positionals.length !== 1) {
    throw new Error("usage: rollback-ci.mjs <prod|xdream> [--deployment-id <id>] [--message <msg>]");
  }
  const name = positionals[0];
  const target = DEPLOY_TARGETS[name];
  if (!target) throw new Error(`unknown rollback target: ${name}`);

  const launcher = parseWranglerLauncher();
  console.error(`\n==> Rolling back ${name} (${target.config}) via ${launcher.join(" ")}`);

  for (const step of buildRollbackPlan(name, options, launcher)) {
    run(step.cmd, step.args);
  }

  try {
    const smokeBase = process.env[`AGENTPARTY_${name.toUpperCase()}_SMOKE_BASE`] ?? target.smokeBase;
    const metadata = await readDeploymentMetadata(smokeBase);
    console.error(`Post-rollback ${name} live: version=${metadata.version} commit=${metadata.commit} deployed_at=${metadata.deployed_at}`);
  } catch (error) {
    console.error(`Post-rollback health read failed (rollback itself succeeded): ${error instanceof Error ? error.message : error}`);
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
