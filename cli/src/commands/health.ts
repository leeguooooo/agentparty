// party health — 本地读探针（#254）：serve 落的 WS 健康快照，watchdog 用它替代裸 pgrep。
// 只读本机 health.json，不打网络请求——这就是它的价值：即便服务端/网络都不可达，也能就地判断
// "这个 serve 进程此刻是不是真的僵住了"。
import { isHelpArg, num, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readHealthCache } from "../health-cache";

const HEALTH_FLAGS = ["json", "channel", "stale-after"];
// > 2x ping 心跳周期（client.ts 默认 25s），容忍一次 pong 迟到还不算 stale。
const DEFAULT_STALE_AFTER_MS = 90_000;

const HELP = `usage: party health [--json] [--channel C] [--stale-after ms]

Print the local WS connection health for the \`party serve\` running in this workspace
(read from ~/.agentparty/state/<workspace>/health.json). Unlike \`pgrep\`, this proves the
socket is actually receiving server frames — not just that the process exists (issue #254).

Options:
  --json            machine-readable JSON output (adds age_ms, stale, healthy)
  --channel C       assert the record belongs to channel C (mismatch counts as unhealthy)
  --stale-after ms  treat last_frame_at older than this as unhealthy (default ${DEFAULT_STALE_AFTER_MS})

Exit codes: 0 healthy · 1 no health record (serve never ran here, or already exited) ·
            2 unhealthy (disconnected, reconnecting, channel mismatch, or stale)`;

export interface HealthReport {
  healthy: boolean;
  reason?: "no_health_record";
  age_ms?: number | null;
  stale?: boolean;
  pid?: number;
  channel?: string;
  ws_connected?: boolean;
  reconnecting?: boolean;
  reconnect_count?: number;
  last_frame_at?: number | null;
  last_error?: string | null;
  connected_since?: number | null;
  current_task?: number | null;
  task_started_at?: number | null;
  heartbeat_at?: number | null;
  updated_at?: number;
}

export function buildHealthReport(
  cache: ReturnType<typeof readHealthCache>,
  opts: { channel?: string; staleAfterMs: number; now?: number },
): HealthReport {
  if (cache === null) return { healthy: false, reason: "no_health_record" };
  const now = opts.now ?? Date.now();
  const age = cache.last_frame_at === null ? null : now - cache.last_frame_at;
  const stale = age === null || age > opts.staleAfterMs;
  const channelMismatch = opts.channel !== undefined && cache.channel !== opts.channel;
  const healthy = cache.ws_connected && !cache.reconnecting && !stale && !channelMismatch;
  return { ...cache, age_ms: age, stale, healthy };
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv)) {
    console.log(HELP);
    return 0;
  }
  const { flags } = parseArgs(argv, { booleans: ["json"] });
  const unknown = unknownFlagError(flags, HEALTH_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "stale-after"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const staleAfterFlag = num(flags["stale-after"]);
  if (flags["stale-after"] !== undefined && (staleAfterFlag === undefined || staleAfterFlag <= 0)) {
    console.error("--stale-after must be a positive number of milliseconds");
    return 1;
  }
  const staleAfterMs = staleAfterFlag ?? DEFAULT_STALE_AFTER_MS;
  const channel = str(flags.channel);

  const report = buildHealthReport(readHealthCache(), { channel, staleAfterMs });

  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return report.healthy ? 0 : report.reason === "no_health_record" ? 1 : 2;
  }

  if (report.reason === "no_health_record") {
    console.error("no health record — party serve hasn't written one in this workspace yet");
    return 1;
  }

  const now = Date.now();
  const ageS = report.age_ms === null || report.age_ms === undefined ? null : Math.round(report.age_ms / 1000);
  console.log(`pid:             ${report.pid}`);
  console.log(`channel:         ${report.channel}`);
  console.log(`ws_connected:    ${report.ws_connected}`);
  console.log(`reconnecting:    ${report.reconnecting}`);
  console.log(`reconnect_count: ${report.reconnect_count}`);
  console.log(`last_frame_at:   ${report.last_frame_at === null ? "(never)" : `${new Date(report.last_frame_at!).toISOString()} (${ageS}s ago)`}`);
  console.log(`last_error:      ${report.last_error ?? "(none)"}`);
  // 每任务进度/心跳（#228）：本机操作者一眼看到「正在跑 seq=X 的任务、心跳 Ns 前」，
  // 不必去 launchd/tmux 后台文件里翻 ▶ 和 runner log。空闲则不打印这行。
  if (report.current_task !== null && report.current_task !== undefined) {
    const hbAgeS =
      report.heartbeat_at === null || report.heartbeat_at === undefined
        ? null
        : Math.round((now - report.heartbeat_at) / 1000);
    const runS =
      report.task_started_at === null || report.task_started_at === undefined
        ? null
        : Math.round((now - report.task_started_at) / 1000);
    const hb = hbAgeS === null ? "(no heartbeat)" : `heartbeat ${hbAgeS}s ago`;
    const ran = runS === null ? "" : `, running ${runS}s`;
    console.log(`current_task:    seq=${report.current_task} (${hb}${ran})`);
  }

  if (channel !== undefined && report.channel !== channel) {
    console.log(`→ health stale for #${channel}: record belongs to #${report.channel}`);
  } else if (!report.ws_connected) {
    console.log(report.reconnecting ? `→ reconnecting (${report.reconnect_count} time(s) so far)` : "→ disconnected");
  } else if (report.stale) {
    console.log(`→ health stale; no frame in ${ageS}s (> ${Math.round(staleAfterMs / 1000)}s threshold); restart supervisor`);
  } else {
    console.log("→ connected");
  }

  return report.healthy ? 0 : 2;
}
