//! XueMint desktop shell. Hosts the local server in the background, keeps the
//! tray alive when windows close, and provides pairing/setup windows.

mod commands;
mod firewall;
mod host;
mod mdns;
mod power;
mod state;

use state::DesktopState;
use std::path::PathBuf;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

pub fn open_gallery_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window("gallery") {
        window.show()?;
        window.set_focus()?;
        return Ok(window);
    }

    let port = app.state::<DesktopState>().port();
    if port == 0 {
        return Err(tauri::Error::Anyhow(anyhow::anyhow!(
            "the local server is not ready yet"
        )));
    }
    let url = tauri::Url::parse(&format!("https://127.0.0.1:{port}/"))
        .expect("local gallery URL is valid");

    let builder = WebviewWindowBuilder::new(app, "gallery", WebviewUrl::External(url))
        .title("XueMint")
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .center();

    // The server uses a self-signed certificate for loopback. Only this window
    // bypasses certificate errors; phones pin the fingerprint from the QR code.
    #[cfg(windows)]
    let builder = builder.additional_browser_args("--ignore-certificate-errors");

    builder.build()
}

/// Focuses the pairing window and asks it for a fresh token. Reusing the window
/// avoids destroying and recreating a webview with the same label.
pub fn open_pairing_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window("pairing") {
        existing.show()?;
        existing.set_focus()?;
        let _ = existing.emit("refresh-pairing", ());
        return Ok(existing);
    }
    let builder = WebviewWindowBuilder::new(app, "pairing", WebviewUrl::App("index.html".into()))
        .title("Pair a phone — XueMint")
        .inner_size(880.0, 640.0)
        .min_inner_size(520.0, 560.0)
        .center();
    #[cfg(windows)]
    let builder = builder.additional_browser_args("--ignore-certificate-errors");
    builder.build()
}

pub fn open_setup_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window("setup") {
        window.show()?;
        window.set_focus()?;
        return Ok(window);
    }
    let builder = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("index.html".into()))
        .title("XueMint setup")
        .inner_size(740.0, 760.0)
        .min_inner_size(520.0, 560.0)
        .center();
    #[cfg(windows)]
    let builder = builder.additional_browser_args("--ignore-certificate-errors");
    builder.build()
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open gallery", true, None::<&str>)?;
    let pair = MenuItem::with_id(app, "pair", "Pair a phone", true, None::<&str>)?;
    let setup = MenuItem::with_id(app, "setup", "Allow phone connections…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit XueMint", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pair, &setup, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("XueMint — your photos stay on this PC")
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = open_gallery_window(&app) {
                        eprintln!("Tray: could not open gallery: {error}");
                    }
                });
            }
            "pair" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = open_pairing_window(&app) {
                        eprintln!("Tray: could not open pairing: {error}");
                    }
                });
            }
            "setup" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = open_setup_window(&app) {
                        eprintln!("Tray: could not open setup: {error}");
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = open_gallery_window(&app) {
                        eprintln!("Tray click: could not open gallery: {error}");
                    }
                });
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::create_pairing_code,
            commands::setup_status,
            commands::add_firewall_rule,
            commands::set_autostart,
            commands::open_gallery,
            commands::open_pairing,
            commands::quit,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let minimized = std::env::args().any(|arg| arg == "--minimized");

            match tauri::async_runtime::block_on(host::prepare(&handle)) {
                Ok(startup) => {
                    let state = DesktopState::new(
                        startup.cfg.port,
                        startup.cfg.photos_dir.clone(),
                        startup.cfg.data_dir.clone(),
                        minimized,
                    );
                    app.manage(state);
                    host::ensure_default_autostart(&handle, &startup.cfg.data_dir);
                    setup_tray(&handle)?;
                    host::launch(handle, startup);
                }
                Err(error) => {
                    eprintln!("XueMint startup failed: {error:#}");
                    let (photos_dir, data_dir) = fallback_paths();
                    app.manage(DesktopState::fallback(
                        format!("{error:#}"),
                        photos_dir,
                        data_dir.clone(),
                        minimized,
                    ));
                    setup_tray(&handle)?;
                    let _ = open_setup_window(&handle);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the gallery hides it; backups continue in the tray.
            if window.label() == "gallery" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building XueMint")
        .run(|app, event| match event {
            // Closing the last window must not stop the backup server.
            RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            RunEvent::Exit => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    state.power.release();
                    if let Ok(mut slot) = state.mdns.lock() {
                        if let Some(advertiser) = slot.take() {
                            advertiser.shutdown();
                        }
                    }
                }
            }
            _ => {}
        });
}

fn fallback_paths() -> (PathBuf, PathBuf) {
    host::default_paths()
}
