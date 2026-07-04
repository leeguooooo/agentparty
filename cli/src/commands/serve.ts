// party serve — 常驻监听频道，每条 @你 的消息触发一次本地命令，把「跑完就停的 session agent」
// 用外部 supervisor 唤醒（wake GOAL 的 session 型那半；有入站 URL 的 runtime 走 webhook）。
// 复用 client.connect 的自动重连帧流，真正常驻；命令串行执行（一条处理完再下一条，不并发抢跑）。
import { EXIT_ARCHIVED, EXIT_AUTH, type MsgFrame } from "@agentparty/shared";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { connect } from "../client";
import { loadCursor, resolveChannel, saveCursor } from "../config";
import { formatMsg } from "../format";
import { resolveAuth } from "../oidc-cli";
import { isSlug } from "../validation";

const PROTOCOL_REMINDER =
  "被 @ 唤起：需要产出结论时，先用 `party send --reply-to <seq>` 把 final synthesis 发回频道，再 status done；别只回本地。";

// 把一条 @mention 的完整上下文落成 JSON 文件，命令拿路径读——避开 env/stdin 的 shell quoting/注入，
// 也让 runner 能一次拿全 channel/seq/sender/body/reply_to/protocol_reminder（评审建议）。
function writeContextFile(frame: MsgFrame, channel: string, self: string): string {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  const path = join(tmpdir(), `agentparty-serve-${channel}-${frame.seq}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        channel,
        seq: frame.seq,
        sender: frame.sender.name,
        owner: frame.sender.owner ?? null,
        kind: frame.kind,
        body,
        mentions: frame.mentions,
        reply_to: frame.seq, // 回这条就 --reply-to 它
        self,
        protocol_reminder: PROTOCOL_REMINDER,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return path;
}

const SERVE_FLAGS = ["channel", "on-mention", "all"];
const HELP = `usage: party serve [channel|--channel C] --on-mention "<cmd>" [--all]

Stay attached to a channel and run one local command for each matching message.
The command can read the context JSON path from {file} or AP_CONTEXT_FILE.

Options:
  --channel C          serve channel C instead of the bound channel
  --on-mention "<cmd>" command to run for each wake
  --all                run for every non-self message, not only @mentions`;

export interface ServeOptions {
  server: string;
  token: string;
  channel: string;
  since: number;
  cmd: string;
  mentionsOnly: boolean;
  onCursor?: (cursor: number) => void;
  // 测试注入点：默认用 sh -c 起子进程
  runCommand?: (frame: MsgFrame, ctx: { cmd: string; channel: string; self: string }) => Promise<void>;
  out?: (line: string) => void;
}

// 默认执行器：把上下文写成 context file → sh -c <cmd>（cmd 里的 {file} 替成路径，也放进 AP_CONTEXT_FILE）。
// 正文仍走 stdin + AP_* env 图省事；context file 是给需要稳健取全量的 runner 用。串行等它退出。
// 非零退出：打印 exit code + context file 路径（便于排查），并保留文件；成功则清理。
async function defaultRun(
  frame: MsgFrame,
  ctx: { cmd: string; channel: string; self: string },
): Promise<void> {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  const file = writeContextFile(frame, ctx.channel, ctx.self);
  const cmd = ctx.cmd.includes("{file}") ? ctx.cmd.replaceAll("{file}", file) : ctx.cmd;
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdin: new TextEncoder().encode(body),
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      AP_CONTEXT_FILE: file,
      AP_CHANNEL: ctx.channel,
      AP_SEQ: String(frame.seq),
      AP_SENDER: frame.sender.name,
      AP_OWNER: frame.sender.owner ?? "",
      AP_BODY: body,
      AP_MENTIONS: frame.mentions.join(","),
      AP_SELF: ctx.self,
      AP_REPLY_TO: String(frame.seq),
    },
  });
  const code = await proc.exited;
  if (code !== 0) {
    // 保留 context file 供排查，抛错让 runServe 打印（不发频道）
    throw new Error(`command exited ${code} (context: ${file})`);
  }
  try {
    unlinkSync(file);
  } catch {
    /* 清理失败无所谓 */
  }
}

export async function runServe(o: ServeOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.error(line));
  const run = o.runCommand ?? defaultRun;
  const conn = connect(o.server, o.token, o.channel, o.since, { onCursor: o.onCursor });

  let self = "";
  let code = 0;
  out(
    `serving #${o.channel} — 每条${o.mentionsOnly ? " @你 的" : ""}消息触发一次命令（Ctrl-C 停）`,
  );
  try {
    for await (const frame of conn.frames) {
      if (frame.type === "welcome") {
        self = frame.self;
        continue;
      }
      if (frame.type === "error") {
        console.error(`error: ${frame.code} ${frame.message}`);
        code =
          frame.code === "unauthorized"
            ? EXIT_AUTH
            : frame.code === "archived"
              ? EXIT_ARCHIVED
              : 1;
        break;
      }
      if (frame.type !== "msg") continue;
      const fromSelf = frame.sender.name === self;
      const qualifies = !fromSelf && (!o.mentionsOnly || frame.mentions.includes(self));
      if (qualifies) {
        out(`▶ ${formatMsg(frame)}`);
        // 串行：本条命令跑完再消费下一帧（新帧此间缓冲在 FrameQueue），避免并发唤起互相抢
        try {
          await run(frame, { cmd: o.cmd, channel: o.channel, self });
        } catch (e) {
          out(`  命令失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // 处理（或跳过）后才推进游标，退出时未消费的留给下次补拉
      conn.ack(frame.seq);
    }
  } finally {
    conn.close();
  }
  return code;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["all"] });
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, SERVE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "on-mention"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cmd = str(flags["on-mention"]);
  if (!cmd) {
    console.error(
      'need --on-mention "<command>"：每条 @你 的消息跑一次。\n' +
        "  上下文：命令里的 {file} 替成 context JSON 路径（= AP_CONTEXT_FILE）；正文也在 stdin；元信息在 AP_*。",
    );
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  return runServe({
    server: cfg.server,
    token: cfg.token,
    channel,
    since: loadCursor(channel),
    cmd,
    mentionsOnly: flags.all !== true,
    onCursor: (c) => saveCursor(channel, c),
  });
}
