import type { UIMessage } from "ai";
import { native } from "../lib/native";
import { create } from "zustand";
import {
  DEFAULT_MODEL_ID,
  getModel,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
} from "../config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceFolder } from "@/modules/workspace/folder";
import { useAgentsStore } from "./agentsStore";
import { useTodosStore } from "./todoStore";
import type { AgentUsage } from "../lib/provider";
import {
  resolveCompactionSpec,
  resolveFallbackSpec,
  resolveIsanAgentTarget,
} from "../lib/isanagentTarget";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys } from "../lib/keyring";
import {
  deleteSessionData,
  deriveTitle,
  loadAll,
  loadMessages,
  mergeBackendSessions,
  newSessionId,
  saveActiveId,
  saveDeletedIds,
  saveMessages,
  saveSessionsList,
  type SessionMeta,
} from "../lib/sessions";
import { pushRecentModel } from "../lib/modelPrefs";
import { appendBackgroundMessage } from "../lib/backgroundTranscript";
import {
  combineAgentInstructions,
  readProjectInstructions,
} from "../lib/projectInstructions";
import { effectivePermissionMode, setDefaultModel } from "@/modules/settings/store";
import type { AssignmentRunConfig } from "@/modules/github/lib/assignments";

type Live = {
  getCwd: () => string | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openPreview: (url: string) => boolean;
};

export type AgentRunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

/** A subagent task currently dispatched by the main agent. */
export type SubagentTask = {
  taskId: string;
  childChatId: string;
  /** Human-facing label (e.g. "Researcher"), if the agent provided one. */
  displayName: string | null;
  /** Named agent the task runs as (e.g. "researcher", "coder"), if any. */
  agentName: string | null;
};

/** An action awaiting a user decision, mirrored from the native event stream. */
export type PendingApproval = {
  id: string;
  action: string;
  payload: unknown;
};

/** A compact, current-session audit trail for the task inspector. */
export type AgentActivity = {
  id: string;
  label: string;
  detail?: string;
  kind?: "tool" | "research" | "mcp" | "execution" | "agent" | "approval" | "system";
  tone?: "default" | "success" | "warning" | "error";
  createdAt: number;
};

/** A file or result emitted by a runtime experiment, available to inspect. */
export type AgentArtifact = {
  id: string;
  path: string;
  experimentId: string;
  createdAt: number;
};

export type AgentMeta = {
  status: AgentRunStatus;
  step: string | null;
  approvalsPending: number;
  pendingApprovals: PendingApproval[];
  activity: AgentActivity[];
  artifacts: AgentArtifact[];
  error: string | null;
  tokens: AgentUsage;
  lastInputTokens: number;
  lastCachedTokens: number;
  /** Subagent tasks running right now, surfaced as a live indicator. */
  activeSubagents: SubagentTask[];
};

const ZERO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

const IDLE_META: AgentMeta = {
  status: "idle",
  step: null,
  approvalsPending: 0,
  pendingApprovals: [],
  activity: [],
  artifacts: [],
  error: null,
  tokens: ZERO_USAGE,
  lastInputTokens: 0,
  lastCachedTokens: 0,
  activeSubagents: [],
};

export type MiniState = {
  open: boolean;
  /**
   * Element that had focus when the panel was opened. Focus is restored to
   * it on close so keyboard/AT users aren't orphaned to <body> (a11y D4).
   */
  opener?: HTMLElement | null;
};

export type PendingSelection = {
  id: string;
  text: string;
  source: "terminal" | "editor";
};

type StoreState = {
  live: Live;
  setLive: (live: Live) => void;

  /**
   * Resolve a pending tool approval. Routes directly to the native
   * IsanAgent runtime; surfaces anywhere (chat transcript, AI diff tab in
   * the editor area) call this with the approval id.
   */
  respondToApproval: (approvalId: string, approved: boolean) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  selectedModelId: ModelId;
  setSelectedModelId: (id: ModelId) => void;

  mini: MiniState;
  openMini: () => void;
  closeMini: () => void;
  toggleMini: () => void;

  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  focusSignal: number;
  pendingPrefill: string | null;
  focusInput: (prefill?: string | null) => void;
  consumePrefill: () => string | null;

  pendingSelections: PendingSelection[];
  attachSelection: (text: string, source: "terminal" | "editor") => void;
  consumeSelections: () => PendingSelection[];

  agentMeta: AgentMeta;
  patchAgentMeta: (patch: Partial<AgentMeta>) => void;
  resetAgentMeta: () => void;
  /** Track a newly spawned subagent task (de-duplicated by taskId). */
  addSubagentTask: (task: SubagentTask) => void;
  /** Drop a subagent task once it reaches a terminal state. */
  removeSubagentTask: (taskId: string) => void;
  /** Mirror a native approval request so it can be actioned outside the transcript. */
  addApproval: (approval: PendingApproval) => void;
  removeApproval: (approvalId: string) => void;
  /** Add a bounded item to the focused task's in-memory activity timeline. */
  addActivity: (activity: Omit<AgentActivity, "id" | "createdAt">) => void;
  addArtifacts: (input: { experimentId: string; paths: string[] }) => void;

  /** Messages from the IsanAgent runtime, rendered as UIMessage parts. */
  nativeMessages: UIMessage[];
  appendNativeMessage: (content: string, role: string) => void;
  clearNativeMessages: () => void;

  /**
   * Preset answers for a pending `ask_user` clarification, surfaced as
   * clickable chips. `null` when no clarification is open. Cleared when the
   * user sends any message (a reply resolves the clarification) or switches
   * sessions.
   */
  pendingChoices: string[] | null;
  setPendingChoices: (choices: string[] | null) => void;

  /**
   * Structured file-edit diff attached to a clarification when the agent's
   * edit gate requests approval (crate `interactive_edit_mode = Ask`). When
   * present, the chat renders a diff-review card instead of the plain choice
   * chips. The reply path is identical to a normal clarification — the user
   * sends `approve` / `deny` as a message and the `ClarificationHub` routes it
   * back to the waiting tool.
   */
  pendingEditDiff: {
    file: string;
    diff: string;
    truncated: boolean;
  } | null;
  setPendingEditDiff: (
    diff: { file: string; diff: string; truncated: boolean } | null,
  ) => void;
  /** Clear BOTH `pendingChoices` and `pendingEditDiff` in one step. The two
   *  are always set together from a clarification event and resolve together
   *  when the user replies — this is the single chokepoint so every reset
   *  site (session switch, rewind, send) clears both atomically instead of
   *  each site re-stating the two-field reset by hand (drift-prone). */
  resetPendingClarification: () => void;

  /**
   * Id of the assistant `UIMessage` that is currently accumulating parts
   * for the in-flight turn. Tool calls + interleaved text from the native
   * runtime collapse into this message so the UI renders one bubble with
   * inline tool entries instead of fragmenting per event.
   *
   * `null` when no turn is in flight — the next assistant event opens a
   * fresh message.
   */
  currentAssistantTurnId: string | null;
  startNativeToolCall: (
    toolCallId: string,
    toolName: string,
    input: unknown,
  ) => void;
  endNativeToolCall: (
    toolCallId: string,
    output: unknown,
    errorText?: string,
  ) => void;
  closeAssistantTurn: () => void;

  /** Whether the Paper Import panel is open in the input bar. */
  paperImportOpen: boolean;
  setPaperImportOpen: (open: boolean) => void;

  // Sessions
  sessionsHydrated: boolean;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  hydrateSessions: () => Promise<void>;
  newSession: () => string;
  /** Create a titled session WITHOUT focusing it (no active-session change,
   *  no transcript reset) — for background agent dispatch from the board. */
  createBackgroundSession: (title: string) => string;
  switchSession: (id: string) => void;
  /** Move a session immediately before or after another session. */
  reorderSessions: (id: string, targetId: string, after: boolean) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openPreview: () => false,
};

// Trailing debounce for per-token message persistence. Streaming mutates
// `nativeMessages` on every event; without this we'd JSON-serialize the
// full message array and round-trip to the store plugin per event, which
// stalls the UI. Flush on idle (status transition) via `flushPersist`.
const PERSIST_DEBOUNCE_MS = 300;
const pendingPersist = new Map<
  string,
  { latest: UIMessage[]; timer: ReturnType<typeof setTimeout> }
>();

// Message arrays freshly hydrated from disk. The persistence subscription
// skips these once — re-writing a thread we just read back is pure waste.
const loadedMessagesRefs = new WeakSet<UIMessage[]>();

// Sessions the user permanently deleted. Kept out of the history list and
// used to suppress backend recovery so a deleted chat doesn't resurrect.
const deletedSessionIds = new Set<string>();

// Fingerprint of the runtime config we last successfully started. Lets us skip
// the per-message `agent_start` IPC when nothing changed (the Rust side no-ops
// on an identical fingerprint anyway). Reset to null on any start/send failure
// so a dead runtime is always restarted on the next attempt.
let lastStartFingerprint: string | null = null;

function flushPersistEntry(id: string) {
  const entry = pendingPersist.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingPersist.delete(id);
  void saveMessages(id, entry.latest);
}

export function flushPersist(id?: string): void {
  if (id) {
    flushPersistEntry(id);
    return;
  }
  for (const key of Array.from(pendingPersist.keys())) flushPersistEntry(key);
}

/**
 * Persist a session's native message thread (debounced) and refresh its
 * derived title. This is the replacement for the former Vercel-SDK
 * `Chat`-instance persistence: `nativeMessages` is now the single source of
 * truth, so we save it directly whenever it changes (see the store
 * subscription below).
 */
function persistNativeMessages(id: string, messages: UIMessage[]): void {
  const existing = pendingPersist.get(id);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const entry = pendingPersist.get(id);
    if (!entry) return;
    pendingPersist.delete(id);
    void saveMessages(id, entry.latest);
  }, PERSIST_DEBOUNCE_MS);
  pendingPersist.set(id, { latest: messages, timer });

  // Update the session list only when the derived title actually changes —
  // otherwise we'd rewrite the sessions array (and trigger re-renders + a
  // store write) on every streamed event.
  const state = useChatStore.getState();
  const meta = state.sessions.find((s) => s.id === id);
  if (!meta) return;
  const isUntitled = !meta.title || meta.title === "New chat";
  if (!isUntitled) return;
  const nextTitle = deriveTitle(messages);
  if (nextTitle === meta.title) return;
  const next = state.sessions.map((s) =>
    s.id === id ? { ...s, title: nextTitle, updatedAt: Date.now() } : s,
  );
  useChatStore.setState({ sessions: next });
  void saveSessionsList(next);
}

export const useChatStore = create<StoreState>((set, get) => ({
  live: NOOP_LIVE,
  setLive: (live) => set({ live }),

  respondToApproval: (approvalId, approved) => {
    const approval = get().agentMeta.pendingApprovals.find(
      (item) => item.id === approvalId,
    );
    get().removeApproval(approvalId);
    get().addActivity({
      label: approved ? "Approved action" : "Denied action",
      detail: approval?.action,
      tone: approved ? "success" : "warning",
    });
    void native.agentApprove(approvalId, approved).catch((cause) => {
      if (approval) {
        get().addApproval(approval);
      }

      get().addActivity({
        label: "Approval response failed",
        detail: cause instanceof Error ? cause.message : String(cause),
        tone: "error",
      });
      get().patchAgentMeta({
        status: "error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
  },

  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  setApiKeys: (keys) => set({ apiKeys: keys }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
  },

  selectedModelId: DEFAULT_MODEL_ID,
  setSelectedModelId: (id) => {
    const prev = get().selectedModelId;
    if (prev === id) return;
    set({ selectedModelId: id });
    void pushRecentModel(id);
    // Persist the picked model so it survives an app restart. The dedup
    // guard above keeps the App.tsx hydrate path (which mirrors
    // preferences → chatStore on boot and on cross-window events) from
    // writing the same value back through `setDefaultModel`.
    void setDefaultModel(id);
  },

  mini: { open: false },
  openMini: () =>
    set((s) => {
      // Capture the opener so we can restore focus on close (a11y D4).
      // Only record on a real open transition; ignore re-opens.
      if (s.mini.open) return s;
      const opener =
        typeof document !== "undefined"
          ? (document.activeElement as HTMLElement | null)
          : null;
      return { mini: { open: true, opener } };
    }),
  closeMini: () =>
    set((s) => {
      const { opener } = s.mini;
      // Restore focus to the element that opened the panel, if it's still
      // in the document; otherwise leave focus where it is (a11y D4).
      if (opener && document.contains(opener)) {
        opener.focus?.();
      }
      return { mini: { open: false, opener: null } };
    }),
  toggleMini: () => {
    const s = get();
    if (s.mini.open) s.closeMini();
    else s.openMini();
  },

  panelOpen: false,
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  focusSignal: 0,
  pendingPrefill: null,
  focusInput: (prefill = null) =>
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingPrefill: prefill ?? null,
    })),
  consumePrefill: () => {
    const v = get().pendingPrefill;
    if (v != null) set({ pendingPrefill: null });
    return v;
  },

  pendingSelections: [],
  attachSelection: (text, source) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingSelections: [...s.pendingSelections, { id, text: trimmed, source }],
    }));
  },
  consumeSelections: () => {
    const v = get().pendingSelections;
    if (v.length > 0) set({ pendingSelections: [] });
    return v;
  },

  agentMeta: IDLE_META,
  patchAgentMeta: (patch) =>
    set((s) => ({ agentMeta: { ...s.agentMeta, ...patch } })),
  resetAgentMeta: () => set({ agentMeta: IDLE_META }),
  addSubagentTask: (task) =>
    set((s) => {
      if (s.agentMeta.activeSubagents.some((t) => t.taskId === task.taskId)) {
        return {};
      }
      return {
        agentMeta: {
          ...s.agentMeta,
          activeSubagents: [...s.agentMeta.activeSubagents, task],
        },
      };
    }),
  removeSubagentTask: (taskId) =>
    set((s) => ({
      agentMeta: {
        ...s.agentMeta,
        activeSubagents: s.agentMeta.activeSubagents.filter(
          (t) => t.taskId !== taskId,
        ),
      },
    })),
  addApproval: (approval) =>
    set((s) => {
      if (s.agentMeta.pendingApprovals.some((item) => item.id === approval.id)) {
        return {};
      }
      const pendingApprovals = [...s.agentMeta.pendingApprovals, approval];
      return {
        agentMeta: {
          ...s.agentMeta,
          status: "awaiting-approval",
          pendingApprovals,
          approvalsPending: pendingApprovals.length,
        },
      };
    }),
  removeApproval: (approvalId) =>
    set((s) => {
      const pendingApprovals = s.agentMeta.pendingApprovals.filter(
        (item) => item.id !== approvalId,
      );
      return {
        agentMeta: {
          ...s.agentMeta,
          pendingApprovals,
          approvalsPending: pendingApprovals.length,
          status:
            pendingApprovals.length === 0 && s.agentMeta.status === "awaiting-approval"
              ? "thinking"
              : s.agentMeta.status,
        },
      };
    }),
  addActivity: (activity) =>
    set((s) => {
      const next = [
        ...s.agentMeta.activity,
        {
          ...activity,
          id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: Date.now(),
        },
      ].slice(-80);
      return { agentMeta: { ...s.agentMeta, activity: next } };
    }),
  addArtifacts: ({ experimentId, paths }) =>
    set((s) => {
      const existing = new Set(s.agentMeta.artifacts.map((item) => item.id));
      const additions = paths
        .filter((path) => path.trim().length > 0)
        .map((path, index) => ({
          id: `${experimentId}:${path}:${index}`,
          path,
          experimentId,
          createdAt: Date.now(),
        }))
        .filter((item) => !existing.has(item.id));
      if (!additions.length) return {};
      return {
        agentMeta: {
          ...s.agentMeta,
          artifacts: [...s.agentMeta.artifacts, ...additions].slice(-80),
        },
      };
    }),

  nativeMessages: [],
  currentAssistantTurnId: null,
  appendNativeMessage: (content, role) => {
    const validRole = (role === "user" || role === "assistant")
      ? role
      : "assistant";

    // User turn closes any in-flight assistant turn so the next assistant
    // event begins a fresh bubble. New user messages are always appended
    // as their own UIMessage.
    if (validRole === "user") {
      const id = `native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msg: UIMessage = {
        id,
        role: "user",
        parts: [{ type: "text", text: content }],
      };
      set((s) => ({
        nativeMessages: [...s.nativeMessages, msg],
        currentAssistantTurnId: null,
      }));
      return;
    }

    // Assistant content folds into the current turn so text emitted
    // before/after tool calls stays inside the same bubble. If no turn
    // is open we mint a new assistant UIMessage and remember its id.
    set((s) => {
      const turnId = s.currentAssistantTurnId;
      if (turnId) {
        const next = s.nativeMessages.map((m) =>
          m.id === turnId
            ? {
                ...m,
                parts: [
                  ...m.parts,
                  { type: "text" as const, text: content },
                ],
              }
            : m,
        );
        return { nativeMessages: next };
      }
      const id = `native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msg: UIMessage = {
        id,
        role: "assistant",
        parts: [{ type: "text", text: content }],
      };
      return {
        nativeMessages: [...s.nativeMessages, msg],
        currentAssistantTurnId: id,
      };
    });
  },
  startNativeToolCall: (toolCallId, toolName, input) => {
    // Cast to the loose UIMessagePart shape — `dynamic-tool` lives in
    // the ai-sdk type space and isn't worth importing through here just
    // for one assignment. AiChat.tsx renders any part whose `type`
    // starts with "tool-" or equals "dynamic-tool", so the shape below
    // matches what `RenderedTool` expects.
    const toolPart = {
      type: "dynamic-tool" as const,
      toolName,
      toolCallId,
      state: "input-available" as const,
      input,
    } as unknown as UIMessage["parts"][number];

    set((s) => {
      const turnId = s.currentAssistantTurnId;
      if (turnId) {
        const next = s.nativeMessages.map((m) =>
          m.id === turnId
            ? { ...m, parts: [...m.parts, toolPart] }
            : m,
        );
        return { nativeMessages: next };
      }
      const id = `native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msg: UIMessage = {
        id,
        role: "assistant",
        parts: [toolPart],
      };
      return {
        nativeMessages: [...s.nativeMessages, msg],
        currentAssistantTurnId: id,
      };
    });
  },
  endNativeToolCall: (toolCallId, output, errorText) => {
    set((s) => {
      // Walk from the end — the part we just completed is almost always
      // on the most recent assistant message. Bail out untouched if no
      // match (shouldn't happen, but the bridge is best-effort).
      let touched = false;
      const nextMessages = s.nativeMessages.map((m) => {
        if (touched) return m;
        const idx = m.parts.findIndex(
          (p) =>
            (p as { toolCallId?: string }).toolCallId === toolCallId,
        );
        if (idx === -1) return m;
        touched = true;
        const updatedPart = {
          ...(m.parts[idx] as object),
          state: errorText ? "output-error" : "output-available",
          ...(errorText ? { errorText } : { output }),
        } as unknown as UIMessage["parts"][number];
        const nextParts = [...m.parts];
        nextParts[idx] = updatedPart;
        return { ...m, parts: nextParts };
      });
      return touched ? { nativeMessages: nextMessages } : {};
    });
  },
  closeAssistantTurn: () => set({ currentAssistantTurnId: null }),
  clearNativeMessages: () =>
    set({ nativeMessages: [], currentAssistantTurnId: null }),

  pendingChoices: null,
  setPendingChoices: (choices) => {
    const next = choices && choices.length > 0 ? choices : null;
    // Clearing the choices also clears the edit-diff card — the two are
    // always set together from a clarification event and resolve together
    // when the user replies. Routed through `resetPendingClarification` so
    // there is exactly one chokepoint for the two-field reset.
    if (next === null) {
      set({ pendingChoices: null, pendingEditDiff: null });
    } else {
      set({ pendingChoices: next });
    }
  },

  pendingEditDiff: null,
  setPendingEditDiff: (diff) => set({ pendingEditDiff: diff }),
  resetPendingClarification: () =>
    set({ pendingChoices: null, pendingEditDiff: null }),

  paperImportOpen: false,
  setPaperImportOpen: (open) => set({ paperImportOpen: open }),

  sessionsHydrated: false,
  sessions: [],
  activeSessionId: null,

  hydrateSessions: async () => {
    if (get().sessionsHydrated) return;
    let { sessions, activeId, deletedIds } = await loadAll();
    deletedSessionIds.clear();
    for (const id of deletedIds) deletedSessionIds.add(id);

    // Reconcile with the backend memory DB — the durable source of truth.
    // Chats that were closed (dropped from this ephemeral store) but still
    // exist in the agent's history are recovered here so they reappear in the
    // chat-history list (Claude Code / Cursor behavior). Best-effort:
    // a backend error must not block hydration. Permanently-deleted ids are
    // suppressed so they don't come back.
    const { merged, recoveredIds } = await mergeBackendSessions(
      sessions,
      [...deletedSessionIds],
    );
    sessions = merged;
    if (recoveredIds.length > 0) {
      void saveSessionsList(merged);
    }

    // Pick the session to land on after restart. Prefer the last-used one
    // (persisted activeId) if it still exists, so the user returns to their
    // most recent conversation instead of an empty "New chat". Else reuse the
    // most recent untitled "New chat" (no point stacking empty placeholders
    // every launch), else create a fresh one.
    let active =
      (activeId ? sessions.find((s) => s.id === activeId) : undefined) ?? null;
    if (!active && sessions[0]?.title === "New chat") {
      active = sessions[0];
    }
    let nextSessions: SessionMeta[];
    if (active) {
      nextSessions = sessions;
    } else {
      active = {
        id: newSessionId(),
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      nextSessions = [active, ...sessions];
      void saveSessionsList(nextSessions);
    }
    const activeSessionId = active.id;
    void saveActiveId(activeSessionId);

    set({
      sessions: nextSessions,
      activeSessionId,
      sessionsHydrated: true,
    });

    // Restore the active session's thread so the conversation reappears on
    // reopen instead of an empty transcript. Guarded so a manual switch that
    // lands elsewhere before this resolves wins (same shape as switchSession).
    void loadMessages(activeSessionId).then((m) => {
      if (get().activeSessionId !== activeSessionId) return;
      const loaded = m ?? [];
      loadedMessagesRefs.add(loaded);
      set({ nativeMessages: loaded });
    });
  },

  newSession: () => {
    const id = newSessionId();
    const meta: SessionMeta = {
      id,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const current = get().sessions;
    const activeIdx = current.findIndex(
      (s) => s.id === get().activeSessionId,
    );
    const next =
      activeIdx === -1
        ? [...current, meta]
        : [
            ...current.slice(0, activeIdx + 1),
            meta,
            ...current.slice(activeIdx + 1),
          ];
    set({
      sessions: next,
      activeSessionId: id,
      agentMeta: IDLE_META,
      nativeMessages: [],
      currentAssistantTurnId: null,
      pendingChoices: null,
      pendingEditDiff: null,
    });
    void saveSessionsList(next);
    void saveActiveId(id);
    return id;
  },

  createBackgroundSession: (title) => {
    const id = newSessionId();
    const meta: SessionMeta = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const next = [...get().sessions, meta];
    set({ sessions: next });
    void saveSessionsList(next);
    return id;
  },

  switchSession: (id) => {
    const prevId = get().activeSessionId;
    if (prevId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;

    // Persist the tail of the session we're leaving before swapping in the
    // target session's thread, so a debounced write in flight isn't lost.
    if (prevId) flushPersist(prevId);

    // Switch synchronously so the UI reflects the active session immediately.
    // The message thread loads asynchronously and is applied only if we're
    // still on this session — rapid A→B→A switches must not cross-populate.
    set({
      activeSessionId: id,
      agentMeta: IDLE_META,
      nativeMessages: [],
      currentAssistantTurnId: null,
      pendingChoices: null,
      pendingEditDiff: null,
    });
    void saveActiveId(id);

    void loadMessages(id).then((m) => {
      if (get().activeSessionId !== id) return;
      const loaded = m ?? [];
      loadedMessagesRefs.add(loaded);
      set({ nativeMessages: loaded });
    });
  },

  reorderSessions: (id, targetId, after) => {
    if (id === targetId) return;
    const current = get().sessions;
    const moved = current.find((session) => session.id === id);
    if (!moved || !current.some((session) => session.id === targetId)) return;

    const withoutMoved = current.filter((session) => session.id !== id);
    const targetIndex = withoutMoved.findIndex(
      (session) => session.id === targetId,
    );
    const next = [...withoutMoved];
    next.splice(targetIndex + (after ? 1 : 0), 0, moved);
    set({ sessions: next });
    void saveSessionsList(next);
  },

  deleteSession: (id) => {
    const remaining = get().sessions.filter((s) => s.id !== id);
    const pend = pendingPersist.get(id);
    if (pend) {
      clearTimeout(pend.timer);
      pendingPersist.delete(id);
    }
    void deleteSessionData(id);
    void useTodosStore.getState().clearSession(id);
    // Permanent delete: blocklist the id so the backend recovery pass on the
    // next launch doesn't resurrect this chat from the durable memory DB.
    deletedSessionIds.add(id);
    void saveDeletedIds([...deletedSessionIds]);

    if (remaining.length === 0) {
      const fresh: SessionMeta = {
        id: newSessionId(),
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      set({
        sessions: [fresh],
        activeSessionId: fresh.id,
        agentMeta: IDLE_META,
        nativeMessages: [],
        currentAssistantTurnId: null,
        pendingChoices: null,
        pendingEditDiff: null,
      });
      void saveSessionsList([fresh]);
      void saveActiveId(fresh.id);
      return;
    }

    const wasActive = get().activeSessionId === id;
    // remaining is non-empty here (the empty case returned above), so
    // remaining[0] is defined whenever we deleted the active session.
    const nextActive = wasActive ? remaining[0].id : get().activeSessionId;
    if (wasActive) {
      // Clear the deleted session's thread synchronously so its messages don't
      // linger on screen while the next session's thread loads asynchronously.
      set({
        sessions: remaining,
        activeSessionId: nextActive,
        agentMeta: IDLE_META,
        nativeMessages: [],
        currentAssistantTurnId: null,
        pendingChoices: null,
        pendingEditDiff: null,
      });
    } else {
      set({ sessions: remaining });
    }
    void saveSessionsList(remaining);
    if (wasActive && nextActive) {
      void saveActiveId(nextActive);
      void loadMessages(nextActive).then((m) => {
        // Guard against a rapid switch landing elsewhere before this resolves.
        if (get().activeSessionId !== nextActive) return;
        const loaded = m ?? [];
        loadedMessagesRefs.add(loaded);
        set({ nativeMessages: loaded });
      });
    }
  },

  renameSession: (id, title) => {
    const next = get().sessions.map((s) =>
      s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },
}));

// Persist the native message thread of the active session whenever it
// changes. `nativeMessages` is the single source of truth, so this is the
// only place conversation history is written to disk.
useChatStore.subscribe((state, prev) => {
  // A session switch swaps both activeSessionId and nativeMessages in one
  // update; persistence/hydration for that path is handled explicitly in the
  // session actions, so skip it here (also avoids a spurious empty-write).
  if (state.activeSessionId !== prev.activeSessionId) return;
  if (state.nativeMessages === prev.nativeMessages) return;
  // A thread just hydrated from disk — don't write it straight back.
  if (loadedMessagesRefs.has(state.nativeMessages)) {
    loadedMessagesRefs.delete(state.nativeMessages);
    return;
  }
  const id = state.activeSessionId;
  if (!id) return;
  persistNativeMessages(id, state.nativeMessages);
});

/** Plain-text body of a user message (text parts joined). */
function userMessageText(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Keep the transcript through the `keep`-th user message (1-based, inclusive),
 * drop everything after it. `keep <= 0` returns an empty thread. If the thread
 * has fewer than `keep` user messages, returns the whole thread unchanged
 * (matches the backend no-op). Mirrors `TruncateAfterUserMessage` so the
 * frontend transcript stays in sync after a rewind.
 */
function cutThroughNthUser(messages: UIMessage[], keep: number): UIMessage[] {
  if (keep <= 0) return [];
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") seen++;
    if (seen >= keep) return messages.slice(0, i + 1);
  }
  return messages.slice();
}

/**
 * Rewind the active chat to `keepUserMessages` user turns on the backend (the
 * durable source of truth), mirror the trim on the frontend, then resend `text`
 * as a fresh user turn. Powers conversation retry / edit — the backend owns the
 * history, so the discard has to happen there before the resend.
 *
 * Returns sendMessage's result (false if dispatch failed). A failed backend
 * rewind aborts without touching the frontend transcript.
 */
async function rewindAndResend(
  sessionId: string,
  keepUserMessages: number,
  text: string,
): Promise<boolean> {
  const workspacePath = currentWorkspaceFolder() ?? undefined;
  // Stop any in-flight run first so its events don't land on the trimmed thread.
  try {
    await native.agentCancel(sessionId);
  } catch {
    /* best-effort: an idle chat has nothing to cancel */
  }
  try {
    await native.agentTruncateAfterUserMessage(
      sessionId,
      keepUserMessages,
      workspacePath,
    );
  } catch (cause) {
    useChatStore.getState().addActivity({
      label: "Failed to modify history",
      detail: cause instanceof Error ? cause.message : String(cause),
      tone: "error",
    });
    return false;
  }
  const cut = cutThroughNthUser(
    useChatStore.getState().nativeMessages,
    keepUserMessages,
  );
  useChatStore.setState({
    nativeMessages: cut,
    currentAssistantTurnId: null,
    pendingChoices: null,
    pendingEditDiff: null,
    agentMeta: IDLE_META,
  });
  // Force-flush so a crash before the debounce can't leave the frontend store
  // holding the pre-rewind (longer) thread while the backend already rewound.
  flushPersist(sessionId);
  return sendMessage(text);
}

/**
 * Regenerate the assistant's last response: rewind the active chat to just
 * before its last user message and resend that message as a fresh turn.
 */
export async function retryLastMessage(): Promise<boolean> {
  const { nativeMessages, activeSessionId } = useChatStore.getState();
  if (!activeSessionId) return false;
  let lastUserId: string | null = null;
  let userCount = 0;
  for (const m of nativeMessages) {
    if (m.role === "user") {
      userCount++;
      lastUserId = m.id;
    }
  }
  if (!lastUserId || userCount === 0) return false;
  const lastUser = nativeMessages.find((m) => m.id === lastUserId);
  const text = lastUser ? userMessageText(lastUser) : "";
  if (!text.trim()) return false;
  return rewindAndResend(activeSessionId, userCount - 1, text);
}

/**
 * Edit a previous user message and resend: rewind to just before it, then send
 * the edited text as a fresh user turn. Everything after the edited message
 * (its old response and any later turns) is discarded.
 */
export async function editUserMessage(
  messageId: string,
  text: string,
): Promise<boolean> {
  const { nativeMessages, activeSessionId } = useChatStore.getState();
  if (!activeSessionId) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  let userIndex = 0;
  let found = false;
  for (const m of nativeMessages) {
    if (m.role === "user") userIndex++;
    if (m.id === messageId) {
      found = true;
      break;
    }
  }
  if (!found || userIndex === 0) return false;
  return rewindAndResend(activeSessionId, userIndex - 1, trimmed);
}

export function getAgentMeta(): AgentMeta {
  return useChatStore.getState().agentMeta;
}

export function getActiveProviderKey(): string | null {
  const { selectedModelId, apiKeys } = useChatStore.getState();
  return apiKeys[getModel(selectedModelId).provider] ?? null;
}

export function hasKeyForModel(modelId: ModelId): boolean {
  const { apiKeys } = useChatStore.getState();
  const provider = getModel(modelId).provider;
  return providerNeedsKey(provider) ? !!apiKeys[provider] : true;
}

export async function sendMessage(
  text: string,
  images?: string[],
  documents?: { data: string; mediaType: string; name: string }[],
): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;

  // Sending any message resolves an open clarification, so clear its chips.
  // Clear any pending clarification (choices and/or an edit-approval diff
  // card) — sending a message resolves the `ask_user` wait in the crate, so
  // the chip/diff state must go away regardless of which kind it was. The
  // guard fires on either field so an edit-approval clarification that
  // carried no preset choices still unmounts the EditApprovalCard.
  if (state.pendingChoices || state.pendingEditDiff) {
    state.setPendingChoices(null);
  }

  // The ALTAI session id IS the runtime chat_id — keeps each tab's
  // conversation isolated and lets the event bridge route by chat.
  return sendViaIsanAgent(text, sessionId, images, documents);
}

async function sendViaIsanAgent(
  text: string,
  chatId: string,
  images?: string[],
  documents?: { data: string; mediaType: string; name: string }[],
): Promise<boolean> {
  const store = useChatStore.getState();

  // Resolve the target (provider + model + base URL + key) from the
  // model picker. The hardcoded "first key wins" mapping used to ignore
  // the user's selection — pick a model in the UI and IsanAgent now
  // actually targets it.
  const prefs = usePreferencesStore.getState();
  const selectedModelId = store.selectedModelId;
  const resolution = resolveIsanAgentTarget(selectedModelId, store.apiKeys, {
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    lmstudioModelId: prefs.lmstudioModelId,
    mlxBaseURL: prefs.mlxBaseURL,
    mlxModelId: prefs.mlxModelId,
    openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    openaiCompatibleModelId: prefs.openaiCompatibleModelId,
  });
  if (!resolution.ok) {
    store.patchAgentMeta({ status: "error", error: resolution.error });
    return false;
  }
  const { providerName, apiKey, modelName, baseUrl } = resolution.target;

  // Pass the active agent's instructions through so IsanAgent honors the
  // selected persona (Coder, Architect, custom agents, etc.). The runtime
  // captures this at first-start; switching agents mid-session does not
  // yet reapply — that needs a runtime restart and lives in a follow-up.
  const agentsState = useAgentsStore.getState();
  const activeAgent = agentsState.all().find((a) => a.id === agentsState.activeId);

  // IsanAgent roots its workspace (memory/sandbox/config) at
  // `<workspaceFolder>/.isanagent`. Passing it keeps each project's agent
  // state with the project instead of under ~/.isanagent.
  const workspacePath = currentWorkspaceFolder() ?? undefined;
  const instructions = combineAgentInstructions(
    activeAgent?.instructions?.trim() || undefined,
    await readProjectInstructions(workspacePath),
  );

  // The active permission mode gates code-exec / destructive-shell in the
  // runtime (maps to IsanAgent's shell policy). Mirror the switcher's guard:
  // "bypass" falls back to "ask" when bypass is not enabled in Settings, so a stale selection
  // can never silently disable the gate (shared invariant with PermissionModeSwitcher).
  const permissionMode = effectivePermissionMode(
    prefs.permissionMode,
    prefs.bypassPermissionsEnabled,
  );

  // Configured failover model. The runtime refreshes its process-global
  // fallback list per send so the agent retries here when the primary provider
  // is exhausted; null when no failover model is set or it can't be resolved.
  const fallback = resolveFallbackSpec(prefs.fallbackModelId, store.apiKeys, {
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    lmstudioModelId: prefs.lmstudioModelId,
    mlxBaseURL: prefs.mlxBaseURL,
    mlxModelId: prefs.mlxModelId,
    openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    openaiCompatibleModelId: prefs.openaiCompatibleModelId,
  });

  // Context-condensing config. Threshold percent → tokens via the active
  // model's context window (percent wins when set). Threaded end-to-end so
  // a Settings change rebuilds the runtime on next send (the Rust side
  // fingerprints it).
  const compaction = resolveCompactionSpec(
    {
      compactionAuto: prefs.compactionAuto,
      compactionThresholdPercent: prefs.compactionThresholdPercent,
      compactionThresholdTokens: prefs.compactionThresholdTokens,
      compactionTailTurns: prefs.compactionTailTurns,
    },
    selectedModelId,
    prefs.openaiCompatibleContextLimit,
  );

  // Only (re)start the runtime when the target config actually changes —
  // avoids a redundant IPC round-trip on every message. Mirrors the fields
  // the Rust runtime fingerprints (provider, key, model, base URL, persona,
  // workspace root, permission mode, compaction).
  const startFingerprint = JSON.stringify([
    providerName,
    apiKey,
    modelName,
    baseUrl ?? "",
    instructions ?? "",
    workspacePath ?? "",
    permissionMode,
    compaction.auto,
    compaction.thresholdTokens,
    compaction.tailTurns,
  ]);
  if (startFingerprint !== lastStartFingerprint) {
    try {
      await native.agentStart({
        providerName,
        apiKey,
        modelName,
        instructions,
        baseUrl,
        workspacePath,
        permissionMode,
        compaction,
      });
      lastStartFingerprint = startFingerprint;
    } catch (e) {
      lastStartFingerprint = null;
      store.patchAgentMeta({
        status: "error",
        error: `ALTAI runtime failed to start: ${e}`,
      });
      return false;
    }
  }

  store.addActivity({ label: "Sent a task to ALTAI" });
  store.patchAgentMeta({ status: "thinking", step: "Sending to ALTAI..." });

  // Echo the clean user message locally (no env preamble in the transcript).
  store.appendNativeMessage(text, "user");

  // Prepend a live <env> block so the agent knows the active workspace,
  // terminal cwd, and open file — the context the deleted Vercel transport
  // used to inject. IsanAgent resolves workspace_root itself, but not the
  // ALTAI UI's live terminal/editor state, so we pass it per turn.
  const envBlock = buildEnvBlock(store.live);
  const payload = envBlock ? `${envBlock}\n\n${text}` : text;

  // IsanAgent manages its own system prompt and tools; we only feed input.
  // Image attachments (data URIs) go as multimodal parts for vision models.
  try {
    // Carry the same config the pre-warm used, so the runtime routes this
    // message to that instance (route_send keys instances by this config).
    await native.agentSend(payload, images, documents, chatId, {
      providerName,
      apiKey,
      modelName,
      instructions,
      baseUrl,
      workspacePath,
      permissionMode,
      fallback,
      compaction,
    });
    return true;
  } catch (e) {
    // Without this the status would stay stuck on "thinking" if the IPC call
    // rejects (e.g. the runtime died between start and send). Drop the start
    // fingerprint so the next message re-initializes the runtime.
    lastStartFingerprint = null;
    store.addActivity({
      label: "Task could not be sent",
      detail: e instanceof Error ? e.message : String(e),
      tone: "error",
    });
    store.patchAgentMeta({
      status: "error",
      error: e instanceof Error ? e.message : String(e),
      step: null,
    });
    return false;
  }
}

export async function dispatchToSession(
  text: string,
  chatId: string,
  runConfig?: AssignmentRunConfig,
): Promise<boolean> {
  const store = useChatStore.getState();
  const prefs = usePreferencesStore.getState();
  const selectedModelId = runConfig?.modelId ?? store.selectedModelId;
  const resolution = resolveIsanAgentTarget(selectedModelId, store.apiKeys, {
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    lmstudioModelId: prefs.lmstudioModelId,
    mlxBaseURL: prefs.mlxBaseURL,
    mlxModelId: prefs.mlxModelId,
    openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    openaiCompatibleModelId: prefs.openaiCompatibleModelId,
  });
  if (!resolution.ok) return false;
  const { providerName, apiKey, modelName, baseUrl } = resolution.target;

  const agentsState = useAgentsStore.getState();
  const activeAgent = agentsState.all().find((a) => a.id === (runConfig?.agentId ?? agentsState.activeId));
  const workspacePath = currentWorkspaceFolder() ?? undefined;
  const instructions = combineAgentInstructions(
    activeAgent?.instructions?.trim() || undefined,
    await readProjectInstructions(workspacePath),
  );

  // The config routes this chat to its own runtime instance — so this
  // background run can be on a different model than the focused chat (or other
  // assignments) and run concurrently without tearing anything down.
  const compaction = resolveCompactionSpec(
    {
      compactionAuto: prefs.compactionAuto,
      compactionThresholdPercent: prefs.compactionThresholdPercent,
      compactionThresholdTokens: prefs.compactionThresholdTokens,
      compactionTailTurns: prefs.compactionTailTurns,
    },
    selectedModelId,
    prefs.openaiCompatibleContextLimit,
  );
  const config = {
    providerName,
    apiKey,
    modelName,
    instructions,
    baseUrl,
    workspacePath,
    permissionMode: effectivePermissionMode(
      runConfig?.permissionMode ?? prefs.permissionMode,
      prefs.bypassPermissionsEnabled,
    ),
    // Configured failover model — same per-send failover policy as the focused
    // chat; null when none is set or it can't be resolved.
    fallback: resolveFallbackSpec(prefs.fallbackModelId, store.apiKeys, {
      lmstudioBaseURL: prefs.lmstudioBaseURL,
      lmstudioModelId: prefs.lmstudioModelId,
      mlxBaseURL: prefs.mlxBaseURL,
      mlxModelId: prefs.mlxModelId,
      openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
      openaiCompatibleModelId: prefs.openaiCompatibleModelId,
    }),
    compaction,
  };

  // Persist the seed as the session's opening message (so "Open transcript"
  // shows context) without routing it through the focused chat's thread.
  // Route it through the SAME per-chat queue as later background appends so the
  // seed serializes with them — a fire-and-forget write here could race the
  // first background append and get clobbered.
  appendBackgroundMessage(chatId, "user", text);

  const envBlock = buildEnvBlock(store.live);
  const payload = envBlock ? `${envBlock}\n\n${text}` : text;
  try {
    await native.agentSend(payload, undefined, undefined, chatId, config);
    return true;
  } catch {
    return false;
  }
}

function buildEnvBlock(live: Live): string | null {
  const lines: string[] = [];
  const workspaceRoot = live.getWorkspaceRoot();
  const cwd = live.getCwd();
  const activeFile = live.getActiveFile();
  if (workspaceRoot) lines.push(`workspace_root: ${workspaceRoot}`);
  if (cwd) lines.push(`active_terminal_cwd: ${cwd}`);
  if (activeFile) lines.push(`active_file: ${activeFile}`);
  if (live.isActiveTerminalPrivate()) lines.push("active_terminal_mode: private");
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}

export function stop(): void {
  const state = useChatStore.getState();
  void native.agentCancel(state.activeSessionId ?? undefined);
  state.patchAgentMeta({ status: "idle", step: null });
}
