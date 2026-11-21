//! Hardening checks: HEIC/RAW ingest, Live Photo pairing, EXIF fallbacks,
//! upload integrity, pairing-token safety and the optional folder mirror.

mod support;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use image::GenericImageView;
use serde_json::{json, Value};
use sqlx::Row;
use support::*;
use xue_mint_server::{ingest, media};

#[tokio::test]
async fn heic_still_is_decoded_and_thumbnailed() {
    let (_dir, state) = support::state().await;
    let path = state.photos_dir().join("iphone-still.heic");
    std::fs::write(&path, test_heic(64, 48, [20, 210, 70])).unwrap();

    ingest::ingest_file(&state, &path).await.unwrap();

    let row = sqlx::query("SELECT hash, type, width, height FROM assets")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("type"), "photo");
    assert_eq!(row.get::<Option<i64>, _>("width"), Some(64));
    assert_eq!(row.get::<Option<i64>, _>("height"), Some(48));

    let hash: String = row.get("hash");
    let thumbnail = image::ImageReader::open(state.cfg.thumbs_dir().join(format!("{hash}.jpg")))
        .unwrap()
        .decode()
        .unwrap();
    // The thumbnail fits the 400px box, so the 4:3 source becomes 400x300;
    // the pixel check below separates a real decode from the neutral placeholder.
    assert_eq!(thumbnail.dimensions(), (400, 300));
    let center = thumbnail.to_rgb8().get_pixel(200, 150).0;
    assert!(
        center[1] > center[0] && center[1] > center[2],
        "thumbnail should contain the green HEIC image, got {center:?}"
    );
}

#[tokio::test]
async fn raw_file_uses_its_embedded_preview() {
    let (_dir, state) = support::state().await;
    let preview = test_jpeg([25, 55, 225]);
    let mut raw = b"II*\0\x08\0\0\0".to_vec();
    raw.extend_from_slice(&preview);

    let path = state.photos_dir().join("camera-shot.dng");
    std::fs::write(&path, &raw).unwrap();
    ingest::ingest_file(&state, &path).await.unwrap();

    let row = sqlx::query("SELECT hash, type, width, height FROM assets")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("type"), "photo");
    assert_eq!(row.get::<Option<i64>, _>("width"), Some(64));
    assert_eq!(row.get::<Option<i64>, _>("height"), Some(48));

    let hash: String = row.get("hash");
    let thumbnail = image::ImageReader::open(state.cfg.thumbs_dir().join(format!("{hash}.jpg")))
        .unwrap()
        .decode()
        .unwrap();
    let center = thumbnail.to_rgb8().get_pixel(32, 24).0;
    assert!(
        center[2] > center[0] && center[2] > center[1],
        "thumbnail should come from the embedded blue preview, got {center:?}"
    );
}

#[tokio::test]
async fn live_photo_pairs_stay_one_visible_asset_in_both_orders() {
    let (_dir, base, pool, state, _handle) = support::start().await;
    let http = client();
    let credential = pair(&http, &base, &pool, "live-photo-phone").await;

    // Arrival order 1: the video is indexed first, then its still arrives.
    let video_one = state.photos_dir().join("IMG_0001.MOV");
    std::fs::write(&video_one, b"live photo video one").unwrap();
    ingest::ingest_file(&state, &video_one).await.unwrap();
    let photo_one = state.photos_dir().join("IMG_0001.jpg");
    std::fs::write(
        &photo_one,
        unique_jpeg("live-one", Some("2024:01:15 10:30:00"), 1),
    )
    .unwrap();
    ingest::ingest_file(&state, &photo_one).await.unwrap();

    // Arrival order 2: the still exists first, so the video is never indexed.
    let photo_two = state.photos_dir().join("IMG_0002.jpg");
    std::fs::write(
        &photo_two,
        unique_jpeg("live-two", Some("2024:02:20 09:00:00"), 1),
    )
    .unwrap();
    ingest::ingest_file(&state, &photo_two).await.unwrap();
    let video_two = state.photos_dir().join("IMG_0002.mov");
    std::fs::write(&video_two, b"live photo video two").unwrap();
    ingest::ingest_file(&state, &video_two).await.unwrap();

    let rows = sqlx::query("SELECT filename, type, hidden, live_video_path FROM assets")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        3,
        "two stills plus the video that arrived first"
    );
    let visible = rows
        .iter()
        .filter(|row| row.get::<i64, _>("hidden") == 0)
        .count();
    assert_eq!(visible, 2, "one visible asset per Live Photo");
    assert!(
        !rows
            .iter()
            .any(|row| row.get::<String, _>("filename") == "IMG_0002.mov"),
        "the late video must not become a second asset"
    );

    let first_photo = rows
        .iter()
        .find(|row| row.get::<String, _>("filename") == "IMG_0001.jpg")
        .expect("first still row");
    assert_eq!(first_photo.get::<i64, _>("hidden"), 0);
    assert_eq!(
        first_photo.get::<Option<String>, _>("live_video_path"),
        Some(video_one.to_string_lossy().into_owned())
    );
    let first_video = rows
        .iter()
        .find(|row| row.get::<String, _>("filename") == "IMG_0001.MOV")
        .expect("companion video row");
    assert_eq!(first_video.get::<i64, _>("hidden"), 1);

    // The timeline shows one item per pair, dated by the still.
    let timeline: Value = http
        .get(format!("{base}/assets"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let items = timeline["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["takenAt"], "2024-02-20T09:00:00");
    assert!(items.iter().all(|item| item["type"] == "photo"));

    let cookie = local_cookie(&http, &base).await;
    let summary: Value = http
        .get(format!("{base}/local/status"))
        .header("Cookie", cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(summary["photoCount"], 2);
    assert_eq!(summary["videoCount"], 0);
    assert_eq!(summary["assetCount"], 2);
}

#[tokio::test]
async fn exif_edge_cases_fall_back_to_the_file_date() {
    let (_dir, state) = support::state().await;

    let screenshot = state.photos_dir().join("Screenshot.png");
    std::fs::write(&screenshot, test_png([245, 245, 245])).unwrap();
    set_modified(&screenshot, "2024-05-06T07:08:09Z");
    ingest::ingest_file(&state, &screenshot).await.unwrap();

    let zeroed = state.photos_dir().join("zero-date.jpg");
    std::fs::write(
        &zeroed,
        unique_jpeg("zero-date", Some("0000:00:00 00:00:00"), 1),
    )
    .unwrap();
    set_modified(&zeroed, "2024-05-07T08:09:10Z");
    ingest::ingest_file(&state, &zeroed).await.unwrap();

    let valid = state.photos_dir().join("valid-date.jpg");
    std::fs::write(
        &valid,
        unique_jpeg("valid-date", Some("2024:01:15 10:30:00"), 6),
    )
    .unwrap();
    ingest::ingest_file(&state, &valid).await.unwrap();

    let odd = state.photos_dir().join("odd-orientation.jpg");
    std::fs::write(
        &odd,
        unique_jpeg("odd-orientation", Some("2024:02:02 02:02:02"), 99),
    )
    .unwrap();
    ingest::ingest_file(&state, &odd).await.unwrap();

    let dates = sqlx::query("SELECT filename, taken_at, width, height FROM assets")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    let find = |name: &str| {
        dates
            .iter()
            .find(|row| row.get::<String, _>("filename") == name)
            .unwrap_or_else(|| panic!("missing row for {name}"))
    };

    assert_eq!(
        find("Screenshot.png").get::<Option<String>, _>("taken_at"),
        Some("2024-05-06T07:08:09Z".to_string()),
        "screenshots fall back to the file date"
    );
    assert_eq!(
        find("zero-date.jpg").get::<Option<String>, _>("taken_at"),
        Some("2024-05-07T08:09:10Z".to_string()),
        "zeroed EXIF falls back to the file date"
    );
    assert_eq!(
        find("valid-date.jpg").get::<Option<String>, _>("taken_at"),
        Some("2024-01-15T10:30:00".to_string())
    );
    assert_eq!(
        find("valid-date.jpg").get::<Option<i64>, _>("width"),
        Some(48),
        "orientation 6 swaps the stored dimensions"
    );
    assert_eq!(
        find("valid-date.jpg").get::<Option<i64>, _>("height"),
        Some(64)
    );
    assert_eq!(
        find("odd-orientation.jpg").get::<Option<i64>, _>("width"),
        Some(64),
        "an unknown orientation must not transpose the image"
    );

    // Timeline order is driven by the resolved dates.
    let ordered = sqlx::query(
        "SELECT filename FROM assets ORDER BY COALESCE(taken_at, added_at) DESC, id DESC",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap();
    let names: Vec<String> = ordered
        .iter()
        .map(|row| row.get::<String, _>("filename"))
        .collect();
    assert!(names.contains(&"Screenshot.png".to_string()));
    assert!(names.contains(&"valid-date.jpg".to_string()));
}

#[tokio::test]
async fn pairing_tokens_are_single_use_under_concurrency() {
    let (_dir, base, pool, _state, _handle) = support::start().await;
    let http = client();
    let token = xue_mint_server::tokens::create_token(&pool, 600)
        .await
        .unwrap();

    let first = http
        .post(format!("{base}/pair"))
        .json(&json!({
            "token": token,
            "devicePublicKey": BASE64.encode(b"concurrent-a"),
            "deviceName": "Phone A"
        }))
        .send();
    let second = http
        .post(format!("{base}/pair"))
        .json(&json!({
            "token": token,
            "devicePublicKey": BASE64.encode(b"concurrent-b"),
            "deviceName": "Phone B"
        }))
        .send();
    let (first, second) = tokio::join!(first, second);
    let first = first.unwrap();
    let second = second.unwrap();
    let mut statuses = [first.status().as_u16(), second.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 401], "exactly one pairing may win");

    let failed = if first.status().as_u16() == 401 {
        first
    } else {
        second
    };
    assert_eq!(
        failed.json::<Value>().await.unwrap()["code"],
        "PAIR_TOKEN_USED"
    );

    // An expired code is reported separately so the UI can ask for a fresh QR.
    sqlx::query(
        "INSERT INTO pairing_tokens (token, created_at, expires_at, used) VALUES (?, ?, ?, 0)",
    )
    .bind("EXPIRED-CODE-1234")
    .bind("2000-01-01T00:00:00Z")
    .bind("2000-01-01T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();
    let response = http
        .post(format!("{base}/pair"))
        .json(&json!({
            "token": "EXPIRED-CODE-1234",
            "devicePublicKey": BASE64.encode(b"late-phone"),
            "deviceName": "Late Phone"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 401);
    assert_eq!(
        response.json::<Value>().await.unwrap()["code"],
        "PAIR_TOKEN_EXPIRED"
    );
}

#[tokio::test]
async fn corrupt_and_interrupted_uploads_leave_no_asset() {
    let (_dir, base, pool, state, _handle) = support::start().await;
    let http = client();
    let credential = pair(&http, &base, &pool, "integrity-phone").await;

    // --- wrong bytes are rejected and the temp file is removed ---
    let expected = b"the correct photo bytes".to_vec();
    let expected_hash = media::hash_bytes(&expected);
    let wrong = b"these are different bytes".to_vec();
    let response = http
        .put(format!("{base}/assets/upload/{expected_hash}?final=1"))
        .header("Authorization", auth(&credential))
        .header("x-total", wrong.len().to_string())
        .header("x-filename", "wrong.jpg")
        .body(wrong)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 409);
    assert_eq!(
        response.json::<Value>().await.unwrap()["code"],
        "HASH_MISMATCH"
    );
    let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM assets")
        .fetch_one(&state.pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(count, 0, "corrupt bytes must never become an asset");
    assert_eq!(
        std::fs::read_dir(state.cfg.tmp_dir()).unwrap().count(),
        0,
        "the rejected temp file is cleaned up"
    );

    // --- the first chunk completes, then the connection drops mid-chunk ---
    let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let hash = media::hash_bytes(&bytes);
    let response = http
        .put(format!("{base}/assets/upload/{hash}"))
        .header("Authorization", auth(&credential))
        .header("offset", "0")
        .header("x-total", bytes.len().to_string())
        .header("x-filename", "drop.jpg")
        .body(bytes[..150_000].to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.json::<Value>().await.unwrap()["offset"], 150_000);

    let partial = bytes[150_000..200_000].to_vec();
    let stream = futures_util::stream::iter(vec![
        Ok::<Vec<u8>, std::io::Error>(partial),
        Err(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "simulated network drop",
        )),
    ]);
    let result = http
        .put(format!("{base}/assets/upload/{hash}"))
        .header("Authorization", auth(&credential))
        .header("offset", "150000")
        .header("x-total", bytes.len().to_string())
        .header("x-filename", "drop.jpg")
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await;
    match result {
        Ok(response) => assert!(
            !response.status().is_success(),
            "an interrupted body must not finalize the upload"
        ),
        Err(_) => {}
    }
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM assets")
        .fetch_one(&state.pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(count, 0, "no asset before the upload completes");
    let offset: i64 = sqlx::query("SELECT offset FROM uploads WHERE hash = ?")
        .bind(&hash)
        .fetch_one(&state.pool)
        .await
        .unwrap()
        .get("offset");
    assert_eq!(
        offset, 150_000,
        "only completed chunks move the resume offset"
    );

    // --- resuming from the last committed chunk verifies the whole file ---
    let response = http
        .put(format!("{base}/assets/upload/{hash}?final=1"))
        .header("Authorization", auth(&credential))
        .header("offset", "150000")
        .header("x-total", bytes.len().to_string())
        .header("x-filename", "drop.jpg")
        .body(bytes[150_000..].to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let done: Value = response.json().await.unwrap();
    assert_eq!(done["stored"], true);

    let timeline: Value = http
        .get(format!("{base}/assets"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = timeline["items"][0]["id"].as_str().unwrap().to_string();
    let original = http
        .get(format!("{base}/assets/{id}/original"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(original.as_ref(), bytes.as_slice());
}

#[tokio::test]
async fn upload_resumes_after_a_server_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (base, pool, state, handle) = serve_from(dir.path()).await;
    let http = client();
    let credential = pair(&http, &base, &pool, "restart-phone").await;

    let bytes: Vec<u8> = (0..400_000u32).map(|i| (i % 253) as u8).collect();
    let hash = media::hash_bytes(&bytes);
    let first = http
        .put(format!("{base}/assets/upload/{hash}"))
        .header("Authorization", auth(&credential))
        .header("offset", "0")
        .header("x-total", bytes.len().to_string())
        .header("x-filename", "restart.jpg")
        .body(bytes[..200_000].to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(first.status().as_u16(), 200);
    assert_eq!(first.json::<Value>().await.unwrap()["offset"], 200_000);

    // Simulate the PC going away mid-upload.
    handle.abort();
    drop(state);
    drop(pool);
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;

    let (base, pool, state, _handle) = serve_from(dir.path()).await;
    let response = http
        .put(format!("{base}/assets/upload/{hash}?final=1"))
        .header("Authorization", auth(&credential))
        .header("offset", "200000")
        .header("x-total", bytes.len().to_string())
        .header("x-filename", "restart.jpg")
        .body(bytes[200_000..].to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.json::<Value>().await.unwrap()["stored"], true);

    let status: String = sqlx::query("SELECT status FROM uploads WHERE hash = ?")
        .bind(&hash)
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("status");
    assert_eq!(status, "complete");

    let timeline: Value = http
        .get(format!("{base}/assets"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = timeline["items"][0]["id"].as_str().unwrap().to_string();
    let original = http
        .get(format!("{base}/assets/{id}/original"))
        .header("Authorization", auth(&credential))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(original.as_ref(), bytes.as_slice());
    assert_eq!(
        state.cfg.thumbs_dir().read_dir().unwrap().count(),
        1,
        "the thumbnail is generated for the resumed asset"
    );
}

#[tokio::test]
async fn oversized_and_odd_requests_are_rejected_without_side_effects() {
    let (_dir, base, pool, state, _handle) = support::start().await;
    let http = client();
    let credential = pair(&http, &base, &pool, "bounds-phone").await;

    // A colon in the extension must not become an NTFS stream name.
    let bytes = unique_jpeg("stream-name", None, 1);
    let hash = media::hash_bytes(&bytes);
    let response = http
        .put(format!("{base}/assets/upload/{hash}?final=1"))
        .header("Authorization", auth(&credential))
        .header("x-total", bytes.len().to_string())
        .header("x-filename", "evil.jpg%3Astream")
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let stored: String = sqlx::query("SELECT path FROM assets WHERE hash = ?")
        .bind(&hash)
        .fetch_one(&state.pool)
        .await
        .unwrap()
        .get("path");
    assert!(stored.ends_with(".jpg"), "extension sanitized: {stored}");
    assert!(!stored.contains(':'), "no stream name: {stored}");
    assert!(state.photos_dir().join(&stored).is_file());

    // An offset beyond the declared total is a client bug, not a resume.
    let response = http
        .put(format!("{base}/assets/upload/{hash}"))
        .header("Authorization", auth(&credential))
        .header("offset", "100")
        .header("x-total", "50")
        .body(Vec::new())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);

    // Too many hashes in one check.
    let hashes: Vec<String> = (0..5001).map(|index| format!("{index:064x}")).collect();
    let response = http
        .post(format!("{base}/assets/check"))
        .header("Authorization", auth(&credential))
        .json(&json!({ "hashes": hashes }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);

    // Unbounded search text.
    let long_query = "a".repeat(201);
    let response = http
        .get(format!("{base}/assets"))
        .header("Authorization", auth(&credential))
        .query(&[("q", long_query.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);

    // Oversized pairing public keys are refused before any token is claimed.
    let token = xue_mint_server::tokens::create_token(&pool, 600)
        .await
        .unwrap();
    let response = http
        .post(format!("{base}/pair"))
        .json(&json!({
            "token": token,
            "devicePublicKey": "A".repeat(5000),
            "deviceName": "Huge Key"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);
}

#[tokio::test]
async fn mirror_copies_new_files_and_reports_a_missing_drive() {
    let (dir, base, pool, state, _handle) = support::start().await;
    let http = client();
    let cookie = local_cookie(&http, &base).await;

    let mirror = dir.path().join("mirror");
    std::fs::create_dir_all(&mirror).unwrap();
    let saved: Value = http
        .put(format!("{base}/local/settings"))
        .header("Cookie", &cookie)
        .json(&json!({ "mirrorFolder": mirror.to_string_lossy() }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved["mirrorAvailable"], true);

    let credential = pair(&http, &base, &pool, "mirror-phone").await;
    let uploaded = unique_jpeg("mirror-upload", None, 1);
    let uploaded_hash = media::hash_bytes(&uploaded);
    let response = http
        .put(format!("{base}/assets/upload/{uploaded_hash}?final=1"))
        .header("Authorization", auth(&credential))
        .header("x-total", uploaded.len().to_string())
        .header("x-filename", "mirror-upload.jpg")
        .body(uploaded.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let mirrored = mirror
        .join(&uploaded_hash[..2])
        .join(format!("{uploaded_hash}.jpg"));
    assert!(mirrored.is_file(), "uploaded file must be mirrored");
    assert_eq!(std::fs::read(&mirrored).unwrap(), uploaded);

    // Files dropped into the watched folder are mirrored too.
    let watched = unique_jpeg("mirror-watched", None, 1);
    let dropped = state.photos_dir().join("dropped.jpg");
    std::fs::write(&dropped, &watched).unwrap();
    ingest::ingest_file(&state, &dropped).await.unwrap();
    assert_eq!(
        std::fs::read(mirror.join("dropped.jpg")).unwrap(),
        watched,
        "watched-folder files keep their relative path in the mirror"
    );

    // An unplugged drive is reported, and uploads keep working without creating it.
    let missing = dir.path().join("unplugged-drive");
    let saved: Value = http
        .put(format!("{base}/local/settings"))
        .header("Cookie", &cookie)
        .json(&json!({ "mirrorFolder": missing.to_string_lossy() }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved["mirrorAvailable"], false);
    assert!(
        !missing.exists(),
        "a missing mirror folder must not be created"
    );

    let second = unique_jpeg("mirror-while-unplugged", None, 1);
    let second_hash = media::hash_bytes(&second);
    let response = http
        .put(format!("{base}/assets/upload/{second_hash}?final=1"))
        .header("Authorization", auth(&credential))
        .header("x-total", second.len().to_string())
        .header("x-filename", "no-mirror.jpg")
        .body(second)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert!(!missing.exists());
}

#[tokio::test]
async fn mirror_follows_renames_and_deletes() {
    let (dir, base, pool, state, _handle) = support::start().await;
    let http = client();
    let cookie = local_cookie(&http, &base).await;
    let mirror = dir.path().join("mirror");
    std::fs::create_dir_all(&mirror).unwrap();
    let _ = pool;

    http.put(format!("{base}/local/settings"))
        .header("Cookie", &cookie)
        .json(&json!({ "mirrorFolder": mirror.to_string_lossy() }))
        .send()
        .await
        .unwrap();

    let original = unique_jpeg("mirror-rename", None, 1);
    let path = state.photos_dir().join("old-name.jpg");
    std::fs::write(&path, &original).unwrap();
    ingest::ingest_file(&state, &path).await.unwrap();
    assert!(mirror.join("old-name.jpg").is_file());

    let id: String = sqlx::query("SELECT id FROM assets WHERE filename = 'old-name.jpg'")
        .fetch_one(&state.pool)
        .await
        .unwrap()
        .get("id");
    let response = http
        .patch(format!("{base}/assets/{id}"))
        .header("Cookie", &cookie)
        .json(&json!({ "filename": "New Name.jpg" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert!(!mirror.join("old-name.jpg").exists());
    assert!(mirror.join("New Name.jpg").is_file());

    http.put(format!("{base}/local/settings"))
        .header("Cookie", &cookie)
        .json(&json!({ "deleteBehavior": "delete_file" }))
        .send()
        .await
        .unwrap();
    let response = http
        .delete(format!("{base}/assets/{id}"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 204);
    assert!(!mirror.join("New Name.jpg").exists(), "mirror copy removed");
    assert!(!state.photos_dir().join("New Name.jpg").exists());
}
