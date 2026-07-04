// party whoami — 打印当前身份，调 /api/me 验活
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_LOOP_GUARD } from "@agentparty/shared";
import { parseArgs, unknownFlagError } from "../args";
import { handleRestError, fetchMe, RestError } from "../rest";
import { resolveAuth } from "../oidc-cli";
import { jsonFrame, nowTs } from "../json";

const WHOAMI_FLAGS = ["json", "caps"];

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, { booleans: ["json", "caps"] });
  const unknown = unknownFlagError(flags, WHOAMI_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const json = flags.json === true;
  let auth;
  try {
    auth = await resolveAuth();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (json) {
      console.log(JSON.stringify(jsonFrame({ type: "error", ts: nowTs(), code: "auth_error", message, error: message, retryable: false })));
    } else {
      console.error(`error: ${message}`);
    }
    return 1;
  }
  if (!auth) {
    if (json) console.log(JSON.stringify(jsonFrame({ type: "whoami", ts: nowTs(), logged_in: false, server: null })));
    else console.log("not logged in");
    return 0;
  }
  try {
    const me = await fetchMe(auth.server, auth.token);
    if (json) {
      // 原样吐 /api/me（name/email/kind/role/owner…），供工具判身份/权限，免解析人类串
      console.log(JSON.stringify(jsonFrame({ type: "whoami", ts: nowTs(), logged_in: true, server: auth.server, ...me })));
    } else {
      const who = me.email ?? me.name;
      console.log(`logged in as ${who} (${me.kind}/${me.role})`);
      // --caps：把 token 能干什么摊开，免得撞 403 才知道没权限（scoped token 尤其容易懵）
      if (flags.caps) {
        const scope = me.channel_scope ?? null;
        console.log(`  scope: ${scope ?? "none (all channels)"}`);
        const yn = (b: boolean | undefined) => (b ? "yes" : "no");
        if (me.caps) {
          console.log(
            `  can: send=${yn(me.caps.send)} create-channel=${yn(me.caps.create_channel)} mint-agents=${yn(me.caps.mint_agents)}`,
          );
        } else {
          console.log("  caps: server too old (no caps in /api/me); upgrade server");
        }
      }
    }
    return 0;
  } catch (e) {
    if (json) {
      if (e instanceof RestError) {
        const code = e.code ?? String(e.status);
        console.log(JSON.stringify(jsonFrame({ type: "error", ts: nowTs(), code, message: e.message, error: e.message, retryable: e.status >= 500 })));
        if (e.status === 401) return EXIT_AUTH;
        if (e.code === "loop_guard") return EXIT_LOOP_GUARD;
        if (e.code === "archived") return EXIT_ARCHIVED;
        return 1;
      }
      const message = e instanceof Error ? e.message : String(e);
      console.log(JSON.stringify(jsonFrame({ type: "error", ts: nowTs(), code: "error", message, error: message, retryable: false })));
      return 1;
    }
    return handleRestError(e);
  }
}
