//! Commands invoked by the pairing and setup windows.

use crate::state::DesktopState;
use crate::{firewall, host, open_gallery_window, open_pairing_window};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub server_ready: bool,
    pub server_error: Option<String>,
    pub port: u16,
    pub photos_dir: String,
    pub data_dir: String,
    pub autostart: bool,
    pub firewall_rule: bool,
    pub version: String,
}

#[tauri::command]
pub async fn create_pairing_code(
    state: State<'_, DesktopState>,
) -> Result<host::PairingInfo, String> {
    let state = state.inner().clone();
    if state.port() == 0 {
        return Err("The local server has not started yet.".to_string());
    }
    let response = state
        .http
        .post(format!("https://127.0.0.1:{}/local/pairing", state.port()))
        .send()
        .await
        .map_err(|error| format!("Could not reach the local server: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The local server refused to create a code (HTTP {}).",
            response.status().as_u16()
        ));
    }
    response
        .json::<host::PairingInfo>()
        .await
        .map_err(|error| format!("The pairing response was invalid: {error}"))
}

#[tauri::command]
pub async fn setup_status(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<SetupStatus, String> {
    let state = state.inner().clone();
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    // The gallery can change the folder while this window is open; ask the
    // running server for the active value, falling back to startup state.
    let active_folder = match state
        .http
        .get(format!("https://127.0.0.1:{}/local/settings", state.port()))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|value| {
                value
                    .get("activePhotosFolder")
                    .and_then(|folder| folder.as_str())
                    .map(str::to_string)
            }),
        _ => None,
    };
    Ok(SetupStatus {
        server_ready: state.is_ready(),
        server_error: state.error(),
        port: state.port(),
        photos_dir: active_folder
            .unwrap_or_else(|| state.photos_dir().to_string_lossy().into_owned()),
        data_dir: state.data_dir().to_string_lossy().into_owned(),
        autostart,
        firewall_rule: firewall::rule_exists(),
        version: app.package_info().version.to_string(),
    })
}

#[tauri::command]
pub async fn add_firewall_rule() -> Result<firewall::FirewallResult, String> {
    tokio::task::spawn_blocking(firewall::add_rule)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_gallery(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_gallery_window(&app) {
            eprintln!("Could not open the gallery window: {error}");
        }
    });
}

#[tauri::command]
pub fn open_pairing(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_pairing_window(&app) {
            eprintln!("Could not open the pairing window: {error}");
        }
    });
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}
