// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../i18n/locale";
import { DesktopSettingsStrings } from "../i18n/strings/DesktopSettings";
import {
  applyAutostartSetting,
  DesktopSettings,
  DesktopSettingsPanel,
  isDesktopSettingsOutsideClick,
  loadAutostartSetting,
  shouldDismissDesktopSettings,
  type DesktopSettingsRuntime,
} from "./DesktopSettings";

const translations: Record<string, string> = {
  "DesktopSettings.control.label": "Application settings",
  "DesktopSettings.panel.title": "Application settings",
  "DesktopSettings.autostart.label": "Launch at login",
  "DesktopSettings.autostart.description": "Open AgentParty when you sign in.",
  "DesktopSettings.autostart.loading": "Reading system setting",
  "DesktopSettings.autostart.error": "Couldn't update this setting.",
};
const t = (key: string) => translations[key] ?? key;

function runtime(overrides: Partial<DesktopSettingsRuntime> = {}): DesktopSettingsRuntime {
  return {
    isDesktopRuntime: () => true,
    isAutostartEnabled: async () => false,
    setAutostartEnabled: async () => true,
    ...overrides,
  };
}

function renderSettings(runtimeValue: DesktopSettingsRuntime): string {
  return renderToStaticMarkup(
    <LocaleProvider><DesktopSettings runtime={runtimeValue} /></LocaleProvider>,
  );
}

describe("DesktopSettings", () => {
  test("registers independent English and Chinese copy", () => {
    for (const locale of ["en", "zh"] as const) {
      expect(DesktopSettingsStrings[locale]["DesktopSettings.control.label"]).toBeTruthy();
      expect(DesktopSettingsStrings[locale]["DesktopSettings.autostart.label"]).toBeTruthy();
      expect(DesktopSettingsStrings[locale]["DesktopSettings.autostart.error"]).toBeTruthy();
    }
  });

  test("renders nothing outside the Tauri desktop runtime", () => {
    const html = renderSettings(runtime({ isDesktopRuntime: () => false }));

    expect(html).toBe("");
  });

  test("renders an accessible settings trigger with the project sprite", () => {
    const html = renderSettings(runtime());

    expect(html).toContain("ap-sprite--settings");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="desktop-settings-panel"');
    expect(html).not.toContain("emoji");
    expect(html).not.toContain("<svg");
  });
});

describe("DesktopSettingsPanel", () => {
  test("exposes the launch-at-login toggle as a keyboard-operable switch", () => {
    const html = renderToStaticMarkup(
      <DesktopSettingsPanel enabled={true} pending={false} error={false} t={t} onToggle={() => {}} />,
    );

    expect(html).toContain('id="desktop-settings-panel"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Launch at login");
  });

  test("disables the switch while reading or writing and renders a short error", () => {
    const html = renderToStaticMarkup(
      <DesktopSettingsPanel enabled={false} pending={true} error={true} t={t} onToggle={() => {}} />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("update this setting.");
  });
});

describe("desktop autostart behavior", () => {
  test("loads the current system state during initialization", async () => {
    let reads = 0;
    const enabled = await loadAutostartSetting(runtime({
      isAutostartEnabled: async () => {
        reads += 1;
        return true;
      },
    }));

    expect(enabled).toBe(true);
    expect(reads).toBe(1);
  });

  test("writes the next state without a redundant read after success", async () => {
    const writes: boolean[] = [];
    let reads = 0;
    const result = await applyAutostartSetting(runtime({
      setAutostartEnabled: async (next) => {
        writes.push(next);
        return true;
      },
      isAutostartEnabled: async () => {
        reads += 1;
        return false;
      },
    }), true, false);

    expect(result).toEqual({ enabled: true, failed: false });
    expect(writes).toEqual([true]);
    expect(reads).toBe(0);
  });

  test("re-reads system state and reports an error after a failed write", async () => {
    const calls: string[] = [];
    const result = await applyAutostartSetting(runtime({
      setAutostartEnabled: async () => {
        calls.push("write");
        return false;
      },
      isAutostartEnabled: async () => {
        calls.push("read");
        return false;
      },
    }), true, true);

    expect(result).toEqual({ enabled: false, failed: true });
    expect(calls).toEqual(["write", "read"]);
  });
});

describe("desktop settings dismissal", () => {
  test("closes on Escape but not unrelated keys", () => {
    expect(shouldDismissDesktopSettings({ key: "Escape" })).toBe(true);
    expect(shouldDismissDesktopSettings({ key: "Enter" })).toBe(false);
  });

  test("closes only when the pointer target is outside the settings root", () => {
    const inside = {} as Node;
    const outside = {} as Node;
    const root = { contains: (target: Node) => target === inside };

    expect(isDesktopSettingsOutsideClick(root, outside)).toBe(true);
    expect(isDesktopSettingsOutsideClick(root, inside)).toBe(false);
    expect(isDesktopSettingsOutsideClick(null, outside)).toBe(false);
  });
});
