import { describe, expect, test } from "bun:test";
import {
  agentFilterSearch,
  filterByAgent,
  matchesAgentFilter,
  parseAgentFilter,
  seqFromQuery,
  setKind,
  toggleAgent,
  type AgentFilter,
} from "./filters";

describe("agent filters", () => {
  test("parses deep-link filters from csv and repeated params", () => {
    expect(parseAgentFilter("?agent=bob,alice&agent=alice&agentMode=except")).toEqual({
      mode: "except",
      agents: ["alice", "bob"],
      kind: null,
    });
  });

  test("ignores invalid names and defaults to only mode", () => {
    expect(parseAgentFilter("?agent=ok&agent=bad/name&agentMode=wat")).toEqual({
      mode: "only",
      agents: ["ok"],
      kind: null,
    });
  });

  test("parses agentKind from url, ignoring unknown values", () => {
    expect(parseAgentFilter("?agentKind=human")).toEqual({ mode: "only", agents: [], kind: "human" });
    expect(parseAgentFilter("?agentKind=agent")).toEqual({ mode: "only", agents: [], kind: "agent" });
    expect(parseAgentFilter("?agentKind=robot")).toEqual({ mode: "only", agents: [], kind: null });
    expect(parseAgentFilter("")).toEqual({ mode: "only", agents: [], kind: null });
  });

  test("serializes only and except modes", () => {
    expect(agentFilterSearch({ mode: "only", agents: ["alice", "bob"], kind: null })).toBe("agent=alice%2Cbob");
    expect(agentFilterSearch({ mode: "except", agents: ["alice"], kind: null })).toBe("agent=alice&agentMode=except");
    expect(agentFilterSearch({ mode: "except", agents: [], kind: null })).toBe("");
  });

  test("serializes agentKind, and stays non-empty with only a kind filter set", () => {
    expect(agentFilterSearch({ mode: "only", agents: [], kind: "human" })).toBe("agentKind=human");
    expect(agentFilterSearch({ mode: "only", agents: [], kind: "agent" })).toBe("agentKind=agent");
    expect(agentFilterSearch({ mode: "except", agents: ["alice"], kind: "human" })).toBe(
      "agent=alice&agentMode=except&agentKind=human",
    );
  });

  test("toggles agents deterministically", () => {
    const filter: AgentFilter = { mode: "only", agents: ["bob"], kind: null };
    expect(toggleAgent(filter, "alice")).toEqual({ mode: "only", agents: ["alice", "bob"], kind: null });
    expect(toggleAgent(filter, "bob")).toEqual({ mode: "only", agents: [], kind: null });
  });

  test("setKind sets the kind and is mutually exclusive with the other kind", () => {
    const filter: AgentFilter = { mode: "only", agents: [], kind: null };
    const human = setKind(filter, "human");
    expect(human).toEqual({ mode: "only", agents: [], kind: "human" });
    const agent = setKind(human, "agent");
    expect(agent).toEqual({ mode: "only", agents: [], kind: "agent" });
  });

  test("setKind toggles back to null when re-applying the same kind (mutual exclusivity)", () => {
    const filter: AgentFilter = { mode: "only", agents: [], kind: "human" };
    expect(setKind(filter, "human")).toEqual({ mode: "only", agents: [], kind: null });
  });

  test("matches only and except filters by name", () => {
    expect(matchesAgentFilter({ name: "alice", kind: "agent" }, { mode: "only", agents: ["alice"], kind: null })).toBe(
      true,
    );
    expect(matchesAgentFilter({ name: "bob", kind: "agent" }, { mode: "only", agents: ["alice"], kind: null })).toBe(
      false,
    );
    expect(
      matchesAgentFilter({ name: "alice", kind: "agent" }, { mode: "except", agents: ["alice"], kind: null }),
    ).toBe(false);
    expect(matchesAgentFilter({ name: "bob", kind: "agent" }, { mode: "except", agents: ["alice"], kind: null })).toBe(
      true,
    );
  });

  test("matches by kind alone", () => {
    const humanOnly: AgentFilter = { mode: "only", agents: [], kind: "human" };
    expect(matchesAgentFilter({ name: "alice", kind: "human" }, humanOnly)).toBe(true);
    expect(matchesAgentFilter({ name: "bob", kind: "agent" }, humanOnly)).toBe(false);

    const agentOnly: AgentFilter = { mode: "only", agents: [], kind: "agent" };
    expect(matchesAgentFilter({ name: "bob", kind: "agent" }, agentOnly)).toBe(true);
    expect(matchesAgentFilter({ name: "alice", kind: "human" }, agentOnly)).toBe(false);
  });

  test("combines name and kind filters with AND", () => {
    const filter: AgentFilter = { mode: "only", agents: ["alice"], kind: "human" };
    // name matches, kind matches -> true
    expect(matchesAgentFilter({ name: "alice", kind: "human" }, filter)).toBe(true);
    // name matches, kind doesn't -> false
    expect(matchesAgentFilter({ name: "alice", kind: "agent" }, filter)).toBe(false);
    // name doesn't match, kind matches -> false
    expect(matchesAgentFilter({ name: "bob", kind: "human" }, filter)).toBe(false);
    // neither matches -> false
    expect(matchesAgentFilter({ name: "bob", kind: "agent" }, filter)).toBe(false);
  });

  test("filters sender-shaped items by name", () => {
    const items = [
      { seq: 1, sender: { name: "alice", kind: "agent" as const } },
      { seq: 2, sender: { name: "bob", kind: "agent" as const } },
    ];
    expect(filterByAgent(items, { mode: "only", agents: ["bob"], kind: null })).toEqual([items[1]]);
  });

  test("filters sender-shaped items by kind, unaffected by agents when unset", () => {
    const items = [
      { seq: 1, sender: { name: "alice", kind: "human" as const } },
      { seq: 2, sender: { name: "bob", kind: "agent" as const } },
    ];
    expect(filterByAgent(items, { mode: "only", agents: [], kind: "human" })).toEqual([items[0]]);
    expect(filterByAgent(items, { mode: "only", agents: [], kind: "agent" })).toEqual([items[1]]);
    expect(filterByAgent(items, { mode: "only", agents: [], kind: null })).toEqual(items);
  });

  test("filters sender-shaped items by name AND kind together", () => {
    const items = [
      { seq: 1, sender: { name: "alice", kind: "human" as const } },
      { seq: 2, sender: { name: "alice", kind: "agent" as const } },
      { seq: 3, sender: { name: "bob", kind: "human" as const } },
    ];
    expect(filterByAgent(items, { mode: "only", agents: ["alice"], kind: "human" })).toEqual([items[0]]);
  });
});

describe("seqFromQuery (#716)", () => {
  test("显式 #<seq>（>0）识别为消息定位", () => {
    expect(seqFromQuery("#634")).toBe(634);
    expect(seqFromQuery("  #42 ")).toBe(42);
    expect(seqFromQuery("#007")).toBe(7);
  });
  test("裸数字保留为全文查询，不再抢占为消息定位", () => {
    expect(seqFromQuery("634")).toBeNull();
    expect(seqFromQuery("  42 ")).toBeNull();
    expect(seqFromQuery("007")).toBeNull();
  });
  test("非显式正整数序号 → null（走全文检索）", () => {
    expect(seqFromQuery("")).toBeNull();
    expect(seqFromQuery("#0")).toBeNull();
    expect(seqFromQuery("hello")).toBeNull();
    expect(seqFromQuery("#12a")).toBeNull();
    expect(seqFromQuery("#-5")).toBeNull();
    expect(seqFromQuery("#1.5")).toBeNull();
    expect(seqFromQuery("# 12")).toBeNull();
    expect(seqFromQuery("##12")).toBeNull();
  });
  test("超出安全整数 → null（不误当 seq）", () => {
    expect(seqFromQuery("#99999999999999999999")).toBeNull();
  });
});
