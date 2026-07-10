// party channel guard status（#174）：熔断前读 limit/streak/remaining 的 CLI 入口
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, writeState } from "../src/config";
import { run as channelRun } from "../src/commands/channel";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-guardstatus-"));
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

test("guard status --json prints the guard state and hits GET loop-guard", async () => {
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });

  const code = await channelRun(["guard", "status", "ops", "--json"]);
  expect(code).toBe(0);

  const req = mock.requests.find((r) => r.path === "/api/channels/ops/loop-guard");
  expect(req?.method).toBe("GET");
  expect(req?.auth).toBe("Bearer ap_runtime");

  const printed = JSON.parse(logs.join("\n"));
  expect(printed).toEqual({ enabled: true, limit: 30, streak: 27, remaining: 3, resets_on: "human" });
});

test("guard status (human-readable) surfaces streak/limit/remaining and reset target", async () => {
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });

  const code = await channelRun(["guard", "status"]);
  expect(code).toBe(0);
  const out = logs.join("\n");
  expect(out).toContain("27");
  expect(out).toContain("30");
  expect(out).toContain("3");
  expect(out.toLowerCase()).toContain("human");
});

test("guard status resolves the slug from state when omitted", async () => {
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });

  await channelRun(["guard", "status"]);
  expect(mock.requests.some((r) => r.path === "/api/channels/ops/loop-guard")).toBe(true);
});
