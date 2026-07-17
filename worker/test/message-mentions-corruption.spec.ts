import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, postMessage, seedToken } from "./helpers";

interface SqlLike {
  exec(query: string, ...args: unknown[]): { toArray(): Record<string, unknown>[] };
}

interface MsgLike {
  seq: number;
  body: string;
  mentions: string[];
}

// 回归：一行 mentions_json='' 曾让整条频道的 messages 历史 / hello 回填全部 500——
// rowToFrame 里裸 JSON.parse('') 抛未捕获异常，DO 对该频道所有读请求返回 Cloudflare
// "internal error"（xdream 上 kyc/seamail 实测）。修法是像其余存储解析一样兜底空/坏值。
describe("mentions_json corruption is tolerated on read (#do-mentions-parse)", () => {
  async function seedCorruptRow(slug: string, seq: number, rawMentions: string): Promise<void> {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      const sql = (instance as unknown as { ctx: { storage: { sql: SqlLike } } }).ctx.storage.sql;
      sql.exec(
        `INSERT INTO messages (seq, sender_name, sender_kind, kind, body, mentions_json, reply_to, ts)
         VALUES (?, 'ghost', 'agent', 'message', ?, ?, NULL, ?)`,
        seq,
        `corrupt-${seq}`,
        rawMentions,
        Date.now() + seq,
      );
    });
  }

  it("GET /messages returns 200 with empty mentions for a '' row instead of 500", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "healthy")).status).toBe(200);
    await seedCorruptRow(slug, 2, ""); // 空串：修复前 JSON.parse('') 抛异常
    await seedCorruptRow(slug, 3, "not-json"); // 坏 JSON：同样必须兜底

    const res = await api(`/api/channels/${slug}/messages?before=9007199254740991&limit=50`, token);
    expect(res.status).toBe(200);
    const { messages } = (await res.json()) as { messages: MsgLike[] };
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messages[1]).toMatchObject({ seq: 2, mentions: [] });
    expect(messages[2]).toMatchObject({ seq: 3, mentions: [] });
    // hello 首连补拉走同一个 rowToFrame，故此处覆盖即同时覆盖 ws 路径。
  });
});
