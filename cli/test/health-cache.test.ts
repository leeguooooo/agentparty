import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceId } from "../src/config";
import { clearHealthCache, healthCachePath, readHealthCache, writeHealthCache } from "../src/health-cache";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-health-"));
  cwd = join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  process.env.AGENTPARTY_HOME = home;
});

afterEach(() => {
  delete process.env.AGENTPARTY_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("health cache contract", () => {
  test("writes health.json under the cwd workspace state directory, 0600", () => {
    writeHealthCache({ channel: "dev", ws_connected: true, last_frame_at: 1000 }, cwd, 1234);

    expect(healthCachePath(cwd)).toBe(join(home, "state", workspaceId(cwd), "health.json"));
    const cache = readHealthCache(cwd);
    expect(cache).toEqual({
      v: 1,
      pid: process.pid,
      channel: "dev",
      ws_connected: true,
      last_frame_at: 1000,
      reconnecting: false,
      reconnect_count: 0,
      last_error: null,
      connected_since: null,
      current_task: null,
      task_started_at: null,
      heartbeat_at: null,
      updated_at: 1234,
    });
    expect(statSync(healthCachePath(cwd)).mode & 0o777).toBe(0o600);
  });

  test("merges patches: keys not mentioned keep their previous value", () => {
    writeHealthCache({ channel: "dev", ws_connected: true, last_frame_at: 1000, reconnect_count: 2 }, cwd, 1000);
    writeHealthCache({ last_frame_at: 2000 }, cwd, 2000);

    const cache = readHealthCache(cwd);
    expect(cache?.ws_connected).toBe(true);
    expect(cache?.reconnect_count).toBe(2);
    expect(cache?.last_frame_at).toBe(2000);
    expect(cache?.updated_at).toBe(2000);
  });

  test("an explicit null clears a field instead of falling back to the previous value", () => {
    writeHealthCache({ channel: "dev", last_error: "boom", connected_since: 500 }, cwd, 1000);
    expect(readHealthCache(cwd)?.last_error).toBe("boom");

    writeHealthCache({ last_error: null, connected_since: null }, cwd, 1100);
    const cache = readHealthCache(cwd);
    expect(cache?.last_error).toBeNull();
    expect(cache?.connected_since).toBeNull();
  });

  test("clearHealthCache only clears a record this process pid owns", () => {
    // Foreign pid — must be left untouched.
    writeHealthCache({ channel: "dev", ws_connected: true }, cwd, 1000);
    const raw = JSON.parse(require("node:fs").readFileSync(healthCachePath(cwd), "utf8"));
    raw.pid = process.pid + 1;
    require("node:fs").writeFileSync(healthCachePath(cwd), JSON.stringify(raw));

    clearHealthCache(cwd, 2000);
    expect(readHealthCache(cwd)?.ws_connected).toBe(true);

    // Our own record does get cleared.
    writeHealthCache({ channel: "dev", ws_connected: true, connected_since: 999 }, cwd, 3000);
    clearHealthCache(cwd, 4000);
    const cleared = readHealthCache(cwd);
    expect(cleared?.ws_connected).toBe(false);
    expect(cleared?.reconnecting).toBe(false);
    expect(cleared?.connected_since).toBeNull();
  });

  test("readHealthCache returns null when no file exists yet", () => {
    expect(readHealthCache(cwd)).toBeNull();
  });
});
