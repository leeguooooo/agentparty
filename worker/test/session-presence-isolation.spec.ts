import type { PresenceEntry } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, completeCapabilityHello, createChannel, seedToken } from "./helpers";

async function sendStatus(
  ws: WsClient,
  state: "working" | "waiting",
  note: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  ws.send({ type: "send", kind: "status", state, note, mentions: [], ...extra });
  await ws.nextOfType("sent");
  await ws.nextOfType("status");
}

async function presence(slug: string, token: string, name: string): Promise<PresenceEntry> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  const rows = ((await res.json()) as { presence: PresenceEntry[] }).presence;
  return rows.find((row) => row.name === name)!;
}

describe("same-name websocket session isolation (#363)", () => {
  it("persists an agent-reported model session in presence for restart resume (#522)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    await sendStatus(ws, "waiting", "ready");

    ws.send({
      type: "heartbeat",
      current_task: null,
      task_started_at: null,
      heartbeat_at: null,
      agent_session: {
        harness: "codex",
        session_id: "019f35d9-0000-7000-8000-000000000522",
        updated_at: 1_700_000_000_000,
        cwd: "/workspace/agentparty",
        workdir: "/home/agent/.agentparty/runners/test",
      },
    });
    await ws.nextOfType("presence");

    expect(await presence(slug, agent.token, agent.name)).toMatchObject({
      agent_session: {
        harness: "codex",
        session_id: "019f35d9-0000-7000-8000-000000000522",
        updated_at: 1_700_000_000_000,
        cwd: "/workspace/agentparty",
        workdir: "/home/agent/.agentparty/runners/test",
      },
    });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const row = state.storage.sql
        .exec("SELECT agent_session_json FROM presence WHERE name = ?", agent.name)
        .one();
      expect(JSON.parse(String(row.agent_session_json))).toMatchObject({ harness: "codex" });
    });
    ws.close();
  });

  it("accepts an interactive agent session on a normal status frame (#522)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    await sendStatus(ws, "working", "interactive session", {
      agent_session: {
        harness: "claude",
        session_id: "019f35d9-0000-7000-8000-000000000523",
        updated_at: 1_700_000_000_001,
        cwd: "/workspace/manual",
      },
    });

    expect(await presence(slug, agent.token, agent.name)).toMatchObject({
      state: "working",
      agent_session: {
        harness: "claude",
        session_id: "019f35d9-0000-7000-8000-000000000523",
        cwd: "/workspace/manual",
      },
    });
    ws.close();
  });

  it("keeps status, busy, and task state per connection while aggregating the active session", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const working = await WsClient.open(slug, agent.token);
    const waiting = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(working);
    await completeCapabilityHello(waiting);

    await sendStatus(working, "working", "reviewing do.ts", { busy: true, queue_depth: 2 });
    working.send({ type: "heartbeat", current_task: 363, task_started_at: 1000, heartbeat_at: 2000 });
    await working.nextOfType("presence");
    await sendStatus(waiting, "waiting", "idle");

    const aggregate = await presence(slug, agent.token, agent.name);
    expect(aggregate).toMatchObject({
      state: "working",
      note: "reviewing do.ts",
      busy: true,
      queue_depth: 2,
      current_task: 363,
      connection_count: 2,
    });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const rows = state.storage.sql
        .exec(
          "SELECT session_id, state, note, busy, current_task FROM presence WHERE name = ? ORDER BY state",
          agent.name,
        )
        .toArray();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => String(row.session_id))).size).toBe(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: "waiting", note: "idle", busy: 0, current_task: null }),
          expect.objectContaining({ state: "working", note: "reviewing do.ts", busy: 1, current_task: 363 }),
        ]),
      );
    });

    working.close();
    waiting.close();
  });

  it("removes only the disconnected session and re-aggregates to the surviving session", async () => {
    const agent = await seedToken("agent");
    const observer = await seedToken("human");
    const slug = await createChannel(agent.token);
    const watcher = await WsClient.open(slug, observer.token);
    const working = await WsClient.open(slug, agent.token);
    const waiting = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(watcher);
    await completeCapabilityHello(working);
    await completeCapabilityHello(waiting);

    await sendStatus(working, "working", "session A", { busy: true });
    await sendStatus(waiting, "waiting", "session B");
    working.close();

    for (;;) {
      const frame = await watcher.nextOfType("presence");
      if (frame.name === agent.name && frame.note === "session B") {
        expect(frame.state).toBe("waiting");
        expect(frame).not.toHaveProperty("busy");
        expect(frame).not.toHaveProperty("current_task");
        break;
      }
    }

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const states = state.storage.sql
        .exec("SELECT state FROM presence WHERE name = ? ORDER BY state", agent.name)
        .toArray()
        .map((row) => String(row.state));
      expect(states).toEqual(["waiting"]);
    });

    waiting.close();
    watcher.close();
  });

  it("stores read cursors per connection and exposes the identity maximum", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const first = await WsClient.open(slug, agent.token);
    const second = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(first);
    await completeCapabilityHello(second);

    first.send({ type: "send", kind: "message", body: "m1", mentions: [], reply_to: null });
    const s1 = (await first.nextOfType("sent")).seq;
    first.send({ type: "send", kind: "message", body: "m2", mentions: [], reply_to: null });
    const s2 = (await first.nextOfType("sent")).seq;

    first.send({ type: "seen", seq: s2 });
    await first.nextOfType("read_cursor");
    second.send({ type: "seen", seq: s1 });

    const res = await api(`/api/channels/${slug}/read-cursors`, agent.token);
    const cursors = ((await res.json()) as { cursors: Array<{ name: string; last_seen_seq: number }> }).cursors;
    expect(cursors.filter((row) => row.name === agent.name)).toEqual([
      expect.objectContaining({ name: agent.name, last_seen_seq: s2 }),
    ]);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const rows = state.storage.sql
        .exec("SELECT session_id, last_seen_seq FROM read_cursor WHERE name = ? ORDER BY last_seen_seq", agent.name)
        .toArray();
      expect(rows.map((row) => Number(row.last_seen_seq))).toEqual([s1, s2]);
      expect(new Set(rows.map((row) => String(row.session_id))).size).toBe(2);
    });

    first.close();
    second.close();
  });
});

describe("session schema compatibility migration (#363)", () => {
  it("migrates legacy name-keyed presence and read_cursor rows without data loss", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    expect((await api(`/api/channels/${slug}/presence`, agent.token)).status).toBe(200);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("DROP TABLE presence");
      state.storage.sql.exec(`CREATE TABLE presence (
        name TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        note TEXT,
        updated_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec(
        "INSERT INTO presence (name, state, note, updated_at) VALUES (?, 'working', 'legacy task', 1234)",
        agent.name,
      );
      state.storage.sql.exec("DROP TABLE read_cursor");
      state.storage.sql.exec(`CREATE TABLE read_cursor (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        last_seen_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec(
        "INSERT INTO read_cursor (name, kind, last_seen_seq, updated_at) VALUES (?, 'agent', 7, 1234)",
        agent.name,
      );

      instance.onStart();

      const presenceRows = state.storage.sql
        .exec("SELECT name, session_id, state, note, updated_at FROM presence WHERE name = ?", agent.name)
        .toArray();
      expect(presenceRows).toEqual([
        expect.objectContaining({ name: agent.name, state: "working", note: "legacy task", updated_at: 1234 }),
      ]);
      expect(String(presenceRows[0]!.session_id)).not.toBe("");

      const cursorRows = state.storage.sql
        .exec("SELECT name, session_id, kind, last_seen_seq, updated_at FROM read_cursor WHERE name = ?", agent.name)
        .toArray();
      expect(cursorRows).toEqual([
        expect.objectContaining({ name: agent.name, kind: "agent", last_seen_seq: 7, updated_at: 1234 }),
      ]);

      const presencePk = state.storage.sql
        .exec("PRAGMA table_info(presence)")
        .toArray()
        .filter((row) => Number(row.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((row) => String(row.name));
      expect(presencePk).toEqual(["name", "session_id"]);
      const cursorPk = state.storage.sql
        .exec("PRAGMA table_info(read_cursor)")
        .toArray()
        .filter((row) => Number(row.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((row) => String(row.name));
      expect(cursorPk).toEqual(["name", "session_id"]);
    });

    const migratedPresence = await presence(slug, agent.token, agent.name);
    expect(migratedPresence).toMatchObject({ state: "working", note: "legacy task", ts: 1234 });
    const cursorRes = await api(`/api/channels/${slug}/read-cursors`, agent.token);
    const cursorBody = (await cursorRes.json()) as { cursors: Array<{ name: string; last_seen_seq: number }> };
    expect(cursorBody.cursors).toContainEqual(expect.objectContaining({ name: agent.name, last_seen_seq: 7 }));
  });
});
