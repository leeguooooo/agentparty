// party daemon — 实验性：内嵌 @anthropic-ai/claude-agent-sdk 的常驻 party runner（SPIKE，#672 Phase 2）。
//
// 动机（#672）：`party watch --once` 是单发子进程，harness 在 turn 边界把它回收即静默——presence 的
// 「可唤醒」本质是谎报，这是 #665/#664/#508/#29/#199 唤醒债风暴的共同根因。daemon 是一档**第一方常驻**
// runner：长期进程持 WS（真实心跳），被 @ 时就地跑内嵌的官方 Agent SDK session，处理完回帖、进程续存，
// **不依赖 harness turn 边界**。
//
// #688 Phase-2（本次）：Phase-1 只处理普通 `msg` 帧、connect 不声明 directed_delivery——真被 agent @ 时
// 服务端把 @ 走**持久化 directed delivery**，daemon 收到 `upgrade_required` 报错就崩（`● online` 一被 @
// 就死，正是 #665 假在线陷阱）。本阶段移植 serve 的 directed-delivery 接收路径：connect 声明
// `directedDelivery:"v1"`，握手进 directedDeliveryMode 后接住 `delivery` 帧、认领投给本身份的 delivery、
// 跑 SDK、把回复**带 reply_to 链回 delivery 的原消息**——服务端据此把 delivery 从 claimed 推到 replied
// （见 worker/src/do.ts `linkWakeResume`→`completeDirectedDelivery`：目标身份 + reply_to==message_seq 即
// 标 replied，无需 work_id/continuation_ref）。SDK 出错也回一条带 reply_to 的失败提示，同样了结 delivery，
// 避免它租约过期后被无限重投。
//
// #688 Phase-2.1（本次）：daemon 升为**一级唤醒类型**——不再复用 watch 捷径。
//   ① 随 hello 上报 `advertiseWakeKind: "daemon"`：服务端在 presence 落 wake_kind='daemon'、residency='daemon'
//      （见 worker/src/do.ts advertiseDaemonWakePresence）。who / PresenceBar 据此把它显式标为第一方常驻的强可唤醒档。
//   ② delivery 租约续期：跑 SDK 期间周期性发 `delivery_update running`（间隔远小于 90s 租约，默认 45s）把
//      lease_until 顶上去；turn 一结束即停。修掉「SDK 会话长于 DIRECTED_DELIVERY_LEASE_MS(90s) → 服务端租约到期
//      重派/重跑（重复模型副作用）」的窗口（#688 B）。快 turn（<45s）不发续租、只走终局 reply（reply_to 了结）。
import {
  DIRECTED_DELIVERY_LEASE_MS,
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_STREAM_ENDED,
  type DirectedDelivery,
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

const HELP = `party daemon — 实验性：内嵌 Claude Agent SDK 的常驻 party runner（SPIKE，#672 Phase 2）

usage: party daemon [channel|--channel C] [--timeout N]

  连上频道并常驻（长期进程、真实心跳）。被 @ 到本身份时，就地用内嵌的官方
  @anthropic-ai/claude-agent-sdk 跑一个 session，把最终文本回帖到频道——不经 harness、无 turn 边界。
  真 agent 的 @ 走持久化 directed delivery：daemon connect 声明 directedDelivery:"v1"，认领投给本身份的
  delivery、跑 SDK、回复带 reply_to 链回原消息使服务端把 delivery 标为 replied。SDK 出错则回一条带
  reply_to 的失败提示（同样了结 delivery），进程续存。收到 SIGTERM/SIGINT 干净断开（presence 随之清除）。

flags:
  --channel C     目标频道（也可作为位置参数）；缺省用 party init 绑定的频道
  --timeout N     跑 N 秒后退出（默认 0 = 常驻）；主要给冒烟测试用

auth：内嵌 SDK 走**订阅**凭据，从环境变量 CLAUDE_CODE_OAUTH_TOKEN 读取（Phase-1 live 已验证，零 API key）。
  起 daemon 前请确保该变量是有效的订阅 token/session；过期时 SDK 会话会失败并回一条失败提示（不崩进程）。

experimental：仅供 spike/live 验证，未接入 onboarding / join-pack。声明一级 wake_kind:daemon（residency=daemon），
  处理 delivery 期间周期续租（delivery_update running），>90s 会话不再被服务端重派。`;

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
  /**
   * #688 B：处理一条 claimed delivery 期间的租约续期间隔（发 delivery_update running 的周期）。
   * 默认 DIRECTED_DELIVERY_LEASE_MS/2(≈45s)，远小于 90s 租约。测试注入极小值以在毫秒级验证续租。
   */
  leaseRenewIntervalMs?: number;
  /** 干净关停信号（SIGTERM/SIGINT）；abort 时关闭连接、presence 随之清除。 */
  abortSignal?: AbortSignal;
}

/**
 * 生产 SDK 运行器：懒加载官方 @anthropic-ai/claude-agent-sdk 的 query()，收集最终 result 文本。
 * 懒加载（dynamic import）保证只有真跑 daemon 才载入 SDK——注入了 mock 的单测永远不会触碰它。
 */
export function createSdkRunner(options?: Record<string, unknown>): SdkRunner {
  // #691 评审(Major)：无头 daemon 必须显式设 permissionMode。SDK 默认 'default' 会在 headless（无 TTY、
  // 未提供 canUseTool）下遇到需批准的工具时挂起/行为不定。'dontAsk' = 不提示、未预批的工具一律拒绝——
  // experimental daemon 只产文本、绝不被一条 @ 触发任意工具执行（安全）。完整的 owner/worker 边界权限模型
  // （canUseTool → 三方边界、allowedTools、scope options）见 Phase-2.2 #692；调用方可覆盖本默认。
  const sdkOptions: Record<string, unknown> = { permissionMode: "dontAsk", ...(options ?? {}) };
  return {
    async run(prompt: string, ctx: SdkRunContext): Promise<string> {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const framed =
        `你在 AgentParty 频道 #${ctx.channel} 里被 @ 了（来自 ${ctx.sender}，seq=${ctx.seq}）。\n` +
        `请针对下面这条消息给出回复正文（回复会直接贴回频道）：\n\n${prompt}`;
      let final = "";
      // Query 是 AsyncGenerator<SDKMessage>：迭代到 type:"result" 拿终值。
      // success 携带 result:string；error 变体携带 errors:string[]，抛出交给上层回帖失败提示。
      for await (const message of query({ prompt: framed, options: sdkOptions })) {
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
 * #688 Phase-2：既接住持久化 `delivery` 帧（真 agent @ 的主路径），也保留 plain `msg` 帧的 @self 唤醒
 * （老服务端 / 非持久投递的兜底）。status/presence/message_update 等一律忽略（暂停接待 / squad 等留给后续
 * 阶段）。delivery 的了结靠回复带 reply_to 链回原消息——服务端据此标 replied（见文件头注释）。
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
    // #688：声明本连接消费持久化 directed-delivery v1 帧——不声明就会在真被 @（durable 投递）时收到
    // `upgrade_required` 报错并退出（Phase-1 的崩溃根因）。
    directedDelivery: "v1",
    // #688 Phase-2.1：一级 daemon 唤醒声明（不再是 watch 捷径）。服务端据此落 wake_kind='daemon'、
    // residency='daemon'（第一方常驻活体），who / PresenceBar 显式标强可唤醒档。断连由 markOffline 撤销。
    advertiseWakeKind: "daemon",
  });

  let self = "";
  // 服务端是否按 directed-delivery v1 路由 @：为 true 时普通 @self 的 `msg` 帧由 delivery 帧接管，
  // plain-msg 路径不再据此唤醒（避免同一条 @ 双跑）。老服务端不发 directed_delivery → 保持 msg 路径唤醒。
  let directedDeliveryMode = false;
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

  // 跑 SDK 并回帖的公共路径：delivery 与 plain-msg 两条唤醒都汇到这里。回复始终带 reply_to=msg.seq——
  // 对 delivery 而言这就是了结机制（服务端见目标身份 + reply_to==message_seq 即把 delivery 标 replied，
  // 见文件头 / worker/src/do.ts）；失败提示同样带 reply_to，一样了结 delivery，避免租约过期后被重投。
  const wake = async (
    msg: { seq: number; body: string; sender: { name: string } },
    delivery: DirectedDelivery | null,
  ): Promise<void> => {
    out(`daemon: woken by seq=${msg.seq} from ${msg.sender.name}`);
    // #688 B：claimed delivery 的租约续期。SDK 会话可能长于 DIRECTED_DELIVERY_LEASE_MS(90s)——期间不续租，
    // 服务端租约到期会把这条 delivery 重新派发/重跑（重复模型副作用）。跑 SDK 期间用一个 setInterval 周期性
    // 发 delivery_update running（间隔远小于租约）把 lease_until 顶上去；SDK turn 一结束（成功/失败/早退）由
    // 下方 finally 停表。fire-and-forget：丢一拍无妨，下一拍或终局 reply(reply_to 了结)会补。带 work_id/
    // continuation_ref 精确锁定这条 work（镜像 serve confirmDeliveryUpdate 的 running 帧参数）。
    // 快 turn（< 续租间隔）→ 定时器一拍未到就被 finally 清掉，零续租，只走终局 reply。
    let renewTimer: ReturnType<typeof setInterval> | null = null;
    if (delivery !== null) {
      const intervalMs = o.leaseRenewIntervalMs ?? Math.floor(DIRECTED_DELIVERY_LEASE_MS / 2);
      renewTimer = setInterval(() => {
        conn.send({
          type: "delivery_update",
          delivery_id: delivery.id,
          state: "running",
          ...(delivery.work_id === null ? {} : { work_id: delivery.work_id }),
          ...(delivery.continuation_ref === null ? {} : { continuation_ref: delivery.continuation_ref }),
        });
        out(`daemon: renewed delivery ${delivery.id} lease (delivery_update running)`);
      }, intervalMs);
      if (typeof renewTimer.unref === "function") renewTimer.unref();
    }
    let reply: string;
    try {
      reply = await o.runner.run(msg.body, { channel: o.channel, sender: msg.sender.name, seq: msg.seq });
    } catch (error) {
      const em = error instanceof Error ? error.message : String(error);
      out(`daemon: sdk session failed on seq=${msg.seq}: ${em}`);
      // graceful：回一条简短失败提示而非崩溃；提示本身失败也吞掉（best-effort），进程续存。
      // 该回帖带 reply_to → 即使 SDK 失败也把 delivery 标 replied（一次交付语义），不留悬挂重投。
      try {
        await post({
          body: `⚠️ daemon SDK 会话失败（${em}）——本条 @ 未能就地处理，请重试或改走 human/serve。`,
          mentions: [msg.sender.name],
          replyTo: msg.seq,
        });
      } catch (postErr) {
        out(`daemon: failed to post failure note for seq=${msg.seq}: ${postErr instanceof Error ? postErr.message : String(postErr)}`);
      }
      return;
    } finally {
      // SDK turn 结束即停续租——无论成功、失败早退还是抛穿。之后的终局 reply（带 reply_to）负责把 delivery
      // 从 running 推到 replied，不再需要续租。
      if (renewTimer) clearInterval(renewTimer);
    }

    const body = reply.trim() || "(daemon: SDK 返回空结果)";
    try {
      await post({ body, mentions: [msg.sender.name], replyTo: msg.seq });
      out(`daemon: replied to seq=${msg.seq}`);
    } catch (error) {
      out(`daemon: failed to post reply for seq=${msg.seq}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    for await (const incoming of conn.frames) {
      if (incoming.type === "welcome") {
        self = incoming.self;
        directedDeliveryMode = incoming.directed_delivery === "v1";
        // #688：声明 directedDelivery:v1 还不够——服务端只把「已注册的 live delivery adapter」当作
        // 可实时派发目标(do.ts:2490)。必须像 watch 一样发一帧 register,服务端才会 dispatchNextDirectedDelivery
        // 把投给本身份的 delivery 实时推过来。逐连接状态,每次重连收到 welcome 都要重发。
        if (directedDeliveryMode) {
          conn.send({ type: "delivery_adapter", adapter: "watch", op: "register" });
        }
        out(
          `daemon: attached to #${o.channel} as @${self} (experimental, SDK-in-process` +
            `${directedDeliveryMode ? ", directed-delivery v1" : ""})`,
        );
        continue;
      }
      if (incoming.type === "error") {
        out(`daemon: error ${incoming.code}: ${incoming.message}`);
        if (incoming.code === "unauthorized") code = EXIT_AUTH;
        else if (incoming.code === "archived") code = EXIT_ARCHIVED;
        else code = 1;
        break;
      }

      // #688：真 agent 的 @ 走持久化 directed delivery。像 serve 一样把 delivery 帧拆成 delivery 元信息 +
      // 内嵌的原消息（frame.message）。plain `msg` 帧则 delivery=null、msg=frame 自身。
      const directedDelivery = incoming.type === "delivery" ? incoming.delivery : null;
      const msg = incoming.type === "delivery" ? incoming.message : incoming;

      // delivery 帧内嵌的永远是 message，其余（status/presence/…）一律忽略——留给后续阶段。
      if (msg.type !== "msg") continue;

      // ── 持久化 directed delivery 路径（真 @ 的主路径）──
      if (directedDelivery !== null) {
        // 只处理认领给本身份、且处于 claimed 的 delivery；其余（别人的、或状态不对的）记一笔即忽略。
        if (directedDelivery.target_name !== self || directedDelivery.state !== "claimed") {
          out(
            `daemon: ignored invalid delivery ${directedDelivery.id} for target=${directedDelivery.target_name} state=${directedDelivery.state}`,
          );
          continue;
        }
        // 自己发的 @ 不唤醒自己。delivery 是独立 work cursor，不看 conn.cursor 的 fresh。
        if (msg.sender.name === self) continue;
        await wake(msg, directedDelivery);
        continue;
      }

      // ── plain `msg` 路径（老服务端 / 非持久投递的兜底）──
      const fromSelf = msg.sender.name === self;
      const mentioned = msg.mentions.includes(self);
      const fresh = msg.seq > conn.cursor;
      // 无论是否唤醒都推进游标（并持久化）：daemon 是常驻读者，读过即已读。
      if (msg.seq > 0) conn.ack(msg.seq);
      // directedDeliveryMode 下，@self 的普通 msg 由 delivery 帧接管——这里不再据它唤醒（否则同一条 @ 双跑）。
      if (directedDeliveryMode && mentioned) continue;
      if (fromSelf || !mentioned || !fresh) continue;

      // plain-msg 兜底路径没有 delivery 租约，无需续租。
      await wake(msg, null);
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
    "party daemon is EXPERIMENTAL (#672/#688 Phase-2.1 spike): it embeds @anthropic-ai/claude-agent-sdk and " +
      "runs an in-process SDK session on each @-mention, receiving durable directed deliveries " +
      "(directedDelivery:v1). It advertises a first-class wake_kind:'daemon' (residency=daemon) and renews " +
      "the delivery lease (delivery_update running) so >90s turns are not re-dispatched. " +
      "Subscription auth comes from CLAUDE_CODE_OAUTH_TOKEN. Not wired into onboarding.",
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
