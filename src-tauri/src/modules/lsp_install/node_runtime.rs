//! Altai-managed Node.js runtime, downloaded on first use.
//!
//! The runtime is shared across all npm-based LSP installs (TypeScript,
//! Pyright) so a single ~30 MB download covers the lot. We pin a known-good
//! Node LTS version per app build — bumping it is a code change, never a
//! silent runtime upgrade.
//!
//! Layout:
//! ```text
//! <app_data>/runtimes/node/v20.18.0/
//!     bin/node
//!     lib/node_modules/npm/bin/npm-cli.js
//! ```
//!
//! Windows is intentionally not implemented yet: Node ships as a `.zip`
//! on Windows and `lsp_install` doesn't have a zip extractor. Phase 4
//! sticks to macOS + Linux to match the rust-analyzer support matrix.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::download::{download_to, CancelToken};
use super::installer::extract_tar_gzip;
use super::progress::ProgressReporter;

/// Pinned Node LTS. Bumping this version cascades into a fresh download
/// the next time the user installs a Node-based LSP.
const NODE_VERSION: &str = "20.18.0";

/// Resolved paths the npm installer needs to drive Node + npm.
#[derive(Debug, Clone)]
pub struct NodeRuntime {
    pub node_bin: PathBuf,
    pub npm_cli_js: PathBuf,
}

/// Return a usable runtime, downloading + extracting if it isn't already
/// on disk. Idempotent — concurrent callers race on the file system but
/// both ultimately produce the same paths.
pub async fn ensure_node_runtime(
    app: &AppHandle,
    progress: &ProgressReporter,
    cancel: &CancelToken,
) -> Result<NodeRuntime, String> {
    let root = runtime_root(app)?;
    let resolved = NodeRuntime {
        node_bin: root.join("bin").join(node_bin_name()),
        npm_cli_js: root
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
    };
    if resolved.node_bin.exists() && resolved.npm_cli_js.exists() {
        return Ok(resolved);
    }

    let platform = NodePlatform::current().ok_or_else(|| {
        format!(
            "no bundled Node available for this platform ({}/{}). Install Node 18+ manually and try again.",
            std::env::consts::OS,
            std::env::consts::ARCH,
        )
    })?;
    let url = format!(
        "https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-{platform}.tar.gz",
        platform = platform.tag()
    );

    let tmp_dir = runtimes_dir(app)?.join("tmp");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|e| format!("mkdir node tmp: {e}"))?;
    let archive_path = tmp_dir.join(format!("node-v{NODE_VERSION}-{}.tar.gz", platform.tag()));

    log::info!("lsp_install/node_runtime: downloading {url}");
    download_to(&url, &archive_path, None, progress, cancel).await?;

    // Node's tarball nests everything under `node-v<ver>-<platform>/` —
    // extract to a temp dir, then rename that one folder to our canonical
    // `v<ver>/` location. Atomic-ish: we never read the half-extracted dir.
    let extract_dir = tmp_dir.join("extract");
    // Wipe any stale extraction from a previous failed run.
    let _ = tokio::fs::remove_dir_all(&extract_dir).await;
    let top_dir = tokio::task::spawn_blocking({
        let archive = archive_path.clone();
        let dest = extract_dir.clone();
        move || extract_tar_gzip(&archive, &dest)
    })
    .await
    .map_err(|e| format!("extract join: {e}"))??;

    // The destination might exist from a previous half-success; wipe it.
    if root.exists() {
        let _ = tokio::fs::remove_dir_all(&root).await;
    }
    if let Some(parent) = root.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir node parent: {e}"))?;
    }
    tokio::fs::rename(&top_dir, &root)
        .await
        .map_err(|e| format!("move node tree: {e}"))?;
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;

    if !resolved.node_bin.exists() {
        return Err(format!(
            "Node downloaded but binary missing at {}",
            resolved.node_bin.display()
        ));
    }
    if !resolved.npm_cli_js.exists() {
        return Err(format!(
            "Node downloaded but npm-cli.js missing at {}",
            resolved.npm_cli_js.display()
        ));
    }
    Ok(resolved)
}

fn runtimes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(base.join("runtimes").join("node"))
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtimes_dir(app)?.join(format!("v{NODE_VERSION}")))
}

fn node_bin_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// Map our `(os, arch)` to Node's release-tag platform string. Matches
/// what's published at https://nodejs.org/dist/v{version}/.
struct NodePlatform(&'static str);

impl NodePlatform {
    // Each `#[cfg]` block below compiles for exactly one host target, so on
    // that target the corresponding `return` IS the function body and clippy
    // flags `needless_return`. Suppress it once at the function level rather
    // than rewriting every block to a trailing-expression form (which would
    // make the parallel structure harder to scan).
    #[allow(clippy::needless_return)]
    fn current() -> Option<Self> {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            return Some(NodePlatform("darwin-arm64"));
        }
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        {
            return Some(NodePlatform("darwin-x64"));
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            return Some(NodePlatform("linux-x64"));
        }
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        {
            return Some(NodePlatform("linux-arm64"));
        }
        #[cfg(not(any(
            all(target_os = "macos", target_arch = "aarch64"),
            all(target_os = "macos", target_arch = "x86_64"),
            all(target_os = "linux", target_arch = "x86_64"),
            all(target_os = "linux", target_arch = "aarch64"),
        )))]
        {
            // Windows + everything else — see module docstring.
            #[allow(unreachable_code)]
            None
        }
    }

    fn tag(&self) -> &'static str {
        self.0
    }
}

/// Used by tests and (eventually) a "managed Node" Settings panel.
#[allow(dead_code)]
pub fn pinned_version() -> &'static str {
    NODE_VERSION
}

/// True if the managed Node runtime is already installed. Doesn't trigger
/// a download.
#[allow(dead_code)]
pub fn is_installed(app: &AppHandle) -> bool {
    runtime_root(app)
        .map(|p| p.join("bin").join(node_bin_name()).exists())
        .unwrap_or(false)
}

#[allow(dead_code)]
fn _unused_path_marker(_p: &Path) {}
