import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { plural } from "@/lib/utils";
import { useChatStore } from "../store/chatStore";
import { useAgentRunsStore } from "../store/agentRunsStore";
import { useTodosStore } from "../store/todoStore";
import { appendBackgroundMessage } from "./backgroundTranscript";
import type { Todo, TodoStatus } from "./todos";
import { z } from "zod";

/**
 * Trust-boundary schema for the `todo_write` tool input (model-produced, so
 * untrusted). We validate the *structure* — an `items` array of objects — then
 * read each item's fields defensively below, since their names vary by model.
 */
const todoWriteSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
});

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
  | { type: "agent_message"; content: string; role: string }
  | { type: "tool_call_start"; id: string; name: string; input: unknown }
  | { type: "tool_call_end"; id: string; output: unknown; error?: string }
  | { type: "edit_diff"; file: string; before: string; after: string; hunk_id: string }
  | { type: "approval_request"; id: string; action: string; payload: unknown }
  | { type: "thinking"; content: string }
  | { type: "clarification"; content: string; choices: string[] }
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

/**
 * Initialize the agent event bridge.
 *
 * Listens to `agent://event` from the Tauri backend and dispatches
 * events to the appropriate Zustand stores. Call once during app setup.
 */
export async function initAgentEventBridge(): Promise<UnlistenFn> {
  return listen<AgentEvent & { chat_id?: string }>("agent://event", (event) => {
    const payload = event.payload;
    const store = useChatStore.getState();
    // Feed the per-chat_id run registry FIRST, before the active-session drop
    // below — this is the only sink that sees background (non-focused) runs, so
    // a project board can track every dispatched agent. Must stay above the
    // filter; the filter itself must remain so background content never leaks
    // into the focused chat's transcript/meter.
    if (payload.chat_id) {
      useAgentRunsStore.getState().ingest(payload.chat_id, payload);
    }
    // Persist a BACKGROUND run's assistant messages to its own thread so "Open
    // transcript" replays the result, not just the seed. The focused chat
    // persists itself via nativeMessages, so skip it here.
    if (
      payload.type === "agent_message" &&
      payload.role === "assistant" &&
      payload.chat_id &&
      payload.chat_id !== store.activeSessionId
    ) {
      appendBackgroundMessage(payload.chat_id, "assistant", payload.content);
    }
    // Per-session isolation: every event is tagged with the chat_id (= ALTAI
    // session id) it belongs to. Drop anything that isn't for the chat tab on
    // screen, so a still-streaming or autonomous turn from another chat (and
    // the runtime's bootstrap "initialized" message) never leaks into it.
    if (payload.chat_id && payload.chat_id !== store.activeSessionId) return;
    switch (payload.type) {
      case "agent_message":
        store.appendNativeMessage(payload.content, payload.role);
        // A final assistant turn arrived → drop the stale "Sending to ALTAI…"
        // (or whatever the last tool step was) so the status pill doesn't
        // sit on stale text. System bootstrap messages ("IsanAgent runtime
        // initialized.") keep the existing status. The Rust runtime doesn't
        // emit a separate `done` event yet — relying on the final assistant
        // message is the closest signal we have until that lands.
        if (payload.role === "assistant") {
          store.patchAgentMeta({ status: "idle", step: null });
        }
        break;

      case "tool_call_start":
        // The status pill stays for at-a-glance "what's running now" —
        // but we also push the tool into the message thread so the
        // history shows every call inline with input/output instead of
        // each new tool overwriting the last one on a single status line.
        store.patchAgentMeta({ status: "streaming", step: payload.name });
        store.startNativeToolCall(payload.id, payload.name, payload.input);
        if (payload.name === "todo_write") {
          ingestTodoWrite(payload.input, store.activeSessionId);
        }
        break;

      case "tool_call_end":
        if (payload.error) {
          store.patchAgentMeta({ step: `${payload.id} (error)` });
        }
        store.endNativeToolCall(payload.id, payload.output, payload.error);
        break;

      case "thinking":
        store.patchAgentMeta({ status: "thinking", step: payload.content });
        break;

      case "clarification":
        // The agent is asking the user something. Render the question as an
        // assistant message and expose any preset choices as clickable chips;
        // the turn yields back to the user (idle) until they reply.
        store.appendNativeMessage(payload.content, "assistant");
        store.setPendingChoices(payload.choices);
        store.patchAgentMeta({ status: "idle", step: null });
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
        store.patchAgentMeta({
          status: "awaiting-approval",
          approvalsPending: store.agentMeta.approvalsPending + 1,
        });
        break;

      // Execution-harness lifecycle. The agent typically also gets woken to
      // summarize a finished job, so these surface as a lightweight transient
      // status line rather than persisted messages.
      case "execution_run_finished": {
        const secs = (payload.duration_ms / 1000).toFixed(1);
        store.patchAgentMeta({
          step: `Run finished — exit ${payload.exit_code ?? "?"}, ${secs}s, ${plural(payload.artifact_count, "artifact")}`,
        });
        break;
      }

      case "execution_job_finished": {
        const secs = (payload.duration_ms / 1000).toFixed(1);
        store.patchAgentMeta({
          step: `Background job ${payload.job_id} ${payload.status} — ${secs}s, ${plural(payload.artifact_count, "artifact")}`,
        });
        break;
      }

      case "background_job_updated":
        store.patchAgentMeta({
          step: `Background job ${payload.job_id}: ${payload.state}`,
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
        store.patchAgentMeta({ step: `${label} ${payload.status}` });
        break;
      }

      case "done":
        store.patchAgentMeta({ status: "idle", step: null });
        store.closeAssistantTurn();
        break;

      case "error":
        store.patchAgentMeta({ status: "error", error: payload.message });
        store.closeAssistantTurn();
        break;

      case "notebook_output":
        // Dispatched to the notebook store when it exists.
        window.dispatchEvent(
          new CustomEvent("altai:notebook-output", { detail: payload }),
        );
        break;

      case "experiment_result":
        window.dispatchEvent(
          new CustomEvent("altai:experiment-result", { detail: payload }),
        );
        break;
    }
  });
}
