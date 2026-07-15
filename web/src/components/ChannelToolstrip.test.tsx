// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
// @ts-expect-error Bun provides node:fs for this source-level CSS contract test.
import { readFileSync } from "node:fs";
import { LocaleProvider } from "../i18n/locale";

const { ChannelToolstrip } = await import("./ChannelToolstrip");

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed));
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

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
});

function renderWithStorage(storage: Storage): ReactTestRenderer {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  let value!: ReactTestRenderer;
  void act(() => {
    value = create(
      <LocaleProvider>
        <ChannelToolstrip
          buttons={<button type="button">Announcement</button>}
          actions={<button type="button">Notify</button>}
        />
      </LocaleProvider>,
    );
  });
  renderer = value;
  return value;
}

function render(seed: Record<string, string> = {}): ReactTestRenderer {
  return renderWithStorage(memoryStorage({ ap_locale: "en", ...seed }));
}

function toggle(r: ReactTestRenderer) {
  return r.root.find((node) => node.props.className === "d-btn chan-toolstrip-toggle");
}

describe("ChannelToolstrip discoverability (#355)", () => {
  test("defaults to expanded with a visible tools toggle", () => {
    const r = render();
    expect(r.root.findByProps({ "aria-label": "channel tools" }).props.className).toContain("chan-toolstrip--expanded");
    expect(toggle(r).props["aria-expanded"]).toBe(true);
    expect(toggle(r).props["aria-controls"]).toBe("channel-toolstrip-content");
    expect(toggle(r).findByProps({ className: "ap-sprite ap-sprite--tools" })).toBeDefined();
    expect(toggle(r).findByProps({ className: "chan-toolstrip-toggle-label" }).children).toEqual(["channel tools"]);
  });

  test("defaults to expanded when reading localStorage throws", () => {
    const storage = memoryStorage({ ap_locale: "en" });
    storage.getItem = () => { throw new Error("storage unavailable"); };

    const r = renderWithStorage(storage);

    expect(toggle(r).props["aria-expanded"]).toBe(true);
  });

  test("collapses, expands, and persists the user's choice", async () => {
    const r = render();
    await act(async () => toggle(r).props.onClick());

    expect(toggle(r).props["aria-expanded"]).toBe(false);
    expect(r.root.findByProps({ "aria-label": "channel tools" }).props.className).toContain("chan-toolstrip--collapsed");
    expect(localStorage.getItem("ap_channel_tools_expanded")).toBe("0");

    await act(async () => toggle(r).props.onClick());
    expect(toggle(r).props["aria-expanded"]).toBe(true);
    expect(localStorage.getItem("ap_channel_tools_expanded")).toBe("1");
  });

  test("restores a collapsed preference", () => {
    const r = render({ ap_channel_tools_expanded: "0" });
    expect(toggle(r).props["aria-expanded"]).toBe(false);
    expect(r.root.findByProps({ "aria-label": "channel tools" }).props.className).toContain("chan-toolstrip--collapsed");
  });

  test("responsive CSS leaves desktop unchanged and hides only mobile collapsed content", () => {
    const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
    expect(css).toContain(".chan-toolstrip-toggle {\n  display: none;");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.chan-toolstrip-toggle \{[\s\S]*display: inline-flex;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.chan-toolstrip-toggle-label \{[\s\S]*display: none;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.chan-toolstrip--collapsed \.chan-toolstrip-content \{\s*display: none;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.chan-toolstrip-content \{[\s\S]*overflow-x: auto;/);
    expect(css).toMatch(/\.chan-tool-btn \.ap-sprite\s*{[^}]*--ap-icon-size:\s*28px;[^}]*background-size:\s*440% 330%;/s);
  });
});
