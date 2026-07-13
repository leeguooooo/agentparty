// party who — 从终端看频道里谁在线/可唤醒/最近，便于接着 party send --mention 把人拉进来/唤醒。
// Claude Code 原生 @ 只认本地文件/技能，塞不进远程动态列表；本命令就是那个「动态在线列表」。
import { autoWakeReachable, type PresenceEntry, type SenderKind, type WakeKind, wakeableState } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import { fetchPresence, fetchReadCursors, handleRestError } from "../rest";
import { localStatuslineBase, unreadFromCursor, writeStatuslineCache } from "../statusline-cache";
import { isSlug } from "../validation";

const WHO_FLAGS = ["channel", "json"];
const HELP = `usage: party who [channel|--channel C] [--json]

List who is in a channel, tiered by how you can reach them:
  ● online    connected right now
  ◐ wakeable  not connected, but a wake layer means @-mention can still wake them.
              A watch --once agent is offline between wakes yet still wakeable —
              this is its normal standby, not "gone". Shown as verified/unverified:
                · wakeable verified    server-confirmed — webhook (server-delivered)
                                       or it was seen resuming after an @-mention
                · wakeable unverified  self-declared serve/watch the server has NOT
                                       verified — may or may not actually wake up
  ○ recent    seen lately, no wake layer; mention delivers, wake not guaranteed
A "⏳ busy" tag means the target is serially handling a wake (e.g. a long run): it
is reachable but a reply will be slow — an ask that times out means "busy", not
"offline", so do not re-@ it. "N queued" shows how many wakes are already waiting.
The verified/unverified split is server-authoritative and does NOT trust the wake
kind the client self-reports: prove a self-declared agent with: party wake test @name
A "read #N / read ✓ / N behind" note shows how far a streaming reader (web, or an
agent on serve / watch --follow) has read. No note = not a line-by-line reader.
Then bring one in: party send "@name …" --mention name
A human is @-notified by their handle (their web client matches on handle, not the
session name), so mention the "@handle" shown here — not a UUID session name.

Options:
  --channel C   read channel C instead of the bound channel
  --json        emit one JSON object per line
                (name/kind/tier/wake/wake_unverified/busy/queue_depth/current_task/task_started_at/heartbeat_at/account/handle/display_name/age_ms/read_seq)`;

const STALE_MS = 60_000; // 与 DO presence 扫描一致
const DEAD_MS = 14 * 24 * 60 * 60 * 1000; // 14 天没露面视为幽灵，不再列
// 系统生成的人类会话名（网页登录默认名 = UUID；OIDC 设备验证 = login-verify-*），非 @ 目标
const SYSTEM_HUMAN_SESSION_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|login-verify-.+)$/i;

type Tier = "online" | "wakeable" | "recent";
interface Row {
  name: string;
  kind: SenderKind;
  tier: Tier;
  wake?: WakeKind;
  // watch 型 wake 是自报的：presence 新鲜只证明 watcher 进程活着，不证明 harness 会因它的
  // 输出唤醒 agent（issue #55/#60 的假在线）。没有 wake 验证记录就如实标注，让调用方先
  // party wake test 再依赖。serve 有活的 supervisor、webhook 由服务端投递，不带此标记。
  wake_unverified?: true;
  age_ms: number;
  connection_count?: number;
  read_seq?: number; // 读到的最大 seq（Phase 2）；无游标 = 不逐帧流式读，不标注
  // 人为暂停接待（#180）：与 offline 视觉区分——不是「掉线丢了」，是「人主动按下暂停」。
  // 暂停期该 agent 被 @ 也不唤醒（webhook 不投、serve/watch 自我抑制），消息仍进历史。
  paused?: true;
  resume_at?: number; // 定时恢复时刻（epoch ms）；无则需手动恢复
  // 身份分层（#110）：presence 已带 account/handle/display_name，who 之前只吐 name，
  // 想 @ 一个人类的 agent 从 who 里看不到 handle——而 web 通知按 handle 命中，@ 名字送不到。
  // 这里原样带出（仅在 presence 给了非空值时），让 who 不再对已有身份信息保持沉默。
  account?: string; // 会话背后的账号（人类 = OIDC email；agent = owner）
  handle?: string; // 人类全局唯一 @别名；@ 通知的真正投递键（web notify 按 handle 命中）
  display_name?: string; // OAuth/SSO 展示名
  // busy（#103）：serve 正串行处理一条 wake，回复会慢。让人别把「@ 了没立刻回」误判成失联、反复 @。
  busy?: true;
  queue_depth?: number; // 忙时排在身后、尚未处理的 wake 数；>0 才带出
  // 每任务进度/心跳（#228）：正在处理哪条 wake（触发 seq）、何时开始、最近心跳。让频道区分
  // 「还在干、活到 T」与「卡死」——比裸 busy 更细。仅在有活跃任务时带出。
  current_task?: number;
  task_started_at?: number;
  heartbeat_at?: number;
}

// kind 已知取 kind；旧 presence 行没回填时 UUID 名判 human（网页登录会话），其余判 agent。
function kindOf(e: PresenceEntry): SenderKind {
  if (e.kind === "agent" || e.kind === "human") return e.kind;
  return SYSTEM_HUMAN_SESSION_RE.test(e.name) ? "human" : "agent";
}

// 返回该 presence 的候选行，或 null（离线人类 / 幽灵，不该列）。导出仅为单测。
export function classify(e: PresenceEntry, now: number): Row | null {
  if (e.name === "system") return null;
  const seen = e.last_seen ?? e.ts ?? 0;
  const age = now - seen;
  // online：与 web 一致以「当前有活 WS 连接」为准（#97 的 live）；无 live 信号时回退旧新鲜度启发式。
  const online = e.state !== "offline" && (e.live === true || age < STALE_MS);
  const kind = kindOf(e);
  const wake = e.wake?.kind;
  const paused = e.paused === true;
  // #191：非在线的 wake layer 判定。wakeableState 把「非在线」分成三档——
  //   offline（无 wake layer / human_driven）/ wakeable_unverified（自报 serve/watch 未经服务端验证）
  //   / wakeable_verified（webhook，或服务端观测到被 @ 后 resume 盖了 verified_at）。
  const wstate = wakeableState(e, now);
  const wakeReachable = autoWakeReachable(e, now, STALE_MS);
  let tier: Tier;
  if (online) tier = "online";
  // #454：wakeable 不只看历史声明，还必须有当前可达证据。serve/watch 的本地 listener 超过租约未续
  // 即降级 recent；webhook 由服务端投递，仍可离线 wakeable。避免被 harness kill 的 watch --once 永久假在线。
  else if (wstate !== "offline" && wakeReachable && age <= DEAD_MS) tier = "wakeable";
  else tier = "recent";
  if (tier !== "online") {
    // 暂停是人主动设的、有意保留的状态：不当人类/幽灵清掉，始终列出，让人看得见「谁被按了暂停」。
    if (!paused && kind === "human") return null; // 围观的人类只在线才列
    if (!paused && age > DEAD_MS) return null; // 幽灵清理
  }
  return {
    name: e.name,
    kind,
    tier,
    ...(paused ? { paused: true as const, ...(typeof e.resume_at === "number" ? { resume_at: e.resume_at } : {}) } : {}),
    ...(wake === undefined ? {} : { wake }),
    // #191：可唤醒但未经服务端验证（自报的 serve/watch，服务端从没观测到它被 @ 后 resume）如实标注。
    // 不再只针对 watch——serve 同样是自报，未验证就不该被默认信任（避免「自称可唤醒实则叫不醒」）。
    ...(tier === "wakeable" && wstate === "wakeable_unverified" ? { wake_unverified: true as const } : {}),
    // 身份分层（#110）：只在 presence 给了非空值时带出，缺失就省略（诚实留白，不无中生有）。
    ...(typeof e.account === "string" && e.account !== "" ? { account: e.account } : {}),
    ...(typeof e.handle === "string" && e.handle !== "" ? { handle: e.handle } : {}),
    ...(typeof e.display_name === "string" && e.display_name !== "" ? { display_name: e.display_name } : {}),
    // busy/queue_depth（#103）：仅在服务端标了 busy（目标可达且自报忙）时带出；离线态服务端本就不下发 busy。
    ...(e.busy === true ? { busy: true as const } : {}),
    ...(e.busy === true && typeof e.queue_depth === "number" && e.queue_depth > 0 ? { queue_depth: e.queue_depth } : {}),
    // 每任务进度/心跳（#228）：服务端只在 state != offline 且有活跃任务时下发 current_task，原样带出。
    ...(typeof e.current_task === "number"
      ? {
          current_task: e.current_task,
          ...(typeof e.task_started_at === "number" ? { task_started_at: e.task_started_at } : {}),
          ...(typeof e.heartbeat_at === "number" ? { heartbeat_at: e.heartbeat_at } : {}),
        }
      : {}),
    age_ms: age,
    ...(typeof e.connection_count === "number" && e.connection_count > 1
      ? { connection_count: e.connection_count }
      : {}),
  };
}

const RANK: Record<Tier, number> = { online: 0, wakeable: 1, recent: 2 };
const DOT: Record<Tier, string> = { online: "●", wakeable: "◐", recent: "○" };

// 已读标注：无游标不显示（诚实留白：该身份不逐帧流式读）；读到最新显示 ✓；落后显示读到第几条 + 差多少。
function readNote(readSeq: number | undefined, lastSeq: number): string {
  if (readSeq === undefined) return "";
  if (lastSeq > 0 && readSeq >= lastSeq) return " · read ✓";
  const behind = lastSeq - readSeq;
  return behind > 0 ? ` · read #${readSeq} (${behind} behind)` : ` · read #${readSeq}`;
}

// 身份分层（#110）：终端行里补出 @handle / account / 展示名，让人看得见「该 @ 哪个别名」。
// handle 是人类被 @ 通知的真正投递键（web notify 按 handle 命中），name 可能只是 UUID 会话名。
export function terminalIdentityText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();
}

export function identityNote(r: Row): string {
  const parts: string[] = [];
  const name = terminalIdentityText(r.name);
  if (r.handle !== undefined) {
    const handle = terminalIdentityText(r.handle);
    if (handle !== "" && handle !== name) parts.push(`@${handle}`);
  }
  if (r.display_name !== undefined) {
    const displayName = terminalIdentityText(r.display_name);
    if (displayName !== "") parts.push(displayName);
  }
  if (r.account !== undefined) {
    const account = terminalIdentityText(r.account);
    if (account !== "") parts.push(account);
  }
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

// busy 标注（#103）：目标可达但正串行处理一条 wake——「⏳ busy」或「⏳ busy · N queued」。
// 让人看懂「@ 了没立刻回」是忙、不是失联，别反复 @ 堆重复唤醒。
export function busyNote(r: Row): string {
  if (r.busy !== true) return "";
  const queued = r.queue_depth !== undefined && r.queue_depth > 0 ? ` · ${r.queue_depth} queued` : "";
  return ` · ⏳ busy${queued}`;
}

// 每任务进度/心跳标注（#228）：比 busy 更细——「▶ seq X」是正在处理哪条 wake，「♥ Ns」是心跳新鲜度。
// 心跳还在推进 = 活着；心跳很旧 = 大概率卡死（配合 live 一起看）。仅在有活跃任务时渲染。
export function taskNote(r: Row, now: number): string {
  if (typeof r.current_task !== "number") return "";
  const beat =
    typeof r.heartbeat_at === "number" ? ` · ♥ ${humanAge(Math.max(0, now - r.heartbeat_at))}` : " · ♥ (none)";
  return ` · ▶ seq ${r.current_task}${beat}`;
}

function humanAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"] });
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, WHO_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel"]);
  if (flagError !== null) {
    console.error(flagError);
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
  try {
    const presence = await fetchPresence(cfg.server, cfg.token, channel);
    // 已读游标尽力而为：老 worker 没这个端点会抛，降级为不标注（Phase 2 · CLI）。
    // 只有逐帧流式在读的身份（网页人 / serve / watch --follow 的 agent）才有游标；webhook/watch-once
    // 不逐条读，天然没有——不标注就是诚实。
    let cursorOf = new Map<string, number>();
    let lastSeq = 0;
    try {
      const rc = await fetchReadCursors(cfg.server, cfg.token, channel);
      lastSeq = rc.last_seq;
      cursorOf = new Map(rc.cursors.map((c) => [c.name, c.last_seen_seq]));
    } catch {
      /* 端点不存在 / 拉取失败：不标注已读，who 其余照常 */
    }
    writeStatuslineCache({
      ...localStatuslineBase(channel),
      ...(lastSeq > 0 ? { unread: unreadFromCursor(lastSeq, channel) } : {}),
    });
    const now = Date.now();
    const rows = presence
      .map((e) => classify(e, now))
      .filter((r): r is Row => r !== null)
      .map((r) => ({ ...r, read_seq: cursorOf.get(r.name) }))
      .sort((a, b) => RANK[a.tier] - RANK[b.tier] || a.name.localeCompare(b.name));
    if (flags.json === true) {
      for (const r of rows) console.log(JSON.stringify(r));
      return 0;
    }
    if (rows.length === 0) {
      console.log(`no one to mention in ${channel} yet`);
      return 0;
    }
    for (const r of rows) {
      const read = readNote(r.read_seq, lastSeq);
      const duplicate = r.connection_count !== undefined ? ` x${r.connection_count} sessions` : "";
      // 暂停接待（#180）：独立的 ⏸ 行，与 offline 视觉区分。带上定时/手动恢复提示，一眼看清何时回来。
      if (r.paused === true) {
        const resume =
          typeof r.resume_at === "number"
            ? ` · resumes in ${humanAge(Math.max(0, r.resume_at - now))}`
            : " · resume manually";
        console.log(`⏸ ${"paused".padEnd(8)} ${r.name}  [${r.kind}]${identityNote(r)}${resume}${read}${duplicate}`);
        continue;
      }
      // #191：可唤醒行明确标出「已验证 / 未验证」——verified＝服务端确认过（webhook，或观测到被 @ 后 resume），
      // unverified＝仅自报、服务端没验证过，别当它一定叫得醒。
      const wake =
        r.tier === "wakeable"
          ? ` · ${r.wake_unverified === true ? "unverified" : "verified"}${r.wake ? ` (${r.wake})` : ""}`
          : "";
      const age = r.tier === "online" ? "" : ` (${humanAge(r.age_ms)})`;
      console.log(`${DOT[r.tier]} ${r.tier.padEnd(8)} ${r.name}  [${r.kind}]${identityNote(r)}${busyNote(r)}${taskNote(r, now)}${wake}${read}${duplicate}${age}`);
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
