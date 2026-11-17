//! Server configuration: where photos live, where the database and thumbnails live, which port to serve.

use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    /// HTTPS port served on all interfaces (reachable from the LAN).
    pub port: u16,
    /// Folder that holds photos as plain files (the user owns these files).
    pub photos_dir: PathBuf,
    /// Folder for server-owned data: SQLite database, thumbnails, TLS certificate.
    pub data_dir: PathBuf,
}

impl Config {
    pub fn thumbs_dir(&self) -> PathBuf {
        self.data_dir.join("thumbs")
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }

    pub fn db_file(&self) -> PathBuf {
        self.data_dir.join("library.db")
    }

    pub fn cert_file(&self) -> PathBuf {
        self.data_dir.join("cert.pem")
    }

    pub fn key_file(&self) -> PathBuf {
        self.data_dir.join("key.pem")
    }

    /// Creates all directories this configuration needs, if missing.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for dir in [
            self.photos_dir.clone(),
            self.data_dir.clone(),
            self.thumbs_dir(),
            self.tmp_dir(),
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}
