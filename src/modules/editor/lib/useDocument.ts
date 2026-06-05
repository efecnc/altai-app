import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

/**
 * Survives the remount that happens when an editor pane is reparented by a
 * split/layout change (#65): without it, dragging a tab to split the view —
 * which moves panes into `ResizablePanel`s — would silently discard unsaved
 * edits. Keyed by path; evicted via {@link pruneDocumentCache} when a tab is
 * actually closed (not merely remounted).
 */
const bufferCache = new Map<
  string,
  { saved: string; buffer: string; size: number }
>();

/** Drop cached buffers whose path is no longer open. */
export function pruneDocumentCache(livePaths: Set<string>): void {
  for (const p of [...bufferCache.keys()]) {
    if (!livePaths.has(p)) bufferCache.delete(p);
  }
}

export function useDocument({ path, onDirtyChange }: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  // Track the saved buffer so we can detect changes cheaply.
  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  // Load on path change or explicit reload.
  useEffect(() => {
    let cancelled = false;

    // Restore an unsaved buffer carried across a remount (e.g. split layout
    // change) instead of re-reading and clobbering the user's edits.
    const cached = bufferCache.get(path);
    if (cached) {
      savedRef.current = cached.saved;
      bufferRef.current = cached.buffer;
      setDoc({ status: "ready", content: cached.buffer, size: cached.size });
      setDirty(cached.buffer !== cached.saved);
      return () => {
        cancelled = true;
      };
    }

    setDoc({ status: "loading" });
    setDirty(false);

    invoke<ReadResult>("fs_read_file", { path, workspace: currentWorkspaceEnv() })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          savedRef.current = res.content;
          bufferRef.current = res.content;
          bufferCache.set(path, {
            saved: res.content,
            buffer: res.content,
            size: res.size,
          });
          setDoc({
            status: "ready",
            content: res.content,
            size: res.size,
          });
        } else if (res.kind === "binary") {
          setDoc({ status: "binary", size: res.size });
        } else if (res.kind === "toolarge") {
          setDoc({
            status: "toolarge",
            size: res.size,
            limit: res.limit,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setDoc({ status: "error", message: String(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [path, reloadCounter]);

  /** Re-read the file from disk. No-op (silent) if the buffer is dirty —
   *  callers shouldn't clobber unsaved user edits. Returns whether reload ran. */
  const reload = useCallback((): boolean => {
    if (dirtyRef.current) return false;
    // Discard the cached buffer so the effect re-reads from disk.
    bufferCache.delete(path);
    setReloadCounter((n) => n + 1);
    return true;
  }, [path]);

  const onChange = useCallback(
    (next: string) => {
      bufferRef.current = next;
      const cached = bufferCache.get(path);
      if (cached) cached.buffer = next;
      setDirty(next !== savedRef.current);
    },
    [path],
  );

  const save = useCallback(async () => {
    if (!dirty) return;
    const content = bufferRef.current;
    await invoke("fs_write_file", {
      path,
      content,
      workspace: currentWorkspaceEnv(),
      source: "editor",
    });
    savedRef.current = content;
    const cached = bufferCache.get(path);
    if (cached) cached.saved = content;
    setDirty(false);
  }, [path, dirty]);

  return { doc, dirty, onChange, save, reload };
}
