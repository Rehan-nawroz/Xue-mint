//! mDNS/Bonjour advertising so phones can find this PC on the local network.

use crate::host::PairingInfo;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::net::IpAddr;

pub const SERVICE_TYPE: &str = "_xue-mint._tcp.local.";

pub struct MdnsAdvertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl MdnsAdvertiser {
    pub fn start(info: &PairingInfo) -> Result<Self, String> {
        let addresses: Vec<IpAddr> = info
            .addresses
            .iter()
            .filter_map(|address| address.parse::<IpAddr>().ok())
            .filter(|address| !address.is_loopback())
            .collect();
        if addresses.is_empty() {
            return Err("no LAN address to advertise".to_string());
        }

        let host_name = format!("{}.local.", host_label(&info.server_name));
        let properties = [
            ("version", "1".to_string()),
            ("fingerprint", info.fingerprint.clone()),
            ("path", "/".to_string()),
        ];

        let daemon = ServiceDaemon::new().map_err(|error| error.to_string())?;
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &info.server_name,
            &host_name,
            addresses.as_slice(),
            info.port,
            &properties[..],
        )
        .map_err(|error| error.to_string())?;
        let fullname = service.get_fullname().to_string();
        daemon
            .register(service)
            .map_err(|error| error.to_string())?;

        Ok(Self { daemon, fullname })
    }

    pub fn fullname(&self) -> &str {
        &self.fullname
    }

    pub fn shutdown(self) {
        let _ = self.daemon.shutdown();
    }
}

/// Hostnames may contain only letters, digits and hyphens. The instance name
/// keeps the readable computer name; the host gets the sanitized form.
fn host_label(name: &str) -> String {
    let mut label: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while label.contains("--") {
        label = label.replace("--", "-");
    }
    let label = label.trim_matches('-');
    if label.is_empty() {
        "xue-mint-pc".to_string()
    } else {
        label.to_string()
    }
}
