// party bridge — attach AgentParty to an already-open interactive harness session.
//
// The Claude lane uses Claude Code's dedicated experimental `claude/channel`
// capability. This is intentionally different from ordinary MCP notifications:
// a channel notification is a harness-supported input path that queues a new
// turn in the current session, while logging/resource/tool-list notifications
// remain diagnostics and must never be treated as delivery.
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter as pathDelimiter, dirname, isAbsolute, resolve } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { isPartyBinaryPath } from "../upgrade";
import { isSlug } from "../validation";
import { runCodexSessionBridge, type CodexBridgeRuntimeOptions } from "./codex-bridge";

const CLAUDE_CHANNEL_MIN_VERSION = [2, 1, 80] as const;
const CODEX_BRIDGE_MIN_VERSION = [0, 144, 0] as const;
const CHANNEL_SERVER_NAME = "agentparty-channel";

const HELP = `usage: party bridge <claude|codex> [channel] [options] [-- <harness args...>]

forms:
  party bridge claude [channel|--channel C] [-- <claude args...>]
  party bridge codex  [channel|--channel C] [--codex-bin PATH] [-- <codex args...>]

Attach AgentParty to the same interactive harness session:
  claude  native Claude Channel input and linked reply tool
  codex   one app-server writer shared by the Unix-remote TUI and AgentParty

requirements:
  Claude Code >= 2.1.80 with development Channels enabled by the local/org policy.
  Codex CLI >= 0.144.0 with app-server --stdio and TUI --remote unix:// support.

examples:
  party bridge claude
  party bridge claude dev
  party bridge claude --channel dev -- --model opus
  party bridge codex dev
  party bridge codex --channel dev -- --model gpt-5.4
  party bridge codex dev --codex-bin /opt/homebrew/bin/codex

Tokens after -- are passed to the selected interactive CLI. The bridge never
uses PTY input injection and never starts a second writer against a live turn.`;

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface ClaudeBridgeLaunch {
  command: string;
  args: string[];
  mcpConfig: {
    mcpServers: Record<string, {
      type: "stdio";
      command: string;
      args: string[];
    }>;
  };
}

export interface BridgeDeps {
  execPath?: string;
  processArgv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  codexBinary?: string;
  probeClaudeVersion?: () => Promise<string>;
  probeCodexCapabilities?: (
    codexBinary: string,
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<CodexCapabilityProbe>;
  launch?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>;
  runCodexBridge?: (options: CodexBridgeRuntimeOptions) => Promise<number>;
}

export interface CodexCapabilityProbe {
  version: string;
  rootHelp: string;
  appServerHelp: string;
}

const CODEX_APP_DIRS = [
  "/Applications/Codex.app/Contents/Resources",
  "/Applications/ChatGPT.app/Contents/Resources",
] as const;

const CODEX_FALLBACK_PATH_DIRS = [
  resolve(homedir(), ".local/bin"),
  resolve(homedir(), ".npm-global/bin"),
  resolve(homedir(), ".bun/bin"),
  resolve(homedir(), ".deno/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  ...CODEX_APP_DIRS,
  "/usr/bin",
  "/bin",
] as const;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(value: string | undefined): string[] {
  return value?.split(pathDelimiter).filter((entry) => entry !== "") ?? [];
}

/**
 * Construct the exact PATH inherited by both Codex children. The fallback
 * directories are deliberately explicit: launchd GUI sessions commonly omit
 * Homebrew and application bundle paths even when the same command works in a
 * login shell.
 */
export function buildCodexChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  preferredPathDirs: string[] = [],
): NodeJS.ProcessEnv {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of [
    ...preferredPathDirs,
    ...pathEntries(env.PATH),
    ...CODEX_FALLBACK_PATH_DIRS,
  ]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return { ...env, PATH: entries.join(pathDelimiter) };
}

function executableOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null {
  if (isAbsolute(command) || command.includes("/")) {
    const candidate = isAbsolute(command) ? command : resolve(cwd, command);
    return executable(candidate) ? candidate : null;
  }
  for (const entry of pathEntries(env.PATH)) {
    const candidate = resolve(cwd, entry, command);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve one absolute binary for both app-server and TUI. launchd often lacks
 * Homebrew's PATH, which caused the resident runner's
 * "Executable not found in $PATH: codex" failure.
 */
export function resolveCodexBinary(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  const configured = explicit || env.AGENTPARTY_CODEX_BIN;
  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(cwd, configured);
    return executable(path) ? realpathSync(path) : null;
  }
  const fromPath = executableOnPath("codex", buildCodexChildEnv(env), cwd);
  if (fromPath && executable(fromPath)) return realpathSync(fromPath);
  for (const appDir of CODEX_APP_DIRS) {
    const candidate = resolve(appDir, "codex");
    if (existsSync(candidate) && executable(candidate)) return realpathSync(candidate);
  }
  return null;
}

function shebangEnvCommand(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(512);
    const bytes = readSync(fd, prefix, 0, prefix.length, 0);
    const firstLine = prefix.subarray(0, bytes).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) return null;
    const parts = firstLine.slice(2).trim().split(/\s+/);
    const interpreter = parts[0] ?? "";
    if (interpreter !== "/usr/bin/env" && interpreter !== "/bin/env") return null;
    let index = 1;
    if (parts[index] === "-S") index += 1;
    while (parts[index]?.includes("=")) index += 1;
    const command = parts[index];
    return command && !command.startsWith("-") ? command : null;
  } finally {
    closeSync(fd);
  }
}

export type CodexLaunchResolution =
  | {
    ok: true;
    codexBinary: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
  | {
    ok: false;
    error: string;
  };

/**
 * Resolve binary, cwd, and environment as one unit. Probing with a different
 * PATH than the eventual app-server/TUI launch can produce a false-positive
 * preflight, especially for npm shims using `#!/usr/bin/env node`.
 */
export function resolveCodexLaunch(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): CodexLaunchResolution {
  const configured = explicit || env.AGENTPARTY_CODEX_BIN;
  const configuredPath = configured
    ? (isAbsolute(configured) ? configured : resolve(cwd, configured))
    : null;
  const lookupEnv = buildCodexChildEnv(
    env,
    configuredPath === null ? [] : [dirname(configuredPath)],
  );
  const codexBinary = resolveCodexBinary(explicit, lookupEnv, cwd);
  if (!codexBinary) {
    return {
      ok: false,
      error:
        "could not find an executable Codex CLI. Pass --codex-bin PATH or set AGENTPARTY_CODEX_BIN",
    };
  }
  const childEnv = buildCodexChildEnv(lookupEnv, [
    ...(configuredPath === null ? [] : [dirname(configuredPath)]),
    dirname(codexBinary),
  ]);
  let envCommand: string | null;
  try {
    envCommand = shebangEnvCommand(codexBinary);
  } catch (error) {
    return {
      ok: false,
      error: `could not inspect Codex CLI ${codexBinary}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (envCommand && executableOnPath(envCommand, childEnv, cwd) === null) {
    return {
      ok: false,
      error:
        `Codex CLI ${codexBinary} uses /usr/bin/env ${envCommand}, but ${envCommand} is not executable ` +
        "on the child PATH. Install its runtime or pass a standalone Codex binary",
    };
  }
  return { ok: true, codexBinary, cwd, env: childEnv };
}

/** Extract the first semver-looking tuple from `claude --version`. */
export function parseClaudeVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|\()/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsClaudeChannels(raw: string): boolean {
  const parsed = parseClaudeVersion(raw);
  if (!parsed) return false;
  for (let index = 0; index < CLAUDE_CHANNEL_MIN_VERSION.length; index += 1) {
    if (parsed[index]! > CLAUDE_CHANNEL_MIN_VERSION[index]!) return true;
    if (parsed[index]! < CLAUDE_CHANNEL_MIN_VERSION[index]!) return false;
  }
  return true;
}

export function parseCodexVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$|\()/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(
  version: readonly number[],
  minimum: readonly number[],
): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index]! > minimum[index]!) return true;
    if (version[index]! < minimum[index]!) return false;
  }
  return true;
}

export function supportsCodexSessionBridge(probe: CodexCapabilityProbe): boolean {
  const version = parseCodexVersion(probe.version);
  return version !== null &&
    atLeast(version, CODEX_BRIDGE_MIN_VERSION) &&
    probe.rootHelp.includes("--remote") &&
    probe.rootHelp.includes("unix://") &&
    probe.appServerHelp.includes("--stdio");
}

/**
 * Resolve the command Claude should spawn for the channel MCP subprocess.
 * Compiled installs point directly at `party`; source/dev runs preserve
 * `bun <entry.ts>` so tests and contributors do not need a global binary.
 */
export function selfCommand(
  execPath: string = process.execPath,
  processArgv: string[] = process.argv,
): CommandSpec {
  if (isPartyBinaryPath(execPath) || processArgv[1] === undefined) {
    return { command: execPath, args: [] };
  }
  return { command: execPath, args: [processArgv[1]] };
}

export function buildClaudeBridgeLaunch(options: {
  channel: string;
  claudeArgs?: string[];
  execPath?: string;
  processArgv?: string[];
}): ClaudeBridgeLaunch {
  const self = selfCommand(options.execPath, options.processArgv);
  const mcpConfig: ClaudeBridgeLaunch["mcpConfig"] = {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: {
        type: "stdio",
        command: self.command,
        args: [...self.args, "claude-channel", "--channel", options.channel],
      },
    },
  };
  return {
    command: "claude",
    args: [
      "--mcp-config",
      JSON.stringify(mcpConfig),
      "--dangerously-load-development-channels",
      `server:${CHANNEL_SERVER_NAME}`,
      ...(options.claudeArgs ?? []),
    ],
    mcpConfig,
  };
}

async function defaultProbeClaudeVersion(): Promise<string> {
  const proc = Bun.spawn(["claude", "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const detail = stderr.trim() || `exit ${code}`;
    throw new Error(`could not run claude --version (${detail})`);
  }
  return stdout.trim();
}

async function capture(
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed (${stderr.trim() || `exit ${code}`})`);
  }
  return stdout;
}

async function defaultProbeCodexCapabilities(
  codexBinary: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CodexCapabilityProbe> {
  const [version, rootHelp, appServerHelp] = await Promise.all([
    capture([codexBinary, "--version"], options),
    capture([codexBinary, "--help"], options),
    capture([codexBinary, "app-server", "--help"], options),
  ]);
  return { version: version.trim(), rootHelp, appServerHelp };
}

async function defaultLaunch(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

export async function run(argv: string[], deps: BridgeDeps = {}): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }

  // `--` is a hard ownership boundary: flags after it belong to the selected
  // harness, not AgentParty.
  const delimiter = argv.indexOf("--");
  const bridgeArgs = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const harnessArgs = delimiter < 0 ? [] : argv.slice(delimiter + 1);
  const { positionals, flags } = parseArgs(bridgeArgs);
  const unknown = unknownFlagError(flags, ["channel", "codex-bin"]);
  if (unknown !== null) {
    console.error(`${unknown}; put harness flags after --`);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "codex-bin"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const harness = positionals[0];
  if (harness !== "claude" && harness !== "codex") {
    console.error("bridge supports: party bridge claude|codex [channel|--channel C] [-- <harness args...>]");
    return 1;
  }
  if (positionals.length > 2) {
    console.error("too many bridge arguments; put harness arguments after --");
    return 1;
  }
  if (harness === "claude" && flags["codex-bin"] !== undefined) {
    console.error("--codex-bin is only valid with party bridge codex");
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[1]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }

  if (harness === "codex") {
    const ownedFlag = harnessArgs.find((arg) =>
      arg === "--remote" ||
      arg.startsWith("--remote=") ||
      arg === "--remote-auth-token-env" ||
      arg.startsWith("--remote-auth-token-env=")
    );
    if (ownedFlag) {
      console.error(
        `party bridge codex owns ${ownedFlag}; remove it so all TUI and AgentParty writes stay on the single bridge endpoint`,
      );
      return 1;
    }
    const cwd = deps.cwd ?? process.cwd();
    const launch = resolveCodexLaunch(
      str(flags["codex-bin"]) ?? deps.codexBinary,
      deps.env ?? process.env,
      cwd,
    );
    if (!launch.ok) {
      console.error(
        `party bridge codex ${launch.error}. ` +
          "The bridge will not rely on launchd's often-incomplete PATH.",
      );
      return 1;
    }
    let probe: CodexCapabilityProbe;
    try {
      probe = await (deps.probeCodexCapabilities ?? defaultProbeCodexCapabilities)(
        launch.codexBinary,
        { cwd: launch.cwd, env: launch.env },
      );
    } catch (error) {
      console.error(`party bridge codex: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    if (!supportsCodexSessionBridge(probe)) {
      console.error(
        `party bridge codex requires Codex CLI >= ${CODEX_BRIDGE_MIN_VERSION.join(".")} with ` +
          `app-server --stdio and --remote unix:// support; found ${probe.version || "unknown"}. ` +
          "Update Codex before attaching a live session. AgentParty will not fall back to PTY injection.",
      );
      return 1;
    }
    return await (deps.runCodexBridge ?? ((options) => runCodexSessionBridge(options)))({
      channel,
      codexBinary: launch.codexBinary,
      codexArgs: harnessArgs,
      cwd: launch.cwd,
      env: launch.env,
    });
  }

  let rawVersion: string;
  try {
    rawVersion = await (deps.probeClaudeVersion ?? defaultProbeClaudeVersion)();
  } catch (error) {
    console.error(`party bridge claude: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!supportsClaudeChannels(rawVersion)) {
    console.error(
      `party bridge claude requires Claude Code >= ${CLAUDE_CHANNEL_MIN_VERSION.join(".")}; found ${rawVersion || "unknown"}. ` +
        "Update Claude Code before attaching a live session. AgentParty will not fall back to PTY injection or concurrently resume it.",
    );
    return 1;
  }

  const launch = buildClaudeBridgeLaunch({
    channel,
    claudeArgs: harnessArgs,
    execPath: deps.execPath,
    processArgv: deps.processArgv,
  });
  console.error(
    `party bridge: launching Claude Code with native AgentParty Channel for #${channel}. ` +
      "If organization policy disables development Channels, Claude will reject the channel explicitly; no unsafe resume fallback is attempted.",
  );
  return await (deps.launch ?? defaultLaunch)(launch.command, launch.args, {
    cwd: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
  });
}
