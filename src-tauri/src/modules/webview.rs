// Native child-webview tabs. Lets the frontend host external sites (e.g.
// Colab) inside the main window as if they were tabs, side-stepping the
// X-Frame-Options block that prevents iframe embedding.
//
// Lifecycle is owned by the frontend slot component (mount → create,
// unmount → close, layout change → set_bounds). Off-screen positioning
// is used to "hide" a webview while keeping its DOM/JS state alive, since
// native child webviews always render above HTML and ignore CSS.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

fn validate_label(label: &str) -> Result<(), String> {
    if label.is_empty() || label.len() > 128 {
        return Err("invalid label length".into());
    }
    if !label
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid label characters".into());
    }
    // Block reserved labels so the frontend can't hijack the main/settings
    // webviews via set_bounds or close.
    if label == "main" || label == "settings" || label.starts_with("ext-") {
        return Err("reserved label".into());
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("unsupported URL scheme: {scheme}"));
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn webview_create(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_label(&label)?;
    let parsed = validate_url(&url)?;

    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }

    let main_window = app.get_webview_window("main").ok_or("main window not found")?;
    let scale_factor = main_window.scale_factor().map_err(|e| e.to_string())?;
    let main_pos = main_window
        .inner_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale_factor);

    // SECURITY: this window loads EXTERNAL, untrusted content. `withGlobalTauri`
    // (tauri.conf.json) injects `window.__TAURI__` into every webview, this one
    // included, so its label (`wv-*`) must NEVER be added to a capability
    // `windows` list. The ACL (capabilities/*.json, scoped to "main"/"settings")
    // is what stops a remote page from invoking Tauri commands — keep it strict.
    WebviewWindowBuilder::new(&app, label.as_str(), WebviewUrl::External(parsed))
        .position(main_pos.x + x, main_pos.y + y)
        .inner_size(width.max(1.0), height.max(1.0))
        .decorations(false)
        .parent(&main_window)
        .map_err(|e| e.to_string())?
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn webview_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_label(&label)?;
    // The frontend can race ahead of close — silently no-op if the webview
    // is already gone rather than surfacing a noisy error.
    let Some(webview) = app.get_webview_window(&label) else {
        return Ok(());
    };
    
    let main_window = app.get_webview_window("main").ok_or("main window not found")?;
    let scale_factor = main_window.scale_factor().map_err(|e| e.to_string())?;
    let main_pos = main_window
        .inner_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale_factor);

    webview
        .set_position(LogicalPosition::new(main_pos.x + x, main_pos.y + y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn webview_close(app: AppHandle, label: String) -> Result<(), String> {
    validate_label(&label)?;
    if let Some(webview) = app.get_webview_window(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
