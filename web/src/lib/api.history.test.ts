// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { AuthError, fetchMessages, fetchMessagesWithRetry } from "./api";

const original = Object.getOwnPropertyDescriptor(globalThis, "fetch");

afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, "fetch");
  else Object.defineProperty(globalThis, "fetch", original);
});

function mockResponses(responses: Response[]): { calls: () => number } {
  let count = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => responses[count++] ?? responses.at(-1),
  });
  return { calls: () => count };
}

describe("fetchMessagesWithRetry", () => {
  test("recovers from one transient initial-history failure", async () => {
    const mock = mockResponses([
      new Response("temporary", { status: 503 }),
      Response.json({ messages: [{ type: "msg", seq: 7, body: "recovered" }] }),
    ]);

    const messages = await fetchMessagesWithRetry("tok", "demo", { limit: 50 }, {
      attempts: 2,
      delayMs: 0,
    });

    expect(mock.calls()).toBe(2);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.seq).toBe(7);
  });

  test("does not retry authentication failures", async () => {
    const mock = mockResponses([new Response("unauthorized", { status: 401 })]);

    await expect(fetchMessagesWithRetry("tok", "demo", {}, { attempts: 2, delayMs: 0 }))
      .rejects.toBeInstanceOf(AuthError);
    expect(mock.calls()).toBe(1);
  });

  test("stops after the bounded attempt count", async () => {
    const mock = mockResponses([new Response("temporary", { status: 503 })]);

    await expect(fetchMessagesWithRetry("tok", "demo", {}, { attempts: 2, delayMs: 0 }))
      .rejects.toThrow("failed (503)");
    expect(mock.calls()).toBe(2);
  });
});

describe("fetchMessages around-seq window", () => {
  test("requests a bounded window anchored on the target seq", async () => {
    const urls: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request) => {
        urls.push(String(input));
        return Response.json({ messages: [] });
      },
    });

    await fetchMessages("tok", "demo", { around: 42, limit: 25 });

    expect(urls).toHaveLength(1);
    const requested = urls[0]!;
    expect(requested).toContain("/api/channels/demo/messages?");
    const search = new URLSearchParams(requested.slice(requested.indexOf("?") + 1));
    expect(search.get("around")).toBe("42");
    expect(search.get("limit")).toBe("25");
  });
});
