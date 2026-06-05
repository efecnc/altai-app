mod modules;
mod altai;

use modules::{
    fs, git, github, lsp_install, net, notebook, proc, pty, secrets, shell, webview, workspace,
};
use altai::agent::commands as agent_commands;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().expect("LaunchDir mutex poisoned").take()
}

fn parse_launch_dir() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let Ok(canon) = std::fs::canonicalize(&arg) else { continue };
        if !canon.is_dir() {
            continue;
        }
        let s = canon.to_string_lossy();
        return Some(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
    }
    None
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

    tauri::Builder::default()
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
        .manage(LaunchDir(Mutex::new(parse_launch_dir())))
        .setup(|app| {
            altai::agent::runtime::init(app.handle().clone())?;
            workspace::grant_startup_asset_scope(app.handle());
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
            get_launch_dir,
            open_settings_window,
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
            agent_commands::agent_fetch_paper,
            agent_commands::checkpoint_list,
            agent_commands::checkpoint_restore,
            agent_commands::agent_install_skill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
