// party invite --mode watch|participate（#186）：观看模式把接入包锚到 readonly token（发送禁用、只读围观），
// 参与模式锚到 agent token（全程参与，今日默认）。子进程级：真实 argv + mock REST，断言接入包内容。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let restServer: ReturnType<typeof Bun.serve> | null = null;
let minted: { name: string; role: string }[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-invite-"));
  minted = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restServer?.stop(true);
  restServer = null;
});

function startRest(): string {
  let counter = 0;
  restServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/tokens" && req.method === "POST") {
        const body = (await req.json()) as { name: string; role: string };
        minted.push({ name: body.name, role: body.role });
        // token 明文按角色可辨认，方便断言接入包引用了哪一个
        const token = `ap_${body.role === "readonly" ? "readonly" : "agenttok"}${(counter++).toString().padStart(24 - (body.role === "readonly" ? 8 : 8), "0")}`;
        return Response.json({ token, name: body.name, role: body.role, owner: "x", channel_scope: body.name }, { status: 201 });
      }
      if (url.pathname === "/api/channels" && req.method === "POST") {
        return Response.json({ ok: true }, { status: 201 });
      }
      if (url.pathname.endsWith("/charter") && req.method === "GET") {
        return Response.json({ error: { code: "not_found", message: "no charter" } }, { status: 404 });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${restServer.port}`;
}

async function runInvite(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, "invite", ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home, ADMIN_SECRET: "sekret" },
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

describe("party invite --mode", () => {
  test("watch mode anchors the join pack to a readonly token and disables sending", async () => {
    const server = startRest();
    const r = await runInvite(["Watch Room", "--slug", "watchroom", "--mode", "watch", "--server", server]);
    expect(r.code).toBe(0);
    // a readonly token was minted and it is the one the invitee inits with
    expect(minted.some((m) => m.role === "readonly")).toBe(true);
    // #676：token 走 AGENTPARTY_TOKEN 环境变量，不写进 argv——可拷贝命令里不得再有明文 `--token ap`
    expect(r.stdout).toMatch(/AGENTPARTY_TOKEN='ap_readonly\d*' party init --server .* --channel watchroom/);
    expect(r.stdout).not.toContain("--token ap_readonly");
    const watchGuardIndex = r.stdout.indexOf("AgentParty onboarding scope: join the existing channel #watchroom");
    expect(watchGuardIndex).toBeGreaterThan(-1);
    expect(watchGuardIndex).toBeLessThan(r.stdout.indexOf("party init "));
    // mode is stated in the pack
    expect(r.stdout).toContain("观看");
    // watch mode never tells the invitee to send a check-in (readonly can't send)
    expect(r.stdout).not.toMatch(/party send .*报到/);
    expect(r.stdout.toLowerCase()).toContain("watch");
  });

  test("participate mode (explicit) anchors to an agent token with full participation", async () => {
    const server = startRest();
    const r = await runInvite(["Part Room", "--slug", "partroom", "--mode", "participate", "--server", server]);
    expect(r.code).toBe(0);
    expect(minted.some((m) => m.role === "agent")).toBe(true);
    expect(r.stdout).toMatch(/AGENTPARTY_TOKEN='ap_agenttok\d*' party init --server .* --channel partroom/);
    expect(r.stdout).not.toContain("--token ap_agenttok");
    const participateGuardIndex = r.stdout.indexOf("AgentParty onboarding scope: join the existing channel #partroom");
    expect(participateGuardIndex).toBeGreaterThan(-1);
    expect(participateGuardIndex).toBeLessThan(r.stdout.indexOf("party init "));
    expect(r.stdout).toContain("参与");
    // participate keeps the check-in send line
    expect(r.stdout).toMatch(/party send .*报到/);
  });

  test("default mode is participate", async () => {
    const server = startRest();
    const r = await runInvite(["Def Room", "--slug", "defroom", "--server", server]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/AGENTPARTY_TOKEN='ap_agenttok\d*' party init --server .* --channel defroom/);
    expect(r.stdout).not.toContain("--token ap_agenttok");
    expect(r.stdout).toMatch(/party send .*报到/);
  });

  test("rejects an invalid --mode", async () => {
    const server = startRest();
    const r = await runInvite(["Bad", "--slug", "bad", "--mode", "lurk", "--server", server]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("mode");
  });
});
