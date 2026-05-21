/**
 * TypeScript mirrors of the Rust `lsp_install::registry` and
 * `lsp_install::progress` types. Keep these in sync with
 * `src-tauri/src/modules/lsp_install/registry.rs` — the Rust side serializes
 * through the same shapes (camelCase, `kind` tag for unions).
 *
 * No defaults / no fabrication: every value comes from the backend over a
 * Tauri command. Hardcoding a parallel TS registry would inevitably drift.
 */

export type PlatformAsset = {
  /** `<os>-<arch>` key, e.g. "macos-aarch64". */
  key: string;
  /** Platform string substituted into `assetTemplate`'s `{platform}` slot. */
  assetPlatform: string;
  /** Hex-encoded sha256; absent when upstream doesn't publish a digest. */
  sha256?: string;
};

export type ArchiveKind = "none" | "gzip" | "tarGzip" | "zip";

export type NpmPeer = {
  package: string;
  version: string;
};

export type InstallSource =
  | {
      kind: "githubRelease";
      owner: string;
      repo: string;
      tag: string;
      assetTemplate: string;
      platforms: PlatformAsset[];
      archive: ArchiveKind;
      binaryName: string;
    }
  | {
      kind: "npmBundledNode";
      package: string;
      version: string;
      peers: NpmPeer[];
      entryRelative: string[];
    }
  | {
      kind: "goInstall";
      package: string;
      version: string;
      binaryName: string;
    };

export type LspManifest = {
  id: string;
  name: string;
  args: string[];
  languageId: string;
  /** Lowercased extensions handled (no leading dot). */
  extensions: string[];
  install: InstallSource;
};

/**
 * Phase events streamed by `lsp_install_run` over a Tauri Channel.
 * `downloaded` frames arrive frequently; render with a debounce if the
 * UI thread struggles, but the Rust side doesn't throttle.
 */
export type InstallPhase =
  | { kind: "started"; totalBytes?: number }
  | { kind: "downloaded"; bytes: number; totalBytes?: number }
  | { kind: "extracting" }
  | { kind: "verifying" }
  | { kind: "done"; path: string; version: string }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" };

/**
 * Reply payload from `lsp_install_status`. Two paths are distinct because
 * the UI shows them differently — managed installs carry a version + an
 * "Uninstall" button, system installs only carry a "Re-check" / "Upgrade
 * to managed" button.
 */
export type LspInstallStatus = {
  id: string;
  installed: boolean;
  managedPath?: string | null;
  systemPath?: string | null;
  version?: string | null;
};
