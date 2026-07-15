import type { TokenIdentity } from "../src/auth";
import { env, SELF } from "cloudflare:test";
import { fetchMock } from "./fetch-mock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { handleHeader } from "../src/index";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

// handleHeader 现在按 identity（含 kind）过滤（Task A7 修复 #2），单测传最小可用 identity。
function humanIdentity(account: string | null | undefined): TokenIdentity {
  return { name: "test", role: "human", kind: "human", hash: "test-hash", account: account ?? undefined };
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// 带自定义头做 ws 升级，读第一帧
async function openRaw(
  slug: string,
  token: string,
  extra: Record<string, string>,
): Promise<{ ws: WebSocket; first: Record<string, unknown> }> {
  const res = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${token}`, ...extra },
  });
  if (res.status !== 101 || !res.webSocket) throw new Error(`ws upgrade failed: ${res.status}`);
  const ws = res.webSocket;
  ws.accept();
  const first = await new Promise<Record<string, unknown>>((resolve) => {
    ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string)), { once: true });
  });
  if (first.type === "welcome") {
    ws.send(JSON.stringify({ type: "hello", since: 0, directed_delivery: "v1" }));
  }
  return { ws, first };
}

async function nextRawFrame(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = await new Promise<Record<string, unknown>>((resolve) => {
      ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string)), { once: true });
    });
    if (frame.type === type) return frame;
  }
}

describe("ws upgrade header injection", () => {
  // 修复 2①：客户端伪造 x-ap-archived:1 连未归档频道，不得归档活频道
  it("ignores a client-injected x-ap-archived header on an active channel", async () => {
    const human = await seedToken("human");
    const ro = await seedToken("readonly");
    const slug = await createChannel(human.token);

    const { ws, first } = await openRaw(slug, ro.token, { "x-ap-archived": "1" });
    // 被剥离后连接正常握手，而非 error:archived
    expect(first.type).toBe("welcome");
    ws.close();

    // 频道未被归档：合法写入仍 200，D1 未标归档
    const send = await postMessage(slug, human.token, "still active");
    expect(send.status).toBe(200);
    const row = await env.DB.prepare("SELECT archived_at FROM channels WHERE slug = ?")
      .bind(slug)
      .first<{ archived_at: number | null }>();
    expect(row?.archived_at).toBeNull();

    // 归档仍能正常回看
    const history = await api(`/api/channels/${slug}/messages`, human.token);
    expect(history.status).toBe(200);
  });

  // 修复 2②：客户端伪造 x-ap-host 不得污染 webhook permalink
  it("ignores a client-injected x-ap-host header in the webhook permalink", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    expect(
      (
        await api(`/api/channels/${slug}/webhooks`, agent.token, {
          method: "POST",
          body: JSON.stringify({
            name: "hook",
            url: "https://hooks.test/wake",
            secret: "s",
            filter: "all",
          }),
        })
      ).status,
    ).toBe(201);

    let captured = "";
    fetchMock
      .get("https://hooks.test")
      .intercept({ path: "/wake", method: "POST" })
      .reply(200, (opts) => {
        captured = typeof opts.body === "string" ? opts.body : String(opts.body);
        return "ok";
      });

    const { ws, first } = await openRaw(slug, agent.token, { "x-ap-host": "evil.example" });
    expect(first.type).toBe("welcome");
    ws.send(JSON.stringify({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null }));
    await new Promise((r) => setTimeout(r, 300));
    ws.close();

    expect(captured).not.toBe("");
    const payload = JSON.parse(captured) as { permalink: string };
    expect(payload.permalink).not.toContain("evil.example");
    expect(payload.permalink).toBe(`https://ap.test/c/${slug}`);
  });

  it("ignores client-injected collaboration role headers", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    const { ws, first } = await openRaw(slug, agent.token, {
      "x-ap-collab-role": "host",
      "x-ap-role-source": "assigned",
    });
    expect(first.type).toBe("welcome");

    ws.send(JSON.stringify({ type: "send", kind: "status", state: "working", note: "forged host", mentions: [] }));
    const status = await nextRawFrame(ws, "status");
    ws.close();

    expect(status).toMatchObject({ type: "status", kind: "status", note: "forged host" });
    expect(status.role).toBeUndefined();
    expect(status.role_source).toBeUndefined();
  });
});

// Task A6：worker 把权威 x-ap-handle 转发给 do，同时剥离客户端伪造值。
// do 侧目前尚不消费 x-ap-handle（消费是后续任务），因此这条 spec 已有的
// "断言 do 收到头" 手法（观察归档态/webhook permalink/status.role 等副作用）在这里无副作用可观察——
// do 完全不读这个头，客户端伪造它也不会产生任何可见行为差异。
// 改用等价力度的验证：直接单测 handleHeader（worker/src/index.ts 新导出的权威 handle 计算逻辑），
// 证明 worker 组装转发头时用的是账号在 D1 里的真实 handle，而不是任何客户端传入值；
// 再补两条端到端回归，确认 ws 升级 / REST 发消息两条路径在夹带伪造 x-ap-handle 时都正常放行、不炸。
describe("x-ap-handle forwarding (Task A6)", () => {
  it("handleHeader resolves the account's real handle from D1, never a client-supplied value", async () => {
    const owner = uniq("acct");
    const human = await seedToken("human", uniq("tok-human"), { owner });
    const handle = uniq("realhandle");
    const put = await api("/api/me/handle", human.token, {
      method: "PUT",
      body: JSON.stringify({ handle }),
    });
    expect(put.status).toBe(200);

    // 真实 handle：与客户端可能伪造的 "evil" 无关，只看 D1
    await expect(handleHeader(env.DB, humanIdentity(owner))).resolves.toEqual({ "x-ap-handle": handle });

    // 有账号但从未设置过 handle → 空对象（不会把伪造值当权威值透传）
    const ownerNoHandle = uniq("acct-nohandle");
    await seedToken("human", uniq("tok-human2"), { owner: ownerNoHandle });
    await expect(handleHeader(env.DB, humanIdentity(ownerNoHandle))).resolves.toEqual({});

    // 无账号会话（legacy token / readonly）→ 空对象
    await expect(handleHeader(env.DB, humanIdentity(null))).resolves.toEqual({});
    await expect(handleHeader(env.DB, humanIdentity(undefined))).resolves.toEqual({});

    // kind !== "human"（agent）→ 即使账号设了 handle 也不带（Task A7 修复 #2）
    await expect(
      handleHeader(env.DB, { ...humanIdentity(owner), kind: "agent" }),
    ).resolves.toEqual({});
  });

  it("ws upgrade still succeeds when a client sends a forged x-ap-handle header", async () => {
    const owner = uniq("acct");
    const human = await seedToken("human", uniq("tok-human"), { owner });
    const handle = uniq("wshandle");
    expect((await api("/api/me/handle", human.token, { method: "PUT", body: JSON.stringify({ handle }) })).status).toBe(200);
    const slug = await createChannel(human.token);

    const { ws, first } = await openRaw(slug, human.token, { "x-ap-handle": "evil" });
    expect(first.type).toBe("welcome");
    ws.close();
  });

  it("POST .../messages still succeeds when a client sends a forged x-ap-handle header", async () => {
    const owner = uniq("acct");
    const human = await seedToken("human", uniq("tok-human"), { owner });
    const handle = uniq("resthandle");
    expect((await api("/api/me/handle", human.token, { method: "PUT", body: JSON.stringify({ handle }) })).status).toBe(200);
    const slug = await createChannel(human.token);

    const res = await api(`/api/channels/${slug}/messages`, human.token, {
      method: "POST",
      headers: { "x-ap-handle": "evil" },
      body: JSON.stringify({ kind: "message", body: "hi", mentions: [], reply_to: null }),
    });
    expect(res.status).toBe(200);
  });
});
