// 命令层：send/agent add/whoami/logout 在账号会话下的行为
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAccount } from "../src/account";
import { tokenFingerprint, writeConfig, writeState } from "../src/config";
import { run as sendRun } from "../src/commands/send";
import { run as agentRun } from "../src/commands/agent";
import { run as spawnRun } from "../src/commands/spawn";
import { run as whoamiRun } from "../src/commands/whoami";
import { run as statuslineRun } from "../src/commands/statusline";
import { run as logoutRun } from "../src/commands/logout";
import { run as channelRun } from "../src/commands/channel";
import { writeStatuslineCache } from "../src/statusline-cache";
import { startRestMock, type RestMock } from "./rest-mock";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
let restMock: RestMock | null = null;
const nowSec = () => Math.floor(Date.now() / 1000);

// 捕获 console.log / console.error
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-acctcmd-"));
  process.env.AGENTPARTY_HOME = home;
  logs = [];
  errs = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.AGENTPARTY_HOME;
  rmSync(home, { recursive: true, force: true });
  restMock?.stop();
  restMock = null;
  mock?.stop();
  mock = null;
});

function liveAccount(server: string) {
  writeAccount({
    server,
    refresh_token: "ref",
    access_token: "acc-live",
    expires_at: nowSec() + 3600,
  });
}

describe("send auth precedence", () => {
  test("config ap_ token wins over a live account session (workspace/agent identity)", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_agent_wins" });
    liveAccount(mock.url);
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["hello", "--channel", "dev"]);
    expect(code).toBe(0);
    const msgReq = mock.requests.find((r) => r.path === "/api/channels/dev/messages");
    // init 写的 workspace token 优先——agent 以自己的身份发言，不被残留账号会话顶替
    expect(msgReq?.auth).toBe("Bearer ap_agent_wins");
    // 账号会话未被触碰，不刷新
    expect(mock.tokenCalls).toHaveLength(0);
  });

  test("uses account access_token when no workspace token is bound", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["yo", "--channel", "dev"]);
    expect(code).toBe(0);
    const msgReq = mock.requests.find((r) => r.path === "/api/channels/dev/messages");
    expect(msgReq?.auth).toBe("Bearer acc-live");
  });

  test("falls back to config ap_ token when logged out", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_fallback" });
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["hi", "--channel", "dev"]);
    expect(code).toBe(0);
    const msgReq = mock.requests.find((r) => r.path === "/api/channels/dev/messages");
    expect(msgReq?.auth).toBe("Bearer ap_fallback");
  });

  test("warns on the send-to-channel footgun but still sends to the bound channel", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_x" });
    writeState({ channel: "dev", cursor: 0 });

    // 想发到 ops，误用 `send ops "..."`：ops 被并进正文，实际发到绑定的 dev
    const code = await sendRun(["ops", "deploy done"]);
    expect(code).toBe(0);
    expect(errs.join("\n")).toContain("若想发到「ops」");
    expect(mock.requests.some((r) => r.path === "/api/channels/dev/messages")).toBe(true);
  });

  test("no footgun warning for a normal quoted message", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_x" });
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["hello everyone"]);
    expect(code).toBe(0);
    expect(errs.join("\n")).not.toContain("若想发到");
  });

  test("debug-auth prints safe runtime/config source without raw token", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_debug_secret" });
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["hello", "--channel", "dev", "--debug-auth"]);
    expect(code).toBe(0);
    const stderr = errs.join("\n");
    expect(stderr).toContain("using runtime=fan@example.com (human/human)");
    expect(stderr).toContain("auth-source=runtime_config");
    expect(stderr).toContain(`token=${tokenFingerprint("ap_debug_secret")}`);
    expect(stderr).not.toContain("ap_debug_secret");
  });
});

describe("agent add", () => {
  test("requires login", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_x" });
    const code = await agentRun(["add", "botty"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("agent add requires a human login");
    expect(mock.requests.find((r) => r.path === "/api/agents")).toBeUndefined();
  });

  test("explains account capability failures separately from runtime token auth", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/agents")) {
        return Response.json({ error: { code: "forbidden", message: "forbidden" } }, { status: 403 });
      }
      return origFetch(input, init);
    }) as typeof fetch;
    try {
      liveAccount(mock.url);
      const code = await agentRun(["add", "botty"]);
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain("current account cannot mint agents");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("stale account refresh failure tells operator to login again", async () => {
    mock = startOidcMock({ tokenResponse: () => ({ token_type: "Bearer" }) });
    writeAccount({
      server: mock.url,
      refresh_token: "ref-expired",
      access_token: "acc-expired",
      expires_at: nowSec() - 10,
    });

    const code = await agentRun(["add", "botty"]);
    expect(code).toBe(1);
    const stderr = errs.join("\n");
    expect(stderr).toContain("stored account session is expired or invalid");
    expect(stderr).toContain("party login");
    expect(stderr).not.toContain("token endpoint returned no access_token");
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.requests.find((r) => r.path === "/api/agents")).toBeUndefined();
  });

  test("mints agent via /api/agents with account bearer + channel_scope", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await agentRun(["add", "botty", "--channel-scope", "ops"]);
    expect(code).toBe(0);
    const req = mock.requests.find((r) => r.path === "/api/agents");
    expect(req?.method).toBe("POST");
    expect(req?.auth).toBe("Bearer acc-live");
    expect(req?.body).toEqual({ name: "botty", channel_scope: "ops" });
    // 明文 token 打印一次
    expect(logs.join("\n")).toContain("ap_botty_secret");
  });

  test("rejects invalid channel-scope before any request", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await agentRun(["add", "botty", "--channel-scope", "BAD_SLUG"]);
    expect(code).toBe(1);
    expect(mock.requests.find((r) => r.path === "/api/agents")).toBeUndefined();
  });

  test("creates a reusable project-agent profile with account bearer", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await agentRun([
      "create",
      "herness-dev",
      "--runner",
      "codex-sdk",
      "--repo",
      "git@github.com:leeguooooo/herness-use.git",
      "--workdir",
      "/Users/leo/github.com/herness-use",
      "--base-branch",
      "main",
      "--worktree",
      "branch",
      "--rules",
      "Report readiness.",
      "--invitable-by",
      "anyone",
    ]);
    expect(code).toBe(0);
    const req = mock.requests.find((r) => r.path === "/api/agent-profiles" && r.method === "POST");
    expect(req?.auth).toBe("Bearer acc-live");
    expect(req?.body).toEqual({
      handle: "herness-dev",
      runner: "codex-sdk",
      repo_url: "git@github.com:leeguooooo/herness-use.git",
      workdir: "/Users/leo/github.com/herness-use",
      base_branch: "main",
      worktree_strategy: "branch",
      rules: "Report readiness.",
      invitable_by: "anyone",
    });
    expect(logs.join("\n")).toContain("fan@example.com/herness-dev");
  });

  test("lists project-agent profiles", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    expect(await agentRun(["create", "builder", "--runner", "codex"])).toBe(0);
    logs = [];
    const code = await agentRun(["list"]);
    expect(code).toBe(0);
    expect(mock.requests.some((r) => r.path === "/api/agent-profiles" && r.method === "GET")).toBe(true);
    expect(logs.join("\n")).toContain("fan@example.com/builder");
  });

  test("rejects invalid project-agent profile flags before any request", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    expect(await agentRun(["create", "builder", "--runner", "bad"])).toBe(1);
    expect(await agentRun(["create", "builder", "--runner", "codex", "--worktree", "bad"])).toBe(1);
    expect(await agentRun(["create", "builder", "--runner", "codex", "--invitable-by", "bad"])).toBe(1);
    expect(mock.requests.find((r) => r.path === "/api/agent-profiles")).toBeUndefined();
  });
});

describe("channel invite-agent", () => {
  test("invites a reusable project-agent profile to the resolved channel", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_runtime" });
    writeState({ channel: "ops", cursor: 0 });

    const code = await channelRun(["invite-agent", "fan@example.com/herness-dev"]);
    expect(code).toBe(0);
    const req = mock.requests.find((r) => r.path === "/api/channels/ops/project-agents");
    expect(req?.method).toBe("POST");
    expect(req?.auth).toBe("Bearer ap_runtime");
    expect(req?.body).toEqual({ owner_account: "fan@example.com", handle: "herness-dev" });
    expect(logs.join("\n")).toContain("invited fan@example.com/herness-dev to ops");
  });

  test("rejects malformed profile refs before any request", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_runtime" });
    writeState({ channel: "ops", cursor: 0 });
    expect(await channelRun(["invite-agent", "bad-ref"])).toBe(1);
    expect(mock.requests.find((r) => r.path.includes("/project-agents"))).toBeUndefined();
  });

  test("removes a project-agent profile from only the resolved channel", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_runtime" });
    writeState({ channel: "ops", cursor: 0 });

    const code = await channelRun(["remove-agent", "fan@example.com/herness-dev"]);
    expect(code).toBe(0);
    const req = mock.requests.find((r) => r.path === "/api/channels/ops/project-agents" && r.method === "DELETE");
    expect(req?.auth).toBe("Bearer ap_runtime");
    expect(req?.body).toEqual({ owner_account: "fan@example.com", handle: "herness-dev" });
    expect(logs.join("\n")).toContain("removed fan@example.com/herness-dev from ops");
  });
});

describe("spawn", () => {
  test("uses runtime config token to spawn a channel-scoped child", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_parent" });
    liveAccount(mock.url);

    const code = await spawnRun(["child-bot", "--channel-scope", "ops", "--ttl", "30m", "--team-id", "team.1"]);
    expect(code).toBe(0);
    const req = mock.requests.find((r) => r.path === "/api/spawn");
    expect(req?.method).toBe("POST");
    expect(req?.auth).toBe("Bearer ap_parent");
    expect(req?.body).toEqual({ name: "child-bot", channel_scope: "ops", ttl_sec: 1800, team_id: "team.1" });
    expect(logs.join("\n")).toContain("ap_child-bot_secret");
    expect(errs.join("\n")).toContain("give it to the worker");
    expect(errs.join("\n")).toContain("party init --server");
    expect(errs.join("\n")).toContain("--channel ops");
  });

  test("rejects invalid ttl and channel-scope before any request", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_parent" });

    const badTtl = await spawnRun(["child", "--channel-scope", "ops", "--ttl", "soon"]);
    expect(badTtl).toBe(1);
    const badScope = await spawnRun(["child", "--channel-scope", "Bad"]);
    expect(badScope).toBe(1);
    expect(mock.requests.find((r) => r.path === "/api/spawn")).toBeUndefined();
  });

  test("requires a runtime token", async () => {
    mock = startOidcMock();
    const code = await spawnRun(["child", "--channel-scope", "ops"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("no config");
    expect(mock.requests.find((r) => r.path === "/api/spawn")).toBeUndefined();
  });
});

describe("whoami", () => {
  test("hits /api/me and prints identity", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await whoamiRun([]);
    expect(code).toBe(0);
    const stdout = logs.join("\n");
    expect(stdout).toContain("runtime: logged in as fan@example.com");
    expect(stdout).toContain("account:");
    expect(stdout).toContain("config:");
    expect(stdout).toContain("auth-source: account_session");
    expect(mock.requests.some((r) => r.path === "/api/me" && r.auth === "Bearer acc-live")).toBe(true);
  });

  test("prints identity as json", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await whoamiRun(["--json"]);
    expect(code).toBe(0);
    const frame = JSON.parse(logs[0]!);
    expect(frame).toMatchObject({
      schema: "agentparty.v1",
      type: "whoami",
      logged_in: true,
      server: mock.url,
      name: "fan@example.com",
      email: "fan@example.com",
      kind: "human",
      role: "human",
      channel_scope: null,
      caps: {
        send: true,
        create_channel: true,
        mint_agents: true,
        scoped_to: null,
      },
      auth_source: "account_session",
      runtime: {
        name: "fan@example.com",
        email: "fan@example.com",
        kind: "human",
        role: "human",
        owner: null,
        channel_scope: null,
      },
      account: {
        present: true,
        server: mock.url,
      },
      config: {
        kind: "none",
        path: null,
      },
    });
    expect(typeof frame.ts).toBe("number");
  });

  test("prints capabilities in text mode", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await whoamiRun(["--caps"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("scope: none (all channels)");
    expect(logs.join("\n")).toContain("can: send=yes create-channel=yes mint-agents=yes");
  });

  test("prints safe rejoin instructions without exposing the token", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_rejoin_secret" });
    writeState({ channel: "dev", cursor: 0 });
    const code = await whoamiRun(["--rejoin"]);
    expect(code).toBe(0);
    const stdout = logs.join("\n");
    expect(stdout).toContain("rejoin:");
    expect(stdout).toContain("channel: dev");
    expect(stdout).toContain(`token: ${tokenFingerprint("ap_rejoin_secret")}`);
    expect(stdout).toContain("AGENTPARTY_CONFIG=");
    expect(stdout).toContain("party watch dev --mentions-only --once");
    expect(stdout).not.toContain("ap_rejoin_secret");
  });

  test("prints not logged in when no auth", async () => {
    const code = await whoamiRun([]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("not logged in");
  });

  test("prints not logged in as json", async () => {
    const code = await whoamiRun(["--json"]);
    expect(code).toBe(0);
    const frame = JSON.parse(logs[0]!);
    expect(frame).toMatchObject({
      schema: "agentparty.v1",
      type: "whoami",
      logged_in: false,
      server: null,
      auth_source: "none",
      account: {
        present: false,
      },
      config: {
        kind: "none",
        path: null,
      },
    });
    expect(typeof frame.ts).toBe("number");
  });

  test("rejects unknown flags", async () => {
    const code = await whoamiRun(["--bogus"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("unknown option --bogus");
  });

  // issue #140：runtime config 指向 server A，account.json 是另一台 server B 的人类会话——
  // /api/me 打的是 A，但旧输出只印 account 那行的 B，agent 会误判自己在 B 上。
  describe("effective server disambiguation (issue #140)", () => {
    test("text mode: runtime line shows the server /api/me was actually called against", async () => {
      restMock = startRestMock();
      writeConfig({ server: restMock.url, token: "ap_effective" });
      writeAccount({
        server: "https://agentparty.other-server.example",
        refresh_token: "ref",
        access_token: "acc-live",
        email: "human@example.com",
        expires_at: nowSec() + 3600,
      });

      const code = await whoamiRun([]);
      expect(code).toBe(0);
      const stdout = logs.join("\n");
      // 生效 server（runtime_config 那个，也是 /api/me 实打的那个）必须出现在 runtime 行
      expect(stdout).toContain(`runtime: logged in as agent (agent/agent) server=${restMock.url}`);
      expect(restMock.requests.some((r) => r.path === "/api/me" && r.method === "GET")).toBe(true);
    });

    test("text mode: account line flags a server mismatch instead of silently implying it's in effect", async () => {
      restMock = startRestMock();
      writeConfig({ server: restMock.url, token: "ap_effective" });
      writeAccount({
        server: "https://agentparty.other-server.example",
        refresh_token: "ref",
        access_token: "acc-live",
        email: "human@example.com",
        expires_at: nowSec() + 3600,
      });

      const code = await whoamiRun([]);
      expect(code).toBe(0);
      const stdout = logs.join("\n");
      expect(stdout).toContain("account: human@example.com present server=https://agentparty.other-server.example");
      expect(stdout).toContain("different server");
      expect(stdout).toContain("not used for this command");
    });

    test("text mode: no mismatch annotation when the account session is on the effective server", async () => {
      mock = startOidcMock();
      liveAccount(mock.url); // config 里没 token，回落 account_session，同一台 server
      const code = await whoamiRun([]);
      expect(code).toBe(0);
      const stdout = logs.join("\n");
      expect(stdout).toContain(`runtime: logged in as fan@example.com (human/human) server=${mock.url}`);
      expect(stdout).not.toContain("different server");
    });

    test("json mode: effective_server and account_server are distinct, unambiguous fields", async () => {
      restMock = startRestMock();
      writeConfig({ server: restMock.url, token: "ap_effective" });
      writeAccount({
        server: "https://agentparty.other-server.example",
        refresh_token: "ref",
        access_token: "acc-live",
        email: "human@example.com",
        expires_at: nowSec() + 3600,
      });

      const code = await whoamiRun(["--json"]);
      expect(code).toBe(0);
      const frame = JSON.parse(logs[0]!);
      expect(frame.effective_server).toBe(restMock!.url);
      expect(frame.account_server).toBe("https://agentparty.other-server.example");
      // 生效 server 不能和 account server 撞车，否则整个字段就是摆设
      expect(frame.effective_server).not.toBe(frame.account_server);
      // 既有的顶层 server 字段必须继续等于生效 server（合约不能破）
      expect(frame.server).toBe(frame.effective_server);
    });

    test("text mode: not-logged-in path still prints the resolved config server", async () => {
      writeConfig({ server: "https://agentparty.config-only.example", token: "" });
      const code = await whoamiRun([]);
      expect(code).toBe(0);
      const stdout = logs.join("\n");
      expect(stdout).toContain("not logged in");
      expect(stdout).toContain("server: https://agentparty.config-only.example");
    });

    test("json mode: not-logged-in path still reports effective_server/account_server", async () => {
      writeConfig({ server: "https://agentparty.config-only.example", token: "" });
      const code = await whoamiRun(["--json"]);
      expect(code).toBe(0);
      const frame = JSON.parse(logs[0]!);
      expect(frame.logged_in).toBe(false);
      expect(frame.effective_server).toBe("https://agentparty.config-only.example");
      expect(frame.account_server).toBe(null);
    });
  });
});

describe("statusline", () => {
  test("prints cached agent identity and bound channel without network", async () => {
    writeConfig({
      server: "https://agentparty.example",
      token: "ap_cached_secret",
      identity: {
        name: "codex-mini",
        email: null,
        kind: "agent",
        role: "agent",
        owner: "leo",
        channel_scope: "dev",
        verified_at: 123,
      },
    });
    writeState({ channel: "dev", cursor: 0 });

    const code = await statuslineRun(["--no-network"]);
    expect(code).toBe(0);
    expect(logs).toEqual(["ap:codex-mini #dev"]);
    expect(errs).toEqual([]);
  });

  test("prints cached active task count without network", async () => {
    writeConfig({
      server: "https://agentparty.example",
      token: "ap_cached_secret",
      identity: {
        name: "codex-mini",
        email: null,
        kind: "agent",
        role: "agent",
        owner: "leo",
        channel_scope: "dev",
        verified_at: 123,
      },
    });
    writeState({ channel: "dev", cursor: 0 });
    writeStatuslineCache({ channel: "dev", tasks: { mine_active: 2, mine_total: 3 } });

    const code = await statuslineRun(["--no-network"]);
    expect(code).toBe(0);
    expect(logs).toEqual(["ap:codex-mini #dev tasks:2"]);
    expect(errs).toEqual([]);
  });

  test("prints nothing when no identity is available", async () => {
    const code = await statuslineRun(["--no-network"]);
    expect(code).toBe(0);
    expect(logs).toEqual([]);
    expect(errs).toEqual([]);
  });

  test("refresh verifies identity and updates the local cache", async () => {
    restMock = startRestMock();
    writeConfig({ server: restMock.url, token: "ap_refresh_secret" });
    writeState({ channel: "ops", cursor: 0 });

    const code = await statuslineRun(["--refresh"]);
    expect(code).toBe(0);
    expect(logs).toEqual(["ap:agent #ops"]);
    expect(restMock.requests.some((r) => r.path === "/api/me" && r.headers.authorization === "Bearer ap_refresh_secret")).toBe(true);
    logs.length = 0;

    const cachedCode = await statuslineRun(["--no-network"]);
    expect(cachedCode).toBe(0);
    expect(logs).toEqual(["ap:agent #ops"]);
  });

  test("rejects invalid channel override", async () => {
    writeConfig({
      server: "https://agentparty.example",
      token: "ap_cached_secret",
      identity: {
        name: "codex-mini",
        email: null,
        kind: "agent",
        role: "agent",
        owner: null,
        channel_scope: null,
        verified_at: 123,
      },
    });
    const code = await statuslineRun(["--channel", "Bad_Channel", "--no-network"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("channel must match");
  });
});

describe("logout", () => {
  test("clears session", async () => {
    liveAccount("https://ap.example.com");
    expect(await logoutRun([])).toBe(0);
    expect(logs.join("\n")).toContain("logged out");
    // 二次登出提示未登录
    logs.length = 0;
    expect(await logoutRun([])).toBe(0);
    expect(logs.join("\n")).toContain("not logged in");
  });
});
