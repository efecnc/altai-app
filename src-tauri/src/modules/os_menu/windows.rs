//! Windows taskbar Jump List: the menu shown when right-clicking the app's
//! taskbar button or its pinned Start-menu tile. Built with the Shell COM APIs
//! (`ICustomDestinationList`); Tauri has no API for it.
//!
//! The "New Window" task relaunches the exe with `--new-window`, and each recent
//! entry relaunches it with the folder path — both land in the existing
//! single-instance handler in lib.rs, so no extra IPC is needed.

use tauri::AppHandle;

/// Rebuild the Jump List from the current recents. Runs on a dedicated STA
/// thread (the Shell list APIs are apartment-affine and we must not disturb
/// Tauri's main-thread COM apartment). Fire-and-forget.
pub fn set_jump_list(_app: &AppHandle, recents: &[String]) {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(e) => {
            log::error!("os_menu: current_exe failed: {e}");
            return;
        }
    };
    let recents: Vec<String> = recents.to_vec();
    std::thread::spawn(move || {
        if let Err(e) = build_jump_list(&exe, &recents) {
            log::error!("os_menu: failed to build jump list: {e}");
        }
    });
}

fn build_jump_list(exe: &str, recents: &[String]) -> windows::core::Result<()> {
    use windows::core::{w, Interface, GUID, HSTRING};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    // PKEY_Title (System.Title) — the property that supplies a jump-list item's
    // visible label. Defined inline to avoid pulling in the whole
    // Win32_Storage_EnhancedStorage feature just for one constant.
    const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xf29f85e0_4ff9_1068_ab91_08002b27b3d9),
        pid: 2,
    };

    unsafe {
        // Dedicated thread → safe to take an STA for ourselves.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let result = (|| -> windows::core::Result<()> {
            // One IShellLinkW == one Jump List entry. Its visible label comes
            // from the System.Title property, not the link itself.
            let make_link = |args: &str, title: &str| -> windows::core::Result<IShellLinkW> {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&HSTRING::from(exe))?;
                link.SetArguments(&HSTRING::from(args))?;
                let store: IPropertyStore = link.cast()?;
                let value = PROPVARIANT::from(title);
                store.SetValue(&PKEY_TITLE, &value)?;
                store.Commit()?;
                Ok(link)
            };

            let list: ICustomDestinationList =
                CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            // No SetAppID: we rely on the implicit (exe-path) AppUserModelID so
            // the list attaches to the taskbar button created by launching this
            // exe. We don't control the installer shortcut's explicit AppUMID,
            // and a mismatch would make the list silently never appear.

            let mut _max_slots: u32 = 0;
            let removed: IObjectArray = list.BeginList(&mut _max_slots)?;

            // Windows forbids re-adding entries the user removed from the list in
            // the same session — doing so makes AddUserTasks/AppendCategory or
            // CommitList fail and the list stops updating entirely. Collect the
            // removed entries' arguments (each is an IShellLink) and skip them.
            let mut removed_args: Vec<String> = Vec::new();
            if let Ok(count) = removed.GetCount() {
                for i in 0..count {
                    if let Ok(link) = removed.GetAt::<IShellLinkW>(i) {
                        let mut buf = [0u16; 1024];
                        if link.GetArguments(&mut buf).is_ok() {
                            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                            removed_args.push(String::from_utf16_lossy(&buf[..end]));
                        }
                    }
                }
            }

            // Tasks: "New Window".
            if !removed_args.iter().any(|a| a == "--new-window") {
                let tasks: IObjectCollection =
                    CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
                tasks.AddObject(&make_link("--new-window", "New Window")?)?;
                list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
            }

            // Custom "Recent Folders" category.
            if !recents.is_empty() {
                let col: IObjectCollection =
                    CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
                let mut added_any = false;
                for path in recents {
                    // Quote the path so spaces survive argument parsing. Per
                    // CommandLineToArgvW, a run of backslashes immediately before
                    // the closing quote escapes it (e.g. "C:\" would swallow the
                    // quote) — double any trailing run so the path stays literal.
                    let trailing = path.len() - path.trim_end_matches('\\').len();
                    let args = format!("\"{path}{}\"", "\\".repeat(trailing));
                    if removed_args.iter().any(|a| *a == args) {
                        continue;
                    }
                    let name = std::path::Path::new(path)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(path.as_str());
                    col.AddObject(&make_link(&args, name)?)?;
                    added_any = true;
                }
                if added_any {
                    list.AppendCategory(w!("Recent Folders"), &col.cast::<IObjectArray>()?)?;
                }
            }

            list.CommitList()?;
            Ok(())
        })();

        CoUninitialize();
        result
    }
}
