import type { Tokens, TokenizerAndRendererExtension } from "marked";
import {
  isMentionStart,
  readMentionToken,
  resolveMentionToken,
  type MentionAlias,
} from "@agentparty/shared/mentions";
import type { IdentityDisplayMap } from "./identityDisplay";

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
  const aliases: MentionAlias[] = Object.keys(identities).map((name) => ({
    alias: name,
    target: name,
    kind: "canonical",
  }));
  return {
    name: "apMention",
    level: "inline",
    start(src: string) {
      const i = src.indexOf("@");
      return i < 0 ? undefined : i;
    },
    tokenizer(src, tokens) {
      // Reconstruct the consumed inline source so renderer and server run the
      // same boundary/URL/email/package decision. Marked has already kept this
      // tokenizer out of code tokens; the shared guard remains defence in depth.
      const previousRaw = tokens
        .map((token) => (typeof token.raw === "string" ? token.raw : ""))
        .join("");
      if (!isMentionStart(previousRaw + src, previousRaw.length)) return undefined;

      const parsed = readMentionToken(src, 0);
      if (parsed === null) return undefined;
      const resolution = resolveMentionToken(parsed.value, aliases);
      if (resolution.status !== "resolved") return undefined;
      const name = resolution.target;
      const display = identities[name]?.display;
      // 没有映射、或映射回自身，就不接管这个 token：让 @name 以字面文本渲染。
      if (display === undefined || display === name) return undefined;

      // CJK 无空格正文可能被词法层读成 "小明看一下"。只消费实际命中的 alias，
      // 余下 "看一下" 继续交给 marked 渲染，不能吞进 mention span。
      const raw = `@${parsed.value.slice(0, resolution.matchedAlias.length)}`;
      const token: MentionToken = { type: "apMention", raw, name, display };
      return token;
    },
    renderer(token) {
      const { name, display } = token as MentionToken;
      return `<span class="ap-mention" title="@${escapeHtmlAttr(name)}">@${escapeHtmlText(display)}</span>`;
    },
  };
}
