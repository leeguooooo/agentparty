// do 消费 x-ap-handle（Task A7）：presence.handle + sender_handle 落库/回填 + 端到端防注入。
// 手法完全镜像 owner.spec.ts —— 走真实 worker 路径（SELF.fetch 升级 ws / 发消息），
// 不直接绕过 worker 给 do 发内部请求，因为权威 x-ap-handle 是 worker 层算出来再转发的（Task A6）。
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, completeCapabilityHello, createChannel, postMessage, seedToken, uniq, WsClient } from "./helpers";

// 带自定义头做 ws 升级（同 ws-header-injection.spec.ts 的 openRaw），用于模拟客户端在升级请求里
// 夹带伪造 x-ap-handle。worker 会先剥离所有客户端注入的 x-ap-* 头，再按账号的真实 handle（若有）
// 补权威值（Task A6），所以这条路径测的是「经 worker 转发」这一层，不是绕过 worker 直连 do 那一层。
async function openWithForgedHeader(
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

async function setHandle(token: string, handle: string) {
  const res = await api("/api/me/handle", token, { method: "PUT", body: JSON.stringify({ handle }) });
  expect(res.status).toBe(200);
}

describe("do consumes x-ap-handle (Task A7)", () => {
  it("stamps sender.handle on send, mirrors it into presence, and keeps it through history replay", async () => {
    const owner = uniq("acct");
    const human = await seedToken("human", uniq("h"), { owner });
    const handle = uniq("leo");
    await setHandle(human.token, handle);
    const slug = await createChannel(human.token);

    const ws = await WsClient.open(slug, human.token);
    const welcome = await completeCapabilityHello(ws);
    // welcome.participants 走 ConnState → senderFromIdentity 同一条镜像路径，顺手断言一次
    expect(welcome.participants).toContainEqual({ name: human.name, kind: "human", owner, handle });

    ws.send({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null });
    await ws.nextOfType("sent");
    const msg = await ws.nextOfType("msg");
    expect(msg.sender.handle).toBe(handle);

    // presence 表只在 status 帧时 upsert（同 owner/account 的既有手法），补发一条 status 才能看到 presence.handle
    ws.send({ type: "send", kind: "status", state: "working", note: "", mentions: [] });
    await ws.nextOfType("sent");
    const presence = await ws.nextOfType("presence");
    // PresenceFrame（shared/src/protocol.ts）目前的类型声明里没带 handle 字段（A2 只加到了
    // PresenceEntry 上），但 do.ts 的 `{ type: "presence", ...entry }` 运行时确实会把 entry
    // （PresenceEntry）里的 handle 一并展开出来。这里用类型断言绕开这个类型层的既有缺口，
    // 不在本任务范围内顺手改 shared 协议类型（那是另一处遗留，见任务报告 concern）。
    expect((presence as unknown as { handle?: string }).handle).toBe(handle);
    ws.close();

    // 历史补拉（hello since=0）：新连接读回同一条消息，sender.handle 仍在 —— 证明落库了，不是只在内存里现算
    const reader = await WsClient.open(slug, human.token);
    await completeCapabilityHello(reader);
    const back = await reader.nextOfType("msg");
    expect(back.sender.handle).toBe(handle);
    reader.close();

    // GET /api/channels/:slug/messages（/internal/messages 的公开出口，同一条 rowToFrame）也带 handle
    const history = await api(`/api/channels/${slug}/messages`, human.token);
    const historyBody = (await history.json()) as { messages: { sender: { handle?: string } }[] };
    expect(historyBody.messages.some((m) => m.sender.handle === handle)).toBe(true);
  });

  // 端到端防注入（A6 交接）：账号从未设置过 handle 时，worker 的 handleHeader() 不会补任何 x-ap-handle，
  // 客户端在 ws 升级请求里自带的 x-ap-handle 会被 AP_FORWARD_HEADERS 无条件剥离。这里测的是
  // 「经 worker 路径」这一层：最终落到 sender.handle 上的必须是空，而不是客户端伪造的 "evil"。
  it("never lets a client-forged x-ap-handle become sender.handle when the account has none set", async () => {
    const owner = uniq("acct-nohandle");
    const human = await seedToken("human", uniq("h"), { owner });
    const slug = await createChannel(human.token);

    const { ws, first } = await openWithForgedHeader(slug, human.token, { "x-ap-handle": "evil" });
    expect(first.type).toBe("welcome");
    const me = (first.participants as { name: string; handle?: string }[]).find((p) => p.name === human.name);
    expect(me).not.toHaveProperty("handle");

    ws.send(JSON.stringify({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null }));
    const msg = await nextRawFrame(ws, "msg");
    const sender = msg.sender as { handle?: string };
    expect(sender.handle).not.toBe("evil");
    expect(sender).not.toHaveProperty("handle");
    ws.close();
  });

  // 同一层再补一条：账号确实设置过 handle，客户端仍夹带伪造值，最终必须是真实 handle，绝不是伪造值。
  it("uses the account's real handle even when the client forges a different one", async () => {
    const owner = uniq("acct-realhandle");
    const human = await seedToken("human", uniq("h"), { owner });
    const handle = uniq("real");
    await setHandle(human.token, handle);
    const slug = await createChannel(human.token);

    const { ws, first } = await openWithForgedHeader(slug, human.token, { "x-ap-handle": "evil" });
    expect(first.type).toBe("welcome");

    ws.send(JSON.stringify({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null }));
    const msg = await nextRawFrame(ws, "msg");
    const sender = msg.sender as { handle?: string };
    expect(sender.handle).toBe(handle);
    ws.close();
  });
});

// Task A7 review 发现的两个 Important 修复的回归证据：
//  ① handleHeader 只按 account 查 D1、不看调用方 kind → human 和其自铸 agent 共享 account 时，
//     agent 自己发的消息会被错误打上 human 的 handle（协议要求 agent 恒省略 handle）。
//  ② review / edit|retract|supersede 两条转发路径漏调 handleHeader()，导致 supersede 新消息、
//     reviewer 审核回复的 sender.handle 永远缺失，即使发送方/审核方账号已设置过真实 handle。
describe("x-ap-handle review fixes (Task A7)", () => {
  it("does not let an agent inherit the handle of the human it shares an account with", async () => {
    const acct = uniq("shared-acct");
    const human = await seedToken("human", uniq("h"), { owner: acct });
    const handle = uniq("humanhandle");
    await setHandle(human.token, handle);
    // 自铸 agent：与 human 共享同一 account（典型场景——human 给自己铸的 agent token）
    const agent = await seedToken("agent", uniq("a"), { owner: acct });
    const slug = await createChannel(human.token);

    const sent = await postMessage(slug, agent.token, "hi from agent");
    expect(sent.status).toBe(200);
    const seq = ((await sent.json()) as { seq: number }).seq;

    const history = await api(`/api/channels/${slug}/messages`, human.token);
    const messages = ((await history.json()) as {
      messages: { seq: number; sender: { kind: string; handle?: string } }[];
    }).messages;
    const msg = messages.find((m) => m.seq === seq);
    expect(msg?.sender.kind).toBe("agent");
    expect(msg?.sender).not.toHaveProperty("handle");
  });

  it("forwards the actor's real handle onto the new message when superseding (edit|retract|supersede path)", async () => {
    const acct = uniq("acct-supersede");
    const human = await seedToken("human", uniq("h"), { owner: acct });
    const handle = uniq("supersedehandle");
    await setHandle(human.token, handle);
    const slug = await createChannel(human.token);

    const sent = await postMessage(slug, human.token, "old claim");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const supersede = await api(`/api/channels/${slug}/messages/${seq}/supersede`, human.token, {
      method: "POST",
      body: JSON.stringify({ body: "new claim" }),
    });
    expect(supersede.status).toBe(200);
    const body = (await supersede.json()) as { message: { sender: { handle?: string } } };
    expect(body.message.sender.handle).toBe(handle);
  });

  it("forwards the reviewer's real handle onto the reviewer reply (review path)", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: acct });
    const slug = await createChannel(owner.token);
    const writer = await seedToken("agent", uniq("writer"), { owner: acct, channelScope: slug });
    const reviewerAcct = uniq("reviewer-acct");
    const reviewer = await seedToken("human", uniq("reviewer"), { owner: reviewerAcct, channelScope: slug });
    const handle = uniq("reviewerhandle");
    await setHandle(reviewer.token, handle);

    const gate = await api(`/api/channels/${slug}/completion-gate`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ gate: "reviewer", policy: "sender" }),
    });
    expect(gate.status).toBe(200);

    const kickoff = await postMessage(slug, writer.token, "please do the work");
    const kickoffSeq = ((await kickoff.json()) as { seq: number }).seq;

    const completion = await api(`/api/channels/${slug}/messages`, writer.token, {
      method: "POST",
      body: JSON.stringify({
        kind: "message",
        body: "final synthesis",
        mentions: [],
        reply_to: kickoffSeq,
        completion_artifact: {
          kind: "final_synthesis",
          kickoff_seq: kickoffSeq,
          replies_count: 1,
          timeout: false,
          related_issues: [],
          related_prs: [],
        },
      }),
    });
    expect(completion.status).toBe(200);
    const completionSeq = ((await completion.json()) as { seq: number }).seq;

    const approved = await api(`/api/channels/${slug}/messages/${completionSeq}/review`, reviewer.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as { reply: { sender: { handle?: string } } };
    expect(body.reply.sender.handle).toBe(handle);
  });
});
