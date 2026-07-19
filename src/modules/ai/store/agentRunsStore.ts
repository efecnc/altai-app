import { create } from "zustand";
import type { AgentEvent } from "../lib/agentEventBridge";
import type { AgentRunStatus, SubagentTask } from "./chatStore";

export type RunTokens = { input: number; output: number; cached: number };
export type RunVerification = {
  id: string;
  label: string;
  /** The command when the tool exposes one; never required for a result. */
  command?: string;
  status: "running" | "passed" | "failed" | "unknown";
  detail?: string;
};
export type RunChange = { path: string; source: string };

/** Per-session (chat_id) run state, tracked for EVERY session — not just the
 *  focused one — so a project board can watch many dispatched agents at once. */
export type RunState = {
  status: AgentRunStatus;
  step: string | null;
  tokens: RunTokens;
  subagents: SubagentTask[];
  /** The run's last assistant message — its result/summary. */
  lastResult: string | null;
  /** Build/test/lint executions observed from the agent telemetry. */
  verifications: RunVerification[];
  /** Files the runtime reported as changed during this run. */
  changes: RunChange[];
  /** Non-verification tool errors, surfaced in the final outcome. */
  failures: string[];
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
  verifications: [],
  changes: [],
  failures: [],
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
    case "tool_call_start": {
      const check = verificationFromToolStart(ev);
      const change = changeFromToolStart(ev);
      return {
        ...cur,
        status: "streaming",
        step: ev.name,
        verifications: check
          ? [...cur.verifications.filter((item) => item.id !== check.id), check].slice(-20)
          : cur.verifications,
        changes: change ? addChange(cur.changes, change) : cur.changes,
      };
    }
    case "tool_call_end": {
      const existing = cur.verifications.find((item) => item.id === ev.id);
      if (existing) {
        const result = verificationResult(ev.output, ev.error);
        return {
          ...cur,
          step: ev.error ? `${existing.label} failed` : cur.step,
          verifications: cur.verifications.map((item) =>
            item.id === ev.id ? { ...item, ...result } : item,
          ),
          failures: ev.error ? [...cur.failures, `${existing.label}: ${ev.error}`].slice(-10) : cur.failures,
        };
      }
      return ev.error
        ? { ...cur, step: `${ev.id} (error)`, failures: [...cur.failures, ev.error].slice(-10) }
        : cur;
    }
    case "edit_diff":
      return { ...cur, changes: addChange(cur.changes, { path: ev.file, source: "agent edit" }) };
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
    case "execution_run_finished":
      return {
        ...cur,
        verifications: addVerification(cur.verifications, {
          id: `execution:${ev.session_id}:${ev.duration_ms}`,
          label: ev.description || "Execution run",
          status: ev.exit_code === 0 ? "passed" : ev.exit_code === null ? "unknown" : "failed",
          detail: `exit ${ev.exit_code ?? "?"} · ${(ev.duration_ms / 1000).toFixed(1)}s`,
        }),
      };
    case "execution_job_finished":
      return {
        ...cur,
        verifications: addVerification(cur.verifications, {
          id: `job:${ev.job_id}`,
          label: ev.description || `Background job ${ev.job_id}`,
          status: ev.status === "success" || ev.exit_code === 0 ? "passed" : ev.exit_code === null ? "unknown" : "failed",
          detail: `exit ${ev.exit_code ?? "?"} · ${(ev.duration_ms / 1000).toFixed(1)}s`,
        }),
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

function stringField(input: unknown, names: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function verificationFromToolStart(
  ev: Extract<AgentEvent, { type: "tool_call_start" }>,
): RunVerification | null {
  const command = stringField(ev.input, ["command", "cmd", "script"]);
  const text = `${ev.name} ${command ?? ""}`.toLowerCase();
  if (!/\b(test|tests|lint|typecheck|type-check|check|build)\b/.test(text)) return null;
  return {
    id: ev.id,
    label: command ? command.slice(0, 100) : ev.name,
    command,
    status: "running",
  };
}

function changeFromToolStart(
  ev: Extract<AgentEvent, { type: "tool_call_start" }>,
): RunChange | null {
  if (!/(write|edit|patch|create_directory)/i.test(ev.name)) return null;
  const path = stringField(ev.input, ["path", "file", "file_path"]);
  return path ? { path, source: ev.name } : null;
}

function verificationResult(output: unknown, error?: string): Pick<RunVerification, "status" | "detail"> {
  if (error) return { status: "failed", detail: error };
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    const code = record.exit_code ?? record.exitCode ?? record.code;
    if (typeof code === "number") {
      return { status: code === 0 ? "passed" : "failed", detail: `exit ${code}` };
    }
    if (record.success === false || record.ok === false || record.is_error === true) {
      return { status: "failed", detail: stringField(output, ["error", "stderr", "message"]) };
    }
  }
  return { status: "passed" };
}

function addChange(list: RunChange[], change: RunChange): RunChange[] {
  return list.some((item) => item.path === change.path)
    ? list
    : [...list, change].slice(-80);
}

function addVerification(list: RunVerification[], item: RunVerification): RunVerification[] {
  return [...list.filter((entry) => entry.id !== item.id), item].slice(-20);
}
