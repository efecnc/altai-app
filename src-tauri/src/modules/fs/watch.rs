//! Real-time filesystem watching for the file explorer.
//!
//! The explorer used to require a manual "Refresh" press to pick up files or
//! folders created outside the app (including hidden dot-folders). This module
//! watches the open workspace root recursively and emits a debounced
//! `fs://changed` event whenever the tree's *structure* changes
//! (create / delete / rename) so the frontend can re-list the affected
//! directories live.
//!
//! Content-only edits (saving a file's bytes) are intentionally ignored — they
//! don't change the tree, and refetching on every keystroke-save would just
//! cause flicker.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use notify::event::{EventKind, ModifyKind};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// Quiet period used to coalesce bursts of filesystem events into a single
/// frontend notification. Tools that touch many files at once (git checkout,
/// npm install) otherwise produce a storm of individual events.
const DEBOUNCE: Duration = Duration::from_millis(250);

/// Payload for the `fs://changed` event. `root` echoes the exact path the
/// frontend asked to watch, so a listener can ignore events for a stale root
/// during a workspace switch.
#[derive(Clone, Serialize)]
struct FsChangedEvent {
    root: String,
}

/// Managed Tauri state holding the single active explorer watcher. Dropping the
/// stored [`RecommendedWatcher`] stops the OS watch and, by closing the event
/// channel, tells the debounce thread to exit — so replacing or clearing this
/// is all the teardown that's needed.
#[derive(Default)]
pub struct WatcherState {
    inner: Mutex<Option<RecommendedWatcher>>,
}

/// True for events that change the *shape* of the tree (a new/removed/renamed
/// entry), as opposed to in-place content edits. Free function so it can be
/// unit-tested without spinning up a real watcher.
fn is_structural(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    )
}

/// Drains coalesced change ticks and emits one `fs://changed` per quiet burst.
/// Exits when `rx`'s sender is dropped (i.e. the watcher was replaced/stopped).
fn run_debounce_loop(app: AppHandle, root: String, rx: Receiver<()>) {
    loop {
        // Block until the first change of a burst. Err => watcher dropped.
        if rx.recv().is_err() {
            return;
        }
        // Coalesce: keep draining until the filesystem goes quiet for DEBOUNCE.
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                // Watcher dropped mid-burst (workspace switch / shutdown): the
                // root is being abandoned, so discard the in-flight batch
                // instead of emitting for a root the listener is tearing down.
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let _ = app.emit(
            "fs://changed",
            FsChangedEvent {
                root: root.clone(),
            },
        );
    }
}

/// Start (or restart) the recursive watcher on `path`. Replacing any existing
/// watcher. `path` is the frontend's forward-slash root; it is echoed verbatim
/// in every emitted event so the listener can match it.
#[tauri::command]
pub fn fs_watch_start(
    app: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = resolve_path(&path, &workspace);

    let (tx, rx): (Sender<()>, Receiver<()>) = channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            if is_structural(&event.kind) {
                // Ignore send errors: a closed receiver just means the debounce
                // thread has already exited (watcher being torn down).
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("failed to create fs watcher: {e}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {}: {e}", root.display()))?;

    thread::spawn(move || run_debounce_loop(app, path, rx));

    // Store last so the old watcher (if any) is dropped only after the new one
    // is successfully watching — avoids a gap with no coverage.
    let mut guard = state.inner.lock().map_err(|_| "watcher state poisoned")?;
    *guard = Some(watcher);
    Ok(())
}

/// Stop the active watcher, if any. Idempotent.
#[tauri::command]
pub fn fs_watch_stop(state: State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|_| "watcher state poisoned")?;
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};

    #[test]
    fn create_and_remove_are_structural() {
        assert!(is_structural(&EventKind::Create(CreateKind::Folder)));
        assert!(is_structural(&EventKind::Create(CreateKind::File)));
        assert!(is_structural(&EventKind::Create(CreateKind::Any)));
        assert!(is_structural(&EventKind::Remove(RemoveKind::Any)));
    }

    #[test]
    fn rename_is_structural() {
        assert!(is_structural(&EventKind::Modify(ModifyKind::Name(
            RenameMode::Any
        ))));
    }

    #[test]
    fn content_edits_are_not_structural() {
        // Saving a file's bytes must not refresh the tree.
        assert!(!is_structural(&EventKind::Modify(ModifyKind::Data(
            DataChange::Content
        ))));
        assert!(!is_structural(&EventKind::Access(
            notify::event::AccessKind::Read
        )));
    }

    /// End-to-end platform check: a real watcher on a temp dir must observe a
    /// structural event when a file/dir is created. Guards against a backend
    /// (e.g. macOS FSEvents) reporting creates in a shape our filter misses.
    ///
    /// Ignored by default — it depends on live OS event delivery (FSEvents /
    /// inotify) whose latency makes it flaky under CI load, and the native
    /// backend may be absent in sandboxed runners. Run locally with
    /// `cargo test fs::watch -- --ignored` after touching the watcher.
    #[test]
    #[ignore = "live-fs smoke test; run locally with --ignored"]
    fn watcher_observes_created_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (tx, rx) = channel::<()>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                if is_structural(&event.kind) {
                    let _ = tx.send(());
                }
            }
        })
        .expect("watcher");
        watcher
            .watch(dir.path(), RecursiveMode::Recursive)
            .expect("watch");

        std::fs::create_dir(dir.path().join(".hidden-folder")).expect("mkdir");
        std::fs::write(dir.path().join("note.txt"), b"hi").expect("write");

        // FSEvents/inotify deliver asynchronously; allow a generous window.
        rx.recv_timeout(Duration::from_secs(5))
            .expect("expected a structural fs event for created entries");
    }
}
