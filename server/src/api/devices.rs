//! GET /devices (list) and DELETE /devices/{id} (revoke).

use crate::auth::Device;
use crate::errors::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use sqlx::Row;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDto {
    pub id: String,
    pub name: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
    pub revoked: bool,
}

#[derive(Debug, Serialize)]
pub struct DevicesResponse {
    pub devices: Vec<DeviceDto>,
}

pub async fn list(
    State(state): State<AppState>,
    _device: Device,
) -> Result<Json<DevicesResponse>, ApiError> {
    let rows = sqlx::query("SELECT id, name, paired_at, last_seen_at, revoked FROM devices ORDER BY paired_at")
        .fetch_all(&state.pool)
        .await?;

    let devices = rows
        .iter()
        .map(|row| DeviceDto {
            id: row.get("id"),
            name: row.get("name"),
            paired_at: row.get("paired_at"),
            last_seen_at: row.get("last_seen_at"),
            revoked: row.get::<i64, _>("revoked") != 0,
        })
        .collect();

    Ok(Json(DevicesResponse { devices }))
}

/// Revocation takes effect immediately: the device's credential stops matching.
pub async fn revoke(
    State(state): State<AppState>,
    _device: Device,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let result = sqlx::query("UPDATE devices SET revoked = 1 WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("DEVICE_NOT_FOUND", "No such device."));
    }
    println!("Revoked device {id}");
    Ok(StatusCode::NO_CONTENT)
}
