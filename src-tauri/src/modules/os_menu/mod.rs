//! OS-level taskbar / Dock / Start-menu integration: a right-click menu on the
//! app icon offering "New Window" and the recently-opened workspace folders.
//!
//! The recents are the same list the welcome screen shows — the frontend
//! mirrors them here via the `set_recent_folders` command whenever they change.
//! There is no high-level Tauri API for any of these surfaces, so each platform
//! drops to native code (see the platform submodules):
//!
//! - macOS: a Dock menu via `[NSApp setDockMenu:]`.
//! - Windows: a taskbar Jump List via the Shell COM APIs.
//! - Linux: a static `.desktop` "New Window" action baked at bundle time; a
//!   launcher menu cannot list recent folders dynamically.

use std::sync::Mutex;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// The most-recently-opened workspace folders, newest first, mirrored from the
/// frontend store so the native menus can list them. Lives in Tauri state.
#[derive(Default)]
pub struct RecentFolders(pub Mutex<Vec<String>>);

/// Open a fresh ALTAI window. It loads the same app as the main window, but —
/// because its label isn't `main` — the frontend starts it on the welcome
/// screen instead of reopening the persisted folder, so the user can pick a
/// different workspace. Shared by every entry point: the single-instance
/// `--new-window` relaunch, the macOS Dock item, and the frontend command.
pub fn spawn_new_window(app: &AppHandle) {
    // A unique label is mandatory (Tauri rejects duplicates). The `main-`
    // prefix matches the capability glob (`main-*`) so the new window inherits
    // the same plugin permissions as the primary one.
    let label = format!("main-{}", uuid::Uuid::new_v4().simple());

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("ALTAI")
        .inner_size(800.0, 600.0)
        .min_inner_size(420.0, 280.0)
        .focused(true);

    // Mirror the chrome the app expects (see the settings window in lib.rs):
    // the overlay titlebar on macOS, our own titlebar (decorations off) on
    // Windows/Linux where `USE_CUSTOM_WINDOW_CONTROLS` is true.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    match builder.build() {
        Ok(_window) => {
            // Some GNOME/Mutter setups ignore the builder-time decorations flag
            // (same quirk the settings window works around) — re-assert it.
            #[cfg(target_os = "linux")]
            let _ = _window.set_decorations(false);
        }
        Err(e) => log::error!("os_menu: failed to open new window: {e}"),
    }
}

/// Rebuild the native menu from the current recents. No-op on Linux, whose
/// launcher actions are static and baked into the `.desktop` file at bundle time.
fn rebuild(app: &AppHandle, recents: &[String]) {
    #[cfg(target_os = "macos")]
    macos::set_dock_menu(app, recents);
    #[cfg(target_os = "windows")]
    windows::set_jump_list(app, recents);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (app, recents);
}

/// Build the menu once at startup. Recents are empty until the frontend pushes
/// them, but we still want "New Window" available immediately (macOS).
pub fn init(app: &AppHandle) {
    rebuild(app, &[]);
}

/// Mirror the frontend's recent-folders list and rebuild the native menu.
#[tauri::command]
pub fn set_recent_folders(
    app: AppHandle,
    folders: Vec<String>,
    state: tauri::State<'_, RecentFolders>,
) {
    if let Ok(mut guard) = state.0.lock() {
        *guard = folders.clone();
    }
    rebuild(&app, &folders);
}

/// Open a fresh ALTAI window (welcome screen). Callable from the frontend too.
#[tauri::command]
pub fn open_new_window(app: AppHandle) {
    spawn_new_window(&app);
}
