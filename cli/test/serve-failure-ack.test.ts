// #118 + #198：唤醒失败不得静默推进游标。
// 游标只表达「已了结」＝ 送达成功，或有界重试耗尽后**响亮地**放弃。
// 「欠账」（送达失败、从没进过模型）由 stuck 表达，落盘，且永不被当作积压跳过。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ARCHIVED, type MsgFrame } from "@agentparty/shared";
import { createBuiltinRunner, createSdkRunner, EXIT_WAKE_ABANDON_CIRCUIT, profileChildServeOptions, runServe, WakeBlockedError, type BuiltinRunnerOptions, type RunnerProcess, type ServeOptions } from "../src/commands/serve";
import type { StuckWake } from "../src/config";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  server?.stop();
  server = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ap-serve-ack-"));
  tempDirs.push(dir);
  return dir;
}

function triggerFrame(seq = 7): MsgFrame {
  return msgFrame(seq, "wake up", { mentions: ["me"] }) as unknown as MsgFrame;
}

function runnerCtx() {
  return { cmd: "", channel: "dev", self: "me", contextDir: mkdtempSync(join(tmpdir(), "ap-ctx-")), recent: [] as MsgFrame[] };
}

function opts(over: Partial<ServeOptions> & { server: string }): ServeOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: (line) => lines.push(line),
    lines,
    // 每个测试一把独立的单实例锁（#99）：测试不该依赖真实 ~/.agentparty，
    // 也不该互相抢锁（第二个 runServe 会被拒并返回 EXIT_ALREADY_SERVING）
    lockDir: mkdtempSync(join(tmpdir(), "ap-lock-")),
    wakeRetryDelayMs: 0,
    ...over,
  };
}

function closeAfterOneMention() {
  server = startMockServer((frame, sock) => {
    if (frame.type !== "hello") return;
    sock.send(welcomeFrame(0, "me"));
    setTimeout(() => sock.send(msgFrame(1, "wake up", { mentions: ["me"] })), 20);
    setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 200);
  });
  return server;
}

describe("serve wake delivery (#118 / #198)", () => {
  test("a transient runner failure is retried, and the cursor advances only once it lands", async () => {
    const s = closeAfterOneMention();
    const cursors: number[] = [];
    const posts: string[] = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      onCursor: (c) => cursors.push(c),
      post: async (_s, _t, _c, body) => {
        posts.push(JSON.stringify(body));
        return { seq: 1 };
      },
      runCommand: async () => {
        calls++;
        // 只有「模型确定没跑过」的失败才可重试；裸 Error 一律视为不可重试
        if (calls < 3) throw new WakeBlockedError("runner did not start", true);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(3);
    expect(cursors).toEqual([1]);
    // 送达了就不该有 blocked 噪音
    expect(posts.some((p) => p.includes("blocked"))).toBe(false);
  });

  test("each failed attempt persists stuck, and the cursor stays put until the wake is resolved", async () => {
    const s = closeAfterOneMention();
    const events: string[] = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      onCursor: (c) => events.push(`cursor=${c}`),
      onStuck: (st: StuckWake | null) => events.push(st ? `stuck=${st.seq}/${st.attempts}` : "stuck=cleared"),
      post: async () => ({ seq: 1 }),
      runCommand: async () => {
        calls++;
        if (calls < 3) throw new WakeBlockedError("runner did not start", true);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    // 欠账在每次失败后落盘（进程此刻崩掉也记得重试了几次），游标绝不先于送达推进
    expect(events).toEqual(["stuck=1/1", "stuck=1/2", "stuck=cleared", "cursor=1"]);
  });

  test("after the retry budget is exhausted it gives up loudly: blocked status naming the seq, then advances", async () => {
    const s = closeAfterOneMention();
    const cursors: number[] = [];
    const posts: Array<Record<string, unknown>> = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 2,
      onCursor: (c) => cursors.push(c),
      post: async (_s, _t, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: 1 };
      },
      runCommand: async () => {
        calls++;
        throw new WakeBlockedError("runner binary missing", true);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(2); // 有界：绝不无限重放
    const blocked = posts.find((p) => p.state === "blocked");
    expect(blocked).toBeDefined();
    const note = String(blocked!.note);
    expect(note).toContain("seq=1");
    expect(note).toContain("runner binary missing");
    // 常数不许只活在源码里：放弃了几次、退避多久，频道上直接可见（无 CLI flag 的代价）
    expect(note).toContain("attempts=2/2");
    expect(note).toContain("retry_delay_ms=0");
    // 放弃是一次「了结」——响亮留痕之后才允许推进游标
    expect(cursors).toEqual([1]);
  });

  test("retry budget resumes from the persisted count: a crash mid-retry does not reset it", async () => {
    const s = closeAfterOneMention();
    const posts: Array<Record<string, unknown>> = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      // 上个进程已经在这条 seq 上烧掉 2 次，崩了。重启后只剩 1 次，不是重新 3 次。
      stuck: { seq: 1, attempts: 2, last_error: "died mid-retry" },
      onCursor: () => {},
      post: async (_s, _t, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: 1 };
      },
      runCommand: async () => {
        calls++;
        throw new WakeBlockedError("still broken", true);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(1); // 不是 3——否则一个反复崩溃的 runner 每次重启都换来一整轮新预算
    expect(posts.some((p) => p.state === "blocked")).toBe(true);
  });

  test("a blocked builtin runner signals failure to the caller instead of returning normally", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir: tempDir(),
      runProcess: async () => ({ code: 3, stdout: "", stderr: "boom" }),
      post: async (_s, _t, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: posts.length };
      },
    });

    // 它必须告诉 runServe「这条没送达」，否则调用方以为送达了、直接 ack 掉。
    await expect(run(triggerFrame(1), runnerCtx())).rejects.toThrow(/blocked|exit code 3/);
    // 但它**不该自己发** blocked：外层还要重试，瞬态失败不该污染频道状态（#206 门禁 P1②）
    expect(posts.some((p) => p.state === "blocked")).toBe(false);
  });

  test("a succeeding runner advances the cursor and leaves no debt", async () => {
    const s = closeAfterOneMention();
    const cursors: number[] = [];
    const stucks: unknown[] = [];
    const o = opts({
      server: s.url,
      onCursor: (c) => cursors.push(c),
      onStuck: (st) => stucks.push(st),
      runCommand: async () => {},
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(cursors).toEqual([1]);
    expect(stucks).toEqual([]);
  });
});

describe("连续放弃熔断 (#193 / #198 owner 约束④)", () => {
  function mentionBurst(count: number) {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      for (let seq = 1; seq <= count; seq++) {
        sock.send(msgFrame(seq, `wake ${seq}`, { mentions: ["me"] }));
      }
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 200);
    });
    return server;
  }

  test("three consecutive explicit abandons post a final sanitized blocked status and exit nonzero", async () => {
    const s = mentionBurst(3);
    const posts: Array<Record<string, unknown>> = [];
    const o = opts({
      server: s.url,
      maxWakeAttempts: 1,
      post: async (_a, _b, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: posts.length };
      },
      runCommand: async (frame) => {
        throw new WakeBlockedError(`runner missing for seq ${frame.seq}\nAuthorization: Bearer ap_secret_value`, true);
      },
    });

    expect(await runServe(o)).toBe(EXIT_WAKE_ABANDON_CIRCUIT);
    const blocked = posts.filter((p) => p.state === "blocked");
    expect(blocked).toHaveLength(4); // 三条逐条放弃留痕 + 一条 supervisor 熔断终态
    const finalNote = String(blocked.at(-1)!.note);
    expect(finalNote).toContain("circuit breaker");
    expect(finalNote).toContain("last_seq=3");
    expect(finalNote).toContain("runner missing for seq 3");
    expect(finalNote).not.toContain("ap_secret_value");
    expect(finalNote).not.toContain("\n");
  });

  test("a successfully delivered wake resets the consecutive-abandon counter", async () => {
    const s = mentionBurst(4);
    const posts: Array<Record<string, unknown>> = [];
    const seen: number[] = [];
    const o = opts({
      server: s.url,
      maxWakeAttempts: 1,
      post: async (_a, _b, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: posts.length };
      },
      runCommand: async (frame) => {
        seen.push(frame.seq);
        if (frame.seq !== 2) throw new WakeBlockedError(`runner missing ${frame.seq}`, true);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(posts.filter((p) => p.state === "blocked")).toHaveLength(3);
    expect(posts.some((p) => String(p.note).includes("circuit breaker"))).toBe(false);
  });

  test("after the circuit trips, buffered future mentions are neither executed nor acknowledged", async () => {
    const s = mentionBurst(5);
    const executed: number[] = [];
    const cursors: number[] = [];
    const o = opts({
      server: s.url,
      maxWakeAttempts: 1,
      onCursor: (cursor) => cursors.push(cursor),
      post: async () => ({ seq: 1 }),
      runCommand: async (frame) => {
        executed.push(frame.seq);
        throw new WakeBlockedError("runner missing", true);
      },
    });

    expect(await runServe(o)).toBe(EXIT_WAKE_ABANDON_CIRCUIT);
    expect(executed).toEqual([1, 2, 3]);
    // conn.ack 的权威副作用是 cursor 持久化；4/5 已在 FrameQueue 缓冲，但熔断后绝不消费。
    expect(cursors).toEqual([1, 2, 3]);
  });
});

describe("backlog vs debt (#193 + #198 约束②)", () => {
  // 游标停在 3，挂载水位 6（4/5/6 是离线积压），挂上后来一条真·新消息 7
  function backlogThenFresh() {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(6, "me"));
      sock.send(msgFrame(4, "overnight A", { mentions: ["me"] }));
      sock.send(msgFrame(5, "overnight B", { mentions: ["me"] }));
      sock.send(msgFrame(6, "overnight C", { mentions: ["me"] }));
      setTimeout(() => sock.send(msgFrame(7, "fresh", { mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 120);
    });
    return server;
  }

  test("默认跳过离线积压：只对挂载后到达的消息唤醒 runner", async () => {
    const s = backlogThenFresh();
    const seen: number[] = [];
    const o = opts({ server: s.url, since: 3, runCommand: async (f) => void seen.push(f.seq) });
    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([7]);
    expect(o.lines.some((l) => l.includes("跳过 3 条离线积压") && l.includes("seq 4..6"))).toBe(true);
  });

  test("--replay-backlog 恢复逐条重放", async () => {
    const s = backlogThenFresh();
    const seen: number[] = [];
    const o = opts({ server: s.url, since: 3, skipBacklog: false, runCommand: async (f) => void seen.push(f.seq) });
    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([4, 5, 6, 7]);
  });

  test("欠账落在积压区间里，也绝不被跳过——它不是积压，是我们欠着的", async () => {
    const s = backlogThenFresh();
    const seen: number[] = [];
    const o = opts({
      server: s.url,
      since: 3,
      // 上个进程在 seq 5 上送达失败、崩了。5 <= 挂载水位 6，长得跟积压一模一样。
      stuck: { seq: 5, attempts: 1, last_error: "died mid-retry" },
      runCommand: async (f) => void seen.push(f.seq),
    });
    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    // 4/6 是积压，跳过；5 是欠账，必须重放；7 是新消息
    expect(seen).toEqual([5, 7]);
    expect(o.lines.some((l) => l.includes("欠账 seq=5"))).toBe(true);
  });
});

// 190-codex-dev 门禁（PR #206）指出的两条未覆盖分支
describe("放弃通告发不出去时不得静默丢 @ (#206 门禁 P1①)", () => {
  test("最终 blocked 发送失败 → 欠账保留、游标不动、非零退出", async () => {
    const s = closeAfterOneMention();
    const cursors: number[] = [];
    const stucks: Array<StuckWake | null> = [];
    const o = opts({
      server: s.url,
      maxWakeAttempts: 1,
      onCursor: (c) => cursors.push(c),
      onStuck: (st) => stucks.push(st),
      post: async () => {
        throw new Error("network down");
      },
      runCommand: async () => {
        throw new Error("runner exploded");
      },
    });

    // 喊不出救命的 supervisor 没有理由继续消费队列——响亮地死，让人发现
    expect(await runServe(o)).not.toBe(EXIT_ARCHIVED);
    expect(await runServe(o)).not.toBe(0);
    // 没宣告过 = 没了结：游标绝不前进，欠账绝不清
    expect(cursors).toEqual([]);
    expect(stucks.at(-1)).not.toBeNull();
    expect(stucks.at(-1)!.seq).toBe(1);
  });
});

describe("重试期间不得污染频道状态 (#206 门禁 P1②)", () => {
  const builtin = (runProcess: RunnerProcess, post: BuiltinRunnerOptions["post"]) =>
    createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir: tempDir(),
      runProcess,
      post,
    });

  // 瞬态 = 模型没跑过（spawn 失败）。exit!=0 说明模型可能跑过，那类失败不重试（见 P1③）
  test("builtin runner 一次瞬态失败（没起来）后成功 → 频道上不留 blocked", async () => {
    const s = closeAfterOneMention();
    const posts: Array<Record<string, unknown>> = [];
    let calls = 0;
    const post = async (_s: string, _t: string, _c: string, body: Record<string, unknown>) => {
      posts.push(body);
      return { seq: posts.length };
    };
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      post: post as never,
      runCommand: builtin(async () => {
        calls++;
        if (calls === 1) throw new Error("spawn ENOENT"); // 进程没起来 → 模型确定没跑
        return { code: 0, stdout: `session id: 019f35d9-0000-7000-8000-000000000001\n`, stderr: "" };
      }, post as never),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(2);
    // 第一次失败不该把频道标成 blocked——它只是「还在重试」
    expect(posts.filter((p) => p.state === "blocked")).toHaveLength(0);
  });

  test("builtin runner 持续失败 → 全程只发一条最终 blocked，不是每次尝试一条", async () => {
    const s = closeAfterOneMention();
    const posts: Array<Record<string, unknown>> = [];
    const post = async (_s: string, _t: string, _c: string, body: Record<string, unknown>) => {
      posts.push(body);
      return { seq: posts.length };
    };
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      post: post as never,
      runCommand: builtin(async () => ({ code: 7, stdout: "", stderr: "always broken" }), post as never),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    // 每次尝试一条 blocked = 给 loop guard 上膛（worker/src/do.ts:2582 对 status 也计数）
    expect(posts.filter((p) => p.state === "blocked")).toHaveLength(1);
    expect(String(posts.find((p) => p.state === "blocked")!.note)).toContain("giving up");
  });
});

// 190-codex-dev 的反例（PR #206）：证伪了我「ack 守卫是死代码」的结论。
// stuck 能活着走到 conn.ack —— 只要欠账那一帧被 mentionsOnly / fromSelf 过滤掉。
describe("欠账必须先于过滤条件处理 (#206 门禁反例)", () => {
  test("--all 下留下的非 mention 欠账，重启回 mentions-only 后不得被过滤掉再 ack 越过", async () => {
    // 上个进程用 --all 跑，seq 4（不 @ 我）送达失败，留下欠账。
    // 这次重启是默认 mentions-only：seq 4 不含 @me，旧实现里 qualifies=false → 直接 ack 越过。
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(5, "me"));
      sock.send(msgFrame(4, "chatter, not a mention", { mentions: [] }));
      setTimeout(() => sock.send(msgFrame(5, "@me fresh", { mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 120);
    });

    const seen: number[] = [];
    const cursors: number[] = [];
    const o = opts({
      server: server.url,
      since: 3,
      mentionsOnly: true,
      stuck: { seq: 4, attempts: 1, last_error: "died in --all mode" },
      onCursor: (c) => cursors.push(c),
      post: async () => ({ seq: 1 }),
      runCommand: async (f) => void seen.push(f.seq),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    // 欠账必须被重试（它欠着，与当前过滤模式无关）
    expect(seen).toContain(4);
    // 游标绝不在欠账了结前越过它
    expect(cursors.every((c) => c >= 4)).toBe(true);
  });

  test("欠账未了结时，后续 seq 不得把游标带过它", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(6, "me"));
      // 欠账帧永远不来（比如被服务端修剪）；后面的新消息不该把游标带过 4
      setTimeout(() => sock.send(msgFrame(6, "@me fresh", { mentions: ["me"] })), 30);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 90);
    });
    const cursors: number[] = [];
    const o = opts({
      server: server.url,
      since: 3,
      stuck: { seq: 4, attempts: 1 },
      onCursor: (c) => cursors.push(c),
      post: async () => ({ seq: 1 }),
      runCommand: async () => {},
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(cursors.filter((c) => c >= 4)).toEqual([]);
  });
});

// 门禁 P1③ / P2（190-codex-dev on PR #206）
describe("重试不得重复模型副作用 (#206 门禁 P1③)", () => {
  test("runner 已经跑过模型（非零退出）→ 不重试，直接宣告放弃", async () => {
    const s = closeAfterOneMention();
    const posts: Array<Record<string, unknown>> = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3, // 预算给足，但这类失败一次都不该重试
      post: async (_a, _b, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: 1 };
      },
      runCommand: createBuiltinRunner({
        server: "http://agentparty.test",
        token: "ap_tok",
        channel: "dev",
        harness: "codex",
        workdir: tempDir(),
        // 进程起来了、模型跑过了，只是退出码非零 → 重跑会重复 git push / 开 PR 之类副作用
        runProcess: async () => {
          calls++;
          return { code: 7, stdout: "", stderr: "model ran, then failed" };
        },
        post: async () => ({ seq: 1 }),
      }),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(1); // 不是 3
    expect(posts.filter((p) => p.state === "blocked")).toHaveLength(1);
    const note = String(posts.find((p) => p.state === "blocked")!.note);
    expect(note).toContain("attempts=1/3");
    expect(note).toContain("not retriable");
  });

  test("runner 根本没起来（spawn 失败）→ 模型没跑过，可以安全重试", async () => {
    const s = closeAfterOneMention();
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      post: async () => ({ seq: 1 }),
      runCommand: createBuiltinRunner({
        server: "http://agentparty.test",
        token: "ap_tok",
        channel: "dev",
        harness: "codex",
        workdir: tempDir(),
        runProcess: async () => {
          calls++;
          if (calls < 3) throw new Error("spawn ENOENT");
          return { code: 0, stdout: "session id: 019f35d9-0000-7000-8000-000000000001\n", stderr: "" };
        },
        post: async () => ({ seq: 1 }),
      }),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(3); // 没跑过模型的失败，重试是安全的
  });

  test("崩溃在最后一次失败之后 → 最终通告仍带得出持久化的 last_error（P2）", async () => {
    const s = closeAfterOneMention();
    const posts: Array<Record<string, unknown>> = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 2,
      stuck: { seq: 1, attempts: 2, last_error: "runner binary missing" }, // 预算已耗尽
      post: async (_a, _b, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: 1 };
      },
      runCommand: async () => void calls++,
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(0); // 预算已耗尽，循环不跑
    const blocked = posts.find((p) => p.state === "blocked");
    expect(blocked).toBeDefined();
    expect(String(blocked!.note)).toContain("runner binary missing"); // 不是空字符串
  });
});

// 门禁第三轮（190-codex-dev on PR #206）
describe("resume 非零后不得内部 cold-start 重跑模型 (#206 门禁 P1②)", () => {
  test("resume 返回非零 → 只调用一次 runner，不 fork 出新 session 重复副作用", async () => {
    const workdir = tempDir();
    writeFileSync(
      join(workdir, "wake-session.json"),
      JSON.stringify({ harness: "codex", session_id: "019f35d9-0000-7000-8000-000000000001", created_at: 1, last_wake_ts: 1, wakes: 3 }),
    );
    const calls: string[][] = [];
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir,
      runProcess: async (args) => {
        calls.push(args);
        return { code: 9, stdout: "", stderr: "resume failed after model already pushed" };
      },
      post: async () => ({ seq: 1 }),
    });

    // resume 可能已经跑过模型、push 过、开过 PR，只是最后非零退出。
    // 再 cold-start 一次就是重复那些副作用。
    await expect(run(triggerFrame(1), runnerCtx())).rejects.toThrow();
    expect(calls).toHaveLength(1); // 不是 2
    expect(calls[0]!).toContain("resume");
  });
});

describe("codex-sdk 模型前失败可重试，模型后不可 (#206 门禁 P1③)", () => {
  test("startThread 抛错（模型还没跑）→ 标为可重试，外层再试一次就成功", async () => {
    const s = closeAfterOneMention();
    let starts = 0;
    let runs = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      post: async () => ({ seq: 1 }),
      runCommand: createSdkRunner({
        server: "http://agentparty.test",
        token: "ap_tok",
        channel: "dev",
        workdir: tempDir(),
        codexFactory: () => ({
          startThread: () => {
            starts++;
            if (starts === 1) throw new Error("EAI_AGAIN"); // 连服务端都没连上，模型确定没跑
            return {
              id: "thread_1",
              run: async () => {
                runs++;
                return { final_response: "ok" };
              },
            };
          },
          resumeThread: () => {
            throw new Error("should not resume");
          },
        }),
        post: async () => ({ seq: 1 }),
      }),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(starts).toBe(2); // 模型前的瞬态失败重试了
    expect(runs).toBe(1); // 模型只跑了一次
  });

  test("thread.run 抛错（模型可能已经跑过）→ 不可重试，一次即宣告放弃", async () => {
    const s = closeAfterOneMention();
    let runs = 0;
    const posts: Array<Record<string, unknown>> = [];
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      post: async (_a, _b, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: 1 };
      },
      runCommand: createSdkRunner({
        server: "http://agentparty.test",
        token: "ap_tok",
        channel: "dev",
        workdir: tempDir(),
        codexFactory: () => ({
          startThread: () => ({
            id: "thread_1",
            run: async () => {
              runs++;
              throw new Error("sdk exploded after the model ran");
            },
          }),
          resumeThread: () => ({ id: "thread_1", run: async () => ({ final_response: "x" }) }),
        }),
        post: async () => ({ seq: 1 }),
      }),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(runs).toBe(1); // 绝不重跑模型
    expect(posts.filter((p) => p.state === "blocked")).toHaveLength(1);
  });
});

// 门禁反例（190-codex-dev）：cursor=3、持久欠账 seq=4、welcome head=6 但未重放 seq 4、
// 挂载后来一条新 seq=7。旧实现会跑 seq 7、把 cursor 推到 7，**顺手清掉 seq=4 的欠账**。
// 现有测试只发 head 内的 seq 6，被 backlog 过滤，从没走到这条路径。
describe("后续消息不得清掉、也不得越过另一条欠账 (#206 门禁 P1①)", () => {
  test("欠账 seq=4 未重放时，head 之后的新 seq=7 不执行、不 ack、不清账", async () => {
    server = startMockServer((f, sock) => {
      if (f.type !== "hello") return;
      sock.send(welcomeFrame(6, "me")); // head=6，但服务端没重放 seq 4
      setTimeout(() => sock.send(msgFrame(7, "@me 新消息", { mentions: ["me"] })), 30);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 120);
    });
    const seen: number[] = [];
    const cursors: number[] = [];
    const stucks: Array<StuckWake | null> = [];
    const o = opts({
      server: server.url,
      since: 3,
      stuck: { seq: 4, attempts: 1, last_error: "died mid-retry" },
      onCursor: (c) => cursors.push(c),
      onStuck: (st) => stucks.push(st),
      post: async () => ({ seq: 1 }),
      runCommand: async (f) => void seen.push(f.seq),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([]); // seq 7 绝不能在欠账了结前被执行
    expect(cursors).toEqual([]); // 游标绝不越过 seq 4
    expect(stucks.filter((s) => s === null)).toEqual([]); // 欠账绝不被清掉
  });

  test("欠账那条重放回来 → 正常重试并了结，之后的新消息才放行", async () => {
    server = startMockServer((f, sock) => {
      if (f.type !== "hello") return;
      sock.send(welcomeFrame(6, "me"));
      sock.send(msgFrame(4, "@me 欠着的那条", { mentions: ["me"] })); // 这次重放回来了
      setTimeout(() => sock.send(msgFrame(7, "@me 新消息", { mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 140);
    });
    const seen: number[] = [];
    const o = opts({
      server: server.url,
      since: 3,
      stuck: { seq: 4, attempts: 1 },
      post: async () => ({ seq: 1 }),
      runCommand: async (f) => void seen.push(f.seq),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([4, 7]); // 先还债，再放行
  });
});

// 门禁 P2：`--profile --replay-backlog` 被接受，但 profile 的子 serve 没拿到这个语义。
// 用户明确要求重放，profile 模式下却静默跳过——这是「flag 接受了但不起作用」。
describe("profile 子 serve 继承 --replay-backlog (#206 门禁 P2)", () => {
  test("ProfileServeOptions 带 skipBacklog 时，构造的 ServeOptions 也带上", () => {
    // 契约层面钉住：profile 的 serveOpts 必须把 skipBacklog 透传下去
    const opts = profileChildServeOptions({
      server: "https://x",
      token: "ap_child",
      channel: "dev",
      mentionsOnly: true,
      skipBacklog: false,
    });
    expect(opts.skipBacklog).toBe(false);
  });

  test("默认（不传）时仍然跳过积压", () => {
    const opts = profileChildServeOptions({
      server: "https://x",
      token: "ap_child",
      channel: "dev",
      mentionsOnly: true,
    });
    expect(opts.skipBacklog).not.toBe(false);
  });
});
