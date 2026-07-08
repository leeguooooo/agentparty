import { describe, expect, it } from "bun:test";
import { replaceMentionLabels } from "./mentionMarkup";

describe("replaceMentionLabels", () => {
  it("renders readable email mentions as controlled spans instead of bare autolinks", () => {
    const raw = "61ec302c-6c31-4bca-a1df-88152372f6d9";
    expect(
      replaceMentionLabels(`@${raw} hello`, {
        [raw]: { display: "thejacks@163.com", kind: "human", account: "thejacks@163.com" },
      }),
    ).toBe(
      '<span class="ap-mention" title="@61ec302c-6c31-4bca-a1df-88152372f6d9">@thejacks&#64;163.com</span> hello',
    );
  });

  it("escapes mapped mention labels before injecting markdown html", () => {
    expect(
      replaceMentionLabels("@raw hello", {
        raw: { display: 'a<&"b', kind: "human" },
      }),
    ).toBe('<span class="ap-mention" title="@raw">@a&lt;&amp;"b</span> hello');
  });
});
