// 账号会话凭据：~/.agentparty/account.json（mode 0600），party login 写、logout 删
import { join } from "node:path";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { agentpartyHome } from "./config";

// spec §4：账号会话最小持久化形状。access_token/expires_at 为缓存，过期时用 refresh_token 换新
export interface AccountSession {
  server: string;
  refresh_token: string;
  access_token?: string;
  // 访问令牌过期的绝对时刻（epoch 秒）
  expires_at?: number;
  email?: string;
  sub?: string;
}

export function accountPath(): string {
  return join(agentpartyHome(), "account.json");
}

export function readAccount(): AccountSession | null {
  try {
    return JSON.parse(readFileSync(accountPath(), "utf8")) as AccountSession;
  } catch {
    return null;
  }
}

export function writeAccount(sess: AccountSession): void {
  mkdirSync(agentpartyHome(), { recursive: true });
  // refresh_token 是长期凭据，落盘只许属主读写；对已存在文件补 chmod
  writeFileSync(accountPath(), JSON.stringify(sess, null, 2) + "\n", { mode: 0o600 });
  chmodSync(accountPath(), 0o600);
}

// 返回登出前是否存在会话，供 logout 打印友好文案
export function clearAccount(): boolean {
  const existed = readAccount() !== null;
  try {
    rmSync(accountPath(), { force: true });
  } catch {
    // 已不存在
  }
  return existed;
}
