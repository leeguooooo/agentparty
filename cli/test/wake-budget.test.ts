// party wake-budget（issue #108）：inspect（GET）/ set（PUT --limit --window）/ clear（--off），
// 以及 fmtWindow 展示与 --limit 校验。窗口内 wake 硬上限，超额 @ 由 worker 侧抑制（不烧订阅）。
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as wakeBudgetRun } from "../src/commands/wake-budget";
import { writeConfig, writeState } from "../src/config";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-wakebudget-"));
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

test("no flags → inspect via GET, prints 'no wake budget' when unset", async () => {
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });

  const code = await wakeBudgetRun(["alice"]);
  expect(code).toBe(0);
  const req = mock.requests.find((r) => r.path === "/api/channels/ops/wake-budget/alice");
  expect(req?.method).toBe("GET");
  expect(logs.join("\n").toLowerCase()).toContain("no wake budget");
});

test("--limit N --window D → PUT sets budget and echoes the cap", async () => {
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });

  const code = await wakeBudgetRun(["bob", "--limit", "20", "--window", "2h"]);
  expect(code).toBe(0);
  const put = mock.requests.find((r) => r.path === "/api/channels/ops/wake-budget/bob" && r.method === "PUT");
  expect(put).toBeDefined();
  expect(put?.body).toMatchObject({ enabled: true, limit: 20, window_ms: 7_200_000 });
  const out = logs.join("\n");
  expect(out).toContain("20 wakes");
  expect(out).toContain("2h");

  // 设完再 inspect 应看到已生效
  logs.length = 0;
  await wakeBudgetRun(["bob"]);
  expect(logs.join("\n")).toContain("20");
});

test("--off → PUT enabled:false clears the budget", async () => {
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });

  await wakeBudgetRun(["carol", "--limit", "5"]);
  logs.length = 0;
  const code = await wakeBudgetRun(["carol", "--off"]);
  expect(code).toBe(0);
  const puts = mock.requests.filter((r) => r.path === "/api/channels/ops/wake-budget/carol" && r.method === "PUT");
  expect(puts.at(-1)?.body).toMatchObject({ enabled: false });
  expect(logs.join("\n").toLowerCase()).toContain("unlimited");
});

test("--limit 0 → local validation error, no request", async () => {
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });

  const code = await wakeBudgetRun(["dave", "--limit", "0"]);
  expect(code).toBe(1);
  expect(errs.join("\n")).toContain("--limit");
  expect(mock.requests.some((r) => r.path.includes("/wake-budget/dave"))).toBe(false);
});

test("missing name → usage error", async () => {
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });
  const code = await wakeBudgetRun([]);
  expect(code).toBe(1);
  expect(errs.join("\n").toLowerCase()).toContain("usage");
});
