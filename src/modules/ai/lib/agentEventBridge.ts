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
  | { type: "done"; reason: string }
  | { type: "error"; message: string }
  | { type: "notebook_output"; notebook_id: string; cell_index: number; output: unknown }
  | { type: "experiment_result"; experiment_id: string; metrics: unknown; artifacts: string[] };

/**
 * Initialize the agent event bridge.
 *
 * Listens to `agent://event` from the Tauri backend and dispatches
 * events to the appropriate Zustand stores. Call once during app setup.
 */
export async function initAgentEventBridge(): Promise<UnlistenFn> {
  return listen<AgentEvent>("agent://event", (event) => {
    const payload = event.payload;
    const store = useChatStore.getState();

    // Only process native events when in isanagent backend mode.
    if (store.backendMode !== "isanagent") return;

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

      case "approval_request":
        store.patchAgentMeta({
          status: "awaiting-approval",
          approvalsPending: store.agentMeta.approvalsPending + 1,
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
