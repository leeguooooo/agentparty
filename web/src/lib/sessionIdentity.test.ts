// #126 follow-up 安全修复：jwtSub + gateSession 的纯状态机测试。
import { describe, expect, test } from "bun:test";
import { gateSession, jwtSub, resolvedSessionIdentity, sessionIdentityOf } from "./sessionIdentity";

// 造一个 payload 为 {sub} 的假 JWT（不签名——jwtSub 只解不验）。
// 先 UTF-8 编码再 btoa：payload 里可能有非 ASCII（如中文 sub），btoa 本身只吃 Latin1，
// 直接喂 JSON 字符串会抛 InvalidCharacterError——这里的编码方式要对得上 decodeSegment 的解码方式。
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
}
const NOW = 1_000_000;
const fresh = (over = {}) => ({ accessToken: "at", refreshToken: "rt", expiresAt: NOW + 3600, ...over });

describe("jwtSub", () => {
  test("合法 JWT 解出 sub", () => {
    expect(jwtSub(fakeJwt({ sub: "user-1" }))).toBe("user-1");
  });
  test("payload 无 sub 字段 → null", () => {
    expect(jwtSub(fakeJwt({ name: "no sub here" }))).toBeNull();
  });
  test("只有 2 段（非 JWT 结构）→ null", () => {
    const twoSeg = fakeJwt({ sub: "user-1" }).split(".").slice(0, 2).join(".");
    expect(jwtSub(twoSeg)).toBeNull();
  });
  test("非字符串输入 → null", () => {
    expect(jwtSub(null)).toBeNull();
    expect(jwtSub(undefined)).toBeNull();
  });
  test("payload 段 base64 乱码 → null", () => {
    expect(jwtSub("aaa.###not-base64###.sig")).toBeNull();
  });
  test("sub 为空串 → null", () => {
    expect(jwtSub(fakeJwt({ sub: "" }))).toBeNull();
  });
  test("sub 含非 ASCII（如中文用户名）→ 正确解出", () => {
    expect(jwtSub(fakeJwt({ sub: "用户-1" }))).toBe("用户-1");
  });
});

describe("sessionIdentityOf", () => {
  test("有 identity → 原值", () => {
    expect(sessionIdentityOf({ identity: "user-1" })).toBe("user-1");
  });
  test("旧 session 无该字段 → null", () => {
    expect(sessionIdentityOf({ accessToken: "at" })).toBeNull();
  });
  test("null → null", () => {
    expect(sessionIdentityOf(null)).toBeNull();
  });
});

describe("resolvedSessionIdentity（I1 修复：身份比对用，落盘优先，缺失时从 access token 派生）", () => {
  test("落盘有值 → 原值（即便 accessToken 的 sub 不同，也不去解它）", () => {
    expect(
      resolvedSessionIdentity({ identity: "user-1", accessToken: fakeJwt({ sub: "user-2" }) }),
    ).toBe("user-1");
  });
  test("旧 session 无字段但 accessToken 是带 sub 的 JWT → 解出该 sub", () => {
    expect(resolvedSessionIdentity({ accessToken: fakeJwt({ sub: "user-1" }) })).toBe("user-1");
  });
  test("accessToken 不透明（非 JWT）且无字段 → null", () => {
    expect(resolvedSessionIdentity({ accessToken: "opaque-at" })).toBeNull();
  });
  test("null → null", () => {
    expect(resolvedSessionIdentity(null)).toBeNull();
  });
});

describe("gateSession（#126 + I1/I3 修复后边界矩阵，nowSec = NOW）", () => {
  test("session 为 null → none", () => {
    expect(gateSession(null, "user-1", NOW)).toBe("none");
  });
  test("accessToken 为 null → none", () => {
    expect(gateSession({ accessToken: null }, "user-1", NOW)).toBe("none");
  });

  // --- I1 回归：旧 session（无落盘 identity）的身份要从 access token 的 sub 派生，
  // 不能因为落盘字段缺失就放行到 refresh —— 否则跨身份的旧 session 会被拿去续期。
  test("旧 session 无 identity、accessToken 的 sub 是另一身份 → foreign（I1 回归：跨身份旧 session 禁止 refresh）", () => {
    const sess = fresh({ identity: undefined, accessToken: fakeJwt({ sub: "user-2" }) });
    expect(gateSession(sess, "user-1", NOW)).toBe("foreign");
  });
  test("旧 session 无 identity、accessToken 的 sub 与 currentIdentity 相同、很新鲜 → refresh（不是 adopt：落盘字段缺失时禁止 adopt）", () => {
    const sess = fresh({ identity: undefined, accessToken: fakeJwt({ sub: "user-1" }) });
    expect(gateSession(sess, "user-1", NOW)).toBe("refresh");
  });
  test("旧 session 无 identity、accessToken 的 sub 与 currentIdentity 相同、无 refreshToken → none", () => {
    const sess = fresh({ identity: undefined, accessToken: fakeJwt({ sub: "user-1" }), refreshToken: null });
    expect(gateSession(sess, "user-1", NOW)).toBe("none");
  });
  test("双方都解不出身份（accessToken 不透明 + currentIdentity=null）+ 有 refreshToken → refresh", () => {
    const sess = fresh({ identity: undefined, accessToken: "opaque-at" });
    expect(gateSession(sess, null, NOW)).toBe("refresh");
  });
  test("双方都解不出身份（accessToken 不透明 + currentIdentity=null）+ 无 refreshToken → none", () => {
    const sess = fresh({ identity: undefined, accessToken: "opaque-at", refreshToken: null });
    expect(gateSession(sess, null, NOW)).toBe("none");
  });
  test("identity 有值但 currentIdentity 为 null → foreign（无法证明同身份，一步都不碰）", () => {
    expect(gateSession(fresh({ identity: "user-1" }), null, NOW)).toBe("foreign");
  });
  test("identity ≠ currentIdentity 且很新鲜 → foreign（跨身份回归：新鲜也不许 adopt）", () => {
    expect(gateSession(fresh({ identity: "user-2" }), "user-1", NOW)).toBe("foreign");
  });
  test("identity === currentIdentity 且新鲜 → adopt（同身份回归）", () => {
    expect(gateSession(fresh({ identity: "user-1" }), "user-1", NOW)).toBe("adopt");
  });
  test("identity === currentIdentity 但已过期 + 有 refreshToken → refresh", () => {
    expect(gateSession(fresh({ identity: "user-1", expiresAt: NOW - 1 }), "user-1", NOW)).toBe("refresh");
  });
  test("identity === currentIdentity 但已过期 + 无 refreshToken → none", () => {
    expect(
      gateSession(fresh({ identity: "user-1", expiresAt: NOW - 1, refreshToken: null }), "user-1", NOW),
    ).toBe("none");
  });
  test("SKEW 边界：expiresAt = NOW + 30 恰好不算新鲜 → 同身份下应为 refresh", () => {
    expect(gateSession(fresh({ identity: "user-1", expiresAt: NOW + 30 }), "user-1", NOW)).toBe("refresh");
  });
  test("SKEW 边界：expiresAt = NOW + 31 → adopt", () => {
    expect(gateSession(fresh({ identity: "user-1", expiresAt: NOW + 31 }), "user-1", NOW)).toBe("adopt");
  });
});
