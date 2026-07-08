import { describe, it, expect } from "vitest";
import { validateHandleFormat, HANDLE_RE } from "../src/handle";

describe("validateHandleFormat", () => {
  it("接受合法 handle", () => {
    expect(validateHandleFormat("leo")).toBe("leo");
    expect(validateHandleFormat("a1._-b")).toBe("a1._-b");
  });
  it("拒绝非法：大写/太短/太长/非法首字/非串", () => {
    expect(validateHandleFormat("Leo")).toBeNull();
    expect(validateHandleFormat("a")).toBeNull();
    expect(validateHandleFormat("-abc")).toBeNull();
    expect(validateHandleFormat("a".repeat(33))).toBeNull();
    expect(validateHandleFormat(123)).toBeNull();
  });
});
