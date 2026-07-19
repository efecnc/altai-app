import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { native } from "../ai/lib/native";

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

/**
 * Only the primary window (`main`) reopens the persisted workspace. Windows
 * spawned via "New Window" (label `main-<uuid>`) start on the welcome screen so
 * the user can pick a different folder. See the `os_menu` Rust backend.
 */
function isPrimaryWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true; // non-Tauri context — behave as the primary window.
  }
}

/**
 * Mirror the recents into the native OS menu (macOS Dock / Windows Jump List)
 * so they're reachable by right-clicking the app icon. Best-effort: the command
 * is a no-op on Linux and absent outside Tauri.
 */
function pushRecentFolders(folders: string[]): void {
  void native.setRecentFolders(folders).catch(() => {});
}

/**
 * Whether `path` still exists and is a directory. Used to fall back to the
 * welcome screen — instead of loading into a broken workspace ("no such file or
 * directory") — when a persisted or recent folder was deleted/moved/unmounted.
 */
async function folderIsAccessible(path: string): Promise<boolean> {
  try {
    // Authorize first: fs access for paths outside the default scope must go
    // through workspace authorization, else stat fails for a perfectly valid
    // folder. A missing path makes authorize/stat throw → treated as gone.
    await native.workspaceAuthorize(path);
    return (await native.stat(path)).kind === "dir";
  } catch {
    return false;
  }
}

type State = {
  folder: string | null;
  /** Most-recently-opened workspaces, newest first. Powers the welcome list. */
  recents: string[];
  hydrated: boolean;
  /**
   * Set when the active workspace was just produced by a clone, so the app can
   * open straight into the Source Control view instead of the file explorer.
   * Transient (never persisted); consumed + cleared by the app on mount.
   */
  justCloned: boolean;
  clearJustCloned: () => void;
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
   * Open a workspace from the recents list. Verifies it still exists first; if
   * it was deleted/moved, drops it from recents instead of loading into an
   * error screen. Resolves true when the folder was opened.
   */
  openRecent: (path: string) => Promise<boolean>;
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
  justCloned: false,
  clearJustCloned: () => {
    if (get().justCloned) set({ justCloned: false });
  },
  hydrate: async () => {
    if (get().hydrated) return;
    let recentList: string[] = [];
    let saved: string | null = null;
    try {
      const recents = (await store.get<string[]>(KEY_RECENTS)) ?? [];
      recentList = Array.isArray(recents) ? recents : [];
      // New windows start on the welcome screen; only `main` reopens the folder.
      saved = isPrimaryWindow()
        ? ((await store.get<string>(KEY_FOLDER)) ?? null)
        : null;
      // If the persisted workspace was deleted/moved/unmounted, fall back to the
      // welcome screen instead of loading into a broken workspace, and forget it
      // as the active folder (it stays in recents so the user can re-pick it).
      if (saved && !(await folderIsAccessible(saved))) {
        saved = null;
        void store.delete(KEY_FOLDER).then(() => store.save());
      }
    } catch (error) {
      // A missing/corrupt store or a transient native-plugin failure must never
      // leave the entire app permanently blank. Start clean and let the user
      // pick a workspace instead.
      console.warn("workspace hydration failed; starting without a workspace", error);
    }
    set({
      folder: saved,
      recents: recentList,
      hydrated: true,
    });
    pushRecentFolders(recentList);
  },
  setFolder: (path) => {
    const recents = prependRecent(get().recents, path);
    set({ folder: path, recents });
    pushRecentFolders(recents);
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
    const dest = await native.gitClone(trimmed, parent);
    set({ justCloned: true });
    get().setFolder(dest);
    return dest;
  },
  removeRecent: (path) => {
    const recents = get().recents.filter((p) => p !== path);
    set({ recents });
    pushRecentFolders(recents);
    void (async () => {
      await store.set(KEY_RECENTS, recents);
      await store.save();
    })();
  },
  openRecent: async (path) => {
    if (await folderIsAccessible(path)) {
      get().setFolder(path);
      return true;
    }
    // Folder is gone — confirm before pruning so a temporarily-unplugged drive
    // or offline network share doesn't silently lose the entry.
    const remove = await ask(
      `"${path}" is no longer accessible.\n\nRemove it from recent projects?`,
      { title: "Folder not found", kind: "warning" },
    );
    if (remove) get().removeRecent(path);
    return false;
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
