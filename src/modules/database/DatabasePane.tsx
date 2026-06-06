import { cn } from "@/lib/utils";
import {
  Database02Icon,
  GridTableIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { DataGrid } from "./DataGrid";
import {
  db,
  type DbQueryResult,
  type DbSchema,
  type DbTablePage,
} from "./lib/api";
import { QueryEditor } from "./QueryEditor";

const PAGE_SIZE = 100;

type DatabasePaneProps = {
  path: string;
};

type View = "data" | "query";

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function DatabasePane({ path }: DatabasePaneProps) {
  const [connId, setConnId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [schema, setSchema] = useState<DbSchema | null>(null);

  const [view, setView] = useState<View>("data");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [page, setPage] = useState<DbTablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [dataError, setDataError] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);

  const [sql, setSql] = useState("");
  const [queryResult, setQueryResult] = useState<DbQueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Connect + load schema on mount; disconnect on unmount. `path` is stable for
  // a pane instance (one per tab), so this runs exactly once.
  useEffect(() => {
    let cancelled = false;
    let ownedConnId: string | null = null;
    async function init() {
      try {
        const res = await db.connectSqlite(path);
        ownedConnId = res.connId;
        if (cancelled) {
          void db.disconnect(res.connId);
          return;
        }
        setConnId(res.connId);
        const sch = await db.schema(res.connId);
        if (!cancelled) {
          setSchema(sch);
          setSelectedTable(sch.tables[0]?.name ?? null);
        }
      } catch (e) {
        if (!cancelled) setFatalError(String(e));
      } finally {
        if (!cancelled) setConnecting(false);
      }
    }
    void init();
    return () => {
      cancelled = true;
      if (ownedConnId) void db.disconnect(ownedConnId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPage = useCallback(
    async (id: string, table: string, off: number) => {
      setLoadingPage(true);
      setDataError(null);
      try {
        setPage(await db.tablePage(id, table, PAGE_SIZE, off));
      } catch (e) {
        setDataError(String(e));
        setPage(null);
      } finally {
        setLoadingPage(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!connId || !selectedTable) return;
    void loadPage(connId, selectedTable, offset);
  }, [connId, selectedTable, offset, loadPage]);

  const handleSelectTable = useCallback((name: string) => {
    setView("data");
    setSelectedTable(name);
    setOffset(0);
  }, []);

  const runQuery = useCallback(async () => {
    if (!connId || !sql.trim() || running) return;
    setRunning(true);
    setQueryError(null);
    try {
      setQueryResult(await db.query(connId, sql));
    } catch (e) {
      setQueryError(String(e));
      setQueryResult(null);
    } finally {
      setRunning(false);
    }
  }, [connId, sql, running]);

  if (connecting) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Connecting…
      </div>
    );
  }

  if (fatalError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <HugeiconsIcon
          icon={Database02Icon}
          size={28}
          className="text-muted-foreground/60"
        />
        <div className="text-sm font-medium">Couldn’t open database</div>
        <div className="max-w-md break-words text-xs text-muted-foreground">
          {fatalError}
        </div>
      </div>
    );
  }

  const tables = schema?.tables ?? [];
  const title = basename(path);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <HugeiconsIcon
          icon={Database02Icon}
          size={15}
          className="text-muted-foreground"
        />
        <span className="truncate text-[13px] font-medium">{title}</span>
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
          {(["data", "query"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded px-2 py-0.5 text-xs capitalize transition-colors",
                view === v
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={view === v}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-56 min-w-44 flex-col border-r border-border/60">
          <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Tables ({tables.length})
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {tables.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No tables.
              </div>
            ) : (
              tables.map((table) => (
                <button
                  key={table.name}
                  type="button"
                  onClick={() => handleSelectTable(table.name)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent",
                    selectedTable === table.name &&
                      view === "data" &&
                      "bg-accent",
                  )}
                  title={table.name}
                >
                  <HugeiconsIcon
                    icon={GridTableIcon}
                    size={14}
                    className="flex-shrink-0 text-muted-foreground"
                  />
                  <span className="truncate">{table.name}</span>
                  {table.kind === "view" && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      view
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {view === "data" ? (
            <>
              <div className="min-h-0 flex-1">
                {dataError ? (
                  <div className="break-words p-4 text-xs text-destructive">
                    {dataError}
                  </div>
                ) : !selectedTable ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Select a table to view its rows.
                  </div>
                ) : page ? (
                  <DataGrid columns={page.columns} rows={page.rows} />
                ) : (
                  <div className="p-4 text-sm text-muted-foreground">Loading…</div>
                )}
              </div>
              {selectedTable && page && (
                <div className="flex items-center gap-3 border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
                  <span>
                    {page.total === 0
                      ? "0 rows"
                      : `${offset + 1}–${Math.min(
                          offset + PAGE_SIZE,
                          page.total,
                        )} of ${page.total}`}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      disabled={offset === 0 || loadingPage}
                      onClick={() =>
                        setOffset((o) => Math.max(0, o - PAGE_SIZE))
                      }
                      className="rounded border border-border/60 px-2 py-0.5 hover:bg-accent disabled:opacity-40"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      disabled={offset + PAGE_SIZE >= page.total || loadingPage}
                      onClick={() => setOffset((o) => o + PAGE_SIZE)}
                      className="rounded border border-border/60 px-2 py-0.5 hover:bg-accent disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
                <button
                  type="button"
                  onClick={runQuery}
                  disabled={running || !sql.trim()}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-50"
                >
                  <HugeiconsIcon icon={PlayIcon} size={13} />
                  {running ? "Running…" : "Run"}
                </button>
                <span className="text-[11px] text-muted-foreground">
                  ⌘/Ctrl+Enter
                </span>
                {queryResult && !queryError && (
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {queryResult.columns.length > 0
                      ? `${queryResult.rows.length} rows`
                      : `${queryResult.rowsAffected} affected`}{" "}
                    · {queryResult.elapsedMs} ms
                  </span>
                )}
              </div>
              <div className="h-40 min-h-[8rem] overflow-hidden border-b border-border/60">
                <QueryEditor value={sql} onChange={setSql} onRun={runQuery} />
              </div>
              <div className="min-h-0 flex-1">
                {queryError ? (
                  <div className="break-words p-4 text-xs text-destructive">
                    {queryError}
                  </div>
                ) : queryResult ? (
                  queryResult.columns.length > 0 ? (
                    <DataGrid
                      columns={queryResult.columns}
                      rows={queryResult.rows}
                    />
                  ) : (
                    <div className="p-4 text-sm text-muted-foreground">
                      {queryResult.rowsAffected} row(s) affected.
                    </div>
                  )
                ) : (
                  <div className="p-4 text-sm text-muted-foreground">
                    Run a query to see results.
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
