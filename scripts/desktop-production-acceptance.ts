#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { compareVersionPrecedence, validateVersion } from "./release-version";

const SCHEMA = "agentparty.desktop-acceptance.v3";
const BUNDLE_IDENTIFIER = "com.agentparty.desktop";

export interface InstalledAppEvidence {
  schema: typeof SCHEMA;
  capturedAt: string;
  appPath: string;
  version: string;
  bundleIdentifier: string;
  executablePath: string;
  executableSha256: string;
  sidecarVersion: string;
  sidecarSha256: string;
  signingAuthority: string;
  teamIdentifier: string;
  codeIdentifier: string;
  designatedRequirement: string;
  entitlementsSha256: string;
  codesignVerified: true;
  gatekeeperAccepted: true;
  notarizationStapled: true;
}

export interface UpdaterReceipt {
  status: "success";
  source: null;
  stage: "relaunch";
  category: null;
  timestamp: number;
  appVersion: string;
  targetVersion: string;
}

export interface UpgradeAcceptanceReport {
  schema: typeof SCHEMA;
  status: "passed";
  fromVersion: string;
  toVersion: string;
  appPath: string;
  executablePath: string;
  processId: number;
  receiptTimestamp: number;
  verifiedAt: string;
}

export type AcceptanceCliOptions =
  | { command: "baseline"; app: string; expectedVersion: string; output: string }
  | { command: "verify"; app: string; expectedVersion: string; baseline: string; receipt: string };

function requireValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseAcceptanceCliArgs(argv: readonly string[]): AcceptanceCliOptions {
  const command = argv[0];
  if (command !== "baseline" && command !== "verify") {
    throw new Error("expected baseline or verify command");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--")) throw new Error(`unexpected argument: ${name ?? ""}`);
    if (values.has(name)) throw new Error(`${name} may only be provided once`);
    values.set(name, requireValue(argv, index, name));
  }
  const allowed = command === "baseline"
    ? new Set(["--app", "--expected-version", "--output"])
    : new Set(["--app", "--expected-version", "--baseline", "--receipt"]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown argument: ${name}`);
  }
  const app = values.get("--app");
  const expectedVersion = values.get("--expected-version");
  if (!app) throw new Error("--app is required");
  if (!expectedVersion) throw new Error("--expected-version is required");
  validateVersion(expectedVersion);
  if (command === "baseline") {
    const output = values.get("--output");
    if (!output) throw new Error("--output is required");
    return { command, app, expectedVersion, output };
  }
  const baseline = values.get("--baseline");
  const receipt = values.get("--receipt");
  if (!baseline) throw new Error("--baseline is required");
  if (!receipt) throw new Error("--receipt is required");
  return { command, app, expectedVersion, baseline, receipt };
}

function run(command: string, args: readonly string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(command)} failed (${result.status ?? "unknown"})`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function plist(path: string, key: string): string {
  return run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path]).stdout.trim();
}

function sha256(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function requireInstalledApplication(path: string): string {
  const canonical = realpathSync(resolve(path));
  if (!canonical.startsWith("/Applications/") || !canonical.endsWith(".app")) {
    throw new Error("desktop acceptance requires an app installed under /Applications");
  }
  return canonical;
}

export function parseDesignatedRequirement(requirement: string): {
  codeIdentifier: string;
  teamIdentifier: string;
} {
  const identifiers = [...requirement.matchAll(/\bidentifier\s+"([^"]+)"/g)];
  const teamMatches = [...requirement.matchAll(
    /\bcertificate\s+leaf\[subject\.OU]\s*=\s*(?:"([A-Z0-9]{10})"|([A-Z0-9]{10})(?![A-Z0-9]))/g,
  )];
  const anchors = [...requirement.matchAll(/\banchor\s+apple\s+generic\b/g)];
  const codeIdentifier = identifiers[0]?.[1];
  const teamMatch = teamMatches[0];
  const teamIdentifier = teamMatch?.[1] ?? teamMatch?.[2];
  if (!codeIdentifier
    || !teamIdentifier
    || identifiers.length !== 1
    || teamMatches.length !== 1
    || anchors.length !== 1
    || /\bor\b/i.test(requirement)
    || /\bcdhash\b/i.test(requirement)) {
    throw new Error("desktop designated requirement is not stable Developer ID identity");
  }
  return { codeIdentifier, teamIdentifier };
}

export function inspectInstalledApp(app: string, expectedVersion: string): InstalledAppEvidence {
  if (process.platform !== "darwin") throw new Error("desktop production acceptance requires macOS");
  const appPath = requireInstalledApplication(app);
  const info = join(appPath, "Contents", "Info.plist");
  const version = validateVersion(plist(info, "CFBundleShortVersionString"));
  if (version !== expectedVersion) {
    throw new Error(`installed app version mismatch: expected ${expectedVersion}, found ${version}`);
  }
  const bundleIdentifier = plist(info, "CFBundleIdentifier");
  if (bundleIdentifier !== BUNDLE_IDENTIFIER) throw new Error("installed app bundle identifier mismatch");
  const executablePath = realpathSync(join(appPath, "Contents", "MacOS", plist(info, "CFBundleExecutable")));
  const sidecarPath = realpathSync(join(appPath, "Contents", "MacOS", "party"));
  if ((statSync(executablePath).mode & 0o111) === 0 || (statSync(sidecarPath).mode & 0o111) === 0) {
    throw new Error("desktop executable or bundled sidecar is not executable");
  }
  const sidecarVersion = validateVersion(run(sidecarPath, ["--version"]).stdout.trim());
  if (sidecarVersion !== expectedVersion) throw new Error("bundled sidecar version mismatch");

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
  const signature = run("codesign", ["-dv", "--verbose=4", appPath]).stderr;
  const signingAuthority = signature.match(/^Authority=(Developer ID Application: .+)$/m)?.[1];
  const teamIdentifier = signature.match(/^TeamIdentifier=([A-Z0-9]+)$/m)?.[1];
  const codeIdentifier = signature.match(/^Identifier=(.+)$/m)?.[1];
  const designatedRequirement = run("codesign", ["-d", "-r-", "--", appPath]).stderr
    .match(/^designated => (.+)$/m)?.[1];
  const entitlements = run("codesign", ["-d", "--entitlements", ":-", "--", appPath]).stdout;
  const entitlementsSha256 = createHash("sha256").update(entitlements).digest("hex");
  if (!signingAuthority || !teamIdentifier) throw new Error("Developer ID signing identity is missing");
  if (codeIdentifier !== bundleIdentifier) throw new Error("CodeDirectory identifier does not match the app bundle");
  if (!designatedRequirement) {
    throw new Error("desktop designated requirement is not stable Developer ID identity");
  }
  const requirementIdentity = parseDesignatedRequirement(designatedRequirement);
  if (requirementIdentity.codeIdentifier !== bundleIdentifier
    || requirementIdentity.teamIdentifier !== teamIdentifier) {
    throw new Error("desktop designated requirement does not match the signed application identity");
  }

  return {
    schema: SCHEMA,
    capturedAt: new Date().toISOString(),
    appPath,
    version,
    bundleIdentifier,
    executablePath,
    executableSha256: sha256(executablePath),
    sidecarVersion,
    sidecarSha256: sha256(sidecarPath),
    signingAuthority,
    teamIdentifier,
    codeIdentifier,
    designatedRequirement,
    entitlementsSha256,
    codesignVerified: true,
    gatekeeperAccepted: true,
    notarizationStapled: true,
  };
}

function isEvidence(value: unknown): value is InstalledAppEvidence {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const structurallyValid = item.schema === SCHEMA
    && typeof item.capturedAt === "string"
    && typeof item.appPath === "string"
    && typeof item.version === "string"
    && typeof item.bundleIdentifier === "string"
    && typeof item.executablePath === "string"
    && typeof item.executableSha256 === "string"
    && /^[0-9a-f]{64}$/.test(item.executableSha256)
    && typeof item.sidecarVersion === "string"
    && typeof item.sidecarSha256 === "string"
    && /^[0-9a-f]{64}$/.test(item.sidecarSha256)
    && typeof item.signingAuthority === "string"
    && typeof item.teamIdentifier === "string"
    && typeof item.codeIdentifier === "string"
    && typeof item.designatedRequirement === "string"
    && typeof item.entitlementsSha256 === "string"
    && /^[0-9a-f]{64}$/.test(item.entitlementsSha256)
    && item.codesignVerified === true
    && item.gatekeeperAccepted === true
    && item.notarizationStapled === true;
  if (!structurallyValid || !Number.isFinite(Date.parse(item.capturedAt as string))) return false;
  try {
    validateVersion(item.version as string);
    validateVersion(item.sidecarVersion as string);
    const requirementIdentity = parseDesignatedRequirement(item.designatedRequirement as string);
    if (requirementIdentity.codeIdentifier !== item.codeIdentifier
      || requirementIdentity.teamIdentifier !== item.teamIdentifier) return false;
  } catch {
    return false;
  }
  return true;
}

export function parseUpdaterReceipt(value: unknown): UpdaterReceipt {
  if (typeof value !== "object" || value === null) throw new Error("updater receipt is invalid");
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt).sort();
  const expectedKeys = ["appVersion", "category", "source", "stage", "status", "targetVersion", "timestamp"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || receipt.status !== "success"
    || receipt.source !== null
    || receipt.stage !== "relaunch"
    || receipt.category !== null
    || typeof receipt.timestamp !== "number"
    || !Number.isSafeInteger(receipt.timestamp)
    || receipt.timestamp <= 0
    || typeof receipt.appVersion !== "string"
    || typeof receipt.targetVersion !== "string") {
    throw new Error("updater receipt is invalid");
  }
  validateVersion(receipt.appVersion);
  validateVersion(receipt.targetVersion);
  return receipt as unknown as UpdaterReceipt;
}

export function verifyUpgradeEvidence(
  baseline: InstalledAppEvidence,
  current: InstalledAppEvidence,
  receipt: UpdaterReceipt,
  running: Array<{ pid: number; executablePath: string }>,
  expectedVersion: string,
  verifiedAt = new Date().toISOString(),
): UpgradeAcceptanceReport {
  if (baseline.schema !== SCHEMA || current.schema !== SCHEMA) throw new Error("desktop evidence schema mismatch");
  if (current.version !== expectedVersion || current.sidecarVersion !== expectedVersion) {
    throw new Error("upgraded app version does not match the expected release");
  }
  if (compareVersionPrecedence(baseline.version, current.version) >= 0) {
    throw new Error("desktop upgrade did not advance the installed version");
  }
  if (baseline.appPath !== current.appPath || baseline.bundleIdentifier !== current.bundleIdentifier) {
    throw new Error("desktop upgrade changed the installed application identity");
  }
  if (baseline.executableSha256 === current.executableSha256 || baseline.sidecarSha256 === current.sidecarSha256) {
    throw new Error("desktop upgrade did not replace both bundled executables");
  }
  const baselineRequirement = parseDesignatedRequirement(baseline.designatedRequirement);
  const currentRequirement = parseDesignatedRequirement(current.designatedRequirement);
  if (baseline.teamIdentifier !== current.teamIdentifier
    || baseline.codeIdentifier !== current.codeIdentifier
    || baselineRequirement.codeIdentifier !== currentRequirement.codeIdentifier
    || baselineRequirement.teamIdentifier !== currentRequirement.teamIdentifier
    || baselineRequirement.codeIdentifier !== baseline.codeIdentifier
    || currentRequirement.codeIdentifier !== current.codeIdentifier
    || baselineRequirement.teamIdentifier !== baseline.teamIdentifier
    || currentRequirement.teamIdentifier !== current.teamIdentifier) {
    throw new Error("desktop code-signing identity changed during upgrade");
  }
  if (baseline.entitlementsSha256 !== current.entitlementsSha256) {
    throw new Error("desktop signed entitlements changed during upgrade");
  }
  if (!baseline.signingAuthority.startsWith("Developer ID Application:")
    || !current.signingAuthority.startsWith("Developer ID Application:")) {
    throw new Error("desktop evidence is not Developer ID signed");
  }
  if (receipt.appVersion !== expectedVersion || receipt.targetVersion !== expectedVersion) {
    throw new Error("updater receipt does not confirm the expected version");
  }
  const baselineTimestamp = Date.parse(baseline.capturedAt);
  const currentTimestamp = Date.parse(current.capturedAt);
  const verificationTimestamp = Date.parse(verifiedAt);
  if (!Number.isFinite(baselineTimestamp)
    || !Number.isFinite(currentTimestamp)
    || !Number.isFinite(verificationTimestamp)
    || currentTimestamp <= baselineTimestamp
    || receipt.timestamp < baselineTimestamp
    || receipt.timestamp > verificationTimestamp) {
    throw new Error("updater receipt is stale or outside the acceptance window");
  }
  const matching = running.filter(({ executablePath }) => executablePath === current.executablePath);
  const sameName = running.filter(({ executablePath }) => basename(executablePath) === basename(current.executablePath));
  if (matching.length !== 1 || sameName.length !== 1) {
    throw new Error("expected exactly one running desktop process from the installed app");
  }
  return {
    schema: SCHEMA,
    status: "passed",
    fromVersion: baseline.version,
    toVersion: current.version,
    appPath: current.appPath,
    executablePath: current.executablePath,
    processId: matching[0].pid,
    receiptTimestamp: receipt.timestamp,
    verifiedAt,
  };
}

function runningDesktopProcesses(executableName: string): Array<{ pid: number; executablePath: string }> {
  return run("ps", ["-axo", "pid=,comm="]).stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), executablePath: match[2] }))
    .filter(({ executablePath }) => basename(executablePath) === executableName);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function requirePrivateFile(path: string, label: string): string {
  const file = resolve(path);
  const metadata = statSync(file);
  if (!metadata.isFile()) throw new Error(`${label} is not a file`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must not be group- or world-readable`);
  return file;
}

function atomicWriteJson(path: string, value: unknown): void {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, output);
}

function main(argv: readonly string[]): void {
  const options = parseAcceptanceCliArgs(argv);
  const evidence = inspectInstalledApp(options.app, options.expectedVersion);
  if (options.command === "baseline") {
    atomicWriteJson(options.output, evidence);
    console.log(`desktop production baseline recorded: ${resolve(options.output)}`);
    return;
  }
  const baselinePath = requirePrivateFile(options.baseline, "desktop baseline evidence");
  const receiptPath = requirePrivateFile(options.receipt, "updater receipt");
  const baselineValue = readJson(baselinePath);
  if (!isEvidence(baselineValue)) throw new Error("desktop baseline evidence is invalid");
  const receipt = parseUpdaterReceipt(readJson(receiptPath));
  const report = verifyUpgradeEvidence(
    baselineValue,
    evidence,
    receipt,
    runningDesktopProcesses(basename(evidence.executablePath)),
    options.expectedVersion,
  );
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`desktop-production-acceptance: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
