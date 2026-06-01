import { invoke } from "@tauri-apps/api/core";
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
const KEY_RECENTS = "recents";
// How many recent workspaces the welcome screen remembers. Cursor shows a
// similar short list — enough to jump back to active projects, not a history.
const RECENTS_CAP = 12;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

function prependRecent(recents: string[], path: string): string[] {
  return [path, ...recents.filter((p) => p !== path)].slice(0, RECENTS_CAP);
}

type State = {
  folder: string | null;
  /** Most-recently-opened workspaces, newest first. Powers the welcome list. */
  recents: string[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setFolder: (path: string) => void;
  /** Open the native directory picker; persists + returns the chosen path. */
  pickFolder: () => Promise<string | null>;
  /**
   * Prompt for a destination directory, clone `url` into it via the Rust
   * `git_clone` command, then open the cloned repo as the workspace. Returns
   * the cloned path, or null if the user cancelled the destination dialog.
   * Throws (with git's error text) if the clone itself fails.
   */
  cloneRepo: (url: string) => Promise<string | null>;
  /** Drop a path from the recents list (e.g. it was moved/deleted). */
  removeRecent: (path: string) => void;
  /**
   * Close the current workspace → return to the welcome screen. Keeps recents
   * (the just-closed folder stays at the top of the list). The persisted
   * folder is cleared so the next launch shows the welcome too.
   */
  closeFolder: () => void;
};

export const useWorkspaceFolderStore = create<State>((set, get) => ({
  folder: null,
  recents: [],
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    const saved = (await store.get<string>(KEY_FOLDER)) ?? null;
    const recents = (await store.get<string[]>(KEY_RECENTS)) ?? [];
    set({
      folder: saved,
      recents: Array.isArray(recents) ? recents : [],
      hydrated: true,
    });
  },
  setFolder: (path) => {
    const recents = prependRecent(get().recents, path);
    set({ folder: path, recents });
    // Force an immediate write (not the autoSave debounce) so the last folder
    // survives even if the app is closed right after selecting it.
    void (async () => {
      await store.set(KEY_FOLDER, path);
      await store.set(KEY_RECENTS, recents);
      await store.save();
    })();
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
  cloneRepo: async (url) => {
    const trimmed = url.trim();
    if (!trimmed) throw new Error("Enter a repository URL.");
    const parent = await open({
      directory: true,
      multiple: false,
      title: "Choose where to clone",
    });
    if (typeof parent !== "string") return null; // cancelled
    const dest = await invoke<string>("git_clone", {
      url: trimmed,
      destParent: parent,
    });
    get().setFolder(dest);
    return dest;
  },
  removeRecent: (path) => {
    const recents = get().recents.filter((p) => p !== path);
    set({ recents });
    void (async () => {
      await store.set(KEY_RECENTS, recents);
      await store.save();
    })();
  },
  closeFolder: () => {
    set({ folder: null });
    void (async () => {
      await store.delete(KEY_FOLDER);
      await store.save();
    })();
  },
}));

export function currentWorkspaceFolder(): string | null {
  return useWorkspaceFolderStore.getState().folder;
}

/** Last path segment of a workspace folder, for display. */
export function folderName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/** Collapse the home prefix to `~` so recent paths read like a shell would. */
export function prettyDir(path: string, home: string | null): string {
  if (!home) return path;
  return path === home
    ? "~"
    : path.startsWith(`${home}/`)
      ? `~${path.slice(home.length)}`
      : path;
}
