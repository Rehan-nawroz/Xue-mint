//! Small shared helpers: time formatting, hashing, media type classification.

pub mod exif;
pub mod intake;
pub mod live;
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

/// Modification time (or creation time) of a file in the schema's ISO format.
/// Used as the capture-time fallback for screenshots, edited exports and files
/// whose EXIF is missing or unusable.
pub fn file_date(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().or_else(|_| metadata.created()).ok()?;
    let datetime: chrono::DateTime<chrono::Utc> = modified.into();
    Some(datetime.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Display name for a stored file: control characters removed, bounded length,
/// with a neutral fallback instead of an empty label.
pub fn clean_display_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "photo".to_string()
    } else {
        trimmed.to_string()
    }
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

pub const VIDEO_EXTS: [&str; 10] = [
    "mp4", "mov", "mkv", "avi", "webm", "m4v", "3gp", "mpg", "mpeg", "wmv",
];

/// Image formats that need the HEVC-based HEIF decoder.
pub const HEIC_EXTS: [&str; 3] = ["heic", "heif", "hif"];

/// Camera RAW formats. Thumbnails come from the JPEG preview inside each file.
pub const RAW_EXTS: [&str; 10] = [
    "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2", "raf", "srw", "pef",
];

/// Extensions the folder watcher indexes automatically.
pub const WATCHED_EXTS: [&str; 31] = [
    "jpg", "jpeg", "png", "heic", "heif", "hif", "webp", "gif", "bmp", "tif", "tiff", "dng", "cr2",
    "cr3", "nef", "arw", "orf", "rw2", "raf", "srw", "pef", "mp4", "mov", "mkv", "avi", "webm",
    "m4v", "3gp", "mpeg", "mpg", "wmv",
];

pub fn is_video_ext(ext: &str) -> bool {
    VIDEO_EXTS.contains(&ext)
}

pub fn is_heic_ext(ext: &str) -> bool {
    HEIC_EXTS.contains(&ext)
}

pub fn is_raw_ext(ext: &str) -> bool {
    RAW_EXTS.contains(&ext)
}

/// File extension safe to use in a stored path: lowercase ASCII letters and
/// digits only. Anything unexpected (extra separators, stream names, a huge
/// blob) keeps the leading alphanumeric part or becomes `bin`.
pub fn sanitize_ext(raw: &str) -> String {
    let lowered = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    let candidate: String = lowered
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric())
        .take(10)
        .collect();
    if candidate.is_empty() {
        "bin".to_string()
    } else {
        candidate
    }
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
        "heic" | "heif" | "hif" => "image/heic",
        "dng" => "image/x-adobe-dng",
        "cr2" | "cr3" => "image/x-canon-cr2",
        "nef" => "image/x-nikon-nef",
        "arw" => "image/x-sony-arw",
        "orf" => "image/x-olympus-orf",
        "rw2" => "image/x-panasonic-rw2",
        "raf" => "image/x-fuji-raf",
        "srw" => "image/x-samsung-srw",
        "pef" => "image/x-pentax-pef",
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
