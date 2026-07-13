// party worktree list|prune — 安全清理 agentparty 并行开发留下的 worktree（issue #455）。
//
// 判『能否安全删』不能靠 ahead 计数——squash/rebase-merge 会把 patch 揉进 main 却留下不同 SHA，
// 单看 ahead 会把已合工作误判成未合。#450 手动考古验证过的正确三步（本命令原样产品化）：
//   1. patch-equivalent 检测：`git cherry <base> <branch>` 数 '+' 提交——0 个 = 内容已在 base。
//   2. dirty 保全：worktree 有未提交改动时【绝不 --force 丢活】——先 commit+push 到 preserve/*，再删。
//   3. 未合价值：有 '+' 提交 → skip + 报告，交作者追 main 开 PR。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";

const HELP = `usage: party worktree list [--base <ref>] [--json]
       party worktree prune [--base <ref>] [--dry-run] [--remote] [--yes]

Safely tear down git worktrees left by parallel agent development (#455).

Status is decided by patch-equivalence, NOT ahead-count (squash/rebase-merge
would otherwise mis-flag merged work as unmerged):
  merged-clean  git cherry <base> <branch> has 0 '+' commits AND worktree is clean
  merged-dirty  patch-equivalent merged BUT has uncommitted changes
  unmerged      has '+' commits not in base (real unmerged work)

list   print every worktree with its status + (commits-ahead / dirty-file-count).

prune  DEFAULT IS --dry-run: print the plan, do nothing. Pass --yes to execute.
  merged-clean -> git worktree remove + git branch -D  (+ push --delete if --remote)
  merged-dirty -> commit + push origin HEAD:preserve/<branch>, THEN remove (never
                  --force-loses work; if preserve fails the worktree is SKIPPED)
  unmerged     -> SKIP + report so you can open a PR
  Never touches the main working tree, the current worktree, or a locked worktree.

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

// 无人值守 agent 会自动跑本工具的 push/commit。若 git 命中交互认证（HTTPS 密码、
// SSH passphrase 走 /dev/tty——不受 stdin:"ignore" 约束）会永久挂起，整条 prune 无限阻塞。
// GIT_TERMINAL_PROMPT=0 让 git 遇到提示直接失败而非等输入；再叠一层硬超时兜底熔断。
const GIT_TIMEOUT_MS = 120_000;

const defaultGit: GitRunner = async (args, cwd) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      return { code: code || 124, stdout, stderr: `git timed out after ${GIT_TIMEOUT_MS}ms: git ${args.join(" ")}` };
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

// 面向终端打印的外部字符串（分支名、worktree 路径、git stderr）先剥控制字符/ANSI 转义，
// 防不受信上游内容污染/注入终端。制表符(\x09)与换行(\x0A)保留——stderr 常多行。
export function sanitizeForTerminal(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export type WorktreeStatus =
  | "merged-clean"
  | "merged-dirty"
  | "unmerged"
  | "main"
  | "current"
  | "locked"
  | "detached";

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
    throw new Error(`git worktree list failed: ${list.stderr.trim() || list.stdout.trim()}`);
  }
  const raws = parseWorktreePorcelain(list.stdout);

  // 当前工作树（cwd 所在的顶层）——绝不删自己脚下的。失败绝不能静默降级成 ""：
  // 那样 w.path === "" 永不命中，当前 worktree 保护失效、可能被删。失败即抛（同 list 失败）。
  const top = await git(["rev-parse", "--show-toplevel"], root);
  if (top.code !== 0) {
    throw new Error(`git rev-parse --show-toplevel failed: ${top.stderr.trim() || top.stdout.trim()}`);
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

async function runList(root: string, base: string, json: boolean, git: GitRunner): Promise<number> {
  const rows = await classifyWorktrees(root, base, git);
  if (json) {
    console.log(JSON.stringify(rows));
    return 0;
  }
  console.log(`base: ${base}`);
  for (const r of rows) {
    const d = detail(r);
    console.log(`${r.status.padEnd(13)} ${sanitizeForTerminal(r.branch ?? "(detached)").padEnd(28)} ${d.padEnd(16)} ${sanitizeForTerminal(r.path)}`);
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
  const branch = sanitizeForTerminal(action.row.branch!);
  const rm = await git(["worktree", "remove", action.row.path], root);
  if (rm.code !== 0) {
    console.error(`  ! ${branch}: worktree remove failed, skipped — ${sanitizeForTerminal(rm.stderr.trim())}`);
    return false;
  }
  const del = await git(["branch", "-D", branch], root);
  if (del.code !== 0) {
    console.error(`  ! ${branch}: worktree removed but branch delete failed — ${sanitizeForTerminal(del.stderr.trim())}`);
  }
  if (remote) {
    const pushDel = await git(["push", "origin", "--delete", branch], root);
    if (pushDel.code !== 0) {
      console.error(`  ! ${branch}: remote branch delete failed — ${sanitizeForTerminal(pushDel.stderr.trim())}`);
    }
  }
  console.log(`  removed ${branch} (merged-clean)`);
  return true;
}

// merged-dirty：绝不 --force 丢活。先把未提交改动 commit + push 到 preserve/*，全部成功才删。
// 任一步失败 → 保留 worktree，跳过并告警，宁可留着让人处理也不丢工作。
async function preserveAndRemove(root: string, action: PruneAction, git: GitRunner): Promise<boolean> {
  const branch = sanitizeForTerminal(action.row.branch!);
  const path = action.row.path;
  const add = await git(["-C", path, "add", "-A"], root);
  if (add.code !== 0) {
    console.error(`  ! ${branch}: git add failed, worktree preserved as-is — ${sanitizeForTerminal(add.stderr.trim())}`);
    return false;
  }
  const commit = await git(["-C", path, "commit", "-m", `wip: preserve ${branch} (#455)`], root);
  if (commit.code !== 0) {
    console.error(`  ! ${branch}: commit failed, worktree preserved as-is — ${sanitizeForTerminal(commit.stderr.trim())}`);
    return false;
  }
  const push = await git(["-C", path, "push", "origin", `HEAD:preserve/${branch}`], root);
  if (push.code !== 0) {
    console.error(`  ! ${branch}: push to preserve/${branch} failed, worktree preserved as-is — ${sanitizeForTerminal(push.stderr.trim())}`);
    return false;
  }
  // 改动已安全落到 origin/preserve/*，现在删本地 worktree+分支才不丢活。
  const rm = await git(["worktree", "remove", "--force", path], root);
  if (rm.code !== 0) {
    console.error(`  ! ${branch}: preserved to preserve/${branch} but worktree remove failed — ${sanitizeForTerminal(rm.stderr.trim())}`);
    return false;
  }
  const del = await git(["branch", "-D", branch], root);
  if (del.code !== 0) {
    console.error(`  ! ${branch}: preserved + worktree removed but branch delete failed — ${sanitizeForTerminal(del.stderr.trim())}`);
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
    console.log(`plan (dry-run — pass --yes to execute), base ${base}:`);
    for (const a of actions) {
      const b = sanitizeForTerminal(a.row.branch ?? "(detached)");
      console.log(`  ${a.kind.padEnd(8)} ${b.padEnd(28)} ${a.reason}  [${sanitizeForTerminal(a.row.path)}]`);
    }
    const removable = actions.filter((a) => a.kind !== "skip").length;
    console.log(`\n${removable} worktree(s) would be cleaned, ${actions.length - removable} skipped. Re-run with --yes.`);
    return 0;
  }

  console.log(`executing prune, base ${base}:`);
  for (const a of actions) {
    if (a.kind === "skip") {
      const b = sanitizeForTerminal(a.row.branch ?? "(detached)");
      console.log(`  skip    ${b} — ${a.reason}`);
      continue;
    }
    if (a.kind === "remove") await removeMergedClean(root, a, opts.remote, git);
    else await preserveAndRemove(root, a, git);
  }
  return 0;
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
