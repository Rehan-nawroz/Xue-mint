//! Startup, server supervision and the first-run integrations.

use crate::mdns::MdnsAdvertiser;
use crate::state::DesktopState;
use crate::{firewall, open_gallery_window, open_pairing_window, open_setup_window};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use xue_mint_server::config::Config;
use xue_mint_server::db::{self, get_setting};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub version: u8,
    pub server_name: String,
    pub addresses: Vec<String>,
    pub port: u16,
    pub fingerprint: String,
    pub token: Option<String>,
    pub expires_at: Option<String>,
}

pub struct Startup {
    pub cfg: Config,
    pub pool: sqlx::SqlitePool,
}

/// Resolves durable locations, opens the database and applies saved settings
/// before the server starts. Env overrides keep automated checks isolated.
pub async fn prepare(app: &AppHandle) -> anyhow::Result<Startup> {
    let (photos_dir, data_dir) = default_paths();
    let port = std::env::var("XM_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(8427);

    let mut cfg = Config {
        port,
        photos_dir,
        data_dir,
        web_dir: resolve_web_dir(app),
    };
    cfg.ensure_dirs()?;

    let pool = db::open(&cfg).await?;
    db::apply_defaults(&pool).await?;

    if let Some(folder) = get_setting(&pool, "photos_folder").await? {
        if !folder.trim().is_empty() {
            cfg.photos_dir = PathBuf::from(folder);
        }
    }
    if let Some(port) = get_setting(&pool, "port").await? {
        if let Ok(port) = port.parse::<u16>() {
            if port > 0 {
                cfg.port = port;
            }
        }
    }
    cfg.ensure_dirs()?;

    Ok(Startup { cfg, pool })
}

/// Default locations, overridable for isolated checks.
pub fn default_paths() -> (PathBuf, PathBuf) {
    let data_dir = env_path("XM_DATA_DIR").unwrap_or_else(|| {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Xue-Mint")
    });
    let photos_dir = env_path("XM_PHOTOS_DIR").unwrap_or_else(|| {
        dirs::picture_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Xue-Mint")
    });
    (photos_dir, data_dir)
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// The gallery bundle copied next to the executable by the installer, with
/// source-tree fallbacks for `tauri dev`.
fn resolve_web_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = env_path("XM_WEB_DIR") {
        candidates.push(path);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("web"));
        candidates.push(resource_dir.join("resources").join("web"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("web"),
    );
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("web")
            .join("dist"),
    );

    candidates
        .into_iter()
        .find(|candidate| candidate.join("index.html").is_file())
}

/// Starts the background server and waits for it to answer, then brings up
/// the gallery and the optional first-run prompt. Retries forever if the port
/// is temporarily unavailable.
pub fn launch(app: AppHandle, startup: Startup) {
    let state = app.state::<DesktopState>().inner().clone();
    let open_pairing = std::env::args().any(|arg| arg == "--pairing");
    state.set_port(startup.cfg.port);
    state.set_error(None);

    let cfg = startup.cfg.clone();
    let pool = startup.pool.clone();
    let server_state = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_error: Option<String> = None;
        loop {
            let result = xue_mint_server::run_server(cfg.clone(), pool.clone()).await;
            let message = match result {
                Ok(()) => "The local server stopped unexpectedly.".to_string(),
                Err(error) => format!("The local server could not start: {error}"),
            };
            if last_error.as_deref() != Some(message.as_str()) {
                eprintln!("{message}");
                last_error = Some(message.clone());
            }
            server_state.set_ready(false);
            server_state.set_error(Some(message));
            tokio::time::sleep(Duration::from_secs(4)).await;
        }
    });

    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut announced_startup = false;
        loop {
            let ready = fetch_pairing(&state.http, state.port()).await.is_some();
            if ready {
                state.set_ready(true);
                state.set_error(None);
                if state.mark_integrated() {
                    start_integrations(&state).await;
                    if open_pairing {
                        if let Err(error) = open_pairing_window(&app) {
                            eprintln!("Could not open the pairing window: {error}");
                        }
                    } else if !state.minimized {
                        if let Err(error) = open_gallery_window(&app) {
                            eprintln!("Could not open the gallery window: {error}");
                        }
                    }
                    prompt_for_firewall(&app, &state);
                }
                if !announced_startup {
                    println!(
                        "Xue-Mint server ready on port {} after {:?}",
                        state.port(),
                        started.elapsed()
                    );
                    announced_startup = true;
                }
            } else {
                state.set_ready(false);
                if started.elapsed() > Duration::from_secs(20)
                    && state.error().is_none()
                    && !announced_startup
                {
                    state.set_error(Some(
                        "The local server is taking longer than expected to start.".to_string(),
                    ));
                    if let Err(error) = open_setup_window(&app) {
                        eprintln!("Could not open the setup window: {error}");
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

/// Registers mDNS and starts the power monitor. Runs once per process.
async fn start_integrations(state: &DesktopState) {
    if let Some(info) = fetch_pairing(&state.http, state.port()).await {
        match MdnsAdvertiser::start(&info) {
            Ok(advertiser) => {
                println!("mDNS advertising {}", advertiser.fullname());
                if let Ok(mut slot) = state.mdns.lock() {
                    *slot = Some(advertiser);
                }
            }
            Err(error) => eprintln!("mDNS advertising skipped: {error}"),
        }
    }

    let monitor_state = state.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let active = fetch_active_uploads(&monitor_state.http, monitor_state.port())
                .await
                .unwrap_or(false);
            if active {
                monitor_state.power.acquire();
            } else {
                monitor_state.power.release();
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

/// Opens setup once when Windows has no rule yet, so the first phone attempt
/// has a clear explanation instead of a silent timeout.
fn prompt_for_firewall(app: &AppHandle, state: &DesktopState) {
    let app = app.clone();
    let data_dir = state.data_dir().clone();
    tauri::async_runtime::spawn(async move {
        let exists = tokio::task::spawn_blocking(firewall::rule_exists)
            .await
            .unwrap_or(false);
        if exists {
            return;
        }
        let marker = data_dir.join("firewall-prompted");
        if marker.exists() {
            return;
        }
        match open_setup_window(&app) {
            Ok(window) => {
                println!("Opened first-run firewall setup window: {}", window.label());
                let _ = std::fs::write(marker, b"1");
            }
            Err(error) => eprintln!("Could not open first-run setup window: {error}"),
        }
    });
}

/// Autostart is on after the first run; setup exposes the switch to turn it
/// off. The marker keeps a later user choice from being overwritten.
pub fn ensure_default_autostart(app: &AppHandle, data_dir: &Path) {
    let marker = data_dir.join(".autostart-initialized");
    if marker.exists() {
        return;
    }
    if app.autolaunch().enable().is_ok() {
        let _ = std::fs::write(marker, b"1");
    }
}

pub async fn fetch_pairing(http: &reqwest::Client, port: u16) -> Option<PairingInfo> {
    if port == 0 {
        return None;
    }
    let response = http
        .get(format!("https://127.0.0.1:{port}/local/pairing"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<PairingInfo>().await.ok()
}

async fn fetch_active_uploads(http: &reqwest::Client, port: u16) -> Option<bool> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        active_uploads: i64,
    }

    if port == 0 {
        return None;
    }
    let status = http
        .get(format!("https://127.0.0.1:{port}/local/status"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Status>()
        .await
        .ok()?;
    Some(status.active_uploads > 0)
}
