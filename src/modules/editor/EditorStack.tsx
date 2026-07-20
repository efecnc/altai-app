import { cn } from "@/lib/utils";
import { MarkdownPreviewPane } from "@/modules/markdown";
import type { EditorTab, Tab } from "@/modules/tabs";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { PlayIcon, SourceCodeIcon, ViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";
import { ImagePreviewPane } from "./ImagePreviewPane";
import { dirnameForPath, runCommandForPath } from "./lib/runFile";
import { runInTerminal } from "@/modules/terminal/runInTerminal";
import { pruneDocumentCache } from "./lib/useDocument";
import {
  allLeaves,
  emptyLeaf,
  leafContainingTab,
  reconcile,
  setActiveTab,
  splitLeafWithTab,
  type EditorGroupNode,
  type SplitEdge,
} from "./lib/editorGroups";

const DRAG_MIME = "application/altai-tab";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Git repo root for minimap git-diff markers (#82). */
  repoRoot?: string | null;
  onSelect: (id: number) => void;
  onDirtyChange: (id: number, dirty: boolean) => void;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onCloseTab: (id: number) => void;
  /**
   * Bumped `n` by the header Split button to split the active editor group
   * along `dir` (moves the active tab into a new group beside the current).
   */
  splitSignal?: { dir: "row" | "col"; n: number } | null;
  /** Reports whether the active editor group can be split (its leaf has 2+ tabs). */
  onCanSplitChange?: (canSplit: boolean) => void;
};

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(path);
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function EditorStack({
  tabs,
  activeId,
  repoRoot,
  onSelect,
  onDirtyChange,
  registerHandle,
  onCloseTab,
  splitSignal,
  onCanSplitChange,
}: Props) {
  const editors = useMemo(
    () => tabs.filter((t): t is EditorTab => t.kind === "editor"),
    [tabs],
  );
  const editorById = useMemo(() => {
    const m = new Map<number, EditorTab>();
    for (const e of editors) m.set(e.id, e);
    return m;
  }, [editors]);
  const editorIdsKey = editors.map((e) => e.id).join(",");

  // Stable per-tab callbacks — inline arrows would change identity each render
  // and make React detach/reattach refs, re-firing onDirtyChange.
  const registerRef = useRef(registerHandle);
  const dirtyRef = useRef(onDirtyChange);
  const closeRef = useRef(onCloseTab);
  const selectRef = useRef(onSelect);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeRef.current = onCloseTab;
  }, [onCloseTab]);
  useEffect(() => {
    selectRef.current = onSelect;
  }, [onSelect]);

  const refCallbacks = useRef(
    new Map<number, (h: EditorPaneHandle | null) => void>(),
  );
  const dirtyCallbacks = useRef(new Map<number, (dirty: boolean) => void>());
  const closeCallbacks = useRef(new Map<number, () => void>());
  const localHandles = useRef(new Map<number, EditorPaneHandle>());

  const [previewIds, setPreviewIds] = useState<Set<number>>(() => new Set());
  const [previewContent, setPreviewContent] = useState<Map<number, string>>(
    () => new Map(),
  );

  // --- Split-group layout (#65) ---
  const [layout, setLayout] = useState<EditorGroupNode>(() => emptyLeaf(1));
  const nextLeafIdRef = useRef(2);
  // Group new tabs land in / splits anchor to — the last leaf the global active
  // editor lived in.
  const lastActiveLeafRef = useRef(1);
  const [draggingTabId, setDraggingTabId] = useState<number | null>(null);

  // Reconcile the tree with the live editor set; place new tabs in the
  // last-focused leaf and mark the global active tab active in its leaf. The
  // updater is pure — the lastActiveLeafRef sync lives in its own effect below
  // (a side effect inside a state updater can run twice under StrictMode).
  useEffect(() => {
    const ids = editorIdsKey ? editorIdsKey.split(",").map(Number) : [];
    setLayout((prev) => {
      let next = reconcile(prev, ids, lastActiveLeafRef.current);
      const leaf = editorById.has(activeId)
        ? leafContainingTab(next, activeId)
        : null;
      if (leaf) next = setActiveTab(next, leaf.id, activeId);
      return next;
    });
  }, [editorIdsKey, activeId, editorById]);

  // Keep lastActiveLeafRef pointing at the leaf that holds the global active
  // tab, so the next reconcile drops new tabs into the right group.
  useEffect(() => {
    if (!editorById.has(activeId)) return;
    const leaf = leafContainingTab(layout, activeId);
    if (leaf) lastActiveLeafRef.current = leaf.id;
  }, [layout, activeId, editorById]);

  // Show drop zones whenever an editor tab is being dragged (from a group strip
  // or the global tab bar — both mark the node with data-editor-drag-tab).
  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.(
        "[data-editor-drag-tab]",
      ) as HTMLElement | null;
      const id = el?.dataset.editorDragTab;
      if (id != null && id !== "") setDraggingTabId(Number(id));
    };
    const clear = () => setDraggingTabId(null);
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

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
        const content = localHandles.current.get(id)?.getContent();
        if (content !== null && content !== undefined) {
          setPreviewContent((m) => new Map(m).set(id, content));
        }
      }
      return next;
    });
  }, []);

  // Drop a tab onto a leaf edge → split; center → move into the group.
  // (splitLeafWithTab handles both, including the center no-op.) Ids are
  // allocated here, not inside the updater, so the updater stays pure.
  const handleDrop = useCallback(
    (targetLeafId: number, edge: SplitEdge, tabId: number) => {
      const newLeafId = nextLeafIdRef.current++;
      const newSplitId = nextLeafIdRef.current++;
      setLayout((prev) =>
        splitLeafWithTab(prev, targetLeafId, tabId, edge, newLeafId, newSplitId),
      );
      lastActiveLeafRef.current = targetLeafId;
      selectRef.current(tabId);
      setDraggingTabId(null);
    },
    [],
  );

  // Header Split button → split the active editor group: move the active tab
  // into a new group on the right (row) / bottom (col), like dragging it to
  // that edge. Keyed on the signal's nonce so it fires once per click; the
  // ≥2-tabs guard mirrors `canSplit` (a lone tab has nothing to split off).
  const lastSplitNonceRef = useRef(splitSignal?.n ?? 0);
  useEffect(() => {
    const sig = splitSignal;
    if (!sig || sig.n === 0 || sig.n === lastSplitNonceRef.current) return;
    lastSplitNonceRef.current = sig.n;
    if (!editorById.has(activeId)) return;
    const leaf = leafContainingTab(layout, activeId);
    if (!leaf || leaf.tabIds.length < 2) return;
    handleDrop(leaf.id, sig.dir === "row" ? "right" : "bottom", activeId);
  }, [splitSignal, activeId, layout, editorById, handleDrop]);

  const onCanSplitChangeRef = useRef(onCanSplitChange);
  useEffect(() => {
    onCanSplitChangeRef.current = onCanSplitChange;
  }, [onCanSplitChange]);

  // Report whether the active editor group can be split (its leaf holds 2+ tabs)
  // so the header button can enable/disable itself.
  useEffect(() => {
    const leaf = editorById.has(activeId)
      ? leafContainingTab(layout, activeId)
      : null;
    onCanSplitChangeRef.current?.(!!leaf && leaf.tabIds.length >= 2);
  }, [layout, activeId, editorById]);

  // Drop callback / preview / buffer-cache state for closed tabs.
  useEffect(() => {
    const live = new Set(editors.map((t) => t.id));
    for (const map of [
      refCallbacks.current,
      dirtyCallbacks.current,
      closeCallbacks.current,
      localHandles.current,
    ]) {
      for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    }
    // Evict cached buffers for files no longer open (so a true close, not a
    // split remount, re-reads fresh from disk on reopen).
    pruneDocumentCache(new Set(editors.map((t) => t.path)));
    setPreviewIds((curr) => {
      const next = new Set([...curr].filter((id) => live.has(id)));
      return next.size === curr.size ? curr : next;
    });
    setPreviewContent((curr) => {
      const next = new Map([...curr].filter(([id]) => live.has(id)));
      return next.size === curr.size ? curr : next;
    });
  }, [editors]);

  if (editors.length === 0) return null;

  const showStrips = allLeaves(layout).length > 1;

  const renderEditorTab = (tabId: number, visibleInLeaf: boolean) => {
    const t = editorById.get(tabId);
    if (!t) return null;
    const isMd = isMarkdownPath(t.path);
    const showPreview = previewIds.has(t.id);
    const runCommand = runCommandForPath(t.path);
    return (
      <div
        key={t.id}
        className={cn(
          "absolute inset-0",
          !visibleInLeaf && "invisible pointer-events-none",
        )}
        aria-hidden={!visibleInLeaf}
      >
        <div className="relative h-full overflow-hidden rounded-md border border-border/60 bg-background">
          {isImagePath(t.path) ? (
            <ImagePreviewPane path={t.path} />
          ) : (
            <EditorPane
              ref={getRefCallback(t.id)}
              path={t.path}
              repoRoot={repoRoot}
              onDirtyChange={getDirtyCallback(t.id)}
              onClose={getCloseCallback(t.id)}
            />
          )}
          {isMd && showPreview && (
            <div className="absolute inset-0 bg-background">
              <MarkdownPreviewPane
                path={t.path}
                visible={visibleInLeaf}
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
          {runCommand && !showPreview && (
            <button
              type="button"
              onClick={() => runInTerminal(runCommand, { cwd: dirnameForPath(t.path), immediate: true })}
              className={cn("absolute top-2 z-10 flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2 text-[11px] font-medium text-muted-foreground backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground", isMd ? "right-24" : "right-2")}
              title={`Run ${runCommand}`}
            >
              <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.75} />
              <span>Run</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderNode = (node: EditorGroupNode) => {
    if (node.kind === "split") {
      return (
        <ResizablePanelGroup
          orientation={node.dir === "row" ? "horizontal" : "vertical"}
          className="h-full min-h-0"
        >
          {node.children.map((child, i) => (
            <Fragment key={child.id}>
              {i > 0 && <ResizableHandle />}
              <ResizablePanel id={`egroup-${child.id}`} minSize="15%">
                {renderNode(child)}
              </ResizablePanel>
            </Fragment>
          ))}
        </ResizablePanelGroup>
      );
    }
    const tabIds = node.tabIds.filter((id) => editorById.has(id));
    const activeTabId =
      node.activeTabId != null && tabIds.includes(node.activeTabId)
        ? node.activeTabId
        : (tabIds[tabIds.length - 1] ?? null);
    const panelId = `egpanel-${node.id}`;
    const tabDomId = (id: number) => `egtab-${node.id}-${id}`;
    const activate = (id: number) => {
      setLayout((prev) => setActiveTab(prev, node.id, id));
      lastActiveLeafRef.current = node.id;
      selectRef.current(id);
    };
    // Roving-focus keyboard nav across the group's tab strip (ARIA tabs).
    const onStripKeyDown = (
      e: ReactKeyboardEvent<HTMLDivElement>,
      id: number,
    ) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate(id);
        return;
      }
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const i = tabIds.indexOf(id);
      const nextIdx =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? tabIds.length - 1
            : (i + (e.key === "ArrowRight" ? 1 : -1) + tabIds.length) %
              tabIds.length;
      const nextId = tabIds[nextIdx];
      activate(nextId);
      e.currentTarget.parentElement
        ?.querySelector<HTMLElement>(`[data-editor-drag-tab="${nextId}"]`)
        ?.focus();
    };
    return (
      <div className="flex h-full min-h-0 flex-col">
        {showStrips && (
          <div
            role="tablist"
            aria-orientation="horizontal"
            aria-label="Editor group tabs"
            className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/40 px-1"
          >
            {tabIds.map((id) => {
              const t = editorById.get(id)!;
              const selected = id === activeTabId;
              return (
                <div
                  key={id}
                  id={tabDomId(id)}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  draggable
                  data-editor-drag-tab={id}
                  onDragStart={(e) =>
                    e.dataTransfer.setData(DRAG_MIME, String(id))
                  }
                  onClick={() => activate(id)}
                  onKeyDown={(e) => onStripKeyDown(e, id)}
                  className={cn(
                    "group/etab flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors",
                    selected
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <span className={cn("truncate", t.preview && "italic")}>
                    {basename(t.path)}
                  </span>
                  {t.dirty ? <span className="text-foreground/70">●</span> : null}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeRef.current(id);
                    }}
                    aria-label={`Close ${basename(t.path)}`}
                    className="rounded px-0.5 text-muted-foreground/60 opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/etab:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div
          id={panelId}
          role={showStrips ? "tabpanel" : undefined}
          aria-labelledby={
            showStrips && activeTabId != null ? tabDomId(activeTabId) : undefined
          }
          className="relative min-h-0 flex-1"
          onMouseDownCapture={() => {
            if (activeTabId != null && activeTabId !== activeId) {
              lastActiveLeafRef.current = node.id;
              selectRef.current(activeTabId);
            }
          }}
        >
          {tabIds.map((id) => renderEditorTab(id, id === activeTabId))}
          {draggingTabId != null && (
            <LeafDropZones
              onDrop={(edge) => {
                if (draggingTabId != null)
                  handleDrop(node.id, edge, draggingTabId);
              }}
            />
          )}
        </div>
      </div>
    );
  };

  return <div className="h-full w-full">{renderNode(layout)}</div>;
}

/** Edge/center drop targets overlaid on a group while a tab is dragged. */
function LeafDropZones({ onDrop }: { onDrop: (edge: SplitEdge) => void }) {
  const zone = (edge: SplitEdge, className: string, label: string) => (
    <div
      className={cn("group/zone absolute", className)}
      onDragOver={(e) => {
        // Only accept our own tab drags — reject OS file drops etc.
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(edge);
      }}
      aria-label={label}
    >
      <div className="h-full w-full rounded bg-primary/0 transition-colors group-hover/zone:bg-primary/20" />
    </div>
  );
  return (
    <div className="absolute inset-0 z-20">
      {zone("left", "left-0 top-0 h-full w-1/4", "Split left")}
      {zone("right", "right-0 top-0 h-full w-1/4", "Split right")}
      {zone("top", "left-1/4 top-0 h-1/3 w-1/2", "Split up")}
      {zone("bottom", "left-1/4 bottom-0 h-1/3 w-1/2", "Split down")}
      {zone("center", "left-1/4 top-1/3 h-1/3 w-1/2", "Move here")}
    </div>
  );
}
