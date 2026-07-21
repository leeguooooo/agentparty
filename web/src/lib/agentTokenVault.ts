import { AGENT_NAME_RE, mcpServerName } from "@agentparty/shared/onboarding";
import { type JoinPackMode, MIN_CLI, VERSION_GE_SNIPPET } from "./joinPack";

const VAULT_KEY = "ap_agent_token_vault:v1";

export interface AgentTokenRecord {
  account: string;
  slug: string;
  name: string;
  token: string;
  command: string;
  /** #612：生成时选的接入方式；「复制接入包」按它重建同款。缺省（旧记录）按 interactive。 */
  mode?: JoinPackMode;
  savedAt: number;
}

function readAll(): AgentTokenRecord[] {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is AgentTokenRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.account === "string" &&
    typeof rec.slug === "string" &&
    typeof rec.name === "string" &&
    typeof rec.token === "string" &&
    typeof rec.command === "string" &&
    typeof rec.savedAt === "number" &&
    (rec.mode === undefined || rec.mode === "interactive" || rec.mode === "unattended")
  );
}

function writeAll(records: AgentTokenRecord[]) {
  localStorage.setItem(VAULT_KEY, JSON.stringify(records));
}

export function listSavedAgentTokens(account: string, slug: string): AgentTokenRecord[] {
  return readAll()
    .filter((rec) => rec.account === account && rec.slug === slug)
    .sort((a, b) => b.savedAt - a.savedAt || a.name.localeCompare(b.name));
}

export function findSavedAgentToken(account: string, slug: string, name: string): AgentTokenRecord | null {
  return readAll().find((rec) => rec.account === account && rec.slug === slug && rec.name === name) ?? null;
}

export function saveAgentToken(record: AgentTokenRecord) {
  const rest = readAll().filter(
    (rec) => !(rec.account === record.account && rec.slug === record.slug && rec.name === record.name),
  );
  writeAll([record, ...rest].slice(0, 200));
}

export function removeSavedAgentToken(account: string, slug: string, name: string) {
  writeAll(readAll().filter((rec) => !(rec.account === account && rec.slug === slug && rec.name === name)));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall back to execCommand below. */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// MIN_CLI / version_ge 真值搬进 joinPack（完整包 builder 所在地），这里 re-export 保住既有
// 消费者；桌面最小包与完整包仍共用同一份，防两处漂移。版本上调历史见 joinPack 注释。
export { MIN_CLI, VERSION_GE_SNIPPET } from "./joinPack";

// MCP server 注册名规则挪到 shared 与 cli 的 party invite 共用一份（#585）；语义与来由见那边注释。
export { mcpServerName } from "@agentparty/shared/onboarding";

export function buildMinimalAgentCommand(input: {
  server: string;
  slug: string;
  name: string;
  token: string;
  inviterName: string;
  checkinMessage: string;
}): string {
  const configPath = `$HOME/.agentparty/agents/agentparty-${input.name}-${input.slug}.json`;
  const mcpName = mcpServerName(input.name);
  // #597：inviter 是 account id（lark:on_xxx）时 --mention 会被 CLI 拒绝，降级为不 @。
  const checkin = AGENT_NAME_RE.test(input.inviterName)
    ? `party send "${input.checkinMessage}" --channel ${input.slug} --mention ${input.inviterName}`
    : `party send "${input.checkinMessage}" --channel ${input.slug}`;
  return [
    `# AgentParty onboarding scope: join the existing channel #${input.slug} using only the supplied party commands.`,
    "# Do not create or select another channel; do not use third-party or project-local channel workflows (for example, Trellis); do not delegate onboarding.",
    "# After onboarding, you are the front agent with three responsibilities: (1) stay in the main channel and communicate with its members; (2) communicate with the owner for permissions, trade-offs, and decisions; (3) dispatch work to sub-agents/workers, follow up, accept their evidence, and synthesize results.",
    "# Code changes, multi-step investigation, browser/ops, and other long-running execution MUST go to a harness sub-agent/worker; it reports evidence/results back to you. If the harness cannot create one, report blocked instead of doing worker work yourself.",
    "",
    `export PATH="$HOME/.local/bin:$PATH"`,
    VERSION_GE_SNIPPET,
    `need=${MIN_CLI}; have="$(party --version 2>/dev/null || echo 0)"; version_ge "$have" "$need" || curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh`,
    `export AGENTPARTY_CONFIG="${configPath}"`,
    // #676: pass the token via AGENTPARTY_TOKEN (env), never in argv — `ps -axww` can't see it and it
    // doesn't trip party init's own "--token leaks into argv/history" warning (strictest: `--token -` via stdin).
    `AGENTPARTY_TOKEN='${input.token}' party init --server ${input.server} --channel ${input.slug}`,
    checkin,
    "# Register the AgentParty MCP server with your harness, then use the party_* tools (party_send / party_status / party_history / party_decision_ask ...) for all channel actions — they carry your identity automatically, no AGENTPARTY_CONFIG prefix needed per command:",
    `claude mcp add ${mcpName} --env AGENTPARTY_CONFIG="${configPath}" -- party mcp --channel ${input.slug}`,
    `# Codex: codex mcp add ${mcpName} --env AGENTPARTY_CONFIG="${configPath}" -- party mcp --channel ${input.slug}`,
    "# Non-MCP harnesses: keep using the party CLI with the AGENTPARTY_CONFIG prefix on every command.",
  ].join("\n");
}
