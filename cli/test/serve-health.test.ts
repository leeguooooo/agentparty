import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ARCHIVED } from "@agentparty/shared";
import { EXIT_ALREADY_SERVING, runServe, type ServeOptions } from "../src/commands/serve";
import { readHealthCache } from "../src/health-cache";
import { acquireInstanceLock } from "../src/instance-lock";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
let home: string;
let oldHome: string | undefined;

beforeEach(() => {
  oldHome = process.env.AGENTPARTY_HOME;
  home = mkdtempSync(join(tmpdir(), "ap-health-serve-"));
  process.env.AGENTPARTY_HOME = home;
});

afterEach(() => {
  server?.stop();
  server = null;
  if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

function opts(over: Partial<ServeOptions> & { server: string }): ServeOptions {
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: () => {},
    lockDir: mkdtempSync(join(tmpdir(), "ap-lock-")),
    ...over,
  };
}

describe("serve writes local WS health (#254)", () => {
  test("welcome + frames mark ws_connected and stamp a fresh last_frame_at", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(1, "me"));
      setTimeout(() => sock.send(msgFrame(1, "hi", { mentions: [] })), 10);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 60);
    });
    const before = Date.now();
    const code = await runServe(opts({ server: server.url, runCommand: async () => {} }));
    expect(code).toBe(EXIT_ARCHIVED);

    // Process "exited" (runServe returned) — health record must be cleared to avoid a stale-green.
    const after = readHealthCache();
    expect(after?.ws_connected).toBe(false);
    expect(after?.reconnecting).toBe(false);
    expect(after?.last_frame_at).toBeGreaterThanOrEqual(before);
  });

  test("a transient drop marks reconnecting and bumps reconnect_count before recovering", async () => {
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
      if (connIndex === 0) {
        sock.send(welcomeFrame(0, "me"));
        sock.close();
      } else {
        sock.send(welcomeFrame(0, "me"));
        setTimeout(() => sock.send(msgFrame(1, "hi", { mentions: ["me"] })), 10);
        setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 60);
      }
    });
    const seen: Array<{ ws_connected: boolean; reconnecting: boolean; reconnect_count: number } | null> = [];
    const code = await runServe(
      opts({
        server: server.url,
        runCommand: async () => {
          seen.push(readHealthCache());
        },
      }),
    );
    expect(code).toBe(EXIT_ARCHIVED);
    expect(seen).toHaveLength(1);
    // By the time the mention fired the runner, we must have gone through a reconnect.
    expect(seen[0]?.reconnect_count).toBeGreaterThanOrEqual(1);
  });

  test("EXIT_ALREADY_SERVING does not clobber the winning server's health record", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0, "me"));
    });
    const lockDir = mkdtempSync(join(tmpdir(), "ap-lock-"));
    const held = acquireInstanceLock("serve", "dev", lockDir);
    expect(held.ok).toBe(true);

    const code = await runServe(opts({ server: server.url, lockDir, runCommand: async () => {} }));
    expect(code).toBe(EXIT_ALREADY_SERVING);
    // No health record for our workspace should exist — the losing instance never claimed the channel.
    expect(readHealthCache()).toBeNull();
  });

  test("health/statusline filesystem failures never crash the WS callbacks or delivery loop", async () => {
    // Point AGENTPARTY_HOME at a regular file: every health/statusline mkdir/write/clear operation
    // deterministically fails with ENOTDIR, including onStatus callbacks and welcome/msg writes.
    rmSync(home, { recursive: true, force: true });
    writeFileSync(home, "not a directory");
    const seen: number[] = [];
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "still deliver", { mentions: ["me"] })), 10);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 60);
    });

    const code = await runServe(opts({
      server: server.url,
      statusline: true,
      advertise: async () => {},
      post: async () => ({ seq: 99 }),
      runCommand: async (frame) => { seen.push(frame.seq); },
    }));

    expect(code).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([1]);
  });
});
