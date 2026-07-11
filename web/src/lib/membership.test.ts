// 会员骨架（#277）：申请入口纯逻辑 + isMember 钩子的判定。UI 渲染（chip / apply 链接）由 App 组件承载，
// 这里只钉住机制：默认 free、member 判定、mailto 预填账号。
import { describe, expect, test } from "bun:test";
import { isMember, normalizeTier } from "@agentparty/shared";
import type { MeInfo } from "./api";
import { MEMBERSHIP_CONTACT_EMAIL, membershipApplyMailto, membershipStatusOf } from "./membership";

function me(overrides: Partial<MeInfo> = {}): MeInfo {
  return {
    name: "human-a",
    email: "a@example.com",
    kind: "human",
    handle: "human-a",
    display_name: null,
    avatar_url: null,
    avatar_thumb: null,
    provider: null,
    tenant_key: null,
    role: "human",
    owner: null,
    ...overrides,
  };
}

describe("membership scaffold (#277)", () => {
  test("缺 membership_tier（旧 server）判定为 free", () => {
    expect(isMember(membershipStatusOf(me()))).toBe(false);
  });

  test("membership_tier=free 判定为 free", () => {
    expect(isMember(membershipStatusOf(me({ membership_tier: "free" })))).toBe(false);
  });

  test("membership_tier=member 判定为 member", () => {
    expect(isMember(membershipStatusOf(me({ membership_tier: "member" })))).toBe(true);
  });

  test("未知 tier 归一为 free（不误解锁）", () => {
    expect(normalizeTier("gold")).toBe("free");
    expect(isMember({ tier: "gold" })).toBe(false);
  });

  test("mailto 预填收件人、主题、正文（正文带上申请者账号）", () => {
    const url = membershipApplyMailto(me({ email: "leo@x.com" }), "Join", "Account: ");
    expect(url.startsWith(`mailto:${MEMBERSHIP_CONTACT_EMAIL}?`)).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("subject")).toBe("Join");
    expect(params.get("body")).toBe("Account: leo@x.com");
  });

  test("无 email 时 mailto 正文回落到 owner/handle/name", () => {
    const url = membershipApplyMailto(me({ email: null, owner: "acct-1", handle: null }), "s", "who=");
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("body")).toBe("who=acct-1");
  });
});
