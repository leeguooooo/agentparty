// party ask — send + watch 语法糖，agent 主循环用
import { parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { loadCursor, saveCursor } from "../config";
import { resolveAuth } from "../oidc-cli";
import { MAX_TIMEOUT_SEC, parsePositiveIntFlag } from "../validation";
import { doSend, resolveSendInput, sendSpec } from "./send";
import { runWatch } from "./watch";

const ASK_FLAGS = ["channel", "reply-to", "mention", "timeout", "mentions-only"];

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    ...sendSpec,
    booleans: ["mentions-only"],
  });
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(parsed.flags, ASK_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const timeoutFlagError = valueFlagError(parsed.flags, ["timeout"]);
  if (timeoutFlagError !== null) {
    console.error(timeoutFlagError);
    return 1;
  }
  const timeoutSec = parsePositiveIntFlag(str(parsed.flags.timeout), "timeout", MAX_TIMEOUT_SEC);
  if (typeof timeoutSec === "string") {
    console.error(timeoutSec);
    return 1;
  }
  const input = await resolveSendInput(parsed);
  if (!input) return 1;
  const result = await doSend(cfg, input);
  if (typeof result === "number") return result;

  // 游标从自己刚发的 seq 起，自己的消息不会被当成回复
  const since = Math.max(result.seq, loadCursor(input.channel));
  return runWatch({
    server: cfg.server,
    token: cfg.token,
    channel: input.channel,
    since,
    timeoutSec: timeoutSec ?? 240,
    follow: false,
    mentionsOnly: parsed.flags["mentions-only"] === true,
    onCursor: (c) => saveCursor(input.channel, c),
  });
}
