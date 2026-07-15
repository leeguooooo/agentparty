// party watch — 补拉错过消息，阻塞等新消息
import {
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_LOOP_GUARD,
  EXIT_STREAM_ENDED,
  EXIT_TIMEOUT,
  type DirectedDelivery,
  type MsgFrame,
} from "@agentparty/shared";
import { acquireInstanceLock, defaultInstanceLockDir, instanceLockTarget } from "../instance-lock";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { connect } from "../client";
import {
  loadCursor,
  loadRevCursor,
  loadStuck,
  markWatchDirectedStuckAccepted,
  resolveChannel,
  saveCursor,
  saveRevCursor,
  saveWatchStuck,
  type StuckWake,
} from "../config";
import { resolveAuthDetailed, type ResolvedAuthDetailed } from "../oidc-cli";
import { formatMsg } from "../format";
import { fetchMe, fetchMessages, fetchRecentMessages, handleRestError, postMessage } from "../rest";
import { buildContext } from "./status";
import { MAX_TIMEOUT_SEC, isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";
import { jsonFrame, nowTs } from "../json";
import {
  clearStatuslineListener,
  heartbeatPatch,
  lastMessageFromFrame,
  localStatuslineBase,
  unreadFromCursor,
  writeStatuslineCache,
} from "../statusline-cache";

const WATCH_FLAGS = ["channel", "timeout", "follow", "once", "mentions-only", "exclude-self", "json", "allow-multiple", "latest", "since"];
const WATCH_SKIP_PAGE_SIZE = 1000;
const WATCH_SKIP_SCAN_LIMIT = 10_000;
const WATCH_DELIVERY_ACK_TIMEOUT_MS = 5_000;
const WATCH_DELIVERY_ACK_POLL_MS = 10;
const HELP = `usage: party watch [channel|--channel C] [--timeout N] [--mentions-only] [--exclude-self] [--follow|--once] [--latest|--since seq] [--json] [--allow-multiple]

Watch a channel for new messages. By default this waits up to 240 seconds.
With --follow, it stays attached unless --timeout N is explicit.
With --once, it stays attached until the FIRST matching message, prints it, and
exits 0. It is only a wake signal while the harness keeps that background task
alive. Claude Code may kill run_in_background tasks at turn boundaries, so this
is turn-scoped best effort, not durable unattended presence.
Re-arm --once with the persisted cursor (omit --latest). If the previous result
was lost before the agent replied, the pending wake is replayed first.
For --mentions-only --once, an uninitialized cursor (0) attaches at the current
channel head to avoid replaying old mentions. Use --since 0 to request backlog.
Self messages are skipped by default; --exclude-self is accepted as an explicit
automation hint for scripts that want to document that behavior.
NOTE: --follow only PRINTS messages. Most harnesses (Codex included) never turn
background output into a new agent turn, so a mention can sit unread while you
look online. --once is only a wake layer while your harness preserves the task
and proves that process exit resumes the same agent session. For durable Claude
Code/Codex presence, run a project agent from a persistent terminal with:
  party serve <channel> --runner claude|codex --replay-backlog
The replay flag recovers mentions that arrived while the supervisor was down.
Verify the whole chain from another identity with: party wake test @<you>

Options:
  --channel C       watch channel C instead of the bound channel
  --timeout N       stop after N seconds
  --mentions-only   print only non-self messages that mention this agent
  --exclude-self    explicitly skip this agent's own messages (default)
  --follow          keep watching after the first matching message
  --once            exit 0 right after the first matching message
  --latest          explicitly skip backlog, attach at the current channel head
  --since seq       explicitly start after seq (mutually exclusive with --latest)
  --json            emit structured NDJSON frames`;

// --follow 的假在线陷阱（issue #55/#60）：watcher 打印了 mention、presence 也新鲜，但多数
// harness（Codex 实测）不会把后台输出变成新一轮，agent 实际没醒。启动时把这件事讲清楚，
// 并给出每种 harness 的正确待命姿势。发 stderr，不污染被消费的 stdout 流。
export const FOLLOW_WAKE_ADVISORY =
  "note: --follow only prints; unless your harness turns background output into a new agent turn " +
  "(Codex does not), mentions will sit here unread while you look online. " +
  "Use --once only for a turn-scoped wait, or a durable project agent with: " +
  "party serve <channel> --runner claude|codex --replay-backlog. " +
  "Verify from another identity: party wake test @<you>";

export const ONCE_CODEX_ADVISORY =
  "warning: Codex CLI does not resume a model turn just because `party watch --once` exits. " +
  "Use `party serve <channel> --on-mention '<codex exec resume ...; party send ...>'` " +
  "from a durable supervisor (tmux/launchctl/daemon), then verify with `party wake test @<you>`.";

export const ONCE_CLAUDE_ADVISORY =
  "warning: Claude Code may kill `run_in_background` watchers at a turn boundary. " +
  "This --once listener is only a turn-scoped wait; re-arm it every turn and do not claim durable presence. " +
  "For unattended wake, run `party serve <channel> --runner claude --replay-backlog` from a persistent terminal/project agent.";

export const ONCE_REARM_ADVISORY =
  "note: --once is single-shot and harness-scoped. Re-arm it every turn without --latest; pending wakes are replayed until this identity sends a message/status. " +
  "For unattended presence, use `party serve --runner claude|codex --replay-backlog`.";

export const ONCE_LATEST_ADVISORY =
  "warning: re-arming `party watch --once` with --latest explicitly discards backlog. " +
  "Use the persisted cursor (omit --latest); any pending unacknowledged wake will be replayed first.";

/** Claude Code 环境：可做回合内 --once，但 run_in_background 可能在回合边界被回收（#454）。 */
export function isClaudeCodeEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.CLAUDECODE !== undefined || Object.keys(env).some((key) => key.startsWith("CLAUDE_CODE_"));
}

export function isCodexRuntimeEnv(env: Record<string, string | undefined> = process.env): boolean {
  // Claude Code 优先短路（#175）：它装 codex 插件/companion 时 env 里也会有 CODEX_* 变量；
  // 它需要 #454 的 turn-scoped 警告，而不是 Codex 的「退出不会唤醒」警告。
  if (isClaudeCodeEnv(env)) return false;
  return Object.keys(env).some((key) => key === "CODEX" || key.startsWith("CODEX_") || key.startsWith("OPENAI_CODEX"));
}

export const EXIT_ALREADY_WATCHING = 10;

export interface WatchOptions {
  server: string;
  token: string;
  channel: string;
  since: number;
  sinceRev?: number; // 修订游标（hello.since_rev），服务端据此限定修订重放
  timeoutSec: number;
  follow: boolean;
  mentionsOnly: boolean;
  once?: boolean; // 第一条匹配消息后立即退出 0（harness 后台任务的唤醒信号）
  json?: boolean; // 输出 NDJSON 帧而非人类格式，供 supervisor/工具消费
  skippedMentionSeqs?: number[]; // 显式 --latest/--since 快进时跳过的 @，随 once wake 交给 agent
  /** --once 打印前先持久化「尚未被模型确认」的唤醒；后续自己发消息/状态才清账（#508）。 */
  onStuck?: (stuck: StuckWake) => void;
  /** running ACK 后按 delivery id 原子把本地 debt 标成 accepted；false/throw 都按 unknown outcome 阻断。 */
  onDirectedAccepted?: (deliveryId: string) => boolean;
  onCursor?: (cursor: number) => void;
  onRevCursor?: (revCursor: number) => void;
  out?: (line: string) => void;
  backoffBaseMs?: number;
  statusline?: boolean;
  /** 单实例锁目录（#195/#465）。默认全机共享、再按 server/token 身份隔离；测试注入。 */
  lockDir?: string;
  /** 关掉单实例保护（逃生舱）。 */
  allowMultiple?: boolean;
  /** durable delivery running 回执等待上限；生产默认 5s，测试可注入更短时间。 */
  deliveryAckTimeoutMs?: number;
  // watch 挂上（连上 WS、开始监听）后声明自己「有 watch 唤醒层」的钩子；run() 注入真实实现，测试可省略/替换。
  advertise?: () => Promise<void>;
}

async function confirmWatchDeliveryRunning(
  conn: Pick<ReturnType<typeof connect>, "send" | "pendingFrames">,
  delivery: DirectedDelivery,
  expectedTarget: string,
  timeoutMs: number,
  interrupted: () => boolean,
): Promise<void> {
  const isExpectedAck = (frame: ReturnType<typeof conn.pendingFrames>[number]) =>
    frame.type === "delivery_state" &&
    frame.delivery.id === delivery.id &&
    frame.delivery.target_name === expectedTarget &&
    frame.delivery.state === "running";
  // A broadcast can already be queued before our update. It is not proof that this send was
  // accepted, so require one additional exact acknowledgement after send.
  const existingAckCount = conn.pendingFrames().filter(isExpectedAck).length;
  const existingErrors = new Set(conn.pendingFrames().filter((frame) => frame.type === "error"));
  const update = {
    type: "delivery_update" as const,
    delivery_id: delivery.id,
    state: "running" as const,
    ...(delivery.work_id === null ? {} : { work_id: delivery.work_id }),
    ...(delivery.continuation_ref === null ? {} : { continuation_ref: delivery.continuation_ref }),
  };
  if (!conn.send(update)) throw new Error("websocket is not open");

  const finiteTimeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : WATCH_DELIVERY_ACK_TIMEOUT_MS;
  const deadline = Date.now() + finiteTimeout;
  for (;;) {
    if (interrupted()) throw new Error("connection interrupted before running acknowledgement");
    const pending = conn.pendingFrames();
    if (pending.filter(isExpectedAck).length > existingAckCount) return;
    const rejection = pending.find((frame) => frame.type === "error" && !existingErrors.has(frame));
    if (rejection?.type === "error") throw new Error(`${rejection.code}: ${rejection.message}`);
    if (Date.now() >= deadline) {
      throw new Error(`delivery running acknowledgement timed out after ${finiteTimeout}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, WATCH_DELIVERY_ACK_POLL_MS));
  }
}

// watch 一挂上（连上 WS、开始监听）就把 presence 标成带 watch 唤醒层：residency=supervised + wake.kind=watch。
// 没这一步，agent 跑了 watch 但 presence.wake_kind 仍是 null → 服务端 / `party wake test` 对它恒判
// 'no wake adapter'、presence 把挂着 watch 的 agent 判成假在线 / not listening（#440）。对照 serve 的
// advertiseServeWake（residency=supervised + wake.kind=serve）——watch 同样是本地常驻 supervisor 持 WS，
// wakeReachable 也把 serve/watch 一并按「持 WS 才可唤醒」处理，故 residency 用 supervised。
// 自报=unverified（who 里显示 'wakeable unverified'）：只声明「存在 watch 唤醒层」，不谎称已验证——
// 真验证仍靠 agent_resumed / ledger（#191②）。--once 单发也在 attach 时报一次，让服务端至少看得见。
export async function advertiseWatchWake(auth: ResolvedAuthDetailed, channel: string): Promise<void> {
  if (!auth.server || !auth.token) return;
  await postMessage(auth.server, auth.token, channel, {
    kind: "status",
    state: "waiting",
    note: "watch 已挂上——被 @ 才唤起你一次，等待零 token",
    mentions: [],
    residency: "supervised",
    wake: { kind: "watch" },
    context: buildContext(auth),
  });
}

export function resolveWatchTimeoutSec(timeout: number | undefined, indefinite: boolean): number {
  if (typeof timeout === "number") return timeout;
  return indefinite ? 0 : 240;
}

interface ExplicitWatchCursor {
  cursor: number;
  skippedMessages: number;
  skippedMentionSeqs: number[];
}

async function resolveExplicitWatchCursor(
  server: string,
  token: string,
  channel: string,
  localCursor: number,
  requestedSince: number | undefined,
): Promise<ExplicitWatchCursor> {
  const [identity, tail] = await Promise.all([
    fetchMe(server, token),
    fetchRecentMessages(server, token, channel, 1),
  ]);
  const head = tail.at(-1)?.seq ?? 0;
  // Sample head first. The subsequent forward scan is then complete through that
  // head; messages created later remain above the attach cursor and arrive on WS.
  const cursor = Math.min(requestedSince ?? head, head);
  const skipped: MsgFrame[] = [];
  let scanCursor = localCursor;
  while (scanCursor < cursor && skipped.length < WATCH_SKIP_SCAN_LIMIT) {
    const page = await fetchMessages(
      server,
      token,
      channel,
      scanCursor,
      Math.min(WATCH_SKIP_PAGE_SIZE, WATCH_SKIP_SCAN_LIMIT - skipped.length),
    );
    if (page.length === 0) break;
    const throughCursor = page.filter((msg) => msg.seq <= cursor);
    skipped.push(...throughCursor);
    const pageLast = page.at(-1)?.seq ?? scanCursor;
    if (pageLast <= scanCursor) break;
    scanCursor = pageLast;
    if (pageLast >= cursor) break;
  }
  const firstSkipped = skipped.at(0)?.seq;
  const exactFromLocalCursor = firstSkipped === undefined || firstSkipped === localCursor + 1;
  const scanComplete = cursor <= localCursor || scanCursor >= cursor;
  if (!exactFromLocalCursor || !scanComplete) {
    throw new Error(
      `refusing to skip more than ${WATCH_SKIP_SCAN_LIMIT} retained messages without an exact mention scan; use --since in smaller steps`,
    );
  }
  return {
    cursor,
    skippedMessages: skipped.length,
    skippedMentionSeqs: skipped
      .filter((msg) => msg.sender.name !== identity.name && msg.mentions.includes(identity.name))
      .map((msg) => msg.seq),
  };
}

export async function runWatch(o: WatchOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.log(line));
  // Only the single-shot watcher whose caller can persist and acknowledge directed debt is an
  // actionable v1 adapter. Declare this in the first hello so the Worker never has to guess in the
  // welcome -> register window; observers deliberately omit the capability.
  const acceptsDirectedDelivery =
    o.once === true &&
    o.mentionsOnly &&
    o.onStuck !== undefined &&
    o.onDirectedAccepted !== undefined;
  // 先抢锁，再连服务端：第二个 watcher 连 WS 都不该建，否则它已经开始消费 @ 了（#195）
  const lockDir = o.lockDir ?? defaultInstanceLockDir();
  const lockTarget = o.lockDir === undefined ? instanceLockTarget(o.server, o.token, o.channel) : o.channel;
  const lock = o.allowMultiple === true ? null : acquireInstanceLock("watch", lockTarget, lockDir);
  if (lock && !lock.ok) {
    out(
      `watch: 已有 watcher 挂在 #${o.channel} 上（pid ${lock.heldByPid}）。` +
        ` 再挂一个会让同一条 @ 触发 N 次唤醒——agent 会把同一条消息回 N 遍，并给 loop guard 上膛。` +
        ` 要么等它退出，要么 kill ${lock.heldByPid}；确实想并存请加 --allow-multiple。`,
    );
    return EXIT_ALREADY_WATCHING;
  }
  // Capture transport interruptions by generation. A delivery received after an earlier reconnect
  // may proceed, but a disconnect between update and ACK invalidates that exact claim attempt.
  let connectionGeneration = 0;
  let conn: ReturnType<typeof connect>;
  try {
    conn = connect(o.server, o.token, o.channel, o.since, {
      onCursor: o.onCursor,
      ...(acceptsDirectedDelivery ? { directedDelivery: "v1" as const } : {}),
      sinceRev: o.sinceRev,
      onRevCursor: o.onRevCursor,
      backoffBaseMs: o.backoffBaseMs,
      onStatus: (status) => {
        if (status === "reconnecting" || status === "closed") connectionGeneration += 1;
      },
    });
  } catch (error) {
    lock?.release?.();
    throw error;
  }

  let self = "";
  let lastSeq = 0;
  let printed = 0;
  let timedOut = false;
  let onceDone = false;
  let code = 0;
  // Durable work 只交给专门等待 @ 的 single-shot watcher。普通 --once 可能先被无关消息
  // 满足并退出；若它同时 claim 了 delivery，就会把真正的 work 留到租约超时。
  let directedDeliveryMode = false;
  const displayedMessageSeqs = new Set<number>();
  // 人为暂停接待（#180）：镜像 serve 的 self-paused 跟踪。被 @ 时不把 --once 退出当唤醒信号，
  // 但消息照常打印进历史、游标照推进。从 welcome 的 presence 快照认出初始状态（重连也不误唤醒），
  // 之后靠 presence 帧增量翻转。恢复后不重放暂停期的 @（在历史里，agent 自行补看），与 serve 一致。
  let selfPaused = false;
  // 挂上即声明「有 watch 唤醒层」（best-effort，只做一次；重连再收 welcome 不重复刷）——见 advertiseWatchWake。
  let advertised = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (o.timeoutSec > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      conn.close();
    }, o.timeoutSec * 1000);
  }
  // Heartbeat on a clock, not only on traffic: a quiet channel used to leave
  // heartbeat_ts stale, and status bars (which treat >10 min as dead) showed
  // "listener down" while the watch sat healthily connected.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (o.statusline === true) {
    heartbeat = setInterval(() => {
      writeStatuslineCache({
        ...localStatuslineBase(o.channel),
        ...heartbeatPatch("watch", Date.now(), { mentionsOnly: o.mentionsOnly }),
      });
    }, 60_000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }

  try {
    for await (const frame of conn.frames) {
      if (frame.type === "welcome") {
        self = frame.self;
        lastSeq = frame.last_seq;
        // 只有专门等 @ 的 --mentions-only --once 才能把退出当成一次可行动唤醒。
        // --follow / 普通 watch / 会被无关消息提前满足的泛用 --once 都不能 claim work。
        directedDeliveryMode = acceptsDirectedDelivery && frame.directed_delivery === "v1";
        // registration 是逐连接状态；每次重连收到 welcome 都重新声明。它不等价于普通消息游标，
        // 也不允许 conn.ack/seen 变成 delivery 完成回执。
        if (directedDeliveryMode) {
          conn.send({ type: "delivery_adapter", adapter: "watch", op: "register" });
        }
        // 连上/重连时若自己已被暂停接待（#180），从 welcome 的 presence 快照里认出来——
        // 重连也不会把暂停期的 @ 误当成 --once 唤醒。提示走 stderr，不污染被消费的 stdout 流。
        const mine = frame.presence?.find((p) => p.name === self);
        selfPaused = mine?.paused === true;
        if (selfPaused) {
          console.error(
            `watch: 当前处于暂停接待状态——被 @ 也不作为 --once 唤醒信号${typeof mine?.resume_at === "number" ? `，将于 ${new Date(mine.resume_at).toISOString()} 恢复` : "（等人工恢复）"}。消息仍进历史。`,
          );
        }
        // 不要用 welcome.read_cursors 快进 --once 的游标（#172 的诱人错解）。
        // read cursor 是**身份级「已读」**：protocol.ts 明确「网页 tab / serve / watch --follow
        // 读到就回 seen；webhook / watch --once 型事件驱动 agent 不发 seen，其送达状态由
        // wake 回执表达」。同身份的网页标签页读过一条 @，不代表这个 supervisor 被它唤醒过。
        // 拿它 ack 会静默跳过从未送达的 mention。#172 需要一个独立的 wake cursor。
        // 挂上即声明 watch 唤醒层（#440，best-effort，只做一次；重连再收 welcome 不重复刷）。
        // presence 上报走独立 REST 通道，绝不进 watch 的输出流：失败也**静默吞掉**——既不能污染
        // stdout（--json 的帧契约按 fixture 校验，多一行就崩），也不能污染 stderr（订阅方按
        // stderr==="" 断言）。声明失败最坏就是 agent 回到「wake_kind=null」的旧态，不比现状差。
        if (!advertised) {
          advertised = true;
          try {
            await o.advertise?.();
          } catch {
            /* best-effort presence：失败静默，不碰 stdout/stderr（保 --json 帧契约与 stderr 洁净） */
          }
        }
        if (o.statusline === true) {
          writeStatuslineCache({
            ...localStatuslineBase(o.channel),
            ...heartbeatPatch("watch", Date.now(), { mentionsOnly: o.mentionsOnly }),
            unread: unreadFromCursor(lastSeq, o.channel),
          });
        }
        continue;
      }
      // adapter ACK 和公开状态广播都不是 actionable work。尤其 delivery_state 只供展示，
      // 绝不能让 --once 退出或让 --follow 冒充已经承接了一条 delivery。
      if (frame.type === "delivery_adapter" || frame.type === "delivery_state") continue;
      if (frame.type === "delivery") {
        // Worker 只应把当前 watch 租约的 claimed work 发给 holder；客户端仍做 fail-closed
        // 校验，避免 queued/running/replied/failed 状态或观察型 watch 被误当成一次唤醒。
        if (
          !directedDeliveryMode ||
          !acceptsDirectedDelivery ||
          frame.delivery.target_name !== self ||
          frame.delivery.state !== "claimed"
        ) {
          continue;
        }

        const msg = frame.message;
        lastSeq = Math.max(lastSeq, msg.seq);
        if (selfPaused) {
          // Worker 正常不会把 paused identity 的 work 分配给 watch；若竞态中收到，保持未消费、
          // 不落本地 debt，让恢复后的同一 delivery 新租约仍可真正唤醒。
          console.error(
            `watch: ⏸ 暂停接待中，delivery=${frame.delivery.id} 不作为唤醒信号（未确认，等待重放）。`,
          );
          continue;
        }

        // 不缓存 delivery id：同一个 durable work 可以在旧租约过期后以新 attempt/lease 重投。
        // --once 在输出第一条合法 claim 后立即 break，已足以让同一进程只消费一次，同时不会
        // 把未来新租约永久吞掉。
        // --once 的本地 debt 必须在输出前落盘；seq 只是找到原消息，delivery/work/continuation
        // 才是这次 actionable work 的身份。普通 conn.ack/seen 在此路径完全不发送。
        const directedDebt: StuckWake = {
          seq: msg.seq,
          delivery_id: frame.delivery.id,
          ...(frame.delivery.work_id !== null ? { work_id: frame.delivery.work_id } : {}),
          ...(frame.delivery.continuation_ref !== null
            ? { continuation_ref: frame.delivery.continuation_ref }
            : {}),
          delivery_acceptance: "unconfirmed",
          attempts: 0,
          last_error: "watch delivery awaiting running acknowledgement",
          source: "watch",
          channel_last_seq: lastSeq,
          skipped_mention_seqs: o.skippedMentionSeqs ?? [],
        };
        try {
          o.onStuck!(directedDebt);
        } catch (error) {
          console.error(
            `watch: delivery=${frame.delivery.id} 本地 debt 持久化失败，未发送 running: ${error instanceof Error ? error.message : String(error)}`,
          );
          code = EXIT_STREAM_ENDED;
          break;
        }

        const claimConnectionGeneration = connectionGeneration;
        try {
          await confirmWatchDeliveryRunning(
            conn,
            frame.delivery,
            self,
            o.deliveryAckTimeoutMs ?? WATCH_DELIVERY_ACK_TIMEOUT_MS,
            () => timedOut || connectionGeneration !== claimConnectionGeneration,
          );
        } catch (error) {
          console.error(
            `watch: delivery=${frame.delivery.id} running 确认失败，未输出唤醒: ${error instanceof Error ? error.message : String(error)}`,
          );
          code = EXIT_STREAM_ENDED;
          break;
        }

        try {
          if (!o.onDirectedAccepted!(frame.delivery.id)) {
            throw new Error("directed debt changed before accepted state could be persisted");
          }
        } catch (error) {
          console.error(
            `watch: delivery=${frame.delivery.id} running 已确认，但本地 accepted 状态落盘失败；unknown outcome，未输出唤醒: ${error instanceof Error ? error.message : String(error)}`,
          );
          code = EXIT_STREAM_ENDED;
          break;
        }

        const lag = Math.max(0, lastSeq - msg.seq);
        if (o.json) {
          // 保留完整 delivery frame；不能退化成只含原 msg 的 JSON，否则 work/continuation 丢失。
          out(
            JSON.stringify(
              jsonFrame({
                ...(frame as unknown as Record<string, unknown>),
                channel_last_seq: lastSeq,
                lag,
                skipped_mention_seqs: o.skippedMentionSeqs ?? [],
              }),
            ),
          );
        } else {
          if (!displayedMessageSeqs.has(msg.seq)) {
            out(formatMsg(msg));
            displayedMessageSeqs.add(msg.seq);
          }
          const work = frame.delivery.work_id === null ? "" : ` work_id=${frame.delivery.work_id}`;
          const continuation =
            frame.delivery.continuation_ref === null ? "" : ` continuation_ref=${frame.delivery.continuation_ref}`;
          out(`watch: directed delivery=${frame.delivery.id}${work}${continuation}`);
        }
        printed++;

        if (o.statusline === true) {
          writeStatuslineCache({
            ...localStatuslineBase(o.channel),
            ...heartbeatPatch("watch", Date.now(), { mentionsOnly: o.mentionsOnly }),
            unread: unreadFromCursor(Math.max(lastSeq, msg.seq), o.channel),
            last_message: lastMessageFromFrame(msg),
          });
        }

        onceDone = true;
        if (!o.json && lag > 0) {
          out(
            `watch: 唤醒于 delivery=${frame.delivery.id} seq=${msg.seq}，落后 ${lag} 条，head=${lastSeq}。` +
              ` channel_last_seq=${lastSeq} lag=${lag} skipped_mention_seqs=${JSON.stringify(o.skippedMentionSeqs ?? [])}.` +
              ` 这不是最新消息——补上下文：party history ${o.channel} --since ${msg.seq}`,
          );
        } else if (!o.json) {
          out(
            `watch: delivery=${frame.delivery.id} channel_last_seq=${lastSeq} lag=0 skipped_mention_seqs=${JSON.stringify(o.skippedMentionSeqs ?? [])}`,
          );
        }
        break;
      }
      if (frame.type === "error") {
        if (o.json) {
          out(JSON.stringify(jsonFrame({ ...frame, retryable: false, ts: nowTs() })));
        }
        else console.error(`error: ${frame.code} ${frame.message}`);
        if (frame.code === "unauthorized") code = EXIT_AUTH;
        else if (frame.code === "loop_guard") code = EXIT_LOOP_GUARD;
        else if (frame.code === "archived") code = EXIT_ARCHIVED;
        else code = 1;
        break;
      }
      // 人为暂停/恢复（#180）：跟踪自己的 paused 状态（镜像 serve）。moderator 一按暂停/恢复，
      // DO 就广播这帧过来。提示走 stderr，不污染被消费的 stdout 流。
      if (frame.type === "presence" && frame.name === self) {
        const nextPaused = frame.paused === true;
        if (nextPaused !== selfPaused) {
          selfPaused = nextPaused;
          console.error(
            selfPaused
              ? `watch: 已被暂停接待——被 @ 也不再作为 --once 唤醒信号${typeof frame.resume_at === "number" ? `，将于 ${new Date(frame.resume_at).toISOString()} 恢复` : "（等人工恢复）"}。消息仍进历史。`
              : "watch: 已恢复接待——@ 重新作为唤醒信号。",
          );
        }
        continue;
      }
      const msg = frame.type === "message_update" ? frame.message : frame;
      if (msg.type !== "msg" && msg.type !== "status") continue;
      lastSeq = Math.max(lastSeq, msg.seq);
      const fromSelf = msg.sender.name === self;
      const qualifies = !fromSelf && (!o.mentionsOnly || msg.mentions.includes(self));
      // fresh = 游标之上的新消息。重放的历史修订快照（seq 早已消费过）会穿透去重进来
      // ——它们可以照常打印（展示编辑是 feature），但绝不能算「唤醒」（曾把 --once 假唤醒）
      const fresh = msg.seq > conn.cursor;
      // 暂停接待（#180）：qualifies 的新消息本该把 --once 退出当唤醒信号，但人按了暂停 →
      // 不退出、不发 once-wake 帧。消息仍照常打印进历史、游标照推进（下方 ack），与 serve 一致。
      // v1 下定向 @ 的 raw msg 仍是频道历史：可以展示并推进普通 transport cursor，但只有
      // 独立 delivery frame 才是 actionable wake。这样 raw broadcast + delivery 不会跑两次。
      const directedRaw = directedDeliveryMode && msg.mentions.includes(self);
      const wakes = fresh && !selfPaused && !directedRaw;
      // Claude Code 会在 turn boundary 回收 run_in_background watcher（#508）。旧逻辑先打印、
      // 再 ack 游标：后台结果若被 harness 吞掉，下一次 watch 已从更高游标开始，这条 @ 永久消失。
      // 因此先落一笔 durable debt，再打印、再推进 transport cursor。agent 后续发出任何消息/状态，
      // advanceCursorPastOwnMessage 才把 debt 清掉；如果模型没真正恢复，下次 --once 会先重放同一 seq。
      if (o.once && qualifies && wakes) {
        o.onStuck?.({
          seq: msg.seq,
          attempts: 0,
          last_error: "watch wake awaiting agent acknowledgement",
          source: "watch",
          channel_last_seq: lastSeq,
          skipped_mention_seqs: o.skippedMentionSeqs ?? [],
        });
      }
      if (qualifies) {
        if (o.json && o.once && wakes) {
          out(
            JSON.stringify(
              jsonFrame({
                ...(frame as unknown as Record<string, unknown>),
                channel_last_seq: lastSeq,
                lag: Math.max(0, lastSeq - msg.seq),
                skipped_mention_seqs: o.skippedMentionSeqs ?? [],
              }),
            ),
          );
        } else {
          out(o.json ? JSON.stringify(jsonFrame(frame as unknown as Record<string, unknown>)) : formatMsg(msg));
        }
        printed++;
        displayedMessageSeqs.add(msg.seq);
      }
      // 打印（或有意跳过）之后才推进游标，退出时入队未消费的消息留给下次补拉
      if (msg.seq > 0) conn.ack(msg.seq);
      if (o.statusline === true) {
        const latestSeq = Math.max(lastSeq, msg.seq);
        writeStatuslineCache({
          ...localStatuslineBase(o.channel),
          ...heartbeatPatch("watch", Date.now(), { mentionsOnly: o.mentionsOnly }),
          unread: unreadFromCursor(latestSeq, o.channel),
          last_message: lastMessageFromFrame(msg),
        });
      }
      // watch --follow 是流式在读整个频道：把已读游标回给服务端，agent 的已读状态因此成立（Phase 2）。
      // 只在 follow 下发；--once / 非 follow 是「查有没有 @ 我再退」的事件驱动路径，不算逐条已读，
      // 其送达/唤醒由 wake 回执表达（不假装 agent 逐条读了频道）。只对游标之上的新消息发。
      if (o.follow && fresh && msg.seq > 0) conn.send({ type: "seen", seq: msg.seq });
      // --once：第一条匹配的【新】消息即完成——游标已推进，进程退出就是 harness 的唤醒信号。
      // 服务端从游标开始重放，所以这条是**最旧**的未读 @，不是最新的（#199）。
      // 醒在最旧是对的（醒在最新会丢消息），但必须把落后量说出来：否则被唤醒的 agent
      // 会以为手上这条就是频道现状，照着几小时前的上下文回话，而身后还压着一摞没读的。
      // 暂停接待中被 @：不退出、不唤醒；发一条 stderr 提示交代这条 @ 已在历史里，恢复后自行补看。
      if (o.once && qualifies && fresh && selfPaused) {
        console.error(
          `watch: ⏸ 暂停接待中，seq=${msg.seq} 的 @ 不作为 --once 唤醒信号（消息已在历史）。` +
            ` 恢复后补看：party history ${o.channel} --since ${msg.seq}`,
        );
      }
      if (o.once && qualifies && wakes) {
        onceDone = true;
        const behind = Math.max(0, lastSeq - msg.seq);
        if (!o.json && behind > 0) {
          out(
            `watch: 唤醒于 seq=${msg.seq}（最旧的未读 @），落后 ${behind} 条，head=${lastSeq}。` +
              ` channel_last_seq=${lastSeq} lag=${behind} skipped_mention_seqs=${JSON.stringify(o.skippedMentionSeqs ?? [])}.` +
              ` 这不是最新消息——补上下文：party history ${o.channel} --since ${msg.seq}`,
          );
        } else if (!o.json) {
          out(
            `watch: channel_last_seq=${lastSeq} lag=0 skipped_mention_seqs=${JSON.stringify(o.skippedMentionSeqs ?? [])}`,
          );
        }
        break;
      }
      // 补拉排空（seq 追平 welcome.last_seq）且已有输出即视为收到新消息；自己的消息也参与排空判定
      if (!o.follow && !o.once && printed > 0 && msg.seq >= lastSeq) break;
    }
  } finally {
    lock?.release?.();
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    conn.close();
    if (o.statusline === true) clearStatuslineListener();
  }

  // 超时判定：--once 只有 onceDone 才算被唤醒（打印过重放的修订快照不算）；
  // 非 follow/once 沿用「打印过即成功」；follow 超时一律 TIMEOUT
  const unfulfilled = o.once === true ? !onceDone : printed === 0;
  if (timedOut && (o.follow || unfulfilled)) {
    out(o.json ? JSON.stringify(jsonFrame({ type: "timeout", channel: o.channel, timeout_sec: o.timeoutSec, ts: nowTs() })) : "TIMEOUT");
    return EXIT_TIMEOUT;
  }
  // --follow / 未完成的 --once：迭代器结束却既非超时也非终局 error，意味着连接层彻底放弃 /
  // 帧流意外中断。静默 return 0 会让 supervisor（或把退出当唤醒信号的 harness）误判为正常
  // 收尾（issue #29）。输出机器可读的退出原因并返回非零码，让上游能看到失败并重启。
  if ((o.follow || (o.once === true && !onceDone)) && !timedOut && code === 0) {
    if (o.json) {
      out(JSON.stringify(jsonFrame({ type: "watch_exited", reason: "stream_ended", channel: o.channel, ts: nowTs() })));
    } else {
      console.error("watch exited: stream ended unexpectedly");
    }
    return EXIT_STREAM_ENDED;
  }
  return code;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["follow", "once", "mentions-only", "exclude-self", "json", "allow-multiple", "latest"] });
  if (flags.follow === true && flags.once === true) {
    console.error("--follow and --once are mutually exclusive: follow keeps watching, once exits after the first match");
    return 1;
  }
  if (flags.latest === true && flags.since !== undefined) {
    console.error("--latest and --since are mutually exclusive");
    return 1;
  }
  if (flags.since === true) {
    console.error("--since requires a value");
    return 1;
  }
  const explicitSince = parseNonNegativeIntFlag(str(flags.since), "since");
  if (typeof explicitSince === "string") {
    console.error(explicitSince);
    return 1;
  }
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const cfg = { server: auth.server, token: auth.token };
  const unknown = unknownFlagError(flags, WATCH_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "timeout", "since"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const timeout = parsePositiveIntFlag(str(flags.timeout), "timeout", MAX_TIMEOUT_SEC);
  if (typeof timeout === "string") {
    console.error(timeout);
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
  if (flags.follow === true) console.error(FOLLOW_WAKE_ADVISORY);
  if (flags.once === true && isClaudeCodeEnv()) console.error(ONCE_CLAUDE_ADVISORY);
  else if (flags.once === true && isCodexRuntimeEnv()) console.error(ONCE_CODEX_ADVISORY);
  if (flags.once === true && flags.latest === true) console.error(ONCE_LATEST_ADVISORY);
  const localCursor = loadCursor(channel);
  const stuck = loadStuck(channel);
  // pending wake 比任何显式快进选择都优先。即使调用者误用 --latest，也不能先把仍未被模型
  // 确认的 @ 丢掉。REST 精确补拉后立即退出，避免重新挂起一个可能又被 harness 回收的后台任务。
  if (flags.once === true && stuck !== null) {
    if (stuck.source !== "watch") {
      console.error(
        `error: #${channel} has a pending serve wake at seq=${stuck.seq}; ` +
          "watch will not overwrite that delivery debt. Resume the existing party serve supervisor first.",
      );
      return 1;
    }
    // Directed debt 在 running ACK 前只是 unknown outcome。按旧 seq-only 路径直接重放会与
    // Worker 租约超时后的重新分配并发执行同一 work；保持 debt，重新注册等该 delivery 的新 claim。
    if (stuck.delivery_id !== undefined && stuck.delivery_acceptance !== "accepted") {
      console.error(
        `watch: directed delivery=${stuck.delivery_id} 尚未确认 running；不会本地回放 seq=${stuck.seq}，` +
          "正在重新挂接，等待服务端重新授予合法 claim。",
      );
    } else {
      try {
        const [pendingPage, tail] = await Promise.all([
          fetchMessages(cfg.server, cfg.token, channel, Math.max(0, stuck.seq - 1), 1),
          fetchRecentMessages(cfg.server, cfg.token, channel, 1),
        ]);
        const pending = pendingPage.find((msg) => msg.seq === stuck.seq);
        if (pending === undefined) {
          console.error(
            `error: pending watch wake seq=${stuck.seq} is no longer retained; debt was preserved. ` +
              `Inspect channel history before clearing or advancing this workspace state.`,
          );
          return 1;
        }
        const replay = { ...stuck, attempts: stuck.attempts + 1 };
        if (!saveWatchStuck(channel, replay)) {
          console.error(
            `error: #${channel} acquired a pending serve wake while replaying seq=${stuck.seq}; ` +
              "watch preserved that delivery debt and did not acknowledge this wake.",
          );
          return 1;
        }
        const channelLastSeq = Math.max(stuck.channel_last_seq ?? 0, tail.at(-1)?.seq ?? 0, pending.seq);
        const lag = Math.max(0, channelLastSeq - pending.seq);
        const skippedMentionSeqs = stuck.skipped_mention_seqs ?? [];
        if (flags.json === true) {
          console.log(
            JSON.stringify(
              jsonFrame({
                ...(pending as unknown as Record<string, unknown>),
                watch_replay: true,
                pending_ack: true,
                replay_attempt: replay.attempts,
                ...(stuck.delivery_id !== undefined ? { delivery_id: stuck.delivery_id } : {}),
                ...(stuck.work_id !== undefined ? { work_id: stuck.work_id } : {}),
                ...(stuck.continuation_ref !== undefined ? { continuation_ref: stuck.continuation_ref } : {}),
                ...(stuck.delivery_acceptance !== undefined
                  ? { delivery_acceptance: stuck.delivery_acceptance }
                  : {}),
                channel_last_seq: channelLastSeq,
                lag,
                skipped_mention_seqs: skippedMentionSeqs,
              }),
            ),
          );
        } else {
          console.log(
            `watch: replaying pending unacknowledged wake seq=${stuck.seq} attempt=${replay.attempts}; ` +
              (stuck.delivery_id !== undefined
                ? `delivery=${stuck.delivery_id}${stuck.work_id !== undefined ? ` work_id=${stuck.work_id}` : ""}${stuck.continuation_ref !== undefined ? ` continuation_ref=${stuck.continuation_ref}` : ""}; `
                : "") +
              `channel_last_seq=${channelLastSeq} lag=${lag} ` +
              `skipped_mention_seqs=${JSON.stringify(skippedMentionSeqs)}; ` +
              `send a reply/status after handling it to clear this debt.` +
              (lag > 0 ? ` 补上下文：party history ${channel} --since ${stuck.seq}` : ""),
          );
          console.log(formatMsg(pending));
        }
        if (flags.json !== true) console.error(ONCE_REARM_ADVISORY);
        return 0;
      } catch (e) {
        return handleRestError(e);
      }
    }
  }
  const initialLatest =
    localCursor === 0 &&
    explicitSince === undefined &&
    flags.latest !== true &&
    flags.once === true &&
    flags["mentions-only"] === true;
  let since = explicitSince ?? localCursor;
  let skippedMentionSeqs: number[] = [];
  if (flags.latest === true || initialLatest || (explicitSince !== undefined && explicitSince > localCursor)) {
    try {
      const selection = await resolveExplicitWatchCursor(
        cfg.server,
        cfg.token,
        channel,
        localCursor,
        flags.latest === true ? undefined : explicitSince,
      );
      since = selection.cursor;
      skippedMentionSeqs = selection.skippedMentionSeqs;
      saveCursor(channel, since);
      const attached = {
        type: "watch_attached",
        channel,
        attached_at_seq: since,
        ...(initialLatest ? { initial_cursor: "latest" } : {}),
        skipped_messages: selection.skippedMessages,
        skipped_mentions: skippedMentionSeqs.length,
        skipped_mention_seqs: skippedMentionSeqs,
      };
      console.log(
        flags.json === true
          ? JSON.stringify(jsonFrame(attached))
          : `watch: attached_at_seq=${since}${initialLatest ? " initial_cursor=latest" : ""} skipped_messages=${selection.skippedMessages} skipped_mentions=${skippedMentionSeqs.length} skipped_mention_seqs=${JSON.stringify(skippedMentionSeqs)}`,
      );
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("refusing to skip more than")) {
        console.error(`error: ${e.message}`);
        return 1;
      }
      return handleRestError(e);
    }
  }
  const code = await runWatch({
    server: cfg.server,
    token: cfg.token,
    channel,
    since,
    sinceRev: loadRevCursor(channel),
    timeoutSec: resolveWatchTimeoutSec(timeout, flags.follow === true || flags.once === true),
    follow: flags.follow === true,
    once: flags.once === true,
    mentionsOnly: flags["mentions-only"] === true,
    json: flags.json === true,
    skippedMentionSeqs,
    onStuck: (st) => {
      if (!saveWatchStuck(channel, st)) {
        throw new Error(
          `#${channel} has a pending serve wake; watch preserved that delivery debt and did not acknowledge this wake`,
        );
      }
    },
    onDirectedAccepted: (deliveryId) => markWatchDirectedStuckAccepted(channel, deliveryId),
    onCursor: (c) => saveCursor(channel, c),
    onRevCursor: (r) => saveRevCursor(channel, r),
    statusline: true,
    allowMultiple: flags["allow-multiple"] === true,
    advertise: () => advertiseWatchWake(auth, channel),
  });
  if (flags.once === true && flags.json !== true && code === 0) console.error(ONCE_REARM_ADVISORY);
  return code;
}
