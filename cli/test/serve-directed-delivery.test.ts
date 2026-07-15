import { afterEach, describe, expect, test } from "bun:test";
import { EXIT_ARCHIVED, EXIT_STREAM_ENDED, type DirectedDelivery, type MsgFrame } from "@agentparty/shared";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runServe, type ServeOptions, type ServeRunner } from "../src/commands/serve";
import { writeConfig, writeState } from "../src/config";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";
import { startRestMock } from "./rest-mock";

let server: MockServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function delivery(messageSeq: number, over: Partial<DirectedDelivery> = {}): DirectedDelivery {
  return {
    id: `delivery-${messageSeq}`,
    message_seq: messageSeq,
    target_name: "me",
    cause: "mention",
    state: "claimed",
    attempt: 1,
    lease_until: Date.now() + 90_000,
    work_id: `work-${messageSeq}`,
    continuation_ref: `continuation-${messageSeq}`,
    reply_seq: null,
    last_error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
}

function opts(over: Partial<ServeOptions> & Pick<ServeOptions, "server">): ServeOptions {
  return {
    token: "ap_test",
    channel: "dev",
    since: 0,
    cmd: "",
    mentionsOnly: true,
    allowMultiple: true,
    advertise: async () => {},
    post: async () => ({ seq: 99 }),
    ...over,
  };
}

describe("serve durable directed delivery (#551)", () => {
  test("custom decision resumes as a fresh process on the served channel with exact lineage context", async () => {
    const home = mkdtempSync(join(tmpdir(), "ap-custom-continuation-"));
    const evidencePath = join(home, "owner-answer.json");
    const previousHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    const sourceMessage = msgFrame(20, "needs owner approval", { mentions: ["me"] }) as unknown as MsgFrame;
    const source = delivery(20, {
      id: "delivery-custom-source",
      work_id: "work-custom",
      continuation_ref: "custom-context-v1",
    });
    const ownerMessage = {
      ...(msgFrame(21, "@me decision #70 → approve", { mentions: ["me"], reply_to: 70 }) as unknown as MsgFrame),
      decision_response: {
        request_seq: 70,
        chosen_index: 0,
        chosen_option: "approve",
        prompt: "custom approval",
        delivery_id: source.id,
        origin_seq: source.message_seq,
        origin_channel: "serve-b",
        work_id: source.work_id!,
        continuation_ref: source.continuation_ref!,
      },
    } satisfies MsgFrame;
    const owner = delivery(21, {
      id: "delivery-custom-owner-answer",
      cause: "owner_answer",
      work_id: source.work_id,
      continuation_ref: source.continuation_ref,
    });
    const rest = startRestMock((request) => {
      if (request.method !== "POST" || request.path !== "/api/channels/serve-b/messages") return undefined;
      return Response.json({
        seq: 70,
        decision_request: {
          kind: "approval",
          prompt: "custom approval",
          options: ["approve", "reject"],
          delivery_id: source.id,
          origin_seq: source.message_seq,
          origin_channel: "serve-b",
          work_id: source.work_id,
          continuation_ref: source.continuation_ref,
        },
        decision_resolution: { state: "pending" },
      });
    });
    try {
      writeConfig({ server: rest.url, token: "ap_custom" });
      writeState({ channel: "bound-a", cursor: 0 });
      const indexPath = join(import.meta.dir, "..", "src", "index.ts");
      const customScriptPath = join(home, "custom-runner.ts");
      const script = `
        const context = await Bun.file(process.env.AP_CONTEXT_FILE).json();
        if (context.decision_response) {
          await Bun.write(${JSON.stringify(evidencePath)}, JSON.stringify({
            context,
            env: {
              channel: process.env.AGENTPARTY_CHANNEL,
              harness: process.env.AP_RUNNER_HARNESS,
              deliveryId: process.env.AP_DELIVERY_ID,
              workId: process.env.AP_WORK_ID,
              continuationRef: process.env.AP_CONTINUATION_REF,
            },
          }));
        } else {
          const child = Bun.spawn([
            process.execPath,
            ${JSON.stringify(indexPath)},
            "decision",
            "ask",
            "custom approval",
          ], { env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
          process.exit(await child.exited);
        }
      `;
      writeFileSync(customScriptPath, script);
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(customScriptPath)}`;
      server = startMockServer((frame, sock) => {
        if (frame.type === "hello") {
          sock.send({ ...welcomeFrame(0, "me"), channel: "serve-b", directed_delivery: "v1" });
          return;
        }
        if (frame.type === "serve_lease") {
          sock.send({ type: "serve_lease", name: "me", held: true });
          sock.send({ type: "delivery", delivery: source, message: sourceMessage });
          return;
        }
        if (frame.type !== "delivery_update") return;
        if (frame.delivery_id === source.id && frame.state === "running") {
          sock.send({ type: "delivery_state", delivery: { ...source, state: "running", updated_at: Date.now() } });
        } else if (frame.delivery_id === source.id && frame.state === "replied") {
          sock.send({ type: "delivery_state", delivery: { ...source, state: "waiting_owner", updated_at: Date.now() } });
          sock.send({ type: "delivery", delivery: owner, message: ownerMessage });
        } else if (frame.delivery_id === owner.id && frame.state === "running") {
          sock.send({ type: "delivery_state", delivery: { ...owner, state: "running", updated_at: Date.now() } });
        } else if (frame.delivery_id === owner.id && frame.state === "replied") {
          sock.send({ type: "delivery_state", delivery: { ...owner, state: "replied", updated_at: Date.now() } });
          sock.send({ type: "error", code: "archived", message: "done" });
        }
      });

      expect(await runServe(opts({ server: server.url, channel: "serve-b", cmd: command }))).toBe(EXIT_ARCHIVED);

      expect(rest.requests.some((request) =>
        request.method === "POST" && request.path === "/api/channels/serve-b/messages"
      )).toBe(true);
      expect(rest.requests.some((request) => request.path === "/api/channels/bound-a/messages")).toBe(false);
      expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
        env: {
          channel: "serve-b",
          harness: "custom",
          deliveryId: owner.id,
          workId: source.work_id,
          continuationRef: source.continuation_ref,
        },
        context: {
          delivery: {
            id: owner.id,
            cause: "owner_answer",
            work_id: source.work_id,
            continuation_ref: source.continuation_ref,
          },
          decision_response: {
            request_seq: 70,
            chosen_option: "approve",
            delivery_id: source.id,
            work_id: source.work_id,
            continuation_ref: source.continuation_ref,
          },
        },
      });
    } finally {
      rest.stop();
      if (previousHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("running waits for every blocking preflight and runner_started audit never delays model start", async () => {
    const message = msgFrame(1, "preflight", {
      mentions: ["me"],
      attachments: [{
        key: "dev/file",
        filename: "file.bin",
        content_type: "application/octet-stream",
        size: 1,
        url: "/api/channels/dev/attachments/file",
      }],
    }) as unknown as MsgFrame;
    const work = delivery(1);
    const events: string[] = [];
    let releaseDownload!: (value: Uint8Array) => void;
    let releaseUpgrade!: () => void;
    let releasePrepare!: () => void;
    const downloadGate = new Promise<Uint8Array>((resolve) => { releaseDownload = resolve; });
    const upgradeGate = new Promise<void>((resolve) => { releaseUpgrade = resolve; });
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const waitFor = async (event: string) => {
      for (let i = 0; i < 100 && !events.includes(event); i++) await Bun.sleep(5);
      expect(events).toContain(event);
    };
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
      } else if (frame.type === "serve_lease") {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send({ type: "delivery", delivery: work, message });
      } else if (frame.type === "delivery_update") {
        events.push(`delivery:${frame.state}`);
        sock.send({ type: "delivery_state", delivery: { ...work, state: frame.state, updated_at: Date.now() } });
        if (frame.state === "replied") sock.send({ type: "error", code: "archived", message: "done" });
      }
    });
    const runner: ServeRunner = async () => { events.push("model"); };
    runner.prepare = async () => {
      events.push("prepare:start");
      await prepareGate;
      events.push("prepare:done");
    };
    const running = runServe(opts({
      server: server.url,
      downloadAttachment: async () => {
        events.push("download:start");
        const bytes = await downloadGate;
        events.push("download:done");
        return bytes;
      },
      refreshAvailableUpgrade: async (current) => {
        events.push("upgrade:start");
        await upgradeGate;
        events.push("upgrade:done");
        return current;
      },
      upgradeProbeIntervalMs: 0,
      // The audit POST intentionally never resolves. It must be fire-and-forget after running ACK.
      post: async () => await new Promise<never>(() => {}),
      runCommand: runner,
    }));

    await waitFor("download:start");
    expect(events.some((event) => event.startsWith("delivery:"))).toBe(false);
    releaseDownload(new Uint8Array([1]));
    await waitFor("upgrade:start");
    expect(events.some((event) => event.startsWith("delivery:"))).toBe(false);
    releaseUpgrade();
    await waitFor("prepare:start");
    expect(events.some((event) => event.startsWith("delivery:"))).toBe(false);
    releasePrepare();
    expect(await running).toBe(EXIT_ARCHIVED);
    expect(events).toEqual(expect.arrayContaining([
      "download:done",
      "upgrade:done",
      "prepare:done",
      "delivery:running",
      "model",
      "delivery:replied",
    ]));
    expect(events.indexOf("prepare:done")).toBeLessThan(events.indexOf("delivery:running"));
    expect(events.indexOf("delivery:running")).toBeLessThan(events.indexOf("model"));
  });

  test("ordinary mention advances the read cursor but only its delivery frame runs the command", async () => {
    const message = msgFrame(1, "do this once", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(1, { work_id: "work-1", continuation_ref: "codex:thread-1" });
    const updates: Array<Record<string, unknown>> = [];
    const cursors: number[] = [];
    const seen: number[] = [];
    let receivedContext: DirectedDelivery | null | undefined;
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "serve_lease") {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send(message);
        sock.send({ type: "delivery", delivery: work, message });
        return;
      }
      if (frame.type === "delivery_update") {
        updates.push(frame as unknown as Record<string, unknown>);
        sock.send({
          type: "delivery_state",
          delivery: { ...work, state: frame.state, updated_at: Date.now() },
        });
        if (frame.state !== "running") sock.send({ type: "error", code: "archived", message: "done" });
      }
    });

    const code = await runServe(opts({
      server: server.url,
      onCursor: (cursor) => cursors.push(cursor),
      runCommand: async (frame, context) => {
        seen.push(frame.seq);
        receivedContext = context.delivery;
        expect(context.recent.map((item) => item.seq)).not.toContain(frame.seq);
      },
    }));

    expect(code).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([1]);
    expect(cursors).toEqual([1]);
    expect(receivedContext).toMatchObject({ id: work.id, work_id: "work-1", continuation_ref: "codex:thread-1" });
    expect(updates).toEqual([
      {
        type: "delivery_update",
        delivery_id: work.id,
        state: "running",
        work_id: work.work_id,
        continuation_ref: work.continuation_ref,
      },
      { type: "delivery_update", delivery_id: work.id, state: "replied" },
    ]);
  });

  test("a persisted delivery runs even when its source message is behind the ordinary cursor and attach head", async () => {
    const message = msgFrame(3, "offline work", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(3, { attempt: 2, cause: "retry" });
    const seen: number[] = [];
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(10, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "serve_lease") {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send({ type: "delivery", delivery: work, message });
        return;
      }
      if (frame.type === "delivery_update") {
        sock.send({
          type: "delivery_state",
          delivery: { ...work, state: frame.state, updated_at: Date.now() },
        });
        if (frame.state !== "running") sock.send({ type: "error", code: "archived", message: "done" });
      }
    });

    const code = await runServe(opts({
      server: server.url,
      since: 10,
      skipBacklog: true,
      runCommand: async (frame) => { seen.push(frame.seq); },
    }));

    expect(code).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([3]);
  });

  test("an exhausted runner reports the delivery failed instead of silently releasing it", async () => {
    const message = msgFrame(7, "will fail", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(7);
    const updates: Array<Record<string, unknown>> = [];
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "serve_lease") {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send({ type: "delivery", delivery: work, message });
        return;
      }
      if (frame.type === "delivery_update") {
        updates.push(frame as unknown as Record<string, unknown>);
        sock.send({
          type: "delivery_state",
          delivery: { ...work, state: frame.state, last_error: frame.error ?? null, updated_at: Date.now() },
        });
        if (frame.state !== "running") sock.send({ type: "error", code: "archived", message: "done" });
      }
    });

    const code = await runServe(opts({
      server: server.url,
      maxWakeAttempts: 1,
      runCommand: async () => { throw new Error("runner exploded"); },
    }));

    expect(code).toBe(EXIT_ARCHIVED);
    expect(updates[0]).toMatchObject({
      type: "delivery_update",
      delivery_id: work.id,
      state: "running",
    });
    expect(updates[1]).toMatchObject({
      type: "delivery_update",
      delivery_id: work.id,
      state: "failed",
    });
    expect(String(updates[1]?.error)).toContain("runner exploded");
  });

  test("a disconnect that loses the terminal update exits unknown-outcome and never runs a redelivery", async () => {
    const message = msgFrame(9, "do not duplicate", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(9);
    const lines: string[] = [];
    let runnerCalls = 0;
    let updateCalls = 0;
    server = startMockServer((frame, sock, connectionIndex) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
        if (connectionIndex > 0) {
          // The replacement connection can already have the same durable work buffered. The first
          // run's unknown terminal outcome must stop this runServe invocation before it consumes it.
          sock.send({ type: "delivery", delivery: work, message });
          sock.send({ type: "error", code: "archived", message: "replacement connection" });
        }
        return;
      }
      if (frame.type === "serve_lease" && connectionIndex === 0) {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send({ type: "delivery", delivery: work, message });
        return;
      }
      if (frame.type === "delivery_update") {
        updateCalls += 1;
        if (frame.state === "running") {
          sock.send({
            type: "delivery_state",
            delivery: { ...work, state: "running", updated_at: Date.now() },
          });
        } else {
          // Drop the connection before an authoritative terminal delivery_state can echo the update.
          sock.close();
        }
      }
    });

    const code = await runServe(opts({
      server: server.url,
      out: (line) => lines.push(line),
      runCommand: async () => { runnerCalls += 1; },
    }));

    expect(code).toBe(EXIT_STREAM_ENDED);
    expect(runnerCalls).toBe(1);
    expect(updateCalls).toBe(2);
    expect(lines.some((line) => line.includes("完成回执发送失败"))).toBe(true);
  });

  test("a disconnect before the authoritative running acknowledgement never starts the runner", async () => {
    const message = msgFrame(12, "must not start", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(12);
    const lines: string[] = [];
    let runnerCalls = 0;
    let runningUpdates = 0;
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "serve_lease") {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send({ type: "delivery", delivery: work, message });
        return;
      }
      if (frame.type === "delivery_update" && frame.state === "running") {
        runningUpdates += 1;
        sock.close();
      }
    });

    const code = await runServe(opts({
      server: server.url,
      out: (line) => lines.push(line),
      runCommand: async () => { runnerCalls += 1; },
    }));

    expect(code).toBe(EXIT_STREAM_ENDED);
    expect(runningUpdates).toBe(1);
    expect(runnerCalls).toBe(0);
    expect(lines.some((line) => line.includes("启动确认失败，未启动 runner"))).toBe(true);
  }, 10_000);
});
