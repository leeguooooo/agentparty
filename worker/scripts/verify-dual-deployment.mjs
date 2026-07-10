import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readDeploymentMetadata } from "./deployment-metadata.mjs";

const expectedVersion = JSON.parse(readFileSync("../desktop/package.json", "utf8")).version;
const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const targets = {
  prod: process.env.AGENTPARTY_PROD_SMOKE_BASE ?? "https://agentparty.leeguoo.com",
  xdream: process.env.AGENTPARTY_XDREAM_SMOKE_BASE ?? "https://agentparty.pwtk-dev.work",
};

const entries = await Promise.all(Object.entries(targets).map(async ([name, base]) => {
  const metadata = await readDeploymentMetadata(base);
  if (metadata.version !== expectedVersion) {
    throw new Error(`${name}: version mismatch: expected ${expectedVersion}, got ${metadata.version}`);
  }
  if (metadata.commit !== expectedCommit) {
    throw new Error(`${name}: commit mismatch: expected ${expectedCommit}, got ${metadata.commit}`);
  }
  return [name, metadata];
}));

const verified = Object.fromEntries(entries);
if (verified.prod.deployed_at !== verified.xdream.deployed_at) {
  throw new Error(`deployment timestamp mismatch: prod=${verified.prod.deployed_at}, xdream=${verified.xdream.deployed_at}`);
}

console.log(JSON.stringify(verified, null, 2));
