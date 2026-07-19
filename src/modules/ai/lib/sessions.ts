import type { UIMessage } from "ai";
import { LazyStore } from "@tauri-apps/plugin-store";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

const STORE_PATH = "altai-ai-sessions.json";
const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeId";
const KEY_DELETED = "deletedSessionIds";
const messagesKey = (id: string) => `messages:${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedSessions = {
  sessions: SessionMeta[];
  activeId: string | null;
  deletedIds: string[];
};

export async function loadAll(): Promise<LoadedSessions> {
  // One IPC roundtrip via entries() rather than two parallel get()s. Per-
  // session messages are loaded lazily via `loadMessages` only when a
  // session is opened, so cold boot stays at a single store call.
  const entries = await store.entries();
  let sessions: SessionMeta[] | undefined;
  let activeId: string | null | undefined;
  let deletedIds: string[] | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_SESSIONS) sessions = v as SessionMeta[];
    else if (k === KEY_ACTIVE) activeId = v as string | null;
    else if (k === KEY_DELETED) deletedIds = v as string[];
  }
  return {
    sessions: sessions ?? [],
    activeId: activeId ?? null,
    deletedIds: Array.isArray(deletedIds) ? deletedIds : [],
  };
}

export async function loadMessages(id: string): Promise<UIMessage[] | null> {
  const cached = (await store.get<UIMessage[]>(messagesKey(id))) ?? null;
  if (cached && cached.length > 0) return cached;

  // Frontend store has no thread for this id (e.g. a chat recovered from the
  // backend memory DB on hydration). Fetch the durable history from the backend
  // and map OpenAI-style messages → UIMessage so a reopened chat renders its
  // real conversation instead of an empty thread.
  return loadMessagesFromBackend(id);
}

/**
 * Map a backend OpenAI-style chat message to the frontend UIMessage shape.
 *
 * Backend stores plain `{role, content, tool_calls, ...}` rows; the UI renders
 * `{id, role, parts[]}`. We synthesize a stable-ish id and fold the text content
 * and tool calls into parts. This is a best-effort read-only view — rich tool
 * rendering relies on fields the backend doesn't persist verbatim, but the text
 * + tool-call + tool-result sequence is preserved so the conversation is readable.
 */
function backendMessageToUi(
  msg: {
    role: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }> | null;
    tool_call_id?: string | null;
    reasoning_content?: string | null;
  },
  index: number,
): UIMessage {
  const parts: UIMessage["parts"] = [];
  // Reasoning (chain-of-thought) — render as a text part if present.
  const reasoning = msg.reasoning_content?.trim();
  if (reasoning) {
    parts.push({ type: "text", text: reasoning });
  }
  // Assistant tool calls → dynamic-tool parts (input state; the matching tool
  // result row is a separate `role: "tool"` message carrying tool_call_id).
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = { raw: tc.function.arguments };
      }
      parts.push({
        type: "dynamic-tool",
        toolName: tc.function.name,
        toolCallId: tc.id,
        input,
        state: "input-available",
      });
    }
  }
  // Plain text content (user / assistant / tool result text).
  const text = typeof msg.content === "string" ? msg.content.trim() : "";
  if (text) {
    parts.push({ type: "text", text });
  }
  return {
    id: `backend-${index}`,
    role: (msg.role === "tool" ? "assistant" : msg.role) as UIMessage["role"],
    parts,
  };
}

/**
 * Best-effort recovery of a chat's message history from the backend memory DB.
 * Returns `null` on any failure so the caller renders an empty thread (no worse
 * than before) instead of erroring. The workspace path is resolved from the
 * persisted workspace store to scope the query to the active project.
 */
async function loadMessagesFromBackend(id: string): Promise<UIMessage[] | null> {
  try {
    const { native } = await import("./native");
    const { currentWorkspaceFolder } = await import("@/modules/workspace/folder");
    const workspacePath = currentWorkspaceFolder() ?? undefined;
    const backend = await native.agentGetSessionMessages(id, workspacePath);
    if (!backend || backend.length === 0) return null;
    const ui = backend.map((m, i) => backendMessageToUi(m, i));
    // Persist the recovered thread so subsequent opens hit the fast path.
    if (ui.length > 0) {
      await store.set(messagesKey(id), ui);
    }
    return ui;
  } catch {
    return null;
  }
}

export async function saveSessionsList(sessions: SessionMeta[]): Promise<void> {
  await store.set(KEY_SESSIONS, sessions);
}

export async function saveActiveId(id: string | null): Promise<void> {
  await store.set(KEY_ACTIVE, id);
}

export async function saveDeletedIds(ids: string[]): Promise<void> {
  await store.set(KEY_DELETED, ids);
}

export async function saveMessages(
  id: string,
  messages: UIMessage[],
): Promise<void> {
  await store.set(messagesKey(id), messages);
}

export async function deleteSessionData(id: string): Promise<void> {
  await store.delete(messagesKey(id));
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function deriveTitle(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text
        .replace(
          /<(env|system-reminder|environment_details|terminal-context|git-diff|folder|selection|file|tool_call|task|instructions|context)[\s\S]*?<\/\1>\s*/gi,
          "",
        )
        .replace(
          /<\/?(env|system-reminder|environment_details|terminal-context|git-diff|folder|selection|file)[^>]*>\s*/gi,
          "",
        )
        .trim();
      if (!text) continue;
      const first = text
        .split("\n")
        .map((line) =>
          line
            .replace(/^```[^\n]*/g, "")
            .replace(/^\s{0,3}#+\s*/, "")
            .replace(/^\s{0,3}>\s*/, "")
            .replace(/^\s{0,3}[-*]\s*/, "")
            .trim(),
        )
        .find((line) => line.length > 0);
      if (!first) continue;
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return "New chat";
}


/**
 * Merge backend-only sessions into the frontend session list.
 *
 * The backend memory DB (`agent_memory.db`) is the durable source of truth —
 * every conversation the agent actually ran lives there forever. The frontend
 * `altai-ai-sessions.json` is a best-effort mirror that can drop sessions when
 * a chat tab is closed. This reconciliation (called on hydration) re-surfaces
 * those closed chats so they reappear in history, matching Claude Code / Cursor.
 *
 * Returns the merged list and the list of newly recovered ids (so the caller
 * can persist once). Existing frontend entries are preserved untouched (their
 * titles may be richer than the backend preview).
 */
export async function mergeBackendSessions(
  frontend: SessionMeta[],
  deletedIds: string[] = [],
): Promise<{ merged: SessionMeta[]; recoveredIds: string[] }> {
  let backend: { id: string; updatedAt: number; title: string }[] = [];
  try {
    // Lazy import to avoid a static Tauri dependency in this otherwise
    // pure-storage module — keeps it testable without the IPC bridge.
    const { native } = await import("./native");
    // The backend memory DB is per-workspace (`<folder>/.isanagent/...`).
    // Querying without the workspace path opens the wrong (empty) DB and
    // recovers nothing — which is why closed chats never reappeared in history.
    const { currentWorkspaceFolder } = await import(
      "@/modules/workspace/folder"
    );
    const workspacePath = currentWorkspaceFolder() ?? undefined;
    backend = await native.agentListSessions(workspacePath);
  } catch {
    // Backend unavailable (e.g. non-Tauri test context) — no-op, keep frontend.
    return { merged: frontend, recoveredIds: [] };
  }

  const known = new Set(frontend.map((s) => s.id));
  const deleted = new Set(deletedIds);
  const recoveredIds: string[] = [];
  for (const b of backend) {
    if (known.has(b.id)) continue;
    // Skip sessions the user permanently deleted — the blocklist keeps the
    // backend (source of truth) from resurrecting them on every restart.
    if (deleted.has(b.id)) continue;
    frontend.push({
      id: b.id,
      // Backend preview is a best-effort title; deriveTitle would do the same
      // truncation, so keep the backend value when present, else default.
      title: b.title?.trim() || "New chat",
      createdAt: b.updatedAt,
      updatedAt: b.updatedAt,
    });
    known.add(b.id);
    recoveredIds.push(b.id);
  }
  // Newest-first, consistent with the rest of the store.
  frontend.sort((a, b) => b.updatedAt - a.updatedAt);
  return { merged: frontend, recoveredIds };
}
