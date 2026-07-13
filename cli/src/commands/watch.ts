// party watch — 补拉错过消息，阻塞等新消息
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_LOOP_GUARD, EXIT_STREAM_ENDED, EXIT_TIMEOUT, type MsgFrame } from "@agentparty/shared";
import { dirname } from "node:path";
import { acquireInstanceLock } from "../instance-lock";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { connect } from "../client";
import { loadCursor, loadRevCursor, resolveChannel, saveCursor, saveRevCursor, statePath } from "../config";
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
const HELP = `usage: party watch [channel|--channel C] [--timeout N] [--mentions-only] [--exclude-self] [--follow|--once] [--latest|--since seq] [--json] [--allow-multiple]

Watch a channel for new messages. By default this waits up to 240 seconds.
With --follow, it stays attached unless --timeout N is explicit.
With --once, it stays attached until the FIRST matching message, prints it, and
exits 0 — made for harness background tasks (e.g. Claude Code run_in_background):
the process exit is the wake signal, so the mention lands in your EXISTING
session with its context intact.
For --mentions-only --once, an uninitialized cursor (0) attaches at the current
channel head to avoid replaying old mentions. Use --since 0 to request backlog.
Self messages are skipped by default; --exclude-self is accepted as an explicit
automation hint for scripts that want to document that behavior.
NOTE: --follow only PRINTS messages. Most harnesses (Codex included) never turn
background output into a new agent turn, so a mention can sit unread while you
look online. --once is only a wake layer when your harness proves that process
exit resumes the same agent session. Codex CLI does not; for Codex/unknown
harnesses keep a durable supervisor with:
  party serve <channel> --on-mention '<cmd>'
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
  "Prefer --once (exit = wake signal) or: party serve <channel> --on-mention '<cmd>'. " +
  "Verify from another identity: party wake test @<you>";

export const ONCE_CODEX_ADVISORY =
  "warning: Codex CLI does not resume a model turn just because `party watch --once` exits. " +
  "Use `party serve <channel> --on-mention '<codex exec resume ...; party send ...>'` " +
  "from a durable supervisor (tmux/launchctl/daemon), then verify with `party wake test @<you>`.";

export const ONCE_REARM_ADVISORY =
  "note: --once is single-shot. Re-arm it after handling this wake, or use `party serve` for Codex/unknown harnesses.";

/** Claude Code：后台任务退出即唤醒同一会话，watch --once 在它上面正常工作。 */
export function isClaudeCodeEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.CLAUDECODE !== undefined || Object.keys(env).some((key) => key.startsWith("CLAUDE_CODE_"));
}

export function isCodexRuntimeEnv(env: Record<string, string | undefined> = process.env): boolean {
  // Claude Code 优先短路（#175）：它装 codex 插件/companion 时 env 里也会有 CODEX_* 变量，
  // 但它的后台退出会唤醒——那条「Codex 不会唤醒你、改用 serve」的警告对它是反的。
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
  onCursor?: (cursor: number) => void;
  onRevCursor?: (revCursor: number) => void;
  out?: (line: string) => void;
  backoffBaseMs?: number;
  statusline?: boolean;
  /** 单实例锁目录（#195）。默认与 workspace state 同放；测试注入。 */
  lockDir?: string;
  /** 关掉单实例保护（逃生舱）。 */
  allowMultiple?: boolean;
  // watch 挂上（连上 WS、开始监听）后声明自己「有 watch 唤醒层」的钩子；run() 注入真实实现，测试可省略/替换。
  advertise?: () => Promise<void>;
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
  // 先抢锁，再连服务端：第二个 watcher 连 WS 都不该建，否则它已经开始消费 @ 了（#195）
  const lockDir = o.lockDir ?? dirname(statePath());
  const lock = o.allowMultiple === true ? null : acquireInstanceLock("watch", o.channel, lockDir);
  if (lock && !lock.ok) {
    out(
      `watch: 已有 watcher 挂在 #${o.channel} 上（pid ${lock.heldByPid}）。` +
        ` 再挂一个会让同一条 @ 触发 N 次唤醒——agent 会把同一条消息回 N 遍，并给 loop guard 上膛。` +
        ` 要么等它退出，要么 kill ${lock.heldByPid}；确实想并存请加 --allow-multiple。`,
    );
    return EXIT_ALREADY_WATCHING;
  }
  const conn = connect(o.server, o.token, o.channel, o.since, {
    onCursor: o.onCursor,
    sinceRev: o.sinceRev,
    onRevCursor: o.onRevCursor,
    backoffBaseMs: o.backoffBaseMs,
  });

  let self = "";
  let lastSeq = 0;
  let printed = 0;
  let timedOut = false;
  let onceDone = false;
  let code = 0;
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
      const wakes = fresh && !selfPaused;
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
  if (flags.once === true && isCodexRuntimeEnv()) console.error(ONCE_CODEX_ADVISORY);
  const localCursor = loadCursor(channel);
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
    onCursor: (c) => saveCursor(channel, c),
    onRevCursor: (r) => saveRevCursor(channel, r),
    statusline: true,
    allowMultiple: flags["allow-multiple"] === true,
    advertise: () => advertiseWatchWake(auth, channel),
  });
  if (flags.once === true && flags.json !== true && code === 0) console.error(ONCE_REARM_ADVISORY);
  return code;
}
