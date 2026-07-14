import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8");

describe("task title containment (#489)", () => {
  test("the title owns the remaining row width and clips its strong text", () => {
    expect(css).toMatch(/\.task-card-title\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.task-card-main strong\s*\{[^}]*display:\s*block;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.task-card-main \.task-state\s*\{[^}]*flex:\s*none;/s);
  });
});

describe("agent hover card (#490)", () => {
  test("opens immediately on hover or keyboard focus without a native tooltip delay", () => {
    expect(css).toMatch(/\.msg-agent-card\s*\{[^}]*transition:\s*opacity 60ms linear/s);
    expect(css).toMatch(/\.msg-agent-popover:hover \.msg-agent-card,[\s\S]*\.msg-agent-popover:focus-within \.msg-agent-card\s*\{[^}]*visibility:\s*visible;/s);
  });
});
