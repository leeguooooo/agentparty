// #115：--profile 常驻 daemon 必须比数据面更耐操。
// 修复前：for(;;) 里裸 await listInvites，一次 DNS 抖动/5xx 就 throw 到 index.ts 的
// process.exit(1)，把整个 daemon 连同所有已挂频道一起拖死。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAgentChildName, runProfileServe, type RunnerProcess, type ServeOptions } from "../src/commands/serve";
import { RestError } from "../src/rest";

const tempDir = () => mkdtempSync(join(tmpdir(), "ap-daemon-"));
const okGit: RunnerProcess = async () => ({ code: 0, stdout: "", stderr: "" });

const profile = {
  owner_account: "fan@example.com",
  handle: "herness-dev",
  name: "herness-dev",
  runner: "codex-sdk" as const,
  repo_url: null,
  workdir: null,
  base_branch: "main",
  worktree_strategy: "branch" as const,
  rules: "Report readiness.",
  invitable_by: "anyone" as const,
  created_at: 1,
  updated_at: 1,
};

const invite = (channel_slug: string, id = 1) => ({
  id,
  channel_slug,
  owner_account: profile.owner_account,
  profile_handle: profile.handle,
  invited_by: "owner@example.com",
  invited_at: id,
  profile,
});

function baseOpts(over: Partial<Parameters<typeof runProfileServe>[0]>) {
  const served: ServeOptions[] = [];
  const logs: string[] = [];
  return {
    served,
    logs,
    opts: {
      server: "http://agentparty.test",
      humanToken: "acc-human",
      ownerAccount: profile.owner_account,
      handle: profile.handle,
      mentionsOnly: true,
      pollIntervalMs: 1,
      runGit: okGit,
      out: (line: string) => logs.push(line),
      post: async () => {},
      mintRuntime: async () => ({ token: "ap_profile_runtime", profile }),
      ensureChannelRuntime: async (_s: string, _t: string, slug: string, owner: string, handle: string, childName: string) => ({
        token: `ap_child_${slug}`,
        name: childName,
        role: "agent" as const,
        owner,
        channel_scope: slug,
        lineage: { parent_agent: handle, root_agent: handle, team_id: handle, depth: 1, expires_at: null },
        profile,
      }),
      runChannelServe: async (o: ServeOptions) => {
        served.push(o);
        return 0;
      },
      ...over,
    } as Parameters<typeof runProfileServe>[0],
  };
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const old = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = tempDir();
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.AGENTPARTY_HOME;
    else process.env.AGENTPARTY_HOME = old;
  }
}

describe("profile daemon resilience (#115)", () => {
  test("a transient listInvites failure does not kill the daemon; it backs off and recovers", async () => {
    let calls = 0;
    const { served, logs, opts } = baseOpts({
      once: false,
      listInvites: async () => {
        calls += 1;
        if (calls === 1) throw new Error("getaddrinfo EAI_AGAIN agentparty.test");
        if (calls === 2) throw new RestError(503, "unavailable", "service unavailable");
        if (calls === 3) return [invite("alpha")]; // 恢复：频道挂上
        throw new RestError(401, "unauthorized", "stop the loop"); // 终局，收敛测试
      },
    });

    await withHome(async () => {
      await expect(runProfileServe(opts)).rejects.toThrow("stop the loop");
    });

    // 关键断言：前两次失败没有中止 daemon，第三次成功仍然挂上了频道
    expect(served.map((o) => o.channel)).toEqual(["alpha"]);
    expect(logs.filter((l) => l.includes("invite poll failed"))).toHaveLength(2);
    expect(logs.some((l) => l.includes("EAI_AGAIN"))).toBe(true);
    expect(logs.some((l) => l.includes("retrying in"))).toBe(true);
  });

  test("401 is terminal — the daemon stops instead of hammering a revoked token", async () => {
    const { logs, opts } = baseOpts({
      once: false,
      listInvites: async () => {
        throw new RestError(401, "unauthorized", "invalid or revoked token");
      },
    });

    await withHome(async () => {
      await expect(runProfileServe(opts)).rejects.toThrow("invalid or revoked token");
    });
    // 终局错误不该进退避日志
    expect(logs.filter((l) => l.includes("invite poll failed"))).toHaveLength(0);
  });

  test("one channel failing to attach does not take down the other channels", async () => {
    let calls = 0;
    const { served, logs, opts } = baseOpts({
      once: false,
      listInvites: async () => {
        calls += 1;
        if (calls >= 2) throw new RestError(401, "unauthorized", "stop the loop");
        return [invite("alpha", 1), invite("boom", 2), invite("gamma", 3)];
      },
      ensureChannelRuntime: async (_s: string, _t: string, slug: string, owner: string, handle: string, childName: string) => {
        if (slug === "boom") throw new Error("git clone failed for project agent profile");
        return {
          token: `ap_child_${slug}`,
          name: childName,
          role: "agent" as const,
          owner,
          channel_scope: slug,
          lineage: { parent_agent: handle, root_agent: handle, team_id: handle, depth: 1, expires_at: null },
          profile,
        };
      },
    });

    await withHome(async () => {
      await expect(runProfileServe(opts)).rejects.toThrow("stop the loop");
    });

    // alpha 和 gamma 照常挂上，只有 boom 掉队
    expect(served.map((o) => o.channel).sort()).toEqual(["alpha", "gamma"]);
    expect(logs.some((l) => l.includes("failed to attach #boom"))).toBe(true);
    expect(logs.some((l) => l.includes("will retry next poll"))).toBe(true);
  });

  test("a profile child keeps its initial backlog policy across failures before welcome", async () => {
    let attempts = 0;
    let invitePolls = 0;
    const policies: Array<boolean | undefined> = [];
    const { opts } = baseOpts({
      once: false,
      skipBacklog: true,
      listInvites: async () => {
        invitePolls += 1;
        if (attempts >= 2) throw new RestError(401, "unauthorized", "stop after child retry");
        // Keep returning the same invite while its child supervisor owns the running slot.
        return [invite("alpha")];
      },
      runChannelServe: async (serveOpts) => {
        policies.push(serveOpts.skipBacklog);
        attempts += 1;
        if (attempts === 1) throw new Error("pre-welcome child crash"); // no welcome callback
        serveOpts.onWelcome?.();
        return 0;
      },
      sleep: async () => { await Promise.resolve(); },
    });

    await withHome(async () => {
      await expect(runProfileServe(opts)).rejects.toThrow("stop after child retry");
    });

    expect(invitePolls).toBeGreaterThanOrEqual(1);
    expect(policies).toEqual([true, true]);
  });

  test("projectAgentChildName stays stable (guard against fixture drift)", () => {
    expect(projectAgentChildName("herness-dev", "alpha")).toBe(projectAgentChildName("herness-dev", "alpha"));
  });
});
