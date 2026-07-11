// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetDesktopUiForTests,
  parseDesktopUiIdentity,
  reportDesktopUiReady,
  type DesktopUiRuntime,
} from "./desktopUi";

const identity = {
  buildId: "0123456789abcdef0123456789abcdef01234567",
  uiAbi: 1,
};

function runtime(overrides: Partial<DesktopUiRuntime> = {}): DesktopUiRuntime {
  return {
    isDesktop: () => true,
    readIdentity: () => identity,
    invokeReady: async () => {},
    ...overrides,
  };
}

beforeEach(() => __resetDesktopUiForTests());

describe("desktop UI ready handshake", () => {
  test("accepts only a complete shell-injected identity", () => {
    expect(parseDesktopUiIdentity(identity)).toEqual(identity);
    expect(parseDesktopUiIdentity({ buildId: "main", uiAbi: 1 })).toBeNull();
    expect(parseDesktopUiIdentity({ buildId: identity.buildId, uiAbi: 0 })).toBeNull();
    expect(parseDesktopUiIdentity({ buildId: identity.buildId, uiAbi: 1, origin: "https://evil.example" })).toBeNull();
  });

  test("does nothing in a browser runtime", async () => {
    let calls = 0;
    expect(await reportDesktopUiReady(runtime({
      isDesktop: () => false,
      invokeReady: async () => { calls += 1; },
    }))).toBe(false);
    expect(calls).toBe(0);
  });

  test("reports each build once even when calls overlap", async () => {
    let calls = 0;
    const value = runtime({ invokeReady: async () => { calls += 1; } });
    expect(await Promise.all([
      reportDesktopUiReady(value),
      reportDesktopUiReady(value),
      reportDesktopUiReady(value),
    ])).toEqual([true, true, true]);
    expect(calls).toBe(1);
  });

  test("allows retry after a native failure", async () => {
    let calls = 0;
    const value = runtime({
      invokeReady: async () => {
        calls += 1;
        if (calls === 1) throw new Error("native unavailable");
      },
    });
    expect(await reportDesktopUiReady(value)).toBe(false);
    expect(await reportDesktopUiReady(value)).toBe(true);
    expect(calls).toBe(2);
  });
});
