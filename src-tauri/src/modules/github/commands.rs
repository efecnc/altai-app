//! Tauri commands for GitHub connect / identity / API proxy.

use tauri::AppHandle;

use crate::modules::github::types::{
    CreatedRepo, CreatedRepoRaw, DeviceCodeResponse, GitHubUser, GitHubUserRaw,
};
use crate::modules::github::{api, device};
use crate::modules::net::HttpResponse;
use crate::modules::secrets::SecretsState;

async fn fetch_user(token: &str) -> Result<GitHubUser, String> {
    let resp = api::request(token, "GET", "/user", None, false).await?;
    if resp.status == 401 {
        return Err("GitHub token is invalid or has expired.".to_string());
    }
    if !(200..300).contains(&resp.status) {
        return Err(format!(
            "GitHub /user request failed (HTTP {})",
            resp.status
        ));
    }
    let raw: GitHubUserRaw = serde_json::from_slice(&resp.body)
        .map_err(|e| format!("unexpected GitHub response: {e}"))?;
    Ok(GitHubUser {
        login: raw.login,
        name: raw.name,
        avatar_url: raw.avatar_url,
    })
}

/// Step 1 of the connect flow — request a device + user code.
#[tauri::command]
pub async fn github_device_start() -> Result<DeviceCodeResponse, String> {
    device::start().await
}

/// Step 2 — poll until authorized, then persist the token and return identity.
#[tauri::command]
pub async fn github_poll_token(
    app: AppHandle,
    secrets: tauri::State<'_, SecretsState>,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<GitHubUser, String> {
    let token = device::poll(&device_code, interval, expires_in).await?;
    let user = fetch_user(&token).await?;
    api::store_token(&app, secrets.inner(), &token)?;
    Ok(user)
}

/// Identity of the connected account, or `None` if not connected (or the stored
/// token is no longer valid).
#[tauri::command]
pub async fn github_status(
    app: AppHandle,
    secrets: tauri::State<'_, SecretsState>,
) -> Result<Option<GitHubUser>, String> {
    let token = match api::get_token(&app, secrets.inner())? {
        Some(t) => t,
        None => return Ok(None),
    };
    Ok(fetch_user(&token).await.ok())
}

/// Forget the stored token.
#[tauri::command]
pub async fn github_disconnect(
    app: AppHandle,
    secrets: tauri::State<'_, SecretsState>,
) -> Result<(), String> {
    api::clear_token(&app, secrets.inner())
}

/// Authenticated GitHub API proxy. `path` must begin with `/` and is appended
/// to `https://api.github.com`. Returns the raw response (status/headers/body)
/// so the frontend can parse JSON and read pagination headers.
#[tauri::command]
pub async fn github_api_request(
    app: AppHandle,
    secrets: tauri::State<'_, SecretsState>,
    method: String,
    path: String,
    body: Option<Vec<u8>>,
) -> Result<HttpResponse, String> {
    let token = api::get_token(&app, secrets.inner())?
        .ok_or_else(|| "Not connected to GitHub.".to_string())?;
    api::request(&token, &method, &path, body, true).await
}

/// Create a new repository under the connected user (or an org). Returns the
/// clone URLs needed to wire up `origin` and push.
#[tauri::command]
pub async fn github_create_repo(
    app: AppHandle,
    secrets: tauri::State<'_, SecretsState>,
    name: String,
    private: bool,
    org: Option<String>,
    description: Option<String>,
) -> Result<CreatedRepo, String> {
    let token = api::get_token(&app, secrets.inner())?
        .ok_or_else(|| "Not connected to GitHub.".to_string())?;
    let path = match org.as_deref() {
        Some(o) if !o.is_empty() => format!("/orgs/{o}/repos"),
        _ => "/user/repos".to_string(),
    };
    let payload = serde_json::json!({
        "name": name,
        "private": private,
        "description": description.unwrap_or_default(),
    });
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    let resp = api::request(&token, "POST", &path, Some(bytes), true).await?;
    if resp.status == 422 {
        return Err("A repository with that name already exists on GitHub.".to_string());
    }
    if !(200..300).contains(&resp.status) {
        return Err(format!(
            "Failed to create GitHub repository (HTTP {})",
            resp.status
        ));
    }
    let raw: CreatedRepoRaw = serde_json::from_slice(&resp.body)
        .map_err(|e| format!("unexpected GitHub response: {e}"))?;
    Ok(CreatedRepo {
        full_name: raw.full_name,
        clone_url: raw.clone_url,
        ssh_url: raw.ssh_url,
        html_url: raw.html_url,
        default_branch: raw.default_branch,
    })
}
