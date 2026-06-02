import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  applyOverride,
  BUILTIN_AGENTS,
  diffAgainstBuiltin,
  loadAgents,
  newAgentId,
  saveActiveAgentId,
  saveAgentOverrides,
  saveCustomAgents,
  saveDisabledAgentIds,
  type Agent,
  type AgentOverride,
} from "../lib/agents";

const CHANGED_EVENT = "altai://ai-agents-changed";
/**
 * Per-window identifier embedded in every broadcast. `emit()` delivers to the
 * sending window too, so without this guard each local mutation triggers a
 * redundant disk reload + state replacement on the same window.
 */
const SELF_TOKEN = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

type AgentsState = {
  hydrated: boolean;
  customAgents: Agent[];
  activeId: string;
  disabledIds: string[];
  overrides: Record<string, AgentOverride>;
  /** All agents (built-in + custom), with overrides applied. */
  all: () => Agent[];
  /** Subset of `all()` that the user hasn't disabled. */
  enabled: () => Agent[];
  isDisabled: (id: string) => boolean;
  isOverridden: (id: string) => boolean;
  hydrate: () => Promise<void>;
  setActiveId: (id: string) => void;
  /**
   * Save an agent. For custom agents (`builtIn: false`) appends/updates the
   * custom list. For built-in agents stores only the diff against the
   * hardcoded default in the overrides map — so resetting is a single delete.
   */
  upsert: (agent: Agent) => void;
  remove: (id: string) => void;
  setDisabled: (id: string, disabled: boolean) => void;
  /** Drop the user's override for a built-in agent (restore defaults). */
  resetBuiltin: (id: string) => void;
};

let initialized = false;

function broadcast(): void {
  void emit(CHANGED_EVENT, { source: SELF_TOKEN });
}

function applyAll(
  customAgents: Agent[],
  overrides: Record<string, AgentOverride>,
): Agent[] {
  const builtins = BUILTIN_AGENTS.map((a) => applyOverride(a, overrides[a.id]));
  return [...builtins, ...customAgents];
}

function pickFirstEnabled(
  list: Agent[],
  disabled: ReadonlySet<string>,
): Agent | undefined {
  return list.find((a) => !disabled.has(a.id));
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  hydrated: false,
  customAgents: [],
  activeId: BUILTIN_AGENTS[0].id,
  disabledIds: [],
  overrides: {},
  all: () => applyAll(get().customAgents, get().overrides),
  enabled: () => {
    const { customAgents, overrides, disabledIds } = get();
    const all = applyAll(customAgents, overrides);
    if (disabledIds.length === 0) return all;
    const disabled = new Set(disabledIds);
    return all.filter((a) => !disabled.has(a.id));
  },
  isDisabled: (id) => get().disabledIds.includes(id),
  isOverridden: (id) => Object.prototype.hasOwnProperty.call(get().overrides, id),
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const { custom, activeId, disabledIds, overrides } = await loadAgents();
    set({ customAgents: custom, activeId, disabledIds, overrides, hydrated: true });

    void listen<{ source?: string }>(CHANGED_EVENT, async (e) => {
      // Skip our own broadcasts — the local mutator already updated state
      // in-process. Only foreign-window writes need a disk reload.
      if (e.payload?.source === SELF_TOKEN) return;
      const fresh = await loadAgents();
      set({
        customAgents: fresh.custom,
        activeId: fresh.activeId,
        disabledIds: fresh.disabledIds,
        overrides: fresh.overrides,
      });
    });
  },
  setActiveId: (id) => {
    set({ activeId: id });
    void saveActiveAgentId(id).then(broadcast);
  },
  upsert: (agent) => {
    if (agent.builtIn) {
      const base = BUILTIN_AGENTS.find((a) => a.id === agent.id);
      if (!base) return;
      const patch = diffAgainstBuiltin(base, agent);
      const next = { ...get().overrides };
      if (Object.keys(patch).length === 0) {
        delete next[agent.id];
      } else {
        next[agent.id] = patch;
      }
      set({ overrides: next });
      void saveAgentOverrides(next).then(broadcast);
      return;
    }
    const list = get().customAgents;
    const idx = list.findIndex((a) => a.id === agent.id);
    const next =
      idx === -1 ? [...list, agent] : list.map((a) => (a.id === agent.id ? agent : a));
    set({ customAgents: next });
    void saveCustomAgents(next).then(broadcast);
  },
  remove: (id) => {
    const list = get().customAgents.filter((a) => a.id !== id);
    set({ customAgents: list });
    let active = get().activeId;
    if (active === id) {
      active = BUILTIN_AGENTS[0].id;
      set({ activeId: active });
      void saveActiveAgentId(active);
    }
    void saveCustomAgents(list).then(broadcast);
  },
  setDisabled: (id, disabled) => {
    const nextDisabled = new Set(get().disabledIds);
    if (disabled) nextDisabled.add(id);
    else nextDisabled.delete(id);

    // Invariant: at least one agent must be enabled and selectable from the
    // toolbar dropdown. If the user just disabled the active agent we have
    // to relocate `activeId`. If they disabled everything, force-re-enable
    // the fallback so the dropdown is never an empty dead-end.
    let nextActive = get().activeId;
    if (disabled && nextActive === id) {
      const fallback =
        pickFirstEnabled(
          applyAll(get().customAgents, get().overrides),
          nextDisabled,
        ) ?? BUILTIN_AGENTS[0];
      nextActive = fallback.id;
      if (nextDisabled.has(fallback.id)) {
        nextDisabled.delete(fallback.id);
      }
    }

    const nextIds = Array.from(nextDisabled);
    set({ disabledIds: nextIds });
    void saveDisabledAgentIds(nextIds).then(broadcast);

    if (nextActive !== get().activeId) {
      get().setActiveId(nextActive);
    }
  },
  resetBuiltin: (id) => {
    if (!get().isOverridden(id)) return;
    const next = { ...get().overrides };
    delete next[id];
    set({ overrides: next });
    void saveAgentOverrides(next).then(broadcast);
  },
}));

export { newAgentId };
