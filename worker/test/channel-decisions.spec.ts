import type { ChannelDecisionRecord } from "@agentparty/shared";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ADMIN_HEADERS,
  api,
  completeCapabilityHello,
  createChannel,
  seedToken,
  uniq,
  WsClient,
} from "./helpers";

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function recordDecision(
  slug: string,
  token: string,
  input: {
    topic: string;
    summary: string;
    source_seq?: number;
    supersedes_id?: string;
  },
): Promise<Response> {
  return api(`/api/channels/${slug}/decisions`, token, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function postHostStatus(slug: string, token: string, note: string): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({
      kind: "status",
      state: "working",
      note,
      mentions: [],
      role: "host",
    }),
  });
}

describe("authoritative channel decision ledger (#736)", () => {
  it("is append-only, owner/assigned-host writable, and projected into the charter snapshot", async () => {
    const owner = await seedToken("agent", uniq("owner"), {
      owner: `${uniq("owner")}@example.com`,
    });
    const slug = await createChannel(owner.token);
    const guest = await seedToken("agent", uniq("guest"), {
      owner: `${uniq("guest")}@example.com`,
      channelScope: slug,
    });
    const host = await seedToken("agent", uniq("host"), {
      owner: `${uniq("host")}@example.com`,
      channelScope: slug,
    });
    const readonlyHost = await seedToken("readonly", uniq("readonly-host"), {
      owner: `${uniq("readonly-host")}@example.com`,
      channelScope: slug,
    });

    const initialCharter = await responseJson<{ active_decisions: ChannelDecisionRecord[] }>(
      await api(`/api/channels/${slug}/charter`, guest.token),
    );
    expect(initialCharter.active_decisions).toEqual([]);

    const denied = await recordDecision(slug, guest.token, {
      topic: "storage",
      summary: "guest self-claim must not become authoritative",
    });
    expect(denied.status).toBe(403);

    const firstResponse = await recordDecision(slug, owner.token, {
      topic: "Storage",
      summary: "Use D1 as the authoritative ledger.",
      source_seq: 12,
    });
    expect(firstResponse.status).toBe(201);
    const first = await responseJson<ChannelDecisionRecord>(firstResponse);
    expect(first).toMatchObject({
      type: "channel_decision",
      channel: slug,
      topic: "Storage",
      summary: "Use D1 as the authoritative ledger.",
      source_seq: 12,
      supersedes_id: null,
      superseded_by_id: null,
      status: "active",
      created_by: owner.name,
    });

    const implicitOverwrite = await recordDecision(slug, owner.token, {
      topic: "storage",
      summary: "Silently overwrite it.",
    });
    expect(implicitOverwrite.status).toBe(409);
    expect(await responseJson(implicitOverwrite)).toMatchObject({
      error: { code: "conflict", message: expect.stringContaining(first.id) },
    });

    expect(
      (
        await api(`/api/channels/${slug}/roles/${host.name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "host", responsibility: "maintain settled decisions" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(`/api/channels/${slug}/roles/${readonlyHost.name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "host" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await recordDecision(slug, readonlyHost.token, {
          topic: "readonly-escalation",
          summary: "A readonly token must remain unable to write after host assignment.",
        })
      ).status,
    ).toBe(403);

    const secondResponse = await recordDecision(slug, host.token, {
      topic: "Storage",
      summary: "Use D1 plus an immutable history and mutable topic heads.",
      source_seq: 18,
      supersedes_id: first.id,
    });
    expect(secondResponse.status).toBe(201);
    const second = await responseJson<ChannelDecisionRecord>(secondResponse);
    expect(second).toMatchObject({
      topic: "Storage",
      status: "active",
      supersedes_id: first.id,
      created_by: host.name,
    });

    const active = await responseJson<{ decisions: ChannelDecisionRecord[] }>(
      await api(`/api/channels/${slug}/decisions`, guest.token),
    );
    expect(active.decisions).toEqual([second]);

    const all = await responseJson<{ decisions: ChannelDecisionRecord[] }>(
      await api(`/api/channels/${slug}/decisions?status=all`, guest.token),
    );
    expect(all.decisions).toHaveLength(2);
    expect(all.decisions).toEqual(
      expect.arrayContaining([
        second,
        expect.objectContaining({
          id: first.id,
          status: "superseded",
          superseded_by_id: second.id,
        }),
      ]),
    );

    const charter = await responseJson<{ active_decisions: ChannelDecisionRecord[] }>(
      await api(`/api/channels/${slug}/charter`, guest.token),
    );
    expect(charter.active_decisions).toEqual([second]);

    const charterUpdate = await api(`/api/channels/${slug}/charter`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "Keep the active ledger next to this charter." }),
    });
    expect(charterUpdate.status).toBe(200);
    expect(await responseJson<{ active_decisions: ChannelDecisionRecord[] }>(charterUpdate)).toMatchObject({
      active_decisions: [second],
    });

    const crossScoped = await seedToken("agent", uniq("cross-scoped-host"), {
      owner: `${uniq("cross-scoped")}@example.com`,
      channelScope: uniq("other-channel"),
    });
    expect(
      (
        await api(`/api/channels/${slug}/roles/${crossScoped.name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "host" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await recordDecision(slug, crossScoped.token, {
          topic: "scope-escape",
          summary: "A token scoped elsewhere must never inherit this channel's host role.",
        })
      ).status,
    ).toBe(403);

    const history = await responseJson<{ messages: Array<{ kind: string; body: string }> }>(
      await api(`/api/channels/${slug}/messages?since=0&limit=20`, guest.token),
    );
    expect(history.messages).toContainEqual(
      expect.objectContaining({
        kind: "status",
        body: `decision ledger updated: ${second.id}`,
      }),
    );
  });

  it("allows only one concurrent supersede of the same active head", async () => {
    const owner = await seedToken("agent", uniq("owner"), {
      owner: `${uniq("owner")}@example.com`,
    });
    const slug = await createChannel(owner.token);
    const initialResponse = await recordDecision(slug, owner.token, {
      topic: "transport",
      summary: "Use the initial transport.",
    });
    expect(initialResponse.status).toBe(201);
    const initial = await responseJson<ChannelDecisionRecord>(initialResponse);

    const responses = await Promise.all([
      recordDecision(slug, owner.token, {
        topic: "transport",
        summary: "Use candidate A.",
        supersedes_id: initial.id,
      }),
      recordDecision(slug, owner.token, {
        topic: "transport",
        summary: "Use candidate B.",
        supersedes_id: initial.id,
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    const active = await responseJson<{ decisions: ChannelDecisionRecord[] }>(
      await api(`/api/channels/${slug}/decisions`, owner.token),
    );
    expect(active.decisions).toHaveLength(1);
    expect(active.decisions[0]).toMatchObject({
      supersedes_id: initial.id,
      status: "active",
    });
    const all = await responseJson<{ decisions: ChannelDecisionRecord[] }>(
      await api(`/api/channels/${slug}/decisions?status=all`, owner.token),
    );
    expect(all.decisions).toHaveLength(2);
    const bounded = await responseJson<{ decisions: ChannelDecisionRecord[]; truncated: boolean }>(
      await api(`/api/channels/${slug}/decisions?status=all&limit=1`, owner.token),
    );
    expect(bounded).toMatchObject({ truncated: true });
    expect(bounded.decisions).toHaveLength(1);
  });

  it("keeps the ledger read-only after archival at the database boundary", async () => {
    const owner = await seedToken("agent", uniq("owner"), {
      owner: `${uniq("owner")}@example.com`,
    });
    const slug = await createChannel(owner.token);
    await env.DB.prepare("UPDATE channels SET archived_at = ? WHERE slug = ?")
      .bind(Date.now(), slug)
      .run();

    expect(
      (
        await recordDecision(slug, owner.token, {
          topic: "late-write",
          summary: "An archived channel must reject ledger writes.",
        })
      ).status,
    ).toBe(410);
    await expect(
      env.DB.prepare(
        `INSERT INTO channel_decisions (
           id, channel_slug, topic, summary, source_seq, supersedes_id,
           created_by, created_by_kind, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `decision_${crypto.randomUUID().replaceAll("-", "")}`,
          slug,
          "late-write",
          "This insert bypasses the route snapshot.",
          null,
          null,
          owner.name,
          "agent",
          Date.now(),
        )
        .run(),
    ).rejects.toThrow(/channel is archived/i);
  });

  it("warns a self-claimed host when another host is owner-assigned, including REST and WS", async () => {
    const owner = await seedToken("agent", uniq("owner"), {
      owner: `${uniq("owner")}@example.com`,
    });
    const slug = await createChannel(owner.token);
    const assigned = await seedToken("agent", uniq("assigned-host"), {
      owner: `${uniq("assigned")}@example.com`,
      channelScope: slug,
    });
    const claimant = await seedToken("agent", uniq("claimant"), {
      owner: `${uniq("claimant")}@example.com`,
      channelScope: slug,
    });

    expect(
      (
        await api(`/api/channels/${slug}/roles/${assigned.name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "host" }),
        })
      ).status,
    ).toBe(200);
    // 任意其它 assigned role 也不能靠 status 自封 host。
    expect(
      (
        await api(`/api/channels/${slug}/roles/${claimant.name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "reviewer" }),
        })
      ).status,
    ).toBe(200);

    const restClaim = await postHostStatus(slug, claimant.token, "I will take host");
    expect(restClaim.status).toBe(200);
    expect(await responseJson<{ role_warning?: string }>(restClaim)).toMatchObject({
      role_warning: expect.stringContaining(`assigned host @${assigned.name}`),
    });

    const assignedStatus = await postHostStatus(slug, assigned.token, "assigned host online");
    expect(assignedStatus.status).toBe(200);
    expect(await responseJson<{ role_warning?: string }>(assignedStatus)).not.toHaveProperty("role_warning");

    // Worker/DO role snapshots can briefly arrive out of order after reassignment. The durable
    // name + owner role binding still recognizes the real host without trusting a same-name impostor.
    const assignedToken = await env.DB.prepare("SELECT hash, owner FROM tokens WHERE name = ?")
      .bind(assigned.name)
      .first<{ hash: string; owner: string }>();
    expect(assignedToken).not.toBeNull();
    const staleRoleStatus = await env.CHANNELS.get(env.CHANNELS.idFromName(slug)).fetch(
      "http://ap.test/internal/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-partykit-room": slug,
          "x-ap-name": assigned.name,
          "x-ap-kind": "agent",
          "x-ap-role": "agent",
          "x-ap-owner": assignedToken!.owner,
          "x-ap-token-hash": assignedToken!.hash,
          "x-ap-assigned-host": assigned.name,
          "x-ap-can-write": "1",
        },
        body: JSON.stringify({
          type: "send",
          kind: "status",
          state: "working",
          note: "assigned host with a stale collaboration-role snapshot",
          mentions: [],
          role: "host",
        }),
      },
    );
    expect(staleRoleStatus.status).toBe(200);
    expect(await responseJson<{ role_warning?: string }>(staleRoleStatus)).not.toHaveProperty("role_warning");

    // 先让已连接 socket 真正拿到 host，再在线改派成 reviewer；旧连接不能保留 stale host。
    expect(
      (
        await api(`/api/channels/${slug}/roles/${claimant.name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "host" }),
        })
      ).status,
    ).toBe(200);
    const ws = await WsClient.open(slug, claimant.token);
    await completeCapabilityHello(ws);
    expect(
      (
        await api(`/api/channels/${slug}/roles/${claimant.name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "reviewer" }),
        })
      ).status,
    ).toBe(200);
    ws.send({
      type: "send",
      kind: "status",
      state: "working",
      note: "claiming again over websocket",
      mentions: [],
      role: "host",
    });
    const sent = await ws.nextOfType("sent");
    expect(sent.role_warning).toContain(`assigned host @${assigned.name}`);
    const presence = await responseJson<{
      presence: Array<{ name: string; role?: string; role_source?: string }>;
    }>(await api(`/api/channels/${slug}/presence`, owner.token));
    expect(presence.presence.find((entry) => entry.name === claimant.name)).toMatchObject({
      role: "reviewer",
      role_source: "assigned",
    });
    ws.close();

    // #101：role 绑定 principal（owner account），不能只按同名放行。旧 token 撤销后，
    // 另一账号重铸相同 name 仍是 self-claim，应明确告警。
    expect(
      (
        await api(`/api/tokens/${assigned.name}`, "unused", {
          method: "DELETE",
          headers: ADMIN_HEADERS,
        })
      ).status,
    ).toBe(200);
    const reminted = await api("/api/tokens", "unused", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        name: assigned.name,
        role: "agent",
        owner: `${uniq("different-owner")}@example.com`,
        channel_scope: slug,
      }),
    });
    expect(reminted.status).toBe(201);
    const sameNameDifferentAccount = await responseJson<{ token: string }>(reminted);
    const impersonatedClaim = await postHostStatus(
      slug,
      sameNameDifferentAccount.token,
      "same name, different principal",
    );
    expect(impersonatedClaim.status).toBe(200);
    expect(await responseJson<{ role_warning?: string }>(impersonatedClaim)).toMatchObject({
      role_warning: expect.stringContaining(`assigned host @${assigned.name}`),
    });
  });
});
