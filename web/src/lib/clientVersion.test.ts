// #434：发送方 CLI 版本比较 + 落后判定。规则须与 worker/src/client-version.ts 一致（只认前三段数字）。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { compareClientVersions, isClientVersionOutdated } from "./clientVersion";

describe("compareClientVersions (#434)", () => {
  test("按前三段数字比较", () => {
    expect(compareClientVersions("0.3.1", "0.3.0")).toBe(1);
    expect(compareClientVersions("0.2.9", "0.3.0")).toBe(-1);
    expect(compareClientVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("忽略预发行后缀（第四段及 -beta 等）", () => {
    expect(compareClientVersions("0.3.1-beta.2", "0.3.1")).toBe(0);
    expect(compareClientVersions("0.3.1", "0.3.1-rc.1")).toBe(0);
  });

  test("缺段按 0 补齐", () => {
    expect(compareClientVersions("1", "1.0.0")).toBe(0);
    expect(compareClientVersions("1.2", "1.2.0")).toBe(0);
  });
});

describe("isClientVersionOutdated (#434)", () => {
  test("严格低于最低版本 → 落后", () => {
    expect(isClientVersionOutdated("0.2.0", "0.3.0")).toBe(true);
  });

  test("等于或高于最低版本 → 不落后", () => {
    expect(isClientVersionOutdated("0.3.0", "0.3.0")).toBe(false);
    expect(isClientVersionOutdated("0.4.0", "0.3.0")).toBe(false);
  });

  test("版本或下限未知 → 一律不判落后（不误伤）", () => {
    expect(isClientVersionOutdated(null, "0.3.0")).toBe(false);
    expect(isClientVersionOutdated("0.2.0", null)).toBe(false);
    expect(isClientVersionOutdated(undefined, undefined)).toBe(false);
  });
});
