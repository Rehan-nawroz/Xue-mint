//! Database access: connection pool, migrations, settings helpers.

use crate::config::Config;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

/// Opens the SQLite pool and applies all migrations.
pub async fn open(cfg: &Config) -> anyhow::Result<SqlitePool> {
    std::fs::create_dir_all(&cfg.data_dir)?;
    let options = SqliteConnectOptions::new()
        .filename(cfg.db_file())
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

/// Inserts default settings rows (existing values are never overwritten).
pub async fn apply_defaults(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('delete_behavior', 'index_only')",
    )
    .execute(pool)
    .await?;
    sqlx::query("INSERT OR IGNORE INTO settings (key, value) VALUES ('mirror_folder', '')")
        .execute(pool)
        .await?;
    Ok(())
}

/// Reads one settings value by key, if present.
pub async fn get_setting(pool: &SqlitePool, key: &str) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<String, _>("value")))
}
