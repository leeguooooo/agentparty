export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const MAX_TIMEOUT_SEC = Math.floor(2_147_483_647 / 1000);

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

export function isName(value: string): boolean {
  return NAME_RE.test(value);
}

export function parseNonNegativeIntFlag(value: string | undefined, flag: string): number | string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return `--${flag} must be a non-negative integer`;
  return Number(value);
}

export function parsePositiveIntFlag(
  value: string | undefined,
  flag: string,
  max?: number,
): number | string | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) return `--${flag} must be a positive integer`;
  const n = Number(value);
  if (max !== undefined && n > max) return `--${flag} must be <= ${max}`;
  return n;
}

export function normalizeServerUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// config 里手写/脚本生成的 server 常缺协议头（"agentparty.example.com"）——init 会规范化，
// 但绕过 init 的路径不会。直接喂给 fetch 会炸出 Bun 原始报错 "fetch() URL is invalid"，
// 外层 runner 的 party send 因此静默丢交付（生产实锤，#agentparty seq=725）。这里透明自愈：
// 合法则归一化原值，缺协议补 https:// 再试，治不了返回 null 让调用方给明确错误。
export function healServerUrl(value: string): string | null {
  return normalizeServerUrl(value) ?? normalizeServerUrl(`https://${value}`);
}
