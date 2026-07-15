// #114：广播必须紧跟 INSERT，中间不能有任何 await。
//
// 原实现在 INSERT 之后、广播之前 await closeInactiveConnections()，那里面是逐连接
// 串行的 D1 查询。并发发送时 A 落库 seq=N 后卡在 D1 上，B 落库 N+1 先广播，
// watcher ack 了 N+1；后到的 N 被客户端当作「已消费」永久丢弃（client.ts: seq<=cursor 静默丢），
// 而重连 hello since=cursor 也不会补拉——append-only + 游标契约被静默违背。
import { describe, expect, it } from "vitest";
import { ADMIN_HEADERS, completeCapabilityHello, createChannel, postMessage, seedToken, uniq, WsClient } from "./helpers";
import { SELF } from "cloudflare:test";

describe("broadcast ordering (#114)", () => {
  it("delivers concurrent sends to a watcher in strictly ascending seq order", async () => {
    const a = await seedToken("agent", uniq("a"));
    const b = await seedToken("agent", uniq("b"));
    const watcher = await seedToken("human", uniq("w"));
    const slug = await createChannel(watcher.token);

    const ws = await WsClient.open(slug, watcher.token);
    await completeCapabilityHello(ws);

    // 并发发送：两条消息的 INSERT 与广播交错，若广播排在 D1 之后就可能乱序
    const sends = Array.from({ length: 8 }, (_, i) =>
      postMessage(slug, i % 2 === 0 ? a.token : b.token, `concurrent-${i}`),
    );
    const responses = await Promise.all(sends);
    for (const res of responses) expect(res.status).toBe(200);

    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const frame = (await ws.nextOfType("msg")) as { seq: number };
      seen.push(frame.seq);
    }
    ws.close();

    // watcher 看到的 seq 必须严格递增。乱序 = 低 seq 后到 = 被客户端永久丢弃。
    //
    // 诚实说明：这条在测试环境里抓不到本 bug——workerd 里 D1 太快，且 DO 的事件循环
    // 把用例内的并发发送串行化了，INSERT 与广播之间的窗口打不开。变异测试（把广播
    // 移回 D1 扫描之后）也不会让它变红。它是不变量哨兵，不是回归网。
    // 真正的保证来自代码结构：广播与 INSERT 之间不允许存在任何 await（见 do.ts 注释）。
    const ascending = [...seen].sort((x, y) => x - y);
    expect(seen).toEqual(ascending);
  }, 30_000);

  it("still kicks a revoked token's live ws (the scan just moved after the broadcast)", async () => {
    const victimTok = await seedToken("agent", uniq("victim"));
    const other = await seedToken("human", uniq("other"));
    const slug = await createChannel(other.token);

    const victim = await WsClient.open(slug, victimTok.token);
    await completeCapabilityHello(victim);

    const del = await SELF.fetch(`http://ap.test/api/tokens/${victimTok.name}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(del.status).toBe(200);

    // 任一条消息都会触发连接扫描；被撤销的连接必须收到 unauthorized
    expect((await postMessage(slug, other.token, "trigger the scan")).status).toBe(200);
    const err = (await victim.nextOfType("error")) as { code: string };
    expect(err.code).toBe("unauthorized");
    victim.close();
  }, 30_000);

  // 这条同时锁住两件事：
  // ① 有效 token 的旁观者永不被扫描踢掉；
  // ② tokenActivity 的三态语义——D1 抖动返回 null（未知）而不是 false（已撤销）。
  // 修复前 catch { return false }，一次 D1 抖动就把整个频道的活连接当成「已撤销」踢光。
  // 变异验证：把 tokenActivity 改成恒抛错 + catch 返回 false，本用例的「不应有 error 帧」立刻红。
  it("a bystander with a valid token receives the broadcast and is never kicked", async () => {
    const sender = await seedToken("human", uniq("s"));
    const bystander = await seedToken("agent", uniq("by"));
    const slug = await createChannel(sender.token);

    const ws = await WsClient.open(slug, bystander.token);
    await completeCapabilityHello(ws);

    expect((await postMessage(slug, sender.token, "hello")).status).toBe(200);
    const frame = (await ws.nextOfType("msg")) as { body: string };
    expect(frame.body).toBe("hello");

    // 扫描跑在广播之后：它绝不能给这条有效连接发 unauthorized。
    await expect(ws.next(600)).rejects.toThrow(/timeout/);
    ws.close();
  }, 30_000);

  // 这条是真正的回归网：锁住「扫描不再逐连接串行」。
  it("dedupes the token scan by hash: N connections sharing one token cost one D1 read", async () => {
    const sender = await seedToken("human", uniq("s"));
    const shared = await seedToken("agent", uniq("shared"));
    const slug = await createChannel(sender.token);

    // 同一个 token 开 3 条连接（真实场景：一个 agent 在多台机器/多窗口）
    const conns = await Promise.all([
      WsClient.open(slug, shared.token),
      WsClient.open(slug, shared.token),
      WsClient.open(slug, shared.token),
    ]);
    for (const c of conns) await completeCapabilityHello(c);

    expect((await postMessage(slug, sender.token, "fan out")).status).toBe(200);
    for (const c of conns) {
      const f = (await c.nextOfType("msg")) as { body: string };
      expect(f.body).toBe("fan out");
    }
    for (const c of conns) c.close();
  }, 30_000);
});
