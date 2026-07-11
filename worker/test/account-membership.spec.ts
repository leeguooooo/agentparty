// 会员骨架（#277）：账号默认 free；owner（ADMIN_SECRET）手动开通翻到 member + 记 member_since；
// 非 admin 不能开通；/api/me 回显 tier。不测定价/支付/feature-gating（本次不做）。
import { describe, expect, it } from "vitest";
import { ADMIN_HEADERS, api, seedToken, uniq } from "./helpers";
import { SELF } from "cloudflare:test";

function activate(account: string, tier: "free" | "member", headers: Record<string, string> = ADMIN_HEADERS) {
  return SELF.fetch("http://ap.test/api/admin/membership", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ account, tier }),
  });
}

describe("account membership (#277 scaffold)", () => {
  it("一个新账号默认是 free（GET /api/me）", async () => {
    const owner = uniq("acct");
    const { token } = await seedToken("human", uniq("tok-human"), { owner });
    const me = await api("/api/me", token);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { membership_tier: string; member_since: number | null };
    expect(body.membership_tier).toBe("free");
    expect(body.member_since).toBeNull();
  });

  it("admin 开通把账号翻成 member 并盖上 member_since", async () => {
    const owner = uniq("acct");
    const { token } = await seedToken("human", uniq("tok-human"), { owner });

    const before = Date.now();
    const res = await activate(owner, "member");
    expect(res.status).toBe(200);
    const activated = (await res.json()) as { account: string; tier: string; member_since: number };
    expect(activated.account).toBe(owner);
    expect(activated.tier).toBe("member");
    expect(activated.member_since).toBeGreaterThanOrEqual(before);

    const me = await api("/api/me", token);
    const body = (await me.json()) as { membership_tier: string; member_since: number | null };
    expect(body.membership_tier).toBe("member");
    expect(body.member_since).toBe(activated.member_since);
  });

  it("非 admin（普通 bearer / 错误 secret）不能开通", async () => {
    const owner = uniq("acct");
    const { token } = await seedToken("human", uniq("tok-human"), { owner });

    // 错误的 admin secret → 401
    const wrong = await activate(owner, "member", { "x-admin-secret": "nope" });
    expect(wrong.status).toBe(401);

    // 普通 bearer token（无 admin secret）也不能开通自己 → 401
    const asBearer = await SELF.fetch("http://ap.test/api/admin/membership", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ account: owner, tier: "member" }),
    });
    expect(asBearer.status).toBe(401);

    // 仍是 free
    const me = await api("/api/me", token);
    const body = (await me.json()) as { membership_tier: string };
    expect(body.membership_tier).toBe("free");
  });

  it("重复开通保留最初的 member_since（幂等，不重置开通时间）", async () => {
    const owner = uniq("acct");
    const first = (await (await activate(owner, "member")).json()) as { member_since: number };
    const again = (await (await activate(owner, "member")).json()) as { member_since: number };
    expect(again.member_since).toBe(first.member_since);
  });

  it("降级回 free 清掉 member_since", async () => {
    const owner = uniq("acct");
    await activate(owner, "member");
    const downgraded = (await (await activate(owner, "free")).json()) as { tier: string; member_since: number | null };
    expect(downgraded.tier).toBe("free");
    expect(downgraded.member_since).toBeNull();
  });

  it("拒绝非法 tier", async () => {
    const owner = uniq("acct");
    const res = await activate(owner, "gold" as "member");
    expect(res.status).toBe(400);
  });

  it("拒绝缺失/空 account", async () => {
    const res = await SELF.fetch("http://ap.test/api/admin/membership", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ tier: "member" }),
    });
    expect(res.status).toBe(400);
  });
});
