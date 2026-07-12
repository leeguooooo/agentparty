use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};

#[cfg(desktop)]
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod agent;
#[cfg(desktop)]
mod ui_download;
#[cfg(desktop)]
mod ui_protocol;
#[cfg(desktop)]
mod ui_storage;
pub mod ui_update;

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg(not(target_os = "macos"))]
const CREDENTIAL_SERVICE: &str = "com.agentparty.desktop";
const CREDENTIAL_ACCOUNT: &str = "desktop-session";
#[cfg(target_os = "macos")]
const MACOS_CREDENTIAL_SERVICE: &str = "com.agentparty.desktop.credentials.v2";
#[cfg(target_os = "macos")]
const KEYCHAIN_AUTHORIZATION_REQUIRED: &str = "desktop_keychain_authorization_required";
#[cfg(target_os = "macos")]
const KEYCHAIN_UNAVAILABLE: &str = "desktop_keychain_unavailable";
const UI_RELEASE_FLOOR_PUBLISHED_AT: i64 = 1_783_751_237;
const UPDATER_DIAGNOSTIC_FILE: &str = "updater-diagnostic.json";
static UPDATER_DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopReleaseInfo {
    distribution: &'static str,
    notarized: bool,
}

fn release_info_from_build(
    distribution: Option<&str>,
    notarized: Option<&str>,
) -> DesktopReleaseInfo {
    match (distribution, notarized) {
        (Some("production"), Some("true")) => DesktopReleaseInfo {
            distribution: "production",
            notarized: true,
        },
        (Some("preview"), Some("false")) => DesktopReleaseInfo {
            distribution: "preview",
            notarized: false,
        },
        _ => DesktopReleaseInfo {
            distribution: "development",
            notarized: false,
        },
    }
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_release_info() -> DesktopReleaseInfo {
    release_info_from_build(
        option_env!("AGENTPARTY_DESKTOP_DISTRIBUTION"),
        option_env!("AGENTPARTY_DESKTOP_NOTARIZED"),
    )
}

#[cfg(all(desktop, windows))]
const UI_PROTOCOL_URL: &str = "http://agentparty-ui.localhost/";
#[cfg(all(desktop, not(windows)))]
const UI_PROTOCOL_URL: &str = "agentparty-ui://localhost/";
#[cfg(all(desktop, windows))]
const BUNDLED_UI_URL: &str = "http://tauri.localhost/";
#[cfg(all(desktop, not(windows)))]
const BUNDLED_UI_URL: &str = "tauri://localhost/";
#[cfg(desktop)]
const UI_READY_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(desktop)]
const UI_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum UpdaterDiagnosticStatus {
    Attempt,
    Success,
    Failure,
    Pending,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum UpdaterDiagnosticSource {
    Auto,
    Manual,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum UpdaterDiagnosticStage {
    Check,
    Install,
    Relaunch,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum UpdaterDiagnosticCategory {
    Offline,
    Timeout,
    Verification,
    Install,
    Relaunch,
    Generic,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdaterDiagnostic {
    status: UpdaterDiagnosticStatus,
    source: Option<UpdaterDiagnosticSource>,
    stage: UpdaterDiagnosticStage,
    category: Option<UpdaterDiagnosticCategory>,
    timestamp: u64,
    app_version: Option<String>,
    target_version: Option<String>,
}

fn valid_diagnostic_version(version: &str) -> bool {
    version.len() <= 64
        && regex::Regex::new(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
            .expect("valid updater version pattern")
            .is_match(version)
}

fn validate_updater_diagnostic(diagnostic: &UpdaterDiagnostic) -> Result<(), String> {
    if diagnostic.timestamp == 0 {
        return Err("updater diagnostic timestamp is invalid".to_string());
    }
    for version in [
        diagnostic.app_version.as_deref(),
        diagnostic.target_version.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !valid_diagnostic_version(version) {
            return Err("updater diagnostic version is invalid".to_string());
        }
    }
    if diagnostic.target_version.is_some() && diagnostic.stage != UpdaterDiagnosticStage::Relaunch {
        return Err("updater diagnostic target version is invalid".to_string());
    }
    match diagnostic.stage {
        UpdaterDiagnosticStage::Check if diagnostic.source.is_none() => {
            return Err("updater check diagnostic source is required".to_string());
        }
        UpdaterDiagnosticStage::Install | UpdaterDiagnosticStage::Relaunch
            if diagnostic.source.is_some() =>
        {
            return Err("updater diagnostic source is invalid".to_string());
        }
        _ => {}
    }
    match diagnostic.status {
        UpdaterDiagnosticStatus::Failure if diagnostic.category.is_none() => {
            return Err("updater failure diagnostic category is required".to_string());
        }
        UpdaterDiagnosticStatus::Attempt
        | UpdaterDiagnosticStatus::Success
        | UpdaterDiagnosticStatus::Pending
            if diagnostic.category.is_some() =>
        {
            return Err("updater diagnostic category is invalid".to_string());
        }
        _ => {}
    }
    if diagnostic.status == UpdaterDiagnosticStatus::Pending
        && (diagnostic.stage != UpdaterDiagnosticStage::Relaunch
            || diagnostic.app_version.is_none()
            || diagnostic.target_version.is_none())
    {
        return Err("pending updater receipt is incomplete".to_string());
    }
    if diagnostic.status == UpdaterDiagnosticStatus::Success
        && diagnostic.stage == UpdaterDiagnosticStage::Relaunch
        && (diagnostic.app_version.is_none() || diagnostic.app_version != diagnostic.target_version)
    {
        return Err("completed updater receipt does not match its target".to_string());
    }
    Ok(())
}

fn write_updater_diagnostic(path: &Path, diagnostic: &UpdaterDiagnostic) -> Result<(), String> {
    validate_updater_diagnostic(diagnostic)?;
    let parent = path
        .parent()
        .ok_or_else(|| "updater diagnostic path is invalid".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "updater diagnostic directory is unavailable".to_string())?;
    let sequence = UPDATER_DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_extension(format!("json.{}.{sequence}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "updater diagnostic file is unavailable".to_string())?;
    let mut encoded = serde_json::to_vec(diagnostic)
        .map_err(|_| "updater diagnostic serialization failed".to_string())?;
    encoded.push(b'\n');
    let committed = file
        .write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "updater diagnostic write failed".to_string())
        .and_then(|_| {
            fs::rename(&temporary, path).map_err(|_| "updater diagnostic commit failed".to_string())
        });
    if let Err(error) = committed {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "updater diagnostic directory sync failed".to_string())?;
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDesktopCredential {
    refresh_token: String,
    device_secret: String,
    server_origin: String,
    session_id: Option<String>,
}

fn parse_stored_credential(input: &str) -> Result<StoredDesktopCredential, String> {
    let credential: StoredDesktopCredential = serde_json::from_str(input)
        .map_err(|_| "desktop credential has an invalid shape".to_string())?;
    if credential.refresh_token.is_empty() || credential.device_secret.is_empty() {
        return Err("desktop credential is incomplete".to_string());
    }
    let origin = url::Url::parse(&credential.server_origin)
        .map_err(|_| "desktop credential server is invalid".to_string())?;
    let local_http = origin.scheme() == "http"
        && origin.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
    if !matches!(origin.scheme(), "https" | "http")
        || (origin.scheme() == "http" && !local_http)
        || origin.host_str().is_none()
        || origin.username() != ""
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err("desktop credential server is invalid".to_string());
    }
    Ok(credential)
}

#[cfg(all(desktop, not(target_os = "macos")))]
fn credential_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, account)
        .map_err(|error| format!("secure credential store unavailable: {error}"))
}

fn credential_account_for_origin(origin: &str) -> Result<String, String> {
    let parsed =
        url::Url::parse(origin).map_err(|_| "desktop credential server is invalid".to_string())?;
    if parsed.origin().ascii_serialization() != origin {
        return Err("desktop credential server is not normalized".to_string());
    }
    let digest = Sha256::digest(origin.as_bytes());
    Ok(format!("desktop-session:{digest:x}"))
}

trait CredentialBackend {
    fn read(&self, account: &str) -> Result<Option<String>, String>;
    fn write(&self, account: &str, credential: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

#[cfg(desktop)]
struct NativeCredentialBackend;

#[cfg(all(desktop, target_os = "macos"))]
fn macos_password_options(
    service: &str,
    account: &str,
    allow_interaction: bool,
) -> security_framework::passwords::PasswordOptions {
    use core_foundation::{
        base::TCFType,
        string::{CFString, CFStringRef},
    };
    use security_framework_sys::item::kSecUseAuthenticationUI;

    unsafe extern "C" {
        static kSecUseAuthenticationUIFail: CFStringRef;
    }

    let mut options =
        security_framework::passwords::PasswordOptions::new_generic_password(service, account);
    if !allow_interaction {
        #[allow(deprecated)]
        options.query.push((
            unsafe { CFString::wrap_under_get_rule(kSecUseAuthenticationUI) },
            unsafe { CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail) }.into_CFType(),
        ));
    }
    options
}

#[cfg(all(desktop, target_os = "macos"))]
fn map_macos_keychain_error(error: security_framework::base::Error) -> String {
    match error.code() {
        -25_308 => KEYCHAIN_AUTHORIZATION_REQUIRED.to_string(),
        _ => KEYCHAIN_UNAVAILABLE.to_string(),
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn macos_keychain_read(
    service: &str,
    account: &str,
    allow_interaction: bool,
) -> Result<Option<String>, String> {
    match security_framework::passwords::generic_password(macos_password_options(
        service,
        account,
        allow_interaction,
    )) {
        Ok(value) => String::from_utf8(value)
            .map(Some)
            .map_err(|_| "secure credential has an invalid encoding".to_string()),
        Err(error) if error.code() == -25_300 => Ok(None),
        Err(error) => Err(map_macos_keychain_error(error)),
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn macos_keychain_write(
    service: &str,
    account: &str,
    value: &str,
    allow_interaction: bool,
) -> Result<(), String> {
    security_framework::passwords::set_generic_password_options(
        value.as_bytes(),
        macos_password_options(service, account, allow_interaction),
    )
    .map_err(map_macos_keychain_error)
}

#[cfg(all(desktop, target_os = "macos"))]
fn macos_keychain_delete(
    service: &str,
    account: &str,
    allow_interaction: bool,
) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password_options(macos_password_options(
        service,
        account,
        allow_interaction,
    )) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25_300 => Ok(()),
        Err(error) => Err(map_macos_keychain_error(error)),
    }
}

#[cfg(all(desktop, target_os = "macos"))]
impl CredentialBackend for NativeCredentialBackend {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        macos_keychain_read(MACOS_CREDENTIAL_SERVICE, account, false)
    }

    fn write(&self, account: &str, credential: &str) -> Result<(), String> {
        macos_keychain_write(MACOS_CREDENTIAL_SERVICE, account, credential, false)
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        macos_keychain_delete(MACOS_CREDENTIAL_SERVICE, account, false)
    }
}

#[cfg(all(desktop, not(target_os = "macos")))]
impl CredentialBackend for NativeCredentialBackend {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        match credential_entry(account)?.get_password() {
            Ok(credential) => Ok(Some(credential)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("secure credential read failed: {error}")),
        }
    }

    fn write(&self, account: &str, credential: &str) -> Result<(), String> {
        credential_entry(account)?
            .set_password(credential)
            .map_err(|error| format!("secure credential write failed: {error}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match credential_entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("secure credential delete failed: {error}")),
        }
    }
}

#[cfg(desktop)]
fn read_ui_high_water(store: &ui_update::UiUpdateStore) -> Result<i64, String> {
    // Activation advances this value before a pending UI can run. Do not mirror this
    // non-secret watermark into Keychain: ad-hoc preview builds get a new macOS code
    // identity on every shell update and would trigger a password prompt on each launch.
    let stored = store
        .load_metadata()
        .map_err(|_| "desktop UI state is invalid".to_string())?
        .highest_published_at
        .unwrap_or(UI_RELEASE_FLOOR_PUBLISHED_AT);
    if stored < UI_RELEASE_FLOOR_PUBLISHED_AT {
        return Err("desktop UI high-water mark is invalid".to_string());
    }
    Ok(stored)
}

fn migrate_legacy_credential<B: CredentialBackend>(backend: &B) -> Result<Option<String>, String> {
    let Some(raw) = backend.read(CREDENTIAL_ACCOUNT)? else {
        return Ok(None);
    };
    let credential = parse_stored_credential(&raw)?;
    let account = credential_account_for_origin(&credential.server_origin)?;
    if backend.read(&account)?.is_none() {
        backend.write(&account, &raw)?;
    }
    backend.delete(CREDENTIAL_ACCOUNT)?;
    Ok(Some(credential.server_origin))
}

#[cfg(desktop)]
fn write_desktop_credential_with_interaction(
    origin: String,
    credential: String,
    allow_interaction: bool,
) -> Result<(), String> {
    let parsed = parse_stored_credential(&credential)?;
    if parsed.server_origin != origin {
        return Err("desktop credential origin does not match its slot".to_string());
    }
    let account = credential_account_for_origin(&origin)?;
    #[cfg(target_os = "macos")]
    return macos_keychain_write(
        MACOS_CREDENTIAL_SERVICE,
        &account,
        &credential,
        allow_interaction,
    );
    #[cfg(not(target_os = "macos"))]
    NativeCredentialBackend.write(&account, &credential)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_write(origin: String, credential: String) -> Result<(), String> {
    write_desktop_credential_with_interaction(origin, credential, false)
}

#[cfg(desktop)]
#[tauri::command]
async fn desktop_credential_write_interactive(
    app: tauri::AppHandle,
    origin: String,
    credential: String,
) -> Result<(), String> {
    wait_for_main_window(app).await?;
    write_desktop_credential_with_interaction(origin, credential, true)
}

#[cfg(desktop)]
fn read_desktop_credential_with_interaction(
    origin: String,
    allow_interaction: bool,
) -> Result<Option<String>, String> {
    let account = credential_account_for_origin(&origin)?;
    #[cfg(target_os = "macos")]
    let credential = macos_keychain_read(MACOS_CREDENTIAL_SERVICE, &account, allow_interaction)?;
    #[cfg(not(target_os = "macos"))]
    let credential = NativeCredentialBackend.read(&account)?;
    if let Some(raw) = credential.as_deref() {
        let parsed = parse_stored_credential(raw)?;
        if parsed.server_origin != origin {
            return Err("desktop credential origin does not match its slot".to_string());
        }
    }
    Ok(credential)
}

#[cfg(desktop)]
fn read_desktop_credential(origin: String) -> Result<Option<String>, String> {
    read_desktop_credential_with_interaction(origin, false)
}

#[cfg(desktop)]
async fn wait_for_main_window(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<MainWindowGate>().wait_until_shown();
    })
    .await
    .map_err(|error| format!("desktop window wait failed: {error}"))
}

#[cfg(desktop)]
#[tauri::command]
async fn desktop_credential_read(
    app: tauri::AppHandle,
    origin: String,
) -> Result<Option<String>, String> {
    wait_for_main_window(app).await?;
    read_desktop_credential(origin)
}

#[cfg(desktop)]
#[tauri::command]
async fn desktop_credential_authorize(
    app: tauri::AppHandle,
    origin: String,
) -> Result<Option<String>, String> {
    wait_for_main_window(app).await?;
    read_desktop_credential_with_interaction(origin, true)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_delete(origin: String) -> Result<(), String> {
    let account = credential_account_for_origin(&origin)?;
    NativeCredentialBackend.delete(&account)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_delete_interactive(origin: String) -> Result<(), String> {
    let account = credential_account_for_origin(&origin)?;
    #[cfg(target_os = "macos")]
    return macos_keychain_delete(MACOS_CREDENTIAL_SERVICE, &account, true);
    #[cfg(not(target_os = "macos"))]
    NativeCredentialBackend.delete(&account)
}

#[cfg(desktop)]
#[tauri::command]
async fn desktop_credential_migrate(app: tauri::AppHandle) -> Result<Option<String>, String> {
    wait_for_main_window(app).await?;
    migrate_legacy_credential(&NativeCredentialBackend)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_updater_record_diagnostic(
    app: tauri::AppHandle,
    diagnostic: UpdaterDiagnostic,
) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "desktop app data directory is unavailable".to_string())?
        .join(UPDATER_DIAGNOSTIC_FILE);
    write_updater_diagnostic(&path, &diagnostic)
}

#[derive(Debug, PartialEq, Eq)]
enum TrayAction {
    Show,
    CheckUpdates,
    Quit,
}

fn tray_action(id: &str) -> Option<TrayAction> {
    match id {
        "show" => Some(TrayAction::Show),
        "check-updates" => Some(TrayAction::CheckUpdates),
        "quit" => Some(TrayAction::Quit),
        _ => None,
    }
}

trait AutostartBackend {
    fn is_enabled(&self) -> Result<bool, String>;
    fn enable(&self) -> Result<(), String>;
}

#[cfg(desktop)]
impl AutostartBackend for tauri_plugin_autostart::AutoLaunchManager {
    fn is_enabled(&self) -> Result<bool, String> {
        self.is_enabled().map_err(|error| error.to_string())
    }

    fn enable(&self) -> Result<(), String> {
        self.enable().map_err(|error| error.to_string())
    }
}

fn refresh_enabled_autostart<B: AutostartBackend>(backend: &B) -> Result<(), String> {
    if backend.is_enabled()? {
        // The plugin stores an absolute executable path. Re-enabling preserves the
        // user's preference while replacing stale paths left by an older install.
        backend.enable()?;
    }
    Ok(())
}

#[derive(Default)]
struct ExitGuard(AtomicBool);

struct MainWindowGate {
    has_been_shown: AtomicBool,
    wait_lock: Mutex<()>,
    shown: Condvar,
}

impl MainWindowGate {
    fn new(has_been_shown: bool) -> Self {
        Self {
            has_been_shown: AtomicBool::new(has_been_shown),
            wait_lock: Mutex::new(()),
            shown: Condvar::new(),
        }
    }

    fn has_been_shown(&self) -> bool {
        self.has_been_shown.load(Ordering::Acquire)
    }

    fn mark_shown(&self) {
        self.has_been_shown.store(true, Ordering::Release);
        self.shown.notify_all();
    }

    fn wait_until_shown(&self) {
        if self.has_been_shown() {
            return;
        }
        let mut guard = self
            .wait_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while !self.has_been_shown() {
            guard = self
                .shown
                .wait(guard)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
}

impl ExitGuard {
    fn begin_quit(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn is_quitting(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[cfg(desktop)]
struct UiRuntimeManager {
    started: AtomicBool,
    checking: Arc<AtomicBool>,
    operation: Arc<Mutex<()>>,
    protocol_cache: Mutex<ui_protocol::UiProtocolCache>,
}

#[cfg(desktop)]
impl Default for UiRuntimeManager {
    fn default() -> Self {
        Self {
            started: AtomicBool::new(false),
            checking: Arc::new(AtomicBool::new(false)),
            operation: Arc::new(Mutex::new(())),
            protocol_cache: Mutex::new(ui_protocol::UiProtocolCache::default()),
        }
    }
}

#[cfg(desktop)]
fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "desktop UI data directory is unavailable".to_string())
}

#[cfg(desktop)]
fn configured_ui_verifier() -> Result<ui_download::MinisignVerifier, String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .map_err(|_| "desktop UI updater configuration is invalid".to_string())?;
    let encoded = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or_else(|| "desktop UI updater public key is unavailable".to_string())?;
    ui_download::MinisignVerifier::from_updater_pubkey_base64(encoded)
        .map_err(|_| "desktop UI updater public key is invalid".to_string())
}

#[cfg(desktop)]
fn navigate_main_to(app: &tauri::AppHandle, url: &'static str) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        let Ok(target) = tauri::Url::parse(url) else {
            return;
        };
        let _ = window.navigate(target);
    });
}

#[cfg(desktop)]
fn navigate_to_available_ui(app: &tauri::AppHandle, store: &ui_update::UiUpdateStore) {
    let shell_version = app.package_info().version.to_string();
    let verifier = configured_ui_verifier().ok();
    let high_water = read_ui_high_water(store).ok();
    let trust_available = verifier.is_some() && high_water.is_some();
    let is_verified = |store: &ui_update::UiUpdateStore| {
        verifier
            .as_ref()
            .zip(high_water)
            .is_some_and(|(verifier, minimum)| {
                store
                    .verified_current_archive_at_least(
                        &shell_version,
                        ui_update::SUPPORTED_UI_ABI,
                        verifier,
                        &ui_update::UpdateLimits::default(),
                        Some(minimum),
                    )
                    .is_ok_and(|archive| archive.is_some())
            })
    };
    let mut verified = is_verified(store);
    if !verified && trust_available {
        if let Ok(metadata) = store.load_metadata() {
            if let Some(build_id) = metadata.current {
                if metadata.status == ui_update::UpdateStatus::Pending {
                    let _ =
                        store.fail_and_rollback(&build_id, ui_update::FailureReason::LoadFailed);
                } else {
                    let _ =
                        store.quarantine_current(&build_id, ui_update::FailureReason::LoadFailed);
                }
            }
        }
        verified = is_verified(store);
    }
    let target = if verified {
        UI_PROTOCOL_URL
    } else {
        BUNDLED_UI_URL
    };
    navigate_main_to(app, target);
}

#[cfg(desktop)]
fn recover_stale_pending(store: &ui_update::UiUpdateStore) {
    let Ok(metadata) = store.load_metadata() else {
        return;
    };
    if metadata.status != ui_update::UpdateStatus::Pending {
        return;
    }
    if let Some(build_id) = metadata.pending {
        let _ = store.fail_and_rollback(&build_id, ui_update::FailureReason::BootFailed);
    }
}

#[cfg(desktop)]
fn start_ui_ready_watchdog(app: tauri::AppHandle, build_id: String) {
    let operation = app.state::<UiRuntimeManager>().operation.clone();
    std::thread::spawn(move || {
        std::thread::sleep(UI_READY_TIMEOUT);
        let Ok(_guard) = operation.lock() else {
            return;
        };
        let Ok(app_data) = app_data_dir(&app) else {
            return;
        };
        let store = ui_update::UiUpdateStore::new(app_data);
        let Ok(metadata) = store.load_metadata() else {
            return;
        };
        if metadata.status == ui_update::UpdateStatus::Pending
            && metadata.pending.as_deref() == Some(build_id.as_str())
            && store
                .fail_and_rollback(&build_id, ui_update::FailureReason::ReadyTimeout)
                .is_ok()
        {
            navigate_to_available_ui(&app, &store);
        }
    });
}

#[cfg(desktop)]
fn perform_ui_check(app: &tauri::AppHandle) {
    let manager = app.state::<UiRuntimeManager>();
    if manager.checking.swap(true, Ordering::AcqRel) {
        return;
    }
    let checking = manager.checking.clone();
    let operation = manager.operation.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let result: Result<(), ()> = (|| {
            let _guard = operation.lock().map_err(|_| ())?;
            let app_data = app_data_dir(&app).map_err(|_| ())?;
            let store = ui_update::UiUpdateStore::new(app_data);
            if store
                .load_metadata()
                .is_ok_and(|metadata| metadata.status == ui_update::UpdateStatus::Pending)
            {
                return Ok(());
            }
            let current = store.current_build().ok().flatten();
            let current_build_id = current.as_ref().map(|build| build.build_id().to_string());
            let client = ui_download::OfficialHttpClient::new().map_err(|_| ())?;
            let verifier = configured_ui_verifier().map_err(|_| ())?;
            let shell_version = app.package_info().version.to_string();
            match ui_download::download_and_activate(
                &client,
                &verifier,
                &store,
                current_build_id.as_deref(),
                &shell_version,
                ui_update::SUPPORTED_UI_ABI,
                &ui_update::UpdateLimits::default(),
            ) {
                Ok(ui_download::DownloadOutcome::Activated { build_id, .. }) => {
                    navigate_main_to(&app, UI_PROTOCOL_URL);
                    start_ui_ready_watchdog(app.clone(), build_id);
                }
                Ok(ui_download::DownloadOutcome::NoUpdate) | Err(_) => {
                    if current.is_some() {
                        navigate_main_to(&app, UI_PROTOCOL_URL);
                    }
                }
            }
            Ok(())
        })();
        let _ = result;
        checking.store(false, Ordering::Release);
    });
}

#[cfg(desktop)]
fn ensure_ui_runtime_started(app: &tauri::AppHandle) {
    let manager = app.state::<UiRuntimeManager>();
    if manager.started.swap(true, Ordering::AcqRel) {
        return;
    }
    let operation = manager.operation.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        if let Ok(_guard) = operation.lock() {
            if let Ok(app_data) = app_data_dir(&app) {
                let store = ui_update::UiUpdateStore::new(app_data);
                recover_stale_pending(&store);
                navigate_to_available_ui(&app, &store);
            }
        }
        perform_ui_check(&app);
        loop {
            std::thread::sleep(UI_CHECK_INTERVAL);
            perform_ui_check(&app);
        }
    });
}

#[cfg(desktop)]
fn serve_ui_protocol(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let Ok(app_data) = app_data_dir(app) else {
        return tauri::http::Response::builder()
            .status(500)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(b"Internal Server Error".to_vec())
            .expect("static desktop UI error response must be valid");
    };
    let Ok(verifier) = configured_ui_verifier() else {
        return tauri::http::Response::builder()
            .status(500)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(b"Internal Server Error".to_vec())
            .expect("static desktop UI error response must be valid");
    };
    let store = ui_update::UiUpdateStore::new(app_data);
    let Ok(high_water) = read_ui_high_water(&store) else {
        return tauri::http::Response::builder()
            .status(500)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(b"Internal Server Error".to_vec())
            .expect("static desktop UI error response must be valid");
    };
    let protocol = ui_protocol::serve_verified(
        &app.state::<UiRuntimeManager>().protocol_cache,
        &store,
        &app.package_info().version.to_string(),
        ui_update::SUPPORTED_UI_ABI,
        Some(high_water),
        &verifier,
        path,
    );
    let (status, headers, body) = protocol.into_parts();
    let mut response = tauri::http::Response::builder().status(status);
    for (name, value) in headers {
        response = response.header(name, value);
    }
    response.body(body).unwrap_or_else(|_| {
        tauri::http::Response::builder()
            .status(500)
            .body(b"Internal Server Error".to_vec())
            .expect("fixed desktop UI error response is valid")
    })
}

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        if window.show().is_ok() {
            app.state::<MainWindowGate>().mark_shown();
            let _ = app.emit("agentparty://window-shown", ());
        }
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_window_has_been_shown(app: tauri::AppHandle) -> bool {
    app.state::<MainWindowGate>().has_been_shown()
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_ui_ready(app: tauri::AppHandle, build_id: String, ui_abi: u32) -> Result<(), String> {
    let operation = app.state::<UiRuntimeManager>().operation.clone();
    let _guard = operation
        .lock()
        .map_err(|_| "desktop UI state is unavailable".to_string())?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "desktop UI data directory is unavailable".to_string())?;
    let store = ui_update::UiUpdateStore::new(app_data);
    let verifier = configured_ui_verifier()?;
    let high_water = read_ui_high_water(&store)?;
    let archive = store
        .verified_current_archive_at_least(
            &app.package_info().version.to_string(),
            ui_update::SUPPORTED_UI_ABI,
            &verifier,
            &ui_update::UpdateLimits::default(),
            Some(high_water),
        )
        .map_err(|_| "desktop UI signed evidence was rejected".to_string())?
        .ok_or_else(|| "desktop UI signed evidence is unavailable".to_string())?;
    if archive.build_id() != build_id || archive.ui_abi() != ui_abi {
        return Err("desktop UI ready receipt does not match signed evidence".to_string());
    }
    store
        .mark_ready(&build_id, ui_abi)
        .map_err(|_| "desktop UI ready receipt was rejected".to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_ui_storage_restore(app: tauri::AppHandle) -> Result<BTreeMap<String, String>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "desktop UI data directory is unavailable".to_string())?;
    ui_storage::read_snapshot(&app_data)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_ui_storage_snapshot(
    app: tauri::AppHandle,
    entries: BTreeMap<String, String>,
) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "desktop UI data directory is unavailable".to_string())?;
    ui_storage::write_snapshot(&app_data, &entries)?;
    ensure_ui_runtime_started(&app);
    Ok(())
}

#[cfg(desktop)]
fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show AgentParty", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates...",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit AgentParty", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &check_updates, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("AgentParty")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match tray_action(event.id.as_ref()) {
            Some(TrayAction::Show) => show_main(app),
            Some(TrayAction::CheckUpdates) => {
                show_main(app);
                perform_ui_check(app);
                let _ = app.emit("agentparty://check-for-updates", ());
            }
            Some(TrayAction::Quit) => {
                app.state::<ExitGuard>().begin_quit();
                app.exit(0);
            }
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(ExitGuard::default());

    #[cfg(desktop)]
    let builder = builder
        .manage(MainWindowGate::new(
            !std::env::args().any(|arg| arg == "--hidden"),
        ))
        .manage(agent::AgentManager::default())
        .manage(UiRuntimeManager::default())
        .register_uri_scheme_protocol("agentparty-ui", |context, request| {
            serve_ui_protocol(context.app_handle(), request.uri().path())
        });

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .invoke_handler(tauri::generate_handler![
            desktop_release_info,
            desktop_credential_read,
            desktop_credential_authorize,
            desktop_credential_write,
            desktop_credential_write_interactive,
            desktop_credential_delete,
            desktop_credential_delete_interactive,
            desktop_credential_migrate,
            desktop_window_has_been_shown,
            desktop_updater_record_diagnostic,
            desktop_ui_ready,
            desktop_ui_storage_restore,
            desktop_ui_storage_snapshot,
            agent::desktop_agent_list_configs,
            agent::desktop_agent_status,
            agent::desktop_agent_start,
            agent::desktop_agent_stop,
            agent::desktop_agent_logs
        ]);

    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init());

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                install_tray(app)?;
                if let Err(error) = refresh_enabled_autostart(app.autolaunch().inner()) {
                    eprintln!("AgentParty could not refresh its login item: {error}");
                }
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                app.deep_link().register_all()?;
                if !std::env::args().any(|arg| arg == "--hidden") {
                    show_main(app.handle());
                }
                let handle = app.handle().clone();
                if app_data_dir(&handle).is_ok_and(|path| ui_storage::snapshot_exists(&path)) {
                    ensure_ui_runtime_started(&handle);
                } else {
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(5));
                        ensure_ui_runtime_started(&handle);
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main" && !window.app_handle().state::<ExitGuard>().is_quitting() {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building AgentParty desktop")
        .run(|app, event| {
            #[cfg(desktop)]
            if matches!(
                &event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                app.state::<agent::AgentManager>().kill_on_exit();
            }
            #[cfg(target_os = "macos")]
            if matches!(&event, tauri::RunEvent::Reopen { .. }) {
                show_main(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::HashMap};

    use base64::{engine::general_purpose::STANDARD, Engine};
    use minisign_verify::{PublicKey, Signature};
    use tempfile::TempDir;

    use super::{
        credential_account_for_origin, migrate_legacy_credential, parse_stored_credential,
        refresh_enabled_autostart, release_info_from_build, tray_action,
        validate_updater_diagnostic, write_updater_diagnostic, AutostartBackend, CredentialBackend,
        ExitGuard, MainWindowGate, TrayAction, UpdaterDiagnostic, UpdaterDiagnosticCategory,
        UpdaterDiagnosticStage, UpdaterDiagnosticStatus, CREDENTIAL_ACCOUNT,
    };

    #[test]
    fn desktop_release_identity_fails_closed() {
        assert_eq!(
            release_info_from_build(Some("production"), Some("true")),
            super::DesktopReleaseInfo {
                distribution: "production",
                notarized: true,
            }
        );
        assert_eq!(
            release_info_from_build(Some("preview"), Some("false")),
            super::DesktopReleaseInfo {
                distribution: "preview",
                notarized: false,
            }
        );
        for invalid in [
            release_info_from_build(Some("production"), Some("false")),
            release_info_from_build(Some("preview"), Some("true")),
            release_info_from_build(None, None),
        ] {
            assert_eq!(invalid.distribution, "development");
            assert!(!invalid.notarized);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn automatic_keychain_access_disables_authentication_ui() {
        let interactive = super::macos_password_options("service", "account", true);
        let automatic = super::macos_password_options("service", "account", false);
        #[allow(deprecated)]
        {
            assert_eq!(interactive.query.len(), 3);
            assert_eq!(automatic.query.len(), 4);
        }
        assert_eq!(
            super::map_macos_keychain_error(security_framework::base::Error::from_code(-25_308)),
            super::KEYCHAIN_AUTHORIZATION_REQUIRED
        );
        assert_eq!(
            super::map_macos_keychain_error(security_framework::base::Error::from_code(-25_299)),
            super::KEYCHAIN_UNAVAILABLE
        );
    }

    #[derive(Default)]
    struct MockAutostart {
        enabled: bool,
        enable_calls: RefCell<usize>,
        read_error: bool,
        write_error: bool,
    }

    impl AutostartBackend for MockAutostart {
        fn is_enabled(&self) -> Result<bool, String> {
            if self.read_error {
                return Err("autostart read failed".to_string());
            }
            Ok(self.enabled)
        }

        fn enable(&self) -> Result<(), String> {
            *self.enable_calls.borrow_mut() += 1;
            if self.write_error {
                return Err("autostart write failed".to_string());
            }
            Ok(())
        }
    }

    #[test]
    fn refreshes_only_an_enabled_autostart_registration() {
        let disabled = MockAutostart::default();
        refresh_enabled_autostart(&disabled).unwrap();
        assert_eq!(*disabled.enable_calls.borrow(), 0);

        let enabled = MockAutostart {
            enabled: true,
            ..MockAutostart::default()
        };
        refresh_enabled_autostart(&enabled).unwrap();
        assert_eq!(*enabled.enable_calls.borrow(), 1);
    }

    #[test]
    fn autostart_refresh_surfaces_read_and_rewrite_failures() {
        let read_failure = MockAutostart {
            read_error: true,
            ..MockAutostart::default()
        };
        assert_eq!(
            refresh_enabled_autostart(&read_failure).unwrap_err(),
            "autostart read failed"
        );

        let write_failure = MockAutostart {
            enabled: true,
            write_error: true,
            ..MockAutostart::default()
        };
        assert_eq!(
            refresh_enabled_autostart(&write_failure).unwrap_err(),
            "autostart write failed"
        );
        assert_eq!(*write_failure.enable_calls.borrow(), 1);
    }

    fn pending_updater_receipt() -> UpdaterDiagnostic {
        UpdaterDiagnostic {
            status: UpdaterDiagnosticStatus::Pending,
            source: None,
            stage: UpdaterDiagnosticStage::Relaunch,
            category: None,
            timestamp: 123_456,
            app_version: Some("0.2.90".to_string()),
            target_version: Some("0.2.91".to_string()),
        }
    }

    #[test]
    fn updater_diagnostic_rejects_unknown_or_inconsistent_fields() {
        let raw = r#"{
            "status":"failure",
            "source":null,
            "stage":"relaunch",
            "category":"verification",
            "timestamp":123456,
            "appVersion":"0.2.90",
            "targetVersion":"0.2.91",
            "rawError":"token=must-not-persist"
        }"#;
        assert!(serde_json::from_str::<UpdaterDiagnostic>(raw).is_err());

        let mut diagnostic = pending_updater_receipt();
        diagnostic.category = Some(UpdaterDiagnosticCategory::Verification);
        assert!(validate_updater_diagnostic(&diagnostic).is_err());
        diagnostic.category = None;
        diagnostic.target_version = Some("../../secret".to_string());
        assert!(validate_updater_diagnostic(&diagnostic).is_err());
    }

    #[test]
    fn updater_diagnostic_is_atomically_persisted_without_a_temp_file() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("updater-diagnostic.json");
        let diagnostic = pending_updater_receipt();

        write_updater_diagnostic(&path, &diagnostic).unwrap();

        let stored: UpdaterDiagnostic =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored, diagnostic);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[derive(Default)]
    struct MemoryCredentials(RefCell<HashMap<String, String>>);

    impl CredentialBackend for MemoryCredentials {
        fn read(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(account).cloned())
        }

        fn write(&self, account: &str, credential: &str) -> Result<(), String> {
            self.0
                .borrow_mut()
                .insert(account.to_string(), credential.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(account);
            Ok(())
        }
    }

    #[test]
    fn maps_known_tray_actions() {
        assert_eq!(tray_action("show"), Some(TrayAction::Show));
        assert_eq!(tray_action("check-updates"), Some(TrayAction::CheckUpdates));
        assert_eq!(tray_action("quit"), Some(TrayAction::Quit));
        assert_eq!(tray_action("unknown"), None);
    }

    #[test]
    fn exit_guard_only_allows_explicit_quit() {
        let guard = ExitGuard::default();
        assert!(!guard.is_quitting());

        guard.begin_quit();
        assert!(guard.is_quitting());
    }

    #[test]
    fn hidden_startup_gate_opens_only_after_the_main_window_is_shown() {
        use std::{
            sync::{mpsc, Arc},
            thread,
            time::Duration,
        };

        let gate = Arc::new(MainWindowGate::new(false));
        let waiting_gate = Arc::clone(&gate);
        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            waiting_gate.wait_until_shown();
            done_tx.send(()).unwrap();
        });

        assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());

        gate.mark_shown();

        done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_credentials_do_not_reopen_the_legacy_keychain_service() {
        assert_eq!(
            super::MACOS_CREDENTIAL_SERVICE,
            "com.agentparty.desktop.credentials.v2"
        );
        assert_ne!(super::MACOS_CREDENTIAL_SERVICE, "com.agentparty.desktop");
    }

    #[test]
    fn configured_updater_key_verifies_the_v2_probe() {
        const PROBE: &[u8] = b"AgentParty updater v2 key probe\n";
        const PROBE_SIGNATURE_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTaFhBUlJFam9nMURVUGRiTDRXRTVTUU44amViWVhJUGQvNVRxN09ZK01reFc3aldyZzNNeTk4WmZ3Z2J6Wkp1RmxyZUtKOG5BdHo4cmxXaWRYYzhpOGpKNTVDN3RNZ1FVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgzNjk5NTgwCWZpbGU6dG1wLjNpNHNNUHZQZU4KVSt6YnFHSk1pUEs3cnFCSUZ3MW53cDkrNVBGTHMxMWU4Z3hXM1dqVjE5Y3lrWCt5OE1MMWhzVlk0WVdZbjZUYXBqRk9vdlJSTTBwSHdpQkJWNWlzRFE9PQo=";

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let encoded_public_key = config["plugins"]["updater"]["pubkey"]
            .as_str()
            .expect("configured updater public key");
        let public_key_text = String::from_utf8(
            STANDARD
                .decode(encoded_public_key)
                .expect("base64-encoded updater public key"),
        )
        .expect("UTF-8 minisign public key");
        let public_key = PublicKey::decode(&public_key_text).expect("parseable updater public key");

        let signature_text = String::from_utf8(
            STANDARD
                .decode(PROBE_SIGNATURE_B64)
                .expect("base64-encoded updater signature"),
        )
        .expect("UTF-8 minisign signature");
        let signature = Signature::decode(&signature_text).expect("parseable updater signature");

        public_key
            .verify(PROBE, &signature, false)
            .expect("v2 updater key verifies its probe signature");
    }

    #[test]
    fn accepts_only_the_refresh_and_device_credential_shape() {
        let credential = parse_stored_credential(
            r#"{"refreshToken":"refresh","deviceSecret":"device-secret","serverOrigin":"https://agentparty.leeguoo.com","sessionId":"session-1"}"#,
        )
        .expect("valid desktop credential");

        assert_eq!(credential.refresh_token, "refresh");
        assert_eq!(credential.device_secret, "device-secret");
        assert_eq!(credential.server_origin, "https://agentparty.leeguoo.com");
        assert_eq!(credential.session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn rejects_access_tokens_and_incomplete_credentials_before_keyring_io() {
        assert!(parse_stored_credential(
            r#"{"refreshToken":"refresh","deviceSecret":"device-secret","serverOrigin":"https://agentparty.leeguoo.com","sessionId":null,"accessToken":"must-not-persist"}"#,
        )
        .is_err());
        assert!(parse_stored_credential(
            r#"{"refreshToken":"refresh","serverOrigin":"https://agentparty.leeguoo.com","sessionId":null}"#,
        )
        .is_err());
        assert!(parse_stored_credential(
            r#"{"refreshToken":"refresh","deviceSecret":"device-secret","serverOrigin":"http://evil.example","sessionId":null}"#,
        )
        .is_err());
    }

    #[test]
    fn derives_a_stable_sha256_account_from_the_origin() {
        assert_eq!(
            credential_account_for_origin("https://agentparty.leeguoo.com").unwrap(),
            "desktop-session:a54553e56c5db33ab39807028be8b3c039c7694a6382d1520644c72dc63918be"
        );
    }

    #[test]
    fn migrates_the_legacy_slot_once_and_removes_it() {
        let store = MemoryCredentials::default();
        let credential = r#"{"refreshToken":"refresh","deviceSecret":"device-secret","serverOrigin":"https://party.example.com","sessionId":null}"#;
        store.write(CREDENTIAL_ACCOUNT, credential).unwrap();

        assert_eq!(
            migrate_legacy_credential(&store).unwrap().as_deref(),
            Some("https://party.example.com")
        );
        let account = credential_account_for_origin("https://party.example.com").unwrap();
        assert_eq!(store.read(&account).unwrap().as_deref(), Some(credential));
        assert_eq!(store.read(CREDENTIAL_ACCOUNT).unwrap(), None);
        assert_eq!(migrate_legacy_credential(&store).unwrap(), None);
    }
}
