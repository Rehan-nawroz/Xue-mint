//! Live folder watcher: files dropped into the photos folder are indexed
//! automatically, using the same ingest path as uploads.

use crate::ingest::ingest_file;
use crate::state::AppState;
use notify::{EventKind, RecursiveMode, Watcher};
use std::time::Duration;

/// Starts watching the photos folder. The returned watcher must be kept alive:
/// dropping it stops the watching.
pub fn start(state: AppState) -> anyhow::Result<notify::RecommendedWatcher> {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Event>();

    let mut watcher = notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        if let Ok(event) = result {
            let _ = tx.send(event);
        }
    })?;
    watcher.watch(&state.cfg.photos_dir, RecursiveMode::Recursive)?;

    let handle = tokio::runtime::Handle::current();
    let thread_state = state.clone();
    std::thread::spawn(move || {
        for event in rx {
            let relevant = matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_)
            );
            if !relevant {
                continue;
            }
            for path in event.paths {
                if !path.is_file() {
                    continue;
                }
                let state = thread_state.clone();
                // Give the writer a moment to finish, then index.
                handle.block_on(async move {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if let Err(error) = ingest_file(&state, &path).await {
                        println!("Watched ingest failed for {}: {error}", path.display());
                    }
                });
            }
        }
    });

    Ok(watcher)
}
