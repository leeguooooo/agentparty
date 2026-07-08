// party who — 从终端看频道里谁在线/可唤醒/最近，便于接着 party send --mention 把人拉进来/唤醒。
// Claude Code 原生 @ 只认本地文件/技能，塞不进远程动态列表；本命令就是那个「动态在线列表」。
import type { PresenceEntry, SenderKind, WakeKind } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import { fetchPresence, fetchReadCursors, handleRestError } from "../rest";
import { isSlug } from "../validation";

const WHO_FLAGS = ["channel", "json"];
const HELP = `usage: party who [channel|--channel C] [--json]

List who is in a channel, tiered by how you can reach them:
  ● online    connected right now
  ◐ wakeable  not connected, but @-mention will wake them (serve/watch/webhook)
  ○ recent    seen lately; mention delivers, wake not guaranteed
A "read #N / read ✓ / N behind" note shows how far a streaming reader (web, or an
agent on serve / watch --follow) has read. No note = not a line-by-line reader.
Then bring one in: party send "@name …" --mention name

Options:
  --channel C   read channel C instead of the bound channel
  --json        emit one JSON object per line (name/kind/tier/wake/age_ms/read_seq)`;

const WAKEABLE: readonly WakeKind[] = ["serve", "watch", "webhook"];
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
  age_ms: number;
  connection_count?: number;
  read_seq?: number; // 读到的最大 seq（Phase 2）；无游标 = 不逐帧流式读，不标注
}

// kind 已知取 kind；旧 presence 行没回填时 UUID 名判 human（网页登录会话），其余判 agent。
function kindOf(e: PresenceEntry): SenderKind {
  if (e.kind === "agent" || e.kind === "human") return e.kind;
  return SYSTEM_HUMAN_SESSION_RE.test(e.name) ? "human" : "agent";
}

// 返回该 presence 的候选行，或 null（离线人类 / 幽灵，不该列）。
function classify(e: PresenceEntry, now: number): Row | null {
  if (e.name === "system") return null;
  const seen = e.last_seen ?? e.ts ?? 0;
  const age = now - seen;
  const online = e.state !== "offline" && age < STALE_MS;
  const kind = kindOf(e);
  const wake = e.wake?.kind;
  let tier: Tier;
  if (online) tier = "online";
  else if (wake !== undefined && WAKEABLE.includes(wake) && age <= DEAD_MS) tier = "wakeable";
  else tier = "recent";
  if (tier !== "online") {
    if (kind === "human") return null; // 围观的人类只在线才列
    if (age > DEAD_MS) return null; // 幽灵清理
  }
  return {
    name: e.name,
    kind,
    tier,
    ...(wake === undefined ? {} : { wake }),
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
      const wake = r.tier === "wakeable" && r.wake ? ` ${r.wake}` : "";
      const age = r.tier === "online" ? "" : ` (${humanAge(r.age_ms)})`;
      const duplicate = r.connection_count !== undefined ? ` x${r.connection_count} sessions` : "";
      const read = readNote(r.read_seq, lastSeq);
      console.log(`${DOT[r.tier]} ${r.tier.padEnd(8)} ${r.name}  [${r.kind}]${wake}${read}${duplicate}${age}`);
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
