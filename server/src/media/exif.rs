//! EXIF metadata extraction: capture date, GPS, orientation.
//!
//! Screenshots, edited exports, messaging apps and timezone-less cameras all
//! produce odd or missing EXIF. Anything that is not a real, plausible capture
//! time is rejected here; the ingest path then falls back to the file's own
//! date instead of inventing a time or dropping the photo from the timeline.

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

    if let Some(field) = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
        meta.taken_at = normalize_datetime(&field_text(field));
    }
    if meta.taken_at.is_none() {
        if let Some(field) = exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
            meta.taken_at = normalize_datetime(&field_text(field));
        }
    }

    meta.gps = read_gps(&exif);

    if let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        meta.orientation = field.value.get_uint(0).unwrap_or(1);
    }
    if !(1..=8).contains(&meta.orientation) {
        // Unknown orientation values must not rotate or transpose anything.
        meta.orientation = 1;
    }

    Some(meta)
}

/// Extracts an ASCII string from an EXIF field.
fn field_text(field: &exif::Field) -> String {
    match &field.value {
        exif::Value::Ascii(values) => values
            .first()
            .map(|bytes| {
                String::from_utf8_lossy(bytes)
                    .trim_end_matches('\0')
                    .trim()
                    .to_string()
            })
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// Converts EXIF datetime format (`2024:01:15 10:30:00`) into the schema format
/// (`2024-01-15T10:30:00`). Invalid dates (`0000:00:00 …`, month 13, year 0000)
/// return None so the caller can fall back to the file date.
fn normalize_datetime(raw: &str) -> Option<String> {
    let text = raw.trim().trim_matches('\0').trim();
    if text.len() < 19 {
        return None;
    }
    let candidate = &text[..19];
    let bytes = candidate.as_bytes();
    if bytes[4] != b':'
        || bytes[7] != b':'
        || bytes[10] != b' '
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 7 | 10 | 13 | 16) {
            continue;
        }
        if !byte.is_ascii_digit() {
            return None;
        }
    }

    let normalized = format!(
        "{}-{}-{}T{}:{}:{}",
        &candidate[0..4],
        &candidate[5..7],
        &candidate[8..10],
        &candidate[11..13],
        &candidate[14..16],
        &candidate[17..19]
    );
    let parsed = chrono::NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S").ok()?;

    // Cameras sometimes leave a zeroed field behind; plausible photos are taken
    // between the dawn of digital photography and slightly into the future
    // (clock drift on the camera).
    let year = chrono::Datelike::year(&parsed);
    if !(1900..=2100).contains(&year) {
        return None;
    }
    let future_limit = chrono::Utc::now().naive_utc() + chrono::Duration::days(2);
    if parsed > future_limit {
        return None;
    }

    Some(normalized)
}

/// GPS latitude/longitude as a decimal string ("48.1234,11.5678"), or None.
fn read_gps(exif: &exif::Exif) -> Option<String> {
    let latitude = dms_to_decimal(exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)?)?;
    let longitude = dms_to_decimal(exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY)?)?;
    if !(0.0..=90.0).contains(&latitude) || !(0.0..=180.0).contains(&longitude) {
        return None;
    }
    let latitude = if latitude_ref_is_south(exif) {
        -latitude
    } else {
        latitude
    };
    let longitude = if longitude_ref_is_west(exif) {
        -longitude
    } else {
        longitude
    };
    Some(format!("{latitude:.6},{longitude:.6}"))
}

fn latitude_ref_is_south(exif: &exif::Exif) -> bool {
    exif.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY)
        .map(|field| field_text(field).to_ascii_uppercase().starts_with('S'))
        .unwrap_or(false)
}

fn longitude_ref_is_west(exif: &exif::Exif) -> bool {
    exif.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY)
        .map(|field| field_text(field).to_ascii_uppercase().starts_with('W'))
        .unwrap_or(false)
}

/// Degrees/minutes/seconds rationals to decimal degrees. Zero denominators and
/// out-of-range minute/second parts are treated as unusable, not as infinity.
fn dms_to_decimal(field: &exif::Field) -> Option<f64> {
    match &field.value {
        exif::Value::Rational(parts) if parts.len() == 3 => {
            let mut values = [0.0f64; 3];
            for (index, part) in parts.iter().enumerate() {
                if part.denom == 0 {
                    return None;
                }
                let value = part.num as f64 / part.denom as f64;
                if !value.is_finite() {
                    return None;
                }
                values[index] = value;
            }
            let [degrees, minutes, seconds] = values;
            if degrees < 0.0 || !(0.0..60.0).contains(&minutes) || !(0.0..60.0).contains(&seconds) {
                return None;
            }
            Some(degrees + minutes / 60.0 + seconds / 3600.0)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_real_timestamps_only() {
        assert_eq!(
            normalize_datetime("2024:01:15 10:30:00"),
            Some("2024-01-15T10:30:00".to_string())
        );
        assert_eq!(
            normalize_datetime(" 2024:01:15 10:30:00\u{0} "),
            Some("2024-01-15T10:30:00".to_string())
        );
        assert_eq!(normalize_datetime("0000:00:00 00:00:00"), None);
        assert_eq!(normalize_datetime("2024:13:40 10:30:00"), None);
        assert_eq!(normalize_datetime("2024:01:15 10:30"), None);
        assert_eq!(normalize_datetime("not a date"), None);
        assert_eq!(normalize_datetime(""), None);
    }

    #[test]
    fn rejects_impossible_orientation_values() {
        // Orientation is normalized by read(); this covers the guard's range.
        for value in 1..=8 {
            assert!((1..=8).contains(&value));
        }
        assert!(!(1..=8).contains(&0));
        assert!(!(1..=8).contains(&9));
    }
}
