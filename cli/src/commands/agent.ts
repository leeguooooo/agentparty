// party agent add <name> — 账号会话自助铸一枚 agent token（owner=自己，由 worker 推导）
// party agent create <handle> — 保存一个可复用 project-agent profile（#50 foundation）
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readAccount } from "../account";
import { ensureFreshAccess } from "../oidc-cli";
import {
  createAgent,
  createProjectAgentProfile,
  handleRestError,
  listProjectAgentProfiles,
  RestError,
  type ProjectAgentInvitableBy,
  type ProjectAgentRunner,
  type ProjectAgentWorktreeStrategy,
} from "../rest";
import { isName, isSlug } from "../validation";

const AGENT_FLAGS = ["channel-scope", "name", "runner", "repo", "workdir", "base-branch", "worktree", "rules", "invitable-by"];
const RUNNERS = ["codex", "claude", "codex-sdk", "shell"] as const;
const WORKTREE = ["branch", "shared", "none"] as const;
const INVITABLE_BY = ["owner", "org", "anyone"] as const;
const HELP = `usage: party agent add <name> [--channel-scope slug]
       party agent create <handle> --runner codex|claude|codex-sdk|shell [--name n] [--repo url] [--workdir path] [--base-branch b] [--worktree branch|shared|none] [--rules text] [--invitable-by owner|org|anyone]
       party agent list

Mint one-off agent tokens or manage reusable project-agent profiles.

Options:
  --channel-scope slug   restrict the new token to one channel
  --runner r            project-agent runner
  --repo url            repository URL or local repo label for the project agent
  --workdir path        local working directory used by the daemon
  --base-branch b       base branch (default: main)
  --worktree mode       branch, shared, or none (default: branch)
  --rules text          fixed instruction text injected into the daemon profile
  --invitable-by mode   owner, org, or anyone (default: owner)`;

async function freshAccount(action: string): Promise<{ server: string; token: string } | null> {
  const sess = readAccount();
  if (!sess) {
    console.error(`${action} requires a human login; run party login`);
    return null;
  }
  try {
    const { session, token } = await ensureFreshAccess(sess);
    return { server: session.server, token };
  } catch {
    console.error(`${action} requires a human login; stored account session is expired or invalid; run party login`);
    return null;
  }
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, AGENT_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel-scope", "name", "runner", "repo", "workdir", "base-branch", "worktree", "rules", "invitable-by"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const sub = positionals[0];
  try {
    if (sub === "add") {
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
      const account = await freshAccount("agent add");
      if (!account) return 1;
      const res = await createAgent(account.server, account.token, name, channelScope);
      // 明文 token 只出现这一次
      console.log(JSON.stringify(res));
      // token 走 AGENTPARTY_TOKEN 环境变量传入，不进 argv：同机任意用户 `ps -axww` 看不到它（#676）。
      console.error(
        `give it to the agent (token via env, not argv): AGENTPARTY_TOKEN='${res.token}' party init --server ${account.server}`,
      );
      return 0;
    }

    if (sub === "create") {
      const handle = positionals[1];
      if (!handle || !isName(handle)) {
        console.error("usage: party agent create <handle> --runner codex|claude|codex-sdk|shell");
        return 1;
      }
      const runner = str(flags.runner);
      if (runner === undefined || !RUNNERS.includes(runner as (typeof RUNNERS)[number])) {
        console.error("--runner must be codex, claude, codex-sdk, or shell");
        return 1;
      }
      const worktree = str(flags.worktree);
      if (worktree !== undefined && !WORKTREE.includes(worktree as (typeof WORKTREE)[number])) {
        console.error("--worktree must be branch, shared, or none");
        return 1;
      }
      const invitableBy = str(flags["invitable-by"]);
      if (invitableBy !== undefined && !INVITABLE_BY.includes(invitableBy as (typeof INVITABLE_BY)[number])) {
        console.error("--invitable-by must be owner, org, or anyone");
        return 1;
      }
      const account = await freshAccount("agent create");
      if (!account) return 1;
      const profile = await createProjectAgentProfile(account.server, account.token, {
        handle,
        ...(str(flags.name) === undefined ? {} : { name: str(flags.name) }),
        runner: runner as ProjectAgentRunner,
        ...(str(flags.repo) === undefined ? {} : { repo_url: str(flags.repo) }),
        ...(str(flags.workdir) === undefined ? {} : { workdir: str(flags.workdir) }),
        ...(str(flags["base-branch"]) === undefined ? {} : { base_branch: str(flags["base-branch"]) }),
        ...(worktree === undefined ? {} : { worktree_strategy: worktree as ProjectAgentWorktreeStrategy }),
        ...(str(flags.rules) === undefined ? {} : { rules: str(flags.rules) }),
        ...(invitableBy === undefined ? {} : { invitable_by: invitableBy as ProjectAgentInvitableBy }),
      });
      console.log(`${profile.owner_account}/${profile.handle}\t${profile.runner}\t${profile.base_branch}\t${profile.worktree_strategy}`);
      return 0;
    }

    if (sub === "list") {
      const account = await freshAccount("agent list");
      if (!account) return 1;
      const profiles = await listProjectAgentProfiles(account.server, account.token);
      for (const p of profiles) {
        console.log(`${p.owner_account}/${p.handle}\t${p.runner}\t${p.base_branch}\t${p.worktree_strategy}\t${p.name}`);
      }
      return 0;
    }

    console.error("usage: party agent add|create|list");
    return 1;
  } catch (e) {
    if (e instanceof RestError && (e.status === 401 || e.status === 403)) {
      if (sub === "add") {
        console.error("agent add requires a human login; current account cannot mint agents; run party login");
      } else {
        console.error("agent command requires a human login; current account is not allowed; run party login");
      }
      return 1;
    }
    return handleRestError(e);
  }
}
