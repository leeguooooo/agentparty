// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { SettingsPanel, type SettingsMe } from "./SettingsPanel";

mock.module("dompurify", () => ({
  default: { addHook: () => {}, sanitize: (value: string) => value },
}));

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => { values.set(k, v); },
    removeItem: (k) => { values.delete(k); },
    clear: () => values.clear(),
    key: (i) => [...values.keys()][i] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;
let store: Storage;
let themeAttribute: string | null = null;
let keyHandlers: Array<(e: { key: string; shiftKey?: boolean; preventDefault?: () => void }) => void> = [];
// 统计 keydown 监听的挂/摘次数——用来验证焦点陷阱 effect 只跑一次、不随 onClose 身份变化重挂。
let keydownAdds = 0;
let keydownRemoves = 0;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  store = memoryStorage({ ap_locale: "en" });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
  keyHandlers = [];
  keydownAdds = 0;
  keydownRemoves = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (type: string, fn: (e: { key: string }) => void) => {
        if (type === "keydown") { keyHandlers.push(fn); keydownAdds += 1; }
      },
      removeEventListener: (type: string, fn: (e: { key: string }) => void) => {
        if (type === "keydown") { keyHandlers = keyHandlers.filter((h) => h !== fn); keydownRemoves += 1; }
      },
    },
  });
  themeAttribute = null;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        setAttribute: (name: string, value: string) => { if (name === "data-theme") themeAttribute = value; },
      },
    },
  });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

const me: SettingsMe = { name: "alice", kind: "agent", role: "agent", handle: null, display_name: null, owner: null };

type SettingsProps = Parameters<typeof SettingsPanel>[0];
type RenderProps = Omit<SettingsProps, "notifyOptin" | "onNotifyOptinChange"> &
  Partial<Pick<SettingsProps, "notifyOptin" | "onNotifyOptinChange">>;

function render(props: RenderProps): ReactTestRenderer {
  const normalized: SettingsProps = {
    notifyOptin: false,
    onNotifyOptinChange: () => {},
    ...props,
  };
  let r!: ReactTestRenderer;
  void act(() => {
    r = create(<LocaleProvider><SettingsPanel {...normalized} /></LocaleProvider>);
  });
  renderer = r;
  return r;
}
function findByClass(node: unknown, target: string): { props: Record<string, unknown> } | null {
  if (node === null || typeof node !== "object") return null;
  const n = node as { props?: Record<string, unknown>; children?: unknown };
  const cls = n.props?.className;
  if (typeof cls === "string" && cls.split(" ").includes(target)) return n as { props: Record<string, unknown> };
  const kids = n.children;
  if (Array.isArray(kids)) { for (const k of kids) { const hit = findByClass(k, target); if (hit) return hit; } }
  else if (kids) { const hit = findByClass(kids, target); if (hit) return hit; }
  return null;
}
function findByProp(node: unknown, key: string, val: unknown): { props: Record<string, unknown> } | null {
  if (node === null || typeof node !== "object") return null;
  const n = node as { props?: Record<string, unknown>; children?: unknown };
  if (n.props && n.props[key] === val) return n as { props: Record<string, unknown> };
  const kids = n.children;
  if (Array.isArray(kids)) { for (const k of kids) { const hit = findByProp(k, key, val); if (hit) return hit; } }
  else if (kids) { const hit = findByProp(kids, key, val); if (hit) return hit; }
  return null;
}
function allText(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object" && "children" in (node as Record<string, unknown>)) walk((node as { children: unknown }).children);
  };
  walk(r.toJSON());
  return out.join(" ");
}

describe("SettingsPanel (#273)", () => {
  test("renders language, theme, notifications, and account sections", () => {
    const txt = allText(render({ me, canSetHandle: false, onClose: () => {}, onLogout: () => {} }));
    expect(txt).toContain("Settings");
    expect(txt).toContain("Language");
    expect(txt).toContain("Theme");
    expect(txt).toContain("@-mention notifications");
    expect(txt).toContain("Account");
    expect(txt).toContain("alice");
  });

  test("notification toggle writes ap_notify_optin to localStorage", () => {
    let notifyOptin = false;
    const onNotifyOptinChange = (next: boolean) => { notifyOptin = next; };
    const common = { me, canSetHandle: false, onClose: () => {}, onLogout: () => {} };
    const r = render({ ...common, notifyOptin, onNotifyOptinChange });
    expect(store.getItem("ap_notify_optin")).toBe(null);
    const toggle = findByClass(r.toJSON(), "settings-toggle");
    expect(toggle).not.toBeNull();
    void act(() => { (toggle!.props.onClick as () => void)(); });
    expect(store.getItem("ap_notify_optin")).toBe("1");
    expect(notifyOptin).toBe(true);

    void act(() => {
      r.update(
        <LocaleProvider>
          <SettingsPanel
            {...common}
            notifyOptin={notifyOptin}
            onNotifyOptinChange={onNotifyOptinChange}
          />
        </LocaleProvider>,
      );
    });
    // 再点一次关掉
    const toggle2 = findByClass(r.toJSON(), "settings-toggle");
    void act(() => { (toggle2!.props.onClick as () => void)(); });
    expect(store.getItem("ap_notify_optin")).toBe("0");
    expect(notifyOptin).toBe(false);
  });

  test("keeps in-app alerts enabled and explains when system notifications are unavailable", async () => {
    let notifyOptin = false;
    const r = render({
      me,
      canSetHandle: false,
      notifyOptin,
      onClose: () => {},
      onLogout: () => {},
      onNotifyOptinChange: (next) => { notifyOptin = next; },
    });
    const toggle = findByClass(r.toJSON(), "settings-toggle");

    await act(async () => {
      (toggle!.props.onClick as () => void)();
      await Promise.resolve();
    });

    expect(notifyOptin).toBe(true);
    expect(store.getItem("ap_notify_optin")).toBe("1");
    expect(allText(r)).toContain("System notifications are unavailable");
  });

  test("uses explicit sections and exposes only the selected panel", () => {
    const r = render({
      me,
      canSetHandle: false,
      onClose: () => {},
      onLogout: () => {},
      onShowOnboarding: () => {},
      desktopAppSettings: <p>desktop module</p>,
    });

    expect(r.root.findAllByProps({ role: "tab" })).toHaveLength(4);
    expect(r.root.findByProps({ id: "global-settings-tab-preferences" }).props["aria-selected"]).toBe(true);
    expect(r.root.findByProps({ id: "global-settings-panel-preferences" }).props.hidden).toBe(false);
    expect(r.root.findByProps({ id: "global-settings-panel-account" }).props.hidden).toBe(true);

    void act(() => r.root.findByProps({ id: "global-settings-tab-account" }).props.onClick());

    expect(r.root.findByProps({ id: "global-settings-tab-account" }).props["aria-selected"]).toBe(true);
    expect(r.root.findByProps({ id: "global-settings-panel-preferences" }).props.hidden).toBe(true);
    expect(r.root.findByProps({ id: "global-settings-panel-account" }).props.hidden).toBe(false);
  });

  test("theme buttons flip data-theme and persist to localStorage", () => {
    const r = render({ me, canSetHandle: false, onClose: () => {}, onLogout: () => {} });
    const midnight = findByProp(r.toJSON(), "data-theme-code", "midnight");
    expect(midnight).not.toBeNull();
    void act(() => { (midnight!.props.onClick as () => void)(); });
    expect(themeAttribute).toBe("midnight");
    expect(store.getItem("ap_theme")).toBe("midnight");
    const paper = findByProp(r.toJSON(), "data-theme-code", "doodle");
    void act(() => { (paper!.props.onClick as () => void)(); });
    expect(themeAttribute).toBe("doodle");
    expect(store.getItem("ap_theme")).toBe("doodle");
  });

  test("embeds the HandleSetup editor only when canSetHandle", () => {
    const withEdit = render({ me, canSetHandle: true, onClose: () => {}, onLogout: () => {}, onHandleSaved: () => {} });
    expect(findByClass(withEdit.toJSON(), "handlesetup-input")).not.toBeNull();
    void act(() => renderer!.unmount());
    renderer = null;
    const noEdit = render({ me, canSetHandle: false, onClose: () => {}, onLogout: () => {} });
    expect(findByClass(noEdit.toJSON(), "handlesetup-input")).toBeNull();
  });

  test("logout button invokes onLogout", () => {
    let loggedOut = 0;
    const r = render({ me, canSetHandle: false, onClose: () => {}, onLogout: () => { loggedOut += 1; } });
    const logout = findByClass(r.toJSON(), "settings-logout");
    expect(logout).not.toBeNull();
    void act(() => { (logout!.props.onClick as () => void)(); });
    expect(loggedOut).toBe(1);
  });

  test("help entry invokes the onboarding callback", () => {
    let opens = 0;
    const r = render({
      me,
      canSetHandle: false,
      onClose: () => {},
      onLogout: () => {},
      onShowOnboarding: () => { opens += 1; },
    });
    const help = findByClass(r.toJSON(), "settings-onboarding");
    expect(help).not.toBeNull();

    void act(() => { (help!.props.onClick as () => void)(); });

    expect(opens).toBe(1);
  });

  test("surfaces email and provider when present", () => {
    const rich: SettingsMe = { ...me, email: "a@example.com", provider: "oidc" };
    const txt = allText(render({ me: rich, canSetHandle: false, onClose: () => {}, onLogout: () => {} }));
    expect(txt).toContain("a@example.com");
    expect(txt).toContain("oidc");
  });

  test("no account section / logout when me is null", () => {
    const txt = allText(render({ me: null, canSetHandle: false, onClose: () => {}, onLogout: null }));
    expect(txt).toContain("Language");
    expect(txt).not.toContain("Account");
  });

  // #637 a11y：aria-modal 对话框现在真正接管键盘——Esc 关闭由焦点陷阱 effect 统一处理。
  test("dialog is focusable and Escape invokes onClose (focus-trap effect)", () => {
    let closes = 0;
    const r = render({ me, canSetHandle: false, onClose: () => { closes += 1; }, onLogout: () => {} });
    // 面板本身可作为焦点回退目标（tabindex=-1）
    const panel = findByClass(r.toJSON(), "settings-panel");
    expect(panel?.props.tabIndex).toBe(-1);
    // effect 已把 keydown 监听挂到 window；模拟 Esc
    expect(keyHandlers.length).toBeGreaterThan(0);
    void act(() => { keyHandlers.forEach((h) => h({ key: "Escape" })); });
    expect(closes).toBe(1);
  });

  // #654 复审：onClose 身份不稳定（父级传内联箭头）时，焦点陷阱 effect 不应重挂——
  // 否则清理阶段会抢先恢复焦点、重挂后 previouslyFocused 指向面板内元素，焦点恢复失效。
  test("focus-trap effect survives an unstable onClose (no teardown+re-arm on identity change)", () => {
    let closes = 0;
    const r = render({ me, canSetHandle: false, onClose: () => { closes += 1; }, onLogout: () => {} });
    // 挂载时只挂一次 keydown，尚未摘除。
    expect(keydownAdds).toBe(1);
    expect(keydownRemoves).toBe(0);

    // 父级重渲染并传入全新 onClose 身份（模拟内联箭头函数）。
    void act(() => {
      r.update(
        <LocaleProvider>
          <SettingsPanel
            me={me}
            notifyOptin={false}
            canSetHandle={false}
            onClose={() => { closes += 2; }}
            onLogout={() => {}}
            onNotifyOptinChange={() => {}}
          />
        </LocaleProvider>,
      );
    });
    // effect 依赖 []：既不摘旧监听也不挂新监听，焦点恢复不会被提前触发。
    expect(keydownAdds).toBe(1);
    expect(keydownRemoves).toBe(0);

    // Esc 仍经 ref 走到最新的 onClose。
    void act(() => { keyHandlers.forEach((h) => h({ key: "Escape" })); });
    expect(closes).toBe(2);
  });
});
