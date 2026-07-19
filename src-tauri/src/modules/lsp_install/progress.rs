//! Progress events streamed from the installer back to the UI.
//!
//! We use `tauri::ipc::Channel<T>` (per-invocation) instead of a global
//! event so two installs running in parallel don't see each other's
//! progress frames. See `proc::reader_task` for the same pattern.

use serde::Serialize;
use tauri::ipc::Channel;

/// Phase-tagged progress payload. The frontend pattern-matches on `kind`
/// to render bars, spinners, or terminal states.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallPhase {
    /// Connection established, total size known if the server returned
    /// Content-Length.
    Started { total_bytes: Option<u64> },
    /// Streaming bytes from the network. `total_bytes` is `None` for
    /// chunked responses with no Content-Length.
    Downloaded {
        bytes: u64,
        total_bytes: Option<u64>,
    },
    /// Decompressing / unpacking on disk. No byte counter — extract is
    /// usually fast and progress jitter would just confuse the bar.
    Extracting,
    /// Verifying sha256 / running post-install checks.
    Verifying,
    /// Install succeeded; binary is at `path`.
    Done { path: String, version: String },
    /// Install failed; `message` is shown verbatim in the UI.
    Failed { message: String },
    /// User cancelled before completion.
    Cancelled,
}

/// Thin wrapper so we can stub progress in tests later. Clones cheaply.
#[derive(Clone)]
pub struct ProgressReporter {
    channel: Option<Channel<InstallPhase>>,
}

impl ProgressReporter {
    pub fn new(channel: Channel<InstallPhase>) -> Self {
        Self {
            channel: Some(channel),
        }
    }

    pub fn report(&self, phase: InstallPhase) {
        if let Some(ch) = &self.channel {
            // The frontend can drop the channel mid-install (window closed,
            // HMR). That's not an installer error — ignore the send result.
            let _ = ch.send(phase);
        }
    }
}
