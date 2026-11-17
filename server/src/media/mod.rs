//! Small shared helpers: time formatting, hashing, media type classification.

pub mod exif;
pub mod thumbs;

use sha2::Digest;
use std::path::Path;

/// Current UTC time in the compact ISO format used across the schema
/// (`YYYY-MM-DDTHH:MM:SSZ`), chosen so plain string comparison sorts correctly.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// SHA-256 as lowercase hex (used to hash device credentials at rest).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha2::Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// BLAKE3 of a file, computed in blocking context (streamed from disk).
pub fn hash_file_blocking(path: &Path) -> std::io::Result<String> {
    let file = std::fs::File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    std::io::copy(&mut std::io::BufReader::new(file), &mut hasher)?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// BLAKE3 of an in-memory byte slice (used by tests and small payloads).
pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Lowercase extension without the dot ("jpg"), or empty if none.
pub fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub const VIDEO_EXTS: [&str; 10] = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "3gp", "mpg", "mpeg", "wmv"];

/// Extensions the folder watcher indexes automatically.
pub const WATCHED_EXTS: [&str; 26] = [
    "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "bmp", "tif", "tiff", "dng", "cr2", "cr3",
    "nef", "arw", "orf", "rw2", "raf", "mp4", "mov", "mkv", "avi", "webm", "m4v", "3gp", "mpeg",
];

pub fn is_video_ext(ext: &str) -> bool {
    VIDEO_EXTS.contains(&ext)
}

pub fn is_watched_ext(ext: &str) -> bool {
    WATCHED_EXTS.contains(&ext)
}

/// File type recorded on an asset: video by extension, everything else photo.
pub fn classify(ext: &str) -> &'static str {
    if is_video_ext(ext) {
        "video"
    } else {
        "photo"
    }
}

/// Content type for serving originals.
pub fn content_type_for(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "heic" | "heif" => "image/heic",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "3gp" => "video/3gpp",
        "mpg" | "mpeg" => "video/mpeg",
        "wmv" => "video/x-ms-wmv",
        _ => "application/octet-stream",
    }
}

/// A BLAKE3 hex digest must be exactly 64 lowercase hex characters.
pub fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}
