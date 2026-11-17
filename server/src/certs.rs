//! TLS certificate: a self-signed certificate is generated once and persisted.
//! Clients (the phone) pin the certificate fingerprint they received in the QR
//! code, so a self-signed certificate is as trustworthy as a CA-signed one here.

use crate::config::Config;

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
    println!("Generated new self-signed TLS certificate in {}", cfg.data_dir.display());
    Ok((cert_pem, key_pem))
}
