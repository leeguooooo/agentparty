// #616 第 3 块：系统级常驻值守（launchd）。
// 桌面 app 进程内的 serve child 随 app 退出而死，与「无人值守」自相矛盾；本模块把一个
// 值守实例落成 macOS LaunchAgent：RunAtLoad + KeepAlive，退出 app 不断线、重启机器自动拉起。
//
// 安全边界（#221 教训）：plist 里绝不放 token——只放 AGENTPARTY_CONFIG 的文件路径；
// 二进制拷贝到 ~/.agentparty/desktop/bin 的稳定路径（app bundle 路径随更新/挪动会失效），
// 并给 serve 挂 --auto-upgrade，让常驻进程在 wake 间隙自行换新。
use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

#[cfg(desktop)]
use tauri::{AppHandle, State};

use crate::agent::{validate_channel, validate_runner};

pub(crate) const DUTY_LABEL_PREFIX: &str = "com.agentparty.duty.";

/// launchd label 只收 [A-Za-z0-9.-]：instance_id 的 config_id 是 sha256 hex、channel 是 slug，
/// 唯一的越界字符是分隔用的冒号——映射成 '.'；其余越界字符一律 '-'（防御，不该出现）。
pub(crate) fn duty_label(instance_id: &str) -> String {
    let safe: String = instance_id
        .chars()
        .map(|value| match value {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' => value,
            ':' => '.',
            _ => '-',
        })
        .collect();
    format!("{DUTY_LABEL_PREFIX}{safe}")
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub(crate) struct DutyPlistSpec<'a> {
    pub(crate) label: &'a str,
    pub(crate) party_bin: &'a str,
    pub(crate) config_path: &'a str,
    pub(crate) channel: &'a str,
    pub(crate) runner: &'a str,
    pub(crate) workdir: Option<&'a str>,
    pub(crate) repo: Option<&'a str>,
    pub(crate) log_path: &'a str,
    /// launchd 起的进程 PATH 被精简成 /usr/bin:/bin:/usr/sbin:/sbin,找不到 codex/claude
    /// runner(#741 频道实测:serve 起来了但 runner not found → wake 全 abandon)。plist 必须显式设 PATH。
    pub(crate) path: &'a str,
    /// builtin runner 的绝对路径。PATH 只留给 runner 内部工具；启动 runner 本身不能再依赖 launchd
    /// 继承/拼装出来的 PATH（Finder、launchd、版本管理器的环境都可能不同）。
    pub(crate) runner_bin: Option<&'a str>,
}

/// 给 launchd 常驻的 serve 用的 PATH：已解析 runner 的父目录必须排第一；已解析 Node runtime
/// 的父目录紧随其后。runner 可能装在独立 npm prefix（如 ~/.npm-global/bin），而 Node 只存在
/// 于 nvm/fnm/asdf/mise/volta，因此不能假设 `#!/usr/bin/env node` 总能在 runner 同目录命中。
/// 再补 runner(codex/claude)常见安装目录 + adopt 时进程自身的 PATH + 系统默认兜底。
/// launchd 不展开 ~/$HOME,所以全用绝对路径;PATH 允许重复项,不必去重。
pub(crate) fn runner_launch_path(
    home: &Path,
    runner_bin: Option<&Path>,
    node_bin: Option<&Path>,
    inherited_path: Option<&std::ffi::OsStr>,
) -> String {
    let home = home.to_string_lossy();
    let mut parts = Vec::new();
    for executable in [runner_bin, node_bin].into_iter().flatten() {
        if !executable.is_absolute() || !executable_file(executable) {
            continue;
        }
        let Some(parent) = executable.parent().filter(|parent| parent.is_absolute()) else {
            continue;
        };
        let parent = parent.to_string_lossy().into_owned();
        if !parts.contains(&parent) {
            parts.push(parent);
        }
    }
    parts.extend([
        format!("{home}/.local/bin"),
        format!("{home}/.npm-global/bin"), // `npm config set prefix ~/.npm-global` 的 codex/claude 装这
        format!("{home}/.bun/bin"),
        format!("{home}/.deno/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ]);
    if let Some(inherited) = inherited_path {
        let inherited = inherited.to_string_lossy();
        if !inherited.is_empty() {
            parts.push(inherited.into_owned());
        }
    }
    parts.push("/usr/bin:/bin:/usr/sbin:/sbin".to_string());
    parts.join(":")
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

/// nvm/fnm 把全局 npm binary 放在版本目录里，不会生成固定 shim。只枚举一层版本目录，
/// 按路径倒序保证选择稳定（通常也会先命中新版本），不启动交互 shell、不读取 shell rc。
fn append_versioned_bin_dirs(paths: &mut Vec<PathBuf>, root: &Path, suffix: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut versions: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path().join(suffix))
        .filter(|path| path.is_dir())
        .collect();
    versions.sort();
    versions.reverse();
    for path in versions {
        push_unique_path(paths, path);
    }
}

fn runner_search_dirs(home: &Path, inherited_path: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for path in [
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
        home.join(".deno/bin"),
        home.join(".volta/bin"),
        home.join(".asdf/shims"),
        home.join(".local/share/mise/shims"),
        home.join(".local/share/pnpm"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ] {
        push_unique_path(&mut paths, path);
    }
    append_versioned_bin_dirs(&mut paths, &home.join(".nvm/versions/node"), Path::new("bin"));
    append_versioned_bin_dirs(
        &mut paths,
        &home.join(".local/share/fnm/node-versions"),
        Path::new("installation/bin"),
    );
    append_versioned_bin_dirs(
        &mut paths,
        &home.join(".fnm/node-versions"),
        Path::new("installation/bin"),
    );
    if let Some(path) = inherited_path {
        for entry in env::split_paths(path) {
            push_unique_path(&mut paths, entry);
        }
    }
    for path in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        push_unique_path(&mut paths, PathBuf::from(path));
    }
    paths
}

fn find_runner_executable(name: &str, search_dirs: &[PathBuf]) -> Option<PathBuf> {
    search_dirs
        .iter()
        .map(|dir| dir.join(name))
        .find(|path| path.is_absolute() && executable_file(path))
}

fn resolve_node_executable(
    home: &Path,
    inherited_path: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    let search_dirs = runner_search_dirs(home, inherited_path);
    find_runner_executable("node", &search_dirs)
}

fn runner_override_env(runner: &str) -> Option<&'static str> {
    match runner {
        "codex" => Some("AGENTPARTY_CODEX_BIN"),
        "claude" => Some("AGENTPARTY_CLAUDE_BIN"),
        _ => None,
    }
}

/// 把 runner 依赖在「写 plist 之前」解析成绝对可执行路径。codex-sdk 不需要外部 CLI。
/// 专用环境变量允许高级用户显式覆盖，但无效覆盖不能静默回退，否则 UI 显示成功后仍会在 wake 时失败。
fn resolve_runner_executable(runner: &str, home: &Path) -> Result<Option<PathBuf>, String> {
    if runner == "codex-sdk" {
        return Ok(None);
    }
    let Some(override_name) = runner_override_env(runner) else {
        return Err(format!("runner_dependency_unknown:{runner}"));
    };
    if let Some(value) = env::var_os(override_name) {
        let path = PathBuf::from(value);
        if path.is_absolute() && executable_file(&path) {
            return Ok(Some(path));
        }
        return Err(format!(
            "runner_dependency_missing:{runner}: {override_name} must point to an absolute executable file"
        ));
    }
    let search_dirs = runner_search_dirs(home, env::var_os("PATH").as_deref());
    find_runner_executable(runner, &search_dirs)
        .map(Some)
        .ok_or_else(|| {
            format!(
                "runner_dependency_missing:{runner}: {runner} CLI was not found; install it, then repair this resident duty"
            )
        })
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}

fn plist_strings(value: &str) -> Vec<String> {
    value
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("<string>")
                .and_then(|line| line.strip_suffix("</string>"))
                .map(xml_unescape)
        })
        .collect()
}

fn plist_value_for_key(value: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{}</key>", xml_escape(key));
    let rest = value.split_once(&marker)?.1;
    plist_strings(rest).into_iter().next()
}

#[derive(Debug, Default, PartialEq, Eq)]
struct DutyPlistMetadata {
    runner: Option<String>,
    workdir: Option<String>,
    repo: Option<String>,
    runner_bin: Option<String>,
}

fn duty_plist_metadata(value: &str) -> DutyPlistMetadata {
    let args = value
        .split_once("<key>ProgramArguments</key>")
        .and_then(|(_, rest)| rest.split_once("</array>").map(|(array, _)| plist_strings(array)))
        .unwrap_or_default();
    let argument = |flag: &str| {
        args.iter()
            .position(|value| value == flag)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    DutyPlistMetadata {
        runner: argument("--runner"),
        workdir: argument("--workdir"),
        repo: argument("--repo"),
        runner_bin: plist_value_for_key(value, "AGENTPARTY_RUNNER_BIN"),
    }
}

fn runner_dependency(
    runner: Option<&str>,
    stored_bin: Option<&str>,
    home: &Path,
) -> (&'static str, Option<String>) {
    let Some(runner) = runner else {
        return ("unknown", None);
    };
    if runner == "codex-sdk" {
        return ("not-required", None);
    }
    if !matches!(runner, "codex" | "claude") {
        return ("unknown", None);
    }
    if let Some(stored) = stored_bin {
        let path = PathBuf::from(stored);
        let state = if path.is_absolute() && executable_file(&path) {
            "ready"
        } else {
            "missing"
        };
        return (state, Some(stored.to_string()));
    }
    match resolve_runner_executable(runner, home) {
        Ok(Some(path)) => (
            // 旧 plist 即使当前能在 PATH 中找到 runner，仍需重写一次，消除下次登录/升级后的漂移。
            "repair-required",
            Some(path.to_string_lossy().into_owned()),
        ),
        _ => ("missing", None),
    }
}

/// 生成 LaunchAgent plist。token 绝不入内——只引用 config 文件路径。
pub(crate) fn duty_plist_content(spec: &DutyPlistSpec<'_>) -> String {
    let mut args: Vec<String> = vec![
        spec.party_bin.to_string(),
        "serve".to_string(),
        spec.channel.to_string(),
        "--runner".to_string(),
        spec.runner.to_string(),
        // 常驻进程没有 app 帮它换新二进制：wake 间隙发现磁盘上有更新的 party 就自我重启（#45 机制）。
        "--auto-upgrade".to_string(),
    ];
    if let Some(dir) = spec.workdir {
        args.push("--workdir".to_string());
        args.push(dir.to_string());
    }
    if let Some(url) = spec.repo {
        args.push("--repo".to_string());
        args.push(url.to_string());
    }
    let args_xml: String = args
        .iter()
        .map(|value| format!("    <string>{}</string>\n", xml_escape(value)))
        .collect();
    let runner_bin_xml = spec.runner_bin.map_or_else(String::new, |runner_bin| {
        format!(
            "    <key>AGENTPARTY_RUNNER_BIN</key>\n    <string>{}</string>\n",
            xml_escape(runner_bin)
        )
    });
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{args_xml}  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTPARTY_CONFIG</key>
    <string>{config}</string>
    <key>PATH</key>
    <string>{path}</string>
{runner_bin_xml}    <!-- #744:让 serve 知道自己这个 launchd job 的 label,熔断/token 撤销等终局退出时自卸载,不被 KeepAlive 重启 -->
    <key>AP_DUTY_LABEL</key>
    <string>{label}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        label = xml_escape(spec.label),
        args_xml = args_xml,
        config = xml_escape(spec.config_path),
        path = xml_escape(spec.path),
        runner_bin_xml = runner_bin_xml,
        log = xml_escape(spec.log_path),
    )
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "cannot locate the home directory".to_string())
}

pub(crate) fn duty_plist_path(home: &Path, label: &str) -> PathBuf {
    home.join("Library/LaunchAgents").join(format!("{label}.plist"))
}

pub(crate) fn duty_log_path(home: &Path, label: &str) -> PathBuf {
    home.join(".agentparty/desktop/logs").join(format!("{label}.log"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DutyPlistSnapshot {
    contents: Option<Vec<u8>>,
    loaded: bool,
}

fn replace_duty_plist_atomically(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create LaunchAgents dir: {error}"))?;
    }
    let tmp = path.with_extension("plist.tmp");
    fs::write(&tmp, contents).map_err(|error| format!("cannot stage duty plist: {error}"))?;
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot install duty plist: {error}"));
    }
    Ok(())
}

fn restore_duty_plist_file(
    path: &Path,
    snapshot: &DutyPlistSnapshot,
) -> Result<(), String> {
    match snapshot.contents.as_deref() {
        Some(contents) => replace_duty_plist_atomically(path, contents),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("cannot remove replacement duty plist: {error}")),
        },
    }
}

/// launchctl 本身不能在单测里安全运行；把回滚的文件状态机与 job 操作分开注入。
/// 返回值是要附在原始失败后的可读回滚结果，成功/失败都不能吞。
fn rollback_duty_install_with<Bootout, Bootstrap>(
    plist_path: &Path,
    snapshot: &DutyPlistSnapshot,
    mut bootout_current: Bootout,
    mut bootstrap_previous: Bootstrap,
) -> String
where
    Bootout: FnMut() -> Result<(), String>,
    Bootstrap: FnMut(&Path) -> Result<(), String>,
{
    let mut failures = Vec::new();
    if let Err(error) = bootout_current() {
        failures.push(format!("could not unload replacement job: {error}"));
    }

    let plist_restored = match restore_duty_plist_file(plist_path, snapshot) {
        Ok(()) => true,
        Err(error) => {
            failures.push(format!("could not restore previous plist: {error}"));
            false
        }
    };

    if snapshot.loaded {
        if snapshot.contents.is_none() {
            failures.push(
                "previous job was loaded but its plist did not exist, so it cannot be reloaded"
                    .to_string(),
            );
        } else if plist_restored {
            if let Err(error) = bootstrap_previous(plist_path) {
                failures.push(format!("could not reload previous job: {error}"));
            }
        }
    }

    if failures.is_empty() {
        if snapshot.loaded {
            "restored previous plist and reloaded previous job".to_string()
        } else if snapshot.contents.is_some() {
            "restored previous plist; previous job remains unloaded".to_string()
        } else {
            "removed replacement plist; no previous job was loaded".to_string()
        }
    } else {
        format!("incomplete: {}", failures.join("; "))
    }
}

/// 取日志尾部 cap 字节，并前移到 UTF-8 字符边界（不截断多字节字符）。#725：桌面看常驻日志。
fn tail_utf8(bytes: &[u8], cap: usize) -> String {
    let mut start = bytes.len().saturating_sub(cap);
    // 0b10xx_xxxx 是 UTF-8 续接字节；从这种字节起会切坏字符，往后挪到一个首字节。
    while start < bytes.len() && (bytes[start] & 0xC0) == 0x80 {
        start += 1;
    }
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

pub(crate) fn duty_bin_path(home: &Path) -> PathBuf {
    home.join(".agentparty/desktop/bin/party")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DutyEntry {
    pub(crate) label: String,
    pub(crate) instance_id: String,
    pub(crate) plist_path: String,
    pub(crate) log_path: String,
    pub(crate) loaded: bool,
    pub(crate) runner: Option<String>,
    pub(crate) workdir: Option<String>,
    pub(crate) repo: Option<String>,
    pub(crate) runner_executable: Option<String>,
    pub(crate) dependency_state: String,
}

/// 从 plist 文件名还原 instance_id 的展示形态：label 里 config_id 与 channel 以最后一个 '.' 相接。
/// （config_id 是 hex，不含 '.'；channel 是 slug，也不含 '.'——所以最后一个 '.' 就是原来的 ':'。）
pub(crate) fn instance_id_from_label(label: &str) -> Option<String> {
    let rest = label.strip_prefix(DUTY_LABEL_PREFIX)?;
    let (config, channel) = rest.rsplit_once('.')?;
    Some(format!("{config}:{channel}"))
}

#[cfg(all(desktop, target_os = "macos"))]
fn launchctl(args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("launchctl")
        .args(args)
        .output()
        .map_err(|error| format!("failed to run launchctl: {error}"))
}

#[cfg(all(desktop, target_os = "macos"))]
fn gui_domain() -> String {
    // launchctl 的 GUI 域按 uid 定位；桌面 app 恒跑在登录用户会话里。
    // 不引 libc：`id -u` 是 POSIX 标配，一次性调用开销可忽略。
    let uid = std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default();
    format!("gui/{uid}")
}

#[cfg(all(desktop, target_os = "macos"))]
fn duty_loaded(label: &str) -> bool {
    launchctl(&["print", &format!("{}/{label}", gui_domain())])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(all(desktop, target_os = "macos"))]
fn duty_loaded_checked(label: &str) -> Result<bool, String> {
    launchctl(&["print", &format!("{}/{label}", gui_domain())])
        .map(|output| output.status.success())
}

#[cfg(all(desktop, target_os = "macos"))]
fn launchctl_checked(args: &[&str], action: &str) -> Result<(), String> {
    let output = launchctl(args)?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim().chars().take(200).collect::<String>();
    if detail.is_empty() {
        Err(format!("{action} failed"))
    } else {
        Err(format!("{action} failed: {detail}"))
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn snapshot_duty_plist(path: &Path, label: &str) -> Result<DutyPlistSnapshot, String> {
    let contents = match fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("cannot back up the existing duty plist: {error}")),
    };
    let loaded = duty_loaded_checked(label)?;
    Ok(DutyPlistSnapshot { contents, loaded })
}

#[cfg(all(desktop, target_os = "macos"))]
fn rollback_duty_install(
    domain: &str,
    label: &str,
    plist_path: &Path,
    snapshot: &DutyPlistSnapshot,
) -> String {
    let result = rollback_duty_install_with(
        plist_path,
        snapshot,
        || {
            if !duty_loaded_checked(label)? {
                return Ok(());
            }
            launchctl_checked(
                &["bootout", &format!("{domain}/{label}")],
                "launchctl rollback bootout",
            )
        },
        |restored_path| {
            launchctl_checked(
                &["bootstrap", domain, &restored_path.to_string_lossy()],
                "launchctl rollback bootstrap",
            )
        },
    );
    if !snapshot.loaded || result.starts_with("incomplete:") {
        return result;
    }
    match duty_loaded_checked(label) {
        Ok(true) => result,
        Ok(false) => {
            "incomplete: previous plist was restored and bootstrap succeeded, but the previous job is not loaded"
                .to_string()
        }
        Err(error) => format!(
            "incomplete: previous plist was restored and bootstrap succeeded, but loaded-state verification failed: {error}"
        ),
    }
}

fn failure_with_rollback(original: String, rollback: String) -> String {
    format!("{original}; rollback: {rollback}")
}

/// 把当前 app 内嵌的 party sidecar 拷贝到稳定路径（bundle 路径随 app 更新/挪动失效）。
#[cfg(desktop)]
fn ensure_duty_binary(home: &Path) -> Result<PathBuf, String> {
    let target = duty_bin_path(home);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("cannot create duty bin dir: {error}"))?;
    }
    // externalBin sidecar 运行期就躺在主可执行文件旁（tauri externalBin 约定）。#696：
    // 别用 tauri 的 BaseDirectory::Executable —— 它映射到 dirs::executable_dir()（XDG $EXE 目录），
    // 在 macOS/Windows 上恒为 None → Err(UnknownPath)，正是「cannot resolve party sidecar path:
    // unknown path」的来源。current_exe() 才是「当前可执行文件」，跨平台都对。
    let exe = std::env::current_exe()
        .map_err(|error| format!("cannot resolve current executable: {error}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "current executable has no parent directory".to_string())?;
    let sidecar = exe_dir.join("party");
    let source = if sidecar.exists() {
        sidecar
    } else {
        // dev 模式（未打包）：可执行目录里是带 target triple 的名字
        let dir = sidecar.parent().map(Path::to_path_buf).unwrap_or_default();
        fs::read_dir(&dir)
            .ok()
            .and_then(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .find(|path| {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with("party"))
                    })
            })
            .ok_or_else(|| "party sidecar binary not found next to the app executable".to_string())?
    };
    // 先写临时名再原子 rename：正在运行的旧常驻进程继续持有旧 inode，不会被写坏。
    let tmp = target.with_extension("tmp");
    fs::copy(&source, &tmp).map_err(|error| format!("cannot stage duty binary: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755));
    }
    fs::rename(&tmp, &target).map_err(|error| format!("cannot install duty binary: {error}"))?;
    Ok(target)
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn desktop_duty_list() -> Result<Vec<DutyEntry>, String> {
    let home = home_dir()?;
    let agents_dir = home.join("Library/LaunchAgents");
    let mut entries = Vec::new();
    let Ok(dir) = fs::read_dir(&agents_dir) else {
        return Ok(entries);
    };
    for item in dir.flatten() {
        let name = item.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(label) = name.strip_suffix(".plist") else { continue };
        if !label.starts_with(DUTY_LABEL_PREFIX) {
            continue;
        }
        let Some(instance_id) = instance_id_from_label(label) else { continue };
        let metadata = fs::read_to_string(item.path())
            .ok()
            .map(|value| duty_plist_metadata(&value))
            .unwrap_or_default();
        let (dependency_state, runner_executable) = runner_dependency(
            metadata.runner.as_deref(),
            metadata.runner_bin.as_deref(),
            &home,
        );
        entries.push(DutyEntry {
            label: label.to_string(),
            instance_id,
            plist_path: item.path().to_string_lossy().into_owned(),
            log_path: duty_log_path(&home, label).to_string_lossy().into_owned(),
            #[cfg(target_os = "macos")]
            loaded: duty_loaded(label),
            #[cfg(not(target_os = "macos"))]
            loaded: false,
            runner: metadata.runner,
            workdir: metadata.workdir,
            repo: metadata.repo,
            runner_executable,
            dependency_state: dependency_state.to_string(),
        });
    }
    entries.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(entries)
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn desktop_duty_persist(
    app: AppHandle,
    agent_state: State<'_, crate::agent::AgentManager>,
    config_id: String,
    channel: String,
    runner: String,
    workdir: Option<String>,
    repo: Option<String>,
) -> Result<DutyEntry, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, agent_state, config_id, channel, runner, workdir, repo);
        return Err("system-level duty is currently macOS-only (launchd)".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        validate_channel(&channel)?;
        validate_runner(&runner)?;
        if let Some(dir) = workdir.as_deref() {
            crate::agent::validate_workdir(dir)?;
        }
        if let Some(url) = repo.as_deref() {
            crate::agent::validate_repo(url)?;
        }
        duty_persist_inner(
            &app,
            &agent_state,
            &config_id,
            &channel,
            &runner,
            workdir.as_deref(),
            repo.as_deref(),
        )
        .await
    }
}

/// persist 的共同内核：desktop_duty_persist（面板路径）与 desktop_duty_adopt（web 一键接管）
/// 共用——校验已由调用方完成。
#[cfg(all(desktop, target_os = "macos"))]
async fn duty_persist_inner(
    // #696：sidecar 定位改用 current_exe() 后这里不再需要 app。仍保留形参（下划线标未用）：两个
    // 调用命令是注入了 AppHandle 的 #[tauri::command]，继续把 &app 传进来即让命令层的 app 保持「已用」，
    // 免得彻底删参把 unused 警告冒到命令签名上（macOS 分支会因此 deny(warnings) 失败）。
    _app: &AppHandle,
    agent_state: &State<'_, crate::agent::AgentManager>,
    config_id: &str,
    channel: &str,
    runner: &str,
    workdir: Option<&str>,
    repo: Option<&str>,
) -> Result<DutyEntry, String> {
    let (config_path, _summary) = crate::agent::resolve_config(config_id)?;
    let home = home_dir()?;
    let instance_id = format!("{config_id}:{channel}");
    let label = duty_label(&instance_id);
    // 必须先验证依赖，再停止 app 内同键实例。缺 runner 时保留当前健康实例，不做破坏性切换。
    let inherited_path = env::var_os("PATH");
    let runner_bin = resolve_runner_executable(runner, &home)?;
    let node_bin = runner_bin
        .as_ref()
        .and_then(|_| resolve_node_executable(&home, inherited_path.as_deref()));
    let runner_bin_string = runner_bin
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    let plist_path = duty_plist_path(&home, &label);
    // Repair 必须先快照旧 plist 与 loaded 状态。之后任何 bootout/bootstrap/确认失败都用它恢复，
    // 不能让一次“修复”把原本还在工作的旧常驻变成离线。
    let previous = snapshot_duty_plist(&plist_path, &label)?;

    // 同一实例不允许 app 内 child 与 launchd 常驻双跑（同身份两个 serve 会互抢租约）：
    // 先停掉 app 内的同键实例。停不掉（kill 失败/超时后仍活跃）必须中止，不能带病装常驻。
    agent_state.stop_instance_for_duty(&instance_id).await?;

    let party_bin = ensure_duty_binary(&home)?;
    let log_path = duty_log_path(&home, &label);
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("cannot create duty log dir: {error}"))?;
    }
    // runner 与 Node 可能分处独立 npm prefix 和版本管理器目录；两者都必须进入 launchd
    // PATH，Finder 启动的 app 没有交互 shell PATH 可兜底。
    let launch_path = runner_launch_path(
        &home,
        runner_bin.as_deref(),
        node_bin.as_deref(),
        inherited_path.as_deref(),
    );
    let plist = duty_plist_content(&DutyPlistSpec {
        label: &label,
        party_bin: &party_bin.to_string_lossy(),
        config_path: &config_path.to_string_lossy(),
        channel,
        runner,
        workdir,
        repo,
        log_path: &log_path.to_string_lossy(),
        path: &launch_path,
        runner_bin: runner_bin_string.as_deref(),
    });
    replace_duty_plist_atomically(&plist_path, plist.as_bytes())?;

    // 已加载的旧实例先卸再装（幂等重装）。从覆盖 plist 开始，任何错误都必须走同一个回滚出口。
    let domain = gui_domain();
    let unload = duty_loaded_checked(&label).and_then(|loaded| {
        if loaded {
            launchctl_checked(
                &["bootout", &format!("{domain}/{label}")],
                "launchctl bootout",
            )
        } else {
            Ok(())
        }
    });
    if let Err(original) = unload {
        let rollback = rollback_duty_install(&domain, &label, &plist_path, &previous);
        return Err(failure_with_rollback(original, rollback));
    }
    if let Err(original) = launchctl_checked(
        &["bootstrap", &domain, &plist_path.to_string_lossy()],
        "launchctl bootstrap",
    ) {
        let rollback = rollback_duty_install(&domain, &label, &plist_path, &previous);
        return Err(failure_with_rollback(original, rollback));
    }
    // bootstrap 返回成功但任务未必立刻可见——短轮询确认；确认不了按失败报，
    // 绝不把 loaded=false 包装成成功让 UI 显示「已常驻」（CodeRabbit #621）。
    let mut loaded = false;
    for _ in 0..10 {
        if duty_loaded(&label) {
            loaded = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    if !loaded {
        let original =
            "launchctl bootstrap reported success but the duty job is not loaded".to_string();
        let rollback = rollback_duty_install(&domain, &label, &plist_path, &previous);
        return Err(failure_with_rollback(original, rollback));
    }
    Ok(DutyEntry {
        label: label.clone(),
        instance_id,
        plist_path: plist_path.to_string_lossy().into_owned(),
        log_path: log_path.to_string_lossy().into_owned(),
        loaded: true,
        runner: Some(runner.to_string()),
        workdir: workdir.map(str::to_string),
        repo: repo.map(str::to_string),
        runner_executable: runner_bin_string,
        dependency_state: if runner == "codex-sdk" {
            "not-required".to_string()
        } else {
            "ready".to_string()
        },
    })
}

/// #616 第 4 块：web「无人值守」流程在桌面 webview 内一键接管。
/// token 经 tauri IPC 本机直达（绝不进 URL / 剪贴板 / 终端），写成与 party init 同构的
/// 配置文件后走 persist 同一条链路。name 校验对齐 CLI 的 agent 名正则。
#[cfg(desktop)]
fn validate_adopt_inputs(server: &str, token: &str, name: &str) -> Result<(), String> {
    if !token.starts_with("ap_")
        || token.len() <= 3
        || token.len() > 256
        || token.chars().any(|value| value.is_whitespace() || value.is_control())
    {
        return Err("token must be a valid agent token".to_string());
    }
    let name_ok = name.len() <= 64
        && name.chars().next().is_some_and(|value| value.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-'));
    if !name_ok {
        return Err("name must match the agent name grammar".to_string());
    }
    if server.len() > 512 || server.chars().any(|value| value.is_whitespace() || value.is_control()) {
        return Err("server origin is invalid".to_string());
    }
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn desktop_duty_adopt(
    app: AppHandle,
    agent_state: State<'_, crate::agent::AgentManager>,
    server: String,
    token: String,
    name: String,
    channel: String,
    runner: String,
    workdir: Option<String>,
) -> Result<DutyEntry, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, agent_state, server, token, name, channel, runner, workdir);
        return Err("system-level duty is currently macOS-only (launchd)".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        validate_channel(&channel)?;
        validate_runner(&runner)?;
        validate_adopt_inputs(&server, &token, &name)?;
        if let Some(dir) = workdir.as_deref() {
            crate::agent::validate_workdir(dir)?;
        }
        let home = home_dir()?;
        // adopt 接下来会写含 token 的身份配置并准备 launchd 回滚；依赖缺失必须在任何落盘/bootout 前失败。
        resolve_runner_executable(&runner, &home)?;
        // 与 join pack 的 AGENTPARTY_CONFIG 约定同路径：CLI 与桌面端看见的是同一个身份文件。
        let config_dir = home.join(".agentparty/agents");
        fs::create_dir_all(&config_dir).map_err(|error| format!("cannot create agents dir: {error}"))?;
        let config_path = config_dir.join(format!("agentparty-{name}-{channel}.json"));
        let config = serde_json::json!({
            "server": server,
            "token": token,
            "identity": {
                "name": name,
                "email": null,
                "kind": "agent",
                "role": "agent",
                "owner": null,
                "channel_scope": channel,
                "verified_at": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_millis() as u64)
                    .unwrap_or(0),
            },
        });
        // tmp 从创建那一刻就是 0600（create_new + mode）——敏感内容一个瞬间也不以宽权限存在；
        // 任何失败都清掉 tmp（CodeRabbit #621）。
        let tmp = config_path.with_extension("json.tmp");
        let body = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
        {
            use std::io::Write;
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&tmp)
                .map_err(|error| format!("cannot create agent config tmp: {error}"))?;
            if let Err(error) = file.write_all(&body) {
                drop(file);
                let _ = fs::remove_file(&tmp);
                return Err(format!("cannot write agent config: {error}"));
            }
        }
        // 先验 tmp 再替换：坏内容绝不覆盖同名旧配置（CodeRabbit #621）。
        if let Err(error) = crate::agent::parse_config_summary(&tmp) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("adopted config failed validation: {error}"));
        }
        // rename 会覆盖同名旧配置：先留备份。备份读取失败 ≠ 无旧文件——读不出来就中止，
        // 绝不冒着丢原配置的风险继续（CodeRabbit #621 复审）。
        let backup = match fs::read(&config_path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("cannot back up the existing agent config: {error}"));
            }
        };
        if let Err(error) = fs::rename(&tmp, &config_path) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("cannot install agent config: {error}"));
        }
        // 恢复失败必须传播——静默吞掉等于用户在不知情下丢了原身份文件。
        let restore = |reason: String| -> String {
            let outcome: Result<(), std::io::Error> = match &backup {
                Some(bytes) => fs::write(&config_path, bytes).map(|()| {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = fs::set_permissions(&config_path, fs::Permissions::from_mode(0o600));
                    }
                }),
                None => match fs::remove_file(&config_path) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
                    _ => Ok(()),
                },
            };
            match outcome {
                Ok(()) => reason,
                Err(error) => format!("{reason}; ALSO failed to restore the previous agent config: {error}"),
            }
        };
        let config_id = match crate::agent::config_id(&config_path) {
            Ok(value) => value,
            Err(error) => return Err(restore(error)),
        };
        // duty_persist_inner 自己原子快照/恢复 launchd plist 与 loaded 状态；adopt 这里只负责
        // 身份配置回滚，避免内层已恢复旧 job 后外层再次 bootout 的“双回滚”。
        match duty_persist_inner(&app, &agent_state, &config_id, &channel, &runner, workdir.as_deref(), None).await {
            Ok(entry) => Ok(entry),
            Err(error) => Err(restore(error)),
        }
    }
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn desktop_duty_unpersist(instance_id: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = instance_id;
        Err("system-level duty is currently macOS-only (launchd)".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let home = home_dir()?;
        let label = duty_label(&instance_id);
        let plist_path = duty_plist_path(&home, &label);
        // 先 bootout 再删 plist：顺序反了会留一个「加载中但文件已没了」的孤儿任务。
        let _ = launchctl(&["bootout", &format!("{}/{label}", gui_domain())]);
        if plist_path.exists() {
            fs::remove_file(&plist_path).map_err(|error| format!("cannot remove duty plist: {error}"))?;
        }
        Ok(())
    }
}

/// 读某个常驻实例的 launchd 日志尾部（#725：桌面排查常驻 agent）。
/// 只按 label 派生路径、且 label 必须是我们生成的前缀——杜绝任意路径读取。日志不存在时返回空串。
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn desktop_duty_log_read(label: String, max_bytes: Option<usize>) -> Result<String, String> {
    if !label.starts_with(DUTY_LABEL_PREFIX) {
        return Err("not a duty label".to_string());
    }
    // label 只允许 launchd 合法字符（生成时已限定）——再挡一次 '/' 与 '..' 目录穿越。
    if label.contains('/') || label.contains("..") {
        return Err("invalid duty label".to_string());
    }
    use std::io::{Read as _, Seek as _};
    let home = home_dir()?;
    let path = duty_log_path(&home, &label);
    let cap = (max_bytes.unwrap_or(64 * 1024).min(1024 * 1024)) as u64;
    // 只读尾部 cap 字节:launchd 日志无轮转、可能很大,seek 到末尾前 cap 处再读,别整文件进内存。
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("cannot open duty log: {error}")),
    };
    let len = file
        .metadata()
        .map_err(|error| format!("cannot stat duty log: {error}"))?
        .len();
    if len > cap {
        file.seek(std::io::SeekFrom::Start(len - cap))
            .map_err(|error| format!("cannot seek duty log: {error}"))?;
    }
    let mut buf = Vec::new();
    // take(cap):serve 正在往日志追加,seek 后到 EOF 可能已超过 cap——硬性封顶到 cap 字节。
    file.take(cap)
        .read_to_end(&mut buf)
        .map_err(|error| format!("cannot read duty log: {error}"))?;
    // seek 可能切在多字节字符中间——tail_utf8 前移到字符边界。
    Ok(tail_utf8(&buf, buf.len()))
}

#[cfg(test)]
mod tests {
    use super::{
        duty_label, duty_plist_content, duty_plist_metadata, failure_with_rollback,
        find_runner_executable, instance_id_from_label, rollback_duty_install_with,
        resolve_node_executable, runner_launch_path, runner_search_dirs, tail_utf8,
        DutyPlistMetadata, DutyPlistSnapshot, DutyPlistSpec,
    };

    #[test]
    fn tail_utf8_keeps_char_boundary_and_caps_length() {
        // 多字节内容:每个「日/志」是 3 字节。cap 落在字符中间时应前移到边界,不产生替换符。
        let full = "abc日志日志".to_string();
        let bytes = full.as_bytes();
        let tail = tail_utf8(bytes, 5); // 落在某个多字节字符中间
        assert!(!tail.contains('\u{FFFD}'), "tail must not split a multibyte char: {tail:?}");
        assert!(full.ends_with(&tail));
        assert_eq!(tail_utf8(bytes, 9999), full); // cap 超长 → 原样
        assert_eq!(tail_utf8(b"", 10), ""); // 空输入
    }

    #[test]
    fn label_maps_colon_to_dot_and_round_trips() {
        let label = duty_label("abc123:native-r4");
        assert_eq!(label, "com.agentparty.duty.abc123.native-r4");
        assert_eq!(instance_id_from_label(&label).as_deref(), Some("abc123:native-r4"));
        assert_eq!(instance_id_from_label("com.other.thing"), None);
    }

    #[test]
    fn plist_never_contains_tokens_and_escapes_xml() {
        let plist = duty_plist_content(&DutyPlistSpec {
            label: "com.agentparty.duty.x.dev",
            party_bin: "/Users/leo/.agentparty/desktop/bin/party",
            config_path: "/Users/leo/.agentparty/agents/agentparty-a&b-dev.json",
            channel: "dev",
            runner: "claude",
            workdir: Some("/srv/<duty>"),
            repo: None,
            log_path: "/Users/leo/.agentparty/desktop/logs/x.log",
            path: "/Users/leo/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
            runner_bin: Some("/Users/leo/.local/bin/claude"),
        });
        assert!(plist.contains("a&amp;b"));
        assert!(plist.contains("&lt;duty&gt;"));
        assert!(!plist.contains("ap_"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<string>--auto-upgrade</string>"));
        assert!(plist.contains("<key>AGENTPARTY_CONFIG</key>"));
        // #741:PATH 必须进 EnvironmentVariables,否则 launchd 精简 PATH 找不到 codex/claude runner。
        assert!(plist.contains("<key>PATH</key>"));
        assert!(plist.contains(
            "<key>AGENTPARTY_RUNNER_BIN</key>\n    <string>/Users/leo/.local/bin/claude</string>"
        ));
        // #744:AP_DUTY_LABEL 的值必须紧跟其 key(不能只是碰巧 label 在别处出现,#745 CodeRabbit)。
        assert!(plist.contains("<key>AP_DUTY_LABEL</key>\n    <string>com.agentparty.duty.x.dev</string>"));
        assert!(plist.contains("/Users/leo/.local/bin"));
        // --repo 未指定时绝不出现
        assert!(!plist.contains("--repo"));
    }

    #[test]
    fn plist_includes_workdir_and_repo_when_given() {
        let plist = duty_plist_content(&DutyPlistSpec {
            label: "l",
            party_bin: "/bin/party",
            config_path: "/cfg.json",
            channel: "dev",
            runner: "codex",
            workdir: Some("/srv/duty"),
            repo: Some("https://github.com/org/repo.git"),
            log_path: "/log",
            path: "/x/bin:/usr/bin:/bin",
            runner_bin: Some("/x/bin/codex"),
        });
        assert!(plist.contains("<string>--workdir</string>"));
        assert!(plist.contains("<string>/srv/duty</string>"));
        assert!(plist.contains("<string>--repo</string>"));
        assert!(plist.contains("<string>https://github.com/org/repo.git</string>"));
        assert_eq!(
            duty_plist_metadata(&plist),
            DutyPlistMetadata {
                runner: Some("codex".to_string()),
                workdir: Some("/srv/duty".to_string()),
                repo: Some("https://github.com/org/repo.git".to_string()),
                runner_bin: Some("/x/bin/codex".to_string()),
            }
        );
    }

    #[test]
    fn plist_omits_runner_binary_for_codex_sdk() {
        let plist = duty_plist_content(&DutyPlistSpec {
            label: "l",
            party_bin: "/bin/party",
            config_path: "/cfg.json",
            channel: "dev",
            runner: "codex-sdk",
            workdir: None,
            repo: None,
            log_path: "/log",
            path: "/usr/bin:/bin",
            runner_bin: None,
        });
        assert!(!plist.contains("AGENTPARTY_RUNNER_BIN"));
        assert_eq!(duty_plist_metadata(&plist).runner.as_deref(), Some("codex-sdk"));
    }

    #[test]
    fn runner_lookup_requires_an_absolute_executable_file() {
        use std::fs;
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("tempdir");
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        fs::create_dir_all(&first).expect("first dir");
        fs::create_dir_all(&second).expect("second dir");
        fs::write(first.join("codex"), b"not executable").expect("first candidate");
        let executable = second.join("codex");
        fs::write(&executable, b"#!/bin/sh\n").expect("second candidate");
        #[cfg(unix)]
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).expect("chmod");

        assert_eq!(
            find_runner_executable("codex", &[first, second]),
            Some(executable)
        );
        assert_eq!(find_runner_executable("claude", &[temp.path().to_path_buf()]), None);
    }

    #[test]
    fn runner_launch_path_has_common_runner_dirs_and_system_defaults() {
        // #741:launchd serve 的 PATH 必须含 codex/claude 常见安装位置,否则 runner not found。
        let path = runner_launch_path(std::path::Path::new("/Users/leo"), None, None, None);
        assert!(path.contains("/Users/leo/.local/bin"), "缺 ~/.local/bin(install.sh 默认): {path}");
        assert!(path.contains("/Users/leo/.npm-global/bin"), "缺 ~/.npm-global/bin(npm global): {path}");
        assert!(path.contains("/opt/homebrew/bin"), "缺 homebrew: {path}");
        assert!(path.contains("/usr/local/bin"), "缺 /usr/local/bin(npm 默认): {path}");
        assert!(path.contains("/usr/bin:/bin:/usr/sbin:/sbin"), "缺系统默认兜底: {path}");
    }

    #[test]
    fn runner_launch_path_prepends_resolved_version_manager_bin() {
        use std::fs;
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("tempdir");
        let bin = temp.path().join(".nvm/versions/node/v22.18.0/bin");
        fs::create_dir_all(&bin).expect("version bin");
        let runner = bin.join("codex");
        fs::write(&runner, b"#!/usr/bin/env node\n").expect("runner");
        #[cfg(unix)]
        fs::set_permissions(&runner, fs::Permissions::from_mode(0o755)).expect("chmod runner");

        let path = runner_launch_path(temp.path(), Some(&runner), None, None);
        assert!(
            path.starts_with(&format!("{}:", bin.to_string_lossy())),
            "runner sibling node must win PATH lookup: {path}"
        );
    }

    #[test]
    fn separated_npm_prefix_and_version_manager_node_reach_finder_launch_path() {
        use std::{ffi::OsStr, fs};
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("tempdir");
        let runner_dir = temp.path().join(".npm-global/bin");
        let invalid_node_dir = temp.path().join(".local/bin");
        let node_dir = temp.path().join(".volta/bin");
        fs::create_dir_all(&runner_dir).expect("runner dir");
        fs::create_dir_all(&invalid_node_dir).expect("invalid node dir");
        fs::create_dir_all(&node_dir).expect("node dir");

        let runner = runner_dir.join("codex");
        fs::write(&runner, b"#!/usr/bin/env node\n").expect("runner");
        let invalid_node = invalid_node_dir.join("node");
        fs::write(&invalid_node, b"not executable").expect("invalid node");
        let node = node_dir.join("node");
        fs::write(&node, b"#!/bin/sh\n").expect("node");
        #[cfg(unix)]
        {
            fs::set_permissions(&runner, fs::Permissions::from_mode(0o755))
                .expect("chmod runner");
            fs::set_permissions(&node, fs::Permissions::from_mode(0o755))
                .expect("chmod node");
        }

        let finder_path = OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin");
        let search_dirs = runner_search_dirs(temp.path(), Some(finder_path));
        let resolved_runner =
            find_runner_executable("codex", &search_dirs).expect("global-prefix runner");
        let resolved_node =
            resolve_node_executable(temp.path(), Some(finder_path)).expect("version-manager node");
        assert_eq!(resolved_runner, runner);
        assert_eq!(resolved_node, node, "non-executable earlier candidate must be ignored");

        let path = runner_launch_path(
            temp.path(),
            Some(&resolved_runner),
            Some(&resolved_node),
            Some(finder_path),
        );
        let parts: Vec<&str> = path.split(':').collect();
        assert_eq!(parts[0], runner_dir.to_string_lossy());
        assert_eq!(parts[1], node_dir.to_string_lossy());
        assert!(parts.ends_with(&["/usr/bin", "/bin", "/usr/sbin", "/sbin"]));
    }

    #[test]
    fn rollback_atomically_restores_previous_plist_and_loaded_job() {
        use std::{cell::Cell, fs};

        let temp = tempfile::tempdir().expect("tempdir");
        let plist = temp.path().join("duty.plist");
        fs::write(&plist, b"replacement").expect("replacement plist");
        let snapshot = DutyPlistSnapshot {
            contents: Some(b"previous".to_vec()),
            loaded: true,
        };
        let bootout_called = Cell::new(false);
        let bootstrap_called = Cell::new(false);

        let result = rollback_duty_install_with(
            &plist,
            &snapshot,
            || {
                bootout_called.set(true);
                Ok(())
            },
            |path| {
                bootstrap_called.set(true);
                assert_eq!(path, plist);
                Ok(())
            },
        );

        assert_eq!(result, "restored previous plist and reloaded previous job");
        assert_eq!(fs::read(&plist).expect("restored plist"), b"previous");
        assert!(bootout_called.get());
        assert!(bootstrap_called.get());
        assert!(!plist.with_extension("plist.tmp").exists());
    }

    #[test]
    fn rollback_error_preserves_original_failure_and_reload_result() {
        use std::fs;

        let temp = tempfile::tempdir().expect("tempdir");
        let plist = temp.path().join("duty.plist");
        fs::write(&plist, b"replacement").expect("replacement plist");
        let snapshot = DutyPlistSnapshot {
            contents: Some(b"previous".to_vec()),
            loaded: true,
        };
        let rollback = rollback_duty_install_with(
            &plist,
            &snapshot,
            || Ok(()),
            |_| Err("launchctl rollback bootstrap failed: denied".to_string()),
        );
        let error = failure_with_rollback(
            "launchctl bootstrap failed: malformed replacement".to_string(),
            rollback,
        );

        assert!(error.starts_with("launchctl bootstrap failed: malformed replacement; rollback:"));
        assert!(error.contains("could not reload previous job"));
        assert!(error.contains("launchctl rollback bootstrap failed: denied"));
        assert_eq!(fs::read(&plist).expect("restored plist"), b"previous");
    }
}
