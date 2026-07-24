// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agentparty/shared";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AuthError, ForbiddenError, type AuthoritativePendingDecision } from "./api";
import {
  frameMayChangePendingDecisions,
  useAuthoritativePendingDecisions,
} from "./pendingDecisions";

function frame(value: unknown): ServerFrame {
  return value as ServerFrame;
}

const scheduler = { every: () => () => {} };
let renderer: ReactTestRenderer | null = null;
let latest: ReturnType<typeof useAuthoritativePendingDecisions> | null = null;

function HookHarness({
  load,
  onAuthError,
}: {
  load: (token: string, slug: string) => Promise<AuthoritativePendingDecision[]>;
  onAuthError: () => void;
}) {
  latest = useAuthoritativePendingDecisions({
    token: "token",
    slug: "channel",
    load,
    onAuthError,
    scheduler,
  });
  return null;
}

async function renderHook(
  load: (token: string, slug: string) => Promise<AuthoritativePendingDecision[]>,
  onAuthError = () => {},
) {
  await act(async () => {
    renderer = create(createElement(HookHarness, { load, onAuthError }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  if (renderer !== null) act(() => renderer!.unmount());
  renderer = null;
  latest = null;
});

describe("frameMayChangePendingDecisions", () => {
  test("refreshes for decision creation, resolution, and retraction", () => {
    expect(frameMayChangePendingDecisions(frame({
      type: "msg",
      seq: 1,
      decision_request: { kind: "approval", prompt: "ship?", options: ["approve", "reject"] },
    }))).toBe(true);
    expect(frameMayChangePendingDecisions(frame({
      type: "message_update",
      action: "decision",
      message: { seq: 1 },
    }))).toBe(true);
    expect(frameMayChangePendingDecisions(frame({
      type: "message_update",
      action: "retract",
      message: { seq: 1 },
    }))).toBe(true);
  });

  test("ignores frames unrelated to decisions", () => {
    expect(frameMayChangePendingDecisions(frame({ type: "msg", seq: 2, body: "ordinary" }))).toBe(false);
    expect(frameMayChangePendingDecisions(frame({ type: "presence", entries: [] }))).toBe(false);
  });
});

describe("useAuthoritativePendingDecisions", () => {
  const oldData: AuthoritativePendingDecision[] = [{
    seq: 7,
    prompt: "ship?",
    asker: "alice",
    waitingOnMe: true,
  }];

  test("keeps the last successful data and exposes a refresh failure", async () => {
    let shouldFail = false;
    await renderHook(async () => {
      if (shouldFail) throw new Error("offline");
      return oldData;
    });

    expect(latest?.lastSuccessfulData).toEqual(oldData);
    expect(latest?.error).toBeNull();
    shouldFail = true;
    await act(async () => {
      await latest!.refresh();
    });

    expect(latest?.lastSuccessfulData).toEqual(oldData);
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toEqual({ kind: "load_failed" });
  });

  test("represents a first failure as unknown data instead of an empty list", async () => {
    await renderHook(async () => {
      throw new Error("offline");
    });

    expect(latest?.lastSuccessfulData).toBeNull();
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toEqual({ kind: "load_failed" });
  });

  test("clears the error and replaces data after a retry succeeds", async () => {
    let attempt = 0;
    const recovered: AuthoritativePendingDecision[] = [{
      seq: 12,
      prompt: "approve?",
      asker: "bob",
      waitingOnMe: false,
    }];
    await renderHook(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("offline");
      return recovered;
    });

    expect(latest?.error).toEqual({ kind: "load_failed" });
    await act(async () => {
      await latest!.refresh();
    });

    expect(latest?.lastSuccessfulData).toEqual(recovered);
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
  });

  test("drops stale decision prompts when channel permission is revoked", async () => {
    let forbidden = false;
    await renderHook(async () => {
      if (forbidden) throw new ForbiddenError("forbidden");
      return oldData;
    });

    expect(latest?.lastSuccessfulData).toEqual(oldData);
    forbidden = true;
    await act(async () => {
      await latest!.refresh();
    });

    expect(latest?.lastSuccessfulData).toBeNull();
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toEqual({ kind: "forbidden" });
  });

  test("continues to delegate authentication failures to the channel auth handler", async () => {
    let authFailures = 0;
    await renderHook(
      async () => { throw new AuthError("revoked"); },
      () => { authFailures += 1; },
    );

    expect(authFailures).toBe(1);
    expect(latest?.lastSuccessfulData).toBeNull();
    expect(latest?.error).toBeNull();
    expect(latest?.loading).toBe(false);
  });
});
