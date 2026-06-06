//! Wire types for the database module. Response structs serialize as camelCase
//! to match the frontend; the connect request deserializes the config the
//! `DatabasePane` sends.

use serde::{Deserialize, Serialize};

/// Connection request. `engine` is currently always "sqlite"; `path` is the
/// database file to open.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectConfig {
    pub engine: String,
    pub path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub conn_id: String,
    pub engine: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    pub data_type: String,
    pub pk: bool,
    pub not_null: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTable {
    pub name: String,
    /// "table" or "view".
    pub kind: String,
    pub columns: Vec<DbColumn>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSchema {
    pub tables: Vec<DbTable>,
}

/// A page of rows from a single table. Values are normalized to JSON so the
/// frontend grid renders them as text without per-engine type handling.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTablePage {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total: i64,
}

/// Result of an arbitrary SQL statement. `rows`/`columns` are populated for
/// result sets; `rows_affected` for INSERT/UPDATE/DELETE/DDL.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: u64,
    pub elapsed_ms: u64,
}
