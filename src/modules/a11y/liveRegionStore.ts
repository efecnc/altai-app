import { create } from "zustand";

type State = {
  message: string;
  announce: (msg: string) => void;
};

// Re-announcing identical text needs an intervening empty value, so we clear
// then set after a short delay. Tracking the pending timer means rapid-fire
// announce() calls collapse to the latest message instead of racing.
const REANNOUNCE_DELAY_MS = 50;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

export const useLiveRegionStore = create<State>((set) => ({
  message: "",
  announce: (msg) => {
    if (pendingTimer) clearTimeout(pendingTimer);
    set({ message: "" });
    pendingTimer = setTimeout(() => {
      set({ message: msg });
      pendingTimer = null;
    }, REANNOUNCE_DELAY_MS);
  },
}));

/** Announce a transient message to assistive tech via the global live region. */
export function announce(msg: string): void {
  useLiveRegionStore.getState().announce(msg);
}
