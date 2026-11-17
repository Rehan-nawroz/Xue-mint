//! API error type. Every error maps to a machine-readable code plus a human-readable
//! message that the phone app can show directly, as defined in the API contract.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, code: "BAD_REQUEST", message: message.into() }
    }

    pub fn auth_required() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "AUTH_REQUIRED",
            message: "Pair with the PC first.".into(),
        }
    }

    pub fn device_revoked() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "DEVICE_REVOKED",
            message: "This device was revoked on the PC. Re-pair needed.".into(),
        }
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, code, message: message.into() }
    }

    pub fn pair_token_invalid() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "PAIR_TOKEN_INVALID",
            message: "Unknown pairing code. Generate a new one on the PC.".into(),
        }
    }

    pub fn pair_token_used() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "PAIR_TOKEN_USED",
            message: "This QR code was already used.".into(),
        }
    }

    pub fn pair_token_expired() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "PAIR_TOKEN_EXPIRED",
            message: "The QR code expired. Generate a new one on the PC.".into(),
        }
    }

    pub fn hash_mismatch() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "HASH_MISMATCH",
            message: "Uploaded bytes did not match the expected hash.".into(),
        }
    }

    pub fn offset_mismatch(expected: i64) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "OFFSET_MISMATCH",
            message: format!("Resume offset mismatch. Server offset: {expected}"),
        }
    }

    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "INTERNAL",
            message: format!("Internal error: {error}"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "code": self.code, "message": self.message }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        ApiError::internal(error)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        ApiError::internal(error)
    }
}

impl From<axum::Error> for ApiError {
    fn from(error: axum::Error) -> Self {
        ApiError::internal(error)
    }
}
