// party whoami — 打印当前身份，调 /api/me 验活
import { handleRestError, fetchMe } from "../rest";
import { resolveAuth } from "../oidc-cli";

export async function run(_argv: string[]): Promise<number> {
  let auth;
  try {
    auth = await resolveAuth();
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!auth) {
    console.log("not logged in");
    return 0;
  }
  try {
    const me = await fetchMe(auth.server, auth.token);
    const who = me.email ?? me.name;
    console.log(`logged in as ${who} (${me.kind}/${me.role})`);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
