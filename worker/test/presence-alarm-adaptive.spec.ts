// #487（降本）：Durable Objects Compute 是 Cloudflare 账单最大头（$37.50/68%），根因是每个有连接的
// 频道 DO 被 60s presence 扫描 alarm 24/7 每分钟唤醒一次。本 spec 证明改造后：
//   ① 唤醒频率下降——健康连接的下一次扫描排到 ~PRESENCE_SCAN_MS(120s) 而非旧的 60s；且按连接真实到期
//      时刻自适应（earliestSeen + 窗口），无连接时干脆不排 presence alarm。
//   ② presence 超时仍能检出——静默超过 PRESENCE_SCAN_MS 的半开连接照样被标 offline 回收。
//   ③ paused/retention/temp 等其它 alarm 用途不受影响——它们走 scheduleNextAlarm 的独立 candidates，
//      即便一个连接都没有也照常排点（这里以 #180 定时恢复为代表）。
import { PRESENCE_TIMEOUT_MS } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type ChannelDO, PRESENCE_SCAN_MS } from "../src/do";
import { WsClient, createChannel, seedToken } from "./helpers";

type ConnPeek = { name: string; lastSeen: number };

describe("#487 presence 扫描 alarm 自适应降本", () => {
  it("① 健康连接：下一次扫描排到 ~PRESENCE_SCAN_MS 之外，而非旧的每 60s 唤醒", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    ws.raw('{"type":"ping","probe":"hello"}');
    await ws.nextOfType("pong");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const res = await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      // 刚 ping 过的健康连接（lastSeen=now，auto-response 未介入）
      for (const c of instance.getConnections<ConnPeek>()) {
        const st = c.state;
        if (st?.name === agent.name) c.setState({ ...st, lastSeen: now });
      }
      await instance.onAlarm();
      return { alarm: await state.storage.getAlarm(), now };
    });

    expect(res.alarm).not.toBeNull();
    // 旧实现固定 now+60s；新实现 earliestSeen(=now)+120s。断言明显越过旧的 60s cadence。
    expect(res.alarm!).toBeGreaterThan(res.now + PRESENCE_TIMEOUT_MS + 10_000);
    expect(res.alarm!).toBeLessThanOrEqual(res.now + PRESENCE_SCAN_MS + 2_000);
    ws.close();
  });

  it("① 自适应：下一次扫描 = 最早连接的 last + 窗口，不是固定 now+窗口", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    ws.raw('{"type":"ping","probe":"hello"}');
    await ws.nextOfType("pong");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const res = await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      const now = Date.now();
      // 40s 前 ping 过：到期应在 now + (窗口 - 40s)，证明是 earliestSeen 驱动而非固定 now+窗口
      for (const c of instance.getConnections<ConnPeek>()) {
        const st = c.state;
        if (st?.name === agent.name) c.setState({ ...st, lastSeen: now - 40_000 });
      }
      await instance.onAlarm();
      return { alarm: await state.storage.getAlarm(), now };
    });

    const expected = res.now + (PRESENCE_SCAN_MS - 40_000);
    expect(res.alarm!).toBeGreaterThan(expected - 3_000);
    expect(res.alarm!).toBeLessThanOrEqual(expected + 3_000);
    ws.close();
  });

  it("① 无存活连接：不再挂 presence 扫描 alarm（DO 可睡到别的 candidate）", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token); // standing 频道，init 不排 alarm

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const alarm = await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      instance.onStart(); // 未经连接的 standing DO 尚未建表，先物化 schema（幂等 CREATE IF NOT EXISTS）
      await instance.onAlarm();
      return state.storage.getAlarm();
    });
    expect(alarm).toBeNull();
  });

  it("② 静默 > PRESENCE_SCAN_MS 的半开连接仍被标 offline；60~120s 之间的连接不被误回收", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    const silent = await WsClient.open(slug, agent.token);
    await silent.nextOfType("welcome");
    silent.send({ type: "hello", since: 0 });
    silent.raw('{"type":"ping","probe":"hello"}');
    await silent.nextOfType("pong");
    const watcher = await WsClient.open(slug, human.token);
    await watcher.nextOfType("welcome");
    watcher.send({ type: "hello", since: 0 });
    watcher.raw('{"type":"ping","probe":"hello"}');
    await watcher.nextOfType("pong");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));

    // (a) 90s 静默（旧 60s 窗口会误杀）：新窗口下仍存活，连接不被关。健康端每 25s ping，永远够不到 120s。
    const survived = await runInDurableObject(stub, async (instance: ChannelDO) => {
      const now = Date.now();
      for (const c of instance.getConnections<ConnPeek>()) {
        const st = c.state;
        if (st?.name === agent.name) c.setState({ ...st, lastSeen: now - 90_000 });
      }
      await instance.onAlarm();
      let found = false;
      for (const c of instance.getConnections<ConnPeek>()) if (c.state?.name === agent.name) found = true;
      return found;
    });
    expect(survived).toBe(true);

    // (b) 越过 PRESENCE_SCAN_MS 的静默：判 offline 并回收，watcher 收到 offline presence。
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      const now = Date.now();
      for (const c of instance.getConnections<ConnPeek>()) {
        const st = c.state;
        if (st?.name === agent.name) c.setState({ ...st, lastSeen: now - (PRESENCE_SCAN_MS + 1_000) });
      }
      await instance.onAlarm();
    });
    const presence = await watcher.nextOfType("presence");
    expect(presence).toMatchObject({ name: agent.name, state: "offline" });
    watcher.close();
  });

  it("③ 其它 alarm 用途不受影响：无连接时 paused 定时恢复（#180）仍照常排点", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const res = await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      instance.onStart(); // 物化 schema（standing DO 未经连接尚未建表）
      const now = Date.now();
      const resumeAt = now + 300_000;
      // 一条未来才恢复的 paused presence，没有任何活连接
      state.storage.sql.exec(
        "INSERT INTO presence (name, session_id, state, note, updated_at, paused_resume_at) VALUES (?, ?, 'offline', NULL, ?, ?)",
        "pausedbot",
        "s1",
        now,
        resumeAt,
      );
      await instance.onAlarm();
      return { alarm: await state.storage.getAlarm(), resumeAt };
    });
    // presence 扫描贡献为空（无连接），但 paused 恢复 candidate 照样把 alarm 排到恢复时刻。
    expect(res.alarm).not.toBeNull();
    expect(res.alarm!).toBeGreaterThan(res.resumeAt - 3_000);
    expect(res.alarm!).toBeLessThanOrEqual(res.resumeAt + 3_000);
  });
});
