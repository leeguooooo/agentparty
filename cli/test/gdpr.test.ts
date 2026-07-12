// party gdpr erase|export（#421）：确认闸（erase 需 --yes）、命令层路由 + 回显。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, writeState } from "../src/config";
import { run as gdprRun } from "../src/commands/gdpr";
import { startRestMock, type RestMock } from "./rest-mock";

let home: string;
let restMock: RestMock | null = null;
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;

const IDENTITY_RE = /^\/api\/channels\/([^/]+)\/identity\/([^/?]+)\/data(?:\?.*)?$/;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-gdpr-"));
  process.env.AGENTPARTY_HOME = home;
  logs = [];
  errs = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  restMock = startRestMock((r) => {
    const m = r.path.match(IDENTITY_RE);
    if (!m) return undefined;
    if (r.method === "DELETE") {
      return Response.json({
        name: decodeURIComponent(m[2]!),
        erased_at: 1,
        messages_scrubbed: 3,
        audit_deleted: 2,
        wake_ledger_deleted: 1,
        read_cursors_deleted: 1,
        presence_deleted: 1,
      });
    }
    return Response.json({
      name: decodeURIComponent(m[2]!),
      exported_at: 1,
      messages: [{ seq: 1, body: "a" }, { seq: 2, body: "b" }],
      audit: [{ target_seq: 1, action: "edit", actor: { name: "bot", kind: "agent" } }],
      wake_deliveries: [{ target_name: "bot" }],
      read_cursor: { name: "bot" },
      presence: [{ name: "bot" }],
      next: { messages: null, audit: null, wake_deliveries: null },
    });
  });
  writeConfig({ server: restMock.url, token: "ap_mod" });
  writeState({ channel: "ops", cursor: 0 });
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.AGENTPARTY_HOME;
  rmSync(home, { recursive: true, force: true });
  restMock?.stop();
  restMock = null;
});

describe("party gdpr", () => {
  test("erase without --yes refuses before any request", async () => {
    const code = await gdprRun(["erase", "bot"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("refusing to erase without confirmation");
    expect(restMock!.requests.some((r) => IDENTITY_RE.test(r.path))).toBe(false);
  });

  test("erase --yes hits DELETE and prints the counts", async () => {
    const code = await gdprRun(["erase", "bot", "--yes"]);
    expect(code).toBe(0);
    const req = restMock!.requests.find((r) => IDENTITY_RE.test(r.path));
    expect(req?.method).toBe("DELETE");
    expect(req?.path).toBe("/api/channels/ops/identity/bot/data");
    expect(req?.headers.authorization).toBe("Bearer ap_mod");
    const out = logs.join("\n");
    expect(out).toContain("messages scrubbed:    3");
    expect(out).toContain("audit rows deleted:   2");
  });

  test("export hits GET and prints a summary", async () => {
    const code = await gdprRun(["export", "bot"]);
    expect(code).toBe(0);
    const req = restMock!.requests.find((r) => IDENTITY_RE.test(r.path));
    expect(req?.method).toBe("GET");
    expect(logs.join("\n")).toContain("messages:        2");
    expect(logs.join("\n")).toContain("audit rows:      1");
  });

  test("export --json prints the raw dump", async () => {
    const code = await gdprRun(["export", "bot", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as { name: string; messages: unknown[] };
    expect(parsed.name).toBe("bot");
    expect(parsed.messages.length).toBe(2);
  });

  test("sanitizes control characters in terminal output", async () => {
    const code = await gdprRun(["erase", "bot\u001b[31m", "--yes"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).not.toContain("\u001b");
  });

  test("accepts a dash-prefixed identity after the option terminator", async () => {
    const code = await gdprRun(["erase", "--yes", "--", "-bot"]);
    expect(code).toBe(0);
    expect(restMock!.requests.some((r) => r.path.includes("identity/-bot/data"))).toBe(true);
  });

  test("rejects an unknown subcommand", async () => {
    const code = await gdprRun(["nuke", "bot"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("usage: party gdpr");
    expect(restMock!.requests.some((r) => IDENTITY_RE.test(r.path))).toBe(false);
  });
});
