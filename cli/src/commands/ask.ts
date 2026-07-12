// party ask — send + watch 语法糖，agent 主循环用
import { EXIT_TIMEOUT } from "@agentparty/shared";
import { parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { loadCursor, loadRevCursor, saveCursor, saveRevCursor } from "../config";
import { resolveAuth } from "../oidc-cli";
import { busyTimeoutHint } from "../reach";
import { fetchPresence } from "../rest";
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
  const code = await runWatch({
    server: cfg.server,
    token: cfg.token,
    channel: input.channel,
    since,
    sinceRev: loadRevCursor(input.channel),
    timeoutSec: timeoutSec ?? 240,
    follow: false,
    mentionsOnly: parsed.flags["mentions-only"] === true,
    onCursor: (c) => saveCursor(input.channel, c),
    onRevCursor: (r) => saveRevCursor(input.channel, r),
    statusline: true,
  });
  // 超时富提示（#103）：runWatch 已吐裸 TIMEOUT 到 stdout，看不出对方是「忙」还是「失联」。
  // 若被 @ 的目标此刻仍标 busy（serve 正串行处理），在 stderr 补一行——别把超时误判成掉线反复 @。
  // 锦上添花：presence 拉取失败不改变退出码，保持原 TIMEOUT 行为。
  if (code === EXIT_TIMEOUT && input.mentions.length > 0) {
    try {
      const presence = await fetchPresence(cfg.server, cfg.token, input.channel);
      const hint = busyTimeoutHint(input.mentions, presence, Date.now());
      if (hint !== null) console.error(hint);
    } catch {
      /* presence 不可达：静默，裸 TIMEOUT 已足够 */
    }
  }
  return code;
}
