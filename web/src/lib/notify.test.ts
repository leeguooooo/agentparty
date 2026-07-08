import { test, expect } from "bun:test";
import { shouldNotify } from "./notify";
const base = (over = {}) => ({ type:"msg", kind:"message", seq:5, mentions:["leo"], retracted:undefined,
  sender:{name:"bob",kind:"agent"}, body:"hi @leo", ...over } as any);

test("被@ + 隐藏 + 已授权 → true", () => {
  expect(shouldNotify(base(), "leo", true, true)).toBe(true);
});
test("标签页可见 → false", () => {
  expect(shouldNotify(base(), "leo", false, true)).toBe(false);
});
test("未授权 → false", () => {
  expect(shouldNotify(base(), "leo", true, false)).toBe(false);
});
test("没@我 → false", () => {
  expect(shouldNotify(base({mentions:["carol"]}), "leo", true, true)).toBe(false);
});
test("我没 handle → false", () => {
  expect(shouldNotify(base(), null, true, true)).toBe(false);
});
test("已撤回 / status / 自己发 → false", () => {
  expect(shouldNotify(base({retracted:true}), "leo", true, true)).toBe(false);
  expect(shouldNotify(base({kind:"status"}), "leo", true, true)).toBe(false);
  expect(shouldNotify(base({sender:{name:"leo",kind:"human",handle:"leo"}}), "leo", true, true)).toBe(false);
});
