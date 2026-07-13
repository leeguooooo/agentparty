// party worktree list|prune — 安全清理 agentparty 并行开发留下的 worktree（issue #455）。
//
// 判『能否安全删』不能靠 ahead 计数——squash/rebase-merge 会把 patch 揉进 main 却留下不同 SHA，
// 单看 ahead 会把已合工作误判成未合。#450 手动考古验证过的正确三步（本命令原样产品化）：
//   1. patch-equivalent 检测：`git cherry <base> <branch>` 数 '+' 提交——0 个 = 内容已在 base。
//   2. dirty 保全：worktree 有未提交改动时【绝不 --force 丢活】——先 commit+push 到 preserve/*，再删。
//   3. 未合价值：有 '+' 提交 → skip + 报告，交作者追 main 开 PR。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { stripTerminalControls } from "../format";

const HELP = `usage: party worktree list [--base <ref>] [--json]
       party worktree prune [--base <ref>] [--dry-run] [--remote] [--yes]

Safely tear down git worktrees left by parallel agent development (#455).

Status is decided by patch-equivalence, NOT ahead-count (squash/rebase-merge
would otherwise mis-flag merged work as unmerged):
  merged-clean  git cherry <base> <branch> has 0 '+' commits AND worktree is clean
  merged-dirty  patch-equivalent merged BUT has uncommitted changes
  unmerged      has '+' commits not in base (real unmerged work)

list   print every worktree with its status + (commits-ahead / dirty-file-count).
       Only AgentParty patterns are eligible for cleanup; unrelated worktrees are reported and skipped.

prune  DEFAULT IS --dry-run: print the plan, do nothing. Pass --yes to execute.
  merged-clean -> git worktree remove + git branch -D  (+ push --delete if --remote)
  merged-dirty -> commit + push origin HEAD:preserve/<branch>, THEN remove (never
                  --force-loses work; if preserve fails the worktree is SKIPPED)
  unmerged     -> SKIP + report so you can open a PR
  Never touches the main/current/locked/detached worktree, or an unrelated worktree.

Options:
  --base <ref>   base to compare against (default: origin/main)
  --json         (list) machine-readable output
  --dry-run      (prune) print plan only — this is the default
  --remote       (prune) also delete the remote branch for merged-clean
  --yes          (prune) actually execute the plan`;

const FLAGS = ["base"];
const BOOLEANS = ["json", "dry-run", "remote", "yes"];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

const DEFAULT_GIT_TIMEOUT_MS = 30_000;

interface KillableGitProcess {
  pid: number;
  kill(signal?: NodeJS.Signals | number): void;
}

type WindowsTreeKiller = (pid: number) => Promise<boolean>;

async function taskkillProcessTree(pid: number): Promise<boolean> {
  try {
    const killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    killer.unref();
    return (await killer.exited) === 0;
  } catch {
    return false;
  }
}

export async function terminateGitProcessTree(
  proc: KillableGitProcess,
  platform: NodeJS.Platform = process.platform,
  killGroup: typeof process.kill = process.kill,
  killWindowsTree: WindowsTreeKiller = taskkillProcessTree,
): Promise<"group" | "tree" | "child"> {
  if (platform === "win32") {
    try {
      if (await killWindowsTree(proc.pid)) return "tree";
    } catch {
      // taskkill 启动失败时仍要至少终止直接子进程。
    }
  } else {
    try {
      killGroup(-proc.pid, "SIGKILL");
      return "group";
    } catch {
      // Git 可能恰好已退出；回退到直接子进程。
    }
  }
  proc.kill("SIGKILL");
  return "child";
}

// 超时必须独立返回：即使平台级终止失败、子进程仍握着管道，也不能让 prune 永久等下去。
// 同时尽力终止整棵进程树，避免把 ssh/credential helper 留在后台。
export async function spawnWithTimeout(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string | undefined> = process.env,
): Promise<GitResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // POSIX 上独立进程组可一次终止 git + ssh/credential helper；
    // Windows 保留父子关系，超时时交给 taskkill /T /F 清整棵进程树。
    detached: process.platform !== "win32",
    env,
  });
  if (!proc.pid) return { code: 1, stdout: "", stderr: `failed to start: ${cmd.join(" ")}` };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const work: Promise<GitResult> = (async () => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  })().catch((error): GitResult => ({ code: 1, stdout: "", stderr: String(error) }));

  const stopChild = () => {
    void terminateGitProcessTree(proc).catch(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已退出或终止失败；下面仍会断开父进程引用。 */
      }
    });
    try {
      void proc.stdout.cancel().catch(() => undefined);
      void proc.stderr.cancel().catch(() => undefined);
    } catch {
      // Response reader 可能已经锁住流；unref 仍确保残留 pipe 不把 CLI 挂住。
    }
    try {
      proc.unref();
    } catch {
      /* Bun 旧版本兜底：timeout/signal race 仍会立即返回。 */
    }
  };

  let resolveSignal: ((result: GitResult) => void) | undefined;
  const signal = new Promise<GitResult>((resolve) => {
    resolveSignal = resolve;
  });
  const onSigint = () => {
    stopChild();
    resolveSignal?.({ code: 130, stdout: "", stderr: "interrupted by SIGINT" });
  };
  const onSigterm = () => {
    stopChild();
    resolveSignal?.({ code: 143, stdout: "", stderr: "terminated by SIGTERM" });
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const timeout = new Promise<GitResult>((resolve) => {
    timer = setTimeout(() => {
      stopChild();
      resolve({ code: 124, stdout: "", stderr: `timed out after ${timeoutMs}ms: ${cmd.join(" ")}` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout, signal]);
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

export async function runGitCommand(
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<GitResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...opts.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_SSH_COMMAND: opts.env?.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.askPass",
    GIT_CONFIG_VALUE_0: "",
  };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return spawnWithTimeout(["git", ...args], cwd, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, env);
}

const defaultGit: GitRunner = (args, cwd) => runGitCommand(args, cwd);

export type WorktreeStatus =
  | "merged-clean"
  | "merged-dirty"
  | "unmerged"
  | "main"
  | "current"
  | "locked"
  | "detached"
  | "unrelated";

export interface WorktreeRow {
  path: string;
  branch: string | null;
  status: WorktreeStatus;
  ahead: number; // '+' commits not patch-equivalent in base
  dirty: number; // uncommitted file count
}

interface RawWorktree {
  path: string;
  branch: string | null; // short branch name, null if detached
  detached: boolean;
  locked: boolean;
  bare: boolean;
}

export function isAgentPartyWorktree(path: string, branch: string | null): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    branch?.startsWith("agentparty/") === true ||
    /(?:^|\/)agentparty-wt-[^/]+(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)\.claude\/worktrees\/agent-[^/]+(?:\/|$)/.test(normalized) ||
    /(?:^|\/)worktrees\/[^/]+(?:\/|$)/.test(normalized)
  );
}

// 解析 `git worktree list --porcelain`：block 之间空行分隔，主工作树是第一个 block。
export function parseWorktreePorcelain(out: string): RawWorktree[] {
  const blocks: RawWorktree[] = [];
  let cur: RawWorktree | null = null;
  for (const line of out.split("\n")) {
    if (line === "") {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (cur) blocks.push(cur);
      cur = { path: line.slice("worktree ".length), branch: null, detached: false, locked: false, bare: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      cur.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      cur.locked = true;
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

// 枚举 + 判定每个 worktree 的状态。root 是任一属于该仓的目录（通常 process.cwd()）。
export async function classifyWorktrees(
  root: string,
  base: string,
  git: GitRunner = defaultGit,
): Promise<WorktreeRow[]> {
  const list = await git(["worktree", "list", "--porcelain"], root);
  if (list.code !== 0) {
    throw new Error(`git worktree list failed: ${terminal(list.stderr.trim() || list.stdout.trim())}`);
  }
  const raws = parseWorktreePorcelain(list.stdout);

  // 当前工作树（cwd 所在的顶层）——绝不删自己脚下的。失败绝不能静默降级成 ""：
  // 那样 w.path === "" 永不命中，当前 worktree 保护失效、可能被删。失败即抛（同 list 失败）。
  const top = await git(["rev-parse", "--show-toplevel"], root);
  if (top.code !== 0 || top.stdout.trim() === "") {
    throw new Error(`cannot protect current worktree: ${terminal(top.stderr.trim() || "git rev-parse failed")}`);
  }
  const currentPath = top.stdout.trim();

  const rows: WorktreeRow[] = [];
  for (let i = 0; i < raws.length; i++) {
    const w = raws[i]!;
    const row: WorktreeRow = { path: w.path, branch: w.branch, status: "unmerged", ahead: 0, dirty: 0 };

    // 不可动的三类：主工作树（列表首项 / bare）、当前工作树、被锁的。
    if (i === 0 || w.bare) {
      row.status = "main";
      rows.push(row);
      continue;
    }
    if (w.path === currentPath) {
      row.status = "current";
      rows.push(row);
      continue;
    }
    if (w.locked) {
      row.status = "locked";
      rows.push(row);
      continue;
    }
    if (w.detached || !w.branch) {
      row.status = "detached";
      rows.push(row);
      continue;
    }
    if (!isAgentPartyWorktree(w.path, w.branch)) {
      row.status = "unrelated";
      rows.push(row);
      continue;
    }

    // patch-equivalent 检测：cherry 的 '+' 行 = 未在 base 里的提交。
    const cherry = await git(["cherry", base, w.branch], root);
    if (cherry.code !== 0) {
      // base 解析不了或分支异常——保守起见当未合，别误删。
      row.status = "unmerged";
      rows.push(row);
      continue;
    }
    row.ahead = cherry.stdout.split("\n").filter((l) => l.startsWith("+")).length;

    // dirty 检测：在该 worktree 内跑 status --porcelain。
    const status = await git(["-C", w.path, "status", "--porcelain"], root);
    if (status.code !== 0) {
      // status 拿不到（磁盘/权限/索引损坏）——状态未知。空 stdout 绝不能被读成
      // dirty=0 → merged-clean → 删。保守当未合，留给人处理，别误删。
      row.status = "unmerged";
      rows.push(row);
      continue;
    }
    row.dirty = status.stdout.split("\n").filter((l) => l.trim() !== "").length;

    if (row.ahead === 0) {
      row.status = row.dirty > 0 ? "merged-dirty" : "merged-clean";
    } else {
      row.status = "unmerged";
    }
    rows.push(row);
  }
  return rows;
}

function detail(r: WorktreeRow): string {
  if (r.status === "unmerged") return `${r.ahead} commit${r.ahead === 1 ? "" : "s"} ahead`;
  if (r.status === "merged-dirty") return `${r.dirty} dirty file${r.dirty === 1 ? "" : "s"}`;
  return "";
}

export function sanitizeForTerminal(input: string): string {
  // 先移除常见 CSI 序列本体，再剥其余控制字符；否则只去 ESC 会把 "[31m" 留进输出。
  return stripTerminalControls(input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, ""));
}

function terminal(input: string): string {
  return sanitizeForTerminal(input).replace(/[\r\n\t]+/g, " ");
}

async function runList(root: string, base: string, json: boolean, git: GitRunner): Promise<number> {
  const rows = await classifyWorktrees(root, base, git);
  if (json) {
    console.log(JSON.stringify(rows));
    return 0;
  }
  console.log(`base: ${terminal(base)}`);
  for (const r of rows) {
    const d = detail(r);
    console.log(
      `${r.status.padEnd(13)} ${terminal(r.branch ?? "(detached)").padEnd(28)} ${d.padEnd(16)} ${terminal(r.path)}`,
    );
  }
  return 0;
}

interface PruneAction {
  row: WorktreeRow;
  kind: "remove" | "preserve" | "skip";
  reason: string;
}

function planPrune(rows: WorktreeRow[], remote: boolean): PruneAction[] {
  return rows.map((row): PruneAction => {
    switch (row.status) {
      case "merged-clean":
        return {
          row,
          kind: "remove",
          reason: `remove worktree + branch ${row.branch}${remote ? " (+ remote)" : ""}`,
        };
      case "merged-dirty":
        return {
          row,
          kind: "preserve",
          reason: `commit + push -> preserve/${row.branch}, then remove worktree + branch`,
        };
      case "unmerged":
        return { row, kind: "skip", reason: `unmerged (${row.ahead} ahead) — open a PR to main` };
      default:
        return { row, kind: "skip", reason: row.status };
    }
  });
}

async function removeMergedClean(
  root: string,
  action: PruneAction,
  remote: boolean,
  git: GitRunner,
): Promise<boolean> {
  // raw 用于 git 参数，branch(sanitized) 只用于打印——绝不把『防注入显示串』喂给会真删/真推的
  // git 命令，否则日后扩展 sanitize（如 Unicode 归一化）会悄悄改掉实际分支名（CodeRabbit #459）。
  const raw = action.row.branch!;
  const branch = terminal(raw);
  const rm = await git(["worktree", "remove", action.row.path], root);
  if (rm.code !== 0) {
    console.error(`  ! ${branch}: worktree remove failed, skipped — ${terminal(rm.stderr.trim())}`);
    return false;
  }
  const del = await git(["branch", "-D", raw], root);
  if (del.code !== 0) {
    console.error(`  ! ${branch}: worktree removed but branch delete failed — ${terminal(del.stderr.trim())}`);
    return false;
  }
  if (remote) {
    const pushDel = await git(["push", "origin", "--delete", raw], root);
    if (pushDel.code !== 0) {
      console.error(`  ! ${branch}: remote branch delete failed — ${terminal(pushDel.stderr.trim())}`);
      return false;
    }
  }
  console.log(`  removed ${branch} (merged-clean)`);
  return true;
}

// merged-dirty：绝不 --force 丢活。先把未提交改动 commit + push 到 preserve/*，全部成功才删。
// 任一步失败 → 保留 worktree，跳过并告警，宁可留着让人处理也不丢工作。
async function preserveAndRemove(root: string, action: PruneAction, git: GitRunner): Promise<boolean> {
  // raw 喂 git，branch(sanitized) 只打印——同 removeMergedClean 的理由（CodeRabbit #459）。
  const raw = action.row.branch!;
  const branch = terminal(raw);
  const path = action.row.path;
  const add = await git(["-C", path, "add", "-A"], root);
  if (add.code !== 0) {
    console.error(`  ! ${branch}: git add failed, worktree preserved as-is — ${terminal(add.stderr.trim())}`);
    return false;
  }
  const commit = await git(["-C", path, "commit", "-m", `wip: preserve ${raw} (#455)`], root);
  if (commit.code !== 0) {
    console.error(`  ! ${branch}: commit failed, worktree preserved as-is — ${terminal(commit.stderr.trim())}`);
    return false;
  }
  const push = await git(["-C", path, "push", "origin", `HEAD:preserve/${raw}`], root);
  if (push.code !== 0) {
    console.error(
      `  ! ${branch}: push to preserve/${branch} failed, worktree preserved as-is — ${terminal(push.stderr.trim())}`,
    );
    return false;
  }
  // 改动已安全落到 origin/preserve/*，现在删本地 worktree+分支才不丢活。
  const rm = await git(["worktree", "remove", "--force", path], root);
  if (rm.code !== 0) {
    console.error(
      `  ! ${branch}: preserved to preserve/${branch} but worktree remove failed — ${terminal(rm.stderr.trim())}`,
    );
    return false;
  }
  const del = await git(["branch", "-D", raw], root);
  if (del.code !== 0) {
    console.error(
      `  ! ${branch}: preserved + worktree removed but branch delete failed — ${terminal(del.stderr.trim())}`,
    );
    return false;
  }
  console.log(`  preserved ${branch} -> origin/preserve/${branch}, then removed (merged-dirty)`);
  return true;
}

async function runPrune(
  root: string,
  base: string,
  opts: { dryRun: boolean; remote: boolean; yes: boolean },
  git: GitRunner,
): Promise<number> {
  const rows = await classifyWorktrees(root, base, git);
  const actions = planPrune(rows, opts.remote);
  const act = opts.yes && !opts.dryRun;

  if (!act) {
    console.log(`plan (dry-run — pass --yes to execute), base ${terminal(base)}:`);
    for (const a of actions) {
      const b = a.row.branch ?? "(detached)";
      console.log(
        `  ${a.kind.padEnd(8)} ${terminal(b).padEnd(28)} ${terminal(a.reason)}  [${terminal(a.row.path)}]`,
      );
    }
    const removable = actions.filter((a) => a.kind !== "skip").length;
    console.log(`\n${removable} worktree(s) would be cleaned, ${actions.length - removable} skipped. Re-run with --yes.`);
    return 0;
  }

  console.log(`executing prune, base ${terminal(base)}:`);
  let failed = false;
  for (const a of actions) {
    if (a.kind === "skip") {
      const b = a.row.branch ?? "(detached)";
      console.log(`  skip    ${terminal(b)} — ${terminal(a.reason)}`);
      continue;
    }
    const ok =
      a.kind === "remove"
        ? await removeMergedClean(root, a, opts.remote, git)
        : await preserveAndRemove(root, a, git);
    if (!ok) failed = true;
  }
  return failed ? 1 : 0;
}

export async function run(argv: string[], git: GitRunner = defaultGit): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: BOOLEANS });
  const unknown = unknownFlagError(flags, [...FLAGS, ...BOOLEANS]);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, FLAGS);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const sub = positionals[0];
  const base = str(flags.base) ?? "origin/main";
  const root = process.cwd();

  switch (sub) {
    case "list":
      return runList(root, base, flags.json === true, git);
    case "prune":
      return runPrune(
        root,
        base,
        { dryRun: flags["dry-run"] === true, remote: flags.remote === true, yes: flags.yes === true },
        git,
      );
    default:
      console.error("usage: party worktree list|prune [--base <ref>]");
      return 1;
  }
}
