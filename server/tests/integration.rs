//! End-to-end test over TLS: pair → check → upload → timeline → thumb →
//! original → duplicate → devices list/revoke → revoked device rejected.

use std::io::Write;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use image::GenericImageView;
use serde_json::{json, Value};
use sqlx::Row;

use xue_mint_server::{build_router, config::Config, db, serve_on, state::AppState, tokens};

fn test_config(base: &std::path::Path) -> Config {
    Config {
        port: 0,
        photos_dir: base.join("photos"),
        data_dir: base.join("data"),
        web_dir: None,
    }
}

fn test_jpeg() -> Vec<u8> {
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        64,
        48,
        image::Rgb([200, 30, 30]),
    ));
    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut bytes);
    img.write_to(&mut cursor, image::ImageFormat::Jpeg).unwrap();
    bytes
}

fn exif_jpeg() -> Vec<u8> {
    fn put_u16(buf: &mut [u8], offset: usize, value: u16) {
        buf[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }
    fn put_u32(buf: &mut [u8], offset: usize, value: u32) {
        buf[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    fn entry(buf: &mut [u8], offset: usize, tag: u16, kind: u16, count: u32, value: u32) {
        put_u16(buf, offset, tag);
        put_u16(buf, offset + 2, kind);
        put_u32(buf, offset + 4, count);
        put_u32(buf, offset + 8, value);
    }

    // Little-endian TIFF with orientation, DateTimeOriginal, and south/west GPS.
    let mut tiff = vec![0u8; 190];
    tiff[0..2].copy_from_slice(b"II");
    put_u16(&mut tiff, 2, 42);
    put_u32(&mut tiff, 4, 8);

    put_u16(&mut tiff, 8, 3);
    entry(&mut tiff, 10, 0x0112, 3, 1, 6); // Orientation = rotate 90° clockwise
    entry(&mut tiff, 22, 0x8769, 4, 1, 50); // Exif IFD pointer
    entry(&mut tiff, 34, 0x8825, 4, 1, 88); // GPS IFD pointer
    put_u32(&mut tiff, 46, 0);

    put_u16(&mut tiff, 50, 1);
    entry(&mut tiff, 52, 0x9003, 2, 20, 68); // DateTimeOriginal
    put_u32(&mut tiff, 64, 0);
    tiff[68..88].copy_from_slice(b"2024:01:15 10:30:00\0");

    put_u16(&mut tiff, 88, 4);
    entry(&mut tiff, 90, 1, 2, 2, u32::from_le_bytes(*b"S\0\0\0")); // GPSLatitudeRef
    entry(&mut tiff, 102, 2, 5, 3, 142); // GPSLatitude rationals
    entry(&mut tiff, 114, 3, 2, 2, u32::from_le_bytes(*b"W\0\0\0")); // GPSLongitudeRef
    entry(&mut tiff, 126, 4, 5, 3, 166); // GPSLongitude rationals
    put_u32(&mut tiff, 138, 0);

    for (offset, numerator, denominator) in [
        (142, 37, 1),
        (150, 30, 1),
        (158, 0, 1), // 37°30'00" S
        (166, 122, 1),
        (174, 15, 1),
        (182, 0, 1), // 122°15'00" W
    ] {
        put_u32(&mut tiff, offset, numerator);
        put_u32(&mut tiff, offset + 4, denominator);
    }
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff);
    let segment_len = (payload.len() + 2) as u16;
    let jpeg = test_jpeg();
    let mut out = Vec::with_capacity(jpeg.len() + payload.len() + 4);
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(&[0xff, 0xe1]);
    out.extend_from_slice(&segment_len.to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[2..]);
    out
}

async fn start_server() -> (String, sqlx::SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = test_config(dir.path());
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    let state = AppState::new(cfg, pool.clone());

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        serve_on(state, listener).await.unwrap();
    });

    // Keep the tempdir alive for the whole test by leaking it (tests are short).
    std::mem::forget(dir);

    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let probe = std::net::TcpStream::connect(("127.0.0.1", port));
            if probe.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await;

    (format!("https://127.0.0.1:{port}"), pool)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap()
}

fn auth(credential: &str) -> reqwest::header::HeaderValue {
    reqwest::header::HeaderValue::from_str(&format!("Device {credential}")).unwrap()
}

#[tokio::test]
async fn full_pair_upload_browse_revoke_flow() {
    let (base, pool) = start_server().await;
    let http = client();

    // --- pair ---
    let token = tokens::create_token(&pool, 600).await.unwrap();
    let response = http
        .post(format!("{base}/pair"))
        .json(&json!({
            "token": token,
            "devicePublicKey": BASE64.encode(b"test-device-key"),
            "deviceName": "Test Phone"
        }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();
    assert_eq!(
        status.as_u16(),
        200,
        "pair should succeed; body: {body_text}"
    );
    let paired: Value = serde_json::from_str(&body_text).unwrap();
    let device_id = paired["deviceId"].as_str().unwrap().to_string();
    let credential = paired["credential"].as_str().unwrap().to_string();

    // Token is single-use: pairing again with the same token must fail.
    let token2 = tokens::create_token(&pool, 600).await.unwrap();
    let _ = http
        .post(format!("{base}/pair"))
        .json(&json!({ "token": token2.clone(), "devicePublicKey": "eA==", "deviceName": "x" }))
        .send()
        .await
        .unwrap();
    let reused = http
        .post(format!("{base}/pair"))
        .json(&json!({ "token": token2, "devicePublicKey": "eA==", "deviceName": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(reused.status().as_u16(), 401);
    assert_eq!(
        reused.json::<Value>().await.unwrap()["code"],
        "PAIR_TOKEN_USED"
    );

    // --- check: hash missing ---
    let bytes = test_jpeg();
    let hash = xue_mint_server::media::hash_bytes(&bytes);

    let response = http
        .post(format!("{base}/assets/check"))
        .header("Authorization", auth(&credential))
        .json(&json!({ "hashes": [hash] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let check: Value = response.json().await.unwrap();
    assert_eq!(check["missing"].as_array().unwrap().len(), 1);

    // --- upload: one final chunk ---
    let response = http
        .put(format!("{base}/assets/upload/{hash}?final=1"))
        .header("Authorization", auth(&credential))
        .header("x-total", bytes.len().to_string())
        .header("x-filename", "red%20photo.jpg")
        .body(bytes.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200, "upload should succeed");
    let uploaded: Value = response.json().await.unwrap();
    assert_eq!(uploaded["stored"], true);
    assert_eq!(uploaded["duplicate"], false);

    // --- check: now present ---
    let response = http
        .post(format!("{base}/assets/check"))
        .header("Authorization", auth(&credential))
        .json(&json!({ "hashes": [hash] }))
        .send()
        .await
        .unwrap();
    let check: Value = response.json().await.unwrap();
    assert_eq!(check["missing"].as_array().unwrap().len(), 0);

    // --- duplicate upload ---
    let response = http
        .put(format!("{base}/assets/upload/{hash}?final=1"))
        .header("Authorization", auth(&credential))
        .header("x-total", bytes.len().to_string())
        .body(bytes.clone())
        .send()
        .await
        .unwrap();
    let uploaded: Value = response.json().await.unwrap();
    assert_eq!(uploaded["stored"], true);
    assert_eq!(uploaded["duplicate"], true);

    // --- timeline ---
    let response = http
        .get(format!("{base}/assets"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let timeline: Value = response.json().await.unwrap();
    let items = timeline["items"].as_array().unwrap();
    if items.len() != 1 {
        panic!("expected 1 asset, got {items:?}");
    }
    assert_eq!(items[0]["hash"], hash);
    assert_eq!(items[0]["type"], "photo");
    assert_eq!(items[0]["filename"], "red photo.jpg");
    let asset_id = items[0]["id"].as_str().unwrap().to_string();

    // --- thumbnail ---
    let response = http
        .get(format!("{base}/assets/{asset_id}/thumb"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("image/jpeg"));
    assert!(!response.bytes().await.unwrap().is_empty());

    // --- original matches uploaded bytes ---
    let response = http
        .get(format!("{base}/assets/{asset_id}/original"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.bytes().await.unwrap().as_ref(), bytes.as_slice());

    // --- devices list ---
    let response = http
        .get(format!("{base}/devices"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap();
    let devices: Value = response.json().await.unwrap();
    let listed = devices["devices"].as_array().unwrap();
    assert_eq!(
        listed.len(),
        2,
        "two paired devices expected (reuse-check pairing counts too)"
    );
    assert!(listed.iter().any(|d| d["id"] == device_id));
    assert!(listed.iter().any(|d| d["name"] == "Test Phone"));

    // --- revoke ---
    let response = http
        .delete(format!("{base}/devices/{device_id}"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 204);

    // --- revoked device is rejected with a distinct code ---
    let response = http
        .post(format!("{base}/assets/check"))
        .header("Authorization", auth(&credential))
        .json(&json!({ "hashes": [hash] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 401);
    assert_eq!(
        response.json::<Value>().await.unwrap()["code"],
        "DEVICE_REVOKED"
    );
}

#[tokio::test]
async fn unauthenticated_request_is_rejected() {
    let (base, _pool) = start_server().await;
    let http = client();

    let response = http.get(format!("{base}/assets")).send().await.unwrap();
    assert_eq!(response.status().as_u16(), 401);
    assert_eq!(
        response.json::<Value>().await.unwrap()["code"],
        "AUTH_REQUIRED"
    );
}

#[tokio::test]
async fn resumable_upload_in_two_chunks() {
    let (base, pool) = start_server().await;
    let http = client();

    let token = tokens::create_token(&pool, 600).await.unwrap();
    let paired: Value = http
        .post(format!("{base}/pair"))
        .json(&json!({
            "token": token,
            "devicePublicKey": BASE64.encode(b"chunky"),
            "deviceName": "Chunk Phone"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let credential = paired["credential"].as_str().unwrap().to_string();

    // Build a larger fake "photo" (random bytes are fine; the server verifies
    // the hash, not the image decodability).
    let bytes: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let hash = xue_mint_server::media::hash_bytes(&bytes);
    let (first, second) = bytes.split_at(150_000);

    // Chunk 1: 150 000 bytes, not final.
    let response = http
        .put(format!("{base}/assets/upload/{hash}"))
        .header("Authorization", auth(&credential))
        .header("x-total", bytes.len().to_string())
        .header("x-filename", "big.dat")
        .body(first.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let chunk: Value = response.json().await.unwrap();
    assert_eq!(chunk["stored"], false);
    assert_eq!(chunk["offset"], 150_000);

    // Chunk 2: remaining 50 000 bytes, at the right offset, final.
    let response = http
        .put(format!("{base}/assets/upload/{hash}"))
        .header("Authorization", auth(&credential))
        .header("offset", "150000")
        .header("x-total", bytes.len().to_string())
        .body(second.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let done: Value = response.json().await.unwrap();
    assert_eq!(done["stored"], true);
    assert_eq!(done["duplicate"], false);

    // Original matches byte for byte.
    let timeline: Value = http
        .get(format!("{base}/assets"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let asset_id = timeline["items"][0]["id"].as_str().unwrap().to_string();
    let response = http
        .get(format!("{base}/assets/{asset_id}/original"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap();
    assert_eq!(response.bytes().await.unwrap().as_ref(), bytes.as_slice());
}

#[tokio::test]
async fn timeline_cursor_pagination_and_delete() {
    let (base, pool) = start_server().await;
    let http = client();

    let token = tokens::create_token(&pool, 600).await.unwrap();
    let paired: Value = http
        .post(format!("{base}/pair"))
        .json(&json!({
            "token": token,
            "devicePublicKey": BASE64.encode(b"pager"),
            "deviceName": "Pager"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let credential = paired["credential"].as_str().unwrap().to_string();

    // Upload three distinct photos.
    let mut ids = Vec::new();
    for r in 0..3u8 {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            32,
            32,
            image::Rgb([250, r, 200 - r]),
        ));
        let mut bytes = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
        let hash = xue_mint_server::media::hash_bytes(&bytes);
        let response = http
            .put(format!("{base}/assets/upload/{hash}?final=1"))
            .header("Authorization", auth(&credential))
            .header("x-total", bytes.len().to_string())
            .body(bytes)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
    }

    // Page 1: limit=1 returns exactly one item and a cursor.
    let page1: Value = http
        .get(format!("{base}/assets?limit=1"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page1["items"].as_array().unwrap().len(), 1);
    let cursor = page1["nextCursor"].as_str().unwrap().to_string();
    ids.push(page1["items"][0]["id"].as_str().unwrap().to_string());

    // Page 2 and 3: different items, last page has no cursor.
    let page2: Value = http
        .get(format!("{base}/assets?limit=1&cursor={cursor}"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page2["items"].as_array().unwrap().len(), 1);
    assert_ne!(
        page2["items"][0]["id"], ids[0],
        "pages must not repeat items"
    );
    let cursor2 = page2["nextCursor"].as_str().unwrap().to_string();

    let page3: Value = http
        .get(format!("{base}/assets?limit=1&cursor={cursor2}"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page3["items"].as_array().unwrap().len(), 1);
    assert_ne!(page3["items"][0]["id"], ids[0]);
    assert!(page3["nextCursor"].is_null(), "last page has no cursor");

    // Delete (default behavior: index only; file stays on disk).
    let id = page1["items"][0]["id"].as_str().unwrap().to_string();
    let response = http
        .delete(format!("{base}/assets/{id}"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 204);

    let count = sqlx::query("SELECT COUNT(*) AS n FROM assets")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count.get::<i64, _>("n"),
        2,
        "index row removed, others kept"
    );

    // Deleted asset endpoints answer 404 afterwards.
    let response = http
        .get(format!("{base}/assets/{id}/thumb"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 404);
}

#[tokio::test]
async fn watcher_indexes_files_dropped_into_photos_folder() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = test_config(dir.path());
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    let state = AppState::new(cfg, pool);

    let _watcher = xue_mint_server::watch::start(state.clone()).unwrap();

    let bytes = test_jpeg();
    let hash = xue_mint_server::media::hash_bytes(&bytes);
    let path = state.cfg.photos_dir.join("dropped-live.jpg");
    std::fs::File::create(&path)
        .unwrap()
        .write_all(&bytes)
        .unwrap();

    // The watcher reacts within a couple of seconds; poll the database.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let count = sqlx::query("SELECT COUNT(*) AS n FROM assets")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get::<i64, _>("n");
        if count == 1 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "watcher did not index the dropped file in time"
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    assert!(state.cfg.thumbs_dir().join(format!("{hash}.jpg")).exists());
}

#[tokio::test]
async fn ingest_indexes_dropped_file() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = test_config(dir.path());
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    let state = AppState::new(cfg, pool);

    let bytes = test_jpeg();
    let hash = xue_mint_server::media::hash_bytes(&bytes);
    let file_path = state.cfg.photos_dir.join("dropped.jpg");
    std::fs::File::create(&file_path)
        .unwrap()
        .write_all(&bytes)
        .unwrap();

    xue_mint_server::ingest::ingest_file(&state, &file_path)
        .await
        .unwrap();

    let count = sqlx::query("SELECT COUNT(*) AS n FROM assets")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count.get::<i64, _>("n"), 1);
    assert!(state.cfg.thumbs_dir().join(format!("{hash}.jpg")).exists());

    // Ingesting the same file again must not create a second row.
    xue_mint_server::ingest::ingest_file(&state, &file_path)
        .await
        .unwrap();
    let count = sqlx::query("SELECT COUNT(*) AS n FROM assets")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count.get::<i64, _>("n"), 1);
}

#[tokio::test]
async fn exif_date_gps_and_orientation_are_extracted() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = test_config(dir.path());
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    let state = AppState::new(cfg, pool);

    let path = state.cfg.photos_dir.join("with-exif.jpg");
    std::fs::write(&path, exif_jpeg()).unwrap();

    let meta = xue_mint_server::media::exif::read(&path)
        .expect("EXIF reader should parse generated EXIF JPEG");
    assert_eq!(meta.taken_at.as_deref(), Some("2024-01-15T10:30:00"));
    assert_eq!(meta.gps.as_deref(), Some("-37.500000,-122.250000"));
    assert_eq!(meta.orientation, 6);

    xue_mint_server::ingest::ingest_file(&state, &path)
        .await
        .unwrap();
    let row = sqlx::query("SELECT taken_at, gps, width, height FROM assets")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        row.get::<Option<String>, _>("taken_at").as_deref(),
        Some("2024-01-15T10:30:00")
    );
    assert_eq!(
        row.get::<Option<String>, _>("gps").as_deref(),
        Some("-37.500000,-122.250000")
    );
    assert_eq!(row.get::<Option<i64>, _>("width"), Some(48));
    assert_eq!(row.get::<Option<i64>, _>("height"), Some(64));
}

#[tokio::test]
async fn video_thumbnail_uses_ffmpeg_first_frame() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = test_config(dir.path());
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    let state = AppState::new(cfg, pool);

    let video = state.cfg.photos_dir.join("generated.mp4");
    let generated = std::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=64x48:d=1",
            "-frames:v",
            "1",
            "-c:v",
            "mpeg4",
        ])
        .arg(&video)
        .output();
    let generated = match generated {
        Ok(output) if output.status.success() => output,
        Ok(output) => panic!(
            "ffmpeg fixture generation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("ffmpeg not installed; skipping real video thumbnail test");
            return;
        }
        Err(error) => panic!("cannot run ffmpeg: {error}"),
    };
    let _ = generated;
    assert!(std::fs::metadata(&video).unwrap().len() > 0);

    xue_mint_server::ingest::ingest_file(&state, &video)
        .await
        .unwrap();
    let row = sqlx::query("SELECT hash, type FROM assets")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("type"), "video");
    let hash: String = row.get("hash");
    let thumb_path = state.cfg.thumbs_dir().join(format!("{hash}.jpg"));
    let thumb = image::ImageReader::open(thumb_path)
        .unwrap()
        .decode()
        .unwrap();
    assert_eq!(thumb.dimensions(), (400, 300));
    let center = thumb.to_rgb8().get_pixel(200, 150).0;
    assert!(
        center[0] > 180 && center[1] < 80 && center[2] < 80,
        "expected red video frame, got {center:?}"
    );
}

#[tokio::test]
async fn undecodable_photo_gets_placeholder_thumbnail() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = test_config(dir.path());
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    let state = AppState::new(cfg, pool);

    // Bytes that are NOT a valid HEIC file: the placeholder thumbnail path.
    let file_path = state.cfg.photos_dir.join("broken.heic");
    std::fs::write(&file_path, [0u8, 1, 2, 3, 4, 5]).unwrap();

    xue_mint_server::ingest::ingest_file(&state, &file_path)
        .await
        .unwrap();

    let row = sqlx::query("SELECT hash FROM assets")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let hash: String = row.get("hash");
    assert!(
        state.cfg.thumbs_dir().join(format!("{hash}.jpg")).exists(),
        "placeholder thumbnail expected for undecodable input"
    );
}

// ---------------------------------------------------------------------------
// Gallery on this PC: session cookie, loopback-only endpoints, settings, static
// files.
// ---------------------------------------------------------------------------

fn session_cookie(response: &reqwest::Response) -> String {
    let raw = response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .expect("session response must set a cookie")
        .to_str()
        .unwrap()
        .to_string();
    for expected in [
        "xm_session=",
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Path=/",
    ] {
        assert!(
            raw.contains(expected),
            "session cookie missing {expected}: {raw}"
        );
    }
    raw.split(';').next().unwrap().to_string()
}

async fn put_settings(
    http: &reqwest::Client,
    base: &str,
    cookie: &str,
    body: Value,
) -> reqwest::Response {
    http.put(format!("{base}/local/settings"))
        .header("Cookie", cookie)
        .json(&body)
        .send()
        .await
        .unwrap()
}

async fn body_text(response: axum::response::Response) -> String {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn local_session_cookie_unlocks_gallery_and_hides_local_identity() {
    let (base, pool) = start_server().await;
    let http = client();

    let response = http
        .post(format!("{base}/local/session"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 204);
    let cookie = session_cookie(&response);

    // A second visit reuses the stored credential instead of minting a new one.
    let again = http
        .post(format!("{base}/local/session"))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status().as_u16(), 204);
    assert_eq!(session_cookie(&again), cookie);

    // Only the hash is stored; the plaintext credential never reaches SQLite.
    let credential = cookie.strip_prefix("xm_session=").unwrap().to_string();
    let row = sqlx::query("SELECT credential_hash, revoked FROM devices WHERE id = 'local'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let stored: String = row.get("credential_hash");
    assert_eq!(stored.len(), 64);
    assert_ne!(stored, credential);
    assert_eq!(row.get::<i64, _>("revoked"), 0);

    // Cookie authentication works for JSON endpoints and image endpoints alike.
    let assets = http
        .get(format!("{base}/assets"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(assets.status().as_u16(), 200);

    let status = http
        .get(format!("{base}/local/status"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(status.status().as_u16(), 200);
    let summary: Value = status.json().await.unwrap();
    assert_eq!(summary["assetCount"], 0);
    assert_eq!(summary["photoCount"], 0);
    assert_eq!(summary["videoCount"], 0);

    // The built-in gallery identity is not a paired device and cannot be revoked.
    let devices = http
        .get(format!("{base}/devices"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(devices.status().as_u16(), 200);
    let body: Value = devices.json().await.unwrap();
    assert_eq!(body["devices"].as_array().unwrap().len(), 0);

    let revoke = http
        .delete(format!("{base}/devices/local"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(revoke.status().as_u16(), 404);
}

#[tokio::test]
async fn local_endpoints_reject_requests_without_loopback_identity() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = test_config(dir.path());
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    let app = build_router(AppState::new(cfg, pool));

    // No ConnectInfo extension means the transport identity is unavailable; the
    // server must refuse rather than fall back to a header or trust the caller.
    for (method, uri) in [
        ("GET", "/local/status"),
        ("GET", "/local/settings"),
        ("POST", "/local/session"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("Host", "127.0.0.1")
                    .header("Origin", "https://127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "{method} {uri} must require loopback transport identity"
        );
    }
}

#[tokio::test]
async fn settings_validate_persist_and_report_restart() {
    let (base, pool) = start_server().await;
    let http = client();
    let cookie = session_cookie(
        &http
            .post(format!("{base}/local/session"))
            .send()
            .await
            .unwrap(),
    );

    let current = http
        .get(format!("{base}/local/settings"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(current.status().as_u16(), 200);
    let current: Value = current.json().await.unwrap();
    assert_eq!(current["deleteBehavior"], "index_only");
    assert_eq!(current["restartRequired"], false);
    let active_port = current["activePort"].clone();

    for invalid in [
        json!({ "deleteBehavior": "nuke" }),
        json!({ "port": 80 }),
        json!({ "photosFolder": "relative/photos" }),
        json!({ "photosFolder": "   " }),
    ] {
        let response = put_settings(&http, &base, &cookie, invalid.clone()).await;
        assert_eq!(
            response.status().as_u16(),
            400,
            "invalid settings must be rejected: {invalid}"
        );
    }

    let folder = dir_with_new_photos();
    let folder_text = folder.to_string_lossy().into_owned();
    let saved = put_settings(
        &http,
        &base,
        &cookie,
        json!({
            "photosFolder": folder_text,
            "port": 9000,
            "deleteBehavior": "delete_file"
        }),
    )
    .await;
    assert_eq!(saved.status().as_u16(), 200);
    let saved: Value = saved.json().await.unwrap();
    assert_eq!(saved["restartRequired"], true);
    assert_eq!(saved["port"], 9000);
    assert_eq!(saved["deleteBehavior"], "delete_file");
    assert_eq!(saved["activePort"], active_port);

    let reloaded = http
        .get(format!("{base}/local/settings"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    let reloaded: Value = reloaded.json().await.unwrap();
    assert_eq!(reloaded["port"], 9000);
    assert_eq!(reloaded["photosFolder"], folder_text);
    assert_eq!(reloaded["deleteBehavior"], "delete_file");
    assert_eq!(reloaded["restartRequired"], true);

    let stored_port = sqlx::query("SELECT value FROM settings WHERE key = 'port'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored_port.get::<String, _>("value"), "9000");
    let stored_behavior = sqlx::query("SELECT value FROM settings WHERE key = 'delete_behavior'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored_behavior.get::<String, _>("value"), "delete_file");

    if let Some(parent) = folder.parent() {
        std::fs::remove_dir_all(parent).ok();
    }
}

/// Creates a unique folder path for settings tests without leaving files behind.
fn dir_with_new_photos() -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!("xue-mint-settings-{}", std::process::id()));
    base.join(format!("photos-{}", uuid::Uuid::new_v4()))
}

#[tokio::test]
async fn built_gallery_is_served_with_spa_fallback_and_api_precedence() {
    let dir = tempfile::tempdir().unwrap();
    let web_dir = dir.path().join("web");
    std::fs::create_dir_all(&web_dir).unwrap();
    std::fs::write(
        web_dir.join("index.html"),
        "<!doctype html><title>gallery-marker</title><div id=\"root\"></div>",
    )
    .unwrap();

    let cfg = Config {
        web_dir: Some(web_dir),
        ..test_config(dir.path())
    };
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    let app = build_router(AppState::new(cfg, pool));

    // Site root and unknown application paths resolve to the gallery entry point.
    for uri in ["/", "/library/2024", "/some/deep/route"] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "{uri} must serve the gallery"
        );
        assert!(
            body_text(response).await.contains("gallery-marker"),
            "{uri} must return the gallery entry point"
        );
    }

    // Files outside the built gallery (the database, for example) are never served.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/data/library.db")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_text(response).await;
    assert!(body.contains("gallery-marker"));
    assert!(!body.contains("SQLite format 3"));

    // API routes keep precedence over the static fallback and still authenticate.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/assets")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(body_text(response).await.contains("AUTH_REQUIRED"));

    // Loopback-only endpoints stay closed when the transport identity is missing.
    let response = app
        .oneshot(
            Request::builder()
                .uri("/local/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

/// Starts a server and keeps the state so a test can index files directly.
async fn start_server_state() -> (String, sqlx::SqlitePool, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = test_config(dir.path());
    cfg.ensure_dirs().unwrap();
    let pool = db::open(&cfg).await.unwrap();
    db::apply_defaults(&pool).await.unwrap();
    let state = AppState::new(cfg.clone(), pool.clone());

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let serving = state.clone();
    tokio::spawn(async move {
        serve_on(serving, listener).await.unwrap();
    });
    std::mem::forget(dir);

    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await;

    (format!("https://127.0.0.1:{port}"), pool, state)
}

#[tokio::test]
async fn delete_behavior_controls_whether_the_file_is_removed() {
    let (base, pool, state) = start_server_state().await;
    let http = client();
    let cookie = session_cookie(
        &http
            .post(format!("{base}/local/session"))
            .send()
            .await
            .unwrap(),
    );

    async fn add_photo(state: &AppState, pool: &sqlx::SqlitePool, name: &str) -> String {
        let path = state.cfg.photos_dir.join(name);
        // Different trailing bytes keep the two fixtures from deduplicating.
        let mut bytes = test_jpeg();
        bytes.extend_from_slice(name.as_bytes());
        std::fs::write(&path, bytes).unwrap();
        xue_mint_server::ingest::ingest_file(state, &path)
            .await
            .unwrap();
        sqlx::query("SELECT id FROM assets WHERE filename = ?")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap()
            .get("id")
    }

    // delete_file removes the stored file from disk.
    let delete_file_id = add_photo(&state, &pool, "delete-me.jpg").await;
    let keep_on_index_id = add_photo(&state, &pool, "keep-me.jpg").await;
    let delete_file_path = state.cfg.photos_dir.join("delete-me.jpg");

    let saved = put_settings(
        &http,
        &base,
        &cookie,
        json!({ "deleteBehavior": "delete_file" }),
    )
    .await;
    assert_eq!(saved.status().as_u16(), 200);

    let response = http
        .delete(format!("{base}/assets/{delete_file_id}"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 204);
    assert!(
        !delete_file_path.exists(),
        "delete_file must remove the file from disk"
    );

    // index_only keeps the file while removing the library entry.
    let keep_path = state.cfg.photos_dir.join("keep-me.jpg");
    let saved = put_settings(
        &http,
        &base,
        &cookie,
        json!({ "deleteBehavior": "index_only" }),
    )
    .await;
    assert_eq!(saved.status().as_u16(), 200);

    let response = http
        .delete(format!("{base}/assets/{keep_on_index_id}"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 204);
    assert!(keep_path.exists(), "index_only must keep the file on disk");

    let remaining: i64 = sqlx::query("SELECT COUNT(*) AS n FROM assets")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(remaining, 0);
}
