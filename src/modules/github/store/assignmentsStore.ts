import { native } from "@/modules/ai/lib/native";
import { resolveIsanAgentTarget } from "@/modules/ai/lib/isanagentTarget";
import { useAgentRunsStore } from "@/modules/ai/store/agentRunsStore";
import { dispatchToSession, useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { create } from "zustand";
import {
  type Assignment,
  type AssignmentRunConfig,
  type AssignmentSource,
  type AssignmentStatus,
  buildItemSeed,
  buildTaskSeed,
  loadAssignments,
  saveAssignments,
} from "../lib/assignments";
import type { RepoSlug } from "../lib/items";

/** Statuses where the run is still live (cancellable, not yet terminal). */
export const ACTIVE_ASSIGNMENT_STATES: AssignmentStatus[] = [
  "dispatching",
  "running",
  "awaiting-approval",
];

function newAssignmentId(): string {
  return `asg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Verify a runtime target (provider+model+key) resolves before dispatching. */
function resolveTarget(modelId?: string): { ok: true } | { ok: false; error: string } {
  const cs = useChatStore.getState();
  const p = usePreferencesStore.getState();
  const r = resolveIsanAgentTarget(modelId ?? cs.selectedModelId, cs.apiKeys, {
    lmstudioBaseURL: p.lmstudioBaseURL,
    lmstudioModelId: p.lmstudioModelId,
    mlxBaseURL: p.mlxBaseURL,
    mlxModelId: p.mlxModelId,
    openaiCompatibleBaseURL: p.openaiCompatibleBaseURL,
    openaiCompatibleModelId: p.openaiCompatibleModelId,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

type AssignInput = {
  source: AssignmentSource;
  title: string;
  seed: string;
  runConfig?: AssignmentRunConfig;
};

type State = {
  assignments: Assignment[];
  hydrated: boolean;
  /** True while a dispatch is in flight (serializes the shared runtime start). */
  dispatching: boolean;
  hydrate: () => Promise<void>;
  assign: (input: AssignInput) => Promise<string>;
  updateStatus: (id: string, status: AssignmentStatus) => void;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  runTask: (input: { title: string; prompt: string; runConfig?: AssignmentRunConfig }) => Promise<string>;
};

export const useAssignmentsStore = create<State>((set, get) => ({
  assignments: [],
  hydrated: false,
  dispatching: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const loaded = await loadAssignments();
    // Sessions must be known before we judge an assignment orphaned, or a
    // not-yet-hydrated chatStore would make us hide every restored card.
    await useChatStore.getState().hydrateSessions();
    const sessions = new Set(useChatStore.getState().sessions.map((s) => s.id));
    set((s) => {
      // Merge with any assignment created during the await (in-flight dispatch),
      // and skip orphans whose session is gone. Non-destructive: we don't
      // rewrite the persisted list here, so nothing is permanently dropped.
      const known = new Set(s.assignments.map((a) => a.id));
      const restored = loaded.filter(
        (a) => !known.has(a.id) && sessions.has(a.sessionId),
      );
      return { assignments: [...s.assignments, ...restored], hydrated: true };
    });
  },

  assign: async ({ source, title, seed, runConfig }) => {
    const target = resolveTarget(runConfig?.modelId);
    if (!target.ok) throw new Error(target.error);

    set({ dispatching: true });
    try {
      // Background session: titled, but NOT focused — no chat hijack, no
      // todo-list wipe. Its chat_id is the run identity.
      const sessionId = useChatStore.getState().createBackgroundSession(title);

      const now = Date.now();
      const assignment: Assignment = {
        id: newAssignmentId(),
        source,
        sessionId,
        title,
        status: "dispatching",
        runConfig,
        createdAt: now,
        updatedAt: now,
      };
      set((s) => {
        const next = [assignment, ...s.assignments];
        void saveAssignments(next);
        return { assignments: next };
      });

      const ok = await dispatchToSession(seed, sessionId, runConfig);
      if (!ok) {
        // Dispatch failed at the runtime — tear down the orphan session and
        // drop the card, then surface the error to the caller.
        useChatStore.getState().deleteSession(sessionId);
        useAgentRunsStore.getState().clear(sessionId);
        set((s) => {
          const next = s.assignments.filter((x) => x.id !== assignment.id);
          void saveAssignments(next);
          return { assignments: next };
        });
        throw new Error(
          "Couldn't start the agent run — check the selected model and API key.",
        );
      }
      get().updateStatus(assignment.id, "running");
      return assignment.id;
    } finally {
      set({ dispatching: false });
    }
  },

  updateStatus: (id, status) =>
    set((s) => {
      let changed = false;
      const next = s.assignments.map((a) => {
        if (a.id === id && a.status !== status) {
          changed = true;
          return { ...a, status, updatedAt: Date.now() };
        }
        return a;
      });
      if (!changed) return {};
      void saveAssignments(next);
      return { assignments: next };
    }),

  cancel: async (id) => {
    const a = get().assignments.find((x) => x.id === id);
    if (!a) return;
    try {
      await native.agentCancel(a.sessionId);
    } finally {
      // Only commit "cancelled" if the run is still active — don't overwrite a
      // run that finished (done/failed) just as we asked it to cancel.
      const current = get().assignments.find((x) => x.id === id);
      if (current && ACTIVE_ASSIGNMENT_STATES.includes(current.status)) {
        get().updateStatus(id, "cancelled");
      }
    }
  },

  remove: async (id) => {
    const a = get().assignments.find((x) => x.id === id);
    // A still-running run must be cancelled before its card disappears, or it
    // becomes an uncancellable orphan on the Rust side.
    if (a && ACTIVE_ASSIGNMENT_STATES.includes(a.status)) {
      try {
        await native.agentCancel(a.sessionId);
      } catch {
        // best effort — proceed with removal regardless
      }
    }
    // Tear down the background session and its registry entry so removing a
    // card doesn't leave a ghost session + run state behind.
    if (a) {
      useChatStore.getState().deleteSession(a.sessionId);
      useAgentRunsStore.getState().clear(a.sessionId);
    }
    set((s) => {
      const next = s.assignments.filter((x) => x.id !== id);
      void saveAssignments(next);
      return { assignments: next };
    });
  },

  runTask: async ({ title, prompt, runConfig }) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) throw new Error("Describe the task before starting it.");
    const cleanTitle = title.trim() || cleanPrompt.split("\n")[0].slice(0, 96);
    return get().assign({
      source: { kind: "task", prompt: cleanPrompt },
      title: `🤖 ${cleanTitle}`,
      seed: buildTaskSeed(cleanPrompt, runConfig?.skills),
      runConfig,
    });
  },
}));

/** Convenience: dispatch an agent for a GitHub issue/PR (shared across the
 *  board and the Pull Requests & Issues views). Returns the assignment id. */
export function assignGitHubItem(input: {
  kind: "issue" | "pr";
  slug: RepoSlug;
  number: number;
  title: string;
  body: string | null;
  url: string;
}): Promise<string> {
  const seed = buildItemSeed({
    kind: input.kind,
    owner: input.slug.owner,
    repo: input.slug.repo,
    number: input.number,
    title: input.title,
    body: input.body,
  });
  return useAssignmentsStore.getState().assign({
    source: {
      kind: input.kind,
      owner: input.slug.owner,
      repo: input.slug.repo,
      number: input.number,
      url: input.url,
    },
    title: `🤖 ${input.kind === "pr" ? "PR" : "Issue"} #${input.number} · ${input.title}`,
    seed,
  });
}

/** True when an issue/PR already has an agent assigned. */
export function isItemAssigned(
  assignments: Assignment[],
  kind: "issue" | "pr",
  number: number,
): boolean {
  return assignments.some(
    (a) => a.source.kind === kind && a.source.number === number,
  );
}
