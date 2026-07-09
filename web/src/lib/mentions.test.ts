import { describe, expect, test } from "bun:test";
import type { PresenceEntry, Sender } from "@agentparty/shared";
import { activeMentionQuery, filterCandidates, mentionCandidates } from "./mentions";

const NOW = 1_000_000_000;

function presence(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, ...over };
}

describe("mentionCandidates", () => {
  test("tiers: online (participant) > wakeable (serve/watch fresh) > recent", () => {
    const participants: Sender[] = [{ name: "alice", kind: "human" }];
    const pres: Record<string, PresenceEntry> = {
      alice: presence({ name: "alice" }),
      bob: presence({ name: "bob", wake: { kind: "serve" } }),
      carol: presence({ name: "carol", wake: { kind: "none" } }),
    };
    const c = mentionCandidates(participants, pres, "me", NOW);
    const byName = Object.fromEntries(c.map((x) => [x.name, x.tier]));
    expect(byName.alice).toBe("online");
    expect(byName.bob).toBe("wakeable");
    expect(byName.carol).toBe("recent");
    // 排序：online 在最前
    expect(c[0]!.name).toBe("alice");
  });

  test("stale wakeable falls back to recent", () => {
    const pres = { bob: presence({ name: "bob", wake: { kind: "serve" }, last_seen: NOW - 120_000 }) };
    expect(mentionCandidates([], pres, null, NOW)[0]!.tier).toBe("recent");
  });

  test("human_driven watch falls back to recent", () => {
    const pres = { bob: presence({ name: "bob", residency: "human_driven", wake: { kind: "watch" } }) };
    expect(mentionCandidates([], pres, null, NOW)[0]!.tier).toBe("recent");
  });

  test("stale webhook 仍是 wakeable：服务端投递，agent 离线也能被唤醒（#47）", () => {
    const pres = { hook: presence({ name: "hook", wake: { kind: "webhook" }, last_seen: NOW - 780_000 }) };
    expect(mentionCandidates([], pres, null, NOW)[0]!.tier).toBe("wakeable");
  });

  test("excludes self and system", () => {
    const pres = { me: presence({ name: "me" }), system: presence({ name: "system" }), x: presence({ name: "x" }) };
    const names = mentionCandidates([], pres, "me", NOW).map((c) => c.name);
    expect(names).toEqual(["x"]);
  });

  test("offline human viewer is excluded (只在线的人类才作候选)", () => {
    const pres = {
      bob: presence({ name: "bob", kind: "human" }), // 围观的人，不在线
      agentx: presence({ name: "agentx", kind: "agent" }),
    };
    const names = mentionCandidates([], pres, null, NOW).map((c) => c.name);
    expect(names).toEqual(["agentx"]); // bob 被剔除
  });

  test("online human is kept", () => {
    const participants: Sender[] = [{ name: "alice", kind: "human" }];
    const pres = { alice: presence({ name: "alice", kind: "human" }) };
    expect(mentionCandidates(participants, pres, null, NOW).map((c) => c.name)).toEqual(["alice"]);
  });

  test("human UUID session displays its account email + carries role (issue #38 看是谁/职责)", () => {
    const uuid = "61ec302c-6c31-4bca-a1df-88152372f6d9";
    const participants: Sender[] = [{ name: uuid, kind: "human" }];
    const pres = {
      [uuid]: presence({ name: uuid, kind: "human", account: "thejacks@163.com", role: "reviewer" }),
    };
    const c = mentionCandidates(participants, pres, null, NOW)[0]!;
    expect(c.name).toBe(uuid); // @ 目标仍是 token 名
    expect(c.display).toBe("thejacks@163.com"); // 但显示可读账号
    expect(c.group).toBe("thejacks@163.com");
    expect(c.role).toBe("reviewer"); // hover 能看职责
  });

  test("human UUID session can be labeled from the channel identity map", () => {
    const uuid = "61ec302c-6c31-4bca-a1df-88152372f6d9";
    const participants: Sender[] = [{ name: uuid, kind: "human" }];
    const pres = { [uuid]: presence({ name: uuid, kind: "human" }) };
    const c = mentionCandidates(participants, pres, null, NOW, [
      { name: uuid, display: "thejacks@163.com", kind: "human", account: "thejacks@163.com" },
    ])[0]!;
    expect(c.display).toBe("thejacks@163.com");
    expect(c.group).toBe("thejacks@163.com");
  });

  test("online opaque human UUID without an account is excluded instead of showing raw id", () => {
    const uuid = "e6a3d3fa-3678-4c8c-ba5c-5f3481f98430";
    const participants: Sender[] = [{ name: uuid, kind: "human" }];
    const pres = { [uuid]: presence({ name: uuid, kind: "human" }) };
    expect(mentionCandidates(participants, pres, null, NOW)).toEqual([]);
  });

  test("agent candidates carry account grouping from identities", () => {
    const pres = { "leo-zego-im": presence({ name: "leo-zego-im", kind: "agent", role: "worker" }) };
    const c = mentionCandidates([], pres, null, NOW, [
      { name: "leo-zego-im", display: "leo-zego-im", kind: "agent", account: "leeguooooo@gmail.com" },
    ])[0]!;
    expect(c.display).toBe("leo-zego-im");
    expect(c.account).toBe("leeguooooo@gmail.com");
    expect(c.group).toBe("leeguooooo@gmail.com");
    expect(c.role).toBe("worker");
  });

  test("identity-only agents stay mentionable even without live presence", () => {
    const c = mentionCandidates([], {}, null, NOW, [
      { name: "LEO-MAIN", display: "LEO-MAIN", kind: "agent", account: "lark:on_owner" },
    ])[0]!;
    expect(c.name).toBe("LEO-MAIN");
    expect(c.display).toBe("LEO-MAIN");
    expect(c.tier).toBe("recent");
    expect(c.group).toBe("lark:on_owner");
  });

  test("identity-only agents can be found by readable display", () => {
    const c = mentionCandidates([], {}, null, NOW, [
      { name: "lark-14c1a0719d91", display: "AgentParty", kind: "agent", account: "lark:on_owner" },
    ]);
    expect(filterCandidates(c, "agent").map((candidate) => candidate.name)).toEqual(["lark-14c1a0719d91"]);
  });

  test("offline human identity with handle stays mentionable by readable handle", () => {
    const c = mentionCandidates([], {}, null, NOW, [
      {
        name: "lark-14c1a0719d91",
        display: "Evan",
        handle: "Evan",
        kind: "human",
        account: "lark:on_acda4d50062e089bf3b2401b907decde",
      },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.name).toBe("Evan");
    expect(c[0]!.display).toBe("Evan");
    expect(filterCandidates(c, "ev").map((candidate) => candidate.name)).toEqual(["Evan"]);
  });

  test("offline human identity without handle is still selectable by readable display", () => {
    const c = mentionCandidates([], {}, null, NOW, [
      {
        name: "lark-14c1a0719d91",
        display: "Evan",
        kind: "human",
        account: "lark:on_acda4d50062e089bf3b2401b907decde",
      },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.name).toBe("lark-14c1a0719d91");
    expect(c[0]!.display).toBe("Evan");
  });

  test("assigned channel roles add offline agents and carry structured responsibility", () => {
    const c = mentionCandidates([], {}, null, NOW, [], [
      {
        name: "build-agent",
        role: "worker",
        responsibility: "build and deploy",
        assigned_by: "owner",
        assigned_at: NOW,
        kind: "agent",
        account: "leeguooooo@gmail.com",
        display: "build-agent",
      },
    ])[0]!;
    expect(c.name).toBe("build-agent");
    expect(c.group).toBe("leeguooooo@gmail.com");
    expect(c.role).toBe("worker");
    expect(c.responsibility).toBe("build and deploy");
  });

  test("assigned role overrides self-reported presence role", () => {
    const pres = { "review-agent": presence({ name: "review-agent", kind: "agent", role: "worker" }) };
    const c = mentionCandidates([], pres, null, NOW, [], [
      {
        name: "review-agent",
        role: "reviewer",
        responsibility: "final review",
        assigned_by: "owner",
        assigned_at: NOW,
      },
    ])[0]!;
    expect(c.role).toBe("reviewer");
    expect(c.responsibility).toBe("final review");
  });

  test("bare-UUID session name excluded when offline (旧 presence 行没回填 kind 的兜底)", () => {
    const uuid = "63ce33fa-6169-4c71-840b-fe6ea1d1162d";
    const pres = { [uuid]: presence({ name: uuid }) }; // 无 kind：靠名字形状判为 human
    expect(mentionCandidates([], pres, null, NOW)).toEqual([]);
  });

  test("login-verify-* system session excluded when offline", () => {
    const pres = {
      "login-verify-h2": presence({ name: "login-verify-h2" }), // OIDC 设备验证流，human
      "real-agent": presence({ name: "real-agent", kind: "agent" }),
    };
    expect(mentionCandidates([], pres, null, NOW).map((c) => c.name)).toEqual(["real-agent"]);
  });

  test("online human with a handle uses the handle as the @ token + display (Task B3)", () => {
    const uuid = "7f1a302c-6c31-4bca-a1df-88152372f6d9";
    const participants: Sender[] = [{ name: uuid, kind: "human", handle: "leo" }];
    const pres = {
      [uuid]: presence({ name: uuid, kind: "human", handle: "leo", account: "leo@x.com", state: "working" }),
    };
    const c = mentionCandidates(participants, pres, null, NOW)[0]!;
    expect(c.name).toBe("leo"); // @ 插入 token 必须是 handle 才能真正 @ 到（服务端按 handle 检测被@）
    expect(c.display).toBe("leo"); // 显示名也用 handle，而非账号 email 或 UUID
  });

  test("online human without a handle keeps existing behavior (name=UUID, display=account)", () => {
    const uuid = "8b2b302c-6c31-4bca-a1df-88152372f6d9";
    const participants: Sender[] = [{ name: uuid, kind: "human" }];
    const pres = {
      [uuid]: presence({ name: uuid, kind: "human", account: "noHandle@x.com" }),
    };
    const c = mentionCandidates(participants, pres, null, NOW)[0]!;
    expect(c.name).toBe(uuid);
    expect(c.display).toBe("noHandle@x.com");
  });

  test("recent agent (days old) is kept; only long-dead (>14d) ghost dropped", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const pres = {
      fresh: presence({ name: "fresh", kind: "agent", last_seen: NOW - 60_000 }),
      daysold: presence({ name: "daysold", kind: "agent", last_seen: NOW - 4 * DAY }), // 4天前聊过，仍保留
      ghost: presence({ name: "ghost", kind: "agent", last_seen: NOW - 15 * DAY }), // 15天，剔除
    };
    expect(mentionCandidates([], pres, null, NOW).map((c) => c.name).sort()).toEqual(["daysold", "fresh"]);
  });
});

describe("activeMentionQuery", () => {
  test("detects @prefix at caret after whitespace/start", () => {
    expect(activeMentionQuery("@ali", 4)).toEqual({ start: 0, query: "ali" });
    expect(activeMentionQuery("hi @bo", 6)).toEqual({ start: 3, query: "bo" });
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });
  test("ignores @ inside a word (email etc.)", () => {
    expect(activeMentionQuery("mail me@x", 9)).toBeNull();
  });
  test("null when caret not in a mention", () => {
    expect(activeMentionQuery("hello world", 11)).toBeNull();
    expect(activeMentionQuery("@ali done ", 10)).toBeNull();
  });
});

describe("filterCandidates", () => {
  const cands = [
    { name: "alice", display: "alice", kind: "human" as const, tier: "online" as const, group: "alice@example.com" },
    { name: "bob-review", display: "bob-review", kind: "agent" as const, tier: "wakeable" as const, group: "bob@example.com" },
    { name: "carol", display: "carol", kind: "agent" as const, tier: "recent" as const, group: "carol@example.com" },
  ];
  test("prefix hits before substring hits", () => {
    expect(filterCandidates(cands, "b").map((c) => c.name)).toEqual(["bob-review"]);
    expect(filterCandidates(cands, "review").map((c) => c.name)).toEqual(["bob-review"]);
  });
  test("empty query returns all (capped)", () => {
    expect(filterCandidates(cands, "").length).toBe(3);
  });
});
