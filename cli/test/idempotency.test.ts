// #98：postMessage 必须给每次发送带一个唯一 idempotency_key。
// 断言过程（发出去的 body 里有键、每次调用键不同），不只看返回。
// 有了它，服务端盲重试（DO reset 后 clone 重发同一 body）携带同一键，才能被服务端去重。
import { describe, expect, test } from "bun:test";
import { postMessage } from "../src/rest";
import { startRestMock } from "./rest-mock";

describe("postMessage idempotency key (#98)", () => {
  test("attaches a non-empty idempotency_key, unique per call", async () => {
    const mock = startRestMock();
    try {
      await postMessage(mock.url, "ap_tok", "chan", { kind: "message", body: "hi", mentions: [], reply_to: null });
      await postMessage(mock.url, "ap_tok", "chan", { kind: "message", body: "hi", mentions: [], reply_to: null });

      const bodies = mock.requests
        .filter((r) => r.method === "POST" && r.path === "/api/channels/chan/messages")
        .map((r) => r.body as { idempotency_key?: unknown });

      expect(bodies).toHaveLength(2);
      expect(typeof bodies[0]!.idempotency_key).toBe("string");
      expect((bodies[0]!.idempotency_key as string).length).toBeGreaterThan(0);
      // 每次发送生成新键：不同逻辑消息不会互相误去重
      expect(bodies[0]!.idempotency_key).not.toBe(bodies[1]!.idempotency_key);
    } finally {
      mock.stop();
    }
  });
});
