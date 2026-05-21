//! Streaming HTTPS downloader for LSP binaries.
//!
//! Hardened for the install path:
//!   - HTTPS only, no userinfo, no localhost
//!   - Host allowlist (GitHub release domains, npm registry, Go module proxy)
//!   - Streams to disk while computing sha256 incrementally — never buffers
//!     the whole asset in memory
//!   - Honors a cancellation flag checked between chunks
//!
//! This deliberately doesn't share the network plumbing in `modules::net`
//! because that surface allows private-network endpoints (for LM Studio /
//! Ollama). LSP downloads must hit the public internet only.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::progress::{InstallPhase, ProgressReporter};

/// Outcome of a download: number of bytes written + the binary's hex-sha256.
pub struct DownloadOutcome {
    pub bytes_written: u64,
    pub sha256_hex: String,
}

/// Cancellation token shared between the Tauri command (which the frontend
/// can poke via `lsp_install_cancel`) and the download loop. The loop checks
/// it between every streamed chunk so cancellation is bounded by chunk size,
/// not whole-file latency.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<Mutex<bool>>);

impl CancelToken {
    pub async fn cancel(&self) {
        *self.0.lock().await = true;
    }

    pub async fn is_cancelled(&self) -> bool {
        *self.0.lock().await
    }
}

/// Stream `url` to `dest`, reporting progress as bytes accumulate.
///
/// `expected_sha256` — if `Some`, the download fails with `ChecksumMismatch`
/// when the hex doesn't match (case-insensitive). The file is deleted on
/// mismatch so a partial / tampered download can't masquerade as installed.
pub async fn download_to(
    url: &str,
    dest: &Path,
    expected_sha256: Option<&str>,
    progress: &ProgressReporter,
    cancel: &CancelToken,
) -> Result<DownloadOutcome, String> {
    validate_url(url)?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        // Default redirect policy follows up to 10 hops — GitHub releases
        // bounce through `objects.githubusercontent.com`, which is fine
        // because we re-validate every URL on the redirect chain.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("too many redirects");
            }
            match validate_url(attempt.url().as_str()) {
                Ok(()) => attempt.follow(),
                Err(_) => attempt.stop(),
            }
        }))
        .user_agent("altai/lsp-installer")
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download status {} from {url}", resp.status()));
    }
    let total_bytes = resp.content_length();
    progress.report(InstallPhase::Started { total_bytes });

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let mut file = File::create(dest)
        .await
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut bytes_written: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk_res) = stream.next().await {
        if cancel.is_cancelled().await {
            // Best-effort cleanup — don't shadow the cancel signal with a
            // delete error.
            let _ = file.shutdown().await;
            let _ = tokio::fs::remove_file(dest).await;
            return Err("cancelled".into());
        }
        let chunk = chunk_res.map_err(|e| format!("read body: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write disk: {e}"))?;
        bytes_written += chunk.len() as u64;
        progress.report(InstallPhase::Downloaded {
            bytes: bytes_written,
            total_bytes,
        });
    }
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("close file: {e}"))?;

    let sha256_hex = hex::encode(hasher.finalize());

    if let Some(expected) = expected_sha256 {
        if !expected.eq_ignore_ascii_case(&sha256_hex) {
            let _ = tokio::fs::remove_file(dest).await;
            return Err(format!(
                "checksum mismatch: expected {expected}, got {sha256_hex}"
            ));
        }
    }

    Ok(DownloadOutcome {
        bytes_written,
        sha256_hex,
    })
}

/// Reject anything that isn't an HTTPS request to a known LSP-distribution
/// host. We can grow this list as we add installers — keeping the gate
/// narrow today means a typo in the registry can't accidentally pull from
/// a malicious mirror.
fn validate_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("only https is allowed (got {})", parsed.scheme()));
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("userinfo in url is not allowed".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?
        .to_ascii_lowercase();
    if !is_allowed_host(&host) {
        return Err(format!("host not in download allowlist: {host}"));
    }
    Ok(())
}

fn is_allowed_host(host: &str) -> bool {
    // GitHub releases: github.com hosts the metadata, objects.githubusercontent.com
    // serves the actual asset bytes after a redirect.
    matches!(
        host,
        "github.com"
            | "api.github.com"
            | "codeload.github.com"
            | "objects.githubusercontent.com"
            | "release-assets.githubusercontent.com"
            | "raw.githubusercontent.com"
    ) || host.ends_with(".objects.githubusercontent.com")
        || host.ends_with(".githubusercontent.com")
        // npm registry — for the Phase-4 npm installer (it hits both
        // the metadata API and the tarball CDN).
        || host == "registry.npmjs.org"
        || host.ends_with(".npmjs.org")
        // Node.js distribution — used by the bundled-Node runtime
        // downloader (Phase 4). nodejs.org redirects to a CloudFront
        // CDN edge, both validated by the redirect policy.
        || host == "nodejs.org"
        || host.ends_with(".nodejs.org")
        // Go module proxy — used by `go install` under the hood. The
        // download crate doesn't touch this directly today, but adding it
        // here keeps the allowlist coherent.
        || host == "proxy.golang.org"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_http_and_userinfo_and_unknown_hosts() {
        assert!(validate_url("http://github.com/foo").is_err());
        assert!(validate_url("https://user:pass@github.com/foo").is_err());
        assert!(validate_url("https://evil.example.com/foo").is_err());
        assert!(validate_url("ftp://github.com/foo").is_err());
        assert!(validate_url("https://github.com/foo").is_ok());
        assert!(validate_url("https://objects.githubusercontent.com/x").is_ok());
        assert!(validate_url("https://registry.npmjs.org/typescript").is_ok());
    }
}
