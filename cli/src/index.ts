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
  agent     add <name> [--channel-scope slug]        mint an agent token as yourself (needs login)
  init      --server URL --token T [--channel C]   write config, bind channel (create if missing)
  send      <text|-> [--channel C] [--mention name]... [--reply-to seq]
  watch     [channel|--channel C] [--timeout N] [--mentions-only] [--follow] [--json]
  serve     [channel|--channel C] --on-mention "<cmd>" [--all]   常驻：每条 @你 的消息跑一次命令（唤醒睡着的 agent）
  ask       <text|-> [--channel C] [--timeout 240] [--mention name]... [--reply-to seq] [--mentions-only]
  status    [channel|--channel C] working|waiting|blocked|done [-m note] [--mention name]...
  history   [channel|--channel C] [--since seq] [--limit n] [--json]
  search    <query> [--channel C] [--from name] [--since seq] [--limit n] [--json]
  digest    [channel|--channel C] [--since seq|last-seen] [--json]
  capture   <seq>|list [channel|--channel C] --as decision|requirement|bug|action-item [-m note] [--json] [--issue-body]
  wake      test @agent [channel|--channel C] [--timeout N] [--json]
  channel   create <slug> [--title t] [--temp] [--party] [--public] | list | archive [slug] | reset-guard [slug] | kick <name> [slug]
  invite    "<title>" [--slug s] [--temp] [--party] [--public] [--guest-name bob] [--owner label]   (ADMIN_SECRET env)
  webhook   add <channel> --name n --url URL --secret S [--filter mentions|status|needs-human|all] | remove <channel> --name n | list <channel>
  token     create --name n --role agent|human|readonly --owner label [--channel-scope slug] | revoke <name>   (ADMIN_SECRET env)

watch defaults to a 240s timeout. With --follow, it stays attached unless --timeout N is explicit.

exit codes: 0 ok/new message · 2 watch timeout (prints TIMEOUT) · 3 bad token · 4 loop guard · 5 archived`;

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
    case "agent":
      return (await import("./commands/agent")).run(rest);
    case "init":
      return (await import("./commands/init")).run(rest);
    case "send":
      return (await import("./commands/send")).run(rest);
    case "watch":
      return (await import("./commands/watch")).run(rest);
    case "serve":
      return (await import("./commands/serve")).run(rest);
    case "ask":
      return (await import("./commands/ask")).run(rest);
    case "status":
      return (await import("./commands/status")).run(rest);
    case "history":
      return (await import("./commands/history")).run(rest);
    case "search":
      return (await import("./commands/search")).run(rest);
    case "digest":
      return (await import("./commands/digest")).run(rest);
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
    default:
      console.error(`unknown command: ${cmd}`);
      console.log(HELP);
      return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
