use serde::{Deserialize, Serialize};

// ---- Device flow ----

/// Raw response from the device-code endpoint.
#[derive(Debug, Deserialize)]
pub struct DeviceCodeRaw {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub interval: u64,
    #[serde(default)]
    pub expires_in: u64,
}

/// Device-code details handed to the frontend so it can show the user code and
/// open the verification page, then poll for the token.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

/// Raw response from the access-token (polling) endpoint. Either `access_token`
/// is present (success) or `error` describes the pending/failure state.
#[derive(Debug, Deserialize)]
pub struct AccessTokenRaw {
    pub access_token: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub interval: Option<u64>,
}

// ---- User ----

#[derive(Debug, Deserialize)]
pub struct GitHubUserRaw {
    pub login: String,
    #[serde(default)]
    pub name: Option<String>,
    pub avatar_url: String,
}

/// Connected account identity surfaced to the frontend.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitHubUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
}

// ---- Repo creation (publish) ----

#[derive(Debug, Deserialize)]
pub struct CreatedRepoRaw {
    pub full_name: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub html_url: String,
    #[serde(default)]
    pub default_branch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRepo {
    pub full_name: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub html_url: String,
    pub default_branch: String,
}
