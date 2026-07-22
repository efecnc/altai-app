import { create } from "zustand";
import type {
  AgentEvent,
  ParsedAgentEvent,
  RunBudgetWarning,
  RunOutcome,
} from "../lib/agentEventBridge";
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
export type RunChange = {
  path: string;
  source: string;
  before?: string;
  after?: string;
  hunkId?: string;
};

/** Per-session (chat_id) run state, tracked for EVERY session — not just the
 *  focused one — so a project board can watch many dispatched agents at once. */
export type RunState = {
  runId: string | null;
  lastSeq: number;
  outcome: RunOutcome | null;
  warning: RunBudgetWarning | null;
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
  runId: null,
  lastSeq: 0,
  outcome: null,
  warning: null,
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
  admitAccepted: (chatId: string, runId: string) => boolean;
  ingest: (chatId: string, ev: ParsedAgentEvent) => boolean;
  markCancelling: (chatId: string, runId: string) => boolean;
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
  admitAccepted: (chatId, runId) => {
    let accepted = false;
    set((s) => {
      const current = s.runs[chatId];
      // Events may outrun the IPC acknowledgement. If this exact run already
      // exists (even terminal), the acknowledgement confirms it and must not
      // reset newer lifecycle state back to an admitted placeholder.
      if (current?.runId === runId) {
        accepted = true;
        return s;
      }
      if (current && !current.completed) return s;
      accepted = true;
      return {
        runs: {
          ...s.runs,
          [chatId]: { ...EMPTY, runId, status: "thinking" },
        },
      };
    });
    return accepted;
  },
  ingest: (chatId, ev) => {
    let accepted = false;
    set((s) => {
      const cur = s.runs[chatId] ?? EMPTY;
      const next = reduce(cur, ev);
      if (next === cur) return s;
      accepted = true;
      return { runs: { ...s.runs, [chatId]: next } };
    });
    return accepted;
  },
  markCancelling: (chatId, runId) => {
    let accepted = false;
    set((s) => {
      const current = s.runs[chatId];
      if (
        !current ||
        current.runId !== runId ||
        current.completed ||
        current.status === "cancelling"
      ) {
        return s;
      }
      accepted = true;
      return {
        runs: {
          ...s.runs,
          [chatId]: { ...current, status: "cancelling", step: null },
        },
      };
    });
    return accepted;
  },
  clear: (chatId) =>
    set((s) => {
      if (!(chatId in s.runs)) return s;
      const rest = { ...s.runs };
      delete rest[chatId];
      return { runs: rest };
    }),
}));

function reduce(cur: RunState, ev: ParsedAgentEvent): RunState {
  if (ev.version === 1) {
    if (ev.type === "run_started") {
      const confirmsAcceptedRun =
        cur.runId === ev.run_id && cur.lastSeq === 0 && !cur.completed;
      if (
        ev.seq !== 1 ||
        (cur.runId !== null && !cur.completed && !confirmsAcceptedRun)
      ) {
        return cur;
      }
    } else if (
      !ev.run_id ||
      ev.run_id !== cur.runId ||
      !ev.seq ||
      ev.seq <= cur.lastSeq
    ) {
      return cur;
    }
  }
  if (ev.version === 1 && ev.type !== "run_started") {
    cur = { ...cur, lastSeq: ev.seq!, runId: ev.run_id! };
  }
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
      return {
        ...cur,
        changes: addChange(cur.changes, {
          path: ev.file,
          source: "agent edit",
          before: ev.before,
          after: ev.after,
          hunkId: ev.hunk_id,
        }),
      };
    case "agent_message":
      // Content never completes a run; lifecycle owns terminal state.
      return ev.role === "assistant"
        ? {
            ...cur,
            lastResult: ev.content,
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
    case "clarification":
      return { ...cur, status: "awaiting-approval", step: null };
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
    case "run_started":
      return {
        ...EMPTY,
        runId: ev.run_id,
        lastSeq: ev.seq ?? 1,
        status:
          cur.runId === ev.run_id && cur.status === "cancelling"
            ? "cancelling"
            : "thinking",
      };
    case "run_warning":
      return {
        ...cur,
        status: cur.status === "cancelling" ? "cancelling" : "thinking",
        warning: ev.warning,
      };
    case "run_terminated": {
      const succeeded =
        ev.outcome.kind === "completed" || ev.outcome.kind === "cancelled";
      return {
        ...cur,
        status: succeeded ? "idle" : "error",
        step: null,
        completed: true,
        outcome: ev.outcome,
      };
    }
    case "done":
      return cur;
    case "error":
      return { ...cur, failures: [...cur.failures, ev.message].slice(-10) };
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
  const existing = list.find((item) => item.path === change.path);
  if (!existing) return [...list, change].slice(-80);
  return list.map((item) =>
    item.path === change.path ? { ...item, ...change } : item,
  );
}

function addVerification(list: RunVerification[], item: RunVerification): RunVerification[] {
  return [...list.filter((entry) => entry.id !== item.id), item].slice(-20);
}
