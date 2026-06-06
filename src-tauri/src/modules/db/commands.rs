//! Tauri commands for the database module. Each connection-bound command looks
//! the connection up in `DbState`, clones the inner handle out, and runs the
//! blocking SQLite op on a `spawn_blocking` thread (the map lock is never held
//! across `.await`).

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::State;
use uuid::Uuid;

use super::types::{ConnectConfig, ConnectResult, DbQueryResult, DbSchema, DbTablePage};
use super::{operations, Conn, DbState};

/// Run a blocking SQLite op against a locked connection on a worker thread.
async fn run_sqlite<F, T>(handle: Arc<Mutex<Connection>>, f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let conn = handle
            .lock()
            .map_err(|_| "database connection lock poisoned".to_string())?;
        f(&conn)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn db_connect(
    config: ConnectConfig,
    state: State<'_, DbState>,
) -> Result<ConnectResult, String> {
    match config.engine.as_str() {
        "sqlite" => {
            let path = config
                .path
                .ok_or_else(|| "sqlite connection requires a file path".to_string())?;
            let conn = tauri::async_runtime::spawn_blocking(move || operations::open_sqlite(&path))
                .await
                .map_err(|e| e.to_string())??;
            let conn_id = Uuid::new_v4().to_string();
            state
                .insert(conn_id.clone(), Conn::Sqlite(Arc::new(Mutex::new(conn))))
                .await;
            Ok(ConnectResult { conn_id, engine: "sqlite".into() })
        }
        other => Err(format!("unsupported database engine: {other}")),
    }
}

#[tauri::command]
pub async fn db_schema(conn_id: String, state: State<'_, DbState>) -> Result<DbSchema, String> {
    let conn = state
        .get(&conn_id)
        .await
        .ok_or_else(|| "unknown database connection".to_string())?;
    match &*conn {
        Conn::Sqlite(handle) => run_sqlite(handle.clone(), operations::schema).await,
    }
}

#[tauri::command]
pub async fn db_table_page(
    conn_id: String,
    table: String,
    limit: i64,
    offset: i64,
    state: State<'_, DbState>,
) -> Result<DbTablePage, String> {
    let conn = state
        .get(&conn_id)
        .await
        .ok_or_else(|| "unknown database connection".to_string())?;
    match &*conn {
        Conn::Sqlite(handle) => {
            run_sqlite(handle.clone(), move |c| {
                operations::table_page(c, &table, limit, offset)
            })
            .await
        }
    }
}

#[tauri::command]
pub async fn db_query(
    conn_id: String,
    sql: String,
    state: State<'_, DbState>,
) -> Result<DbQueryResult, String> {
    let conn = state
        .get(&conn_id)
        .await
        .ok_or_else(|| "unknown database connection".to_string())?;
    match &*conn {
        Conn::Sqlite(handle) => {
            run_sqlite(handle.clone(), move |c| operations::query(c, &sql)).await
        }
    }
}

#[tauri::command]
pub async fn db_disconnect(conn_id: String, state: State<'_, DbState>) -> Result<(), String> {
    state.remove(&conn_id).await;
    Ok(())
}
