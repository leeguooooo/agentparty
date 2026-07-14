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

import { parseUpdaterReceipt, type UpdaterReceipt } from "./desktop-production-acceptance";
import { compareVersionPrecedence, validateVersion } from "./release-version";

const SCHEMA = "agentparty.desktop-adhoc-acceptance.v1";
const REPORT_SCHEMA = "agentparty.desktop-adhoc-acceptance-report.v1";
const BUNDLE_IDENTIFIER = "com.agentparty.desktop";

export interface AdhocSignatureMetadata {
  signature: "adhoc";
  teamIdentifier: null;
  codeIdentifier: string;
}

export interface InstalledAdhocAppEvidence {
  schema: typeof SCHEMA;
  distribution: "ad-hoc";
  capturedAt: string;
  appPath: string;
  version: string;
  bundleIdentifier: string;
  executablePath: string;
  executableSha256: string;
  sidecarVersion: string;
  sidecarSha256: string;
  codeResourcesSha256: string;
  entitlementsSha256: string;
  signature: "adhoc";
  teamIdentifier: null;
  codeIdentifier: string;
  codesignVerified: true;
  gatekeeperAccepted: false;
  notarizationStapled: false;
}

export interface AdhocUpgradeAcceptanceReport {
  schema: typeof REPORT_SCHEMA;
  status: "passed";
  distribution: "ad-hoc";
  fromVersion: string;
  toVersion: string;
  baselineCapturedAt: string;
  currentCapturedAt: string;
  bundleIdentifier: string;
  codeIdentifier: string;
  fromExecutableSha256: string;
  toExecutableSha256: string;
  fromSidecarSha256: string;
  toSidecarSha256: string;
  fromCodeResourcesSha256: string;
  toCodeResourcesSha256: string;
  entitlementsSha256: string;
  appPath: string;
  executablePath: string;
  processId: number;
  receiptStatus: "success";
  receiptStage: "relaunch";
  receiptAppVersion: string;
  receiptTargetVersion: string;
  receiptTimestamp: number;
  verifiedAt: string;
  codesignVerified: true;
  gatekeeperAccepted: false;
  notarizationStapled: false;
}

export type AdhocAcceptanceCliOptions =
  | { command: "baseline"; app: string; expectedVersion: string; output: string }
  | {
    command: "verify";
    app: string;
    expectedVersion: string;
    baseline: string;
    receipt: string;
    output?: string;
  };

function requireValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseAdhocAcceptanceCliArgs(argv: readonly string[]): AdhocAcceptanceCliOptions {
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
    : new Set(["--app", "--expected-version", "--baseline", "--receipt", "--output"]);
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
  const output = values.get("--output");
  if (!baseline) throw new Error("--baseline is required");
  if (!receipt) throw new Error("--receipt is required");
  return { command, app, expectedVersion, baseline, receipt, ...(output === undefined ? {} : { output }) };
}

function run(command: string, args: readonly string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status ?? "unknown"})`);
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
    throw new Error("desktop ad-hoc acceptance requires an app installed under /Applications");
  }
  return canonical;
}

export function parseAdhocSignatureMetadata(signature: string): AdhocSignatureMetadata {
  const signatures = [...signature.matchAll(/^Signature=(.+)$/gm)];
  const identifiers = [...signature.matchAll(/^Identifier=(.+)$/gm)];
  const teams = [...signature.matchAll(/^TeamIdentifier=(.+)$/gm)];
  const authorities = [...signature.matchAll(/^Authority=(.+)$/gm)];
  if (signatures.length !== 1
    || signatures[0]?.[1] !== "adhoc"
    || identifiers.length !== 1
    || !identifiers[0]?.[1]
    || teams.length !== 1
    || teams[0]?.[1] !== "not set"
    || authorities.length !== 0) {
    throw new Error("desktop app is not exclusively ad-hoc signed");
  }
  return {
    signature: "adhoc",
    teamIdentifier: null,
    codeIdentifier: identifiers[0][1],
  };
}

export function inspectInstalledAdhocApp(app: string, expectedVersion: string): InstalledAdhocAppEvidence {
  if (process.platform !== "darwin") throw new Error("desktop ad-hoc acceptance requires macOS");
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
  const codeResourcesPath = realpathSync(join(appPath, "Contents", "_CodeSignature", "CodeResources"));
  if ((statSync(executablePath).mode & 0o111) === 0 || (statSync(sidecarPath).mode & 0o111) === 0) {
    throw new Error("desktop executable or bundled sidecar is not executable");
  }
  if (statSync(codeResourcesPath).size === 0) throw new Error("complete ad-hoc bundle signature is missing");
  const sidecarVersion = validateVersion(run(sidecarPath, ["--version"]).stdout.trim());
  if (sidecarVersion !== expectedVersion) throw new Error("bundled sidecar version mismatch");

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const metadata = parseAdhocSignatureMetadata(run("codesign", ["-dv", "--verbose=4", appPath]).stderr);
  if (metadata.codeIdentifier !== bundleIdentifier) {
    throw new Error("CodeDirectory identifier does not match the app bundle");
  }
  const entitlements = run("codesign", ["-d", "--entitlements", ":-", "--", appPath]).stdout;
  const entitlementsSha256 = createHash("sha256").update(entitlements).digest("hex");

  return {
    schema: SCHEMA,
    distribution: "ad-hoc",
    capturedAt: new Date().toISOString(),
    appPath,
    version,
    bundleIdentifier,
    executablePath,
    executableSha256: sha256(executablePath),
    sidecarVersion,
    sidecarSha256: sha256(sidecarPath),
    codeResourcesSha256: sha256(codeResourcesPath),
    entitlementsSha256,
    ...metadata,
    codesignVerified: true,
    gatekeeperAccepted: false,
    notarizationStapled: false,
  };
}

function isAdhocEvidence(value: unknown): value is InstalledAdhocAppEvidence {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const hashFields = ["executableSha256", "sidecarSha256", "codeResourcesSha256", "entitlementsSha256"];
  const valid = item.schema === SCHEMA
    && item.distribution === "ad-hoc"
    && typeof item.capturedAt === "string"
    && Number.isFinite(Date.parse(item.capturedAt))
    && typeof item.appPath === "string"
    && typeof item.version === "string"
    && typeof item.bundleIdentifier === "string"
    && typeof item.executablePath === "string"
    && typeof item.sidecarVersion === "string"
    && item.signature === "adhoc"
    && item.teamIdentifier === null
    && typeof item.codeIdentifier === "string"
    && hashFields.every((field) => typeof item[field] === "string" && /^[0-9a-f]{64}$/.test(item[field] as string))
    && item.codesignVerified === true
    && item.gatekeeperAccepted === false
    && item.notarizationStapled === false;
  if (!valid) return false;
  try {
    validateVersion(item.version as string);
    validateVersion(item.sidecarVersion as string);
  } catch {
    return false;
  }
  return true;
}

export function verifyAdhocUpgradeEvidence(
  baseline: InstalledAdhocAppEvidence,
  current: InstalledAdhocAppEvidence,
  receipt: UpdaterReceipt,
  running: Array<{ pid: number; executablePath: string }>,
  expectedVersion: string,
  verifiedAt = new Date().toISOString(),
): AdhocUpgradeAcceptanceReport {
  if (!isAdhocEvidence(baseline) || !isAdhocEvidence(current)) {
    throw new Error("desktop ad-hoc evidence is invalid");
  }
  if (current.version !== expectedVersion || current.sidecarVersion !== expectedVersion) {
    throw new Error("upgraded app version does not match the expected release");
  }
  if (compareVersionPrecedence(baseline.version, current.version) >= 0) {
    throw new Error("desktop upgrade did not advance the installed version");
  }
  if (baseline.appPath !== current.appPath
    || baseline.bundleIdentifier !== current.bundleIdentifier
    || baseline.codeIdentifier !== current.codeIdentifier) {
    throw new Error("desktop upgrade changed the installed application identity");
  }
  if (baseline.executableSha256 === current.executableSha256
    || baseline.sidecarSha256 === current.sidecarSha256
    || baseline.codeResourcesSha256 === current.codeResourcesSha256) {
    throw new Error("desktop upgrade did not replace and re-sign both bundled executables");
  }
  if (baseline.entitlementsSha256 !== current.entitlementsSha256) {
    throw new Error("desktop signed entitlements changed during upgrade");
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
    schema: REPORT_SCHEMA,
    status: "passed",
    distribution: "ad-hoc",
    fromVersion: baseline.version,
    toVersion: current.version,
    baselineCapturedAt: baseline.capturedAt,
    currentCapturedAt: current.capturedAt,
    bundleIdentifier: current.bundleIdentifier,
    codeIdentifier: current.codeIdentifier,
    fromExecutableSha256: baseline.executableSha256,
    toExecutableSha256: current.executableSha256,
    fromSidecarSha256: baseline.sidecarSha256,
    toSidecarSha256: current.sidecarSha256,
    fromCodeResourcesSha256: baseline.codeResourcesSha256,
    toCodeResourcesSha256: current.codeResourcesSha256,
    entitlementsSha256: current.entitlementsSha256,
    appPath: current.appPath,
    executablePath: current.executablePath,
    processId: matching[0].pid,
    receiptStatus: receipt.status,
    receiptStage: receipt.stage,
    receiptAppVersion: receipt.appVersion,
    receiptTargetVersion: receipt.targetVersion,
    receiptTimestamp: receipt.timestamp,
    verifiedAt,
    codesignVerified: true,
    gatekeeperAccepted: false,
    notarizationStapled: false,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseRunningProcessCommand(
  line: string,
  executableName: string,
): { pid: number; executablePath: string } | null {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  if (match === null) return null;
  const command = match[2];
  const executable = command.match(new RegExp(`^(.+/${escapeRegExp(executableName)})(?:\\s|$)`))?.[1];
  if (executable === undefined || !executable.startsWith("/")) return null;
  return { pid: Number(match[1]), executablePath: executable };
}

function runningDesktopProcesses(executableName: string): Array<{ pid: number; executablePath: string }> {
  return run("ps", ["-axo", "pid=,command="]).stdout
    .split("\n")
    .map((line) => parseRunningProcessCommand(line, executableName))
    .filter((process): process is { pid: number; executablePath: string } => process !== null);
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
  const options = parseAdhocAcceptanceCliArgs(argv);
  const evidence = inspectInstalledAdhocApp(options.app, options.expectedVersion);
  if (options.command === "baseline") {
    atomicWriteJson(options.output, evidence);
    console.log(`desktop ad-hoc baseline recorded: ${resolve(options.output)}`);
    return;
  }
  const baselinePath = requirePrivateFile(options.baseline, "desktop ad-hoc baseline evidence");
  const receiptPath = requirePrivateFile(options.receipt, "updater receipt");
  const baselineValue = readJson(baselinePath);
  if (!isAdhocEvidence(baselineValue)) throw new Error("desktop ad-hoc baseline evidence is invalid");
  const receipt = parseUpdaterReceipt(readJson(receiptPath));
  const report = verifyAdhocUpgradeEvidence(
    baselineValue,
    evidence,
    receipt,
    runningDesktopProcesses(basename(evidence.executablePath)),
    options.expectedVersion,
  );
  if (options.output !== undefined) atomicWriteJson(options.output, report);
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`desktop-adhoc-acceptance: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
