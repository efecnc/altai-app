import { LazyStore } from "@tauri-apps/plugin-store";

/** What an agent run was assigned to work on. */
export type AssignmentSource =
  | { kind: "issue"; owner: string; repo: string; number: number; url: string }
  | { kind: "pr"; owner: string; repo: string; number: number; url: string }
  | { kind: "todo"; todoId: string };

export type AssignmentStatus =
  | "dispatching"
  | "running"
  | "awaiting-approval"
  | "done"
  | "failed"
  | "cancelled";

/** One assignment = one ALTAI session = one IsanAgent chat_id (1:1). */
export interface Assignment {
  id: string;
  source: AssignmentSource;
  /** The ALTAI session / IsanAgent chat_id driving this work. */
  sessionId: string;
  title: string;
  status: AssignmentStatus;
  createdAt: number;
  updatedAt: number;
}

const STORE_PATH = "altai-assignments.json";
const KEY = "assignments";
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadAssignments(): Promise<Assignment[]> {
  const list = await store.get<Assignment[]>(KEY);
  return Array.isArray(list) ? list : [];
}

export async function saveAssignments(list: Assignment[]): Promise<void> {
  await store.set(KEY, list);
  await store.save();
}

function clip(text: string, max = 4000): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n…(truncated)` : t;
}

/** Seed prompt for an issue/PR assignment. */
export function buildItemSeed(input: {
  kind: "issue" | "pr";
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
}): string {
  const noun = input.kind === "pr" ? "pull request" : "issue";
  const verb =
    input.kind === "pr"
      ? "Review it, address any problems, and push the needed changes."
      : "Investigate and complete it end-to-end.";
  return [
    `You've been assigned to work on a GitHub ${noun}.`,
    ``,
    `Repository: ${input.owner}/${input.repo}`,
    `${noun === "issue" ? "Issue" : "PR"} #${input.number}: ${input.title}`,
    ``,
    input.body ? clip(input.body) : "(no description provided)",
    ``,
    `${verb} Use todo_write to lay out your plan, and spawn sub-agents for independent parts as needed. When finished, summarize what you did.`,
  ].join("\n");
}

/** Seed prompt for a local todo assignment. */
export function buildTodoSeed(title: string, description?: string): string {
  return [
    `You've been assigned to complete this task:`,
    ``,
    title,
    description ? `\n${clip(description)}` : "",
    ``,
    `Use todo_write to track sub-steps and spawn sub-agents where it helps. Summarize the outcome when done.`,
  ].join("\n");
}
