import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Restore keyboard focus to the last-focused element when the window
 * regains foreground focus (Cmd+Tab back, Alt+Tab back, dock-icon click).
 *
 * Two layers are needed when the window is re-activated:
 *  1. NATIVE focus — re-install the webview as the OS first responder. In
 *     Tauri's `unstable` multi-webview mode the outer window keeps native
 *     focus on reactivation and the child webview is never re-focused, which
 *     strands VoiceOver (macOS) / NVDA / Narrator outside the web content.
 *     This MUST be done natively: `element.focus()` only sets
 *     `document.activeElement`, not the OS first responder. It is handled in
 *     Rust on `WindowEvent::Focused(true)` — see `src-tauri/src/lib.rs`. (The
 *     JS `getCurrentWebview().setFocus()` IPC was tried and proved unreliable,
 *     notably on Windows, due to round-trip timing.)
 *  2. ELEMENT focus — once the content owns native focus again, restore the
 *     precise element that was focused before the app lost focus. That's this
 *     hook's job. Without it the WebView leaves focus on `document.body`: the
 *     visible cursor goes blank and keyboard users Tab from scratch.
 *
 * Pattern:
 *  - capture-phase `focusin` listener tracks the most-recent focused element
 *    while the window is active.
 *  - Tauri `onFocusChanged` fires on every foreground transition. On focus
 *    regain we wait one frame (the native focus push + the WebView's own
 *    focus-handling settle first) and re-focus the tracked element if it's
 *    still in the DOM and rendered.
 */
export function useRestoreFocusOnReturn(): void {
  useEffect(() => {
    let lastFocused: HTMLElement | null = null;

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && target !== document.body) {
        lastFocused = target;
      }
    };
    document.addEventListener("focusin", onFocusIn, true);

    const restoreElement = () => {
      const el = lastFocused;
      if (!el || !document.contains(el)) return;
      // Skip if the element is hidden — focus() on a display:none node
      // is silently a no-op and leaves the SR pointing at nothing.
      if (el.offsetParent === null && el !== document.documentElement) {
        return;
      }
      try {
        el.focus({ preventScroll: false });
      } catch {
        // Element may have been re-rendered / replaced; harmless.
      }
    };

    const win = getCurrentWindow();
    const unlistenPromise = win.onFocusChanged((event) => {
      const focused = event.payload as boolean;
      if (!focused) return;
      // Native first-responder focus is re-asserted in Rust (lib.rs,
      // `WindowEvent::Focused`). Here we only restore the precise element that
      // was focused before the switch, one frame later so the native push and
      // the WebView's own focus handling have settled.
      requestAnimationFrame(restoreElement);
    });

    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
}
