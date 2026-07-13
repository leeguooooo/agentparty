import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as channelRun } from "../src/commands/channel";
import { writeConfig, writeState } from "../src/config";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-retention-"));
  process.env.AGENTPARTY_HOME = home;
  logs = [];
  errs = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.AGENTPARTY_HOME;
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

test("retention config sends independent message and audit windows", async () => {
  expect(await channelRun(["retention", "30d", "90d", "ops"])).toBe(0);
  const request = mock!.requests.find((r) => r.path === "/api/channels/ops/retention" && r.method === "PUT");
  expect(request?.body).toEqual({
    message_retention_ms: 30 * 24 * 60 * 60 * 1000,
    audit_retention_ms: 90 * 24 * 60 * 60 * 1000,
  });
  expect(logs.join("\n")).toContain("messages=30d audit=90d");
});

test("retention supports off, status json, and rejects windows below one minute", async () => {
  expect(await channelRun(["retention", "off", "7d"])).toBe(0);
  expect(await channelRun(["retention", "status", "ops", "--json"])).toBe(0);
  expect(JSON.parse(logs.at(-1)!)).toEqual({
    message_retention_ms: null,
    audit_retention_ms: 7 * 24 * 60 * 60 * 1000,
  });
  const requestCount = mock!.requests.length;
  expect(await channelRun(["retention", "30s", "7d", "ops"])).toBe(1);
  expect(mock!.requests.length).toBe(requestCount);
  expect(errs.join("\n")).toContain("at least 60s");
});
