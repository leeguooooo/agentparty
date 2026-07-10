// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopUpdaterState } from "../lib/desktopUpdater";
import { DesktopUpdaterStrings } from "../i18n/strings/DesktopUpdater";
import { DesktopUpdaterPanel, handleDesktopUpdaterTrayCheck, updateUpdaterDialogFocus } from "./DesktopUpdater";

const state = (overrides: Partial<DesktopUpdaterState>): DesktopUpdaterState => ({
  phase: "idle",
  panelOpen: true,
  currentVersion: null,
  nextVersion: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  progressPercent: null,
  error: null,
  failureStage: null,
  ...overrides,
});

const translations: Record<string, string> = {
  "DesktopUpdater.panel.title": "Desktop update",
  "DesktopUpdater.close": "Close update status",
  "DesktopUpdater.available": "A new version is ready to install.",
  "DesktopUpdater.currentVersion": "Current",
  "DesktopUpdater.nextVersion": "Available",
  "DesktopUpdater.releaseNotes": "Release notes",
  "DesktopUpdater.install": "Install update",
  "DesktopUpdater.check": "Check now",
  "DesktopUpdater.retry": "Retry",
  "DesktopUpdater.error": "The update could not be completed.",
  "DesktopUpdater.error.offline": "Connect to the internet and try again.",
};
const t = (key: string) => translations[key] ?? key;

describe("DesktopUpdaterPanel", () => {
  test("provides localized copy for every safe error category", () => {
    const categories = ["offline", "timeout", "verification", "install", "relaunch", "generic"];

    for (const locale of ["en", "zh"] as const) {
      for (const category of categories) {
        expect(DesktopUpdaterStrings[locale][`DesktopUpdater.error.${category}`]).toBeTruthy();
      }
    }
  });

  test("renders bounded release notes as plain text", () => {
    const html = renderToStaticMarkup(
      <DesktopUpdaterPanel
        state={state({
          phase: "available",
          currentVersion: "0.2.82",
          nextVersion: "0.2.83",
          notes: "<strong>Security update</strong>",
        })}
        t={t}
        panelRef={createRef<HTMLElement>()}
        onClose={() => {}}
        onCheck={() => {}}
        onInstall={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Release notes");
    expect(html).toContain("&lt;strong&gt;Security update&lt;/strong&gt;");
    expect(html).not.toContain("<strong>Security update</strong>");
  });

  test("renders a localized error category instead of a native error", () => {
    const html = renderToStaticMarkup(
      <DesktopUpdaterPanel
        state={state({ phase: "error", error: "offline", failureStage: "check" })}
        t={t}
        panelRef={createRef<HTMLElement>()}
        onClose={() => {}}
        onCheck={() => {}}
        onInstall={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(html).toContain("Connect to the internet and try again.");
    expect(html).not.toContain("ECONNREFUSED");
  });
});

describe("desktop updater dialog focus", () => {
  test("focuses the dialog after opening and restores the trigger after closing", () => {
    const focused: string[] = [];
    const dialog = { focus: () => focused.push("dialog") };
    const trigger = { focus: () => focused.push("trigger") };

    updateUpdaterDialogFocus(true, false, dialog, trigger);
    updateUpdaterDialogFocus(false, true, dialog, trigger);
    updateUpdaterDialogFocus(false, false, dialog, trigger);

    expect(focused).toEqual(["dialog", "trigger"]);
  });
});

test("tray update action opens the updater and starts a manual check", () => {
  const calls: string[] = [];
  const controller = {
    openPanel: () => calls.push("open"),
    check: async (source: string) => { calls.push(`check:${source}`); },
  } as unknown as import("../lib/desktopUpdater").DesktopUpdaterController;

  handleDesktopUpdaterTrayCheck(controller);
  expect(calls).toEqual(["open", "check:manual"]);
});
