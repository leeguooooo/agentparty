// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cssPath = fileURLToPath(new URL("./app.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

function ruleBody(selector: string): string {
  const needle = `${selector} {`;
  const start = css.indexOf(needle);
  if (start === -1) throw new Error(`selector not found in app.css: ${selector}`);
  const end = css.indexOf("}", start);
  if (end === -1) throw new Error(`unterminated rule for selector: ${selector}`);
  return css.slice(start, end);
}

describe("issue #357 layout and touch CSS", () => {
  test("the brand stays intact and the narrow composer keeps a full-width editor", () => {
    expect(ruleBody(".app-logo")).toContain("white-space: nowrap");
    expect(css).toMatch(/@media \(max-width: 400px\)[\s\S]*\.composer-input\s*{[^}]*flex:\s*0 0 100%;[^}]*width:\s*100%;/s);
    expect(css).toMatch(/@media \(max-width: 400px\)[\s\S]*\.composer-actions\s*{[^}]*margin-left:\s*auto;/s);
  });

  test("the charter modal delegates scrolling to the panel body", () => {
    const body = ruleBody(".channel-panel-body .charter-body .msg-body");
    expect(body).toContain("max-height: none");
    expect(body).toContain("overflow: visible");
  });

  test("message menu triggers stay visible on devices without hover", () => {
    expect(css).toMatch(/@media \(hover: none\)\s*{\s*\.msg-menu-trigger\s*{[^}]*opacity:\s*1;/s);
  });

  test("the popover overflow affordance has a distinct dim text style", () => {
    const body = ruleBody(".presence-popover-more");
    expect(body).toContain("color: var(--t-dim)");
    expect(body).toContain("font-size:");
  });

  test("touch-revealed status and team details wrap instead of inheriting compact truncation", () => {
    expect(ruleBody(".msg-status-detail")).toContain("white-space: pre-wrap");
    expect(ruleBody(".msg-context.msg-context-detail")).toContain("max-width: none");
    expect(ruleBody(".team-member-detail")).toContain("overflow-wrap: anywhere");
  });
});
