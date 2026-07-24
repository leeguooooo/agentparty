import { describe, expect, test } from "bun:test";
import { extractMentionTokens, type MsgFrame, type PresenceEntry, type Sender } from "@agentparty/shared";
import { isValidMentionToken, MENTION_TOKEN_MAX_LENGTH } from "@agentparty/shared/mentions";
import { activeMentionQuery, filterCandidates, mentionCandidates, parseDraftMentions } from "./mentions";

const NOW = 1_000_000_000;

test("shared mention lexer respects a zero limit", () => {
  expect(extractMentionTokens("@alice", 0)).toEqual([]);
});

// #641：MENTION_TOKEN_MAX_LENGTH 曾是无人引用的死常量（真正的上限写死在正则 {0,63} 里）。
// 现已用它构造 MENTION_TOKEN_RE，成为 64 字符上限的单一来源——正好卡在 MAX、超一位即拒。
test("mention token max length is the single source of truth for isValidMentionToken", () => {
  expect(MENTION_TOKEN_MAX_LENGTH).toBe(64);
  const atMax = "a".repeat(MENTION_TOKEN_MAX_LENGTH);
  const overMax = "a".repeat(MENTION_TOKEN_MAX_LENGTH + 1);
  expect(atMax.length).toBe(64);
  expect(isValidMentionToken(atMax)).toBe(true);
  expect(isValidMentionToken(overMax)).toBe(false);
});

function presence(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, ...over };
}

function message(sender: Sender, ts = NOW): MsgFrame {
  return {
    type: "msg",
    seq: 1,
    sender,
    kind: "message",
    body: "hello",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts,
  } as MsgFrame;
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

  test("页面打开后发言的跨 owner agent 无需新的 presence 帧也会进入空查询和名字过滤候选 (#499)", () => {
    const messages = [message({
      name: "Evan_Clauder",
      kind: "agent",
      owner: "lark:on_cross_company",
    })];
    const candidates = mentionCandidates([], {}, "leo", NOW, [], [], [], messages);

    expect(candidates.map((candidate) => candidate.name)).toEqual(["Evan_Clauder"]);
    expect(candidates[0]?.group).toBe("lark:on_cross_company");
    expect(filterCandidates(candidates, "evan").map((candidate) => candidate.name)).toEqual(["Evan_Clauder"]);
  });

  test("removed participants stay in history snapshots but are excluded from live mention candidates", () => {
    const historical = message({
      name: "removed-agent",
      kind: "agent",
      owner: "lark:on_former_member",
    });
    const removedNames = new Set(["removed-agent"]);
    const candidates = mentionCandidates(
      [],
      {},
      "leo",
      NOW,
      [{ name: "removed-agent", display: "Former member", kind: "agent" }],
      [{ name: "removed-agent", kind: "agent", role: "worker" }],
      [],
      [historical],
      removedNames,
    );

    expect(candidates).toEqual([]);
    // Removal only changes the addressable projection; message history remains untouched.
    expect(historical.sender.name).toBe("removed-agent");
    expect(mentionCandidates([], {}, "leo", NOW, [], [], [], [historical])).toMatchObject([
      { name: "removed-agent" },
    ]);
  });

  test("authoritative roster prevents history-only resurrection after reload and restores an explicit rejoin", () => {
    const historical = message({
      name: "returning-agent",
      kind: "agent",
      owner: "lark:on_owner",
    });
    const currentMembers = new Set(["active-agent"]);

    expect(mentionCandidates(
      [],
      {},
      "leo",
      NOW,
      [],
      [],
      [],
      [historical],
      new Set(),
      currentMembers,
    )).toEqual([]);

    currentMembers.add("returning-agent");
    expect(mentionCandidates(
      [{ name: "returning-agent", kind: "agent" }],
      {},
      "leo",
      NOW,
      [],
      [],
      [],
      [historical],
      new Set(),
      currentMembers,
    )).toMatchObject([
      { name: "returning-agent", group: "lark:on_owner", tier: "online" },
    ]);
  });

  test("participants-only agent uses its owner instead of falling into unowned agents (#499)", () => {
    const candidates = mentionCandidates([
      { name: "external-live", kind: "agent", owner: "lark:on_cross_company" },
    ], {}, null, NOW);

    expect(candidates[0]).toMatchObject({
      name: "external-live",
      account: "lark:on_cross_company",
      group: "lark:on_cross_company",
    });
  });

  test("participants-only human UUID remains readable through its owner (#499)", () => {
    const uuid = "61ec302c-6c31-4bca-a1df-88152372f6d9";
    const candidates = mentionCandidates([
      { name: uuid, kind: "human", owner: "cross-owner@example.com" },
    ], {}, null, NOW);

    expect(candidates[0]).toMatchObject({
      name: uuid,
      display: "cross-owner@example.com",
      account: "cross-owner@example.com",
    });
  });

  test("recent raw sender stays retained when stale presence supplies a different current handle (#499)", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const messages = [message({ name: "external-session", kind: "agent", handle: "old-handle" })];
    const pres = {
      "external-session": presence({
        name: "external-session",
        kind: "agent",
        handle: "new-handle",
        last_seen: NOW - 15 * DAY,
        ts: NOW - 15 * DAY,
      }),
    };

    expect(mentionCandidates([], pres, null, NOW, [], [], [], messages)).toMatchObject([
      { name: "new-handle", tier: "recent" },
    ]);
  });

  test("同名 sender 的稀疏新帧不会擦掉完整 owner/handle/display (#499)", () => {
    const complete = message({
      name: "cross-owner-session",
      kind: "human",
      owner: "lark:on_cross_company",
      handle: "Evan_Clauder",
      display_name: "Evan",
    }, NOW - 1);
    const sparse = message({ name: "cross-owner-session", kind: "human" }, NOW);
    const candidates = mentionCandidates([], {}, null, NOW, [], [], [], [complete, sparse]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "Evan_Clauder",
      display: "Evan_Clauder",
      account: "lark:on_cross_company",
      group: "lark:on_cross_company",
    });
  });

  test("超过 14 天的消息 sender 不会绕过幽灵清理重新进入候选 (#499)", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const messages = [message({ name: "old-cross-owner", kind: "agent", owner: "lark:on_old" }, NOW - 15 * DAY)];
    expect(mentionCandidates([], {}, null, NOW, [], [], [], messages)).toEqual([]);
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

  test("channel squads are mention candidates even without live presence", () => {
    const c = mentionCandidates([], {}, null, NOW, [], [], [
      {
        type: "squad",
        channel: "dev",
        name: "frontend",
        title: "Frontend",
        description: "web UI owners",
        leader: "alice",
        members: ["alice", "bob"],
        created_by: "leo",
        created_by_kind: "human",
        created_at: NOW,
        updated_at: NOW,
      },
    ]);
    expect(c[0]).toMatchObject({
      name: "frontend",
      display: "Frontend",
      kind: "squad",
      tier: "wakeable",
      group: "squads",
      role: "leader:alice",
      responsibility: "2 members",
      note: "web UI owners",
    });
    expect(filterCandidates(c, "front").map((candidate) => candidate.name)).toEqual(["frontend"]);
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
    expect(activeMentionQuery("https://github.com/@alice", 25)).toBeNull();
    for (const source of ["请看github.com/@alice", "测试@example.com", "use @agentparty/shared", "use `@alice`"]) {
      expect(activeMentionQuery(source, source.length), source).toBeNull();
    }
  });
  test("中文正文和全角标点无需空格也触发补全", () => {
    expect(activeMentionQuery("请@小明", 4)).toEqual({ start: 1, query: "小明" });
    expect(activeMentionQuery("请，@小明", 5)).toEqual({ start: 2, query: "小明" });
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

// 这个函数不只喂草稿状态条——发送/编辑路径也用它决定真正上报给服务端的 mentions 数组（issue #124），
// 所以边界规则的回归必须被 CI 拦住，而不是靠人工在页面上试。
describe("parseDraftMentions", () => {
  test("不吃单词内部的 @（email / git 地址）", () => {
    expect(parseDraftMentions("deploy@buildbot ping @alpha")).toEqual(["alpha"]);
    expect(parseDraftMentions("mail me@x.com about @bob")).toEqual(["bob"]);
  });
  test("行首与空白后的 @ 都算", () => {
    expect(parseDraftMentions("@alpha hi")).toEqual(["alpha"]);
    expect(parseDraftMentions("hi\n@bob")).toEqual(["bob"]);
  });
  test("去重且保序", () => {
    expect(parseDraftMentions("@bob @alice @Bob")).toEqual(["bob", "alice"]);
  });
  test("保留字仍被提取上报（映射到 body_mentions，由服务端裁决）", () => {
    // #663：网页把提取结果整体放进 body_mentions（正文便利提取，非权威）。这里仍原样提取保留名/未知 token，
    // 交给服务端——命中即路由，未命中/保留字（如 system）降级为普通文本并回执 unresolved_mentions，绝不硬拒整条。
    expect(parseDraftMentions("@system hi @bob")).toEqual(["system", "bob"]);
  });
  test("没有 mention 时返回空数组", () => {
    expect(parseDraftMentions("just a plain message")).toEqual([]);
  });
  // #165：中文昵称
  test("解析中文无空格正文/全角标点，且 email / URL 里的 @ 仍不算", () => {
    expect(parseDraftMentions("@小助手 帮我看下")).toEqual(["小助手"]);
    expect(parseDraftMentions("hi @程序员小明 and @bob")).toEqual(["程序员小明", "bob"]);
    expect(parseDraftMentions("请@小明看一下", ["小明"])).toEqual(["小明"]);
    expect(parseDraftMentions("请，@小明：看一下", ["小明"])).toEqual(["小明"]);
    expect(parseDraftMentions("mail me@bar.com thanks")).toEqual([]);
    expect(parseDraftMentions("请@agent-a看一下")).toEqual(["agent-a"]);
    expect(parseDraftMentions("（@agent-a），@agent-b")).toEqual(["agent-a", "agent-b"]);
    expect(parseDraftMentions("路人甲@小明")).toEqual(["小明"]);
    expect(parseDraftMentions("see https://github.com/@小明/repo", ["小明"])).toEqual([]);
    expect(parseDraftMentions("请看github.com/@小明/repo", ["小明"])).toEqual([]);
    expect(parseDraftMentions("请看：github.com/@小明/repo", ["小明"])).toEqual([]);
    expect(parseDraftMentions("测试@example.com", ["example.com"])).toEqual([]);
    expect(parseDraftMentions("路人甲@小明", ["小明"])).toEqual(["小明"]); // 中文正文不要求空格
  });

  test("忽略 npm scope 与 Markdown code，只提取真正的正文 mention", () => {
    expect(parseDraftMentions("install @agentparty/shared then ping @codex", ["agentparty", "codex"])).toEqual(["codex"]);
    expect(parseDraftMentions("use `@codex` then @alice", ["codex", "alice"])).toEqual(["alice"]);
    expect(parseDraftMentions("```ts\nimport x from '@agentparty/shared'\n@codex\n```\n@alice", ["agentparty", "codex", "alice"])).toEqual(["alice"]);
    expect(parseDraftMentions("~~~\n@codex\n~~~\n@alice", ["codex", "alice"])).toEqual(["alice"]);
  });

  test("句末句号不属于 mention token", () => {
    expect(parseDraftMentions("please ask @codex.", ["codex"])).toEqual(["codex"]);
    expect(parseDraftMentions("@first.last.", ["first.last"])).toEqual(["first.last"]);
    expect(activeMentionQuery("@codex.", 7)).toBeNull();
  });

  test("known target 大小写唯一匹配；未知/歧义原样交给服务端报错", () => {
    expect(parseDraftMentions("@ALICE", ["alice"])).toEqual(["alice"]);
    expect(parseDraftMentions("@ALICE看一下", ["alice"])).toEqual(["alice"]);
    expect(parseDraftMentions("@ghost", ["alice"])).toEqual(["ghost"]);
    expect(parseDraftMentions("@小明看一下", ["小", "小明"])).toEqual(["小明看一下"]);
    expect(parseDraftMentions("@A小明", ["A小明"])).toEqual(["A小明"]);
    expect(parseDraftMentions("@A小明看一下", ["A小明"])).toEqual(["A小明"]);
    expect(parseDraftMentions("@A小明看一下", ["A小", "A小明"])).toEqual(["A小明看一下"]);
  });

  test("仅 ASCII alias 忽略大小写；Unicode alias 按 NFC 精确匹配", () => {
    const decomposed = "A\u0308gent";
    expect(parseDraftMentions("@ALICE @alice", ["alice"])).toEqual(["alice"]);
    expect(parseDraftMentions("@Ägent", ["Ägent"])).toEqual(["Ägent"]);
    expect(parseDraftMentions("@ÄGENT", ["Ägent"])).toEqual(["ÄGENT"]);
    expect(parseDraftMentions("@Ägent @ägent", ["Ägent", "ägent"])).toEqual(["Ägent", "ägent"]);
    expect(parseDraftMentions(`@${decomposed}看一下`, ["Ägent"])).toEqual(["Ägent"]);
    expect(parseDraftMentions("@Ägent看一下", [decomposed])).toEqual([decomposed]);
  });
});

describe("activeMentionQuery — 中文昵称补全（#165）", () => {
  test("打 @中 触发补全下拉", () => {
    expect(activeMentionQuery("@中", 2)).toEqual({ start: 0, query: "中" });
    expect(activeMentionQuery("hi @小助", 6)).toEqual({ start: 3, query: "小助" });
    const supplementary = "请@𠮷";
    expect(activeMentionQuery(supplementary, supplementary.length)).toEqual({ start: 1, query: "𠮷" });
  });
  test("中文正文后可触发，ASCII/email 左边界仍拒绝", () => {
    expect(activeMentionQuery("请@agent", 8)).toEqual({ start: 1, query: "agent" });
    expect(activeMentionQuery("a@agent", 7)).toBeNull();
  });
});
