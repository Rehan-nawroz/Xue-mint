//! Shared application state handed to every request handler.

use crate::config::Config;
use crate::watch::WatcherHandle;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

#[derive(Clone)]
pub struct AppState {
    pub cfg: Config,
    pub pool: SqlitePool,
    /// The folder watched right now. It can be changed from settings without a
    /// restart, so it lives behind a lock rather than in the startup config.
    photos_dir: Arc<RwLock<PathBuf>>,
    watcher: Arc<Mutex<Option<WatcherHandle>>>,
}

impl AppState {
    pub fn new(cfg: Config, pool: SqlitePool) -> Self {
        let photos_dir = cfg.photos_dir.clone();
        Self {
            cfg,
            pool,
            photos_dir: Arc::new(RwLock::new(photos_dir)),
            watcher: Arc::new(Mutex::new(None)),
        }
    }

    /// Folder currently used for new uploads, file lookups and watching.
    pub fn photos_dir(&self) -> PathBuf {
        self.photos_dir
            .read()
            .map(|dir| dir.clone())
            .unwrap_or_else(|_| self.cfg.photos_dir.clone())
    }

    pub fn set_photos_dir(&self, dir: PathBuf) {
        if let Ok(mut current) = self.photos_dir.write() {
            *current = dir;
        }
    }

    pub fn set_watcher(&self, handle: WatcherHandle) {
        if let Ok(mut watcher) = self.watcher.lock() {
            *watcher = Some(handle);
        }
    }

    /// Points the running watcher at a new folder. Does nothing when the state
    /// was built without a watcher (tests that only exercise the router).
    pub fn retarget_watcher(&self, dir: &Path) -> anyhow::Result<()> {
        let watcher = self
            .watcher
            .lock()
            .map_err(|_| anyhow::anyhow!("watcher lock poisoned"))?;
        if let Some(handle) = watcher.as_ref() {
            handle.retarget(dir)?;
        }
        Ok(())
    }
}
