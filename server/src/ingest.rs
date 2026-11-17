//! Ingest: the shared routine that turns a photo/video file on disk into a
//! database row plus a thumbnail. Used by both the upload finalization and the
//! folder watcher, so both paths behave identically.

use crate::media::{self, exif, thumbs};
use crate::state::AppState;
use std::path::{Path, PathBuf};

/// Indexes a file: hashes it, records metadata, generates a thumbnail.
/// Skips silently when the same path or the same hash is already indexed.
pub async fn ingest_file(state: &AppState, path: &Path) -> anyhow::Result<()> {
    let Some(file_name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Ok(());
    };

    // Same path already indexed? Then there is nothing new to do.
    let path_text = path.to_string_lossy();
    let path_taken = sqlx::query("SELECT 1 FROM assets WHERE path = ?")
        .bind(path_text.as_ref())
        .fetch_optional(&state.pool)
        .await?
        .is_some();
    if path_taken {
        return Ok(());
    }

    let hash = media::hash_file_blocking(path)?;
    let hash = hash.to_lowercase();

    // Same content already indexed from another location? Keep the first copy.
    let hash_taken = sqlx::query("SELECT 1 FROM assets WHERE hash = ?")
        .bind(&hash)
        .fetch_optional(&state.pool)
        .await?
        .is_some();
    if hash_taken {
        return Ok(());
    }

    let ext = media::ext_of(path);
    let asset_type = media::classify(&ext);
    let is_video = asset_type == "video";
    let size = std::fs::metadata(path)?.len() as i64;

    let meta = if is_video { None } else { exif::read(path) };
    let taken_at = meta.as_ref().and_then(|m| m.taken_at.clone());
    let gps = meta.as_ref().and_then(|m| m.gps.clone());
    let orientation = meta.as_ref().map(|m| m.orientation).unwrap_or(1);

    let (width, height) = if is_video {
        (None, None)
    } else {
        match image::ImageReader::open(path).ok().and_then(|r| r.into_dimensions().ok()) {
            Some((w, h)) => (Some(w as i64), Some(h as i64)),
            None => (None, None),
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let added_at = media::now_iso();
    let result = sqlx::query(
        "INSERT OR IGNORE INTO assets (id, hash, filename, type, size, taken_at, gps, width, height, path, added_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&hash)
    .bind(&file_name)
    .bind(asset_type)
    .bind(size)
    .bind(&taken_at)
    .bind(&gps)
    .bind(width)
    .bind(height)
    .bind(path_text.as_ref())
    .bind(&added_at)
    .execute(&state.pool)
    .await?;

    if result.rows_affected() == 0 {
        // Another ingest won the race; nothing to do.
        return Ok(());
    }

    thumbs::generate(state, path, &hash, is_video, orientation).await;
    println!("Indexed {file_name} ({hash})");
    Ok(())
}

/// Walks the photos folder recursively and indexes anything not yet in the
/// database. Called once at startup, before the live watcher takes over.
pub async fn scan_existing(state: &AppState) -> anyhow::Result<()> {
    let mut files = Vec::new();
    walk(&state.cfg.photos_dir, &mut files)?;
    let mut count = 0usize;
    for path in files {
        let ext = media::ext_of(&path);
        if !media::is_watched_ext(&ext) {
            continue;
        }
        if ingest_file(state, &path).await.is_ok() {
            count += 1;
        }
    }
    if count > 0 {
        println!("Startup scan indexed {count} new file(s).");
    }
    Ok(())
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}
