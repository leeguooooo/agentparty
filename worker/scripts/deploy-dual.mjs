import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { deploymentDefineArgs, verifyDeploymentMetadata } from "./deployment-metadata.mjs";

function smokeBaseFromConfig(config) {
  const text = readFileSync(config, "utf8");
  const match = text.match(/"pattern"\s*:\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`could not infer smoke base from ${config}; set an explicit smoke base env var`);
  }
  return `https://${match[1].replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

const targets = {
  prod: {
    profile: process.env.AGENTPARTY_PROD_PROFILE ?? "leeguooooo",
    config: "wrangler.jsonc",
    database: "agentparty",
    smokeBase: process.env.AGENTPARTY_PROD_SMOKE_BASE ?? smokeBaseFromConfig("wrangler.jsonc"),
    smokeToken: process.env.AGENTPARTY_SMOKE_TOKEN,
    smokeWriteToken: process.env.AGENTPARTY_SMOKE_WRITE_TOKEN,
  },
  xdream: {
    profile: process.env.AGENTPARTY_XDREAM_PROFILE ?? "Xdreamstar2025",
    config: "wrangler.xdream.jsonc",
    database: "agentparty-xdream",
    smokeBase: process.env.AGENTPARTY_XDREAM_SMOKE_BASE ?? smokeBaseFromConfig("wrangler.xdream.jsonc"),
    smokeToken: process.env.AGENTPARTY_XDREAM_SMOKE_TOKEN,
    smokeWriteToken: process.env.AGENTPARTY_XDREAM_SMOKE_WRITE_TOKEN,
  },
};

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit ${res.status}`);
  }
}

const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
if (trackedChanges !== "") throw new Error("refusing to deploy tracked, uncommitted changes");

const deploymentMetadata = {
  version: JSON.parse(readFileSync("../desktop/package.json", "utf8")).version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  deployed_at: new Date().toISOString(),
};

async function deployTarget(name) {
  const target = targets[name];
  if (!target) throw new Error(`unknown deploy target: ${name}`);

  console.error(`\n==> Deploying ${name} with ${target.profile} (${target.config})`);
  const env = { WRANGLER_PROFILE: target.profile };
  run("wrangler-accounts", ["--profile", target.profile, "d1", "migrations", "apply", target.database, "--remote", "--config", target.config], { env });
  run("node", ["scripts/verify-remote-schema.mjs"], {
    env: {
      ...env,
      AGENTPARTY_D1_DATABASE: target.database,
      AGENTPARTY_WRANGLER_CONFIG: target.config,
    },
  });
  run("wrangler-accounts", [
    "--profile", target.profile,
    "deploy", "--config", target.config,
    ...deploymentDefineArgs(deploymentMetadata),
  ], { env });
  await verifyDeploymentMetadata(target.smokeBase, deploymentMetadata);
  console.error(`Verified ${name} deployment: ${deploymentMetadata.version} ${deploymentMetadata.commit}`);
  run("node", ["scripts/smoke-desktop-pairing.mjs"], {
    env: { ...env, AGENTPARTY_SMOKE_BASE: target.smokeBase },
  });

  if (target.smokeToken && target.smokeWriteToken) {
    run("node", ["scripts/smoke-prod.mjs"], {
      env: {
        AGENTPARTY_SMOKE_BASE: target.smokeBase,
        AGENTPARTY_SMOKE_TOKEN: target.smokeToken,
        AGENTPARTY_SMOKE_WRITE_TOKEN: target.smokeWriteToken,
      },
    });
  } else {
    console.error(`Skipping ${name} smoke: smoke token env vars are not both set.`);
  }
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : ["prod", "xdream"];

run("bun", ["run", "build:web"]);
for (const name of names) await deployTarget(name);
