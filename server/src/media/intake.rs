//! Format-aware image inspection for formats the `image` crate does not decode:
//! HEIF/HEIC stills (HEVC-coded) and camera RAW files (whose embedded JPEG
//! preview stands in for the sensor data).

use crate::media::{ext_of, is_heic_ext, is_raw_ext};
use image::GenericImageView;
use std::path::Path;
use zune_heic::zune_core::bytestream::ZCursor;
use zune_heic::zune_core::colorspace::ColorSpace;

/// Refuse to load absurdly large containers into memory. Real camera files are
/// far below this; the cap only protects the server from a hostile upload.
const MAX_CONTAINER_BYTES: u64 = 512 * 1024 * 1024;

/// Pixel dimensions of an image file. Standard formats are read from headers;
/// HEIC from the container; RAW from the embedded preview.
pub fn dimensions(path: &Path) -> Option<(u32, u32)> {
    if let Some(size) = standard_dimensions(path) {
        return Some(size);
    }
    let ext = ext_of(path);
    if is_heic_ext(&ext) {
        return heic_headers(path)
            .map(|(width, height)| (width as u32, height as u32))
            .or_else(|| decode_heic(path).map(|image| image.dimensions()));
    }
    if is_raw_ext(&ext) {
        return raw_preview_image(path).map(|image| image.dimensions());
    }
    None
}

fn standard_dimensions(path: &Path) -> Option<(u32, u32)> {
    image::ImageReader::open(path).ok()?.into_dimensions().ok()
}

fn heic_headers(path: &Path) -> Option<(usize, usize)> {
    if !within_read_cap(path) {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    let mut decoder = zune_heic::HeifDecoder::new(ZCursor::new(&data));
    decoder.decode_headers().ok()?;
    Some((decoder.width()?, decoder.height()?))
}

/// Decodes a HEIC/HEIF still to an RGB(A) image. The decoder applies the
/// container's rotation/mirroring properties, so callers must not apply the
/// EXIF orientation a second time.
pub fn decode_heic(path: &Path) -> Option<image::DynamicImage> {
    if !within_read_cap(path) {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    if let Some(image) = decode_heic_with_zune(&data) {
        return Some(image);
    }
    // A second, independent HEVC implementation catches containers the first
    // decoder cannot handle (different encoder profiles, unusual tile layouts).
    decode_heic_with_heifer(&data)
}

fn decode_heic_with_zune(data: &[u8]) -> Option<image::DynamicImage> {
    let mut decoder = zune_heic::HeifDecoder::new(ZCursor::new(data));
    decoder.decode_headers().ok()?;
    let width = decoder.width()? as u32;
    let height = decoder.height()? as u32;
    // The colorspace is reported after decoding the picture, not just headers.
    let pixels = decoder.decode().ok()?;
    let colorspace = decoder.colorspace()?;
    match colorspace {
        ColorSpace::RGB => {
            image::RgbImage::from_raw(width, height, pixels).map(image::DynamicImage::ImageRgb8)
        }
        ColorSpace::RGBA => {
            image::RgbaImage::from_raw(width, height, pixels).map(image::DynamicImage::ImageRgba8)
        }
        ColorSpace::Luma => {
            image::GrayImage::from_raw(width, height, pixels).map(image::DynamicImage::ImageLuma8)
        }
        ColorSpace::LumaA => image::GrayAlphaImage::from_raw(width, height, pixels)
            .map(image::DynamicImage::ImageLumaA8),
        _ => None,
    }
}

fn decode_heic_with_heifer(data: &[u8]) -> Option<image::DynamicImage> {
    let decoded = heifer::decode(data).ok()?;
    let width = decoded.width;
    let height = decoded.height;
    let pixels = decoded.to_rgba8();
    image::RgbaImage::from_raw(width, height, pixels).map(image::DynamicImage::ImageRgba8)
}

/// Decodes the largest usable JPEG preview inside a RAW file. Camera RAW
/// containers (DNG, CR2, NEF, ARW, ORF, RW2, RAF, …) embed one or more JPEG
/// previews; the biggest one is a full-resolution image in most formats.
pub fn raw_preview_image(path: &Path) -> Option<image::DynamicImage> {
    if !within_read_cap(path) {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    let mut previews = jpeg_previews(&data);
    previews.sort_by_key(|preview| std::cmp::Reverse(preview.len()));
    for preview in previews {
        if let Ok(image) = image::load_from_memory(preview) {
            return Some(image);
        }
    }
    None
}

/// Collects JPEG byte ranges (SOI … EOI) in a container, newest-scan order.
fn jpeg_previews(data: &[u8]) -> Vec<&[u8]> {
    let mut previews = Vec::new();
    let mut cursor = 0usize;
    while cursor + 1 < data.len() {
        if data[cursor] == 0xFF && data[cursor + 1] == 0xD8 {
            let start = cursor;
            let mut end = start + 2;
            let mut found_end = None;
            while end + 1 < data.len() {
                if data[end] == 0xFF && data[end + 1] == 0xD9 {
                    found_end = Some(end + 2);
                    break;
                }
                end += 1;
            }
            match found_end {
                Some(finish) => {
                    previews.push(&data[start..finish]);
                    cursor = finish;
                }
                None => break,
            }
            if previews.len() >= 32 {
                break;
            }
        } else {
            cursor += 1;
        }
    }
    previews
}

fn within_read_cap(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.len() <= MAX_CONTAINER_BYTES)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_jpeg_previews_and_ignores_raw_bytes() {
        let jpeg = [0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9];
        let mut data = vec![9, 9, 9];
        data.extend_from_slice(&jpeg);
        data.extend_from_slice(&[8, 8]);
        data.extend_from_slice(&jpeg);
        let previews = jpeg_previews(&data);
        assert_eq!(previews.len(), 2);
        assert_eq!(previews[0], &jpeg);
    }
}
