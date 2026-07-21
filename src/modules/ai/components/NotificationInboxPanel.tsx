import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useWorkspaceFolderStore } from "@/modules/workspace/folder";
import {
  Alert02Icon,
  Cancel01Icon,
  Notebook01Icon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import type {
  AgentBackgroundJobInfo,
  AgentClarificationTicketInfo,
  AgentNotificationInfo,
} from "../lib/native";
import { useChatStore } from "../store/chatStore";
import {
  buildNotificationInboxView,
  useNotificationStore,
} from "../store/notificationStore";

type DismissTarget =
  | {
      kind: "ticket";
      id: string;
      chatId: string;
      label: string;
    }
  | {
      kind: "job";
      id: string;
      chatId: string;
      label: string;
    };

type InboxFilter = "all" | "attention" | "work" | "updates";

export function NotificationInboxPanel({ onClose }: { onClose: () => void }) {
  const workspacePath = useWorkspaceFolderStore((state) => state.folder);
  const sessions = useChatStore((state) => state.sessions);
  const switchSession = useChatStore((state) => state.switchSession);
  const notifications = useNotificationStore((state) => state.notifications);
  const backgroundJobs = useNotificationStore((state) => state.backgroundJobs);
  const clarificationTickets = useNotificationStore(
    (state) => state.clarificationTickets,
  );
  const hydrated = useNotificationStore((state) => state.hydrated);
  const loading = useNotificationStore((state) => state.loading);
  const error = useNotificationStore((state) => state.error);
  const pendingIds = useNotificationStore((state) => state.pendingIds);
  const refresh = useNotificationStore((state) => state.refresh);
  const markSeen = useNotificationStore((state) => state.markSeen);
  const resolveNotification = useNotificationStore(
    (state) => state.resolveNotification,
  );
  const dismissJob = useNotificationStore((state) => state.dismissJob);
  const dismissTicket = useNotificationStore((state) => state.dismissTicket);
  const replyToTicket = useNotificationStore((state) => state.replyToTicket);
  const clearError = useNotificationStore((state) => state.clearError);
  const [dismissTarget, setDismissTarget] = useState<DismissTarget | null>(null);
  const [filter, setFilter] = useState<InboxFilter>("all");

  const view = useMemo(
    () =>
      buildNotificationInboxView(
        notifications,
        backgroundJobs,
        clarificationTickets,
      ),
    [notifications, backgroundJobs, clarificationTickets],
  );
  const sessionIds = useMemo(
    () => new Set(sessions.map((session) => session.id)),
    [sessions],
  );
  useEffect(() => {
    void refresh(workspacePath);
  }, [refresh, workspacePath]);

  const openChat = (chatId: string) => {
    if (!sessionIds.has(chatId)) return;
    switchSession(chatId);
    onClose();
  };

  const openNotificationChat = (notification: AgentNotificationInfo) => {
    if (notification.seenAtMs === null) {
      void markSeen(notification.id, notification.chatId);
    }
    openChat(notification.chatId);
  };

  const confirmDismiss = () => {
    const target = dismissTarget;
    if (!target) return;
    if (target.kind === "ticket") {
      void dismissTicket(target.id, target.chatId);
    } else {
      void dismissJob(target.id, target.chatId);
    }
  };

  const empty =
    view.waitingTickets.length === 0 &&
    view.notifications.length === 0 &&
    view.activeJobs.length === 0;
  const unreadNotifications = useMemo(
    () => view.notifications.filter((notification) => notification.seenAtMs === null),
    [view.notifications],
  );
  const waitingJobs = useMemo(
    () =>
      view.activeJobs.filter((job) =>
        job.state.toLowerCase().includes("waiting"),
      ),
    [view.activeJobs],
  );
  const activeJobs = useMemo(
    () =>
      view.activeJobs.filter(
        (job) => !job.state.toLowerCase().includes("waiting"),
      ),
    [view.activeJobs],
  );
  const visibleNotifications = useMemo(
    () => (filter === "attention" ? unreadNotifications : view.notifications),
    [filter, unreadNotifications, view.notifications],
  );
  const filterCounts: Record<InboxFilter, number> = {
    all:
      view.waitingTickets.length +
      view.notifications.length +
      view.activeJobs.length,
    attention:
      view.waitingTickets.length + unreadNotifications.length + waitingJobs.length,
    work: view.activeJobs.length,
    updates: view.notifications.length,
  };
  const hasVisibleItems = filterCounts[filter] > 0;

  return (
    <>
      <section
        aria-label="Agent inbox"
        className="absolute inset-0 z-30 flex flex-col bg-background/96 backdrop-blur-sm"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h2 className="text-[12px] font-semibold text-foreground">Inbox</h2>
              {view.attentionCount ? (
                <span className="rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 dark:text-amber-300">
                  {view.attentionCount} need{view.attentionCount === 1 ? "s" : ""} attention
                </span>
              ) : (
                <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 dark:text-emerald-300">
                  All clear
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Keep track of agents without losing your place in chat.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh(workspacePath)}
            disabled={loading}
            aria-label="Refresh agent inbox"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-45"
          >
            {loading ? (
              <Spinner className="size-3.5" />
            ) : (
              <HugeiconsIcon
                icon={Refresh01Icon}
                size={13}
                strokeWidth={1.75}
              />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close agent inbox"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              size={13}
              strokeWidth={1.75}
            />
          </button>
        </header>

        {error ? (
          <div
            role="alert"
            className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2.5 py-2 text-[10.5px] text-destructive"
          >
            <HugeiconsIcon
              icon={Alert02Icon}
              size={13}
              strokeWidth={1.8}
              className="mt-0.5 shrink-0"
            />
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={clearError}
              aria-label="Dismiss error"
              className="rounded p-0.5 hover:bg-destructive/10"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          </div>
        ) : null}

        <div className="shrink-0 border-b border-border/45 bg-muted/[0.12] px-3 py-2.5">
          <div className="grid grid-cols-3 gap-1.5">
            <InboxStat
              label="Paused"
              value={view.waitingTickets.length}
              active={filter === "attention"}
              tone="amber"
              onClick={() => setFilter("attention")}
            />
            <InboxStat
              label="Unread"
              value={unreadNotifications.length}
              active={filter === "updates"}
              tone="sky"
              onClick={() => setFilter("updates")}
            />
            <InboxStat
              label="Working"
              value={view.activeJobs.length}
              active={filter === "work"}
              tone="violet"
              onClick={() => setFilter("work")}
            />
          </div>
          <div
            role="tablist"
            aria-label="Filter inbox"
            className="mt-2 flex items-center gap-1 overflow-x-auto rounded-lg bg-foreground/[0.045] p-1"
          >
            {(
              [
                ["all", "All"],
                ["attention", "Attention"],
                ["work", "Work"],
                ["updates", "Updates"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "shrink-0 rounded-md px-2 py-1 text-[9.5px] font-medium transition-colors",
                  filter === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {filterCounts[value] ? (
                  <span className="ml-1 opacity-65">{filterCounts[value]}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!hydrated && loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-muted-foreground">
              <Spinner className="size-3.5" />
              Loading agent inbox…
            </div>
          ) : error ? (
            <InboxLoadFailed onRetry={() => void refresh(workspacePath)} />
          ) : empty ? (
            <EmptyInbox />
          ) : !hasVisibleItems ? (
            <FilteredEmptyInbox filter={filter} onShowAll={() => setFilter("all")} />
          ) : (
            <div className="space-y-4">
              {(filter === "all" || filter === "attention") &&
              view.waitingTickets.length ? (
                <InboxSection
                  title="Paused tasks"
                  count={view.waitingTickets.length}
                >
                  {view.waitingTickets.map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      busy={Boolean(pendingIds[`ticket:${ticket.id}`])}
                      canResume={backgroundJobs.some(
                        (job) =>
                          job.id === ticket.jobId &&
                          job.state.trim().toLowerCase() === "waiting",
                      )}
                      canDismiss={backgroundJobs.some(
                        (job) =>
                          job.id === ticket.jobId &&
                          job.state.trim().toLowerCase() === "waiting",
                      )}
                      onReply={(response) =>
                        void replyToTicket(ticket.id, ticket.chatId, response)
                      }
                      onDismiss={() =>
                        setDismissTarget({
                          kind: "ticket",
                          id: ticket.id,
                          chatId: ticket.chatId,
                          label: ticket.prompt,
                        })
                      }
                    />
                  ))}
                </InboxSection>
              ) : null}

              {(filter === "all" || filter === "updates" || filter === "attention") &&
              visibleNotifications.length ? (
                <InboxSection
                  title={filter === "attention" ? "Unread updates" : "Notifications"}
                  count={visibleNotifications.length}
                >
                  {visibleNotifications.map((notification) => (
                    <NotificationCard
                      key={notification.id}
                      notification={notification}
                      canOpenChat={sessionIds.has(notification.chatId)}
                      busy={Boolean(
                        pendingIds[`notification:${notification.id}`],
                      )}
                      onOpenChat={() => openNotificationChat(notification)}
                      onMarkSeen={() =>
                        void markSeen(notification.id, notification.chatId)
                      }
                      onResolve={() =>
                        void resolveNotification(
                          notification.id,
                          notification.chatId,
                        )
                      }
                    />
                  ))}
                </InboxSection>
              ) : null}

              {(filter === "all" || filter === "work") && activeJobs.length ? (
                <InboxSection
                  title="In progress"
                  count={activeJobs.length}
                >
                  {activeJobs.map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      canOpenChat={sessionIds.has(job.chatId)}
                      busy={Boolean(pendingIds[`job:${job.id}`])}
                      canDismiss={false}
                      onOpenChat={() => openChat(job.chatId)}
                      onDismiss={() =>
                        setDismissTarget({
                          kind: "job",
                          id: job.id,
                          chatId: job.chatId,
                          label: labelForJob(job),
                        })
                      }
                    />
                  ))}
                </InboxSection>
              ) : null}

              {(filter === "all" || filter === "attention") &&
              waitingJobs.length ? (
                <InboxSection title="Waiting work" count={waitingJobs.length}>
                  {waitingJobs.map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      canOpenChat={sessionIds.has(job.chatId)}
                      busy={Boolean(pendingIds[`job:${job.id}`])}
                      canDismiss
                      onOpenChat={() => openChat(job.chatId)}
                      onDismiss={() =>
                        setDismissTarget({
                          kind: "job",
                          id: job.id,
                          chatId: job.chatId,
                          label: labelForJob(job),
                        })
                      }
                    />
                  ))}
                </InboxSection>
              ) : null}
            </div>
          )}
        </div>
      </section>

      <AlertDialog
        open={dismissTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDismissTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss background task?</AlertDialogTitle>
            <AlertDialogDescription>
              {dismissTarget?.kind === "ticket"
                ? "This marks the waiting background job as completed and dismisses every unanswered question attached to it."
                : "This marks the waiting background job as completed and dismisses its outstanding questions."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="line-clamp-3 rounded-lg bg-muted/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {dismissTarget?.label}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep task</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDismiss}>
              Dismiss task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function InboxSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        <span className="rounded-full bg-foreground/[0.07] px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function InboxStat({
  label,
  value,
  active,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  active: boolean;
  tone: "amber" | "sky" | "violet";
  onClick: () => void;
}) {
  const tones = {
    amber: "border-amber-500/25 bg-amber-500/[0.055] text-amber-700 dark:text-amber-300",
    sky: "border-sky-500/25 bg-sky-500/[0.05] text-sky-700 dark:text-sky-300",
    violet: "border-violet-500/25 bg-violet-500/[0.05] text-violet-700 dark:text-violet-300",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-2 py-1.5 text-left transition-colors hover:brightness-95",
        tones[tone],
        active && "ring-1 ring-current/25",
      )}
    >
      <span className="block text-[14px] font-semibold leading-none tabular-nums">
        {value}
      </span>
      <span className="mt-1 block truncate text-[8.5px] font-medium opacity-75">
        {label}
      </span>
    </button>
  );
}

function TicketCard({
  ticket,
  busy,
  canResume,
  canDismiss,
  onReply,
  onDismiss,
}: {
  ticket: AgentClarificationTicketInfo;
  busy: boolean;
  canResume: boolean;
  canDismiss: boolean;
  onReply: (response: string) => void;
  onDismiss: () => void;
}) {
  const [response, setResponse] = useState("");
  const trimmedResponse = response.trim();

  return (
    <article className="rounded-lg border border-amber-500/30 bg-amber-500/[0.055] p-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300">
          <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
            Background task is paused
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">
            {ticket.prompt}
          </p>
          {!canResume && ticket.choices.length ? (
            <div
              aria-label="Available choices"
              className="mt-2 flex flex-wrap gap-1"
            >
              {ticket.choices.map((choice, index) => (
                <span
                  key={`${index}-${choice}`}
                  className="rounded-full border border-amber-500/25 bg-background/55 px-2 py-0.5 text-[9.5px] text-muted-foreground"
                >
                  {choice}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-1.5 text-[9px] text-muted-foreground">
            {formatRelativeTime(ticket.updatedAtMs)}
          </div>
          {canResume ? (
            <div className="mt-2 space-y-1.5">
              <textarea
                value={response}
                onChange={(event) => setResponse(event.target.value)}
                disabled={busy}
                placeholder="Reply to resume this task…"
                rows={2}
                maxLength={10_000}
                className="w-full resize-y rounded-md border border-amber-500/25 bg-background/65 px-2 py-1.5 text-[10.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70 focus:border-amber-500/55 disabled:opacity-50"
              />
              {ticket.choices.length ? (
                <div className="flex flex-wrap gap-1">
                  {ticket.choices.map((choice, index) => (
                    <button
                      key={`${index}-${choice}-reply`}
                      type="button"
                      onClick={() => setResponse(choice)}
                      disabled={busy}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[9px] transition-colors disabled:opacity-45",
                        response === choice
                          ? "border-amber-500/60 bg-amber-500/15 text-amber-800 dark:text-amber-200"
                          : "border-amber-500/25 bg-background/55 text-muted-foreground hover:border-amber-500/45",
                      )}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-[9.5px] leading-relaxed text-muted-foreground">
              This task is no longer waiting for a reply.
            </p>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 border-t border-amber-500/15 pt-2">
        {canResume ? (
          <button
            type="button"
            onClick={() => onReply(trimmedResponse)}
            disabled={busy || !trimmedResponse}
            className="rounded-md bg-amber-500/15 px-2 py-1 text-[10px] font-medium text-amber-800 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-45 dark:text-amber-200"
          >
            {busy ? "Resuming…" : "Reply & resume"}
          </button>
        ) : null}
        {canDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="ml-auto rounded-md px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-45"
          >
            {busy ? "Dismissing…" : "Dismiss waiting task"}
          </button>
        ) : (
          <span className="text-[9.5px] text-muted-foreground">
            Waiting for safe resume routing
          </span>
        )}
      </div>
    </article>
  );
}

function NotificationCard({
  notification,
  canOpenChat,
  busy,
  onOpenChat,
  onMarkSeen,
  onResolve,
}: {
  notification: AgentNotificationInfo;
  canOpenChat: boolean;
  busy: boolean;
  onOpenChat: () => void;
  onMarkSeen: () => void;
  onResolve: () => void;
}) {
  const unread = notification.seenAtMs === null;
  return (
    <article
      className={cn(
        "rounded-lg border border-border/60 bg-card/45 p-2.5",
        unread && "border-sky-500/25 bg-sky-500/[0.035]",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            unread ? "bg-sky-500" : "bg-muted-foreground/35",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h4 className="min-w-0 flex-1 text-[11px] font-medium leading-snug text-foreground">
              {notification.title}
            </h4>
            <span className="shrink-0 text-[9px] text-muted-foreground">
              {formatRelativeTime(notification.createdAtMs)}
            </span>
          </div>
          {notification.body ? (
            <p className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-muted-foreground">
              {notification.body}
            </p>
          ) : null}
          <div className="mt-1 text-[9px] text-muted-foreground/75">
            {humanize(notification.kind)}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 border-t border-border/40 pt-2">
        <button
          type="button"
          onClick={onOpenChat}
          disabled={!canOpenChat}
          title={
            canOpenChat
              ? "Open related chat"
              : "The related chat is unavailable until backend session recovery supports this workspace"
          }
          className="rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          Open chat
        </button>
        {unread ? (
          <button
            type="button"
            onClick={onMarkSeen}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-45"
          >
            Mark read
          </button>
        ) : null}
        <button
          type="button"
          onClick={onResolve}
          disabled={busy}
          className="ml-auto rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-45"
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}

function JobCard({
  job,
  canOpenChat,
  busy,
  canDismiss,
  onOpenChat,
  onDismiss,
}: {
  job: AgentBackgroundJobInfo;
  canOpenChat: boolean;
  busy: boolean;
  canDismiss: boolean;
  onOpenChat: () => void;
  onDismiss: () => void;
}) {
  const waiting = job.state.toLowerCase().includes("waiting");
  return (
    <article className="rounded-lg border border-border/60 bg-card/45 p-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-muted-foreground">
          <HugeiconsIcon icon={Notebook01Icon} size={13} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h4 className="min-w-0 flex-1 text-[11px] font-medium text-foreground">
              {labelForJob(job)}
            </h4>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                waiting
                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "bg-sky-500/10 text-sky-700 dark:text-sky-300",
              )}
            >
              {humanize(job.state)}
            </span>
          </div>
          <p className="mt-1 text-[9.5px] text-muted-foreground">
            Updated {formatRelativeTime(job.updatedAtMs)}
            {job.resumeAfterRestart ? " · resumes after restart" : ""}
            {job.detached ? " · detached" : ""}
          </p>
          {job.lastError ? (
            <p className="mt-1.5 line-clamp-2 text-[10px] leading-relaxed text-destructive">
              {job.lastError}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 border-t border-border/40 pt-2">
        <button
          type="button"
          onClick={onOpenChat}
          disabled={!canOpenChat}
          title={
            canOpenChat
              ? "Open related chat"
              : "The related chat is unavailable until backend session recovery supports this workspace"
          }
          className="rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          Open chat
        </button>
        {canDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="ml-auto rounded-md px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-45"
          >
            {busy ? "Dismissing…" : "Dismiss waiting task"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function EmptyInbox() {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <span className="inline-flex size-9 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
        <HugeiconsIcon icon={Tick02Icon} size={18} strokeWidth={1.75} />
      </span>
      <h3 className="mt-3 text-[11.5px] font-medium text-foreground">
        You&apos;re all caught up
      </h3>
      <p className="mt-1 max-w-64 text-[10px] leading-relaxed text-muted-foreground">
        Questions from background agents and durable task updates will appear
        here.
      </p>
    </div>
  );
}

function InboxLoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <span className="inline-flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <HugeiconsIcon icon={Alert02Icon} size={17} strokeWidth={1.75} />
      </span>
      <h3 className="mt-3 text-[11.5px] font-medium text-foreground">
        Inbox could not be loaded
      </h3>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Try again
      </button>
    </div>
  );
}

function FilteredEmptyInbox({
  filter,
  onShowAll,
}: {
  filter: InboxFilter;
  onShowAll: () => void;
}) {
  const label =
    filter === "attention"
      ? "Nothing needs your attention"
      : filter === "work"
        ? "No background work is running"
        : "No notifications to show";
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <HugeiconsIcon icon={Tick02Icon} size={17} strokeWidth={1.75} />
      </span>
      <h3 className="mt-3 text-[11.5px] font-medium text-foreground">{label}</h3>
      <button
        type="button"
        onClick={onShowAll}
        className="mt-2 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Show all inbox items
      </button>
    </div>
  );
}

function labelForJob(job: AgentBackgroundJobInfo): string {
  const kind = humanize(job.kind);
  return kind ? `${kind} background task` : "Background task";
}

function humanize(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, " ");
  return normalized
    ? normalized.charAt(0).toUpperCase() + normalized.slice(1)
    : "";
}

function formatRelativeTime(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
