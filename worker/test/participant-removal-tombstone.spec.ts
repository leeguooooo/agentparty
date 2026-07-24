// Persistent participant-removal authority.
//
// A kick is not merely a best-effort WebSocket cleanup: its D1 tombstone must
// continue to deny public-channel REST/WS entry, stale role/identity projections,
// ordinary tokens, join links, mentions, and queued webhook work. Only an
// explicit moderator re-add may restore the matching account, and an old DO
// broadcast must not undo that newer decision.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, seedToken, uniq, WsClient } from "./helpers";

interface RemovalRow {
  principal_type: "name" | "account";
  principal: string;
  restore_account: string | null;
  removed_at: number;
  removal_epoch: string;
}

interface KickBody {
  ok: true;
  removal: {
    type: "participant_removed";
    name: string;
    removed_at: number;
  } | null;
  broadcasted: boolean;
}

async function makePublicChannel(token: string): Promise<string> {
  const slug = uniq("removed");
  const response = await api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug, kind: "standing", visibility: "public" }),
  });
  if (response.status !== 201) {
    throw new Error(`create public channel failed: ${response.status} ${await response.text()}`);
  }
  return slug;
}

function sendMessage(
  slug: string,
  token: string,
  body: string,
  mentions: string[] = [],
): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null }),
  });
}

function removeParticipant(slug: string, moderatorToken: string, name: string): Promise<Response> {
  return api(`/api/channels/${slug}/kick`, moderatorToken, {
    method: "POST",
    body: JSON.stringify({ name, mode: "remove" }),
  });
}

async function addMember(slug: string, moderatorToken: string, account: string): Promise<Response> {
  return api(`/api/channels/${slug}/members/${encodeURIComponent(account)}`, moderatorToken, {
    method: "PUT",
  });
}

async function removalRows(slug: string): Promise<RemovalRow[]> {
  return (
    await env.DB.prepare(
      `SELECT principal_type, principal, restore_account, removed_at, removal_epoch
         FROM channel_participant_removals
        WHERE channel_slug = ?
        ORDER BY principal_type, principal`,
    )
      .bind(slug)
      .all<RemovalRow>()
  ).results;
}

async function insertAccountRemoval(
  slug: string,
  account: string,
  removedBy: string,
  removedAt = Date.now(),
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO channel_participant_removals
         (channel_slug, principal_type, principal, restore_account, removed_at, removal_epoch, removed_by)
       VALUES (?, 'account', ?, NULL, ?, ?, ?)`,
    ).bind(slug, account, removedAt, crypto.randomUUID(), removedBy),
    env.DB.prepare(
      `INSERT INTO channel_account_bans (channel_slug, account, banned_by, banned_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(slug, account, removedBy, removedAt),
  ]);
}

async function roleNames(slug: string, token: string): Promise<string[]> {
  const response = await api(`/api/channels/${slug}/roles`, token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { roles: Array<{ name: string }> }).roles.map((role) => role.name);
}

async function identityNames(slug: string, token: string): Promise<string[]> {
  const response = await api(`/api/channels/${slug}/identities`, token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { identities: Array<{ name: string }> }).identities.map(
    (identity) => identity.name,
  );
}

async function channelSlugs(token: string): Promise<string[]> {
  const response = await api("/api/channels", token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { channels: Array<{ slug: string }> }).channels.map(
    (channel) => channel.slug,
  );
}

async function installKickFailure(slug: string, participantName: string): Promise<void> {
  const escapedName = participantName.replaceAll("'", "''");
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (instance: ChannelDO, state) => {
    state.storage.sql.exec(`
      CREATE TRIGGER fail_participant_remove_status
      BEFORE INSERT ON messages
      WHEN NEW.sender_name = 'system'
       AND NEW.body = 'removed ${escapedName} from channel'
      BEGIN
        SELECT RAISE(ABORT, 'forced participant cleanup failure');
      END
    `);
    // The kick cleanup and participant_removed fan-out are separate DO calls.
    // Force the latter to throw as well, so the HTTP assertion covers the
    // authoritative D1 commit when *both* best-effort coordination phases fail.
    Object.defineProperty(instance, "broadcastFrame", {
      configurable: true,
      value: () => {
        throw new Error("forced participant broadcast failure");
      },
    });
  });
}

async function deliverySnapshot(
  slug: string,
  target: string,
): Promise<{ directed: number; queued: number; ledger: number }> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const directed = state.storage.sql
      .exec("SELECT COUNT(*) AS count FROM directed_deliveries WHERE target_name = ?", target)
      .one();
    const queued = state.storage.sql
      .exec("SELECT COUNT(*) AS count FROM webhook_queue WHERE webhook_name = ?", target)
      .one();
    const ledger = state.storage.sql
      .exec("SELECT COUNT(*) AS count FROM wake_delivery_ledger WHERE target_name = ?", target)
      .one();
    return {
      directed: Number(directed.count),
      queued: Number(queued.count),
      ledger: Number(ledger.count),
    };
  });
}

async function rejectWebhookOnce(
  slug: string,
  senderToken: string,
  target: string,
  webhookOrigin: string,
): Promise<void> {
  const downstream = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === webhookOrigin) {
      throw new Error("forced initial webhook failure");
    }
    return downstream(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
  try {
    const response = await sendMessage(slug, senderToken, `@${target} queued before removal`, [target]);
    expect(response.status).toBe(200);
    // Webhook first delivery runs through waitUntil, outside the synchronous send path.
    await new Promise((resolve) => setTimeout(resolve, 75));
  } finally {
    globalThis.fetch = downstream;
  }
}

async function expectNoQueuedWebhookRetry(
  slug: string,
  webhookOrigin: string,
): Promise<void> {
  let outboundAttempts = 0;
  const downstream = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === webhookOrigin) {
      outboundAttempts += 1;
      return new Response("unexpected delivery", { status: 200 });
    }
    return downstream(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
  try {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE webhook_queue SET next_retry_at = ?", Date.now() - 1);
      await instance.onAlarm();
    });
  } finally {
    globalThis.fetch = downstream;
  }
  expect(outboundAttempts).toBe(0);
}

async function expectWebSocketEntryDenied(slug: string, token: string): Promise<void> {
  const response = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws`, {
    headers: {
      upgrade: "websocket",
      "sec-websocket-protocol": `agentparty, ${token}`,
    },
  });
  if (response.status === 403) return;
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const ws = response.webSocket!;
  ws.accept();
  const first = await new Promise<"forbidden" | "welcome">((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("removed participant WS did not terminate")), 3_000);
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type?: string; code?: string };
      if (frame.type === "welcome") {
        clearTimeout(timer);
        resolve("welcome");
      } else if (frame.type === "error" && frame.code === "forbidden") {
        clearTimeout(timer);
        resolve("forbidden");
      }
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve("forbidden");
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve("forbidden");
    });
  });
  expect(first).toBe("forbidden");
}

describe("persistent channel participant removals", () => {
  it("commits D1 revocation atomically and returns 200 when DO cleanup/broadcast fails", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const victimAccount = `${uniq("victim")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const victim = await seedToken("agent", uniq("victim"), { owner: victimAccount });
    const slug = await makePublicChannel(owner.token);

    expect((await addMember(slug, owner.token, victimAccount)).status).toBe(200);
    expect(
      (
        await api(`/api/channels/${slug}/roles/${victim.name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "worker", responsibility: "removed atomically" }),
        })
      ).status,
    ).toBe(200);
    expect((await sendMessage(slug, victim.token, "initialize the channel DO")).status).toBe(200);
    await installKickFailure(slug, victim.name);

    const response = await removeParticipant(slug, owner.token, victim.name);
    expect(response.status).toBe(200);
    const body = (await response.json()) as KickBody;
    expect(body).toMatchObject({
      ok: true,
      removal: {
        type: "participant_removed",
        name: victim.name,
        removed_at: expect.any(Number),
      },
      broadcasted: false,
    });

    const tombstones = await removalRows(slug);
    expect(tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principal_type: "name",
          principal: victim.name,
          removed_at: body.removal!.removed_at,
          removal_epoch: expect.any(String),
        }),
        expect.objectContaining({
          principal_type: "account",
          principal: victimAccount,
          removed_at: body.removal!.removed_at,
          removal_epoch: expect.any(String),
        }),
      ]),
    );
    expect(
      await env.DB.prepare(
        "SELECT account FROM channel_members WHERE channel_slug = ? AND account = ?",
      )
        .bind(slug, victimAccount)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT agent_name FROM channel_roles WHERE channel_slug = ? AND agent_name = ?",
      )
        .bind(slug, victim.name)
        .first(),
    ).toBeNull();
    const token = await env.DB.prepare("SELECT revoked_at FROM tokens WHERE name = ?")
      .bind(victim.name)
      .first<{ revoked_at: number | null }>();
    expect(token?.revoked_at).toBeNull();
    expect((await api("/api/me", victim.token)).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, victim.token)).status).toBe(403);
  });

  it("blocks stale roles/identities, public entry, ordinary rejoin, mentions, and queued webhooks", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const victimAccount = `${uniq("victim")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const victim = await seedToken("agent", uniq("victim"), { owner: victimAccount });
    const sibling = await seedToken("agent", uniq("sibling"), { owner: victimAccount });
    const humanSession = await seedToken("human", uniq("human"), { owner: victimAccount });
    const slug = await makePublicChannel(owner.token);
    expect((await addMember(slug, owner.token, victimAccount)).status).toBe(200);

    expect((await sendMessage(slug, victim.token, "victim historical identity")).status).toBe(200);
    expect((await sendMessage(slug, sibling.token, "same-account historical identity")).status).toBe(200);
    expect(
      (
        await api(`/api/channels/${slug}/roles/${victim.name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "worker", responsibility: "must not revive" }),
        })
      ).status,
    ).toBe(200);

    const webhookOrigin = `https://${uniq("removed-hook")}.test`;
    expect(
      (
        await api(`/api/channels/${slug}/webhooks`, victim.token, {
          method: "POST",
          body: JSON.stringify({
            name: victim.name,
            url: `${webhookOrigin}/wake`,
            secret: "participant-removal-secret",
            filter: "mentions",
            mode: "agent",
          }),
        })
      ).status,
    ).toBe(201);
    await rejectWebhookOnce(slug, owner.token, victim.name, webhookOrigin);
    expect((await deliverySnapshot(slug, victim.name)).queued).toBeGreaterThan(0);

    const joinLink = await api(`/api/channels/${slug}/join-links`, owner.token, {
      method: "POST",
      body: JSON.stringify({ max_uses: 3 }),
    });
    expect(joinLink.status).toBe(201);
    const { code } = (await joinLink.json()) as { code: string };

    const removed = await removeParticipant(slug, owner.token, victim.name);
    expect(removed.status).toBe(200);
    expect((await removed.json()) as KickBody).toMatchObject({
      ok: true,
      removal: { name: victim.name },
      broadcasted: true,
    });

    // A stale writer cannot re-create a role, and even a manually restored row
    // remains hidden from the authoritative GET projection.
    const rejectedRole = await api(`/api/channels/${slug}/roles/${victim.name}`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ role: "host", responsibility: "stale writer" }),
    });
    expect(rejectedRole.status).toBe(409);
    expect((await rejectedRole.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "participant_removed" },
    });
    await env.DB.prepare(
      `INSERT INTO channel_roles (channel_slug, agent_name, role, assigned_by, assigned_at)
       VALUES (?, ?, 'host', ?, ?)`,
    )
      .bind(slug, victim.name, owner.name, Date.now())
      .run();
    expect(await roleNames(slug, owner.token)).not.toContain(victim.name);

    const identitiesWhileRemoved = await identityNames(slug, owner.token);
    expect(identitiesWhileRemoved).not.toContain(victim.name);
    expect(identitiesWhileRemoved).not.toContain(sibling.name);

    // The unscoped tokens remain globally valid but cannot use a public channel
    // through REST, list projection, or a fresh WebSocket.
    expect((await api("/api/me", victim.token)).status).toBe(200);
    expect((await api("/api/me", sibling.token)).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, victim.token)).status).toBe(403);
    expect((await sendMessage(slug, victim.token, "public must not revive me")).status).toBe(403);
    expect((await api(`/api/channels/${slug}/messages`, sibling.token)).status).toBe(403);
    expect(await channelSlugs(victim.token)).not.toContain(slug);
    expect(await channelSlugs(sibling.token)).not.toContain(slug);
    await expectWebSocketEntryDenied(slug, victim.token);

    const beforeMention = await deliverySnapshot(slug, victim.name);
    const mention = await sendMessage(
      slug,
      owner.token,
      `@${victim.name} must stay removed`,
      [victim.name],
    );
    expect(mention.status).toBe(400);
    expect((await mention.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "mention_not_found" },
    });
    expect(await deliverySnapshot(slug, victim.name)).toEqual(beforeMention);
    await expectNoQueuedWebhookRetry(slug, webhookOrigin);

    // Neither a join link nor another ordinary token from the removed account
    // clears the durable account tombstone.
    const beforeOrdinaryRejoin = await removalRows(slug);
    const join = await api(`/api/join/${code}`, humanSession.token, { method: "POST" });
    expect(join.status).toBe(403);
    expect((await join.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "forbidden" },
    });
    expect((await api(`/api/channels/${slug}/messages`, sibling.token)).status).toBe(403);
    expect(await removalRows(slug)).toEqual(beforeOrdinaryRejoin);

    // The moderator's member re-add restores the account principal only. The
    // independently removed name remains denied and hidden.
    expect((await addMember(slug, owner.token, victimAccount)).status).toBe(200);
    const afterExplicitReadd = await removalRows(slug);
    expect(
      afterExplicitReadd.some(
        (row) => row.principal_type === "account" && row.principal === victimAccount,
      ),
    ).toBe(false);
    expect(
      afterExplicitReadd.some(
        (row) => row.principal_type === "name" && row.principal === victim.name,
      ),
    ).toBe(true);
    expect((await api(`/api/channels/${slug}/messages`, sibling.token)).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, victim.token)).status).toBe(403);
    const identitiesAfterReadd = await identityNames(slug, owner.token);
    expect(identitiesAfterReadd).toContain(sibling.name);
    expect(identitiesAfterReadd).not.toContain(victim.name);
  });

  it("ignores a late removal broadcast after a newer explicit restoration", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const victimAccount = `${uniq("victim")}@example.com`;
    const independentAccount = `${uniq("independent")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    // Human/account restoration is the explicit path that clears this removal's
    // account row and its linked name row (restore_account), making the old
    // epoch stale. Agent-name removals remain independent, as asserted below.
    const victim = await seedToken("human", uniq("victim"), { owner: victimAccount });
    const independentlyRemoved = await seedToken("agent", uniq("name-only"), {
      owner: independentAccount,
    });
    const slug = await makePublicChannel(owner.token);
    expect((await addMember(slug, owner.token, victimAccount)).status).toBe(200);
    expect((await sendMessage(slug, victim.token, "before removal")).status).toBe(200);
    expect((await sendMessage(slug, independentlyRemoved.token, "independent name")).status).toBe(200);

    const removed = await removeParticipant(slug, owner.token, victim.name);
    expect(removed.status).toBe(200);
    const removal = ((await removed.json()) as KickBody).removal!;
    const oldNameRow = (await removalRows(slug)).find(
      (row) => row.principal_type === "name" && row.principal === victim.name,
    );
    expect(oldNameRow).toBeDefined();

    expect((await removeParticipant(slug, owner.token, independentlyRemoved.name)).status).toBe(200);
    const independentNameRow = (await removalRows(slug)).find(
      (row) => row.principal_type === "name" && row.principal === independentlyRemoved.name,
    );
    expect(independentNameRow).toBeDefined();

    expect((await addMember(slug, owner.token, victimAccount)).status).toBe(200);
    const afterReadd = await removalRows(slug);
    expect(
      afterReadd.some(
        (row) =>
          row.principal_type === "name" &&
          row.principal === independentlyRemoved.name &&
          row.removal_epoch === independentNameRow!.removal_epoch,
      ),
    ).toBe(true);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const replay = await runInDurableObject(stub, async (instance: ChannelDO) =>
      instance.onRequest(
        new Request("https://do/internal/participant-removed", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-partykit-room": slug,
          },
          body: JSON.stringify({
            ...removal,
            removal_epoch: oldNameRow!.removal_epoch,
          }),
        }),
      ),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      broadcasted: false,
      stale: true,
    });
    expect((await api(`/api/channels/${slug}/messages`, victim.token)).status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, independentlyRemoved.token)).status).toBe(403);
  });

  it("keeps member re-add atomic when an unowned name tombstone appears at the batch boundary", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const account = `${uniq("member")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const slug = await makePublicChannel(owner.token);
    const unsafeName = uniq("unowned-agent");
    await insertAccountRemoval(slug, account, ownerAccount);
    await env.DB.prepare(
      `INSERT INTO channel_participant_removals
         (channel_slug, principal_type, principal, restore_account, removed_at, removal_epoch, removed_by)
       VALUES (?, 'name', ?, NULL, ?, ?, ?)`,
    ).bind(slug, unsafeName, Date.now(), crypto.randomUUID(), ownerAccount).run();
    expect(
      await env.DB.prepare("SELECT 1 FROM channel_members WHERE channel_slug = ? AND account = ?")
        .bind(slug, account)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT 1
           FROM channel_participant_removals removal
          WHERE removal.channel_slug = ?
            AND removal.principal_type = 'name'
            AND removal.principal = ?
            AND NOT (
              COALESCE(removal.restore_account = ?, FALSE)
              OR EXISTS (
                SELECT 1 FROM channel_participant_bindings binding
                 WHERE binding.channel_slug = removal.channel_slug
                   AND binding.participant_name = removal.principal
                   AND binding.account = ?
              )
              OR EXISTS (
                SELECT 1 FROM tokens token
                 WHERE token.name = removal.principal
                   AND token.owner = ?
                   AND (token.channel_scope IS NULL OR token.channel_scope = ?)
              )
              OR EXISTS (
                SELECT 1 FROM channel_agent_invites invite
                 WHERE invite.channel_slug = removal.channel_slug
                   AND invite.profile_handle = removal.principal
                   AND invite.owner_account = ?
              )
            )`,
      ).bind(slug, unsafeName, account, account, account, slug, account).first(),
    ).not.toBeNull();
    const response = await api(
      `/api/channels/${slug}/members/${encodeURIComponent(account)}`,
      owner.token,
      {
        method: "PUT",
        body: JSON.stringify({ name: unsafeName }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "participant_removed",
        message: "that name requires its agent-specific moderator restore path",
      },
    });
    expect(
      await env.DB.prepare("SELECT 1 FROM channel_members WHERE channel_slug = ? AND account = ?")
        .bind(slug, account)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM channel_account_bans WHERE channel_slug = ? AND account = ?")
        .bind(slug, account)
        .first(),
    ).not.toBeNull();
    expect(await removalRows(slug)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ principal_type: "account", principal: account }),
        expect.objectContaining({ principal_type: "name", principal: unsafeName }),
      ]),
    );
  });

  it("filters legacy null-owner identities and offline presence through account authority", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const removedAccount = `${uniq("removed")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const legacy = await seedToken("human", uniq("legacy-human"), { owner: removedAccount });
    const slug = await makePublicChannel(owner.token);
    expect((await addMember(slug, owner.token, removedAccount)).status).toBe(200);
    expect((await sendMessage(slug, legacy.token, "legacy identity evidence")).status).toBe(200);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE messages SET sender_owner = NULL WHERE sender_name = ?",
        legacy.name,
      );
      state.storage.sql.exec(
        `INSERT INTO presence (name, session_id, kind, account, state, note, updated_at)
         VALUES (?, 'offline-regression', 'human', ?, 'offline', NULL, ?)`,
        legacy.name,
        removedAccount,
        Date.now(),
      );
    });
    await insertAccountRemoval(slug, removedAccount, ownerAccount);

    expect(await identityNames(slug, owner.token)).not.toContain(legacy.name);
    const presenceResponse = await api(`/api/channels/${slug}/presence`, owner.token);
    expect(presenceResponse.status).toBe(200);
    const presence = (await presenceResponse.json()) as { presence: Array<{ name: string }> };
    expect(presence.presence.map((entry) => entry.name)).not.toContain(legacy.name);
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      expect(
        Number(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM presence WHERE name = ?", legacy.name)
            .one().count,
        ),
      ).toBe(0);
    });
  });

  it("closes a same-name old-principal socket before broadcasting to its new owner", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const oldAccount = `${uniq("old-owner")}@example.com`;
    const newAccount = `${uniq("new-owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const target = await seedToken("agent", uniq("reissued-agent"), { owner: oldAccount });
    const slug = await makePublicChannel(owner.token);
    const oldSocket = await WsClient.open(slug, target.token);
    await oldSocket.nextOfType("welcome");
    await oldSocket.nextOfType("participants");
    oldSocket.send({ type: "hello", since: 0, directed_delivery: "v1" });

    await env.DB.prepare("UPDATE tokens SET owner = ? WHERE name = ?")
      .bind(newAccount, target.name)
      .run();
    expect((await sendMessage(slug, owner.token, "new principal only")).status).toBe(200);
    const firstAfterReissue = await oldSocket.next();
    expect(firstAfterReissue).toMatchObject({ type: "error", code: "unauthorized" });
    oldSocket.close();
  });

  it("re-queries a just-observed owner after the name tombstone commits", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const lateAccount = `${uniq("late-oidc")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const slug = await makePublicChannel(owner.token);
    const lateName = `oidc:${uniq("late-sub")}`;
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let injected = false;
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      const statement = originalPrepare(query);
      if (
        injected ||
        !query.includes("WITH token_owners AS") ||
        !query.includes("(revoked_at IS NULL OR revoked_at = ?)")
      ) {
        return statement;
      }
      injected = true;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async all<T>() {
              await originalPrepare(
                `INSERT INTO channel_participant_bindings
                   (channel_slug, participant_name, account, participant_kind, observed_at)
                 VALUES (?, ?, ?, 'human', ?)`,
              ).bind(slug, lateName, lateAccount, Date.now()).run();
              return bound.all<T>();
            },
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    });
    let response!: Response;
    try {
      response = await removeParticipant(slug, owner.token, lateName);
    } finally {
      prepareSpy.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(injected).toBe(true);
    const rows = await removalRows(slug);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principal_type: "name",
          principal: lateName,
          restore_account: lateAccount,
        }),
        expect.objectContaining({ principal_type: "account", principal: lateAccount }),
      ]),
    );
    expect(
      await env.DB.prepare("SELECT 1 FROM channel_account_bans WHERE channel_slug = ? AND account = ?")
        .bind(slug, lateAccount)
        .first(),
    ).not.toBeNull();
  });

  it("lets only one concurrent dispatcher win the queued delivery claim", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const targetAccount = `${uniq("target")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const target = await seedToken("agent", uniq("dispatch-target"), { owner: targetAccount });
    const slug = await makePublicChannel(owner.token);
    expect(
      (await sendMessage(slug, owner.token, `@${target.name} queued`, [target.name])).status,
    ).toBe(200);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      let arrivals = 0;
      let release!: () => void;
      const bothSelected = new Promise<void>((resolve) => {
        release = resolve;
      });
      let webhookDispatches = 0;
      Object.defineProperties(instance, {
        agentWebhookCandidates: {
          configurable: true,
          value: () => [{
            name: target.name,
            registrationId: "claim-race",
            url: "https://claim-race.test/wake",
            secret: "secret",
            filter: "mentions",
            mode: "agent",
            targetOwner: targetAccount,
          }],
        },
        isParticipantRemoved: {
          configurable: true,
          value: async () => {
            arrivals += 1;
            if (arrivals === 2) release();
            await bothSelected;
            return false;
          },
        },
        isCurrentAgentDeliveryPrincipal: {
          configurable: true,
          value: async () => true,
        },
        dispatchDirectedWebhook: {
          configurable: true,
          value: async () => {
            webhookDispatches += 1;
          },
        },
      });
      const dispatch = instance as unknown as {
        dispatchNextDirectedDeliveryAuthorized(name: string): Promise<void>;
      };
      await Promise.all([
        dispatch.dispatchNextDirectedDeliveryAuthorized(target.name),
        dispatch.dispatchNextDirectedDeliveryAuthorized(target.name),
      ]);
      const delivery = state.storage.sql
        .exec(
          "SELECT state, attempt FROM directed_deliveries WHERE target_name = ?",
          target.name,
        )
        .one();
      expect(delivery.state).toBe("claimed");
      expect(Number(delivery.attempt)).toBe(1);
      expect(webhookDispatches).toBe(1);
    });
  });
});
