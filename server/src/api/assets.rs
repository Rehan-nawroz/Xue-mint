//! Asset endpoints: hash check, resumable chunked upload, timeline, thumbnails,
//! originals, delete.

use crate::auth::Device;
use crate::db::get_setting;
use crate::errors::ApiError;
use crate::media::{self, thumbs};
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use http_body_util::BodyExt;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::io::SeekFrom;
use std::path::PathBuf;

use tokio::io::AsyncWriteExt;

// ---------------------------------------------------------------------------
// POST /assets/check — the phone asks which hashes are missing
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CheckRequest {
    pub hashes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CheckResponse {
    pub missing: Vec<String>,
}

pub async fn check(
    State(state): State<AppState>,
    _device: Device,
    Json(request): Json<CheckRequest>,
) -> Result<Json<CheckResponse>, ApiError> {
    let mut requested = std::collections::HashSet::new();
    for hash in &request.hashes {
        requested.insert(hash.to_lowercase());
    }

    let mut present = std::collections::HashSet::new();
    for chunk in request.hashes.chunks(500) {
        let mut sql = String::from("SELECT hash FROM assets WHERE hash IN (");
        for (i, _) in chunk.iter().enumerate() {
            if i > 0 {
                sql.push(',');
            }
            sql.push('?');
        }
        sql.push(')');

        let mut query = sqlx::query(&sql);
        for hash in chunk {
            query = query.bind(hash.to_lowercase());
        }
        for row in query.fetch_all(&state.pool).await? {
            present.insert(row.get::<String, _>("hash"));
        }
    }

    let missing: Vec<String> = requested.difference(&present).cloned().collect();
    Ok(Json(CheckResponse { missing }))
}

// ---------------------------------------------------------------------------
// PUT /assets/upload/{hash} — resumable, chunked, streamed to disk
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct UploadParams {
    #[serde(rename = "final")]
    pub is_final: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResponse {
    pub stored: bool,
    pub duplicate: Option<bool>,
    pub offset: Option<i64>,
}

pub async fn upload(
    State(state): State<AppState>,
    device: Device,
    Path(hash): Path<String>,
    headers: HeaderMap,
    Query(params): Query<UploadParams>,
    mut body: Body,
) -> Result<Json<UploadResponse>, ApiError> {
    let hash = hash.to_lowercase();
    if !media::is_valid_hash(&hash) {
        return Err(ApiError::bad_request("hash must be a 64-character BLAKE3 hex digest"));
    }

    let offset: i64 = header_i64(&headers, "offset").unwrap_or(0);
    if offset < 0 {
        return Err(ApiError::bad_request("Offset must not be negative"));
    }
    let total: i64 = header_i64(&headers, "x-total").unwrap_or(0);
    let filename: Option<String> = headers
        .get("x-filename")
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_encoding::percent_decode_str(value).decode_utf8_lossy().into_owned());

    // Content already stored? Drain the body (the client may still be sending)
    // and answer "duplicate".
    if asset_row_by_hash(&state.pool, &hash).await?.is_some() {
        while let Some(frame) = body.frame().await {
            let _ = frame.map_err(ApiError::internal)?;
        }
        return Ok(Json(UploadResponse { stored: true, duplicate: Some(true), offset: None }));
    }

    // Find or create the resumable upload session.
    let row = sqlx::query(
        "SELECT id, offset FROM uploads \
         WHERE device_id = ? AND hash = ? AND status = 'in_progress' \
         ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(&device.id)
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;

    let upload_id = match row {
        Some(row) => {
            let stored_offset: i64 = row.get("offset");
            if offset != stored_offset {
                return Err(ApiError::offset_mismatch(stored_offset));
            }
            row.get::<String, _>("id")
        }
        None if offset == 0 => {
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO uploads (id, device_id, hash, offset, total, status, updated_at) \
                 VALUES (?, ?, ?, 0, ?, 'in_progress', ?)",
            )
            .bind(&id)
            .bind(&device.id)
            .bind(&hash)
            .bind(total)
            .bind(media::now_iso())
            .execute(&state.pool)
            .await?;
            id
        }
        None => return Err(ApiError::offset_mismatch(0)),
    };

    // Write the chunk to the temp file. Truncating to the requested offset makes
    // every request self-correcting after an aborted transfer.
    let temp_path = state.cfg.tmp_dir().join(format!("{upload_id}.part"));
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&temp_path)
        .await?;
    use tokio::io::AsyncSeekExt;
    file.set_len(offset as u64).await?;
    file.seek(SeekFrom::End(0)).await?;

    let mut written: i64 = 0;
    while let Some(frame) = body.frame().await {
        let chunk = frame.map_err(ApiError::internal)?.into_data().map_err(|_| {
            ApiError::bad_request("Unexpected non-data frame in upload body")
        })?;
        file.write_all(&chunk).await?;
        written += chunk.len() as i64;
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);

    let new_offset = offset + written;
    sqlx::query(
        "UPDATE uploads SET offset = ?, total = CASE WHEN ? > 0 THEN ? ELSE total END, updated_at = ? WHERE id = ?",
    )
    .bind(new_offset)
    .bind(total)
    .bind(total)
    .bind(media::now_iso())
    .bind(&upload_id)
    .execute(&state.pool)
    .await?;

    let is_final = matches!(params.is_final.as_deref(), Some("1") | Some("true"))
        || (total > 0 && new_offset >= total);

    if !is_final {
        return Ok(Json(UploadResponse { stored: false, duplicate: None, offset: Some(new_offset) }));
    }

    // Finalize: verify the hash, move the temp file into the photos folder,
    // record the asset, generate the thumbnail. All on a blocking thread.
    let cfg = state.cfg.clone();
    let finalize_hash = hash.clone();
    let finalize_result = tokio::task::spawn_blocking(move || {
        finalize_upload(&cfg, &temp_path, &finalize_hash, filename)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;
    let finalize_result = finalize_result?;

    if finalize_result.duplicate {
        mark_upload_complete(&state.pool, &upload_id).await?;
        return Ok(Json(UploadResponse { stored: true, duplicate: Some(true), offset: None }));
    }

    let is_video = media::is_video_ext(&finalize_result.ext);
    let added_at = media::now_iso();
    let result = sqlx::query(
        "INSERT OR IGNORE INTO assets (id, hash, filename, type, size, taken_at, gps, width, height, path, added_at) \
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&hash)
    .bind(&finalize_result.original_name)
    .bind(media::classify(&finalize_result.ext))
    .bind(finalize_result.size)
    .bind(finalize_result.width)
    .bind(finalize_result.height)
    .bind(&finalize_result.rel_path)
    .bind(&added_at)
    .execute(&state.pool)
    .await?;

    if result.rows_affected() == 0 {
        // A concurrent ingest indexed the same hash first; drop our duplicate file.
        let _ = std::fs::remove_file(&finalize_result.dest);
        mark_upload_complete(&state.pool, &upload_id).await?;
        return Ok(Json(UploadResponse { stored: true, duplicate: Some(true), offset: None }));
    }

    let asset_path = state.cfg.photos_dir.join(&finalize_result.rel_path);
    thumbs::generate(&state, &asset_path, &hash, is_video, 1).await;

    mark_upload_complete(&state.pool, &upload_id).await?;
    println!("Stored {hash} ({} bytes)", finalize_result.size);
    Ok(Json(UploadResponse { stored: true, duplicate: Some(false), offset: None }))
}

/// Runs on a blocking thread: hash-verify, move into the photos folder.
struct FinalizedUpload {
    duplicate: bool,
    dest: PathBuf,
    rel_path: String,
    original_name: Option<String>,
    ext: String,
    size: i64,
    width: Option<i64>,
    height: Option<i64>,
}

fn finalize_upload(
    cfg: &crate::config::Config,
    temp_path: &std::path::Path,
    hash: &str,
    filename: Option<String>,
) -> Result<FinalizedUpload, ApiError> {
    let actual = media::hash_file_blocking(temp_path)?;
    if actual != hash {
        std::fs::remove_file(temp_path)?;
        return Err(ApiError::hash_mismatch());
    }

    let sanitized_name = filename.as_deref().and_then(|name| {
        std::path::Path::new(name)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
    });
    let ext = filename
        .as_deref()
        .and_then(|name| std::path::Path::new(name).extension())
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "bin".to_string());
    let disk_name = format!("{hash}.{ext}");
    let rel_path = format!("{}/{hash}.{ext}", &hash[..2]);
    let dest = cfg.photos_dir.join(&rel_path);

    std::fs::create_dir_all(dest.parent().unwrap())?;
    if dest.exists() {
        // Same content is already on disk under the same canonical name.
        std::fs::remove_file(temp_path)?;
        return Ok(FinalizedUpload {
            duplicate: true,
            dest,
            rel_path,
            original_name: sanitized_name,
            ext,
            size: 0,
            width: None,
            height: None,
        });
    }
    move_or_copy(temp_path, &dest)?;

    let size = std::fs::metadata(&dest)?.len() as i64;
    let (width, height) = if media::is_video_ext(&ext) {
        (None, None)
    } else {
        match image::ImageReader::open(&dest).ok().and_then(|r| r.into_dimensions().ok()) {
            Some((w, h)) => (Some(w as i64), Some(h as i64)),
            None => (None, None),
        }
    };

    Ok(FinalizedUpload {
        duplicate: false,
        dest,
        rel_path,
        original_name: sanitized_name,
        ext,
        size,
        width,
        height,
    })
}

fn move_or_copy(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Different drives: copy then delete.
            std::fs::copy(from, to)?;
            std::fs::remove_file(from)?;
            Ok(())
        }
    }
}

async fn mark_upload_complete(pool: &sqlx::SqlitePool, upload_id: &str) -> Result<(), ApiError> {
    sqlx::query("UPDATE uploads SET status = 'complete', updated_at = ? WHERE id = ?")
        .bind(media::now_iso())
        .bind(upload_id)
        .execute(pool)
        .await?;
    Ok(())
}

fn header_i64(headers: &HeaderMap, name: &str) -> Option<i64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
}

// ---------------------------------------------------------------------------
// GET /assets — timeline, cursor-paginated, newest first
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineParams {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDto {
    pub id: String,
    pub hash: String,
    pub filename: Option<String>,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub size: i64,
    pub taken_at: Option<String>,
    pub gps: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub added_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineResponse {
    pub items: Vec<AssetDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct Cursor {
    k: String,
    i: String,
}

pub async fn timeline(
    State(state): State<AppState>,
    _device: Device,
    Query(params): Query<TimelineParams>,
) -> Result<Json<TimelineResponse>, ApiError> {
    let limit = params.limit.unwrap_or(200).clamp(1, 500);

    let cursor = decode_cursor(params.cursor.as_deref())?;
    let select = "SELECT id, hash, filename, type, size, taken_at, gps, width, height, added_at FROM assets";

    let (sql, cursor_binds) = match &cursor {
        Some(_) => (
            format!(
                "{select} WHERE (COALESCE(taken_at, added_at) < ?1 \
                 OR (COALESCE(taken_at, added_at) = ?1 AND id < ?2)) \
                 ORDER BY COALESCE(taken_at, added_at) DESC, id DESC LIMIT ?3"
            ),
            true,
        ),
        None => (
            format!(
                "{select} ORDER BY COALESCE(taken_at, added_at) DESC, id DESC LIMIT ?1"
            ),
            false,
        ),
    };

    let mut query = sqlx::query(&sql);
    if let Some(decoded) = cursor {
        query = query.bind(decoded.k).bind(decoded.i);
    }
    // Fetch one extra row to learn whether a next page exists.
    let query = query.bind(limit + 1);
    let mut rows = query.fetch_all(&state.pool).await?;

    let has_next = rows.len() as i64 > limit;
    if has_next {
        rows.truncate(limit as usize);
    }
    let items: Vec<AssetDto> = rows
        .iter()
        .map(|row| AssetDto {
            id: row.get("id"),
            hash: row.get("hash"),
            filename: row.get("filename"),
            asset_type: row.get("type"),
            size: row.get("size"),
            taken_at: row.get("taken_at"),
            gps: row.get("gps"),
            width: row.get("width"),
            height: row.get("height"),
            added_at: row.get("added_at"),
        })
        .collect();

    let next_cursor = if has_next {
        items.last().map(|last| {
            let cursor = Cursor {
                k: last.taken_at.clone().unwrap_or_else(|| last.added_at.clone()),
                i: last.id.clone(),
            };
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap_or_default())
        })
    } else {
        None
    };

    Ok(Json(TimelineResponse { items, next_cursor }))
}

fn decode_cursor(raw: Option<&str>) -> Result<Option<Cursor>, ApiError> {
    let Some(raw) = raw else { return Ok(None) };
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.trim())
        .map_err(|_| ApiError::bad_request("Invalid cursor"))?;
    let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("Invalid cursor"))?;
    Ok(Some(cursor))
}

// ---------------------------------------------------------------------------
// GET /assets/{id}/thumb and /original
// ---------------------------------------------------------------------------

pub async fn thumb(
    State(state): State<AppState>,
    _device: Device,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let asset = asset_row_by_id(&state.pool, &id).await?.ok_or_else(|| {
        ApiError::not_found("ASSET_NOT_FOUND", "No such asset.")
    })?;
    let hash: String = asset.get("hash");
    let path = state.cfg.thumbs_dir().join(format!("{hash}.jpg"));
    if !path.exists() {
        return Err(ApiError::not_found("ASSET_NOT_FOUND", "Thumbnail not ready."));
    }
    let bytes = tokio::fs::read(&path).await?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response())
}

pub async fn original(
    State(state): State<AppState>,
    _device: Device,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let asset = asset_row_by_id(&state.pool, &id).await?.ok_or_else(|| {
        ApiError::not_found("ASSET_NOT_FOUND", "No such asset.")
    })?;
    let rel_path: String = asset.get("path");
    let ext = media::ext_of(std::path::Path::new(&rel_path));
    let path = state.cfg.photos_dir.join(&rel_path);
    let file = tokio::fs::File::open(&path).await?;
    let stream = tokio_util::io::ReaderStream::new(file);
    Ok((
        [(header::CONTENT_TYPE, media::content_type_for(&ext))],
        Body::from_stream(stream),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// DELETE /assets/{id}
// ---------------------------------------------------------------------------

pub async fn delete_asset(
    State(state): State<AppState>,
    _device: Device,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let asset = asset_row_by_id(&state.pool, &id).await?.ok_or_else(|| {
        ApiError::not_found("ASSET_NOT_FOUND", "No such asset.")
    })?;
    let hash: String = asset.get("hash");
    let rel_path: String = asset.get("path");

    let behavior = get_setting(&state.pool, "delete_behavior").await?.unwrap_or_default();
    if behavior == "delete_file" {
        let _ = std::fs::remove_file(state.cfg.photos_dir.join(&rel_path));
        let _ = std::fs::remove_file(state.cfg.thumbs_dir().join(format!("{hash}.jpg")));
    }

    sqlx::query("DELETE FROM assets WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

pub async fn asset_row_by_hash(
    pool: &sqlx::SqlitePool,
    hash: &str,
) -> Result<Option<sqlx::sqlite::SqliteRow>, ApiError> {
    Ok(sqlx::query("SELECT id, hash FROM assets WHERE hash = ?")
        .bind(hash)
        .fetch_optional(pool)
        .await?)
}

async fn asset_row_by_id(
    pool: &sqlx::SqlitePool,
    id: &str,
) -> Result<Option<sqlx::sqlite::SqliteRow>, ApiError> {
    Ok(sqlx::query("SELECT id, hash, path FROM assets WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?)
}
