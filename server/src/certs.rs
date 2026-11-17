//! TLS certificate: a self-signed certificate is generated once and persisted.
//! Clients (the phone) pin the certificate fingerprint they received in the QR
//! code, so a self-signed certificate is as trustworthy as a CA-signed one here.

use crate::config::Config;
use base64::Engine;
use sha2::{Digest, Sha256};

/// Returns the PEM certificate and key, generating and persisting them on first run.
pub fn ensure_cert(cfg: &Config) -> anyhow::Result<(String, String)> {
    let cert_path = cfg.cert_file();
    let key_path = cfg.key_file();

    if cert_path.exists() && key_path.exists() {
        let cert = std::fs::read_to_string(&cert_path)?;
        let key = std::fs::read_to_string(&key_path)?;
        if !cert.is_empty() && !key.is_empty() {
            return Ok((cert, key));
        }
    }

    let certified_key = rcgen::generate_simple_self_signed(vec![
        "localhost".to_string(),
        "xue-mint-pc".to_string(),
    ])?;
    let cert_pem = certified_key.cert.pem();
    let key_pem = certified_key.key_pair.serialize_pem();

    std::fs::write(&cert_path, &cert_pem)?;
    std::fs::write(&key_path, &key_pem)?;
    println!(
        "Generated new self-signed TLS certificate in {}",
        cfg.data_dir.display()
    );
    Ok((cert_pem, key_pem))
}

/// SHA-256 fingerprint of the persisted certificate, formatted as colon-separated
/// uppercase hex. Phones pin this value from the QR code.
pub fn fingerprint(cert_pem: &str) -> anyhow::Result<String> {
    let body: String = cert_pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD.decode(body.trim())?;
    let digest = Sha256::digest(&der);
    Ok(digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":"))
}
