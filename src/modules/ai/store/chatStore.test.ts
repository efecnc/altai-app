import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";

// --- Mocks --------------------------------------------------------------
// `sessions` constructs a Tauri LazyStore at module load and owns disk I/O.
// We stub it so tests are pure and `loadMessages` resolution is controllable.
const loadMessagesMock = vi.fn<(id: string) => Promise<UIMessage[] | null>>();

vi.mock("../lib/sessions", () => ({
  loadAll: vi.fn(async () => ({
    sessions: [],
    activeId: null,
    deletedIds: [],
  })),
  loadMessages: (id: string) => loadMessagesMock(id),
  saveMessages: vi.fn(async () => {}),
  saveSessionsList: vi.fn(async () => {}),
  saveActiveId: vi.fn(async () => {}),
  saveDeletedIds: vi.fn(async () => {}),
  deleteSessionData: vi.fn(async () => {}),
  mergeBackendSessions: vi.fn(async () => ({ merged: [], recoveredIds: [] })),
  newSessionId: () => `s-${Math.random().toString(36).slice(2, 8)}`,
  deriveTitle: () => "New chat",
}));

// `native` wraps Tauri IPC — stub everything to no-op resolves.
vi.mock("../lib/native", () => ({
  native: {
    agentStart: vi.fn(async () => {}),
    agentSend: vi.fn(async () => {}),
    agentCancel: vi.fn(async () => {}),
    agentApprove: vi.fn(async () => {}),
  },
}));

// todoStore pulls in another LazyStore at load; only `clearSession` is used here.
vi.mock("./todoStore", () => ({
  useTodosStore: { getState: () => ({ clearSession: vi.fn() }) },
}));

import { useChatStore } from "./chatStore";

function msg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

// A promise whose resolution we control, to force out-of-order loads.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SESSIONS = [
  { id: "A", title: "A", createdAt: 0, updatedAt: 0 },
  { id: "B", title: "B", createdAt: 0, updatedAt: 0 },
  { id: "C", title: "C", createdAt: 0, updatedAt: 0 },
];

beforeEach(() => {
  loadMessagesMock.mockReset();
  useChatStore.setState({
    sessions: SESSIONS.map((s) => ({ ...s })),
    activeSessionId: "A",
    nativeMessages: [],
    pendingChoices: null,
    sessionsHydrated: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("switchSession — race guard", () => {
  it("ignores a stale load that resolves after a newer switch", async () => {
    // B loads slowly, C loads fast. User switches A→B→C.
    const bLoad = deferred<UIMessage[]>();
    const cLoad = deferred<UIMessage[]>();
    loadMessagesMock.mockImplementation((id) =>
      id === "B" ? bLoad.promise : id === "C" ? cLoad.promise : Promise.resolve([]),
    );

    useChatStore.getState().switchSession("B");
    useChatStore.getState().switchSession("C");
    expect(useChatStore.getState().activeSessionId).toBe("C");

    // C resolves first and is applied; the late B resolve must be ignored.
    cLoad.resolve([msg("c1", "C message")]);
    await Promise.resolve();
    bLoad.resolve([msg("b1", "B message")]);
    await Promise.resolve();

    const { activeSessionId, nativeMessages } = useChatStore.getState();
    expect(activeSessionId).toBe("C");
    expect(nativeMessages.map((m) => m.id)).toEqual(["c1"]);
  });

  it("switches activeSessionId synchronously and clears the thread", () => {
    useChatStore.setState({ nativeMessages: [msg("a1", "A")] });
    loadMessagesMock.mockReturnValue(new Promise(() => {})); // never resolves
    useChatStore.getState().switchSession("B");
    // Active id flips immediately; old thread is cleared without waiting.
    expect(useChatStore.getState().activeSessionId).toBe("B");
    expect(useChatStore.getState().nativeMessages).toEqual([]);
  });
});

describe("reorderSessions", () => {
  it("moves a session before or after the drop target", () => {
    const store = useChatStore.getState();
    store.reorderSessions("C", "A", false);
    expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual([
      "C",
      "A",
      "B",
    ]);

    useChatStore.getState().reorderSessions("A", "B", true);
    expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual([
      "C",
      "B",
      "A",
    ]);
  });
});

describe("deleteSession — race guard", () => {
  it("ignores the next-active load if the user switched away meanwhile", async () => {
    const aFollowUp = deferred<UIMessage[]>();
    loadMessagesMock.mockImplementation((id) =>
      id === "B" ? aFollowUp.promise : Promise.resolve([msg("c1", "C")]),
    );

    // Delete active A → next active becomes B (remaining[0]); its load is slow.
    useChatStore.getState().deleteSession("A");
    expect(useChatStore.getState().activeSessionId).toBe("B");

    // User switches to C before B's messages arrive.
    useChatStore.getState().switchSession("C");
    await Promise.resolve();
    expect(useChatStore.getState().activeSessionId).toBe("C");

    // B's stale load resolves — must NOT overwrite C's thread.
    aFollowUp.resolve([msg("b1", "B")]);
    await Promise.resolve();
    expect(useChatStore.getState().nativeMessages.map((m) => m.id)).toEqual([
      "c1",
    ]);
  });
});

describe("pendingChoices", () => {
  it("sets choices and normalizes empty to null", () => {
    useChatStore.getState().setPendingChoices(["yes", "no"]);
    expect(useChatStore.getState().pendingChoices).toEqual(["yes", "no"]);
    useChatStore.getState().setPendingChoices([]);
    expect(useChatStore.getState().pendingChoices).toBeNull();
  });
});
