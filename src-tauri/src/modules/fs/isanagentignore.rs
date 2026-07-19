//! `.isanagentignore` matcher for altai's fs layer.
//!
//! Mirrors the Kilo `.isanagentignore` spec: a workspace-root file with
//! gitignore-style patterns that filters altai's editor search, explorer
//! search, and TS-side walker access. The agent itself reads files through
//! isanagent's own tools (gated separately by the upstream crate — Tier 2,
//! see `altaidevorg/isanagent` PR A); this module is Tier 1 (altai-app fs).
//!
//! Walkers (`fs_search`, `fs_grep`, ...) honor the file via
//! `WalkBuilder::add_custom_ignore_filename`, identical to `.gitignore`
//! semantics (nested files at any depth, with `.parents(true)`). Single-path
//! commands (`fs_read_file`, `fs_write_file`, ...) opt-in to the same matcher
//! via [`is_ignored`], which walks the parent chain to find the nearest
//! `.isanagentignore` and applies it as a combined `ignore::gitignore` matcher.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

/// Filename altai honors as a `.isanagentignore` (gitignore syntax). Walker
/// commands pass this to `WalkBuilder::add_custom_ignore_filename` so the
/// `ignore` crate applies it at any depth just like `.gitignore`.
pub const IGNORE_FILENAME: &str = ".isanagentignore";

/// How long a cached matcher is considered fresh before re-stat'ing the file.
/// Short TTL keeps the TOCTOU window tight while coalescing bursts of checks
/// (e.g. a recursive grep fans out to one `is_ignored` call per hit).
const CACHE_TTL_SECS: u64 = 2;

#[derive(Default)]
struct CacheEntry {
    matcher: Option<Gitignore>,
    file_mtime: Option<SystemTime>,
    built_at: Option<Instant>,
}

/// Process-global cache: directory containing a `.isanagentignore` → matcher.
/// Keyed by the file's parent dir (not the workspace root) so multi-root
/// setups don't cross-contaminate. The single-UI-one-workspace assumption
/// keeps this small in practice.
static CACHE: OnceLock<Mutex<HashMap<PathBuf, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<PathBuf, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Walk up from `target`'s parent chain to find the nearest directory that
/// contains a `.isanagentignore`. Returns the directory (the root the matcher
/// applies relative to), or `None` when no ancestor carries the file.
///
/// Mirrors gitignore resolution: patterns are relative to the file's
/// directory, so the nearest ancestor wins for the path being checked.
fn find_ignore_dir(target: &Path) -> Option<PathBuf> {
    let start = if target.is_dir() {
        target
    } else {
        target.parent()?
    };
    let mut cursor: Option<&Path> = Some(start);
    while let Some(dir) = cursor {
        if dir.join(IGNORE_FILENAME).is_file() {
            return Some(dir.to_path_buf());
        }
        cursor = dir.parent();
    }
    None
}

/// Build a fresh `Gitignore` matcher from the `.isanagentignore` at `dir`.
/// Returns `None` if the file is missing, unreadable, or contains no usable
/// patterns. Comments and blank lines are skipped (they would otherwise be
/// treated as literal patterns by `GitignoreBuilder::add_line`).
fn build_matcher(dir: &Path) -> Option<Gitignore> {
    let path = dir.join(IGNORE_FILENAME);
    let contents = std::fs::read_to_string(&path).ok()?;
    let mut builder = GitignoreBuilder::new(dir);
    let mut added = 0usize;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Err(e) = builder.add_line(None, line) {
            log::debug!(".isanagentignore pattern rejected {line:?}: {e}");
            continue;
        }
        added += 1;
    }
    if added == 0 {
        return None;
    }
    builder.build().ok()
}

/// Look up (or refresh) the cached matcher for the `.isanagentignore` whose
/// directory is nearest to `target`. Returns `None` when no `.isanagentignore`
/// applies. Rebuilds when the file's mtime changed or the TTL elapsed.
fn matcher_for(target: &Path) -> Option<(PathBuf, Gitignore)> {
    let dir = find_ignore_dir(target)?;
    let file_path = dir.join(IGNORE_FILENAME);
    let mtime = std::fs::metadata(&file_path)
        .and_then(|m| m.modified())
        .ok();
    let now = Instant::now();

    let mut guard = cache().lock().expect("isanagentignore cache poisoned");
    if let Some(entry) = guard.get(&dir) {
        let ttl_fresh = entry
            .built_at
            .is_some_and(|b| now.duration_since(b).as_secs() < CACHE_TTL_SECS);
        let mtime_match = entry.file_mtime == mtime;
        if ttl_fresh && mtime_match {
            return entry.matcher.clone().map(|m| (dir, m));
        }
    }

    let matcher = build_matcher(&dir);
    guard.insert(
        dir.clone(),
        CacheEntry {
            matcher: matcher.clone(),
            file_mtime: mtime,
            built_at: Some(now),
        },
    );
    matcher.map(|m| (dir, m))
}

/// True if `target` is blocked by a `.isanagentignore` file in any ancestor.
/// `is_dir` controls directory-pattern matching (trailing-slash rules).
///
/// Returns `false` when no `.isanagentignore` applies or the matcher accepts
/// the path. The path itself is never reported as ignored (a target equal to
/// the ignore dir is the root, not a child to filter).
pub fn is_ignored(target: &Path, is_dir: bool) -> bool {
    let Some((dir, matcher)) = matcher_for(target) else {
        return false;
    };
    let rel = match target.strip_prefix(&dir) {
        Ok(r) => r,
        Err(_) => return false,
    };
    if rel.as_os_str().is_empty() {
        return false;
    }
    // `matched_path_or_any_parents` walks ancestor components so a file inside
    // an ignored directory (e.g. `build/` matching `a/b/build/out.txt`) is
    // caught — matches `.gitignore` semantics. Plain `matched` would miss it.
    matcher.matched_path_or_any_parents(rel, is_dir).is_ignore()
}

/// Drop every cached matcher so the next call re-reads from disk. Called by
/// `fs_set_isanagentignore` after an atomic write so edits land immediately
/// without waiting for the TTL to elapse.
pub fn invalidate_all() {
    let mut guard = cache().lock().expect("isanagentignore cache poisoned");
    guard.clear();
}

/// Resolve a workspace path argument (frontend forward-slash form) to a host
/// `PathBuf`. Mirrors the per-command pattern in `file.rs` / `mutate.rs`.
fn resolve_workspace_dir(
    workspace: Option<crate::modules::workspace::WorkspaceEnv>,
    workspace_arg: Option<String>,
) -> Result<std::path::PathBuf, String> {
    use crate::modules::workspace::{resolve_path, WorkspaceEnv};

    let env = WorkspaceEnv::from_option(workspace);
    let root = workspace_arg
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "workspace root is required".to_string())?;
    let p = resolve_path(root, &env);
    if !p.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    Ok(p)
}

/// Read the workspace's `.isanagentignore` contents. Returns `None` when the
/// file does not exist (so the Settings UI can distinguish "no file" from
/// "empty file").
#[tauri::command]
pub fn fs_get_isanagentignore(
    workspace: Option<crate::modules::workspace::WorkspaceEnv>,
    workspace_path: Option<String>,
) -> Result<Option<String>, String> {
    let root = resolve_workspace_dir(workspace, workspace_path)?;
    let file = root.join(IGNORE_FILENAME);
    match std::fs::read_to_string(&file) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Atomically write the workspace's `.isanagentignore`, then drop the cached
/// matcher so enforcement picks up the new patterns immediately.
#[tauri::command]
pub fn fs_set_isanagentignore(
    workspace: Option<crate::modules::workspace::WorkspaceEnv>,
    workspace_path: Option<String>,
    content: String,
) -> Result<(), String> {
    let root = resolve_workspace_dir(workspace, workspace_path)?;
    let target = root.join(IGNORE_FILENAME);
    super::file::write_atomic(&target, content.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", target.display()))?;
    invalidate_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_ignore(dir: &Path, body: &str) {
        fs::write(dir.join(IGNORE_FILENAME), body).unwrap();
    }

    #[test]
    fn no_ignore_file_means_not_ignored() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("note.txt");
        fs::write(&file, b"x").unwrap();
        invalidate_all();
        assert!(!is_ignored(&file, false));
    }

    #[test]
    fn denies_matching_path() {
        let dir = tempdir().unwrap();
        write_ignore(dir.path(), "secrets/**\n");
        let secret = dir.path().join("secrets").join("api.key");
        fs::create_dir_all(secret.parent().unwrap()).unwrap();
        fs::write(&secret, b"x").unwrap();
        invalidate_all();
        assert!(is_ignored(&secret, false));
    }

    #[test]
    fn allows_unrelated_path() {
        let dir = tempdir().unwrap();
        write_ignore(dir.path(), "secrets/**\n");
        let readme = dir.path().join("README.md");
        fs::write(&readme, b"x").unwrap();
        invalidate_all();
        assert!(!is_ignored(&readme, false));
    }

    #[test]
    fn honors_negation() {
        let dir = tempdir().unwrap();
        write_ignore(dir.path(), "*.log\n!important.log\n");
        let ordinary = dir.path().join("debug.log");
        fs::write(&ordinary, b"x").unwrap();
        let important = dir.path().join("important.log");
        fs::write(&important, b"x").unwrap();
        invalidate_all();
        assert!(is_ignored(&ordinary, false));
        assert!(!is_ignored(&important, false));
    }

    #[test]
    fn honors_nested_dir_pattern() {
        let dir = tempdir().unwrap();
        write_ignore(dir.path(), "build/\n");
        let artifact = dir.path().join("build").join("out.txt");
        fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        fs::write(&artifact, b"x").unwrap();
        invalidate_all();
        assert!(is_ignored(&artifact, false));
        assert!(is_ignored(artifact.parent().unwrap(), true));
    }

    #[test]
    fn empty_or_comment_only_file_is_no_op() {
        let dir = tempdir().unwrap();
        write_ignore(dir.path(), "# just a comment\n\n");
        let any = dir.path().join("any.txt");
        fs::write(&any, b"x").unwrap();
        invalidate_all();
        assert!(!is_ignored(&any, false));
    }

    #[test]
    fn applies_from_parent_directory() {
        // .isanagentignore at the root should apply to a file in a subdir.
        let root = tempdir().unwrap();
        write_ignore(root.path(), "ignore.me\n");
        let sub = root.path().join("a").join("b");
        fs::create_dir_all(&sub).unwrap();
        let target = sub.join("ignore.me");
        fs::write(&target, b"x").unwrap();
        invalidate_all();
        assert!(is_ignored(&target, false));
    }

    #[test]
    fn invalidate_clears_cache() {
        let dir = tempdir().unwrap();
        write_ignore(dir.path(), "old\n");
        let target = dir.path().join("old");
        fs::write(&target, b"x").unwrap();
        invalidate_all();
        assert!(is_ignored(&target, false));

        // Edit the file: the TTL would still be fresh, so without
        // invalidation the cached matcher would still deny. Invalidate and
        // the new content (allowing `old`) takes effect.
        write_ignore(dir.path(), "nothing\n");
        invalidate_all();
        assert!(!is_ignored(&target, false));
    }
}
