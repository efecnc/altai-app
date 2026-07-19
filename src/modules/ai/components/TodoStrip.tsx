import {
  CheckListIcon,
  CheckmarkCircle01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  parseTodoItems,
  TodoChecklist,
} from "@/components/ai-elements/todo-checklist";
import type { Todo } from "../lib/todos";
import { useTodosStore } from "../store/todoStore";

type Props = { sessionId: string | null };

const EMPTY_TODOS: Todo[] = [];

/**
 * Compact header chip that surfaces live plan progress at a glance. The full
 * checklist renders inline inside the chat via the `todo_write` tool card, so
 * this is a secondary summary — a clickable chip with `done/total` + a tiny
 * progress bar that opens a popover with the complete list for quick reference
 * without scrolling the transcript.
 */
export function TodoSummaryChip({ sessionId }: Props) {
  const hydrate = useTodosStore((s) => s.hydrate);
  const todos =
    useTodosStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ??
    EMPTY_TODOS;

  useEffect(() => {
    if (sessionId) void hydrate(sessionId);
  }, [sessionId, hydrate]);

  if (!sessionId || todos.length === 0) return null;

  const done = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const pct = Math.round((done / total) * 100);
  const allDone = done === total;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={
            allDone
              ? `Plan complete · ${done}/${total} tasks`
              : `Plan in progress · ${done}/${total} tasks`
          }
          aria-label={`Plan: ${done} of ${total} tasks done`}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-1.5",
            "text-[11px] transition-colors",
            "hover:bg-foreground/[0.06]",
            allDone
              ? "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300"
              : "border-border/50 bg-card/60 text-muted-foreground hover:text-foreground",
          )}
        >
          <HugeiconsIcon
            icon={allDone ? CheckmarkCircle01Icon : CheckListIcon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0"
          />
          <span className="tabular-nums font-medium">
            {done}/{total}
          </span>
          {!allDone ? (
            <span className="relative h-1 w-10 overflow-hidden rounded-full bg-muted">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-foreground/60 transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-72 p-0"
      >
        <TodoSummaryPopover todos={todos} done={done} total={total} pct={pct} />
      </PopoverContent>
    </Popover>
  );
}
function TodoSummaryPopover({
  todos,
  done,
  total,
  pct,
}: {
  todos: Todo[];
  done: number;
  total: number;
  pct: number;
}) {
  const items = parseTodoItems({ items: todos });
  return (
    <div className="flex max-h-80 min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <HugeiconsIcon
          icon={CheckListIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[12px] font-medium text-foreground">Plan</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-foreground/60 transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 py-1.5">
          <TodoChecklist items={items} />
        </div>
      </ScrollArea>
    </div>
  );
}
