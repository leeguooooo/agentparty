import type { Tokens, TokenizerAndRendererExtension } from "marked";
import type { IdentityDisplayMap } from "./identityDisplay";

// mention 名字允许的字符：字母数字开头，后接 字母数字/._- 。
const MENTION_RE = /^@([a-zA-Z0-9][a-zA-Z0-9._-]*)/;
// mention 前必须是「边界」：非(字母数字/._@-)。用来排除 foo@bar 这类邮箱片段——
// 只有像句首、空白、`/`、`*` 这种真实边界后的 @name 才算 mention。
const NAME_CHAR_RE = /[a-zA-Z0-9._@-]/;

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

interface MentionToken extends Tokens.Generic {
  type: "apMention";
  raw: string;
  name: string;
  display: string;
}

/**
 * marked 内联扩展：在 marked **解析之后** 的 token 流上美化 @mention，而不是在解析前
 * 往原文里塞裸 HTML。这样代码块（code）、行内代码（codespan）、以及被 marked 自动
 * 链接的 URL 天然被排除在外——因为这些内容根本不会进入内联 tokenizer，或已被更早的
 * tokenizer 整段吃掉。见 #131：旧的「解析前注入 span」会让代码块里的 @name 渲染成裸
 * HTML，还会把含 @ 的 URL 截断。
 *
 * 渲染产物是 <span class="ap-mention">，class 已在 markdown.ts 的 DOMPurify 白名单里。
 */
export function mentionExtension(
  identities: IdentityDisplayMap,
): TokenizerAndRendererExtension {
  return {
    name: "apMention",
    level: "inline",
    start(src: string) {
      const i = src.indexOf("@");
      return i < 0 ? undefined : i;
    },
    tokenizer(src, tokens) {
      // 边界校验：看紧挨在 @ 前面那个已产出 token 的最后一个字符。
      // 若它是 name 允许字符（字母数字/._@-），说明这个 @ 处在词中间（如 foo@bar），
      // 不当作 mention——与旧正则的前置字符类保持一致。
      const prev = tokens[tokens.length - 1];
      const prevRaw = typeof prev?.raw === "string" ? prev.raw : "";
      const prevChar = prevRaw.slice(-1);
      if (prevChar !== "" && NAME_CHAR_RE.test(prevChar)) return undefined;

      const match = MENTION_RE.exec(src);
      if (match === null) return undefined;
      const name = match[1];
      if (name === undefined) return undefined;
      const display = identities[name]?.display;
      // 没有映射、或映射回自身，就不接管这个 token：让 @name 以字面文本渲染。
      if (display === undefined || display === name) return undefined;

      const token: MentionToken = { type: "apMention", raw: match[0], name, display };
      return token;
    },
    renderer(token) {
      const { name, display } = token as MentionToken;
      return `<span class="ap-mention" title="@${escapeHtmlAttr(name)}">@${escapeHtmlText(display)}</span>`;
    },
  };
}
