import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ChannelDO } from "../src/do";
import {
  completeCapabilityHello,
  createChannel,
  postMessage,
  seedToken,
  uniq,
  WsClient,
} from "./helpers";

describe("participant authority WebSocket hot path", () => {
  it("reuses a fresh channel snapshot and reports D1 outages as temporary", async () => {
    const participant = await seedToken("human", uniq("participant"), {
      owner: `${uniq("account")}@example.com`,
    });
    const slug = await createChannel(participant.token);
    expect((await postMessage(slug, participant.token, "one")).status).toBe(200);
    expect((await postMessage(slug, participant.token, "two")).status).toBe(200);

    const socket = await WsClient.open(slug, participant.token);
    await completeCapabilityHello(socket);
    await socket.nextOfType("msg");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      (instance as unknown as { participantAuthorityRefreshedAt: number })
        .participantAuthorityRefreshedAt = Date.now();
    });

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let reconcileQueries = 0;
    let failAuthority = false;
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (
        query.includes("SELECT principal_type, principal, removed_at") &&
        query.includes("FROM channel_participant_removals")
      ) {
        reconcileQueries += 1;
        if (failAuthority) throw new Error("D1 unavailable");
      }
      return originalPrepare(query);
    });

    try {
      socket.send({ type: "seen", seq: 1 });
      await socket.nextOfType("read_cursor");
      expect(reconcileQueries).toBe(0);

      await runInDurableObject(stub, async (instance: ChannelDO) => {
        (instance as unknown as { participantAuthorityRefreshedAt: number })
          .participantAuthorityRefreshedAt = 0;
      });
      failAuthority = true;
      socket.send({ type: "seen", seq: 2 });
      const error = await socket.nextOfType("error");
      expect(error).toMatchObject({
        code: "unavailable",
        message: "participant authorization is temporarily unavailable",
      });
      expect(reconcileQueries).toBe(1);
    } finally {
      prepare.mockRestore();
      socket.close();
    }
  });
});
