import { describe, expect, test } from "bun:test";
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_STREAM_ENDED } from "@agentparty/shared";
import {
  EXIT_SIGNAL_INT,
  EXIT_SIGNAL_TERM,
  EXIT_WAKE_ABANDON_CIRCUIT,
  runServe,
  superviseServe,
  verifyServeIdentityBoundary,
  type ServeIdentityBoundaryState,
} from "../src/commands/serve";
import type { ResolvedAuthDetailed } from "../src/oidc-cli";
import { RestError } from "../src/rest";
import { msgFrame, startMockServer, welcomeFrame } from "./mock-server";

function auth(
  source: ResolvedAuthDetailed["auth_source"],
  token = "ap_test",
): ResolvedAuthDetailed {
  return {
    server: "https://agentparty.test",
    token,
    auth_source: source,
    config: { kind: source === "runtime_config" ? "workspace" : "none", path: null },
    account: { present: source === "account_session", path: "" },
  };
}

const identity = {
  name: "me",
  email: null,
  kind: "agent",
  role: "agent",
  owner: null,
};

const ownedIdentity = {
  ...identity,
  owner: "owner@example.com",
};

describe("serve lifecycle supervisor (#550)", () => {
  test("restarts transient exits with bounded exponential backoff", async () => {
    const codes = [EXIT_STREAM_ENDED, 1, 0];
    const sleeps: number[] = [];
    const lifecycle: string[] = [];

    const code = await superviseServe({
      runOnce: async () => codes.shift()!,
      baseDelayMs: 10,
      maxDelayMs: 15,
      sleep: async (ms) => { sleeps.push(ms); },
      onLifecycle: (line) => lifecycle.push(line),
    });

    expect(code).toBe(0);
    expect(sleeps).toEqual([10, 15]);
    expect(lifecycle).toContain(`event=restart next_attempt=2 delay_ms=10 previous_code=${EXIT_STREAM_ENDED}`);
    expect(lifecycle).toContain("event=restart next_attempt=3 delay_ms=15 previous_code=1");
  });

  test("stops terminally when the wake-abandon circuit trips", async () => {
    let calls = 0;
    const code = await superviseServe({
      runOnce: async () => {
        calls += 1;
        return EXIT_WAKE_ABANDON_CIRCUIT;
      },
      sleep: async () => { throw new Error("must not sleep"); },
    });

    expect(code).toBe(EXIT_WAKE_ABANDON_CIRCUIT);
    expect(calls).toBe(1);
  });

  test("SIGINT and SIGTERM exits are terminal and never restart the serve", async () => {
    for (const signalExit of [EXIT_SIGNAL_INT, EXIT_SIGNAL_TERM]) {
      let calls = 0;
      const sleeps: number[] = [];
      const code = await superviseServe({
        runOnce: async () => {
          calls += 1;
          return signalExit;
        },
        sleep: async (ms) => { sleeps.push(ms); },
      });

      expect(code).toBe(signalExit);
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  test("does not hammer a terminal auth failure", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const code = await superviseServe({
      runOnce: async () => {
        calls += 1;
        return EXIT_AUTH;
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(code).toBe(EXIT_AUTH);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("turns thrown transient failures into a logged restart", async () => {
    let calls = 0;
    const lifecycle: string[] = [];
    const code = await superviseServe({
      runOnce: async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket factory exploded");
        return 0;
      },
      baseDelayMs: 0,
      sleep: async () => {},
      onLifecycle: (line) => lifecycle.push(line),
    });

    expect(code).toBe(0);
    expect(calls).toBe(2);
    expect(lifecycle.some((line) => line.includes('code=1 error="socket factory exploded"'))).toBe(true);
  });

  test("keeps supervising when lifecycle logging throws", async () => {
    let calls = 0;
    const code = await superviseServe({
      runOnce: async () => (++calls === 1 ? EXIT_STREAM_ENDED : 0),
      baseDelayMs: 0,
      sleep: async () => {},
      onLifecycle: () => { throw new Error("ENOSPC"); },
    });

    expect(code).toBe(0);
    expect(calls).toBe(2);
  });

  test("an internal restart replays mentions that arrived after the first attach instead of classifying them as backlog", async () => {
    const server = startMockServer((frame, sock, connection) => {
      if (frame.type !== "hello") return;
      if (connection === 0) {
        sock.send(welcomeFrame(0, "me"));
        sock.send({ type: "error", code: "bad_request", message: "transient worker reset" });
        return;
      }
      sock.send(welcomeFrame(1, "me"));
      sock.send(msgFrame(1, "arrived during restart", { mentions: ["me"] }));
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 20);
    });
    const seen: number[] = [];
    let cursor = 0;
    let firstAttach = true;
    const policies: boolean[] = [];
    try {
      const code = await superviseServe({
        baseDelayMs: 0,
        sleep: async () => {},
        runOnce: () => {
          policies.push(firstAttach);
          return runServe({
            server: server.url,
            token: "ap_test",
            channel: "dev",
            since: cursor,
            cmd: "",
            mentionsOnly: true,
            skipBacklog: firstAttach,
            onWelcome: () => { firstAttach = false; },
            allowMultiple: true,
            advertise: async () => {},
            post: async () => ({ seq: 99 }),
            onCursor: (next) => { cursor = next; },
            runCommand: async (message) => { seen.push(message.seq); },
          });
        },
      });

      expect(code).toBe(EXIT_ARCHIVED);
      expect(seen).toEqual([1]);
      expect(cursor).toBe(1);
      expect(policies).toEqual([true, false]);
      expect(server.hellos).toEqual([0, 0]);
    } finally {
      server.stop();
    }
  });

  test("a pre-welcome failure keeps the initial skip-backlog policy on the retry", async () => {
    const server = startMockServer((frame, sock, connection) => {
      if (frame.type !== "hello") return;
      if (connection === 0) {
        sock.send({ type: "error", code: "bad_request", message: "failed before welcome" });
        return;
      }
      sock.send(welcomeFrame(1, "me"));
      sock.send(msgFrame(1, "offline backlog", { mentions: ["me"] }));
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 20);
    });
    let firstAttach = true;
    const policies: boolean[] = [];
    const seen: number[] = [];
    try {
      const code = await superviseServe({
        baseDelayMs: 0,
        sleep: async () => {},
        runOnce: () => {
          policies.push(firstAttach);
          return runServe({
            server: server.url,
            token: "ap_test",
            channel: "dev",
            since: 0,
            cmd: "",
            mentionsOnly: true,
            skipBacklog: firstAttach,
            onWelcome: () => { firstAttach = false; },
            allowMultiple: true,
            advertise: async () => {},
            post: async () => ({ seq: 99 }),
            runCommand: async (message) => { seen.push(message.seq); },
          });
        },
      });

      expect(code).toBe(EXIT_ARCHIVED);
      expect(policies).toEqual([true, true]);
      expect(seen).toEqual([]);
    } finally {
      server.stop();
    }
  });
});

describe("serve auth boundary (#550)", () => {
  test("/api/me 401/403 is terminal for static and account credentials", async () => {
    for (const source of ["runtime_config", "account_session"] as const) {
      for (const status of [401, 403]) {
        const state: ServeIdentityBoundaryState = { expectedPrincipal: null, rejectedAccountToken: null };
        const result = await verifyServeIdentityBoundary(
          "https://agentparty.test",
          auth(source),
          state,
          async () => { throw new RestError(status, "unauthorized", "revoked"); },
        );
        expect(result).toEqual({
          ok: false,
          code: EXIT_AUTH,
          reason: `serve authentication rejected by /api/me (${status})`,
        });
      }
    }
  });

  test("a repeated rejected account token exits before another /api/me request", async () => {
    let fetches = 0;
    const state: ServeIdentityBoundaryState = {
      expectedPrincipal: null,
      rejectedAccountToken: "same-token",
    };
    const result = await verifyServeIdentityBoundary(
      "https://agentparty.test",
      auth("account_session", "same-token"),
      state,
      async () => {
        fetches += 1;
        return identity;
      },
    );

    expect(result.ok).toBe(false);
    expect(fetches).toBe(0);
  });

  test("a rotated account token may cross the same principal boundary and clears the rejection", async () => {
    const state: ServeIdentityBoundaryState = {
      expectedPrincipal: JSON.stringify([
        "https://agentparty.test",
        ownedIdentity.name,
        ownedIdentity.kind,
        ownedIdentity.owner,
      ]),
      rejectedAccountToken: "old-token",
    };
    const result = await verifyServeIdentityBoundary(
      "https://agentparty.test",
      auth("account_session", "new-token"),
      state,
      async () => ownedIdentity,
    );

    expect(result).toMatchObject({
      ok: true,
      principal: {
        server_origin: "https://agentparty.test",
        name: "me",
        kind: "agent",
        owner: "owner@example.com",
      },
    });
    if (result.ok) expect(result.namespace).toMatch(/^[a-f0-9]{64}$/);
    expect(state.rejectedAccountToken).toBeNull();
  });

  test("namespace isolates same-named agents across servers and is stable across token rotation", async () => {
    const first = await verifyServeIdentityBoundary(
      "https://prod.agentparty.test/path",
      { ...auth("runtime_config", "token-a"), server: "https://prod.agentparty.test/other" },
      { expectedPrincipal: null, rejectedAccountToken: null },
      async () => ownedIdentity,
    );
    const rotated = await verifyServeIdentityBoundary(
      "https://prod.agentparty.test",
      { ...auth("runtime_config", "token-b"), server: "https://prod.agentparty.test" },
      { expectedPrincipal: null, rejectedAccountToken: null },
      async () => ownedIdentity,
    );
    const testServer = await verifyServeIdentityBoundary(
      "https://test.agentparty.test",
      { ...auth("runtime_config", "token-a"), server: "https://test.agentparty.test" },
      { expectedPrincipal: null, rejectedAccountToken: null },
      async () => ownedIdentity,
    );
    expect(first.ok && rotated.ok && first.namespace === rotated.namespace).toBe(true);
    expect(first.ok && testServer.ok && first.namespace !== testServer.namespace).toBe(true);
  });

  test("same-named legacy tokens use token-sha256 principals and cannot reuse each other's namespace", async () => {
    const firstState: ServeIdentityBoundaryState = {
      expectedPrincipal: null,
      rejectedAccountToken: null,
    };
    const first = await verifyServeIdentityBoundary(
      "https://agentparty.test",
      auth("runtime_config", "legacy-token-a"),
      firstState,
      async () => identity,
    );
    const second = await verifyServeIdentityBoundary(
      "https://agentparty.test",
      auth("runtime_config", "legacy-token-b"),
      { expectedPrincipal: null, rejectedAccountToken: null },
      async () => identity,
    );
    const crossedBoundary = await verifyServeIdentityBoundary(
      "https://agentparty.test",
      auth("runtime_config", "legacy-token-b"),
      firstState,
      async () => identity,
    );

    expect(first.ok && second.ok && first.namespace !== second.namespace).toBe(true);
    expect(crossedBoundary).toMatchObject({ ok: false, code: EXIT_AUTH });
    expect(firstState.expectedPrincipal).toContain("token-sha256:");
    expect(firstState.expectedPrincipal).not.toContain("legacy-token-a");
  });
});
