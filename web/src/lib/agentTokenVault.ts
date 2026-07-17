const VAULT_KEY = "ap_agent_token_vault:v1";

export interface AgentTokenRecord {
  account: string;
  slug: string;
  name: string;
  token: string;
  command: string;
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
    typeof rec.savedAt === "number"
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

// snippet 里保底的 CLI 版本：低于它就强制重装。AgentJoin 的完整接入包与下面的桌面最小
// 接入包共用这一份，防止两处漂移。发布带 CLI 行为变更的版本时同步上调。
// 0.2.124：接入包 MCP-first，依赖 party mcp 的 party_decision_ask 与 party_send attach
//（不能写 0.2.123——该版已从 #579 发布、不含这两个工具，锁它会让过闸的 CLI 缺工具）。
export const MIN_CLI = "0.2.124";

// 与 AgentJoin 完整接入包同一份 awk 三段版本比较；桌面最小包也要过版本闸，
// 只查 command -v 会放过装着旧版、缺 MCP 工具的机器。
export const VERSION_GE_SNIPPET =
  `version_ge(){ awk -v a="$1" -v b="$2" 'BEGIN{split(a,A,".");split(b,B,".");for(i=1;i<=3;i++){A[i]+=0;B[i]+=0;if(A[i]>B[i])exit 0;if(A[i]<B[i])exit 1}exit 0}'; }`;

// MCP server 注册名必须按 agent 唯一：同一目录跑多个 agent 时，固定叫 `party` 会让后注册的
// 覆盖先注册的身份 env——重启会话后静默串号（比 CLI 忘带前缀更难察觉）。agent 名本身是
// NAME_RE 约束的 ASCII，但 `.` 在 Codex 的 TOML 键等处不安全，消毒成 `-`；消毒有损时
//（a.b 与 a-b 会同形）追加原名短哈希保持单射，别让「防覆盖」的改动自己引入新的覆盖面。
export function mcpServerName(agentName: string): string {
  const cleaned = agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (cleaned === agentName) return `party-${agentName}`;
  let h = 5381;
  for (let i = 0; i < agentName.length; i += 1) h = (Math.imul(h, 33) ^ agentName.charCodeAt(i)) >>> 0;
  return `party-${cleaned}-${h.toString(36)}`;
}

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
    `party init --server ${input.server} --token ${input.token} --channel ${input.slug}`,
    `party send "${input.checkinMessage}" --channel ${input.slug} --mention ${input.inviterName}`,
    "# Register the AgentParty MCP server with your harness, then use the party_* tools (party_send / party_status / party_history / party_decision_ask ...) for all channel actions — they carry your identity automatically, no AGENTPARTY_CONFIG prefix needed per command:",
    `claude mcp add ${mcpName} --env AGENTPARTY_CONFIG="${configPath}" -- party mcp --channel ${input.slug}`,
    `# Codex: codex mcp add ${mcpName} --env AGENTPARTY_CONFIG="${configPath}" -- party mcp --channel ${input.slug}`,
    "# Non-MCP harnesses: keep using the party CLI with the AGENTPARTY_CONFIG prefix on every command.",
  ].join("\n");
}
