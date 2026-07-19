//! Built-in registry of LSP servers the app knows how to install.
//!
//! Each `LspManifest` declares (a) what the server is — id, language id,
//! file extensions, default args — and (b) how to install it — a
//! discriminated `InstallSource` that the installer dispatcher pattern-matches
//! on.
//!
//! The registry is hard-coded rather than fetched at runtime so the install
//! contract for a given app version is reproducible: bumping a server version
//! requires a code change (and review), not a server-side push.

use serde::{Deserialize, Serialize};

/// Discriminated union over the three install strategies we support.
///
/// `kind`/camelCase tags mirror what the TS frontend expects so the same
/// manifest round-trips through Tauri commands without a translation layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallSource {
    /// Direct binary download from a GitHub release. One asset per platform.
    GithubRelease {
        owner: String,
        repo: String,
        /// Release tag — date-based for rust-analyzer (`2026-05-18`), semver
        /// for others. Drives the download URL.
        tag: String,
        /// Asset template with `{platform}` placeholder — the installer
        /// substitutes the per-platform `asset_platform` string at install time.
        asset_template: String,
        /// Per-platform asset metadata. Installer picks the entry whose
        /// `key` matches the current `(os, arch)` tuple.
        platforms: Vec<PlatformAsset>,
        /// How the downloaded asset is packaged.
        archive: ArchiveKind,
        /// Final on-disk binary name (without extension on Unix).
        binary_name: String,
    },
    /// npm tarball executed via Altai's bundled Node runtime. Phase 4 wires
    /// this up; for now installers built around this variant return a
    /// not-yet-supported error so the rest of the surface stays consistent.
    NpmBundledNode {
        package: String,
        version: String,
        /// Extra packages to install alongside (e.g. TypeScript itself as
        /// a peer of `typescript-language-server`).
        peers: Vec<NpmPeer>,
        /// Relative path segments to the executable script inside the
        /// extracted package. Joined with the install dir at spawn time.
        entry_relative: Vec<String>,
    },
    /// `go install <package>@<version>`. Requires the user's Go SDK on PATH;
    /// the installer surfaces a friendly error and a "Get Go" link otherwise.
    GoInstall {
        package: String,
        version: String,
        binary_name: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpmPeer {
    pub package: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformAsset {
    /// Stable key matching our `(os, arch)` tuple — see [`current_platform_key`].
    pub key: String,
    /// String substituted into `asset_template`'s `{platform}` slot.
    pub asset_platform: String,
    /// Hex-encoded sha256, when the upstream release publishes one.
    /// We don't fail the install if it's `None`: we trust HTTPS+GitHub but
    /// verify whenever we can.
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveKind {
    /// File is the binary itself, no decompression needed.
    None,
    /// Single-file gzip — `gunzip` to get the binary.
    Gzip,
    /// tar.gz containing files — extract, then find the entry binary.
    TarGzip,
    /// zip archive. Stubbed in Phase 1 (Windows rust-analyzer uses this).
    Zip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspManifest {
    /// Stable id, matches the frontend catalog (`"rust"`, `"typescript"`…).
    pub id: String,
    /// Display name shown in the Settings UI.
    pub name: String,
    /// Default args appended after the resolved binary path on spawn.
    pub args: Vec<String>,
    /// LSP `languageId` to declare for open documents.
    pub language_id: String,
    /// Lowercased file extensions handled by this server (no leading dot).
    pub extensions: Vec<String>,
    /// How to install the binary.
    pub install: InstallSource,
}

/// Return the platform key for the current process — used to pick an entry
/// out of [`PlatformAsset`] lists at install time.
///
/// Format: `<os>-<arch>`. We deliberately keep this short — manifests are
/// human-edited in this file and benefit from one obvious key per platform.
pub fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "macos-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "macos-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "windows-aarch64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
    )))]
    {
        "unsupported"
    }
}

/// All four LSPs we plan to support out of the box. Frontend mirrors this
/// list and looks up by `id`.
pub fn default_registry() -> Vec<LspManifest> {
    vec![
        rust_analyzer(),
        typescript_language_server(),
        pyright(),
        gopls(),
    ]
}

/// Look up one manifest by id.
pub fn manifest(id: &str) -> Option<LspManifest> {
    default_registry().into_iter().find(|m| m.id == id)
}

fn rust_analyzer() -> LspManifest {
    // Tag bumps are intentional code changes. Asset names follow
    // `rust-analyzer-<rust-target-triple>.gz` for Unix; the Windows
    // variants use `.zip` and are stubbed for now (Phase 1 supports Unix).
    LspManifest {
        id: "rust".into(),
        name: "Rust".into(),
        args: vec![],
        language_id: "rust".into(),
        extensions: vec!["rs".into()],
        install: InstallSource::GithubRelease {
            owner: "rust-lang".into(),
            repo: "rust-analyzer".into(),
            tag: "2026-05-18".into(),
            asset_template: "rust-analyzer-{platform}.gz".into(),
            platforms: vec![
                PlatformAsset {
                    key: "macos-aarch64".into(),
                    asset_platform: "aarch64-apple-darwin".into(),
                    sha256: None,
                },
                PlatformAsset {
                    key: "macos-x86_64".into(),
                    asset_platform: "x86_64-apple-darwin".into(),
                    sha256: None,
                },
                PlatformAsset {
                    key: "linux-x86_64".into(),
                    asset_platform: "x86_64-unknown-linux-gnu".into(),
                    sha256: None,
                },
                PlatformAsset {
                    key: "linux-aarch64".into(),
                    asset_platform: "aarch64-unknown-linux-gnu".into(),
                    sha256: None,
                },
            ],
            archive: ArchiveKind::Gzip,
            binary_name: "rust-analyzer".into(),
        },
    }
}

fn typescript_language_server() -> LspManifest {
    LspManifest {
        id: "typescript".into(),
        name: "TypeScript".into(),
        args: vec!["--stdio".into()],
        language_id: "typescript".into(),
        extensions: vec![
            "ts".into(),
            "tsx".into(),
            "js".into(),
            "jsx".into(),
            "mjs".into(),
            "cjs".into(),
        ],
        install: InstallSource::NpmBundledNode {
            package: "typescript-language-server".into(),
            version: "4.3.3".into(),
            peers: vec![NpmPeer {
                package: "typescript".into(),
                version: "5.6.3".into(),
            }],
            entry_relative: vec![
                "node_modules".into(),
                ".bin".into(),
                "typescript-language-server".into(),
            ],
        },
    }
}

fn pyright() -> LspManifest {
    LspManifest {
        id: "python".into(),
        name: "Python".into(),
        args: vec!["--stdio".into()],
        language_id: "python".into(),
        extensions: vec!["py".into(), "pyi".into()],
        install: InstallSource::NpmBundledNode {
            package: "pyright".into(),
            version: "1.1.395".into(),
            peers: vec![],
            entry_relative: vec![
                "node_modules".into(),
                ".bin".into(),
                "pyright-langserver".into(),
            ],
        },
    }
}

fn gopls() -> LspManifest {
    LspManifest {
        id: "go".into(),
        name: "Go".into(),
        args: vec![],
        language_id: "go".into(),
        extensions: vec!["go".into()],
        install: InstallSource::GoInstall {
            package: "golang.org/x/tools/gopls".into(),
            version: "latest".into(),
            binary_name: "gopls".into(),
        },
    }
}
