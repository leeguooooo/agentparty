import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

interface CaptureLike {
  type: "capture";
  channel: string;
  seq: number;
  capture_kind: string;
  note: string | null;
  created_by: string;
  message: {
    seq: number;
    sender: { name: string; kind: string };
    kind: string;
    body: string;
  };
}

describe("captures rest", () => {
  it("creates durable captures from retained message snapshots and lists them", async () => {
    const alice = await seedToken("agent", uniq("alice"));
    const slug = await createChannel(alice.token);
    const sent = await postMessage(slug, alice.token, "ship the decision");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const created = await api(`/api/channels/${slug}/captures`, alice.token, {
      method: "POST",
      body: JSON.stringify({ seq, kind: "decision", note: "accepted by host" }),
    });
    expect(created.status).toBe(201);
    const capture = (await created.json()) as CaptureLike;
    expect(capture).toMatchObject({
      type: "capture",
      channel: slug,
      seq,
      capture_kind: "decision",
      note: "accepted by host",
      created_by: alice.name,
      message: {
        seq,
        sender: { name: alice.name, kind: "agent" },
        kind: "message",
        body: "ship the decision",
      },
    });

    const updated = await api(`/api/channels/${slug}/captures`, alice.token, {
      method: "POST",
      body: JSON.stringify({ seq, as: "decision", note: "updated note" }),
    });
    expect(updated.status).toBe(201);
    expect(((await updated.json()) as CaptureLike).note).toBe("updated note");

    const list = await api(`/api/channels/${slug}/captures?kind=decision&since=0`, alice.token);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { captures: CaptureLike[] };
    expect(body.captures).toHaveLength(1);
    expect(body.captures[0]).toMatchObject({ seq, capture_kind: "decision", note: "updated note" });
  });

  it("rejects missing messages, invalid kinds, and readonly writers", async () => {
    const writer = await seedToken("agent", uniq("writer"));
    const readonly = await seedToken("readonly", uniq("reader"));
    const slug = await createChannel(writer.token);

    const invalidKind = await api(`/api/channels/${slug}/captures`, writer.token, {
      method: "POST",
      body: JSON.stringify({ seq: 1, kind: "idea" }),
    });
    expect(invalidKind.status).toBe(400);

    const missing = await api(`/api/channels/${slug}/captures`, writer.token, {
      method: "POST",
      body: JSON.stringify({ seq: 999, kind: "bug" }),
    });
    expect(missing.status).toBe(404);

    await postMessage(slug, writer.token, "readonly must not tag");
    const denied = await api(`/api/channels/${slug}/captures`, readonly.token, {
      method: "POST",
      body: JSON.stringify({ seq: 1, kind: "bug" }),
    });
    expect(denied.status).toBe(403);
  });
});
