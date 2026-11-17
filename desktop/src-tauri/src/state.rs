//! Desktop state shared by commands, the tray and the background server.

use crate::mdns::MdnsAdvertiser;
use crate::power::PowerManager;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
pub struct DesktopState {
    port: Arc<AtomicU16>,
    ready: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    photos_dir: Arc<Mutex<PathBuf>>,
    data_dir: PathBuf,
    pub http: reqwest::Client,
    pub power: Arc<PowerManager>,
    pub mdns: Arc<Mutex<Option<MdnsAdvertiser>>>,
    integrated: Arc<AtomicBool>,
    pub minimized: bool,
}

impl DesktopState {
    pub fn new(port: u16, photos_dir: PathBuf, data_dir: PathBuf, minimized: bool) -> Self {
        let http = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(4))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            port: Arc::new(AtomicU16::new(port)),
            ready: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(None)),
            photos_dir: Arc::new(Mutex::new(photos_dir)),
            data_dir,
            http,
            power: Arc::new(PowerManager::start()),
            mdns: Arc::new(Mutex::new(None)),
            integrated: Arc::new(AtomicBool::new(false)),
            minimized,
        }
    }

    pub fn fallback(
        error: String,
        photos_dir: PathBuf,
        data_dir: PathBuf,
        minimized: bool,
    ) -> Self {
        let state = Self::new(0, photos_dir, data_dir, minimized);
        state.set_error(Some(error));
        state
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }

    pub fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|error| error.clone())
    }

    pub fn set_error(&self, error: Option<String>) {
        if let Ok(mut current) = self.error.lock() {
            *current = error;
        }
    }

    pub fn photos_dir(&self) -> PathBuf {
        self.photos_dir
            .lock()
            .map(|dir| dir.clone())
            .unwrap_or_default()
    }

    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }

    /// Returns true the first time the server becomes reachable, so the tray
    /// integrations start exactly once per process.
    pub fn mark_integrated(&self) -> bool {
        !self.integrated.swap(true, Ordering::SeqCst)
    }
}
