import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyWorktrees, type GitRunner, run } from "../src/commands/worktree";

// 用真 git：临时仓库 + 真 worktree，覆盖 merged-clean / merged-dirty / unmerged 三态。
// 不 mock git——命令的价值就在于对真 porcelain 输出的解析与真 cherry/status 判定。

let root: string;
let main: string; // 主工作树
let origin: string; // 裸远端，供 preserve/* push
let oldCwd: string;
let logs: string[];
let errs: string[];
let oldLog: typeof console.log;
let oldError: typeof console.error;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", msg);
}

beforeEach(() => {
  oldCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "ap-worktree-"));
  origin = join(root, "origin.git");
  main = join(root, "main");

  git(root, "init", "--bare", "origin.git");
  git(root, "init", "-b", "main", "main");
  git(main, "config", "user.email", "t@t.io");
  git(main, "config", "user.name", "t");
  git(main, "remote", "add", "origin", origin);
  commitFile(main, "base.txt", "base\n", "init");
  git(main, "push", "-u", "origin", "main");

  // merged-clean: 分支提交了改动，同一 patch 也进了 main（cherry -> '-'），工作树干净。
  git(main, "worktree", "add", "-b", "mc", join(root, "wt-mc"), "main");
  commitFile(join(root, "wt-mc"), "mc.txt", "mc-change\n", "mc: add file");
  const mcSha = git(join(root, "wt-mc"), "rev-parse", "HEAD");
  git(main, "cherry-pick", mcSha); // main 现在 patch-equivalent 含 mc 的改动

  // merged-dirty: 同上 patch-equivalent，但工作树留未提交改动。
  git(main, "worktree", "add", "-b", "md", join(root, "wt-md"), "main");
  commitFile(join(root, "wt-md"), "md.txt", "md-change\n", "md: add file");
  const mdSha = git(join(root, "wt-md"), "rev-parse", "HEAD");
  git(main, "cherry-pick", mdSha);
  writeFileSync(join(root, "wt-md", "dirty.txt"), "uncommitted work\n"); // 脏

  // unmerged: 分支有真未合提交（cherry -> '+'）。
  git(main, "worktree", "add", "-b", "un", join(root, "wt-un"), "main");
  commitFile(join(root, "wt-un"), "un.txt", "un-change\n", "un: real unmerged work");

  process.chdir(main);
  logs = [];
  errs = [];
  oldLog = console.log;
  oldError = console.error;
  console.log = (line?: unknown) => logs.push(String(line));
  console.error = (line?: unknown) => errs.push(String(line));
});

afterEach(() => {
  process.chdir(oldCwd);
  console.log = oldLog;
  console.error = oldError;
  rmSync(root, { recursive: true, force: true });
});

describe("classifyWorktrees", () => {
  test("classifies merged-clean / merged-dirty / unmerged, skips main", async () => {
    const rows = await classifyWorktrees(main, "main");
    const by = (b: string) => rows.find((r) => r.branch === b);
    expect(by("mc")?.status).toBe("merged-clean");
    expect(by("md")?.status).toBe("merged-dirty");
    expect(by("md")?.dirty).toBeGreaterThan(0);
    expect(by("un")?.status).toBe("unmerged");
    expect(by("un")?.ahead).toBeGreaterThan(0);
    // 主工作树永远是 skip（不能删）。git 会 realpath（macOS /var -> /private/var）。
    const realMain = realpathSync(main);
    const mainRow = rows.find((r) => r.path === realMain);
    expect(mainRow?.status).toBe("main");
  });

  test("git status 失败时绝不判 merged-clean（否则 prune 会删掉状态未知的 worktree）", async () => {
    // 注入一个 runner：wt-mc 的 status --porcelain 失败（磁盘/权限/索引损坏等）。
    // 空 stdout 绝不能被读成 dirty=0 → merged-clean → 删。status 拿不到 = 状态未知 = 保守保留。
    // 命令形如 git(["-C", <wt路径>, "status", "--porcelain"], root)——按 args 内容匹配。
    const failingGit: GitRunner = async (args, cwd) => {
      if (args.includes("status") && args.some((a) => a.includes("wt-mc"))) {
        return { code: 1, stdout: "", stderr: "fatal: simulated status failure" };
      }
      const out = execFileSync("git", args, { cwd, encoding: "utf8" });
      return { code: 0, stdout: out, stderr: "" };
    };
    const rows = await classifyWorktrees(main, "main", failingGit);
    const mc = rows.find((r) => r.branch === "mc");
    expect(mc?.status).not.toBe("merged-clean");
  });
});

describe("party worktree list", () => {
  test("--json emits the three states", async () => {
    const code = await run(["list", "--base", "main", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(logs.join(""));
    const statuses = Object.fromEntries(out.map((r: any) => [r.branch, r.status]));
    expect(statuses.mc).toBe("merged-clean");
    expect(statuses.md).toBe("merged-dirty");
    expect(statuses.un).toBe("unmerged");
  });
});

describe("party worktree prune", () => {
  test("default is dry-run: touches nothing", async () => {
    const code = await run(["prune", "--base", "main"]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "wt-mc"))).toBe(true);
    expect(existsSync(join(root, "wt-md"))).toBe(true);
    expect(existsSync(join(root, "wt-un"))).toBe(true);
    // 分支都还在
    const branches = git(main, "branch", "--format=%(refname:short)");
    expect(branches).toContain("mc");
    expect(logs.join("\n").toLowerCase()).toContain("dry-run");
  });

  test("--yes removes merged-clean worktree + branch", async () => {
    const code = await run(["prune", "--base", "main", "--yes"]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "wt-mc"))).toBe(false);
    const branches = git(main, "branch", "--format=%(refname:short)").split("\n");
    expect(branches).not.toContain("mc");
  });

  test("--yes preserves merged-dirty to preserve/* BEFORE removing (never loses work)", async () => {
    const code = await run(["prune", "--base", "main", "--yes"]);
    expect(code).toBe(0);
    // 工作树删了
    expect(existsSync(join(root, "wt-md"))).toBe(false);
    // 但脏改动被 push 到 origin 的 preserve/md，内容没丢
    const remoteRefs = git(main, "ls-remote", "--heads", "origin");
    expect(remoteRefs).toContain("refs/heads/preserve/md");
    // preserve 分支里确实含那份未提交的文件
    const files = git(main, "ls-tree", "-r", "--name-only", "origin/preserve/md");
    expect(files).toContain("dirty.txt");
  });

  test("--yes: preserve push 失败时 worktree 保留、脏活不丢（安全关键路径）", async () => {
    // 把 origin 指到不存在的地址，preserve push 必失败
    git(main, "remote", "set-url", "origin", join(root, "nonexistent-origin.git"));
    const code = await run(["prune", "--base", "main", "--yes"]);
    expect(code).toBe(0);
    // push 失败 → 绝不删 worktree（脏活还在原地）
    expect(existsSync(join(root, "wt-md"))).toBe(true);
    expect(existsSync(join(root, "wt-md", "dirty.txt"))).toBe(true);
    // 明确报了跳过/失败
    expect(errs.join("\n").toLowerCase()).toContain("md");
  });

  test("--yes skips unmerged: worktree + branch survive", async () => {
    const code = await run(["prune", "--base", "main", "--yes"]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "wt-un"))).toBe(true);
    const branches = git(main, "branch", "--format=%(refname:short)").split("\n");
    expect(branches).toContain("un");
    expect(logs.join("\n")).toContain("un");
  });
});
