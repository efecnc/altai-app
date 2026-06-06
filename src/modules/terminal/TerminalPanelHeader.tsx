import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { TerminalTab } from "@/modules/tabs";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  ComputerTerminal02Icon,
  Delete02Icon,
  IncognitoIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

type Props = {
  terminals: TerminalTab[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onHide: () => void;
};

const tabDomId = (id: number): string => `terminal-tab-${id}`;

function labelFor(t: TerminalTab): string {
  if (t.private) return "private";
  return t.title || "shell";
}

/**
 * VSCode-style header for the terminal drawer: a tab strip (one tab per
 * terminal) on the left and panel actions (split / new / kill / hide) on the
 * right. Tabs follow the ARIA tablist pattern with roving focus.
 */
export function TerminalPanelHeader({
  terminals,
  activeId,
  onSelect,
  onClose,
  onNew,
  onHide,
}: Props) {
  const ids = terminals.map((t) => t.id);

  const onTabKeyDown = (
    e: ReactKeyboardEvent<HTMLDivElement>,
    id: number,
  ) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
      return;
    }
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = ids.indexOf(id);
    const nextIdx =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? ids.length - 1
          : (i + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
    const nextId = ids[nextIdx];
    onSelect(nextId);
    const list = e.currentTarget.parentElement;
    // Defer the focus move so the SR re-reads the tab after React has flipped
    // aria-selected/tabIndex on re-render (matches AiSidePanel's pattern).
    requestAnimationFrame(() => {
      list?.querySelector<HTMLElement>(`#${tabDomId(nextId)}`)?.focus();
    });
  };

  // Roving-focus entry point: the active tab, or the first tab if there's no
  // active id yet (so Tab never skips the whole tablist).
  const rovingId =
    activeId != null && ids.includes(activeId) ? activeId : ids[0];

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/50 bg-card/40 pl-1 pr-1.5">
      <div
        role="tablist"
        aria-label="Terminals"
        aria-orientation="horizontal"
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {terminals.map((t, i) => {
          const selected = t.id === activeId;
          return (
            <div
              key={t.id}
              id={tabDomId(t.id)}
              role="tab"
              aria-selected={selected}
              aria-label={`${labelFor(t)} terminal, tab ${i + 1} of ${terminals.length}`}
              tabIndex={t.id === rovingId ? 0 : -1}
              onClick={() => onSelect(t.id)}
              onKeyDown={(e) => onTabKeyDown(e, t.id)}
              onAuxClick={(e) => {
                // Middle-click closes the tab, like VSCode.
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(t.id);
                }
              }}
              className={cn(
                "group/term flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-t-2 pl-2.5 pr-1 text-[11px] transition-colors",
                selected
                  ? "border-t-primary bg-background text-foreground"
                  : "border-t-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
              )}
            >
              <HugeiconsIcon
                icon={t.private ? IncognitoIcon : ComputerTerminal02Icon}
                size={13}
                strokeWidth={1.9}
                className="shrink-0"
              />
              <span className="max-w-40 truncate">{labelFor(t)}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                onKeyDown={(e) => {
                  // Don't let Enter/Space bubble to the parent tab's keydown
                  // (which would re-select a tab that's being closed).
                  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                }}
                aria-label={`Close ${labelFor(t)} terminal`}
                className="ml-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/term:opacity-100"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderAction
          icon={PlusSignIcon}
          label={`New terminal (${fmtShortcut(MOD_KEY, "T")})`}
          onClick={onNew}
        />
        <HeaderAction
          icon={Delete02Icon}
          label="Kill terminal"
          onClick={() => activeId != null && onClose(activeId)}
          disabled={activeId == null}
        />
        <HeaderAction
          icon={ArrowDown01Icon}
          label={`Hide panel (${fmtShortcut(MOD_KEY, "J")})`}
          onClick={onHide}
        />
      </div>
    </div>
  );
}

type ActionProps = {
  icon: typeof PlusSignIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

function HeaderAction({ icon, label, onClick, disabled }: ActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <HugeiconsIcon icon={icon} size={15} strokeWidth={1.9} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
