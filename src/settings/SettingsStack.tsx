import { cn } from "@/lib/utils";
import type { SettingsTab as SettingsSection } from "@/modules/settings/openSettingsWindow";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { normalizeSettingsTab, SettingsContent } from "./SettingsContent";

type SettingsStackProps = {
  tabs: Tab[];
  activeId: number;
  /** Persist the active section onto the tab record so it survives blur/focus. */
  onSectionChange: (tabId: number, section: SettingsSection) => void;
};

/**
 * Hosts every open settings tab as a sibling layer. Today the action is
 * singleton-style (only one settings tab at a time), but rendering as a
 * stack keeps the pattern uniform with NotebookStack and leaves the door
 * open for future "compare settings" use cases.
 */
export function SettingsStack({
  tabs,
  activeId,
  onSectionChange,
}: SettingsStackProps) {
  const settingsTabs = tabs.filter((t) => t.kind === "settings");
  return (
    <>
      {settingsTabs.map((tab) => {
        if (tab.kind !== "settings") return null;
        const isActive = tab.id === activeId;
        const section = normalizeSettingsTab(tab.section);
        return (
          <div
            key={tab.id}
            className={cn(
              "absolute inset-0",
              !isActive && "invisible pointer-events-none",
            )}
            aria-hidden={!isActive}
          >
            <SettingsContent
              active={section}
              onActiveChange={(next) => onSectionChange(tab.id, next)}
            />
          </div>
        );
      })}
    </>
  );
}
