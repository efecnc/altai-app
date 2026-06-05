import type { UIMessage } from "ai";
import { loadMessages, saveMessages } from "./sessions";

// Per-chat write queue so concurrent appends to the same session serialize.
const queues = new Map<string, Promise<void>>();

/**
 * Append a message to a session's on-disk thread WITHOUT routing it through the
 * focused chat's live store. Used to persist background (assigned) agent runs
 * so their transcript replays beyond the seed — the focused chat already
 * persists itself via `nativeMessages`, so this is only for non-focused runs.
 */
export function appendBackgroundMessage(
  chatId: string,
  role: "user" | "assistant",
  text: string,
): void {
  const msg: UIMessage = {
    id: `native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts: [{ type: "text", text }],
  };
  const prev = queues.get(chatId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const current = (await loadMessages(chatId)) ?? [];
      await saveMessages(chatId, [...current, msg]);
    })
    .catch(() => {
      // Best-effort persistence — a failed write must not break the queue.
    });
  queues.set(chatId, next);
}
