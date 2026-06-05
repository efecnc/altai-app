import { create } from "zustand";
import type { AgentEvent } from "../lib/agentEventBridge";
import type { AgentRunStatus, SubagentTask } from "./chatStore";

export type RunTokens = { input: number; output: number; cached: number };

/** Per-session (chat_id) run state, tracked for EVERY session — not just the
 *  focused one — so a project board can watch many dispatched agents at once. */
export type RunState = {
  status: AgentRunStatus;
  step: string | null;
  tokens: RunTokens;
  subagents: SubagentTask[];
  /** The run's last assistant message — its result/summary. */
  lastResult: string | null;
  /**
   * True only after a real terminal signal (final assistant message / done).
   * The initial/`usage`-first state is `idle` too, so `idle` alone must NOT be
   * read as "finished" — callers gate "done" on this flag.
   */
  completed: boolean;
};

const EMPTY: RunState = {
  status: "idle",
  step: null,
  tokens: { input: 0, output: 0, cached: 0 },
  subagents: [],
  lastResult: null,
  completed: false,
};

type State = {
  runs: Record<string, RunState>;
  ingest: (chatId: string, ev: AgentEvent) => void;
  clear: (chatId: string) => void;
};

/**
 * A registry fed by the agent event bridge BEFORE its per-session active-chat
 * filter, so every run's status/sub-agents/tokens are tracked by chat_id
 * regardless of which chat is on screen. The chat UI keeps using the global
 * `agentMeta`; this is a parallel, isolation-safe sink for background runs.
 */
export const useAgentRunsStore = create<State>((set) => ({
  runs: {},
  ingest: (chatId, ev) =>
    set((s) => {
      const cur = s.runs[chatId] ?? EMPTY;
      const next = reduce(cur, ev);
      if (next === cur) return s;
      return { runs: { ...s.runs, [chatId]: next } };
    }),
  clear: (chatId) =>
    set((s) => {
      if (!(chatId in s.runs)) return s;
      const rest = { ...s.runs };
      delete rest[chatId];
      return { runs: rest };
    }),
}));

function reduce(cur: RunState, ev: AgentEvent): RunState {
  switch (ev.type) {
    case "thinking":
      return { ...cur, status: "thinking", step: ev.content };
    case "tool_call_start":
      return { ...cur, status: "streaming", step: ev.name };
    case "tool_call_end":
      return ev.error ? { ...cur, step: `${ev.id} (error)` } : cur;
    case "agent_message":
      // A final assistant message is the closest we have to a per-run "done";
      // capture it as the result and mark the run completed.
      return ev.role === "assistant"
        ? {
            ...cur,
            status: "idle",
            step: null,
            lastResult: ev.content,
            completed: true,
          }
        : cur;
    case "usage":
      return {
        ...cur,
        tokens: {
          input: cur.tokens.input + ev.prompt_tokens,
          output: cur.tokens.output + ev.completion_tokens,
          cached: cur.tokens.cached + ev.cache_read_tokens,
        },
      };
    case "approval_request":
      return { ...cur, status: "awaiting-approval" };
    case "subagent_spawned":
      if (cur.subagents.some((t) => t.taskId === ev.task_id)) return cur;
      return {
        ...cur,
        subagents: [
          ...cur.subagents,
          {
            taskId: ev.task_id,
            childChatId: ev.child_chat_id,
            displayName: ev.display_name,
            agentName: ev.agent_name,
          },
        ],
      };
    case "subagent_finished":
      return {
        ...cur,
        subagents: cur.subagents.filter((t) => t.taskId !== ev.task_id),
      };
    case "done":
      return { ...cur, status: "idle", step: null, completed: true };
    case "error":
      return { ...cur, status: "error", step: null };
    default:
      return cur;
  }
}
