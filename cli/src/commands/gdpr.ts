// party gdpr erase|export（issue #421）——按身份的数据保留/合规入口。
// 跨公司频道里，A 公司的 agent 可能误贴密钥 / 客户 PII。撤回（#196）只清单条消息正文，清不掉审计/账本的
// 身份维度，也没有「彻底抹除某身份可归因内容」的口子。这里补上：
//   erase   物理删除该身份在频道 message_audit/wake 账本/读游标/presence 的可识别行 + 抹掉其消息正文/归属 PII。
//   export  只读导出该身份在频道可归因的全部数据（数据可携 / 出境审查）。
// 授权同 kick/pause：仅频道 moderator（房主 / ap_ token）。erase 不可逆，默认要 --yes 确认。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import { eraseIdentityData, exportIdentityData, handleRestError } from "../rest";
import { isSlug } from "../validation";

const GDPR_FLAGS = ["channel", "yes", "json"];
const HELP = `usage: party gdpr erase <name> [channel|--channel C] [--yes]
       party gdpr export <name> [channel|--channel C] [--json]

Per-identity data retention / compliance entry point (moderator only, issue #421).

  erase   Physically delete an identity's identifiable rows in this channel
          (message_audit / wake ledger / read cursors / presence) AND scrub the
          bodies + attribution PII of messages it authored to [erased].
          Irreversible — requires --yes.
  export  Read-only dump of everything attributable to the identity in this
          channel (messages + audit + wake deliveries + read cursor + presence).

Options:
  --channel C   act on channel C instead of the bound channel
  --yes         confirm the (irreversible) erase without prompting
  --json        (export) print the raw JSON dump`;

function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const sub = argv[0];
  if (sub !== "erase" && sub !== "export") {
    console.error("usage: party gdpr erase|export <name> [channel] [--yes|--json]");
    return 1;
  }
  const { positionals, flags } = parseArgs(argv.slice(1), { booleans: ["yes", "json"] });
  const unknown = unknownFlagError(flags, GDPR_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const name = positionals[0];
  if (!name) {
    console.error(`usage: party gdpr ${sub} <name> [channel]`);
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

  try {
    const shownName = terminalSafe(name);
    if (sub === "export") {
      const data = await exportIdentityData(cfg.server, cfg.token, channel, name);
      if (flags.json === true) {
        console.log(JSON.stringify(data, null, 2));
        return 0;
      }
      console.log(`data for ${shownName} in ${channel}:`);
      console.log(`  messages:        ${data.messages.length}`);
      console.log(`  audit rows:      ${data.audit.length}`);
      console.log(`  wake deliveries: ${data.wake_deliveries.length}`);
      console.log(`  read cursor:     ${data.read_cursor ? "yes" : "none"}`);
      console.log(`  presence rows:   ${data.presence.length}`);
      console.log("re-run with --json for the full dump");
      return 0;
    }
    // erase：不可逆，要 --yes
    if (flags.yes !== true) {
      console.error(
        `refusing to erase without confirmation.\n` +
          `  this PHYSICALLY deletes ${shownName}'s identifiable data in ${channel} and scrubs its message bodies to [erased].\n` +
          `  re-run with --yes to proceed: party gdpr erase -- ${shownName} ${channel} --yes`,
      );
      return 1;
    }
    const summary = await eraseIdentityData(cfg.server, cfg.token, channel, name);
    console.log(`erased ${shownName} from ${channel}:`);
    console.log(`  messages scrubbed:    ${summary.messages_scrubbed}`);
    console.log(`  audit rows deleted:   ${summary.audit_deleted}`);
    console.log(`  wake ledger deleted:  ${summary.wake_ledger_deleted}`);
    console.log(`  read cursors deleted: ${summary.read_cursors_deleted}`);
    console.log(`  presence deleted:     ${summary.presence_deleted}`);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
