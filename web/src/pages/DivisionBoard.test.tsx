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
  test("self-reported roles stay visible but do not count as confirmed assignments", () => {
    render(
      baseProps({
        identities: [{ name: "runtime-agent", kind: "agent", display: "Runtime Agent", account: "leo" }],
        presence: {
          "runtime-agent": presenceEntry({
            name: "runtime-agent",
            role: "worker",
            role_source: "self",
            note: "runtime claim",
          }),
        },
      }),
    );

    const count = renderer!.root.find((node) => node.props.className === "t-mono role-board-count");
    expect(JSON.stringify(count.props.children)).toContain("0");
    expect(JSON.stringify(renderer!.toJSON())).toContain("自报");
  });

  test("role editing stays collapsed until requested and collapses again after save (#504)", () => {
    let savedName = "";
    render(
      baseProps({
        canModerate: true,
        roles: [
          {
            name: "leo-claude",
            role: "host",
            responsibility: "统筹交付",
            assigned_by: "leo",
            assigned_at: 1,
            kind: "agent",
            account: "lark:on_leo",
            display: "leo-claude",
          },
        ],
        presence: { "leo-claude": presenceEntry({ name: "leo-claude", account: "lark:on_leo", live: true }) },
        onSaveRole: (name) => { savedName = name; },
      }),
    );
    let card = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-row--card"),
    );
    expect(card.findAllByType("select")).toHaveLength(0);
    expect(card.findAllByType("input")).toHaveLength(0);

    const edit = card.findByProps({ className: "d-btn role-edit-btn" });
    act(() => edit.props.onClick());
    card = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-row--card"),
    );
    expect(card.findAllByType("select")).toHaveLength(1);
    expect(card.findAllByType("input")).toHaveLength(1);
    const save = card.findAllByType("button").find((node) => String(node.props.children).includes("保存"));
    expect(save).toBeDefined();
    act(() => save!.props.onClick());

    card = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-row--card"),
    );
    expect(savedName).toBe("leo-claude");
    expect(card.findAllByType("select")).toHaveLength(0);
    expect(card.findByProps({ className: "d-btn role-edit-btn" })).toBeDefined();
    expect(personNames()).toContain("leo-claude");
  });

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

// issue #168 + #370：分工要看得出正式组织架构关系。唯一权威来源是 channel_roles；
// presence lineage / self-report 只描述运行时事实，不能提升成正式汇报线或频道负责人。
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

  test("the compact org button is the single control for showing the full tree (#504)", () => {
    render(
      baseProps({
        roles: [
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: { "worker-a": presenceEntry({ name: "worker-a", account: "leo" }) },
      }),
    );

    const toggle = renderer!.root.find((node) => node.props.className === "d-btn role-org-toggle");
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(toggle.props["aria-controls"]).toBe("division-org-tree");
    expect(renderer!.root.findAllByProps({ id: "division-org-tree" })).toHaveLength(0);

    act(() => toggle.props.onClick());

    expect(toggle.props["aria-expanded"]).toBe(true);
    const tree = renderer!.root.find((node) => node.type === "section" && node.props.id === "division-org-tree");
    expect(tree.type).toBe("section");
    expect(tree.findAllByType("details")).toHaveLength(0);
  });

  test("runtime lineage is not promoted to a formal reports-to relationship", () => {
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
    expect(anyReportText()).toHaveLength(0);
  });

  test("a declared role shows its formal channel_roles reports_to relationship", () => {
    render(
      baseProps({
        roles: [
          { name: "lead", role: "host", responsibility: "leads", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "lead" },
          { name: "worker-a", role: "worker", responsibility: "ships x", reports_to: "lead", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          lead: presenceEntry({ name: "lead", account: "leo" }),
          "worker-a": presenceEntry({ name: "worker-a", account: "leo" }),
        },
      }),
    );
    expect(anyReportText().some((line) => line.includes("lead"))).toBe(true);
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

  test("a self-reported host is never tagged as the channel lead", () => {
    render(
      baseProps({
        presence: {
          "self-host": presenceEntry({
            name: "self-host",
            account: "leo",
            role: "host",
            role_source: "self",
          }),
        },
      }),
    );

    expect(renderer!.root.findAll((node) => node.props.className === "role-lead-tag t-mono")).toHaveLength(0);
    const toggle = renderer!.root.find((node) => node.props.className === "d-btn role-org-toggle");
    act(() => toggle.props.onClick());
    expect(renderer!.root.findAll((node) => node.props.className === "org-lead-tag t-mono")).toHaveLength(0);
  });

  test("flags when the reporting target isn't part of this channel's roster", () => {
    render(
      baseProps({
        roles: [
          { name: "worker-a", role: "worker", responsibility: "ships x", reports_to: "someone-not-in-channel", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: { "worker-a": presenceEntry({ name: "worker-a", account: "leo" }) },
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
          { name: "worker-a", role: "worker", responsibility: "ships x", reports_to: "leo-claude", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }),
          "worker-a": presenceEntry({ name: "worker-a", account: "leo" }),
        },
      }),
    );
    const externalHints = renderer!.root.findAll((n) => n.props.className === "role-report role-report--external t-mono");
    expect(externalHints.length).toBe(0);
  });

  test("reports-to editor is only available for confirmed assignments", () => {
    render(
      baseProps({
        canModerate: true,
        roles: [
          { name: "assigned-lead", role: "host", responsibility: "统筹", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "assigned-lead" },
        ],
        presence: {
          "assigned-lead": presenceEntry({ name: "assigned-lead", account: "leo" }),
          "self-host": presenceEntry({ name: "self-host", account: "leo", role: "host", role_source: "self" }),
          "runtime-only": presenceEntry({ name: "runtime-only", account: "leo" }),
        },
        onSetReportsTo: noop,
      }),
    );

    const toggle = renderer!.root.find((node) => node.props.className === "d-btn role-org-toggle");
    act(() => toggle.props.onClick());
    const selects = renderer!.root.findAll((node) => node.props.className === "org-report-select");
    expect(selects).toHaveLength(1);
    expect(String(selects[0]!.props["aria-label"])).toContain("assigned-lead");
    const optionValues = selects[0]!.findAllByType("option").map((option) => option.props.value);
    expect(optionValues).not.toContain("self-host");
    expect(optionValues).not.toContain("runtime-only");
  });
});

// issue #150：分工内容应该能一键同步进公告（charter）。这里测的是 DivisionBoard
// 把当前正式分工（只含 channel_roles）拼成 markdown 小节、合并进现有公告文本；
// presence 自报只能作为待确认 claim 展示，不能写成频道正式分工。
// 再把结果通过 onSyncToCharter 交给上层去落盘——按钮本身不发网络请求。
describe("DivisionBoard sync-to-charter (#150)", () => {
  test("syncs only confirmed agent roles and drops self-reports plus stale unresolved owner roles", () => {
    let synced: string | null = null;
    render(
      baseProps({
        canModerate: true,
        charterText: "# Team charter",
        roles: [
          { name: "lark:on_owner", role: "host", responsibility: "大脑", assigned_by: "leo", assigned_at: 1 },
          { name: "ai-girl", role: "worker", responsibility: "服务中台", assigned_by: "leo", assigned_at: 1, kind: "agent", display: "ai-girl" },
        ],
        presence: {
          "ai-girl-host-codex": presenceEntry({ name: "ai-girl-host-codex", role: "host", role_source: "self", note: "大脑大脑" }),
          "ai-girl": presenceEntry({ name: "ai-girl" }),
        },
        onSyncToCharter: (text: string) => { synced = text; },
      }),
    );
    const btn = renderer!.root.find((n) => n.props.className === "d-btn role-sync-charter-btn");
    act(() => btn.props.onClick());
    expect(synced).not.toContain("ai-girl-host-codex");
    expect(synced).toContain("**ai-girl**（未归属 agent）— worker");
    expect(synced).not.toContain("lark:on_owner");
  });

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
        presence: {
          "self-only": presenceEntry({
            name: "self-only",
            role: "worker",
            role_source: "self",
            note: "runtime claim only",
          }),
        },
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
