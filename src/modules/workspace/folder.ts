import { open } from "@tauri-apps/plugin-dialog";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";

/**
 * The user-selected workspace folder — ALTAI's IDE-style project root. It is
 * the explorer root AND the parent of the IsanAgent workspace (the agent roots
 * its memory/sandbox/config at `<folder>/.isanagent`). Persisted so the last
 * workspace reopens automatically; the picker is only forced when none is set.
 */
const STORE_PATH = "altai-workspace.json";
const KEY_FOLDER = "folder";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

type State = {
  folder: string | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setFolder: (path: string) => void;
  /** Open the native directory picker; persists + returns the chosen path. */
  pickFolder: () => Promise<string | null>;
};

export const useWorkspaceFolderStore = create<State>((set, get) => ({
  folder: null,
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    const saved = (await store.get<string>(KEY_FOLDER)) ?? null;
    set({ folder: saved, hydrated: true });
  },
  setFolder: (path) => {
    set({ folder: path });
    void store.set(KEY_FOLDER, path);
  },
  pickFolder: async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select workspace folder",
    });
    if (typeof selected === "string") {
      get().setFolder(selected);
      return selected;
    }
    return null;
  },
}));

export function currentWorkspaceFolder(): string | null {
  return useWorkspaceFolderStore.getState().folder;
}
