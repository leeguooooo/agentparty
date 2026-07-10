use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

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
    let builder = tauri::Builder::default()
        .manage(ExitGuard::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ));

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                install_tray(app)?;
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
    use super::{tray_action, ExitGuard, TrayAction};

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
}
