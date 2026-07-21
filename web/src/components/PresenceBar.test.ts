import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PresenceEntry, Sender } from "@agentparty/shared";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { ACTIVITY_TTL_MS, activityBadge, buildGroups, busyLabel, countLiveGroups, livenessBadge, ownerKey, pauseResumeAt, PresenceBar, presenceTier, PRESENCE_STALE_MS, taskLabel, unreachableBadge, waitingOwnerLabel, wakeabilityBadge, type Item } from "./PresenceBar";

function item(over: Partial<Item> = {}): Item {
  return {
    name: "agent-a",
    kind: "agent",
    state: "working",
    note: null,
    ts: 1_000,
    lastSeen: 1_000,
    role: null,
    roleSource: null,
    residency: null,
    wakeKind: null,
    wakeVerifiedAt: null,
    context: null,
    lineage: null,
    workflow: null,
    owner: null,
    account: null,
    handle: null,
    displayName: null,
    avatarUrl: null,
    avatarThumb: null,
    display: "agent-a",
    responsibility: null,
    connectionCount: 1,
    clientVersion: null,
    paused: false,
    resumeAt: null,
    busy: false,
    queueDepth: null,
    waitingOwnerCount: 0,
    currentTask: null,
    heartbeatAt: null,
    activity: null,
    listening: null,
    runnerHealth: null,
    ...over,
  };
}

// #608：探活分级 + 模型活动 chip（消费 #602/#603 字段），口径对齐 cli/src/commands/who.ts。
describe("livenessBadge / activityBadge (#608)", () => {
  const NOW = 10_000_000;

  test("runner 连败优先级最高，title 带 last_error", () => {
    const badge = livenessBadge(
      item({
        runnerHealth: { ok: false, consecutive_failures: 3, last_error: "spawn ENOENT" },
        listening: "deaf",
      }),
    );
    expect(badge).toEqual({
      key: "PresenceBar.runnerFailing",
      vars: { count: 3 },
      tone: "bad",
      title: "spawn ENOENT",
    });
  });

  test("runner ok=true 不告警（单次失败降噪口径）；listening 分 deaf/suspect 两档", () => {
    expect(livenessBadge(item({ runnerHealth: { ok: true, consecutive_failures: 1 } }))).toBeNull();
    expect(livenessBadge(item({ listening: "deaf" }))!.tone).toBe("bad");
    expect(livenessBadge(item({ listening: "suspect" }))!.tone).toBe("warn");
    expect(livenessBadge(item())).toBeNull();
  });

  test("activity：tool 阶段普通展示，waiting_permission 高亮", () => {
    const tool = activityBadge(item({ activity: { phase: "tool", tool: "Bash", ts: NOW - 5_000 } }), NOW);
    expect(tool!.key).toBe("PresenceBar.activityTool");
    expect(tool!.highlight).toBe(false);
    const perm = activityBadge(
      item({ activity: { phase: "waiting_permission", tool: "Bash", ts: NOW - 5_000 } }),
      NOW,
    );
    expect(perm!.key).toBe("PresenceBar.activityWaitingPermissionTool");
    expect(perm!.highlight).toBe(true);
  });

  test("livenessBadge 各分支 key 与 i18n 定义一致", () => {
    expect(livenessBadge(item({ listening: "deaf" }))!.key).toBe("PresenceBar.listeningDeaf");
    expect(livenessBadge(item({ listening: "suspect" }))!.key).toBe("PresenceBar.listeningSuspect");
  });

  test("activityBadge 其余 phase 的 key/高亮映射（防 i18n key 拼写回归）", () => {
    const at = (phase: NonNullable<Item["activity"]>["phase"], tool?: string) =>
      activityBadge(item({ activity: { phase, tool, ts: NOW - 5_000 } }), NOW);
    expect(at("waiting_permission")).toMatchObject({ key: "PresenceBar.activityWaitingPermission", highlight: true });
    expect(at("waiting_input")).toMatchObject({ key: "PresenceBar.activityWaitingInput", highlight: true });
    expect(at("compacting")).toMatchObject({ key: "PresenceBar.activityCompacting", highlight: false });
    expect(at("starting")).toMatchObject({ key: "PresenceBar.activityStarting", highlight: false });
    expect(at("working")).toMatchObject({ key: "PresenceBar.activityWorking", highlight: false });
    expect(at("idle")).toMatchObject({ key: "PresenceBar.activityIdle", highlight: false });
  });

  test("超 5 分钟陈旧 / 未来时间戳（>1min）不展示；缺省无恙", () => {
    expect(activityBadge(item({ activity: { phase: "working", ts: NOW - ACTIVITY_TTL_MS - 1 } }), NOW)).toBeNull();
    expect(activityBadge(item({ activity: { phase: "working", ts: NOW + 61_000 } }), NOW)).toBeNull();
    expect(activityBadge(item({ activity: { phase: "working", ts: NOW - 1_000 } }), NOW)).not.toBeNull();
    expect(activityBadge(item(), NOW)).toBeNull();
  });
});

describe("wakeabilityBadge (#191 可唤醒·待命 + 服务端校验)", () => {
  const NOW = 2_000_000;
  test("无 wake 元数据 → 不渲染徽章", () => {
    expect(wakeabilityBadge(item({ wakeKind: null }), NOW)).toBeNull();
  });

  test("webhook → verified（服务端投递，天然已验证）", () => {
    expect(wakeabilityBadge(item({ wakeKind: "webhook", wakeVerifiedAt: null }), NOW)).toEqual({
      key: "PresenceBar.wake.verified",
      tone: "on",
    });
  });

  test("serve/watch 无服务端 verified_at → unverified（自报未验证，如实标注）", () => {
    expect(wakeabilityBadge(item({ wakeKind: "serve", wakeVerifiedAt: null }), NOW)?.key).toBe("PresenceBar.wake.unverified");
    expect(wakeabilityBadge(item({ wakeKind: "watch", wakeVerifiedAt: null }), NOW)?.tone).toBe("pending");
  });

  test("serve/watch 有服务端 verified_at（新鲜）→ verified", () => {
    expect(wakeabilityBadge(item({ wakeKind: "watch", wakeVerifiedAt: NOW - 1000 }), NOW)).toEqual({
      key: "PresenceBar.wake.verified",
      tone: "on",
    });
  });

  test("wake=none / human_driven / bare → not wakeable（off）", () => {
    expect(wakeabilityBadge(item({ wakeKind: "none" }), NOW)?.key).toBe("PresenceBar.wake.off");
    expect(wakeabilityBadge(item({ wakeKind: "watch", wakeVerifiedAt: NOW, residency: "human_driven" }), NOW)?.tone).toBe("off");
    expect(wakeabilityBadge(item({ wakeKind: "serve", wakeVerifiedAt: NOW, residency: "bare" }), NOW)?.tone).toBe("off");
  });
});

// #666：把 CLI `party who` 的三档分级搬到 web，把「离线且不可唤醒」（被收割的 watch --once /
// 从未验证 / 无 wake layer）从「可唤醒·待命」里拆出来显式标注。tier 复用共享 wakeableState +
// autoWakeReachable，与 who.ts classify 同口径。
describe("presenceTier / unreachableBadge (#666 未监听)", () => {
  const NOW = 10_000_000;
  const FRESH = NOW - 5_000; // < STALE_MS：新鲜
  const STALE = NOW - PRESENCE_STALE_MS - 60_000; // 远超 STALE_MS：被收割 / 陈旧

  test("presenceTier：在线 → online（不看 wake）", () => {
    expect(presenceTier(item({ state: "working" }), NOW)).toBe("online");
    expect(presenceTier(item({ state: "waiting", wakeKind: null }), NOW)).toBe("online");
  });

  test("presenceTier：离线 + 无 wake layer → recent（不可唤醒）", () => {
    expect(presenceTier(item({ state: "offline", wakeKind: null, lastSeen: STALE }), NOW)).toBe("recent");
    expect(presenceTier(item({ state: "offline", wakeKind: "none", lastSeen: FRESH }), NOW)).toBe("recent");
  });

  test("presenceTier：离线 + serve/watch + 新鲜 last_seen → wakeable（可达待命）", () => {
    expect(presenceTier(item({ state: "offline", wakeKind: "watch", wakeVerifiedAt: null, lastSeen: FRESH }), NOW)).toBe(
      "wakeable",
    );
    expect(presenceTier(item({ state: "offline", wakeKind: "serve", wakeVerifiedAt: NOW - 1_000, lastSeen: FRESH }), NOW)).toBe(
      "wakeable",
    );
  });

  test("presenceTier：离线 + watch 声明还在但 last_seen 陈旧（被 harness 收割的 --once）→ recent", () => {
    expect(presenceTier(item({ state: "offline", wakeKind: "watch", wakeVerifiedAt: null, lastSeen: STALE }), NOW)).toBe(
      "recent",
    );
    // verified_at 新鲜也不能救——freshness 决定当前可达，与 who.ts 同口径（#454）。
    expect(presenceTier(item({ state: "offline", wakeKind: "watch", wakeVerifiedAt: NOW - 1_000, lastSeen: STALE }), NOW)).toBe(
      "recent",
    );
  });

  test("presenceTier：离线 + webhook → wakeable（服务端投递，天然可达）", () => {
    expect(presenceTier(item({ state: "offline", wakeKind: "webhook", lastSeen: STALE }), NOW)).toBe("wakeable");
  });

  test("presenceTier：human_driven / bare 不承诺可唤醒 → recent", () => {
    expect(
      presenceTier(item({ state: "offline", wakeKind: "watch", wakeVerifiedAt: NOW, residency: "human_driven", lastSeen: FRESH }), NOW),
    ).toBe("recent");
    expect(presenceTier(item({ state: "offline", wakeKind: "serve", residency: "bare", lastSeen: FRESH }), NOW)).toBe("recent");
  });

  test("unreachableBadge：离线不可唤醒的 agent → 标注未监听", () => {
    expect(unreachableBadge(item({ kind: "agent", state: "offline", wakeKind: null, lastSeen: STALE }), NOW)).toEqual({
      key: "PresenceBar.unreachable",
      titleKey: "PresenceBar.unreachableTitle",
    });
    // 被收割的 watch --once 同样标注（这是 #666 的核心：别再假报可唤醒）。
    expect(
      unreachableBadge(item({ kind: "agent", state: "offline", wakeKind: "watch", wakeVerifiedAt: null, lastSeen: STALE }), NOW),
    ).not.toBeNull();
  });

  test("unreachableBadge：在线 / 可唤醒待命 / paused / 人类 → 不标注", () => {
    expect(unreachableBadge(item({ kind: "agent", state: "working" }), NOW)).toBeNull();
    expect(
      unreachableBadge(item({ kind: "agent", state: "offline", wakeKind: "watch", wakeVerifiedAt: null, lastSeen: FRESH }), NOW),
    ).toBeNull();
    // paused 是人主动设的有意状态、已有独立 ⏸ chip，不叠加未监听。
    expect(
      unreachableBadge(item({ kind: "agent", state: "offline", paused: true, wakeKind: null, lastSeen: STALE }), NOW),
    ).toBeNull();
    // 人类离线本就靠人接续，不算「未监听」。
    expect(unreachableBadge(item({ kind: "human", state: "offline", wakeKind: null, lastSeen: STALE }), NOW)).toBeNull();
  });

  test("verified-wakeable 的离线 agent：显示可唤醒，不显示未监听", () => {
    const it = item({ kind: "agent", state: "offline", wakeKind: "watch", wakeVerifiedAt: NOW - 1_000, lastSeen: FRESH });
    expect(unreachableBadge(it, NOW)).toBeNull();
    expect(wakeabilityBadge(it, NOW)).toEqual({ key: "PresenceBar.wake.verified", tone: "on" });
  });
});

describe("presence grouping by account", () => {
  test("ownerKey groups online and offline sessions of the same account together", () => {
    const online = item({ name: "sess-1", kind: "human", state: "working", owner: "alice@example.com", account: "alice@example.com" });
    // 离线会话：owner 出于隐私置空，但 account 仍保留，用来分组。
    const offline = item({ name: "3d2f1e8a-uuid", kind: "human", state: "offline", owner: null, account: "alice@example.com" });
    expect(ownerKey(online)).toBe(ownerKey(offline));
    expect(ownerKey(online)).toBe("account:alice@example.com");
  });

  test("items without an account fall back to per-session grouping", () => {
    const a = item({ name: "agent-a", account: null });
    const b = item({ name: "agent-b", account: null });
    expect(ownerKey(a)).not.toBe(ownerKey(b));
  });

  test("buildGroups folds one account's online + offline sessions into a single group, and counts participants (not sessions)", () => {
    const aliceOnline = item({
      name: "sess-1",
      kind: "human",
      state: "working",
      owner: "alice@example.com",
      account: "alice@example.com",
      display: "alice@example.com",
    });
    const aliceOffline = item({
      name: "3d2f1e8a-uuid",
      kind: "human",
      state: "offline",
      owner: null,
      account: "alice@example.com",
      display: "3d2f1e8a-uuid",
    });
    const bobOffline = item({
      name: "bot-1",
      kind: "agent",
      state: "offline",
      owner: null,
      account: "bob@example.com",
      display: "bob@example.com",
    });

    const groups = buildGroups([aliceOnline, aliceOffline, bobOffline]);

    // alice 的在线 + 离线会话应折叠为同一组（1 人 2 个会话），bob 单独一组。
    expect(groups).toHaveLength(2);
    const aliceGroup = groups.find((g) => g.key === "account:alice@example.com");
    expect(aliceGroup?.items).toHaveLength(2);

    // 顶部计数按人数：2 个账号，其中只有 alice 有非离线会话，所以 1/2。
    const { live, total } = countLiveGroups(groups);
    expect(total).toBe(2);
    expect(live).toBe(1);
  });

  test("an account with only offline sessions across multiple entries still counts as one non-live participant", () => {
    const offlineA = item({ name: "sess-x", kind: "human", state: "offline", owner: null, account: "carol@example.com" });
    const offlineB = item({ name: "sess-y", kind: "human", state: "offline", owner: null, account: "carol@example.com" });

    const groups = buildGroups([offlineA, offlineB]);
    expect(groups).toHaveLength(1);
    const { live, total } = countLiveGroups(groups);
    expect(total).toBe(1);
    expect(live).toBe(0);
  });
});

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function presenceEntry(clientVersion?: string): PresenceEntry {
  return {
    name: "agent-a",
    kind: "agent",
    state: "working",
    note: null,
    ts: Date.now(),
    ...(clientVersion === undefined ? {} : { client_version: clientVersion }),
  };
}

function busyEntry(over: Partial<PresenceEntry> = {}): PresenceEntry {
  return { name: "agent-a", kind: "agent", state: "working", note: null, ts: Date.now(), busy: true, ...over };
}

const participants: Sender[] = [{ name: "agent-a", kind: "agent" }];
let renderer: ReactTestRenderer | null = null;

function openRoster(r: ReactTestRenderer): void {
  const toggle = r.root.findByProps({ "aria-haspopup": "dialog" });
  if (toggle.props["aria-expanded"] === true) return;
  void act(() => toggle.props.onClick());
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage({ ap_locale: "en", ap_presence_expanded: "1" }),
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      innerWidth: 1280,
      innerHeight: 800,
    },
  });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "window");
});

function renderPresence(entry: PresenceEntry, open = false): ReactTestRenderer {
  let next!: ReactTestRenderer;
  void act(() => {
    next = create(
      createElement(
        LocaleProvider,
        null,
        createElement(PresenceBar, {
          presence: { "agent-a": entry },
          participants,
          status: "open",
        }),
      ),
    );
  });
  renderer = next;
  if (open) openRoster(next);
  return next;
}

function renderPresenceRoster(count: number, open = false): ReactTestRenderer {
  const roster = Array.from({ length: count }, (_, index) => {
    const name = `agent-${index + 1}`;
    return {
      name,
      entry: { name, kind: "agent", state: "working", note: null, ts: Date.now() } satisfies PresenceEntry,
      participant: { name, kind: "agent", owner: "alice@example.com" } satisfies Sender,
    };
  });
  let next!: ReactTestRenderer;
  void act(() => {
    next = create(
      createElement(
        LocaleProvider,
        null,
        createElement(PresenceBar, {
          presence: Object.fromEntries(roster.map(({ name, entry }) => [name, entry])),
          participants: roster.map(({ participant }) => participant),
          status: "open",
        }),
      ),
    );
  });
  renderer = next;
  if (open) openRoster(next);
  return next;
}

function nodesWithClass(r: ReactTestRenderer, className: string) {
  return r.root.findAll((node) => String(node.props.className ?? "").split(" ").includes(className));
}

describe("presence client version", () => {
  test("shows an agent CLI version in expanded details and the group tooltip, then removes it when collapsed", async () => {
    const r = renderPresence(presenceEntry("0.2.89"), true);

    const versions = nodesWithClass(r, "presence-client-version");
    expect(versions).toHaveLength(1);
    expect(versions[0]?.children).toEqual(["cli v", "0.2.89"]);
    const group = nodesWithClass(r, "presence-group")[0];
    expect(group?.props.title).toContain("agent-a: cli v0.2.89");

    await act(async () => {
      r.root.findByProps({ "aria-label": "collapse" }).props.onClick();
    });

    expect(nodesWithClass(r, "presence-client-version")).toHaveLength(0);
  });

  test("does not render a version label for legacy presence entries", () => {
    const r = renderPresence(presenceEntry(), true);

    expect(nodesWithClass(r, "presence-client-version")).toHaveLength(0);
  });
});

describe("presence header controls", () => {
  test("renders channel controls on the top row before the connection status", () => {
    const controls = createElement("button", { type: "button" }, "Visibility");
    const r = renderWith(presenceEntry(), { headerControls: controls });
    const head = nodesWithClass(r, "presence-head")[0];

    expect(head?.children.map((child) => typeof child === "string" ? child : child.props.className)).toEqual([
      "presence-meta",
      "presence-channel-controls",
      "conn t-mono",
    ]);
    expect(nodesWithClass(r, "presence-channel-controls")[0]?.findByType("button").children).toEqual(["Visibility"]);
  });
});

// busy + 队列深度（#103）：serve 串行处理长任务时，presence 要显式表达「忙 + N 待处理」，
// 与 working 蜡笔点区分，让人别把「@ 了没立刻回」当失联。
describe("busy indicator + queue depth (#103)", () => {
  test("busyLabel: 忙无队列 / 忙有队列 / 不忙三态（#639 走 i18n key）", () => {
    const it = (over: Partial<Item>) =>
      ({ name: "a", busy: false, queueDepth: null, ...over }) as Item;
    expect(busyLabel(it({ busy: true, queueDepth: null }))).toEqual({ key: "PresenceBar.busy" });
    expect(busyLabel(it({ busy: true, queueDepth: 4 }))).toEqual({
      key: "PresenceBar.busyQueued",
      vars: { count: 4 },
    });
    expect(busyLabel(it({ busy: false }))).toBeNull();
  });

  test("waiting_owner 单独显示，不冒充 busy", () => {
    expect(waitingOwnerLabel(item({ waitingOwnerCount: 2, busy: false }))).toEqual({
      key: "PresenceBar.waitingOwnerChip",
      vars: { count: 2 },
    });
    expect(waitingOwnerLabel(item({ waitingOwnerCount: 0 }))).toBeNull();
  });

  test("waiting_owner chip follows the active en/zh locale", async () => {
    const entry = busyEntry({ busy: false, waiting_owner_count: 2 });
    const en = renderPresence(entry, true);
    expect(nodesWithClass(en, "presence-waiting-owner").some((node) => node.children.join("") === "💬 2 waiting owner"))
      .toBe(true);

    await act(async () => en.unmount());
    renderer = null;
    localStorage.setItem("ap_locale", "zh");
    const zh = renderPresence(entry, true);
    expect(nodesWithClass(zh, "presence-waiting-owner").some((node) => node.children.join("") === "💬 2 项等待 owner"))
      .toBe(true);
  });

  // 每任务进度/心跳（#228）：比 busy 更细——标明正在处理哪条 wake + 心跳新鲜度。
  test("taskLabel: 有任务+心跳 / 有任务无心跳 / 无任务三态", () => {
    const now = 100_000;
    const it = (over: Partial<Item>) =>
      ({ name: "a", busy: false, queueDepth: null, currentTask: null, heartbeatAt: null, ...over }) as Item;
    // 新鲜心跳（<45s）显示 "now" = 还活着；很旧则显示 "2m"/"1h" = 大概率卡死。
    // #639：走 taskChip/taskChipBeat i18n key（原为死键），不再写死 chip 文本。
    expect(taskLabel(it({ currentTask: 510, heartbeatAt: now - 5_000 }), now)).toEqual({
      key: "PresenceBar.taskChipBeat",
      vars: { seq: 510, age: "now" },
    });
    expect(taskLabel(it({ currentTask: 510, heartbeatAt: now - 120_000 }), now)).toEqual({
      key: "PresenceBar.taskChipBeat",
      vars: { seq: 510, age: "2m" },
    });
    expect(taskLabel(it({ currentTask: 7 }), now)).toEqual({ key: "PresenceBar.taskChip", vars: { seq: 7 } });
    expect(taskLabel(it({ currentTask: null }), now)).toBeNull();
  });

  test("busy 项渲染琥珀徽章 + 顶部「N busy」汇总", () => {
    const r = renderPresence(busyEntry({ queue_depth: 3 }), true);
    const badges = nodesWithClass(r, "presence-busy");
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.some((n) => n.children.join("").includes("⏳ busy · 3 queued"))).toBe(true);
    const summary = nodesWithClass(r, "presence-alert--busy");
    expect(summary).toHaveLength(1);
    expect(summary[0]?.children.join("")).toContain("1 busy");
  });

  test("busy 但无队列：徽章只显示「busy」，不显示 queued", () => {
    const r = renderPresence(busyEntry({ queue_depth: 0 }), true);
    const badges = nodesWithClass(r, "presence-busy");
    expect(badges.some((n) => n.children.join("") === "⏳ busy")).toBe(true);
    expect(badges.some((n) => n.children.join("").includes("queued"))).toBe(false);
  });

  // #639：busy/queued chip 曾写死英文，zh 界面不翻译。改走 t() 后中文 locale 必须译。
  test("busy chip follows the active en/zh locale (#639)", async () => {
    const entry = busyEntry({ queue_depth: 3 });
    const en = renderPresence(entry, true);
    expect(nodesWithClass(en, "presence-busy").some((n) => n.children.join("") === "⏳ busy · 3 queued")).toBe(true);

    await act(async () => en.unmount());
    renderer = null;
    localStorage.setItem("ap_locale", "zh");
    const zh = renderPresence(entry, true);
    const zhBadges = nodesWithClass(zh, "presence-busy");
    expect(zhBadges.some((n) => n.children.join("") === "⏳ 忙 · 3 排队")).toBe(true);
    // 关键回归：中文界面里绝不再出现写死的英文 "busy"
    expect(zhBadges.some((n) => n.children.join("").includes("busy"))).toBe(false);
  });

  test("不忙的 working 项：不渲染 busy 徽章或汇总", () => {
    const r = renderPresence(presenceEntry());
    expect(nodesWithClass(r, "presence-busy")).toHaveLength(0);
    expect(nodesWithClass(r, "presence-alert--busy")).toHaveLength(0);
  });
});

describe("presence live roster dialog (#484)", () => {
  test("keeps the live roster button last after every status badge (#179)", () => {
    const r = renderWith(busyEntry({ connection_count: 2 }), { party: true });
    const meta = r.root.findByProps({ "aria-label": "channel presence summary" });
    const directClasses = meta.children.map((child) =>
      typeof child === "string" ? "" : String(child.props.className ?? ""),
    );

    expect(directClasses).toEqual([
      "d-hl party-badge",
      "t-mono presence-alert presence-alert--busy",
      "t-mono presence-alert presence-alert--duplicate",
      "presence-toggle",
    ]);
  });

  // #179 的可点击计数保留；#484 把姓名列表从顶部条移进独立 modal。
  test("the live count is a real button that toggles an accessible participant dialog", async () => {
    const r = renderPresence(presenceEntry());

    const toggle = nodesWithClass(r, "presence-toggle")[0];
    expect(toggle).toBeDefined();
    // 是 <button type="button">，天然带 button role + 键盘可达——不是纯展示 span。
    expect(toggle?.type).toBe("button");
    expect(toggle?.props.type).toBe("button");
    // 「X/Y live」计数就渲染在这个按钮内部（点 live 即点按钮，不是旁边的告警文字）。
    const summary = toggle?.findAll(
      (node) => String(node.props.className ?? "").split(" ").includes("presence-summary"),
    );
    expect(summary).toHaveLength(1);
    expect(summary?.[0]?.children.join("")).toBe("1/1 live");

    expect(toggle?.props["aria-haspopup"]).toBe("dialog");
    expect(toggle?.props["aria-expanded"]).toBe(false);
    expect(r.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    await act(async () => {
      toggle?.props.onClick();
    });
    expect(r.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(r.root.findByProps({ role: "dialog" }).props["aria-modal"]).toBe("true");
    expect(r.root.findByProps({ "aria-label": "Participant groups by owner" })).toBeDefined();

    // 再次点击应关闭，姓名组从 DOM 移除，顶部不再留一整排列表。
    expect(toggle?.props["aria-expanded"]).toBe(true);
    expect(nodesWithClass(r, "presence-group")).toHaveLength(1);
    await act(async () => {
      toggle?.props.onClick();
    });
    expect(r.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(nodesWithClass(r, "presence-group")).toHaveLength(0);
  });
});

describe("presence group popover overflow (#357)", () => {
  async function focusGroup(r: ReactTestRenderer): Promise<void> {
    const group = nodesWithClass(r, "presence-group")[0];
    await act(async () => {
      group?.props.onFocus({
        currentTarget: { getBoundingClientRect: () => ({ left: 10, right: 310, top: 10, bottom: 44, width: 300, height: 34 }) },
      });
    });
  }

  test("caps the hover popover at ten members and reports the hidden count", async () => {
    const r = renderPresenceRoster(12, true);
    await focusGroup(r);

    const popover = nodesWithClass(r, "presence-popover")[0];
    expect(popover).toBeDefined();
    expect(popover?.findAll((node) => String(node.props.className ?? "").includes("presence-pill--full"))).toHaveLength(10);
    expect(nodesWithClass(r, "presence-popover-more")[0]?.children.join("")).toBe("+2 · expand participants");
  });

  test("clicking the compact group closes the popover and expands all members inline", async () => {
    const r = renderPresenceRoster(12, true);
    await focusGroup(r);

    const group = nodesWithClass(r, "presence-group")[0];
    expect(group?.props["aria-expanded"]).toBe(false);
    await act(async () => {
      group?.props.onClick({ target: { closest: () => null } });
    });

    expect(nodesWithClass(r, "presence-popover")).toHaveLength(0);
    const expandedGroup = nodesWithClass(r, "presence-group--full")[0];
    expect(expandedGroup?.props["aria-expanded"]).toBe(true);
    expect(nodesWithClass(r, "presence-group-detail")[0]?.findAll(
      (node) => String(node.props.className ?? "").includes("presence-pill--full"),
    )).toHaveLength(12);
  });

  test("uses the existing Chinese expand text for the overflow affordance", async () => {
    localStorage.setItem("ap_locale", "zh");
    const r = renderPresenceRoster(11, true);
    await focusGroup(r);

    expect(nodesWithClass(r, "presence-popover-more")[0]?.children.join("")).toBe("+1 · 展开参与者");
  });

  test("mouse can cross the trigger gap into the popover without closing it (#457)", async () => {
    const r = renderPresenceRoster(3, true);
    const group = nodesWithClass(r, "presence-group")[0];
    await act(async () => {
      group?.props.onMouseEnter({
        currentTarget: { getBoundingClientRect: () => ({ left: 10, right: 310, top: 10, bottom: 44, width: 300, height: 34 }) },
      });
    });
    const popover = nodesWithClass(r, "presence-popover")[0];
    expect(popover).toBeDefined();

    await act(async () => {
      group?.props.onMouseLeave();
      popover?.props.onMouseEnter();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(nodesWithClass(r, "presence-popover")).toHaveLength(1);

    await act(async () => {
      nodesWithClass(r, "presence-popover")[0]?.props.onMouseLeave();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(nodesWithClass(r, "presence-popover")).toHaveLength(0);
  });

  test("popover accepts pointer events so its enter handler can keep it open (#457)", async () => {
    const css = await Bun.file(new URL("../styles/app.css", import.meta.url)).text();
    expect(css).toMatch(/\.presence-popover\s*\{[^}]*pointer-events:\s*auto;/s);
  });
});

function renderWith(entry: PresenceEntry, extra: Record<string, unknown>, open = false): ReactTestRenderer {
  let next!: ReactTestRenderer;
  void act(() => {
    next = create(
      createElement(
        LocaleProvider,
        null,
        createElement(PresenceBar, {
          presence: { "agent-a": entry },
          participants,
          status: "open",
          ...extra,
        }),
      ),
    );
  });
  renderer = next;
  if (open) openRoster(next);
  return next;
}

describe("presence 暂停接待（#180）", () => {
  test("pauseResumeAt：预设 → 恢复时刻；indefinite → null", () => {
    const now = 1_800_000_000_000;
    expect(pauseResumeAt("1h", now)).toBe(now + 3_600_000);
    expect(pauseResumeAt("4h", now)).toBe(now + 4 * 3_600_000);
    expect(pauseResumeAt("indefinite", now)).toBeNull();
    expect(pauseResumeAt("", now)).toBeNull();
    // tomorrow 落在次日 09:00 本地
    const d = new Date(pauseResumeAt("tomorrow", now)!);
    expect(d.getHours()).toBe(9);
  });

  test("被暂停的 agent 渲染 ⏸ paused chip（与 offline 视觉区分）", () => {
    const r = renderWith({ name: "agent-a", kind: "agent", state: "waiting", note: null, ts: Date.now(), paused: true }, {}, true);
    const chip = nodesWithClass(r, "presence-paused");
    expect(chip.length).toBeGreaterThanOrEqual(1);
  });

  test("带 resume_at 时 chip 显示恢复时刻", () => {
    const resumeAt = Date.now() + 3_600_000;
    const r = renderWith({ name: "agent-a", kind: "agent", state: "waiting", note: null, ts: Date.now(), paused: true, resume_at: resumeAt }, {}, true);
    const chip = nodesWithClass(r, "presence-paused")[0];
    expect(String(chip?.children.join(""))).toContain("resumes");
  });

  test("未暂停时不渲染 paused chip", () => {
    const r = renderWith({ name: "agent-a", kind: "agent", state: "working", note: null, ts: Date.now() }, {});
    expect(nodesWithClass(r, "presence-paused")).toHaveLength(0);
  });

  // 管理控件在 hover 详情弹层里（与 kick 同处）；测试先触发 popover 再断言。
  async function openPopover(r: ReactTestRenderer): Promise<void> {
    const section = nodesWithClass(r, "presence-group")[0];
    await act(async () => {
      section?.props.onFocus({ currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0 }) } });
    });
  }

  test("moderator：未暂停的 agent 在详情弹层显示 pause 下拉，选预设即回调 onPauseAgent 带恢复时刻", async () => {
    const calls: Array<{ name: string; resumeAt: number | null }> = [];
    const r = renderWith(
      { name: "agent-a", kind: "agent", state: "working", note: null, ts: Date.now() },
      { canModerate: true, onPauseAgent: (name: string, resumeAt: number | null) => calls.push({ name, resumeAt }), onResumeAgent: () => {} },
      true,
    );
    await openPopover(r);
    const select = nodesWithClass(r, "presence-pause-select")[0];
    expect(select).toBeDefined();
    await act(async () => {
      select?.props.onChange({ target: { value: "1h" }, currentTarget: { value: "1h" } });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("agent-a");
    expect(calls[0]?.resumeAt).toBeGreaterThan(Date.now());
  });

  test("moderator：已暂停的 agent 在详情弹层显示 resume 按钮，点击回调 onResumeAgent", async () => {
    const resumed: string[] = [];
    const r = renderWith(
      { name: "agent-a", kind: "agent", state: "waiting", note: null, ts: Date.now(), paused: true },
      { canModerate: true, onPauseAgent: () => {}, onResumeAgent: (name: string) => resumed.push(name) },
      true,
    );
    await openPopover(r);
    const btn = nodesWithClass(r, "presence-resume")[0];
    expect(btn).toBeDefined();
    // 暂停态不应再显示 pause 下拉
    expect(nodesWithClass(r, "presence-pause-select")).toHaveLength(0);
    await act(async () => {
      btn?.props.onClick({ stopPropagation: () => {} });
    });
    expect(resumed).toEqual(["agent-a"]);
  });

  test("非 moderator 详情弹层不渲染任何暂停/恢复控件", async () => {
    const r = renderWith({ name: "agent-a", kind: "agent", state: "waiting", note: null, ts: Date.now(), paused: true }, { canModerate: false }, true);
    await openPopover(r);
    expect(nodesWithClass(r, "presence-pause-select")).toHaveLength(0);
    expect(nodesWithClass(r, "presence-resume")).toHaveLength(0);
  });
});

// #635 / #637 a11y 修复
describe("presence a11y (#635 pill 键劫持 / #637 group button role)", () => {
  async function openPopover(r: ReactTestRenderer): Promise<void> {
    const section = nodesWithClass(r, "presence-group")[0];
    await act(async () => {
      section?.props.onFocus({ currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0 }) } });
    });
  }

  // #635：pill 的 onKeyDown 只在 target 就是 pill 自身时才接管；焦点落在嵌套 kick 按钮上时冒泡不劫持。
  test("pill onKeyDown 忽略来自嵌套控件的键盘事件，只响应 pill 自身", async () => {
    const opened: string[] = [];
    const r = renderWith(
      { name: "agent-a", kind: "agent", state: "working", note: null, ts: Date.now() },
      { canModerate: true, onRemoveParticipant: () => {}, onOpenAgentDetail: (name: string) => opened.push(name) },
      true,
    );
    await openPopover(r);
    const pill = nodesWithClass(r, "presence-pill")[0];
    expect(pill).toBeDefined();
    expect(pill?.props.role).toBe("button");
    const self = {};
    const child = {};
    // 焦点在嵌套 kick 按钮（target !== currentTarget）→ 不触发详情弹窗
    await act(async () => {
      pill?.props.onKeyDown({ key: "Enter", target: child, currentTarget: self, preventDefault: () => {} });
    });
    expect(opened).toEqual([]);
    // 焦点就在 pill 自身（target === currentTarget）→ 正常打开详情
    await act(async () => {
      pill?.props.onKeyDown({ key: "Enter", target: self, currentTarget: self, preventDefault: () => {} });
    });
    expect(opened).toEqual(["agent-a"]);
  });

  // #637：可键盘激活的 disclosure section 必须暴露 button role + aria-expanded。
  test("presence-group section 暴露 role=button 与 aria-expanded", () => {
    const r = renderPresenceRoster(2, true);
    const section = nodesWithClass(r, "presence-group")[0];
    expect(section?.props.role).toBe("button");
    expect(section?.props["aria-expanded"]).toBe(false);
  });
});

// #666：离线且不可唤醒的 agent 必须在页面上显式可见（红色 chip + 空心红点），
// 别再和「可唤醒·待命」混成一个中性的 offline 点。用 presence（无对应 participant → 离线）驱动渲染。
describe("presence 未监听/不可唤醒可见性 (#666)", () => {
  function renderOffline(entry: PresenceEntry): ReactTestRenderer {
    let next!: ReactTestRenderer;
    void act(() => {
      next = create(
        createElement(
          LocaleProvider,
          null,
          createElement(PresenceBar, {
            presence: { [entry.name]: entry },
            participants: [] as Sender[], // 无活连接 → 离线
            status: "open",
          }),
        ),
      );
    });
    renderer = next;
    openRoster(next);
    return next;
  }

  test("离线 + 无 wake layer + 陈旧 last_seen → 渲染未监听 chip + 空心红点", () => {
    const stale = Date.now() - PRESENCE_STALE_MS - 60_000;
    const r = renderOffline({ name: "ghost", kind: "agent", state: "offline", note: null, ts: stale, last_seen: stale });
    expect(nodesWithClass(r, "presence-unreachable").length).toBeGreaterThan(0);
    expect(nodesWithClass(r, "d-dot--unreachable").length).toBeGreaterThan(0);
  });

  test("被 harness 收割的 watch --once（wake=watch 但 last_seen 陈旧）→ 也标未监听，不再假报可唤醒", () => {
    const stale = Date.now() - PRESENCE_STALE_MS - 60_000;
    const r = renderOffline({
      name: "ghost",
      kind: "agent",
      state: "offline",
      note: null,
      ts: stale,
      last_seen: stale,
      wake: { kind: "watch" },
    });
    expect(nodesWithClass(r, "presence-unreachable").length).toBeGreaterThan(0);
  });

  test("在线 agent → 不渲染未监听 chip", () => {
    const r = renderPresence(presenceEntry(), true);
    expect(nodesWithClass(r, "presence-unreachable")).toHaveLength(0);
    expect(nodesWithClass(r, "d-dot--unreachable")).toHaveLength(0);
  });

  test("未监听 chip 跟随中英文 locale", async () => {
    const stale = Date.now() - PRESENCE_STALE_MS - 60_000;
    const en = renderOffline({ name: "ghost", kind: "agent", state: "offline", note: null, ts: stale, last_seen: stale });
    expect(nodesWithClass(en, "presence-unreachable").some((n) => n.children.join("") === "⚠ unreachable")).toBe(true);

    await act(async () => en.unmount());
    renderer = null;
    localStorage.setItem("ap_locale", "zh");
    const zh = renderOffline({ name: "ghost", kind: "agent", state: "offline", note: null, ts: stale, last_seen: stale });
    expect(nodesWithClass(zh, "presence-unreachable").some((n) => n.children.join("") === "⚠ 未监听")).toBe(true);
  });
});
