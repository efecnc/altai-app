//! Embedded SQLite viewer backend.
//!
//! Opens SQLite database files via `rusqlite` (sync, so its ops run inside
//! `spawn_blocking`) and exposes a small read/query surface to the frontend's
//! `DatabasePane`.
//!
//! A registry of open connections keyed by a uuid lives in Tauri managed state.
//! The frontend refers to a connection by `connId` across `db_schema`,
//! `db_table_page`, `db_query`, and `db_disconnect`. Following the `proc` module
//! shape: an `Arc<Mutex<HashMap<..>>>` guarded by a tokio mutex, values cloned
//! out (as `Arc`) before any blocking work so the map lock is never held across
//! `.await`.

pub mod commands;
mod operations;
mod types;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

/// A live database connection: a single sync `rusqlite::Connection` behind a std
/// mutex — locked only inside `spawn_blocking`, never across `.await`.
pub enum Conn {
    Sqlite(Arc<std::sync::Mutex<rusqlite::Connection>>),
}

/// Registry of open connections, keyed by the uuid handed back from `db_connect`.
#[derive(Default)]
pub struct DbState {
    inner: Mutex<HashMap<String, Arc<Conn>>>,
}

impl DbState {
    async fn insert(&self, id: String, conn: Conn) {
        self.inner.lock().await.insert(id, Arc::new(conn));
    }

    async fn get(&self, id: &str) -> Option<Arc<Conn>> {
        self.inner.lock().await.get(id).cloned()
    }

    async fn remove(&self, id: &str) -> bool {
        self.inner.lock().await.remove(id).is_some()
    }
}
