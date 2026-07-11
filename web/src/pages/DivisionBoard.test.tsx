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
    .findAll((n) => n.props.className === "role-person-name t-mono")
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children)));
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
    const unassignedLabel = renderer!.root.findAll((n) => n.props.className === "role-source role-source--unassigned t-mono");
    expect(unassignedLabel.length).toBe(1);
  });
});
