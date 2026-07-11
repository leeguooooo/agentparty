// party membership — owner 手动开通会员（#277 骨架）。需要 ADMIN_SECRET 环境变量。
// 申请走邮件（网页 mailto → leeguooooo@gmail.com）；owner 收到后用这个命令把账号翻成 member/free。
// 本次不接支付、不 gate 任何功能——只把「谁是会员」落库，供将来的 feature-tier 清单消费。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig } from "../config";
import { handleRestError, setMembership } from "../rest";
import { normalizeServerUrl } from "../validation";

const MEMBERSHIP_FLAGS = ["server", "account"];
const HELP = `usage: party membership activate --account <account>
       party membership deactivate --account <account>

Owner-only membership toggle (#277). Requires ADMIN_SECRET.
Applications come in by email (leeguooooo@gmail.com); use this to activate manually.

Subcommands:
  activate     mark the account a member (records member_since)
  deactivate   downgrade the account back to free

Options:
  --server URL     AgentParty server URL
  --account a      the account (email/principal) to change`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, MEMBERSHIP_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server", "account"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const sub = positionals[0];
  if (sub !== "activate" && sub !== "deactivate") {
    console.error("usage: party membership activate|deactivate --account <account>");
    return 1;
  }
  const account = str(flags.account) ?? positionals[1];
  if (!account || account.trim() === "") {
    console.error("--account required");
    return 1;
  }
  const cfg = readConfig();
  const server = normalizeServerUrl(str(flags.server) ?? cfg?.server ?? "");
  if (!server) {
    console.error("no valid server, run party init or pass --server");
    return 1;
  }
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.error("ADMIN_SECRET env var required");
    return 1;
  }
  const tier = sub === "activate" ? "member" : "free";
  try {
    const res = await setMembership(server, adminSecret, account.trim(), tier);
    console.log(JSON.stringify(res));
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
