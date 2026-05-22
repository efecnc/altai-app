//! Bidirectional child-process I/O for LSP servers and MCP servers.
//!
//! Unlike `shell::shell_run_command` (which discards stdin) and `pty` (which
//! allocates a terminal), this module is built for JSON-RPC-style protocols
//! where the frontend keeps an open dialog with the child:
//!
//! - `proc_spawn` boots the child with `stdin`/`stdout`/`stderr` piped.
//!   Three channels stream stdout/stderr/exit back to the frontend.
//! - `proc_stdin_write` queues bytes into a writer task that drains to the
//!   child's stdin without blocking the IPC worker.
//! - `proc_kill` terminates the child; the wait task surfaces the exit code
//!   on the exit channel either way.
//!
//! Single state container, monotonically-increasing ids, no id reuse.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};

#[derive(Default, Clone)]
pub struct ProcState {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    next_id: AtomicU64,
}

struct Session {
    /// Sender side of the stdin queue; `None` once stdin has been closed
    /// (either by the child exiting or by an explicit close).
    stdin_tx: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    /// Used by `proc_kill` to actively terminate. The wait task still
    /// surfaces the exit code on the exit channel.
    child: Mutex<Child>,
}

#[derive(Serialize, Clone)]
pub struct ExitPayload {
    /// Unix process signal that ended the child, if any. `None` on Windows
    /// and for normal exits.
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<i32>,
    /// Exit code, when available. `None` if the child was signal-killed
    /// and no code is exposed by the platform.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

/// Spawn an external process with all three pipes wired up. Returns a
/// stable id the frontend uses for subsequent writes/kills. The id is
/// never reused.
// The frontend invokes this command by argument name; bundling the inputs
// into a single struct would force a renderer-side wrapper. Eight args is
// the right shape here.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn proc_spawn(
    state: tauri::State<'_, ProcState>,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    on_stdout: Channel<Response>,
    on_stderr: Channel<Response>,
    on_exit: Channel<ExitPayload>,
) -> Result<u64, String> {
    if command.trim().is_empty() {
        return Err("command is empty".into());
    }

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Detach from any inherited TTY so prompts don't deadlock the
        // spawn. LSP/MCP servers should never be interactive.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "");
    if let Some(dir) = cwd.as_deref() {
        cmd.current_dir(dir);
    }
    if let Some(env_map) = env {
        for (k, v) in env_map {
            cmd.env(k, v);
        }
    }

    let mut child = cmd.spawn().map_err(|e| {
        log::warn!("proc_spawn({command}) failed: {e}");
        format!("spawn failed: {e}")
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "stdin pipe not available".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout pipe not available".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr pipe not available".to_string())?;

    let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    let id = state.inner.next_id.fetch_add(1, Ordering::Relaxed);

    tokio::spawn(stdin_writer_task(id, stdin, stdin_rx));
    tokio::spawn(reader_task(id, "stdout", stdout, on_stdout));
    tokio::spawn(reader_task(id, "stderr", stderr, on_stderr));

    let session = Arc::new(Session {
        stdin_tx: Mutex::new(Some(stdin_tx)),
        child: Mutex::new(child),
    });

    // Wait task — surfaces exit and removes the session from the registry
    // when the child ends. Holds its own clone of the inner state so it
    // doesn't need a `tauri::State` borrow (which can't cross tasks).
    let session_for_wait = session.clone();
    let inner_for_wait = state.inner.clone();
    tokio::spawn(async move {
        let payload = wait_for_exit(id, &session_for_wait).await;
        let _ = on_exit.send(payload);
        if let Some(tx) = session_for_wait.stdin_tx.lock().await.take() {
            drop(tx);
        }
        inner_for_wait.sessions.lock().await.remove(&id);
        log::info!("proc id={id} exited");
    });

    state.inner.sessions.lock().await.insert(id, session);
    log::info!("proc spawned id={id} command={command}");
    Ok(id)
}

/// Append bytes to the child's stdin. Returns immediately; the writer task
/// drains in the background.
#[tauri::command]
pub async fn proc_stdin_write(
    state: tauri::State<'_, ProcState>,
    id: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = state
        .inner
        .sessions
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session id={id}"))?;
    let guard = session.stdin_tx.lock().await;
    let tx = guard
        .as_ref()
        .ok_or_else(|| "stdin already closed".to_string())?;
    tx.send(data).map_err(|_| "stdin queue closed".to_string())
}

/// Return the current user's home directory, if it can be resolved.
/// Used by callers that need a sensible workspace-root default (LSP
/// servers like `rust-analyzer` reject empty / fictional roots).
#[tauri::command]
pub fn proc_home_dir() -> Option<String> {
    dirs::home_dir().map(|p| p.to_string_lossy().to_string())
}

/// Resolve a command name against `PATH` without spawning it. Lets the
/// frontend distinguish "binary not installed" from "binary crashed" so
/// the UI can render the two as different states.
#[tauri::command]
pub fn proc_which(name: String) -> Option<String> {
    use std::path::Path;

    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Absolute / dotted paths short-circuit PATH lookup.
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
    // On Windows, the resolved file usually has a `PATHEXT` extension.
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

/// Force-terminate the child. The wait task still fires `on_exit`.
#[tauri::command]
pub async fn proc_kill(state: tauri::State<'_, ProcState>, id: u64) -> Result<(), String> {
    let session = state
        .inner
        .sessions
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session id={id}"))?;
    let mut child = session.child.lock().await;
    if let Err(e) = child.start_kill() {
        log::debug!("proc_kill id={id} start_kill: {e}");
    }
    Ok(())
}

async fn wait_for_exit(id: u64, session: &Session) -> ExitPayload {
    let mut child = session.child.lock().await;
    match child.wait().await {
        Ok(s) => {
            #[cfg(unix)]
            let signal = {
                use std::os::unix::process::ExitStatusExt;
                s.signal()
            };
            #[cfg(not(unix))]
            let signal = None::<i32>;
            ExitPayload {
                signal,
                code: s.code(),
            }
        }
        Err(e) => {
            log::warn!("proc id={id} wait failed: {e}");
            ExitPayload {
                signal: None,
                code: None,
            }
        }
    }
}

async fn stdin_writer_task(
    id: u64,
    mut stdin: ChildStdin,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    while let Some(chunk) = rx.recv().await {
        if let Err(e) = stdin.write_all(&chunk).await {
            log::debug!("proc id={id} stdin write failed: {e}");
            break;
        }
        if let Err(e) = stdin.flush().await {
            log::debug!("proc id={id} stdin flush failed: {e}");
            break;
        }
    }
    // Dropping `stdin` closes the pipe; if the child expects EOF (rare for
    // JSON-RPC servers), this is how it gets delivered.
}

async fn reader_task<R>(
    id: u64,
    stream: &'static str,
    mut reader: R,
    channel: Channel<Response>,
) where
    R: AsyncReadExt + Unpin,
{
    // 16 KiB matches PTY's chunk size; small enough for low-latency frames,
    // large enough to amortize wakeups when servers blast output.
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                let response = Response::new(InvokeResponseBody::Raw(chunk));
                if channel.send(response).is_err() {
                    // Frontend dropped the channel — common during HMR.
                    break;
                }
            }
            Err(e) => {
                log::debug!("proc id={id} {stream} read failed: {e}");
                break;
            }
        }
    }
}
