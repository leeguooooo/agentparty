// M3：invite 接入包 / webhook 子命令 / channel create --party
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBoard, type MsgFrame, type PresenceEntry } from "@agentparty/shared";
import { workspaceId } from "../src/config";
import { handleRestError, RestError, TAIL_BEFORE } from "../src/rest";
import { startRestMock, type RestMock, type RestRequest } from "./rest-mock";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let mock: RestMock | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-cli-m3-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home, ADMIN_SECRET: undefined, ...env },
    stdin: stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function writeCfg(server: string) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ server, token: "ap_tok" }));
}

function readCfg(): { server: string; token: string } {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    server: string;
    token: string;
  };
}

function writeWorkspaceState(channel: string, cursor = 0) {
  const dir = join(home, "state", workspaceId(process.cwd()));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ channel, cursor }));
}

function reqsOf(m: RestMock, method: string, pathPrefix: string): RestRequest[] {
  return m.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
}

describe("party invite", () => {
  test("默认参数：slug 由标题推导，铸 guest+share，输出可粘贴接入包", async () => {
    mock = startRestMock();
    const r = await runCli(["invite", "Fix Login Bug", "--server", mock.url], {
      ADMIN_SECRET: "s3cret",
    });
    expect(r.code).toBe(0);

    // 请求序列：agent token → channel → readonly token
    const tokenReqs = reqsOf(mock, "POST", "/api/tokens");
    // guest agent + share readonly 都带 owner（默认 = ASCII 标题）与 channel_scope=slug（跨公司隔离，spec §5.3）
    expect(tokenReqs.map((t) => t.body)).toEqual([
      {
        name: "fix-login-bug-guest",
        role: "agent",
        owner: "Fix Login Bug",
        channel_scope: "fix-login-bug",
      },
      {
        name: "fix-login-bug-share",
        role: "readonly",
        owner: "Fix Login Bug",
        channel_scope: "fix-login-bug",
      },
    ]);
    expect(tokenReqs[0]!.headers["x-admin-secret"]).toBe("s3cret");
    const chanReq = reqsOf(mock, "POST", "/api/channels")[0]!;
    expect(chanReq.body).toEqual({
      slug: "fix-login-bug",
      title: "Fix Login Bug",
      kind: "standing",
      mode: "normal",
      visibility: "private",
    });
    // 建频道用刚铸的 guest token
    expect(chanReq.headers.authorization).toBe("Bearer ap_fix-login-bug-guest_secret");

    // 接入包内容可整段粘贴
    expect(r.stdout).toContain(
      `party init --server ${mock.url} --token ap_fix-login-bug-guest_secret --channel fix-login-bug`,
    );
    const scopeGuardIndex = r.stdout.indexOf("AgentParty onboarding scope: join the existing channel #fix-login-bug");
    const initIndex = r.stdout.indexOf("party init --server");
    expect(scopeGuardIndex).toBeGreaterThan(-1);
    expect(scopeGuardIndex).toBeLessThan(initIndex);
    expect(r.stdout).toContain("only the supplied party commands");
    expect(r.stdout).toContain("Do not create or select another channel");
    expect(r.stdout).toContain("app-server, MCP, or project-local channel workflow (for example, Trellis)");
    expect(r.stdout).toContain("do not delegate onboarding");
    // 自包含简报要内联教会 agent 待命模型，核心是保住 agent 自己会话的上下文：
    // Claude Code 走后台 watch --once（同会话唤醒），其它 harness 走 serve + 续会话 runner
    expect(r.stdout).toContain("party watch fix-login-bug --mentions-only --once");
    expect(r.stdout).toContain("party serve fix-login-bug --runner claude --replay-backlog");
    expect(r.stdout).toContain('$HOME/.agentparty/agents/agentparty-fix-login-bug-guest-fix-login-bug.json');
    expect(r.stdout).toContain("TMPDIR 清理会抹掉身份和 cursor");
    expect(r.stdout).not.toContain("${TMPDIR");
    expect(r.stdout).toContain("party serve fix-login-bug --on-mention");
    expect(r.stdout).toContain("Codex CLI / Codex tool-call shell：不要用 watch 当 wake 层");
    expect(r.stdout).toContain("watch --follow：只适合 tail/debug");
    expect(r.stdout).toContain("tmux / launchctl / 真实 supervisor");
    expect(r.stdout).toContain("codex exec resume --last --skip-git-repo-check");
    expect(r.stdout).toContain("claude -p -c");
    expect(r.stdout).toContain("零 token");
    expect(r.stdout).toContain("party wake test @你");
    expect(r.stdout).toContain(`${mock.url}/c/fix-login-bug?t=ap_fix-login-bug-share_secret`);
    // 输出快照（归一化随机端口）
    expect(r.stdout.replaceAll(mock.url, "https://party.example")).toMatchSnapshot();
  });

  test("未加引号多词标题会合并，不丢词", async () => {
    mock = startRestMock();
    const r = await runCli(["invite", "Fix", "Login", "Bug", "--server", mock.url], {
      ADMIN_SECRET: "s3cret",
    });
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels")[0]!.body).toMatchObject({
      slug: "fix-login-bug",
      title: "Fix Login Bug",
    });
  });

  test("scope guard precedes moderator-controlled charter text and party init", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/guarded-room/charter") {
        return Response.json({ charter: "MODERATOR CONTROLLED CHARTER", charter_rev: 1 });
      }
      return undefined;
    });
    const r = await runCli(["invite", "Guarded Room", "--server", mock.url], { ADMIN_SECRET: "s" });

    expect(r.code).toBe(0);
    const guardIndex = r.stdout.indexOf("AgentParty onboarding scope: join the existing channel #guarded-room");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(r.stdout.indexOf("MODERATOR CONTROLLED CHARTER"));
    expect(guardIndex).toBeLessThan(r.stdout.indexOf("party init "));
  });

  test("--checkin-mention 会在报到行 @ 邀请人", async () => {
    mock = startRestMock();
    const r = await runCli(["invite", "Fix Login Bug", "--checkin-mention", "leo", "--server", mock.url], {
      ADMIN_SECRET: "s3cret",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("# @ 邀请人让他知道你来了");
    expect(r.stdout).toContain(
      'party send "👋 fix-login-bug-guest 报到，来参与协作" --channel fix-login-bug --mention leo',
    );
  });

  test("--slug --temp --party --guest-name 组合", async () => {
    mock = startRestMock();
    const r = await runCli(
      [
        "invite",
        "修复登录",
        "--slug",
        "hotfix",
        "--temp",
        "--party",
        "--guest-name",
        "bob",
        "--server",
        mock.url,
      ],
      { ADMIN_SECRET: "s3cret" },
    );
    expect(r.code).toBe(0);
    const tokenReqs = reqsOf(mock, "POST", "/api/tokens");
    // 标题非 ASCII（CJK）→ owner 退回 slug（header-safe）；两个 token 都带 channel_scope=slug
    expect(tokenReqs.map((t) => t.body)).toEqual([
      { name: "bob", role: "agent", owner: "hotfix", channel_scope: "hotfix" },
      { name: "hotfix-share", role: "readonly", owner: "hotfix", channel_scope: "hotfix" },
    ]);
    expect(reqsOf(mock, "POST", "/api/channels")[0]!.body).toEqual({
      slug: "hotfix",
      title: "修复登录",
      kind: "temp",
      mode: "party",
      visibility: "private",
    });
    expect(r.stdout).toContain("(temp · party)");
    expect(r.stdout).toContain("--token ap_bob_secret --channel hotfix");
  });

  test("--owner 覆盖默认标签，写在 guest agent 与 share readonly 两个 token 上", async () => {
    mock = startRestMock();
    const r = await runCli(
      ["invite", "Fix Login Bug", "--owner", "leo@leeguoo.com", "--server", mock.url],
      { ADMIN_SECRET: "s3cret" },
    );
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/tokens").map((t) => t.body)).toEqual([
      {
        name: "fix-login-bug-guest",
        role: "agent",
        owner: "leo@leeguoo.com",
        channel_scope: "fix-login-bug",
      },
      {
        name: "fix-login-bug-share",
        role: "readonly",
        owner: "leo@leeguoo.com",
        channel_scope: "fix-login-bug",
      },
    ]);
  });

  test("缺 ADMIN_SECRET 退出 1", async () => {
    mock = startRestMock();
    const r = await runCli(["invite", "t", "--server", mock.url]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ADMIN_SECRET");
    expect(mock.requests.length).toBe(0);
  });

  test("缺标题退出 1", async () => {
    const r = await runCli(["invite"], { ADMIN_SECRET: "s" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party invite");
  });

  test("value flags 缺值退出 1 且不发请求", async () => {
    mock = startRestMock();
    const r = await runCli(["invite", "demo", "--server", mock.url, "--slug"], {
      ADMIN_SECRET: "s",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--slug requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("非法 --checkin-mention 本地拒绝", async () => {
    const r = await runCli(["invite", "demo", "--server", "https://party.example", "--checkin-mention", ":bad"], {
      ADMIN_SECRET: "s",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--checkin-mention must match");
  });

  test("--checkin-mention 缺值退出 1", async () => {
    const r = await runCli(["invite", "demo", "--server", "https://party.example", "--checkin-mention"], {
      ADMIN_SECRET: "s",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--checkin-mention requires a value");
  });

  test("guest token 重名 409 → 报错提示 --guest-name", async () => {
    mock = startRestMock((req) => {
      if (
        req.method === "POST" &&
        req.path === "/api/tokens" &&
        (req.body as { role: string }).role === "agent"
      ) {
        return Response.json(
          { error: { code: "conflict", message: "token exists" } },
          { status: 409 },
        );
      }
      return undefined;
    });
    const r = await runCli(["invite", "demo", "--server", mock.url], { ADMIN_SECRET: "s" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--guest-name");
  });

  test("已存在频道复用：不撤销已分发只读链接，打印服务器真实 mode 而非本地 flag", async () => {
    mock = startRestMock((req) => {
      // 建频道已存在 → 409（复用）
      if (req.method === "POST" && req.path === "/api/channels") {
        return Response.json({ error: { code: "conflict", message: "exists" } }, { status: 409 });
      }
      // 服务器真实频道是 temp·party，本地并未传 --temp --party
      if (req.method === "GET" && req.path === "/api/channels") {
        return Response.json({
          channels: [{ slug: "demo", title: "demo", kind: "temp", mode: "party", archived_at: null }],
        });
      }
      // share token 已存在 → 409
      if (
        req.method === "POST" &&
        req.path === "/api/tokens" &&
        (req.body as { role: string }).role === "readonly"
      ) {
        return Response.json({ error: { code: "conflict", message: "exists" } }, { status: 409 });
      }
      return undefined;
    });
    const r = await runCli(["invite", "demo", "--server", mock.url], { ADMIN_SECRET: "s" });
    expect(r.code).toBe(0);
    // 绝不撤销已分发的只读链接
    expect(reqsOf(mock, "DELETE", "/api/tokens/demo-share").length).toBe(0);
    // readonly 只铸一次（返回 409 后不重铸）
    expect(
      reqsOf(mock, "POST", "/api/tokens").filter(
        (t) => (t.body as { role: string }).role === "readonly",
      ).length,
    ).toBe(1);
    // 打印服务器真实 mode（party），而非本地 flag（normal）
    expect(r.stdout).toContain("(temp · party)");
    // 提示沿用旧链接，且不再打印新的明文只读 token
    expect(r.stdout).toContain("沿用已分发的 demo-share 链接");
    expect(r.stdout).not.toContain("ap_demo-share_secret");
  });

  test("复用频道但 listChannels 拉取失败：标注 existing channel，不谎报本地 flag", async () => {
    mock = startRestMock((req) => {
      if (req.method === "POST" && req.path === "/api/channels") {
        return Response.json({ error: { code: "conflict", message: "exists" } }, { status: 409 });
      }
      if (req.method === "GET" && req.path === "/api/channels") {
        return Response.json({ error: { code: "oops", message: "boom" } }, { status: 500 });
      }
      return undefined;
    });
    const r = await runCli(["invite", "demo", "--slug", "demo", "--party", "--server", mock.url], {
      ADMIN_SECRET: "s",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(existing channel)");
    // 不因本地 --party 谎报 party
    expect(r.stdout).not.toContain("· party");
  });

  test("建频道失败时撤销刚铸的 guest token，避免重试卡在 409", async () => {
    mock = startRestMock((req) => {
      if (req.method === "POST" && req.path === "/api/channels") {
        return Response.json(
          { error: { code: "oops", message: "channel failed" } },
          { status: 500 },
        );
      }
      return undefined;
    });
    const r = await runCli(["invite", "demo", "--server", mock.url], { ADMIN_SECRET: "s" });
    expect(r.code).toBe(1);
    expect(reqsOf(mock, "DELETE", "/api/tokens/demo-guest").length).toBe(1);
    expect(reqsOf(mock, "POST", "/api/tokens").map((t) => t.body)).toEqual([
      { name: "demo-guest", role: "agent", owner: "demo", channel_scope: "demo" },
    ]);
  });
});

describe("party init", () => {
  test("writes config and prints resolved config source plus runtime identity", async () => {
    mock = startRestMock();
    const r = await runCli(["init", "--server", mock.url, "--token", "ap_new"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`config written for ${mock.url}`);
    expect(r.stdout).toContain("config: workspace ");
    expect(r.stdout).toContain("token=sha256:");
    expect(r.stdout).not.toContain("ap_new");
    expect(r.stdout).toContain("runtime: agent (agent/agent)");
  });

  test("value flags 缺值不回退旧 config", async () => {
    mock = startRestMock();
    writeCfg("https://old.example");
    const r = await runCli(["init", "--server", "--token", "ap_new"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--server requires a value");
    expect(readCfg()).toEqual({ server: "https://old.example", token: "ap_tok" });
    expect(mock.requests.length).toBe(0);
  });

  test("--channel 验证失败时不覆盖已有可用 config", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels") {
        return Response.json(
          { error: { code: "unauthorized", message: "bad token" } },
          { status: 401 },
        );
      }
      return undefined;
    });
    writeCfg("https://old.example");
    const r = await runCli(["init", "--server", mock.url, "--token", "ap_bad", "--channel", "dev"]);
    expect(r.code).toBe(3);
    expect(readCfg()).toEqual({ server: "https://old.example", token: "ap_tok" });
    expect(reqsOf(mock, "POST", "/api/channels")).toHaveLength(0);
  });

  test("非法 --server 不覆盖已有可用 config", async () => {
    writeCfg("https://old.example");
    const r = await runCli(["init", "--server", "not-a-url", "--token", "ap_bad"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--server must be an http(s) URL");
    expect(readCfg()).toEqual({ server: "https://old.example", token: "ap_tok" });
  });
});

describe("party send", () => {
  test("绑定频道后未加引号多词正文不会被误当成 channel", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["send", "hello", "world"]);
    expect(r.code).toBe(0);
    const sendReq = reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!;
    expect(sendReq.body).toMatchObject({
      kind: "message",
      body: "hello world",
      mentions: [],
      reply_to: null,
    });
  });

  test("--channel 可在绑定 workspace 中显式发送到其他频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["send", "--channel", "ops", "hello", "world"]);
    expect(r.code).toBe(0);
    const sendReq = reqsOf(mock, "POST", "/api/channels/ops/messages")[0]!;
    expect(sendReq.body).toMatchObject({ body: "hello world" });
  });

  test("未知 flag 退出 1 且不会回退到绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["send", "--channe", "ops", "hello"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown option --channe");
    expect(mock.requests.length).toBe(0);
  });

  test("空 --channel 不会回退到绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["send", "--channel=", "hello"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--channel requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("非法 --channel 本地拒绝且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    for (const channel of ["Bad_Slug", "-"]) {
      const r = await runCli(["send", "--channel", channel, "hello"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("channel must match");
    }
    expect(mock.requests.length).toBe(0);
  });

  test("--channel 缺正文退出 1 且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["send", "--channel", "dev"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing message body");
    expect(mock.requests.length).toBe(0);
  });

  test("send 不再把第一个 positional 当隐式 channel", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["send", "dev", "hello", "world"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no channel");
    expect(mock.requests.length).toBe(0);
  });

  test("绑定频道后首词等于频道名也保留为正文", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["send", "dev", "is", "down"]);
    expect(r.code).toBe(0);
    const sendReq = reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!;
    expect(sendReq.body).toMatchObject({
      kind: "message",
      body: "dev is down",
      mentions: [],
      reply_to: null,
    });
  });

  test("send - 从 stdin 读取正文", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["send", "--channel", "dev", "-"], {}, "hello from stdin\n");
    expect(r.code).toBe(0);
    const sendReq = reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!;
    expect(sendReq.body).toMatchObject({ body: "hello from stdin\n" });
  });

  test("send <slug> - 把首 positional 当 channel 并从 stdin 读正文", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["send", "dev", "-"], {}, "hi from stdin\n");
    expect(r.code).toBe(0);
    const sendReq = reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!;
    expect(sendReq.body).toMatchObject({ body: "hi from stdin\n" });
  });

  test("send -- - 发送字面量短横线，不读 stdin", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["send", "--channel", "dev", "--", "-"], {}, "");
    expect(r.code).toBe(0);
    const sendReq = reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!;
    expect(sendReq.body).toMatchObject({ body: "-" });
  });

  test("send - -- 仍从 stdin 读取正文", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["send", "--channel", "dev", "-", "--"], {}, "stdin still wins");
    expect(r.code).toBe(0);
    const sendReq = reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!;
    expect(sendReq.body).toMatchObject({ body: "stdin still wins" });
  });

  test("--channel 缺值不会回退到绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["send", "--channel", "--mention", "bob", "hello"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--channel requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("--mention 缺值不会发送 literal true", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["send", "--channel", "dev", "--mention", "--reply-to", "5", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--mention requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("非法 --mention 本地拒绝且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["send", "--channel", "dev", "--mention", ":bad", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--mention must match");
    expect(mock.requests.length).toBe(0);
  });

  test("非法 --reply-to 退出 1 且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["send", "--channel", "dev", "hello", "--reply-to", "bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--reply-to must be a positive integer");
    expect(mock.requests.length).toBe(0);
  });

  test("--reply-to 只接受正整数", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const decimal = await runCli(["send", "--channel", "dev", "hello", "--reply-to", "1.5"]);
    expect(decimal.code).toBe(1);
    expect(decimal.stderr).toContain("--reply-to must be a positive integer");
    const negative = await runCli(["send", "--channel", "dev", "hello", "--reply-to", "-1"]);
    expect(negative.code).toBe(1);
    expect(negative.stderr).toContain("--reply-to must be a positive integer");
    expect(mock.requests.length).toBe(0);
  });
});

describe("party ask", () => {
  test("--timeout 缺值不发送消息", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["ask", "hello", "--timeout"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--timeout requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("--timeout 非法值不发送消息", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["ask", "hello", "--timeout", "0"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--timeout must be a positive integer");
    expect(mock.requests.length).toBe(0);
  });

  test("--timeout 过大不发送消息", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["ask", "hello", "--timeout", "2147484"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--timeout must be <=");
    expect(mock.requests.length).toBe(0);
  });
});

describe("party status/history channel flag", () => {
  test("status --channel 优先于绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli([
      "status",
      "--channel",
      "ops",
      "working",
      "-m",
      "checking",
      "--mention",
      "dispatcher",
      "--scope",
      "worker/src/do.ts",
      "--scope",
      "shared/src/protocol.ts",
      "--blocked-reason",
      "waiting review",
      "--summary-seq",
      "42",
    ]);
    expect(r.code).toBe(0);
    const req = reqsOf(mock, "POST", "/api/channels/ops/messages")[0]!;
    expect(req.body).toMatchObject({
      kind: "status",
      state: "working",
      note: "checking",
      mentions: ["dispatcher"],
      scope: ["worker/src/do.ts", "shared/src/protocol.ts"],
      blocked_reason: "waiting review",
      summary_seq: 42,
    });
  });

  test("status forwards structured role residency and wake kind", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli([
      "status",
      "dev",
      "working",
      "-m",
      "coordinating",
      "--role",
      "host",
      "--residency",
      "human_driven",
      "--wake-kind",
      "none",
      "--decision-kind",
      "handoff",
      "--decision",
      "handoff release gate",
      "--next",
      "reviewer signs off",
      "--expires-at",
      "4200000",
      "--handoff-to",
      "reviewer-1",
      "--workflow-id",
      "wf-release",
      "--workflow-kind",
      "orchestrator-workers",
      "--workflow-run",
      "run-1",
      "--workflow-step",
      "review",
      "--workflow-parent-summary-seq",
      "99",
    ]);
    expect(r.code).toBe(0);
    const req = reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!;
    expect(req.body).toMatchObject({
      kind: "status",
      state: "working",
      note: "coordinating",
      role: "host",
      residency: "human_driven",
      wake: { kind: "none" },
      decision: {
        kind: "handoff",
        decision: "handoff release gate",
        next: "reviewer signs off",
        expires_at: 4200000,
        handoff_to: "reviewer-1",
      },
      workflow: {
        workflow_id: "wf-release",
        kind: "orchestrator-workers",
        run_id: "run-1",
        step_id: "review",
        parent_summary_seq: 99,
      },
      context: {
        config_kind: "global",
        config_fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{12}$/),
        workspace_id: expect.stringMatching(/^[a-z0-9-]+-[0-9a-f]{16}$/),
        workspace_label: expect.any(String),
      },
    });
    expect((req.body as { context: { worktree_label?: string } }).context.worktree_label).toContain(":");
  });

  test("status lets an interactive agent self-report its restart-resume session (#522)", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli([
      "status", "dev", "working",
      "--session-harness", "claude",
      "--session-id", "019f35d9-0000-7000-8000-000000000522",
      "--session-cwd", "/workspace/agentparty",
    ]);
    expect(r.code).toBe(0);
    const req = reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!;
    expect(req.body).toMatchObject({
      agent_session: {
        harness: "claude",
        session_id: "019f35d9-0000-7000-8000-000000000522",
        cwd: "/workspace/agentparty",
        updated_at: expect.any(Number),
      },
    });
  });

  test("status --task scopes the status and updates the task ledger", async () => {
    mock = startRestMock((req) => {
      if (req.method === "PATCH" && req.path === "/api/channels/dev/tasks/12") {
        return Response.json({ type: "task", id: 12, state: (req.body as { state: string }).state });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["status", "dev", "working", "-m", "started", "--scope", "web", "--task", "12"]);
    expect(r.code).toBe(0);
    const send = reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!;
    expect(send.body).toMatchObject({
      kind: "status",
      state: "working",
      note: "started",
      scope: ["web", "task:12"],
    });
    expect(reqsOf(mock, "PATCH", "/api/channels/dev/tasks/12")[0]!.body).toEqual({ state: "in_progress" });
  });

  test("status debug-auth prints safe runtime/config source without raw token", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["status", "dev", "working", "--debug-auth"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("using runtime=agent (agent/agent)");
    expect(r.stderr).toContain("auth-source=runtime_config");
    expect(r.stderr).toContain("config=global:");
    expect(r.stderr).toContain("token=sha256:");
    expect(r.stderr).not.toContain("ap_tok");
  });

  test("status rejects invalid collaboration role fields locally", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    for (const args of [
      ["status", "dev", "working", "--role", "agent"],
      ["status", "dev", "working", "--residency", "resident"],
      ["status", "dev", "working", "--wake-kind", "poll"],
      ["status", "dev", "working", "--decision-kind", "lease"],
      ["status", "dev", "working", "--decision-kind", "handoff"],
      ["status", "dev", "working", "--decision", "handoff", "--handoff-to", "bad name"],
      ["status", "dev", "working", "--decision", "takeover", "--takeover-from", "bad name"],
      ["status", "dev", "working", "--workflow-id", "wf"],
      ["status", "dev", "working", "--workflow-kind", "parallel"],
      ["status", "dev", "working", "--workflow-id", "bad id", "--workflow-kind", "parallel"],
      ["status", "dev", "working", "--workflow-id", "wf", "--workflow-kind", "airflow"],
      ["status", "dev", "working", "--workflow-id", "wf", "--workflow-kind", "parallel", "--workflow-parent-summary-seq", "0"],
    ]) {
      const r = await runCli(args);
      expect(r.code).toBe(1);
    }
    expect(mock.requests.length).toBe(0);
  });

  test("status -m 后接 flag 退出 1 且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["status", "dev", "working", "-m", "--channel", "ops"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--note requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("history --channel 优先于绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["history", "--channel", "ops", "--since", "5"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "GET", "/api/channels/ops/messages")).toHaveLength(1);
  });

  test("history --json prints raw messages as NDJSON", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "msg",
              seq: 7,
              sender: { name: "alice", kind: "agent" },
              kind: "message",
              body: "hello",
              mentions: ["me"],
              reply_to: null,
              state: null,
              note: null,
              ts: 123,
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["history", "dev", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({
      schema: "agentparty.v1",
      type: "msg",
      seq: 7,
      body: "hello",
      mentions: ["me"],
    });
  });

  test("host board derives claims/blockers from the task ledger; decisions stay from messages (#204)", async () => {
    const now = Date.now();
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "host-a",
              state: "working",
              note: "coordinating",
              ts: now - 1000,
              last_seen: now - 1000,
              role: "host",
              role_source: "assigned",
              residency: "supervised",
              wake: { kind: "serve", verified_at: now - 2000 },
            },
            {
              name: "host-b",
              state: "working",
              note: "manual",
              ts: now - 1000,
              last_seen: now - 1000,
              role: "host",
              role_source: "self",
              residency: "human_driven",
              wake: { kind: "none" },
            },
          ],
        });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/tasks") {
        // open_claims / blockers 现在从任务台账派生：worker-a 正在做 web/src（in_progress），worker-b 因缺 token 被 blocked。
        // #204 P1：host board 现在按 board-相关状态分别拉，故 mock 按 state 查询参数过滤，模拟真实 API
        // （否则每个状态查询都返回全量 → 重复 claim）。
        const allTasks = [
            {
              type: "task",
              id: 1,
              channel: "dev",
              title: "ui work",
              desc: null,
              state: "in_progress",
              assignee: { name: "worker-a", kind: "agent" },
              created_by: "worker-a",
              created_by_kind: "agent",
              priority: 0,
              labels: [],
              parent_id: null,
              anchor_seqs: [],
              scope: ["web/src"],
              blocked_reason: null,
              completion_artifact: null,
              workflow_id: null,
              created_at: 10_000,
              updated_at: 10_000,
              completed_at: null,
            },
            {
              type: "task",
              id: 2,
              channel: "dev",
              title: "worker work",
              desc: null,
              state: "blocked",
              assignee: { name: "worker-b", kind: "agent" },
              created_by: "worker-b",
              created_by_kind: "agent",
              priority: 0,
              labels: [],
              parent_id: null,
              anchor_seqs: [],
              scope: ["worker/src"],
              blocked_reason: "need token",
              completion_artifact: null,
              workflow_id: null,
              created_at: 11_000,
              updated_at: 11_000,
              completed_at: null,
            },
        ];
        const tasks = req.query.state ? allTasks.filter((task) => task.state === req.query.state) : allTasks;
        return Response.json({ tasks });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "status",
              seq: 12,
              sender: { name: "host-a", kind: "agent" },
              kind: "status",
              body: "handoff",
              mentions: [],
              reply_to: null,
              state: "working",
              note: "handoff",
              status: {
                owner: "host-a",
                state: "working",
                scope: [],
                summary_seq: null,
                blocked_reason: null,
                updated_at: 12000,
                decision: {
                  kind: "handoff",
                  owner: "host-a",
                  decision: "handoff release gate",
                  next: "reviewer signs off",
                  expires_at: null,
                  handoff_to: "reviewer-1",
                },
              },
              ts: 12000,
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["host", "board", "dev", "--json"]);
    expect(r.code).toBe(0);
    const frame = JSON.parse(r.stdout.trim()) as {
      type: string;
      hosts: Array<{ name: string; lease: string; stale_reason: string | null }>;
      open_claims: Array<{ task_id: number | null; owner: string; state: string; task_state: string | null; scope: string[] }>;
      blockers: Array<{ task_id: number | null; owner: string; state: string; task_state: string | null; blocked_reason: string | null }>;
      decisions: Array<{ owner: string; kind: string; handoff_to: string | null }>;
      recommended_actions: Array<{ kind: string; target: string | null; requires_human: boolean }>;
    };
    expect(frame.type).toBe("host_board");
    expect(frame.hosts).toEqual([
      expect.objectContaining({ name: "host-a", lease: "active", stale_reason: null }),
      expect.objectContaining({ name: "host-b", lease: "stale", stale_reason: "residency=human_driven" }),
    ]);
    // claim 身份 = task id；blocked 的 task 只进 blockers、不进 open_claims。
    expect(frame.open_claims).toEqual([
      expect.objectContaining({ task_id: 1, owner: "worker-a", state: "working", task_state: "in_progress", scope: ["web/src"] }),
    ]);
    expect(frame.blockers).toEqual([
      expect.objectContaining({ task_id: 2, owner: "worker-b", state: "blocked", task_state: "blocked", blocked_reason: "need token" }),
    ]);
    // decisions 仍旧从消息折叠来。
    expect(frame.decisions).toEqual([
      expect.objectContaining({ owner: "host-a", kind: "handoff", handoff_to: "reviewer-1" }),
    ]);
    expect(frame.recommended_actions).toEqual([
      expect.objectContaining({ kind: "review-blockers", target: "worker-b", requires_human: false }),
    ]);
    // #151 扩展：host board 默认取最近窗口（tail）。消息端点被打两次：主查询 + limit=1 头探针。
    const messageReqs = reqsOf(mock, "GET", "/api/channels/dev/messages");
    const mainReq = messageReqs.find((r) => r.query.limit !== "1");
    expect(mainReq?.query).toMatchObject({ before: String(TAIL_BEFORE), limit: "500" });
    expect(mainReq?.query.since).toBeUndefined();
    const headProbeReq = messageReqs.find((r) => r.query.limit === "1");
    expect(headProbeReq?.query.before).toBe(String(TAIL_BEFORE));
  });

  test("host board fetches only board-relevant states and flags truncation (#204 P1)", async () => {
    const now = Date.now();
    // 500 个 in_progress（命中每状态页上限），模拟大量活跃 task
    const bigInProgress = Array.from({ length: 500 }, (_, i) => ({
      type: "task", id: i + 1, channel: "dev", title: `t${i}`, desc: null,
      state: "in_progress", assignee: { name: "w", kind: "agent" },
      created_by: "w", created_by_kind: "agent", priority: 0, labels: [],
      parent_id: null, anchor_seqs: [], scope: ["web/src"], blocked_reason: null,
      completion_artifact: null, workflow_id: null, created_at: now, updated_at: now, completed_at: null,
    }));
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") return Response.json({ presence: [] });
      if (req.method === "GET" && req.path === "/api/channels/dev/tasks") {
        // 只有 in_progress 有数据；关键：无论 state 如何，done/backlog/triage 永不被查询
        return Response.json({ tasks: req.query.state === "in_progress" ? bigInProgress : [] });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") return Response.json({ messages: [] });
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["host", "board", "dev", "--json"]);
    expect(r.code).toBe(0);
    const frame = JSON.parse(r.stdout.trim()) as { tasks_truncated: string[] };
    // in_progress 命中 500 上限 → 显性标截断，而不是静默漏（门禁 P1）
    expect(frame.tasks_truncated).toContain("in_progress");
    // board 只按 4 个活跃状态拉；done/backlog/triage 绝不被查询 → 大量 done task 无法挤掉活跃 task
    const states = reqsOf(mock, "GET", "/api/channels/dev/tasks").map((req) => req.query.state).sort();
    expect(states).toEqual(["assigned", "blocked", "in_progress", "needs_review"]);
  });

  test("host board recommends human guard reset and takeover when only stale hosts remain", async () => {
    const now = Date.now();
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "host-old",
              state: "working",
              note: "manual host",
              ts: now - 120_000,
              last_seen: now - 120_000,
              role: "host",
              role_source: "self",
              residency: "human_driven",
              wake: { kind: "none" },
            },
          ],
        });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "status",
              seq: 20,
              sender: { name: "system", kind: "agent" },
              kind: "status",
              body: "loop guard",
              mentions: [],
              reply_to: null,
              state: "blocked",
              note: "loop guard tripped",
              status: {
                owner: "system",
                state: "blocked",
                scope: [],
                summary_seq: null,
                blocked_reason: "loop guard tripped: 200 consecutive agent messages",
                updated_at: 20_000,
              },
              ts: 20_000,
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["host", "board", "dev", "--json"]);
    expect(r.code).toBe(0);
    const frame = JSON.parse(r.stdout.trim()) as {
      hosts: Array<{ name: string; lease: string; stale_reason: string | null }>;
      recommended_actions: Array<{
        kind: string;
        target: string | null;
        command: string | null;
        requires_human: boolean;
      }>;
    };
    expect(frame.hosts).toEqual([
      expect.objectContaining({ name: "host-old", lease: "stale", stale_reason: "residency=human_driven" }),
    ]);
    expect(frame.recommended_actions).toEqual([
      expect.objectContaining({
        kind: "clear-loop-guard",
        target: null,
        command: "party channel reset-guard dev",
        requires_human: true,
      }),
      expect.objectContaining({
        kind: "takeover",
        target: "host-old",
        requires_human: false,
      }),
    ]);
    expect(frame.recommended_actions[1]!.command).toContain("--decision-kind takeover");
    expect(frame.recommended_actions[1]!.command).toContain("--takeover-from host-old");
  });

  test("host board does not recommend guard reset after a human message clears loop guard", async () => {
    const now = Date.now();
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "host-old",
              state: "working",
              note: "manual host",
              ts: now - 120_000,
              last_seen: now - 120_000,
              role: "host",
              role_source: "self",
              residency: "human_driven",
              wake: { kind: "none" },
            },
          ],
        });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "status",
              seq: 20,
              sender: { name: "system", kind: "agent" },
              kind: "status",
              body: "loop guard",
              mentions: [],
              reply_to: null,
              state: "blocked",
              note: "loop guard tripped",
              status: {
                owner: "system",
                state: "blocked",
                scope: [],
                summary_seq: null,
                blocked_reason: "loop guard tripped: 200 consecutive agent messages",
                updated_at: 20_000,
              },
              ts: 20_000,
            },
            {
              type: "msg",
              seq: 21,
              sender: { name: "leo", kind: "human" },
              kind: "message",
              body: "1",
              mentions: [],
              reply_to: null,
              state: null,
              note: null,
              status: null,
              ts: 21_000,
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["host", "board", "dev", "--json"]);
    expect(r.code).toBe(0);
    const frame = JSON.parse(r.stdout.trim()) as {
      blockers: Array<{ owner: string; blocked_reason: string | null }>;
      hosts: Array<{ name: string; lease: string; stale_reason: string | null }>;
      recommended_actions: Array<{
        kind: string;
        target: string | null;
        command: string | null;
        requires_human: boolean;
      }>;
    };
    // #204：blockers 现在从任务台账派生（此处无 tasks → 空）。loop-guard 是 system 消息，不再进 blockers 列表。
    expect(frame.blockers).toEqual([]);
    expect(frame.hosts).toEqual([
      expect.objectContaining({ name: "host-old", lease: "stale", stale_reason: "residency=human_driven" }),
    ]);
    expect(frame.recommended_actions).toEqual([
      expect.objectContaining({
        kind: "takeover",
        target: "host-old",
        requires_human: false,
      }),
    ]);
    // 人类消息已清 loop guard → 不建议 clear-loop-guard（loop-guard 检测仍走消息，不受 blockers 派生改动影响）。
    expect(frame.recommended_actions.some((action) => action.kind === "clear-loop-guard")).toBe(false);
  });

  test("host board can use live guard state when the local message window missed the clearing human frame", () => {
    const now = Date.now();
    const presence: PresenceEntry[] = [
      {
        name: "host-old",
        state: "working",
        note: "manual host",
        ts: now - 120_000,
        last_seen: now - 120_000,
        role: "host",
        role_source: "self",
        residency: "human_driven",
        wake: { kind: "none" },
      },
    ];
    const messages: MsgFrame[] = [
      {
        type: "status",
        seq: 20,
        sender: { name: "system", kind: "agent" },
        kind: "status",
        body: "loop guard",
        mentions: [],
        reply_to: null,
        state: "blocked",
        note: "loop guard tripped",
        status: {
          owner: "system",
          state: "blocked",
          scope: [],
          summary_seq: null,
          blocked_reason: "loop guard tripped: 200 consecutive agent messages",
          updated_at: 20_000,
        },
        ts: 20_000,
      },
      {
        type: "msg",
        seq: 30,
        sender: { name: "worker-a", kind: "agent" },
        kind: "message",
        body: "after guard was cleared elsewhere",
        mentions: [],
        reply_to: null,
        state: null,
        note: null,
        status: null,
        ts: 30_000,
      },
    ];

    // #204：blockers 现在从任务台账派生。这里无 tasks，故 board.blockers 为空；loop-guard 仅为 system 消息，
    // 不再出现在 blockers 列表里，但仍被 recommendHostActions 内部用于 loop-guard 检测（此处 loopGuardActive:false 抑制）。
    const board = buildHostBoard("dev", presence, messages, [], now, { loopGuardActive: false });

    expect(board.blockers).toEqual([]);
    expect(board.recommended_actions.map((action) => action.kind)).toEqual(["takeover"]);
  });

  test("host board detects overlapping task scopes for coordinator triage (#204)", async () => {
    const now = Date.now();
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "host-a",
              state: "working",
              note: "coordinating",
              ts: now - 1000,
              last_seen: now - 1000,
              role: "host",
              role_source: "assigned",
              residency: "supervised",
              wake: { kind: "serve", verified_at: now - 2000 },
            },
          ],
        });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/tasks") {
        // conflicts 用任务 scope 跑 overlap（不同 assignee + scope 重叠）：worker-a web/src 与 worker-b web/src/components 重叠。
        const base = {
          type: "task",
          channel: "dev",
          desc: null,
          created_by_kind: "agent",
          priority: 0,
          labels: [],
          parent_id: null,
          anchor_seqs: [],
          blocked_reason: null,
          completion_artifact: null,
          workflow_id: null,
          created_at: 30_000,
          updated_at: 30_000,
          completed_at: null,
        };
        return Response.json({
          tasks: [
            { ...base, id: 30, title: "web", state: "in_progress", assignee: { name: "worker-a", kind: "agent" }, created_by: "worker-a", scope: ["web/src"] },
            { ...base, id: 31, title: "components", state: "in_progress", assignee: { name: "worker-b", kind: "agent" }, created_by: "worker-b", scope: ["web/src/components"] },
            { ...base, id: 32, title: "cli", state: "in_progress", assignee: { name: "worker-c", kind: "agent" }, created_by: "worker-c", scope: ["cli/src"] },
          ],
        });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({ messages: [] });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["host", "board", "dev", "--json"]);
    expect(r.code).toBe(0);
    const frame = JSON.parse(r.stdout.trim()) as {
      conflicts: Array<{
        scope: string;
        owners: string[];
        claims: Array<{ seq: number; task_id: number | null; owner: string; state: string; scope: string[] }>;
      }>;
      recommended_actions: Array<{ kind: string; target: string | null; reason: string }>;
    };
    // #204：conflicts 由任务台账派生，每一侧都带 task_id，运维能直接看出冲突的是哪两个 task。
    expect(frame.conflicts).toEqual([
      {
        scope: "web/src",
        owners: ["worker-a", "worker-b"],
        claims: [
          { seq: 31, task_id: 31, owner: "worker-b", state: "working", scope: ["web/src/components"] },
          { seq: 30, task_id: 30, owner: "worker-a", state: "working", scope: ["web/src"] },
        ],
      },
    ]);
    expect(frame.recommended_actions).toEqual([
      expect.objectContaining({
        kind: "resolve-conflict",
        target: "worker-a",
        reason: expect.stringContaining("web/src"),
      }),
    ]);
  });

  test("history --completion asks server for completion artifacts only", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["history", "dev", "--completion", "--since", "5"]);
    expect(r.code).toBe(0);
    const req = reqsOf(mock, "GET", "/api/channels/dev/messages")[0]!;
    expect(req.query).toMatchObject({ since: "5", completion: "1" });
  });

  test("complete sends final synthesis artifact", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli([
      "complete",
      "final",
      "synthesis",
      "--channel",
      "dev",
      "--kickoff-seq",
      "3",
      "--replies",
      "0",
      "--timeout",
      "--issue",
      "5",
      "--pr",
      "8",
      "--task",
      "12",
      "--mention",
      "alice",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("completion seq=1");
    const req = reqsOf(mock!, "POST", "/api/channels/dev/messages")[0]!;
    // toMatchObject（非 toEqual）：body 还带一个随机 idempotency_key（#98）
    expect(req.body).toMatchObject({
      kind: "message",
      body: "final synthesis",
      mentions: ["alice"],
      reply_to: 3,
      completion_artifact: {
        kind: "final_synthesis",
        kickoff_seq: 3,
        replies_count: 0,
        timeout: true,
        related_issues: [5],
        related_prs: [8],
        task_id: 12,
      },
    });
    expect(typeof (req.body as { idempotency_key?: unknown }).idempotency_key).toBe("string");
  });

  test("complete sends --replaces for reworked completion", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["complete", "reworked", "--channel", "dev", "--kickoff-seq", "3", "--replaces", "7"]);
    expect(r.code).toBe(0);
    const req = reqsOf(mock!, "POST", "/api/channels/dev/messages")[0]!;
    expect(req.body).toMatchObject({
      kind: "message",
      body: "reworked",
      reply_to: 3,
      replaces: 7,
      completion_artifact: {
        kind: "final_synthesis",
        kickoff_seq: 3,
      },
    });
  });

  test("complete reports pending_review when server gates completion", async () => {
    mock = startRestMock((req) => {
      if (req.method === "POST" && req.path === "/api/channels/dev/messages") {
        return Response.json({ seq: 9, completion_review: { state: "pending_review", policy: "sender" } });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["complete", "final", "--channel", "dev", "--kickoff-seq", "3"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("completion seq=9 pending_review");
    expect(r.stdout).toContain("party review approve 9 --channel dev");
  });

  test("complete validates kickoff and replies locally", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const missing = await runCli(["complete", "done", "--channel", "dev"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--kickoff-seq is required");
    const badReplies = await runCli(["complete", "done", "--channel", "dev", "--kickoff-seq", "1", "--replies", "-1"]);
    expect(badReplies.code).toBe(1);
    expect(badReplies.stderr).toContain("--replies must be a non-negative integer");
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages")).toHaveLength(0);
  });

  test("history 整数范围本地校验", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    for (const args of [
      ["history", "dev", "--since", "1.9"],
      ["history", "dev", "--since", "-1"],
      ["history", "dev", "--limit", "0"],
      ["history", "dev", "--limit", "-1"],
      ["history", "dev", "--limit", "1.5"],
      ["history", "dev", "--limit", "1001"],
    ]) {
      const r = await runCli(args);
      expect(r.code).toBe(1);
    }
    expect(mock.requests.length).toBe(0);
  });

  test("history --channel 缺值不会回退到绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["history", "--channel", "--since", "5"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--channel requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("search renders server-side hits", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/search") {
        return Response.json({
          hits: [
            { type: "search_hit", channel: "dev", query: "deploy", seq: 4, sender: { name: "ci-bot", kind: "agent" }, kind: "status", match_field: "note", snippet: "deploy status", ts: 4 },
            { type: "search_hit", channel: "dev", query: "deploy", seq: 3, sender: { name: "deployer", kind: "agent" }, kind: "message", match_field: "sender", snippet: "deployer", ts: 3 },
            { type: "search_hit", channel: "dev", query: "deploy", seq: 1, sender: { name: "alice", kind: "agent" }, kind: "message", match_field: "body", snippet: "deploy the worker", ts: 1 },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["search", "deploy"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("alice");
    expect(r.stdout).toContain("deployer");
    expect(r.stdout).toContain("ci-bot");
    expect(r.stdout).toContain("[note]");
    expect(reqsOf(mock, "GET", "/api/channels/dev/search")[0]!.query).toMatchObject({
      q: "deploy",
      since: "0",
      limit: "100",
    });
  });

  test("search --channel --from --since and --limit forward server filters", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/ops/search") {
        return Response.json({ hits: [] });
      }
      return undefined;
    });
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["search", "needle", "--channel", "ops", "--from", "alice", "--since", "42", "--limit", "25"]);
    expect(r.code).toBe(0);
    const req = reqsOf(mock, "GET", "/api/channels/ops/search")[0]!;
    expect(req.query).toMatchObject({ q: "needle", from: "alice", since: "42", limit: "25" });

    const tooHigh = await runCli(["search", "needle", "--limit", "1001"]);
    expect(tooHigh.code).toBe(1);
    expect(tooHigh.stderr).toContain("--limit must be <= 1000");
  });

  test("search --json emits structured search hits; no match keeps stdout clean", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/search") {
        if (req.query.q === "nomatch") return Response.json({ hits: [] });
        return Response.json({
          hits: [
            { type: "search_hit", channel: "dev", query: "findme", seq: 5, sender: { name: "x", kind: "agent" }, kind: "message", match_field: "body", snippet: "findme here", ts: 5 },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const hit = await runCli(["search", "findme", "--json"]);
    expect(hit.code).toBe(0);
    expect(JSON.parse(hit.stdout.trim())).toMatchObject({ schema: "agentparty.v1", type: "search_hit", seq: 5, match_field: "body" });
    const miss = await runCli(["search", "nomatch", "--json"]);
    expect(miss.code).toBe(0);
    expect(miss.stdout.trim()).toBe("");
  });

  test("search requires a query", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["search"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("need a query");
  });

  test("edit retract and supersede call audited revision endpoints", async () => {
    const revised = {
      type: "msg",
      seq: 7,
      sender: { name: "agent", kind: "agent" },
      kind: "message",
      body: "corrected",
      mentions: [],
      reply_to: null,
      state: null,
      note: null,
      status: null,
      ts: 777,
      edited: true,
      edited_at: 778,
      edited_by: "agent",
      revision: { original_body: "wrong" },
    };
    const superseding = { ...revised, seq: 8, body: "replacement", edited: undefined, supersedes: 7 };
    mock = startRestMock((req) => {
      if (req.method === "POST" && req.path === "/api/channels/dev/messages/7/edit") {
        return Response.json({ message: revised });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/messages/7/retract") {
        return Response.json({ message: { ...revised, body: "", retracted: true } });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/messages/7/supersede") {
        return Response.json({ message: superseding, superseded: { ...revised, superseded_by: 8 } });
      }
      return undefined;
    });
    writeCfg(mock.url);
    writeWorkspaceState("dev");

    const edit = await runCli(["edit", "7", "corrected", "--json"]);
    expect(edit.code).toBe(0);
    expect(JSON.parse(edit.stdout.trim())).toMatchObject({ schema: "agentparty.v1", seq: 7, edited: true });
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages/7/edit")[0]!.body).toEqual({ body: "corrected" });

    const retract = await runCli(["retract", "7"]);
    expect(retract.code).toBe(0);
    expect(retract.stdout).toContain("retracted #7");
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages/7/retract")).toHaveLength(1);

    const supersede = await runCli(["supersede", "7", "replacement"]);
    expect(supersede.code).toBe(0);
    expect(supersede.stdout).toContain("superseded #7 with #8");
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages/7/supersede")[0]!.body).toEqual({ body: "replacement" });
  });

  test("edit validates seq and body locally", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");

    const badSeq = await runCli(["edit", "wat", "body"]);
    expect(badSeq.code).toBe(1);
    expect(badSeq.stderr).toContain("seq must be a positive integer");

    const missingBody = await runCli(["supersede", "7"]);
    expect(missingBody.code).toBe(1);
    expect(missingBody.stderr).toContain("body is required");
  });

  test("review approve/reject call gated completion endpoint", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");

    const approve = await runCli(["review", "approve", "7", "--json"]);
    expect(approve.code).toBe(0);
    expect(JSON.parse(approve.stdout.trim())).toMatchObject({
      schema: "agentparty.v1",
      seq: 7,
      completion_review: { state: "approved" },
    });
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages/7/review")[0]!.body).toEqual({ action: "approve" });

    const reject = await runCli(["review", "reject", "7", "-m", "needs tests", "--channel", "ops"]);
    expect(reject.code).toBe(0);
    expect(reject.stdout).toContain("review rejected #7");
    expect(reqsOf(mock, "POST", "/api/channels/ops/messages/7/review")[0]!.body).toEqual({
      action: "reject",
      reason: "needs tests",
    });
  });

  test("review validates action seq reason and channel locally", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    for (const args of [
      ["review", "maybe", "7"],
      ["review", "approve", "wat"],
      ["review", "reject", "7"],
      ["review", "approve", "7", "--channel", "Bad_Slug"],
    ]) {
      const r = await runCli(args);
      expect(r.code).toBe(1);
    }
    expect(mock.requests.length).toBe(0);
  });

  test("capture creates durable tags, lists them, and prints issue bodies", async () => {
    const capture = {
      type: "capture",
      channel: "dev",
      seq: 7,
      capture_kind: "requirement",
      note: "host requested it",
      created_by: "agent",
      created_by_kind: "agent",
      created_at: 777,
      message: {
        seq: 7,
        sender: { name: "host", kind: "human" },
        kind: "message",
        body: "Need persistent captures.",
        ts: 700,
      },
    };
    mock = startRestMock((req) => {
      if (req.method === "POST" && req.path === "/api/channels/dev/captures") {
        return Response.json(capture, { status: 201 });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/captures") {
        return Response.json({ captures: [capture] });
      }
      return undefined;
    });
    writeCfg(mock.url);
    writeWorkspaceState("dev");

    const created = await runCli(["capture", "7", "--as", "requirement", "-m", "host requested it"]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("captured #7 requirement host");
    expect(reqsOf(mock, "POST", "/api/channels/dev/captures")[0]!.body).toEqual({
      seq: 7,
      kind: "requirement",
      note: "host requested it",
    });

    const listed = await runCli(["capture", "list", "--as", "requirement", "--since", "3", "--limit", "10", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout.trim())).toMatchObject({
      schema: "agentparty.v1",
      type: "capture",
      seq: 7,
      capture_kind: "requirement",
    });
    expect(reqsOf(mock, "GET", "/api/channels/dev/captures")[0]!.query).toMatchObject({
      kind: "requirement",
      since: "3",
      limit: "10",
    });

    const issue = await runCli(["capture", "7", "--as", "requirement", "--issue-body"]);
    expect(issue.code).toBe(0);
    expect(issue.stdout).toContain("Generated by `party capture --issue-body`");
    expect(issue.stdout).toContain("Need persistent captures.");
  });

  test("capture validates seq and kind locally", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");

    const noKind = await runCli(["capture", "7"]);
    expect(noKind.code).toBe(1);
    expect(noKind.stderr).toContain("--as is required");

    const badSeq = await runCli(["capture", "wat", "--as", "bug"]);
    expect(badSeq.code).toBe(1);
    expect(badSeq.stderr).toContain("seq must be a positive integer");

    const badKind = await runCli(["capture", "7", "--as", "idea"]);
    expect(badKind.code).toBe(1);
    expect(badKind.stderr).toContain("--as must be decision");
  });

  test("digest --json separates mentioned inbox, wake delivery, and linked responses", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "status",
              seq: 11,
              sender: { name: "worker-a", kind: "agent" },
              kind: "status",
              body: "working on digest",
              mentions: [],
              reply_to: null,
              state: "working",
              note: "working on digest",
              status: {
                owner: "worker-a",
                state: "working",
                scope: ["cli/src/commands/digest.ts"],
                summary_seq: null,
                blocked_reason: null,
                updated_at: 111,
              },
              ts: 111,
            },
            {
              type: "msg",
              seq: 12,
              sender: { name: "host", kind: "agent" },
              kind: "message",
              body: "@agent please review",
              mentions: ["agent"],
              reply_to: null,
              state: null,
              note: null,
              status: null,
              ts: 112,
            },
            {
              type: "status",
              seq: 13,
              sender: { name: "agent", kind: "agent" },
              kind: "status",
              body: "review done",
              mentions: [],
              reply_to: null,
              state: "done",
              note: "review done",
              status: {
                owner: "agent",
                state: "done",
                scope: ["cli/src/commands/digest.ts"],
                summary_seq: 12,
                blocked_reason: null,
                updated_at: 113,
              },
              ts: 113,
            },
            {
              type: "msg",
              seq: 14,
              sender: { name: "host", kind: "agent" },
              kind: "message",
              body: "@agent unacked follow-up",
              mentions: ["agent"],
              reply_to: null,
              state: null,
              note: null,
              status: null,
              ts: 114,
            },
            {
              type: "msg",
              seq: 15,
              sender: { name: "agent", kind: "agent" },
              kind: "message",
              body: "unrelated note",
              mentions: [],
              reply_to: null,
              state: null,
              note: null,
              status: null,
              ts: 115,
            },
            {
              type: "msg",
              seq: 16,
              sender: { name: "host", kind: "agent" },
              kind: "message",
              body: "@agent please reply directly",
              mentions: ["agent"],
              reply_to: null,
              state: null,
              note: null,
              status: null,
              ts: 116,
            },
            {
              type: "msg",
              seq: 17,
              sender: { name: "agent", kind: "agent" },
              kind: "message",
              body: "direct ack",
              mentions: [],
              reply_to: 16,
              state: null,
              note: null,
              status: null,
              ts: 117,
            },
          ],
        });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/wake-deliveries") {
        return Response.json({
          deliveries: [
            {
              mention_seq: 14,
              target_name: "agent",
              webhook_name: "agent",
              adapter_kind: "webhook",
              attempt: 1,
              result: "failed",
              http_status: 503,
              error: "Service Unavailable",
              attempted_at: 116,
              ack_seq: null,
              resume_seq: null,
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["digest", "dev", "--since", "10", "--json"]);
    expect(r.code).toBe(0);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      schema: "agentparty.v1",
      type: "digest",
      channel: "dev",
      since: 10,
      last_seq: 17,
      viewer: "agent",
      counts: { messages: 7, statuses: 2, inbox_mentions: 1, responded_mentions: 2, wake_invoked: 1, resumed: 2 },
      wake_contract: {
        mentioned: "durable inbox item only",
        wake_invoked: "durable adapter delivery ledger",
        resumed: "requires linked fresh ack/status",
      },
    });
    expect(frame.statuses[0]).toMatchObject({
      seq: 11,
      owner: "worker-a",
      scope: ["cli/src/commands/digest.ts"],
    });
    expect(frame.inbox_mentions).toEqual([expect.objectContaining({ seq: 14, from: "host", wake_invoked: true })]);
    expect(frame.responded_mentions).toEqual([
      expect.objectContaining({ seq: 12, response_seq: 13, evidence: "status.summary_seq", wake_invoked: false }),
      expect.objectContaining({ seq: 16, response_seq: 17, evidence: "reply_to", wake_invoked: false }),
    ]);
    expect(frame.woken_mentions).toEqual([
      expect.objectContaining({ seq: 14, adapter: "webhook", attempt: 1, result: "failed", http_status: 503 }),
    ]);
    expect(reqsOf(mock, "GET", "/api/channels/dev/wake-deliveries")[0]!.query).toMatchObject({
      since: "11",
      target: "agent",
    });
  });

  test("digest --since last-seen uses the bound channel cursor", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev", 42);
    const r = await runCli(["digest", "dev", "--since", "last-seen", "--json"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "GET", "/api/channels/dev/messages")[0]!.path).toBe("/api/channels/dev/messages");
    const frame = JSON.parse(r.stdout.trim());
    expect(frame.since).toBe(42);
  });

  test("wake test reports human-driven wake=none as inbox-only and does not send", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "agent",
              state: "waiting",
              note: null,
              ts: 111,
              last_seen: 111,
              residency: "human_driven",
              wake: { kind: "none" },
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "test", "@agent", "dev", "--json"]);
    expect(r.code).toBe(2);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      schema: "agentparty.v1",
      type: "wake_test",
      channel: "dev",
      target: "agent",
      result: "not_auto_wakeable",
      presence: { residency: "human_driven", wake_kind: "none" },
      phases: {
        mention_delivered: { ok: false, seq: null },
        wake_invoked: { ok: false, adapter: "none" },
        agent_resumed: { ok: false, seq: null },
      },
    });
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages")).toHaveLength(0);
  });

  test("wake test sends to a serve adapter even when residency=bare (empirical, not refused)", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        const now = Date.now();
        return Response.json({
          presence: [
            {
              name: "agent",
              state: "waiting",
              note: null,
              ts: now,
              last_seen: now,
              residency: "bare",
              wake: { kind: "serve", verified_at: 100 },
            },
          ],
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/messages") {
        return Response.json({ seq: 20 });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "message",
              seq: 21,
              sender: { name: "agent", kind: "agent" },
              kind: "message",
              body: "on it",
              mentions: [],
              reply_to: 20,
              ts: 112,
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "test", "@agent", "dev", "--timeout", "1", "--json"]);
    // serve+bare is a running supervisor: the mention must go out and the linked reply proves health,
    // instead of being pre-emptively refused as not_auto_wakeable.
    expect(r.code).toBe(0);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      type: "wake_test",
      result: "healthy",
      presence: { residency: "bare", wake_kind: "serve" },
      phases: {
        mention_delivered: { ok: true, seq: 20 },
        agent_resumed: { ok: true, seq: 21, evidence: "reply_to" },
      },
    });
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages")).toHaveLength(1);
  });

  test("wake test refuses stale watch/serve adapters before sending", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "agent",
              state: "offline",
              note: null,
              ts: 111,
              last_seen: 111,
              residency: "supervised",
              wake: { kind: "watch", verified_at: 100 },
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "test", "@agent", "dev", "--timeout", "1", "--json"]);
    expect(r.code).toBe(2);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      type: "wake_test",
      result: "not_auto_wakeable",
      presence: { residency: "supervised", wake_kind: "watch", last_seen: 111 },
      phases: {
        mention_delivered: { ok: false, seq: null },
        wake_invoked: { ok: false, adapter: "watch" },
        agent_resumed: { ok: false, seq: null },
      },
    });
    expect(frame.reason).toContain("watch wake adapter is stale");
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages")).toHaveLength(0);
  });

  test("wake test sends to advertised wake adapter and accepts linked status summary as resume", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        const now = Date.now();
        return Response.json({
          presence: [
            {
              name: "agent",
              state: "waiting",
              note: null,
              ts: now,
              last_seen: now,
              residency: "supervised",
              wake: { kind: "serve", verified_at: 100 },
            },
          ],
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/messages") {
        return Response.json({ seq: 10 });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "status",
              seq: 11,
              sender: { name: "agent", kind: "agent" },
              kind: "status",
              body: "ack",
              mentions: [],
              reply_to: null,
              state: "done",
              note: "ack",
              status: {
                owner: "agent",
                state: "done",
                scope: [],
                summary_seq: 10,
                blocked_reason: null,
                updated_at: 112,
              },
              ts: 112,
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "test", "@agent", "dev", "--timeout", "1", "--json"]);
    expect(r.code).toBe(0);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      type: "wake_test",
      result: "healthy",
      phases: {
        mention_delivered: { ok: true, seq: 10 },
        wake_invoked: { ok: null, adapter: "serve" },
        agent_resumed: { ok: true, seq: 11, evidence: "status.summary_seq" },
      },
    });
    expect(reqsOf(mock, "POST", "/api/channels/dev/messages")[0]!.body).toMatchObject({
      kind: "message",
      mentions: ["agent"],
      reply_to: null,
    });
  });

  test("wake test reports audited webhook delivery without treating it as resume", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "agent",
              state: "waiting",
              note: null,
              ts: 111,
              last_seen: 111,
              residency: "webhook",
              wake: { kind: "webhook", verified_at: 100 },
            },
          ],
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/messages") {
        return Response.json({ seq: 30 });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/wake-deliveries") {
        return Response.json({
          deliveries: [
            {
              mention_seq: 30,
              target_name: "agent",
              webhook_name: "agent",
              adapter_kind: "webhook",
              attempt: 1,
              result: "ok",
              http_status: 202,
              error: null,
              attempted_at: 112,
              ack_seq: null,
              resume_seq: null,
            },
          ],
        });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({ messages: [] });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "test", "@agent", "dev", "--timeout", "1", "--json"]);
    expect(r.code).toBe(2);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      type: "wake_test",
      result: "timeout",
      phases: {
        mention_delivered: { ok: true, seq: 30 },
        wake_invoked: { ok: true, adapter: "webhook" },
        agent_resumed: { ok: false, seq: null },
      },
    });
    expect(frame.phases.wake_invoked.evidence).toContain("status=202");
    expect(reqsOf(mock, "GET", "/api/channels/dev/wake-deliveries")[0]!.query).toMatchObject({
      since: "30",
      target: "agent",
    });
  });

  test("wake test accepts durable ledger resume evidence", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "agent",
              state: "waiting",
              note: null,
              ts: 111,
              last_seen: 111,
              residency: "webhook",
              wake: { kind: "webhook", verified_at: 100 },
            },
          ],
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/messages") {
        return Response.json({ seq: 40 });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/wake-deliveries") {
        return Response.json({
          deliveries: [
            {
              mention_seq: 40,
              target_name: "agent",
              webhook_name: "agent",
              adapter_kind: "webhook",
              attempt: 1,
              result: "ok",
              http_status: 202,
              error: null,
              attempted_at: 112,
              ack_seq: null,
              resume_seq: 41,
            },
          ],
        });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({ messages: [] });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "test", "@agent", "dev", "--timeout", "1", "--json"]);
    expect(r.code).toBe(0);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      type: "wake_test",
      result: "healthy",
      phases: {
        mention_delivered: { ok: true, seq: 40 },
        wake_invoked: { ok: true, adapter: "webhook" },
        agent_resumed: { ok: true, seq: 41, evidence: "status.summary_seq" },
      },
    });
  });

  test("wake test timeout keeps mention delivery separate from resume", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "agent",
              state: "waiting",
              note: null,
              ts: 111,
              last_seen: 111,
              residency: "webhook",
              wake: { kind: "webhook", verified_at: 100 },
            },
          ],
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/messages") {
        return Response.json({ seq: 20 });
      }
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({ messages: [] });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "test", "@agent", "dev", "--timeout", "1", "--json"]);
    expect(r.code).toBe(2);
    const frame = JSON.parse(r.stdout.trim());
    expect(frame).toMatchObject({
      type: "wake_test",
      result: "timeout",
      phases: {
        mention_delivered: { ok: true, seq: 20 },
        wake_invoked: { ok: null, adapter: "webhook" },
        agent_resumed: { ok: false, seq: null },
      },
    });
  });
});

describe("rest error mapping", () => {
  test("403 unauthorized is permission denial, not bad-token exit 3", () => {
    const prev = console.error;
    const errs: string[] = [];
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
    try {
      expect(handleRestError(new RestError(403, "unauthorized", "readonly token cannot send"))).toBe(1);
      expect(handleRestError(new RestError(401, "unauthorized", "invalid token"))).toBe(3);
      const stderr = errs.join("\n");
      expect(stderr).toContain("当前 party v");
      expect(stderr).toContain("install.sh | sh");
    } finally {
      console.error = prev;
    }
  });
});

describe("party webhook", () => {
  test("add → list → remove 全流程", async () => {
    mock = startRestMock();
    writeCfg(mock.url);

    const add = await runCli([
      "webhook",
      "add",
      "dev",
      "--name",
      "hermes",
      "--url",
      "https://hooks.example/x",
      "--secret",
      "whs",
    ]);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("webhook hermes added to dev (filter: mentions) [mode: notify]");
    const addReq = reqsOf(mock, "POST", "/api/channels/dev/webhooks")[0]!;
    expect(addReq.body).toEqual({
      name: "hermes",
      url: "https://hooks.example/x",
      secret: "whs",
      filter: "mentions",
      mode: "notify",
    });
    expect(addReq.headers.authorization).toBe("Bearer ap_tok");

    const list = await runCli(["webhook", "list", "dev"]);
    expect(list.code).toBe(0);
    expect(list.stdout.trim()).toBe("hermes\tmentions\thttps://hooks.example/x\tnotify");

    const rm = await runCli(["webhook", "remove", "dev", "--name", "hermes"]);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain("webhook hermes removed from dev");

    const list2 = await runCli(["webhook", "list", "dev"]);
    expect(list2.stdout.trim()).toBe("");
  });

  test.each(["status", "needs-human", "all"] as const)("add --filter %s", async (filter) => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli([
      "webhook",
      "add",
      "dev",
      "--name",
      "h",
      "--url",
      "https://x",
      "--secret",
      "s",
      "--filter",
      filter,
    ]);
    expect(r.code).toBe(0);
    expect((reqsOf(mock, "POST", "/api/channels/dev/webhooks")[0]!.body as { filter: string }).filter).toBe(filter);
  });

  test("add --mode agent 发送模式且 list 显示模式", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const add = await runCli([
      "webhook",
      "add",
      "dev",
      "--name",
      "hermes",
      "--url",
      "https://hooks.example/x",
      "--secret",
      "whs",
      "--mode",
      "agent",
    ]);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("[mode: agent]");
    expect((reqsOf(mock, "POST", "/api/channels/dev/webhooks")[0]!.body as { mode: string }).mode).toBe("agent");

    const list = await runCli(["webhook", "list", "dev"]);
    expect(list.stdout.trim()).toBe("hermes\tmentions\thttps://hooks.example/x\tagent");
  });

  test("非法 mode 退出 1", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli([
      "webhook",
      "add",
      "dev",
      "--name",
      "h",
      "--url",
      "https://x",
      "--secret",
      "s",
      "--mode",
      "claim-everything",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party webhook add");
    expect(mock.requests.length).toBe(0);
  });

  test("help 区分 notify 与 agent 的 claim 语义", async () => {
    const r = await runCli(["webhook", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("default --mode notify");
    expect(r.stdout).toContain("never claims directed");
    expect(r.stdout).toContain("--mode agent");
  });

  test("非法 filter 退出 1", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli([
      "webhook",
      "add",
      "dev",
      "--name",
      "h",
      "--url",
      "https://x",
      "--secret",
      "s",
      "--filter",
      "bogus",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party webhook add");
    expect(mock.requests.length).toBe(0);
  });

  test("缺必填参数退出 1", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["webhook", "add", "dev", "--name", "h"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party webhook add");
  });

  test("webhook name 与 worker 协议保持一致", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    for (const name of [":bad", ".bad", "bad:name"]) {
      const r = await runCli([
        "webhook",
        "add",
        "dev",
        "--name",
        name,
        "--url",
        "https://hooks.example/x",
        "--secret",
        "s",
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("usage: party webhook add");
    }
    expect(mock.requests.length).toBe(0);
  });

  test("webhook 本地拒绝非法 channel 和 remove name", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const list = await runCli(["webhook", "list", "Bad_Slug"]);
    expect(list.code).toBe(1);
    expect(list.stderr).toContain("channel must match");

    const add = await runCli([
      "webhook",
      "add",
      "Bad_Slug",
      "--name",
      "hermes",
      "--url",
      "https://hooks.example/x",
      "--secret",
      "s",
    ]);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain("channel must match");

    const remove = await runCli(["webhook", "remove", "dev", "--name", ":bad"]);
    expect(remove.code).toBe(1);
    expect(remove.stderr).toContain("usage: party webhook remove");
    expect(mock.requests.length).toBe(0);
  });

  test("webhook value flags 缺值退出 1", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["webhook", "add", "dev", "--name", "h", "--url"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--url requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("必须显式传 channel，不回退到 workspace 绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("dev");
    const r = await runCli(["webhook", "list"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party webhook");
    expect(mock.requests.length).toBe(0);
  });

  test("本地拒绝不安全 webhook URL", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    for (const url of [
      "http://hooks.example/x",
      "https://localhost/x",
      "https://localhost./x",
      "https://foo.localhost./x",
      "https://127.0.0.1/x",
      "https://10.0.0.1/x",
      "https://0300.0250.0001.0001/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://[fc00::1]/x",
      "https://[fe80::1]/x",
      "https://[fe81::1]/x",
      "https://[febf::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[::ffff:169.254.169.254]/x",
      "https://user:pass@hooks.example/x",
      "not-a-url",
    ]) {
      const r = await runCli([
        "webhook",
        "add",
        "dev",
        "--name",
        "h",
        "--url",
        url,
        "--secret",
        "s",
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("usage: party webhook add");
    }
    expect(mock.requests.length).toBe(0);
  });

  test("本地拒绝不能安全放入 Authorization header 的 secret", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    for (const secret of ["has space", "line\nbreak", "line\rbreak"]) {
      const r = await runCli([
        "webhook",
        "add",
        "dev",
        "--name",
        "h",
        "--url",
        "https://hooks.example/x",
        "--secret",
        secret,
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("usage: party webhook add");
    }
    expect(mock.requests.length).toBe(0);
  });

  test("无 config 退出 1", async () => {
    const r = await runCli(["webhook", "list", "dev"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no config");
  });
});

describe("party channel create mode", () => {
  test("--party 发送 mode=party", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "create", "war-room", "--party", "--title", "作战室"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels")[0]!.body).toEqual({
      slug: "war-room",
      title: "作战室",
      kind: "standing",
      mode: "party",
      visibility: "private",
    });
  });

  test("默认 mode=normal，visibility=private", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "create", "dev"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels")[0]!.body).toEqual({
      slug: "dev",
      kind: "standing",
      mode: "normal",
      visibility: "private",
    });
  });

  test("--public 发送 visibility=public", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "create", "town-square", "--public"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels")[0]!.body).toEqual({
      slug: "town-square",
      kind: "standing",
      mode: "normal",
      visibility: "public",
    });
  });

  test("--title 缺值退出 1 且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "create", "dev", "--title"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--title requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("非法 slug 本地拒绝且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "create", "Bad_Slug"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("slug must match");
    expect(mock.requests.length).toBe(0);
  });
});

describe("party channel kick", () => {
  test("kick <name> <slug> 调 POST /kick，body 带 name", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "kick", "troll", "town-square"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("kicked troll from town-square");
    const kickReqs = reqsOf(mock, "POST", "/api/channels/town-square/kick");
    expect(kickReqs.length).toBe(1);
    expect(kickReqs[0]!.body).toEqual({ name: "troll" });
    expect(kickReqs[0]!.headers.authorization).toBe("Bearer ap_tok");
  });

  test("省略 slug 时用绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("ops");
    const r = await runCli(["channel", "kick", "troll"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels/ops/kick").length).toBe(1);
  });

  test("--remove 调 remove 语义", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "kick", "troll", "town-square", "--remove"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("removed troll from town-square");
    const kickReqs = reqsOf(mock, "POST", "/api/channels/town-square/kick");
    expect(kickReqs.length).toBe(1);
    expect(kickReqs[0]!.body).toEqual({ name: "troll", mode: "remove" });
  });

  test("缺 name 退出 1 且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "kick"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party channel kick");
    expect(mock.requests.length).toBe(0);
  });

  test("非法 name 本地拒绝且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "kick", ":bad", "town-square"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("name must match");
    expect(mock.requests.length).toBe(0);
  });
});

describe("party channel reset-guard", () => {
  test("reset-guard <slug> 调 POST /reset-guard", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "reset-guard", "town-square"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("guard reset town-square");
    const reqs = reqsOf(mock, "POST", "/api/channels/town-square/reset-guard");
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.headers.authorization).toBe("Bearer ap_tok");
  });

  test("省略 slug 时用绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("ops");
    const r = await runCli(["channel", "reset-guard"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels/ops/reset-guard").length).toBe(1);
  });
});

describe("party channel reset-workflow-guard", () => {
  test("reset-workflow-guard <wid> <slug> 调 POST /workflows/<wid>/reset-guard", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "reset-workflow-guard", "wf-b", "town-square"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("workflow guard reset town-square: wf-b");
    const reqs = reqsOf(mock, "POST", "/api/channels/town-square/workflows/wf-b/reset-guard");
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.headers.authorization).toBe("Bearer ap_tok");
    // 没打到 loop guard 的 reset-guard 端点（两者是不同的熔断器）
    expect(reqsOf(mock, "POST", "/api/channels/town-square/reset-guard").length).toBe(0);
  });

  test("省略 slug 时用绑定频道", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("ops");
    const r = await runCli(["channel", "reset-workflow-guard", "wf-x"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels/ops/workflows/wf-x/reset-guard").length).toBe(1);
  });

  test("缺 workflow_id 报用法且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("ops");
    const r = await runCli(["channel", "reset-workflow-guard"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party channel reset-workflow-guard <workflow_id> [slug]");
    expect(mock.requests.length).toBe(0);
  });

  test("非法 workflow_id 本地拒绝，不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "reset-workflow-guard", "bad id", "ops"]);
    expect(r.code).toBe(1);
    expect(mock.requests.length).toBe(0);
  });
});

describe("party channel gate", () => {
  test("gate reviewer 调 PUT /completion-gate，可带 policy", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "gate", "reviewer", "ops", "--policy", "owner"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("completion gate ops: reviewer policy=owner");
    const reqs = reqsOf(mock, "PUT", "/api/channels/ops/completion-gate");
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.body).toEqual({ gate: "reviewer", policy: "owner" });
    expect(reqs[0]!.headers.authorization).toBe("Bearer ap_tok");
  });

  test("gate off 可使用绑定频道并省略 policy", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("ops");
    const r = await runCli(["channel", "gate", "off"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("completion gate ops: off policy=sender");
    expect(reqsOf(mock, "PUT", "/api/channels/ops/completion-gate")[0]!.body).toEqual({ gate: "off" });
  });

  test("gate 本地校验 gate policy 和 slug", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    for (const args of [
      ["channel", "gate", "quorum", "ops"],
      ["channel", "gate", "reviewer", "ops", "--policy", "assigned_reviewer"],
      ["channel", "gate", "reviewer", "Bad_Slug"],
    ]) {
      const r = await runCli(args);
      expect(r.code).toBe(1);
    }
    expect(mock.requests.length).toBe(0);
  });
});

describe("party channel guard config", () => {
  test("loop guard unlimited/limit 调 PUT /loop-guard", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("ops");

    const off = await runCli(["channel", "guard", "unlimited"]);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("loop guard ops: unlimited");
    expect(reqsOf(mock, "PUT", "/api/channels/ops/loop-guard")[0]!.body).toEqual({ enabled: false });

    const limited = await runCli(["channel", "guard", "80", "ops"]);
    expect(limited.code).toBe(0);
    expect(limited.stdout).toContain("loop guard ops: 80 messages");
    expect(reqsOf(mock, "PUT", "/api/channels/ops/loop-guard")[1]!.body).toEqual({ enabled: true, limit: 80 });
  });

  test("workflow guard off/limit 调 PUT /workflow-guard", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const off = await runCli(["channel", "workflow-guard", "off", "ops"]);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("workflow guard ops: off");
    expect(reqsOf(mock, "PUT", "/api/channels/ops/workflow-guard")[0]!.body).toEqual({ enabled: false });

    const r = await runCli(["channel", "workflow-guard", "12", "ops"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("workflow guard ops: 12 messages");
    expect(reqsOf(mock, "PUT", "/api/channels/ops/workflow-guard")[1]!.body).toEqual({ enabled: true, limit: 12 });
  });

  test("guard 本地校验 limit 和 slug", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    for (const args of [
      ["channel", "guard", "zero", "ops"],
      ["channel", "guard", "10", "Bad_Slug"],
      ["channel", "workflow-guard", "0", "ops"],
    ]) {
      const r = await runCli(args);
      expect(r.code).toBe(1);
    }
  });
});

describe("party channel perms", () => {
  test("prints current channel permissions as json", async () => {
    mock = startRestMock();
    writeCfg(mock.url);

    const r = await runCli(["channel", "perms", "ops", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      channel_slug: "ops",
      permissions: {
        charter_write: "moderators",
        charter_write_agents: "moderators",
        members_list: "members",
        members_list_agents: "members",
      },
    });
    expect(reqsOf(mock, "GET", "/api/channels/ops/perms")).toHaveLength(1);
  });

  test("updates charter and member-list policies with separate agent allowlists", async () => {
    mock = startRestMock();
    writeCfg(mock.url);

    const r = await runCli([
      "channel",
      "perms",
      "ops",
      "--charter-write",
      "members",
      "--charter-write-agents",
      "allowlist",
      "--agent",
      "leo-codex",
      "--agent",
      "qa.bot",
      "--members-list",
      "moderators",
      "--members-list-agents",
      "allowlist",
      "--members-agent",
      "auditor",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("charter_write\tmembers");
    expect(reqsOf(mock, "PUT", "/api/channels/ops/perms")[0]!.body).toEqual({
      charter_write: "members",
      charter_write_agents: "allowlist",
      charter_write_agent_allowlist: ["leo-codex", "qa.bot"],
      members_list: "moderators",
      members_list_agents: "allowlist",
      members_list_agent_allowlist: ["auditor"],
    });
  });

  test("validates policies and allowlist names locally", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    for (const args of [
      ["channel", "perms", "ops", "--charter-write", "off"],
      ["channel", "perms", "ops", "--charter-write-agents", "owners"],
      ["channel", "perms", "ops", "--members-list", "public"],
      ["channel", "perms", "ops", "--agent", ":bad"],
    ]) {
      const r = await runCli(args);
      expect(r.code).toBe(1);
    }
    expect(mock.requests.length).toBe(0);
  });
});


describe("party channel role", () => {
  test("role set/list/unset 调用频道角色 API", async () => {
    mock = startRestMock();
    writeCfg(mock.url);

    const set = await runCli(["channel", "role", "set", "alice", "host", "ops", "--responsibility", "own handoff"]);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("assigned alice as host in ops");
    const setReqs = reqsOf(mock, "PUT", "/api/channels/ops/roles/alice");
    expect(setReqs.length).toBe(1);
    expect(setReqs[0]!.body).toEqual({ role: "host", responsibility: "own handoff" });
    expect(setReqs[0]!.headers.authorization).toBe("Bearer ap_tok");

    const list = await runCli(["channel", "role", "list", "ops"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("alice\thost\towner\t1970-01-01T00:00:00.123Z");
    expect(list.stdout).toContain("\town handoff");

    const unset = await runCli(["channel", "role", "unset", "alice", "ops"]);
    expect(unset.code).toBe(0);
    expect(unset.stdout).toContain("cleared role for alice in ops");
    expect(reqsOf(mock, "DELETE", "/api/channels/ops/roles/alice").length).toBe(1);
  });

  test("role set validates role and can use bound channel", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    writeWorkspaceState("ops");

    const bad = await runCli(["channel", "role", "set", "alice", "captain"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("role must be host");
    expect(mock.requests.length).toBe(0);

    const ok = await runCli(["channel", "role", "set", "alice", "reviewer"]);
    expect(ok.code).toBe(0);
    expect(reqsOf(mock, "PUT", "/api/channels/ops/roles/alice").length).toBe(1);
  });
});

describe("party invite --public", () => {
  test("--public 建 public 频道并在接入包标注", async () => {
    mock = startRestMock();
    const r = await runCli(["invite", "Town Square", "--public", "--server", mock.url], {
      ADMIN_SECRET: "s3cret",
    });
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels")[0]!.body).toEqual({
      slug: "town-square",
      title: "Town Square",
      kind: "standing",
      mode: "normal",
      visibility: "public",
    });
    expect(r.stdout).toContain("· public");
  });
});

describe("party token", () => {
  test("value flags 缺值退出 1 且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["token", "create", "--name", "--role", "agent"], {
      ADMIN_SECRET: "s",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--name requires a value");
    expect(mock.requests.length).toBe(0);
  });

  test("非法 token name 本地拒绝且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["token", "create", "--name", ":bad", "--role", "agent"], {
      ADMIN_SECRET: "s",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("name must match");
    expect(mock.requests.length).toBe(0);
  });

  test("--owner 透传进请求体", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const withOwner = await runCli(
      ["token", "create", "--name", "bot", "--role", "agent", "--owner", "leo@leeguoo.com"],
      { ADMIN_SECRET: "s" },
    );
    expect(withOwner.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/tokens")[0]!.body).toEqual({
      name: "bot",
      role: "agent",
      owner: "leo@leeguoo.com",
    });
  });

  test("--owner 必填：缺 owner 本地早退不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["token", "create", "--name", "bot2", "--role", "agent"], {
      ADMIN_SECRET: "s",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--owner required");
    expect(mock.requests.length).toBe(0);
  });

  test("--channel-scope 透传进请求体（channel_scope 字段）", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(
      [
        "token",
        "create",
        "--name",
        "bot",
        "--role",
        "agent",
        "--owner",
        "leo@leeguoo.com",
        "--channel-scope",
        "demo",
      ],
      { ADMIN_SECRET: "s" },
    );
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/tokens")[0]!.body).toEqual({
      name: "bot",
      role: "agent",
      owner: "leo@leeguoo.com",
      channel_scope: "demo",
    });
  });

  test("非法 --channel-scope 本地拒绝且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(
      [
        "token",
        "create",
        "--name",
        "bot",
        "--role",
        "agent",
        "--owner",
        "leo@leeguoo.com",
        "--channel-scope",
        "Bad_Slug",
      ],
      { ADMIN_SECRET: "s" },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--channel-scope must match");
    expect(mock.requests.length).toBe(0);
  });

  test("非法 owner（非 ASCII）本地拒绝且不发请求", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(
      ["token", "create", "--name", "bot", "--role", "agent", "--owner", "老板"],
      { ADMIN_SECRET: "s" },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--owner must be printable ascii");
    expect(mock.requests.length).toBe(0);
  });
});
