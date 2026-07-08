// PUT /api/me/handle + GET /api/me 返回 handle（spec 2026-07-08，Task A4）：human 账号会话可设置/更新
// 自己的全局唯一 handle；撞已存在 token 名（含别的 agent token）时 409。
import { describe, expect, it } from "vitest";
import { api, seedToken, uniq } from "./helpers";

describe("PUT /api/me/handle + GET /api/me handle", () => {
  it("human 账号设置 handle 后，GET /api/me 回显该 handle", async () => {
    const owner = uniq("acct");
    const { token } = await seedToken("human", uniq("tok-human"), { owner });

    const put = await api("/api/me/handle", token, {
      method: "PUT",
      body: JSON.stringify({ handle: "leo" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ handle: "leo" });

    const me = await api("/api/me", token);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ handle: "leo" });
  });

  it("handle 撞已存在的 token 名时返回 409", async () => {
    // 名字须满足 HANDLE_RE（全小写字母数字，uniq() 生成的即是）才能验证「撞 token 名」这条冲突路径，
    // 而不是先撞 validateHandleFormat 的格式校验；不用字面量 "bob" 避免跟其它 spec 文件已铸的同名 token 撞车
    // （isolatedStorage: false，D1 在整个 vitest run 内跨文件共享）。
    const tokenName = uniq("agentname");
    await seedToken("agent", tokenName);

    const owner = uniq("acct");
    const { token } = await seedToken("human", uniq("tok-human"), { owner });

    const put = await api("/api/me/handle", token, {
      method: "PUT",
      body: JSON.stringify({ handle: tokenName }),
    });
    expect(put.status).toBe(409);
  });
});
