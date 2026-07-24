// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { useT } from "../i18n/useT";
import { OnboardingGuide } from "./OnboardingGuide";
import { OnboardingStrings } from "../i18n/strings/Onboarding";

const STORAGE_KEY = "ap_onboarded";

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
interface KeyEventHarness {
  key: string;
  shiftKey?: boolean;
  preventDefault?: () => void;
}
let keyHandlers: Array<(e: KeyEventHarness) => void> = [];

function render(props: Parameters<typeof OnboardingGuide>[0] = {}) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <OnboardingGuide {...props} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function steps() {
  return renderer!.root.findAll((n) => n.props.className === "onboarding-step");
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  keyHandlers = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (type: string, fn: (e: KeyEventHarness) => void) => {
        if (type === "keydown") keyHandlers.push(fn);
      },
      removeEventListener: (type: string, fn: (e: KeyEventHarness) => void) => {
        if (type === "keydown") keyHandlers = keyHandlers.filter((h) => h !== fn);
      },
    },
  });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = null;
  }
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

describe("OnboardingGuide (#146)", () => {
  test("shows the 4-step guide on first visit (no ap_onboarded flag)", () => {
    render();
    // 首次进入：标记未落 → 四步全渲染
    expect(steps().length).toBe(4);
  });

  test("does not render when ap_onboarded is already set", () => {
    localStorage.setItem(STORAGE_KEY, "1");
    render();
    expect(steps().length).toBe(0);
    // 整个浮层都不该在
    expect(renderer!.root.findAll((n) => n.props.className === "onboarding-card").length).toBe(0);
  });

  test("dismissing writes the flag and hides the guide", () => {
    const root = render();
    expect(steps().length).toBe(4);

    const dismissBtn = root
      .findAll((n) => n.type === "button")
      .find((n) => n.props.className?.includes("onboarding-dismiss"));
    if (!dismissBtn) throw new Error("dismiss button not rendered");

    act(() => { dismissBtn.props.onClick(); });

    // 关掉后：标记落库 + 浮层消失
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
    expect(steps().length).toBe(0);
  });

  test("Escape 关闭模态并落库（#637 与其它模态一致）", () => {
    render();
    expect(steps().length).toBe(4);
    // 模拟按下 Esc：触发挂到 window 的 keydown 监听
    act(() => { keyHandlers.forEach((h) => h({ key: "Escape" })); });
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
    expect(steps().length).toBe(0);
  });

  test("closing via the ✕ also persists and hides", () => {
    const root = render();
    const closeBtn = root
      .findAll((n) => n.type === "button")
      .find((n) => n.props.className?.includes("onboarding-close"));
    if (!closeBtn) throw new Error("close button not rendered");

    act(() => { closeBtn.props.onClick(); });

    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
    expect(steps().length).toBe(0);
  });

  test("forceOpen shows the guide after onboarding and closing notifies the controller", () => {
    localStorage.setItem(STORAGE_KEY, "1");
    let closes = 0;
    const root = render({ forceOpen: true, onClose: () => { closes += 1; } });

    expect(steps().length).toBe(4);
    const closeBtn = root
      .findAll((n) => n.type === "button")
      .find((n) => n.props.className?.includes("onboarding-close"));
    if (!closeBtn) throw new Error("close button not rendered");

    act(() => { closeBtn.props.onClick(); });

    expect(closes).toBe(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
    act(() => {
      renderer!.update(
        <LocaleProvider>
          <OnboardingGuide forceOpen={false} onClose={() => { closes += 1; }} />
        </LocaleProvider>,
      );
    });
    expect(steps().length).toBe(0);
  });

  test("claims focus, traps Tab in the guide, and returns focus to the explicit source", () => {
    const doc: { activeElement: FocusMock | null } = { activeElement: null };
    class FocusMock {
      readonly isConnected = true;
      constructor(readonly name: string, readonly tabIndex = 0) {}
      focus() { doc.activeElement = this; }
    }
    const returnTarget = new FocusMock("settings");
    const close = new FocusMock("close");
    const dismiss = new FocusMock("dismiss");
    const card = Object.assign(new FocusMock("card", -1), {
      querySelectorAll: () => [close, dismiss],
    });
    returnTarget.focus();
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });

    act(() => {
      renderer = create(
        <LocaleProvider>
          <OnboardingGuide
            returnFocusRef={{ current: returnTarget as unknown as HTMLElement }}
          />
        </LocaleProvider>,
        {
          createNodeMock(element) {
            const props = element.props as Record<string, unknown>;
            if (props.className === "d-card onboarding-card") return card;
            if (props.className === "d-btn onboarding-close") return close;
            if (props.className === "d-btn onboarding-dismiss") return dismiss;
            return {};
          },
        },
      );
    });

    expect(doc.activeElement).toBe(close);

    dismiss.focus();
    let prevented = false;
    act(() => {
      keyHandlers.forEach((handler) => handler({
        key: "Tab",
        preventDefault: () => { prevented = true; },
      }));
    });
    expect(prevented).toBe(true);
    expect(doc.activeElement).toBe(close);

    prevented = false;
    act(() => {
      keyHandlers.forEach((handler) => handler({
        key: "Tab",
        shiftKey: true,
        preventDefault: () => { prevented = true; },
      }));
    });
    expect(prevented).toBe(true);
    expect(doc.activeElement).toBe(dismiss);

    const closeButton = renderer!.root.findByProps({ className: "d-btn onboarding-close" });
    act(() => closeButton.props.onClick());
    expect(doc.activeElement).toBe(returnTarget);
  });
});

describe("Onboarding i18n (#146)", () => {
  const KEYS = [
    "Onboarding.title",
    "Onboarding.subtitle",
    "Onboarding.step1.title",
    "Onboarding.step1.desc",
    "Onboarding.step2.title",
    "Onboarding.step2.desc",
    "Onboarding.step3.title",
    "Onboarding.step3.desc",
    "Onboarding.step4.title",
    "Onboarding.step4.desc",
    "Onboarding.dismiss",
    "Onboarding.close",
  ];

  test("all 4 steps + chrome present in en and zh", () => {
    for (const key of KEYS) {
      expect(OnboardingStrings.en[key], `en missing ${key}`).toBeTruthy();
      expect(OnboardingStrings.zh[key], `zh missing ${key}`).toBeTruthy();
    }
  });

  test("zh copy is real Chinese, not the English string copied over", () => {
    // 只查人类可见文案（4 步 + 标题/副标题/按钮），逐条 zh ≠ en
    for (const key of KEYS) {
      expect(OnboardingStrings.zh[key], `zh copied en for ${key}`).not.toBe(OnboardingStrings.en[key]);
    }
  });

  function Probe({ tkey }: { tkey: string }) {
    const t = useT();
    return t(tkey);
  }

  function renderT(locale: "en" | "zh", tkey: string): string {
    localStorage.setItem("ap_locale", locale);
    act(() => {
      renderer = create(
        <LocaleProvider>
          <Probe tkey={tkey} />
        </LocaleProvider>,
      );
    });
    const json = renderer!.toJSON();
    return typeof json === "string" ? json : Array.isArray(json) ? json.join("") : "";
  }

  test("renders zh copy through the real dict path", () => {
    expect(renderT("zh", "Onboarding.step2.title")).toBe(OnboardingStrings.zh["Onboarding.step2.title"]);
    expect(renderT("en", "Onboarding.step2.title")).toBe(OnboardingStrings.en["Onboarding.step2.title"]);
  });
});
