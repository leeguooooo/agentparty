// party daemon — 实验性：内嵌 @anthropic-ai/claude-agent-sdk 的常驻 party runner（SPIKE，#672 Phase 1）。
//
// 动机（#672）：`party watch --once` 是单发子进程，harness 在 turn 边界把它回收即静默——presence 的
// 「可唤醒」本质是谎报，这是 #665/#664/#508/#29/#199 唤醒债风暴的共同根因。daemon 是一档**第一方常驻**
// runner：长期进程持 WS（真实心跳），被 @ 时就地跑内嵌的官方 Agent SDK session，处理完回帖、进程续存，
// **不依赖 harness turn 边界**。
//
// ⚠️ Phase-1 边界（协议不动）：本命令暂**不**新增 WakeKind:"daemon" / Residency:"daemon"（那是 doc 里的
// Phase 2）。为了让 wire 保持不变，daemon 复用现有 serve/watch 风格的唤醒声明——即随 hello 上报
// `advertiseWakeKind: "watch"`。这是刻意的 Phase-1 捷径，见报告与 #672。
import {
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_STREAM_ENDED,
} from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { connect } from "../client";
import { loadCursor, resolveChannel, saveCursor } from "../config";
import { resolveAuthDetailed } from "../oidc-cli";
import { postMessage } from "../rest";
import { isSlug } from "../validation";

/** 常驻 daemon 的信号退出码，与 serve 对齐（128 + signo）。 */
export const EXIT_SIGNAL_INT = 128 + 2;
export const EXIT_SIGNAL_TERM = 128 + 15;

const HELP = `party daemon — 实验性：内嵌 Claude Agent SDK 的常驻 party runner（SPIKE，#672）

usage: party daemon [channel|--channel C] [--timeout N]

  连上频道并常驻（长期进程、真实心跳）。被 @ 到本身份时，就地用内嵌的官方
  @anthropic-ai/claude-agent-sdk 跑一个 session，把最终文本回帖到频道——不经 harness、无 turn 边界。
  SDK 出错则回一条简短失败提示、进程续存。收到 SIGTERM/SIGINT 干净断开（presence 随之清除）。

flags:
  --channel C     目标频道（也可作为位置参数）；缺省用 party init 绑定的频道
  --timeout N     跑 N 秒后退出（默认 0 = 常驻）；主要给冒烟测试用

experimental：仅供 spike/live 验证，未接入 onboarding / join-pack；协议未改动（复用 watch 唤醒声明）。`;

/**
 * SDK 会话运行器抽象——daemon 与具体 SDK 之间的唯一接触面。
 * 默认实现（createSdkRunner）懒加载官方 SDK；**单测注入 mock，CI 永不触碰真 SDK**（SDK 无法在 CI 跑）。
 */
export interface SdkRunner {
  /** 用 @-mention 文本 + 最小频道上下文跑一次 session，返回最终文本（成功）或抛错（失败）。 */
  run(prompt: string, ctx: SdkRunContext): Promise<string>;
}

export interface SdkRunContext {
  channel: string;
  sender: string;
  seq: number;
}

/** 回帖依赖注入点：默认走 rest.postMessage，测试可捕获回帖。 */
export type PostReply = (reply: { body: string; mentions: string[]; replyTo: number }) => Promise<void>;

export interface DaemonOptions {
  server: string;
  token: string;
  channel: string;
  since: number;
  /** SDK 运行器（必填、可注入）。生产用 createSdkRunner()；测试注入 mock。 */
  runner: SdkRunner;
  /** 依赖注入：默认走 client.connect（测试可用 mock server + 真 connect，或完全注入）。 */
  connectImpl?: typeof connect;
  /** 依赖注入：默认走 rest.postMessage。 */
  postReply?: PostReply;
  /** 游标持久化钩子；默认无（run() 注入 saveCursor）。 */
  onCursor?: (cursor: number) => void;
  out?: (line: string) => void;
  backoffBaseMs?: number;
  /** 0 = 常驻（默认）；>0 跑满 N 秒后主动关闭连接退出（冒烟测试用）。 */
  timeoutSec?: number;
  /** 干净关停信号（SIGTERM/SIGINT）；abort 时关闭连接、presence 随之清除。 */
  abortSignal?: AbortSignal;
}

/**
 * 生产 SDK 运行器：懒加载官方 @anthropic-ai/claude-agent-sdk 的 query()，收集最终 result 文本。
 * 懒加载（dynamic import）保证只有真跑 daemon 才载入 SDK——注入了 mock 的单测永远不会触碰它。
 */
export function createSdkRunner(options?: Record<string, unknown>): SdkRunner {
  return {
    async run(prompt: string, ctx: SdkRunContext): Promise<string> {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const framed =
        `你在 AgentParty 频道 #${ctx.channel} 里被 @ 了（来自 ${ctx.sender}，seq=${ctx.seq}）。\n` +
        `请针对下面这条消息给出回复正文（回复会直接贴回频道）：\n\n${prompt}`;
      let final = "";
      // Query 是 AsyncGenerator<SDKMessage>：迭代到 type:"result" 拿终值。
      // success 携带 result:string；error 变体携带 errors:string[]，抛出交给上层回帖失败提示。
      for await (const message of query({ prompt: framed, ...(options ? { options } : {}) })) {
        if (message.type === "result") {
          if (message.subtype === "success") {
            final = message.result;
          } else {
            throw new Error(`sdk ${message.subtype}: ${message.errors?.join("; ") || "unknown error"}`);
          }
        }
      }
      return final;
    },
  };
}

/**
 * daemon 主循环：连上频道、常驻、被 @ 时跑 SDK 并回帖。
 * Phase-1 spike 有意最小化——只处理 plain `msg` 帧的新 @self；status/delivery/message_update 等一律忽略
 * （durable directed-delivery / 暂停接待 / squad 等留给后续阶段）。
 */
export async function runDaemon(o: DaemonOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.log(line));
  const post: PostReply =
    o.postReply ??
    (async ({ body, mentions, replyTo }) => {
      await postMessage(o.server, o.token, o.channel, {
        kind: "message",
        body,
        mentions,
        reply_to: replyTo,
      });
    });

  const conn = (o.connectImpl ?? connect)(o.server, o.token, o.channel, o.since, {
    ...(o.onCursor ? { onCursor: o.onCursor } : {}),
    ...(o.backoffBaseMs !== undefined ? { backoffBaseMs: o.backoffBaseMs } : {}),
    // Phase-1 捷径：复用现有 watch 唤醒声明，协议不动（见文件头注释 / #672）。
    advertiseWakeKind: "watch",
  });

  let self = "";
  let code = 0;
  let timedOut = false;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    conn.close();
  };
  if (o.abortSignal) {
    if (o.abortSignal.aborted) onAbort();
    else o.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (o.timeoutSec !== undefined && o.timeoutSec > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      conn.close();
    }, o.timeoutSec * 1000);
  }

  try {
    for await (const frame of conn.frames) {
      if (frame.type === "welcome") {
        self = frame.self;
        out(`daemon: attached to #${o.channel} as @${self} (experimental, SDK-in-process)`);
        continue;
      }
      if (frame.type === "error") {
        out(`daemon: error ${frame.code}: ${frame.message}`);
        if (frame.code === "unauthorized") code = EXIT_AUTH;
        else if (frame.code === "archived") code = EXIT_ARCHIVED;
        else code = 1;
        break;
      }
      // spike：只有 plain 消息帧能唤醒。status/presence/delivery/message_update 等留给后续阶段。
      if (frame.type !== "msg") continue;
      const msg = frame;
      const fromSelf = msg.sender.name === self;
      const mentioned = msg.mentions.includes(self);
      const fresh = msg.seq > conn.cursor;
      // 无论是否唤醒都推进游标（并持久化）：daemon 是常驻读者，读过即已读。
      if (msg.seq > 0) conn.ack(msg.seq);
      if (fromSelf || !mentioned || !fresh) continue;

      out(`daemon: woken by seq=${msg.seq} from ${msg.sender.name}`);
      let reply: string;
      try {
        reply = await o.runner.run(msg.body, { channel: o.channel, sender: msg.sender.name, seq: msg.seq });
      } catch (error) {
        const em = error instanceof Error ? error.message : String(error);
        out(`daemon: sdk session failed on seq=${msg.seq}: ${em}`);
        // graceful：回一条简短失败提示而非崩溃；提示本身失败也吞掉（best-effort），进程续存。
        try {
          await post({
            body: `⚠️ daemon SDK 会话失败（${em}）——本条 @ 未能就地处理，请重试或改走 human/serve。`,
            mentions: [msg.sender.name],
            replyTo: msg.seq,
          });
        } catch (postErr) {
          out(`daemon: failed to post failure note for seq=${msg.seq}: ${postErr instanceof Error ? postErr.message : String(postErr)}`);
        }
        continue;
      }

      const body = reply.trim() || "(daemon: SDK 返回空结果)";
      try {
        await post({ body, mentions: [msg.sender.name], replyTo: msg.seq });
        out(`daemon: replied to seq=${msg.seq}`);
      } catch (error) {
        out(`daemon: failed to post reply for seq=${msg.seq}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    o.abortSignal?.removeEventListener("abort", onAbort);
    conn.close();
  }

  if (aborted || timedOut) return code;
  // 帧流意外结束（非信号、非超时）：connect 层已彻底放弃重连。返回非零让上游看得见并可重启。
  return code === 0 ? EXIT_STREAM_ENDED : code;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, ["channel", "timeout"]);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "timeout"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }

  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
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
  let timeoutSec = 0;
  if (flags.timeout !== undefined) {
    const parsed = Number(str(flags.timeout));
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error("--timeout must be a non-negative number of seconds");
      return 1;
    }
    timeoutSec = Math.floor(parsed);
  }

  console.error(
    "party daemon is EXPERIMENTAL (#672 Phase-1 spike): it embeds @anthropic-ai/claude-agent-sdk and " +
      "runs an in-process SDK session on each @-mention. Protocol is unchanged — it advertises as a " +
      "watch-style wake for now. Not wired into onboarding.",
  );

  const controller = new AbortController();
  let signalCode = 0;
  const onSignal = (signo: "SIGINT" | "SIGTERM") => {
    signalCode = signo === "SIGINT" ? EXIT_SIGNAL_INT : EXIT_SIGNAL_TERM;
    controller.abort();
  };
  const sigint = () => onSignal("SIGINT");
  const sigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  try {
    const code = await runDaemon({
      server: auth.server,
      token: auth.token,
      channel,
      since: loadCursor(channel),
      runner: createSdkRunner(),
      onCursor: (cursor) => saveCursor(channel, cursor),
      timeoutSec,
      abortSignal: controller.signal,
    });
    return signalCode !== 0 ? signalCode : code;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
}
