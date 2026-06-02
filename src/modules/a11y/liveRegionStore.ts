import { create } from "zustand";

type State = {
  message: string;
  announce: (msg: string) => void;
};

export const useLiveRegionStore = create<State>((set) => ({
  message: "",
  announce: (msg) => {
    // Re-announcing identical text requires a change for the live region to
    // fire again, so clear first and set on the next tick.
    set({ message: "" });
    setTimeout(() => set({ message: msg }), 50);
  },
}));

/** Announce a transient message to assistive tech via the global live region. */
export function announce(msg: string): void {
  useLiveRegionStore.getState().announce(msg);
}
