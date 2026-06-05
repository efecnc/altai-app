import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { github, type GitHubUser } from "../lib/github";

export type GitHubConnectState =
  | "idle" // not connected, nothing in flight
  | "loading" // checking status / starting device flow
  | "waiting" // showing the user code, polling for authorization
  | "connected"
  | "error";

type GitHubStore = {
  connection: GitHubUser | null;
  state: GitHubConnectState;
  /** Code the user types at github.com/login/device (set while `waiting`). */
  userCode: string | null;
  verificationUri: string | null;
  error: string | null;
  /** True once an initial status check has run, so callers don't re-trigger. */
  hydrated: boolean;

  refresh: () => Promise<void>;
  connect: () => Promise<void>;
  cancel: () => void;
  disconnect: () => Promise<void>;
};

// Monotonic token so a stale poll (after cancel/disconnect) can't clobber a
// newer connection state when it eventually resolves.
let attempt = 0;

export const useGitHubStore = create<GitHubStore>((set, get) => ({
  connection: null,
  state: "idle",
  userCode: null,
  verificationUri: null,
  error: null,
  hydrated: false,

  refresh: async () => {
    const mine = ++attempt;
    set({ state: get().connection ? "connected" : "loading", error: null });
    try {
      const user = await github.status();
      if (mine !== attempt) return;
      set({
        connection: user,
        state: user ? "connected" : "idle",
        userCode: null,
        verificationUri: null,
        hydrated: true,
      });
    } catch (e) {
      if (mine !== attempt) return;
      set({ state: "idle", connection: null, hydrated: true, error: String(e) });
    }
  },

  connect: async () => {
    const mine = ++attempt;
    set({ state: "loading", error: null, userCode: null, verificationUri: null });
    try {
      const code = await github.deviceStart();
      if (mine !== attempt) return;
      set({
        state: "waiting",
        userCode: code.userCode,
        verificationUri: code.verificationUri,
      });
      // Best-effort: open the verification page so the user can paste the code.
      void openUrl(code.verificationUri).catch(() => {});

      const user = await github.pollToken(
        code.deviceCode,
        code.interval,
        code.expiresIn,
      );
      if (mine !== attempt) return;
      set({
        connection: user,
        state: "connected",
        userCode: null,
        verificationUri: null,
        error: null,
      });
    } catch (e) {
      if (mine !== attempt) return;
      set({
        state: "error",
        userCode: null,
        verificationUri: null,
        error: String(e),
      });
    }
  },

  cancel: () => {
    attempt++; // invalidate any in-flight poll
    set({
      state: get().connection ? "connected" : "idle",
      userCode: null,
      verificationUri: null,
      error: null,
    });
  },

  disconnect: async () => {
    attempt++; // invalidate any in-flight poll
    try {
      await github.disconnect();
    } finally {
      set({
        connection: null,
        state: "idle",
        userCode: null,
        verificationUri: null,
        error: null,
      });
    }
  },
}));
