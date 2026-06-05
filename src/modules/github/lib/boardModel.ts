import type { Todo } from "@/modules/ai/lib/todos";
import type { SubagentTask } from "@/modules/ai/store/chatStore";
import type { GHItem } from "./items";

export type BoardStatus = "todo" | "in_progress" | "done";
export type BoardSource = "issue" | "pr" | "todo" | "agent";
export type CardBadge = "open" | "closed" | "merged" | "draft" | null;

/** A unified card on the overview board, regardless of where it came from. */
export type BoardItem = {
  key: string;
  source: BoardSource;
  title: string;
  status: BoardStatus;
  number: number | null;
  url: string | null;
  badge: CardBadge;
  /** Secondary line, e.g. author or agent type. */
  meta: string | null;
};

export const BOARD_COLUMNS: { id: BoardStatus; name: string }[] = [
  { id: "todo", name: "Todo" },
  { id: "in_progress", name: "In Progress" },
  { id: "done", name: "Done" },
];

/** Open issue → Todo; closed issue → Done. */
export function issueToBoardItem(it: GHItem): BoardItem {
  const done = it.state === "closed";
  return {
    key: `issue-${it.number}`,
    source: "issue",
    title: it.title,
    status: done ? "done" : "todo",
    number: it.number,
    url: it.html_url,
    badge: done ? "closed" : "open",
    meta: it.user ? `@${it.user.login}` : null,
  };
}

/** Open PR → In Progress; merged/closed PR → Done; draft stays In Progress. */
export function pullToBoardItem(it: GHItem): BoardItem {
  const closed = it.state === "closed";
  const merged = !!(it.merged_at ?? it.pull_request?.merged_at);
  return {
    key: `pr-${it.number}`,
    source: "pr",
    title: it.title,
    status: closed ? "done" : "in_progress",
    number: it.number,
    url: it.html_url,
    badge: merged ? "merged" : closed ? "closed" : it.draft ? "draft" : "open",
    meta: it.user ? `@${it.user.login}` : null,
  };
}

const TODO_STATUS: Record<Todo["status"], BoardStatus> = {
  pending: "todo",
  in_progress: "in_progress",
  completed: "done",
};

export function todoToBoardItem(todo: Todo, index: number): BoardItem {
  return {
    key: `todo-${todo.id || index}`,
    source: "todo",
    title: todo.title,
    status: TODO_STATUS[todo.status],
    number: null,
    url: null,
    badge: null,
    meta: "agent plan",
  };
}

/** Active sub-agents are work in progress. */
export function agentToBoardItem(task: SubagentTask): BoardItem {
  return {
    key: `agent-${task.taskId}`,
    source: "agent",
    title: task.displayName || task.agentName || "Sub-agent",
    status: "in_progress",
    number: null,
    url: null,
    badge: null,
    meta: task.agentName ? `agent · ${task.agentName}` : "agent",
  };
}
