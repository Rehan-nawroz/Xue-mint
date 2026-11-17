//! Windows Firewall rule for the private network, added on demand with UAC.

use serde::Serialize;

const RULE_NAME: &str = "Xue-Mint";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallResult {
    pub ok: bool,
    pub message: String,
}

/// Reads the rule list. `netsh` exits non-zero when no rule matches.
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

/// Adds an inbound allow rule scoped to private and domain networks. Windows
/// shows a UAC prompt; a declined prompt is reported, not treated as a crash.
pub fn add_rule() -> FirewallResult {
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

    let mut command = std::process::Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    hide_console(&mut command);

    let added = matches!(command.status(), Ok(status) if status.success());
    if added && rule_exists() {
        FirewallResult {
            ok: true,
            message: "Windows now allows Xue-Mint on private networks.".to_string(),
        }
    } else {
        FirewallResult {
            ok: false,
            message:
                "Windows did not add the rule. Approve the permission prompt, or add an inbound \
                 rule for Xue-Mint in Windows Security."
                    .to_string(),
        }
    }
}

#[cfg(windows)]
fn hide_console(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut std::process::Command) {}
