import { cn } from "@/lib/utils";
import type { SidebarViewId } from "./types";

export const SIDEBAR_RAIL_HEIGHT = 36;

type RailItem = {
  id: SidebarViewId;
  label: string;
};

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
};

export function SidebarRail({ activeView, onSelectView }: Props) {
  const items: RailItem[] = [
    { id: "explorer", label: "Files" },
    { id: "source-control", label: "Source Control" },
  ];

  return (
    <nav
      aria-label="Workspace views"
      style={{ height: SIDEBAR_RAIL_HEIGHT }}
      className="flex shrink-0 items-stretch gap-1 border-b border-border/60 bg-card/85 px-1.5 py-1 backdrop-blur"
    >
      {items.map((item) => {
        const isActive = item.id === activeView;
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={isActive}
            onClick={() => onSelectView(item.id)}
            className={cn(
              "group relative flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[11px] font-medium outline-none transition-colors duration-150",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive
                ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
            )}
          >
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
