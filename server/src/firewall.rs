//! Windows Firewall rule for the private network, added or removed on demand
//! with UAC. Other platforms report that the control is unavailable.

use serde::Serialize;

pub const RULE_NAME: &str = "Xue-Mint";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallResult {
    pub ok: bool,
    pub message: String,
}

pub fn is_supported() -> bool {
    cfg!(windows)
}

/// Reads the rule list. `netsh` exits non-zero when no rule matches.
#[cfg(windows)]
pub fn rule_exists() -> bool {
    let mut command = std::process::Command::new("netsh");
    command.args([
        "advfirewall",
        "firewall",
        "show",
        "rule",
        &format!("name={RULE_NAME}"),
    ]);
    hide_console(&mut command);
    match command.output() {
        Ok(output) => {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .to_lowercase()
                    .contains("xue-mint")
        }
        Err(_) => false,
    }
}

#[cfg(not(windows))]
pub fn rule_exists() -> bool {
    false
}

/// Adds an inbound allow rule scoped to private and domain networks. Windows
/// shows a UAC prompt; a declined prompt is reported, not treated as a crash.
pub fn add_rule() -> FirewallResult {
    if !is_supported() {
        return unsupported();
    }
    if rule_exists() {
        return FirewallResult {
            ok: true,
            message: "Windows already allows Xue-Mint on private networks.".to_string(),
        };
    }

    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            return FirewallResult {
                ok: false,
                message: format!("Could not find the Xue-Mint executable: {error}"),
            };
        }
    };

    // PowerShell single-quoted string: double embedded single quotes.
    let escaped = exe.to_string_lossy().replace('\'', "''");
    let script = format!(
        "try {{ $p = Start-Process -FilePath 'netsh.exe' -ArgumentList @(\
         'advfirewall','firewall','add','rule','name={RULE_NAME}','dir=in','action=allow',\
         'program=\"{escaped}\"','enable=yes','profile=private,domain',\n         'remoteip=localsubnet') \
         -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; \
         exit $p.ExitCode }} catch {{ exit 1 }}"
    );

    if !run_elevated(&script) || !rule_exists() {
        return FirewallResult {
            ok: false,
            message:
                "Windows did not add the rule. Approve the permission prompt, or add an inbound \
                 rule for Xue-Mint in Windows Security."
                    .to_string(),
        };
    }

    FirewallResult {
        ok: true,
        message: "Windows now allows Xue-Mint on private networks.".to_string(),
    }
}

/// Removes the inbound rule, restoring Windows' default block behavior.
pub fn remove_rule() -> FirewallResult {
    if !is_supported() {
        return unsupported();
    }
    if !rule_exists() {
        return FirewallResult {
            ok: true,
            message: "Phone connections are already blocked.".to_string(),
        };
    }

    let script = format!(
        "try {{ $p = Start-Process -FilePath 'netsh.exe' -ArgumentList @(\
         'advfirewall','firewall','delete','rule','name={RULE_NAME}') \
         -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; \
         exit $p.ExitCode }} catch {{ exit 1 }}"
    );

    if !run_elevated(&script) || rule_exists() {
        return FirewallResult {
            ok: false,
            message:
                "Windows did not remove the rule. Approve the permission prompt, or remove the \
                 Xue-Mint inbound rule in Windows Security."
                    .to_string(),
        };
    }

    FirewallResult {
        ok: true,
        message: "Windows now blocks phone connections to Xue-Mint.".to_string(),
    }
}

fn unsupported() -> FirewallResult {
    FirewallResult {
        ok: false,
        message: "Phone connection control is only available on Windows.".to_string(),
    }
}

#[cfg(windows)]
fn run_elevated(script: &str) -> bool {
    let mut command = std::process::Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    hide_console(&mut command);
    matches!(command.status(), Ok(status) if status.success())
}

#[cfg(not(windows))]
fn run_elevated(_script: &str) -> bool {
    false
}

#[cfg(windows)]
fn hide_console(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut std::process::Command) {}
