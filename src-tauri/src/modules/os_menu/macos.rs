//! macOS Dock menu: the menu shown when right-clicking (or click-and-holding)
//! the app's Dock icon. Tauri exposes no API for this, so we set it directly
//! with `[NSApp setDockMenu:]` via objc2. Clicks route back into Rust through a
//! small handler object that owns the `AppHandle`.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{define_class, msg_send, sel, DefinedClass};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::{ns_string, MainThreadMarker, NSString};
use tauri::{AppHandle, Emitter, Manager};

use super::RecentFolders;

pub struct Ivars {
    app: AppHandle,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "AltaiDockHandler"]
    #[ivars = Ivars]
    struct DockHandler;

    unsafe impl NSObjectProtocol for DockHandler {}

    impl DockHandler {
        #[unsafe(method(altaiNewWindow:))]
        fn altai_new_window(&self, _sender: Option<&AnyObject>) {
            super::spawn_new_window(&self.ivars().app);
        }

        #[unsafe(method(altaiOpenRecent:))]
        fn altai_open_recent(&self, sender: Option<&NSMenuItem>) {
            let Some(sender) = sender else { return };
            let idx = sender.tag();
            if idx < 0 {
                return;
            }
            let app = &self.ivars().app;
            let path = app
                .state::<RecentFolders>()
                .0
                .lock()
                .ok()
                .and_then(|guard| guard.get(idx as usize).cloned());
            let Some(path) = path else { return };

            // Reuse the primary window (same semantics as opening a folder from
            // the CLI / file association); "New Window" is the explicit fresh
            // window. Target `main` specifically so other open windows don't
            // also switch workspace.
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_focus();
                let _ = main.unminimize();
                let _ = main.emit(
                    "altai:launch",
                    serde_json::json!({ "type": "folder", "paths": [path] }),
                );
            }
        }
    }
);

impl DockHandler {
    fn new(mtm: MainThreadMarker, app: AppHandle) -> Retained<Self> {
        let this = mtm.alloc().set_ivars(Ivars { app });
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    // One handler for the whole process. Held here so it outlives every menu we
    // build — AppKit keeps only a weak reference to a menu item's target, so a
    // dropped handler would crash on click. Confined to the main thread (the
    // only thread that ever touches AppKit here), so `Retained` need not be Send.
    static HANDLER: RefCell<Option<Retained<DockHandler>>> = const { RefCell::new(None) };
}

/// Build (or rebuild) the Dock menu. Safe to call repeatedly — `setDockMenu:`
/// replaces the menu wholesale and macOS re-reads it on each right-click.
pub fn set_dock_menu(app: &AppHandle, recents: &[String]) {
    let app = app.clone();
    let recents: Vec<String> = recents.to_vec();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };

        let handler: Retained<DockHandler> = HANDLER.with(|cell| {
            cell.borrow_mut()
                .get_or_insert_with(|| DockHandler::new(mtm, app.clone()))
                .clone()
        });
        let target: &AnyObject = &handler;

        let menu = NSMenu::new(mtm);

        let new_item = NSMenuItem::new(mtm);
        unsafe {
            new_item.setTitle(ns_string!("New Window"));
            new_item.setAction(Some(sel!(altaiNewWindow:)));
            new_item.setTarget(Some(target));
        }
        menu.addItem(&new_item);

        if !recents.is_empty() {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
            for (idx, path) in recents.iter().enumerate() {
                let name = std::path::Path::new(path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(path.as_str());
                let item = NSMenuItem::new(mtm);
                unsafe {
                    item.setTitle(&NSString::from_str(name));
                    item.setTag(idx as isize);
                    item.setAction(Some(sel!(altaiOpenRecent:)));
                    item.setTarget(Some(target));
                }
                menu.addItem(&item);
            }
        }

        // `setDockMenu:` is a real but undocumented NSApplication method, so it
        // isn't in the objc2-app-kit bindings — send it directly.
        let ns_app = NSApplication::sharedApplication(mtm);
        unsafe {
            let _: () = msg_send![&*ns_app, setDockMenu: &*menu];
        }
    });
}
