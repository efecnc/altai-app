//! Authenticated GitHub REST API access + token storage.
//!
//! The access token lives only in the OS secret store and is read on the Rust
//! side for each request — it is never sent to the webview.

use std::collections::HashMap;

use tauri::AppHandle;

use crate::modules::github::config;
use crate::modules::net::{safe_http_request, HttpResponse};
use crate::modules::secrets::{self, SecretsState};

pub fn get_token(app: &AppHandle, secrets: &SecretsState) -> Result<Option<String>, String> {
    secrets::get_secret(
        app,
        secrets,
        config::SECRETS_SERVICE,
        config::SECRETS_ACCOUNT,
    )
}

pub fn store_token(app: &AppHandle, secrets: &SecretsState, token: &str) -> Result<(), String> {
    secrets::set_secret(
        app,
        secrets,
        config::SECRETS_SERVICE,
        config::SECRETS_ACCOUNT,
        token,
    )
}

pub fn clear_token(app: &AppHandle, secrets: &SecretsState) -> Result<(), String> {
    secrets::delete_secret(
        app,
        secrets,
        config::SECRETS_SERVICE,
        config::SECRETS_ACCOUNT,
    )
}

fn auth_headers(token: &str) -> HashMap<String, String> {
    let mut h = HashMap::new();
    h.insert("authorization".to_string(), format!("Bearer {token}"));
    h.insert(
        "accept".to_string(),
        "application/vnd.github+json".to_string(),
    );
    h.insert("x-github-api-version".to_string(), "2022-11-28".to_string());
    h.insert("user-agent".to_string(), config::USER_AGENT.to_string());
    h
}

/// Authenticated request against `https://api.github.com`. `path` must begin
/// with `/` — full URLs are rejected so the token can never be sent to an
/// arbitrary host.
pub async fn request(
    token: &str,
    method: &str,
    path: &str,
    body: Option<Vec<u8>>,
    json_body: bool,
) -> Result<HttpResponse, String> {
    if !path.starts_with('/') {
        return Err("GitHub API path must start with '/'".to_string());
    }
    let url = format!("{}{}", config::API_BASE, path);
    let mut headers = auth_headers(token);
    if json_body && body.is_some() {
        headers.insert("content-type".to_string(), "application/json".to_string());
    }
    safe_http_request(&url, method, Some(headers), body, false).await
}
