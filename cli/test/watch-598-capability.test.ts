// #598：`party watch <slug> --once`（不带 --mentions-only）也必须声明 directed_delivery v1——
// 债务回调齐备的 --once watcher 就是 actionable adapter；把 mentionsOnly 留在 capability 条件里，
// 会让存在 pending durable delivery 的身份被服务端 upgrade_required 硬闭，而 latest CLI 明明接得住。
import { afterEach, describe, expect, test } from "bun:test";
import { EXIT_ARCHIVED } from "@agentparty/shared";
import { runWatch, type WatchOptions } from "../src/commands/watch";
import { startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function baseOpts(over: Partial<WatchOptions> & Pick<WatchOptions, "server">): WatchOptions {
  return {
    token: "ap_test",
    channel: "dev",
    since: 0,
    timeoutSec: 2,
    follow: false,
    once: true,
    mentionsOnly: false,
    allowMultiple: true,
    backoffBaseMs: 20,
    onStuck: () => true,
    onDirectedAccepted: () => true,
    out: () => {},
    ...over,
  };
}

async function helloOf(over: Partial<WatchOptions>): Promise<Record<string, unknown> | null> {
  let hello: Record<string, unknown> | null = null;
  server = startMockServer((frame, sock) => {
    if (frame.type !== "hello") return;
    hello = frame as unknown as Record<string, unknown>;
    sock.send(welcomeFrame(0, "me"));
    setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 20);
  });
  const code = await runWatch(baseOpts({ server: server.url, ...over }));
  expect(code).toBe(EXIT_ARCHIVED);
  return hello;
}

describe("watch directed_delivery capability（#598）", () => {
  test("--once 不带 --mentions-only：hello 仍声明 v1", async () => {
    const hello = await helloOf({ mentionsOnly: false });
    expect(hello).not.toBeNull();
    expect(hello!.directed_delivery).toBe("v1");
  });

  test("--once + --mentions-only：v1 照常（原行为不回归）", async () => {
    const hello = await helloOf({ mentionsOnly: true });
    expect(hello!.directed_delivery).toBe("v1");
  });

  test("--follow 观察者仍不声明（observers deliberately omit）", async () => {
    const hello = await helloOf({ follow: true, once: false, timeoutSec: 1 });
    expect(hello!.directed_delivery).toBeUndefined();
  });

  test("缺债务回调的 --once 不声明（不能 ack 的 adapter 不许骗服务端）", async () => {
    const hello = await helloOf({ onStuck: undefined, onDirectedAccepted: undefined });
    expect(hello!.directed_delivery).toBeUndefined();
  });
});
