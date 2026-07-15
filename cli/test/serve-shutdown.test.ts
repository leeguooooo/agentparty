import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_SIGNAL_TERM, runServe, ServeShutdownError, WakeBlockedError } from "../src/commands/serve";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

const dirs: string[] = [];
const servers: MockServer[] = [];
type TrackedProcess = {
  kill(signal?: NodeJS.Signals | number): void;
  exited: Promise<number>;
};
const processes: TrackedProcess[] = [];

function trackProcess<T extends TrackedProcess>(process: T): T {
  processes.push(process);
  return process;
}

async function stopProcess(process: TrackedProcess): Promise<void> {
  try { process.kill("SIGTERM"); } catch { /* already exited */ }
  const stopped = await Promise.race([
    process.exited.then(() => true),
    Bun.sleep(100).then(() => false),
  ]);
  if (!stopped) {
    try { process.kill("SIGKILL"); } catch { /* already exited */ }
  }
  await process.exited.catch(() => undefined);
}

afterEach(async () => {
  for (const process of processes.splice(0)) await stopProcess(process);
  for (const server of servers.splice(0)) server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

describe("serve process shutdown barrier", () => {
  test("an inherited abort interrupts the initial charter fetch and still releases serve resources", async () => {
    const controller = new AbortController();
    const lockDir = mkdtempSync(join(tmpdir(), "ap-charter-abort-lock-"));
    dirs.push(lockDir);
    const server = startMockServer(() => {});
    servers.push(server);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const running = runServe({
      server: server.url,
      token: "ap_test",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      lockDir,
      signal: controller.signal,
      out: () => {},
      fetchCharter: async (signal) => {
        receivedSignal = signal;
        markStarted();
        return await new Promise<never>(() => {});
      },
    });
    await started;

    controller.abort(new ServeShutdownError("SIGTERM"));
    expect(await running).toBe(EXIT_SIGNAL_TERM);
    expect(receivedSignal?.aborted).toBe(true);
    expect(existsSync(join(lockDir, "serve-dev.lock"))).toBe(false);
  });

  test("an inherited abort interrupts a stuck welcome advertisement", async () => {
    const controller = new AbortController();
    const lockDir = mkdtempSync(join(tmpdir(), "ap-advertise-abort-lock-"));
    dirs.push(lockDir);
    const server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0, "me"));
    });
    servers.push(server);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const running = runServe({
      server: server.url,
      token: "ap_test",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      lockDir,
      signal: controller.signal,
      out: () => {},
      advertise: async (signal) => {
        receivedSignal = signal;
        markStarted();
        return await new Promise<never>(() => {});
      },
    });
    await started;

    controller.abort(new ServeShutdownError("SIGTERM"));
    expect(await running).toBe(EXIT_SIGNAL_TERM);
    expect(receivedSignal?.aborted).toBe(true);
    expect(existsSync(join(lockDir, "serve-dev.lock"))).toBe(false);
  });

  test("an inherited abort interrupts the durable running ACK before the runner starts", async () => {
    const controller = new AbortController();
    const lockDir = mkdtempSync(join(tmpdir(), "ap-delivery-ack-abort-lock-"));
    dirs.push(lockDir);
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send({ ...welcomeFrame(0, "me"), directed_delivery: "v1" });
      } else if (frame.type === "serve_lease") {
        sock.send({ type: "serve_lease", name: "me", held: true });
        sock.send({
          type: "delivery",
          delivery: {
            id: "delivery-shutdown",
            message_seq: 1,
            target_name: "me",
            cause: "mention",
            state: "claimed",
            attempt: 1,
            lease_until: Date.now() + 60_000,
            work_id: "work-shutdown",
            continuation_ref: "ref-shutdown",
            reply_seq: null,
            last_error: null,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
          message: msgFrame(1, "must not start", { mentions: ["me"] }),
        });
      } else if (frame.type === "delivery_update" && frame.state === "running") {
        markWaiting();
        // Deliberately never ACK: shutdown must cancel the wait instead of burning the 5s timeout.
      }
    });
    servers.push(server);
    let runnerCalls = 0;
    const running = runServe({
      server: server.url,
      token: "ap_test",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      lockDir,
      signal: controller.signal,
      advertise: async () => {},
      post: async () => ({ seq: 99 }),
      runCommand: async () => { runnerCalls += 1; },
      out: () => {},
    });
    await waiting;

    controller.abort(new ServeShutdownError("SIGTERM"));
    expect(await Promise.race([running, Bun.sleep(500).then(() => -999)])).toBe(EXIT_SIGNAL_TERM);
    expect(runnerCalls).toBe(0);
    expect(existsSync(join(lockDir, "serve-dev.lock"))).toBe(false);
  });

  test("an inherited abort interrupts a long runner retry delay", async () => {
    const controller = new AbortController();
    const lockDir = mkdtempSync(join(tmpdir(), "ap-retry-abort-lock-"));
    dirs.push(lockDir);
    const server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "retry later", { mentions: ["me"] })), 10);
    });
    servers.push(server);
    let markRetrying!: () => void;
    const retrying = new Promise<void>((resolve) => { markRetrying = resolve; });
    const running = runServe({
      server: server.url,
      token: "ap_test",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      lockDir,
      signal: controller.signal,
      advertise: async () => {},
      post: async () => ({ seq: 99 }),
      runCommand: async () => { throw new WakeBlockedError("retry later", true); },
      maxWakeAttempts: 3,
      wakeRetryDelayMs: 60_000,
      onStuck: (stuck) => { if (stuck !== null) markRetrying(); },
      out: () => {},
    });
    await retrying;

    controller.abort(new ServeShutdownError("SIGTERM"));
    expect(await Promise.race([running, Bun.sleep(500).then(() => -999)])).toBe(EXIT_SIGNAL_TERM);
    expect(existsSync(join(lockDir, "serve-dev.lock"))).toBe(false);
  });

  test("an inherited abort reaches an in-flight control-plane status POST", async () => {
    const controller = new AbortController();
    const lockDir = mkdtempSync(join(tmpdir(), "ap-post-abort-lock-"));
    dirs.push(lockDir);
    const server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "fail once", { mentions: ["me"] })), 10);
    });
    servers.push(server);
    let postSignal: AbortSignal | undefined;
    let markPosting!: () => void;
    const posting = new Promise<void>((resolve) => { markPosting = resolve; });
    const running = runServe({
      server: server.url,
      token: "ap_test",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      lockDir,
      signal: controller.signal,
      advertise: async () => {},
      runCommand: async () => { throw new Error("runner failed"); },
      maxWakeAttempts: 1,
      post: async (_server, _token, _channel, payload, signal) => {
        if (!("state" in payload) || payload.state !== "blocked") return { seq: 99 };
        postSignal = signal;
        markPosting();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      out: () => {},
    });
    await posting;
    expect(postSignal).toBeDefined();
    expect(postSignal?.aborted).toBe(false);

    controller.abort(new ServeShutdownError("SIGTERM"));
    expect(await Promise.race([running, Bun.sleep(500).then(() => -999)])).toBe(EXIT_SIGNAL_TERM);
    expect(postSignal?.aborted).toBe(true);
    expect(existsSync(join(lockDir, "serve-dev.lock"))).toBe(false);
  });

  test("SIGINT reaps an ignoring child/grandchild tree before exit and never starts the next wake", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "ap-serve-shutdown-"));
    dirs.push(dir);
    const grandchildPidFile = join(dir, "grandchild.pid");
    const runsFile = join(dir, "runs.txt");
    const sockets: Array<{ send(frame: unknown): void }> = [];
    const server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sockets[0] = sock;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "first", { mentions: ["me"] })), 10);
    });
    servers.push(server);

    const serveModule = new URL("../src/commands/serve.ts", import.meta.url).pathname;
    const command =
      `echo "$AP_SEQ" >> ${JSON.stringify(runsFile)}; ` +
      `sh -c 'trap "" TERM INT; echo $$ > ${grandchildPidFile}; while :; do sleep 5; done'`;
    const script = `
      import { runServe } from ${JSON.stringify(serveModule)};
      const code = await runServe({
        server: ${JSON.stringify(server.url)}, token: "ap_test", channel: "dev", since: 0,
        cmd: ${JSON.stringify(command)}, mentionsOnly: true, allowMultiple: true,
        advertise: async () => {}, out: () => {},
      });
      process.exit(code);
    `;
    const serve = trackProcess(Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }));
    await waitForFile(grandchildPidFile);
    const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8").trim());

    serve.kill("SIGINT");
    sockets[0]?.send(msgFrame(2, "must never overlap", { mentions: ["me"] }));
    const code = await Promise.race([
      serve.exited,
      Bun.sleep(5_000).then(() => -999),
    ]);
    expect(code).toBe(130);

    let alive = true;
    for (let i = 0; i < 200 && alive; i++) {
      try {
        process.kill(grandchildPid, 0);
        await Bun.sleep(10);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    expect(readFileSync(runsFile, "utf8").trim().split(/\s+/)).toEqual(["1"]);
  }, 10_000);

  test("profile SIGTERM stops the outer invite poll and returns 143", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-profile-shutdown-"));
    dirs.push(dir);
    const readyFile = join(dir, "ready");
    const serveModule = new URL("../src/commands/serve.ts", import.meta.url).pathname;
    const script = `
      import { writeFileSync } from "node:fs";
      import { runProfileServe } from ${JSON.stringify(serveModule)};
      const profile = {
        owner_account: "owner@example.com", handle: "codex", name: "codex",
        runner: "codex", repo_url: null, workdir: null, base_branch: "main",
        worktree_strategy: "shared", rules: "", invitable_by: "anyone",
        created_at: 1, updated_at: 1,
      };
      const code = await runProfileServe({
        server: "http://agentparty.test", humanToken: "acc-test",
        ownerAccount: profile.owner_account, handle: profile.handle, mentionsOnly: true,
        mintRuntime: async () => ({ token: "ap_runtime", profile }),
        listInvites: async () => {
          writeFileSync(${JSON.stringify(readyFile)}, "ready");
          return [];
        },
        pollIntervalMs: 60_000,
        out: () => {},
      });
      process.exit(code);
    `;
    const profileServe = trackProcess(Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    }));
    await waitForFile(readyFile);

    profileServe.kill("SIGTERM");
    const code = await Promise.race([
      profileServe.exited,
      Bun.sleep(3_000).then(() => -999),
    ]);
    expect(code).toBe(143);
  }, 5_000);
});
