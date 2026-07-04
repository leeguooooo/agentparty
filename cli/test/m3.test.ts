// M3：invite 接入包 / webhook 子命令 / channel create --party
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceId } from "../src/config";
import { handleRestError, RestError } from "../src/rest";
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
    expect(r.stdout).toContain("party watch fix-login-bug --follow");
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
    ]);
    expect(r.code).toBe(0);
    const req = reqsOf(mock, "POST", "/api/channels/ops/messages")[0]!;
    expect(req.body).toMatchObject({
      kind: "status",
      state: "working",
      note: "checking",
      mentions: ["dispatcher"],
    });
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
    expect(add.stdout).toContain("webhook hermes added to dev (filter: mentions)");
    const addReq = reqsOf(mock, "POST", "/api/channels/dev/webhooks")[0]!;
    expect(addReq.body).toEqual({
      name: "hermes",
      url: "https://hooks.example/x",
      secret: "whs",
      filter: "mentions",
    });
    expect(addReq.headers.authorization).toBe("Bearer ap_tok");

    const list = await runCli(["webhook", "list", "dev"]);
    expect(list.code).toBe(0);
    expect(list.stdout.trim()).toBe("hermes\tmentions\thttps://hooks.example/x");

    const rm = await runCli(["webhook", "remove", "dev", "--name", "hermes"]);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain("webhook hermes removed from dev");

    const list2 = await runCli(["webhook", "list", "dev"]);
    expect(list2.stdout.trim()).toBe("");
  });

  test("add --filter all", async () => {
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
      "all",
    ]);
    expect(r.code).toBe(0);
    expect((reqsOf(mock, "POST", "/api/channels/dev/webhooks")[0]!.body as { filter: string }).filter).toBe("all");
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
