//! SQLite operations (via `rusqlite`). All functions take a `&Connection` and
//! are called from inside `spawn_blocking` by the command layer. Identifiers
//! coming from the schema list are quoted before interpolation; row values are
//! converted to JSON with a string fallback for blobs.

use rusqlite::types::ValueRef;
use rusqlite::Connection;

use super::types::{DbColumn, DbQueryResult, DbSchema, DbTable, DbTablePage};

pub fn open_sqlite(path: &str) -> Result<Connection, String> {
    Connection::open(path).map_err(|e| format!("Failed to open database: {e}"))
}

/// Quote an identifier for SQLite (double quotes, internal quotes doubled).
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

fn value_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(n) => serde_json::Value::from(n),
        ValueRef::Real(f) => serde_json::json!(f),
        ValueRef::Text(t) => serde_json::Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => serde_json::Value::from(format!("0x{}", hex::encode(b))),
    }
}

fn row_to_json(row: &rusqlite::Row<'_>, col_count: usize) -> Result<Vec<serde_json::Value>, String> {
    let mut out = Vec::with_capacity(col_count);
    for i in 0..col_count {
        let value = row.get_ref(i).map_err(|e| e.to_string())?;
        out.push(value_to_json(value));
    }
    Ok(out)
}

pub fn schema(conn: &Connection) -> Result<DbSchema, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY type, name",
        )
        .map_err(|e| e.to_string())?;
    let listed = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut tables = Vec::with_capacity(listed.len());
    for (name, kind) in listed {
        let columns = table_columns(conn, &name)?;
        tables.push(DbTable { name, kind, columns });
    }
    Ok(DbSchema { tables })
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<DbColumn>, String> {
    // PRAGMA table_info columns: cid(0), name(1), type(2), notnull(3),
    // dflt_value(4), pk(5).
    let sql = format!("PRAGMA table_info({})", quote_ident(table));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| {
            Ok(DbColumn {
                name: row.get::<_, String>(1)?,
                data_type: row.get::<_, String>(2).unwrap_or_default(),
                not_null: row.get::<_, i64>(3).unwrap_or(0) != 0,
                pk: row.get::<_, i64>(5).unwrap_or(0) != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(columns)
}

pub fn table_page(
    conn: &Connection,
    table: &str,
    limit: i64,
    offset: i64,
) -> Result<DbTablePage, String> {
    let quoted = quote_ident(table);
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {quoted} LIMIT ?1 OFFSET ?2"))
        .map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let col_count = columns.len();

    let mut rows_out = Vec::new();
    let mut rows = stmt
        .query(rusqlite::params![limit, offset])
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        rows_out.push(row_to_json(row, col_count)?);
    }

    Ok(DbTablePage { columns, rows: rows_out, total })
}

pub fn query(conn: &Connection, sql: &str) -> Result<DbQueryResult, String> {
    let start = std::time::Instant::now();
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();

    // A zero-column statement is a non-SELECT (INSERT/UPDATE/DELETE/DDL).
    if col_count == 0 {
        let affected = stmt.execute([]).map_err(|e| e.to_string())?;
        return Ok(DbQueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: affected as u64,
            elapsed_ms: start.elapsed().as_millis() as u64,
        });
    }

    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows_out = Vec::new();
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        rows_out.push(row_to_json(row, col_count)?);
    }

    Ok(DbQueryResult {
        columns,
        rows: rows_out,
        rows_affected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, blob BLOB);
             INSERT INTO t (name, score, blob) VALUES ('a', 1.5, x'00ff'), ('b', NULL, NULL);
             CREATE VIEW v AS SELECT id, name FROM t;",
        )
        .unwrap();
        conn
    }

    #[test]
    fn schema_lists_tables_views_and_columns() {
        let conn = seeded();
        let schema = schema(&conn).unwrap();
        let names: Vec<_> = schema.tables.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"t"));
        assert!(names.contains(&"v"));

        let t = schema.tables.iter().find(|t| t.name == "t").unwrap();
        assert_eq!(t.kind, "table");
        let id = t.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id.pk);
        let name = t.columns.iter().find(|c| c.name == "name").unwrap();
        assert!(name.not_null);
    }

    #[test]
    fn table_page_returns_rows_total_and_json_values() {
        let conn = seeded();
        let page = table_page(&conn, "t", 10, 0).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.columns, vec!["id", "name", "score", "blob"]);
        assert_eq!(page.rows.len(), 2);
        // NULL score on the second row serializes as JSON null.
        assert!(page.rows[1][2].is_null());
        // Blobs render as a hex string.
        assert_eq!(page.rows[0][3], serde_json::json!("0x00ff"));
    }

    #[test]
    fn table_page_paginates() {
        let conn = seeded();
        let page = table_page(&conn, "t", 1, 1).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.rows.len(), 1);
    }

    #[test]
    fn query_select_returns_rows() {
        let conn = seeded();
        let result = query(&conn, "SELECT name FROM t WHERE id = 1").unwrap();
        assert_eq!(result.columns, vec!["name"]);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!("a"));
        assert_eq!(result.rows_affected, 0);
    }

    #[test]
    fn query_update_reports_rows_affected() {
        let conn = seeded();
        let result = query(&conn, "UPDATE t SET score = 9 WHERE id = 2").unwrap();
        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
        assert_eq!(result.rows_affected, 1);
    }

    #[test]
    fn quote_ident_escapes_quotes() {
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }
}
