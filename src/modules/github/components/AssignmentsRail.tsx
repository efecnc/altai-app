import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  type RunState,
  useAgentRunsStore,
} from "@/modules/ai/store/agentRunsStore";
import {
  type Assignment,
  type AssignmentStatus,
} from "@/modules/github/lib/assignments";
import {
  ACTIVE_ASSIGNMENT_STATES,
  useAssignmentsStore,
} from "@/modules/github/store/assignmentsStore";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";

const STATUS_META: Record<
  AssignmentStatus,
  { label: string; dot: string; text: string }
> = {
  dispatching: { label: "Dispatching", dot: "bg-amber-500", text: "text-amber-500" },
  running: { label: "Running", dot: "bg-emerald-500", text: "text-emerald-500" },
  "awaiting-approval": {
    label: "Awaiting approval",
    dot: "bg-amber-500",
    text: "text-amber-500",
  },
  done: { label: "Done", dot: "bg-sky-500", text: "text-sky-400" },
  failed: { label: "Failed", dot: "bg-red-500", text: "text-red-500" },
  cancelled: {
    label: "Cancelled",
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
  },
};

/** Terminal statuses are sticky — a late/stray live event must not revive or
 *  relabel a finished assignment. */
const TERMINAL_ASSIGNMENT_STATES: AssignmentStatus[] = [
  "done",
  "failed",
  "cancelled",
];

/** Map a live run onto an assignment status. "done" requires a real terminal
 *  signal (run.completed) — `idle` alone is also the initial/usage-first state
 *  and must NOT be read as finished. */
function mapRun(run: RunState, fallback: AssignmentStatus): AssignmentStatus {
  if (run.completed) {
    if (run.outcome?.kind === "completed") return "done";
    if (run.outcome?.kind === "cancelled") return "cancelled";
    return "failed";
  }
  if (run.status === "thinking" || run.status === "streaming") return "running";
  if (run.status === "awaiting-approval") return "awaiting-approval";
  if (run.status === "error") return "failed";
  return fallback;
}

function sourceLabel(a: Assignment): string {
  if (a.source.kind === "issue") return `Issue #${a.source.number}`;
  if (a.source.kind === "pr") return `PR #${a.source.number}`;
  if (a.source.kind === "task") return "Background task";
  return "Todo";
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function AssignmentsRail() {
  const assignments = useAssignmentsStore((s) => s.assignments);
  const hydrate = useAssignmentsStore((s) => s.hydrate);
  const updateStatus = useAssignmentsStore((s) => s.updateStatus);
  const cancel = useAssignmentsStore((s) => s.cancel);
  const remove = useAssignmentsStore((s) => s.remove);

  const runs = useAgentRunsStore((s) => s.runs);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Repair every assignment's persisted status from the per-chat_id registry —
  // works for ALL runs, not just the focused one. Terminal statuses are sticky.
  useEffect(() => {
    for (const a of assignments) {
      if (TERMINAL_ASSIGNMENT_STATES.includes(a.status)) continue;
      const run = runs[a.sessionId];
      if (!run) continue;
      const mapped = mapRun(run, a.status);
      if (mapped !== a.status) updateStatus(a.id, mapped);
    }
  }, [assignments, runs, updateStatus]);

  if (assignments.length === 0) {
    return (
      <div className="shrink-0 border-b border-border/50 px-4 py-2.5 text-[11.5px] text-muted-foreground/60">
        No agents assigned yet — click{" "}
        <span className="font-medium text-muted-foreground">Assign agent</span>{" "}
        on an issue, PR, or todo.
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b border-border/50">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Agents
        </span>
        <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] font-semibold text-muted-foreground">
          {assignments.length}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto px-4 pb-3">
        {assignments.map((a) => {
          const run = runs[a.sessionId];
          const status: AssignmentStatus = TERMINAL_ASSIGNMENT_STATES.includes(
            a.status,
          )
            ? a.status
            : run
              ? mapRun(run, a.status)
              : a.status;
          const meta = STATUS_META[status];
          const busy = status === "running" || status === "dispatching";
          const tokens = run ? run.tokens.input + run.tokens.output : 0;
          const subagents = run?.subagents ?? [];
          const isActive = a.sessionId === activeSessionId;
          return (
            <div
              key={a.id}
              className="flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-border/60 bg-card/40 p-2.5"
            >
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-1 size-2 shrink-0 rounded-full",
                    meta.dot,
                    busy && "animate-pulse",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-foreground">
                    {a.title}
                  </p>
                  <p className="truncate text-[10.5px] text-muted-foreground/60">
                    {sourceLabel(a)} ·{" "}
                    <span className={meta.text}>{meta.label}</span>
                    {tokens > 0 ? ` · ${formatTokens(tokens)} tok` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Remove assignment"
                  onClick={() => void remove(a.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
                </button>
              </div>

              {/* Current step */}
              {busy && run?.step ? (
                <p className="flex items-center gap-1.5 truncate text-[10.5px] text-muted-foreground/70">
                  <Spinner className="size-3 shrink-0" />
                  <span className="truncate">{run.step}</span>
                </p>
              ) : null}

              {/* Sub-agent lanes */}
              {subagents.length > 0 ? (
                <ul className="flex flex-col gap-1 rounded-lg bg-background/50 p-1.5">
                  {subagents.map((t) => (
                    <li
                      key={t.taskId}
                      className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground"
                    >
                      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                      <span className="truncate font-medium text-foreground/85">
                        {t.displayName || t.agentName || "sub-agent"}
                      </span>
                      {t.agentName && t.displayName ? (
                        <span className="truncate opacity-60">{t.agentName}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* Result (on completion) */}
              {status === "done" && run?.lastResult ? (
                <p
                  className="line-clamp-3 rounded-lg bg-background/50 p-1.5 text-[10.5px] leading-snug text-muted-foreground"
                  title={run.lastResult}
                >
                  {run.lastResult}
                </p>
              ) : null}

              {/* Actions */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => switchSession(a.sessionId)}
                  disabled={isActive}
                  className="rounded-md px-2 py-1 text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
                >
                  {isActive ? "Focused" : "Open transcript"}
                </button>
                {ACTIVE_ASSIGNMENT_STATES.includes(status) ? (
                  <button
                    type="button"
                    onClick={() => void cancel(a.id)}
                    className="ml-auto rounded-md px-2 py-1 text-[10.5px] font-medium text-red-500 transition-colors hover:bg-red-500/10"
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
