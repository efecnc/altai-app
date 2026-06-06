export { DatabasePane } from "./DatabasePane";

/** Matches SQLite database files that should open in the DatabasePane. */
export function isDbPath(path: string): boolean {
  return /\.(db|sqlite|sqlite3)$/i.test(path);
}
