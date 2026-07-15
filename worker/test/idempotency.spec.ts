// 消息幂等键（#98）：客户端带 idempotency_key，服务端按 (sender_name, key) 去重。
// 核心防线针对「服务端盲重试」——POST /messages 走 fetchChannelDO(retries=1)，
// DO reset 后 clone 重发同一 body，命中已落库窗口即重复消息 + 重复唤醒。
// 断言观测过程：重发后 messages 表只多一行、返回的 seq 与首发相同——不是只断言「没报错」。
import { describe, expect, it } from "vitest";
import { WsClient, api, completeCapabilityHello, createChannel, seedToken } from "./helpers";

interface MsgLike {
  seq: number;
  kind: string;
  body: string;
  sender: { name: string; kind: string };
}

function send(slug: string, token: string, body: string, key?: string): Promise<Response> {
  const payload = {
    kind: "message",
    body,
    mentions: [] as string[],
    reply_to: null,
    ...(key === undefined ? {} : { idempotency_key: key }),
  };
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function messages(slug: string, token: string): Promise<MsgLike[]> {
  const res = await api(`/api/channels/${slug}/messages?since=0&limit=1000`, token);
  const { messages } = (await res.json()) as { messages: MsgLike[] };
  return messages.filter((m) => m.kind === "message");
}

describe("message idempotency (#98)", () => {
  it("dedups a resend with the same key: same seq, exactly one row", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const key = crypto.randomUUID();

    const first = await send(slug, token, "hello", key);
    expect(first.status).toBe(200);
    const seq1 = ((await first.json()) as { seq: number }).seq;

    const second = await send(slug, token, "hello", key);
    expect(second.status).toBe(200);
    const seq2 = ((await second.json()) as { seq: number }).seq;

    // 返回的是原来那条的 seq，不是新插入
    expect(seq2).toBe(seq1);
    // messages 表只多一行
    const rows = await messages(slug, token);
    expect(rows.filter((m) => m.body === "hello")).toHaveLength(1);
  });

  it("control: without a key, two identical sends both insert", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);

    const first = await send(slug, token, "dup");
    const seq1 = ((await first.json()) as { seq: number }).seq;
    const second = await send(slug, token, "dup");
    const seq2 = ((await second.json()) as { seq: number }).seq;

    expect(seq2).toBe(seq1 + 1);
    const rows = await messages(slug, token);
    expect(rows.filter((m) => m.body === "dup")).toHaveLength(2);
  });

  it("different keys are not deduped", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);

    const seq1 = ((await (await send(slug, token, "x", crypto.randomUUID())).json()) as { seq: number }).seq;
    const seq2 = ((await (await send(slug, token, "x", crypto.randomUUID())).json()) as { seq: number }).seq;

    expect(seq2).toBe(seq1 + 1);
    expect((await messages(slug, token)).filter((m) => m.body === "x")).toHaveLength(2);
  });

  it("dedup is scoped per sender: same key from two senders both insert", async () => {
    const { token: tokenA } = await seedToken("agent");
    const { token: tokenB } = await seedToken("agent");
    const slug = await createChannel(tokenA);
    const key = crypto.randomUUID();

    const resA = await send(slug, tokenA, "shared-key", key);
    expect(resA.status).toBe(200);
    const resB = await send(slug, tokenB, "shared-key", key);
    expect(resB.status).toBe(200);

    const seqA = ((await resA.json()) as { seq: number }).seq;
    const seqB = ((await resB.json()) as { seq: number }).seq;
    expect(seqB).not.toBe(seqA);
    expect((await messages(slug, tokenA)).filter((m) => m.body === "shared-key")).toHaveLength(2);
  });

  it("deduped resend does not re-broadcast (no double delivery / no double wake)", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    // 房主自己订阅：绕开私有频道 ACL；观测广播是否重复。
    const ws = await WsClient.open(slug, token);
    await completeCapabilityHello(ws);
    const key = crypto.randomUUID();

    const first = await send(slug, token, "once", key);
    expect(first.status).toBe(200);
    const echoed = await ws.nextOfType("msg");
    expect(echoed.body).toBe("once");

    // 同键重发命中去重：不得再广播第二条（afterSend 唤醒同在此 if 块内，一并跳过）
    const second = await send(slug, token, "once", key);
    expect(second.status).toBe(200);
    await expect(ws.nextOfType("msg", 500)).rejects.toThrow();
    ws.close();
  });

  it("dedups status sends too (status frame also carries a key)", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const key = crypto.randomUUID();
    const statusBody = { kind: "status", state: "working", note: "on it", idempotency_key: key };
    const sendStatus = () =>
      api(`/api/channels/${slug}/messages`, token, { method: "POST", body: JSON.stringify(statusBody) });

    const seq1 = ((await (await sendStatus()).json()) as { seq: number }).seq;
    const seq2 = ((await (await sendStatus()).json()) as { seq: number }).seq;
    expect(seq2).toBe(seq1);

    const res = await api(`/api/channels/${slug}/messages?since=0&limit=1000`, token);
    const { messages } = (await res.json()) as { messages: { kind: string; note: string | null }[] };
    expect(messages.filter((m) => m.kind === "status" && m.note === "on it")).toHaveLength(1);
  });
});
