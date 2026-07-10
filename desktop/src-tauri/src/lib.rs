use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;

const CREDENTIAL_SERVICE: &str = "com.agentparty.desktop";
const CREDENTIAL_ACCOUNT: &str = "desktop-session";

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

#[cfg(desktop)]
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

#[cfg(desktop)]
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
#[tauri::command]
fn desktop_credential_write(origin: String, credential: String) -> Result<(), String> {
    let parsed = parse_stored_credential(&credential)?;
    if parsed.server_origin != origin {
        return Err("desktop credential origin does not match its slot".to_string());
    }
    let account = credential_account_for_origin(&origin)?;
    NativeCredentialBackend.write(&account, &credential)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_read(origin: String) -> Result<Option<String>, String> {
    let account = credential_account_for_origin(&origin)?;
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
#[tauri::command]
fn desktop_credential_delete(origin: String) -> Result<(), String> {
    let account = credential_account_for_origin(&origin)?;
    NativeCredentialBackend.delete(&account)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_migrate() -> Result<Option<String>, String> {
    migrate_legacy_credential(&NativeCredentialBackend)
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

#[derive(Default)]
struct ExitGuard(AtomicBool);

impl ExitGuard {
    fn begin_quit(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn is_quitting(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .invoke_handler(tauri::generate_handler![
            desktop_credential_read,
            desktop_credential_write,
            desktop_credential_delete,
            desktop_credential_migrate
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
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                app.deep_link().register_all()?;
                if !std::env::args().any(|arg| arg == "--hidden") {
                    show_main(app.handle());
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
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                show_main(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::HashMap};

    use base64::{engine::general_purpose::STANDARD, Engine};
    use minisign_verify::{PublicKey, Signature};

    use super::{
        credential_account_for_origin, migrate_legacy_credential, parse_stored_credential,
        tray_action, CredentialBackend, ExitGuard, TrayAction, CREDENTIAL_ACCOUNT,
    };

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
