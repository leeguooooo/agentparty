import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

const dirs: string[] = [];
const servers: MockServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

describe("serve process shutdown barrier", () => {
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
    const serve = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
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
});
