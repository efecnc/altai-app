import { create } from "zustand";
import { native } from "../lib/native";

export type QueuedEdit = {
  id: string;
  /** Tool that produced the queued mutation. */
  kind: "write_file" | "edit" | "multi_edit" | "create_directory";
  path: string;
  /** Original file content (empty for new files / create_directory). */
  originalContent: string;
  /** Proposed full content after edit (empty for create_directory). */
  proposedContent: string;
  /** True if the file did not exist when the edit was queued. */
  isNewFile: boolean;
  /** Human-readable description, used for create_directory. */
  description?: string;
};

/** A locally reversible change accepted from Plan review in this app session. */
export type AppliedPlanEdit = QueuedEdit & {
  appliedAt: number;
};

export type PlanApplyResult = { id: string; ok: boolean; error?: string };

type PlanState = {
  active: boolean;
  queue: QueuedEdit[];
  /** Reversible plan-review edits. Directory creates are excluded: they cannot be safely removed once populated. */
  applied: AppliedPlanEdit[];
  toggle: () => void;
  enable: () => void;
  disable: () => void;
  enqueue: (q: QueuedEdit) => void;
  removeOne: (id: string) => void;
  clear: () => void;
  /** Apply exactly one reviewed edit and keep a local rollback snapshot when safe. */
  applyOne: (id: string) => Promise<PlanApplyResult | null>;
  /** Apply queued edits in order. Returns per-edit results. */
  applyAll: () => Promise<PlanApplyResult[]>;
  /** Restore the pre-review content for one locally applied edit. */
  restoreApplied: (id: string) => Promise<PlanApplyResult | null>;
};

export const usePlanStore = create<PlanState>((set, get) => ({
  active: false,
  queue: [],
  applied: [],
  toggle: () =>
    set((s) => ({ active: !s.active, queue: s.active ? [] : s.queue })),
  enable: () => set({ active: true }),
  disable: () => set({ active: false, queue: [] }),
  enqueue: (q) => set((s) => ({ queue: [...s.queue, q] })),
  removeOne: (id) =>
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),
  clear: () => set({ queue: [] }),
  async applyOne(id) {
    const item = get().queue.find((q) => q.id === id);
    if (!item) return null;
    try {
      if (item.kind === "create_directory") {
        await native.createDir(item.path);
      } else {
        await native.writeFile(item.path, item.proposedContent, {
          source: "ai-plan-review",
        });
      }
      set((s) => ({
        queue: s.queue.filter((q) => q.id !== id),
        // A directory may have gained files immediately after creation, so
        // deleting it during undo would be unsafe. File edits/new files are
        // deterministic to restore from the content already in this record.
        applied:
          item.kind === "create_directory"
            ? s.applied
            : [...s.applied, { ...item, appliedAt: Date.now() }].slice(-40),
      }));
      return { id, ok: true };
    } catch (error) {
      return { id, ok: false, error: String(error) };
    }
  },
  async applyAll() {
    const ids = get().queue.map((q) => q.id);
    const results: PlanApplyResult[] = [];
    for (const id of ids) {
      const result = await get().applyOne(id);
      if (result) results.push(result);
    }
    return results;
  },
  async restoreApplied(id) {
    const item = get().applied.find((q) => q.id === id);
    if (!item) return null;
    try {
      if (item.isNewFile) {
        await native.delete(item.path);
      } else {
        await native.writeFile(item.path, item.originalContent, {
          source: "ai-plan-restore",
        });
      }
      set((s) => ({ applied: s.applied.filter((q) => q.id !== id) }));
      return { id, ok: true };
    } catch (error) {
      return { id, ok: false, error: String(error) };
    }
  },
}));
