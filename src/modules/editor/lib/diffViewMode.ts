import { useSyncExternalStore } from "react";

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
const listeners = new Set<() => void>();

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
  for (const l of listeners) l();
}

// Cross-window sync: the `storage` event fires only in *other* windows (e.g. a
// separate Settings window), so mirror an external change into our in-memory
// state and notify local subscribers.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = e.newValue;
    if ((next === "unified" || next === "split") && next !== current) {
      current = next;
      for (const l of listeners) l();
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a component to the shared diff view mode. */
export function useDiffViewMode(): DiffViewMode {
  return useSyncExternalStore(subscribe, getDiffViewMode);
}
