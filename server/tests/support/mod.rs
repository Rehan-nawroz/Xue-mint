//! Shared helpers for the hardening and performance integration suites.
#![allow(dead_code)]

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use xue_mint_server::{config::Config, db, serve_on, state::AppState, tokens};

pub fn config(base: &std::path::Path) -> Config {
    Config {
        port: 0,
        photos_dir: base.join("photos"),
        data_dir: base.join("data"),
        web_dir: None,
    }
}

pub async fn state_in(dir: &std::path::Path) -> AppState {
    let cfg = config(dir);
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    AppState::new(cfg, pool)
}

pub async fn state() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let state = state_in(dir.path()).await;
    (dir, state)
}

pub async fn serve_from(
    dir: &std::path::Path,
) -> (String, SqlitePool, AppState, tokio::task::JoinHandle<()>) {
    let state = state_in(dir).await;
    let pool = state.pool.clone();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let serving = state.clone();
    let handle = tokio::spawn(async move {
        let _ = serve_on(serving, listener).await;
    });

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(
            std::time::Instant::now() < deadline,
            "server did not start listening"
        );
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    }

    (format!("https://127.0.0.1:{port}"), pool, state, handle)
}

pub async fn start() -> (
    tempfile::TempDir,
    String,
    SqlitePool,
    AppState,
    tokio::task::JoinHandle<()>,
) {
    let dir = tempfile::tempdir().unwrap();
    let (base, pool, state, handle) = serve_from(dir.path()).await;
    (dir, base, pool, state, handle)
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap()
}

pub fn auth(credential: &str) -> reqwest::header::HeaderValue {
    reqwest::header::HeaderValue::from_str(&format!("Device {credential}")).unwrap()
}

pub async fn pair(http: &reqwest::Client, base: &str, pool: &SqlitePool, key: &str) -> String {
    let token = tokens::create_token(pool, 600).await.unwrap();
    let response = http
        .post(format!("{base}/pair"))
        .json(&json!({
            "token": token,
            "devicePublicKey": BASE64.encode(key.as_bytes()),
            "deviceName": "Hardening Phone"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200, "pairing must succeed");
    response.json::<Value>().await.unwrap()["credential"]
        .as_str()
        .unwrap()
        .to_string()
}

pub async fn local_cookie(http: &reqwest::Client, base: &str) -> String {
    let response = http
        .post(format!("{base}/local/session"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 204);
    response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .expect("session cookie")
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

pub fn test_jpeg(color: [u8; 3]) -> Vec<u8> {
    let image =
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(64, 48, image::Rgb(color)));
    let mut bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    bytes
}

pub fn test_png(color: [u8; 3]) -> Vec<u8> {
    let image =
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(64, 48, image::Rgb(color)));
    let mut bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

/// JPEG carrying a real EXIF block: orientation plus DateTimeOriginal.
pub fn exif_jpeg(date: &str, orientation: u16) -> Vec<u8> {
    fn put_u16(buffer: &mut [u8], offset: usize, value: u16) {
        buffer[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }
    fn put_u32(buffer: &mut [u8], offset: usize, value: u32) {
        buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    fn entry(buffer: &mut [u8], offset: usize, tag: u16, kind: u16, count: u32, value: u32) {
        put_u16(buffer, offset, tag);
        put_u16(buffer, offset + 2, kind);
        put_u32(buffer, offset + 4, count);
        put_u32(buffer, offset + 8, value);
    }

    let mut tiff = vec![0u8; 76];
    tiff[0..2].copy_from_slice(b"II");
    put_u16(&mut tiff, 2, 42);
    put_u32(&mut tiff, 4, 8);
    put_u16(&mut tiff, 8, 2);
    entry(&mut tiff, 10, 0x0112, 3, 1, orientation as u32);
    entry(&mut tiff, 22, 0x8769, 4, 1, 38);
    put_u32(&mut tiff, 34, 0);
    put_u16(&mut tiff, 38, 1);
    entry(&mut tiff, 40, 0x9003, 2, 20, 56);
    put_u32(&mut tiff, 52, 0);
    let mut raw_date = [0u8; 20];
    let bytes = date.as_bytes();
    let length = bytes.len().min(19);
    raw_date[..length].copy_from_slice(&bytes[..length]);
    tiff[56..76].copy_from_slice(&raw_date);

    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff);
    let segment_length = (payload.len() + 2) as u16;
    let jpeg = test_jpeg([200, 30, 30]);
    let mut out = Vec::with_capacity(jpeg.len() + payload.len() + 4);
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(&[0xff, 0xe1]);
    out.extend_from_slice(&segment_length.to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[2..]);
    out
}

/// Distinct bytes for each fixture so hash dedupe does not merge test photos.
pub fn unique_jpeg(tag: &str, date: Option<&str>, orientation: u16) -> Vec<u8> {
    let mut bytes = match date {
        Some(date) => exif_jpeg(date, orientation),
        None => test_jpeg([120, 160, 200]),
    };
    bytes.extend_from_slice(tag.as_bytes());
    bytes
}

pub fn set_modified(path: &std::path::Path, rfc3339: &str) {
    let when = chrono::DateTime::parse_from_rfc3339(rfc3339).unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(
        std::time::UNIX_EPOCH + std::time::Duration::from_secs(when.timestamp().max(0) as u64),
    ))
    .unwrap();
}

/// A small but real HEIC file (HEVC still in a HEIF container).
pub fn test_heic(width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
    let pixels: Vec<u8> = color
        .iter()
        .copied()
        .cycle()
        .take((width * height * 3) as usize)
        .collect();
    heifer::encode_rgb8(
        width,
        height,
        &pixels,
        &heifer::EncodeOptions::new().with_quality(90),
    )
    .expect("encode HEIC fixture")
}
