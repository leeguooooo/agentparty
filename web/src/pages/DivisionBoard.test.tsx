// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PresenceEntry } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { DivisionBoard, type DivisionBoardProps } from "./Channel";

// issue #169:「频道四个 agent 分工面板只有两个」——分工面板此前只渲染
// 已分配角色（roles）+ 自报角色（presence role_source==="self"）的成员，
// 已连接但从未声明角色的 agent 会被整条略过、从名单里消失，
// 而不是仍然作为「未分工」成员出现在列表里（roster 完整性问题，不是 owner 折叠问题）。

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;

const noop = () => {};

// #150 自动同步用 800ms 去抖的 setTimeout；测试等它触发。留足余量避免 CI 抖动。
const AUTO_SYNC_DEBOUNCE_MS = 800;
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const flushAutoSync = () => wait(AUTO_SYNC_DEBOUNCE_MS + 250);

function presenceEntry(overrides: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return {
    state: "working",
    note: null,
    ts: 1,
    kind: "agent",
    ...overrides,
  };
}

function baseProps(overrides: Partial<DivisionBoardProps> = {}): DivisionBoardProps {
  return {
    canModerate: false,
    slug: "demo",
    roles: [],
    roleDrafts: {},
    roleError: null,
    roleSaving: null,
    roleName: "",
    roleDraft: { role: "worker", responsibility: "" },
    identities: [],
    presence: {},
    onRoleDraft: noop,
    onNewRoleName: noop,
    onNewRoleDraft: noop,
    onSaveRole: noop,
    onDeleteRole: noop,
    forceOpen: true,
    charterText: null,
    onSyncToCharter: noop,
    syncingCharter: false,
    canManageAgentRules: false,
    onOpenAgentRules: noop,
    ...overrides,
  };
}

function render(props: DivisionBoardProps) {
  localStorage.setItem("ap_locale", "zh");
  act(() => {
    renderer = create(
      <LocaleProvider>
        <DivisionBoard {...props} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function personNames(): string[] {
  return renderer!.root
    .findAll((n) => String(n.props.className ?? "").split(" ").includes("role-person-name"))
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children)));
}

function openUnassigned(): void {
  const toggle = renderer!.root.find((node) =>
    String(node.props.className ?? "").split(" ").includes("role-unassigned-toggle"),
  );
  act(() => toggle.props.onClick());
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = null;
  }
});

describe("DivisionBoard roster completeness (#169)", () => {
  test("all 4 distinct agents render as rows even though only 2 have a declared role, and all share one owner", () => {
    const owner = "lark:on_22608d74bd2d7f39f6dc67d0da248fa5";
    render(
      baseProps({
        roles: [
          {
            name: "leo-claude",
            role: "host",
            responsibility: "desktop 集成验收",
            assigned_by: "leo",
            assigned_at: 1,
            kind: "agent",
            account: owner,
            display: "leo-claude",
          },
        ],
        presence: {
          "leo-claude": presenceEntry({ name: "leo-claude", account: owner, role: "host", role_source: "assigned" }),
          "LEO-MAIN": presenceEntry({ name: "LEO-MAIN", account: owner, role: "host", role_source: "self", note: "联合协调前台" }),
          // 已连接，但从未 self-report 过角色，也没有被 admin 分配角色——这才是 issue #169 复现的关键场景。
          Evan_Claude: presenceEntry({ name: "Evan_Claude", account: owner }),
          Evan_opencoder: presenceEntry({ name: "Evan_opencoder", account: owner }),
        },
      }),
    );
    openUnassigned();
    const names = personNames();
    expect(names).toContain("leo-claude");
    expect(names).toContain("LEO-MAIN");
    expect(names).toContain("Evan_Claude");
    expect(names).toContain("Evan_opencoder");
    expect(names.length).toBe(4);
  });

  test("agents across different owners without a role still all render (matches the real #169 report)", () => {
    render(
      baseProps({
        presence: {
          "LEO-MAIN": presenceEntry({ name: "LEO-MAIN", account: "lark:on_leo", role: "host", role_source: "self" }),
          "leo-claude": presenceEntry({ name: "leo-claude", account: "lark:on_leo", role: "host", role_source: "self" }),
          Evan_Claude: presenceEntry({ name: "Evan_Claude", account: "lark:on_evan" }),
          Evan_opencoder: presenceEntry({ name: "Evan_opencoder", account: "lark:on_evan" }),
        },
      }),
    );
    openUnassigned();
    expect(personNames().length).toBe(4);
  });

  test("unassigned rows are labeled distinctly instead of showing a stale role badge", () => {
    render(
      baseProps({
        presence: {
          Evan_Claude: presenceEntry({ name: "Evan_Claude", account: "lark:on_evan" }),
        },
      }),
    );
    const toggle = renderer!.root.findByProps({ className: "role-unassigned-toggle t-mono" });
    expect(toggle.findAllByType("span").some((node) => String(node.props.children).includes("未认领"))).toBe(true);
    expect(personNames()).not.toContain("Evan_Claude");
    openUnassigned();
    expect(personNames()).toContain("Evan_Claude");
    const chip = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-unassigned-chip"),
    );
    expect(chip.type).toBe("span");
  });

  test("only moderators can click an unassigned member to prefill the claim form", () => {
    let selected = "";
    render(
      baseProps({
        canModerate: true,
        presence: { Evan_Claude: presenceEntry({ name: "Evan_Claude", account: "lark:on_evan" }) },
        onNewRoleName: (name) => { selected = name; },
      }),
    );
    openUnassigned();
    const chip = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-unassigned-chip"),
    );
    expect(chip.type).toBe("button");
    act(() => chip.props.onClick());
    expect(selected).toBe("Evan_Claude");
  });
});

// issue #168：分工要看得出组织架构关系——每个 agent 的汇报人（来自 presence
// lineage.parent_agent，agentparty 的 dispatch 关系本就是"谁派我我向谁汇报"）、
// 每个频道的主负责人（已有的 host 分工角色），以及汇报对象是否在本频道可见。
describe("DivisionBoard org-structure relationships (#168)", () => {
  function findText(className: string): string[] {
    return renderer!.root
      .findAll((n) => n.props.className === className)
      .map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children)));
  }

  // 汇报对象是否恰好也在本频道 roster 里，决定渲染成 "role-report t-mono" 还是
  // "role-report role-report--external t-mono"（见下面两个专门测试）；这条测试只
  // 关心「汇报关系文字有没有渲染出来」，两种 class 都收。
  function anyReportText(): string[] {
    return [...findText("role-report t-mono"), ...findText("role-report role-report--external t-mono")];
  }

  test("a declared role with lineage shows who it reports to", () => {
    render(
      baseProps({
        roles: [
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          "worker-a": presenceEntry({
            name: "worker-a",
            account: "leo",
            lineage: { parent_agent: "leo-claude", root_agent: "leo-claude", team_id: "t1", depth: 1, expires_at: null },
          }),
        },
      }),
    );
    expect(anyReportText().some((line) => line.includes("leo-claude"))).toBe(true);
  });

  test("a role with no lineage shows no reporting badge", () => {
    render(
      baseProps({
        roles: [
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: { "worker-a": presenceEntry({ name: "worker-a", account: "leo" }) },
      }),
    );
    expect(findText("role-report t-mono").length).toBe(0);
  });

  test("the host role is tagged as the channel lead", () => {
    render(
      baseProps({
        roles: [
          { name: "leo-claude", role: "host", responsibility: "统筹", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "leo-claude" },
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }),
          "worker-a": presenceEntry({ name: "worker-a", account: "leo" }),
        },
      }),
    );
    const leadTags = renderer!.root.findAll((n) => n.props.className === "role-lead-tag t-mono");
    expect(leadTags.length).toBe(1);
  });

  test("flags when the reporting target isn't part of this channel's roster", () => {
    render(
      baseProps({
        roles: [
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          "worker-a": presenceEntry({
            name: "worker-a",
            account: "leo",
            lineage: { parent_agent: "someone-not-in-channel", root_agent: "someone-not-in-channel", team_id: "t1", depth: 1, expires_at: null },
          }),
        },
      }),
    );
    const externalHints = renderer!.root.findAll((n) => n.props.className === "role-report role-report--external t-mono");
    expect(externalHints.length).toBe(1);
  });

  test("does not flag a reporting target that IS visible in this channel's roster", () => {
    render(
      baseProps({
        roles: [
          { name: "leo-claude", role: "host", responsibility: "统筹", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "leo-claude" },
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }),
          "worker-a": presenceEntry({
            name: "worker-a",
            account: "leo",
            lineage: { parent_agent: "leo-claude", root_agent: "leo-claude", team_id: "t1", depth: 1, expires_at: null },
          }),
        },
      }),
    );
    const externalHints = renderer!.root.findAll((n) => n.props.className === "role-report role-report--external t-mono");
    expect(externalHints.length).toBe(0);
  });
});

// issue #150：分工内容应该能一键同步进公告（charter）。这里测的是 DivisionBoard
// 把当前已声明分工（assigned + self）拼成 markdown 小节、合并进现有公告文本、
// 再把结果通过 onSyncToCharter 交给上层去落盘——按钮本身不发网络请求。
describe("DivisionBoard sync-to-charter (#150)", () => {
  test("moderator sees a sync button that merges declared roles into the existing charter text", () => {
    let synced: string | null = null;
    render(
      baseProps({
        canModerate: true,
        charterText: "# Team charter\n\nBe kind to each other.",
        roles: [
          { name: "leo-claude", role: "host", responsibility: "统筹", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "leo-claude" },
        ],
        presence: { "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }) },
        onSyncToCharter: (text: string) => { synced = text; },
      }),
    );
    const btn = renderer!.root.find((n) => n.props.className === "d-btn role-sync-charter-btn");
    act(() => btn.props.onClick());
    expect(synced).not.toBeNull();
    expect(synced as unknown as string).toContain("leo-claude");
    expect(synced as unknown as string).toContain("Be kind to each other.");
  });

  test("non-moderators do not see the sync-to-charter button", () => {
    render(baseProps({ canModerate: false }));
    const btn = renderer!.root.findAll((n) => n.props.className === "d-btn role-sync-charter-btn");
    expect(btn.length).toBe(0);
  });
});

// issue #150（缺口）：头号诉求是「分工/角色变化即自动同步到公告」，此前只有手动按钮。
// 这里测自动同步 effect：分工变化去抖后自动落盘、非 moderator 静默跳过、内容一致时
// 幂等不重复写。手动按钮保留为兜底（上一组已覆盖），默认自动。
describe("DivisionBoard auto-sync-to-charter (#150)", () => {
  const hostRole = {
    name: "leo-claude", role: "host" as const, responsibility: "统筹", assigned_by: "leo",
    assigned_at: 1, kind: "agent" as const, account: "leo", display: "leo-claude",
  };

  test("moderator auto-syncs declared roles into the charter with no button click", async () => {
    let synced: string | null = null;
    render(
      baseProps({
        canModerate: true,
        charterText: "# Team charter\n\nBe kind to each other.",
        roles: [hostRole],
        presence: { "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }) },
        onSyncToCharter: (text: string) => { synced = text; },
      }),
    );
    // 没有任何点击——纯靠 effect + 去抖触发。
    await flushAutoSync();
    expect(synced).not.toBeNull();
    expect(synced as unknown as string).toContain("leo-claude");
    expect(synced as unknown as string).toContain("Be kind to each other.");
  });

  test("non-moderators never auto-write the charter (silent skip, no failing 403 write)", async () => {
    let synced: string | null = null;
    render(
      baseProps({
        canModerate: false,
        charterText: "# Team charter",
        roles: [hostRole],
        presence: { "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }) },
        onSyncToCharter: (text: string) => { synced = text; },
      }),
    );
    await flushAutoSync();
    expect(synced).toBeNull();
  });

  test("does not auto-write out of nothing when there is no division and no existing section", async () => {
    let synced: string | null = null;
    render(
      baseProps({
        canModerate: true,
        charterText: "# Team charter\n\nBe kind.",
        roles: [],
        presence: {},
        onSyncToCharter: (text: string) => { synced = text; },
      }),
    );
    await flushAutoSync();
    expect(synced).toBeNull();
  });

  test("idempotent: no second auto-write once the charter already holds the up-to-date section", async () => {
    // 第一阶段：空底稿 + 分工，自动写出合并结果。
    let synced: string | null = null;
    render(
      baseProps({
        canModerate: true,
        charterText: "# Team charter\n\nBe kind.",
        roles: [hostRole],
        presence: { "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }) },
        onSyncToCharter: (text: string) => { synced = text; },
      }),
    );
    await flushAutoSync();
    const firstWrite = synced;
    expect(firstWrite).not.toBeNull();
    act(() => renderer!.unmount());
    renderer = null;

    // 第二阶段：把「已同步好的公告」作为底稿重新渲染，同一份分工——合并结果与现状一致，
    // 不应再触发任何写入（幂等，防重复堆叠 / 防自我循环）。
    let secondWrite: string | null = null;
    render(
      baseProps({
        canModerate: true,
        charterText: firstWrite as unknown as string,
        roles: [hostRole],
        presence: { "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }) },
        onSyncToCharter: (text: string) => { secondWrite = text; },
      }),
    );
    await flushAutoSync();
    expect(secondWrite).toBeNull();
  });
});

// issue #171：分工面板应该能跳到「查看/编辑每个 agent 自己的规则」（已用
// AgentTokens 面板实现，见 commit 7f7e8e1）——这里只测入口按钮的存在性/门禁和
// 点击转发，不重复造 AgentTokens 的规则编辑逻辑。
describe("DivisionBoard agent-rules entry point (#171)", () => {
  test("shows a link to the agent rules editor when the viewer can manage agent profiles", () => {
    let opened = false;
    render(baseProps({ canManageAgentRules: true, onOpenAgentRules: () => { opened = true; } }));
    const btn = renderer!.root.find((n) => n.props.className === "d-btn role-open-rules-btn");
    act(() => btn.props.onClick());
    expect(opened).toBe(true);
  });

  test("hides the link when the viewer cannot manage agent profiles", () => {
    render(baseProps({ canManageAgentRules: false }));
    const btn = renderer!.root.findAll((n) => n.props.className === "d-btn role-open-rules-btn");
    expect(btn.length).toBe(0);
  });
});
