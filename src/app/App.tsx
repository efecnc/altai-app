import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  AgentRunBridge,
  AiSidePanel,
  getAllKeys,
  hasAnyKey,
  SelectionAskAi,
  useChatStore,
} from "@/modules/ai";
import {
  DEFAULT_AUTOCOMPLETE_MODEL,
  MODELS,
  pickAutocompleteProvider,
  pickDefaultModel,
  type ProviderId,
} from "@/modules/ai/config";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { redactSensitive } from "@/modules/ai/lib/redact";
import { native } from "@/modules/ai/lib/native";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { usePlanStore, type QueuedEdit } from "@/modules/ai/store/planStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import { announce, LiveRegion } from "@/modules/a11y";
import {
  AiDiffStack,
  EditorBreadcrumb,
  EditorStack,
  GitDiffStack,
  NewEditorDialog,
  type EditorPaneHandle,
} from "@/modules/editor";
import {
  GitHistoryStack,
  type GitHistorySearchHandle,
} from "@/modules/git-history";
import { GitHubItemsStack, ProjectBoardStack } from "@/modules/github";
import { getInitialLaunches, getLaunchDir, type LaunchPayload } from "@/lib/launchDir";
import { useZoom } from "@/lib/useZoom";
import {
  FileExplorer,
  type FileExplorerHandle,
  buildGitDecorations,
} from "@/modules/explorer";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { MarkdownStack } from "@/modules/markdown";
import { NotebookStack } from "@/modules/notebook";
import { SettingsStack } from "@/settings/SettingsStack";
import {
  initAgentEventBridge,
  replayRestoredAgentRuns,
} from "@/modules/ai/lib/agentEventBridge";
import {
  PreviewStack,
  WebviewStack,
  type PreviewPaneHandle,
} from "@/modules/preview";
import {
  openSettingsWindow,
  registerOpenSettings,
  type SettingsTab as SettingsSection,
} from "@/modules/settings/openSettingsWindow";
import {
  registerRunInTerminal,
  type RunInTerminalOptions,
} from "@/modules/terminal/runInTerminal";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useApplyA11yClasses } from "@/modules/settings/applyA11yClasses";
import {
  onKeysChanged,
  setAutocompleteModelId,
  setAutocompleteProvider,
} from "@/modules/settings/store";
import {
  ShortcutsDialog,
  useGlobalShortcuts,
  type ShortcutHandlers,
  type ShortcutId,
} from "@/modules/shortcuts";
import { SidebarRail, type SidebarViewId } from "@/modules/sidebar";
import {
  SourceControlPanel,
  useSourceControl,
} from "@/modules/source-control";
import { StatusBar } from "@/modules/statusbar";
import {
  tabTriggerId,
  type TerminalTab,
  useTabs,
  useWorkspaceCwd,
  WORKSPACE_PANEL_ID,
} from "@/modules/tabs";
import { folderName, useWorkspaceFolderStore } from "@/modules/workspace/folder";
import {
  disposeSession,
  findLeafCwd,
  hasLeaf,
  leafIds,
  respawnSession,
  TerminalPanelHeader,
  TerminalStack,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import { UpdaterDialog } from "@/modules/updater";
import {
  getWslHome,
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SearchAddon } from "@xterm/addon-search";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

function dirname(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx);
}

const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_WIDTH_STORAGE_KEY = "altai.sidebar.width";
const SIDEBAR_VIEW_STORAGE_KEY = "altai.sidebar.view";

const AGENT_SIDEBAR_DEFAULT_WIDTH = 380;
const AGENT_SIDEBAR_MIN_WIDTH = 280;
const AGENT_SIDEBAR_WIDTH_STORAGE_KEY = "altai.agentSidebar.width";
const PLAN_REVIEW_DIFF_PREFIX = "plan-review:";

// Terminal bottom drawer (#61).
const TERMINAL_DRAWER_DEFAULT_HEIGHT = 280;
const TERMINAL_DRAWER_MIN_HEIGHT = 120;
const TERMINAL_DRAWER_HEIGHT_STORAGE_KEY = "altai.terminalDrawer.height";

function clampTerminalDrawerHeight(height: number): number {
  return Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Math.round(height));
}

function readTerminalDrawerHeight(): number {
  try {
    const stored = window.localStorage.getItem(
      TERMINAL_DRAWER_HEIGHT_STORAGE_KEY,
    );
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? clampTerminalDrawerHeight(parsed)
      : TERMINAL_DRAWER_DEFAULT_HEIGHT;
  } catch {
    return TERMINAL_DRAWER_DEFAULT_HEIGHT;
  }
}

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.round(width));
}

function clampAgentSidebarWidth(width: number): number {
  return Math.max(AGENT_SIDEBAR_MIN_WIDTH, Math.round(width));
}

function readSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function readAgentSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(AGENT_SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? clampAgentSidebarWidth(parsed)
      : AGENT_SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return AGENT_SIDEBAR_DEFAULT_WIDTH;
  }
}

function readSidebarView(): SidebarViewId {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
    if (stored === "explorer" || stored === "source-control") return stored;
  } catch {
    // ignore
  }
  return "explorer";
}

export default function App() {
  // Mirror accessibility preferences onto <html> so the CSS overrides in
  // globals.css apply reduce-motion, high-contrast, larger-text,
  // strong-focus, underline-links, and visible-skip-link rules app-wide.
  useApplyA11yClasses();
  // The first terminal should open in the chosen workspace folder. App only
  // mounts once the WorkspaceGate has a folder, so a non-reactive read here is
  // safe and reflects the active workspace (a folder switch remounts App).
  const initialTabCwd =
    useWorkspaceFolderStore.getState().folder ?? getLaunchDir() ?? undefined;
  const {
    tabs,
    activeId,
    setActiveId,
    activeTerminalId,
    setActiveTerminalId,
    newTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    replaceTabAsWebview,
    newMarkdownTab,
    openNotebookTab,
    openSettingsTab,
    setSettingsSection,
    newTerminalTabWithLeaf,
    openAiDiffTab,
    setAiDiffStatus,
    closeAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openGitHubItemsTab,
    openProjectBoardTab,
    openCommitFileDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  } = useTabs(initialTabCwd ? { cwd: initialTabCwd } : undefined);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // The terminal shown in the bottom drawer — decoupled from the main `activeId`
  // (which only references non-terminal tabs now). #61
  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeTerminalId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeTerminalId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [gitHistoryHandle, setGitHistoryHandle] =
    useState<GitHistorySearchHandle | null>(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  const explorerRef = useRef<FileExplorerHandle>(null);
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);

  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const sidebarWidthRef = useRef(readSidebarWidth());
  const sidebarWidthWriteTimerRef = useRef(0);
  const agentSidebarRef = useRef<PanelImperativeHandle | null>(null);
  const agentSidebarWidthRef = useRef(readAgentSidebarWidth());
  const agentSidebarWidthWriteTimerRef = useRef(0);
  // Keep the terminal drawer out of the way on launch. It opens when the user
  // explicitly toggles it, creates a terminal, or sends a command to it.
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(false);
  // React state can lag behind repeated keydown events by a render. Keep a
  // synchronous mirror so a quick shortcut sequence always toggles from the
  // latest requested state instead of reopening an already-open drawer.
  const terminalDrawerOpenRef = useRef(false);
  const terminalDrawerRef = useRef<PanelImperativeHandle | null>(null);
  const terminalDrawerHeightRef = useRef(readTerminalDrawerHeight());
  const terminalDrawerHeightWriteTimerRef = useRef(0);
  const terminalCreationPendingRef = useRef(false);
  // Guards against a 0px ResizeObserver tick on mount — only mirror genuine
  // user-driven drawer collapses after it has been opened once.
  const terminalDrawerSeenOpenRef = useRef(false);
  // A freshly cloned workspace opens straight into Source Control so the new
  // repo is visible without manually switching views; otherwise restore the
  // persisted view. The transient flag is cleared on mount below.
  const [sidebarView, setSidebarViewState] = useState<SidebarViewId>(() =>
    useWorkspaceFolderStore.getState().justCloned
      ? "source-control"
      : readSidebarView(),
  );
  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarViewState(view);
    try {
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
    } catch {
      // storage may fail in private mode
    }
  }, []);
  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.resize(`${sidebarWidthRef.current}px`);
    else p.collapse();
  }, []);
  const setTerminalDrawerVisibility = useCallback((open: boolean) => {
    terminalDrawerOpenRef.current = open;
    setTerminalDrawerOpen(open);
  }, []);
  const toggleTerminalDrawer = useCallback(() => {
    const willOpen = !terminalDrawerOpenRef.current;
    // Opening with no terminal yet — spin one up (outside the state updater,
    // which must stay pure).
    if (
      willOpen &&
      activeTerminalId == null &&
      !terminalCreationPendingRef.current
    ) {
      terminalCreationPendingRef.current = true;
      newTab();
    }
    setTerminalDrawerVisibility(willOpen);
  }, [activeTerminalId, newTab, setTerminalDrawerVisibility]);

  useEffect(() => {
    if (activeTerminalId != null) terminalCreationPendingRef.current = false;
  }, [activeTerminalId]);
  const cycleSidebarView = useCallback(
    (view: SidebarViewId) => {
      const panel = sidebarRef.current;
      const collapsed = panel?.isCollapsed() ?? false;
      if (collapsed) {
        if (panel) panel.resize(`${sidebarWidthRef.current}px`);
        if (view !== sidebarView) persistSidebarView(view);
        return;
      }
      if (view === sidebarView) {
        panel?.collapse();
        return;
      }
      persistSidebarView(view);
    },
    [persistSidebarView, sidebarView],
  );
  const persistSidebarWidth = useCallback((next: number) => {
    sidebarWidthRef.current = next;
    if (sidebarWidthWriteTimerRef.current) {
      window.clearTimeout(sidebarWidthWriteTimerRef.current);
    }
    sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      sidebarWidthWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
    }, 200);
  }, []);
  const persistAgentSidebarWidth = useCallback((next: number) => {
    const clamped = clampAgentSidebarWidth(next);
    agentSidebarWidthRef.current = clamped;
    if (agentSidebarWidthWriteTimerRef.current) {
      window.clearTimeout(agentSidebarWidthWriteTimerRef.current);
    }
    agentSidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      agentSidebarWidthWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(
          AGENT_SIDEBAR_WIDTH_STORAGE_KEY,
          String(clamped),
        );
      } catch {
        // ignore
      }
    }, 200);
  }, []);
  const persistTerminalDrawerHeight = useCallback((next: number) => {
    const clamped = clampTerminalDrawerHeight(next);
    terminalDrawerHeightRef.current = clamped;
    if (terminalDrawerHeightWriteTimerRef.current) {
      window.clearTimeout(terminalDrawerHeightWriteTimerRef.current);
    }
    terminalDrawerHeightWriteTimerRef.current = window.setTimeout(() => {
      terminalDrawerHeightWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(
          TERMINAL_DRAWER_HEIGHT_STORAGE_KEY,
          String(clamped),
        );
      } catch {
        // ignore
      }
    }, 200);
  }, []);
  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
      if (agentSidebarWidthWriteTimerRef.current) {
        window.clearTimeout(agentSidebarWidthWriteTimerRef.current);
      }
      if (terminalDrawerHeightWriteTimerRef.current) {
        window.clearTimeout(terminalDrawerHeightWriteTimerRef.current);
      }
    };
  }, []);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel?.isCollapsed() ?? false;
    if (sidebarView !== "explorer" || collapsed) {
      if (panel && collapsed) panel.resize(`${sidebarWidthRef.current}px`);
      if (sidebarView !== "explorer") persistSidebarView("explorer");
      const active = document.activeElement;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [persistSidebarView, sidebarView]);

  const [home, setHome] = useState<string | null>(null);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
  useEffect(() => {
    homeDir()
      .then(async (p) => {
        const normalized = p.replace(/\\/g, "/");
        setHome(normalized);
        try {
          await native.workspaceAuthorize(normalized);
        } catch {
          // Bootstrap already authorizes home from Rust; ignore.
        }
      })
      .catch(() => setHome(null));
  }, []);

  const switchWorkspace = useCallback(
    async (env: WorkspaceEnv) => {
      if (
        env.kind === workspaceEnv.kind &&
        (env.kind === "local" ||
          (workspaceEnv.kind === "wsl" && env.distro === workspaceEnv.distro))
      ) {
        return;
      }
      const dirty = tabsRef.current.some((t) => t.kind === "editor" && t.dirty);
      if (dirty) {
        const msg =
          "Save or close unsaved editor tabs before switching workspace.";
        announce(msg);
        window.alert(msg);
        return;
      }

      let nextHome: string | null = null;
      try {
        if (env.kind === "wsl") {
          nextHome = await getWslHome(env.distro);
        } else {
          nextHome = (await homeDir()).replace(/\\/g, "/");
        }
      } catch (e) {
        announce(String(e));
        window.alert(String(e));
        return;
      }

      for (const id of liveLeavesRef.current) disposeSession(id);
      searchAddons.current.clear();
      terminalRefs.current.clear();
      editorRefs.current.clear();
      previewRefs.current.clear();
      setActiveSearchAddon(null);
      setActiveEditorHandle(null);
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      setHome(nextHome);
      setLaunchCwd(nextHome);
      if (nextHome) {
        try {
          await native.workspaceAuthorize(nextHome);
        } catch {
          // Non-fatal — git panel will surface "not authorized" if needed.
        }
      }
      resetWorkspace(nextHome ?? undefined);
    },
    [workspaceEnv, setWorkspaceEnv, resetWorkspace],
  );
  useEffect(() => {
    native
      .workspaceCurrentDir()
      .then(setLaunchCwd)
      .catch(() => setLaunchCwd(null))
      .finally(() => setLaunchCwdResolved(true));
  }, []);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const miniOpen = useChatStore((s) => s.mini.open);
  const openMini = useChatStore((s) => s.openMini);
  const closeMini = useChatStore((s) => s.closeMini);
  const focusInput = useChatStore((s) => s.focusInput);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const setLive = useChatStore((s) => s.setLive);
  const respondToApproval = useChatStore((s) => s.respondToApproval);
  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const openaiCompatibleModelId = usePreferencesStore(
    (s) => s.openaiCompatibleModelId,
  );
  const openaiCompatibleBaseURL = usePreferencesStore(
    (s) => s.openaiCompatibleBaseURL,
  );
  const hasLocalModel =
    (lmstudioBaseURL.trim().length > 0 && lmstudioModelId.trim().length > 0) ||
    (mlxBaseURL.trim().length > 0 && mlxModelId.trim().length > 0) ||
    (openaiCompatibleBaseURL.trim().length > 0 &&
      openaiCompatibleModelId.trim().length > 0);
  const hasComposer = hasAnyKey(apiKeys) || hasLocalModel;

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      // Dispatch a window event the composer listens for. Same pattern as
      // selections — keeps file-explorer decoupled from the AI module.
      window.dispatchEvent(
        new CustomEvent<string>("altai:ai-attach-file", { detail: path }),
      );
      openMini();
      focusInput(null);
    },
    [hasComposer, openMini, focusInput],
  );

  const handleLaunch = useCallback(
    (payload: LaunchPayload) => {
      if (payload.type === "folder") {
        const path = payload.paths[0];
        if (path) {
          useWorkspaceFolderStore.getState().setFolder(path);
        }
      } else if (payload.type === "file" || payload.type === "multi_file") {
        payload.paths.forEach((path) => {
          openFileTab(path, true);
        });

        if (payload.action === "explain") {
          const path = payload.paths[0];
          if (path) {
            handleAttachFileToAgent(path);
            // Small delay to let the AI panel open and attach the file.
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent<string>("altai:ai-set-input", {
                  detail: "Explain this file",
                }),
              );
            }, 200);
          }
        } else if (payload.action === "refactor") {
          const path = payload.paths[0];
          if (path) {
            handleAttachFileToAgent(path);
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent<string>("altai:ai-set-input", {
                  detail: "Refactor this file",
                }),
              );
            }, 200);
          }
        } else if (payload.action === "ask-project") {
          const path = payload.paths[0];
          if (path) {
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent<string>("altai:ai-set-input", {
                  detail: "Tell me about this project",
                }),
              );
            }, 500); // More delay for workspace indexing
          }
        }
      }
    },
    [openFileTab, handleAttachFileToAgent],
  );

  useEffect(() => {
    // Process initial launches (from CLI or file assoc at startup)
    const initial = getInitialLaunches();
    for (const l of initial) {
      // Small delay to let the rest of the app hydrate/mount
      setTimeout(() => handleLaunch(l), 100);
    }

    // Listen for subsequent launches (single-instance events)
    const unlistenPromise = getCurrentWebviewWindow().listen<LaunchPayload>(
      "altai:launch",
      (event) => {
        handleLaunch(event.payload);
      },
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, [handleLaunch]);

  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (!alive) return;
        setApiKeys(keys);
        setKeysLoaded(true);
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys]);

  // Hydrate the cross-window preference store and mirror the default model
  // into chatStore so the dropdown reflects what the user picked in Settings.
  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  const autocompleteProvider = usePreferencesStore((s) => s.autocompleteProvider);
  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  // A provider counts as usable when it has a key, or — for the key-optional
  // local providers — when a base URL + model id are configured.
  const isProviderConfigured = useCallback(
    (provider: ProviderId): boolean => {
      if (provider === "lmstudio")
        return (
          lmstudioBaseURL.trim().length > 0 &&
          lmstudioModelId.trim().length > 0
        );
      if (provider === "mlx")
        return mlxBaseURL.trim().length > 0 && mlxModelId.trim().length > 0;
      if (provider === "openai-compatible")
        return (
          openaiCompatibleBaseURL.trim().length > 0 &&
          openaiCompatibleModelId.trim().length > 0
        );
      return !!apiKeys[provider];
    },
    [
      apiKeys,
      lmstudioBaseURL,
      lmstudioModelId,
      mlxBaseURL,
      mlxModelId,
      openaiCompatibleBaseURL,
      openaiCompatibleModelId,
    ],
  );

  // Default chat model follows the configured providers: keep the persisted
  // choice when its provider has a key, otherwise fall back to a model from a
  // provider the user actually set up (#71).
  useEffect(() => {
    if (!prefsHydrated || !keysLoaded) return;
    const storedProvider = MODELS.find(
      (m) => m.id === prefDefaultModel,
    )?.provider;
    if (storedProvider && isProviderConfigured(storedProvider)) {
      setSelectedModelId(prefDefaultModel);
      return;
    }
    const fallback = pickDefaultModel(isProviderConfigured);
    setSelectedModelId(fallback ?? prefDefaultModel);
  }, [
    prefsHydrated,
    keysLoaded,
    prefDefaultModel,
    isProviderConfigured,
    setSelectedModelId,
  ]);

  // Same idea for inline autocomplete: if its provider isn't configured, move
  // to a configured one instead of demanding a key for an unused provider (#71).
  useEffect(() => {
    if (!prefsHydrated || !keysLoaded) return;
    if (isProviderConfigured(autocompleteProvider)) return;
    const fallback = pickAutocompleteProvider(isProviderConfigured);
    if (!fallback || fallback === autocompleteProvider) return;
    void setAutocompleteProvider(fallback);
    // Cloud providers have a fixed fast default; the key-optional local
    // providers use the user's configured local model id.
    const model =
      DEFAULT_AUTOCOMPLETE_MODEL[fallback] ||
      (fallback === "lmstudio"
        ? lmstudioModelId
        : fallback === "mlx"
          ? mlxModelId
          : fallback === "openai-compatible"
            ? openaiCompatibleModelId
            : "");
    if (model) void setAutocompleteModelId(model);
  }, [
    prefsHydrated,
    keysLoaded,
    isProviderConfigured,
    autocompleteProvider,
    lmstudioModelId,
    mlxModelId,
    openaiCompatibleModelId,
  ]);

  const hydrateSessions = useChatStore((s) => s.hydrateSessions);
  useEffect(() => {
    let disposed = false;
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
    // Listen before hydration/replay. A live event that overlaps the replay is
    // deduplicated by the same run-id and sequence guards.
    const unlistenP = initAgentEventBridge();
    void (async () => {
      await hydrateSessions();
      await unlistenP;
      if (disposed) return;
      const workspacePath = useWorkspaceFolderStore.getState().folder;
      if (!workspacePath) return;
      const sessions = useChatStore.getState().sessions;
      await replayRestoredAgentRuns(
        workspacePath,
        sessions.map((session) => session.id),
      );
    })().catch((error) => {
      console.warn("Could not replay restored agent runs", error);
    });
    return () => {
      disposed = true;
      void unlistenP.then((fn) => fn());
    };
  }, [hydrateSessions]);

  const activeTab = tabs.find((t) => t.id === activeId);
  // Terminals live in the bottom drawer, not the main tab bar (#61).
  const mainTabs = useMemo(
    () => tabs.filter((t) => t.kind !== "terminal"),
    [tabs],
  );
  const isTerminalTab = activeTab?.kind === "terminal";
  const isEditorTab = activeTab?.kind === "editor";
  const isPreviewTab = activeTab?.kind === "preview";
  const isWebviewTab = activeTab?.kind === "webview";
  const isMarkdownTab = activeTab?.kind === "markdown";
  const isNotebookTab = activeTab?.kind === "notebook";
  const isSettingsTab = activeTab?.kind === "settings";

  // Reflect the active tab in the document title so the OS window/tab and
  // screen-reader title announcements track context (a11y D6).
  useEffect(() => {
    const name = activeTab?.title?.trim();
    document.title = name ? `${name} — ALTAI` : "ALTAI";
  }, [activeTab?.title]);

  // Route every `openSettingsWindow(...)` call through this hook's tabs
  // store. The registration is idempotent across HMR re-mounts; the
  // returned cleanup wipes the impl so callers fail loud if the host
  // ever unmounts.
  useEffect(() => {
    return registerOpenSettings((section) => {
      openSettingsTab(section);
    });
  }, [openSettingsTab]);
  const isAiDiffTab = activeTab?.kind === "ai-diff";
  const isGitDiffTab =
    activeTab?.kind === "git-diff" || activeTab?.kind === "git-commit-file";
  const isGitHistoryTab = activeTab?.kind === "git-history";
  const isGitHubItemsTab = activeTab?.kind === "github-items";
  const isProjectBoardTab = activeTab?.kind === "project-board";

  // When an AI diff is approved (write_file applied to disk), reload any
  // open editor tabs for that path so the user sees the new content. We
  // track which approvalIds we've already handled to fire the reload only
  // once per applied diff.
  const appliedDiffsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.kind !== "ai-diff") continue;
      if (t.status !== "approved") continue;
      if (appliedDiffsRef.current.has(t.approvalId)) continue;
      appliedDiffsRef.current.add(t.approvalId);
      for (const e of tabs) {
        if (e.kind !== "editor") continue;
        if (e.path !== t.path) continue;
        editorRefs.current.get(e.id)?.reload();
      }
    }
  }, [tabs]);

  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise = getCurrentWebviewWindow().listen<FileWrittenPayload>(
      "fs:file-written",
      (event) => {
        if (event.payload.source === "editor") return;
        const normalizedPath = event.payload.path.replace(/\\/g, "/");
        const currentTabs = tabsRef.current;
        for (const t of currentTabs) {
          if (t.kind !== "editor") continue;
          if (t.path.replace(/\\/g, "/") === normalizedPath) {
            editorRefs.current.get(t.id)?.reload();
          }
        }
      },
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  const workspaceFolder = useWorkspaceFolderStore((s) => s.folder);
  const closeFolder = useWorkspaceFolderStore((s) => s.closeFolder);

  // Consume the one-shot "just cloned" flag that steered the initial sidebar
  // view, so a later folder switch falls back to the persisted preference.
  useEffect(() => {
    useWorkspaceFolderStore.getState().clearJustCloned();
  }, []);
  const { explorerRoot: terminalExplorerRoot, inheritedCwdForNewTab } =
    useWorkspaceCwd(
      // Terminals live in the drawer now, so cwd tracking follows the drawer's
      // active terminal rather than the main active tab (#61).
      activeTerminalTab ?? undefined,
      tabs,
      workspaceFolder ?? launchCwd ?? home,
    );
  // The opened workspace folder IS the explorer root (IDE behavior): the file
  // tree stays anchored to the project instead of following wherever a terminal
  // has cd'd (which made it jump to `/`). Falls back to the terminal-derived
  // root only when no workspace is selected.
  const explorerRoot = workspaceFolder ?? terminalExplorerRoot;

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null ? (searchAddons.current.get(activeLeafId) ?? null) : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  const handleClose = useCallback(
    (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "editor" && t.dirty) {
        setPendingCloseTab(id);
        return;
      }
      disposeTab(id);
    },
    [tabs, disposeTab],
  );

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const nextIdx = (idx + delta + tabs.length) % tabs.length;
      setActiveId(tabs[nextIdx].id);
    },
    [tabs, activeId, setActiveId],
  );

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      const lid = t.activeLeafId;
      return terminalRefs.current.get(lid)?.getSelection() ?? null;
    }
    if (t.kind === "editor") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  const togglePanelAndFocus = useCallback(() => {
    // Read directly from the store so rapid shortcut presses cannot observe a
    // stale render-time value of `miniOpen`.
    if (useChatStore.getState().mini.open) {
      closeMini();
    } else {
      openMini();
      focusInput(null);
    }
  }, [openMini, closeMini, focusInput]);

  const attachSelection = useChatStore((s) => s.attachSelection);

  useEffect(() => {
    const panel = agentSidebarRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (miniOpen && collapsed) {
      const target = clampAgentSidebarWidth(agentSidebarWidthRef.current);
      agentSidebarWidthRef.current = target;
      panel.resize(`${target}px`);
    } else if (!miniOpen && !collapsed) {
      panel.collapse();
    }
  }, [miniOpen]);

  // Sync the terminal drawer panel to its open state (#61).
  useEffect(() => {
    const panel = terminalDrawerRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (terminalDrawerOpen && collapsed) {
      const target = clampTerminalDrawerHeight(terminalDrawerHeightRef.current);
      terminalDrawerHeightRef.current = target;
      panel.resize(`${target}px`);
    } else if (!terminalDrawerOpen && !collapsed) {
      panel.collapse();
    }
  }, [terminalDrawerOpen]);

  // Auto-hide the terminal drawer once the last terminal tab is closed. The
  // ref guard means we only close after terminals existed (never on the
  // initial empty state), so reopening still works.
  const hadTerminalRef = useRef(false);
  useEffect(() => {
    const count = tabs.reduce(
      (n, t) => (t.kind === "terminal" ? n + 1 : n),
      0,
    );
    if (count > 0) {
      hadTerminalRef.current = true;
    } else if (hadTerminalRef.current) {
      hadTerminalRef.current = false;
      setTerminalDrawerVisibility(false);
    }
  }, [tabs, setTerminalDrawerVisibility]);

  const askFromSelection = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    const selection = captureActiveSelection();
    if (!selection || !selection.trim()) {
      focusInput(null);
      return;
    }
    const source: "terminal" | "editor" =
      activeTab?.kind === "editor" ? "editor" : "terminal";
    attachSelection(selection, source);
  }, [
    hasComposer,
    captureActiveSelection,
    focusInput,
    attachSelection,
    activeTab,
  ]);

  const [askPopup, setAskPopup] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    const isInsideAi = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return !!(
        el.closest("[data-selection-ask-ai]") ||
        el.closest("[data-ai-side-panel]")
      );
    };

    const onDown = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      setAskPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      // Defer one tick so xterm/CodeMirror finalize the selection.
      setTimeout(() => {
        const text = captureActiveSelection();
        if (text && text.trim().length > 0) {
          setAskPopup({ x: e.clientX, y: e.clientY });
        } else {
          setAskPopup(null);
        }
      }, 0);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [captureActiveSelection]);

  const onAskFromSelection = useCallback(() => {
    askFromSelection();
    setAskPopup(null);
  }, [askFromSelection]);

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
    setTerminalDrawerVisibility(true);
  }, [newTab, inheritedCwdForNewTab, setTerminalDrawerVisibility]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
    setTerminalDrawerVisibility(true);
  }, [newPrivateTab, inheritedCwdForNewTab, setTerminalDrawerVisibility]);

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      const quoted = path.includes(" ")
        ? `'${path.replace(/'/g, `'\\''`)}'`
        : path;
      term.write(`cd ${quoted}\r`);
      term.focus();
    },
    [activeLeafId],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTerminalDrawerVisibility(true);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        const quoted = path.includes(" ")
          ? `'${path.replace(/'/g, `'\\''`)}'`
          : path;
        t.write(`cd ${quoted}\r`);
        t.focus();
      }, 80);
    },
    [newTab, setTerminalDrawerVisibility],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Route .ipynb files to the notebook tab instead of the editor.
      if (path.endsWith(".ipynb")) {
        openNotebookTab(path);
        return;
      }
      // Explorer defaults to preview (pin=false); explicit actions like
      // context-menu "Open" pass pin=true for a persistent tab.
      openFileTab(path, pin ?? false);
    },
    [openFileTab, openNotebookTab],
  );

  useEffect(() => {
    const onOpenFile = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      if (typeof path === "string" && path.trim()) handleOpenFile(path, true);
    };
    window.addEventListener("altai:open-file", onOpenFile);
    return () => window.removeEventListener("altai:open-file", onOpenFile);
  }, [handleOpenFile]);

  // Plan review lives inside the AI panel while the detailed CodeMirror diff
  // belongs in the central tab area. A small DOM event keeps those modules
  // decoupled without threading tab callbacks through the whole shell.
  useEffect(() => {
    const onPlanReviewDiff = (event: Event) => {
      const edit = (event as CustomEvent<QueuedEdit>).detail;
      if (!edit || typeof edit.id !== "string" || !edit.path) return;
      openAiDiffTab({
        path: edit.path,
        originalContent: edit.originalContent,
        proposedContent: edit.proposedContent,
        approvalId: `${PLAN_REVIEW_DIFF_PREFIX}${edit.id}`,
        isNewFile: edit.isNewFile,
      });
    };
    window.addEventListener("altai:plan-review-diff", onPlanReviewDiff);
    return () =>
      window.removeEventListener("altai:plan-review-diff", onPlanReviewDiff);
  }, [openAiDiffTab]);

  const handleAiDiffDecision = useCallback(
    (approvalId: string, approved: boolean) => {
      if (!approvalId.startsWith(PLAN_REVIEW_DIFF_PREFIX)) {
        respondToApproval(approvalId, approved);
        return;
      }

      const editId = approvalId.slice(PLAN_REVIEW_DIFF_PREFIX.length);
      if (!approved) {
        usePlanStore.getState().removeOne(editId);
        useChatStore.getState().addActivity({
          label: "Rejected a reviewed change",
          tone: "warning",
        });
        setAiDiffStatus(approvalId, "rejected");
        return;
      }

      void usePlanStore
        .getState()
        .applyOne(editId)
        .then((result) => {
          if (!result) return;
          if (result.ok) {
            useChatStore.getState().addActivity({
              label: "Applied a reviewed change from full diff",
              detail: "Restore point available in Undo",
              tone: "success",
            });
            setAiDiffStatus(approvalId, "approved");
          } else {
            useChatStore.getState().addActivity({
              label: "Could not apply reviewed change",
              detail: result.error,
              tone: "error",
            });
          }
        });
    },
    [respondToApproval, setAiDiffStatus],
  );

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      for (const id of pendingDeleteTabs) disposeTab(id);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeTab]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathDeleted = useCallback(
    (path: string) => {
      const dirty: number[] = [];
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path !== path && !t.path.startsWith(`${path}/`)) continue;
        if (t.dirty) {
          dirty.push(t.id);
        } else {
          disposeTab(t.id);
        }
      }
      if (dirty.length > 0) setPendingDeleteTabs(dirty);
    },
    [tabs, disposeTab],
  );

  const activeTerminalLeafCwd = activeTerminalTab
    ? (findLeafCwd(
        activeTerminalTab.paneTree,
        activeTerminalTab.activeLeafId,
      ) ??
      activeTerminalTab.cwd ??
      null)
    : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const workspaceFallbackPath = launchCwdResolved
    ? (launchCwd ?? home ?? null)
    : null;
  const sourceControlContextPath = (() => {
    if (activeTab?.kind === "editor") return dirname(activeTab.path);
    if (activeTab?.kind === "git-diff") return activeTab.repoRoot;
    if (activeTab?.kind === "git-commit-file") return activeTab.repoRoot;
    if (activeTab?.kind === "git-history") return activeTab.repoRoot;
    if (activeTab?.kind === "github-items") return activeTab.repoRoot;
    if (activeTab?.kind === "project-board") return activeTab.repoRoot;
    // No main tab — anchor to the drawer terminal's cwd (#61).
    if (activeTerminalLeafCwd) return activeTerminalLeafCwd;
    return explorerRoot ?? workspaceFallbackPath;
  })();
  const hasOpenGitTab = useMemo(
    () =>
      tabs.some(
        (t) =>
          t.kind === "git-diff" ||
          t.kind === "git-history" ||
          t.kind === "github-items" ||
          t.kind === "project-board" ||
          t.kind === "git-commit-file",
      ),
    [tabs],
  );
  const sourceControlActive =
    hasOpenGitTab || sidebarView === "source-control";
  // Stable per-session path so switching tabs / cd-ing in a shell does NOT
  // re-fire git IPC for the badge. The active panel resolves the current
  // context path on its own when the user actually opens git.
  const badgeContextPath = workspaceFallbackPath;
  const sourceControlPath = sourceControlActive
    ? sourceControlContextPath
    : badgeContextPath;
  const sourceControl = useSourceControl(sourceControlPath, true);
  const gitDecorations = useMemo(
    () => buildGitDecorations(sourceControl.status),
    [sourceControl.status],
  );

  const toggleSourceControl = useCallback(() => {
    cycleSidebarView("source-control");
  }, [cycleSidebarView]);

  // After a branch switch the working tree changed under us: refresh git
  // status and reload open editors (reload() is a no-op on dirty buffers, so
  // unsaved edits are preserved).
  const refreshSourceControl = sourceControl.refresh;
  const handleBranchSwitched = useCallback(() => {
    void refreshSourceControl({ remote: "never" });
    for (const t of tabsRef.current) {
      if (t.kind === "editor") editorRefs.current.get(t.id)?.reload();
    }
  }, [refreshSourceControl]);

  const openGitGraphFromContext = useCallback(async () => {
    const known = sourceControl.hasRepo ? sourceControl.repo : null;
    if (known) {
      openCommitHistoryTab({
        repoRoot: known.repoRoot,
        branch: sourceControl.status?.branch ?? null,
      });
      return;
    }
    if (!sourceControlContextPath) return;
    try {
      const repo = await native.gitResolveRepo(sourceControlContextPath);
      if (!repo) return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    } catch {
      /* noop */
    }
  }, [
    openCommitHistoryTab,
    sourceControl.hasRepo,
    sourceControl.repo,
    sourceControl.status?.branch,
    sourceControlContextPath,
  ]);

  const openGitHubItemsFromContext = useCallback(async () => {
    const known = sourceControl.hasRepo ? sourceControl.repo : null;
    if (known) {
      openGitHubItemsTab({ repoRoot: known.repoRoot });
      return;
    }
    if (!sourceControlContextPath) return;
    try {
      const repo = await native.gitResolveRepo(sourceControlContextPath);
      if (!repo) return;
      openGitHubItemsTab({ repoRoot: repo.repoRoot });
    } catch {
      /* noop */
    }
  }, [
    openGitHubItemsTab,
    sourceControl.hasRepo,
    sourceControl.repo,
    sourceControlContextPath,
  ]);

  const openProjectBoardFromContext = useCallback(async () => {
    const known = sourceControl.hasRepo ? sourceControl.repo : null;
    if (known) {
      openProjectBoardTab({ repoRoot: known.repoRoot });
      return;
    }
    if (!sourceControlContextPath) return;
    try {
      const repo = await native.gitResolveRepo(sourceControlContextPath);
      if (!repo) return;
      openProjectBoardTab({ repoRoot: repo.repoRoot });
    } catch {
      /* noop */
    }
  }, [
    openProjectBoardTab,
    sourceControl.hasRepo,
    sourceControl.repo,
    sourceControlContextPath,
  ]);

  const openPreviewTab = useCallback(
    (url: string) => {
      const id = newPreviewTab(url);
      // Focus the address bar if the URL is empty so the user can type.
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  // The address-bar promotion path: the user is in tab `id` (a preview tab
  // that fired this) and wants the URL to open as a native webview here —
  // not as a sibling. Replace in place so the tab keeps its position.
  const promotePreviewToWebview = useCallback(
    (id: number, url: string) => replaceTabAsWebview(id, url),
    [replaceTabAsWebview],
  );

  const openMarkdownPreview = useCallback(
    (path: string) => {
      newMarkdownTab(path);
    },
    [newMarkdownTab],
  );

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      if (activeTerminalId == null) return;
      const t = tabsRef.current.find((x) => x.id === activeTerminalId);
      if (!t || t.kind !== "terminal") return;
      splitActivePane(activeTerminalId, dir);
    },
    [activeTerminalId, splitActivePane],
  );

  // Header Split button → split the active EDITOR group (not the terminal).
  // EditorStack owns the group layout, so we bump a signal it watches; it also
  // reports back whether a split is possible (active group has 2+ tabs).
  const [editorCanSplit, setEditorCanSplit] = useState(false);
  const [editorSplit, setEditorSplit] = useState<{
    dir: "row" | "col";
    n: number;
  }>({ dir: "row", n: 0 });
  const requestEditorSplit = useCallback(
    (dir: "row" | "col") => setEditorSplit((s) => ({ dir, n: s.n + 1 })),
    [],
  );

  const handleCloseTabOrPane = useCallback(() => {
    // A focused main tab closes first; otherwise close the drawer terminal/pane.
    const main = tabsRef.current.find((x) => x.id === activeId);
    if (main) {
      handleClose(activeId);
      return;
    }
    if (activeTerminalId == null) return;
    const term = tabsRef.current.find((x) => x.id === activeTerminalId);
    if (term?.kind === "terminal" && leafIds(term.paneTree).length > 1) {
      closeActivePane(activeTerminalId);
    } else {
      handleClose(activeTerminalId);
    }
  }, [activeId, activeTerminalId, closeActivePane, handleClose]);

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "tab.new": openNewTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newPreview": () => openPreviewTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => cycleTab(1),
      "tab.prev": () => cycleTab(-1),
      "tab.selectByIndex": (e) => selectByIndex(parseInt(e.key, 10) - 1),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => {
        if (activeTerminalId != null) focusNextPaneInTab(activeTerminalId, 1);
      },
      "pane.focusPrev": () => {
        if (activeTerminalId != null) focusNextPaneInTab(activeTerminalId, -1);
      },
      "pane.source": toggleSourceControl,
      "terminal.toggle": toggleTerminalDrawer,
      "search.focus": () => searchInlineRef.current?.focus(),
      "ai.toggle": togglePanelAndFocus,
      "ai.askSelection": askFromSelection,
      "shortcuts.open": () => setShortcutsOpen((v) => !v),
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
    }),
    [
      activeId,
      cycleTab,
      handleCloseTabOrPane,
      openNewTab,
      openNewPrivateTab,
      openPreviewTab,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      activeTerminalId,
      toggleTerminalDrawer,
      toggleSourceControl,
      togglePanelAndFocus,
      askFromSelection,
      toggleSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      if (id === "editor.undo" || id === "editor.redo") {
        return activeTab?.kind !== "editor";
      }
      if (id === "ai.askSelection") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        if (!inTerminal) return false;
        const sel = captureActiveSelection();
        return !sel || !sel.trim();
      }
      return false;
    },
    [activeTab],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  // Queue of writes waiting for a specific leaf's PTY handle to register.
  // "Run in terminal" stuffs the install command in here right after
  // creating the tab; the write fires the moment xterm finishes initializing.
  const pendingTerminalWritesRef = useRef<
    Map<number, { command: string; immediate: boolean }>
  >(new Map());

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) {
        terminalRefs.current.set(leafId, h);
        const pending = pendingTerminalWritesRef.current.get(leafId);
        if (pending) {
          pendingTerminalWritesRef.current.delete(leafId);
          // xterm finishes its first paint a tick after the handle is
          // returned; a short delay avoids characters getting eaten by
          // the initial cursor placement.
          setTimeout(() => {
            const suffix = pending.immediate ? "\r" : "";
            h.write(pending.command + suffix);
          }, 250);
        }
      } else {
        terminalRefs.current.delete(leafId);
      }
    },
    [],
  );

  // Wire the "Run in terminal" registry to this hook's tabs + PTY handles.
  // The impl always creates a fresh terminal tab (no surprise execution in
  // a tab the user is already typing in) and queues the command for the
  // new leaf.
  useEffect(() => {
    return registerRunInTerminal(
      (command: string, options?: RunInTerminalOptions) => {
        const { leafId } = newTerminalTabWithLeaf(options?.cwd);
        setTerminalDrawerVisibility(true);
        pendingTerminalWritesRef.current.set(leafId, {
          command,
          immediate: options?.immediate === true,
        });
      },
    );
  }, [newTerminalTabWithLeaf, setTerminalDrawerVisibility]);

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) editorRefs.current.set(id, h);
      else editorRefs.current.delete(id);
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const registerPreviewHandle = useCallback(
    (id: number, h: PreviewPaneHandle | null) => {
      if (h) previewRefs.current.set(id, h);
      else previewRefs.current.delete(id);
    },
    [],
  );

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => setLeafCwd(leafId, cwd),
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      const isLast =
        leafIds(tab.paneTree).length === 1 &&
        all.filter((t) => t.kind === "terminal").length === 1;
      if (isLast) {
        void respawnSession(leafId, tab.cwd);
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    if (isGitHistoryTab && gitHistoryHandle)
      return {
        kind: "git-history",
        handle: gitHistoryHandle,
        focus: () => {},
      };
    return null;
  }, [
    isTerminalTab,
    isEditorTab,
    isGitHistoryTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
    gitHistoryHandle,
  ]);

  const activeCwd = activeTerminalLeafCwd;

  useEffect(() => {
    const findCwd = () => {
      const active = tabs.find((x) => x.id === activeTerminalId);
      if (active?.kind === "terminal") {
        return findLeafCwd(active.paneTree, active.activeLeafId) ?? active.cwd ?? null;
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "terminal") continue;
        const cwd = findLeafCwd(t.paneTree, t.activeLeafId) ?? t.cwd;
        if (cwd) return cwd;
      }
      return explorerRoot ?? launchCwd ?? home ?? null;
    };

    setLive({
      getCwd: findCwd,
      getTerminalContext: () => {
        const t = tabs.find((x) => x.id === activeTerminalId);
        if (t?.kind !== "terminal") return null;
        if (t.private) return null;
        const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
      isActiveTerminalPrivate: () => {
        const t = tabs.find((x) => x.id === activeTerminalId);
        return t?.kind === "terminal" && t.private === true;
      },
      injectIntoActivePty: (text) => {
        const t = tabs.find((x) => x.id === activeTerminalId);
        if (t?.kind !== "terminal") return false;
        const term = terminalRefs.current.get(t.activeLeafId);
        if (!term) return false;
        term.write(text);
        term.focus();
        return true;
      },
      getWorkspaceRoot: () => explorerRoot ?? launchCwd ?? home ?? null,
      getActiveFile: () => {
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "editor" ? t.path : null;
      },
      openPreview: (url: string) => {
        openPreviewTab(url);
        return true;
      },
    });
  }, [
    setLive,
    activeId,
    activeTerminalId,
    tabs,
    explorerRoot,
    launchCwd,
    home,
    openPreviewTab,
  ]);

  const workspaceSurface = (
    <div
      className="relative h-full min-h-0"
      role="tabpanel"
      id={WORKSPACE_PANEL_ID}
      aria-labelledby={tabTriggerId(activeId)}
    >
      {/* Terminal moved to the bottom drawer (#61); see terminalDrawer below. */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col px-3 pt-2 pb-2",
          !isEditorTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isEditorTab}
      >
        {activeTab?.kind === "editor" ? (
          <EditorBreadcrumb path={activeTab.path} root={explorerRoot} />
        ) : null}
        <div className="min-h-0 flex-1">
          <EditorStack
            tabs={tabs}
            activeId={activeId}
            repoRoot={explorerRoot}
            onSelect={setActiveId}
            registerHandle={registerEditorHandle}
            onDirtyChange={handleEditorDirty}
            onCloseTab={disposeTab}
            splitSignal={editorSplit}
            onCanSplitChange={setEditorCanSplit}
          />
        </div>
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isPreviewTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isPreviewTab}
      >
        <PreviewStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerPreviewHandle}
          onUrlChange={handlePreviewUrl}
          onOpenAsWebview={promotePreviewToWebview}
        />
      </div>
      {/* Native child-webview tabs (Colab et al). Padding matches the other
          stacks so the webview lines up with where any tab kind renders.
          pointer-events-none on the host: the actual webview captures input
          natively above HTML — this layer is purely for layout/measurement. */}
      <div
        className="pointer-events-none absolute inset-0 px-3 pt-2 pb-2"
        aria-hidden={!isWebviewTab}
      >
        <WebviewStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isMarkdownTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isMarkdownTab}
      >
        <MarkdownStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isNotebookTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isNotebookTab}
      >
        <NotebookStack
          tabs={tabs}
          activeId={activeId}
          onDirtyChange={handleEditorDirty}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isSettingsTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isSettingsTab}
      >
        <SettingsStack
          tabs={tabs}
          activeId={activeId}
          onSectionChange={(id, section) =>
            setSettingsSection(id, section as SettingsSection)
          }
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isAiDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isAiDiffTab}
      >
        <AiDiffStack
          tabs={tabs}
          activeId={activeId}
          onAccept={(id) => handleAiDiffDecision(id, true)}
          onReject={(id) => handleAiDiffDecision(id, false)}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isGitDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitDiffTab}
      >
        <GitDiffStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isGitHistoryTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitHistoryTab}
      >
        <GitHistoryStack
          tabs={tabs}
          activeId={activeId}
          onOpenCommitFile={openCommitFileDiffTab}
          onSearchHandle={setGitHistoryHandle}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isGitHubItemsTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitHubItemsTab}
      >
        <GitHubItemsStack
          tabs={tabs}
          activeId={activeId}
          onOpenDiff={openGitDiffTab}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isProjectBoardTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isProjectBoardTab}
      >
        <ProjectBoardStack tabs={tabs} activeId={activeId} />
      </div>
      {!activeTab ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
          <span className="text-[13px] font-medium">No file open</span>
          <span className="text-[11.5px]">
            Open a file from the explorer, or toggle the terminal with Cmd/Ctrl+J.
          </span>
        </div>
      ) : null}
    </div>
  );

  // Terminal bottom drawer (#61): the terminal moved out of the main tab
  // surface into a collapsible bottom panel with its own tab strip.
  const terminalTabs = tabs.filter(
    (t): t is TerminalTab => t.kind === "terminal",
  );
  const terminalDrawer = (
    <div className="flex h-full min-h-0 flex-col border-t border-border/60 bg-background">
      <TerminalPanelHeader
        terminals={terminalTabs}
        activeId={activeTerminalId}
        onSelect={setActiveTerminalId}
        onClose={handleClose}
        onNew={openNewTab}
        onHide={() => setTerminalDrawerVisibility(false)}
      />
      <div className="relative min-h-0 flex-1 px-2 py-1.5">
        <TerminalStack
          tabs={tabs}
          activeId={activeTerminalId ?? -1}
          registerHandle={registerTerminalHandle}
          onSearchReady={handleSearchReady}
          onCwd={handleTerminalCwd}
          onExit={handleLeafExit}
          onFocusLeaf={handleFocusLeaf}
        />
      </div>
    </div>
  );

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {/* Sr-only document title anchors the heading outline so screen
              reader users can H-navigate: h1 (global) → h2 (each Settings
              section / AI session) → h3 (sub-blocks). */}
          <h1 className="sr-only">ALTAI workspace</h1>
          {/* Skip links — the first focusable elements on the page. Keyboard
              users can jump straight to the editor or AI panel without
              walking through the ~25 toolbar/sidebar buttons in between.
              Visually hidden until focused; users with `showSkipLinks` on
              keep them visible. */}
          <a href="#altai-main" className="a11y-skip-link">
            Skip to main content
          </a>
          <a
            href="#altai-ai-panel"
            className="a11y-skip-link"
            style={{ left: "12rem" }}
          >
            Skip to AI assistant
          </a>
          <Header
            tabs={mainTabs}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={openNewTab}
            onNewPrivate={openNewPrivateTab}
            onNewPreview={() => openPreviewTab("")}
            onNewEditor={() => setNewEditorOpen(true)}
            onNewGitGraph={openGitGraphFromContext}
            onClose={handleClose}
            onPin={pinTab}
            onToggleSidebar={toggleSidebar}
            onSplit={requestEditorSplit}
            canSplit={editorCanSplit}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onOpenSettings={() => void openSettingsWindow()}
            onToggleAgentSidebar={miniOpen ? closeMini : openMini}
            agentSidebarActive={miniOpen}
            agentSidebarAvailable={true}
            searchTarget={searchTarget}
            searchRef={searchInlineRef}
          />

          <main
            id="altai-main"
            className="zoom-content flex min-h-0 flex-1 flex-col"
          >
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={`${sidebarWidthRef.current}px`}
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                groupResizeBehavior="preserve-pixel-size"
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  if (size.inPixels > 0) persistSidebarWidth(size.inPixels);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                  <SidebarRail
                    activeView={sidebarView}
                    onSelectView={persistSidebarView}
                  />
                  {workspaceFolder ? (
                    <div className="group/ws flex items-center gap-1 border-b border-border/60 px-2 py-1.5">
                      <span
                        className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                        title={workspaceFolder}
                      >
                        {folderName(workspaceFolder)}
                      </span>
                      <button
                        type="button"
                        onClick={closeFolder}
                        title="Close folder — back to welcome"
                        aria-label="Close folder"
                        className="flex size-5 shrink-0 items-center justify-center rounded text-[14px] leading-none text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/ws:opacity-100"
                      >
                        ×
                      </button>
                    </div>
                  ) : null}
                  <div className="min-h-0 flex-1">
                    {sidebarView === "explorer" ? (
                      <FileExplorer
                        ref={explorerRef}
                        rootPath={explorerRoot}
                        gitDecorations={gitDecorations}
                        onOpenFile={handleOpenFile}
                        onPathRenamed={handlePathRenamed}
                        onPathDeleted={handlePathDeleted}
                        onRevealInTerminal={cdInNewTab}
                        onAttachToAgent={handleAttachFileToAgent}
                        onOpenMarkdownPreview={openMarkdownPreview}
                      />
                    ) : (
                      <SourceControlPanel
                        open
                        sourceControl={sourceControl}
                        onOpenDiff={openGitDiffTab}
                        onOpenGitGraph={openGitGraphFromContext}
                        onOpenGitHubItems={openGitHubItemsFromContext}
                        onOpenProjects={openProjectBoardFromContext}
                        onBranchSwitched={handleBranchSwitched}
                      />
                    )}
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle
                withHandle
                aria-label="Resize file explorer"
                title="Resize file explorer (use arrow keys for precise control)"
              />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                <ResizablePanelGroup
                  orientation="vertical"
                  className="h-full min-h-0"
                >
                  <ResizablePanel id="workspace-main" minSize="20%">
                    <div className="relative h-full min-h-0">
                      {workspaceSurface}
                    </div>
                  </ResizablePanel>
                  <ResizableHandle
                    withHandle
                    aria-label="Resize terminal drawer"
                    title="Resize terminal drawer (use arrow keys for precise control)"
                  />
                  <ResizablePanel
                    id="terminal-drawer"
                    panelRef={terminalDrawerRef}
                    defaultSize={
                      terminalDrawerOpen
                        ? `${clampTerminalDrawerHeight(terminalDrawerHeightRef.current)}px`
                        : "0px"
                    }
                    minSize={`${TERMINAL_DRAWER_MIN_HEIGHT}px`}
                    groupResizeBehavior="preserve-pixel-size"
                    collapsible
                    collapsedSize={0}
                    onResize={(size) => {
                      const px = size.inPixels;
                      if (px > 0) {
                        terminalDrawerSeenOpenRef.current = true;
                        persistTerminalDrawerHeight(px);
                        if (!terminalDrawerOpenRef.current) {
                          setTerminalDrawerVisibility(true);
                        }
                      } else if (
                        terminalDrawerOpenRef.current &&
                        terminalDrawerSeenOpenRef.current
                      ) {
                        setTerminalDrawerVisibility(false);
                      }
                    }}
                  >
                    {terminalDrawer}
                  </ResizablePanel>
                </ResizablePanelGroup>
              </ResizablePanel>
              <ResizableHandle
                withHandle
                aria-label="Resize AI panel"
                title="Resize AI panel (use arrow keys for precise control)"
              />
              <ResizablePanel
                id="agent-sidebar"
                panelRef={agentSidebarRef}
                defaultSize={
                  miniOpen
                    ? `${clampAgentSidebarWidth(agentSidebarWidthRef.current)}px`
                    : "0px"
                }
                minSize={`${AGENT_SIDEBAR_MIN_WIDTH}px`}
                groupResizeBehavior="preserve-pixel-size"
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  const px = size.inPixels;
                  // Treat the panel's actual size as the source of truth for the
                  // open state. A viewport shrink can collapse the collapsible
                  // panel to 0 on its own; mirroring that into the store keeps the
                  // toggle button in sync instead of stuck "open" (#62).
                  if (px > 0) {
                    persistAgentSidebarWidth(px);
                    if (!miniOpen) openMini();
                  } else if (miniOpen) {
                    closeMini();
                  }
                }}
              >
                <div className="h-full min-h-0 border-l border-border/60">
                  <AiSidePanel
                    onClose={closeMini}
                    hasComposer={keysLoaded && hasComposer}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          <StatusBar
            cwd={activeCwd}
            filePath={activeFilePath}
            home={home}
            onCd={sendCd}
            onWorkspaceChange={switchWorkspace}
            privateActive={activeTerminalTab?.private === true}
            terminalOpen={terminalDrawerOpen}
            onToggleTerminal={toggleTerminalDrawer}
          />

          {hasComposer ? (
            <AgentRunBridge
              openAiDiffTab={openAiDiffTab}
              closeAiDiffTab={closeAiDiffTab}
            />
          ) : null}

          <AnimatePresence>
            {askPopup ? (
              <SelectionAskAi
                key="ask-ai-popup"
                x={askPopup.x}
                y={askPopup.y}
                onAsk={onAskFromSelection}
                onDismiss={() => setAskPopup(null)}
              />
            ) : null}
          </AnimatePresence>

          <ShortcutsDialog
            open={shortcutsOpen}
            onOpenChange={setShortcutsOpen}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <UpdaterDialog />

          <LiveRegion />

          <AlertDialog
            open={pendingCloseTab !== null}
            onOpenChange={(open) => !open && cancelClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {tabs.find((t) => t.id === pendingCloseTab)?.title
                    ? `"${
                        tabs.find((t) => t.id === pendingCloseTab)?.title
                      }" has unsaved changes. Close anyway?`
                    : "This file has unsaved changes. Close anyway?"}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={pendingDeleteTabs !== null}
            onOpenChange={(open) => !open && cancelDeleteClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDeleteTabs?.length === 1
                    ? (() => {
                        const title = tabs.find(
                          (t) => t.id === pendingDeleteTabs[0],
                        )?.title;
                        return title
                          ? `"${title}" has unsaved changes. The file has been deleted. Close anyway?`
                          : "This file has unsaved changes. The file has been deleted. Close anyway?";
                      })()
                    : `${pendingDeleteTabs?.length ?? 0} files have unsaved changes. They have been deleted. Close all anyway?`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelDeleteClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmDeleteClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}
