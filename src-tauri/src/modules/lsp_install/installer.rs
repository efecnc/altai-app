//! Installer implementations — one per `InstallSource` variant.
//!
//! The dispatcher matches on the manifest's `install` field and delegates
//! to the right strategy. Each strategy is responsible for:
//!   - resolving its download URL / arguments
//!   - putting the final binary at the canonical path (`server_bin_path`)
//!   - returning a version string for the persisted state
//!
//! Phase 1 only ships the `GithubRelease` strategy in working form. The
//! `NpmBundledNode` and `GoInstall` strategies are intentional stubs that
//! return a not-yet-supported error — keeping them visible in the dispatch
//! makes it obvious which slots Phase 4 needs to fill.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use tauri::AppHandle;

use super::download::{download_to, CancelToken};
use super::paths::{
    make_executable, read_state, server_bin_path, server_root, server_tmp_dir, write_state,
    InstallState,
};
use super::progress::{InstallPhase, ProgressReporter};
use super::registry::{
    current_platform_key, ArchiveKind, InstallSource, LspManifest, PlatformAsset,
};

/// Result of a completed install — the same payload the Tauri command
/// returns to the caller.
pub struct InstallResult {
    pub binary_path: PathBuf,
    pub version: String,
}

/// Dispatch entry point. Used by the Tauri command layer.
///
/// The dispatcher is deliberately not a trait — `InstallSource` is a closed
/// set, so a `match` keeps the strategies inspectable from one place.
pub async fn run_install(
    app: &AppHandle,
    manifest: &LspManifest,
    progress: ProgressReporter,
    cancel: CancelToken,
) -> Result<InstallResult, String> {
    let result = match &manifest.install {
        InstallSource::GithubRelease { .. } => {
            install_github_release(app, manifest, &progress, &cancel).await
        }
        InstallSource::NpmBundledNode { .. } => {
            install_npm_bundled_node(app, manifest, &progress, &cancel).await
        }
        InstallSource::GoInstall { .. } => install_go(app, manifest, &progress).await,
    };

    match &result {
        Ok(r) => {
            // Persist state so a subsequent app launch can answer
            // "is this LSP installed?" without re-running the installer.
            let state = InstallState {
                id: manifest.id.clone(),
                version: r.version.clone(),
                source_kind: source_kind_tag(&manifest.install).to_string(),
                binary_path: r.binary_path.to_string_lossy().to_string(),
                installed_at: now_seconds(),
            };
            if let Err(e) = write_state(app, &state) {
                log::warn!("lsp_install({}): write_state failed: {e}", manifest.id);
            }
            progress.report(InstallPhase::Done {
                path: r.binary_path.to_string_lossy().to_string(),
                version: r.version.clone(),
            });
        }
        Err(e) => {
            // Cancelled is a distinct UI state — render a different badge,
            // skip the "Retry" hint, don't surface as a real error.
            if cancel.is_cancelled().await {
                progress.report(InstallPhase::Cancelled);
            } else {
                progress.report(InstallPhase::Failed { message: e.clone() });
            }
        }
    }
    result
}

/// "Is there a usable managed install on disk?" — the read side that the
/// status command and the spawn path both consult.
pub fn resolve_managed_binary(app: &AppHandle, manifest: &LspManifest) -> Option<PathBuf> {
    let binary_name = installed_binary_name(manifest);
    let bin = server_bin_path(app, &manifest.id, binary_name).ok()?;
    if bin.exists() {
        return Some(bin);
    }
    // Fall back to the state file's stored path — covers npm/Go installs
    // that put the binary in a non-default location once they're filled in.
    let state = read_state(app, &manifest.id)?;
    let p = PathBuf::from(state.binary_path);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// Read persisted install metadata, if any. Used by the status command.
pub fn read_install_state(app: &AppHandle, id: &str) -> Option<InstallState> {
    read_state(app, id)
}

fn installed_binary_name(manifest: &LspManifest) -> &str {
    match &manifest.install {
        InstallSource::GithubRelease { binary_name, .. } => binary_name,
        InstallSource::GoInstall { binary_name, .. } => binary_name,
        InstallSource::NpmBundledNode { entry_relative, .. } => entry_relative
            .last()
            .map(|s| s.as_str())
            .unwrap_or(&manifest.id),
    }
}

fn source_kind_tag(src: &InstallSource) -> &'static str {
    match src {
        InstallSource::GithubRelease { .. } => "githubRelease",
        InstallSource::NpmBundledNode { .. } => "npmBundledNode",
        InstallSource::GoInstall { .. } => "goInstall",
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- GithubRelease ----------------------------------------------------

async fn install_github_release(
    app: &AppHandle,
    manifest: &LspManifest,
    progress: &ProgressReporter,
    cancel: &CancelToken,
) -> Result<InstallResult, String> {
    let (owner, repo, tag, asset_template, platforms, archive, binary_name) =
        match &manifest.install {
            InstallSource::GithubRelease {
                owner,
                repo,
                tag,
                asset_template,
                platforms,
                archive,
                binary_name,
            } => (
                owner,
                repo,
                tag,
                asset_template,
                platforms,
                *archive,
                binary_name,
            ),
            _ => unreachable!("dispatch invariant"),
        };

    let platform = pick_platform(platforms)?;
    let asset = asset_template.replace("{platform}", &platform.asset_platform);
    let url = format!("https://github.com/{owner}/{repo}/releases/download/{tag}/{asset}");

    // Pre-create the install layout and a temp file for the streamed asset.
    let tmp_dir = server_tmp_dir(app, &manifest.id)?;
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|e| format!("mkdir tmp: {e}"))?;
    let download_path = tmp_dir.join(format!("{}-{}", manifest.id, asset));

    let outcome = download_to(
        &url,
        &download_path,
        platform.sha256.as_deref(),
        progress,
        cancel,
    )
    .await?;
    log::info!(
        "lsp_install({}): downloaded {} bytes, sha256={}",
        manifest.id,
        outcome.bytes_written,
        outcome.sha256_hex
    );

    progress.report(InstallPhase::Extracting);
    let target = server_bin_path(app, &manifest.id, binary_name)?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir bin: {e}"))?;
    }
    extract_archive(archive, &download_path, &target)?;

    progress.report(InstallPhase::Verifying);
    make_executable(&target).map_err(|e| format!("chmod +x: {e}"))?;
    if !target.exists() {
        return Err(format!(
            "binary not present after extract: {}",
            target.display()
        ));
    }
    // Cleanup scratch on success. Failure here is non-fatal.
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;

    Ok(InstallResult {
        binary_path: target,
        version: tag.clone(),
    })
}

fn pick_platform(platforms: &[PlatformAsset]) -> Result<&PlatformAsset, String> {
    let key = current_platform_key();
    platforms.iter().find(|p| p.key == key).ok_or_else(|| {
        format!(
            "no asset for platform {key}; this LSP build doesn't ship a binary for your OS/arch yet"
        )
    })
}

fn extract_archive(
    archive: ArchiveKind,
    src: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    match archive {
        ArchiveKind::None => std::fs::rename(src, dest)
            .map_err(|e| format!("move {} -> {}: {e}", src.display(), dest.display())),
        ArchiveKind::Gzip => extract_gzip(src, dest),
        // For `GithubRelease` callers, tar.gz is unusual (rust-analyzer
        // ships plain gzip). It exists in `ArchiveKind` mainly so the
        // npm and Node-runtime code paths can reuse the same extractor
        // through `extract_tar_gzip` below.
        ArchiveKind::TarGzip => Err(
            "tar.gz isn't a valid GithubRelease archive; use the npm/Node code paths instead"
                .into(),
        ),
        ArchiveKind::Zip => {
            Err("zip extraction is not enabled yet — used by Windows rust-analyzer builds".into())
        }
    }
}

fn extract_gzip(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    use std::io::{BufReader, Write};
    let input = std::fs::File::open(src).map_err(|e| format!("open {}: {e}", src.display()))?;
    let mut decoder = GzDecoder::new(BufReader::new(input));
    let mut output =
        std::fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    // Pump in 64 KiB chunks. Avoids holding the whole binary (rust-analyzer
    // is ~50 MiB decompressed) in memory.
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        use std::io::Read;
        match decoder.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => output
                .write_all(&buf[..n])
                .map_err(|e| format!("write extracted: {e}"))?,
            Err(e) => return Err(format!("gunzip: {e}")),
        }
    }
    output
        .flush()
        .map_err(|e| format!("flush extracted: {e}"))?;
    Ok(())
}

/// Uninstall — used by both the explicit "Uninstall" button and as a
/// recovery path when an install half-completes and the user retries.
pub fn uninstall(app: &AppHandle, id: &str) -> Result<(), String> {
    let root = server_root(app, id)?;
    if !root.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&root).map_err(|e| format!("uninstall {}: {e}", root.display()))
}

// ---------- GoInstall --------------------------------------------------------

/// Install a Go-based LSP by shelling out to the user's `go` toolchain.
///
/// We don't manage a Go SDK ourselves — Go's `go install` is the canonical
/// distribution channel and any user serious about Go has a SDK installed.
/// When they don't, we surface a friendly error pointing at go.dev rather
/// than trying to download a multi-hundred-MB toolchain.
///
/// `GOBIN` is pinned to our managed `bin/` dir, so the binary lands in a
/// location we own (and can `uninstall` later).
async fn install_go(
    app: &AppHandle,
    manifest: &LspManifest,
    progress: &ProgressReporter,
) -> Result<InstallResult, String> {
    let (package, version, binary_name) = match &manifest.install {
        InstallSource::GoInstall {
            package,
            version,
            binary_name,
        } => (package, version, binary_name),
        _ => unreachable!("dispatch invariant"),
    };

    let go = super::which_on_path("go").ok_or_else(|| {
        "Go SDK not found on PATH. Install Go from https://go.dev/dl/ and re-try.".to_string()
    })?;

    progress.report(InstallPhase::Started { total_bytes: None });

    let bin_dir = server_root(app, &manifest.id)?.join("bin");
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(|e| format!("mkdir bin: {e}"))?;

    // `go install` puts the artifact at $GOBIN/<binary> when GOBIN is set.
    // We don't have to chase GOPATH this way.
    let target = format!("{package}@{version}");
    log::info!("lsp_install({}): go install {target}", manifest.id);
    let output = tokio::process::Command::new(&go)
        .arg("install")
        .arg(&target)
        .env("GOBIN", &bin_dir)
        // Keep `go` from leaking proxy/cache pollution from a partial env.
        .env_remove("GOFLAGS")
        .output()
        .await
        .map_err(|e| format!("spawn `go install`: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Best-effort cleanup so a half-built dir doesn't masquerade as installed.
        let _ = tokio::fs::remove_dir_all(&bin_dir).await;
        return Err(if stderr.is_empty() {
            format!(
                "`go install {target}` failed (exit {:?})",
                output.status.code()
            )
        } else {
            format!("`go install {target}` failed: {stderr}")
        });
    }

    progress.report(InstallPhase::Verifying);
    let installed = bin_dir.join(if cfg!(windows) {
        format!("{binary_name}.exe")
    } else {
        binary_name.to_string()
    });
    if !installed.exists() {
        return Err(format!(
            "go install succeeded but binary not at expected path: {}",
            installed.display()
        ));
    }
    make_executable(&installed).map_err(|e| format!("chmod +x: {e}"))?;

    Ok(InstallResult {
        binary_path: installed,
        version: version.clone(),
    })
}

// ---------- NpmBundledNode ---------------------------------------------------

/// Install an npm-distributed LSP under our managed Node runtime.
///
/// End-to-end flow:
///   1. Ensure the Altai-managed Node runtime is on disk (downloads to
///      `<app_data>/runtimes/node/v<ver>/` on first call).
///   2. Write a minimal `package.json` listing the LSP + peers as deps.
///   3. Run `<bundled-node> <bundled-npm-cli> install --no-audit ...` in
///      the server's install root.
///   4. Generate a tiny launcher wrapper at `<lsp_root>/bin/<binary>` that
///      execs `<bundled-node> <real-entry.js>`. Subsequent spawns hit this
///      wrapper, which lets `LspClient.start` stay platform-agnostic.
async fn install_npm_bundled_node(
    app: &AppHandle,
    manifest: &LspManifest,
    progress: &ProgressReporter,
    cancel: &CancelToken,
) -> Result<InstallResult, String> {
    let (package, version, peers, entry_relative) = match &manifest.install {
        InstallSource::NpmBundledNode {
            package,
            version,
            peers,
            entry_relative,
        } => (package, version, peers, entry_relative),
        _ => unreachable!("dispatch invariant"),
    };

    // Step 1 — Node runtime. `ensure_node_runtime` shows download progress,
    // so the user sees a single uninterrupted bar across the bigger Node
    // download + the smaller npm install.
    let node = super::node_runtime::ensure_node_runtime(app, progress, cancel).await?;

    // Step 2 — package.json. We write deliberately small / deterministic
    // content so two installs of the same LSP produce identical trees,
    // and npm's lockfile-less mode is fine for a project we throw away
    // and rebuild on uninstall.
    let install_root = server_root(app, &manifest.id)?;
    tokio::fs::create_dir_all(&install_root)
        .await
        .map_err(|e| format!("mkdir lsp root: {e}"))?;
    let pkg_json = build_package_json(&manifest.id, package, version, peers);
    let pkg_path = install_root.join("package.json");
    tokio::fs::write(&pkg_path, pkg_json)
        .await
        .map_err(|e| format!("write package.json: {e}"))?;

    // Step 3 — npm install. We invoke npm-cli.js directly via Node so we
    // don't depend on the npm shim shell script having executable bits or
    // resolving `node` from PATH.
    progress.report(InstallPhase::Extracting);
    log::info!(
        "lsp_install({}): node {} install in {}",
        manifest.id,
        node.npm_cli_js.display(),
        install_root.display()
    );
    let output = tokio::process::Command::new(&node.node_bin)
        .arg(&node.npm_cli_js)
        .arg("install")
        .arg("--no-audit")
        .arg("--no-fund")
        .arg("--loglevel=error")
        // We don't want npm's progress UI interleaving with ours.
        .arg("--no-progress")
        .current_dir(&install_root)
        // Make sure the spawned npm sees OUR bundled node, not whatever
        // happens to be on PATH. Prepending is enough for npm's own
        // shebangs to resolve correctly.
        .env("PATH", path_with_node_prefix(&node.node_bin))
        .output()
        .await
        .map_err(|e| format!("spawn npm: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("npm install {package}@{version} failed")
        } else {
            format!("npm install {package}@{version} failed: {stderr}")
        });
    }

    // Step 4 — wrapper script. The `entry_relative` in the manifest points
    // at the actual JS entry inside the installed package; we don't trust
    // .bin shims because they'd require a system-resolvable `node`.
    progress.report(InstallPhase::Verifying);
    let entry_script = install_root.join(entry_relative.iter().collect::<std::path::PathBuf>());
    if !entry_script.exists() {
        return Err(format!(
            "npm install completed but entry script missing: {}",
            entry_script.display()
        ));
    }

    let bin_dir = install_root.join("bin");
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(|e| format!("mkdir bin: {e}"))?;
    let binary_name = installed_binary_name(manifest);
    let wrapper_path = if cfg!(windows) {
        bin_dir.join(format!("{binary_name}.cmd"))
    } else {
        bin_dir.join(binary_name)
    };
    write_node_wrapper(&wrapper_path, &node.node_bin, &entry_script)?;
    make_executable(&wrapper_path).map_err(|e| format!("chmod +x wrapper: {e}"))?;

    Ok(InstallResult {
        binary_path: wrapper_path,
        version: version.clone(),
    })
}

fn build_package_json(
    id: &str,
    package: &str,
    version: &str,
    peers: &[super::registry::NpmPeer],
) -> String {
    // Hand-build the JSON so we don't pull serde for one tiny object —
    // and so the diff stays human-readable in case anyone inspects it
    // under `<app_data>/lsp/<id>/package.json`.
    use std::fmt::Write;
    let mut s = String::new();
    s.push_str("{\n");
    let _ = writeln!(s, "  \"name\": \"altai-lsp-{}\",", json_escape(id));
    s.push_str("  \"private\": true,\n");
    s.push_str("  \"dependencies\": {\n");
    let mut first = true;
    let emit = |pkg: &str, ver: &str, s: &mut String, first: &mut bool| {
        if !*first {
            s.push_str(",\n");
        }
        *first = false;
        let _ = write!(s, "    \"{}\": \"{}\"", json_escape(pkg), json_escape(ver));
    };
    emit(package, version, &mut s, &mut first);
    for p in peers {
        emit(&p.package, &p.version, &mut s, &mut first);
    }
    s.push_str("\n  }\n}\n");
    s
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

fn path_with_node_prefix(node_bin: &std::path::Path) -> std::ffi::OsString {
    // We prepend the bundled node's parent dir so npm's child processes
    // (and `npm`'s own shim resolution) pick our node up first. Falls back
    // to whatever PATH the parent had so e.g. git on PATH still works
    // during `git+...` style npm deps.
    let bin_dir = node_bin.parent().map(|p| p.to_owned()).unwrap_or_default();
    match std::env::var_os("PATH") {
        Some(existing) => {
            let mut paths: Vec<std::path::PathBuf> = vec![bin_dir];
            paths.extend(std::env::split_paths(&existing));
            std::env::join_paths(paths).unwrap_or_else(|_| {
                std::ffi::OsString::from(
                    node_bin
                        .parent()
                        .unwrap_or_else(|| std::path::Path::new("")),
                )
            })
        }
        None => bin_dir.into_os_string(),
    }
}

fn write_node_wrapper(
    path: &std::path::Path,
    node_bin: &std::path::Path,
    entry_script: &std::path::Path,
) -> Result<(), String> {
    let contents = if cfg!(windows) {
        format!(
            "@echo off\r\n\"{node}\" \"{entry}\" %*\r\n",
            node = node_bin.display(),
            entry = entry_script.display(),
        )
    } else {
        format!(
            "#!/bin/sh\nexec '{node}' '{entry}' \"$@\"\n",
            node = node_bin.display(),
            entry = entry_script.display(),
        )
    };
    std::fs::write(path, contents).map_err(|e| format!("write wrapper {}: {e}", path.display()))
}

// ---------- tar.gz extraction (shared by Node runtime + future npm) ----------

/// Extract a `.tar.gz` archive into `dest_dir`. Used by `node_runtime` to
/// unpack the Node binary distribution. Returns the path to the first
/// top-level directory in the archive, which is how Node tarballs nest
/// (`node-v20.18.0-darwin-arm64/bin/node`).
pub(crate) fn extract_tar_gzip(
    src: &std::path::Path,
    dest_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    std::fs::create_dir_all(dest_dir).map_err(|e| format!("mkdir extract dest: {e}"))?;
    let file = std::fs::File::open(src).map_err(|e| format!("open {}: {e}", src.display()))?;
    let mut archive = Archive::new(GzDecoder::new(std::io::BufReader::new(file)));
    archive.set_preserve_permissions(true);

    // We stream entries one by one so we can both (a) extract them and
    // (b) record the first top-level directory for the caller.
    let mut top_dir: Option<std::path::PathBuf> = None;
    let entries = archive.entries().map_err(|e| format!("tar entries: {e}"))?;
    for entry_res in entries {
        let mut entry = entry_res.map_err(|e| format!("tar read: {e}"))?;
        let entry_path = entry
            .path()
            .map_err(|e| format!("tar path: {e}"))?
            .into_owned();

        // Guard against zip-slip: any component containing `..` is fatal.
        if entry_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!(
                "tar entry escapes archive root: {}",
                entry_path.display()
            ));
        }
        if top_dir.is_none() {
            if let Some(std::path::Component::Normal(first)) = entry_path.components().next() {
                top_dir = Some(dest_dir.join(first));
            }
        }
        entry
            .unpack_in(dest_dir)
            .map_err(|e| format!("unpack {}: {e}", entry_path.display()))?;
    }
    top_dir.ok_or_else(|| "tar.gz archive contained no entries".to_string())
}
