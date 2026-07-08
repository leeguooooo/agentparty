import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_HEADERS, api, seedToken, uniq } from "./helpers";

// P1 起 owner 必填（spec §6）：铸 token 一律带归属账号
function mint(name: string, role: string, headers: Record<string, string> = ADMIN_HEADERS) {
  return SELF.fetch("http://ap.test/api/tokens", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name, role, owner: "leo@leeguoo.com" }),
  });
}

describe("tokens", () => {
  it("mints a token usable as bearer", async () => {
    const name = uniq("mint");
    const res = await mint(name, "agent");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; name: string; role: string };
    expect(body.token).toMatch(/^ap_[0-9a-f]{32}$/);
    expect(body.name).toBe(name);
    expect(body.role).toBe("agent");
    const list = await api("/api/channels", body.token);
    expect(list.status).toBe(200);
  });

  it("rejects a bad admin secret", async () => {
    const res = await mint(uniq("bad"), "agent", { "x-admin-secret": "wrong" });
    expect(res.status).toBe(401);
  });

  it("409 on duplicate active name", async () => {
    const name = uniq("dup");
    expect((await mint(name, "agent")).status).toBe(201);
    expect((await mint(name, "human")).status).toBe(409);
  });

  it("revocation invalidates the token and frees the name", async () => {
    const { token, name } = await seedToken("agent");
    expect((await api("/api/channels", token)).status).toBe(200);
    const del = await SELF.fetch(`http://ap.test/api/tokens/${name}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(del.status).toBe(200);
    expect((await api("/api/channels", token)).status).toBe(401);
    expect((await mint(name, "agent")).status).toBe(201);
    // 继承 vitest.config 的全局 20_000（此前的 15_000 覆盖在 CI 单 workerd 满载 + 新增 DO
    // schema 冷启下会偶发超时，见 #43）
  });

  it("404 on revoking an unknown token", async () => {
    const res = await SELF.fetch(`http://ap.test/api/tokens/${uniq("ghost")}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("rejects reserved names like system so webhooks can't be silenced", async () => {
    const res = await mint("system", "agent");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("reserved");
    // 普通名不受影响
    expect((await mint(uniq("normal"), "agent")).status).toBe(201);
  });

  it("rejects an unknown bearer token", async () => {
    const res = await api("/api/channels", "ap_deadbeefdeadbeefdeadbeefdeadbeef");
    expect(res.status).toBe(401);
  });

  // 反向唯一性（Task A5）：human 账号先占了某个 handle，之后铸一个同名的 token 必须 409——
  // handle 与 token name 共用 @ 命名空间，两个方向都得挡撞车。
  it("409 when minting a token whose name collides with an existing handle", async () => {
    const handle = uniq("leohandle");
    const owner = uniq("acct");
    const { token: humanToken } = await seedToken("human", uniq("tok-human"), { owner });

    const put = await api("/api/me/handle", humanToken, {
      method: "PUT",
      body: JSON.stringify({ handle }),
    });
    expect(put.status).toBe(200);

    const res = await mint(handle, "agent");
    expect(res.status).toBe(409);
  });
});
