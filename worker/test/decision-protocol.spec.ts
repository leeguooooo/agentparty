import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, completeCapabilityHello, createChannel, postMessage, seedToken, uniq } from "./helpers";

interface MsgLike {
  seq: number;
  body: string;
  mentions: string[];
  reply_to: number | null;
  decision_request?: { kind: "approval" | "choice"; prompt: string; options: string[] };
  decision_resolution?: {
    state: "pending" | "resolved" | "auto_resolved";
    chosen_index?: number;
    chosen_option?: string;
    responder?: { name: string };
    reason?: string;
  };
  decision_response?: { request_seq: number; chosen_index: number; chosen_option: string };
  rev_seq?: number;
}

async function fixture(mode?: "approval" | "unattended") {
  const acct = `${uniq("acct")}@leeguoo.com`;
  const owner = await seedToken("agent", uniq("owner"), { owner: acct }); // channel creator → moderator
  const slug = await createChannel(owner.token);
  const agent = await seedToken("agent", uniq("agent"), { owner: acct, channelScope: slug }); // requesting agent (non-moderator)
  const human = await seedToken("human", uniq("human"), { owner: `${uniq("h")}@example.com`, channelScope: slug });
  const other = await seedToken("agent", uniq("other"), { owner: `${uniq("o")}@example.com`, channelScope: slug }); // non-moderator agent
  const readonly = await seedToken("readonly", uniq("ro"), { owner: acct, channelScope: slug });
  if (mode !== undefined) {
    const res = await api(`/api/channels/${slug}/decision-mode`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
    expect(res.status).toBe(200);
  }
  return { slug, owner, agent, human, other, readonly };
}

async function postDecision(
  slug: string,
  token: string,
  opts: {
    prompt?: string;
    kind?: "approval" | "choice";
    options?: string[];
    body?: string;
    mentions?: string[];
    expectedResponderOwner?: string;
  } = {},
) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: opts.body ?? "here is the plan",
      mentions: opts.mentions ?? [],
      reply_to: null,
      decision_request: {
        prompt: opts.prompt ?? "approve this plan?",
        ...(opts.kind === undefined ? {} : { kind: opts.kind }),
        ...(opts.options === undefined ? {} : { options: opts.options }),
      },
      ...(opts.expectedResponderOwner === undefined
        ? {}
        : { expected_decision_responder_owner: opts.expectedResponderOwner }),
    }),
  });
}

async function history(slug: string, token: string): Promise<MsgLike[]> {
  const res = await api(`/api/channels/${slug}/messages`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: MsgLike[] }).messages;
}

async function pendingDecisions(slug: string, token: string) {
  const res = await api(`/api/channels/${slug}/pending-decisions`, token);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    decisions: Array<{ seq: number; prompt: string; asker: string; waiting_on_me: boolean }>;
    next_after: number | null;
  };
}

describe("channel decision protocol (#284)", () => {
  it("defaults an option-less request to approve/reject and stays pending in approval mode", async () => {
    const { slug, agent } = await fixture();
    const res = await postDecision(slug, agent.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MsgLike;
    expect(body.decision_request).toEqual({ kind: "approval", prompt: "approve this plan?", options: ["approve", "reject"] });
    expect(body.decision_resolution).toEqual({ state: "pending" });
  });

  it("keeps unresolved decisions authoritative after they leave the latest 300-message window", async () => {
    const { slug, agent, human, readonly } = await fixture();
    const asked = await postDecision(slug, agent.token, { prompt: "ship the retained decision?" });
    const question = (await asked.json()) as MsgLike;
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE noise(x) AS (
           VALUES(1)
           UNION ALL
           SELECT x + 1 FROM noise WHERE x < 301
         )
         INSERT INTO messages (
           seq, sender_name, sender_kind, kind, body, mentions_json, delivery_targets_json, ts
         )
         SELECT ? + x, 'noise', 'human', 'message', 'noise', '[]', '[]', ? + x
           FROM noise`,
        question.seq,
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('seq', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(question.seq + 301),
      );
    });

    const recentResponse = await api(
      `/api/channels/${slug}/messages?before=${Number.MAX_SAFE_INTEGER}&limit=300`,
      human.token,
    );
    expect(recentResponse.status).toBe(200);
    const recent = ((await recentResponse.json()) as { messages: MsgLike[] }).messages;
    expect(recent).toHaveLength(300);
    expect(recent.some((message) => message.seq === question.seq)).toBe(false);

    expect(await pendingDecisions(slug, human.token)).toEqual({
      decisions: [{
        seq: question.seq,
        prompt: "ship the retained decision?",
        asker: agent.name,
        waiting_on_me: true,
      }],
      next_after: null,
    });
    expect((await pendingDecisions(slug, readonly.token)).decisions[0]?.waiting_on_me).toBe(false);
    expect((await pendingDecisions(slug, agent.token)).decisions[0]?.waiting_on_me).toBe(false);

    const resolved = await api(`/api/channels/${slug}/messages/${question.seq}/decision`, human.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(resolved.status).toBe(200);
    expect((await pendingDecisions(slug, human.token)).decisions).toEqual([]);
  });

  it("resolves an approval via a human clicking approve and emits a decision_response reply", async () => {
    const { slug, agent, human } = await fixture();
    const req = await postDecision(slug, agent.token, { mentions: [] });
    const seq = ((await req.json()) as MsgLike).seq;

    const ws = await WsClient.open(slug, human.token);
    await completeCapabilityHello(ws);
    const resolved = await api(`/api/channels/${slug}/messages/${seq}/decision`, human.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(resolved.status).toBe(200);
    const payload = (await resolved.json()) as { message: MsgLike; reply: MsgLike };
    expect(payload.message).toMatchObject({
      seq,
      decision_resolution: { state: "resolved", chosen_index: 0, chosen_option: "approve", responder: { name: human.name } },
    });
    expect(payload.message.rev_seq).toBeGreaterThan(0);
    expect(payload.reply).toMatchObject({
      reply_to: seq,
      mentions: [agent.name],
      decision_response: { request_seq: seq, chosen_index: 0, chosen_option: "approve" },
    });

    const update = await ws.nextOfType("message_update");
    expect(update).toMatchObject({ type: "message_update", target_seq: seq, action: "decision", message: { decision_resolution: { state: "resolved" } } });
    ws.close();

    // A retried response is idempotent: return the original resolution/reply without inserting
    // another decision_response, even if the stale retry carries a different action.
    const again = await api(`/api/channels/${slug}/messages/${seq}/decision`, human.token, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "changed my mind" }),
    });
    expect(again.status).toBe(200);
    const repeated = (await again.json()) as { message: MsgLike; reply: MsgLike };
    expect(repeated.message.decision_resolution).toMatchObject({
      state: "resolved",
      chosen_index: 0,
      chosen_option: "approve",
    });
    expect(repeated.reply.seq).toBe(payload.reply.seq);
    expect((await history(slug, human.token)).filter((message) => message.decision_response?.request_seq === seq)).toHaveLength(1);
  });

  it("binds a managed decision to its exact owner account without exposing the binding", async () => {
    const expectedOwner = `${uniq("expected")}@example.com`;
    const moderatorAgent = await seedToken("agent", uniq("moderator-agent"), { owner: expectedOwner });
    const slug = await createChannel(moderatorAgent.token);
    const boundAgent = await seedToken("agent", uniq("bound-agent"), {
      owner: expectedOwner,
      channelScope: slug,
    });
    const expectedHuman = await seedToken("human", uniq("expected-human"), {
      owner: expectedOwner,
      channelScope: slug,
    });
    const wrongHuman = await seedToken("human", uniq("wrong-human"), {
      owner: `${uniq("wrong")}@example.com`,
      channelScope: slug,
    });
    const asked = await postDecision(slug, boundAgent.token, {
      expectedResponderOwner: `  ${expectedOwner}  `,
    });
    expect(asked.status).toBe(200);
    const question = (await asked.json()) as MsgLike;
    expect(question.decision_request).not.toHaveProperty("expected_responder_owner");
    expect((await pendingDecisions(slug, expectedHuman.token)).decisions[0]?.waiting_on_me).toBe(true);
    expect((await pendingDecisions(slug, wrongHuman.token)).decisions[0]?.waiting_on_me).toBe(false);
    expect((await pendingDecisions(slug, moderatorAgent.token)).decisions[0]?.waiting_on_me).toBe(false);

    const denied = await api(`/api/channels/${slug}/messages/${question.seq}/decision`, wrongHuman.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()) as { error: { code: string } }).toMatchObject({ error: { code: "forbidden" } });
    const moderatorDenied = await api(
      `/api/channels/${slug}/messages/${question.seq}/decision`,
      moderatorAgent.token,
      {
        method: "POST",
        body: JSON.stringify({ action: "approve" }),
      },
    );
    expect(moderatorDenied.status).toBe(403);
    const pending = (await history(slug, expectedHuman.token)).find((message) => message.seq === question.seq);
    expect(pending?.decision_resolution).toEqual({ state: "pending" });
    expect(pending?.decision_request).not.toHaveProperty("expected_responder_owner");

    const resolved = await api(`/api/channels/${slug}/messages/${question.seq}/decision`, expectedHuman.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(resolved.status).toBe(200);
    const payload = (await resolved.json()) as { message: MsgLike; reply: MsgLike };
    expect(payload.message.decision_resolution).toMatchObject({
      state: "resolved",
      responder: { name: expectedHuman.name },
    });
  });

  it("rejects an owner binding that does not match the requesting principal", async () => {
    const { slug, agent, human } = await fixture();
    const asked = await postDecision(slug, agent.token, {
      expectedResponderOwner: `${uniq("forged")}@example.com`,
    });
    expect(asked.status).toBe(403);
    expect((await history(slug, human.token)).filter((message) => message.body === "here is the plan")).toHaveLength(0);
  });

  it("resolves a reject with a public reason mentioning the requester", async () => {
    const { slug, agent, human } = await fixture();
    const req = await postDecision(slug, agent.token);
    const seq = ((await req.json()) as MsgLike).seq;
    const rejected = await api(`/api/channels/${slug}/messages/${seq}/decision`, human.token, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "scope too broad" }),
    });
    expect(rejected.status).toBe(200);
    const payload = (await rejected.json()) as { message: MsgLike; reply: MsgLike };
    expect(payload.message.decision_resolution).toMatchObject({ state: "resolved", chosen_option: "reject", reason: "scope too broad" });
    expect(payload.reply.mentions).toEqual([agent.name]);
  });

  it("resolves a custom choice request by option index", async () => {
    const { slug, agent, owner } = await fixture();
    const req = await postDecision(slug, agent.token, { kind: "choice", options: ["ship now", "wait for review", "cancel"], prompt: "which path?" });
    const body = (await req.json()) as MsgLike;
    expect(body.decision_request).toEqual({ kind: "choice", prompt: "which path?", options: ["ship now", "wait for review", "cancel"] });
    const resolved = await api(`/api/channels/${slug}/messages/${body.seq}/decision`, owner.token, {
      method: "POST",
      body: JSON.stringify({ option: 1 }),
    });
    expect(resolved.status).toBe(200);
    const payload = (await resolved.json()) as { message: MsgLike; reply: MsgLike };
    expect(payload.message.decision_resolution).toMatchObject({ state: "resolved", chosen_index: 1, chosen_option: "wait for review" });
    expect(payload.reply.decision_response).toMatchObject({ request_seq: body.seq, chosen_index: 1, chosen_option: "wait for review" });
  });

  it("auto-resolves in unattended mode without waiting for a human", async () => {
    const { slug, agent, human } = await fixture("unattended");
    const req = await postDecision(slug, agent.token, { kind: "choice", options: ["a", "b"] });
    const body = (await req.json()) as MsgLike;
    expect(body.decision_resolution).toMatchObject({ state: "auto_resolved", chosen_index: 0, chosen_option: "a" });
    expect(body.decision_resolution?.responder).toBeUndefined();
    // already resolved → human response is a no-op 409
    const late = await api(`/api/channels/${slug}/messages/${body.seq}/decision`, human.token, {
      method: "POST",
      body: JSON.stringify({ option: 1 }),
    });
    expect(late.status).toBe(409);
  });

  it("rejects non-permitted responders: readonly, the requester, and a plain non-moderator agent", async () => {
    const { slug, agent, other, readonly } = await fixture();
    const req = await postDecision(slug, agent.token);
    const seq = ((await req.json()) as MsgLike).seq;

    const ro = await api(`/api/channels/${slug}/messages/${seq}/decision`, readonly.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(ro.status).toBe(403);

    const own = await api(`/api/channels/${slug}/messages/${seq}/decision`, agent.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(own.status).toBe(403);

    const plainAgent = await api(`/api/channels/${slug}/messages/${seq}/decision`, other.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(plainAgent.status).toBe(403);
  });

  it("replays decision request + resolution through history", async () => {
    const { slug, agent, human } = await fixture();
    const req = await postDecision(slug, agent.token);
    const seq = ((await req.json()) as MsgLike).seq;
    await api(`/api/channels/${slug}/messages/${seq}/decision`, human.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    const rows = await history(slug, agent.token);
    const request = rows.find((row) => row.seq === seq);
    expect(request?.decision_request?.prompt).toBe("approve this plan?");
    expect(request?.decision_resolution).toMatchObject({ state: "resolved", chosen_option: "approve" });
    const response = rows.find((row) => row.decision_response?.request_seq === seq);
    expect(response?.decision_response?.chosen_option).toBe("approve");
  });

  it("guards the decision-mode endpoint to moderators", async () => {
    const { slug, other } = await fixture();
    const res = await api(`/api/channels/${slug}/decision-mode`, other.token, {
      method: "PUT",
      body: JSON.stringify({ mode: "unattended" }),
    });
    expect(res.status).toBe(403);
  });
});
