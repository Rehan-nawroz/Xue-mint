//! Response-time checks for a 5,000+ asset library and a multi-GB streaming
//! upload. The huge upload test is ignored by default because it writes 2.5 GB
//! to disk; run it with `cargo test --test performance -- --ignored`.

mod support;

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use serde_json::Value;
use sqlx::Row;
use support::*;
use xue_mint_server::media;

fn percentile(durations: &[Duration], percent: usize) -> Duration {
    let mut sorted = durations.to_vec();
    sorted.sort();
    let index = (sorted.len() * percent / 100).min(sorted.len().saturating_sub(1));
    sorted[index]
}

#[tokio::test]
async fn five_thousand_assets_stay_responsive() {
    let (_dir, base, pool, state, _handle) = support::start().await;
    let http = client();
    let cookie = local_cookie(&http, &base).await;

    let thumbnail = test_jpeg([200, 40, 40]);
    let now = chrono::Utc::now();
    let mut transaction = pool.begin().await.unwrap();
    for index in 0..5200i64 {
        let hash = format!("{index:064x}");
        let filename = format!("IMG_{index:05}.jpg");
        let taken_at = (now - chrono::Duration::seconds(index * 60))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        sqlx::query(
            "INSERT INTO assets (id, hash, filename, type, size, taken_at, gps, width, height, path, added_at) \
             VALUES (?, ?, ?, 'photo', 2048, ?, NULL, 4032, 3024, ?, ?)",
        )
        .bind(format!("perf-{index:05}"))
        .bind(&hash)
        .bind(&filename)
        .bind(&taken_at)
        .bind(format!("{}/{}.jpg", &hash[..2], hash))
        .bind(&taken_at)
        .execute(&mut *transaction)
        .await
        .unwrap();
        std::fs::write(
            state.cfg.thumbs_dir().join(format!("{hash}.jpg")),
            &thumbnail,
        )
        .unwrap();
    }
    transaction.commit().await.unwrap();

    // Warm the TLS connection and page cache, then walk the whole library.
    let _ = http
        .get(format!("{base}/assets?limit=200"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();

    let started = Instant::now();
    let mut cursor: Option<String> = None;
    let mut pages = 0usize;
    let mut seen = 0usize;
    let mut page_times = Vec::new();
    loop {
        let mut request = http.get(format!("{base}/assets?limit=200"));
        if let Some(cursor) = &cursor {
            request = request.query(&[("cursor", cursor.as_str())]);
        }
        let page_started = Instant::now();
        let page: Value = request
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        page_times.push(page_started.elapsed());
        let items = page["items"].as_array().unwrap();
        seen += items.len();
        pages += 1;
        cursor = page["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    let total_time = started.elapsed();
    assert_eq!(seen, 5200, "every asset is reachable through pagination");
    assert!(pages >= 26);
    let max = *page_times.iter().max().unwrap();
    let p95 = percentile(&page_times, 95);
    println!("timeline: {pages} pages, total {total_time:?}, p95 {p95:?}, max {max:?}");
    assert!(
        max < Duration::from_millis(700),
        "slowest page took {max:?}"
    );
    assert!(p95 < Duration::from_millis(300), "p95 page took {p95:?}");
    assert!(
        total_time < Duration::from_secs(8),
        "full pagination took {total_time:?}"
    );

    // Search stays indexed and quick at this size.
    let search_started = Instant::now();
    let found: Value = http
        .get(format!("{base}/assets?limit=200&q=IMG_0500"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let search_time = search_started.elapsed();
    assert!(!found["items"].as_array().unwrap().is_empty());
    println!("search at 5,200 assets: {search_time:?}");
    assert!(search_time < Duration::from_millis(500));

    // Thumbnails are served from disk with no per-request scan.
    let ids: Vec<String> = sqlx::query("SELECT id FROM assets LIMIT 120")
        .fetch_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.get("id"))
        .collect();
    let thumb_started = Instant::now();
    for id in &ids {
        let response = http
            .get(format!("{base}/assets/{id}/thumb"))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let _ = response.bytes().await.unwrap();
    }
    let average = thumb_started.elapsed() / ids.len() as u32;
    println!("thumbnail average: {average:?}");
    assert!(
        average < Duration::from_millis(50),
        "thumbnail average {average:?}"
    );

    let summary: Value = http
        .get(format!("{base}/local/status"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(summary["assetCount"], 5200);
    assert_eq!(summary["photoCount"], 5200);
}

fn rss_bytes() -> u64 {
    let pid = sysinfo::Pid::from_u32(std::process::id());
    let mut system = sysinfo::System::new().expect("system information");
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    system
        .process(pid)
        .map(|process| process.memory())
        .unwrap_or(0)
}

#[tokio::test]
#[ignore = "writes and uploads 2.5 GB; run with --ignored"]
async fn multi_gigabyte_video_upload_stays_streamed() {
    let (dir, base, pool, state, _handle) = support::start().await;
    let http = client();
    let credential = pair(&http, &base, &pool, "large-video-phone").await;

    let total: u64 = 2_500_000_000;
    let source = dir.path().join("large-source.mp4");
    {
        let mut file = std::io::BufWriter::new(std::fs::File::create(&source).unwrap());
        let block = vec![0x5Au8; 1024 * 1024];
        let whole_blocks = total / block.len() as u64;
        for _ in 0..whole_blocks {
            file.write_all(&block).unwrap();
        }
        let remainder = (total % block.len() as u64) as usize;
        file.write_all(&block[..remainder]).unwrap();
        file.flush().unwrap();
    }
    assert_eq!(std::fs::metadata(&source).unwrap().len(), total);

    let hash = media::hash_file_blocking(&source).unwrap();
    let baseline = rss_bytes();
    let mut peak = baseline;
    let mut file = std::fs::File::open(&source).unwrap();
    let mut buffer = vec![0u8; 16 * 1024 * 1024];
    let mut offset: u64 = 0;
    let upload_started = Instant::now();
    loop {
        let read = file.read(&mut buffer).unwrap();
        if read == 0 {
            break;
        }
        offset += read as u64;
        let final_flag = if offset >= total { "1" } else { "0" };
        let response = http
            .put(format!("{base}/assets/upload/{hash}?final={final_flag}"))
            .header("Authorization", auth(&credential))
            .header("offset", (offset - read as u64).to_string())
            .header("x-total", total.to_string())
            .header("x-filename", "large-video.mp4")
            .body(buffer[..read].to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status().as_u16(),
            200,
            "chunk ending at {offset} failed"
        );
        peak = peak.max(rss_bytes());
    }
    assert_eq!(offset, total);

    let growth = peak.saturating_sub(baseline);
    println!(
        "large upload: {total} bytes in {:?}, RSS baseline {baseline}, peak {peak}, growth {growth}",
        upload_started.elapsed()
    );
    assert!(
        growth < 500 * 1024 * 1024,
        "server buffered too much of the video: {growth} bytes"
    );

    let row = sqlx::query("SELECT path, type, size FROM assets WHERE hash = ?")
        .bind(&hash)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("type"), "video");
    assert_eq!(row.get::<i64, _>("size"), total as i64);
    let stored_path: String = row.get("path");
    let stored = state.photos_dir().join(&stored_path);
    assert_eq!(std::fs::metadata(&stored).unwrap().len(), total);
    assert_eq!(media::hash_file_blocking(&stored).unwrap(), hash);
}
