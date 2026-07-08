import { RESERVED_NAMES } from "@agentparty/shared";

export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function validateHandleFormat(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const h = input.trim();
  return HANDLE_RE.test(h) ? h : null;
}

// 冲突检查：撞保留名 / 撞任意 token 名 / 已被别的账号占用。无冲突返回 null。
export async function handleConflict(
  db: D1Database,
  handle: string,
  forAccount: string | null,
): Promise<"reserved" | "token_name" | "taken" | null> {
  if (RESERVED_NAMES.includes(handle)) return "reserved";
  const tok = await db.prepare("SELECT 1 FROM tokens WHERE name = ?").bind(handle).first();
  if (tok) return "token_name";
  const owner = await db
    .prepare("SELECT account FROM account_profiles WHERE handle = ?")
    .bind(handle)
    .first<{ account: string }>();
  if (owner && owner.account !== forAccount) return "taken";
  return null;
}
