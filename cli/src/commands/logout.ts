// party logout — 删账号会话凭据（config.json 的 ap_ token 不动）
import { isHelpArg, parseArgs, unknownFlagError } from "../args";
import { clearAccount } from "../account";

const HELP = `usage: party logout

Clear the stored account session. Workspace agent tokens are not removed.`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, []);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const existed = clearAccount();
  console.log(existed ? "logged out" : "not logged in");
  return 0;
}
