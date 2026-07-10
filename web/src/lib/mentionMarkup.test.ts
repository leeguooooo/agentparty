import { describe, expect, it } from "bun:test";
import { Marked } from "marked";
import type { IdentityDisplayMap } from "./identityDisplay";
import { markdownToHtmlUnsafe } from "./markdown";
import { mentionExtension } from "./mentionMarkup";

const IDS: IdentityDisplayMap = {
  alice: { display: "Alice", kind: "agent" },
  "61ec302c-6c31-4bca-a1df-88152372f6d9": {
    display: "thejacks@163.com",
    kind: "human",
    account: "thejacks@163.com",
  },
  weird: { display: 'a<&"b', kind: "human" },
  self: { display: "self", kind: "agent" },
};

// 走真实生产管线（markdown.ts 的 marked + hljs + mention 扩展，DOMPurify 净化前的产物；
// DOMPurify 只做白名单不改 ap-mention span 结构，且在 bun 无 DOM 跑不了）。用它做集成断言：
// 若有人把 mention 改回「解析前注入」，代码块/URL 用例会立刻变红。
const R = (md: string) => markdownToHtmlUnsafe(md, IDS).trim();

// 直接驱动扩展本身、并监听 renderer——用于「断言过程」：mention 注入到底调用了没、拿到了什么。
function spy(identities: IdentityDisplayMap) {
  const calls: Array<{ name: string; display: string }> = [];
  const ext = mentionExtension(identities);
  const inner = (ext as { renderer: (tk: unknown) => string }).renderer;
  const marked = new Marked();
  marked.use({
    extensions: [
      {
        ...ext,
        renderer(token: unknown) {
          const t = token as { name: string; display: string };
          calls.push({ name: t.name, display: t.display });
          return inner.call(this, token);
        },
      },
    ],
  });
  return { calls, render: (md: string) => marked.parse(md, { async: false }).trim() };
}

describe("mention 美化：真实管线集成（#131）", () => {
  it("prose 里的 @name 变成受控 span", () => {
    expect(R("hi @alice there")).toBe(
      '<p>hi <span class="ap-mention" title="@alice">@Alice</span> there</p>',
    );
  });

  it("代码块（fenced）里的 @name 保持字面，绝不出现 ap-mention span 或泄漏的裸 HTML", () => {
    const out = R("```\n@alice inside code\n```");
    expect(out).not.toContain("ap-mention"); // 既挡真 span，也挡旧 bug 里被转义的 span 文本
    expect(out).toContain("@alice");
    expect(out).toContain("inside code");
  });

  it("行内代码里的 @name 保持字面", () => {
    expect(R("use `@alice` please")).toBe("<p>use <code>@alice</code> please</p>");
  });

  it("含 @ 的 URL 不被截断（issue 原例 a@b）", () => {
    expect(R("see https://x.com/a@b/c done")).toBe(
      '<p>see <a href="https://x.com/a@b/c">https://x.com/a@b/c</a> done</p>',
    );
  });

  it("形如 /@alice/ 的 URL（旧代码在此截断）保持完整、href 内无 span", () => {
    const out = R("repo https://github.com/@alice/repo end");
    expect(out).toBe(
      '<p>repo <a href="https://github.com/@alice/repo">https://github.com/@alice/repo</a> end</p>',
    );
    expect(out).toContain("https://github.com/@alice/repo");
    expect(out).not.toContain("ap-mention");
  });

  it("词中间的 @（如邮箱片段 foo@alice）不当作 mention", () => {
    // alice 是已知身份；靠「@ 前是词字符」这条边界规则挡住，而非靠 display===name
    expect(R("email foo@alice please")).toBe("<p>email foo@alice please</p>");
  });

  it("可读邮箱 display 作为 span 渲染，@ 原样保留", () => {
    const raw = "61ec302c-6c31-4bca-a1df-88152372f6d9";
    expect(R(`@${raw} hello`)).toBe(
      `<p><span class="ap-mention" title="@${raw}">@thejacks@163.com</span> hello</p>`,
    );
  });

  it("注入前转义 display 里的 HTML 特殊字符", () => {
    expect(R("@weird hi")).toBe(
      '<p><span class="ap-mention" title="@weird">@a&lt;&amp;"b</span> hi</p>',
    );
  });

  it("未知身份的 @name 保持字面", () => {
    expect(R("hi @nobody there")).toBe("<p>hi @nobody there</p>");
  });

  it("display 与 name 相同时不注入", () => {
    expect(R("hi @self there")).toBe("<p>hi @self there</p>");
  });

  it("句首、以及 /、* 等真实边界后的 @name 都识别为 mention", () => {
    expect(R("@alice")).toBe('<p><span class="ap-mention" title="@alice">@Alice</span></p>');
    expect(R("path /@alice/x")).toContain(
      '/<span class="ap-mention" title="@alice">@Alice</span>/x',
    );
    expect(R("**b**@alice")).toBe(
      '<p><strong>b</strong><span class="ap-mention" title="@alice">@Alice</span></p>',
    );
  });
});

describe("mention 美化：过程断言（renderer 是否被调用、入参是什么）", () => {
  it("prose：mention renderer 恰好被调用一次，且拿到正确 name/display", () => {
    const s = spy(IDS);
    s.render("hi @alice there");
    expect(s.calls).toEqual([{ name: "alice", display: "Alice" }]);
  });

  it("代码块：mention renderer 一次都不被调用（结构性排除，而非事后擦除）", () => {
    const s = spy(IDS);
    s.render("```\n@alice inside\n```");
    expect(s.calls).toEqual([]);
  });

  it("行内代码：mention renderer 一次都不被调用", () => {
    const s = spy(IDS);
    s.render("use `@alice` here");
    expect(s.calls).toEqual([]);
  });

  it("含 @ 的 URL：mention renderer 一次都不被调用", () => {
    const s = spy(IDS);
    s.render("go https://github.com/@alice/repo done");
    expect(s.calls).toEqual([]);
  });
});
