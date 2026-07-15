import { describe, expect, it } from "vitest";
import { api, WsClient, completeCapabilityHello, createChannel, seedToken } from "./helpers";

async function postMessage(ws: WsClient, body: string): Promise<number> {
  ws.send({ type: "send", kind: "message", body, mentions: [], reply_to: null });
  const sent = await ws.nextOfType("sent");
  return sent.seq;
}

describe("read cursor (Phase 2)", () => {
  it("seen advances the cursor and broadcasts read_cursor; agent readers count too; monotonic", async () => {
    const a = await seedToken("human");
    const b = await seedToken("agent");
    const slug = await createChannel(a.token);
    const wa = await WsClient.open(slug, a.token);
    await completeCapabilityHello(wa);
    await wa.nextOfType("participants");
    const s1 = await postMessage(wa, "m1");
    await postMessage(wa, "m2");
    const s3 = await postMessage(wa, "m3");

    const wb = await WsClient.open(slug, b.token); // agent reader (流式 agent)
    await completeCapabilityHello(wb);
    await wa.nextOfType("participants");

    // agent B 声明已读到 s3 —— read 状态覆盖 agent，不只人类
    wb.send({ type: "seen", seq: s3 });
    const cur = await wa.nextOfType("read_cursor");
    expect(cur).toMatchObject({ type: "read_cursor", name: b.name, kind: "agent", last_seen_seq: s3 });

    // 回退 seq 不后移、不广播；再前移到更大 seq 才广播
    wb.send({ type: "seen", seq: s1 }); // < s3 → 忽略
    await postMessage(wa, "m4");
    const s5 = await postMessage(wa, "m5");
    wb.send({ type: "seen", seq: s5 });
    const cur2 = await wa.nextOfType("read_cursor");
    expect(cur2.name).toBe(b.name);
    expect(cur2.last_seen_seq).toBe(s5); // 直接跳到 s5，中途的 s1 回退被忽略

    wa.close();
    wb.close();
  });

  it("welcome carries a read_cursors snapshot for late joiners", async () => {
    const a = await seedToken("human");
    const slug = await createChannel(a.token);
    const wa = await WsClient.open(slug, a.token);
    await completeCapabilityHello(wa);
    await wa.nextOfType("participants");
    const s1 = await postMessage(wa, "m1");
    wa.send({ type: "seen", seq: s1 });
    await wa.nextOfType("read_cursor"); // 自己也收到广播

    const c = await seedToken("human");
    const wc = await WsClient.open(slug, c.token);
    const welcome = await completeCapabilityHello(wc);
    expect(welcome.read_cursors).toContainEqual(
      expect.objectContaining({ name: a.name, last_seen_seq: s1 }),
    );
    wa.close();
    wc.close();
  });

  it("caps seq to lastSeq — a future seq cannot over-advance the cursor", async () => {
    const a = await seedToken("human");
    const b = await seedToken("agent");
    const slug = await createChannel(a.token);
    const wa = await WsClient.open(slug, a.token);
    await completeCapabilityHello(wa);
    await wa.nextOfType("participants");
    const s1 = await postMessage(wa, "m1");

    const wb = await WsClient.open(slug, b.token);
    await completeCapabilityHello(wb);
    await wa.nextOfType("participants");

    wb.send({ type: "seen", seq: 999_999 }); // 远超 lastSeq
    const cur = await wa.nextOfType("read_cursor");
    expect(cur.last_seen_seq).toBe(s1); // 夹到 lastSeq，不是 999999

    wa.close();
    wb.close();
  });

  it("REST /read-cursors returns the cursor snapshot + channel last_seq (for party who)", async () => {
    const a = await seedToken("human");
    const slug = await createChannel(a.token);
    const wa = await WsClient.open(slug, a.token);
    await completeCapabilityHello(wa);
    await wa.nextOfType("participants");
    await postMessage(wa, "m1");
    const s2 = await postMessage(wa, "m2");
    wa.send({ type: "seen", seq: s2 });
    await wa.nextOfType("read_cursor");

    const res = await api(`/api/channels/${slug}/read-cursors`, a.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cursors: Array<{ name: string; last_seen_seq: number }>; last_seq: number };
    expect(body.last_seq).toBe(s2);
    expect(body.cursors).toContainEqual(expect.objectContaining({ name: a.name, last_seen_seq: s2 }));
    wa.close();
  });
});
