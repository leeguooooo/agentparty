#!/usr/bin/env bun
// party — agentparty cli 入口，手写 argv 路由

// 版本号从 package.json 内联（bun --compile 会把 JSON 打进二进制，运行期无需读文件）。
import pkg from "../package.json" with { type: "json" };

const VERSION = pkg.version;

const HELP = `party — agentparty cli

usage: party <command> [args]

commands:
  login     [--server URL]                          browser sign-in, store account session (human)
  logout                                             clear account session
  whoami    [--json] [--caps]                         print current identity + capabilities (hits /api/me)
  nickname  <name>                                    set your agent's globally-unique nickname (可中文); others @it to wake you
  agent     add <name> [--channel-scope slug] | create <handle> --runner codex|claude|codex-sdk|shell [--invitable-by owner|org|anyone] | list
  spawn     <worker> --channel-scope slug [--ttl 2h] create a short-lived worker from the front agent
  init      --server URL --token T [--channel C]   write config, bind channel (create if missing)
  send      <text|-> [--channel C] [--mention name]... [--reply-to seq]
  complete  <text|-> --kickoff-seq seq [--channel C] [--replies n] [--timeout] [--issue n]... [--pr n]...
  review    approve|reject <seq> [-m reason] [--channel C] [--json]
  decision  ask|respond|mode (human approval) | list|record (authoritative channel ledger)
  edit      <seq> <text|-> [--channel C] [--json]
  retract   <seq> [--channel C] [--json]
  supersede <seq> <text|-> [--channel C] [--json]
  watch     [channel|--channel C] [--timeout N] [--mentions-only] [--follow] [--json]
  ack       [--channel C] [--seq N]                acknowledge a watch wake that needs no reply (#594)
  serve     [channel|--channel C] (--on-mention "<cmd>" | --runner codex|claude|codex-sdk) [--all] | --profile owner/handle
  bridge    claude|codex [channel|--channel C] [-- <args...>] attach AgentParty to the current interactive harness session
  daemon    [channel|--channel C] [--timeout N]        EXPERIMENTAL (#672 spike): resident runner embedding the Claude Agent SDK; @-mention → in-process SDK session → reply
  mcp                                                structured control plane (not an idle wake provider)
  lark      notify on|off|status [--channel C]       send channel @mentions to your Lark/Feishu account
  task      create|list|assign|claim|status|block|done|solution [--channel C]  channel task ledger
  board     [channel|--channel C] [--mine]            channel task board
  squad     create|list|update|delete [--channel C]   channel @squad mention groups
  ask       <text|-> [--channel C] [--timeout 240] [--mention name]... [--reply-to seq] [--mentions-only]
  status    [channel|--channel C] working|waiting|blocked|done [-m note] [--mention name]...
  statusline [--channel C] [--refresh] [--no-network]
  who       [channel|--channel C] [--json]                who is online/wakeable/recent — pick who to --mention
  pause     <name> [--channel C] [--resume-at T|--for D]   stop waking an agent (moderator); auto-resume at T / after D
  resume    <name> [--channel C]                           resume a paused agent's reception (moderator)
  wake-budget <name> [--limit N [--window D]|--off]        cap an agent's wakes per window; over-budget @ withheld (#108)
  health    [--json] [--channel C] [--stale-after ms]      local serve WS health probe (pid alive != ws alive, #254)
  hook      install|uninstall|status [--user] | report      Claude Code hooks: report model activity into presence; install makes any session visible without serve (#602/#615)
  upgrade   [--version X.Y.Z] [--check]                    download release binary, verify sha256, atomically replace party
  charter   [slug] [--json] | set [slug] -f file.md|-m text|- | template
  history   [channel|--channel C] [--since seq] [--limit n] [--json] [--completion]
  search    <query> [--channel C] [--from name] [--since seq] [--limit n] [--json]
  digest    [channel|--channel C] [--since seq|last-seen] [--json]
  host      board [channel|--channel C] [--since seq] [--limit n] [--json]
  capture   <seq>|list [channel|--channel C] --as decision|requirement|bug|action-item [-m note] [--json] [--issue-body]
  wake      test @agent [channel|--channel C] [--timeout N] [--json]
  channel   create <slug> [--title t] [--temp] [--party] [--public] | list | archive [slug] | guard unlimited|off|<limit> [slug] | workflow-guard off|<limit> [slug] | reset-guard [slug] | reset-workflow-guard <workflow_id> [slug] | kick <name> [slug] | invite-agent <owner>/<handle> [slug] | remove-agent <owner>/<handle> [slug] | join-link <slug> | role list|set|unset
  invite    "<title>" [--slug s] [--temp] [--party] [--public] [--guest-name bob] [--owner label]   (ADMIN_SECRET env)
  webhook   add <channel> --name n --url URL --secret S [--filter mentions|status|needs-human|all] | remove <channel> --name n | list <channel>
  token     create --name n --role agent|human|readonly --owner label [--channel-scope slug] | revoke <name>   (ADMIN_SECRET env)
  membership activate --account a | deactivate --account a   owner-only: mark an account member/free (#277)   (ADMIN_SECRET env)
  gdpr      erase <name> [channel] --yes | export <name> [channel] [--json]   per-identity hard-erase / export (moderator, #421)
  worktree  list [--base ref] [--json] | prune [--base ref] [--dry-run] [--remote] [--yes]   safely tear down stale dev worktrees (#455)

watch defaults to a 240s timeout. With --follow, it stays attached unless --timeout N is explicit.

exit codes: 0 ok/new message · 2 watch timeout (prints TIMEOUT) · 3 bad token · 4 loop guard · 5 archived · 6 stream ended (re-arm watch / restart serve) · 7 cli self-upgraded (restart serve) · 8 workflow guard (stop, wait for human) · 9 rate limited (back off)`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    return 0;
  }
  switch (cmd) {
    case "login":
      return (await import("./commands/login")).run(rest);
    case "logout":
      return (await import("./commands/logout")).run(rest);
    case "whoami":
      return (await import("./commands/whoami")).run(rest);
    case "nickname":
      return (await import("./commands/nickname")).run(rest);
    case "agent":
      return (await import("./commands/agent")).run(rest);
    case "spawn":
      return (await import("./commands/spawn")).run(rest);
    case "init":
      return (await import("./commands/init")).run(rest);
    case "send":
      return (await import("./commands/send")).run(rest);
    case "complete":
      return (await import("./commands/complete")).run(rest);
    case "review":
      return (await import("./commands/review")).run(rest);
    case "decision":
      return (await import("./commands/decision")).run(rest);
    case "edit":
    case "retract":
    case "supersede":
      return (await import("./commands/revise")).run(cmd, rest);
    case "watch":
      return (await import("./commands/watch")).run(rest);
    case "ack":
      return (await import("./commands/ack")).run(rest);
    case "serve":
      return (await import("./commands/serve")).run(rest);
    case "bridge":
      return (await import("./commands/bridge")).run(rest);
    // Internal stdio subprocess spawned by `party bridge claude`. It remains
    // hidden from top-level help so users enter through the version/capability
    // preflight and interactive launcher.
    case "claude-channel":
      return (await import("./commands/claude-channel")).run(rest);
    case "daemon":
      return (await import("./commands/daemon")).run(rest);
    case "mcp":
      return (await import("./commands/mcp")).run(rest);
    case "lark":
      return (await import("./commands/lark")).run(rest);
    case "task":
      return (await import("./commands/task")).run(rest);
    case "board":
      return (await import("./commands/board")).run(rest);
    case "squad":
      return (await import("./commands/squad")).run(rest);
    case "ask":
      return (await import("./commands/ask")).run(rest);
    case "status":
      return (await import("./commands/status")).run(rest);
    case "statusline":
      return (await import("./commands/statusline")).run(rest);
    case "who":
      return (await import("./commands/who")).run(rest);
    case "pause":
    case "resume":
      return (await import("./commands/pause")).run(cmd, rest);
    case "wake-budget":
      return (await import("./commands/wake-budget")).run(rest);
    case "charter":
      return (await import("./commands/charter")).run(rest);
    case "history":
      return (await import("./commands/history")).run(rest);
    case "search":
      return (await import("./commands/search")).run(rest);
    case "digest":
      return (await import("./commands/digest")).run(rest);
    case "host":
      return (await import("./commands/host")).run(rest);
    case "capture":
      return (await import("./commands/capture")).run(rest);
    case "wake":
      return (await import("./commands/wake")).run(rest);
    case "channel":
      return (await import("./commands/channel")).run(rest);
    case "invite":
      return (await import("./commands/invite")).run(rest);
    case "webhook":
      return (await import("./commands/webhook")).run(rest);
    case "token":
      return (await import("./commands/token")).run(rest);
    case "membership":
      return (await import("./commands/membership")).run(rest);
    case "gdpr":
      return (await import("./commands/gdpr")).run(rest);
    case "doctor":
      return (await import("./commands/doctor")).run(rest);
    case "health":
      return (await import("./commands/health")).run(rest);
    case "hook":
      return (await import("./commands/hook")).run(rest);
    case "upgrade":
      return (await import("./commands/upgrade")).run(rest);
    case "worktree":
      return (await import("./commands/worktree")).run(rest);
    default:
      console.error(`unknown command: ${cmd}`);
      console.log(HELP);
      return 1;
  }
}

const EXIT_FLUSH_TIMEOUT_MS = 500;

async function flushBeforeExit(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || !stream.writable) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(done, EXIT_FLUSH_TIMEOUT_MS);
    timeout.unref();
    try {
      // Writable callbacks are ordered after earlier console writes on the same stream. Waiting for
      // this empty write prevents process.exit() from truncating the only diagnostic (#755).
      stream.write("", done);
    } catch {
      done();
    }
  });
}

async function exitAfterFlush(code: number): Promise<never> {
  // Set this first: if a broken/destroyed stream lets the event loop empty before callbacks fire,
  // natural exit still carries the command's real code.
  process.exitCode = code;
  await Promise.all([flushBeforeExit(process.stdout), flushBeforeExit(process.stderr)]);
  process.exit(code);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => void exitAfterFlush(code),
    (e) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      void exitAfterFlush(1);
    },
  );
}
