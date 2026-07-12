// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { beforeEach, describe, expect, test } from "bun:test";
import { __resetDesktopPairingSingleFlightsForTests } from "./desktopPairing";
import type { DesktopCredentialVault } from "./desktopCredentials";
import {
  classifyDesktopRestoreFailure,
  initialTokenForRuntime,
  restoreDesktopAccess,
  restoreDesktopAccessInteractive,
} from "./desktopAuth";

describe("desktop app authentication integration", () => {
  beforeEach(() => __resetDesktopPairingSingleFlightsForTests());

  test("never reads the browser token store in desktop mode", () => {
    let browserReads = 0;
    expect(initialTokenForRuntime(true, () => {
      browserReads += 1;
      return "browser-token";
    })).toBeNull();
    expect(browserReads).toBe(0);

    expect(initialTokenForRuntime(false, () => "browser-token")).toBe("browser-token");
  });

  test("deduplicates StrictMode startup refresh calls", async () => {
    let reads = 0;
    let requests = 0;
    const vault: DesktopCredentialVault = {
      read: async () => {
        reads += 1;
        return {
          refreshToken: "refresh",
          deviceSecret: "device-secret",
          serverOrigin: "https://agentparty.leeguoo.com",
          sessionId: "session-1",
        };
      },
      authorize: async () => null,
      write: async () => {},
      writeInteractive: async () => {},
      delete: async () => {},
      deleteInteractive: async () => {},
    };
    const fetcher = async () => {
      requests += 1;
      await Promise.resolve();
      return new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh-next",
        expires_in: 600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const first = restoreDesktopAccess(vault, "https://agentparty.leeguoo.com", fetcher);
    const second = restoreDesktopAccess(vault, "https://agentparty.leeguoo.com", fetcher);
    expect(first).toBe(second);
    expect(await second).toBe("access");
    expect(reads).toBe(1);
    expect(requests).toBe(1);
  });

  test("uses the interactive Keychain path only after an explicit recovery action", async () => {
    let reads = 0;
    let authorizations = 0;
    const vault: DesktopCredentialVault = {
      read: async () => {
        reads += 1;
        return null;
      },
      authorize: async () => {
        authorizations += 1;
        return null;
      },
      write: async () => {},
      writeInteractive: async () => {},
      delete: async () => {},
      deleteInteractive: async () => {},
    };

    expect(await restoreDesktopAccessInteractive(
      vault,
      "https://agentparty.leeguoo.com",
      async () => new Response(null, { status: 500 }),
    )).toBeNull();
    expect(reads).toBe(0);
    expect(authorizations).toBe(1);
  });

  test("only classifies the native authorization sentinel as a Keychain recovery", () => {
    expect(classifyDesktopRestoreFailure("desktop_keychain_authorization_required")).toBe("keychain-authorization");
    expect(classifyDesktopRestoreFailure(new Error("desktop_keychain_authorization_required"))).toBe("keychain-authorization");
    expect(classifyDesktopRestoreFailure(new TypeError("offline"))).toBe("retryable");
    expect(classifyDesktopRestoreFailure(new Error("desktop session refresh failed (503)"))).toBe("retryable");
  });
});
