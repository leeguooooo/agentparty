// #434：发送方 CLI 版本随消息落库 + 随消息帧/历史返回。
// CLI 每次 REST 调用带 x-ap-client-version，服务端在 handleSend 时把它快照进消息 sender.client_version，
// 供网页展示「该条来自哪个 CLI 版本」并对落后版本标警告。
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken } from "./helpers";

interface MsgLike {
  seq: number;
  sender: { name: string; kind: string; client_version?: string };
  body: string;
}

function sendWithClientVersion(slug: string, token: string, body: string, clientVersion?: string): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions: [], reply_to: null }),
    headers: clientVersion === undefined ? {} : { "x-ap-client-version": clientVersion },
  });
}

describe("message sender client version (#434)", () => {
  it("snapshots x-ap-client-version onto the message and returns it via history", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);

    const res = await sendWithClientVersion(slug, token, "hello", "0.3.1");
    expect(res.status).toBe(200);

    const hist = await api(`/api/channels/${slug}/messages?since=0`, token);
    const { messages } = (await hist.json()) as { messages: MsgLike[] };
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sender.client_version).toBe("0.3.1");
  });

  it("omits client_version when the sender sends no version header (web/legacy)", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);

    expect((await sendWithClientVersion(slug, token, "no version")).status).toBe(200);

    const hist = await api(`/api/channels/${slug}/messages?since=0`, token);
    const { messages } = (await hist.json()) as { messages: MsgLike[] };
    expect(messages[0]!.sender.client_version).toBeUndefined();
  });

  it("rejects a malformed version header (falls back to omitted, never crashes send)", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);

    // 空格/非法字符不满足 CLIENT_VERSION_RE → parseClientVersion 返回 null → 不落库。
    expect((await sendWithClientVersion(slug, token, "bad ver", "not a version!!")).status).toBe(200);

    const hist = await api(`/api/channels/${slug}/messages?since=0`, token);
    const { messages } = (await hist.json()) as { messages: MsgLike[] };
    expect(messages[0]!.sender.client_version).toBeUndefined();
  });
});
