import { RESERVED_NAMES } from "@agentparty/shared";

// #165：agent 全局唯一昵称（可 @中文昵称 唤醒）。与人类 handle 共用一套 @ 命名空间，
// 但存法不同：handle 按 account（人类一账号一昵称），nickname 按 token name（agent 与 human
// 共享 account，故必须 per-identity）。允许 unicode 首字（中文），后续字符再放开 . _ -。
// 长度上界 64（与 do.ts BODY_MENTION_RE 的 {0,63} 捕获上界对齐——设了就一定能被 @ 到）。
export const NICKNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

export function validateNicknameFormat(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const n = input.trim();
  return NICKNAME_RE.test(n) ? n : null;
}

// 冲突检查（共用 @ 命名空间）：撞保留名 / 撞任意 token 名 / 撞人类 handle / 已被别的 agent 占用。
// forName = 设置者自己的 token name（同名覆盖自己那条不算冲突）。无冲突返回 null。
export async function nicknameConflict(
  db: D1Database,
  nickname: string,
  forName: string,
): Promise<"reserved" | "token_name" | "handle" | "taken" | null> {
  if (RESERVED_NAMES.includes(nickname)) return "reserved";
  const tok = await db.prepare("SELECT 1 FROM tokens WHERE name = ? COLLATE NOCASE").bind(nickname).first();
  if (tok) return "token_name";
  const handle = await db
    .prepare("SELECT 1 FROM account_profiles WHERE handle = ? COLLATE NOCASE")
    .bind(nickname)
    .first();
  if (handle) return "handle";
  const owner = await db
    .prepare("SELECT name FROM agent_nicknames WHERE nickname = ? COLLATE NOCASE")
    .bind(nickname)
    .first<{ name: string }>();
  if (owner && owner.name !== forName) return "taken";
  return null;
}

export async function saveAgentNickname(
  db: D1Database,
  name: string,
  nickname: string,
): Promise<"reserved" | "token_name" | "handle" | "taken" | null> {
  const conflict = await nicknameConflict(db, nickname, name);
  if (conflict !== null) return conflict;
  const now = Date.now();
  try {
    await db.prepare(
      `INSERT INTO agent_nicknames (name, nickname, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at`,
    )
      .bind(name, nickname, now, now)
      .run();
    return null;
  } catch (error) {
    // nicknameConflict 之后仍可能被并发请求抢占；保持 409 语义，不把唯一键竞态冒成 500。
    if ((error instanceof Error ? error.message : String(error)).includes("UNIQUE")) return "taken";
    throw error;
  }
}
