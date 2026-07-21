import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentBackgroundJobInfo,
  AgentClarificationTicketInfo,
  AgentNotificationInfo,
} from "../lib/native";

const nativeMocks = vi.hoisted(() => ({
  agentListNotifications: vi.fn(),
  agentListBackgroundJobs: vi.fn(),
  agentListClarificationTickets: vi.fn(),
  agentNotificationMarkSeen: vi.fn(),
  agentNotificationResolve: vi.fn(),
  agentBackgroundJobDismiss: vi.fn(),
  agentClarificationTicketDismiss: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMocks }));

import {
  buildNotificationInboxView,
  invalidateNotificationInbox,
  useNotificationStore,
} from "./notificationStore";

function notification(
  overrides: Partial<AgentNotificationInfo> = {},
): AgentNotificationInfo {
  return {
    id: "notification-1",
    chatId: "chat-a",
    kind: "background_update",
    title: "Task update",
    body: "The task has an update.",
    actionKind: null,
    seenAtMs: null,
    resolvedAtMs: null,
    createdAtMs: 10,
    ...overrides,
  } as AgentNotificationInfo;
}

function job(
  overrides: Partial<AgentBackgroundJobInfo> = {},
): AgentBackgroundJobInfo {
  return {
    id: "job-1",
    kind: "agent",
    chatId: "chat-a",
    state: "running",
    resumeAfterRestart: true,
    detached: false,
    lastError: null,
    createdAtMs: 5,
    updatedAtMs: 10,
    ...overrides,
  } as AgentBackgroundJobInfo;
}

function ticket(
  overrides: Partial<AgentClarificationTicketInfo> = {},
): AgentClarificationTicketInfo {
  return {
    id: "ticket-1",
    jobId: "job-1",
    chatId: "chat-a",
    prompt: "Which option should I use?",
    choices: ["A", "B"],
    response: null,
    status: "waiting",
    createdAtMs: 8,
    updatedAtMs: 10,
    ...overrides,
  } as AgentClarificationTicketInfo;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeMocks.agentListNotifications.mockResolvedValue([]);
  nativeMocks.agentListBackgroundJobs.mockResolvedValue([]);
  nativeMocks.agentListClarificationTickets.mockResolvedValue([]);
  nativeMocks.agentNotificationMarkSeen.mockResolvedValue(undefined);
  nativeMocks.agentNotificationResolve.mockResolvedValue(undefined);
  nativeMocks.agentBackgroundJobDismiss.mockResolvedValue(undefined);
  nativeMocks.agentClarificationTicketDismiss.mockResolvedValue(undefined);
  useNotificationStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildNotificationInboxView", () => {
  it("deduplicates a ticket's linked notification and counts attention", () => {
    const waitingTicket = ticket();
    const linked = notification({
      id: "notification-ticket",
      kind: "clarification_ticket",
      actionKind: "reply_ticket",
      createdAtMs: 20,
    });
    const unread = notification({ id: "notification-unread", createdAtMs: 30 });
    const seen = notification({
      id: "notification-seen",
      seenAtMs: 25,
      createdAtMs: 25,
    });
    const resolved = notification({
      id: "notification-resolved",
      resolvedAtMs: 40,
    });

    const view = buildNotificationInboxView(
      [linked, seen, resolved, unread],
      [
        job(),
        job({ id: "job-waiting", state: "waiting", updatedAtMs: 30 }),
        job({ id: "job-done", state: "completed" }),
      ],
      [waitingTicket],
    );

    expect(view.waitingTickets.map((item) => item.id)).toEqual(["ticket-1"]);
    expect(view.notifications.map((item) => item.id)).toEqual([
      "notification-unread",
      "notification-seen",
    ]);
    // job-1 is represented by the waiting ticket; terminal jobs stay hidden.
    expect(view.activeJobs.map((item) => item.id)).toEqual(["job-waiting"]);
    expect(view.attentionCount).toBe(3); // ticket + unread notice + orphan wait
  });
});

describe("notification store", () => {
  it("refreshes the current workspace after a live inbox invalidation", async () => {
    vi.useFakeTimers();
    useNotificationStore.setState({
      workspacePath: "/workspace",
      hydrated: true,
    });

    invalidateNotificationInbox();
    await vi.advanceTimersByTimeAsync(80);

    expect(nativeMocks.agentListNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/workspace" }),
    );
  });

  it("ignores a stale workspace refresh that resolves last", async () => {
    const aNotifications = deferred<AgentNotificationInfo[]>();
    const aJobs = deferred<AgentBackgroundJobInfo[]>();
    const aTickets = deferred<AgentClarificationTicketInfo[]>();
    const bNotifications = deferred<AgentNotificationInfo[]>();
    const bJobs = deferred<AgentBackgroundJobInfo[]>();
    const bTickets = deferred<AgentClarificationTicketInfo[]>();

    nativeMocks.agentListNotifications.mockImplementation(
      ({ workspacePath }: { workspacePath?: string }) =>
        workspacePath === "/workspace/a"
          ? aNotifications.promise
          : bNotifications.promise,
    );
    nativeMocks.agentListBackgroundJobs.mockImplementation(
      ({ workspacePath }: { workspacePath?: string }) =>
        workspacePath === "/workspace/a" ? aJobs.promise : bJobs.promise,
    );
    nativeMocks.agentListClarificationTickets.mockImplementation(
      ({ workspacePath }: { workspacePath?: string }) =>
        workspacePath === "/workspace/a" ? aTickets.promise : bTickets.promise,
    );

    const refreshA = useNotificationStore
      .getState()
      .refresh("/workspace/a");
    const refreshB = useNotificationStore
      .getState()
      .refresh("/workspace/b");

    bNotifications.resolve([notification({ id: "from-b" })]);
    bJobs.resolve([job({ id: "job-b" })]);
    bTickets.resolve([ticket({ id: "ticket-b", jobId: "job-b" })]);
    await refreshB;

    aNotifications.resolve([notification({ id: "from-a" })]);
    aJobs.resolve([job({ id: "job-a" })]);
    aTickets.resolve([ticket({ id: "ticket-a", jobId: "job-a" })]);
    await refreshA;

    const state = useNotificationStore.getState();
    expect(state.workspacePath).toBe("/workspace/b");
    expect(state.notifications.map((item) => item.id)).toEqual(["from-b"]);
    expect(state.backgroundJobs.map((item) => item.id)).toEqual(["job-b"]);
    expect(state.clarificationTickets.map((item) => item.id)).toEqual([
      "ticket-b",
    ]);
  });

  it("passes the owning chat to notification mutations and updates locally", async () => {
    useNotificationStore.setState({
      workspacePath: "/workspace",
      notifications: [notification()],
    });

    await useNotificationStore
      .getState()
      .markSeen("notification-1", "chat-a");
    expect(nativeMocks.agentNotificationMarkSeen).toHaveBeenCalledWith(
      "notification-1",
      "chat-a",
      "/workspace",
    );
    expect(
      useNotificationStore.getState().notifications[0].seenAtMs,
    ).not.toBeNull();

    await useNotificationStore
      .getState()
      .resolveNotification("notification-1", "chat-a");
    expect(nativeMocks.agentNotificationResolve).toHaveBeenCalledWith(
      "notification-1",
      "chat-a",
      "/workspace",
    );
    expect(
      useNotificationStore.getState().notifications[0].resolvedAtMs,
    ).not.toBeNull();
  });

  it("dismisses a ticket's whole job projection without leaving duplicates", async () => {
    const first = ticket();
    const second = ticket({ id: "ticket-2" });
    useNotificationStore.setState({
      workspacePath: "/workspace",
      backgroundJobs: [job()],
      clarificationTickets: [first, second],
      notifications: [
        notification({
          id: "notice-1",
          kind: "clarification_ticket",
          actionKind: "reply_ticket",
        }),
        notification({
          id: "notice-2",
          kind: "clarification_ticket",
          actionKind: "reply_ticket",
        }),
      ],
    });

    await useNotificationStore
      .getState()
      .dismissTicket(first.id, first.chatId);

    expect(nativeMocks.agentClarificationTicketDismiss).toHaveBeenCalledWith(
      first.id,
      first.chatId,
      "/workspace",
    );
    const state = useNotificationStore.getState();
    expect(state.clarificationTickets).toEqual([]);
    expect(state.backgroundJobs).toEqual([]);
    expect(state.notifications).toEqual([]);
  });

  it("keeps persisted data and reports an error when a mutation fails", async () => {
    nativeMocks.agentBackgroundJobDismiss.mockRejectedValue(
      new Error("not allowed"),
    );
    const activeJob = job();
    useNotificationStore.setState({
      workspacePath: "/workspace",
      backgroundJobs: [activeJob],
    });

    await useNotificationStore
      .getState()
      .dismissJob(activeJob.id, activeJob.chatId);

    expect(nativeMocks.agentBackgroundJobDismiss).toHaveBeenCalledWith(
      activeJob.id,
      activeJob.chatId,
      "/workspace",
    );
    expect(useNotificationStore.getState().backgroundJobs).toEqual([activeJob]);
    expect(useNotificationStore.getState().error).toContain("not allowed");
    expect(useNotificationStore.getState().pendingIds).toEqual({});
  });
});
