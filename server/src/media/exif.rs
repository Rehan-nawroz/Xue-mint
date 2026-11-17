//! EXIF metadata extraction: capture date, GPS, orientation.

use std::path::Path;

#[derive(Debug, Default, Clone)]
pub struct ExifMeta {
    pub taken_at: Option<String>,
    pub gps: Option<String>,
    pub orientation: u32,
}

/// Reads EXIF from a photo file. Returns None for files without usable EXIF
/// (videos, unknown formats) — callers treat that as "no metadata".
pub fn read(path: &Path) -> Option<ExifMeta> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;

    let mut meta = ExifMeta::default();

    if let Some(f) = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
        meta.taken_at = normalize_datetime(&field_text(f));
    }
    if meta.taken_at.is_none() {
        if let Some(f) = exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
            meta.taken_at = normalize_datetime(&field_text(f));
        }
    }

    meta.gps = read_gps(&exif);

    if let Some(f) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        meta.orientation = f.value.get_uint(0).unwrap_or(1);
    }
    if meta.orientation == 0 {
        meta.orientation = 1;
    }

    Some(meta)
}

/// Extracts an ASCII string from an EXIF field.
fn field_text(field: &exif::Field) -> String {
    match &field.value {
        exif::Value::Ascii(values) => values
            .first()
            .map(|b| {
                String::from_utf8_lossy(b)
                    .trim_end_matches('\0')
                    .trim()
                    .to_string()
            })
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// Converts EXIF datetime format (`2024:01:15 10:30:00`) into the schema format
/// (`2024-01-15T10:30:00`), or None if the value does not look like a datetime.
fn normalize_datetime(raw: &str) -> Option<String> {
    let s = raw.trim();
    let bytes = s.as_bytes();
    if s.len() < 19 || bytes[4] != b':' || bytes[7] != b':' {
        return None;
    }
    let mut out = String::with_capacity(19);
    for (i, c) in s.chars().enumerate() {
        match i {
            4 | 7 => out.push('-'),
            10 => out.push('T'),
            _ if i < 19 => out.push(c),
            _ => break,
        }
    }
    if out.len() == 19 {
        Some(out)
    } else {
        None
    }
}

/// GPS latitude/longitude as a decimal string ("48.1234,11.5678"), or None.
fn read_gps(exif: &exif::Exif) -> Option<String> {
    let lat = dms_to_decimal(
        exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)?,
        exif.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY)
            .map(|f| field_text(f)),
    )?;
    let lon = dms_to_decimal(
        exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY)?,
        exif.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY)
            .map(|f| field_text(f)),
    )?;
    let lat = if lat_ref_negative(exif) { -lat } else { lat };
    let lon = if lon_ref_negative(exif) { -lon } else { lon };
    Some(format!("{lat:.6},{lon:.6}"))
}

fn lat_ref_negative(exif: &exif::Exif) -> bool {
    exif.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY)
        .map(|f| field_text(f).starts_with('S'))
        .unwrap_or(false)
}

fn lon_ref_negative(exif: &exif::Exif) -> bool {
    exif.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY)
        .map(|f| field_text(f).starts_with('W'))
        .unwrap_or(false)
}

/// Degrees/minutes/seconds rationals to decimal degrees.
fn dms_to_decimal(field: &exif::Field, _ref_field: Option<String>) -> Option<f64> {
    match &field.value {
        exif::Value::Rational(parts) if parts.len() == 3 => {
            let to_f = |r: &exif::Rational| r.num as f64 / r.denom as f64;
            Some(to_f(&parts[0]) + to_f(&parts[1]) / 60.0 + to_f(&parts[2]) / 3600.0)
        }
        _ => None,
    }
}
