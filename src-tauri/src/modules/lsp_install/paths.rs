//! Directory layout for managed LSP installations.
//!
//! Everything lives under the Tauri app-data directory so uninstalling
//! Altai cleans up its LSP cache without touching system-installed binaries.
//!
//! ```text
//! <app_data>/lsp/<id>/bin/<binary>      — the installed binary
//! <app_data>/lsp/<id>/state.json        — install metadata (version, source)
//! <app_data>/lsp/<id>/tmp/...           — scratch space for in-flight downloads
//! ```

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Root directory for all LSP installations managed by this app. Created
/// lazily on first install — we don't pre-create it during app startup
/// because most sessions never install an LSP.
pub fn lsp_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(base.join("lsp"))
}

/// Per-server install root. All files for one LSP live under this folder.
pub fn server_root(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(lsp_root(app)?.join(sanitize_id(id)))
}

/// Where the final executable lives. The frontend resolves a server's
/// "managed path" by checking whether this exists.
pub fn server_bin_path(app: &AppHandle, id: &str, binary_name: &str) -> Result<PathBuf, String> {
    let mut p = server_root(app, id)?.join("bin").join(binary_name);
    if cfg!(target_os = "windows") {
        // The same registry runs on every platform; we only append `.exe`
        // at resolution time so manifests stay platform-agnostic.
        p.set_extension("exe");
    }
    Ok(p)
}

/// Scratch directory for an in-flight install. The installer creates this,
/// streams the download into a `NamedTempFile` underneath, then deletes the
/// directory once the binary has been moved into `bin/`.
pub fn server_tmp_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(server_root(app, id)?.join("tmp"))
}

/// Path to the metadata sidecar file. Survives across installs of the same
/// server so the UI can show "installed version 2026-05-18" without
/// shelling out to `--version`.
pub fn state_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(server_root(app, id)?.join("state.json"))
}

/// Minimal install metadata persisted to disk. We only record what the
/// UI needs to render a server card — version, source kind, install date.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallState {
    pub id: String,
    pub version: String,
    /// Discriminator string from `InstallSource` (`"githubRelease"`, …).
    pub source_kind: String,
    /// Absolute path to the installed binary. Stored so we can validate
    /// on next launch that nothing moved underneath us.
    pub binary_path: String,
    /// Unix timestamp, seconds. `u64` because we don't need pre-1970 dates.
    pub installed_at: u64,
}

pub fn read_state(app: &AppHandle, id: &str) -> Option<InstallState> {
    let path = state_file(app, id).ok()?;
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_state(app: &AppHandle, state: &InstallState) -> Result<(), String> {
    let path = state_file(app, &state.id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir state parent: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(state).map_err(|e| format!("state serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("state write: {e}"))
}

/// Belt-and-suspenders: a malicious manifest id (`../etc/passwd`) must never
/// escape the lsp root. We allowlist `[a-zA-Z0-9_.-]` and reject anything
/// containing `..` or a path separator.
fn sanitize_id(id: &str) -> &str {
    if id.is_empty()
        || id.contains("..")
        || id.contains('/')
        || id.contains('\\')
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return "_invalid";
    }
    id
}

/// Set the executable bit on Unix. No-op on Windows. We don't propagate
/// errors aggressively — if chmod fails, the spawn will fail with a clearer
/// "permission denied" anyway.
#[cfg(unix)]
pub fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(perms.mode() | 0o755);
    std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
pub fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sanitize_id;

    #[test]
    fn sanitize_rejects_traversal_and_separators() {
        assert_eq!(sanitize_id("../etc"), "_invalid");
        assert_eq!(sanitize_id("a/b"), "_invalid");
        assert_eq!(sanitize_id("a\\b"), "_invalid");
        assert_eq!(sanitize_id(""), "_invalid");
        assert_eq!(sanitize_id("rust-analyzer.v1"), "rust-analyzer.v1");
        assert_eq!(sanitize_id("typescript"), "typescript");
    }
}
