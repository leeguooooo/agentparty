import type { IdentityDisplayMap } from "./identityDisplay";

const BODY_MENTION_RE = /(^|[^a-zA-Z0-9._@-])@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;

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
    .replaceAll("@", "&#64;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function replaceMentionLabels(source: string, identities: IdentityDisplayMap | undefined): string {
  if (identities === undefined) return source;
  return source.replace(BODY_MENTION_RE, (full, prefix: string, name: string) => {
    const display = identities[name]?.display;
    return display === undefined || display === name
      ? full
      : `${prefix}<span class="ap-mention" title="@${escapeHtmlAttr(name)}">@${escapeHtmlText(display)}</span>`;
  });
}
