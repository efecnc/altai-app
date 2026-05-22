import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  CHAT_ANNOUNCE_LABELS,
  FOCUS_RING_LABELS,
  REDUCE_MOTION_LABELS,
  resetAccessibility,
  setApprovalAnnounceAssertive,
  setChatAnnounce,
  setFocusRing,
  setHighContrast,
  setLargerText,
  setReduceMotion,
  setShowSkipLinks,
  setTerminalScreenReader,
  setUnderlineLinks,
  type ChatAnnouncePref,
  type FocusRingPref,
  type ReduceMotionPref,
} from "@/modules/settings/store";
import { ArrowDown01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const REDUCE_MOTION_OPTIONS: ReduceMotionPref[] = ["system", "always", "never"];
const FOCUS_RING_OPTIONS: FocusRingPref[] = ["default", "strong"];
const CHAT_ANNOUNCE_OPTIONS: ChatAnnouncePref[] = ["off", "polite", "assertive"];

export function AccessibilitySection() {
  const reduceMotion = usePreferencesStore((s) => s.reduceMotion);
  const highContrast = usePreferencesStore((s) => s.highContrast);
  const largerText = usePreferencesStore((s) => s.largerText);
  const underlineLinks = usePreferencesStore((s) => s.underlineLinks);
  const focusRing = usePreferencesStore((s) => s.focusRing);
  const chatAnnounce = usePreferencesStore((s) => s.chatAnnounce);
  const approvalAssertive = usePreferencesStore(
    (s) => s.approvalAnnounceAssertive,
  );
  const terminalScreenReader = usePreferencesStore(
    (s) => s.terminalScreenReader,
  );
  const showSkipLinks = usePreferencesStore((s) => s.showSkipLinks);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Accessibility"
        description="Tune ALTAI for screen readers, keyboard navigation, low vision, and reduced motion. Every setting persists across sessions and applies live — no restart."
      />

      <SubsectionLabel>Motion &amp; visuals</SubsectionLabel>
      <div className="flex flex-col gap-2">
        <SettingRow
          title="Reduce motion"
          description="Disables UI animations, the streaming-chat fade, the agent-status pulse, and Radix collapsible transitions. Default follows the OS setting (System Settings → Accessibility → Display → Reduce motion on macOS / equivalent elsewhere)."
        >
          <PickerDropdown
            value={reduceMotion}
            options={REDUCE_MOTION_OPTIONS}
            labels={REDUCE_MOTION_LABELS}
            onPick={(v) => void setReduceMotion(v)}
          />
        </SettingRow>

        <SettingRow
          title="High contrast"
          description="Darkens secondary text and strengthens borders so muted UI elements meet WCAG AA 4.5:1. Useful in low-vision setups and outdoors."
        >
          <Switch
            checked={highContrast}
            onCheckedChange={(v) => void setHighContrast(v)}
          />
        </SettingRow>

        <SettingRow
          title="Larger interface text"
          description="Bumps the root font-size by ~10%. All UI labels, buttons, chat text, and settings scale together. Independent from the editor and terminal font sizes."
        >
          <Switch
            checked={largerText}
            onCheckedChange={(v) => void setLargerText(v)}
          />
        </SettingRow>

        <SettingRow
          title="Always underline links"
          description="Adds an underline to every text link so it's perceivable without color. Excludes button-styled links."
        >
          <Switch
            checked={underlineLinks}
            onCheckedChange={(v) => void setUnderlineLinks(v)}
          />
        </SettingRow>
      </div>

      <SubsectionLabel>Keyboard</SubsectionLabel>
      <div className="flex flex-col gap-2">
        <SettingRow
          title="Focus ring"
          description="Strong mode widens the ring to 4 px, raises contrast, and forces it visible on both mouse and keyboard focus — easier to track when tabbing through dense UI."
        >
          <PickerDropdown
            value={focusRing}
            options={FOCUS_RING_OPTIONS}
            labels={FOCUS_RING_LABELS}
            onPick={(v) => void setFocusRing(v)}
          />
        </SettingRow>

        <SettingRow
          title="Show skip links"
          description="Adds visible Skip to main / Skip to AI assistant links at the top of the window. Always reachable via Tab from the first focusable element; toggling on makes them visible even before focus."
        >
          <Switch
            checked={showSkipLinks}
            onCheckedChange={(v) => void setShowSkipLinks(v)}
          />
        </SettingRow>
      </div>

      <SubsectionLabel>Screen readers</SubsectionLabel>
      <div className="flex flex-col gap-2">
        <SettingRow
          title="Announce chat messages"
          description="Polite (default) lets the screen reader finish what it's saying before announcing the next streamed token. Assertive interrupts immediately. Off disables announcement entirely (useful with screen-reader navigation modes that read the log on demand)."
        >
          <PickerDropdown
            value={chatAnnounce}
            options={CHAT_ANNOUNCE_OPTIONS}
            labels={CHAT_ANNOUNCE_LABELS}
            onPick={(v) => void setChatAnnounce(v)}
          />
        </SettingRow>

        <SettingRow
          title="Announce permission prompts assertively"
          description='When the agent stops to ask for permission ("approve this shell command?"), announce it via an assertive live region so the screen reader interrupts whatever it was reading. Strongly recommended on — silent permission prompts can make the agent appear hung.'
        >
          <Switch
            checked={approvalAssertive}
            onCheckedChange={(v) => void setApprovalAnnounceAssertive(v)}
          />
        </SettingRow>

        <SettingRow
          title="Terminal screen-reader mode"
          description="Mirrors xterm.js output into an off-screen aria-live region so VoiceOver / NVDA / JAWS / Orca can read terminal text. Small perf cost on busy terminals (parallel ARIA buffer); leave on unless you confirm a slowdown."
        >
          <Switch
            checked={terminalScreenReader}
            onCheckedChange={(v) => void setTerminalScreenReader(v)}
          />
        </SettingRow>
      </div>

      <div className="mt-2 flex items-center justify-between rounded-lg border border-border/40 bg-card/40 px-3 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[12.5px] font-medium">Reset accessibility settings</span>
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            Restore every option above to its default value. Other settings
            (theme, models, shortcuts) are not touched.
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void resetAccessibility()}
          className="h-7 gap-1.5 px-2.5 text-[11.5px]"
        >
          <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />
          Reset
        </Button>
      </div>
    </div>
  );
}

function SubsectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="-mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function PickerDropdown<T extends string>({
  value,
  options,
  labels,
  onPick,
}: {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onPick: (next: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 min-w-44 justify-between gap-2 px-2.5 text-[11.5px]"
          aria-label={labels[value]}
        >
          <span>{labels[value]}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={12}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {options.map((o) => (
          <DropdownMenuItem
            key={o}
            onSelect={() => onPick(o)}
            className={cn("text-[12px]", o === value && "bg-accent/50")}
          >
            {labels[o]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
