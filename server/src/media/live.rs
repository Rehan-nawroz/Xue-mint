//! Live Photo companions: the still image and its short video live beside each
//! other and share a file stem (`IMG_1234.HEIC` + `IMG_1234.MOV`). The still is
//! the one visible timeline asset; the video is linked to it instead of being
//! indexed as a second item with its own date.
//!
//! Only file-system discovery lives here; the database link is applied by the
//! ingest and upload paths once both rows are known.

use crate::media::VIDEO_EXTS;
use std::path::{Path, PathBuf};

/// Still formats that can own a Live Photo companion video.
const STILL_EXTS: [&str; 8] = ["heic", "heif", "hif", "jpg", "jpeg", "png", "tif", "tiff"];

/// The video paired with a still, when both files sit in the same folder.
pub fn video_companion_for_photo(photo: &Path) -> Option<PathBuf> {
    companion(photo, &VIDEO_EXTS)
}

/// The still paired with a video, when both files sit in the same folder.
pub fn photo_companion_for_video(video: &Path) -> Option<PathBuf> {
    companion(video, &STILL_EXTS)
}

fn companion(path: &Path, extensions: &[&str]) -> Option<PathBuf> {
    let stem = path.file_stem()?.to_string_lossy();
    if stem.trim().is_empty() {
        return None;
    }
    let dir = path.parent()?;
    for extension in extensions {
        for variant in [
            extension.to_ascii_lowercase(),
            extension.to_ascii_uppercase(),
        ] {
            let candidate = dir.join(format!("{stem}.{variant}"));
            if candidate != path && candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Lowercased file stem, used to match an uploaded image and video by their
/// friendly file names.
pub fn lowered_stem(filename: &str) -> Option<String> {
    Path::new(filename)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_lowercase())
        .filter(|stem| !stem.trim().is_empty())
}
