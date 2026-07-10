import { useMemo } from "react";
import type { IdentityDisplayMap } from "../lib/identityDisplay";
import { renderMarkdown } from "../lib/markdown";

export function Markdown({ source, identities }: { source: string; identities?: IdentityDisplayMap }) {
  // renderMarkdown 内部已过 DOMPurify 白名单；mention 在 marked 解析后美化（#131）
  const html = useMemo(() => renderMarkdown(source, identities), [source, identities]);
  return <div className="msg-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
