// 全局配置与 workspace 游标状态
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { atomicWriteJson } from "./atomic-json";

export interface Config {
  server: string;
  token: string;
  identity?: CachedIdentity;
}

export interface CachedIdentity {
  name: string;
  email: string | null;
  kind: string;
  role: string;
  owner: string | null;
  channel_scope: string | null;
  verified_at: number;
}

export type ConfigSourceKind = "explicit" | "workspace" | "global" | "none";

export interface ConfigSourceInfo {
  kind: ConfigSourceKind;
  path: string | null;
  workspace_id?: string;
  token_fingerprint?: string;
}

export interface ConfigWithSource {
  config: Config | null;
  source: ConfigSourceInfo;
}

/**
 * 欠账（#198）：一条送达失败、从没进过模型的 @。
 * 它和 cursor 是**两个语义**：cursor 说「这条我了结了」（处理成功，或主动宣告放弃），
 * stuck 说「这条我欠着」。只存内存不算修复——runner 崩溃常常连进程一起带走。
 */
export interface StuckWake {
  seq: number;
  /** durable directed-delivery identity; independent from the ordinary message cursor. */
  delivery_id?: string;
  /** Stable logical work identity, retained so JSON replay does not erase delivery context. */
  work_id?: string;
  /** Harness continuation selected for this work, when the server supplied one. */
  continuation_ref?: string;
  /**
   * Directed watch 两阶段接单状态：running ACK 前为 unconfirmed，绝不能按 seq 本地回放；
   * 服务端 ACK 后以 delivery id 原子转为 accepted，才允许把已确认接单但被 harness 吞掉的输出重放。
   */
  delivery_acceptance?: "unconfirmed" | "accepted";
  /** 连续送达失败次数。有界重放靠它：超过上限就响亮放弃，绝不静默丢弃。 */
  attempts: number;
  last_error?: string;
  /** false means the model/process may already have run; restart must announce/close, never execute it again. */
  retriable?: boolean;
  /** Runner ignored cancellation; restart must trip the circuit before accepting any later wake. */
  termination_unconfirmed?: boolean;
  /** 旧状态/serve 欠账没有该字段；watch 用它隔离两阶段确认语义，不能误清 serve delivery debt。 */
  source?: "serve" | "watch";
  /** watch 首次输出时看到的频道 head；重放时会再探测并取较新者。 */
  channel_last_seq?: number;
  /** 首次显式快进时跳过的 mentions，随 pending wake 一起保留。 */
  skipped_mention_seqs?: number[];
}

export interface ChannelCursor {
  cursor: number;
  rev_cursor?: number;
  stuck?: StuckWake;
}

export interface WorkspaceState {
  channel: string;
  cursor: number;
  /** 修订游标：已见过的最大 rev_seq（hello.since_rev），与消息游标并列持久化 */
  rev_cursor?: number;
  /**
   * 分频道游标（#113）。旧版把游标只绑在 `channel` 上，于是 `serve --profile` 的所有
   * 频道恒 since=0，每次重启把保留窗口里的历史 @ 逐条重放，反复拉起 runner。
   * 顶层 channel/cursor/rev_cursor 保留作绑定频道的镜像，兼容旧读者与 statusline。
   */
  cursors?: Record<string, ChannelCursor>;
  /** 每个频道最后一次 init 使用的显式 config；同一 cwd 的多频道互不覆盖。 */
  bindings?: Record<string, string>;
  /**
   * 面包屑：init 时若用了 AGENTPARTY_CONFIG，把该显式路径记进【cwd 基准】的 state（不受 env 影响）。
   * 回落用——Claude Code 的 Bash 不跨 turn 保留 export，被唤醒回复轮没了 env 就靠它找回绑定的 agent
   * config，避免回落到人类账号会话导致冒充/串号（issue #42）。只存路径不存 token，token 仍只在该文件里。
   */
  config_path?: string;
}

export function agentpartyHome(): string {
  return process.env.AGENTPARTY_HOME || join(homedir(), ".agentparty");
}

export function explicitConfigPath(): string | null {
  return process.env.AGENTPARTY_CONFIG || null;
}

// 全局 config：跨目录默认 + 存量兼容（旧版本只写这里）。
export function globalConfigPath(): string {
  const explicit = explicitConfigPath();
  if (explicit) return explicit;
  return defaultGlobalConfigPath();
}

function defaultGlobalConfigPath(): string {
  return join(agentpartyHome(), "config.json");
}

// workspace 级 config：按 cwd 隔离，与 state 同放（state/<workspaceId>/）。
// 同机多 session 各在自己目录，token/身份互不覆盖——修「共享 config.json 被后启动的 session 冲掉」。
// 注：同一目录并发多 session 仍会撞（workspaceId 相同），那种情形用 AGENTPARTY_CONFIG
// 或 AGENTPARTY_HOME 硬隔离；AGENTPARTY_CONFIG 同时隔离 config 与 cursor state。
export function workspaceConfigPath(cwd: string = process.cwd()): string {
  const explicit = explicitConfigPath();
  if (explicit) return explicit;
  return defaultWorkspaceConfigPath(cwd);
}

function defaultWorkspaceConfigPath(cwd: string): string {
  return join(agentpartyHome(), "state", workspaceId(cwd), "config.json");
}

/**
 * Write one workspace identity without consulting `AGENTPARTY_CONFIG` and without
 * replacing the process-wide fallback config.
 *
 * `party serve --profile` owns several child identities inside one resident
 * process.  Calling `writeConfig()` there would either overwrite the owner's
 * explicit config or race every child through the same global config.  The
 * returned path is safe to pin into only that child's runner environment.
 */
export function writeWorkspaceConfigOnly(cfg: Config, cwd: string): string {
  const path = defaultWorkspaceConfigPath(cwd);
  writeConfigFile(path, cfg);
  return path;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // TMPDIR 被整目录清掉后，直接 realpath(dirname(path)) 也会失败。向上找到最近仍存在的
    // 祖先（macOS 通常是 /var/folders/.../T），先消解 /var → /private/var，再接回尾段。
    let current = resolve(path);
    const tail: string[] = [];
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.unshift(basename(current));
      current = parent;
    }
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      return resolve(path);
    }
  }
}

function isWithin(path: string, root: string): boolean {
  const candidate = canonicalPath(path);
  const base = canonicalPath(root);
  return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * 临时目录不能成为 agent token 的唯一存储（#518）。
 *
 * 保留调用方给出的文件名（spawn / invite 已含 agent+channel），但把副本放进
 * ~/.agentparty/agents。AGENTPARTY_HOME 本身视为显式持久根，即使测试或高级用户把它
 * 指到了系统临时目录，也不对它递归再镜像。
 */
export function durableConfigPointerPath(path: string): string {
  if (isWithin(path, agentpartyHome())) return path;
  const ephemeral = [tmpdir(), "/tmp", "/private/tmp"].some((root) => isWithin(path, root));
  if (!ephemeral) return path;

  const rawStem = basename(path).replace(/\.json$/i, "");
  const stem = slugifyBasename(rawStem);
  const stableStem = stem.startsWith("agentparty-")
    ? stem
    : `${stem}-${createHash("sha256").update(canonicalPath(path)).digest("hex").slice(0, 8)}`;
  return join(agentpartyHome(), "agents", `${stableStem}.json`);
}

function writeConfigFile(path: string, cfg: Config): void {
  atomicWriteJson(path, cfg);
  const durable = durableConfigPointerPath(path);
  if (durable !== path) atomicWriteJson(durable, cfg);
}

// 兼容旧调用：优先返回存在的 workspace 级路径，否则全局路径。
export function configPath(cwd: string = process.cwd()): string {
  const ws = workspaceConfigPath(cwd);
  return existsSync(ws) ? ws : globalConfigPath();
}

export function tokenFingerprint(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
}

function sourceInfo(kind: ConfigSourceKind, path: string | null, cfg: Config | null, cwd: string): ConfigSourceInfo {
  return {
    kind,
    path,
    ...(kind === "workspace" ? { workspace_id: workspaceId(cwd) } : {}),
    ...(cfg?.token ? { token_fingerprint: tokenFingerprint(cfg.token) } : {}),
  };
}

function readBreadcrumbConfig(cwd: string): ConfigWithSource | null {
  try {
    const st = JSON.parse(readFileSync(cwdStatePath(cwd), "utf8")) as WorkspaceState;
    const breadcrumb = st.bindings?.[st.channel] ?? st.config_path;
    if (!breadcrumb) return null;
    try {
      const cfg = JSON.parse(readFileSync(breadcrumb, "utf8")) as Config;
      return { config: cfg, source: sourceInfo("explicit", breadcrumb, cfg, cwd) };
    } catch {
      console.error(`warning: workspace config breadcrumb is unreadable: ${breadcrumb}; falling back to global config`);
    }
  } catch {
    /* 无 cwd state */
  }
  return null;
}

export function readConfigWithSource(cwd: string = process.cwd()): ConfigWithSource {
  const explicit = explicitConfigPath();
  let missingExplicit: ConfigSourceInfo | null = null;
  if (explicit) {
    try {
      const cfg = JSON.parse(readFileSync(explicit, "utf8")) as Config;
      return { config: cfg, source: sourceInfo("explicit", explicit, cfg, cwd) };
    } catch {
      // 显式路径若被 TMPDIR 清理，只尝试 workspace breadcrumb 的同身份持久镜像（#518）。
      // 若镜像也失败，保留 explicit source 并失败关闭，诊断仍能指出真正丢失的路径。
      missingExplicit = sourceInfo("explicit", explicit, null, cwd);
    }
  }

  // 显式路径丢失时，只接受由该路径确定性推导出的持久镜像；不能盲信 cwd 中可能属于
  // 另一并发 agent 的 breadcrumb，否则会从“丢身份”变成更危险的静默串号。
  if (missingExplicit) {
    const durable = durableConfigPointerPath(explicit!);
    if (durable !== explicit) {
      try {
        const cfg = JSON.parse(readFileSync(durable, "utf8")) as Config;
        return { config: cfg, source: sourceInfo("explicit", durable, cfg, cwd) };
      } catch {
        /* 持久镜像同样不可读：下面失败关闭 */
      }
    }
    // AGENTPARTY_CONFIG 是明确的身份选择；其本体和持久 breadcrumb 都不可读时必须失败关闭，
    // 不能继续拿 workspace/global 的另一枚 token 冒充当前 agent。
    return { config: null, source: missingExplicit };
  }

  // 走到这里说明没有 AGENTPARTY_CONFIG，按正常 workspace → breadcrumb → global 顺序读取。
  const ws = defaultWorkspaceConfigPath(cwd);
  try {
    const cfg = JSON.parse(readFileSync(ws, "utf8")) as Config;
    return { config: cfg, source: sourceInfo("workspace", ws, cfg, cwd) };
  } catch {
    /* 试 cwd 面包屑 */
  }

  // cwd 绑定优先于全局兜底（#359）。bindings 是新格式；config_path 是旧状态兼容镜像。
  const breadcrumb = readBreadcrumbConfig(cwd);
  if (breadcrumb) return breadcrumb;

  const global = defaultGlobalConfigPath();
  try {
    const cfg = JSON.parse(readFileSync(global, "utf8")) as Config;
    return { config: cfg, source: sourceInfo("global", global, cfg, cwd) };
  } catch {
    /* 无全局来源 */
  }
  return { config: null, source: sourceInfo("none", null, null, cwd) };
}

export function readConfig(cwd: string = process.cwd()): Config | null {
  return readConfigWithSource(cwd).config;
}

export function writeConfig(cfg: Config, cwd: string = process.cwd()): void {
  const explicit = explicitConfigPath();
  if (explicit) {
    writeConfigFile(explicit, cfg);
    return;
  }
  // 配置里有 token 明文，收紧到仅属主可读写；对已存在的文件补 chmod
  // 双写：① workspace 级（本目录/session 专属，读取时优先）② 全局（跨目录默认 + 存量兼容）。
  // 读取偏好 workspace，故全局被并发覆盖也不会串号。
  for (const p of [workspaceConfigPath(cwd), globalConfigPath()]) {
    atomicWriteJson(p, cfg);
  }
}

/**
 * 就地刷新配置（#104）：只写**读取时命中的那个来源**，绝不双写、绝不新建。
 *
 * `party init` 双写（workspace + 全局）是有意的契约——「init 一次，跨目录可用」。
 * 但 `party whoami` / `statusline` 只是想把 identity 缓存刷新一下，它们不该有身份的副作用：
 * 旧实现里，在一个 workspace 身份是 bob 的目录跑一句 whoami，就会把**全局**也换成 bob，
 * 于是所有靠全局回落的目录悄悄改用了 bob 的 token，甚至打到另一台 server 上。
 * statusline 更隐蔽——它在后台定时跑。
 */
export function refreshConfigInPlace(cfg: Config, cwd: string = process.cwd()): void {
  const { source } = readConfigWithSource(cwd);
  if (source.kind === "none" || source.path === null) return; // 没有来源就没有该刷新的东西
  writeConfigFile(source.path, cfg);
}

export function slugifyBasename(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "workspace";
}

// <目录basename-slug>-<sha256(realpath(cwd))前16位>
//
// 必须先 realpath（#104）：cwd 字符串直接哈希时，同一个目录经不同路径访问会得到不同的
// workspaceId，于是它找不到自己的 workspace config、静默回落到全局身份——用的是别人的 token。
// macOS 上 /tmp 与 /var 都是 symlink（`/var/folders/...` 与 `/private/var/folders/...`
// 是同一个目录），所以这不是边角情形：任何 cd 进 symlink 路径的 session 都会中招。
// realpath 失败（目录不存在）时退回原字符串，保持旧行为。
export function workspaceId(cwd: string = process.cwd()): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* 目录还不存在：用原路径，反正它也还没有 workspace config */
  }
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return `${slugifyBasename(basename(real))}-${hash}`;
}

export function workspaceLabel(cwd: string = process.cwd()): string {
  return basename(cwd) || "workspace";
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    const res = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0) return null;
    const out = String(res.stdout).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

export function worktreeLabel(cwd: string = process.cwd()): string | undefined {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) return undefined;
  const branch = gitOutput(cwd, ["branch", "--show-current"]);
  const head = branch ?? gitOutput(cwd, ["rev-parse", "--short", "HEAD"]);
  return head === null ? basename(root) : `${basename(root)}:${head}`;
}

/**
 * realpath 修复（#104）改变了 workspaceId，于是老用户的 state 目录名对不上了：
 * 游标会被当成陌生 workspace 从 0 开始。serve 有 #193 的 skip-backlog 兜底，
 * **但 watch --once 没有**——游标归 0 后它每次唤醒只消费一条，要烧掉几百次唤醒才追得上。
 *
 * 所以把旧哈希（未 realpath 的 cwd 字符串）下的目录一次性搬过来。
 * 幂等：新目录已存在就什么都不做，绝不覆盖更新的状态。
 */
function migrateLegacyWorkspaceState(cwd: string): void {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return; // 目录不存在，没有可迁移的东西
  }
  if (real === cwd) return; // 路径本来就是真实路径，没有旧哈希
  const root = join(agentpartyHome(), "state");
  const legacyHash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const legacy = join(root, `${slugifyBasename(basename(cwd))}-${legacyHash}`);
  const current = join(root, workspaceId(real));
  if (existsSync(current) || !existsSync(legacy)) return;
  try {
    mkdirSync(root, { recursive: true });
    renameSync(legacy, current);
  } catch {
    /* 并发下另一个进程先搬完了，或跨设备：忽略，读取会走正常路径 */
  }
}

export function statePath(cwd: string = process.cwd()): string {
  const explicit = explicitConfigPath();
  if (explicit) return configScopedStatePath(explicit);
  return join(agentpartyHome(), "state", workspaceId(cwd), "state.json");
}

function configScopedStatePath(configPath: string): string {
  return join(dirname(configPath), `${basename(configPath)}.state`, "state.json");
}

function durableStatePath(): string | null {
  const explicit = explicitConfigPath();
  if (!explicit) return null;
  const durable = durableConfigPointerPath(explicit);
  return durable === explicit ? null : configScopedStatePath(durable);
}

// cwd 基准的 state 路径，永远无视 AGENTPARTY_CONFIG——面包屑指针写这里，回复轮（无 env）才找得到。
export function cwdStatePath(cwd: string = process.cwd()): string {
  return join(agentpartyHome(), "state", workspaceId(cwd), "state.json");
}

const STATE_LOCK_TIMEOUT_MS = 5_000;
const STATE_LOCK_STALE_MS = 30_000;
const lockWaiter = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeStaleLock(lockPath: string): void {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    if (typeof owner.pid === "number" && processAlive(owner.pid)) return;
    if (typeof owner.pid !== "number" && age < STATE_LOCK_STALE_MS) return;
    rmSync(lockPath, { force: true });
  } catch {
    /* lock disappeared or is still being initialized */
  }
}

function withStateLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  for (;;) {
    let fd: number | null = null;
    let created = false;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      created = true;
      writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: Date.now() }) + "\n");
      closeSync(fd);
      fd = null;
      break;
    } catch (error) {
      if (fd !== null) closeSync(fd);
      if (created) rmSync(lockPath, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) throw new Error(`timed out waiting for state lock: ${lockPath}`);
      Atomics.wait(lockWaiter, 0, 0, 2);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function readStateFile(path: string): WorkspaceState | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkspaceState;
  } catch {
    return null;
  }
}

// init 时把显式 config 路径按频道记进 cwd-state；config_path 保留为旧读者的当前频道镜像。
export function bindWorkspaceConfigPointer(configPath: string, channel: string, cwd: string = process.cwd()): void {
  const p = cwdStatePath(cwd);
  withStateLock(p, () => {
    const prev = readStateFile(p);
    const next: WorkspaceState = {
      ...(prev ?? { channel, cursor: 0 }),
      channel,
      bindings: {
        ...(prev?.config_path ? { [prev.channel]: prev.config_path } : {}),
        ...(prev?.bindings ?? {}),
        [channel]: configPath,
      },
      config_path: configPath,
    };
    atomicWriteJson(p, next);
  });
}

export function readState(cwd: string = process.cwd()): WorkspaceState | null {
  migrateLegacyWorkspaceState(cwd);
  const durable = durableStatePath();
  const paths = [statePath(cwd), durable, explicitConfigPath() && !durable ? null : cwdStatePath(cwd)].filter(
    (path, index, all): path is string => path !== null && all.indexOf(path) === index,
  );
  for (const path of paths) {
    const state = readStateFile(path);
    if (state) return state;
  }
  return null;
}

function writeStateCopies(primary: string, st: WorkspaceState): void {
  atomicWriteJson(primary, st);
  const durable = durableStatePath();
  if (durable && durable !== primary) atomicWriteJson(durable, st);
}

// tmp + rename 原子替换（#113）：裸 writeFileSync 在崩溃/并发下会留下截断的 JSON，
// readState 随即返回 null → 游标退回 0 → 整个保留窗口的 @ 被重放。范本同 statusline-cache.ts。
export function writeState(st: WorkspaceState, cwd: string = process.cwd()): void {
  const p = statePath(cwd);
  withStateLock(p, () => writeStateCopies(p, st));
}

export function resolveChannel(explicit?: string, cwd?: string): string | null {
  if (explicit) return explicit;
  // Resident profile runners cannot mutate process.env per child: several
  // channels may execute concurrently in the same daemon.  Each spawned model
  // process receives this immutable binding together with its child config, so
  // nested `party decision ask` / `party send` calls stay in the wake's channel.
  if (process.env.AGENTPARTY_CHANNEL) return process.env.AGENTPARTY_CHANNEL;
  return readState(cwd)?.channel ?? null;
}

// 游标按频道键持久化（#113）。读旧格式时回落到顶层字段（绑定频道），保证升级不丢游标。
function channelCursor(st: WorkspaceState | null, channel: string): ChannelCursor {
  if (!st) return { cursor: 0 };
  const scoped = st.cursors?.[channel];
  if (scoped) return scoped;
  if (st.channel === channel) return { cursor: st.cursor, ...(st.rev_cursor === undefined ? {} : { rev_cursor: st.rev_cursor }) };
  return { cursor: 0 };
}

// cursor 的读取、比较、合并、写回必须同处一个跨进程临界区（#364）。
function updateChannelCursor(
  channel: string,
  update: (current: ChannelCursor) => ChannelCursor | null,
  cwd: string = process.cwd(),
): void {
  migrateLegacyWorkspaceState(cwd);
  const p = statePath(cwd);
  withStateLock(p, () => {
    const st = readStateFile(p) ?? readState(cwd) ?? { channel, cursor: 0 };
    const next = update(channelCursor(st, channel));
    if (next === null) return;
    const merged: WorkspaceState = {
      ...st,
      cursors: { ...(st.cursors ?? {}), [channel]: next },
    };
    if (st.channel === channel) {
      merged.cursor = next.cursor;
      if (next.rev_cursor === undefined) delete merged.rev_cursor;
      else merged.rev_cursor = next.rev_cursor;
    }
    writeStateCopies(p, merged);
  });
}

export function loadCursor(channel: string, cwd?: string): number {
  return channelCursor(readState(cwd), channel).cursor;
}

export function saveCursor(channel: string, cursor: number, cwd?: string): void {
  updateChannelCursor(channel, (cur) => cursor <= cur.cursor ? null : { ...cur, cursor }, cwd);
}

/** 读欠账（#198）。没有欠账返回 null。 */
export function loadStuck(channel: string, cwd?: string): StuckWake | null {
  return channelCursor(readState(cwd), channel).stuck ?? null;
}

/** 写欠账。和 cursor 并列，互不覆盖。 */
export function saveStuck(channel: string, stuck: StuckWake, cwd?: string): void {
  updateChannelCursor(channel, (cur) => ({ ...cur, stuck }), cwd);
}

/**
 * 原子写 watch 欠账：watch/serve 用不同实例锁，可以并发；不能先 load 再 save（TOCTOU 会覆盖 serve debt）。
 * 返回 false 表示已有非 watch 欠账，调用方必须停止且不得 ack 当前消息。
 */
export function saveWatchStuck(channel: string, stuck: StuckWake, cwd?: string): boolean {
  let saved = false;
  updateChannelCursor(channel, (cur) => {
    if (cur.stuck !== undefined && cur.stuck.source !== "watch") return null;
    saved = true;
    return { ...cur, stuck: { ...stuck, source: "watch" } };
  }, cwd);
  return saved;
}

/**
 * 将同一条 directed watch debt 从 unconfirmed 原子推进为 accepted。
 * delivery id 不同、debt 被 serve/另一条 work 替换、或状态不是 unconfirmed 时均 fail closed。
 */
export function markWatchDirectedStuckAccepted(channel: string, deliveryId: string, cwd?: string): boolean {
  let accepted = false;
  updateChannelCursor(channel, (cur) => {
    const stuck = cur.stuck;
    if (
      stuck?.source !== "watch" ||
      stuck.delivery_id !== deliveryId ||
      stuck.delivery_acceptance !== "unconfirmed"
    ) {
      return null;
    }
    accepted = true;
    return {
      ...cur,
      stuck: {
        ...stuck,
        delivery_acceptance: "accepted",
        last_error: "watch delivery accepted; awaiting agent acknowledgement",
      },
    };
  }, cwd);
  return accepted;
}

/** 了结欠账：送达成功，或有界重试耗尽后显式放弃。 */
export function clearStuck(channel: string, cwd?: string): void {
  updateChannelCursor(channel, (cur) => {
    const { stuck: _dropped, ...rest } = cur;
    return rest;
  }, cwd);
}

/**
 * 自己发消息后推进游标——**仅在没有空洞时**（#113）。
 * 旧实现无条件 saveCursor(channel, mySeq)，把发送前所有未消费的消息（含正 @ 我的新 mention）
 * 一起吞掉：不打印、不唤醒、不补拉。watch 侧本来就有 fromSelf 过滤（watch.ts），
 * 所以「跳过自己的回声」根本不需要动游标。
 * 这里只处理「我已经读到最新、紧接着自己发了一条」的情形，保住 statusline 的 unread=0。
 */
export function advanceCursorPastOwnMessage(channel: string, seq: number, cwd?: string): void {
  updateChannelCursor(channel, (cur) => {
    const advancesCursor = cur.cursor === seq - 1;
    const acknowledgesWake = cur.stuck?.source === "watch" && seq > cur.stuck.seq;
    if (!advancesCursor && !acknowledgesWake) return null;
    const next: ChannelCursor = advancesCursor ? { ...cur, cursor: seq } : { ...cur };
    if (acknowledgesWake) delete next.stuck;
    return next;
  }, cwd);
}

export function loadRevCursor(channel: string, cwd?: string): number {
  return channelCursor(readState(cwd), channel).rev_cursor ?? 0;
}

export function saveRevCursor(channel: string, revCursor: number, cwd?: string): void {
  updateChannelCursor(
    channel,
    (cur) => revCursor <= (cur.rev_cursor ?? 0) ? null : { ...cur, rev_cursor: revCursor },
    cwd,
  );
}
