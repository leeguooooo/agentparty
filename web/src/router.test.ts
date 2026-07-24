// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { expect, test } from "bun:test";
import { matchPair, routeNavigationTarget } from "./router";

test("matches only the independent pair page route", () => {
  expect(matchPair("/pair")).toBe(true);
  expect(matchPair("/pair/")).toBe(true);
  expect(matchPair("/pair/AB12C-DE34F")).toBe(false);
  expect(matchPair("/repair")).toBe(false);
});

test("cross-channel navigation keeps only the share credential", () => {
  expect(routeNavigationTarget(
    "/c/next",
    "?agent=alice&agentMode=except&agentKind=agent",
  )).toBe("/c/next");
  expect(routeNavigationTarget(
    "/c/next",
    "?t=watch-secret&agent=alice&agentKind=agent",
  )).toBe("/c/next?t=watch-secret");
  expect(routeNavigationTarget(
    "/c/next?agent=bob",
    "?t=watch-secret&agent=alice",
  )).toBe("/c/next?agent=bob");
});
