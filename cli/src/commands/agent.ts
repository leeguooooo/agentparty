// party agent add <name> — 账号会话自助铸一枚 agent token（owner=自己，由 worker 推导）
import { parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readAccount } from "../account";
import { ensureFreshAccess } from "../oidc-cli";
import { createAgent, handleRestError } from "../rest";
import { isName, isSlug } from "../validation";

const AGENT_FLAGS = ["channel-scope"];

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, AGENT_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel-scope"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const sub = positionals[0];
  if (sub !== "add") {
    console.error("usage: party agent add <name> [--channel-scope slug]");
    return 1;
  }
  const name = positionals[1];
  if (!name || !isName(name)) {
    console.error("usage: party agent add <name> [--channel-scope slug]");
    return 1;
  }
  const channelScope = str(flags["channel-scope"]);
  if (channelScope !== undefined && !isSlug(channelScope)) {
    console.error("--channel-scope must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const sess = readAccount();
  if (!sess) {
    console.error("not logged in, run: party login");
    return 1;
  }
  try {
    const { session, token } = await ensureFreshAccess(sess);
    const res = await createAgent(session.server, token, name, channelScope);
    // 明文 token 只出现这一次
    console.log(JSON.stringify(res));
    console.error(`give it to the agent: party init --server ${session.server} --token ${res.token}`);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
