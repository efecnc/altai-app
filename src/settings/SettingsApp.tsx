import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useState } from "react";
import { normalizeSettingsTab, SettingsContent } from "./SettingsContent";

/**
 * Legacy window entry for the settings UI. Kept so a pre-existing
 * separate `settings` webview keeps working, but new entry points should
 * use the in-tab `SettingsPane` instead.
 *
 * Reads its initial section from the URL `?tab=` query (set by the Rust
 * `open_settings_window` command) and listens for the `altai:settings-tab`
 * event so a second invocation re-focuses without spawning a new window.
 */
function readInitialTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const url = new URL(window.location.href);
  return normalizeSettingsTab(url.searchParams.get("tab") ?? undefined);
}

export function SettingsApp() {
  const [active, setActive] = useState<SettingsTab>(readInitialTab);

  useEffect(() => {
    const unlistenPromise = getCurrentWebviewWindow().listen<string>(
      "altai:settings-tab",
      (e) => setActive(normalizeSettingsTab(e.payload)),
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <header
        data-tauri-drag-region
        className={`flex h-11 shrink-0 items-center border-b border-border/60 bg-card/60 ${
          IS_MAC ? "pr-3 pl-22" : "pr-0 pl-3"
        }`}
      >
        <div className="flex-1" />
        {USE_CUSTOM_WINDOW_CONTROLS && <WindowControls closeOnly />}
      </header>
      <div className="min-h-0 flex-1">
        <SettingsContent active={active} onActiveChange={setActive} />
      </div>
    </div>
  );
}
