import { afterEach, describe, expect, test } from "bun:test";
import {
  EXIT_ARCHIVED,
  EXIT_STREAM_ENDED,
  EXIT_TIMEOUT,
  type DirectedDelivery,
  type MsgFrame,
} from "@agentparty/shared";
import { runWatch, type WatchOptions } from "../src/commands/watch";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function message(seq: number): MsgFrame {
  return msgFrame(seq, `work ${seq}`, { mentions: ["me"] }) as unknown as MsgFrame;
}

function delivery(seq: number, over: Partial<DirectedDelivery> = {}): DirectedDelivery {
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
    ...over,
  };
}

function deliveryState(
  work: DirectedDelivery,
  over: Partial<{
    id: string;
    target_name: string;
    state: DirectedDelivery["state"];
  }> = {},
) {
  return {
    id: work.id,
    message_seq: work.message_seq,
    target_name: work.target_name,
    state: work.state,
    reply_seq: work.reply_seq,
    created_at: work.created_at,
    updated_at: Date.now(),
    ...over,
  };
}

function opts(over: Partial<WatchOptions> & Pick<WatchOptions, "server">): WatchOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    token: "ap_test",
    channel: "dev",
    since: 0,
    timeoutSec: 1,
    follow: false,
    once: true,
    mentionsOnly: true,
    allowMultiple: true,
    backoffBaseMs: 20,
    onDirectedAccepted: () => true,
    out: (line) => lines.push(line),
    lines,
    ...over,
  };
}

describe("watch durable directed-delivery adapter (#551)", () => {
  test("actionable --once persists debt, waits for an exact running ACK, then outputs exactly once", async () => {
    const msg = message(1);
    const work = delivery(1);
    const clientFrames: Array<Record<string, unknown>> = [];
    const stuck: Array<Record<string, unknown>> = [];
    let stuckCountAtRunning = -1;
    let outputCountBeforeExactAck = -1;
    let exactAckSent = false;
    let acceptedAfterExactAck = false;
    let o!: WatchOptions & { lines: string[] };
    server = startMockServer((frame, sock) => {
      clientFrames.push(frame as unknown as Record<string, unknown>);
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(1, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") {
        sock.send({ type: "delivery_adapter", adapter: "watch", registered: true });
        sock.send({ type: "delivery_state", delivery: deliveryState(work, { state: "claimed" }) });
        sock.send({ type: "delivery", delivery: work, message: msg });
        sock.send({ type: "delivery", delivery: work, message: msg });
        return;
      }
      if (frame.type === "delivery_update") {
        stuckCountAtRunning = stuck.length;
        // None of these public broadcasts is the authoritative ACK for this exact holder update.
        sock.send({ type: "delivery_state", delivery: deliveryState(work, { id: "wrong-id", state: "running" }) });
        sock.send({ type: "delivery_state", delivery: deliveryState(work, { target_name: "other", state: "running" }) });
        sock.send({ type: "delivery_state", delivery: deliveryState(work, { state: "claimed" }) });
        sock.send({ type: "delivery_state", delivery: deliveryState(work, { state: "failed" }) });
        setTimeout(() => {
          outputCountBeforeExactAck = o.lines.length;
          exactAckSent = true;
          sock.send({ type: "delivery_state", delivery: deliveryState(work, { state: "running" }) });
        }, 20);
      }
    });

    o = opts({
      server: server.url,
      json: true,
      onStuck: (item) => stuck.push(item as unknown as Record<string, unknown>),
      onDirectedAccepted: (deliveryId) => {
        acceptedAfterExactAck = exactAckSent && deliveryId === work.id;
        return acceptedAfterExactAck;
      },
    });
    expect(await runWatch(o)).toBe(0);

    expect(clientFrames).toContainEqual({ type: "delivery_adapter", adapter: "watch", op: "register" });
    expect(clientFrames).toContainEqual({
      type: "delivery_update",
      delivery_id: work.id,
      state: "running",
      work_id: work.work_id,
      continuation_ref: work.continuation_ref,
    });
    expect(stuckCountAtRunning).toBe(1);
    expect(outputCountBeforeExactAck).toBe(0);
    expect(acceptedAfterExactAck).toBe(true);
    expect(stuck).toEqual([
      expect.objectContaining({
        seq: 1,
        delivery_id: work.id,
        work_id: work.work_id,
        continuation_ref: work.continuation_ref,
        delivery_acceptance: "unconfirmed",
        source: "watch",
      }),
    ]);

    const output = o.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(output.filter((frame) => frame.type === "delivery")).toHaveLength(1);
    expect(output.find((frame) => frame.type === "delivery")).toMatchObject({
      delivery: {
        id: work.id,
        work_id: work.work_id,
        continuation_ref: work.continuation_ref,
      },
      message: { seq: 1 },
    });
    expect(output.some((frame) => frame.type === "delivery_state")).toBe(false);
  });

  test("delivery remains actionable when its message seq is already behind the ordinary cursor", async () => {
    const msg = message(3);
    const work = delivery(3, { id: "old-seq-new-delivery" });
    const cursors: number[] = [];
    const stuck: Array<Record<string, unknown>> = [];
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(10, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") {
        sock.send({ type: "delivery_adapter", adapter: "watch", registered: true });
        sock.send({ type: "delivery", delivery: work, message: msg });
        return;
      }
      if (frame.type === "delivery_update") {
        sock.send({ type: "delivery_state", delivery: deliveryState(work, { state: "running" }) });
      }
    });

    const o = opts({
      server: server.url,
      since: 10,
      json: true,
      onCursor: (cursor) => cursors.push(cursor),
      onStuck: (item) => stuck.push(item as unknown as Record<string, unknown>),
    });
    expect(await runWatch(o)).toBe(0);
    expect(cursors).toEqual([]);
    expect(stuck).toEqual([expect.objectContaining({ seq: 3, delivery_id: work.id })]);
    expect(JSON.parse(o.lines[0]!)).toMatchObject({
      type: "delivery",
      delivery: { id: work.id },
      message: { seq: 3 },
      channel_last_seq: 10,
      lag: 7,
    });
  });

  test("--follow observes ordinary messages without registering or claiming durable work", async () => {
    const msg = message(2);
    const clientFrames: Array<Record<string, unknown>> = [];
    server = startMockServer((frame, sock) => {
      clientFrames.push(frame as unknown as Record<string, unknown>);
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(2, "me"), directed_delivery: "v1" });
        sock.send(msg);
        setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 20);
      }
    });

    const o = opts({ server: server.url, once: false, follow: true, json: true });
    expect(await runWatch(o)).toBe(EXIT_ARCHIVED);
    const output = o.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(output.filter((frame) => frame.type === "msg")).toHaveLength(1);
    expect(clientFrames.some((frame) => frame.type === "delivery_adapter")).toBe(false);
    expect(clientFrames.some((frame) => frame.type === "delivery_update")).toBe(false);
  });

  test("plain watch observes ordinary messages without registering or claiming durable work", async () => {
    const msg = message(2);
    const clientFrames: Array<Record<string, unknown>> = [];
    server = startMockServer((frame, sock) => {
      clientFrames.push(frame as unknown as Record<string, unknown>);
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(2, "me"), directed_delivery: "v1" });
        sock.send(msg);
      }
    });

    const o = opts({ server: server.url, once: false, follow: false, json: true });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ type: "msg", seq: 2 })]);
    expect(clientFrames.some((frame) => frame.type === "delivery_adapter")).toBe(false);
    expect(clientFrames.some((frame) => frame.type === "delivery_update")).toBe(false);
  });

  test("generic --once cannot claim work because an unrelated message may make it exit first", async () => {
    const msg = message(3);
    const clientFrames: Array<Record<string, unknown>> = [];
    server = startMockServer((frame, sock) => {
      clientFrames.push(frame as unknown as Record<string, unknown>);
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(3, "me"), directed_delivery: "v1" });
        sock.send(msg);
      }
    });

    const o = opts({ server: server.url, once: true, mentionsOnly: false, json: true });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ type: "msg", seq: 3 })]);
    expect(clientFrames.some((frame) => frame.type === "delivery_adapter")).toBe(false);
    expect(clientFrames.some((frame) => frame.type === "delivery_update")).toBe(false);
  });

  test("local debt persistence failure sends no running update and produces no success output", async () => {
    const msg = message(5);
    const work = delivery(5);
    const clientFrames: Array<Record<string, unknown>> = [];
    server = startMockServer((frame, sock) => {
      clientFrames.push(frame as unknown as Record<string, unknown>);
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(5, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") {
        sock.send({ type: "delivery_adapter", adapter: "watch", registered: true });
        sock.send({ type: "delivery", delivery: work, message: msg });
      }
    });

    const o = opts({
      server: server.url,
      json: true,
      onStuck: () => { throw new Error("disk full"); },
    });
    expect(await runWatch(o)).toBe(EXIT_STREAM_ENDED);
    expect(clientFrames.some((frame) => frame.type === "delivery_update")).toBe(false);
    expect(o.lines).toEqual([]);
  });

  test("a rejected running update produces no success output", async () => {
    const msg = message(6);
    const work = delivery(6);
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(6, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") {
        sock.send({ type: "delivery_adapter", adapter: "watch", registered: true });
        sock.send({ type: "delivery", delivery: work, message: msg });
        return;
      }
      if (frame.type === "delivery_update") {
        sock.send({ type: "error", code: "bad_request", message: "lease rejected" });
      }
    });

    const o = opts({ server: server.url, json: true, onStuck: () => {} });
    expect(await runWatch(o)).toBe(EXIT_STREAM_ENDED);
    expect(o.lines).toEqual([]);
  });

  test("a disconnect before the running ACK produces no success output", async () => {
    const msg = message(7);
    const work = delivery(7);
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(7, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") {
        sock.send({ type: "delivery_adapter", adapter: "watch", registered: true });
        sock.send({ type: "delivery", delivery: work, message: msg });
        return;
      }
      if (frame.type === "delivery_update") sock.close();
    });

    const o = opts({ server: server.url, json: true, onStuck: () => {}, deliveryAckTimeoutMs: 200 });
    expect(await runWatch(o)).toBe(EXIT_STREAM_ENDED);
    expect(o.lines).toEqual([]);
  });

  test("a running ACK timeout produces no success output", async () => {
    const msg = message(8);
    const work = delivery(8);
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(8, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") {
        sock.send({ type: "delivery_adapter", adapter: "watch", registered: true });
        sock.send({ type: "delivery", delivery: work, message: msg });
      }
    });

    const o = opts({ server: server.url, json: true, onStuck: () => {}, deliveryAckTimeoutMs: 40 });
    expect(await runWatch(o)).toBe(EXIT_STREAM_ENDED);
    expect(o.lines).toEqual([]);
  });

  test("accepted-state persistence failure after running ACK is unknown outcome and produces no output", async () => {
    const msg = message(9);
    const work = delivery(9);
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(9, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") {
        sock.send({ type: "delivery_adapter", adapter: "watch", registered: true });
        sock.send({ type: "delivery", delivery: work, message: msg });
        return;
      }
      if (frame.type === "delivery_update") {
        sock.send({ type: "delivery_state", delivery: deliveryState(work, { state: "running" }) });
      }
    });

    const o = opts({
      server: server.url,
      json: true,
      onStuck: () => {},
      onDirectedAccepted: () => false,
    });
    expect(await runWatch(o)).toBe(EXIT_STREAM_ENDED);
    expect(o.lines).toEqual([]);
  });

  test("non-claimed full delivery states never wake --once", async () => {
    const msg = message(4);
    const work = delivery(4);
    const stuck: Array<Record<string, unknown>> = [];
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(4, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") {
        sock.send({ type: "delivery_adapter", adapter: "watch", registered: true });
        for (const state of ["queued", "running", "waiting_owner", "replied", "failed"] as const) {
          sock.send({ type: "delivery", delivery: { ...work, state }, message: msg });
        }
      }
    });

    const o = opts({
      server: server.url,
      timeoutSec: 0.1,
      onStuck: (item) => stuck.push(item as unknown as Record<string, unknown>),
    });
    expect(await runWatch(o)).toBe(EXIT_TIMEOUT);
    expect(o.lines).toEqual(["TIMEOUT"]);
    expect(stuck).toEqual([]);
  });

  test("delivery_state alone never wakes once", async () => {
    const work = delivery(4);
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(4, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") {
        sock.send({ type: "delivery_adapter", adapter: "watch", registered: true });
        sock.send({
          type: "delivery_state",
          delivery: {
            id: work.id,
            message_seq: 4,
            target_name: "me",
            state: "claimed",
            reply_seq: null,
            created_at: work.created_at,
            updated_at: work.updated_at,
          },
        });
      }
    });

    const o = opts({ server: server.url, timeoutSec: 0.1, onStuck: () => {} });
    expect(await runWatch(o)).toBe(EXIT_TIMEOUT);
    expect(o.lines).toEqual(["TIMEOUT"]);
  });

  test("raw directed mention in v1 can display and advance but cannot wake without delivery", async () => {
    const cursors: number[] = [];
    const stuck: Array<Record<string, unknown>> = [];
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(1, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "delivery_adapter") sock.send(message(1));
    });

    const o = opts({
      server: server.url,
      timeoutSec: 0.1,
      onCursor: (cursor) => cursors.push(cursor),
      onStuck: (item) => stuck.push(item as unknown as Record<string, unknown>),
    });
    expect(await runWatch(o)).toBe(EXIT_TIMEOUT);
    expect(o.lines.some((line) => line.includes("work 1"))).toBe(true);
    expect(o.lines.at(-1)).toBe("TIMEOUT");
    expect(cursors).toEqual([1]);
    expect(stuck).toEqual([]);
  });
});
