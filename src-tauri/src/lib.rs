mod altai;
mod modules;

use altai::agent::commands as agent_commands;
use modules::{
    fs, git, github, lsp_install, mcp, net, notebook, os_menu, proc, pty, secrets, shell, webview,
    workspace,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

#[derive(Clone, Serialize, Deserialize, Debug)]
struct LaunchPayload {
    #[serde(rename = "type")]
    kind: String,
    paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
}

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct PendingLaunch(Mutex<Vec<LaunchPayload>>);

#[tauri::command]
fn get_pending_launches(state: State<'_, PendingLaunch>) -> Vec<LaunchPayload> {
    let mut pending = state.0.lock().expect("PendingLaunch mutex poisoned");
    std::mem::take(&mut *pending)
}

/// Read a process env var as a boolean flag. Returns `true` when the var is
/// set to `"1"`, `"true"`, `"yes"`, or `"on"` (case-insensitive); `false`
/// otherwise (including when unset). Used by the frontend to honor
/// `ALTAI_DISABLE_AUTOCOMPACT` / `ALTAI_DISABLE_PRUNE` overrides that
/// Vite's `import.meta.env` can't see.
#[tauri::command]
fn env_get_flag(name: String) -> bool {
    matches!(
        std::env::var(&name)
            .ok()
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Open a filesystem item with a user-selected application. This deliberately
/// stays in the backend so the webview never gets broad process-launch access.
#[tauri::command]
fn open_with(path: String, application: String) -> Result<(), String> {
    let application = application.trim();
    if application.is_empty() {
        return Err("An application name or executable is required.".to_string());
    }

    let path = std::fs::canonicalize(&path)
        .map_err(|e| format!("Could not access the selected item: {e}"))?;
    tauri_plugin_opener::open_path(path, Some(application))
        .map_err(|e| format!("Could not open the item with {application}: {e}"))
}

fn collect_launch_payloads(args: Vec<String>, cwd: Option<&str>) -> Vec<LaunchPayload> {
    let mut files = Vec::new();
    let mut folders = Vec::new();
    let mut action = None;

    for arg in args.into_iter().skip(1) {
        if arg == "--explain" {
            action = Some("explain".to_string());
            continue;
        }
        if arg == "--refactor" {
            action = Some("refactor".to_string());
            continue;
        }
        if arg == "--ask-project" {
            action = Some("ask-project".to_string());
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        // Resolve relative args against the caller-provided cwd (the requesting
        // process's directory for single-instance launches), not this process's.
        let candidate = std::path::Path::new(&arg);
        let resolved = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else if let Some(base) = cwd {
            std::path::Path::new(base).join(candidate)
        } else {
            candidate.to_path_buf()
        };
        let Ok(canon) = std::fs::canonicalize(&resolved) else {
            continue;
        };
        let s = canon.to_string_lossy();
        let path = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();

        if canon.is_dir() {
            folders.push(path);
        } else if canon.is_file() {
            files.push(path);
        }
    }

    let mut payloads = Vec::new();

    if !folders.is_empty() {
        payloads.push(LaunchPayload {
            kind: "folder".to_string(),
            paths: folders,
            action: action.clone(),
        });
    }

    if !files.is_empty() {
        payloads.push(LaunchPayload {
            kind: if files.len() > 1 {
                "multi_file".to_string()
            } else {
                "file".to_string()
            },
            paths: files,
            action,
        });
    }

    payloads
}

fn handle_launch_args(app: &tauri::AppHandle, args: Vec<String>, cwd: Option<&str>) {
    let payloads = collect_launch_payloads(args, cwd);
    for payload in payloads {
        // When `main` is already up, deliver straight to it (targeting the
        // primary window so extra windows don't all switch folders) and do NOT
        // queue: a queued payload would be drained by the next "New Window" on
        // mount, hijacking its welcome screen. Only queue when no window exists
        // yet (cold start / startup race), for the first window to pick up.
        match app.get_webview_window("main") {
            Some(main) => {
                let _ = main.emit("altai:launch", &payload);
            }
            None => {
                let _ = app.emit("altai:launch", &payload);
                let state = app.state::<PendingLaunch>();
                state.0.lock().unwrap().push(payload);
            }
        }
    }
}

fn parse_initial_launch(state: &PendingLaunch) {
    let args = std::env::args().collect();
    let payloads = collect_launch_payloads(args, None);
    let mut pending = state.0.lock().expect("PendingLaunch mutex poisoned");
    pending.extend(payloads);
}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON — no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("altai:settings-tab", t);
        }
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(720.0, 520.0)
        .min_inner_size(720.0, 520.0)
        .max_inner_size(720.0, 520.0)
        .resizable(false)
        // Keep settings above the main app window so it doesn't get hidden
        // when the user clicks back into the editor or terminal (#33).
        .always_on_top(true);

    // Tie lifecycle to the main window so settings minimizes/closes with it.
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag — re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }
    let _ = window;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    workspace::init_launch_cwd();
    let _ = modules::os_integration::register_context_menus();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A `--new-window` relaunch (from the Dock/Jump List/.desktop action
            // or `altai --new-window`) opens a fresh window instead of focusing
            // the existing one. Any folder/file args alongside it are still
            // honored (delivered to the primary window by handle_launch_args).
            if args.iter().any(|a| a == "--new-window") {
                os_menu::spawn_new_window(app);
                let rest: Vec<String> = args.into_iter().filter(|a| a != "--new-window").collect();
                handle_launch_args(app, rest, Some(&cwd));
                return;
            }
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_focus();
                let _ = main.unminimize();
            }
            handle_launch_args(app, args, Some(&cwd));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_process::init())
        // TODO: Re-enable updater once ALTAI has its own update endpoint
        // .plugin(tauri_plugin_updater::Builder::new().build())
        // Skip restoring VISIBLE so a previously hidden window never comes
        // back hidden — screen readers (VoiceOver/NVDA/JAWS) need the window
        // in the accessibility tree at launch.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(proc::ProcState::default())
        .manage(shell::ShellState::default())
        .manage(secrets::SecretsState::default())
        .manage(lsp_install::LspInstallState::default())
        .manage(fs::watch::WatcherState::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            registry
        })
        .manage({
            let state = PendingLaunch::default();
            parse_initial_launch(&state);
            state
        })
        .manage(os_menu::RecentFolders::default())
        .manage(mcp::McpStatusRegistry::new())
        .setup(|app| {
            altai::agent::runtime::init(app.handle().clone())?;
            // We use workspaceFallbackPath in frontend which depends on this
            workspace::grant_startup_asset_scope(app.handle());
            // Build the Dock/Jump List menu (recents fill in once the frontend
            // mirrors them via set_recent_folders).
            os_menu::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_extract_pdf,
            fs::file::fs_extract_pdf_path,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::file::fs_canonicalize,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_delete,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_glob,
            fs::watch::fs_watch_start,
            fs::watch::fs_watch_stop,
            fs::isanagentignore::fs_get_isanagentignore,
            fs::isanagentignore::fs_set_isanagentignore,
            git::commands::git_resolve_repo,
            git::commands::git_panel_snapshot,
            git::commands::git_status,
            git::commands::git_diff,
            git::commands::git_diff_content,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_commit,
            git::commands::git_clone,
            git::commands::git_fetch,
            git::commands::git_pull_ff_only,
            git::commands::git_branches,
            git::commands::git_checkout_branch,
            git::commands::git_create_branch,
            git::commands::git_push,
            git::commands::git_publish,
            git::commands::git_log,
            git::commands::git_show_commit,
            git::commands::git_commit_files,
            git::commands::git_commit_file_diff,
            git::commands::git_remote_url,
            // ALTAI — GitHub connect / identity / API proxy
            github::commands::github_device_start,
            github::commands::github_poll_token,
            github::commands::github_status,
            github::commands::github_disconnect,
            github::commands::github_api_request,
            github::commands::github_create_repo,
            shell::shell_run_command,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_bg_spawn,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_list,
            workspace::wsl_list_distros,
            workspace::wsl_default_distro,
            workspace::wsl_home,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            get_pending_launches,
            env_get_flag,
            open_with,
            open_settings_window,
            // ALTAI — OS taskbar/Dock menu: new window + recent folders
            os_menu::open_new_window,
            os_menu::set_recent_folders,
            // ALTAI — native child-webview tabs
            webview::webview_create,
            webview::webview_set_bounds,
            webview::webview_close,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            net::lm_ping,
            net::ai_http_request,
            net::ai_http_stream,
            // ALTAI — notebook execution
            notebook::notebook_execute_cell,
            // ALTAI — generic stdio process (LSP/MCP servers)
            proc::proc_spawn,
            proc::proc_stdin_write,
            proc::proc_kill,
            proc::proc_home_dir,
            proc::proc_which,
            // ALTAI — MCP server configuration and agent tool bridge
            mcp::mcp_get_servers,
            mcp::mcp_save_servers,
            mcp::mcp_probe_server,
            mcp::mcp_server_status,
            // ALTAI — managed LSP installer (Phase 1: rust-analyzer working;
            // TS/Python/Go stubbed until Phase 4 lands bundled Node + Go detect)
            lsp_install::lsp_registry_list,
            lsp_install::lsp_registry_get,
            lsp_install::lsp_install_status,
            lsp_install::lsp_install_run,
            lsp_install::lsp_install_cancel,
            lsp_install::lsp_install_uninstall,
            // ALTAI — İsanAgent commands
            agent_commands::agent_start,
            agent_commands::agent_send,
            agent_commands::agent_approve,
            agent_commands::agent_cancel,
            agent_commands::agent_list_sessions,
            agent_commands::agent_get_session_messages,
            agent_commands::agent_truncate_after_user_message,
            agent_commands::agent_list_notifications,
            agent_commands::agent_notification_mark_seen,
            agent_commands::agent_notification_resolve,
            agent_commands::agent_list_background_jobs,
            agent_commands::agent_background_job_dismiss,
            agent_commands::agent_list_clarification_tickets,
            agent_commands::agent_clarification_ticket_dismiss,
            agent_commands::agent_clarification_ticket_reply,
            agent_commands::agent_list_automations,
            agent_commands::agent_automation_create,
            agent_commands::agent_automation_remove,
            agent_commands::agent_fetch_paper,
            agent_commands::checkpoint_list,
            agent_commands::checkpoint_restore,
            agent_commands::agent_install_skill,
            agent_commands::agent_list_skills,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_collect_launch_payloads() {
        let dir = tempdir().unwrap();
        let folder_path = dir.path().join("test_folder");
        fs::create_dir(&folder_path).unwrap();
        let file_path = dir.path().join("test_file.txt");
        fs::write(&file_path, "test").unwrap();

        let args = vec![
            "altai".to_string(),
            folder_path.to_string_lossy().to_string(),
            file_path.to_string_lossy().to_string(),
        ];

        let payloads = collect_launch_payloads(args, None);
        // Canonicalization might fail in some CI environments if paths don't exist,
        // but here we created them.
        assert_eq!(payloads.len(), 2);

        let folder_payload = payloads.iter().find(|p| p.kind == "folder").unwrap();
        assert_eq!(folder_payload.paths.len(), 1);
        assert!(folder_payload.paths[0]
            .replace("\\\\", "/")
            .contains("test_folder"));

        let file_payload = payloads.iter().find(|p| p.kind == "file").unwrap();
        assert_eq!(file_payload.paths.len(), 1);
        assert!(file_payload.paths[0]
            .replace("\\\\", "/")
            .contains("test_file.txt"));
    }

    #[test]
    fn test_collect_multi_file_payloads() {
        let dir = tempdir().unwrap();
        let file1 = dir.path().join("file1.txt");
        let file2 = dir.path().join("file2.txt");
        fs::write(&file1, "1").unwrap();
        fs::write(&file2, "2").unwrap();

        let args = vec![
            "altai".to_string(),
            file1.to_string_lossy().to_string(),
            file2.to_string_lossy().to_string(),
        ];

        let payloads = collect_launch_payloads(args, None);
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].kind, "multi_file");
        assert_eq!(payloads[0].paths.len(), 2);
    }
}
