// #729：输入法确认候选的回车不能误发消息。WebKit/WKWebView(桌面版)里 compositionend 早于
// 确认键 keydown,那一刻 isComposing 已是 false——只靠 isComposing 会漏拦。这里用可控的 rAF
// 精确复现「compositionend → 确认 Enter(isComposing=false) → 才放开护栏」的时序。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { Composer } from "./Composer";

let renderer: ReactTestRenderer | null = null;
let rafQueue: Array<() => void> = [];

function memoryStorage(): Storage {
  const values = new Map<string, string>([["ap_locale", "en"]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
}

beforeEach(() => {
  rafQueue = [];
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerHeight: 844 } });
  // 可控 rAF:攒起来,由测试决定何时放开护栏。
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; },
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "requestAnimationFrame");
});

function render(onSend: () => void) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <Composer
          draft="你好"
          setDraft={() => undefined}
          onSend={onSend}
          ready
          candidates={[]}
          mentionStatuses={[]}
        />
      </LocaleProvider>,
    );
  });
  return renderer!.root.findByProps({ className: "composer-input t-mono" });
}

function enter(isComposing = false) {
  return { key: "Enter", preventDefault() {}, nativeEvent: { isComposing }, shiftKey: false, metaKey: false, ctrlKey: false };
}

describe("Composer 输入法回车不误发 (#729)", () => {
  test("WebKit 时序:compositionend 后、护栏未放开时的确认 Enter(isComposing=false) 不发送", () => {
    let sends = 0;
    const ta = render(() => { sends += 1; });
    act(() => ta.props.onCompositionStart());
    act(() => ta.props.onCompositionEnd()); // 把放开动作压进 rafQueue(未执行)
    act(() => ta.props.onKeyDown(enter(false))); // 确认候选的回车
    expect(sends).toBe(0);
    // 放开护栏后,真正的回车才发送
    act(() => { rafQueue.forEach((cb) => cb()); });
    act(() => ta.props.onKeyDown(enter(false)));
    expect(sends).toBe(1);
  });

  test("合成中(isComposing=true)的 Enter 一律不发送", () => {
    let sends = 0;
    const ta = render(() => { sends += 1; });
    act(() => ta.props.onCompositionStart());
    act(() => ta.props.onKeyDown(enter(true)));
    expect(sends).toBe(0);
  });

  test("非合成状态下普通 Enter 正常发送", () => {
    let sends = 0;
    const ta = render(() => { sends += 1; });
    act(() => ta.props.onKeyDown(enter(false)));
    expect(sends).toBe(1);
  });
});
