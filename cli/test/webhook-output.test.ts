import { describe, expect, test } from "bun:test";
import { formatWebhookListRow } from "../src/commands/webhook";

describe("webhook list terminal output", () => {
  test("sanitizes every remote column and narrows an invalid mode", () => {
    const row = formatWebhookListRow({
      name: "hook\u001b]52;c;clipboard\u0007",
      filter: "mentions\u001b[31m\u0000",
      url: "https://example.test/path\nforged\tcolumn",
      mode: "agent\u001b[2J",
    });

    expect(row).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(row.split("\t")).toEqual([
      "hook]52;c;clipboard",
      "mentions",
      "https://example.test/path forged column",
      "notify",
    ]);
  });
});
