import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiBase, apiOrigin, apiUrl, clearApiBase, setApiBase, wsUrl } from "./base";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } });
});

afterEach(() => {
  clearApiBase();
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("api base", () => {
  test("defaults to browser-relative URLs", () => {
    clearApiBase();

    expect(apiBase()).toBe("");
    expect(apiUrl("/api/me")).toBe("/api/me");
  });

  test("normalizes and applies a runtime API base", () => {
    setApiBase("https://agentparty.pwtk-dev.work///");

    expect(apiBase()).toBe("https://agentparty.pwtk-dev.work");
    expect(apiOrigin("tauri://localhost")).toBe("https://agentparty.pwtk-dev.work");
    expect(apiUrl("/api/channels")).toBe("https://agentparty.pwtk-dev.work/api/channels");
  });

  test("falls back to the supplied browser origin for same-origin web deployments", () => {
    clearApiBase();

    expect(apiOrigin("https://party.example.com")).toBe("https://party.example.com");
  });

  test("derives websocket URLs from the configured API base", () => {
    setApiBase("https://agentparty.leeguoo.com");

    expect(wsUrl("/api/channels/demo/ws?t=abc")).toBe("wss://agentparty.leeguoo.com/api/channels/demo/ws?t=abc");
  });

  test("keeps the active runtime base in memory when storage is unavailable", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: () => { throw new Error("storage unavailable"); },
        setItem: () => { throw new Error("storage unavailable"); },
        removeItem: () => { throw new Error("storage unavailable"); },
      },
    });

    setApiBase("https://party.example.com");
    expect(apiBase()).toBe("https://party.example.com");
    expect(apiUrl("/api/me")).toBe("https://party.example.com/api/me");
    expect(wsUrl("/api/ws")).toBe("wss://party.example.com/api/ws");
  });
});
