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

  test("an inbound watchdog reconnect records its exact reason in health", async () => {
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      if (connIndex > 0) {
        setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 5);
      }
    });
    const running = runServe(opts({
      server: server.url,
      runCommand: async () => {},
      inboundIdleTimeoutMs: 30,
    }));

    let reconnecting = readHealthCache();
    const deadline = Date.now() + 500;
    while (reconnecting?.reconnecting !== true && Date.now() < deadline) {
      await Bun.sleep(5);
      reconnecting = readHealthCache();
    }
    expect(reconnecting).toMatchObject({
      ws_connected: false,
      reconnecting: true,
      reconnect_count: 1,
      last_error: "inbound idle timeout",
    });

    expect(await running).toBe(EXIT_ARCHIVED);
  });

  test("a replacement socket stays unhealthy until its first valid server frame", async () => {
    server = startMockServer((frame, sock, connIndex) => {
      if (frame.type !== "hello") return;
      if (connIndex === 0) {
        sock.send(welcomeFrame(0, "me"));
        return;
      }
      // The replacement accepts a WS handshake but withholds application frames long enough for
      // the test to observe health. A delayed welcome then proves the same socket becomes healthy.
      setTimeout(() => sock.send(welcomeFrame(0, "me")), 80);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 130);
    });
    const running = runServe(opts({
      server: server.url,
      runCommand: async () => {},
      inboundIdleTimeoutMs: 200,
    }));

    let replacement = readHealthCache();
    const openDeadline = Date.now() + 2_000;
    while (
      !(replacement?.reconnect_count === 1 && replacement.ws_connected && replacement.last_frame_at === null)
      && Date.now() < openDeadline
    ) {
      await Bun.sleep(5);
      replacement = readHealthCache();
    }
    expect(replacement).toMatchObject({
      ws_connected: true,
      reconnecting: false,
      reconnect_count: 1,
      last_frame_at: null,
      last_error: "inbound idle timeout",
    });

    let recovered = readHealthCache();
    const frameDeadline = Date.now() + 500;
    while (recovered?.last_frame_at === null && Date.now() < frameDeadline) {
      await Bun.sleep(5);
      recovered = readHealthCache();
    }
    expect(recovered?.last_frame_at).not.toBeNull();
    expect(recovered?.last_error).toBeNull();
    expect(await running).toBe(EXIT_ARCHIVED);
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
