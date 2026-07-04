// 子进程级冒烟：真实 argv 路由 + 退出码
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceId } from "../src/config";
import { startMockServer, welcomeFrame, type MockServer } from "./mock-server";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let server: MockServer | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  server?.stop();
  server = null;
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("cli subprocess", () => {
  test("--help exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("party <command>");
  });

  test("non-json subcommands support --help without auth or config", async () => {
    const commands = [
      "init",
      "send",
      "status",
      "channel",
      "invite",
      "webhook",
      "token",
      "login",
      "logout",
      "agent",
      "serve",
    ];
    for (const cmd of commands) {
      const r = await runCli([cmd, "--help"]);
      expect(r.code, cmd).toBe(0);
      expect(r.stdout, cmd).toContain(`usage: party ${cmd}`);
      expect(r.stderr, cmd).toBe("");
    }
  });

  test("--version 输出非空版本号并 exit 0", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("unknown command exits 1", async () => {
    const r = await runCli(["nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command");
  });

  test("watch without config exits 1", async () => {
    const r = await runCli(["watch", "dev", "--timeout", "1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no config");
  });

  test("watch timeout exits 2 and prints TIMEOUT", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    const r = await runCli(["watch", "dev", "--timeout", "1"]);
    expect(r.code).toBe(2);
    expect(r.stdout.trim()).toBe("TIMEOUT");
  }, 15_000);

  test("watch --channel 优先于绑定频道", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ channel: "dev", cursor: 0 }));

    const r = await runCli(["watch", "--channel", "ops", "--timeout", "1"]);
    expect(r.code).toBe(2);
    expect(server.paths).toContain("/api/channels/ops/ws");
    expect(server.paths).not.toContain("/api/channels/dev/ws");
  }, 15_000);

  test("watch --channel 缺值不会回退到绑定频道", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    const dir = join(home, "state", workspaceId(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ channel: "dev", cursor: 0 }));

    const r = await runCli(["watch", "--channel", "--timeout", "1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--channel requires a value");
    expect(server.paths).toHaveLength(0);
  });

  test("watch --timeout 必须是正整数，不会进入阻塞连接", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") sock.send(welcomeFrame(0));
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: server.url, token: "ap_tok" }),
    );
    for (const value of ["0", "-1", "1.5", "2147484"]) {
      const r = await runCli(["watch", "dev", "--timeout", value]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--timeout must be (a positive integer|<=)/);
    }
    expect(server.paths).toHaveLength(0);
  });
});
