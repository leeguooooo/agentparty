// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { DirectedDelivery, MsgFrame, PublicDirectedDelivery } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { ChannelStrings } from "../i18n/strings/Channel";
import type { MentionReceipt } from "../lib/wakeReceipt";

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

function renderMessage(
  deliveries: PublicDirectedDelivery[] = [],
  receipts: MentionReceipt[] = [],
): ReturnType<ReactTestRenderer["root"]["findByProps"]> {
  const msg = {
    type: "msg", seq: 10, sender: { name: "builder", kind: "agent", owner: "team@example.com" }, kind: "message",
    body: "finished", mentions: [], reply_to: null, state: null, note: null, status: null,
    ts: 1_700_000_000_000,
  } as unknown as MsgFrame;
  act(() => {
    renderer = create(<LocaleProvider><MessageCard
      msg={msg} self={null} quotedMessage={null} canModerate={false} onReply={noop} onEdit={noop}
      deliveries={deliveries}
      receipts={receipts}
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

  test("directed delivery renders the durable state and suppresses the legacy guess for that target", () => {
    // Deliberately bypass the public prop type to prove the view remains coarse even if a caller hands it
    // a holder-only object. The reducer has a stronger allow-list test in state.test.ts.
    const maliciousDelivery: DirectedDelivery = {
      id: "delivery-10-builder",
      message_seq: 10,
      target_name: "builder",
      cause: "mention",
      state: "running",
      attempt: 2,
      lease_until: 1_700_000_090_000,
      work_id: "work-10",
      continuation_ref: "thread-10",
      reply_seq: null,
      last_error: "secret internal stack",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_001_000,
    };
    const root = renderMessage([maliciousDelivery], [{ name: "builder", state: "pending_wake", detail: null, at: null }]);

    const delivery = root.findByProps({ "data-delivery-id": "delivery-10-builder" });
    expect(delivery.props.className).toContain("msg-delivery--running");
    expect(delivery.children.map((child) => typeof child === "string" ? child : child.children.join("")).join(""))
      .toContain("@builderrunning");
    expect(delivery.props.title).not.toContain("attempt 2");
    expect(delivery.props.title).not.toContain("work-10");
    expect(delivery.props.title).not.toContain("thread-10");
    expect(delivery.props.title).not.toContain("secret internal stack");
    expect(root.findAll((node) => String(node.props.className ?? "").includes("msg-receipt--pending_wake"))).toHaveLength(0);
  });
});
