"use client";

import { cn } from "@/lib/utils";
import {
  CheckmarkCircle01Icon,
  CancelCircleIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";

export type TodoItemStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  id?: string;
  title: string;
  description?: string;
  status: TodoItemStatus;
};

export type TodoChecklistProps = ComponentProps<"ul"> & {
  items: TodoItem[];
  /** Smaller / denser variant — used inside the inline tool card. */
  dense?: boolean;
};

/**
 * Shared todo checklist renderer. Used both by the inline `todo_write` tool
 * card (dense) and the standalone todo summary. Each row carries a status
 * glyph (spinner / check / dash), the title, and an optional progress bar is
 * the caller's concern.
 */
export function TodoChecklist({
  items,
  dense = false,
  className,
  ...props
}: TodoChecklistProps) {
  return (
    <ul
      className={cn(
        "flex flex-col gap-0.5",
        dense ? "text-[11.5px]" : "text-[12px]",
        className,
      )}
      {...props}
    >
      {items.map((item, i) => (
        <TodoChecklistRow key={item.id ?? i} item={item} dense={dense} />
      ))}
    </ul>
  );
}

function TodoChecklistRow({
  item,
  dense,
}: {
  item: TodoItem;
  dense: boolean;
}) {
  const isInProgress = item.status === "in_progress";
  const isDone = item.status === "completed";
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-sm",
        dense ? "px-1 py-0.5" : "px-1.5 py-1",
        isInProgress && "bg-muted/40",
      )}
    >
      <span className="mt-[2px] inline-flex size-3.5 shrink-0 items-center justify-center">
        {isInProgress ? (
          <HugeiconsIcon
            icon={Loading03Icon}
            size={13}
            strokeWidth={1.75}
            className="animate-spin text-foreground"
          />
        ) : isDone ? (
          <HugeiconsIcon
            icon={CheckmarkCircle01Icon}
            size={13}
            strokeWidth={1.75}
            className="text-emerald-600 dark:text-emerald-400"
          />
        ) : (
          <HugeiconsIcon
            icon={CancelCircleIcon}
            size={13}
            strokeWidth={1.75}
            className="text-muted-foreground/40"
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 leading-snug",
          isDone
            ? "text-muted-foreground/70 line-through"
            : isInProgress
              ? "text-foreground"
              : "text-muted-foreground",
        )}
      >
        {item.title}
        {item.description ? (
          <span className="block text-[10.5px] text-muted-foreground/70">
            {item.description}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/**
 * Parse the agent's free-form `todo_write` input items into the strict
 * TodoItem shape. Field names vary by model — content/title/task/text are all
 * observed — so each item is read defensively. Mirrors the normalization in
 * `agentEventBridge.ts` so the inline card matches the persisted store.
 */
export function parseTodoItems(input: unknown): TodoItem[] {
  if (!input || typeof input !== "object") return [];
  const items = (input as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.map((raw, i) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const title =
      (typeof it.content === "string" && it.content) ||
      (typeof it.title === "string" && it.title) ||
      (typeof it.task === "string" && it.task) ||
      (typeof it.text === "string" && it.text) ||
      "Untitled task";
    const id = typeof it.id === "string" ? it.id : `item-${i}`;
    const description =
      typeof it.description === "string" ? it.description : undefined;
    return {
      id,
      title,
      description,
      status: normalizeStatus(it.status),
    };
  });
}

function normalizeStatus(value: unknown): TodoItemStatus {
  const v =
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
  if (["completed", "complete", "done", "finished"].includes(v))
    return "completed";
  if (
    ["in_progress", "active", "running", "doing", "started", "wip"].includes(v)
  )
    return "in_progress";
  return "pending";
}

export function summarizeTodos(items: TodoItem[]): {
  total: number;
  done: number;
  inProgress: number;
  pct: number;
} {
  const total = items.length;
  const done = items.filter((i) => i.status === "completed").length;
  const inProgress = items.filter((i) => i.status === "in_progress").length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, inProgress, pct };
}
