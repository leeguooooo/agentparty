// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import {
  createInvokeCredentialVault,
  finishDesktopPairing,
  logoutDesktopSession,
  refreshDesktopSession,
  refreshDesktopSessionInteractive,
  migrateLegacyDesktopCredential,
  type DesktopCredential,
  type DesktopCredentialVault,
} from "./desktopCredentials";

function memoryVault(initial: DesktopCredential | null = null) {
  let credential = initial;
  const writes: DesktopCredential[] = [];
  let deletes = 0;
  const vault: DesktopCredentialVault = {
    read: async () => credential,
    authorize: async () => credential,
    write: async (next) => {
      credential = next;
      writes.push(next);
    },
    writeInteractive: async (next) => {
      credential = next;
      writes.push(next);
    },
    delete: async () => {
      credential = null;
      deletes += 1;
    },
    deleteInteractive: async () => {
      credential = null;
      deletes += 1;
    },
  };
  return { vault, writes, deletes: () => deletes };
}

describe("desktop secure credentials", () => {
  test("round-trips the credential through native commands", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let stored: string | null = null;
    const vault = createInvokeCredentialVault("https://agentparty.leeguoo.com", async (command, args) => {
      calls.push({ command, args });
      if (command === "desktop_credential_read") return stored;
      if (command === "desktop_credential_authorize") return stored;
      if (command === "desktop_credential_write") stored = String(args?.credential);
      if (command === "desktop_credential_write_interactive") stored = String(args?.credential);
      if (command === "desktop_credential_delete") stored = null;
      if (command === "desktop_credential_delete_interactive") stored = null;
      return null;
    });
    const credential: DesktopCredential = {
      refreshToken: "refresh",
      deviceSecret: "device-secret",
      serverOrigin: "https://agentparty.leeguoo.com",
      sessionId: "session-1",
    };

    await vault.write(credential);
    await vault.writeInteractive(credential);
    expect(await vault.read()).toEqual(credential);
    expect(await vault.authorize()).toEqual(credential);
    await vault.delete();
    await vault.deleteInteractive();
    expect(await vault.read()).toBeNull();
    expect(calls.map((call) => call.command)).toEqual([
      "desktop_credential_write",
      "desktop_credential_write_interactive",
      "desktop_credential_read",
      "desktop_credential_authorize",
      "desktop_credential_delete",
      "desktop_credential_delete_interactive",
      "desktop_credential_read",
    ]);
    expect(calls.every((call) => call.args?.origin === "https://agentparty.leeguoo.com")).toBe(true);
  });

  test("isolates native credential slots by normalized server origin", async () => {
    const slots = new Map<string, string>();
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      const origin = String(args?.origin);
      if (command === "desktop_credential_write") slots.set(origin, String(args?.credential));
      if (command === "desktop_credential_delete") slots.delete(origin);
      return command === "desktop_credential_read" ? slots.get(origin) ?? null : null;
    };
    const prod = createInvokeCredentialVault("https://agentparty.leeguoo.com", invoke);
    const privateServer = createInvokeCredentialVault("https://party.example.com", invoke);
    await prod.write({ refreshToken: "prod", deviceSecret: "prod-secret", serverOrigin: "https://agentparty.leeguoo.com", sessionId: null });
    await privateServer.write({ refreshToken: "private", deviceSecret: "private-secret", serverOrigin: "https://party.example.com", sessionId: null });

    expect((await prod.read())?.refreshToken).toBe("prod");
    expect((await privateServer.read())?.refreshToken).toBe("private");
    expect(slots).toHaveLength(2);
  });

  test("invokes the idempotent native legacy migration once at startup", async () => {
    const calls: string[] = [];
    const origin = await migrateLegacyDesktopCredential(async (command) => {
      calls.push(command);
      return "https://agentparty.leeguoo.com";
    });
    expect(origin).toBe("https://agentparty.leeguoo.com");
    expect(calls).toEqual(["desktop_credential_migrate"]);
  });

  test("persists refresh token and device secret but never the access token", async () => {
    const secure = memoryVault();
    const originalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new Proxy({}, { get: () => { throw new Error("localStorage must not be touched"); } }),
    });
    try {
      const access = await finishDesktopPairing({
        access_token: "access-only-in-memory",
        refresh_token: "refresh-in-keychain",
        expires_in: 600,
        session_id: "session-1",
      }, "device-secret", "https://agentparty.leeguoo.com", secure.vault);

      expect(access).toBe("access-only-in-memory");
      expect(secure.writes).toEqual([{
        refreshToken: "refresh-in-keychain",
        deviceSecret: "device-secret",
        serverOrigin: "https://agentparty.leeguoo.com",
        sessionId: "session-1",
      }]);
      expect(JSON.stringify(secure.writes)).not.toContain("access-only-in-memory");
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: originalStorage });
    }
  });

  test("refreshes on startup and stores a rotated refresh token", async () => {
    const secure = memoryVault({
      refreshToken: "refresh-old",
      deviceSecret: "device-secret",
      serverOrigin: "https://agentparty.leeguoo.com",
      sessionId: "session-1",
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const access = await refreshDesktopSession(
      secure.vault,
      ["https://agentparty.leeguoo.com"],
      async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 600,
          session_id: "session-1",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    );

    expect(access).toBe("access-new");
    expect(requests[0]?.url).toBe("https://agentparty.leeguoo.com/api/desktop/sessions/refresh");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      refresh_token: "refresh-old",
      device_secret: "device-secret",
    });
    expect(secure.writes.at(-1)?.refreshToken).toBe("refresh-new");
    expect(JSON.stringify(secure.writes)).not.toContain("access-new");
  });

  test("allows an explicit recovery action to authorize Keychain access", async () => {
    const secure = memoryVault({
      refreshToken: "refresh-old",
      deviceSecret: "device-secret",
      serverOrigin: "https://agentparty.leeguoo.com",
      sessionId: "session-1",
    });
    let reads = 0;
    let authorizations = 0;
    let interactiveWrites = 0;
    const vault: DesktopCredentialVault = {
      ...secure.vault,
      read: async () => {
        reads += 1;
        throw new Error("automatic read must not be used");
      },
      authorize: async () => {
        authorizations += 1;
        return secure.vault.authorize();
      },
      writeInteractive: async (next) => {
        interactiveWrites += 1;
        await secure.vault.writeInteractive(next);
      },
    };

    const access = await refreshDesktopSessionInteractive(vault, ["https://agentparty.leeguoo.com"], async () => (
      new Response(JSON.stringify({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 600,
        session_id: "session-1",
      }), { status: 200, headers: { "content-type": "application/json" } })
    ));

    expect(access).toBe("access-new");
    expect(reads).toBe(0);
    expect(authorizations).toBe(1);
    expect(interactiveWrites).toBe(1);
    expect(secure.writes.at(-1)?.refreshToken).toBe("refresh-new");
  });
});

describe("desktop logout", () => {
  test("does not send credentials to a stored server outside the runtime allowlist", async () => {
    const secure = memoryVault({
      refreshToken: "refresh-token",
      deviceSecret: "device-secret",
      serverOrigin: "https://evil.example",
      sessionId: "session-1",
    });
    let requests = 0;
    const result = await logoutDesktopSession(secure.vault, async () => {
      requests += 1;
      return new Response(null, { status: 204 });
    }, ["https://agentparty.leeguoo.com"]);

    expect(result).toEqual({ revoked: false, removedOnly: true });
    expect(requests).toBe(0);
    expect(secure.deletes()).toBe(1);
  });

  test("revokes online before deleting the local credential", async () => {
    const order: string[] = [];
    const secure = memoryVault({
      refreshToken: "refresh-token",
      deviceSecret: "device-secret",
      serverOrigin: "https://agentparty.leeguoo.com",
      sessionId: "session-1",
    });
    const vault: DesktopCredentialVault = {
      ...secure.vault,
      delete: async () => {
        order.push("delete");
        await secure.vault.delete();
      },
    };
    const result = await logoutDesktopSession(vault, async (_url, init) => {
      order.push("revoke");
      expect(JSON.parse(String(init?.body))).toEqual({
        refresh_token: "refresh-token",
        device_secret: "device-secret",
      });
      return new Response(null, { status: 204 });
    });

    expect(result).toEqual({ revoked: true, removedOnly: false });
    expect(order).toEqual(["revoke", "delete"]);
  });

  test("still removes the local credential offline and reports device-only removal", async () => {
    const secure = memoryVault({
      refreshToken: "refresh-token",
      deviceSecret: "device-secret",
      serverOrigin: "https://agentparty.leeguoo.com",
      sessionId: null,
    });
    const result = await logoutDesktopSession(secure.vault, async () => {
      throw new TypeError("offline");
    });

    expect(result).toEqual({ revoked: false, removedOnly: true });
    expect(secure.deletes()).toBe(1);
  });
});
