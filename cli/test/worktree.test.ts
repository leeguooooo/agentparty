import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyWorktrees,
  type GitRunner,
  run,
  runGitCommand,
  sanitizeForTerminal,
  spawnWithTimeout,
  terminateGitProcessTree,
} from "../src/commands/worktree";

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
  git(main, "worktree", "add", "-b", "mc", join(root, "agentparty-wt-mc"), "main");
  commitFile(join(root, "agentparty-wt-mc"), "mc.txt", "mc-change\n", "mc: add file");
  const mcSha = git(join(root, "agentparty-wt-mc"), "rev-parse", "HEAD");
  git(main, "cherry-pick", mcSha); // main 现在 patch-equivalent 含 mc 的改动

  // merged-dirty: 同上 patch-equivalent，但工作树留未提交改动。
  git(main, "worktree", "add", "-b", "md", join(root, "agentparty-wt-md"), "main");
  commitFile(join(root, "agentparty-wt-md"), "md.txt", "md-change\n", "md: add file");
  const mdSha = git(join(root, "agentparty-wt-md"), "rev-parse", "HEAD");
  git(main, "cherry-pick", mdSha);
  writeFileSync(join(root, "agentparty-wt-md", "dirty.txt"), "uncommitted work\n"); // 脏

  // unmerged: 分支有真未合提交（cherry -> '+'）。
  git(main, "worktree", "add", "-b", "un", join(root, "agentparty-wt-un"), "main");
  commitFile(join(root, "agentparty-wt-un"), "un.txt", "un-change\n", "un: real unmerged work");

  // 普通手工 worktree：即使 patch 已在 main，也不属于 AgentParty teardown 范围，绝不能清。
  git(main, "worktree", "add", "-b", "manual", join(root, "manual-wt"), "main");

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
      if (args.includes("status") && args.some((a) => a.includes("agentparty-wt-mc"))) {
        return { code: 1, stdout: "", stderr: "fatal: simulated status failure" };
      }
      const out = execFileSync("git", args, { cwd, encoding: "utf8" });
      return { code: 0, stdout: out, stderr: "" };
    };
    const rows = await classifyWorktrees(main, "main", failingGit);
    const mc = rows.find((r) => r.branch === "mc");
    // 精确断言 unmerged；undefined / merged-dirty 都不能误放行。
    expect(mc?.status).toBe("unmerged");
  });

  test("rev-parse 当前 worktree 失败时直接中止，不能绕过 current 保护", async () => {
    const failingGit: GitRunner = async (args, cwd) => {
      if (args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "simulated rev-parse failure" };
      const out = execFileSync("git", args, { cwd, encoding: "utf8" });
      return { code: 0, stdout: out, stderr: "" };
    };
    await expect(classifyWorktrees(main, "main", failingGit)).rejects.toThrow("cannot protect current worktree");
  });
});

describe("git runner safety", () => {
  test("uses taskkill semantics for the full process tree on Windows", async () => {
    const treePids: number[] = [];
    const childSignals: Array<NodeJS.Signals | number | undefined> = [];
    const result = await terminateGitProcessTree(
      { pid: 42, kill: (signal) => childSignals.push(signal) },
      "win32",
      process.kill,
      async (pid) => {
        treePids.push(pid);
        return true;
      },
    );

    expect(result).toBe("tree");
    expect(treePids).toEqual([42]);
    expect(childSignals).toEqual([]);
  });

  test("falls back to the direct child when taskkill fails", async () => {
    const childSignals: Array<NodeJS.Signals | number | undefined> = [];
    const result = await terminateGitProcessTree(
      { pid: 42, kill: (signal) => childSignals.push(signal) },
      "win32",
      process.kill,
      async () => false,
    );
    expect(result).toBe("child");
    expect(childSignals).toEqual(["SIGKILL"]);
  });

  test("disables interactive Git and credential prompts", async () => {
    const bin = join(root, "bin");
    git(root, "init", "--quiet", bin);
    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      "#!/bin/sh\nprintf '%s|%s|%s|%s|%s|%s' \"$GIT_TERMINAL_PROMPT\" \"$GCM_INTERACTIVE\" \"${GIT_ASKPASS-unset}\" \"${SSH_ASKPASS-unset}\" \"$GIT_SSH_COMMAND\" \"$GIT_CONFIG_KEY_0\"\n",
    );
    chmodSync(fakeGit, 0o755);
    const result = await runGitCommand(["status"], main, {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GIT_ASKPASS: "/tmp/should-not-run",
        SSH_ASKPASS: "/tmp/should-not-run",
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("0|Never|unset|unset|ssh -o BatchMode=yes|core.askPass");
  });
});

describe("spawnWithTimeout", () => {
  test("SIGINT 级联终止子进程并清理信号监听器", async () => {
    const before = process.listenerCount("SIGINT");
    const pending = spawnWithTimeout([process.execPath, "-e", "setTimeout(() => {}, 5000)"], root, 5000);
    await Bun.sleep(50);
    process.emit("SIGINT");

    const r = await pending;
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("SIGINT");
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("超时独立返回 124，不等命令自然结束（防子进程占管道导致卡死）", async () => {
    const t0 = Date.now();
    const r = await spawnWithTimeout([process.execPath, "-e", "setTimeout(() => {}, 5000)"], root, 200);
    expect(r.code).toBe(124);
    expect(r.stderr).toContain("timed out");
    // 远早于 5s 返回 = 超时确实独立于命令/管道，没干等。
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test("命令按时结束时返回真实退出码与输出", async () => {
    const r = await spawnWithTimeout([process.execPath, "-e", "process.stdout.write('ok')"], root, 5000);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("ok");
  });
});

describe("sanitizeForTerminal", () => {
  test("剥掉 ANSI 转义与控制字符，保留可见文本/制表/换行", () => {
    expect(sanitizeForTerminal("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitizeForTerminal("a\x07b\x00c\x7f")).toBe("abc");
    expect(sanitizeForTerminal("real\rFAKE")).toBe("realFAKE");
    expect(sanitizeForTerminal("keep\tnormal\nline")).toBe("keep\tnormal\nline");
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
    expect(existsSync(join(root, "agentparty-wt-mc"))).toBe(true);
    expect(existsSync(join(root, "agentparty-wt-md"))).toBe(true);
    expect(existsSync(join(root, "agentparty-wt-un"))).toBe(true);
    // 分支都还在
    const branches = git(main, "branch", "--format=%(refname:short)");
    expect(branches).toContain("mc");
    expect(logs.join("\n").toLowerCase()).toContain("dry-run");
  });

  test("--yes removes merged-clean worktree + branch", async () => {
    const code = await run(["prune", "--base", "main", "--yes"]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "agentparty-wt-mc"))).toBe(false);
    const branches = git(main, "branch", "--format=%(refname:short)").split("\n");
    expect(branches).not.toContain("mc");
  });

  test("--yes preserves merged-dirty to preserve/* BEFORE removing (never loses work)", async () => {
    const code = await run(["prune", "--base", "main", "--yes"]);
    expect(code).toBe(0);
    // 工作树删了
    expect(existsSync(join(root, "agentparty-wt-md"))).toBe(false);
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
    expect(code).toBe(1);
    // push 失败 → 绝不删 worktree（脏活还在原地）
    expect(existsSync(join(root, "agentparty-wt-md"))).toBe(true);
    expect(existsSync(join(root, "agentparty-wt-md", "dirty.txt"))).toBe(true);
    // 明确报了跳过/失败
    expect(errs.join("\n").toLowerCase()).toContain("md");
  });

  test("--yes skips unmerged: worktree + branch survive", async () => {
    const code = await run(["prune", "--base", "main", "--yes"]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "agentparty-wt-un"))).toBe(true);
    const branches = git(main, "branch", "--format=%(refname:short)").split("\n");
    expect(branches).toContain("un");
    // 精确匹配 skip 行本身，避免被 "executing prune" 之类的普通文本误满足。
    expect(logs.join("\n")).toMatch(/skip\s+un\s+—\s+unmerged/);
  });

  test("--yes skips unrelated manual worktree", async () => {
    const code = await run(["prune", "--base", "main", "--yes"]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "manual-wt"))).toBe(true);
    const branches = git(main, "branch", "--format=%(refname:short)").split("\n");
    expect(branches).toContain("manual");
    expect(logs.join("\n")).toMatch(/skip\s+manual\s+— unrelated/);
  });
});
