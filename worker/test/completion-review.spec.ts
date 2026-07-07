import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, postMessage, seedToken, uniq } from "./helpers";

interface MsgLike {
  seq: number;
  body: string;
  mentions: string[];
  reply_to: number | null;
  completion_artifact?: { kickoff_seq: number };
  completion_review?: {
    state: "pending_review" | "approved" | "rejected";
    policy: "sender" | "owner";
    reason?: string;
    reviewer?: { name: string };
    reviewed_at?: number;
    replaces_seq?: number;
    replaced_by_seq?: number;
  };
  rev_seq?: number;
}

async function fixture() {
  const acct = `${uniq("acct")}@leeguoo.com`;
  const owner = await seedToken("agent", uniq("owner"), { owner: acct });
  const slug = await createChannel(owner.token);
  const writer = await seedToken("agent", uniq("writer"), { owner: acct, channelScope: slug });
  const reviewer = await seedToken("agent", uniq("reviewer"), { owner: `${uniq("reviewer")}@example.com`, channelScope: slug });
  const readonly = await seedToken("readonly", uniq("ro"), { owner: acct, channelScope: slug });
  const gate = await api(`/api/channels/${slug}/completion-gate`, owner.token, {
    method: "PUT",
    body: JSON.stringify({ gate: "reviewer", policy: "sender" }),
  });
  expect(gate.status).toBe(200);
  const kickoff = await postMessage(slug, writer.token, "please do the work");
  const kickoffSeq = ((await kickoff.json()) as { seq: number }).seq;
  return { slug, owner, writer, reviewer, readonly, kickoffSeq };
}

async function postCompletion(slug: string, token: string, kickoffSeq: number, opts: { replaces?: number; body?: string } = {}) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: opts.body ?? "final synthesis",
      mentions: [],
      reply_to: kickoffSeq,
      completion_artifact: {
        kind: "final_synthesis",
        kickoff_seq: kickoffSeq,
        replies_count: 1,
        timeout: false,
        related_issues: [],
        related_prs: [],
      },
      ...(opts.replaces === undefined ? {} : { replaces: opts.replaces }),
    }),
  });
}

async function history(slug: string, token: string): Promise<MsgLike[]> {
  const res = await api(`/api/channels/${slug}/messages`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: MsgLike[] }).messages;
}

describe("review-gated completion (#34)", () => {
  it("creates pending completion and approves it with message_update(review)", async () => {
    const { slug, writer, reviewer, readonly, kickoffSeq } = await fixture();
    const completion = await postCompletion(slug, writer.token, kickoffSeq);
    expect(completion.status).toBe(200);
    const completionBody = (await completion.json()) as { seq: number; completion_review?: { state: string; policy: string } };
    expect(completionBody.completion_review).toEqual({ state: "pending_review", policy: "sender" });

    const selfReview = await api(`/api/channels/${slug}/messages/${completionBody.seq}/review`, writer.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(selfReview.status).toBe(403);

    const readonlyReview = await api(`/api/channels/${slug}/messages/${completionBody.seq}/review`, readonly.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(readonlyReview.status).toBe(403);

    const ws = await WsClient.open(slug, reviewer.token);
    await ws.nextOfType("welcome");
    const approved = await api(`/api/channels/${slug}/messages/${completionBody.seq}/review`, reviewer.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { message: MsgLike; reply: MsgLike };
    expect(approvedBody.message).toMatchObject({
      seq: completionBody.seq,
      completion_review: { state: "approved", policy: "sender", reviewer: { name: reviewer.name } },
    });
    expect(approvedBody.message.rev_seq).toBeGreaterThan(0);
    expect(approvedBody.reply).toMatchObject({ reply_to: completionBody.seq, body: `review approved #${completionBody.seq}` });

    const update = await ws.nextOfType("message_update");
    expect(update).toMatchObject({
      type: "message_update",
      target_seq: completionBody.seq,
      action: "review",
      message: { completion_review: { state: "approved" } },
    });
    const reply = await ws.nextOfType("msg");
    expect(reply).toMatchObject({ reply_to: completionBody.seq, body: `review approved #${completionBody.seq}` });
    ws.close();

    const duplicate = await api(`/api/channels/${slug}/messages/${completionBody.seq}/review`, reviewer.token, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "too late" }),
    });
    expect(duplicate.status).toBe(409);
  });

  it("rejects with public reason and mentions the original sender", async () => {
    const { slug, writer, reviewer, kickoffSeq } = await fixture();
    const completion = await postCompletion(slug, writer.token, kickoffSeq);
    const seq = ((await completion.json()) as { seq: number }).seq;

    const missingReason = await api(`/api/channels/${slug}/messages/${seq}/review`, reviewer.token, {
      method: "POST",
      body: JSON.stringify({ action: "reject" }),
    });
    expect(missingReason.status).toBe(400);

    const rejected = await api(`/api/channels/${slug}/messages/${seq}/review`, reviewer.token, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "missing test evidence" }),
    });
    expect(rejected.status).toBe(200);
    const body = (await rejected.json()) as { message: MsgLike; reply: MsgLike };
    expect(body.message).toMatchObject({
      completion_review: { state: "rejected", reason: "missing test evidence", reviewer: { name: reviewer.name } },
    });
    expect(body.reply).toMatchObject({
      reply_to: seq,
      mentions: [writer.name],
      body: `@${writer.name} review rejected #${seq}: missing test evidence`,
    });
  });

  it("links a reworked completion to the rejected one and bumps the old row rev_seq", async () => {
    const { slug, writer, reviewer, kickoffSeq } = await fixture();
    const completion = await postCompletion(slug, writer.token, kickoffSeq);
    const rejectedSeq = ((await completion.json()) as { seq: number }).seq;
    const rejected = await api(`/api/channels/${slug}/messages/${rejectedSeq}/review`, reviewer.token, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "missing evidence" }),
    });
    expect(rejected.status).toBe(200);
    const rejectedBody = (await rejected.json()) as { message: MsgLike };
    const rejectedRev = rejectedBody.message.rev_seq;
    expect(rejectedRev).toBeGreaterThan(0);

    const ws = await WsClient.open(slug, reviewer.token);
    await ws.nextOfType("welcome");
    const reworked = await postCompletion(slug, writer.token, kickoffSeq, {
      replaces: rejectedSeq,
      body: "final synthesis with evidence",
    });
    expect(reworked.status).toBe(200);
    const reworkedBody = (await reworked.json()) as { seq: number; completion_review?: MsgLike["completion_review"] };
    expect(reworkedBody.completion_review).toMatchObject({
      state: "pending_review",
      policy: "sender",
      replaces_seq: rejectedSeq,
    });

    const update = await ws.nextOfType("message_update");
    expect(update).toMatchObject({
      type: "message_update",
      target_seq: rejectedSeq,
      action: "review",
      message: { completion_review: { state: "rejected", replaced_by_seq: reworkedBody.seq } },
    });
    ws.close();

    const rows = await history(slug, writer.token);
    const oldRow = rows.find((row) => row.seq === rejectedSeq);
    const newRow = rows.find((row) => row.seq === reworkedBody.seq);
    expect(oldRow?.completion_review).toMatchObject({ state: "rejected", replaced_by_seq: reworkedBody.seq });
    expect(oldRow?.rev_seq).toBeGreaterThan(rejectedRev ?? 0);
    expect(newRow?.completion_review).toMatchObject({ state: "pending_review", replaces_seq: rejectedSeq });
  });

  it("rejects replaces when the target kickoff differs or is not rejected", async () => {
    const { slug, writer, reviewer, kickoffSeq } = await fixture();
    const pending = await postCompletion(slug, writer.token, kickoffSeq);
    const pendingSeq = ((await pending.json()) as { seq: number }).seq;

    const nonRejected = await postCompletion(slug, writer.token, kickoffSeq, { replaces: pendingSeq });
    expect(nonRejected.status).toBe(400);

    const rejected = await api(`/api/channels/${slug}/messages/${pendingSeq}/review`, reviewer.token, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "needs rework" }),
    });
    expect(rejected.status).toBe(200);
    const otherKickoff = await postMessage(slug, writer.token, "please do unrelated work");
    const otherKickoffSeq = ((await otherKickoff.json()) as { seq: number }).seq;

    const mismatch = await postCompletion(slug, writer.token, otherKickoffSeq, { replaces: pendingSeq });
    expect(mismatch.status).toBe(400);
  });
});
