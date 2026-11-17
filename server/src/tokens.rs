//! Pairing tokens: single-use, expire within minutes of being minted.
//! Tokens live in the database so the desktop app (any process) can mint one
//! for the QR window while the server keeps running.

use chrono::Utc;
use sqlx::SqlitePool;

const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/L/0/1: they are easy to confuse

/// Creates a one-time pairing token valid for `ttl_secs` seconds and stores it.
pub async fn create_token(pool: &SqlitePool, ttl_secs: i64) -> anyhow::Result<String> {
    let token = random_token();
    let now = Utc::now();
    let expires = (now + chrono::Duration::seconds(ttl_secs))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let created = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    sqlx::query("INSERT INTO pairing_tokens (token, created_at, expires_at, used) VALUES (?, ?, ?, 0)")
        .bind(&token)
        .bind(&created)
        .bind(&expires)
        .execute(pool)
        .await?;
    Ok(token)
}

/// A 16-character code grouped for reading aloud, e.g. "K7QP-2M4X-C9RT-B3HN".
fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let groups: Vec<String> = bytes
        .chunks(4)
        .map(|chunk| {
            chunk
                .iter()
                .map(|b| {
                    let idx = (*b as usize) % ALPHABET.len();
                    ALPHABET[idx] as char
                })
                .collect::<String>()
        })
        .collect();
    groups.join("-")
}
