//! Library crate: exposes every module and the router/server bootstrap so the
//! binary and the integration tests share one code path.

pub mod api;
pub mod auth;
pub mod certs;
pub mod config;
pub mod db;
pub mod errors;
pub mod ingest;
pub mod media;
pub mod state;
pub mod tokens;
pub mod watch;

use crate::config::Config;
use crate::state::AppState;
use axum::routing::{delete, get, post, put};
use axum::Router;
use sqlx::SqlitePool;

/// Builds the application router. Used by both the real server and the tests.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/pair", post(api::pair::pair))
        .route("/assets/check", post(api::assets::check))
        .route("/assets/upload/{hash}", put(api::assets::upload))
        .route("/assets", get(api::assets::timeline))
        .route("/assets/{id}/thumb", get(api::assets::thumb))
        .route("/assets/{id}/original", get(api::assets::original))
        .route("/assets/{id}", delete(api::assets::delete_asset))
        .route("/devices", get(api::devices::list))
        .route("/devices/{id}", delete(api::devices::revoke))
        .with_state(state)
}

/// Full server bootstrap: directories, defaults, watcher, TLS, serve forever.
pub async fn run_server(cfg: Config, pool: SqlitePool) -> anyhow::Result<()> {
    cfg.ensure_dirs()?;
    db::apply_defaults(&pool).await?;
    ingest::scan_existing(&AppState::new(cfg.clone(), pool.clone())).await?;

    let state = AppState::new(cfg.clone(), pool);
    let _watcher = watch::start(state.clone())?;

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = std::net::TcpListener::bind(addr)?;
    serve_on(state, listener).await
}

/// Serves the router over TLS on an already-bound listener (used by tests to
/// grab an ephemeral port).
pub async fn serve_on(state: AppState, listener: std::net::TcpListener) -> anyhow::Result<()> {
    // Install the ring crypto provider once; the process default is used by rustls.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (cert_pem, key_pem) = certs::ensure_cert(&state.cfg)?;
    let tls_config =
        axum_server::tls_rustls::RustlsConfig::from_pem(cert_pem.into_bytes(), key_pem.into_bytes()).await?;
    axum_server::from_tcp_rustls(listener, tls_config)
        .serve(build_router(state).into_make_service())
        .await?;
    Ok(())
}
