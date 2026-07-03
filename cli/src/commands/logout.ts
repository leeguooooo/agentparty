// party logout — 删账号会话凭据（config.json 的 ap_ token 不动）
import { clearAccount } from "../account";

export async function run(_argv: string[]): Promise<number> {
  const existed = clearAccount();
  console.log(existed ? "logged out" : "not logged in");
  return 0;
}
