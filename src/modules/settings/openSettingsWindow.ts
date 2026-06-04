export type SettingsTab =
  | "general"
  | "shortcuts"
  | "models"
  | "agents"
  | "skills"
  | "language-servers"
  | "accessibility"
  | "about";

/**
 * Settings renders as an in-app tab, not a separate window. The host app
 * (which owns the tab system) registers the actual "open tab"
 * implementation on mount via [registerOpenSettings]. Every other module
 * just calls `openSettingsWindow(...)` and the registered impl does the
 * right thing — no need to thread the tabs hook through every component
 * that opens settings.
 *
 * The old separate-window implementation has been removed; the function
 * name is preserved for backward-compat with existing call sites.
 */
type OpenImpl = (tab?: SettingsTab) => void;

let openImpl: OpenImpl | null = null;

/**
 * Register the host's settings-opening function. Returns an unregister
 * callback for use as an effect cleanup.
 */
export function registerOpenSettings(impl: OpenImpl): () => void {
  openImpl = impl;
  return () => {
    if (openImpl === impl) openImpl = null;
  };
}

/** Open (or refocus) the settings tab. */
export function openSettingsWindow(tab?: SettingsTab): void {
  if (!openImpl) {
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn("openSettingsWindow called before registration");
    }
    return;
  }
  openImpl(tab);
}
