import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

// WebView2 (Windows) is the only backend that loses content focus on window
// reactivation in multi-webview mode — see the native-focus note below. Gate
// the extra IPC call to it so the already-working macOS/Linux flows are
// untouched. WebView2's UA always contains "Windows NT".
const IS_WINDOWS =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

/**
 * Restore keyboard focus to the last-focused element when the window
 * regains foreground focus (Cmd+Tab back, Alt+Tab back, dock-icon click).
 *
 * Without this, the WebView dumps focus on `document.body` whenever the
 * window comes back to the front. The visible cursor goes blank, the
 * screen reader narrates the window title but no focused element, and
 * keyboard users have to Tab from scratch every time they switch apps.
 *
 * Two layers are needed on Windows:
 *  1. NATIVE focus — push OS/UIA focus into the WebView2 content via
 *     `webview.setFocus()`. We run with Tauri's `unstable` feature for
 *     multi-webview tabs; in that mode tao can't decide which child webview
 *     to focus, so it forwards nothing on `WM_SETFOCUS` and OS focus stays
 *     stranded on the outer window. JAWS/Narrator then read the virtual
 *     buffer but the content isn't interactable. `element.focus()` alone
 *     can't fix this — it only sets `document.activeElement`, not OS focus.
 *  2. ELEMENT focus — once the content owns native focus, restore the
 *     precise last-focused element.
 *
 * Pattern:
 *  - capture-phase `focusin` listener tracks the most-recent focused
 *    element while the window is active.
 *  - Tauri `onFocusChanged` fires on every foreground transition. On
 *    focus regain we move native focus into the webview (Windows), then
 *    wait one frame (WebView's own focus-handling races with ours
 *    otherwise) and re-focus the tracked element if it's still in the DOM
 *    and rendered.
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
      if (IS_WINDOWS) {
        // Move native/UIA focus into the WebView2 content first, then
        // restore the element on the next frame. `getCurrentWebview()` reads
        // `window.__TAURI_INTERNALS__` synchronously and can throw before a
        // promise exists, so guard it — element restore must still run.
        try {
          getCurrentWebview()
            .setFocus()
            .catch(() => {
              // ACL-denied or webview gone — element restore still runs.
            })
            .finally(() => requestAnimationFrame(restoreElement));
        } catch {
          requestAnimationFrame(restoreElement);
        }
      } else {
        requestAnimationFrame(restoreElement);
      }
    });

    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
}
