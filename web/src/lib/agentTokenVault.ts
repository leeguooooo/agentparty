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

export function buildMinimalAgentCommand(input: {
  server: string;
  slug: string;
  name: string;
  token: string;
  inviterName: string;
  checkinMessage: string;
}): string {
  return [
    `export PATH="$HOME/.local/bin:$PATH"; command -v party >/dev/null || curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh`,
    `export AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${input.name}-${input.slug}.json"`,
    `party init --server ${input.server} --token ${input.token} --channel ${input.slug}`,
    `party send "${input.checkinMessage}" --channel ${input.slug} --mention ${input.inviterName}`,
  ].join("\n");
}
