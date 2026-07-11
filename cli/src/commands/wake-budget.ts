// party wake-budget（issue #108）——查看/设置某 agent 在频道里的 wake 预算（窗口内唤醒硬上限）。
// 背景：每个 @ 触发一次完整 runner run，会烧目标 agent 的 LLM 订阅/tokens；协议此前无任何总量上限。
// 设了预算后，窗口内已投 wake 达到 limit 的目标，再被 @ 也不投 webhook（不烧订阅），落 ledger 的
// budget 行 + 频道内 system status 可观测。缺省不设 = 不限（正常流）。
// 授权：agent 可给自己设（自我节流），moderator（房主 / ap_）可给任意 agent 设/清。
import { isHelpArg, num, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import { getWakeBudget, handleRestError, setWakeBudget } from "../rest";
import { isSlug } from "../validation";
import { parseDurationMs } from "./pause";

const FLAGS = ["channel", "limit", "window", "off"];
const HELP = `usage: party wake-budget <name> [channel|--channel C]
       party wake-budget <name> --limit N [--window <dur>] [channel|--channel C]
       party wake-budget <name> --off [channel|--channel C]

Inspect or set an agent's per-channel wake budget (issue #108). Every @-mention
triggers a full runner run that burns the target's LLM subscription. A wake budget
caps how many wakes an agent takes per rolling window; @-mentions beyond the cap are
withheld (webhook not fired, no tokens burned) and surfaced in-channel + the ledger.

Run with no flags to inspect. An agent may set its own budget; a channel moderator
may set/clear any agent's budget.

Options:
  --channel C    act on channel C instead of the bound channel
  --limit N      max wakes per window (positive integer). Sets the budget.
  --window D     rolling window: 30m / 2h / 1d / 90s (default 1h when omitted)
  --off          clear the budget (back to unlimited / normal flow)`;

function fmtWindow(ms: number | null): string {
  if (ms === null) return "-";
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["off"] });
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "limit", "window"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const name = positionals[0];
  if (!name) {
    console.error("usage: party wake-budget <name> [--limit N [--window D] | --off]");
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[1]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }

  const off = flags.off === true;
  const limitRaw = num(flags.limit);
  const windowStr = str(flags.window);
  const isSet = off || limitRaw !== undefined || windowStr !== undefined;

  try {
    // 无任何写入 flag → inspect
    if (!isSet) {
      const state = await getWakeBudget(cfg.server, cfg.token, channel, name);
      if (!state.enabled) {
        console.log(`${name}: no wake budget (unlimited)`);
        return 0;
      }
      const resets =
        state.window_resets_at === null ? "" : ` (window rolls at ${new Date(state.window_resets_at).toISOString()})`;
      console.log(
        `${name}: ${state.used}/${state.limit} wakes used per ${fmtWindow(state.window_ms)}, ${state.remaining} remaining${resets}`,
      );
      return 0;
    }

    if (off) {
      await setWakeBudget(cfg.server, cfg.token, channel, name, { enabled: false });
      console.log(`cleared wake budget for ${name} in ${channel} — back to unlimited`);
      return 0;
    }

    if (limitRaw === undefined || !Number.isInteger(limitRaw) || limitRaw <= 0) {
      console.error("invalid --limit: pass a positive integer, e.g. --limit 20");
      return 1;
    }
    let windowMs: number | undefined;
    if (windowStr !== undefined) {
      const parsed = parseDurationMs(windowStr);
      if (parsed === null || parsed <= 0) {
        console.error("invalid --window: use 30m / 2h / 1d / 90s");
        return 1;
      }
      windowMs = parsed;
    }
    const state = await setWakeBudget(cfg.server, cfg.token, channel, name, {
      enabled: true,
      limit: limitRaw,
      ...(windowMs === undefined ? {} : { window_ms: windowMs }),
    });
    console.log(
      `set wake budget for ${name} in ${channel}: ${state.limit} wakes per ${fmtWindow(state.window_ms)} — over-budget @-mentions are withheld`,
    );
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
