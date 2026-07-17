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

  // 模型 session 活动（issue #602）：hook 落盘、serve 心跳捎带的「正在干什么」快照。
  // 新鲜度与心跳同生共死：本拍没带就清空，任务结束/离线一并清除。
  it("stamps activity from a heartbeat and clears it when the next beat omits it (#602)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);
    // 排掉 seedPresence 自己触发的 presence 广播，后续每个 nextOfType("presence") 都对齐一拍心跳
    await ws.nextOfType("presence");

    ws.send({
      type: "heartbeat",
      current_task: 7,
      task_started_at: 1000,
      heartbeat_at: 1000,
      activity: { phase: "tool", tool: "Bash", ts: 1000 },
    });
    await ws.nextOfType("presence");
    let entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toMatchObject({ current_task: 7, activity: { phase: "tool", tool: "Bash", ts: 1000 } });

    // 下一拍没带 activity（hook 文件缺失/过期）→ 清空，绝不留僵值
    ws.send({ type: "heartbeat", current_task: 7, task_started_at: 1000, heartbeat_at: 2000 });
    await ws.nextOfType("presence");
    entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toMatchObject({ current_task: 7, heartbeat_at: 2000 });
    expect(entry).not.toHaveProperty("activity");
    ws.close();
  });

  it("clears activity together with the task fields on the current_task=null clear beat (#602)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);
    await ws.nextOfType("presence");

    ws.send({
      type: "heartbeat",
      current_task: 7,
      task_started_at: 1000,
      heartbeat_at: 1000,
      activity: { phase: "waiting_permission", tool: "Bash", ts: 1000 },
    });
    await ws.nextOfType("presence");
    // 清除帧即便捎带 activity 也一并清：没有任务就没有活动可言
    ws.send({
      type: "heartbeat",
      current_task: null,
      task_started_at: null,
      heartbeat_at: null,
      activity: { phase: "idle", ts: 2000 },
    });
    await ws.nextOfType("presence");

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("current_task");
    expect(entry).not.toHaveProperty("activity");
    ws.close();
  });

  it("drops a heartbeat carrying a malformed activity, same as a dirty agent_session (#602)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);
    await ws.nextOfType("presence");

    // 未知 phase → 整帧丢弃；随后的干净帧照常生效（不炸连接）
    ws.send({
      type: "heartbeat",
      current_task: 5,
      task_started_at: 1000,
      heartbeat_at: 1000,
      activity: { phase: "hacking", ts: 1000 },
    });
    ws.send({
      type: "heartbeat",
      current_task: 6,
      task_started_at: 1000,
      heartbeat_at: 1000,
      activity: { phase: "working", ts: 1000 },
    });
    // 排掉 seed 后第一条到达的 presence 就是干净帧的广播——脏帧被丢弃、从未广播
    const frame = await ws.nextOfType("presence");
    expect(frame).toMatchObject({ name: agent.name, current_task: 6, activity: { phase: "working", ts: 1000 } });

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toMatchObject({ current_task: 6, activity: { phase: "working", ts: 1000 } });
    ws.close();
  });

  // runner 健康自报（issue #603）：serve 在任务收尾拍带上连败计数；独立于 current_task 生命周期
  //（空闲期也要能看见「干不动」），恢复由后续心跳缺省即清。
  it("stamps runner_health from a clear beat and keeps it visible while idle (#603)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);
    // 排掉 seedPresence 的 presence 广播，后续 nextOfType("presence") 对齐一拍心跳（防竞态）
    await ws.nextOfType("presence");

    // 任务放弃后的清除帧：task 字段全 null，但 runner_health 留在 presence 上（空闲期可见）
    ws.send({
      type: "heartbeat",
      current_task: null,
      task_started_at: null,
      heartbeat_at: null,
      runner_health: { ok: false, consecutive_failures: 2, last_error: "spawn claude ENOENT" },
    });
    await ws.nextOfType("presence");
    let entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toMatchObject({
      runner_health: { ok: false, consecutive_failures: 2, last_error: "spawn claude ENOENT" },
    });
    expect(entry).not.toHaveProperty("current_task");

    // 恢复：下一拍缺省 runner_health 即清空
    ws.send({ type: "heartbeat", current_task: null, task_started_at: null, heartbeat_at: null });
    await ws.nextOfType("presence");
    entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).not.toHaveProperty("runner_health");
    ws.close();
  });

  it("drops a heartbeat carrying a malformed runner_health (#603)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);
    await ws.nextOfType("presence");

    ws.send({
      type: "heartbeat",
      current_task: 5,
      task_started_at: 1000,
      heartbeat_at: 1000,
      runner_health: { ok: "nope", consecutive_failures: -1 },
    });
    ws.send({ type: "heartbeat", current_task: 6, task_started_at: 1000, heartbeat_at: 1000 });
    await ws.nextOfType("presence");

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toMatchObject({ current_task: 6 });
    expect(entry).not.toHaveProperty("runner_health");
    ws.close();
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


// runner_health.last_error 会被 who/wake 直接拼进终端：控制字符在协议校验层统一剥离（#603 复审）。
describe("runner_health last_error hygiene (#603)", () => {
  it("strips control characters from last_error before persisting", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    await seedPresence(ws);
    await ws.nextOfType("presence");

    ws.send({
      type: "heartbeat",
      current_task: null,
      task_started_at: null,
      heartbeat_at: null,
      runner_health: { ok: false, consecutive_failures: 2, last_error: "boom\u001b[31mevil\u0007end" },
    });
    await ws.nextOfType("presence");
    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry?.runner_health?.last_error).toBe("boom[31mevilend");
    ws.close();
  });
});
