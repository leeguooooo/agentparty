import { afterEach, describe, expect, test } from "bun:test";
import { fetchServerVersion } from "../src/rest";
import { RUNNING_VERSION, serverMinVersionNotice, serverVersionUpgradeNotice } from "../src/upgrade";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CLI↔worker version negotiation (issue #137)", () => {
  test("every REST call announces the client version via x-ap-client-version", async () => {
    let seen: string | null = "MISSING";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      seen = req.headers.get("x-ap-client-version");
      return Response.json({ version: "dev", commit: "unknown", deployed_at: null, min_client_version: "0.2.0" });
    }) as typeof fetch;

    await fetchServerVersion("https://ap.test");
    expect(seen).toBe(RUNNING_VERSION);
  });

  test("fetchServerVersion parses the endpoint and tolerates a legacy server (missing fields)", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        version: "0.2.94",
        commit: "abc",
        deployed_at: "2026-07-11T00:00:00Z",
        min_client_version: "0.3.0",
        min_client_enforced: true,
      })) as typeof fetch;
    expect(await fetchServerVersion("https://ap.test")).toEqual({
      version: "0.2.94",
      commit: "abc",
      deployed_at: "2026-07-11T00:00:00Z",
      min_client_version: "0.3.0",
      min_client_enforced: true,
    });

    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({})) as typeof fetch;
    const legacy = await fetchServerVersion("https://ap.test");
    expect(legacy.min_client_version).toBe("0.0.0");
    expect(legacy.min_client_enforced).toBe(false);
  });

  test("serverMinVersionNotice fires only when the running version is below the declared floor", () => {
    // 低于下限 → 生成升级提示（对齐 cli_upgrade 的 ask_user 流）
    const below = serverMinVersionNotice("9.9.9", false, { runningVersion: "0.2.60" });
    expect(below).not.toBeNull();
    expect(below?.action_required).toBe("ask_user");
    expect(below?.min_client_version).toBe("9.9.9");
    expect(below?.running_version).toBe("0.2.60");
    expect(below?.enforced).toBe(false);
    expect(below?.command).toContain("install.sh");

    // 等于/高于下限 → 无提示
    expect(serverMinVersionNotice("0.2.60", false, { runningVersion: "0.2.60" })).toBeNull();
    expect(serverMinVersionNotice("0.2.0", false, { runningVersion: "0.2.94" })).toBeNull();

    // enforced 标透传，并改用「已被拒绝」的措辞
    const enforced = serverMinVersionNotice("9.9.9", true, { runningVersion: "0.2.60" });
    expect(enforced?.enforced).toBe(true);
    expect(enforced?.message).toContain("拒绝");
  });

  test("serverVersionUpgradeNotice asks the agent to notify its owner when the deployed release is newer (#485)", () => {
    const notice = serverVersionUpgradeNotice("v0.2.108", { runningVersion: "0.2.107" });
    expect(notice).toMatchObject({
      running_version: "0.2.107",
      available_version: "0.2.108",
      auto_upgrade: false,
      action_required: "ask_user",
    });
    expect(notice?.installed_version).toBeUndefined();
    expect(notice?.message).toContain("主动提醒 owner 升级");
    expect(notice?.command).toContain("install.sh");

    expect(serverVersionUpgradeNotice("0.2.107", { runningVersion: "0.2.107" })).toBeNull();
    expect(serverVersionUpgradeNotice("0.2.106", { runningVersion: "0.2.107" })).toBeNull();
    expect(serverVersionUpgradeNotice("dev", { runningVersion: "0.2.107" })).toBeNull();
  });
});
