import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useChatStore } from "../store/chatStore";

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
  | { type: "notebook_output"; notebook_id: string; cell_index: number; output: unknown }
  | { type: "experiment_result"; experiment_id: string; metrics: unknown; artifacts: string[] };

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

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
