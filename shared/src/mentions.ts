// @mention lexical rules shared by the worker and web composer/renderer.
//
// Chinese prose normally has no spaces ("请@小明看一下"), so a Unicode
// "letter vs non-letter" boundary is too strict: the character before @ may
// legitimately be Han. Email, URL, package, and Markdown-code context therefore
// need explicit rejection. Keeping these rules here prevents the sender,
// renderer, and server from silently disagreeing about who was @ed.

export const MENTION_TOKEN_MAX_LENGTH = 64;

const MENTION_VALUE_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*/u;
const MENTION_TOKEN_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const ASCII_NAME_CHAR_RE = /[A-Za-z0-9._@-]/;
const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const EMAIL_LOCAL_CHAR_RE = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]/u;
const EMAIL_DOMAIN_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}\.)+[\p{L}][\p{L}\p{N}-]{1,62}/u;
const SCHEMELESS_URL_TAIL_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}\.)+[\p{L}\p{N}][\p{L}\p{N}-]{1,62}(?::\d{1,5})?(?:[/:?#][^\s]*)?$/iu;
const NPM_SCOPED_PACKAGE_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/i;

type TextRange = readonly [start: number, end: number];

export interface ParsedMentionToken {
  value: string;
  start: number;
  end: number;
}

export type MentionAliasKind = "canonical" | "nickname" | "display";

export interface MentionAlias {
  alias: string;
  target: string;
  kind: MentionAliasKind;
}

export type MentionResolution =
  | { status: "resolved"; target: string; matchedAlias: string }
  | { status: "unknown" }
  | { status: "ambiguous"; targets: string[] };

function urlSegmentBefore(text: string, at: number): string {
  let start = at;
  while (start > 0 && !/\s/u.test(text[start - 1]!)) start--;
  return text.slice(start, at);
}

export function isMentionInUrl(text: string, at: number): boolean {
  const prefix = urlSegmentBefore(text, at);
  if (/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s]*$/i.test(prefix)) return true;
  // Match a domain at the *tail* instead of requiring it at the start of the
  // whitespace-delimited segment. CJK prose commonly has no space before a URL:
  // "请看github.com/@alice" and "请看：github.com/@alice" are still URLs.
  return SCHEMELESS_URL_TAIL_RE.test(prefix);
}

function isMentionInEmail(text: string, at: number): boolean {
  let localStart = at;
  while (localStart > 0 && EMAIL_LOCAL_CHAR_RE.test(text[localStart - 1]!)) localStart--;
  if (localStart === at) return false;
  return EMAIL_DOMAIN_RE.test(text.slice(at + 1));
}

function isNpmScopedPackage(text: string, at: number): boolean {
  // Keep `/@alice/x` available as a prose mention (an established renderer
  // behaviour), while treating standalone `@scope/pkg` as a package reference.
  if (at > 0 && text[at - 1] === "/") return false;
  return NPM_SCOPED_PACKAGE_RE.test(text.slice(at));
}

function runLength(text: string, start: number, char: "`" | "~", end = text.length): number {
  let cursor = start;
  while (cursor < end && text[cursor] === char) cursor++;
  return cursor - start;
}

function fenceMarker(line: string): { char: "`" | "~"; length: number; rest: string } | null {
  let cursor = 0;
  while (cursor < line.length && cursor < 3 && line[cursor] === " ") cursor++;
  const char = line[cursor];
  if (char !== "`" && char !== "~") return null;
  const length = runLength(line, cursor, char);
  if (length < 3) return null;
  return { char, length, rest: line.slice(cursor + length) };
}

function fencedCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let open: { start: number; char: "`" | "~"; length: number } | null = null;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const nextLine = newline < 0 ? text.length : newline + 1;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const marker = fenceMarker(line);
    if (open === null) {
      // Backtick fence info strings cannot themselves contain a backtick.
      if (marker !== null && (marker.char === "~" || !marker.rest.includes("`"))) {
        open = { start: lineStart, char: marker.char, length: marker.length };
      }
    } else if (
      marker !== null &&
      marker.char === open.char &&
      marker.length >= open.length &&
      marker.rest.trim() === ""
    ) {
      ranges.push([open.start, nextLine]);
      open = null;
    }
    lineStart = nextLine;
  }
  if (open !== null) ranges.push([open.start, text.length]);
  return ranges;
}

function isEscaped(text: string, at: number): boolean {
  let slashes = 0;
  for (let cursor = at - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function inlineCodeRanges(text: string, start: number, end: number): TextRange[] {
  const ranges: TextRange[] = [];
  const runs: Array<{ start: number; length: number; nextSame?: number }> = [];
  let cursor = start;
  while (cursor < end) {
    const at = text.indexOf("`", cursor);
    if (at < 0 || at >= end) break;
    const length = runLength(text, at, "`", end);
    if (!isEscaped(text, at)) runs.push({ start: at, length });
    cursor = at + length;
  }
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!;
    const next = nextByLength.get(run.length);
    if (next !== undefined) run.nextSame = next;
    nextByLength.set(run.length, index);
  }
  for (let index = 0; index < runs.length;) {
    const opener = runs[index]!;
    if (opener.nextSame === undefined) {
      index++;
      continue;
    }
    const closer = runs[opener.nextSame]!;
    ranges.push([opener.start, closer.start + closer.length]);
    index = opener.nextSame + 1;
  }
  return ranges;
}

function markdownCodeRanges(text: string): TextRange[] {
  const fenced = fencedCodeRanges(text);
  const ranges: TextRange[] = [];
  let cursor = 0;
  for (const fence of fenced) {
    ranges.push(...inlineCodeRanges(text, cursor, fence[0]), fence);
    cursor = fence[1];
  }
  ranges.push(...inlineCodeRanges(text, cursor, text.length));
  return ranges;
}

function insideRanges(at: number, ranges: readonly TextRange[]): boolean {
  return ranges.some(([start, end]) => at >= start && at < end);
}

export function isMentionBoundaryChar(char: string): boolean {
  return char === "" || !ASCII_NAME_CHAR_RE.test(char);
}

function isMentionStartOutsideCode(text: string, at: number): boolean {
  if (text[at] !== "@") return false;
  if (isNpmScopedPackage(text, at) || isMentionInEmail(text, at) || isMentionInUrl(text, at)) return false;
  const previous = at === 0 ? "" : text[at - 1]!;
  return isMentionBoundaryChar(previous);
}

function isMentionStartWithCodeRanges(text: string, at: number, codeRanges: readonly TextRange[]): boolean {
  return !insideRanges(at, codeRanges) && isMentionStartOutsideCode(text, at);
}

export function isMentionStart(text: string, at: number): boolean {
  return isMentionStartWithCodeRanges(text, at, markdownCodeRanges(text));
}

// Reads the lexical token after @. Boundary/URL checks intentionally live in
// isMentionStart so marked's inline tokenizer can supply its previous token.
export function readMentionToken(text: string, at: number): ParsedMentionToken | null {
  if (text[at] !== "@") return null;
  const match = MENTION_VALUE_RE.exec(text.slice(at + 1));
  // A full stop is ordinary sentence punctuation when it ends the lexical run:
  // "@codex." routes codex and leaves the period in prose. Internal dots remain
  // valid (`@first.last`).
  const value = match?.[0]?.replace(/\.+$/u, "");
  if (!value) return null;
  return { value, start: at, end: at + 1 + value.length };
}

export function extractMentionTokens(text: string): ParsedMentionToken[] {
  const out: ParsedMentionToken[] = [];
  const codeRanges = markdownCodeRanges(text);
  let codeRangeIndex = 0;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    while (codeRangeIndex < codeRanges.length && codeRanges[codeRangeIndex]![1] <= at) codeRangeIndex++;
    const codeRange = codeRanges[codeRangeIndex];
    if (codeRange !== undefined && at >= codeRange[0] && at < codeRange[1]) continue;
    if (!isMentionStartOutsideCode(text, at)) continue;
    const parsed = readMentionToken(text, at);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function isValidMentionToken(value: string): boolean {
  return MENTION_TOKEN_RE.test(value);
}

/**
 * Match keys must mirror SQLite's NOCASE contract: ASCII identifiers are
 * case-insensitive, while Unicode aliases are exact after NFC normalization.
 * Locale-wide lower-casing is unsafe here (for example, it can make the Web
 * resolve an alias that D1 deliberately treats as a different identity).
 */
export function mentionMatchKey(value: string): string {
  const normalized = value.normalize("NFC");
  return /^[A-Za-z0-9._-]+$/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function uniqueTargets(matches: MentionAlias[]): string[] {
  return [...new Set(matches.map((entry) => entry.target))].sort((a, b) => a.localeCompare(b));
}

function finish(matches: MentionAlias[]): MentionResolution | null {
  const targets = uniqueTargets(matches);
  if (targets.length === 0) return null;
  if (targets.length > 1) return { status: "ambiguous", targets };
  return { status: "resolved", target: targets[0]!, matchedAlias: matches[0]!.alias };
}

// Exact canonical/handle/nickname matches outrank a coincidentally equal
// display name. A display is routable only when it identifies one target.
//
// For CJK prose we also allow a known alias followed immediately by CJK text:
// "@小明看一下" resolves the known alias "小明" and leaves "看一下" as prose.
// Multiple possible target prefixes are rejected instead of guessing.
export function resolveMentionToken(value: string, aliases: MentionAlias[]): MentionResolution {
  const normalized = mentionMatchKey(value);
  const exact = aliases.filter((entry) => mentionMatchKey(entry.alias) === normalized);
  const exactStrong = finish(exact.filter((entry) => entry.kind !== "display"));
  if (exactStrong !== null) return exactStrong;
  const exactDisplay = finish(exact.filter((entry) => entry.kind === "display"));
  if (exactDisplay !== null) return exactDisplay;

  const prefixes = aliases.filter((entry) => {
    const alias = mentionMatchKey(entry.alias);
    if (alias === "" || alias.length >= normalized.length || !normalized.startsWith(alias)) return false;
    const suffix = value.slice(entry.alias.length);
    return suffix !== "" && CJK_CHAR_RE.test(suffix[0]!);
  });
  const prefixStrong = finish(prefixes.filter((entry) => entry.kind !== "display"));
  if (prefixStrong !== null) return prefixStrong;
  const prefixDisplay = finish(prefixes.filter((entry) => entry.kind === "display"));
  return prefixDisplay ?? { status: "unknown" };
}
