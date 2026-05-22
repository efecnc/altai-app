import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  AbsoluteIcon,
  ArrowDown01Icon,
  AtomicPowerIcon,
  BookSearchIcon,
  CodeIcon,
  DatabaseIcon,
  Notebook01Icon,
  PaintBrush04Icon,
  PencilEdit02Icon,
  Settings01Icon,
  ShieldUserIcon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ISANAGENT_AGENT_IDS, type AgentIconId } from "../lib/agents";
import { useAgentsStore } from "../store/agentsStore";

const ICONS: Record<AgentIconId, typeof CodeIcon> = {
  coder: CodeIcon,
  architect: AbsoluteIcon,
  reviewer: PencilEdit02Icon,
  security: ShieldUserIcon,
  designer: PaintBrush04Icon,
  paper: BookSearchIcon,
  notebook: Notebook01Icon,
  dataset: DatabaseIcon,
  spark: SparklesIcon,
};

type AgentSwitcherVariant = "default" | "mini" | "toolbar" | "toolbar-icon";

export function AgentSwitcher({
  isMiniWindow,
  variant,
}: {
  isMiniWindow?: boolean;
  variant?: AgentSwitcherVariant;
}) {
  // Subscribe to the underlying state so any change (custom agents,
  // disabled set, builtin overrides, active id) re-renders the picker.
  const customAgents = useAgentsStore((s) => s.customAgents);
  const disabledIds = useAgentsStore((s) => s.disabledIds);
  const overrides = useAgentsStore((s) => s.overrides);
  const activeId = useAgentsStore((s) => s.activeId);
  const setActiveId = useAgentsStore((s) => s.setActiveId);

  // Keep these subscriptions live — selectors above are what trigger re-renders.
  void customAgents;
  void disabledIds;
  void overrides;

  const list = useAgentsStore.getState().enabled();
  const allList = useAgentsStore.getState().all();
  // Resolve active from the full list (including disabled) so the trigger
  // still labels the disabled-but-active edge correctly until the store
  // downgrades it on the next setDisabled call.
  const active = allList.find((a) => a.id === activeId) ?? list[0] ?? allList[0];
  const builtIn = list.filter(
    (a) => a.builtIn && !ISANAGENT_AGENT_IDS.has(a.id),
  );
  const mlAgents = list.filter(
    (a) => a.builtIn && ISANAGENT_AGENT_IDS.has(a.id),
  );
  const custom = list.filter((a) => !a.builtIn);
  const ActiveIcon = ICONS[active.icon] ?? SparklesIcon;
  const activeIsMl = ISANAGENT_AGENT_IDS.has(active.id);

  const resolved: AgentSwitcherVariant =
    variant ?? (isMiniWindow ? "mini" : "default");
  const isToolbar = resolved === "toolbar" || resolved === "toolbar-icon";
  const isIconOnly = resolved === "toolbar-icon";
  const dropdownSide = isToolbar ? "top" : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className={cn(
            "group",
            resolved === "default"
              ? "flex h-6 items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 text-[10.5px] text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
              : resolved === "mini"
                ? "text-xs mr-1"
                : isIconOnly
                  ? "flex size-7 items-center justify-center rounded-md p-0 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  : "flex h-7 min-w-0 max-w-[9rem] items-center gap-1.5 rounded-md px-2 text-[11.5px] text-foreground/80 transition-colors hover:bg-accent hover:text-foreground",
          )}
          aria-label={`Switch agent — current: ${active.name}`}
          title={`Agent: ${active.name}`}
        >
          <HugeiconsIcon
            icon={ActiveIcon}
            size={isToolbar ? 13 : 11}
            strokeWidth={1.75}
            className={cn("shrink-0", isToolbar && "opacity-80")}
          />
          {!isIconOnly && (
            <>
              <span
                className={cn(
                  "truncate",
                  isToolbar ? "min-w-0 font-medium" : "max-w-[7rem]",
                )}
              >
                {active.name}
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={isToolbar ? 11 : 10}
                strokeWidth={2}
                className={cn(
                  "shrink-0",
                  isToolbar
                    ? "opacity-60 transition-opacity group-hover:opacity-90"
                    : "opacity-70",
                )}
              />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={dropdownSide}
        sideOffset={isToolbar ? 6 : undefined}
        collisionPadding={isToolbar ? 8 : undefined}
        align="start"
        className={cn(
          "min-w-60",
          isToolbar && "w-[min(22rem,calc(100vw-1rem))]",
        )}
      >
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Built-in
        </div>
        {builtIn.map((a) => {
          const Icon = ICONS[a.icon] ?? SparklesIcon;
          return (
            <DropdownMenuItem
              key={a.id}
              onSelect={() => setActiveId(a.id)}
              className={cn(
                "flex items-start gap-2 pr-2 text-[12px]",
                a.id === activeId && "bg-accent/40",
              )}
            >
              <HugeiconsIcon
                icon={Icon}
                size={13}
                strokeWidth={1.75}
                className={cn(
                  "mt-0.5",
                  a.id === activeId
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{a.name}</span>
                <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                  {a.description}
                </span>
              </span>
              {a.id === activeId ? (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={12}
                  strokeWidth={2}
                  className="mt-0.5 shrink-0 text-foreground"
                />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {mlAgents.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 text-[12px] font-normal",
                activeIsMl && "bg-accent/40",
              )}
            >
              <HugeiconsIcon
                icon={AtomicPowerIcon}
                size={13}
                strokeWidth={1.75}
                className={cn(
                  "shrink-0",
                  activeIsMl ? "text-foreground" : "text-muted-foreground",
                )}
              />
              <span className="flex-1">ML Agents</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              sideOffset={4}
              collisionPadding={8}
              className="min-w-60"
            >
              {mlAgents.map((a) => {
                const Icon = ICONS[a.icon] ?? SparklesIcon;
                return (
                  <DropdownMenuItem
                    key={a.id}
                    onSelect={() => setActiveId(a.id)}
                    className={cn(
                      "flex items-start gap-2 pr-2 text-[12px]",
                      a.id === activeId && "bg-accent/40",
                    )}
                  >
                    <HugeiconsIcon
                      icon={Icon}
                      size={13}
                      strokeWidth={1.75}
                      className={cn(
                        "mt-0.5 shrink-0",
                        a.id === activeId
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{a.name}</span>
                      <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                        {a.description}
                      </span>
                    </span>
                    {a.id === activeId ? (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        size={12}
                        strokeWidth={2}
                        className="mt-0.5 shrink-0 text-foreground"
                      />
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {custom.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Custom
            </div>
            {custom.map((a) => {
              const Icon = ICONS[a.icon] ?? SparklesIcon;
              return (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={() => setActiveId(a.id)}
                  className={cn(
                    "flex items-start gap-2 text-[12px]",
                    a.id === activeId && "bg-accent/40",
                  )}
                >
                  <HugeiconsIcon
                    icon={Icon}
                    size={13}
                    strokeWidth={1.75}
                    className="mt-0.5 text-muted-foreground"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{a.name}</span>
                    {a.description ? (
                      <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                        {a.description}
                      </span>
                    ) : null}
                  </span>
                  {a.id === activeId ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      size={12}
                      strokeWidth={2}
                      className="mt-0.5 shrink-0 text-foreground"
                    />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void openSettingsWindow("agents")}
          className="gap-2 text-[12px] text-muted-foreground"
        >
          <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
          Manage agents…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { ICONS as AGENT_ICONS };
