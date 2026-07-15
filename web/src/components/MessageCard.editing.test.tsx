// #343: The inline message editor supports keyboard save/cancel shortcuts without
// interfering with newlines or IME composition.
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

mock.module("../lib/markdown", () => ({ renderMarkdown: (source: string) => source }));
const { MessageCard } = await import("./MessageCard");

let renderer: ReactTestRenderer | null = null;

const noop = () => undefined;

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

function baseMsg(): MsgFrame {
  return {
    type: "msg",
    seq: 7,
    sender: { name: "planner", kind: "agent" },
    kind: "message",
    body: "original",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1_700_000_000_000,
  } as MsgFrame;
}

function renderEditor(extra: Record<string, unknown> = {}): ReactTestInstance {
  localStorage.setItem("ap_locale", "en");
  act(() => {
    renderer = create(
      <LocaleProvider>
        <MessageCard
          msg={baseMsg()}
          self="planner"
          quotedMessage={null}
          canModerate={false}
          onReply={noop}
          onEdit={noop}
          onRetract={noop}
          canCreateTask={false}
          onCreateTask={noop}
          editing={true}
          editDraft="changed"
          editSaving={false}
          actionError={null}
          busy={false}
          onEditDraftChange={noop}
          onEditCancel={noop}
          onEditSave={noop}
          {...extra}
        />
      </LocaleProvider>,
    );
  });
  return renderer!.root.findByType("textarea");
}

function keyEvent(key: string, overrides: Record<string, unknown> = {}) {
  let prevented = false;
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => { prevented = true; },
    wasPrevented: () => prevented,
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("message edit keyboard shortcuts (#343)", () => {
  test("focuses and reveals the editor when editing starts", () => {
    const focus = mock(() => undefined);
    const scrollIntoView = mock(() => undefined);
    const card = (editing: boolean) => (
      <LocaleProvider>
        <MessageCard
          msg={baseMsg()}
          self="planner"
          quotedMessage={null}
          canModerate={false}
          onReply={noop}
          onEdit={noop}
          onRetract={noop}
          canCreateTask={false}
          onCreateTask={noop}
          editing={editing}
          editDraft="changed"
          editSaving={false}
          actionError={null}
          busy={false}
          onEditDraftChange={noop}
          onEditCancel={noop}
          onEditSave={noop}
        />
      </LocaleProvider>
    );

    localStorage.setItem("ap_locale", "en");
    act(() => {
      renderer = create(
        card(false),
        {
          createNodeMock: (element) =>
            element.type === "textarea"
              && (element.props as { className?: string }).className?.includes("msg-edit-input") === true
              ? { focus, scrollIntoView }
              : {},
        },
      );
    });

    expect(focus).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => renderer!.update(card(true)));

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  test("Escape cancels editing", () => {
    let cancelCalls = 0;
    const textarea = renderEditor({ onEditCancel: () => { cancelCalls += 1; } });
    const event = keyEvent("Escape");

    act(() => textarea.props.onKeyDown(event));

    expect(cancelCalls).toBe(1);
    expect(event.wasPrevented()).toBe(true);
  });

  test("Cmd+Enter saves editing", () => {
    let saveCalls = 0;
    const textarea = renderEditor({ onEditSave: () => { saveCalls += 1; } });
    const event = keyEvent("Enter", { metaKey: true });

    act(() => textarea.props.onKeyDown(event));

    expect(saveCalls).toBe(1);
    expect(event.wasPrevented()).toBe(true);
  });

  test("Ctrl+Enter saves editing", () => {
    let saveCalls = 0;
    const textarea = renderEditor({ onEditSave: () => { saveCalls += 1; } });
    const event = keyEvent("Enter", { ctrlKey: true });

    act(() => textarea.props.onKeyDown(event));

    expect(saveCalls).toBe(1);
    expect(event.wasPrevented()).toBe(true);
  });

  test("plain Enter keeps the textarea newline behavior", () => {
    let saveCalls = 0;
    const textarea = renderEditor({ onEditSave: () => { saveCalls += 1; } });
    const event = keyEvent("Enter");

    act(() => textarea.props.onKeyDown(event));

    expect(saveCalls).toBe(0);
    expect(event.wasPrevented()).toBe(false);
  });

  test("save shortcut does not save again while editSaving", () => {
    let saveCalls = 0;
    const textarea = renderEditor({ editSaving: true, onEditSave: () => { saveCalls += 1; } });
    const event = keyEvent("Enter", { metaKey: true });

    act(() => textarea.props.onKeyDown(event));

    expect(saveCalls).toBe(0);
    expect(event.wasPrevented()).toBe(true);
  });

  test("IME composition does not trigger cancel or save shortcuts", () => {
    let cancelCalls = 0;
    let saveCalls = 0;
    const textarea = renderEditor({
      onEditCancel: () => { cancelCalls += 1; },
      onEditSave: () => { saveCalls += 1; },
    });
    const composing = { nativeEvent: { isComposing: true } };
    const escapeEvent = keyEvent("Escape", composing);
    const saveEvent = keyEvent("Enter", { ...composing, metaKey: true });

    act(() => textarea.props.onKeyDown(escapeEvent));
    act(() => textarea.props.onKeyDown(saveEvent));

    expect(cancelCalls).toBe(0);
    expect(saveCalls).toBe(0);
    expect(escapeEvent.wasPrevented()).toBe(false);
    expect(saveEvent.wasPrevented()).toBe(false);
  });
});
