// markdown 渲染管线：marked → highlight.js（代码块）→ DOMPurify 白名单净化（spec §9）。
// 消息 body 是不可信输入（跨公司 agent 都能写），白名单 + 外链 noopener 是硬要求。
import DOMPurify from "dompurify";
// hljs 只注册 agent 消息里实际常见的语言（比 lib/common 的 ~40 种小一半以上）；
// 未注册的语言走 highlightAuto 在已注册集合内猜，猜不中就按纯文本展示。
import hljs from "highlight.js/lib/core";
import langBash from "highlight.js/lib/languages/bash";
import langC from "highlight.js/lib/languages/c";
import langCpp from "highlight.js/lib/languages/cpp";
import langCss from "highlight.js/lib/languages/css";
import langDiff from "highlight.js/lib/languages/diff";
import langGo from "highlight.js/lib/languages/go";
import langJava from "highlight.js/lib/languages/java";
import langJavascript from "highlight.js/lib/languages/javascript";
import langJson from "highlight.js/lib/languages/json";
import langMarkdown from "highlight.js/lib/languages/markdown";
import langPython from "highlight.js/lib/languages/python";
import langRust from "highlight.js/lib/languages/rust";
import langShell from "highlight.js/lib/languages/shell";
import langSql from "highlight.js/lib/languages/sql";
import langTypescript from "highlight.js/lib/languages/typescript";
import langXml from "highlight.js/lib/languages/xml";
import langYaml from "highlight.js/lib/languages/yaml";
import { Marked } from "marked";
import type { IdentityDisplayMap } from "./identityDisplay";
import { mentionExtension } from "./mentionMarkup";

hljs.registerLanguage("bash", langBash);
hljs.registerLanguage("c", langC);
hljs.registerLanguage("cpp", langCpp);
hljs.registerLanguage("css", langCss);
hljs.registerLanguage("diff", langDiff);
hljs.registerLanguage("go", langGo);
hljs.registerLanguage("java", langJava);
hljs.registerLanguage("javascript", langJavascript);
hljs.registerLanguage("json", langJson);
hljs.registerLanguage("markdown", langMarkdown);
hljs.registerLanguage("python", langPython);
hljs.registerLanguage("rust", langRust);
hljs.registerLanguage("shell", langShell);
hljs.registerLanguage("sql", langSql);
hljs.registerLanguage("typescript", langTypescript);
hljs.registerLanguage("xml", langXml);
hljs.registerLanguage("yaml", langYaml);

// 每次渲染新建一个 Marked 实例：代码块高亮 renderer 恒定，mention 扩展按本条消息的
// identities 闭包注入。mention 在解析后的 token 流上美化，代码块/行内代码/自动链接 URL
// 天然被排除（见 mentionMarkup.ts 与 #131），不再往原文里塞裸 HTML。
// 把裸 HTML token 的原文转义成可见文本（用于中和用户消息里的 inline/block HTML）。
function escapeRawHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function createMarked(identities: IdentityDisplayMap | undefined): Marked {
  const instance = new Marked();
  instance.use({
    renderer: {
      code({ text, lang }) {
        const language = lang && hljs.getLanguage(lang) ? lang : undefined;
        const html = language
          ? hljs.highlight(text, { language }).value
          : hljs.highlightAuto(text).value;
        return `<pre><code class="hljs">${html}</code></pre>`;
      },
      // #642 安全：消息 body 里的裸 HTML（inline <span …> 与 block）一律转义成可见文本，
      // 绝不作为真实 DOM 渲染。否则用户可写 `<span class="ap-mention" title="@owner">@owner</span>`
      // 借用应用样式伪造一个没真正 @、也不通知任何人的 @mention（或用 hljs-* 借样式）——
      // DOMPurify 的 class 白名单按名字放行，无法辨别来源，挡不住。真正的 mention span 由
      // mentionExtension 在解析后生成（apMention token，不走这条 html renderer），不受影响。
      html({ text }) {
        return escapeRawHtml(text);
      },
    },
  });
  if (identities !== undefined) {
    instance.use({ extensions: [mentionExtension(identities)] });
  }
  return instance;
}

// span/class 是 hljs 高亮产物的载体，必须放行。
// img 不放行：远程 src 会让每个看频道的人自动请求第三方主机（IP/时段追踪 beacon），
// MVP 先禁图，v2 需要时走图片代理再开。
const ALLOWED_TAGS = [
  "p", "br", "hr", "a",
  "code", "pre", "span",
  "ul", "ol", "li",
  "strong", "em", "del", "blockquote",
  "table", "thead", "tbody", "tr", "th", "td",
  // input 只为 GFM 任务列表 `- [ ]` 的复选框：marked 的 html renderer 已把消息正文里的裸 HTML
  // 整体转义（#642），所以能到达 DOMPurify 的 <input> 只可能是 marked 任务列表 token 生成的；
  // 下面的 hook 再把它强制成 disabled 复选框，杜绝任何交互/表单面。
  "input",
  "h1", "h2", "h3", "h4", "h5", "h6",
];
// align：保留 GFM 表格列对齐（marked 发 <th align="center">）。type/checked/disabled：任务列表复选框。
const ALLOWED_ATTR = ["href", "title", "class", "start", "align", "type", "checked", "disabled"];

// class 只留 hljs 产物和受控 mention 产物，防止消息正文借用应用自身样式伪装系统 UI。
const SAFE_CLASS_RE = /^(?:hljs(?:-[\w-]+)?|ap-mention)$/;

// addHook 只在有 DOM 时可用；无 DOM 环境（bun 测试、SSR）里 DOMPurify 是未绑定 window 的
// 工厂，addHook/sanitize 均为 undefined。此处守卫让 markdown.ts 在无 DOM 下也能被 import，
// 从而单测能覆盖 markdownToHtmlUnsafe 那一步——净化本身只在浏览器里真正执行，行为不变。
if (typeof DOMPurify.addHook === "function") {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // 外链新窗口 + noopener（净化后统一补，用户写不进 target/rel）
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    // 任务列表复选框：强制成不可交互的 disabled 复选框（type 只能是 checkbox），并删掉除
    // type/checked/disabled 外的一切属性——即便未来有别的路径塞进 <input>，也没有任何表单/交互面。
    if (node.tagName === "INPUT") {
      node.setAttribute("type", "checkbox");
      node.setAttribute("disabled", "");
      for (const attr of [...node.attributes]) {
        if (!["type", "checked", "disabled"].includes(attr.name)) node.removeAttribute(attr.name);
      }
    }
    if (node.hasAttribute("class")) {
      const kept = (node.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter((c) => SAFE_CLASS_RE.test(c))
        .join(" ");
      if (kept === "") node.removeAttribute("class");
      else node.setAttribute("class", kept);
    }
  });
}

// marked 解析 + mention 美化（DOMPurify 净化前的产物）。单独导出是因为 DOMPurify 依赖
// DOM，在 bun 测试环境跑不起来（addHook 未定义）；这一步是纯 marked，可被单测覆盖，用来
// 钉住「mention 在解析后美化、绝不在解析前注入」这条 #131 接线。DOMPurify 只做白名单，
// 不改动 ap-mention span 的结构，所以这一步的输出即最终 HTML 的语义。
export function markdownToHtmlUnsafe(md: string, identities?: IdentityDisplayMap): string {
  return createMarked(identities).parse(md, { async: false });
}

export function renderMarkdown(md: string, identities?: IdentityDisplayMap): string {
  const raw = markdownToHtmlUnsafe(md, identities);
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
