import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiScanIcon,
  CodeSquareIcon,
  GithubIcon,
  InformationCircleIcon,
  Layers02Icon,
  Notebook01Icon,
  PuzzleIcon,
  PlugIcon,
  Settings01Icon,
  UniversalAccessIcon,
  UserMultiple02Icon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { JSX, useEffect } from "react";
import { AboutSection } from "./sections/AboutSection";
import { AccessibilitySection } from "./sections/AccessibilitySection";
import { AgentsSection } from "./sections/AgentsSection";
import { ContextSection } from "./sections/ContextSection";
import { GeneralSection } from "./sections/GeneralSection";
import { GitHubSection } from "./sections/GitHubSection";
import { LanguageServersSection } from "./sections/LanguageServersSection";
import { McpSection } from "./sections/McpSection";
import { ModelsSection } from "./sections/ModelsSection";
import { ProjectIntelligenceSection } from "./sections/ProjectIntelligenceSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { SkillsSection } from "./sections/SkillsSection";

const TABS: {
  id: SettingsTab;
  label: string;
  icon: typeof Settings01Icon;
  component: () => JSX.Element;
}[] = [
  { id: "general", label: "General", icon: Settings01Icon, component: GeneralSection },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon, component: ShortcutsSection },
  { id: "models", label: "Models", icon: AiScanIcon, component: ModelsSection },
  { id: "context", label: "Context", icon: Layers02Icon, component: ContextSection },
  { id: "project", label: "Project", icon: Notebook01Icon, component: ProjectIntelligenceSection },
  { id: "agents", label: "Agents", icon: UserMultiple02Icon, component: AgentsSection },
  { id: "skills", label: "Skills", icon: PuzzleIcon, component: SkillsSection },
  { id: "github", label: "GitHub", icon: GithubIcon, component: GitHubSection },
  { id: "language-servers", label: "Languages", icon: CodeSquareIcon, component: LanguageServersSection },
  { id: "mcp", label: "MCP", icon: PlugIcon, component: McpSection },
  { id: "accessibility", label: "Accessibility", icon: UniversalAccessIcon, component: AccessibilitySection },
  { id: "about", label: "About", icon: InformationCircleIcon, component: AboutSection },
];

export const VALID_SETTINGS_TABS: SettingsTab[] = TABS.map((t) => t.id);

/** Normalize legacy / unknown section ids. */
export function normalizeSettingsTab(input: string | undefined): SettingsTab {
  if (input === "ai" || input === "connections") return "models";
  if (input === "plugins" || input === "marketplace") return "general";
  if (input === "compaction" || input === "isanagentignore") return "context";
  if (input && (VALID_SETTINGS_TABS as string[]).includes(input)) {
    return input as SettingsTab;
  }
  return "general";
}

/**
 * The reusable inner surface of the settings UI. Renders the tab strip
 * plus the active section, without any window chrome. Used both by the
 * legacy `SettingsApp` window entry and by the in-tab `SettingsPane`.
 *
 * The active section is fully controlled — the host owns it so it can
 * persist across re-mounts (e.g. survive tab focus/unfocus).
 */
export function SettingsContent({
  active,
  onActiveChange,
}: {
  active: SettingsTab;
  onActiveChange: (next: SettingsTab) => void;
}) {
  const init = usePreferencesStore((s) => s.init);
  const ActiveSection = TABS.find((t) => t.id === active)?.component;

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center border-b border-border/60 bg-card/30 px-3">
        <Tabs
          value={active}
          onValueChange={(v) => onActiveChange(v as SettingsTab)}
          orientation="horizontal"
          className="flex min-w-0 flex-1 items-center"
        >
          <TabsList className="mx-auto h-7 max-w-full overflow-x-auto bg-muted/40 px-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="h-6 gap-1.5 px-2.5 text-[11.5px]"
              >
                <HugeiconsIcon icon={t.icon} size={12} strokeWidth={1.75} />
                <span>{t.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-7 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto w-full max-w-160">
          {ActiveSection ? <ActiveSection /> : null}
        </div>
      </main>
    </div>
  );
}
