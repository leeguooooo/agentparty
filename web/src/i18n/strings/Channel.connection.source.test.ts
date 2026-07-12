// @ts-nocheck -- Bun executes this source regression guard outside web tsconfig.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChannelStrings } from "./Channel";

describe("Channel connection notice (#353)", () => {
  test("renders localized reconnecting and closed notices beside the composer", () => {
    const source = readFileSync(resolve(import.meta.dir, "../../pages/Channel.tsx"), "utf8");

    expect(source).toContain('state.status === "reconnecting" || state.status === "closed"');
    expect(source).toContain('t("Channel.conn.reconnecting")');
    expect(source).toContain('t("Channel.conn.closed")');
    expect(ChannelStrings.en["Channel.conn.reconnecting"]).toContain("sending is paused");
    expect(ChannelStrings.zh["Channel.conn.reconnecting"]).toContain("发送已暂停");
    expect(ChannelStrings.en["Channel.conn.closed"]).toContain("sending is paused");
    expect(ChannelStrings.zh["Channel.conn.closed"]).toContain("发送已暂停");
  });
});
