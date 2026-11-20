//! POST /pair — exchange a one-time QR token for a device credential.

use crate::errors::ApiError;
use crate::media::{now_iso, sha256_hex};
use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub token: String,
    pub device_public_key: String,
    pub device_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub credential: String,
}

pub async fn pair(
    State(state): State<AppState>,
    Json(request): Json<PairRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    let token = request.token.trim().to_uppercase();

    let row = sqlx::query("SELECT expires_at, used FROM pairing_tokens WHERE token = ?")
        .bind(&token)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(ApiError::pair_token_invalid)?;

    if row.get::<i64, _>("used") != 0 {
        return Err(ApiError::pair_token_used());
    }
    if now_iso() > row.get::<String, _>("expires_at") {
        return Err(ApiError::pair_token_expired());
    }

    sqlx::query("UPDATE pairing_tokens SET used = 1 WHERE token = ?")
        .bind(&token)
        .execute(&state.pool)
        .await?;

    let public_key = decode_public_key(&request.device_public_key)
        .ok_or_else(|| ApiError::bad_request("devicePublicKey must be valid base64"))?;

    // The credential is 256 bits of random data; only its SHA-256 hash is stored.
    use rand::RngCore;
    let mut credential_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut credential_bytes);
    let credential = URL_SAFE_NO_PAD.encode(credential_bytes);
    let credential_hash = sha256_hex(credential.as_bytes());

    // A phone that pairs again keeps its identity: its public key already
    // has a device row, so the row is updated with a fresh credential and
    // un-revoked instead of colliding on the unique public key.
    let existing: Option<String> = sqlx::query("SELECT id FROM devices WHERE public_key = ?")
        .bind(&public_key)
        .fetch_optional(&state.pool)
        .await?
        .map(|row| row.get::<String, _>("id"));

    let device_id = if let Some(id) = existing {
        sqlx::query(
            "UPDATE devices SET name = ?, credential_hash = ?, paired_at = ?, last_seen_at = ?, revoked = 0 \
             WHERE id = ?",
        )
        .bind(request.device_name.trim())
        .bind(&credential_hash)
        .bind(now_iso())
        .bind(now_iso())
        .bind(&id)
        .execute(&state.pool)
        .await?;
        println!("Re-paired device \"{}\" ({id})", request.device_name.trim());
        id
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO devices (id, name, public_key, credential_hash, paired_at, last_seen_at, revoked) \
             VALUES (?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(&id)
        .bind(request.device_name.trim())
        .bind(&public_key)
        .bind(&credential_hash)
        .bind(now_iso())
        .bind(now_iso())
        .execute(&state.pool)
        .await?;
        println!("Paired device \"{}\" ({id})", request.device_name.trim());
        id
    };
    Ok(Json(PairResponse {
        device_id,
        credential,
    }))
}

/// Accepts standard or URL-safe base64 for the device public key.
fn decode_public_key(value: &str) -> Option<Vec<u8>> {
    STANDARD
        .decode(value.trim())
        .ok()
        .or_else(|| URL_SAFE_NO_PAD.decode(value.trim()).ok())
}
