// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { addChannelMember, kickParticipant } from "./lib/api";

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

afterEach(() => {
  if (originalFetch === undefined) Reflect.deleteProperty(globalThis, "fetch");
  else Object.defineProperty(globalThis, "fetch", originalFetch);
});

function respond(body: unknown): Request[] {
  const requests: Request[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(new URL(String(input), "https://web.test"), init));
      return Response.json(body);
    },
  });
  return requests;
}

describe("kickParticipant permanent removal response", () => {
  test("keeps an authoritative tombstone even when peer broadcast failed", async () => {
    const removal = { type: "participant_removed" as const, name: "former-agent", removed_at: 42 };
    const requests = respond({ ok: true, removal, broadcasted: false });

    await expect(kickParticipant("token", "private room", "former-agent", "remove")).resolves.toEqual({
      ok: true,
      removal,
      broadcasted: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toContain("/api/channels/private%20room/kick");
    expect(await requests[0]!.json()).toEqual({ name: "former-agent", mode: "remove" });
  });

  test("does not synthesize a tombstone after an authoritative same-name restore", async () => {
    respond({ ok: true, removal: null, broadcasted: false, restored: true });

    await expect(kickParticipant("token", "demo", "returning-agent", "remove")).resolves.toEqual({
      ok: true,
      removal: null,
      broadcasted: false,
      restored: true,
    });
  });

  test("restored wins closed over a contradictory stale removal payload", async () => {
    respond({
      ok: true,
      removal: { type: "participant_removed", name: "returning-agent", removed_at: 42 },
      broadcasted: false,
      restored: true,
    });

    await expect(kickParticipant("token", "demo", "returning-agent", "remove")).resolves.toMatchObject({
      removal: null,
      restored: true,
    });
  });

  test("does not trust a malformed or wrong-name removal payload", async () => {
    respond({
      ok: true,
      removal: { type: "participant_removed", name: "someone-else", removed_at: 99 },
      broadcasted: true,
    });

    await expect(kickParticipant("token", "demo", "target", "remove")).resolves.toEqual({
      ok: true,
      removal: null,
      broadcasted: true,
    });
  });
});

describe("addChannelMember restoration body", () => {
  test("sends the removed row name only for an explicit participant restore", async () => {
    const response = {
      account: "owner@example.com",
      added_by: "moderator@example.com",
      added_at: 42,
    };
    const requests = respond(response);

    await expect(
      addChannelMember("token", "private room", "owner@example.com", "former-agent"),
    ).resolves.toEqual(response);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.url).toContain(
      "/api/channels/private%20room/members/owner%40example.com",
    );
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer token");
    expect(requests[0]!.headers.get("content-type")).toBe("application/json");
    expect(await requests[0]!.json()).toEqual({ name: "former-agent" });
  });

  test("keeps an ordinary account add bodyless when no participant name is supplied", async () => {
    const requests = respond({
      account: "new@example.com",
      added_by: "moderator@example.com",
      added_at: 43,
    });

    await addChannelMember("token", "demo", "new@example.com");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.headers.get("content-type")).toBeNull();
    expect(await requests[0]!.text()).toBe("");
  });
});
