//! Live folder watcher: files dropped into the photos folder are indexed
//! automatically, using the same ingest path as uploads. The watched folder can
//! be changed at runtime (settings) without restarting the server.

use crate::ingest::ingest_file;
use crate::state::AppState;
use notify::{EventKind, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

enum Command {
    Retarget(PathBuf, mpsc::SyncSender<Result<(), String>>),
}

/// Handle to the watcher thread. Dropping it stops the watcher.
#[derive(Clone)]
pub struct WatcherHandle {
    commands: mpsc::Sender<Command>,
}

impl WatcherHandle {
    /// Switches watching to `dir`, waiting until the OS watcher accepted it.
    pub fn retarget(&self, dir: &Path) -> anyhow::Result<()> {
        let (ack_tx, ack_rx) = mpsc::sync_channel(0);
        self.commands
            .send(Command::Retarget(dir.to_path_buf(), ack_tx))
            .map_err(|_| anyhow::anyhow!("watcher thread is not running"))?;
        match ack_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(anyhow::anyhow!(message)),
            Err(_) => Err(anyhow::anyhow!("watcher did not answer in time")),
        }
    }
}

/// Starts watching the current photos folder. The returned handle must be kept
/// alive: dropping it stops the watching.
pub fn start(state: AppState) -> anyhow::Result<WatcherHandle> {
    let initial = state.photos_dir();
    let (event_tx, event_rx) = mpsc::channel::<notify::Event>();
    let mut watcher =
        notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            if let Ok(event) = result {
                let _ = event_tx.send(event);
            }
        })?;
    watcher.watch(&initial, RecursiveMode::Recursive)?;

    let (command_tx, command_rx) = mpsc::channel::<Command>();
    let runtime = tokio::runtime::Handle::current();
    let thread_state = state.clone();

    std::thread::spawn(move || {
        let mut current = initial;

        loop {
            match command_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Command::Retarget(dir, ack)) => {
                    let result = if dir == current {
                        Ok(())
                    } else {
                        match watcher.unwatch(&current) {
                            Err(error) => Err(error.to_string()),
                            Ok(()) => match watcher.watch(&dir, RecursiveMode::Recursive) {
                                Ok(()) => {
                                    current = dir;
                                    Ok(())
                                }
                                Err(error) => {
                                    // Keep watching the previous folder rather than nothing.
                                    let _ = watcher.watch(&current, RecursiveMode::Recursive);
                                    Err(error.to_string())
                                }
                            },
                        }
                    };
                    let _ = ack.send(result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            while let Ok(event) = event_rx.try_recv() {
                let relevant = matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_));
                if !relevant {
                    continue;
                }
                for path in event.paths {
                    if !path.is_file() {
                        continue;
                    }
                    // Watchers often fire while a file is still being written.
                    let state = thread_state.clone();
                    runtime.spawn(async move {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        if let Err(error) = ingest_file(&state, &path).await {
                            println!("Watched ingest failed for {}: {error}", path.display());
                        }
                    });
                }
            }
        }
    });

    Ok(WatcherHandle {
        commands: command_tx,
    })
}
