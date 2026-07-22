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
        entries.push(DutyEntry {
            label: label.to_string(),
            instance_id,
            plist_path: item.path().to_string_lossy().into_owned(),
            log_path: duty_log_path(&home, label).to_string_lossy().into_owned(),
            #[cfg(target_os = "macos")]
            loaded: duty_loaded(label),
            #[cfg(not(target_os = "macos"))]
            loaded: false,
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

    // 同一实例不允许 app 内 child 与 launchd 常驻双跑（同身份两个 serve 会互抢租约）：
    // 先停掉 app 内的同键实例。停不掉（kill 失败/超时后仍活跃）必须中止，不能带病装常驻。
    agent_state.stop_instance_for_duty(&instance_id).await?;

    let party_bin = ensure_duty_binary(&home)?;
    let log_path = duty_log_path(&home, &label);
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("cannot create duty log dir: {error}"))?;
    }
    let plist = duty_plist_content(&DutyPlistSpec {
        label: &label,
        party_bin: &party_bin.to_string_lossy(),
        config_path: &config_path.to_string_lossy(),
        channel,
        runner,
        workdir,
        repo,
        log_path: &log_path.to_string_lossy(),
    });
    let plist_path = duty_plist_path(&home, &label);
    if let Some(parent) = plist_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("cannot create LaunchAgents dir: {error}"))?;
    }
    let tmp = plist_path.with_extension("plist.tmp");
    fs::write(&tmp, plist).map_err(|error| format!("cannot write duty plist: {error}"))?;
    fs::rename(&tmp, &plist_path).map_err(|error| format!("cannot install duty plist: {error}"))?;

    // 已加载的旧实例先卸再装（幂等重装）；bootout 对未加载的 label 报错，忽略。
    let domain = gui_domain();
    let _ = launchctl(&["bootout", &format!("{domain}/{label}")]);
    let boot = launchctl(&["bootstrap", &domain, &plist_path.to_string_lossy()])?;
    if !boot.status.success() {
        let detail = String::from_utf8_lossy(&boot.stderr);
        return Err(format!(
            "launchctl bootstrap failed: {}",
            detail.trim().chars().take(200).collect::<String>()
        ));
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
        return Err("launchctl bootstrap reported success but the duty job is not loaded".to_string());
    }
    Ok(DutyEntry {
        label: label.clone(),
        instance_id,
        plist_path: plist_path.to_string_lossy().into_owned(),
        log_path: log_path.to_string_lossy().into_owned(),
        loaded: true,
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
        // launchd 面同样要可回滚：记录 persist 之前该 label 的 plist 原状（不存在 / 原内容）。
        let label = duty_label(&format!("{config_id}:{channel}"));
        let plist_path = duty_plist_path(&home, &label);
        let old_plist = match fs::read(&plist_path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(restore(format!("cannot back up the existing duty plist: {error}"))),
        };
        match duty_persist_inner(&app, &agent_state, &config_id, &channel, &runner, workdir.as_deref(), None).await {
            Ok(entry) => Ok(entry),
            Err(error) => {
                // 卸掉可能已装上的新任务，plist 恢复原状（原有旧值守则连内容带加载态一起还原）。
                let domain = gui_domain();
                let _ = launchctl(&["bootout", &format!("{domain}/{label}")]);
                match &old_plist {
                    Some(bytes) => {
                        let plist_restored = fs::write(&plist_path, bytes).is_ok();
                        if plist_restored {
                            let _ = launchctl(&["bootstrap", &domain, &plist_path.to_string_lossy()]);
                        }
                    }
                    None => {
                        let _ = fs::remove_file(&plist_path);
                    }
                }
                Err(restore(error))
            }
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
    let home = home_dir()?;
    let path = duty_log_path(&home, &label);
    let cap = max_bytes.unwrap_or(64 * 1024).min(1024 * 1024);
    match fs::read(&path) {
        Ok(bytes) => Ok(tail_utf8(&bytes, cap)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("cannot read duty log: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{duty_label, duty_plist_content, instance_id_from_label, tail_utf8, DutyPlistSpec};

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
        });
        assert!(plist.contains("a&amp;b"));
        assert!(plist.contains("&lt;duty&gt;"));
        assert!(!plist.contains("ap_"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<string>--auto-upgrade</string>"));
        assert!(plist.contains("<key>AGENTPARTY_CONFIG</key>"));
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
        });
        assert!(plist.contains("<string>--workdir</string>"));
        assert!(plist.contains("<string>/srv/duty</string>"));
        assert!(plist.contains("<string>--repo</string>"));
        assert!(plist.contains("<string>https://github.com/org/repo.git</string>"));
    }
}
