//! Optional mirror: every stored photo is copied into a second folder (often an
//! external drive) so a second copy exists without a cloud service.
//!
//! The mirror is best-effort by design. When the drive is unplugged the setting
//! stays saved, new photos simply skip the copy, and the gallery warns that the
//! mirror is not reachable. Nothing is ever deleted from the library because a
//! mirror copy failed.

use crate::db::get_setting;
use crate::state::AppState;
use sqlx::Row;
use std::path::{Component, Path, PathBuf};

const SETTING: &str = "mirror_folder";

/// Folder configured for mirroring, if any.
pub async fn configured_folder(state: &AppState) -> Option<PathBuf> {
    get_setting(&state.pool, SETTING)
        .await
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Relative location of a stored asset inside the mirror, or None when the
/// stored path is outside the photos folder or would escape the mirror root.
pub fn relative_for(state: &AppState, stored_path: &str) -> Option<PathBuf> {
    let path = Path::new(stored_path);
    let relative = if path.is_absolute() {
        path.strip_prefix(state.photos_dir()).ok()?.to_path_buf()
    } else {
        path.to_path_buf()
    };
    let safe = !relative.as_os_str().is_empty()
        && relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    safe.then_some(relative)
}

/// Copies an indexed file to the mirror. Silently skips when no mirror is set
/// or its folder is not reachable right now.
pub async fn copy_stored(state: &AppState, source: &Path, stored_path: &str) {
    let Some(relative) = relative_for(state, stored_path) else {
        return;
    };
    copy(state, source, &relative).await;
}

pub async fn copy(state: &AppState, source: &Path, relative: &Path) {
    let Some(root) = configured_folder(state).await else {
        return;
    };
    if !root.is_dir() {
        // Unplugged drive or unmounted share: skip and leave the library intact.
        return;
    }
    let source = source.to_path_buf();
    let relative = relative.to_path_buf();
    let label = relative.to_string_lossy().into_owned();
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let destination = root.join(&relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&source, &destination)?;
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => println!("Mirror copy failed for {label}: {error}"),
        Err(error) => println!("Mirror task failed for {label}: {error}"),
    }
}

/// Removes a mirrored copy after the library file is deleted.
pub async fn remove_stored(state: &AppState, stored_path: &str) {
    let Some(root) = configured_folder(state).await else {
        return;
    };
    if !root.is_dir() {
        return;
    }
    let Some(relative) = relative_for(state, stored_path) else {
        return;
    };
    let _ = tokio::fs::remove_file(root.join(relative)).await;
}

/// Keeps the mirrored copy in step with a rename in the photos folder.
pub async fn rename_stored(state: &AppState, old_stored: &str, new_stored: &str) {
    let Some(root) = configured_folder(state).await else {
        return;
    };
    if !root.is_dir() {
        return;
    }
    let (Some(old_relative), Some(new_relative)) = (
        relative_for(state, old_stored),
        relative_for(state, new_stored),
    ) else {
        return;
    };
    let old_path = root.join(old_relative);
    let new_path = root.join(new_relative);
    if !old_path.is_file() {
        return;
    }
    if let Some(parent) = new_path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return;
        }
    }
    if tokio::fs::rename(&old_path, &new_path).await.is_err() {
        // Different drives or a transient lock: fall back to copy + remove.
        if tokio::fs::copy(&old_path, &new_path).await.is_ok() {
            let _ = tokio::fs::remove_file(&old_path).await;
        }
    }
}

/// Copies every indexed file that is not in the mirror yet. Runs in the
/// background when a mirror folder is first saved, or when the server starts
/// with a mirror configured and connected.
pub async fn backfill(state: &AppState) {
    let Some(root) = configured_folder(state).await else {
        return;
    };
    if !root.is_dir() {
        return;
    }
    let rows = match sqlx::query("SELECT path FROM assets")
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            println!("Mirror backfill could not read the library: {error}");
            return;
        }
    };
    let mut copied = 0usize;
    for row in rows {
        let stored_path: String = match row.try_get("path") {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(relative) = relative_for(state, &stored_path) else {
            continue;
        };
        let destination = root.join(&relative);
        if destination.exists() {
            continue;
        }
        let source = Path::new(&stored_path);
        let source = if source.is_absolute() {
            source.to_path_buf()
        } else {
            state.photos_dir().join(source)
        };
        if !source.is_file() {
            continue;
        }
        let destination_for_task = destination.clone();
        let result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            if let Some(parent) = destination_for_task.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&source, &destination_for_task)?;
            Ok(())
        })
        .await;
        if matches!(result, Ok(Ok(()))) {
            copied += 1;
        }
    }
    if copied > 0 {
        println!("Mirror backfill copied {copied} file(s)");
    }
}
