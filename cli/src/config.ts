// 全局配置与 workspace 游标状态
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface Config {
  server: string;
  token: string;
}

export interface WorkspaceState {
  channel: string;
  cursor: number;
}

export function agentpartyHome(): string {
  return process.env.AGENTPARTY_HOME || join(homedir(), ".agentparty");
}

export function configPath(): string {
  return join(agentpartyHome(), "config.json");
}

export function readConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as Config;
  } catch {
    return null;
  }
}

export function writeConfig(cfg: Config): void {
  mkdirSync(agentpartyHome(), { recursive: true });
  // 配置里有 token 明文，收紧到仅属主可读写；对已存在的文件补 chmod
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

export function slugifyBasename(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "workspace";
}

// <目录basename-slug>-<sha256(cwd)前16位>
export function workspaceId(cwd: string = process.cwd()): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return `${slugifyBasename(basename(cwd))}-${hash}`;
}

export function statePath(cwd: string = process.cwd()): string {
  return join(agentpartyHome(), "state", workspaceId(cwd), "state.json");
}

export function readState(cwd: string = process.cwd()): WorkspaceState | null {
  try {
    return JSON.parse(readFileSync(statePath(cwd), "utf8")) as WorkspaceState;
  } catch {
    return null;
  }
}

export function writeState(st: WorkspaceState, cwd: string = process.cwd()): void {
  const p = statePath(cwd);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(st, null, 2) + "\n");
}

export function resolveChannel(explicit?: string, cwd?: string): string | null {
  if (explicit) return explicit;
  return readState(cwd)?.channel ?? null;
}

// 游标只在频道与 workspace 绑定频道一致时读写
export function loadCursor(channel: string, cwd?: string): number {
  const st = readState(cwd);
  return st && st.channel === channel ? st.cursor : 0;
}

export function saveCursor(channel: string, cursor: number, cwd?: string): void {
  const st = readState(cwd);
  if (!st || st.channel !== channel) return;
  if (cursor <= st.cursor) return;
  writeState({ channel, cursor }, cwd);
}
