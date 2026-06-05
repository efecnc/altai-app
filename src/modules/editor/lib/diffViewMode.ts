import { useEffect, useState } from "react";

/** Inline (single editor) vs. side-by-side (two editors) diff layout. */
export type DiffViewMode = "unified" | "split";

const STORAGE_KEY = "altai.diff.viewMode";

function readInitial(): DiffViewMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "unified" || v === "split") return v;
  } catch {
    /* ignore */
  }
  return "unified";
}

let current: DiffViewMode = readInitial();
const listeners = new Set<(mode: DiffViewMode) => void>();

export function getDiffViewMode(): DiffViewMode {
  return current;
}

/** Update the global preference and notify every open diff pane live. */
export function setDiffViewMode(mode: DiffViewMode): void {
  if (mode === current) return;
  current = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l(mode);
}

/** Subscribe a component to the shared diff view mode. */
export function useDiffViewMode(): DiffViewMode {
  const [mode, setMode] = useState(current);
  useEffect(() => {
    const listener = (next: DiffViewMode) => setMode(next);
    listeners.add(listener);
    // Sync in case it changed between render and effect.
    setMode(current);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return mode;
}
