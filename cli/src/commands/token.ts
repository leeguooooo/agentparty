// party token create — 需要 ADMIN_SECRET 环境变量
import type { TokenRole } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig } from "../config";
import { createToken, handleRestError, revokeToken } from "../rest";
import { isName, isSlug, normalizeServerUrl } from "../validation";

const ROLES: TokenRole[] = ["agent", "human", "readonly"];
const TOKEN_FLAGS = ["server", "name", "role", "owner", "channel-scope"];
const OWNER_MAX = 128;
const OWNER_RE = /^[\x20-\x7e]{1,128}$/;
const HELP = `usage: party token create --name n --role agent|human|readonly --owner label [--channel-scope slug]
       party token revoke <name>

Admin-only token management. Requires ADMIN_SECRET.

Options:
  --server URL           AgentParty server URL
  --name n               token name
  --role role            agent, human, or readonly
  --owner label          printable owner label (required for create)
  --channel-scope slug   restrict token to one channel`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, TOKEN_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server", "name", "role", "owner", "channel-scope"]);
  if (flagError !== null) {
    console.error(flagError);
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
  const sub = positionals[0];
  try {
    switch (sub) {
      case "create": {
        const name = str(flags.name);
        const role = str(flags.role) ?? "agent";
        const owner = str(flags.owner);
        const channelScope = str(flags["channel-scope"]);
        if (!name || !ROLES.includes(role as TokenRole)) {
          console.error(
            "usage: party token create --name n --role agent|human|readonly --owner label [--channel-scope slug]",
          );
          return 1;
        }
        if (!isName(name)) {
          console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
          return 1;
        }
        // owner 必填：P1 起新 token 一律有账号归属（spec §6 修复3），缺则本地早退不发请求
        if (owner === undefined) {
          console.error("--owner required (token must have an account owner)");
          return 1;
        }
        if (owner.length > OWNER_MAX || !OWNER_RE.test(owner)) {
          console.error(`--owner must be printable ascii, <= ${OWNER_MAX} chars`);
          return 1;
        }
        if (channelScope !== undefined && !isSlug(channelScope)) {
          console.error("--channel-scope must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const res = await createToken(server, adminSecret, name, role as TokenRole, owner, channelScope);
        // 明文 token 只出现这一次
        console.log(JSON.stringify(res));
        return 0;
      }
      case "revoke": {
        const name = str(flags.name) ?? positionals[1];
        if (!name) {
          console.error("usage: party token revoke <name>");
          return 1;
        }
        if (!isName(name)) {
          console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
          return 1;
        }
        await revokeToken(server, adminSecret, name);
        console.log(`revoked ${name}`);
        return 0;
      }
      default:
        console.error("usage: party token create|revoke");
        return 1;
    }
  } catch (e) {
    return handleRestError(e);
  }
}
