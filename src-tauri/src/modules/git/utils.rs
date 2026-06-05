use std::path::{Path, PathBuf};

use crate::modules::git::errors::{GitError, Result};
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

#[derive(Clone, Debug)]
pub struct ResolvedGitDirectory {
    pub workspace: WorkspaceEnv,
    pub git_path: String,
    pub local_path: PathBuf,
}

pub fn split_upstream(upstream: &str) -> (Option<String>, Option<String>) {
    match upstream.split_once('/') {
        Some((remote, branch)) => (Some(remote.to_string()), Some(branch.to_string())),
        None => (None, Some(upstream.to_string())),
    }
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn normalize_git_path(path: &str) -> String {
    path.replace('\\', "/")
}

pub fn canonical_dir(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<ResolvedGitDirectory> {
    let candidate = resolve_path(path, workspace);
    if !candidate.is_dir() {
        return Err(GitError::NotADirectory(path.to_string()));
    }
    let local_path = registry
        .canonicalize_cached(&candidate)
        .map_err(GitError::Io)?;
    let git_path = if workspace.is_wsl() {
        normalize_git_path(path)
    } else {
        display_path(&local_path)
    };
    Ok(ResolvedGitDirectory {
        workspace: workspace.clone(),
        git_path,
        local_path,
    })
}

pub fn authorized_repo_root(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<ResolvedGitDirectory> {
    let canonical = canonical_dir(registry, path, workspace)?;
    if !registry.is_authorized(&canonical.local_path) {
        return Err(GitError::PathOutsideWorkspace(canonical.local_path.clone()));
    }
    Ok(canonical)
}

pub fn resolve_within_repo(repo_root: &Path, rel: &str) -> Result<PathBuf> {
    if rel.is_empty() {
        return Err(GitError::InvalidPath(rel.into()));
    }
    if !is_safe_pathspec(rel) {
        return Err(GitError::InvalidPath(rel.into()));
    }
    let joined = repo_root.join(rel);
    let canonical = match std::fs::canonicalize(&joined) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return canonicalize_parent(repo_root, &joined, rel)
        }
        Err(e) => return Err(GitError::Io(e)),
    };
    if !canonical.starts_with(repo_root) {
        return Err(GitError::PathOutsideWorkspace(canonical));
    }
    Ok(canonical)
}

pub fn is_safe_pathspec(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains(':')
        && !rel.contains('\0')
        && !rel.chars().any(|c| (c as u32) < 0x20)
}

fn canonicalize_parent(repo_root: &Path, joined: &Path, rel: &str) -> Result<PathBuf> {
    let parent = joined
        .parent()
        .ok_or_else(|| GitError::InvalidPath(rel.into()))?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(GitError::Io)?;
    if !canonical_parent.starts_with(repo_root) {
        return Err(GitError::PathOutsideWorkspace(canonical_parent));
    }
    let file_name = joined
        .file_name()
        .ok_or_else(|| GitError::InvalidPath(rel.into()))?;
    Ok(canonical_parent.join(file_name))
}

/// Standard base64 (with `=` padding). Small self-contained encoder so we
/// don't pull in a crate just for HTTP basic-auth header construction.
pub fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// True for `https://github.com/...` remotes — the only host we inject a token
/// header for. SSH and other hosts keep using the user's existing credentials.
pub fn is_github_https(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://github.com/") || lower.starts_with("https://www.github.com/")
}

/// `-c http.<base>.extraHeader=...` git args that authenticate GitHub HTTPS
/// requests with `token`. Empty when there's no token or the remote isn't a
/// GitHub HTTPS URL. Scoped to github.com so the header never leaks to other
/// remotes. Note: the value is visible in the process arg list — an accepted
/// trade-off for a single-user desktop app (see plan for the env-config
/// hardening path once the minimum git version allows it).
pub fn github_auth_config_args(remote_url: Option<&str>, token: Option<&str>) -> Vec<String> {
    match (remote_url, token) {
        (Some(url), Some(token)) if is_github_https(url) && !token.is_empty() => {
            let basic = base64_encode(format!("x-access-token:{token}").as_bytes());
            vec![
                "-c".to_string(),
                format!("http.https://github.com/.extraHeader=AUTHORIZATION: basic {basic}"),
            ]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn github_https_detection() {
        assert!(is_github_https("https://github.com/owner/repo.git"));
        assert!(is_github_https("HTTPS://GitHub.com/owner/repo"));
        assert!(!is_github_https("git@github.com:owner/repo.git"));
        assert!(!is_github_https("https://gitlab.com/owner/repo.git"));
    }

    #[test]
    fn auth_args_only_for_github_https_with_token() {
        assert!(github_auth_config_args(Some("https://github.com/a/b.git"), Some("tok")).len() == 2);
        assert!(github_auth_config_args(Some("git@github.com:a/b.git"), Some("tok")).is_empty());
        assert!(github_auth_config_args(Some("https://github.com/a/b.git"), None).is_empty());
        assert!(github_auth_config_args(None, Some("tok")).is_empty());
    }

    #[test]
    fn safe_pathspec_accepts_normal_paths() {
        assert!(is_safe_pathspec("src/main.rs"));
        assert!(is_safe_pathspec("a/b/c-d_e.txt"));
        assert!(is_safe_pathspec("folder with spaces/file.md"));
        assert!(is_safe_pathspec("file.with.dots"));
    }

    #[test]
    fn safe_pathspec_rejects_colon() {
        assert!(!is_safe_pathspec("evil:path"));
        assert!(!is_safe_pathspec(":head"));
        assert!(!is_safe_pathspec("a/b:c"));
    }

    #[test]
    fn safe_pathspec_rejects_nul_and_control() {
        assert!(!is_safe_pathspec("foo\0bar"));
        assert!(!is_safe_pathspec("foo\nbar"));
        assert!(!is_safe_pathspec("foo\rbar"));
        assert!(!is_safe_pathspec("foo\tbar"));
    }

    #[test]
    fn safe_pathspec_rejects_empty() {
        assert!(!is_safe_pathspec(""));
    }

    #[test]
    fn resolve_within_repo_rejects_colon_path() {
        let tmp = std::env::temp_dir();
        let err = resolve_within_repo(&tmp, "evil:path");
        assert!(matches!(err, Err(GitError::InvalidPath(_))));
    }

    #[test]
    fn resolve_within_repo_rejects_nul_path() {
        let tmp = std::env::temp_dir();
        let err = resolve_within_repo(&tmp, "evil\0path");
        assert!(matches!(err, Err(GitError::InvalidPath(_))));
    }
}
