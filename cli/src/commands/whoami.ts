// party whoami — 打印当前身份，调 /api/me 验活
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_LOOP_GUARD } from "@agentparty/shared";
import { isHelpArg, parseArgs, unknownFlagError } from "../args";
import { handleRestError, fetchMe, RestError } from "../rest";
import { resolveAuthDetailed } from "../oidc-cli";
import { jsonFrame, nowTs } from "../json";
import { readConfig, resolveChannel, writeConfig } from "../config";
import { cachedIdentity, statuslineIdentity, writeStatuslineCache } from "../statusline-cache";

const WHOAMI_FLAGS = ["json", "caps", "rejoin"];
const HELP = `usage: party whoami [--json] [--caps] [--rejoin]

Print the current identity from /api/me.

Options:
  --json   emit a structured JSON frame
  --caps   print token capabilities and channel scope
  --rejoin print the config path/fingerprint needed to reuse this identity in a new session`;

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { flags } = parseArgs(argv, { booleans: ["json", "caps"] });
  const unknown = unknownFlagError(flags, WHOAMI_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const json = flags.json === true;
  const rejoin = flags.rejoin === true;
  let auth;
  try {
    auth = await resolveAuthDetailed();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (json) {
      console.log(JSON.stringify(jsonFrame({ type: "error", ts: nowTs(), code: "auth_error", message, error: message, retryable: false })));
    } else {
      console.error(`error: ${message}`);
    }
    return 1;
  }
  if (!auth.server || !auth.token) {
    if (json) {
      console.log(JSON.stringify(jsonFrame({
        type: "whoami",
        ts: nowTs(),
        logged_in: false,
        server: null,
        // issue #140：命令实际会打到哪台 server 是最要紧的字段，即便还没登录也不该缺失——
        // effective_server 是解析出来的落点（可能来自 config，即便没有可用 token），
        // account_server 单独给账号会话的 server，二者不该被合并成一个含糊的字段。
        effective_server: auth.server,
        account_server: auth.account.server ?? null,
        auth_source: auth.auth_source,
        account: auth.account,
        config: auth.config,
      })));
    } else {
      console.log("runtime: not logged in");
      console.log(`server: ${auth.server ?? "none (no config server and no account session)"}`);
      console.log(`account: ${auth.account.present ? `${auth.account.email ?? auth.account.sub ?? "present"} present server=${auth.account.server}` : `absent path=${auth.account.path}`}`);
      console.log(`config: ${auth.config.path ? `${auth.config.kind} ${auth.config.path}` : "none"}`);
      console.log(`auth-source: ${auth.auth_source}`);
    }
    return 0;
  }
  try {
    const me = await fetchMe(auth.server, auth.token);
    const boundChannel = resolveChannel() ?? null;
    const local = readConfig();
    if (local?.token) writeConfig({ ...local, identity: cachedIdentity(me) });
    writeStatuslineCache({
      ...(boundChannel === null ? {} : { channel: boundChannel }),
      server: auth.server,
      identity: statuslineIdentity(me),
    });
    const rejoinInfo =
      rejoin
        ? {
            config_kind: auth.config.kind,
            config_path: auth.config.path,
            token_fingerprint: auth.config.token_fingerprint ?? null,
            channel: boundChannel,
          }
        : null;
    if (json) {
      // 原样吐 /api/me（name/email/kind/role/owner…），供工具判身份/权限，免解析人类串
      console.log(JSON.stringify(jsonFrame({
        type: "whoami",
        ts: nowTs(),
        logged_in: true,
        server: auth.server,
        // issue #140：agent 不该靠解析 `account:` 那行的人话来判断落点——effective_server 是
        // /api/me 实际打的 server（与顶层 server 同值，换个不含糊的名字方便工具直接取），
        // account_server 是账号会话自己的 server，二者可能不同，分开给才不会被混用。
        effective_server: auth.server,
        account_server: auth.account.server ?? null,
        ...me,
        auth_source: auth.auth_source,
        runtime: {
          name: me.name,
          email: me.email,
          kind: me.kind,
          role: me.role,
          owner: me.owner,
          channel_scope: me.channel_scope ?? null,
        },
        account: auth.account,
        config: auth.config,
        ...(rejoinInfo === null ? {} : { rejoin: rejoinInfo }),
      })));
    } else {
      const who = me.email ?? me.name;
      // issue #140：这行是 agent 读 whoami 时最先看到的一行，生效 server 必须就在这里，
      // 不能只靠底下的 account: 行（那行印的是账号会话的 server，可能是另一台机器）。
      console.log(`runtime: logged in as ${who} (${me.kind}/${me.role}) server=${auth.server}`);
      if (me.owner) console.log(`  owner: ${me.owner}`);
      console.log(`  scope: ${me.channel_scope ?? "none (all channels)"}`);
      // account session 的 server 可能和生效 server 不是同一台（人类登录过另一台部署的常态），
      // 不标注清楚，agent 会把这行的 URL 误当成命令实际打到的地方。
      const accountServerMismatch =
        auth.account.present && auth.account.server !== undefined && auth.account.server !== auth.server;
      console.log(
        `account: ${
          auth.account.present
            ? `${auth.account.email ?? auth.account.sub ?? "present"} present server=${auth.account.server}${
                accountServerMismatch ? " (different server — not used for this command)" : ""
              }`
            : `absent path=${auth.account.path}`
        }`,
      );
      console.log(`config: ${auth.config.path ? `${auth.config.kind} ${auth.config.path} token=${auth.config.token_fingerprint ?? "none"}` : "none"}`);
      console.log(`auth-source: ${auth.auth_source}`);
      if (rejoin) {
        console.log("rejoin:");
        if (auth.config.path) {
          const prefix = `AGENTPARTY_CONFIG=${shellSingleQuote(auth.config.path)}`;
          console.log(`  config: ${auth.config.path}`);
          console.log(`  token: ${auth.config.token_fingerprint ?? "unknown fingerprint"} (not printed)`);
          if (boundChannel) console.log(`  channel: ${boundChannel}`);
          console.log(`  verify: ${prefix} party whoami --rejoin`);
          if (boundChannel) console.log(`  wait:   ${prefix} party watch ${boundChannel} --mentions-only --once`);
        } else {
          console.log("  no agent config file is active; this identity comes from the account session");
          console.log("  for a durable agent identity, mint an agent token and run party init with AGENTPARTY_CONFIG");
        }
        console.log("  if this config file is lost, mint a new agent token and revoke/remove the old identity");
      }
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
