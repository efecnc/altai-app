import { cn } from "@/lib/utils";
import { MarkdownPreviewPane } from "@/modules/markdown";
import type { EditorTab, Tab } from "@/modules/tabs";
import { SourceCodeIcon, ViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";
import { ImagePreviewPane } from "./ImagePreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onDirtyChange: (id: number, dirty: boolean) => void;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onCloseTab: (id: number) => void;
};

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(path);
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function EditorStack({
  tabs,
  activeId,
  onDirtyChange,
  registerHandle,
  onCloseTab,
}: Props) {
  const editors = tabs.filter((t): t is EditorTab => t.kind === "editor");

  // Stable per-tab callbacks. Inline arrows in `ref` and `onDirtyChange`
  // change identity every render, which makes React detach+reattach the ref
  // callback and re-invoke `onDirtyChange`, triggering setState loops in
  // the parent. Memoizing per id keeps each callback's identity stable.
  const registerRef = useRef(registerHandle);
  const dirtyRef = useRef(onDirtyChange);
  const closeRef = useRef(onCloseTab);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeRef.current = onCloseTab;
  }, [onCloseTab]);

  const refCallbacks = useRef(
    new Map<number, (h: EditorPaneHandle | null) => void>(),
  );
  const dirtyCallbacks = useRef(new Map<number, (dirty: boolean) => void>());
  const closeCallbacks = useRef(new Map<number, () => void>());
  const localHandles = useRef(new Map<number, EditorPaneHandle>());

  // Markdown-preview toggle state, keyed by tab id. Held here so toggling
  // doesn't unmount the editor and lose unsaved buffer state.
  const [previewIds, setPreviewIds] = useState<Set<number>>(() => new Set());
  // Snapshot of editor buffer captured at toggle-on time so the preview
  // reflects unsaved edits.
  const [previewContent, setPreviewContent] = useState<Map<number, string>>(
    () => new Map(),
  );

  const getRefCallback = (id: number) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (h: EditorPaneHandle | null) => {
        if (h) localHandles.current.set(id, h);
        else localHandles.current.delete(id);
        registerRef.current(id, h);
      };
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getDirtyCallback = (id: number) => {
    let cb = dirtyCallbacks.current.get(id);
    if (!cb) {
      cb = (dirty: boolean) => dirtyRef.current(id, dirty);
      dirtyCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getCloseCallback = (id: number) => {
    let cb = closeCallbacks.current.get(id);
    if (!cb) {
      cb = () => closeRef.current(id);
      closeCallbacks.current.set(id, cb);
    }
    return cb;
  };

  const togglePreview = useCallback((id: number) => {
    setPreviewIds((curr) => {
      const next = new Set(curr);
      if (next.has(id)) {
        next.delete(id);
        setPreviewContent((m) => {
          if (!m.has(id)) return m;
          const nm = new Map(m);
          nm.delete(id);
          return nm;
        });
      } else {
        next.add(id);
        const handle = localHandles.current.get(id);
        const content = handle?.getContent();
        if (content !== null && content !== undefined) {
          setPreviewContent((m) => {
            const nm = new Map(m);
            nm.set(id, content);
            return nm;
          });
        }
      }
      return next;
    });
  }, []);

  // Drop callback entries for closed tabs to avoid unbounded growth.
  useEffect(() => {
    const live = new Set(editors.map((t) => t.id));
    for (const id of refCallbacks.current.keys()) {
      if (!live.has(id)) refCallbacks.current.delete(id);
    }
    for (const id of dirtyCallbacks.current.keys()) {
      if (!live.has(id)) dirtyCallbacks.current.delete(id);
    }
    for (const id of closeCallbacks.current.keys()) {
      if (!live.has(id)) closeCallbacks.current.delete(id);
    }
    for (const id of localHandles.current.keys()) {
      if (!live.has(id)) localHandles.current.delete(id);
    }
    setPreviewIds((curr) => {
      let changed = false;
      const next = new Set<number>();
      for (const id of curr) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : curr;
    });
    setPreviewContent((curr) => {
      let changed = false;
      const next = new Map<number, string>();
      for (const [id, c] of curr) {
        if (live.has(id)) next.set(id, c);
        else changed = true;
      }
      return changed ? next : curr;
    });
  }, [editors]);

  if (editors.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {editors.map((t) => {
        const visible = t.id === activeId;
        const isMd = isMarkdownPath(t.path);
        const showPreview = previewIds.has(t.id);
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <div className="relative h-full overflow-hidden rounded-md border border-border/60 bg-background">
              {isImagePath(t.path) ? (
                <ImagePreviewPane path={t.path} />
              ) : (
                <EditorPane
                  ref={getRefCallback(t.id)}
                  path={t.path}
                  onDirtyChange={getDirtyCallback(t.id)}
                  onClose={getCloseCallback(t.id)}
                />
              )}
              {isMd && showPreview && (
                <div className="absolute inset-0 bg-background">
                  <MarkdownPreviewPane
                    path={t.path}
                    visible={visible}
                    content={previewContent.get(t.id)}
                  />
                </div>
              )}
              {isMd && (
                <button
                  type="button"
                  onClick={() => togglePreview(t.id)}
                  className={cn(
                    "absolute right-2 top-2 z-10 flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2 text-[11px] font-medium text-muted-foreground backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground",
                    showPreview && "text-foreground",
                  )}
                  title={
                    showPreview ? "Show markdown source" : "Show markdown preview"
                  }
                  aria-pressed={showPreview}
                >
                  <HugeiconsIcon
                    icon={showPreview ? SourceCodeIcon : ViewIcon}
                    size={13}
                    strokeWidth={1.75}
                  />
                  <span>{showPreview ? "Source" : "Preview"}</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
