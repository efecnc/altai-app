import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { plural } from "@/lib/utils";
import { useChatStore } from "../store/chatStore";
import { useAgentRunsStore } from "../store/agentRunsStore";
import { useTodosStore } from "../store/todoStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { appendBackgroundMessage } from "./backgroundTranscript";
import { pruneOldToolOutputs } from "./compaction";
import type { Todo, TodoStatus } from "./todos";
import { parseMcpToolName, type McpToolInfo } from "@/modules/mcp/toolName";
import { currentWorkspaceFolder } from "@/modules/workspace/folder";
import { z } from "zod";

/**
 * Trust-boundary schema for the `todo_write` tool input (model-produced, so
 * untrusted). We validate the *structure* — an `items` array of objects — then
 * read each item's fields defensively below, since their names vary by model.
 */
const todoWriteSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
});

const RESEARCH_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "arxiv_search",
  "arxiv_fetch",
  "hf_hub_file_fetch",
]);

const activeMcpCalls = new Map<string, McpToolInfo>();

function activityKindForTool(name: string): "research" | "mcp" | "tool" {
  if (parseMcpToolName(name)) return "mcp";
  return RESEARCH_TOOL_NAMES.has(name) ? "research" : "tool";
}

/** Normalize the agent's free-form todo status into the app's TodoStatus.
 *  Case-insensitive + tolerant of common LLM variants. */
function toTodoStatus(value: unknown): TodoStatus {
  const v = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (["completed", "complete", "done", "finished"].includes(v)) return "completed";
  if (["in_progress", "active", "running", "doing", "started", "wip"].includes(v)) {
    return "in_progress";
  }
  return "pending";
}

/**
 * Mirror a `todo_write` tool call into the per-session todo store so the agent's
 * plan flows to the Todo strip AND the project board. The runtime never feeds
 * `todoStore` otherwise — this bridge is the "make a TODO → it shows up" hook.
 * Field names vary, so each item is read defensively.
 */
function ingestTodoWrite(input: unknown, sessionId: string | null): void {
  if (!sessionId) return;
  const parsed = todoWriteSchema.safeParse(input);
  if (!parsed.success) return;
  const todos: Todo[] = parsed.data.items.map((it, i) => {
    const title =
      (typeof it.content === "string" && it.content) ||
      (typeof it.title === "string" && it.title) ||
      (typeof it.task === "string" && it.task) ||
      (typeof it.text === "string" && it.text) ||
      "Untitled task";
    const id = typeof it.id === "string" ? it.id : `${sessionId}:${i}`;
    const description =
      typeof it.description === "string" ? it.description : undefined;
    return { id, title, status: toTodoStatus(it.status), description };
  });
  useTodosStore.getState().setTodos(sessionId, todos);
}

/**
 * Agent event types emitted by the Rust runtime via `agent://event`.
 * Must match the `Event` enum in `src-tauri/src/altai/agent/runtime.rs`.
 */
export type AgentEvent =
  | { type: "run_started"; run_id: string }
  | { type: "run_warning"; run_id: string; warning: RunBudgetWarning }
  | { type: "run_terminated"; run_id: string; outcome: RunOutcome }
  | { type: "agent_message"; content: string; role: string }
  | { type: "tool_call_start"; id: string; name: string; input: unknown }
  | { type: "tool_call_end"; id: string; name: string; output: unknown; error?: string }
  | { type: "edit_diff"; file: string; before: string; after: string; hunk_id: string }
  | { type: "approval_request"; id: string; action: string; payload: unknown }
  | { type: "thinking"; content: string }
  | {
      type: "clarification";
      content: string;
      choices: string[];
      edit_diff?: {
        file: string;
        diff: string;
        truncated: boolean;
      };
    }
  | {
      type: "usage";
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }
  | {
      type: "execution_run_finished";
      provider_id: string;
      session_id: string;
      exit_code: number | null;
      duration_ms: number;
      stdout_len: number;
      stderr_len: number;
      artifact_count: number;
      git_head: string | null;
      description: string | null;
    }
  | {
      type: "execution_job_finished";
      job_id: string;
      session_id: string;
      provider_id: string;
      status: string;
      exit_code: number | null;
      duration_ms: number;
      stdout_len: number;
      stderr_len: number;
      artifact_count: number;
      description: string | null;
    }
  | {
      type: "background_job_updated";
      job_id: string;
      state: string;
      kind: string;
      detail: string | null;
    }
  | {
      type: "notification_created";
      notification_id: string;
      kind: string;
      title: string;
    }
  | {
      type: "notification_updated";
      notification_id: string;
      state: string;
    }
  | { type: "done"; reason: string }
  | { type: "error"; message: string }
  | {
      type: "subagent_spawned";
      task_id: string;
      child_chat_id: string;
      display_name: string | null;
      agent_name: string | null;
      background_job_id: string | null;
    }
  | {
      type: "subagent_finished";
      task_id: string;
      child_chat_id: string;
      status: string;
      agent_name: string | null;
    }
  | { type: "notebook_output"; notebook_id: string; cell_index: number; output: unknown }
  | { type: "experiment_result"; experiment_id: string; metrics: unknown; artifacts: string[] };

export type RunBudgetSnapshot = {
  iterations_used: number;
  iterations_limit: number;
  elapsed_ms?: number;
  elapsed_limit_ms?: number;
  tokens_used?: number;
  tokens_limit?: number;
  provider_retries_used?: number;
  provider_retries_limit?: number;
  context_recoveries_used?: number;
  context_recoveries_limit?: number;
  no_progress_turns?: number;
  repeated_root_cause_failures?: number;
  exhausted_limit?: string;
};

export type RunBudgetWarning = {
  reason:
    | { kind: "approaching_limit"; limit: string }
    | { kind: "repeated_root_cause"; failures: number }
    | { kind: "no_progress"; turns: number };
  budget: RunBudgetSnapshot;
};

export type RunOutcome =
  | { kind: "completed" }
  | { kind: "cancelled" }
  | { kind: "failed"; failure: string; retryable: boolean }
  | { kind: "stuck"; reason: string }
  | {
      kind: "budget_exhausted";
      budget: RunBudgetSnapshot;
    };

export function isRetryableRunOutcome(
  outcome: RunOutcome | null | undefined,
): boolean {
  return outcome?.kind === "failed" && outcome.retryable;
}

export function describeRunWarning(warning: RunBudgetWarning): string {
  switch (warning.reason.kind) {
    case "approaching_limit":
      return `Run is approaching its ${warning.reason.limit.replace(/_/g, " ")} limit`;
    case "repeated_root_cause":
      return `The same typed failure repeated ${warning.reason.failures} times`;
    case "no_progress":
      return `No measurable progress for ${warning.reason.turns} turns`;
  }
}

export type VersionedAgentEventEnvelope = {
  version: 1;
  scope: "run" | "system";
  runId?: string;
  seq?: number;
  timestampMs?: number;
  chatId: string;
  event: AgentEvent;
  replay?: boolean;
};

export type ParsedAgentEvent = AgentEvent & {
  chat_id?: string;
  run_id?: string;
  seq?: number;
  timestamp_ms?: number;
  version?: 1;
  scope?: "run" | "system";
  legacy?: boolean;
  replay?: boolean;
};

const AGENT_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "run_started",
  "run_warning",
  "run_terminated",
  "agent_message",
  "tool_call_start",
  "tool_call_end",
  "edit_diff",
  "approval_request",
  "thinking",
  "clarification",
  "usage",
  "execution_run_finished",
  "execution_job_finished",
  "background_job_updated",
  "notification_created",
  "notification_updated",
  "done",
  "error",
  "subagent_spawned",
  "subagent_finished",
  "notebook_output",
  "experiment_result",
]);

const nonBlankString = z.string().trim().min(1);
const nullableString = z.string().nullable();
const nonnegativeInteger = z.number().int().nonnegative();
const budgetSnapshotSchema = z.object({
  iterations_used: nonnegativeInteger,
  iterations_limit: z.number().int().positive(),
  elapsed_ms: nonnegativeInteger.optional(),
  elapsed_limit_ms: nonnegativeInteger.optional(),
  tokens_used: nonnegativeInteger.optional(),
  tokens_limit: nonnegativeInteger.optional(),
  provider_retries_used: nonnegativeInteger.optional(),
  provider_retries_limit: nonnegativeInteger.optional(),
  context_recoveries_used: nonnegativeInteger.optional(),
  context_recoveries_limit: nonnegativeInteger.optional(),
  no_progress_turns: nonnegativeInteger.optional(),
  repeated_root_cause_failures: nonnegativeInteger.optional(),
  exhausted_limit: nonBlankString.optional(),
});
const runBudgetWarningSchema = z.object({
  reason: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("approaching_limit"), limit: nonBlankString }),
    z.object({
      kind: z.literal("repeated_root_cause"),
      failures: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal("no_progress"),
      turns: z.number().int().positive(),
    }),
  ]),
  budget: budgetSnapshotSchema,
});
const runOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed") }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({
    kind: z.literal("failed"),
    failure: nonBlankString,
    retryable: z.boolean(),
  }),
  z.object({ kind: z.literal("stuck"), reason: nonBlankString }),
  z.object({
    kind: z.literal("budget_exhausted"),
    budget: budgetSnapshotSchema,
  }),
]);
const lifecycleEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_started"), run_id: nonBlankString }),
  z.object({
    type: z.literal("run_warning"),
    run_id: nonBlankString,
    warning: runBudgetWarningSchema,
  }),
  z.object({
    type: z.literal("run_terminated"),
    run_id: nonBlankString,
    outcome: runOutcomeSchema,
  }),
]);
const runEventSchemas: Partial<Record<AgentEvent["type"], z.ZodType>> = {
  agent_message: z.object({
    type: z.literal("agent_message"),
    content: z.string(),
    role: nonBlankString,
  }),
  thinking: z.object({ type: z.literal("thinking"), content: z.string() }),
  error: z.object({ type: z.literal("error"), message: nonBlankString }),
  done: z.object({ type: z.literal("done"), reason: z.string() }),
  tool_call_start: z.object({
    type: z.literal("tool_call_start"),
    id: nonBlankString,
    name: nonBlankString,
    input: z.unknown(),
  }),
  tool_call_end: z.object({
    type: z.literal("tool_call_end"),
    id: nonBlankString,
    name: nonBlankString,
    output: z.unknown(),
    error: z.string().optional(),
  }),
  clarification: z.object({
    type: z.literal("clarification"),
    content: nonBlankString,
    choices: z.array(z.string()),
    edit_diff: z
      .object({
        file: nonBlankString,
        diff: z.string(),
        truncated: z.boolean(),
      })
      .optional(),
  }),
  usage: z.object({
    type: z.literal("usage"),
    prompt_tokens: nonnegativeInteger,
    completion_tokens: nonnegativeInteger,
    total_tokens: nonnegativeInteger,
    cache_read_tokens: nonnegativeInteger,
    cache_creation_tokens: nonnegativeInteger,
  }),
  edit_diff: z.object({
    type: z.literal("edit_diff"),
    file: nonBlankString,
    before: z.string(),
    after: z.string(),
    hunk_id: nonBlankString,
  }),
  approval_request: z.object({
    type: z.literal("approval_request"),
    id: nonBlankString,
    action: nonBlankString,
    payload: z.unknown(),
  }),
  execution_run_finished: z.object({
    type: z.literal("execution_run_finished"),
    provider_id: nonBlankString,
    session_id: nonBlankString,
    exit_code: z.number().int().nullable(),
    duration_ms: nonnegativeInteger,
    stdout_len: nonnegativeInteger,
    stderr_len: nonnegativeInteger,
    artifact_count: nonnegativeInteger,
    git_head: nullableString,
    description: nullableString,
  }),
  execution_job_finished: z.object({
    type: z.literal("execution_job_finished"),
    job_id: nonBlankString,
    session_id: nonBlankString,
    provider_id: nonBlankString,
    status: nonBlankString,
    exit_code: z.number().int().nullable(),
    duration_ms: nonnegativeInteger,
    stdout_len: nonnegativeInteger,
    stderr_len: nonnegativeInteger,
    artifact_count: nonnegativeInteger,
    description: nullableString,
  }),
  subagent_spawned: z.object({
    type: z.literal("subagent_spawned"),
    task_id: nonBlankString,
    child_chat_id: nonBlankString,
    display_name: nullableString,
    agent_name: nullableString,
    background_job_id: nullableString,
  }),
  subagent_finished: z.object({
    type: z.literal("subagent_finished"),
    task_id: nonBlankString,
    child_chat_id: nonBlankString,
    status: nonBlankString,
    agent_name: nullableString,
  }),
  notebook_output: z.object({
    type: z.literal("notebook_output"),
    notebook_id: nonBlankString,
    cell_index: nonnegativeInteger,
    output: z.unknown(),
  }),
  experiment_result: z.object({
    type: z.literal("experiment_result"),
    experiment_id: nonBlankString,
    metrics: z.unknown(),
    artifacts: z.array(z.string()),
  }),
};
const systemEventSchemas: Partial<Record<AgentEvent["type"], z.ZodType>> = {
  background_job_updated: z.object({
    type: z.literal("background_job_updated"),
    job_id: nonBlankString,
    state: nonBlankString,
    kind: nonBlankString,
    detail: nullableString,
  }),
  notification_created: z.object({
    type: z.literal("notification_created"),
    notification_id: nonBlankString,
    kind: nonBlankString,
    title: nonBlankString,
  }),
  notification_updated: z.object({
    type: z.literal("notification_updated"),
    notification_id: nonBlankString,
    state: nonBlankString,
  }),
};

/**
 * Validate the lifecycle envelope at the desktop IPC trust boundary.
 * Legacy events are deliberately limited to assistant text: they can keep old
 * transports readable but can never advance or complete a lifecycle run.
 */
export function parseAgentEventPayload(payload: unknown): ParsedAgentEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if ("version" in value && value.version !== 1) return null;

  if (value.version === 1) {
    const { scope, runId, seq, timestampMs, chatId, event, replay } = value;
    if (
      (scope !== "run" && scope !== "system") ||
      typeof chatId !== "string" ||
      !chatId.trim() ||
      !event ||
      typeof event !== "object"
    ) {
      return null;
    }
    if (
      (timestampMs !== undefined &&
        (typeof timestampMs !== "number" ||
          !Number.isSafeInteger(timestampMs) ||
          timestampMs < 0)) ||
      (replay !== undefined && replay !== true)
    ) {
      return null;
    }
    const typedEvent = event as { type?: unknown };
    if (
      typeof typedEvent.type !== "string" ||
      !AGENT_EVENT_TYPES.has(typedEvent.type as AgentEvent["type"])
    ) {
      return null;
    }
    const eventType = typedEvent.type as AgentEvent["type"];
    if (scope === "system") {
      if (runId !== undefined || seq !== undefined) return null;
      const schema = systemEventSchemas[eventType];
      if (!schema?.safeParse(event).success) return null;
    } else {
      if (
        typeof runId !== "string" ||
        !runId.trim() ||
        typeof seq !== "number" ||
        !Number.isSafeInteger(seq) ||
        seq < 1
      ) {
        return null;
      }
      const lifecycle = lifecycleEventSchema.safeParse(event);
      if (
        eventType === "run_started" ||
        eventType === "run_warning" ||
        eventType === "run_terminated"
      ) {
        if (!lifecycle.success || lifecycle.data.run_id !== runId) return null;
      } else {
        const schema = runEventSchemas[eventType];
        if (!schema?.safeParse(event).success) return null;
      }
    }
    return {
      ...(event as AgentEvent),
      chat_id: chatId,
      run_id: runId,
      seq,
      timestamp_ms: timestampMs,
      version: 1,
      scope,
      replay: replay === true,
    } as ParsedAgentEvent;
  }

  if (
    value.type === "agent_message" &&
    typeof value.content === "string" &&
    typeof value.role === "string"
  ) {
    return {
      ...(value as Extract<AgentEvent, { type: "agent_message" }>),
      legacy: true,
    };
  }
  return null;
}

/**
 * Apply the TS-side prune pass to the focused chat's transcript if the user
 * has it enabled. Pulled out of the `done` handler so the side effect is
 * obvious and easy to skip during tests. Reads prefs + store live so a
 * Settings change takes effect on the next turn boundary.
 */
function maybePruneOldToolOutputs(): void {
  const prefs = usePreferencesStore.getState();
  if (!prefs.compactionPrune) return;
  const store = useChatStore.getState();
  if (!store.activeSessionId) return;
  const next = pruneOldToolOutputs(
    store.nativeMessages,
    prefs.compactionPruneRecencyTokens,
  );
  if (next !== store.nativeMessages) {
    // Direct setState so the persistence subscription (chatStore.ts) picks
    // up the new array reference and writes the pruned thread to disk. The
    // `loadedMessagesRefs` guard there won't trip because this is a freshly
    // mapped array, not a hydrated one.
    useChatStore.setState({ nativeMessages: next });
  }
}

async function waitForSessionHydration(): Promise<void> {
  if (useChatStore.getState().sessionsHydrated) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = useChatStore.subscribe((state) => {
      if (!state.sessionsHydrated) return;
      unsubscribe();
      resolve();
    });
  });
}

async function replayPersistedAgentEvents(): Promise<void> {
  const workspacePath = currentWorkspaceFolder();
  if (!workspacePath) return;
  const chat = useChatStore.getState();
  const chatIds = chat.sessions.map((session) => session.id);
  if (chatIds.length === 0) return;
  // This CAS only classifies runs abandoned by process death. The backend
  // skips every chat that still has a live coordinator lease and never resumes
  // work; execution requires a later, explicit user send.
  await invoke("agent_recover_interrupted_runs", { workspacePath, chatIds });
  const runs = useAgentRunsStore.getState().runs;
  const cursors = chat.sessions.map((session) => {
    const run = runs[session.id];
    return {
      chatId: session.id,
      runId: run?.runId ?? null,
      afterSeq: run?.lastSeq ?? 0,
    };
  });
  if (cursors.length === 0) return;
  const events = await invoke<unknown[]>("agent_replay_events", {
    workspacePath,
    cursors,
  });
  for (const event of events) {
    applyAgentEventPayload(event, true);
  }
}

/**
 * Initialize the agent event bridge.
 *
 * Listens to `agent://event` from the Tauri backend and dispatches
 * events to the appropriate Zustand stores. Call once during app setup.
 */
export async function initAgentEventBridge(): Promise<UnlistenFn> {
  const unlisten = await listen<unknown>("agent://event", (event) => {
    applyAgentEventPayload(event.payload, false);
  });
  await waitForSessionHydration();
  try {
    await replayPersistedAgentEvents();
  } catch (error) {
    useChatStore.getState().addActivity({
      label: "Run recovery unavailable",
      detail: error instanceof Error ? error.message : String(error),
      kind: "agent",
      tone: "warning",
    });
  }
  return unlisten;
}

export function applyAgentEventPayload(raw: unknown, replay: boolean): void {
  const payload = parseAgentEventPayload(raw);
  if (!payload) return;
  const store = useChatStore.getState();
    // Feed the per-chat_id run registry FIRST, before the active-session drop
    // below — this is the only sink that sees background (non-focused) runs, so
    // a project board can track every dispatched agent. Must stay above the
    // filter; the filter itself must remain so background content never leaks
    // into the focused chat's transcript/meter.
    if (payload.scope === "run" && payload.chat_id) {
      const accepted = useAgentRunsStore.getState().ingest(payload.chat_id, payload);
      if (!accepted) return;
    }
    // Persist a BACKGROUND run's assistant messages to its own thread so "Open
    // transcript" replays the result, not just the seed. The focused chat
    // persists itself via nativeMessages, so skip it here.
    if (
      !replay &&
      payload.type === "agent_message" &&
      payload.role === "assistant" &&
      payload.chat_id &&
      payload.chat_id !== store.activeSessionId
    ) {
      appendBackgroundMessage(payload.chat_id, "assistant", payload.content);
    }
  if (payload.type === "clarification" && payload.chat_id) {
      store.setPendingClarificationForSession(payload.chat_id, {
        choices: payload.choices,
        editDiff: payload.edit_diff ?? null,
      });
      if (!replay && payload.chat_id !== store.activeSessionId) {
      appendBackgroundMessage(payload.chat_id, "assistant", payload.content);
    }
  }
  // A terminal run cannot still be waiting for an answer. This also prevents
  // a full restart replay from resurrecting a clarification that was resolved
  // earlier in the same run.
  if (payload.type === "run_terminated" && payload.chat_id) {
    store.setPendingClarificationForSession(payload.chat_id, null);
  }
    if (
      payload.type === "notification_created" ||
      payload.type === "notification_updated" ||
      payload.type === "background_job_updated"
    ) {
      window.dispatchEvent(
        new CustomEvent("altai:agent-inbox-changed", {
          detail: { ...payload },
        }),
      );
    }
    // Per-session isolation: every event is tagged with the chat_id (= ALTAI
    // session id) it belongs to. Drop anything that isn't for the chat tab on
    // screen, so a still-streaming or autonomous turn from another chat (and
    // the runtime's bootstrap "initialized" message) never leaks into it.
    if (payload.chat_id && payload.chat_id !== store.activeSessionId) return;
  switch (payload.type) {
      case "run_started":
        if (store.agentMeta.status !== "cancelling") {
          store.patchAgentMeta({ status: "thinking", step: null, error: null });
        }
        break;

      case "run_warning": {
        const warning = describeRunWarning(payload.warning);
        store.addActivity({
          label: "Run needs attention",
          detail: warning,
          kind: "agent",
          tone: "warning",
        });
        if (store.agentMeta.status !== "cancelling") {
          store.patchAgentMeta({ status: "thinking", step: warning });
        }
        break;
      }

      case "run_terminated": {
        const error =
          payload.outcome.kind === "failed"
            ? payload.outcome.failure === "runtime_restarted"
              ? "The previous run stopped when the app restarted. Review its last completed step before starting a new run."
              : payload.outcome.failure
            : payload.outcome.kind === "stuck"
              ? `Agent got stuck: ${payload.outcome.reason}`
              : payload.outcome.kind === "budget_exhausted"
                ? `Run budget exhausted after ${payload.outcome.budget.iterations_used} iterations`
                : null;
        store.patchAgentMeta({
          status: error ? "error" : "idle",
          step: null,
          error,
          pendingApprovals: [],
          approvalsPending: 0,
        });
        store.closeAssistantTurn();
        if (!replay) maybePruneOldToolOutputs();
        break;
      }

      case "agent_message":
        if (!replay) store.appendNativeMessage(payload.content, payload.role);
        // Assistant prose is content, not a lifecycle signal. Only the
        // matching run_terminated event may transition a run to terminal.
        break;

      case "tool_call_start":
        // The status pill stays for at-a-glance "what's running now" —
        // but we also push the tool into the message thread so the
        // history shows every call inline with input/output instead of
        // each new tool overwriting the last one on a single status line.
        if (store.agentMeta.status !== "cancelling") {
          store.patchAgentMeta({ status: "streaming", step: payload.name });
        }
        {
          const mcp = parseMcpToolName(payload.name);
          if (mcp) activeMcpCalls.set(payload.id, mcp);
          store.addActivity({
            label: mcp
              ? `MCP · ${mcp.server} → ${mcp.tool}`
              : `Started ${payload.name}`,
            detail: mcp ? "Calling connected MCP server" : "Tool call in progress",
            kind: activityKindForTool(payload.name),
          });
        }
        if (!replay) {
          store.startNativeToolCall(payload.id, payload.name, payload.input);
        }
        if (payload.name === "todo_write") {
          ingestTodoWrite(payload.input, store.activeSessionId);
        }
        break;

      case "tool_call_end":
        {
        const mcp = activeMcpCalls.get(payload.id);
        activeMcpCalls.delete(payload.id);
        if (payload.error) {
          store.patchAgentMeta({ step: `${payload.name} (error)` });
        }
        store.addActivity({
          label: mcp
            ? `MCP ${payload.error ? "failed" : "finished"} · ${mcp.server} → ${mcp.tool}`
            : payload.error ? `${payload.name} failed` : `Finished ${payload.name}`,
          detail: payload.error ?? (mcp ? "MCP result received" : payload.id),
          kind: mcp ? "mcp" : activityKindForTool(payload.name),
          tone: payload.error ? "error" : "success",
        });
        if (!replay) {
          store.endNativeToolCall(payload.id, payload.output, payload.error);
        }
        }
        break;

      case "thinking":
        if (store.agentMeta.status !== "cancelling") {
          store.patchAgentMeta({ status: "thinking", step: payload.content });
        }
        break;

      case "clarification":
        // The agent is asking the user something. Render the question as an
        // assistant message and expose any preset choices as clickable chips;
        // the turn yields back to the user (idle) until they reply.
        if (!replay) store.appendNativeMessage(payload.content, "assistant");
        if (!payload.chat_id) {
          store.setPendingChoices(payload.choices);
          store.setPendingEditDiff(payload.edit_diff ?? null);
        }
        store.addActivity({
          label: payload.edit_diff
            ? `Edit approval: ${payload.edit_diff.file}`
            : "Agent requested clarification",
          detail: payload.edit_diff
            ? "Review the diff, then approve or deny"
            : payload.choices.length
              ? `${payload.choices.length} suggested answer${payload.choices.length === 1 ? "" : "s"}`
              : undefined,
          kind: "agent",
          tone: "warning",
        });
        if (store.agentMeta.status !== "cancelling") {
          store.patchAgentMeta({ status: "awaiting-approval", step: null });
        }
        break;

      case "usage": {
        // Accumulate per-call token usage into the run meter, mirroring the
        // old Vercel `onUsage` semantics (prompt → input, completion →
        // output, cache_read → cached). Reset happens on session change via
        // IDLE_META.
        const cur = store.agentMeta.tokens;
        store.patchAgentMeta({
          tokens: {
            inputTokens: cur.inputTokens + payload.prompt_tokens,
            outputTokens: cur.outputTokens + payload.completion_tokens,
            cachedInputTokens: cur.cachedInputTokens + payload.cache_read_tokens,
          },
          lastInputTokens: payload.prompt_tokens,
          lastCachedTokens: payload.cache_read_tokens,
        });
        break;
      }

      case "approval_request":
        store.addApproval({
          id: payload.id,
          action: payload.action,
          payload: payload.payload,
        });
        store.addActivity({
          label: `Approval needed: ${payload.action}`,
          detail: "Waiting for your decision",
          kind: "approval",
          tone: "warning",
        });
        break;

      // Execution-harness lifecycle. The agent typically also gets woken to
      // summarize a finished job, so these surface as a lightweight transient
      // status line rather than persisted messages.
      case "execution_run_finished": {
        const secs = (payload.duration_ms / 1000).toFixed(1);
        store.addActivity({
          label: `Run finished with exit ${payload.exit_code ?? "?"}`,
          detail: `${secs}s · ${plural(payload.artifact_count, "artifact")}`,
          kind: "execution",
          tone: payload.exit_code === 0 ? "success" : "warning",
        });
        store.patchAgentMeta({
          step: `Run finished — exit ${payload.exit_code ?? "?"}, ${secs}s, ${plural(payload.artifact_count, "artifact")}`,
        });
        break;
      }

      case "execution_job_finished": {
        const secs = (payload.duration_ms / 1000).toFixed(1);
        store.addActivity({
          label: `Background job ${payload.status}`,
          detail: `${payload.job_id} · ${secs}s`,
          kind: "execution",
          tone: payload.status === "success" ? "success" : "default",
        });
        store.patchAgentMeta({
          step: `Background job ${payload.job_id} ${payload.status} — ${secs}s, ${plural(payload.artifact_count, "artifact")}`,
        });
        break;
      }

      case "background_job_updated":
        store.addActivity({
          label: `Background job ${payload.state}`,
          detail: payload.detail ?? payload.job_id,
          kind: "execution",
        });
        store.patchAgentMeta({
          step: `Background job ${payload.job_id}: ${payload.state}`,
        });
        break;

      case "notification_created":
        store.addActivity({
          label: payload.title,
          detail: payload.kind,
          kind: "agent",
          tone: "warning",
        });
        break;

      case "notification_updated":
        store.addActivity({
          label: `Notification ${payload.state}`,
          detail: payload.notification_id,
          kind: "agent",
        });
        break;

      // Subagent lifecycle: the main agent dispatched (or finished) a task on
      // a named/anonymous subagent via `subagent_spawn`. Track active tasks so
      // the UI can show a live "N subagents running" indicator, and surface a
      // transient status line for each transition.
      case "subagent_spawned": {
        const label =
          payload.display_name || payload.agent_name || "subagent";
        store.addSubagentTask({
          taskId: payload.task_id,
          childChatId: payload.child_chat_id,
          displayName: payload.display_name,
          agentName: payload.agent_name,
        });
        store.addActivity({
          label: `Dispatched ${label}`,
          detail: "Subagent running",
          kind: "agent",
        });
        store.patchAgentMeta({ step: `Dispatched ${label}…` });
        break;
      }

      case "subagent_finished": {
        // SubagentFinished carries no `display_name`, so recover the friendly
        // label from the task we tracked at spawn time — keeping the finished
        // line symmetric with "Dispatched <label>…" instead of falling back to
        // the bare agent type.
        const tracked = store.agentMeta.activeSubagents.find(
          (t) => t.taskId === payload.task_id,
        );
        const label =
          tracked?.displayName ||
          payload.agent_name ||
          tracked?.agentName ||
          "subagent";
        store.removeSubagentTask(payload.task_id);
        store.addActivity({
          label: `${label} ${payload.status}`,
          detail: "Subagent finished",
          kind: "agent",
          tone: payload.status === "completed" ? "success" : "default",
        });
        store.patchAgentMeta({ step: `${label} ${payload.status}` });
        break;
      }

      case "done":
        store.addActivity({ label: "Agent finished", kind: "agent", tone: "success" });
        break;

      case "error":
        store.addActivity({
          label: "Agent run failed",
          detail: payload.message,
          kind: "agent",
          tone: "error",
        });
        break;

      case "notebook_output":
        // Dispatched to the notebook store when it exists.
        window.dispatchEvent(
          new CustomEvent("altai:notebook-output", { detail: payload }),
        );
        break;

      case "experiment_result":
        store.addArtifacts({
          experimentId: payload.experiment_id,
          paths: payload.artifacts,
        });
        store.addActivity({
          label: "Experiment result received",
          detail: `${plural(payload.artifacts.length, "artifact")} available`,
          kind: "execution",
          tone: "success",
        });
        window.dispatchEvent(
          new CustomEvent("altai:experiment-result", { detail: payload }),
        );
        break;
  }
}
