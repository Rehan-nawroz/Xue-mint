//! Device authentication: the `Authorization: Device <credential>` header.
//!
//! The plaintext credential exists only on the phone; the server stores a SHA-256
//! hash of it. Requests present the credential, the server hashes and looks it up.
//! Revoked devices are rejected with a distinct error code so the UI can say
//! "re-pair needed" instead of "not paired".

use crate::errors::ApiError;
use crate::media::sha256_hex;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::header;
use axum::http::request::Parts;
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct Device {
    pub id: String,
    pub name: String,
}

impl FromRequestParts<AppState> for Device {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let raw = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(ApiError::auth_required)?;

        let credential = raw
            .strip_prefix("Device ")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(ApiError::auth_required)?;

        let credential_hash = sha256_hex(credential.as_bytes());
        let row = sqlx::query("SELECT id, name, revoked FROM devices WHERE credential_hash = ?")
            .bind(&credential_hash)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(ApiError::auth_required)?;

        if row.get::<i64, _>("revoked") != 0 {
            return Err(ApiError::device_revoked());
        }

        let id: String = row.get("id");
        let name: String = row.get("name");

        // Best-effort heartbeat; a failed update never fails the request.
        let _ = sqlx::query("UPDATE devices SET last_seen_at = ? WHERE id = ?")
            .bind(crate::media::now_iso())
            .bind(&id)
            .execute(&state.pool)
            .await;

        Ok(Device { id, name })
    }
}
