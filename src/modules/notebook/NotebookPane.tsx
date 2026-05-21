import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parse, serialize, updateCellSource, updateCellOutputs, insertCell, removeCell, moveCell, emptyCodeCell, emptyMarkdownCell } from "./lib/ipynbParser";
import type { Notebook, CellOutput } from "./lib/ipynbParser";
import { NotebookCell } from "./NotebookCell";
import { useNotebookStore } from "./store/notebookStore";

type ReadResult = { content: string; binary: boolean; truncated: boolean; size: number };

type NotebookPaneProps = {
  path: string;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
};

export function NotebookPane({ path, active, onDirtyChange }: NotebookPaneProps) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [dirty, setDirty] = useState(false);

  const executingCells = useNotebookStore((s) => s.executingCells);

  // Load the notebook file.
  useEffect(() => {
    let alive = true;
    setState("loading");

    invoke<ReadResult>("fs_read_file", { path })
      .then((result) => {
        if (!alive) return;
        if (result.binary) {
          setError("Binary file — not a valid notebook.");
          setState("error");
          return;
        }
        try {
          const nb = parse(result.content);
          setNotebook(nb);
          useNotebookStore.getState().setNotebook(path, nb);
          setState("ready");
        } catch (e) {
          setError(`Failed to parse notebook: ${e}`);
          setState("error");
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setState("error");
      });

    return () => {
      alive = false;
    };
  }, [path]);

  const markDirty = useCallback(() => {
    if (!dirty) {
      setDirty(true);
      onDirtyChange(true);
    }
  }, [dirty, onDirtyChange]);

  const handleSourceChange = useCallback(
    (index: number, source: string) => {
      setNotebook((nb) => {
        if (!nb) return nb;
        const updated = updateCellSource(nb, index, source);
        useNotebookStore.getState().setNotebook(path, updated);
        return updated;
      });
      markDirty();
    },
    [path, markDirty],
  );

  const handleExecute = useCallback(
    async (index: number) => {
      if (!notebook) return;
      const cell = notebook.cells[index];
      if (!cell || cell.cellType !== "code") return;

      const store = useNotebookStore.getState();
      store.setCellExecuting(path, index, true);

      // Derive cwd from notebook file path.
      const lastSlash = path.lastIndexOf("/");
      const cwd = lastSlash > 0 ? path.substring(0, lastSlash) : undefined;

      try {
        const result = await invoke<{
          stdout: string;
          stderr: string;
          exit_code: number | null;
          timed_out: boolean;
        }>("notebook_execute_cell", { source: cell.source, cwd });

        // Map subprocess result to Jupyter-style CellOutput objects.
        const outputs: CellOutput[] = [];

        if (result.timed_out) {
          outputs.push({
            outputType: "error",
            ename: "TimeoutError",
            evalue: "Cell execution timed out (30s limit)",
            traceback: result.stderr ? [result.stderr] : [],
          });
        } else if (result.exit_code !== 0 && result.exit_code !== null) {
          if (result.stdout) {
            outputs.push({
              outputType: "stream",
              name: "stdout",
              text: [result.stdout],
            });
          }
          outputs.push({
            outputType: "error",
            ename: "ProcessError",
            evalue: `exit code ${result.exit_code}`,
            traceback: result.stderr ? [result.stderr] : [],
          });
        } else {
          if (result.stdout) {
            outputs.push({
              outputType: "stream",
              name: "stdout",
              text: [result.stdout],
            });
          }
          if (result.stderr) {
            outputs.push({
              outputType: "stream",
              name: "stderr",
              text: [result.stderr],
            });
          }
        }

        // Update notebook with execution outputs.
        setNotebook((nb) => {
          if (!nb) return nb;
          const updated = updateCellOutputs(nb, index, outputs);
          useNotebookStore.getState().setNotebook(path, updated);
          return updated;
        });
        markDirty();
      } catch (e) {
        // Tauri invoke error (e.g. python not found).
        setNotebook((nb) => {
          if (!nb) return nb;
          const outputs: CellOutput[] = [{
            outputType: "error",
            ename: "ExecutionError",
            evalue: String(e),
            traceback: [],
          }];
          const updated = updateCellOutputs(nb, index, outputs);
          useNotebookStore.getState().setNotebook(path, updated);
          return updated;
        });
      } finally {
        useNotebookStore.getState().setCellExecuting(path, index, false);
      }
    },
    [notebook, path, markDirty],
  );

  const handleDelete = useCallback(
    (index: number) => {
      setNotebook((nb) => {
        if (!nb || nb.cells.length <= 1) return nb;
        const updated = removeCell(nb, index);
        useNotebookStore.getState().setNotebook(path, updated);
        return updated;
      });
      markDirty();
    },
    [path, markDirty],
  );

  const handleMoveUp = useCallback(
    (index: number) => {
      if (index <= 0) return;
      setNotebook((nb) => {
        if (!nb) return nb;
        const updated = moveCell(nb, index, index - 1);
        useNotebookStore.getState().setNotebook(path, updated);
        return updated;
      });
      markDirty();
    },
    [path, markDirty],
  );

  const handleMoveDown = useCallback(
    (index: number) => {
      setNotebook((nb) => {
        if (!nb || index >= nb.cells.length - 1) return nb;
        const updated = moveCell(nb, index, index + 1);
        useNotebookStore.getState().setNotebook(path, updated);
        return updated;
      });
      markDirty();
    },
    [path, markDirty],
  );

  const handleToggleType = useCallback(
    (index: number) => {
      setNotebook((nb) => {
        if (!nb) return nb;
        const cell = nb.cells[index];
        if (!cell) return nb;
        const newType = cell.cellType === "code" ? "markdown" : "code";
        const updated = {
          ...nb,
          cells: nb.cells.map((c, i) =>
            i === index ? { ...c, cellType: newType as "code" | "markdown", outputs: [] } : c,
          ),
        } as Notebook;
        useNotebookStore.getState().setNotebook(path, updated);
        return updated;
      });
      markDirty();
    },
    [path, markDirty],
  );

  const handleAddCell = useCallback(
    (type: "code" | "markdown") => {
      setNotebook((nb) => {
        if (!nb) return nb;
        const cell = type === "code" ? emptyCodeCell() : emptyMarkdownCell();
        const updated = insertCell(nb, nb.cells.length, cell);
        useNotebookStore.getState().setNotebook(path, updated);
        return updated;
      });
      markDirty();
    },
    [path, markDirty],
  );

  const handleSave = useCallback(async () => {
    if (!notebook) return;
    const content = serialize(notebook);
    try {
      await invoke("fs_write_file", { path, content });
      setDirty(false);
      onDirtyChange(false);
    } catch (e) {
      console.error("Failed to save notebook:", e);
    }
  }, [notebook, path, onDirtyChange]);

  // Ctrl+S to save.
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, handleSave]);

  if (state === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading notebook...
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm">
        {error}
      </div>
    );
  }

  if (!notebook) return null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl py-4 space-y-2">
        {/* Kernel info */}
        <div className="flex items-center gap-2 px-3 pb-2 text-xs text-muted-foreground">
          <span>
            {notebook.metadata.kernelspec?.display_name ?? "No kernel"}
          </span>
          {dirty && (
            <span className="text-yellow-500 font-medium">modified</span>
          )}
        </div>

        {/* Cells */}
        {notebook.cells.map((cell, i) => (
          <NotebookCell
            key={i}
            cell={cell}
            index={i}
            isExecuting={executingCells.has(`${path}:${i}`)}
            onSourceChange={handleSourceChange}
            onExecute={handleExecute}
            onDelete={handleDelete}
            onMoveUp={handleMoveUp}
            onMoveDown={handleMoveDown}
            onToggleType={handleToggleType}
            isFirst={i === 0}
            isLast={i === notebook.cells.length - 1}
          />
        ))}

        {/* Add cell buttons */}
        <div className="flex gap-2 px-14 pt-2">
          <button
            type="button"
            className="rounded border border-dashed border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
            onClick={() => handleAddCell("code")}
          >
            + Code
          </button>
          <button
            type="button"
            className="rounded border border-dashed border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
            onClick={() => handleAddCell("markdown")}
          >
            + Markdown
          </button>
        </div>
      </div>
    </div>
  );
}
