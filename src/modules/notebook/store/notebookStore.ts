import { create } from "zustand";
import type { Notebook, CellOutput } from "../lib/ipynbParser";
import { updateCellOutputs } from "../lib/ipynbParser";

export type KernelStatus = "idle" | "busy" | "disconnected";

export type NotebookState = {
  /** Parsed notebooks keyed by file path. */
  notebooks: Record<string, Notebook>;
  /** Per-cell execution status. Key: `${path}:${cellIndex}` */
  executingCells: Set<string>;
  /** Kernel connection status. */
  kernelStatus: KernelStatus;

  setNotebook: (path: string, notebook: Notebook) => void;
  removeNotebook: (path: string) => void;
  updateNotebook: (path: string, updater: (nb: Notebook) => Notebook) => void;

  setCellExecuting: (path: string, cellIndex: number, executing: boolean) => void;
  appendCellOutput: (path: string, cellIndex: number, output: CellOutput) => void;
  setKernelStatus: (status: KernelStatus) => void;
};

export const useNotebookStore = create<NotebookState>((set) => ({
  notebooks: {},
  executingCells: new Set(),
  kernelStatus: "disconnected",

  setNotebook: (path, notebook) =>
    set((s) => ({ notebooks: { ...s.notebooks, [path]: notebook } })),

  removeNotebook: (path) =>
    set((s) => {
      const { [path]: _, ...rest } = s.notebooks;
      return { notebooks: rest };
    }),

  updateNotebook: (path, updater) =>
    set((s) => {
      const nb = s.notebooks[path];
      if (!nb) return s;
      return { notebooks: { ...s.notebooks, [path]: updater(nb) } };
    }),

  setCellExecuting: (path, cellIndex, executing) =>
    set((s) => {
      const key = `${path}:${cellIndex}`;
      const next = new Set(s.executingCells);
      if (executing) next.add(key);
      else next.delete(key);
      return { executingCells: next };
    }),

  appendCellOutput: (path, cellIndex, output) =>
    set((s) => {
      const nb = s.notebooks[path];
      if (!nb) return s;
      const cell = nb.cells[cellIndex];
      if (!cell) return s;
      const updated = updateCellOutputs(nb, cellIndex, [...cell.outputs, output]);
      return { notebooks: { ...s.notebooks, [path]: updated } };
    }),

  setKernelStatus: (status) => set({ kernelStatus: status }),
}));
