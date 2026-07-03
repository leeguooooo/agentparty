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

describe("send with account session", () => {
  test("uses account access_token as bearer, not config ap_ token", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_should_not_be_used" });
    liveAccount(mock.url);
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["hello", "--channel", "dev"]);
    expect(code).toBe(0);
    const msgReq = mock.requests.find((r) => r.path === "/api/channels/dev/messages");
    expect(msgReq?.auth).toBe("Bearer acc-live");
    // 未触发刷新
    expect(mock.tokenCalls).toHaveLength(0);
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

  test("prints not logged in when no auth", async () => {
    const code = await whoamiRun([]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("not logged in");
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
