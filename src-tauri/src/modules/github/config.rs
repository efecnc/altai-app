//! GitHub OAuth Device Flow + REST API configuration.
//!
//! The `client_id` identifies the ALTAI *application* (not an individual user)
//! and is public — Device Flow uses no client secret. Register a GitHub OAuth
//! App once at github.com/settings/developers with **Enable Device Flow**
//! checked, then paste its Client ID into `DEFAULT_CLIENT_ID` below (or set the
//! `ALTAI_GITHUB_CLIENT_ID` environment variable to override at runtime).

/// Sentinel for "no real client id baked in yet" — kept distinct from the real
/// id so `client_id_is_placeholder` keeps working after one is configured.
const PLACEHOLDER_CLIENT_ID: &str = "REPLACE_WITH_ALTAI_OAUTH_CLIENT_ID";

/// ALTAI's registered OAuth App client id. Public by design (Device Flow uses
/// no client secret), so it ships embedded — every user just logs in, no setup.
/// Override at runtime with the `ALTAI_GITHUB_CLIENT_ID` env var if needed.
const DEFAULT_CLIENT_ID: &str = "Ov23lil6NQ39XolAMD54";

/// Resolve the OAuth App client id, preferring the runtime env override.
pub fn client_id() -> String {
    std::env::var("ALTAI_GITHUB_CLIENT_ID")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
}

/// True while no real client id has been configured.
pub fn client_id_is_placeholder(id: &str) -> bool {
    id.is_empty() || id == PLACEHOLDER_CLIENT_ID
}

/// Scopes requested at connect time.
/// - `repo`: private repo push/pull + PR/issue access
/// - `read:org`: list org repositories
/// - `read:user`: connected account identity (login / avatar)
/// - `project`: read/write GitHub Projects v2 boards (project management tab)
pub const SCOPES: &str = "repo read:org read:user project";

pub const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
pub const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
pub const API_BASE: &str = "https://api.github.com";

/// Secret store coordinates for the per-user access token.
pub const SECRETS_SERVICE: &str = "altai-github";
pub const SECRETS_ACCOUNT: &str = "oauth-token";

/// GitHub requires a User-Agent on every API request.
pub const USER_AGENT: &str = "ALTAI";
