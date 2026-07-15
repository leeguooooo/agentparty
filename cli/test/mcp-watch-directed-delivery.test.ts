import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DirectedDelivery, MsgFrame } from "@agentparty/shared";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceId, type StuckWake } from "../src/config";
import { msgFrame, welcomeFrame } from "./mock-server";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let backend: ReturnType<typeof Bun.serve> | null = null;

interface BackendProbe {
  url: string;
  requests: Array<{ method: string; path: string }>;
  clientFrames: Array<Record<string, unknown>>;
}

function work(seq: number): DirectedDelivery {
  return {
    id: `delivery-${seq}`,
    message_seq: seq,
    target_name: "me",
    cause: "mention",
    state: "claimed",
    attempt: 1,
    lease_until: Date.now() + 90_000,
    work_id: `work-${seq}`,
    continuation_ref: `continuation-${seq}`,
    reply_seq: null,
    last_error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function publicState(delivery: DirectedDelivery, state: DirectedDelivery["state"]) {
  return {
    id: delivery.id,
    message_seq: delivery.message_seq,
    target_name: delivery.target_name,
    state,
    reply_seq: delivery.reply_seq,
    created_at: delivery.created_at,
    updated_at: Date.now(),
  };
}

function startBackend(options: {
  pending?: MsgFrame;
  head?: MsgFrame;
  onFrame?: (frame: Record<string, unknown>, send: (frame: unknown) => void) => void;
} = {}): BackendProbe {
  const requests: Array<{ method: string; path: string }> = [];
  const clientFrames: Array<Record<string, unknown>> = [];
  backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: `${url.pathname}${url.search}` });
      if (url.pathname === "/api/channels/dev/ws" && srv.upgrade(req, { data: undefined })) return;
      if (url.pathname === "/api/channels/dev/messages" && req.method === "GET") {
        const messages = url.searchParams.has("before")
          ? (options.head === undefined ? [] : [options.head])
          : (options.pending === undefined ? [] : [options.pending]);
        return Response.json({ messages });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        clientFrames.push(frame);
        options.onFrame?.(frame, (value) => ws.send(JSON.stringify(value)));
      },
    },
  });
  return { url: `http://127.0.0.1:${backend.port}`, requests, clientFrames };
}

function statePath(): string {
  return join(home, "state", workspaceId(process.cwd()), "state.json");
}

function writeRuntime(server: string, stuck?: StuckWake): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ server, token: "ap_tok" }));
  const path = statePath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      channel: "dev",
      cursor: stuck?.seq ?? 0,
      cursors: { dev: { cursor: stuck?.seq ?? 0, ...(stuck === undefined ? {} : { stuck }) } },
    }),
  );
}

function readDebt(): StuckWake | undefined {
  return JSON.parse(readFileSync(statePath(), "utf8")).cursors.dev.stuck as StuckWake | undefined;
}

async function connectClient(): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "AGENTPARTY_CONFIG") env[key] = value;
  }
  env.AGENTPARTY_HOME = home;
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", indexPath, "mcp", "--channel", "dev"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "agentparty-watch-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-mcp-watch-"));
});

afterEach(() => {
  backend?.stop(true);
  backend = null;
  rmSync(home, { recursive: true, force: true });
});

describe("MCP party_watch_once durable delivery (#551)", () => {
  test("new claimed work persists debt, ACKs running, and returns only after accepted", async () => {
    const delivery = work(11);
    const message = msgFrame(11, "@me do work", { mentions: ["me"] }) as unknown as MsgFrame;
    const probe = startBackend({
      onFrame(frame, send) {
        if (frame.type === "hello") {
          send({ ...welcomeFrame(11, "me"), directed_delivery: "v1" });
        } else if (frame.type === "delivery_adapter") {
          send({ type: "delivery_adapter", adapter: "watch", registered: true });
          send({ type: "delivery", delivery, message });
        } else if (frame.type === "delivery_update") {
          send({ type: "delivery_state", delivery: publicState(delivery, "running") });
        }
      },
    });
    writeRuntime(probe.url);
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "party_watch_once",
        arguments: { timeout_sec: 2 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        type: "watch_once",
        channel: "dev",
        exit_code: 0,
        frames: [{ type: "delivery", delivery: { id: delivery.id }, message: { seq: 11 } }],
      });
      expect(probe.clientFrames).toContainEqual({
        type: "delivery_update",
        delivery_id: delivery.id,
        state: "running",
        work_id: delivery.work_id,
        continuation_ref: delivery.continuation_ref,
      });
      expect(readDebt()).toMatchObject({
        seq: 11,
        delivery_id: delivery.id,
        work_id: delivery.work_id,
        continuation_ref: delivery.continuation_ref,
        delivery_acceptance: "accepted",
      });
    } finally {
      await client.close();
    }
  }, 20_000);

  test("accepted pending debt replays exact seq with lineage and sends no new ACK", async () => {
    const pending = msgFrame(12, "accepted pending", { mentions: ["me"] }) as unknown as MsgFrame;
    const head = msgFrame(15, "newer context") as unknown as MsgFrame;
    const probe = startBackend({ pending, head });
    writeRuntime(probe.url, {
      seq: 12,
      delivery_id: "delivery-12",
      work_id: "work-12",
      continuation_ref: "continuation-12",
      delivery_acceptance: "accepted",
      attempts: 1,
      source: "watch",
      channel_last_seq: 13,
      skipped_mention_seqs: [4],
    });
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: "party_watch_once", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        type: "watch_once",
        exit_code: 0,
        frames: [{
          seq: 12,
          watch_replay: true,
          pending_ack: true,
          replay_attempt: 2,
          delivery_id: "delivery-12",
          work_id: "work-12",
          continuation_ref: "continuation-12",
          delivery_acceptance: "accepted",
          channel_last_seq: 15,
          lag: 3,
          skipped_mention_seqs: [4],
        }],
      });
      expect(probe.clientFrames).toEqual([]);
      expect(probe.requests.filter((request) => request.method === "GET")).toHaveLength(2);
      expect(readDebt()).toMatchObject({ attempts: 2, delivery_acceptance: "accepted" });
    } finally {
      await client.close();
    }
  }, 20_000);

  test("unconfirmed directed debt re-registers and never blind-replays its seq", async () => {
    const pending = msgFrame(13, "must not replay", { mentions: ["me"] }) as unknown as MsgFrame;
    const probe = startBackend({
      pending,
      onFrame(frame, send) {
        if (frame.type === "hello") {
          send({ ...welcomeFrame(13, "me"), directed_delivery: "v1" });
        } else if (frame.type === "delivery_adapter") {
          send({ type: "error", code: "archived", message: "re-arm observed" });
        }
      },
    });
    const debt: StuckWake = {
      seq: 13,
      delivery_id: "delivery-13",
      work_id: "work-13",
      continuation_ref: "continuation-13",
      delivery_acceptance: "unconfirmed",
      attempts: 0,
      source: "watch",
    };
    writeRuntime(probe.url, debt);
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: "party_watch_once", arguments: { timeout_sec: 2 } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ exit_code: expect.any(Number) });
      expect(JSON.stringify(result.structuredContent)).not.toContain("watch_replay");
      expect(JSON.stringify(result.structuredContent)).not.toContain("must not replay");
      expect(probe.clientFrames.some((frame) => frame.type === "delivery_adapter")).toBe(true);
      expect(probe.requests.some((request) => request.method === "GET" && request.path.includes("/messages?"))).toBe(false);
      expect(readDebt()).toEqual(debt);
    } finally {
      await client.close();
    }
  }, 20_000);

  test("serve debt fails closed without REST replay, websocket claim, or overwrite", async () => {
    const probe = startBackend();
    const debt: StuckWake = { seq: 14, attempts: 2, source: "serve", last_error: "runner pending" };
    writeRuntime(probe.url, debt);
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: "party_watch_once", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("pending serve wake") }),
      ]);
      expect(probe.requests).toEqual([]);
      expect(probe.clientFrames).toEqual([]);
      expect(readDebt()).toEqual(debt);
    } finally {
      await client.close();
    }
  }, 20_000);
});
