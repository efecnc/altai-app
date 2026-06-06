import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers over the backend `db_*` commands (see
 * `src-tauri/src/modules/db`). Tauri converts camelCase arg keys to the Rust
 * snake_case parameter names automatically.
 */

export interface DbColumn {
  name: string;
  dataType: string;
  pk: boolean;
  notNull: boolean;
}

export interface DbTable {
  name: string;
  kind: "table" | "view";
  columns: DbColumn[];
}

export interface DbSchema {
  tables: DbTable[];
}

/** A single cell value, normalized server-side to JSON. */
export type DbValue = string | number | boolean | null;

export interface DbTablePage {
  columns: string[];
  rows: DbValue[][];
  total: number;
}

export interface DbQueryResult {
  columns: string[];
  rows: DbValue[][];
  rowsAffected: number;
  elapsedMs: number;
}

export interface DbConnectResult {
  connId: string;
  engine: string;
}

export const db = {
  connectSqlite: (path: string) =>
    invoke<DbConnectResult>("db_connect", {
      config: { engine: "sqlite", path },
    }),
  schema: (connId: string) => invoke<DbSchema>("db_schema", { connId }),
  tablePage: (connId: string, table: string, limit: number, offset: number) =>
    invoke<DbTablePage>("db_table_page", { connId, table, limit, offset }),
  query: (connId: string, sql: string) =>
    invoke<DbQueryResult>("db_query", { connId, sql }),
  disconnect: (connId: string) => invoke<void>("db_disconnect", { connId }),
};
