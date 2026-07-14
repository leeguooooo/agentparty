// 自升级支持（issue #45）：已在跑的 serve 是内存里的旧二进制，但 process.execPath 指向的磁盘文件
// 会被 install.sh 换成新版。这里网络-free 地读磁盘二进制版本、比对、在唤醒间隙 re-exec 新版。
import pkg from "../package.json" with { type: "json" };

export const RUNNING_VERSION = pkg.version;
export const OWNER_REPO = "leeguooooo/agentparty";
export const INSTALL_LINE = `curl -fsSL https://raw.githubusercontent.com/${OWNER_REPO}/main/install.sh | sh`;

// semver 比较：a>b→1, a<b→-1, ==→0。只认 X.Y.Z 数字段，非法段当 0。
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 磁盘上 party 二进制的版本：对编译版（bun --compile），process.execPath 就是 party 二进制本身，
// install.sh 覆盖它后，spawn 它 --version 读到的是【新】版本，而当前进程仍是旧的内存镜像。
// 注入点 readVersion 供测试；默认真跑 execPath --version。dev（bun run src/index.ts）下 execPath
// 是 bun，读不到 party 版本 → 返回 null（不误判、不 re-exec）。
export interface UpgradeDeps {
  runningVersion?: string;
  execPath?: string;
  readInstalledVersion?: (execPath: string) => string | null;
  reexec?: (execPath: string, argv: string[]) => void;
}

export interface CliUpgradeNotice {
  running_version: string;
  /** 磁盘已经安装、只需 re-exec 的版本。服务器发布版提示里没有这个字段。 */
  installed_version?: string;
  /** 可下载安装的版本；磁盘更新和服务器发布更新两种来源都统一暴露。 */
  available_version: string;
  auto_upgrade: boolean;
  action_required: "ask_user" | "auto_reexec";
  message: string;
  command: string;
}

function defaultReadInstalledVersion(execPath: string): string | null {
  try {
    const proc = Bun.spawnSync([execPath, "--version"], { stdout: "pipe", stderr: "ignore" });
    if (!proc.success) return null;
    const out = new TextDecoder().decode(proc.stdout).trim();
    return /^\d+\.\d+\.\d+/.test(out) ? out.split(/\s+/)[0]! : null;
  } catch {
    return null;
  }
}

// 磁盘二进制比运行版新 → 返回新版本号，否则 null。
export function pendingUpgrade(deps: UpgradeDeps = {}): string | null {
  const running = deps.runningVersion ?? RUNNING_VERSION;
  const execPath = deps.execPath ?? process.execPath;
  const read = deps.readInstalledVersion ?? defaultReadInstalledVersion;
  // 只有 execPath 看起来是 party 二进制（basename 含 party）才比——dev 下 execPath=bun，跳过。
  const base = execPath.split("/").pop() ?? "";
  if (!base.includes("party")) return null;
  const installed = read(execPath);
  if (!installed) return null;
  return compareVersions(installed, running) > 0 ? installed : null;
}

export function upgradeNotice(auto: boolean, deps: UpgradeDeps = {}): CliUpgradeNotice | null {
  const installed = pendingUpgrade(deps);
  if (!installed) return null;
  const running = deps.runningVersion ?? RUNNING_VERSION;
  const action = auto ? "auto_reexec" : "ask_user";
  return {
    running_version: running,
    installed_version: installed,
    available_version: installed,
    auto_upgrade: auto,
    action_required: action,
    message: auto
      ? `检测到 party CLI 已有新版本 v${installed}（当前运行 v${running}）。本轮唤醒结束后 serve 会自动 re-exec 新版。`
      : `检测到 party CLI 已有新版本 v${installed}（当前运行 v${running}）。继续任务前先询问用户是否升级；用户同意后再让用户运行升级命令并重启 serve。`,
    command: INSTALL_LINE,
  };
}

/**
 * 服务器 /api/version 已经跑在更新的正式版本时，提醒旧 CLI 的 agent 联系 owner 升级（#485）。
 * `dev` / commit hash / 非 SemVer 一律忽略，避免预览部署误导稳定版用户。
 */
export function serverVersionUpgradeNotice(
  serverVersion: string,
  deps: { runningVersion?: string } = {},
): CliUpgradeNotice | null {
  // 只接受正式版和 build metadata；prerelease 的优先级低于同号正式版，不能当成已发布。
  const match = serverVersion.trim().match(/^v?(\d+\.\d+\.\d+)(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const available = match[1]!;
  const running = deps.runningVersion ?? RUNNING_VERSION;
  if (compareVersions(available, running) <= 0) return null;
  return {
    running_version: running,
    available_version: available,
    auto_upgrade: false,
    action_required: "ask_user",
    message: `AgentParty 服务器已发布 party CLI v${available}，当前 agent 仍在使用 v${running}。请用 party send 在本频道主动提醒 owner 升级，然后结束本轮、继续监听；owner 同意后运行升级命令并重启 serve。`,
    command: INSTALL_LINE,
  };
}

// 服务端声明的最低客户端版本（#137）高于本机运行版本时的升级提示——与磁盘自升级（cli_upgrade）
// 互补：cli_upgrade 是「磁盘已有新版、re-exec 即可」，这条是「服务端要求更高、需真正去装新版」。
// 形状对齐 CliUpgradeNotice（action_required=ask_user + command），runner 复用同一条询问用户的处理流。
export interface ServerMinVersionNotice {
  running_version: string;
  min_client_version: string;
  enforced: boolean;
  action_required: "ask_user";
  message: string;
  command: string;
}

export function serverMinVersionNotice(
  minClientVersion: string,
  enforced: boolean,
  deps: { runningVersion?: string } = {},
): ServerMinVersionNotice | null {
  const running = deps.runningVersion ?? RUNNING_VERSION;
  if (compareVersions(running, minClientVersion) >= 0) return null;
  return {
    running_version: running,
    min_client_version: minClientVersion,
    enforced,
    action_required: "ask_user",
    message: enforced
      ? `服务端要求 party CLI 最低 v${minClientVersion}，当前 v${running} 已被拒绝。请先运行升级命令再继续。`
      : `服务端声明 party CLI 最低支持版本 v${minClientVersion}，当前 v${running} 偏旧（协议可能有破坏性变更）。继续任务前先询问用户是否升级。`,
    command: INSTALL_LINE,
  };
}

// re-exec 磁盘上的新二进制：spawn 同 argv、继承 stdio、detach，然后让调用方退出。
// PID 会变——launchctl KeepAlive 天然重启；nohup 场景新进程接管（旧进程退出）。
function defaultReexec(execPath: string, argv: string[]): void {
  Bun.spawn([execPath, ...argv], { stdio: ["inherit", "inherit", "inherit"] }).unref();
}

// serve 在唤醒间隙调用：有新版且 auto=true 就 re-exec 并返回 true（调用方应停循环退出）。
export function maybeReexecUpgrade(auto: boolean, deps: UpgradeDeps = {}): { pending: string | null; reexeced: boolean } {
  const pending = pendingUpgrade(deps);
  if (!pending) return { pending: null, reexeced: false };
  if (!auto) return { pending, reexeced: false };
  const execPath = deps.execPath ?? process.execPath;
  const argv = process.argv.slice(2);
  (deps.reexec ?? defaultReexec)(execPath, argv);
  return { pending, reexeced: true };
}
