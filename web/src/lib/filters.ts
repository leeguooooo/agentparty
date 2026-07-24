// 消息定位必须使用显式的 #<seq> 语法；裸数字可能就是用户要全文检索的正文，不能抢占为导航。
// 去掉外围空白后，仅接受 # + 正整数。前导零/超大值容错：Number 解析 + 有限正整数。
export function seqFromQuery(search: string): number | null {
  const trimmed = search.trim();
  const match = /^#(\d+)$/.exec(trimmed);
  if (match === null) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

export type AgentFilterMode = "only" | "except";
export type AgentFilterKind = "human" | "agent";

export interface AgentFilter {
  mode: AgentFilterMode;
  agents: string[];
  kind: AgentFilterKind | null;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function cleanAgents(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => NAME_RE.test(v)))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function cleanKind(value: string | null): AgentFilterKind | null {
  return value === "human" || value === "agent" ? value : null;
}

export function parseAgentFilter(search: string): AgentFilter {
  const params = new URLSearchParams(search);
  const rawAgents = params.getAll("agent").flatMap((value) => value.split(","));
  const mode = params.get("agentMode") === "except" ? "except" : "only";
  return { mode, agents: cleanAgents(rawAgents), kind: cleanKind(params.get("agentKind")) };
}

export function agentFilterSearch(filter: AgentFilter): string {
  const params = new URLSearchParams();
  if (filter.agents.length === 0 && filter.kind === null) return "";
  if (filter.agents.length > 0) {
    params.set("agent", filter.agents.join(","));
    if (filter.mode === "except") params.set("agentMode", "except");
  }
  if (filter.kind !== null) params.set("agentKind", filter.kind);
  return params.toString();
}

export function toggleAgent(filter: AgentFilter, agent: string): AgentFilter {
  const agents = filter.agents.includes(agent)
    ? filter.agents.filter((name) => name !== agent)
    : [...filter.agents, agent];
  return { ...filter, agents: cleanAgents(agents) };
}

export function setKind(filter: AgentFilter, kind: AgentFilterKind): AgentFilter {
  return { ...filter, kind: filter.kind === kind ? null : kind };
}

export function matchesAgentFilter(sender: { name: string; kind: "agent" | "human" }, filter: AgentFilter): boolean {
  if (filter.kind !== null && sender.kind !== filter.kind) return false;
  if (filter.agents.length === 0) return true;
  const selected = filter.agents.includes(sender.name);
  return filter.mode === "only" ? selected : !selected;
}

export function filterByAgent<T extends { sender: { name: string; kind: "agent" | "human" } }>(
  items: T[],
  filter: AgentFilter,
): T[] {
  if (filter.agents.length === 0 && filter.kind === null) return items;
  return items.filter((item) => matchesAgentFilter(item.sender, filter));
}
