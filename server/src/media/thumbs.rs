//! Thumbnail generation at ingest time.
//!
//! Photos: decoded with the `image` crate, EXIF orientation applied, resized to at
//! most 400px on the long edge, saved as JPEG next to the database.
//! Videos: a first frame is grabbed with a system ffmpeg binary when one is on PATH.
//! HEIC and anything else we cannot decode: a neutral placeholder JPEG so the
//! gallery still shows a tile; native HEIC decoding is a hardening-phase upgrade.

use crate::state::AppState;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const THUMB_MAX_EDGE: u32 = 400;

/// Generates the thumbnail for an asset if it does not exist yet. Never fails the
/// caller: logs and continues, since a missing thumbnail only costs a tile image.
pub async fn generate(state: &AppState, src: &Path, hash: &str, is_video: bool, orientation: u32) {
    let out = state.cfg.thumbs_dir().join(format!("{hash}.jpg"));
    if out.exists() {
        return;
    }
    let src = src.to_path_buf();
    let is_video = is_video;
    let result =
        tokio::task::spawn_blocking(move || make_thumbnail(&src, &out, is_video, orientation))
            .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => println!("Thumbnail generation failed for {hash}: {error}"),
        Err(error) => println!("Thumbnail task failed for {hash}: {error}"),
    }
}

fn make_thumbnail(
    src: &Path,
    out: &PathBuf,
    is_video: bool,
    orientation: u32,
) -> std::io::Result<()> {
    if is_video {
        if ffmpeg_frame(src, out) {
            return Ok(());
        }
        return placeholder(out);
    }
    match decode_thumb(src, orientation) {
        Some(thumb) => write_jpeg(&thumb, out),
        None => placeholder(out),
    }
}

/// Decodes and resizes a raster image; None when the format is not decodable
/// (HEIC, RAW files, corrupt data).
fn decode_thumb(src: &Path, orientation: u32) -> Option<image::DynamicImage> {
    let reader = image::ImageReader::open(src).ok()?;
    let img = reader.decode().ok()?;
    let img = apply_orientation(img, orientation);
    Some(img.thumbnail(THUMB_MAX_EDGE, THUMB_MAX_EDGE))
}

/// Applies an EXIF orientation value (1-8) so the thumbnail is upright.
fn apply_orientation(img: image::DynamicImage, orientation: u32) -> image::DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// Grabs the first frame of a video with a system ffmpeg binary.
/// Returns true only when ffmpeg ran and produced the file.
fn ffmpeg_frame(src: &Path, out: &Path) -> bool {
    let result = std::process::Command::new("ffmpeg")
        .args(["-y", "-ss", "0", "-i"])
        .arg(src)
        .args(["-frames:v", "1", "-vf", "scale=400:-1", "-q:v", "5"])
        .arg(out)
        .output();
    matches!(result, Ok(output) if output.status.success() && out.exists())
}

/// A neutral dark tile for assets we cannot decode yet.
fn placeholder(out: &Path) -> std::io::Result<()> {
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        THUMB_MAX_EDGE,
        (THUMB_MAX_EDGE * 3) / 4,
        image::Rgb([46, 48, 52]),
    ));
    write_jpeg(&img, out)
}

fn write_jpeg(img: &image::DynamicImage, out: &Path) -> std::io::Result<()> {
    let file = std::fs::File::create(out)?;
    let mut writer = std::io::BufWriter::new(file);
    img.write_to(&mut writer, image::ImageFormat::Jpeg)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    writer.flush()?;
    Ok(())
}
