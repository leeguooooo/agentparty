// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import {
  collectDesktopStorage,
  restoreDesktopStorage,
  snapshotDesktopStorage,
  synchronizeDesktopStorage,
  type DesktopStorageSnapshot,
  type DesktopStorageRuntime,
} from "./desktopStorage";

function storage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

describe("desktop origin storage migration", () => {
  test("collects only bounded non-secret desktop preferences", () => {
    const value = storage({
      ap_theme: "midnight",
      ap_locale: "zh",
      ap_server_profiles_v1: '[{"label":"Private","origin":"https://private.example"}]',
      ap_active_server_origin_v1: "https://private.example",
      ap_api_base: "http://localhost:8787",
      ap_notify_optin: "1",
      ap_onboarded: "1",
      ap_presence_expanded: "0",
      ap_channel_tools_expanded: "1",
      ap_desktop_updater_last_success: "1720000000000",
      ap_desktop_updater_diagnostic: '{"status":"success","source":"manual","stage":"check","category":null,"timestamp":1720000000000,"appVersion":"0.2.94"}',
      "ap_seen:v1:agentparty:leo": "42",
      "ap_charter_seen:agentparty": "7",
      ap_token: "secret-access",
      ap_share_token: "secret-share",
      ap_oidc_session: "secret-refresh",
      "ap_agent_token_vault:v1": "secret-agent-token",
      ap_pending_pair_code: "123456",
      unrelated: "ignore",
    });

    expect(collectDesktopStorage(value)).toEqual({
      ap_theme: "midnight",
      ap_locale: "zh",
      ap_server_profiles_v1: '[{"label":"Private","origin":"https://private.example"}]',
      ap_active_server_origin_v1: "https://private.example",
      ap_api_base: "http://localhost:8787",
      ap_notify_optin: "1",
      ap_onboarded: "1",
      ap_presence_expanded: "0",
      ap_channel_tools_expanded: "1",
      ap_desktop_updater_last_success: "1720000000000",
      ap_desktop_updater_diagnostic: '{"status":"success","source":"manual","stage":"check","category":null,"timestamp":1720000000000,"appVersion":"0.2.94"}',
      "ap_seen:v1:agentparty:leo": "42",
      "ap_charter_seen:agentparty": "7",
    });
  });

  test("rejects secret-looking and malformed values under allowed keys", () => {
    const value = storage({
      ap_theme: "ghp_secret_access_token",
      ap_locale: "en\nsecret",
      ap_notify_optin: "Bearer secret-token",
      ap_onboarded: "true",
      ap_presence_expanded: "2",
      ap_channel_tools_expanded: "yes",
      ap_active_server_origin_v1: "https://token@private.example",
      ap_api_base: "https://private.example/api?token=secret",
      ap_server_profiles_v1: '[{"label":"Private","origin":"https://private.example","token":"secret"}]',
      "ap_seen:v1:agentparty:leo": "secret-token",
      "ap_charter_seen:agentparty": "-1",
      "ap_seen:v1:agentparty:leo:ghp_secret": "42",
      "ap_charter_seen:agentparty?token=secret": "7",
      ap_desktop_updater_last_success: "NaN",
      ap_desktop_updater_diagnostic: '{"status":"success","source":"manual","stage":"check","category":null,"timestamp":42,"appVersion":"0.2.94","token":"secret"}',
    });

    expect(collectDesktopStorage(value)).toEqual({});
    expect(restoreDesktopStorage(storage(), Object.fromEntries(
      Array.from({ length: value.length }, (_, index) => value.key(index)!)
        .map((key) => [key, value.getItem(key)!]),
    ))).toBe(0);
  });

  test("rejects producer-invalid profile and updater variants", () => {
    for (const [key, invalid] of [
      ["ap_server_profiles_v1", '[{"label":"","origin":"https://private.example"}]'],
      ["ap_desktop_updater_diagnostic", '{"status":"success","source":"manual","stage":"check","category":null,"timestamp":42,"appVersion":"0.2.94","targetVersion":null}'],
    ]) {
      expect(collectDesktopStorage(storage({ [key]: invalid }))).toEqual({});
    }
  });

  test("restores only missing allowed keys and rejects malformed values", () => {
    const value = storage({ ap_theme: "doodle" });
    expect(restoreDesktopStorage(value, {
      ap_theme: "midnight",
      ap_locale: "zh",
      ap_token: "must-not-restore",
      "../escape": "bad",
      ap_notify_optin: 1,
    })).toBe(1);
    expect(value.getItem("ap_theme")).toBe("doodle");
    expect(value.getItem("ap_locale")).toBe("zh");
    expect(value.getItem("ap_token")).toBeNull();
  });

  test("restores before writing the new origin snapshot", async () => {
    const value = storage();
    const calls: string[] = [];
    const runtime: DesktopStorageRuntime = {
      isDesktop: () => true,
      restore: async () => {
        calls.push("restore");
        return { ap_theme: "midnight", ap_locale: "zh" };
      },
      snapshot: async (entries) => {
        calls.push(`snapshot:${entries.ap_theme}:${entries.ap_locale}`);
      },
    };
    expect(await synchronizeDesktopStorage(value, runtime)).toBe(true);
    expect(calls).toEqual(["restore", "snapshot:midnight:zh"]);
  });

  test("queues snapshots in mutation order and captures each mutation immediately", async () => {
    const value = storage({
      ap_server_profiles_v1: '[{"label":"Private","origin":"https://private.example"}]',
    });
    const snapshots: DesktopStorageSnapshot[] = [];
    let releaseFirstSnapshot!: () => void;
    const firstSnapshotBlocked = new Promise<void>((resolve) => { releaseFirstSnapshot = resolve; });
    const runtime: DesktopStorageRuntime = {
      isDesktop: () => true,
      restore: async () => ({}),
      snapshot: async (entries) => {
        snapshots.push(entries);
        if (snapshots.length === 1) await firstSnapshotBlocked;
      },
    };

    const profileSnapshot = snapshotDesktopStorage(value, runtime);
    value.setItem("ap_active_server_origin_v1", "https://private.example");
    const activeOriginSnapshot = snapshotDesktopStorage(value, runtime);
    value.setItem("ap_active_server_origin_v1", "https://agentparty.leeguoo.com");

    await Promise.resolve();
    expect(snapshots).toHaveLength(1);
    releaseFirstSnapshot();
    expect(await Promise.all([profileSnapshot, activeOriginSnapshot])).toEqual([true, true]);
    expect(snapshots).toEqual([
      {
        ap_server_profiles_v1: '[{"label":"Private","origin":"https://private.example"}]',
      },
      {
        ap_server_profiles_v1: '[{"label":"Private","origin":"https://private.example"}]',
        ap_active_server_origin_v1: "https://private.example",
      },
    ]);
  });

  test("is a non-blocking no-op outside desktop and fails closed", async () => {
    const value = storage({ ap_theme: "midnight" });
    expect(await snapshotDesktopStorage(value, {
      isDesktop: () => false,
      restore: async () => { throw new Error("must not run"); },
      snapshot: async () => { throw new Error("must not run"); },
    })).toBe(false);
    expect(await synchronizeDesktopStorage(value, {
      isDesktop: () => false,
      restore: async () => { throw new Error("must not run"); },
      snapshot: async () => { throw new Error("must not run"); },
    })).toBe(false);
    expect(await synchronizeDesktopStorage(value, {
      isDesktop: () => true,
      restore: async () => { throw new Error("native unavailable"); },
      snapshot: async () => {},
    })).toBe(false);
  });
});
