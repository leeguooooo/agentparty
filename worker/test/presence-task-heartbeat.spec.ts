import type { PresenceEntry } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, seedToken } from "./helpers";

// 每任务进度/心跳（issue #228，扩 #103 busy）：serve 处理一条长 wake 期间，用轻量、presence-only 的
// heartbeat 帧把「正在处理的触发 seq、开始时间、最近心跳」刷进 presence，让 who/web 能区分
// 「还在干、活到 T」与「卡死」。心跳不落 history（不刷屏），任务结束由 current_task=null 清除。

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence;
}

// heartbeat 前得先有一行 presence（serve 挂上先发一条 status）。
async function seedPresence(ws: WsClient): Promise<void> {
  ws.send({ type: "send", kind: "status", state: "waiting", note: "attached", mentions: [] });
  await ws.nextOfType("sent");
  await ws.nextOfType("status");
}

describe("presence per-task heartbeat (issue #228)", () => {
  it("stamps current_task / task_started_at / heartbeat_at from a heartbeat frame", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);

    ws.send({ type: "heartbeat", current_task: 510, task_started_at: 1000, heartbeat_at: 1000 });
    // presence-only：广播一条 presence 帧，但不产生新的 msg/status 历史帧
    await ws.nextOfType("presence");

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toMatchObject({ current_task: 510, task_started_at: 1000, heartbeat_at: 1000 });
    ws.close();
  });

  it("advances heartbeat_at on subsequent heartbeats without appending history", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    const welcome = await ws.nextOfType("welcome");
    const headSeq = (welcome as { last_seq: number }).last_seq;
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);

    ws.send({ type: "heartbeat", current_task: 7, task_started_at: 1000, heartbeat_at: 1000 });
    await ws.nextOfType("presence");
    ws.send({ type: "heartbeat", current_task: 7, task_started_at: 1000, heartbeat_at: 5000 });
    await ws.nextOfType("presence");

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toMatchObject({ current_task: 7, task_started_at: 1000, heartbeat_at: 5000 });

    // 心跳不刷屏：history 里只有 seedPresence 那条 status；心跳没有再加任何一条。
    const hist = await api(`/api/channels/${slug}/messages?since=${headSeq}`, agent.token);
    const msgs = ((await hist.json()) as { messages: { seq: number }[] }).messages;
    expect(msgs.filter((m) => m.seq > headSeq).length).toBe(1);
    ws.close();
  });

  it("clears the task fields when a heartbeat carries current_task=null (task done)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);

    ws.send({ type: "heartbeat", current_task: 7, task_started_at: 1000, heartbeat_at: 1000 });
    await ws.nextOfType("presence");
    ws.send({ type: "heartbeat", current_task: null, task_started_at: null, heartbeat_at: null });
    await ws.nextOfType("presence");

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("current_task");
    expect(entry).not.toHaveProperty("task_started_at");
    expect(entry).not.toHaveProperty("heartbeat_at");
    ws.close();
  });

  it("broadcasts the running task to other readers", async () => {
    const agent = await seedToken("agent");
    const observer = await seedToken("human");
    const slug = await createChannel(agent.token);
    const watcher = await WsClient.open(slug, observer.token);
    await watcher.nextOfType("welcome");

    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);
    ws.send({ type: "heartbeat", current_task: 42, task_started_at: 2000, heartbeat_at: 2000 });

    for (;;) {
      const frame = await watcher.nextOfType("presence");
      if (frame.name === agent.name && (frame as { current_task?: number }).current_task === 42) {
        expect(frame).toMatchObject({ current_task: 42, task_started_at: 2000, heartbeat_at: 2000 });
        break;
      }
    }
    ws.close();
    watcher.close();
  });

  it("ignores a malformed heartbeat (negative / non-integer) without erroring the socket", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);

    // 脏值被丢弃：不落 presence、不炸连接（心跳是自动流量，宁可静默忽略也别断流）。
    ws.send({ type: "heartbeat", current_task: -1, task_started_at: 1000, heartbeat_at: 1000 });
    ws.send({ type: "heartbeat", current_task: 9, task_started_at: 1000, heartbeat_at: 1000 });
    await ws.nextOfType("presence");

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toMatchObject({ current_task: 9 });
    ws.close();
  });
});
