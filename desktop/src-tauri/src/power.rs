//! Keeps Windows awake while a backup is uploading.

use std::sync::mpsc;
use std::time::Duration;

pub struct PowerManager {
    sender: mpsc::Sender<bool>,
}

impl PowerManager {
    pub fn start() -> Self {
        let (sender, receiver) = mpsc::channel::<bool>();

        std::thread::Builder::new()
            .name("xue-mint-power".into())
            .spawn(move || {
                let mut current = false;
                loop {
                    match receiver.recv_timeout(Duration::from_secs(30)) {
                        Ok(next) => {
                            if next != current {
                                set_execution_state(next);
                                current = next;
                                eprintln!(
                                    "power: {}",
                                    if next {
                                        "backup active - keeping Windows awake"
                                    } else {
                                        "backup idle - releasing sleep block"
                                    }
                                );
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            if current {
                                set_execution_state(false);
                            }
                            break;
                        }
                    }
                }
            })
            .ok();

        Self { sender }
    }

    /// Asks Windows to keep the system awake. No-op when already held.
    pub fn acquire(&self) {
        let _ = self.sender.send(true);
    }

    /// Releases the request so the PC can sleep normally again.
    pub fn release(&self) {
        let _ = self.sender.send(false);
    }
}

#[cfg(windows)]
fn set_execution_state(active: bool) {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    let flags = if active {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    // SAFETY: the flags are documented values; the call only affects this thread.
    unsafe {
        SetThreadExecutionState(flags);
    }
}

#[cfg(not(windows))]
fn set_execution_state(_active: bool) {}
