// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found in app.css: ${selector}`);
  const end = css.indexOf("}", start);
  if (end === -1) throw new Error(`unterminated rule for selector: ${selector}`);
  return css.slice(start, end);
}

describe("channel visibility controls layout", () => {
  test("channel management stays at the toolbar's right edge without wrapping content tools", () => {
    expect(ruleBody(".chan-toolstrip")).toContain("flex-wrap: nowrap");
    expect(ruleBody(".chan-toolstrip-content")).toContain("flex-direction: column");
    expect(ruleBody(".chan-toolstrip-content")).toContain("overflow: visible");
    expect(css).toMatch(/@media \(max-width: 1759px\)[\s\S]*\.chan-toolstrip-content\s*{[^}]*overflow-x:\s*auto;/s);
    expect(css).toMatch(/\.chan-tool-buttons,\s*\.chan-tool-actions,\s*\.chan-admin-actions,\s*\.chan-admin-group\s*{[^}]*flex-wrap:\s*nowrap;/s);
    expect(ruleBody(".chan-tool-actions")).toContain("justify-content: flex-end");
    expect(ruleBody(".chan-admin-actions")).toContain("margin-left: auto");
    expect(ruleBody(".chan-admin-actions")).toContain("gap: 0");
    expect(ruleBody(".chan-admin-group + .chan-admin-group")).toContain("border-left: 1.4px solid var(--t-faint)");
    expect(css).toMatch(/@media \(max-width: 1759px\)[\s\S]*\.chan-tool-btn\s*{[^}]*padding-inline:\s*6px;[^}]*font-size:\s*11\.5px;/s);
  });
});
