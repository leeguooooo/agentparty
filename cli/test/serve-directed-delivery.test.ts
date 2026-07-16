import { afterEach, describe, expect, test } from "bun:test";
import {
  EXIT_ARCHIVED,
  EXIT_STREAM_ENDED,
  type ClientFrame,
  type DirectedDelivery,
  type MsgFrame,
  type ServerFrame,
} from "@agentparty/shared";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmDeliveryUpdate, runServe, type ServeOptions, type ServeRunner } from "../src/commands/serve";
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
  test("terminal ACK ignores stale same-state broadcasts without the matching request id", async () => {
    const work = delivery(1);
    const publicWork = {
      id: work.id,
      message_seq: work.message_seq,
      target_name: work.target_name,
      state: "replied" as const,
      reply_seq: null,
      created_at: work.created_at,
      updated_at: work.updated_at,
    };
    const frames: ServerFrame[] = [{ type: "delivery_state", delivery: publicWork }];
    let exactAckSent = false;
    const conn = {
      send(frame: ClientFrame) {
        if (frame.type !== "delivery_update") return false;
        frames.push({ type: "delivery_state", request_id: "stale-request", delivery: publicWork });
        setTimeout(() => {
          exactAckSent = true;
          frames.push({ type: "delivery_state", request_id: frame.request_id, delivery: publicWork });
        }, 20);
        return true;
      },
      pendingFrames: () => frames,
    };

    expect(await confirmDeliveryUpdate(conn, {
      type: "delivery_update",
      delivery_id: work.id,
      state: "replied",
    }, 200)).toMatchObject({ id: work.id, state: "replied" });
    expect(exactAckSent).toBe(true);
  });

  test("a completion probe can explicitly accept the Worker's authoritative failed state", async () => {
    const work = delivery(2);
    const failed = {
      id: work.id,
      message_seq: work.message_seq,
      target_name: work.target_name,
      state: "failed" as const,
      reply_seq: null,
      created_at: work.created_at,
      updated_at: Date.now(),
    };
    const frames: ServerFrame[] = [];
    const conn = {
      send(frame: ClientFrame) {
        if (frame.type !== "delivery_update") return false;
        frames.push({ type: "delivery_state", request_id: frame.request_id, delivery: failed });
        return true;
      },
      pendingFrames: () => frames,
    };

    await expect(confirmDeliveryUpdate(conn, {
      type: "delivery_update",
      delivery_id: work.id,
      state: "replied",
    }, 200)).rejects.toThrow("delivery state is failed, expected replied");
    expect(await confirmDeliveryUpdate(conn, {
      type: "delivery_update",
      delivery_id: work.id,
      state: "replied",
    }, 200, undefined, ["failed"])).toMatchObject({ id: work.id, state: "failed" });
  });

  test("waiting_owner is parked work and never triggers terminal continuation cleanup", async () => {
    const message = msgFrame(3, "ask owner", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(3);
    const terminals: Array<{ id: string; state: "replied" | "failed" }> = [];
    const runner: ServeRunner = async () => {};
    runner.onDeliveryTerminal = (terminal, state) => {
      terminals.push({ id: terminal.id, state });
    };
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
      } else if (frame.type === "serve_lease") {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send({ type: "delivery", delivery: work, message });
      } else if (frame.type === "delivery_update" && frame.state === "running") {
        sock.send({
          type: "delivery_state",
          request_id: frame.request_id,
          delivery: { ...work, state: "running", updated_at: Date.now() },
        });
      } else if (frame.type === "delivery_update" && frame.state === "replied") {
        sock.send({
          type: "delivery_state",
          request_id: frame.request_id,
          delivery: { ...work, state: "waiting_owner", updated_at: Date.now() },
        });
        sock.send({ type: "error", code: "archived", message: "parked" });
      }
    });

    expect(await runServe(opts({ server: server.url, runCommand: runner }))).toBe(EXIT_ARCHIVED);
    expect(terminals).toEqual([]);
  });

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
    let channelSocket: { send(frame: ServerFrame): void } | undefined;
    const rest = startRestMock((request) => {
      if (request.method !== "POST" || request.path !== "/api/channels/serve-b/messages") return undefined;
      const requestBody = request.body as { decision_request?: unknown; reply_to?: unknown } | null;
      if (requestBody?.decision_request === undefined) {
        if (requestBody?.reply_to === ownerMessage.seq) {
          channelSocket?.send({
            type: "delivery_state",
            delivery: { ...owner, state: "replied", reply_seq: 71, updated_at: Date.now() },
          });
        }
        return Response.json({ seq: 71 });
      }
      channelSocket?.send({
        type: "delivery_state",
        delivery: { ...source, state: "waiting_owner", updated_at: Date.now() },
      });
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
          const child = Bun.spawn([
            process.execPath,
            ${JSON.stringify(indexPath)},
            "send",
            "owner continuation complete",
            "--channel",
            process.env.AGENTPARTY_CHANNEL,
            "--reply-to",
            String(context.reply_to),
          ], { env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
          process.exit(await child.exited);
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
          channelSocket = sock;
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
          sock.send({ type: "delivery_state", request_id: frame.request_id, delivery: { ...source, state: "running", updated_at: Date.now() } });
        } else if (frame.delivery_id === source.id && frame.state === "replied") {
          sock.send({ type: "delivery_state", request_id: frame.request_id, delivery: { ...source, state: "waiting_owner", updated_at: Date.now() } });
          sock.send({ type: "delivery", delivery: owner, message: ownerMessage });
        } else if (frame.delivery_id === owner.id && frame.state === "running") {
          sock.send({ type: "delivery_state", request_id: frame.request_id, delivery: { ...owner, state: "running", updated_at: Date.now() } });
        } else if (frame.delivery_id === owner.id && frame.state === "replied") {
          sock.send({ type: "delivery_state", request_id: frame.request_id, delivery: { ...owner, state: "replied", updated_at: Date.now() } });
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
            chosen_index: 0,
            chosen_option: "approve",
            prompt: "custom approval",
            delivery_id: source.id,
            origin_seq: source.message_seq,
            origin_channel: "serve-b",
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
    let auditCalls = 0;
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
        sock.send({ type: "delivery_state", request_id: frame.request_id, delivery: { ...work, state: frame.state, updated_at: Date.now() } });
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
      post: () => {
        auditCalls += 1;
        return new Promise<never>(() => {});
      },
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
    expect(auditCalls).toBeGreaterThan(0);
  });

  test("ordinary mention advances the read cursor but only its delivery frame runs the command", async () => {
    const message = msgFrame(1, "do this once", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(1, { work_id: "work-1", continuation_ref: "codex:thread-1" });
    const updates: Array<Record<string, unknown>> = [];
    const cursors: number[] = [];
    const seen: number[] = [];
    const terminals: Array<{ id: string; state: "replied" | "failed" }> = [];
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
          request_id: frame.request_id,
          delivery: { ...work, state: frame.state, updated_at: Date.now() },
        });
        if (frame.state !== "running") sock.send({ type: "error", code: "archived", message: "done" });
      }
    });

    const runner: ServeRunner = async (frame, context) => {
      seen.push(frame.seq);
      receivedContext = context.delivery;
      expect(context.recent.map((item) => item.seq)).not.toContain(frame.seq);
    };
    runner.onDeliveryTerminal = (terminal, state) => {
      terminals.push({ id: terminal.id, state });
    };
    const code = await runServe(opts({
      server: server.url,
      onCursor: (cursor) => cursors.push(cursor),
      runCommand: runner,
    }));

    expect(code).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([1]);
    expect(cursors).toEqual([1]);
    expect(terminals).toEqual([{ id: work.id, state: "replied" }]);
    expect(receivedContext).toMatchObject({ id: work.id, work_id: "work-1", continuation_ref: "codex:thread-1" });
    expect(updates).toEqual([
      expect.objectContaining({
        type: "delivery_update",
        delivery_id: work.id,
        state: "running",
        work_id: work.work_id,
        continuation_ref: work.continuation_ref,
        request_id: expect.any(String),
      }),
      expect.objectContaining({
        type: "delivery_update",
        delivery_id: work.id,
        state: "replied",
        request_id: expect.any(String),
      }),
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
          request_id: frame.request_id,
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

  test("terminal output strips control sequences from remote delivery fields", async () => {
    const message = msgFrame(6, "invalid remote delivery", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(6, {
      id: "delivery-\u001b]52;c;clipboard\u0007-six",
      target_name: "other\u001b[31m",
    });
    const lines: string[] = [];
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
      } else if (frame.type === "serve_lease") {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send({ type: "delivery", delivery: work, message });
        setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 10);
      }
    });

    expect(await runServe(opts({ server: server.url, out: (line) => lines.push(line) }))).toBe(EXIT_ARCHIVED);
    expect(lines.some((line) => line.includes("ignored invalid delivery"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/[\u001b\u0007]/);
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
          request_id: frame.request_id,
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

  test("a zero-exit custom command with no linked reply is blocked instead of reported as delivered", async () => {
    const message = msgFrame(8, "silent success", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(8);
    const updates: Array<Record<string, unknown>> = [];
    const posts: Array<{ kind: string; state?: string; note?: string }> = [];
    const lines: string[] = [];
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
      if (frame.type !== "delivery_update") return;
      updates.push(frame as unknown as Record<string, unknown>);
      const state = frame.state === "replied" ? "failed" : frame.state;
      sock.send({
        type: "delivery_state",
        request_id: frame.request_id,
        delivery: {
          ...work,
          state,
          last_error: state === "failed" ? "runner reported success without a linked channel reply" : null,
          updated_at: Date.now(),
        },
      });
      if (frame.state === "replied") {
        sock.send({ type: "error", code: "archived", message: "done" });
      }
    });

    const code = await runServe(opts({
      server: server.url,
      cmd: "true",
      out: (line) => lines.push(line),
      post: async (_server, _token, _channel, body) => {
        posts.push(body as { kind: string; state?: string; note?: string });
        return { seq: 100 + posts.length };
      },
    }));

    expect(code).toBe(EXIT_ARCHIVED);
    expect(updates.map((update) => update.state)).toEqual(["running", "replied"]);
    expect(posts).toContainEqual(expect.objectContaining({
      kind: "status",
      state: "blocked",
      note: expect.stringContaining("runner exited successfully without a linked channel reply"),
    }));
    expect(lines.some((line) => line.includes("runner exited successfully without a linked channel reply"))).toBe(true);
  });

  test("authoritative silent-success failure cleans continuation before a later ACK disconnect", async () => {
    const message = msgFrame(81, "silent success cleanup", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(81);
    const updates: string[] = [];
    const terminals: Array<{ id: string; state: "replied" | "failed" }> = [];
    server = startMockServer((frame, sock, connectionIndex) => {
      if (frame.type === "hello") {
        if (connectionIndex > 0) {
          sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
          sock.send({ type: "error", code: "archived", message: "done" });
          return;
        }
        sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
        return;
      }
      if (frame.type === "serve_lease") {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send({ type: "delivery", delivery: work, message });
        return;
      }
      if (frame.type !== "delivery_update") return;
      updates.push(frame.state);
      if (frame.state === "running") {
        sock.send({
          type: "delivery_state",
          request_id: frame.request_id,
          delivery: { ...work, state: "running", updated_at: Date.now() },
        });
        return;
      }
      if (frame.state === "replied") {
        sock.send({
          type: "delivery_state",
          request_id: frame.request_id,
          delivery: {
            ...work,
            state: "failed",
            last_error: "runner reported success without a linked channel reply",
            updated_at: Date.now(),
          },
        });
        setTimeout(() => sock.close(), 0);
      }
    });
    const runner: ServeRunner = async () => {};
    runner.onDeliveryTerminal = (terminal, state) => {
      terminals.push({ id: terminal.id, state });
    };

    const code = await runServe(opts({
      server: server.url,
      runCommand: runner,
      post: async () => ({ seq: 181 }),
    }));

    expect(code).toBe(EXIT_ARCHIVED);
    expect(updates).toEqual(["running", "replied"]);
    expect(terminals).toEqual([{ id: work.id, state: "failed" }]);
  });

  test("a disconnect that loses the terminal update exits unknown-outcome and never runs a redelivery", async () => {
    const message = msgFrame(9, "do not duplicate", { mentions: ["me"] }) as unknown as MsgFrame;
    const work = delivery(9);
    const lines: string[] = [];
    let runnerCalls = 0;
    let updateCalls = 0;
    const terminals: Array<{ id: string; state: "replied" | "failed" }> = [];
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
            request_id: frame.request_id,
            delivery: { ...work, state: "running", updated_at: Date.now() },
          });
        } else {
          // Drop the connection before an authoritative terminal delivery_state can echo the update.
          sock.close();
        }
      }
    });

    const runner: ServeRunner = async () => { runnerCalls += 1; };
    runner.onDeliveryTerminal = (terminal, state) => {
      terminals.push({ id: terminal.id, state });
    };
    const code = await runServe(opts({
      server: server.url,
      out: (line) => lines.push(line),
      runCommand: runner,
    }));

    expect(code).toBe(EXIT_STREAM_ENDED);
    expect(runnerCalls).toBe(1);
    expect(updateCalls).toBe(2);
    expect(terminals).toEqual([]);
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
