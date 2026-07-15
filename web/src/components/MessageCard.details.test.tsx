// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { ChannelStrings } from "../i18n/strings/Channel";

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

function renderStatus(): ReturnType<ReactTestRenderer["root"]["findByProps"]> {
  const msg = {
    type: "msg", seq: 9, sender: { name: "builder", kind: "agent", owner: "team@example.com" }, kind: "status",
    body: "", mentions: [], reply_to: null, state: "blocked", note: "waiting for approval",
    status: { scope: ["web"], blocked_reason: "need human", summary_seq: 8, context: { worktree_label: "issue-357" } },
    ts: 1_700_000_000_000,
  } as unknown as MsgFrame;
  act(() => {
    renderer = create(<LocaleProvider><MessageCard
      msg={msg} self={null} quotedMessage={null} canModerate={false} onReply={noop} onEdit={noop}
      onRetract={noop} canCreateTask={false} onCreateTask={noop} editing={false} editDraft=""
      editSaving={false} actionError={null} busy={false} onEditDraftChange={noop} onEditCancel={noop} onEditSave={noop}
    /></LocaleProvider>);
  });
  return renderer!.root;
}

function renderMessage(): ReturnType<ReactTestRenderer["root"]["findByProps"]> {
  const msg = {
    type: "msg", seq: 10, sender: { name: "builder", kind: "agent", owner: "team@example.com" }, kind: "message",
    body: "finished", mentions: [], reply_to: null, state: null, note: null, status: null,
    ts: 1_700_000_000_000,
  } as unknown as MsgFrame;
  act(() => {
    renderer = create(<LocaleProvider><MessageCard
      msg={msg} self={null} quotedMessage={null} canModerate={false} onReply={noop} onEdit={noop}
      onRetract={noop} canCreateTask={false} onCreateTask={noop} editing={false} editDraft=""
      editSaving={false} actionError={null} busy={false} onEditDraftChange={noop} onEditCancel={noop} onEditSave={noop}
    /></LocaleProvider>);
  });
  return renderer!.root;
}

describe("MessageCard touch and keyboard details (#357)", () => {
  test("identity and stable action metadata render in separate header groups", () => {
    const root = renderMessage();
    const main = root.findByProps({ className: "msg-head-main" });
    const meta = root.findByProps({ className: "msg-head-meta" });

    expect(main.findByProps({ className: "msg-sender msg-agent-trigger" })).toBeDefined();
    expect(meta.findByProps({ className: "d-btn msg-menu-trigger" })).toBeDefined();
    expect(meta.findByProps({ className: "msg-seq" }).children).toEqual(["#", "10"]);
    expect(meta.findByProps({ className: "msg-time" })).toBeDefined();
  });

  test("status full detail expands by click and keyboard", () => {
    const root = renderStatus();
    const summary = root.findByProps({ className: "msg-status-summary" });
    expect(summary.props.tabIndex).toBe(0);
    expect(summary.props["aria-expanded"]).toBe(false);
    act(() => summary.props.onKeyDown({ key: "Enter", preventDefault() {} }));
    expect(root.findByProps({ className: "msg-status-detail t-mono" }).children.join("")).toContain("need human");
    act(() => summary.props.onClick());
    expect(root.findAllByProps({ className: "msg-status-detail t-mono" })).toHaveLength(0);
  });

  test("context ellipsis is an accessible button with inline details", () => {
    const root = renderStatus();
    const more = root.findByProps({ className: "t-mono msg-context-more" });
    expect(more.type).toBe("button");
    expect(more.props["aria-label"]).toBe("Show message context");
    expect(ChannelStrings.zh["Channel.message.context.toggle"]).not.toBe(ChannelStrings.en["Channel.message.context.toggle"]);
    expect(more.props["aria-expanded"]).toBe(false);
    act(() => more.props.onClick());
    const detail = root.findByProps({ className: "msg-context msg-context-detail" });
    const bits = detail.findAll((node) => node.type === "span" && node.props.className === "t-mono")
      .map((node) => node.children.join(""));
    expect(bits).toContain("owner:team@example.com");
    expect(bits).toContain("wt:issue-357");
  });
});
