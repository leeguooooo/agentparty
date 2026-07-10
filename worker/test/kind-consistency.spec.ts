// issue #173：`party who`（presence）与 `party history`（messages）对同一身份的 kind 说法不一致。
//
// 根因：两侧 kind 都是「写入时」从权威 token（tokens.role → identity.kind）盖的快照——
//   - messages.sender_kind：每条消息落库时盖，永远有真值（history 读这个，可靠）。
//   - presence.kind：只有 status 帧写路径会盖；markOffline / kind 列迁移前的旧行 = NULL。
// presence.kind 为 NULL 时，presenceRowToEntry 省略 kind，CLI who.ts kindOf() 便按名字猜
// （非 UUID → "agent"）。于是「只发过普通消息、没发过 status 帧就离线」的人类，被 who 谎报成 agent，
// 而 history 如实报 human。二者对同一身份给出不同的 kind。
//
// 权威来源 = messages.sender_kind（token 盖的、不臆造）。修复让 presence 读侧在自身 kind 为 NULL 时，
// 回填该 name 最近一条消息的 sender_kind，从而 who 与 history 对同一身份返回**同一个** kind 值。
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, postMessage, seedToken } from "./helpers";

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { presence: PresenceEntry[] };
  return body.presence;
}

async function fetchMessages(slug: string, token: string): Promise<MsgFrame[]> {
  const res = await api(`/api/channels/${slug}/messages?since=0&limit=1000`, token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { messages: MsgFrame[] };
  return body.messages;
}

describe("issue #173: who 与 history 对同一身份的 kind 必须一致", () => {
  it("只发过普通消息、离线后 presence.kind=NULL 的人类：/presence 报 human，与 history 同值（不再被猜成 agent）", async () => {
    const creator = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(creator.token);

    // 人类只发一条普通消息（非 status 帧）→ 进 history（sender_kind=human），但**不写 presence**。
    const posted = await postMessage(slug, human.token, "human speaking, can reset loop guard");
    expect(posted.status).toBe(200);

    // watcher 常驻，用它收到的 offline presence 帧同步 markOffline 时机（消 onClose 竞态）。
    const watcher = await WsClient.open(slug, creator.token);
    await watcher.nextOfType("welcome");

    // 人类连一次 WS 再断开 → onClose → markOffline 新建 presence 行，kind 列为 NULL。
    const humanWs = await WsClient.open(slug, human.token);
    await humanWs.nextOfType("welcome");
    humanWs.close();

    // 等 markOffline 广播出该 name 的 offline presence 帧。
    let offlineFrame: PresenceEntry | undefined;
    for (;;) {
      const f = await watcher.nextOfType("presence");
      if (f.name === human.name && f.state === "offline") {
        offlineFrame = f as unknown as PresenceEntry;
        break;
      }
    }

    // history 侧：权威 sender_kind = human。
    const messages = await fetchMessages(slug, human.token);
    const mine = messages.find((m) => m.sender.name === human.name);
    expect(mine).toBeDefined();
    const historyKind = mine!.sender.kind;
    expect(historyKind).toBe("human");

    // presence 侧（who 数据源）：修复前 presence.kind=NULL → 省略 → who 猜成 agent；
    // 修复后回填 messages.sender_kind → human。
    const presence = await fetchPresence(slug, human.token);
    const entry = presence.find((p) => p.name === human.name);
    expect(entry).toBeDefined();
    const presenceKind = entry!.kind;

    // 核心断言：两条路径对同一身份返回**同一个** kind 值（而非只断言字段存在）。
    expect(presenceKind).toBe("human");
    expect(presenceKind).toBe(historyKind);

    // markOffline 走 presenceFor：其广播帧也必须带回填后的 human（覆盖 presenceFor 接线点）。
    expect(offlineFrame!.kind).toBe("human");

    watcher.close();
  });
});
