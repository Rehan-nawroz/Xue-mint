//! Library crate: exposes every module and the router/server bootstrap so the
//! binary and the integration tests share one code path.

pub mod api;
pub mod auth;
pub mod certs;
pub mod config;
pub mod db;
pub mod errors;
pub mod firewall;
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
    let web_dir = state.cfg.web_dir.clone();
    let router = Router::new()
        .route("/pair", post(api::pair::pair))
        .route("/assets/check", post(api::assets::check))
        .route("/assets/upload/{hash}", put(api::assets::upload))
        .route("/assets", get(api::assets::timeline))
        .route("/assets/{id}/thumb", get(api::assets::thumb))
        .route("/assets/{id}/original", get(api::assets::original))
        .route(
            "/assets/{id}",
            delete(api::assets::delete_asset).patch(api::assets::rename_asset),
        )
        .route("/devices", get(api::devices::list))
        .route("/devices/{id}", delete(api::devices::revoke))
        .route("/local/session", post(api::local::session))
        .route(
            "/local/settings",
            get(api::local::get_settings).put(api::local::put_settings),
        )
        .route(
            "/local/pairing",
            get(api::local::pairing_info).post(api::local::pairing_code),
        )
        .route("/local/factory-reset", post(api::local::factory_reset))
        .route("/local/import", post(api::local::import_asset))
        .route("/reset", post(api::local::device_reset))
        .route(
            "/local/connection",
            get(api::local::get_connection).put(api::local::set_connection),
        )
        .route("/local/status", get(api::local::status))
        .with_state(state);

    // The built gallery is served at the site root when its files exist.
    match web_dir.filter(|dir| dir.join("index.html").is_file()) {
        Some(dir) => {
            let index = dir.join("index.html");
            router.fallback_service(
                tower_http::services::ServeDir::new(dir)
                    .fallback(tower_http::services::ServeFile::new(index)),
            )
        }
        None => router,
    }
}

/// Full server bootstrap: directories, defaults, watcher, TLS, serve forever.
pub async fn run_server(cfg: Config, pool: SqlitePool) -> anyhow::Result<()> {
    cfg.ensure_dirs()?;
    db::apply_defaults(&pool).await?;

    let state = AppState::new(cfg.clone(), pool);
    ingest::scan_existing(&state).await?;
    // Keep the handle in the shared state so settings can re-target it later.
    state.set_watcher(watch::start(state.clone())?);

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
    let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem(
        cert_pem.into_bytes(),
        key_pem.into_bytes(),
    )
    .await?;
    axum_server::from_tcp_rustls(listener, tls_config)
        .serve(build_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>())
        .await?;
    Ok(())
}
