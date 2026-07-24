import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq, WsClient } from "./helpers";

async function waitForParticipantBinding(
  slug: string,
  participantName: string,
  timeoutMs = 2_000,
): Promise<{ account: string } | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const binding = await env.DB.prepare(
      "SELECT account FROM channel_participant_bindings WHERE channel_slug = ? AND participant_name = ?",
    ).bind(slug, participantName).first<{ account: string }>();
    if (binding !== null) return binding;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return null;
}

describe("channel participant binding writes", () => {
  it("does not turn successful channel reads into D1 writes", async () => {
    const account = `${uniq("reader")}@example.com`;
    const reader = await seedToken("human", uniq("reader"), { owner: account });
    const slug = await createChannel(reader.token);

    const read = await api(`/api/channels/${slug}/messages?since=0&limit=1`, reader.token);
    expect(read.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT account FROM channel_participant_bindings WHERE channel_slug = ? AND participant_name = ?",
      ).bind(slug, reader.name).first(),
    ).toBeNull();

    expect((await postMessage(slug, reader.token, "bind on mutation")).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT account FROM channel_participant_bindings WHERE channel_slug = ? AND participant_name = ?",
      ).bind(slug, reader.name).first<{ account: string }>(),
    ).toEqual({ account });
  });

  it("still records an accepted WebSocket participant", async () => {
    const account = `${uniq("socket")}@example.com`;
    const participant = await seedToken("human", uniq("socket"), { owner: account });
    const slug = await createChannel(participant.token);
    const socket = await WsClient.open(slug, participant.token);
    await socket.nextOfType("welcome");

    expect(
      await waitForParticipantBinding(slug, participant.name),
    ).toEqual({ account });
    socket.close();
  });
});
