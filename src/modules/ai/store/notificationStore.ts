import { create } from "zustand";
import {
  native,
  type AgentBackgroundJobInfo,
  type AgentClarificationTicketInfo,
  type AgentNotificationInfo,
} from "../lib/native";

const DEFAULT_LIMIT = 200;
const TERMINAL_JOB_STATES = new Set([
  "cancelled",
  "canceled",
  "completed",
  "dismissed",
  "done",
  "failed",
  "success",
]);

type MutationKind = "notification" | "job" | "ticket";

export type NotificationInboxView = {
  waitingTickets: AgentClarificationTicketInfo[];
  notifications: AgentNotificationInfo[];
  activeJobs: AgentBackgroundJobInfo[];
  attentionCount: number;
};

export type NotificationState = {
  workspacePath: string | null;
  notifications: AgentNotificationInfo[];
  backgroundJobs: AgentBackgroundJobInfo[];
  clarificationTickets: AgentClarificationTicketInfo[];
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  pendingIds: Record<string, true>;
  requestSerial: number;
  refresh: (workspacePath?: string | null) => Promise<void>;
  markSeen: (notificationId: string, chatId: string) => Promise<void>;
  resolveNotification: (
    notificationId: string,
    chatId: string,
  ) => Promise<void>;
  dismissJob: (jobId: string, chatId: string) => Promise<void>;
  dismissTicket: (ticketId: string, chatId: string) => Promise<void>;
  replyToTicket: (
    ticketId: string,
    chatId: string,
    response: string,
  ) => Promise<void>;
  clearError: () => void;
  reset: () => void;
};

function normalizedWorkspacePath(path?: string | null): string | null {
  const trimmed = path?.trim();
  return trimmed ? trimmed : null;
}

function mutationKey(kind: MutationKind, id: string): string {
  return `${kind}:${id}`;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byNewest(
  a: { createdAtMs: number },
  b: { createdAtMs: number },
): number {
  return b.createdAtMs - a.createdAtMs;
}

function isWaitingStatus(status: string): boolean {
  return status.trim().toLowerCase() === "waiting";
}

function isTerminalJobState(state: string): boolean {
  return TERMINAL_JOB_STATES.has(state.trim().toLowerCase());
}

function isLinkedTicketNotification(
  notification: AgentNotificationInfo,
  waitingTicketChatIds: ReadonlySet<string>,
): boolean {
  if (!waitingTicketChatIds.has(notification.chatId)) return false;
  return (
    notification.kind === "clarification_ticket" ||
    notification.actionKind === "reply_ticket"
  );
}

/**
 * Build the render model without duplicating the notification that IsanAgent
 * creates for every clarification ticket. Waiting tickets always count as
 * attention; ordinary notifications count only while unread.
 */
export function buildNotificationInboxView(
  notifications: AgentNotificationInfo[],
  backgroundJobs: AgentBackgroundJobInfo[],
  clarificationTickets: AgentClarificationTicketInfo[],
): NotificationInboxView {
  const waitingTickets = clarificationTickets
    .filter((ticket) => isWaitingStatus(ticket.status))
    .sort(byNewest);
  const waitingTicketChatIds = new Set(
    waitingTickets.map((ticket) => ticket.chatId),
  );
  const waitingJobIds = new Set(waitingTickets.map((ticket) => ticket.jobId));

  const visibleNotifications = notifications
    .filter((notification) => notification.resolvedAtMs === null)
    .filter(
      (notification) =>
        !isLinkedTicketNotification(notification, waitingTicketChatIds),
    )
    .sort(byNewest);

  const activeJobs = backgroundJobs
    .filter((job) => !isTerminalJobState(job.state))
    .filter((job) => !waitingJobIds.has(job.id))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  const unreadNotifications = visibleNotifications.filter(
    (notification) => notification.seenAtMs === null,
  ).length;
  const orphanWaitingJobs = activeJobs.filter((job) =>
    job.state.toLowerCase().includes("waiting"),
  ).length;

  return {
    waitingTickets,
    notifications: visibleNotifications,
    activeJobs,
    attentionCount:
      waitingTickets.length + unreadNotifications + orphanWaitingJobs,
  };
}

export function selectNotificationAttentionCount(
  state: NotificationState,
): number {
  return buildNotificationInboxView(
    state.notifications,
    state.backgroundJobs,
    state.clarificationTickets,
  ).attentionCount;
}

function beginMutation(
  set: (
    partial:
      | Partial<NotificationState>
      | ((
          state: NotificationState,
        ) => Partial<NotificationState> | NotificationState),
  ) => void,
  key: string,
): void {
  set((state) => ({
    error: null,
    pendingIds: { ...state.pendingIds, [key]: true },
  }));
}

function endMutation(
  set: (
    partial:
      | Partial<NotificationState>
      | ((
          state: NotificationState,
        ) => Partial<NotificationState> | NotificationState),
  ) => void,
  key: string,
): void {
  set((state) => {
    if (!state.pendingIds[key]) return {};
    const pendingIds = { ...state.pendingIds };
    delete pendingIds[key];
    return { pendingIds };
  });
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  workspacePath: null,
  notifications: [],
  backgroundJobs: [],
  clarificationTickets: [],
  hydrated: false,
  loading: false,
  error: null,
  pendingIds: {},
  requestSerial: 0,

  refresh: async (workspacePath) => {
    // Invalidation events do not carry a filesystem path. An omitted argument
    // therefore means "refresh the workspace already owned by this store";
    // callers may still pass null explicitly for IsanAgent's default workspace.
    const path =
      workspacePath === undefined
        ? get().workspacePath
        : normalizedWorkspacePath(workspacePath);
    const requestSerial = get().requestSerial + 1;
    const workspaceChanged = get().workspacePath !== path;
    if (path === null) {
      set({
        workspacePath: null,
        requestSerial,
        notifications: [],
        backgroundJobs: [],
        clarificationTickets: [],
        hydrated: true,
        loading: false,
        error: null,
        pendingIds: {},
      });
      return;
    }
    set({
      workspacePath: path,
      requestSerial,
      loading: true,
      error: null,
      ...(workspaceChanged
        ? {
            notifications: [],
            backgroundJobs: [],
            clarificationTickets: [],
            hydrated: false,
            pendingIds: {},
          }
        : {}),
    });

    try {
      const options = { workspacePath: path ?? undefined, limit: DEFAULT_LIMIT };
      const [notifications, backgroundJobs, clarificationTickets] =
        await Promise.all([
          native.agentListNotifications(options),
          native.agentListBackgroundJobs(options),
          native.agentListClarificationTickets({
            ...options,
            status: "waiting",
          }),
        ]);

      if (
        get().requestSerial !== requestSerial ||
        get().workspacePath !== path
      ) {
        return;
      }
      set({
        notifications,
        backgroundJobs,
        clarificationTickets,
        hydrated: true,
        loading: false,
      });
    } catch (error) {
      if (
        get().requestSerial !== requestSerial ||
        get().workspacePath !== path
      ) {
        return;
      }
      set({
        hydrated: true,
        loading: false,
        error: `Could not load the agent inbox: ${messageFrom(error)}`,
      });
    }
  },

  markSeen: async (notificationId, chatId) => {
    const key = mutationKey("notification", notificationId);
    const workspacePath = get().workspacePath;
    beginMutation(set, key);
    try {
      await native.agentNotificationMarkSeen(
        notificationId,
        chatId,
        workspacePath ?? undefined,
      );
      if (get().workspacePath !== workspacePath) return;
      const now = Date.now();
      set((state) => ({
        notifications: state.notifications.map((notification) =>
          notification.id === notificationId
            ? {
                ...notification,
                seenAtMs: notification.seenAtMs ?? now,
              }
            : notification,
        ),
      }));
    } catch (error) {
      if (get().workspacePath === workspacePath) {
        set({ error: `Could not mark notification as read: ${messageFrom(error)}` });
      }
    } finally {
      endMutation(set, key);
    }
  },

  resolveNotification: async (notificationId, chatId) => {
    const key = mutationKey("notification", notificationId);
    const workspacePath = get().workspacePath;
    beginMutation(set, key);
    try {
      await native.agentNotificationResolve(
        notificationId,
        chatId,
        workspacePath ?? undefined,
      );
      if (get().workspacePath !== workspacePath) return;
      const now = Date.now();
      set((state) => ({
        notifications: state.notifications.map((notification) =>
          notification.id === notificationId
            ? {
                ...notification,
                seenAtMs: notification.seenAtMs ?? now,
                resolvedAtMs: notification.resolvedAtMs ?? now,
              }
            : notification,
        ),
      }));
    } catch (error) {
      if (get().workspacePath === workspacePath) {
        set({ error: `Could not dismiss notification: ${messageFrom(error)}` });
      }
    } finally {
      endMutation(set, key);
    }
  },

  dismissJob: async (jobId, chatId) => {
    const key = mutationKey("job", jobId);
    const workspacePath = get().workspacePath;
    beginMutation(set, key);
    try {
      await native.agentBackgroundJobDismiss(
        jobId,
        chatId,
        workspacePath ?? undefined,
      );
      if (get().workspacePath !== workspacePath) return;
      // Dismissing a job also resolves its tickets and linked notifications in
      // IsanAgent. Reconcile all three projections because the security-safe
      // frontend DTO intentionally omits the raw ticket action payload.
      await get().refresh(workspacePath);
    } catch (error) {
      if (get().workspacePath === workspacePath) {
        set({ error: `Could not dismiss background job: ${messageFrom(error)}` });
      }
    } finally {
      endMutation(set, key);
    }
  },

  dismissTicket: async (ticketId, chatId) => {
    const key = mutationKey("ticket", ticketId);
    const workspacePath = get().workspacePath;
    beginMutation(set, key);
    try {
      await native.agentClarificationTicketDismiss(
        ticketId,
        chatId,
        workspacePath ?? undefined,
      );
      if (get().workspacePath !== workspacePath) return;
      await get().refresh(workspacePath);
    } catch (error) {
      if (get().workspacePath === workspacePath) {
        set({ error: `Could not dismiss clarification: ${messageFrom(error)}` });
      }
    } finally {
      endMutation(set, key);
    }
  },

  replyToTicket: async (ticketId, chatId, response) => {
    const key = mutationKey("ticket", ticketId);
    const workspacePath = get().workspacePath;
    beginMutation(set, key);
    try {
      await native.agentClarificationTicketReply(
        ticketId,
        chatId,
        response,
        workspacePath ?? undefined,
      );
      if (get().workspacePath !== workspacePath) return;
      await get().refresh(workspacePath);
    } catch (error) {
      if (get().workspacePath === workspacePath) {
        set({ error: `Could not resume background task: ${messageFrom(error)}` });
      }
    } finally {
      endMutation(set, key);
    }
  },

  clearError: () => set({ error: null }),

  reset: () =>
    set((state) => ({
      workspacePath: null,
      notifications: [],
      backgroundJobs: [],
      clarificationTickets: [],
      hydrated: false,
      loading: false,
      error: null,
      pendingIds: {},
      requestSerial: state.requestSerial + 1,
    })),
}));

let invalidationTimer: ReturnType<typeof setTimeout> | null = null;

export function invalidateNotificationInbox(): void {
  if (invalidationTimer) clearTimeout(invalidationTimer);
  invalidationTimer = setTimeout(() => {
    invalidationTimer = null;
    const state = useNotificationStore.getState();
    // The first panel/badge hydration establishes the workspace. Avoid opening
    // the default IsanAgent DB merely because an early lifecycle event fired.
    if (!state.hydrated && state.workspacePath === null) return;
    void state.refresh(state.workspacePath);
  }, 80);
}

// `agentEventBridge` dispatches this lightweight browser event after durable
// notification/job/ticket changes. Registering with the store module keeps the
// badge fresh even while the inbox overlay itself is closed.
if (typeof window !== "undefined") {
  window.addEventListener(
    "altai:agent-inbox-changed",
    invalidateNotificationInbox,
  );
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener(
        "altai:agent-inbox-changed",
        invalidateNotificationInbox,
      );
      if (invalidationTimer) clearTimeout(invalidationTimer);
      invalidationTimer = null;
    });
  }
}
