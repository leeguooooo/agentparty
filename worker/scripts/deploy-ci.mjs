// CI worker 部署（#420）。
//
// 与本地 deploy-dual.mjs 的区别：CI 用 Cloudflare 原生凭据（CLOUDFLARE_API_TOKEN /
// CLOUDFLARE_ACCOUNT_ID，由 job 环境注入），而非本机 wrangler-accounts profile。
// prod 与 xdream 是两个独立 Cloudflare 账号，各自在自己的 GitHub Environment 里
// 提供一套 token/account，一个 job 只部署一个 target。
//
// 每个 target 的顺序（迁移 ↔ 代码守卫）：
//   1. wrangler d1 migrations apply   —— 先把 schema 迁到位
//   2. verify-remote-schema.mjs       —— 校验迁移全部应用且必需列/索引存在，
//                                        失败即中断，绝不进入 deploy（半上线守卫）
//   3. wrangler deploy                —— 带 build 元数据 --define，供 /api/health 回读
//   4. verifyDeploymentMetadata       —— 拉取线上 health 确认 version+commit+时间戳
//   5. smoke（token 齐全时）          —— 端到端冒烟
//
// wrangler 启动器由 AGENTPARTY_WRANGLER_BIN 决定（空格分词），CI 传 "bunx wrangler"
// 走 worker devDependency 里的原生 wrangler；缺省 "wrangler" 走 PATH。

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deploymentDefineArgs, verifyDeploymentMetadata } from "./deployment-metadata.mjs";

export const DEPLOY_TARGETS = {
  prod: {
    config: "wrangler.jsonc",
    database: "agentparty",
    smokeBase: "https://agentparty.leeguoo.com",
  },
  xdream: {
    config: "wrangler.xdream.jsonc",
    database: "agentparty-xdream",
    smokeBase: "https://agentparty.pwtk-dev.work",
  },
};

// AGENTPARTY_WRANGLER_BIN 允许多词命令（如 "bunx wrangler"）。空格分词后第一个是
// 可执行文件，其余是固定前缀参数。缺省单独的 "wrangler"（PATH 上的原生 wrangler）。
export function parseWranglerLauncher(env = process.env) {
  const raw = (env.AGENTPARTY_WRANGLER_BIN ?? "wrangler").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : ["wrangler"];
}

// 返回一个 target 的有序执行计划（纯函数，便于单测断言命令构造，不触发任何 IO）。
export function buildDeployPlan(targetName, metadata, launcher = ["wrangler"]) {
  const target = DEPLOY_TARGETS[targetName];
  if (!target) {
    throw new Error(`unknown deploy target: ${targetName} (expected one of ${Object.keys(DEPLOY_TARGETS).join(", ")})`);
  }
  if (!Array.isArray(launcher) || launcher.length === 0) {
    throw new Error("wrangler launcher must be a non-empty argv array");
  }
  const [bin, ...prefix] = launcher;
  const wrangler = (args) => ({ cmd: bin, args: [...prefix, ...args] });
  const defineArgs = deploymentDefineArgs(metadata);

  return [
    {
      label: "migrate",
      ...wrangler(["d1", "migrations", "apply", target.database, "--remote", "--config", target.config]),
    },
    {
      label: "verify-schema",
      cmd: "node",
      args: ["scripts/verify-remote-schema.mjs"],
      env: {
        AGENTPARTY_D1_DATABASE: target.database,
        AGENTPARTY_WRANGLER_CONFIG: target.config,
      },
    },
    {
      label: "deploy",
      ...wrangler(["deploy", "--config", target.config, ...defineArgs]),
    },
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

function smokeEnv(name, key) {
  const scoped = process.env[`AGENTPARTY_${name.toUpperCase()}_${key}`];
  return scoped ?? process.env[`AGENTPARTY_${key}`];
}

async function deployTarget(name, metadata, launcher) {
  const target = DEPLOY_TARGETS[name];
  console.error(`\n==> Deploying ${name} (${target.config}) via ${launcher.join(" ")}`);

  for (const step of buildDeployPlan(name, metadata, launcher)) {
    run(step.cmd, step.args, { env: step.env });
  }

  const smokeBase = smokeEnv(name, "SMOKE_BASE") ?? target.smokeBase;
  await verifyDeploymentMetadata(smokeBase, metadata);
  console.error(`Verified ${name}: ${metadata.version} ${metadata.commit}`);

  run("node", ["scripts/smoke-desktop-pairing.mjs"], { env: { AGENTPARTY_SMOKE_BASE: smokeBase } });

  const smokeToken = smokeEnv(name, "SMOKE_TOKEN");
  const smokeWriteToken = smokeEnv(name, "SMOKE_WRITE_TOKEN");
  if (smokeToken && smokeWriteToken) {
    run("node", ["scripts/smoke-prod.mjs"], {
      env: {
        AGENTPARTY_SMOKE_BASE: smokeBase,
        AGENTPARTY_SMOKE_TOKEN: smokeToken,
        AGENTPARTY_SMOKE_WRITE_TOKEN: smokeWriteToken,
      },
    });
  } else {
    console.error(`Skipping ${name} write-path smoke: SMOKE_TOKEN / SMOKE_WRITE_TOKEN not both set.`);
  }
}

async function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const names = requested.length > 0 ? requested : ["prod", "xdream"];
  for (const name of names) {
    if (!DEPLOY_TARGETS[name]) throw new Error(`unknown deploy target: ${name}`);
  }

  const launcher = parseWranglerLauncher();
  const metadata = {
    version: JSON.parse(readFileSync("../desktop/package.json", "utf8")).version,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    deployed_at: new Date().toISOString(),
  };

  run("bun", ["run", "build:web"]);
  for (const name of names) await deployTarget(name, metadata, launcher);
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
