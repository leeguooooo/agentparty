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

describe("issue #435 agent work board layout", () => {
  test("lays out the four status lanes as a horizontally scrollable grid", () => {
    const body = ruleBody(".agent-board-panel");
    expect(body).toContain("display: grid");
    expect(body).toContain("grid-template-columns: repeat(4, minmax(220px, 1fr))");
    expect(body).toContain("overflow-x: auto");
  });

  test("keeps task title and state readable inside each agent card", () => {
    const task = ruleBody(".agent-board-task");
    const title = ruleBody(".agent-board-task-title");
    expect(task).toContain("grid-template-columns: auto minmax(0, 1fr) auto");
    expect(title).toContain("text-overflow: ellipsis");
  });
});
