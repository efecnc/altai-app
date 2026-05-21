//! LSP server installer — backend surface.
//!
//! Frontend (Phase 2-3) drives this through four Tauri commands:
//!
//!   - `lsp_registry_list` — read-only view of the built-in manifests
//!   - `lsp_install_status` — "is this LSP installed (managed or system)?"
//!   - `lsp_install_run` — kick off an install; progress streams over Channel
//!   - `lsp_install_cancel` — abort an in-flight install
//!   - `lsp_install_uninstall` — wipe an Altai-managed install
//!
//! State (`LspInstallState`) only tracks in-flight installs so the cancel
//! command has something to flip. Everything persistent lives on disk
//! under `<app_data>/lsp/<id>/` — see [`paths`].

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

pub mod download;
pub mod installer;
pub mod node_runtime;
pub mod paths;
pub mod progress;
pub mod registry;

use download::CancelToken;
use installer::{read_install_state, resolve_managed_binary, run_install};
use progress::{InstallPhase, ProgressReporter};
use registry::{default_registry, manifest, LspManifest};

/// Tracks in-flight installs so `lsp_install_cancel` can find them. Cleared
/// when the install task finishes (success, failure, or cancel).
#[derive(Default, Clone)]
pub struct LspInstallState {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    in_flight: Mutex<HashMap<String, CancelToken>>,
}

/// Payload for `lsp_install_status`. Two paths are reported because the
/// UI distinguishes "Altai installed it" from "we found the user's own
/// install on PATH".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInstallStatus {
    pub id: String,
    /// True if either `managed_path` or `system_path` resolves.
    pub installed: bool,
    /// Path to the Altai-managed binary under `<app_data>/lsp/...`, if any.
    pub managed_path: Option<String>,
    /// Path resolved against `PATH`, if any. Discovered without spawning.
    pub system_path: Option<String>,
    /// Version recorded in `state.json`. Only populated for managed installs.
    pub version: Option<String>,
}

// ---------- commands ---------------------------------------------------------

/// Return the full built-in registry. Frontend caches this on launch and
/// drives the Settings UI from it.
#[tauri::command]
pub fn lsp_registry_list() -> Vec<LspManifest> {
    default_registry()
}

/// Look up a single manifest. Convenient when the frontend only knows the id
/// (e.g. from `specForPath`) and doesn't want to scan the whole registry.
#[tauri::command]
pub fn lsp_registry_get(id: String) -> Option<LspManifest> {
    manifest(&id)
}

/// "Is this LSP installed?" — checks managed path first, then `PATH`.
#[tauri::command]
pub fn lsp_install_status(app: tauri::AppHandle, id: String) -> Result<LspInstallStatus, String> {
    let m = manifest(&id).ok_or_else(|| format!("unknown lsp id: {id}"))?;

    let managed = resolve_managed_binary(&app, &m).map(|p| p.to_string_lossy().to_string());
    let system = system_path_for(&m);
    let version = read_install_state(&app, &id).map(|s| s.version);

    Ok(LspInstallStatus {
        id: m.id,
        installed: managed.is_some() || system.is_some(),
        managed_path: managed,
        system_path: system,
        version,
    })
}

/// Run the install for `id`. Progress streams over `on_progress`. Returns
/// once the install completes (success or failure).
///
/// Re-entrancy: if an install for the same id is already running, returns
/// an error immediately rather than racing two writers into the same dir.
#[tauri::command]
pub async fn lsp_install_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, LspInstallState>,
    id: String,
    on_progress: Channel<InstallPhase>,
) -> Result<String, String> {
    let m = manifest(&id).ok_or_else(|| format!("unknown lsp id: {id}"))?;

    let cancel = {
        let mut guard = state.inner.in_flight.lock().await;
        if guard.contains_key(&id) {
            return Err(format!("install for {id} is already in flight"));
        }
        let token = CancelToken::default();
        guard.insert(id.clone(), token.clone());
        token
    };

    let reporter = ProgressReporter::new(on_progress);
    let result = run_install(&app, &m, reporter.clone(), cancel.clone()).await;

    // Always release the in-flight slot, even on failure / cancel.
    state.inner.in_flight.lock().await.remove(&id);

    match result {
        Ok(r) => Ok(r.binary_path.to_string_lossy().to_string()),
        Err(e) => {
            // Distinguish cancellation from a real failure — the frontend
            // can render them differently. `run_install` already emitted a
            // Failed/Cancelled phase frame; the return value carries the
            // text for synchronous error handling.
            if cancel.is_cancelled().await {
                Err("cancelled".into())
            } else {
                Err(e)
            }
        }
    }
}

/// Flip the cancel flag for an in-flight install. No-op if nothing's running.
#[tauri::command]
pub async fn lsp_install_cancel(
    state: tauri::State<'_, LspInstallState>,
    id: String,
) -> Result<(), String> {
    let token = state.inner.in_flight.lock().await.get(&id).cloned();
    if let Some(t) = token {
        t.cancel().await;
        log::info!("lsp_install_cancel({id}): cancel flag set");
    }
    Ok(())
}

/// Remove the managed install for `id`. Idempotent — succeeds silently if
/// nothing's installed. Doesn't touch the user's system install.
#[tauri::command]
pub fn lsp_install_uninstall(app: tauri::AppHandle, id: String) -> Result<(), String> {
    installer::uninstall(&app, &id)
}

// ---------- helpers ----------------------------------------------------------

/// Mirror of `proc::proc_which` but returns the path that would resolve for
/// this manifest's primary binary. We don't go through `proc_which` to keep
/// the dependency one-way (lsp_install -> proc would be a layering inversion).
fn system_path_for(m: &LspManifest) -> Option<String> {
    let name = match &m.install {
        registry::InstallSource::GithubRelease { binary_name, .. } => binary_name.as_str(),
        registry::InstallSource::GoInstall { binary_name, .. } => binary_name.as_str(),
        registry::InstallSource::NpmBundledNode { entry_relative, .. } => {
            entry_relative.last().map(|s| s.as_str()).unwrap_or(&m.id)
        }
    };
    which_on_path(name)
}

pub(crate) fn which_on_path(name: &str) -> Option<String> {
    use std::path::Path;

    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        let p = Path::new(trimmed);
        if is_executable(p) {
            return Some(p.to_string_lossy().to_string());
        }
        return None;
    }

    let path_env = std::env::var_os("PATH")?;
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut candidates: Vec<String> = vec![trimmed.to_string()];
    #[cfg(windows)]
    {
        if let Some(exts) = std::env::var_os("PATHEXT") {
            for ext in std::env::split_paths(&exts) {
                if let Some(s) = ext.to_str() {
                    candidates.push(format!("{trimmed}{s}"));
                }
            }
        } else {
            candidates.push(format!("{trimmed}.exe"));
        }
    }

    for dir in std::env::split_paths(&path_env) {
        for candidate in &candidates {
            let p = dir.join(candidate);
            if is_executable(&p) {
                return Some(p.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable(p: &std::path::Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}
