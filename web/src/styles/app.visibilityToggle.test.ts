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

describe("issue #443 visibility controls layout", () => {
  test("the current visibility description stays inline with its controls", () => {
    const body = ruleBody(".vis-help");
    expect(body).not.toContain("flex-basis: 100%");
    expect(body).toContain("flex: none");
    expect(body).toContain("white-space: nowrap");
    expect(body).toContain("margin: 0");
  });
});
