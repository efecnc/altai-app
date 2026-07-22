use std::error::Error;

/// Register OS-level right-click ("Open with") entries for ALTAI.
///
/// Each platform takes a different, idiomatic route so that "Open with ALTAI"
/// appears in the host file manager's context menu for files, folders, and the
/// folder background:
///
/// - **Windows**: writes `HKCU\Software\Classes\*\shell\AltaiApp` (and folder /
///   background variants) so Explorer shows the entries. Also adds the
///   "Explain / Refactor / Ask About Project" AI verbs.
/// - **macOS**: declares `public.item` (every file) and `public.folder` as
///   `CFBundleDocumentTypes` in the app bundle's `Info.plist`, then refreshes
///   Launch Services with `lsregister` so Finder lists ALTAI under "Open With".
/// - **Linux**: writes a user-level `.desktop` entry with a broad `MimeType`
///   list (including `inode/directory`) under `~/.local/share/applications/`
///   and runs `update-desktop-database`, so GNOME/KDE/Nautilus/etc. show
///   "Open With ALTAI".
///
/// Everything is best-effort: registration failures must never block app
/// startup, so callers ignore the returned `Result` (`let _ = ...`).
pub fn register_context_menus() -> Result<(), Box<dyn Error>> {
    #[cfg(target_os = "windows")]
    {
        register_windows()?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = register_macos();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = register_linux();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        log::debug!("os_integration: context menu registration not supported on this OS");
    }
    Ok(())
}

// ───────────────────────── Windows ─────────────────────────

#[cfg(target_os = "windows")]
fn register_windows() -> Result<(), Box<dyn Error>> {
    use windows_registry::CURRENT_USER;

    let exe_path = std::env::current_exe()?;
    let exe_path_str = exe_path.to_string_lossy();
    // Use double quotes for the path to handle spaces.
    // %1 is the placeholder for the file/folder path.
    let command = format!("\"{}\" \"%1\"", exe_path_str);
    let command_here = format!("\"{}\" \".\"", exe_path_str);

    // File Context Menu: Right-click on any file.
    let file_key = CURRENT_USER.create("Software\\Classes\\*\\shell\\AltaiApp")?;
    file_key.set_string("", "Open with Altai App")?;
    file_key.set_string("Icon", &exe_path_str)?;
    let file_command_key = file_key.create("command")?;
    file_command_key.set_string("", &command)?;

    // Folder Context Menu: Right-click on a folder.
    let folder_key = CURRENT_USER.create("Software\\Classes\\Directory\\shell\\AltaiApp")?;
    folder_key.set_string("", "Open Folder with Altai App")?;
    folder_key.set_string("Icon", &exe_path_str)?;
    let folder_command_key = folder_key.create("command")?;
    folder_command_key.set_string("", &command)?;

    // Background Context Menu: Right-click inside a folder.
    let bg_key =
        CURRENT_USER.create("Software\\Classes\\Directory\\Background\\shell\\AltaiApp")?;
    bg_key.set_string("", "Open Altai App Here")?;
    bg_key.set_string("Icon", &exe_path_str)?;
    let bg_command_key = bg_key.create("command")?;
    bg_command_key.set_string("", &command_here)?;

    // AI Context Menus for Files
    let explain_key = CURRENT_USER.create("Software\\Classes\\*\\shell\\AltaiAppExplain")?;
    explain_key.set_string("", "Explain with Altai App")?;
    explain_key.set_string("Icon", &exe_path_str)?;
    let explain_command_key = explain_key.create("command")?;
    explain_command_key.set_string("", format!("\"{}\" --explain \"%1\"", exe_path_str))?;

    let refactor_key = CURRENT_USER.create("Software\\Classes\\*\\shell\\AltaiAppRefactor")?;
    refactor_key.set_string("", "Refactor with Altai App")?;
    refactor_key.set_string("Icon", &exe_path_str)?;
    let refactor_command_key = refactor_key.create("command")?;
    refactor_command_key.set_string("", format!("\"{}\" --refactor \"%1\"", exe_path_str))?;

    // Folder Context Menu: Ask About Project
    let project_key =
        CURRENT_USER.create("Software\\Classes\\Directory\\shell\\AltaiAppProject")?;
    project_key.set_string("", "Ask Altai App About This Project")?;
    project_key.set_string("Icon", &exe_path_str)?;
    let project_command_key = project_key.create("command")?;
    project_command_key.set_string("", format!("\"{}\" --ask-project \"%1\"", exe_path_str))?;

    Ok(())
}

// ───────────────────────── macOS ─────────────────────────

#[cfg(target_os = "macos")]
fn register_macos() -> Result<(), Box<dyn Error>> {
    use std::process::Command;

    // current_exe() inside a .app bundle is `<bundle>.app/Contents/MacOS/<bin>`.
    // Walk up to find the enclosing `.app` directory.
    let exe = std::env::current_exe()?;
    let app_bundle = exe
        .ancestors()
        .find(|p| p.extension().and_then(|s| s.to_str()) == Some("app"))
        .map(|p| p.to_path_buf())
        .ok_or("not running inside a .app bundle")?;

    let info_plist = app_bundle.join("Contents").join("Info.plist");

    ensure_document_types(&info_plist)?;

    // Refresh Launch Services so Finder picks up the new "Open With" entries.
    // `-f` forces a fresh registration of the bundle from its (now patched)
    // Info.plist. The path to lsregister is stable across macOS versions.
    let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    let _ = Command::new(lsregister).arg("-f").arg(&app_bundle).status();

    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_document_types(info_plist: &std::path::Path) -> Result<(), Box<dyn Error>> {
    let mut value: plist::Value = plist::from_file(info_plist)?;
    let dict = value
        .as_dictionary_mut()
        .ok_or("Info.plist root is not a dictionary")?;

    // Make sure CFBundleDocumentTypes exists and is an array.
    if dict
        .get("CFBundleDocumentTypes")
        .is_none_or(|v| v.as_array().is_none())
    {
        dict.insert(
            "CFBundleDocumentTypes".to_string(),
            plist::Value::Array(vec![]),
        );
    }
    let arr = dict
        .get_mut("CFBundleDocumentTypes")
        .and_then(|v| v.as_array_mut())
        .ok_or("CFBundleDocumentTypes is not an array")?;

    // Track which UTIs are already claimed so we don't duplicate or rewrite
    // entries (and so we skip writing/lsregister entirely when nothing changed).
    let claimed_files = arr
        .iter()
        .any(|entry| uti_list_includes(entry, "public.item"));
    let claimed_folders = arr
        .iter()
        .any(|entry| uti_list_includes(entry, "public.folder"));

    if claimed_files && claimed_folders {
        return Ok(());
    }

    // `public.item` is the abstract base UTI every file conforms to, so an
    // `Alternate`-ranked Viewer entry here makes ALTAI show up under
    // "Open With" for any file without stealing any app's default.
    if !claimed_files {
        arr.push(make_document_type("All Files", &["public.item"], "Viewer"));
    }
    if !claimed_folders {
        arr.push(make_document_type("Folders", &["public.folder"], "Viewer"));
    }

    value.to_file_xml(info_plist)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn uti_list_includes(entry: &plist::Value, uti: &str) -> bool {
    let arr = match entry
        .as_dictionary()
        .and_then(|d| d.get("LSItemContentTypes"))
        .and_then(|v| v.as_array())
    {
        Some(a) => a,
        None => return false,
    };
    arr.iter().any(|v| v.as_string() == Some(uti))
}

#[cfg(target_os = "macos")]
fn make_document_type(name: &str, utis: &[&str], role: &str) -> plist::Value {
    let mut d = plist::Dictionary::new();
    d.insert(
        "CFBundleTypeName".to_string(),
        plist::Value::String(name.to_string()),
    );
    d.insert(
        "CFBundleTypeRole".to_string(),
        plist::Value::String(role.to_string()),
    );
    d.insert(
        "LSHandlerRank".to_string(),
        plist::Value::String("Alternate".to_string()),
    );
    d.insert(
        "LSItemContentTypes".to_string(),
        plist::Value::Array(
            utis.iter()
                .map(|u| plist::Value::String((*u).to_string()))
                .collect(),
        ),
    );
    plist::Value::Dictionary(d)
}

// ───────────────────────── Linux ─────────────────────────

#[cfg(target_os = "linux")]
fn register_linux() -> Result<(), Box<dyn Error>> {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    // ~/.local/share/applications is the user-level XDG dir that file
    // managers consult for "Open With". It takes precedence over any
    // system-wide entry of the same desktop-file id, so a broad `MimeType`
    // list here wins without creating a duplicate launcher entry.
    let dir: PathBuf = dirs::data_dir()
        .map(|d| d.join("applications"))
        .ok_or("could not resolve XDG data dir")?;
    fs::create_dir_all(&dir)?;

    let exe = std::env::current_exe()?;
    let exe_str = exe.to_string_lossy();
    let icon = resolve_linux_icon(&exe);

    // Broad MIME coverage so ALTAI appears in "Open With" for folders and the
    // vast majority of files. `inode/directory` is what makes folder
    // right-clicks work; `application/octet-stream` covers unrecognized files.
    let mime_types = [
        "inode/directory",
        "application/octet-stream",
        "text/plain",
        "text/markdown",
        "text/html",
        "text/css",
        "text/csv",
        "text/x-makefile",
        "text/x-c",
        "text/x-c++",
        "text/x-csrc",
        "text/x-chdr",
        "text/x-c++src",
        "text/x-c++hdr",
        "text/x-java",
        "text/x-python",
        "text/x-go",
        "text/x-rust",
        "text/x-php",
        "text/x-shellscript",
        "application/json",
        "application/xml",
        "application/javascript",
        "application/x-yaml",
        "application/x-toml",
        "application/x-sh",
        "application/x-shellscript",
        "application/x-perl",
        "application/x-php",
        "application/x-executable",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/svg+xml",
        "image/webp",
        "image/bmp",
        "application/pdf",
        "application/zip",
        "application/gzip",
        "application/x-tar",
        "application/x-bzip2",
    ]
    .join(";")
        + ";";

    // The desktop-file id mirrors the one Tauri's bundler emits for the main
    // binary (`altai`), so this overrides (rather than duplicates) the
    // system entry while contributing the broader MimeType list.
    let content = format!(
        "[Desktop Entry]\n\
Type=Application\n\
Version=1.0\n\
Name=ALTAI\n\
GenericName=Agentic Development Environment\n\
Comment=Open Agentic Development Environment\n\
Exec=\"{exe}\" %U\n\
Icon={icon}\n\
Terminal=false\n\
Categories=Development;IDE;Utility;\n\
StartupWMClass=altai\n\
Actions=NewWindow;\n\
MimeType={mime};\n\
\n\
[Desktop Action NewWindow]\n\
Name=New Window\n\
Exec=\"{exe}\" --new-window\n",
        exe = exe_str,
        icon = icon,
        mime = mime_types,
    );

    let desktop_path = dir.join("altai.desktop");

    // Only touch the filesystem when the content actually changes, so we don't
    // churn mtime / re-trigger desktop-db rebuilds on every launch.
    let prev = fs::read_to_string(&desktop_path).unwrap_or_default();
    if prev != content {
        fs::write(&desktop_path, content)?;
    }

    // Best-effort refresh; these tools may be absent on minimal installs.
    let _ = Command::new("update-desktop-database").arg(&dir).status();
    let _ = Command::new("update-mime-database").arg("-V").status();

    Ok(())
}

/// Pick the best icon reference for the generated `.desktop` entry.
///
/// Installed (deb/rpm) builds drop a themed icon at `hicolor/.../apps/altai.png`
/// and use `Icon=altai`; portable/AppImage builds lack that, so we fall back to
/// an icon file located next to the binary, then to the bare theme name.
#[cfg(target_os = "linux")]
fn resolve_linux_icon(exe: &std::path::Path) -> String {
    let candidates = [
        "../../share/icons/hicolor/256x256/apps/altai.png",
        "../../share/icons/hicolor/128x128/apps/altai.png",
        "../../share/pixmaps/altai.png",
        "../share/icons/hicolor/256x256/apps/altai.png",
    ];
    for rel in candidates {
        if let Ok(p) = exe.join(rel).canonicalize() {
            if p.is_file() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    // Theme name: resolves when the app has been installed system-wide.
    "altai".to_string()
}
