// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { isNearBottom, pinToBottom } from "./scrollPin";

describe("channel stream bottom pinning", () => {
  test("treats the final 160px as sticky-bottom territory", () => {
    expect(isNearBottom({ scrollTop: 740, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
    expect(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
  });

  test("pins after layout growth only while the user remains in sticky-bottom mode", () => {
    const pinned = { scrollTop: 800, scrollHeight: 1200, clientHeight: 200 };
    expect(pinToBottom(pinned, true)).toBe(true);
    expect(pinned.scrollTop).toBe(1000);

    const readingHistory = { scrollTop: 300, scrollHeight: 1200, clientHeight: 200 };
    expect(pinToBottom(readingHistory, false)).toBe(false);
    expect(readingHistory.scrollTop).toBe(300);
  });
});
