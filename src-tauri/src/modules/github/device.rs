//! GitHub OAuth Device Flow.
//!
//! Two steps: request a device/user code, then poll the token endpoint until
//! the user authorizes (or the code expires). All HTTP goes through the
//! SSRF-safe client in [`crate::modules::net`].

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::modules::github::config;
use crate::modules::github::types::{AccessTokenRaw, DeviceCodeRaw, DeviceCodeResponse};
use crate::modules::net::safe_http_request;

const PLACEHOLDER_HELP: &str =
    "GitHub is not configured yet. Register an OAuth App at github.com/settings/developers \
     (Enable Device Flow) and set its Client ID in ALTAI.";

fn ensure_client_id() -> Result<String, String> {
    let id = config::client_id();
    if config::client_id_is_placeholder(&id) {
        return Err(PLACEHOLDER_HELP.to_string());
    }
    Ok(id)
}

/// Build a URL with properly-encoded query parameters (reqwest handles
/// escaping of spaces, colons, etc.).
fn build_url(base: &str, pairs: &[(&str, &str)]) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    {
        let mut qp = url.query_pairs_mut();
        for (k, v) in pairs {
            qp.append_pair(k, v);
        }
    }
    Ok(url.to_string())
}

fn json_headers() -> HashMap<String, String> {
    let mut h = HashMap::new();
    h.insert("accept".to_string(), "application/json".to_string());
    h.insert("user-agent".to_string(), config::USER_AGENT.to_string());
    h
}

/// Step 1 — request a device + user code.
pub async fn start() -> Result<DeviceCodeResponse, String> {
    let client_id = ensure_client_id()?;
    let url = build_url(
        config::DEVICE_CODE_URL,
        &[("client_id", &client_id), ("scope", config::SCOPES)],
    )?;
    let resp = safe_http_request(&url, "POST", Some(json_headers()), None, false).await?;
    if !(200..300).contains(&resp.status) {
        return Err(format!(
            "GitHub device-code request failed (HTTP {})",
            resp.status
        ));
    }
    let raw: DeviceCodeRaw = serde_json::from_slice(&resp.body)
        .map_err(|e| format!("unexpected GitHub response: {e}"))?;
    Ok(DeviceCodeResponse {
        interval: if raw.interval == 0 { 5 } else { raw.interval },
        expires_in: if raw.expires_in == 0 {
            900
        } else {
            raw.expires_in
        },
        device_code: raw.device_code,
        user_code: raw.user_code,
        verification_uri: raw.verification_uri,
    })
}

/// Step 2 — poll until the user authorizes. Returns the access token.
pub async fn poll(device_code: &str, interval: u64, expires_in: u64) -> Result<String, String> {
    let client_id = ensure_client_id()?;
    let url = build_url(
        config::ACCESS_TOKEN_URL,
        &[
            ("client_id", &client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )?;

    let mut wait = interval.clamp(1, 60);
    let deadline = Instant::now() + Duration::from_secs(expires_in.clamp(60, 1800));

    loop {
        if Instant::now() >= deadline {
            return Err(
                "GitHub authorization timed out — please try connecting again.".to_string(),
            );
        }
        tokio::time::sleep(Duration::from_secs(wait)).await;

        let resp = safe_http_request(&url, "POST", Some(json_headers()), None, false).await?;
        let raw: AccessTokenRaw = serde_json::from_slice(&resp.body)
            .map_err(|e| format!("unexpected GitHub response: {e}"))?;

        if let Some(token) = raw.access_token.filter(|t| !t.is_empty()) {
            return Ok(token);
        }
        match raw.error.as_deref() {
            Some("authorization_pending") => continue,
            // GitHub asks us to back off and bumps the interval.
            Some("slow_down") => {
                wait = raw.interval.unwrap_or(wait + 5).clamp(1, 60);
                continue;
            }
            Some("expired_token") => {
                return Err("The device code expired — please try connecting again.".to_string())
            }
            Some("access_denied") => return Err("GitHub authorization was cancelled.".to_string()),
            Some(other) => return Err(format!("GitHub authorization failed: {other}")),
            None => continue,
        }
    }
}
