// 命令层：send/agent add/whoami/logout 在账号会话下的行为
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAccount } from "../src/account";
import { writeConfig, writeState } from "../src/config";
import { run as sendRun } from "../src/commands/send";
import { run as agentRun } from "../src/commands/agent";
import { run as whoamiRun } from "../src/commands/whoami";
import { run as logoutRun } from "../src/commands/logout";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
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
});

describe("agent add", () => {
  test("requires login", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_x" });
    const code = await agentRun(["add", "botty"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("party login");
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
});

describe("whoami", () => {
  test("hits /api/me and prints identity", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await whoamiRun([]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("fan@example.com");
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
    });
    expect(typeof frame.ts).toBe("number");
  });

  test("rejects unknown flags", async () => {
    const code = await whoamiRun(["--bogus"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("unknown option --bogus");
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
