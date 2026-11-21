//! Endpoints used only by the gallery running on this PC.
//!
//! These answer only to connections that come from the PC itself (loopback), so a
//! phone or any other machine on the network can never open a gallery session,
//! change settings, or read desktop-only status.

use crate::auth::SESSION_COOKIE;
use crate::certs;
use crate::db::get_setting;
use crate::errors::ApiError;
use crate::firewall;
use crate::media::{now_iso, sha256_hex};
use crate::state::AppState;
use crate::tokens;
use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::net::SocketAddr;
use std::path::PathBuf;

/// Identifier of the built-in device that represents the gallery on this PC.
pub const LOCAL_DEVICE_ID: &str = "local";

/// Extractor that only succeeds for connections coming from this machine.
pub struct LocalOnly;

impl FromRequestParts<AppState> for LocalOnly {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let is_local = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip().is_loopback())
            .unwrap_or(false);
        if is_local {
            Ok(LocalOnly)
        } else {
            Err(ApiError::forbidden(
                "This page can only be opened on the PC that stores the photos.",
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// POST /local/session - gallery on this PC receives its session cookie
// ---------------------------------------------------------------------------

pub async fn session(
    State(state): State<AppState>,
    _local: LocalOnly,
) -> Result<Response, ApiError> {
    let credential = ensure_local_credential(&state).await?;
    let cookie = format!(
        "{SESSION_COOKIE}={credential}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000"
    );
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response())
}

/// Reads (or creates) the stable credential for this PC's gallery and makes sure
/// the matching built-in device row exists and is not revoked.
async fn ensure_local_credential(state: &AppState) -> Result<String, ApiError> {
    let path = state.cfg.local_session_file();
    let existing = std::fs::read_to_string(&path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());

    let credential = match existing {
        Some(value) => value,
        None => {
            use rand::RngCore;
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            let value = URL_SAFE_NO_PAD.encode(bytes);
            std::fs::write(&path, &value)?;
            value
        }
    };

    let now = now_iso();
    sqlx::query(
        "INSERT INTO devices (id, name, public_key, credential_hash, paired_at, last_seen_at, revoked) \
         VALUES (?, 'This PC', ?, ?, ?, ?, 0) \
         ON CONFLICT(id) DO UPDATE SET credential_hash = excluded.credential_hash, revoked = 0",
    )
    .bind(LOCAL_DEVICE_ID)
    .bind(b"local-gallery".to_vec())
    .bind(sha256_hex(credential.as_bytes()))
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await?;

    Ok(credential)
}

// ---------------------------------------------------------------------------
// GET/PUT /local/settings
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub delete_behavior: String,
    pub photos_folder: String,
    pub mirror_folder: String,
    pub mirror_available: bool,
    pub port: u16,
    pub active_photos_folder: String,
    pub active_port: u16,
    pub restart_required: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub delete_behavior: Option<String>,
    pub photos_folder: Option<String>,
    pub mirror_folder: Option<String>,
    pub port: Option<u16>,
}

async fn read_settings(state: &AppState) -> Result<SettingsDto, ApiError> {
    let delete_behavior = get_setting(&state.pool, "delete_behavior")
        .await?
        .unwrap_or_else(|| "index_only".to_string());

    let active_photos = state.photos_dir();
    let stored_folder = get_setting(&state.pool, "photos_folder").await?;
    let photos_folder = stored_folder
        .clone()
        .unwrap_or_else(|| active_photos.to_string_lossy().into_owned());

    let mirror_folder = get_setting(&state.pool, "mirror_folder")
        .await?
        .unwrap_or_default();
    let mirror_available =
        mirror_folder.trim().is_empty() || PathBuf::from(mirror_folder.trim()).is_dir();

    let stored_port = get_setting(&state.pool, "port")
        .await?
        .and_then(|value| value.parse::<u16>().ok());
    let port = stored_port.unwrap_or(state.cfg.port);

    // The folder applies immediately (the watcher re-targets); only the port
    // needs a restart because the listener is already bound.
    let restart_required = port != state.cfg.port;

    Ok(SettingsDto {
        delete_behavior,
        photos_folder,
        mirror_folder,
        mirror_available,
        port,
        active_photos_folder: active_photos.to_string_lossy().into_owned(),
        active_port: state.cfg.port,
        restart_required,
    })
}

pub async fn get_settings(
    State(state): State<AppState>,
    _local: LocalOnly,
) -> Result<Json<SettingsDto>, ApiError> {
    Ok(Json(read_settings(&state).await?))
}

pub async fn put_settings(
    State(state): State<AppState>,
    _local: LocalOnly,
    Json(update): Json<SettingsUpdate>,
) -> Result<Json<SettingsDto>, ApiError> {
    if let Some(behavior) = &update.delete_behavior {
        if behavior != "index_only" && behavior != "delete_file" {
            return Err(ApiError::bad_request(
                "deleteBehavior must be \"index_only\" or \"delete_file\".",
            ));
        }
    }
    if let Some(port) = update.port {
        if port < 1024 {
            return Err(ApiError::bad_request(
                "Choose a port between 1024 and 65535.",
            ));
        }
    }
    let folder = match &update.photos_folder {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(ApiError::bad_request("The photos folder cannot be empty."));
            }
            let path = PathBuf::from(trimmed);
            if !path.is_absolute() {
                return Err(ApiError::bad_request(
                    "Enter the full path of the photos folder, for example D:\\Photos.",
                ));
            }
            std::fs::create_dir_all(&path).map_err(|error| {
                ApiError::bad_request(format!("That folder cannot be used: {error}"))
            })?;
            Some(path.to_string_lossy().into_owned())
        }
        None => None,
    };

    let mirror = match &update.mirror_folder {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Some(String::new())
            } else {
                let path = PathBuf::from(trimmed);
                if !path.is_absolute() {
                    return Err(ApiError::bad_request(
                        "Enter the full path of the mirror folder, for example E:\\PhotoBackup.",
                    ));
                }
                Some(path.to_string_lossy().into_owned())
            }
        }
        None => None,
    };
    if let Some(mirror) = mirror.as_deref().filter(|value| !value.is_empty()) {
        let photos = folder
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| state.photos_dir());
        if same_folder(&photos, std::path::Path::new(mirror)) {
            return Err(ApiError::bad_request(
                "The mirror folder must be different from the photos folder.",
            ));
        }
    }

    let next_folder = folder.clone();
    let mirror_to_start = mirror.clone().filter(|value| !value.is_empty());
    let writes = [
        ("delete_behavior", update.delete_behavior),
        ("photos_folder", folder),
        ("mirror_folder", mirror),
        ("port", update.port.map(|p| p.to_string())),
    ];
    for (key, value) in writes {
        if let Some(value) = value {
            sqlx::query(
                "INSERT INTO settings (key, value) VALUES (?, ?) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(key)
            .bind(value)
            .execute(&state.pool)
            .await?;
        }
    }

    if let Some(folder) = next_folder {
        let path = PathBuf::from(folder);
        state
            .retarget_watcher(&path)
            .map_err(|error| ApiError::internal(format!("Could not watch that folder: {error}")))?;
        state.set_photos_dir(path);
        // Files already in the new folder are indexed in the background.
        let scan_state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = crate::ingest::scan_existing(&scan_state).await {
                println!("Scan after folder change failed: {error}");
            }
        });
    }

    // A newly configured mirror gets a full copy of the existing library. When
    // the drive is unplugged this simply does nothing; the gallery shows the warning.
    if mirror_to_start.is_some() {
        let mirror_state = state.clone();
        tokio::spawn(async move {
            crate::mirror::backfill(&mirror_state).await;
        });
    }

    Ok(Json(read_settings(&state).await?))
}

// ---------------------------------------------------------------------------
// GET /local/status - summary shown in the gallery's status bar
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    pub asset_count: i64,
    pub photo_count: i64,
    pub video_count: i64,
    pub total_bytes: i64,
    pub device_count: i64,
    pub active_uploads: i64,
    pub last_activity_at: Option<String>,
    pub last_device_seen_at: Option<String>,
}

pub async fn status(
    State(state): State<AppState>,
    _local: LocalOnly,
) -> Result<Json<StatusDto>, ApiError> {
    let assets = sqlx::query(
        "SELECT COUNT(*) AS n, \
                COALESCE(SUM(CASE WHEN type = 'photo' THEN 1 ELSE 0 END), 0) AS photos, \
                COALESCE(SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END), 0) AS videos, \
                COALESCE(SUM(size), 0) AS bytes, \
                MAX(added_at) AS last_added \
         FROM assets WHERE hidden = 0",
    )
    .fetch_one(&state.pool)
    .await?;

    let devices = sqlx::query(
        "SELECT COUNT(*) AS n, MAX(last_seen_at) AS last_seen \
         FROM devices WHERE revoked = 0 AND id != ?",
    )
    .bind(LOCAL_DEVICE_ID)
    .fetch_one(&state.pool)
    .await?;

    let active = sqlx::query("SELECT COUNT(*) AS n FROM uploads WHERE status = 'in_progress'")
        .fetch_one(&state.pool)
        .await?;

    Ok(Json(StatusDto {
        asset_count: assets.get("n"),
        photo_count: assets.get("photos"),
        video_count: assets.get("videos"),
        total_bytes: assets.get("bytes"),
        device_count: devices.get("n"),
        active_uploads: active.get("n"),
        last_activity_at: assets.get("last_added"),
        last_device_seen_at: devices.get("last_seen"),
    }))
}

// ---------------------------------------------------------------------------
// GET/PUT /local/connection - Windows Firewall access for phones
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDto {
    pub allowed: bool,
    pub can_manage: bool,
    pub platform: String,
    pub port: u16,
    pub addresses: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ConnectionUpdate {
    pub allowed: bool,
}

fn connection_dto(state: &AppState) -> ConnectionDto {
    ConnectionDto {
        allowed: firewall::rule_exists(),
        can_manage: firewall::is_supported(),
        platform: std::env::consts::OS.to_string(),
        port: state.cfg.port,
        addresses: lan_addresses(),
    }
}

pub async fn get_connection(
    State(state): State<AppState>,
    _local: LocalOnly,
) -> Result<Json<ConnectionDto>, ApiError> {
    Ok(Json(connection_dto(&state)))
}

pub async fn set_connection(
    State(state): State<AppState>,
    _local: LocalOnly,
    Json(update): Json<ConnectionUpdate>,
) -> Result<Json<ConnectionDto>, ApiError> {
    if !firewall::is_supported() {
        return Err(ApiError::bad_request(
            "Phone connection control is only available on Windows.",
        ));
    }

    let allowed = update.allowed;
    let result = tokio::task::spawn_blocking(move || {
        if allowed {
            firewall::add_rule()
        } else {
            firewall::remove_rule()
        }
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;

    if !result.ok {
        return Err(ApiError::bad_request(result.message));
    }

    Ok(Json(connection_dto(&state)))
}

// ---------------------------------------------------------------------------
// GET/POST /local/pairing - QR contents for the desktop pairing window
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfoDto {
    pub version: u8,
    pub server_name: String,
    pub addresses: Vec<String>,
    pub port: u16,
    pub fingerprint: String,
    pub token: Option<String>,
    pub expires_at: Option<String>,
}

/// Non-loopback IPv4 addresses the phone can try, with a loopback fallback.
fn lan_addresses() -> Vec<String> {
    let mut addresses = Vec::new();
    let primary = primary_ipv4();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            let ip = interface.ip();
            if ip.is_loopback() || !ip.is_ipv4() {
                continue;
            }
            addresses.push(ip.to_string());
        }
    }
    addresses.sort();
    addresses.dedup();
    if let Some(primary) = primary {
        let primary = primary.to_string();
        addresses.sort_by_key(|address| address != &primary);
    }
    if addresses.is_empty() {
        addresses.push("127.0.0.1".to_string());
    }
    addresses
}

fn primary_ipv4() -> Option<std::net::IpAddr> {
    // Connecting a UDP socket performs a route lookup without sending packets.
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback()).then_some(ip)
}

/// Case-insensitive path comparison; Windows paths may use either separator.
fn same_folder(left: &std::path::Path, right: &std::path::Path) -> bool {
    let normalize = |path: &std::path::Path| {
        path.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_ascii_lowercase()
    };
    normalize(left) == normalize(right)
}

fn server_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "XueMint".to_string())
}

fn pairing_dto(
    state: &AppState,
    token: Option<String>,
    expires_at: Option<String>,
) -> Result<PairingInfoDto, ApiError> {
    let (cert_pem, _) =
        certs::ensure_cert(&state.cfg).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(PairingInfoDto {
        version: 1,
        server_name: server_name(),
        addresses: lan_addresses(),
        port: state.cfg.port,
        fingerprint: certs::fingerprint(&cert_pem)
            .map_err(|error| ApiError::internal(error.to_string()))?,
        token,
        expires_at,
    })
}

pub async fn pairing_info(
    State(state): State<AppState>,
    _local: LocalOnly,
) -> Result<Json<PairingInfoDto>, ApiError> {
    Ok(Json(pairing_dto(&state, None, None)?))
}

pub async fn pairing_code(
    State(state): State<AppState>,
    _local: LocalOnly,
) -> Result<Json<PairingInfoDto>, ApiError> {
    const TTL_SECS: i64 = 10 * 60;
    // A new QR supersedes older unused ones, so only the code on screen works.
    sqlx::query("DELETE FROM pairing_tokens WHERE used = 0")
        .execute(&state.pool)
        .await?;
    let token = tokens::create_token(&state.pool, TTL_SECS)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let expires_at = (Utc::now() + chrono::Duration::seconds(TTL_SECS))
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    Ok(Json(pairing_dto(&state, Some(token), Some(expires_at))?))
}

/// Request body for the factory reset.
#[derive(Debug, Deserialize)]
pub struct FactoryResetRequest {
    /// Also delete the photo files stored in the watched folder.
    #[serde(default)]
    pub delete_files: bool,
}

/// Removes every file and subdirectory inside a folder, keeping the folder.
/// Returns how many files were removed.
fn clear_dir_contents(dir: &std::path::Path) -> std::io::Result<usize> {
    let mut removed = 0usize;
    if !dir.is_dir() {
        return Ok(0);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else if path.is_file() {
            std::fs::remove_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// POST /local/factory-reset — wipes everything the server stores: the asset
/// index, upload sessions, cached thumbnails and temp files, pairing tokens
/// and every paired device. With `deleteFiles`, the photo files inside the
/// watched folder are removed too. Folder, port and TLS identity are kept:
/// they are configuration, not data.
pub async fn factory_reset(
    State(state): State<AppState>,
    _local: LocalOnly,
    Json(request): Json<FactoryResetRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let files_removed = wipe_library(&state, request.delete_files).await?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "filesRemoved": files_removed,
    })))
}

/// The actual wipe, shared by the gallery button and the phone request.
pub(crate) async fn wipe_library(state: &AppState, delete_files: bool) -> Result<usize, ApiError> {
    let stored_paths: Vec<String> = sqlx::query("SELECT path FROM assets")
        .fetch_all(&state.pool)
        .await?
        .into_iter()
        .filter_map(|row| row.try_get(0).ok())
        .collect();

    sqlx::query("DELETE FROM uploads")
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM assets")
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM pairing_tokens")
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM devices WHERE id != ?")
        .bind(LOCAL_DEVICE_ID)
        .execute(&state.pool)
        .await?;

    let mut files_removed = 0usize;
    if delete_files {
        for stored_path in &stored_paths {
            crate::mirror::remove_stored(state, stored_path).await;
        }
        files_removed = clear_dir_contents(&state.photos_dir())
            .map_err(|error| ApiError::internal(error.to_string()))?;
    }
    clear_dir_contents(&state.cfg.thumbs_dir())
        .map_err(|error| ApiError::internal(error.to_string()))?;
    clear_dir_contents(&state.cfg.tmp_dir())
        .map_err(|error| ApiError::internal(error.to_string()))?;

    println!("Factory reset: library wiped, {files_removed} watched file(s) removed");
    Ok(files_removed)
}

/// A paired phone asks for a full ecosystem reset: the PC library, stored
/// photos, thumbnails, pairing tokens and all devices go away. The caller
/// wipes its own engine right after, so its credential stops working.
pub async fn device_reset(
    State(state): State<AppState>,
    _device: crate::auth::Device,
) -> Result<Json<serde_json::Value>, ApiError> {
    let files_removed = wipe_library(&state, true).await?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "filesRemoved": files_removed,
    })))
}
/// Response of a successful local import.
#[derive(Debug, Serialize)]
pub struct ImportDto {
    pub id: String,
    pub filename: String,
    pub duplicate: bool,
}

/// POST /local/import — adds a photo or video picked in the gallery to the
/// library. The file arrives as the raw request body with the original name
/// in an `x-filename` header; it is stored like any upload and indexed, so
/// phones see it in their timeline too.
pub async fn import_asset(
    State(state): State<AppState>,
    _local: LocalOnly,
    headers: axum::http::HeaderMap,
    body: axum::body::Body,
) -> Result<Json<ImportDto>, ApiError> {
    let filename = headers
        .get("x-filename")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            let decoded = percent_encoding::percent_decode_str(value).decode_utf8_lossy();
            crate::media::clean_display_name(&decoded)
        })
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| ApiError::bad_request("x-filename header is required"))?;
    let ext = std::path::Path::new(&filename)
        .extension()
        .map(|extension| crate::media::sanitize_ext(&extension.to_string_lossy()))
        .unwrap_or_default();
    if !crate::media::is_watched_ext(&ext) {
        return Err(ApiError::bad_request(
            "Only photo and video files can be added.",
        ));
    }

    let mut bytes = body.into_data_stream();
    let temp_path =
        state
            .cfg
            .tmp_dir()
            .join(format!("import-{}.{}", uuid::Uuid::new_v4().simple(), ext));
    {
        let mut file = tokio::fs::File::create(&temp_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        while let Some(frame) = http_body_util::BodyExt::frame(&mut bytes).await {
            let chunk = frame
                .map_err(ApiError::internal)?
                .into_data()
                .map_err(|_| ApiError::bad_request("Unexpected non-data frame in upload body"))?;
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
    }

    let hash = crate::media::hash_file_blocking(&temp_path)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let finalized = crate::api::assets::finalize_upload(
        &state.photos_dir(),
        &temp_path,
        &hash.to_lowercase(),
        Some(filename.clone()),
    )?;

    // Index the stored file so the row and thumbnail exist like any upload.
    crate::ingest::ingest_file(&state, &finalized.dest)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let hash_lower = hash.to_lowercase();
    let id: Option<String> = sqlx::query("SELECT id FROM assets WHERE hash = ?")
        .bind(&hash_lower)
        .fetch_optional(&state.pool)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .and_then(|row| row.try_get(0).ok());
    let id = id.ok_or_else(|| ApiError::internal("imported file was not indexed"))?;
    // The ingest names rows after the stored file; keep the friendly name.
    sqlx::query("UPDATE assets SET filename = ? WHERE id = ?")
        .bind(&filename)
        .bind(&id)
        .execute(&state.pool)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let stored_path: Option<String> = sqlx::query("SELECT path FROM assets WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .and_then(|row| row.try_get(0).ok());
    if let Some(stored_path) = stored_path {
        crate::api::assets::link_uploaded_companions(&state, &id, &filename, &stored_path).await;
    }

    println!(
        "Imported {} ({})",
        filename,
        if finalized.preexisting {
            "duplicate, indexed"
        } else {
            "indexed"
        }
    );
    Ok(Json(ImportDto {
        id,
        filename,
        duplicate: finalized.preexisting,
    }))
}
