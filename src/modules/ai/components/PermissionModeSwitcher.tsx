import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODE_LABELS,
  setPermissionMode,
  type PermissionMode,
} from "@/modules/settings/store";
import {
  Alert02Icon,
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  Edit02Icon,
  Settings01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const ICONS: Record<PermissionMode, typeof CheckmarkCircle02Icon> = {
  ask: CheckmarkCircle02Icon,
  "auto-edit": Edit02Icon,
  bypass: Alert02Icon,
};

const VISIBLE_MODES: readonly PermissionMode[] = ["ask", "auto-edit"];

type Variant = "toolbar" | "toolbar-icon";

export function PermissionModeSwitcher({
  variant = "toolbar",
}: {
  variant?: Variant;
}) {
  const mode = usePreferencesStore((s) => s.permissionMode);
  const bypassEnabled = usePreferencesStore((s) => s.bypassPermissionsEnabled);

  // If bypass got disabled in Settings while it was the active mode, the
  // setter already downgrades to "ask" — but defensively reflect that here
  // for the trigger label.
  const effectiveMode: PermissionMode =
    mode === "bypass" && !bypassEnabled ? "ask" : mode;
  const ActiveIcon = ICONS[effectiveMode];
  const isBypass = effectiveMode === "bypass";
  const isIconOnly = variant === "toolbar-icon";

  const modes: readonly PermissionMode[] = bypassEnabled
    ? [...VISIBLE_MODES, "bypass"]
    : VISIBLE_MODES;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className={cn(
            "group flex h-7 min-w-0 max-w-[10rem] items-center gap-1.5 rounded-md px-2 text-[11.5px] transition-colors hover:bg-accent",
            isBypass
              ? "text-destructive hover:text-destructive"
              : "text-foreground/80 hover:text-foreground",
          )}
          title={`Permission mode: ${PERMISSION_MODE_LABELS[effectiveMode]}`}
        >
          <HugeiconsIcon
            icon={ActiveIcon}
            size={13}
            strokeWidth={1.75}
            className={cn(
              "shrink-0",
              isBypass ? "opacity-100" : "opacity-80",
            )}
          />
          {!isIconOnly && (
            <>
              <span className="truncate font-medium">
                {PERMISSION_MODE_LABELS[effectiveMode]}
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={2}
                className="shrink-0 opacity-60 transition-opacity group-hover:opacity-90"
              />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        sideOffset={6}
        collisionPadding={8}
        align="start"
        className="w-[min(22rem,calc(100vw-1rem))]"
      >
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Permissions
        </div>
        {modes.map((m) => {
          const Icon = ICONS[m];
          const isActive = m === effectiveMode;
          const danger = m === "bypass";
          return (
            <DropdownMenuItem
              key={m}
              onSelect={() => void setPermissionMode(m)}
              className={cn(
                "flex items-start gap-2 pr-2 text-[12px]",
                isActive && "bg-accent/40",
                danger && "focus:bg-destructive/10",
              )}
            >
              <HugeiconsIcon
                icon={Icon}
                size={13}
                strokeWidth={1.75}
                className={cn(
                  "mt-0.5 shrink-0",
                  danger
                    ? "text-destructive"
                    : isActive
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn(danger && "text-destructive")}>
                  {PERMISSION_MODE_LABELS[m]}
                </span>
                <span className="line-clamp-2 text-[10.5px] text-muted-foreground">
                  {PERMISSION_MODE_DESCRIPTIONS[m]}
                </span>
              </span>
              {isActive ? (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={12}
                  strokeWidth={2}
                  className={cn(
                    "mt-0.5 shrink-0",
                    danger ? "text-destructive" : "text-foreground",
                  )}
                />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void openSettingsWindow("general")}
          className="gap-2 text-[12px] text-muted-foreground"
        >
          <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
          Manage permissions…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
