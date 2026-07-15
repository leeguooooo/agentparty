import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { ADMIN_HEADERS, WsClient, api, createChannel, seedToken } from "./helpers";

describe("websocket", () => {
  it("welcomes with channel, self, participants and last_seq", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    const welcome = await ws.nextOfType("welcome");
    expect(welcome).toMatchObject({
      type: "welcome",
      channel: slug,
      self: name,
      participants: [{ name, kind: "agent" }],
      last_seq: 0,
      presence: [],
    });

    await ws.nextOfType("participants");
    const other = await seedToken("human");
    const second = await WsClient.open(slug, other.token);
    const welcome2 = await second.nextOfType("welcome");
    expect(welcome2.participants).toContainEqual({ name, kind: "agent" });
    expect(welcome2.participants).toContainEqual({ name: other.name, kind: "human" });
    const update = await ws.nextOfType("participants");
    expect(update.participants).toContainEqual({ name, kind: "agent" });
    expect(update.participants).toContainEqual({ name: other.name, kind: "human" });
    second.close();
    const afterLeave = await ws.nextOfType("participants");
    expect(afterLeave.participants).toContainEqual({ name, kind: "agent" });
    expect(afterLeave.participants).not.toContainEqual({ name: other.name, kind: "human" });
    ws.close();
  });

  it("surfaces duplicate live sessions for the same token identity", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    const first = await WsClient.open(slug, token);
    await first.nextOfType("welcome");
    await first.nextOfType("participants");

    const second = await WsClient.open(slug, token);
    const secondWelcome = await second.nextOfType("welcome");
    expect(secondWelcome.participants).toContainEqual({ name, kind: "agent", connection_count: 2 });

    const duplicateUpdate = await first.nextOfType("participants");
    expect(duplicateUpdate.participants).toContainEqual({ name, kind: "agent", connection_count: 2 });

    second.close();
    const afterClose = await first.nextOfType("participants");
    expect(afterClose.participants).toContainEqual({ name, kind: "agent" });
    expect(afterClose.participants).not.toContainEqual({ name, kind: "agent", connection_count: 2 });
    first.close();
  });

  it("accepts browser websocket token through Sec-WebSocket-Protocol", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    const res = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws`, {
      headers: { upgrade: "websocket", "sec-websocket-protocol": `agentparty, ${token}` },
    });
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("agentparty");
    res.webSocket?.accept();
    res.webSocket?.close();

    const ws = await WsClient.open(slug, token, "protocol");
    const welcome = await ws.nextOfType("welcome");
    expect(welcome).toMatchObject({ channel: slug, self: name });
    ws.close();
  });

  it("acks sends with strictly monotonic seq", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    for (let i = 1; i <= 3; i++) {
      ws.send({ type: "send", kind: "message", body: `m${i}`, mentions: [], reply_to: null });
      const sent = await ws.nextOfType("sent");
      expect(sent.seq).toBe(i);
      const echo = await ws.nextOfType("msg");
      expect(echo.seq).toBe(i);
      expect(echo.body).toBe(`m${i}`);
    }
    ws.close();
  });

  it("extracts @name from the body into mentions (bare send should wake the target)", async () => {
    const { token } = await seedToken("agent");
    await seedToken("agent", "bob");
    await seedToken("agent", "carol.dev");
    await seedToken("agent", "agent-a");
    const nicknameTarget = await seedToken("agent");
    await env.DB.prepare(
      "INSERT INTO agent_nicknames (name, nickname, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(nicknameTarget.name, "程序员小明", Date.now(), Date.now()).run();
    await env.DB.prepare(
      `INSERT INTO account_profiles (account, handle, created_at, updated_at, display_name)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind("account-552", "display552", Date.now(), Date.now(), "测试同事").run();
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    // 正文打 @bob，mentions 数组留空——服务端应把 bob 提取进 mentions
    ws.send({ type: "send", kind: "message", body: "hey @BOB and @carol.dev, ping", mentions: [], reply_to: null });
    await ws.nextOfType("sent");
    const echo = await ws.nextOfType("msg");
    expect(echo.mentions).toEqual(["bob", "carol.dev"]);
    // email 里的 @ 不算，显式 mention 与正文 @ 去重合并
    ws.send({ type: "send", kind: "message", body: "mail me@x.com about @bob", mentions: ["bob"], reply_to: null });
    await ws.nextOfType("sent");
    const echo2 = await ws.nextOfType("msg");
    expect(echo2.mentions).toEqual(["bob"]); // 去重，且 me@x.com 不误提
    ws.send({
      type: "send",
      kind: "message",
      body: "请@agent-a看一下，也请@程序员小明帮忙；a@example.com 不算",
      mentions: [],
      reply_to: null,
    });
    await ws.nextOfType("sent");
    const echo3 = await ws.nextOfType("msg");
    expect(echo3.mentions).toEqual(["agent-a", nicknameTarget.name]);
    ws.send({
      type: "send",
      kind: "message",
      body: "请@测试同事确认一下",
      mentions: [],
      reply_to: null,
    });
    await ws.nextOfType("sent");
    const echo4 = await ws.nextOfType("msg");
    expect(echo4.mentions).toEqual(["display552"]);

    await seedToken("agent", "collision552");
    const ambiguousTarget = await seedToken("agent");
    await env.DB.prepare(
      "INSERT INTO agent_nicknames (name, nickname, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(ambiguousTarget.name, "collision552", Date.now(), Date.now()).run();
    ws.send({ type: "send", kind: "message", body: "请@collision552看一下", mentions: [], reply_to: null });
    expect(await ws.nextOfType("error")).toMatchObject({
      code: "bad_request",
      message: "ambiguous mention @collision552",
    });

    ws.send({ type: "send", kind: "message", body: "请@ghost看一下", mentions: [], reply_to: null });
    const error = await ws.nextOfType("error");
    expect(error).toMatchObject({ code: "bad_request", message: "unknown mention @ghost" });
    ws.send({ type: "send", kind: "message", body: "请@bobcat看一下", mentions: [], reply_to: null });
    expect(await ws.nextOfType("error")).toMatchObject({
      code: "bad_request",
      message: "unknown mention @bobcat",
    });
    ws.send({ type: "send", kind: "message", body: "请 @全体 看一下", mentions: [], reply_to: null });
    expect(await ws.nextOfType("error")).toMatchObject({
      code: "bad_request",
      message: "unsupported mention @全体",
    });
    ws.send({ type: "send", kind: "message", body: "请@全体看一下", mentions: [], reply_to: null });
    expect(await ws.nextOfType("error")).toMatchObject({
      code: "bad_request",
      message: "unsupported mention @全体",
    });
    ws.close();
  });

  it("hello since=1 backfills only seq 2 and 3", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const sender = await WsClient.open(slug, token);
    await sender.nextOfType("welcome");
    for (let i = 1; i <= 3; i++) {
      sender.send({ type: "send", kind: "message", body: `m${i}`, mentions: ["bob"], reply_to: null });
      await sender.nextOfType("sent");
    }
    sender.close();

    const reader = await WsClient.open(slug, token);
    const welcome = await reader.nextOfType("welcome");
    expect(welcome.last_seq).toBe(3);
    reader.send({ type: "hello", since: 1 });
    const first = await reader.nextOfType("msg");
    expect(first).toMatchObject({ seq: 2, body: "m2", mentions: ["bob"], reply_to: null });
    const second = await reader.nextOfType("msg");
    expect(second).toMatchObject({ seq: 3, body: "m3" });
    reader.close();
  });

  it("hello since_rev scopes revision replay; welcome carries last_rev_seq (issue #33)", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const sender = await WsClient.open(slug, token);
    await sender.nextOfType("welcome");
    for (let i = 1; i <= 3; i++) {
      sender.send({ type: "send", kind: "message", body: `m${i}`, mentions: [], reply_to: null });
      await sender.nextOfType("sent");
    }
    sender.close();
    // 编辑 seq=1 → 分配 rev_seq=1
    const edited = await api(`/api/channels/${slug}/messages/1/edit`, token, {
      method: "POST",
      body: JSON.stringify({ body: "m1 edited" }),
    });
    expect(edited.status).toBe(200);

    // 旧客户端（hello 不带 since_rev）：即便 since 追平，被编辑的 seq=1 仍会重放（兼容旧行为）
    const legacy = await WsClient.open(slug, token);
    const lw = await legacy.nextOfType("welcome");
    expect(lw.last_rev_seq).toBe(1);
    legacy.send({ type: "hello", since: 3 });
    const replay = await legacy.nextOfType("msg");
    expect(replay).toMatchObject({ seq: 1, body: "m1 edited", edited: true, rev_seq: 1 });
    legacy.close();

    // 新客户端 since_rev=0：这次修订（rev_seq=1 > 0）重放一次
    const fresh = await WsClient.open(slug, token);
    await fresh.nextOfType("welcome");
    fresh.send({ type: "hello", since: 3, since_rev: 0 });
    const once = await fresh.nextOfType("msg");
    expect(once).toMatchObject({ seq: 1, rev_seq: 1 });
    fresh.close();

    // 新客户端 since_rev=1（已见过该修订）：不再重放——用一条新消息当栅栏，
    // 它收到的第一条 msg 必须是栅栏而不是修订快照
    const caughtUp = await WsClient.open(slug, token);
    await caughtUp.nextOfType("welcome");
    caughtUp.send({ type: "hello", since: 3, since_rev: 1 });
    const fence = await WsClient.open(slug, token);
    await fence.nextOfType("welcome");
    fence.send({ type: "send", kind: "message", body: "fence", mentions: [], reply_to: null });
    await fence.nextOfType("sent");
    fence.close();
    const firstMsg = await caughtUp.nextOfType("msg");
    expect(firstMsg).toMatchObject({ seq: 4, body: "fence" });
    caughtUp.close();
  });

  it("broadcasts and backfills completion artifacts", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const sender = await WsClient.open(slug, token);
    await sender.nextOfType("welcome");
    sender.send({ type: "send", kind: "message", body: "kickoff", mentions: [], reply_to: null });
    await sender.nextOfType("sent");
    await sender.nextOfType("msg");

    sender.send({
      type: "send",
      kind: "message",
      body: "final synthesis",
      mentions: [],
      reply_to: 1,
      completion_artifact: {
        kind: "final_synthesis",
        kickoff_seq: 1,
        replies_count: 2,
        timeout: false,
        related_issues: [5],
        related_prs: [8],
      },
    });
    await sender.nextOfType("sent");
    const echo = await sender.nextOfType("msg");
    expect(echo).toMatchObject({
      seq: 2,
      body: "final synthesis",
      completion_artifact: {
        kind: "final_synthesis",
        kickoff_seq: 1,
        replies_count: 2,
        timeout: false,
        related_issues: [5],
        related_prs: [8],
      },
    });
    sender.close();

    const reader = await WsClient.open(slug, token);
    await reader.nextOfType("welcome");
    reader.send({ type: "hello", since: 1 });
    const backfilled = await reader.nextOfType("msg");
    expect(backfilled).toMatchObject({ seq: 2, completion_artifact: { kickoff_seq: 1 } });
    reader.close();
  });

  it("status occupies a seq, updates presence and broadcasts", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    const watcher = await WsClient.open(slug, human.token);
    await watcher.nextOfType("welcome");

    const worker = await WsClient.open(slug, agent.token);
    await worker.nextOfType("welcome");
    worker.send({
      type: "send",
      kind: "status",
      state: "working",
      note: "changing api signature",
      mentions: [human.name],
      role: "worker",
      residency: "supervised",
      wake: { kind: "serve", verified_at: 123 },
      context: {
        config_kind: "explicit",
        config_fingerprint: "sha256:abc123",
        workspace_id: "agentparty-deadbeef",
        workspace_label: "agentparty",
        worktree_label: "agentparty:main",
      },
      scope: ["worker/src/do.ts", "shared/src/protocol.ts"],
      blocked_reason: "waiting for schema review",
      summary_seq: 42,
      decision: {
        kind: "handoff",
        owner: "evil",
        decision: "handoff review host",
        next: "human reviewer owns approval",
        expires_at: 4_200_000,
        handoff_to: human.name,
      },
      workflow: {
        workflow_id: "wf-review",
        kind: "orchestrator-workers",
        run_id: "run-1",
        step_id: "review",
        parent_summary_seq: 7,
      },
    });
    const sent = await worker.nextOfType("sent");
    expect(sent.seq).toBe(1);

    const msg = await watcher.nextOfType("status");
    expect(msg).toMatchObject({
      seq: 1,
      type: "status",
      kind: "status",
      state: "working",
      note: "changing api signature",
      mentions: [human.name],
      status: {
        owner: agent.name,
        state: "working",
        scope: ["worker/src/do.ts", "shared/src/protocol.ts"],
        blocked_reason: "waiting for schema review",
        summary_seq: 42,
        context: {
          config_kind: "explicit",
          config_fingerprint: "sha256:abc123",
          workspace_label: "agentparty",
          worktree_label: "agentparty:main",
        },
        decision: {
          kind: "handoff",
          owner: agent.name,
          decision: "handoff review host",
          next: "human reviewer owns approval",
          expires_at: 4_200_000,
          handoff_to: human.name,
        },
        workflow: {
          workflow_id: "wf-review",
          kind: "orchestrator-workers",
          run_id: "run-1",
          step_id: "review",
          parent_summary_seq: 7,
        },
      },
    });
    const presence = await watcher.nextOfType("presence");
    expect(presence).toMatchObject({
      name: agent.name,
      state: "working",
      note: "changing api signature",
      status: {
        owner: agent.name,
        state: "working",
        scope: ["worker/src/do.ts", "shared/src/protocol.ts"],
        blocked_reason: "waiting for schema review",
        summary_seq: 42,
        decision: {
          kind: "handoff",
          owner: agent.name,
          decision: "handoff review host",
          next: "human reviewer owns approval",
          expires_at: 4_200_000,
          handoff_to: human.name,
        },
        workflow: {
          workflow_id: "wf-review",
          kind: "orchestrator-workers",
          run_id: "run-1",
          step_id: "review",
          parent_summary_seq: 7,
        },
      },
      role: "worker",
      residency: "supervised",
      // #191：客户端在 status 里自报的 wake.verified_at 一律不被采信——verified_at 只由服务端在观测到
      // 真实 @→resume 闭环时盖（见 wakeable-verification.spec）。这里 kind 照收，verified_at 被丢弃。
      wake: { kind: "serve" },
      context: {
        config_kind: "explicit",
        config_fingerprint: "sha256:abc123",
        workspace_id: "agentparty-deadbeef",
        workspace_label: "agentparty",
        worktree_label: "agentparty:main",
      },
    });
    expect(presence.wake).not.toHaveProperty("verified_at");

    worker.send({
      type: "send",
      kind: "status",
      state: "working",
      note: "switching wake layer",
      mentions: [],
      wake: { kind: "none" },
    });
    const secondSent = await worker.nextOfType("sent");
    expect(secondSent.seq).toBe(2);
    await watcher.nextOfType("status");
    const changedWake = await watcher.nextOfType("presence");
    expect(changedWake).toMatchObject({
      name: agent.name,
      state: "working",
      status: {
        owner: agent.name,
        state: "working",
        scope: [],
        blocked_reason: null,
        summary_seq: null,
      },
      role: "worker",
      residency: "supervised",
      wake: { kind: "none" },
      context: {
        config_kind: "explicit",
        config_fingerprint: "sha256:abc123",
        workspace_id: "agentparty-deadbeef",
        workspace_label: "agentparty",
        worktree_label: "agentparty:main",
      },
    });
    expect(changedWake.wake).not.toHaveProperty("verified_at");

    const rejoin = await WsClient.open(slug, human.token);
    const welcome = await rejoin.nextOfType("welcome");
    expect(welcome.last_seq).toBe(2);
    expect(welcome.presence).toContainEqual(
      expect.objectContaining({
        name: agent.name,
        state: "working",
        status: expect.objectContaining({
          owner: agent.name,
          state: "working",
          scope: [],
        }),
        role: "worker",
        residency: "supervised",
        wake: { kind: "none" },
        context: expect.objectContaining({
          config_kind: "explicit",
          workspace_label: "agentparty",
          worktree_label: "agentparty:main",
        }),
      }),
    );
    const history = await SELF.fetch(`http://local/api/channels/${slug}/messages`, {
      headers: { authorization: `Bearer ${human.token}` },
    });
    expect((await history.json()) as unknown).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          type: "status",
          kind: "status",
          mentions: [human.name],
          status: expect.objectContaining({
            owner: agent.name,
            scope: ["worker/src/do.ts", "shared/src/protocol.ts"],
            blocked_reason: "waiting for schema review",
            summary_seq: 42,
            context: expect.objectContaining({
              config_kind: "explicit",
              workspace_label: "agentparty",
            }),
            decision: expect.objectContaining({
              kind: "handoff",
              owner: agent.name,
              handoff_to: human.name,
            }),
            workflow: {
              workflow_id: "wf-review",
              kind: "orchestrator-workers",
              run_id: "run-1",
              step_id: "review",
              parent_summary_seq: 7,
            },
          }),
        }),
      ]),
    });
    watcher.close();
    worker.close();
    rejoin.close();
  });

  it("rejects invalid workflow metadata on status frames", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const res = await api(`/api/channels/${slug}/messages`, token, {
      method: "POST",
      body: JSON.stringify({
        kind: "status",
        state: "working",
        note: "bad workflow",
        workflow: { workflow_id: "wf", kind: "airflow" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("readonly send gets error unauthorized", async () => {
    const agent = await seedToken("agent");
    const ro = await seedToken("readonly");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, ro.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null });
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("unauthorized");
    ws.close();
  });

  it("invalid send payload gets error bad_request", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    ws.send({
      type: "send",
      kind: "message",
      body: "hi",
      mentions: Array.from({ length: 51 }, (_, i) => `agent-${i}`),
      reply_to: null,
    });
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("bad_request");
    ws.close();
  });

  it("invalid reply_to gets error bad_request", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    ws.send({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: 1.5 });
    expect((await ws.nextOfType("error")).code).toBe("bad_request");
    ws.send({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: -1 });
    expect((await ws.nextOfType("error")).code).toBe("bad_request");
    ws.close();
  });

  it("malformed ws frames get error bad_request", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    ws.raw("not-json");
    expect((await ws.nextOfType("error")).code).toBe("bad_request");
    ws.raw("123");
    expect((await ws.nextOfType("error")).code).toBe("bad_request");
    ws.close();
  });

  it("binary ws frames get error bad_request", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    ws.ws.send(new Uint8Array([1, 2, 3]));
    expect((await ws.nextOfType("error")).code).toBe("bad_request");
    ws.close();
  });

  it("answers ping with pong", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    ws.raw('{"type":"ping"}');
    const pong = await ws.nextOfType("pong");
    expect(pong.type).toBe("pong");
    ws.close();
  });

  it("revoking a token kicks its live ws with error unauthorized", async () => {
    const { token, name } = await seedToken("agent");
    const other = await seedToken("human");
    const slug = await createChannel(token);
    const victim = await WsClient.open(slug, token);
    await victim.nextOfType("welcome");
    const bystander = await WsClient.open(slug, other.token);
    await bystander.nextOfType("welcome");

    const del = await SELF.fetch(`http://ap.test/api/tokens/${name}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(del.status).toBe(200);

    const err = await victim.nextOfType("error");
    expect(err.code).toBe("unauthorized");

    // 旁观者不受影响，还能收广播
    const msg = await (async () => {
      const res = await SELF.fetch(`http://ap.test/api/channels/${slug}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "message", body: "still here", mentions: [], reply_to: null }),
      });
      expect(res.status).toBe(200);
      return bystander.nextOfType("msg");
    })();
    expect(msg.body).toBe("still here");
    bystander.close();
  });

  it("revoked token cannot keep sending even if kick notification is missed", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");

    await env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ?")
      .bind(Date.now(), name)
      .run();
    ws.send({ type: "send", kind: "message", body: "after revoke", mentions: [], reply_to: null });
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("unauthorized");
    ws.close();
  });

  it("revoked token cannot keep reading or backfilling even if kick notification is missed", async () => {
    const victimToken = await seedToken("agent");
    const senderToken = await seedToken("human");
    const slug = await createChannel(victimToken.token);
    const victim = await WsClient.open(slug, victimToken.token);
    await victim.nextOfType("welcome");

    await env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ?")
      .bind(Date.now(), victimToken.name)
      .run();

    const sent = await SELF.fetch(`http://ap.test/api/channels/${slug}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${senderToken.token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "message", body: "private update", mentions: [], reply_to: null }),
    });
    expect(sent.status).toBe(200);
    const err = await victim.nextOfType("error");
    expect(err.code).toBe("unauthorized");

    const stale = await WsClient.open(slug, senderToken.token);
    await stale.nextOfType("welcome");
    await env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ?")
      .bind(Date.now(), senderToken.name)
      .run();
    stale.send({ type: "hello", since: 0 });
    expect((await stale.nextOfType("error")).code).toBe("unauthorized");
    victim.close();
    stale.close();
  });

  it("presence scan marks a silent connection offline", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    const silent = await WsClient.open(slug, agent.token);
    await silent.nextOfType("welcome");
    const watcher = await WsClient.open(slug, human.token);
    await watcher.nextOfType("welcome");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      for (const c of instance.getConnections<{ name: string; lastSeen: number }>()) {
        const st = c.state;
        if (st?.name === agent.name) c.setState({ ...st, lastSeen: Date.now() - 120_000 });
      }
      await instance.onAlarm();
    });

    const presence = await watcher.nextOfType("presence");
    expect(presence).toMatchObject({ name: agent.name, state: "offline" });
    watcher.close();
  });

  it("rejects upgrade with a bad token or unknown channel", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const bad = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws`, {
      headers: { upgrade: "websocket", authorization: "Bearer ap_nope" },
    });
    expect(bad.status).toBe(401);
    const missing = await SELF.fetch("http://ap.test/api/channels/no-such-channel/ws", {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
  });

  it("rejects a status frame with an invalid collaboration role using a clear message", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    ws.send({ type: "send", kind: "status", state: "working", note: "x", mentions: [], role: "developer" });
    const err = await ws.nextOfType("error");
    expect(err).toMatchObject({ type: "error", code: "bad_request" });
    expect(err.message).toContain("role");
    expect(err.message).toContain("worker"); // 列出了合法值
    ws.close();
  });

  it("accepts a status frame with a valid collaboration role", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");
    ws.send({ type: "send", kind: "status", state: "working", note: "handling backend", mentions: [], role: "worker" });
    const sent = await ws.nextOfType("sent");
    expect(sent.type).toBe("sent");
    ws.close();
  });
});
