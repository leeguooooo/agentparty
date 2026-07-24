import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, postMessage, seedToken } from "./helpers";

interface MsgLike {
  seq: number;
  sender: { name: string; kind: string };
  kind: string;
  body: string;
}

interface SearchHitLike {
  type: string;
  channel: string;
  query: string;
  seq: number;
  sender: { name: string; kind: string };
  kind: string;
  match_field: string;
  snippet: string;
}

describe("history rest", () => {
  it("returns messages after since, ordered, with limit", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    for (let i = 1; i <= 3; i++) {
      const res = await postMessage(slug, token, `m${i}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { seq: number }).seq).toBe(i);
    }

    const all = await api(`/api/channels/${slug}/messages?since=0`, token);
    expect(all.status).toBe(200);
    const { messages } = (await all.json()) as { messages: MsgLike[] };
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messages[0]).toMatchObject({
      kind: "message",
      body: "m1",
      sender: { name, kind: "agent" },
    });

    const tail = await api(`/api/channels/${slug}/messages?since=2`, token);
    const tailBody = (await tail.json()) as { messages: MsgLike[] };
    expect(tailBody.messages.map((m) => m.seq)).toEqual([3]);

    const limited = await api(`/api/channels/${slug}/messages?since=0&limit=1`, token);
    const limitedBody = (await limited.json()) as { messages: MsgLike[] };
    expect(limitedBody.messages.map((m) => m.seq)).toEqual([1]);
  });

  it("before paginates backwards for IM-style scroll-up (ascending pages)", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    for (let i = 1; i <= 5; i++) {
      expect((await postMessage(slug, token, `m${i}`)).status).toBe(200);
    }

    // 最新一页：before 取一个大值 → 最近 2 条，升序
    const latest = await api(`/api/channels/${slug}/messages?before=9007199254740991&limit=2`, token);
    expect(latest.status).toBe(200);
    const latestBody = (await latest.json()) as { messages: MsgLike[] };
    expect(latestBody.messages.map((m) => m.seq)).toEqual([4, 5]);

    // 上翻一页：before=已加载最老的 seq
    const older = await api(`/api/channels/${slug}/messages?before=4&limit=2`, token);
    const olderBody = (await older.json()) as { messages: MsgLike[] };
    expect(olderBody.messages.map((m) => m.seq)).toEqual([2, 3]);

    // 再上翻：不足一页返回剩余；顶到头返回空
    const first = await api(`/api/channels/${slug}/messages?before=2&limit=2`, token);
    expect(((await first.json()) as { messages: MsgLike[] }).messages.map((m) => m.seq)).toEqual([1]);
    const none = await api(`/api/channels/${slug}/messages?before=1&limit=2`, token);
    expect(((await none.json()) as { messages: MsgLike[] }).messages).toEqual([]);

    // before 与 since 同给时 before 优先（互斥语义）
    const both = await api(`/api/channels/${slug}/messages?since=1&before=3&limit=10`, token);
    expect(((await both.json()) as { messages: MsgLike[] }).messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("loads an ascending window around an exact historical message anchor", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    for (let i = 1; i <= 7; i++) {
      expect((await postMessage(slug, token, `m${i}`)).status).toBe(200);
    }

    const middle = await api(`/api/channels/${slug}/messages?around=4&limit=5`, token);
    expect(middle.status).toBe(200);
    expect(((await middle.json()) as { messages: MsgLike[] }).messages.map((m) => m.seq))
      .toEqual([2, 3, 4, 5, 6]);

    const edge = await api(`/api/channels/${slug}/messages?around=1&limit=5`, token);
    expect(((await edge.json()) as { messages: MsgLike[] }).messages.map((m) => m.seq))
      .toEqual([1, 2, 3, 4, 5]);

    const missing = await api(`/api/channels/${slug}/messages?around=99&limit=5`, token);
    expect(((await missing.json()) as { messages: MsgLike[] }).messages).toEqual([]);

    const precedence = await api(`/api/channels/${slug}/messages?since=6&before=2&around=4&limit=3`, token);
    expect(((await precedence.json()) as { messages: MsgLike[] }).messages.map((m) => m.seq))
      .toEqual([3, 4, 5]);
  });

  it("persists and filters completion artifacts", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "kickoff")).status).toBe(200);
    const completion = await api(`/api/channels/${slug}/messages`, token, {
      method: "POST",
      body: JSON.stringify({
        kind: "message",
        body: "final synthesis",
        mentions: [],
        reply_to: 1,
        completion_artifact: {
          kind: "final_synthesis",
          kickoff_seq: 1,
          replies_count: 0,
          timeout: true,
          related_issues: [5],
          related_prs: [],
        },
      }),
    });
    expect(completion.status).toBe(200);
    expect(((await completion.json()) as { seq: number }).seq).toBe(2);

    const history = await api(`/api/channels/${slug}/messages?since=0`, token);
    const historyBody = (await history.json()) as { messages: MsgLike[] };
    expect(historyBody.messages[1]).toMatchObject({
      seq: 2,
      body: "final synthesis",
      reply_to: 1,
      completion_artifact: {
        kind: "final_synthesis",
        kickoff_seq: 1,
        replies_count: 0,
        timeout: true,
        related_issues: [5],
        related_prs: [],
      },
    });

    const filtered = await api(`/api/channels/${slug}/messages?since=0&completion=1`, token);
    const filteredBody = (await filtered.json()) as { messages: MsgLike[] };
    expect(filteredBody.messages.map((m) => m.seq)).toEqual([2]);
  });

  it("rejects invalid completion artifacts", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "kickoff")).status).toBe(200);

    const mismatched = await api(`/api/channels/${slug}/messages`, token, {
      method: "POST",
      body: JSON.stringify({
        kind: "message",
        body: "bad synthesis",
        mentions: [],
        reply_to: 1,
        completion_artifact: {
          kind: "final_synthesis",
          kickoff_seq: 2,
          replies_count: 1,
          timeout: false,
          related_issues: [],
          related_prs: [],
        },
      }),
    });
    expect(mismatched.status).toBe(400);

    const onStatus = await api(`/api/channels/${slug}/messages`, token, {
      method: "POST",
      body: JSON.stringify({
        kind: "status",
        state: "done",
        note: "done",
        completion_artifact: {
          kind: "final_synthesis",
          kickoff_seq: 1,
          replies_count: 1,
          timeout: false,
          related_issues: [],
          related_prs: [],
        },
      }),
    });
    expect(onStatus.status).toBe(400);
  });

  it("404 on unknown channel", async () => {
    const { token } = await seedToken("agent");
    const res = await api("/api/channels/no-such-channel/messages", token);
    expect(res.status).toBe(404);
  });

  it("searches retained history server-side with sender and since filters", async () => {
    const alice = await seedToken("agent", "alice");
    const bob = await seedToken("agent", "bob");
    const slug = await createChannel(alice.token);
    expect((await postMessage(slug, alice.token, "needle from alice")).status).toBe(200);
    expect((await postMessage(slug, bob.token, "noise from bob")).status).toBe(200);
    expect(
      (
        await api(`/api/channels/${slug}/messages`, bob.token, {
          method: "POST",
          body: JSON.stringify({
            kind: "status",
            state: "working",
            note: "needle status from bob",
            mentions: [],
            summary_seq: null,
          }),
        })
      ).status,
    ).toBe(200);
    expect((await postMessage(slug, bob.token, "needle second from bob")).status).toBe(200);

    const windowed = await api(`/api/channels/${slug}/messages?since=0&limit=1`, alice.token);
    const windowedBody = (await windowed.json()) as { messages: MsgLike[] };
    expect(windowedBody.messages.map((m) => m.seq)).toEqual([1]);

    const res = await api(`/api/channels/${slug}/search?q=needle&from=bob&since=1&limit=5`, alice.token);
    expect(res.status).toBe(200);
    const { hits } = (await res.json()) as { hits: SearchHitLike[] };
    expect(hits.map((h) => h.seq)).toEqual([4, 3]);
    expect(hits[0]).toMatchObject({
      type: "search_hit",
      channel: slug,
      query: "needle",
      sender: { name: "bob", kind: "agent" },
      match_field: "body",
      snippet: "needle second from bob",
    });
    expect(hits[1]).toMatchObject({
      kind: "status",
      match_field: "note",
      snippet: "needle status from bob",
    });

    expect((await postMessage(slug, bob.token, "100% literal")).status).toBe(200);
    const literal = await api(`/api/channels/${slug}/search?q=${encodeURIComponent("%")}&from=bob`, alice.token);
    expect(literal.status).toBe(200);
    const literalBody = (await literal.json()) as { hits: SearchHitLike[] };
    expect(literalBody.hits.map((h) => h.seq)).toEqual([5]);
    expect(literalBody.hits[0]).toMatchObject({
      match_field: "body",
      snippet: "100% literal",
    });

    const bad = await api(`/api/channels/${slug}/search`, alice.token);
    expect(bad.status).toBe(400);
  });

  it("archived channel rejects sends over rest and ws", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "before archive")).status).toBe(200);
    await env.DB.prepare("UPDATE channels SET archived_at = ? WHERE slug = ?")
      .bind(Date.now(), slug)
      .run();

    const rest = await postMessage(slug, token, "after archive");
    expect(rest.status).toBe(410);
    expect(((await rest.json()) as { error: { code: string } }).error.code).toBe("archived");

    const ws = await WsClient.open(slug, token);
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("archived");

    // 归档后仍可回看历史
    const history = await api(`/api/channels/${slug}/messages`, token);
    expect(history.status).toBe(200);
    const { messages } = (await history.json()) as { messages: MsgLike[] };
    expect(messages).toHaveLength(1);
  });
});
