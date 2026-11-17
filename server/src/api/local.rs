//! Endpoints used only by the gallery running on this PC.
//!
//! These answer only to connections that come from the PC itself (loopback), so a
//! phone or any other machine on the network can never open a gallery session,
//! change settings, or read desktop-only status.

use crate::auth::SESSION_COOKIE;
use crate::db::get_setting;
use crate::errors::ApiError;
use crate::media::{now_iso, sha256_hex};
use crate::state::AppState;
use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
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
    pub port: Option<u16>,
}

async fn read_settings(state: &AppState) -> Result<SettingsDto, ApiError> {
    let delete_behavior = get_setting(&state.pool, "delete_behavior")
        .await?
        .unwrap_or_else(|| "index_only".to_string());

    let active_photos = state.cfg.photos_dir.clone();
    let stored_folder = get_setting(&state.pool, "photos_folder").await?;
    let photos_folder = stored_folder
        .clone()
        .unwrap_or_else(|| active_photos.to_string_lossy().into_owned());

    let stored_port = get_setting(&state.pool, "port")
        .await?
        .and_then(|value| value.parse::<u16>().ok());
    let port = stored_port.unwrap_or(state.cfg.port);

    let restart_required = PathBuf::from(&photos_folder) != active_photos || port != state.cfg.port;

    Ok(SettingsDto {
        delete_behavior,
        photos_folder,
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

    let writes = [
        ("delete_behavior", update.delete_behavior),
        ("photos_folder", folder),
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
         FROM assets",
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
