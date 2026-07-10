// #120：serve 把未截断正文塞进 AP_BODY env，并把整个 context JSON 当成**单个 argv**
// 传给 codex / claude。
//
// 我实测证伪了 issue 里「大消息 E2BIG」这半：
//   - macOS 上 argv / env 单条到 ~2MB 才 E2BIG
//   - 最坏 context JSON ≈ 230KB（BODY_LIMIT 100KB + CHARTER_LIMIT 16KB + recent 20×400B）
//   差一个数量级，当前限额下炸不了。
//
// 但同一处代码有个更严重、且**当前就成立**的问题：argv 对同机任意用户可见（`ps -axww`）。
// 一条私有频道消息的正文、频道 charter、最近 20 条上下文，全部躺在命令行里。
// env 稍好（macOS 非特权用户读不到别人的 env），但同一 unix 用户下的兄弟 agent 照样能读——
// 而「一台机器多个 agent」正是本项目推荐的拓扑。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ARCHIVED, type MsgFrame } from "@agentparty/shared";
import { createBuiltinRunner, runServe, type RunnerProcess } from "../src/commands/serve";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ap-argv-"));
  dirs.push(d);
  return d;
}

const SECRET = "TOP_SECRET_MESSAGE_BODY";

function frame(): MsgFrame {
  return msgFrame(42, SECRET, { mentions: ["me"] }) as unknown as MsgFrame;
}
function ctx(contextDir: string) {
  return { cmd: "", channel: "dev", self: "me", contextDir, recent: [] as MsgFrame[] };
}

describe("builtin runner 不得把消息正文放进 argv (#120)", () => {
  test("codex 的 argv 里不出现正文 / charter，只出现 context 文件路径", async () => {
    let captured: string[] = [];
    const runProcess: RunnerProcess = async (args) => {
      captured = args;
      return { code: 0, stdout: "session id: 019f35d9-0000-7000-8000-000000000001\n", stderr: "" };
    };
    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir: tmp(),
      runProcess,
      post: async () => ({ seq: 1 }),
    })(frame(), {
      ...ctx(tmp()),
      charter: { charter: "CHARTER_SECRET_TEXT", charter_rev: 1, updated_at: 0, updated_by: "x" },
    });

    const argv = captured.join(" ");
    // ps -axww 对同机任意用户可见。正文和 charter 绝不能出现在这里。
    expect(argv).not.toContain(SECRET);
    expect(argv).not.toContain("CHARTER_SECRET_TEXT");
    // 但模型必须拿得到——通过 0700 私有目录里的 context 文件路径
    expect(argv.includes("agentparty-serve-") || argv.includes("ap-argv-")).toBe(true);
    expect(argv).toContain(".json");
  });

  test("claude harness 同样不泄漏", async () => {
    let captured: string[] = [];
    const runProcess: RunnerProcess = async (args) => {
      captured = args;
      return { code: 0, stdout: JSON.stringify({ result: "ok", session_id: "abc" }), stderr: "" };
    };
    await createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "claude",
      workdir: tmp(),
      runProcess,
      post: async () => ({ seq: 1 }),
    })(frame(), ctx(tmp()));

    expect(captured.join(" ")).not.toContain(SECRET);
  });
});

describe("AP_BODY 不得把未截断正文塞进 env (#120)", () => {
  test("大正文：env 里被截断并打上 AP_BODY_TRUNCATED=1，完整正文仍走 stdin", async () => {
    const outDir = tmp();
    const big = "B".repeat(10_000);
    let server: MockServer | null = null;
    server = startMockServer((f, sock) => {
      if (f.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, big, { mentions: ["me"] })), 20);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 120);
    });
    try {
      const code = await runServe({
        server: server.url,
        token: "ap_tok",
        channel: "dev",
        since: 0,
        mentionsOnly: true,
        out: () => {},
        // env 长度、截断标志、stdin 长度各写一个文件
        cmd: `printf '%s' "$AP_BODY" | wc -c > ${outDir}/envlen; printf '%s' "$AP_BODY_TRUNCATED" > ${outDir}/flag; wc -c > ${outDir}/stdinlen`,
      });
      expect(code).toBe(EXIT_ARCHIVED);

      const envLen = Number(readFileSync(join(outDir, "envlen"), "utf8").trim());
      const stdinLen = Number(readFileSync(join(outDir, "stdinlen"), "utf8").trim());
      expect(readFileSync(join(outDir, "flag"), "utf8").trim()).toBe("1");
      expect(envLen).toBeLessThan(big.length); // env 里被截断
      expect(stdinLen).toBe(big.length); // stdin 拿到完整正文（stdin 不进 ps）
    } finally {
      server?.stop();
    }
  });

  test("小正文：不截断，标志为 0", async () => {
    const outDir = tmp();
    let server: MockServer | null = null;
    server = startMockServer((f, sock) => {
      if (f.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "short", { mentions: ["me"] })), 20);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 120);
    });
    try {
      await runServe({
        server: server.url,
        token: "ap_tok",
        channel: "dev",
        since: 0,
        mentionsOnly: true,
        out: () => {},
        cmd: `printf '%s' "$AP_BODY" > ${outDir}/body; printf '%s' "$AP_BODY_TRUNCATED" > ${outDir}/flag`,
      });
      expect(readFileSync(join(outDir, "body"), "utf8")).toBe("short");
      expect(readFileSync(join(outDir, "flag"), "utf8").trim()).toBe("0");
    } finally {
      server?.stop();
    }
  });
});
