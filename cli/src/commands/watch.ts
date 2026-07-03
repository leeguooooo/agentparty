// party watch — 补拉错过消息，阻塞等新消息
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_LOOP_GUARD, EXIT_TIMEOUT } from "@agentparty/shared";
import { num, parseArgs } from "../args";
import { connect } from "../client";
import { loadCursor, readConfig, resolveChannel, saveCursor } from "../config";
import { formatMsg } from "../format";

export interface WatchOptions {
  server: string;
  token: string;
  channel: string;
  since: number;
  timeoutSec: number;
  follow: boolean;
  mentionsOnly: boolean;
  onCursor?: (cursor: number) => void;
  out?: (line: string) => void;
  backoffBaseMs?: number;
}

export async function runWatch(o: WatchOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.log(line));
  const conn = connect(o.server, o.token, o.channel, o.since, {
    onCursor: o.onCursor,
    backoffBaseMs: o.backoffBaseMs,
  });

  let self = "";
  let lastSeq = 0;
  let printed = 0;
  let timedOut = false;
  let code = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (o.timeoutSec > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      conn.close();
    }, o.timeoutSec * 1000);
  }

  try {
    for await (const frame of conn.frames) {
      if (frame.type === "welcome") {
        self = frame.self;
        lastSeq = frame.last_seq;
        continue;
      }
      if (frame.type === "error") {
        console.error(`error: ${frame.code} ${frame.message}`);
        if (frame.code === "unauthorized") code = EXIT_AUTH;
        else if (frame.code === "loop_guard") code = EXIT_LOOP_GUARD;
        else if (frame.code === "archived") code = EXIT_ARCHIVED;
        else code = 1;
        break;
      }
      if (frame.type !== "msg") continue;
      const fromSelf = frame.sender.name === self;
      const qualifies = !fromSelf && (!o.mentionsOnly || frame.mentions.includes(self));
      if (qualifies) {
        out(formatMsg(frame));
        printed++;
      }
      // 打印（或有意跳过）之后才推进游标，退出时入队未消费的消息留给下次补拉
      conn.ack(frame.seq);
      // 补拉排空（seq 追平 welcome.last_seq）且已有输出即视为收到新消息；自己的消息也参与排空判定
      if (!o.follow && printed > 0 && frame.seq >= lastSeq) break;
    }
  } finally {
    if (timer) clearTimeout(timer);
    conn.close();
  }

  if (timedOut && (o.follow || printed === 0)) {
    out("TIMEOUT");
    return EXIT_TIMEOUT;
  }
  return code;
}

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { booleans: ["follow", "mentions-only"] });
  const cfg = readConfig();
  if (!cfg) {
    console.error("no config, run: party init --server URL --token T");
    return 1;
  }
  const channel = resolveChannel(positionals[0]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  return runWatch({
    server: cfg.server,
    token: cfg.token,
    channel,
    since: loadCursor(channel),
    timeoutSec: num(flags.timeout) ?? 240,
    follow: flags.follow === true,
    mentionsOnly: flags["mentions-only"] === true,
    onCursor: (c) => saveCursor(channel, c),
  });
}
