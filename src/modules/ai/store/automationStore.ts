import { create } from "zustand";
import {
  native,
  type AgentBackgroundJobInfo,
  type AgentAutomationInfo,
  type AgentAutomationSchedule,
} from "../lib/native";

type DirectSchedule = Extract<
  AgentAutomationSchedule,
  { kind: "at" | "every" }
>;

type AutomationState = {
  workspacePath: string | null;
  items: AgentAutomationInfo[];
  jobsByAutomationId: Record<string, AgentBackgroundJobInfo>;
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  pendingIds: Record<string, true>;
  refresh: (workspacePath?: string | null) => Promise<void>;
  create: (
    chatId: string,
    schedule: DirectSchedule,
    message: string,
  ) => Promise<boolean>;
  remove: (automationId: string, chatId: string) => Promise<void>;
  clearError: () => void;
};

function normalizedWorkspacePath(path?: string | null): string | null {
  const trimmed = path?.trim();
  return trimmed ? trimmed : null;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortItems(items: AgentAutomationInfo[]): AgentAutomationInfo[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

export const useAutomationStore = create<AutomationState>((set, get) => ({
  workspacePath: null,
  items: [],
  jobsByAutomationId: {},
  hydrated: false,
  loading: false,
  error: null,
  pendingIds: {},

  refresh: async (workspacePath) => {
    const path =
      workspacePath === undefined
        ? get().workspacePath
        : normalizedWorkspacePath(workspacePath);
    if (!path) {
      set({
        workspacePath: null,
        items: [],
        jobsByAutomationId: {},
        hydrated: true,
        loading: false,
        error: null,
        pendingIds: {},
      });
      return;
    }
    set({
      workspacePath: path,
      loading: true,
      error: null,
      ...(get().workspacePath === path
        ? {}
        : { items: [], jobsByAutomationId: {}, hydrated: false, pendingIds: {} }),
    });
    try {
      const [items, jobs] = await Promise.all([
        native.agentListAutomations(path),
        native.agentListBackgroundJobs({ workspacePath: path, limit: 200 }),
      ]);
      const jobsByAutomationId = jobs.reduce<Record<string, AgentBackgroundJobInfo>>(
        (result, job) => {
          if (!job.id.startsWith("cron:")) return result;
          const automationId = job.id.slice("cron:".length);
          const existing = result[automationId];
          if (!existing || existing.updatedAtMs < job.updatedAtMs) {
            result[automationId] = job;
          }
          return result;
        },
        {},
      );
      if (get().workspacePath === path) {
        set({ items: sortItems(items), jobsByAutomationId, hydrated: true, loading: false });
      }
    } catch (error) {
      if (get().workspacePath === path) {
        set({ hydrated: true, loading: false, error: messageFrom(error) });
      }
    }
  },

  create: async (chatId, schedule, message) => {
    const path = get().workspacePath;
    if (!path) {
      set({ error: "Open a workspace before creating an automation." });
      return false;
    }
    const pendingKey = "create";
    set((state) => ({
      error: null,
      pendingIds: { ...state.pendingIds, [pendingKey]: true },
    }));
    try {
      const item = await native.agentAutomationCreate(chatId, schedule, message, path);
      set((state) => ({ items: sortItems([...state.items, item]) }));
      return true;
    } catch (error) {
      set({ error: messageFrom(error) });
      return false;
    } finally {
      set((state) => {
        const pendingIds = { ...state.pendingIds };
        delete pendingIds[pendingKey];
        return { pendingIds };
      });
    }
  },

  remove: async (automationId, chatId) => {
    const path = get().workspacePath;
    if (!path) return;
    const pendingKey = `remove:${automationId}`;
    set((state) => ({
      error: null,
      pendingIds: { ...state.pendingIds, [pendingKey]: true },
    }));
    try {
      await native.agentAutomationRemove(automationId, chatId, path);
      set((state) => ({
        items: state.items.filter((item) => item.id !== automationId),
        jobsByAutomationId: Object.fromEntries(
          Object.entries(state.jobsByAutomationId).filter(([id]) => id !== automationId),
        ),
      }));
    } catch (error) {
      set({ error: messageFrom(error) });
    } finally {
      set((state) => {
        const pendingIds = { ...state.pendingIds };
        delete pendingIds[pendingKey];
        return { pendingIds };
      });
    }
  },

  clearError: () => set({ error: null }),
}));
