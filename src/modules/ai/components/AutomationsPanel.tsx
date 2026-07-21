import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useWorkspaceFolderStore } from "@/modules/workspace/folder";
import { useEffect, useMemo, useState } from "react";
import type { AgentAutomationInfo } from "../lib/native";
import { useChatStore } from "../store/chatStore";
import { useAutomationStore } from "../store/automationStore";

type ScheduleMode = "at" | "every";

function defaultAtValue(): string {
  const next = new Date(Date.now() + 5 * 60_000);
  next.setSeconds(0, 0);
  const local = new Date(next.getTime() - next.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function scheduleLabel(item: AgentAutomationInfo): string {
  if (item.schedule.kind === "at") {
    return `Once · ${new Date(item.schedule.atMs).toLocaleString()}`;
  }
  if (item.schedule.kind === "every") {
    const minutes = item.schedule.everyMs / 60_000;
    return `Every ${minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`}`;
  }
  return `Cron · ${item.schedule.cronExpr}`;
}

function lastRunLabel(lastRunAtMs: number | null): string {
  return lastRunAtMs === null
    ? "Not run yet"
    : `Last run ${new Date(lastRunAtMs).toLocaleString()}`;
}

function nextRunLabel(item: AgentAutomationInfo): string {
  if (item.schedule.kind === "at") {
    return `Scheduled ${new Date(item.schedule.atMs).toLocaleString()}`;
  }
  if (item.schedule.kind === "every") {
    if (item.lastRunAtMs === null) return "Next run after initial sync";
    return `Next ${new Date(item.lastRunAtMs + item.schedule.everyMs).toLocaleString()}`;
  }
  return "Next run determined by cron expression";
}

export function AutomationsPanel({ onClose }: { onClose: () => void }) {
  const workspacePath = useWorkspaceFolderStore((state) => state.folder);
  const activeChatId = useChatStore((state) => state.activeSessionId);
  const sessions = useChatStore((state) => state.sessions);
  const switchSession = useChatStore((state) => state.switchSession);
  const items = useAutomationStore((state) => state.items);
  const jobsByAutomationId = useAutomationStore((state) => state.jobsByAutomationId);
  const hydrated = useAutomationStore((state) => state.hydrated);
  const loading = useAutomationStore((state) => state.loading);
  const error = useAutomationStore((state) => state.error);
  const pendingIds = useAutomationStore((state) => state.pendingIds);
  const refresh = useAutomationStore((state) => state.refresh);
  const create = useAutomationStore((state) => state.create);
  const remove = useAutomationStore((state) => state.remove);
  const clearError = useAutomationStore((state) => state.clearError);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<ScheduleMode>("at");
  const [atValue, setAtValue] = useState(defaultAtValue);
  const [everyMinutes, setEveryMinutes] = useState("60");

  useEffect(() => {
    void refresh(workspacePath);
  }, [refresh, workspacePath]);

  const titles = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );
  const creating = Boolean(pendingIds.create);
  const canCreate = Boolean(activeChatId && message.trim() && !creating);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeChatId || !message.trim()) return;
    if (mode === "at") {
      const atMs = new Date(atValue).getTime();
      if (!Number.isFinite(atMs)) return;
      void create(activeChatId, { kind: "at", atMs }, message.trim()).then((created) => {
        if (!created) return;
        setMessage("");
        setAtValue(defaultAtValue());
      });
      return;
    }
    const everyMs = Number(everyMinutes) * 60_000;
    if (!Number.isFinite(everyMs)) return;
    void create(activeChatId, { kind: "every", everyMs }, message.trim()).then((created) => {
      if (created) setMessage("");
    });
  };

  return (
    <section
      aria-label="Automations"
      className="absolute inset-0 z-30 flex flex-col bg-background/96 backdrop-blur-sm"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[12px] font-semibold text-foreground">Automations</h2>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Local schedules run in their owning chat.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh(workspacePath)}
          disabled={loading}
          aria-label="Refresh automations"
          className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-45"
        >
          {loading ? <Spinner className="size-3" /> : "Refresh"}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close automations"
          className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          Close
        </button>
      </header>

      <form onSubmit={submit} className="shrink-0 space-y-2 border-b border-border/50 px-3 py-3">
        <div className="text-[10px] font-medium text-foreground">New automation</div>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={10_000}
          rows={2}
          aria-label="Automation message"
          placeholder="What should the agent do?"
          className="w-full resize-y rounded-md border border-border/70 bg-background px-2 py-1.5 text-[10.5px] outline-none placeholder:text-muted-foreground/70 focus:border-primary/60"
        />
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-muted-foreground" htmlFor="automation-schedule-kind">
            Schedule
          </label>
          <select
            id="automation-schedule-kind"
            value={mode}
            onChange={(event) => setMode(event.target.value as ScheduleMode)}
            className="rounded-md border border-border/70 bg-background px-1.5 py-1 text-[10px] outline-none focus:border-primary/60"
          >
            <option value="at">Once</option>
            <option value="every">Repeat</option>
          </select>
          {mode === "at" ? (
            <input
              type="datetime-local"
              value={atValue}
              onChange={(event) => setAtValue(event.target.value)}
              aria-label="Automation run time"
              className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-1.5 py-1 text-[10px] outline-none focus:border-primary/60"
            />
          ) : (
            <label className="flex min-w-0 flex-1 items-center gap-1 text-[10px] text-muted-foreground">
              Every
              <input
                type="number"
                min="1"
                value={everyMinutes}
                onChange={(event) => setEveryMinutes(event.target.value)}
                aria-label="Repeat interval in minutes"
                className="w-14 rounded-md border border-border/70 bg-background px-1.5 py-1 text-[10px] outline-none focus:border-primary/60"
              />
              min
            </label>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[9.5px] text-muted-foreground">
            {activeChatId ? "Assigned to this chat" : "Select a chat to create one"}
          </span>
          <button
            type="submit"
            disabled={!canCreate}
            className="rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground disabled:opacity-45"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </form>

      {error ? (
        <div role="alert" className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2 py-1.5 text-[10px] text-destructive">
          {error}
          <button type="button" onClick={clearError} aria-label="Dismiss automation error" className="ml-2 underline">
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!hydrated || loading ? (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground"><Spinner className="size-3" /> Loading automations…</div>
        ) : items.length === 0 ? (
          <p className="text-[10.5px] text-muted-foreground">No local automations in this workspace.</p>
        ) : (
          <ul className="space-y-2" aria-label="Workspace automations">
            {items.map((item) => {
              const ownsItem = item.chatId === activeChatId;
              const pending = Boolean(pendingIds[`remove:${item.id}`]);
              const job = jobsByAutomationId[item.id];
              return (
                <li key={item.id} className="rounded-lg border border-border/60 bg-card/65 px-2.5 py-2">
                  <p className="line-clamp-2 text-[10.5px] leading-relaxed text-foreground">{item.message}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9.5px] text-muted-foreground">
                    <span>{scheduleLabel(item)}</span>
                    <span>{lastRunLabel(item.lastRunAtMs)}</span>
                    <span>{nextRunLabel(item)}</span>
                  </div>
                  {job ? (
                    <p className={cn("mt-1 text-[9.5px]", job.lastError ? "text-destructive" : "text-muted-foreground")}>
                      {job.lastError ? `Failed: ${job.lastError}` : `Latest run: ${job.state}`}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => switchSession(item.chatId)}
                      className="min-w-0 truncate text-[9.5px] text-primary hover:underline"
                    >
                      {titles.get(item.chatId) || "Owning chat"}
                    </button>
                    <button
                      type="button"
                      disabled={!ownsItem || pending}
                      onClick={() => void remove(item.id, item.chatId)}
                      title={ownsItem ? "Remove automation" : "Open its owning chat to remove it"}
                      className={cn("text-[9.5px] text-destructive hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline", pending && "opacity-50")}
                    >
                      {pending ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
