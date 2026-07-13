// #434：消息头展示发送方 CLI 版本徽标（cli vX）。落后判定依赖服务端 /api/version 的 min_client_version，
// bun 单测（react-test-renderer，无 window）下 useMinClientVersion 恒为 null，故这里只验证「版本文本渲染 /
// 无版本时不渲染」；落后转琥珀 + ⚠ 的比较逻辑由 lib/clientVersion.test.ts 单测覆盖。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

mock.module("../lib/markdown", () => ({ renderMarkdown: (s: string) => s }));
const { MessageCard } = await import("./MessageCard");

let renderer: ReactTestRenderer | null = null;
const noop = () => undefined;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => "en", setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0,
  } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(msg: MsgFrame): ReactTestInstance {
  act(() => {
    renderer = create(<LocaleProvider><MessageCard
      msg={msg} self={null} quotedMessage={null} canModerate={false} onReply={noop} onEdit={noop}
      onRetract={noop} canCreateTask={false} onCreateTask={noop} editing={false} editDraft=""
      editSaving={false} actionError={null} busy={false} onEditDraftChange={noop} onEditCancel={noop} onEditSave={noop}
    /></LocaleProvider>);
  });
  return renderer!.root;
}

function versionBadges(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((n) => n.type === "span" && String(n.props.className ?? "").includes("msg-client-version"));
}

const base = {
  type: "msg", seq: 7, kind: "message", body: "hi", mentions: [], reply_to: null,
  state: null, note: null, status: null, ts: 1_700_000_000_000,
} as const;

describe("MessageCard sender CLI version (#434)", () => {
  test("sender.client_version 有值 → 渲染 cli vX 徽标", () => {
    const msg = { ...base, sender: { name: "planner", kind: "agent", client_version: "0.3.1" } } as unknown as MsgFrame;
    const badges = versionBadges(render(msg));
    expect(badges.length).toBeGreaterThan(0);
    const text = badges[0]!.children.filter((c) => typeof c === "string").join("");
    expect(text).toContain("cli v");
    expect(text).toContain("0.3.1");
    // min 未知（测试环境无 window）→ 不标落后。
    expect(badges.some((b) => String(b.props.className ?? "").includes("--outdated"))).toBe(false);
  });

  test("sender 无 client_version → 不渲染徽标", () => {
    const msg = { ...base, sender: { name: "planner", kind: "agent" } } as unknown as MsgFrame;
    expect(versionBadges(render(msg))).toHaveLength(0);
  });
});
