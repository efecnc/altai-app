use serde::Serialize;
use shared_child::SharedChild;
use std::io::Read;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;
use tempfile::NamedTempFile;

const CELL_TIMEOUT_SECS: u64 = 30;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct CellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// Execute a Python code cell and return stdout/stderr.
///
/// Writes the source to a temp file and runs `python3 <tmpfile>`.
/// Uses the same subprocess + timeout pattern as `shell::run_blocking`.
#[tauri::command]
pub async fn notebook_execute_cell(
    source: String,
    cwd: Option<String>,
) -> Result<CellResult, String> {
    let trimmed = source.trim().to_string();
    if trimmed.is_empty() {
        return Ok(CellResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: Some(0),
            timed_out: false,
        });
    }

    let (tx, rx) = mpsc::channel::<Result<CellResult, String>>();
    thread::spawn(move || {
        let _ = tx.send(run_cell(trimmed, cwd));
    });

    rx.recv().map_err(|e| e.to_string())?
}

fn run_cell(source: String, cwd: Option<String>) -> Result<CellResult, String> {
    // Write source to a temp file so multiline code works correctly.
    let mut tmp = NamedTempFile::new().map_err(|e| format!("Failed to create temp file: {}", e))?;
    tmp.write_all(source.as_bytes())
        .map_err(|e| format!("Failed to write cell source: {}", e))?;
    tmp.flush()
        .map_err(|e| format!("Failed to flush temp file: {}", e))?;

    let tmp_path = tmp.path().to_string_lossy().to_string();

    // Try python3 first, fall back to python.
    let python = find_python();

    let mut cmd = Command::new(&python);
    cmd.arg(&tmp_path);
    if let Some(dir) = cwd.as_deref().filter(|s| !s.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = Arc::new(
        SharedChild::spawn(&mut cmd).map_err(|e| format!("Failed to spawn {}: {}", python, e))?,
    );

    let mut stdout_pipe = child
        .take_stdout()
        .ok_or_else(|| "no stdout pipe".to_string())?;
    let mut stderr_pipe = child
        .take_stderr()
        .ok_or_else(|| "no stderr pipe".to_string())?;

    let stdout_handle = thread::spawn(move || drain(&mut stdout_pipe));
    let stderr_handle = thread::spawn(move || drain(&mut stderr_pipe));

    // Wait with timeout.
    let (wait_tx, wait_rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = wait_tx.send(waiter.wait());
    });

    let dur = Duration::from_secs(CELL_TIMEOUT_SECS);
    let (exit_code, timed_out) = match wait_rx.recv_timeout(dur) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("cell wait thread disconnected".into());
        }
    };

    let stdout_bytes = stdout_handle.join().unwrap_or_default();
    let stderr_bytes = stderr_handle.join().unwrap_or_default();

    Ok(CellResult {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code,
        timed_out,
    })
}

fn drain(reader: &mut dyn Read) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() + n > MAX_OUTPUT_BYTES {
                    let remaining = MAX_OUTPUT_BYTES.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..remaining]);
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(_) => break,
        }
    }
    buf
}

fn find_python() -> String {
    // Check python3 first, then python.
    for candidate in &["python3", "python"] {
        if Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return candidate.to_string();
        }
    }
    "python3".to_string()
}
