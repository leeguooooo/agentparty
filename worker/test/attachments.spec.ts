import type { MsgFrame } from "@agentparty/shared";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

// 直接用 SELF.fetch 上传二进制，绕开 api() 的默认 application/json content-type
function upload(
  slug: string,
  token: string | null,
  filename: string,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): Promise<Response> {
  return SELF.fetch(`http://ap.test/api/channels/${slug}/attachments?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": contentType,
    },
    body: bytes,
  });
}

function download(slug: string, token: string | null, path: string): Promise<Response> {
  return SELF.fetch(`http://ap.test/api/channels/${slug}/attachments/${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("channel attachments (R2)", () => {
  it("uploads a blob to R2 and returns metadata", async () => {
    const { token } = await seedToken("agent", uniq("owner"), { owner: "owner@ap.test" });
    const slug = await createChannel(token);
    const bytes = new TextEncoder().encode("hello attachment world");
    const res = await upload(slug, token, "note.txt", bytes, "text/plain");
    expect(res.status).toBe(201);
    const meta = (await res.json()) as {
      key: string;
      filename: string;
      content_type: string;
      size: number;
      url: string;
    };
    expect(meta.filename).toBe("note.txt");
    expect(meta.content_type).toBe("text/plain");
    expect(meta.size).toBe(bytes.byteLength);
    // key 锚定到频道 slug 前缀，隔离跨频道读取
    expect(meta.key.startsWith(`${slug}/`)).toBe(true);
    expect(meta.key.endsWith("/note.txt")).toBe(true);
    // url 是回 worker 的鉴权下载路径，不是裸 R2 公链
    expect(meta.url.startsWith(`/api/channels/${slug}/attachments/`)).toBe(true);
    expect(meta.url).not.toContain("r2.cloudflarestorage");
  });

  it("streams the stored blob back with auth and correct content-type", async () => {
    const { token } = await seedToken("agent", uniq("owner"), { owner: "owner@ap.test" });
    const slug = await createChannel(token);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const meta = (await (await upload(slug, token, "pic.png", bytes, "image/png")).json()) as { url: string };
    const res = await download(slug, token, meta.url.split("/attachments/")[1]!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const got = new Uint8Array(await res.arrayBuffer());
    expect([...got]).toEqual([...bytes]);
  });

  it("rejects upload without a valid token (401)", async () => {
    const { token } = await seedToken("agent", uniq("owner"), { owner: "owner@ap.test" });
    const slug = await createChannel(token);
    const res = await upload(slug, null, "x.txt", new TextEncoder().encode("x"), "text/plain");
    expect(res.status).toBe(401);
  });

  it("rejects download from a non-member of a private channel (403)", async () => {
    const { token } = await seedToken("agent", uniq("owner"), { owner: "owner@ap.test" });
    const slug = await createChannel(token); // private by default
    const bytes = new TextEncoder().encode("secret");
    const meta = (await (await upload(slug, token, "s.txt", bytes, "text/plain")).json()) as { url: string };
    const objectPath = meta.url.split("/attachments/")[1]!;
    // 陌生账号 token：非房主、非成员 → 私有频道禁读
    const { token: intruder } = await seedToken("agent", uniq("intruder"), { owner: "intruder@ap.test" });
    const res = await download(slug, intruder, objectPath);
    expect(res.status).toBe(403);
    // 无 token → 401
    expect((await download(slug, null, objectPath)).status).toBe(401);
  });

  it("rejects an oversize upload (413)", async () => {
    const { token } = await seedToken("agent", uniq("owner"), { owner: "owner@ap.test" });
    const slug = await createChannel(token);
    // 26MB > 25MB cap
    const big = new Uint8Array(26 * 1024 * 1024);
    const res = await upload(slug, token, "big.bin", big, "application/octet-stream");
    expect(res.status).toBe(413);
  });

  it("round-trips attachment refs on a message", async () => {
    const { token } = await seedToken("agent", uniq("owner"), { owner: "owner@ap.test" });
    const slug = await createChannel(token);
    const bytes = new TextEncoder().encode("attach me");
    const meta = (await (await upload(slug, token, "doc.pdf", bytes, "application/pdf")).json()) as {
      key: string;
      filename: string;
      content_type: string;
      size: number;
      url: string;
    };
    const send = await api(`/api/channels/${slug}/messages`, token, {
      method: "POST",
      body: JSON.stringify({
        kind: "message",
        body: "see attached",
        mentions: [],
        reply_to: null,
        attachments: [meta],
      }),
    });
    expect(send.status).toBe(200);

    const list = await api(`/api/channels/${slug}/messages`, token);
    expect(list.status).toBe(200);
    const { messages } = (await list.json()) as { messages: MsgFrame[] };
    const msg = messages.find((m) => m.body === "see attached");
    expect(msg).toBeDefined();
    expect(msg?.attachments).toHaveLength(1);
    expect(msg?.attachments?.[0]).toMatchObject({
      key: meta.key,
      filename: "doc.pdf",
      content_type: "application/pdf",
      size: bytes.byteLength,
      url: meta.url,
    });
  });

  it("dedupes by content hash: same bytes+filename → same key; different bytes → different key (#387)", async () => {
    const { token } = await seedToken("agent", uniq("owner"), { owner: "owner@ap.test" });
    const slug = await createChannel(token);
    const bytes = new TextEncoder().encode("identical payload for dedup");

    const first = (await (await upload(slug, token, "dup.bin", bytes)).json()) as { key: string; url: string };
    const second = (await (await upload(slug, token, "dup.bin", bytes)).json()) as { key: string; url: string };
    // 内容 hash 命名 → 同内容同名两次上传落同一个 key（R2 里只一份）
    expect(second.key).toBe(first.key);
    expect(second.url).toBe(first.url);
    // key 是 slug/<64hex>/filename
    expect(first.key).toMatch(new RegExp(`^${slug}/[0-9a-f]{64}/dup\\.bin$`));

    // 内容不同 → key 不同
    const other = (await (await upload(slug, token, "dup.bin", new TextEncoder().encode("different"))).json()) as { key: string };
    expect(other.key).not.toBe(first.key);

    // 去重命中后仍可正常下载（对象确实在）
    const dl = await download(slug, token, second.url.split("/attachments/")[1]!);
    expect(dl.status).toBe(200);
    expect(new TextEncoder().encode(await dl.text())).toEqual(bytes);
  });
});
