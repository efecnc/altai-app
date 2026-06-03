import type { Tab, WebviewTab } from "@/modules/tabs";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

type Props = {
  tabs: Tab[];
  activeId: number;
};

// Off-window coordinate used as a "hide" — Tauri child webviews paint on
// top of HTML and ignore CSS visibility, so we move them outside the
// window's render region instead of trying to display:none them.
const OFFSCREEN = -100000;

export function WebviewStack({ tabs, activeId }: Props) {
  const webviews = tabs.filter((t): t is WebviewTab => t.kind === "webview");
  if (webviews.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {webviews.map((t) => (
        <WebviewSlot
          key={t.id}
          label={t.label}
          url={t.url}
          visible={t.id === activeId}
        />
      ))}
    </div>
  );
}

type SlotProps = {
  label: string;
  url: string;
  visible: boolean;
};

function WebviewSlot({ label, url, visible }: SlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Refs so the long-lived ResizeObserver closure always reads the latest
  // visibility without needing to re-attach observers on every flip.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const compute = () => {
      const rect = el.getBoundingClientRect();
      const onScreen = visibleRef.current;
      return {
        x: onScreen ? rect.left : OFFSCREEN,
        y: onScreen ? rect.top : OFFSCREEN,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      };
    };

    const initial = compute();
    void invoke("webview_create", { label, url, ...initial }).catch((err) =>
      console.error("webview_create failed", err),
    );

    const sync = () => {
      void invoke("webview_set_bounds", { label, ...compute() }).catch(
        () => {},
      );
    };

    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);

    // The embedded tab is now a SEPARATE OS window positioned in screen
    // coordinates (we migrated off the `unstable` in-window child webview), so
    // it must re-sync when the MAIN window itself is dragged or natively
    // resized. The ResizeObserver / `resize` above only catch in-page layout
    // changes — without these the overlay is left stranded at its old screen
    // position after a window move.
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;
    let cancelled = false;
    const appWindow = getCurrentWindow();
    void appWindow.onMoved(sync).then((fn) => {
      if (cancelled) fn();
      else unlistenMoved = fn;
    });
    void appWindow.onResized(sync).then((fn) => {
      if (cancelled) fn();
      else unlistenResized = fn;
    });

    return () => {
      cancelled = true;
      unlistenMoved?.();
      unlistenResized?.();
      observer.disconnect();
      window.removeEventListener("resize", sync);
      void invoke("webview_close", { label }).catch(() => {});
    };
    // url is intentionally captured as the initial URL only — the user
    // navigating inside the webview shouldn't trigger a re-create.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // Re-sync whenever the active tab flips. Reads visibleRef indirectly via
  // the sync closure created in the lifecycle effect — except that closure
  // is captured per-mount, so we replicate the bounds call here.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    void invoke("webview_set_bounds", {
      label,
      x: visible ? rect.left : OFFSCREEN,
      y: visible ? rect.top : OFFSCREEN,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    }).catch(() => {});
  }, [label, visible]);

  // pointer-events-none: the native webview captures input directly (it
  // renders above HTML), so the slot must NOT swallow clicks that should
  // reach the editor/terminal when this tab is hidden.
  return <div ref={ref} className="pointer-events-none absolute inset-0" />;
}
