import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeAccount } from "../src/account";
import { startMockServer, welcomeFrame } from "./mock-server";
import { startOidcMock, type OidcMock } from "./oidc-mock";
import { startRestMock, type RestMock } from "./rest-mock";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");
const fixtureDir = join(import.meta.dir, "fixtures", "json-contract");

let home: string;
let configPath: string;
let restMock: RestMock | null = null;
let oidcMock: OidcMock | null = null;
let wsStop: (() => void) | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-json-contract-"));
  configPath = join(home, "config.json");
});

afterEach(() => {
  restMock?.stop();
  restMock = null;
  oidcMock?.stop();
  oidcMock = null;
  wsStop?.();
  wsStop = null;
  rmSync(home, { recursive: true, force: true });
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

function writeCfg(server: string, token = "ap_tok") {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ server, token }, null, 2) + "\n");
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_CONFIG: configPath, AGENTPARTY_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function parseOneLine(stdout: string): unknown {
  const lines = stdout.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
}

function expectContract(actual: unknown, expected: unknown) {
  expect(actual).toEqual(expectContractShape(expected));
}

function expectContractShape(expected: unknown): unknown {
  if (Array.isArray(expected)) {
    return expect.any(Array);
  }
  if (expected === null) {
    return null;
  }
  if (typeof expected === "object") {
    const shape: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      shape[key] = expectContractShape(value);
    }
    return expect.objectContaining(shape);
  }
  if (typeof expected === "string") {
    return expected.startsWith("agentparty.") || expected === "msg" || expected === "status" ||
        expected === "timeout" || expected === "error" || expected === "whoami" ||
        expected === "digest" || expected === "wake_test" || expected === "search_hit"
      ? expected
      : expect.any(String);
  }
  if (typeof expected === "number") return expect.any(Number);
  if (typeof expected === "boolean") return expected;
  return expected;
}

describe("json contract fixtures", () => {
  test("history --json msg frames match the agentparty.v1 fixture shape", async () => {
    restMock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "msg",
              seq: 1,
              sender: { name: "alice", kind: "agent", owner: "team-a" },
              kind: "message",
              body: "hello",
              mentions: ["bob"],
              reply_to: null,
              state: null,
              note: null,
              ts: Date.now(),
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(restMock.url);

    const result = await runCli(["history", "dev", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expectContract(parseOneLine(result.stdout), fixture("history.msg.json"));
  });

  test("history --json status frames match the agentparty.v1 fixture shape", async () => {
    restMock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "status",
              seq: 2,
              sender: { name: "alice", kind: "agent", owner: "team-a" },
              kind: "status",
              body: "",
              mentions: [],
              reply_to: null,
              state: "working",
              note: "checking release",
              status: {
                owner: "alice",
                state: "working",
                scope: ["cli/src/commands/status.ts"],
                summary_seq: 1,
                blocked_reason: null,
                updated_at: Date.now(),
                workflow: {
                  workflow_id: "wf-release",
                  kind: "pipeline",
                  run_id: "run-1",
                  step_id: "build",
                  parent_summary_seq: 1,
                },
              },
              ts: Date.now(),
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(restMock.url);

    const result = await runCli(["history", "dev", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expectContract(parseOneLine(result.stdout), fixture("history.status.json"));
  });

  test("search --json output matches the agentparty.v1 fixture shape", async () => {
    restMock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/search") {
        return Response.json({
          hits: [
            {
              type: "search_hit",
              channel: "dev",
              query: "release",
              seq: 3,
              sender: { name: "alice", kind: "agent", owner: "team-a" },
              kind: "status",
              match_field: "note",
              snippet: "checking release",
              ts: Date.now(),
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(restMock.url);

    const result = await runCli(["search", "release", "--channel", "dev", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expectContract(parseOneLine(result.stdout), fixture("search-hit.json"));
  });

  test("digest --json output matches the agentparty.v1 fixture shape", async () => {
    restMock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/messages") {
        return Response.json({
          messages: [
            {
              type: "msg",
              seq: 11,
              sender: { name: "host", kind: "agent" },
              kind: "message",
              body: "@agent done?",
              mentions: ["agent"],
              reply_to: null,
              state: null,
              note: null,
              status: null,
              ts: Date.now(),
            },
            {
              type: "msg",
              seq: 12,
              sender: { name: "host", kind: "agent" },
              kind: "message",
              body: "@agent later",
              mentions: ["agent"],
              reply_to: null,
              state: null,
              note: null,
              status: null,
              ts: Date.now(),
            },
            {
              type: "status",
              seq: 13,
              sender: { name: "agent", kind: "agent" },
              kind: "status",
              body: "done",
              mentions: [],
              reply_to: null,
              state: "done",
              note: "done",
              status: {
                owner: "agent",
                state: "done",
                scope: ["cli/src/commands/digest.ts"],
                summary_seq: 11,
                blocked_reason: null,
                updated_at: Date.now(),
              },
              ts: Date.now(),
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(restMock.url);

    const result = await runCli(["digest", "dev", "--since", "10", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expectContract(parseOneLine(result.stdout), fixture("digest.json"));
  });

  test("wake test --json output matches the agentparty.v1 fixture shape", async () => {
    restMock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/channels/dev/presence") {
        return Response.json({
          presence: [
            {
              name: "agent",
              state: "waiting",
              note: null,
              ts: Date.now(),
              last_seen: Date.now(),
              residency: "human_driven",
              wake: { kind: "none" },
            },
          ],
        });
      }
      return undefined;
    });
    writeCfg(restMock.url);

    const result = await runCli(["wake", "test", "@agent", "dev", "--json"]);
    expect(result).toMatchObject({ code: 2, stderr: "" });
    expectContract(parseOneLine(result.stdout), fixture("wake-test.json"));
  });

  test("watch --json timeout frames match the agentparty.v1 fixture shape", async () => {
    const server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    wsStop = server.stop;
    writeCfg(server.url);

    const result = await runCli(["watch", "dev", "--json", "--timeout", "1"]);
    expect(result).toMatchObject({ code: 2, stderr: "" });
    expectContract(parseOneLine(result.stdout), fixture("watch.timeout.json"));
  });

  test("watch --json error frames match the agentparty.v1 fixture shape", async () => {
    const server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({
          type: "error",
          code: "unauthorized",
          message: "invalid or revoked token",
        });
      }
    });
    wsStop = server.stop;
    writeCfg(server.url);

    const result = await runCli(["watch", "dev", "--json", "--timeout", "1"]);
    expect(result).toMatchObject({ code: 3, stderr: "" });
    expectContract(parseOneLine(result.stdout), fixture("watch.error.json"));
  });

  test("whoami --json logged-in output matches the agentparty.v1 fixture shape", async () => {
    oidcMock = startOidcMock();
    process.env.AGENTPARTY_HOME = home;
    writeAccount({
      server: oidcMock.url,
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    delete process.env.AGENTPARTY_HOME;

    const result = await runCli(["whoami", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expectContract(parseOneLine(result.stdout), fixture("whoami.logged-in.json"));
  });

  test("whoami --json logged-out output matches the agentparty.v1 fixture shape", async () => {
    const result = await runCli(["whoami", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expectContract(parseOneLine(result.stdout), fixture("whoami.logged-out.json"));
  });
});
