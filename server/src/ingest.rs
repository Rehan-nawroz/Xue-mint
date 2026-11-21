//! Ingest: the shared routine that turns a photo/video file on disk into a
//! database row plus a thumbnail. Used by both the upload finalization and the
//! folder watcher, so both paths behave identically.

use crate::media::{self, exif, intake, live, thumbs};
use crate::mirror;
use crate::state::AppState;
use sqlx::Row;
use std::path::{Path, PathBuf};

/// Indexes a file: hashes it, records metadata, generates a thumbnail.
/// Skips silently when the same path or the same hash is already indexed.
pub async fn ingest_file(state: &AppState, path: &Path) -> anyhow::Result<()> {
    let Some(file_name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Ok(());
    };

    let ext = media::ext_of(path);
    let asset_type = media::classify(&ext);
    let is_video = asset_type == "video";

    // A Live Photo's video is not a timeline item of its own. Its still image
    // either already exists (linked below) or will arrive right after.
    if is_video && live::photo_companion_for_video(path).is_some() {
        return Ok(());
    }

    // Same path already indexed? Then there is nothing new to do, though a
    // newly arrived still may still need to link its already-indexed video.
    let path_text = path.to_string_lossy();
    let existing_id: Option<String> = sqlx::query("SELECT id FROM assets WHERE path = ?")
        .bind(path_text.as_ref())
        .fetch_optional(&state.pool)
        .await?
        .map(|row| row.get("id"));
    if let Some(id) = existing_id {
        if !is_video {
            link_video_companion(state, &id, path).await;
        }
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

    let size = std::fs::metadata(path)?.len() as i64;

    let meta = if is_video { None } else { exif::read(path) };
    let taken_at = meta
        .as_ref()
        .and_then(|metadata| metadata.taken_at.clone())
        .or_else(|| media::file_date(path));
    let gps = meta.as_ref().and_then(|metadata| metadata.gps.clone());
    let orientation = meta
        .as_ref()
        .map(|metadata| metadata.orientation)
        .unwrap_or(1);

    let (width, height) = match intake::dimensions(path) {
        Some((width, height)) => {
            // HEIF rotation properties are already applied by the decoder.
            if (5..=8).contains(&orientation) && !media::is_heic_ext(&ext) {
                (Some(height as i64), Some(width as i64))
            } else {
                (Some(width as i64), Some(height as i64))
            }
        }
        None => (None, None),
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

    if !is_video {
        link_video_companion(state, &id, path).await;
    }

    thumbs::generate(state, path, &hash, is_video, orientation).await;
    mirror::copy_stored(state, path, path_text.as_ref()).await;
    println!("Indexed {file_name} ({hash})");
    Ok(())
}

/// Links an already-indexed companion video to the still that just arrived, so
/// the pair shows up once, dated by the still.
async fn link_video_companion(state: &AppState, photo_id: &str, photo_path: &Path) {
    let Some(video_path) = live::video_companion_for_photo(photo_path) else {
        return;
    };
    let video_text = video_path.to_string_lossy().into_owned();
    // Windows file names are case-insensitive: the discovered companion may be
    // spelled `IMG_0001.mov` while the indexed file is `IMG_0001.MOV`.
    let video =
        sqlx::query("SELECT id, path FROM assets WHERE path = ? COLLATE NOCASE AND type = 'video'")
            .bind(&video_text)
            .fetch_optional(&state.pool)
            .await;
    let Ok(Some(row)) = video else { return };
    let video_id: String = row.get("id");
    let stored_video_path: String = row.get("path");
    let _ = sqlx::query("UPDATE assets SET hidden = 1 WHERE id = ?")
        .bind(&video_id)
        .execute(&state.pool)
        .await;
    let _ = sqlx::query("UPDATE assets SET live_video_path = ? WHERE id = ?")
        .bind(&stored_video_path)
        .bind(photo_id)
        .execute(&state.pool)
        .await;
}

/// Walks the photos folder recursively and indexes anything not yet in the
/// database. Called once at startup, before the live watcher takes over.
pub async fn scan_existing(state: &AppState) -> anyhow::Result<()> {
    let mut files = Vec::new();
    walk(&state.photos_dir(), &mut files)?;
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
