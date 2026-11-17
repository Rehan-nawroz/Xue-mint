//! Shared application state handed to every request handler.

use crate::config::Config;
use sqlx::SqlitePool;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Config,
    pub pool: SqlitePool,
}

impl AppState {
    pub fn new(cfg: Config, pool: SqlitePool) -> Self {
        Self { cfg, pool }
    }
}
