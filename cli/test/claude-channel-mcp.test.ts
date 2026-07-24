import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientFrame } from "@agentparty/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryFrame, welcomeDirectedFrame } from "./mock-server";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let backend: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-claude-channel-mcp-"));
});

afterEach(() => {
  backend?.stop(true);
  backend = null;
  rmSync(home, { recursive: true, force: true });
});

describe("claude-channel stdio MCP adapter", () => {
  test("declares the dedicated capability, emits a channel notification, and persists a linked reply", async () => {
    const clientFrames: ClientFrame[] = [];
    const posts: unknown[] = [];
    const directed = deliveryFrame(12, "same-session work", {
      id: "delivery-12",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
    });
    backend = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/api/channels/dev/ws" && server.upgrade(request, { data: undefined })) return;
        if (url.pathname === "/api/channels/dev/messages" && request.method === "POST") {
          posts.push(await request.json());
          return Response.json({ seq: 99 });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
      websocket: {
        message(socket, raw) {
          const frame = JSON.parse(String(raw)) as ClientFrame;
          clientFrames.push(frame);
          if (frame.type === "hello") {
            socket.send(JSON.stringify(welcomeDirectedFrame(0, "me")));
          } else if (frame.type === "delivery_adapter") {
            socket.send(JSON.stringify({ type: "delivery_adapter", adapter: "watch", registered: true }));
            socket.send(JSON.stringify(directed));
          } else if (frame.type === "delivery_update" && frame.request_id) {
            socket.send(JSON.stringify({
              type: "delivery_state",
              request_id: frame.request_id,
              delivery: {
                ...directed.delivery,
                state: frame.state,
                reply_seq: frame.reply_seq ?? directed.delivery.reply_seq,
              },
            }));
          }
        },
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${backend.port}`, token: "ap_tok" }),
    );

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "AGENTPARTY_CONFIG") env[key] = value;
    }
    env.AGENTPARTY_HOME = home;
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "claude-channel", "--channel", "dev"],
      env,
      stderr: "pipe",
    });
    const notifications: Array<{ method: string; params?: unknown }> = [];
    let notify!: (value: void) => void;
    const received = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const client = new Client({ name: "claude-channel-contract-test", version: "1.0.0" });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
      if (notification.method === "notifications/claude/channel") notify();
    };

    await client.connect(transport);
    try {
      expect(client.getServerCapabilities()?.experimental).toMatchObject({
        "claude/channel": {},
      });
      expect(client.getInstructions()).toContain("party_channel_claim");
      expect(client.getInstructions()).toContain("party_channel_accept");
      expect(client.getInstructions()).toContain("party_channel_reply");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "party_channel_claim",
        "party_channel_accept",
        "party_channel_reply",
      ]);

      await Promise.race([
        received,
        new Promise((_, reject) => setTimeout(() => reject(new Error("channel notification timeout")), 3_000)),
      ]);
      const channelEvent = notifications.find((entry) => entry.method === "notifications/claude/channel");
      expect(channelEvent?.params).toMatchObject({
        content: expect.stringContaining("execution_id=delivery-12"),
        meta: {
          source: "agentparty",
          channel: "dev",
          seq: "12",
          sender: "alice",
          sender_kind: "human",
          delivery_id: "delivery-12",
          execution_id: "delivery-12",
        },
      });
      expect(JSON.stringify(channelEvent?.params)).not.toContain("same-session work");

      const unclaimedReply = await client.callTool({
        name: "party_channel_reply",
        arguments: { seq: 12, text: "must not persist before claim" },
      });
      expect(unclaimedReply.isError).toBe(true);
      expect(posts).toEqual([]);

      const claim = await client.callTool({
        name: "party_channel_claim",
        arguments: { execution_id: "delivery-12" },
      });
      expect(claim.isError).not.toBe(true);
      const claimContent = JSON.stringify(claim.content);
      expect(claimContent).toContain("same-session work");
      const receipt = /AgentParty claim receipt: ([0-9a-f-]+)/.exec(claimContent)?.[1];
      expect(typeof receipt).toBe("string");

      // Model an MCP response lost after the claim WAL commit. Until accept,
      // an equivalent retry must return the exact same receipt and body.
      const duplicateClaim = await client.callTool({
        name: "party_channel_claim",
        arguments: { execution_id: "delivery-12" },
      });
      expect(duplicateClaim.isError).not.toBe(true);
      expect(duplicateClaim.content).toEqual(claim.content);

      const preAcceptReply = await client.callTool({
        name: "party_channel_reply",
        arguments: { seq: 12, text: "must not persist before accept" },
      });
      expect(preAcceptReply.isError).toBe(true);
      expect(JSON.stringify(preAcceptReply.content)).toContain("accepted");
      expect(posts).toEqual([]);

      const wrongReceipt = await client.callTool({
        name: "party_channel_accept",
        arguments: {
          execution_id: "delivery-12",
          claim_receipt: "receipt-from-an-old-generation",
        },
      });
      expect(wrongReceipt.isError).toBe(true);
      expect(JSON.stringify(wrongReceipt.content)).toContain(
        "invalid or belongs to an old ownership generation",
      );

      const accept = await client.callTool({
        name: "party_channel_accept",
        arguments: { execution_id: "delivery-12", claim_receipt: receipt! },
      });
      expect(accept.isError).not.toBe(true);
      expect(JSON.stringify(accept.content)).toContain("durably accepted");

      // Model the accept ACK being lost after its WAL commit. The exact retry
      // is a successful no-op, and a later claim cannot release the body again.
      const duplicateAccept = await client.callTool({
        name: "party_channel_accept",
        arguments: { execution_id: "delivery-12", claim_receipt: receipt! },
      });
      expect(duplicateAccept.isError).not.toBe(true);
      expect(JSON.stringify(duplicateAccept.content)).toContain("already durably accepted");
      const postAcceptClaim = await client.callTool({
        name: "party_channel_claim",
        arguments: { execution_id: "delivery-12" },
      });
      expect(postAcceptClaim.isError).toBe(true);
      expect(JSON.stringify(postAcceptClaim.content)).toContain("already accepted");
      expect(JSON.stringify(postAcceptClaim.content)).not.toContain("same-session work");

      const reply = await client.callTool({
        name: "party_channel_reply",
        arguments: { seq: 12, text: "linked response" },
      });
      expect(reply.isError).not.toBe(true);
      expect(posts).toEqual([expect.objectContaining({
        kind: "message",
        body: "linked response",
        mentions: ["alice"],
        reply_to: 12,
        idempotency_key: "claude-channel-reply:delivery-12",
      })]);
      expect(clientFrames).toContainEqual(expect.objectContaining({
        type: "delivery_update",
        delivery_id: "delivery-12",
        state: "running",
      }));
      expect(clientFrames).toContainEqual(expect.objectContaining({
        type: "delivery_update",
        delivery_id: "delivery-12",
        state: "replied",
        reply_seq: 99,
      }));
    } finally {
      await client.close();
    }
  }, 10_000);
});
