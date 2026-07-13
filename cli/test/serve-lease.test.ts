// #99：同名 agent 的多个 serve 无租约/互斥，重复执行零护栏。
//
// issue 有两半：
//   A) 跨机器：do.ts 广播发给同名所有连接（`do.ts:2948-2952`、`993-1037`），
//      工位机 + 家里机各跑一个 serve → 每条 @ 触发两次完整 codex run、双份回帖、
//      git push 类副作用执行两遍。唯一线索是 `who` 里不起眼的 `x2 sessions`。
//      **这半需要服务端租约**（do.ts 被三个未合并 PR 压着），不在本 PR。
//   B) 同机：workdir 只按频道键（`serve.ts:1455`），多个 serve 共享同一个
//      wake-session.json 互踩，且失败即 fork。这半在本 PR。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, defaultInstanceLockDir, instanceLockTarget } from "../src/instance-lock";
import { defaultRunnerWorkdir, EXIT_ALREADY_SERVING, runnerWorkdir, runServe } from "../src/commands/serve";
import { startMockServer, welcomeFrame } from "./mock-server";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "ap-lease-"));
  dirs.push(d);
  return d;
}

describe("serve 同机单实例 (#99 的同机那半)", () => {
  test("第二个 serve 被拒，并告知占锁的 pid", () => {
    const d = dir();
    const first = acquireInstanceLock("serve", "dev", d);
    expect(first.ok).toBe(true);

    const second = acquireInstanceLock("serve", "dev", d);
    expect(second.ok).toBe(false);
    expect(second.heldByPid).toBe(process.pid);

    first.release?.();
  });

  test("serve 与 watch 互不阻塞（不同 kind，各自一把锁）", () => {
    const d = dir();
    const s = acquireInstanceLock("serve", "dev", d);
    const w = acquireInstanceLock("watch", "dev", d);
    expect(s.ok).toBe(true);
    expect(w.ok).toBe(true);
    s.release?.();
    w.release?.();
  });

  test("陈旧锁（写锁的进程已死）会被接管，一次 SIGKILL 不该把频道永久锁死", () => {
    const d = dir();
    const dead = 999_999;
    expect(() => process.kill(dead, 0)).toThrow();
    writeFileSync(join(d, "serve-dev.lock"), JSON.stringify({ pid: dead }));
    const lock = acquireInstanceLock("serve", "dev", d);
    expect(lock.ok).toBe(true);
    lock.release?.();
  });

  test("活着的锁不会被误判成陈旧（错的方向最危险）", () => {
    const d = dir();
    writeFileSync(join(d, "serve-dev.lock"), JSON.stringify({ pid: process.pid }));
    const lock = acquireInstanceLock("serve", "dev", d);
    expect(lock.ok).toBe(false);
  });
});

describe("runner workdir 按身份隔离 (#99)", () => {
  test("同频道、不同身份 → 不同 workdir（wake-session.json 不再互踩）", () => {
    const a = runnerWorkdir("/home/x/.agentparty/runners", "dev", "alice");
    const b = runnerWorkdir("/home/x/.agentparty/runners", "dev", "bob");
    expect(a).not.toBe(b);
    expect(a).toContain("dev");
    expect(a).toContain("alice");
  });

  test("身份未知（还没连上服务端）时退回按频道键，保持旧行为", () => {
    const w = runnerWorkdir("/home/x/.agentparty/runners", "dev", undefined);
    expect(w).toBe("/home/x/.agentparty/runners/dev");
  });

  test("身份里的路径分隔符不得逃逸出 runners 根目录", () => {
    const w = runnerWorkdir("/home/x/.agentparty/runners", "dev", "../../etc/passwd");
    expect(w).not.toContain("..");
    expect(w).not.toContain("/etc/passwd");
    expect(w.startsWith("/home/x/.agentparty/runners/")).toBe(true);
  });
});

// 光有 runnerWorkdir、没接进默认值计算，等于没修。
describe("defaultRunnerWorkdir 接线 (#99)", () => {
  test("config 里有身份时，默认 workdir 带上身份", () => {
    const d = dir();
    const cfgPath = join(d, "cfg.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        server: "https://x",
        token: "ap_t",
        identity: { name: "alice", email: null, kind: "agent", role: "agent", owner: null, channel_scope: null, verified_at: 1 },
      }),
    );
    const prev = process.env.AGENTPARTY_CONFIG;
    process.env.AGENTPARTY_CONFIG = cfgPath;
    try {
      expect(defaultRunnerWorkdir("dev")).toContain("dev-alice");
    } finally {
      if (prev === undefined) delete process.env.AGENTPARTY_CONFIG;
      else process.env.AGENTPARTY_CONFIG = prev;
    }
  });

  test("没有缓存身份时退回按频道键（旧行为）", () => {
    const d = dir();
    const cfgPath = join(d, "cfg.json");
    writeFileSync(cfgPath, JSON.stringify({ server: "https://x", token: "ap_t" }));
    const prev = process.env.AGENTPARTY_CONFIG;
    process.env.AGENTPARTY_CONFIG = cfgPath;
    try {
      expect(defaultRunnerWorkdir("dev").endsWith("/runners/dev")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENTPARTY_CONFIG;
      else process.env.AGENTPARTY_CONFIG = prev;
    }
  });
});

describe("runServe 接线 (#99)", () => {
  test("默认锁跨 cwd 使用全局身份作用域，重复 serve 在连 WS 前被拒", async () => {
    const home = dir();
    const previousHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    let connections = 0;
    const server = startMockServer((f, sock) => {
      if (f.type !== "hello") return;
      connections++;
      sock.send(welcomeFrame(0, "me"));
    });
    const held = acquireInstanceLock(
      "serve",
      instanceLockTarget(server.url, "ap_tok", "dev"),
      defaultInstanceLockDir(),
    );
    try {
      const code = await runServe({
        server: server.url,
        token: "ap_tok",
        channel: "dev",
        since: 0,
        cmd: "true",
        mentionsOnly: true,
        out: () => {},
      });
      expect(code).toBe(EXIT_ALREADY_SERVING);
      expect(connections).toBe(0);
    } finally {
      held.release?.();
      server.stop();
      if (previousHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = previousHome;
    }
  });

  test("第二个 serve 直接被拒，且连 WS 都不建（否则它已经在跑 runner 了）", async () => {
    const d = dir();
    let connections = 0;
    const server = startMockServer((f, sock) => {
      if (f.type !== "hello") return;
      connections++;
      sock.send(welcomeFrame(0, "me"));
    });
    try {
      writeFileSync(join(d, "serve-dev.lock"), JSON.stringify({ pid: process.pid }));
      const lines: string[] = [];
      const code = await runServe({
        server: server.url,
        token: "ap_tok",
        channel: "dev",
        since: 0,
        cmd: "true",
        mentionsOnly: true,
        lockDir: d,
        out: (l) => lines.push(l),
      });
      expect(code).toBe(EXIT_ALREADY_SERVING);
      expect(connections).toBe(0); // 关键：没有建立连接，没有消费任何 @
      expect(lines.some((l) => l.includes(String(process.pid)))).toBe(true);
    } finally {
      server.stop();
    }
  });
});
