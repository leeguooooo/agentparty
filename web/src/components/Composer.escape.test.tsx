// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { Composer } from "./Composer";

let renderer: ReactTestRenderer | null = null;

function memoryStorage(): Storage {
  const values = new Map<string, string>([["ap_locale", "en"]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerHeight: 844 } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(onEscape: () => void) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <Composer
          draft="@a"
          setDraft={() => undefined}
          onSend={() => undefined}
          onEscape={onEscape}
          ready
          candidates={[{ name: "alice", display: "Alice", kind: "agent", tier: "online", group: "unowned agents" }]}
          mentionStatuses={[]}
        />
      </LocaleProvider>,
    );
  });
  const textarea = renderer!.root.findByProps({ className: "composer-input t-mono" });
  return { root: renderer!.root, textarea };
}

function keyEvent(key: string, isComposing = false) {
  return { key, preventDefault() {}, nativeEvent: { isComposing }, shiftKey: false, metaKey: false, ctrlKey: false };
}

describe("Composer Escape handling (#357)", () => {
  test("focuses and reveals the composer when reply mode starts", () => {
    const focus = mock(() => undefined);
    const scrollIntoView = mock(() => undefined);

    act(() => {
      renderer = create(
        <LocaleProvider>
          <Composer
            draft=""
            setDraft={() => undefined}
            onSend={() => undefined}
            focusRequest={3}
            ready
            candidates={[]}
            mentionStatuses={[]}
          />
        </LocaleProvider>,
        {
          createNodeMock: (element) =>
            element.type === "textarea"
              && (element.props as { className?: string }).className?.includes("composer-input") === true
              ? { focus, scrollIntoView, style: {}, scrollHeight: 80 }
              : {},
        },
      );
    });

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  test("mention menu consumes the first Escape before reply cancellation", () => {
    let cancelled = 0;
    const { root, textarea } = render(() => { cancelled += 1; });
    act(() => textarea.props.onClick({ currentTarget: { value: "@a", selectionStart: 2 } }));
    expect(root.findAllByProps({ role: "listbox" })).toHaveLength(1);

    act(() => textarea.props.onKeyDown(keyEvent("Escape")));
    expect(root.findAllByProps({ role: "listbox" })).toHaveLength(0);
    expect(cancelled).toBe(0);

    act(() => textarea.props.onKeyDown(keyEvent("Escape")));
    expect(cancelled).toBe(1);
  });

  test("IME composition does not close mentions or cancel reply mode", () => {
    let cancelled = 0;
    const { root, textarea } = render(() => { cancelled += 1; });
    act(() => textarea.props.onClick({ currentTarget: { value: "@a", selectionStart: 2 } }));

    act(() => textarea.props.onKeyDown(keyEvent("Escape", true)));
    expect(root.findAllByProps({ role: "listbox" })).toHaveLength(1);
    expect(cancelled).toBe(0);
  });
});
